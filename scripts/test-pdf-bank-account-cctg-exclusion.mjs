// Disposable PGlite checks for migration 022; all statement data is synthetic.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const migrations = [
  '001_core', '002_operations', '003_sales_inventory', '004_catalog_variants_aliases',
  '005_customer_order_foundation', '006_inventory_reservations', '007_live_intake',
  '008_live_tickets_print', '009_live_operations', '010_tiktok_channel_flow',
  '011_tiktok_live_end', '012_live_runtime_telemetry', '013_catalog_management',
  '014_expense_categories', '015_document_corrections', '016_bank_statement_import',
  '017_hr_core', '018_hr_attendance_leave', '019_hr_payroll', '020_hr_payroll_components',
  '021_pdf_bank_statement_guard', '022_pdf_bank_account_cctg_exclusion',
];
const ids = {
  owner: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
};
const db = new PGlite();
let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log('PASS', label); }
async function query(sql, params = []) { return (await db.query(sql, params)).rows; }
async function asUser(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
}
async function rpc(name, args) {
  const keys = Object.keys(args);
  const values = keys.map(k => args[k] === null ? null : typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]);
  return (await query(`select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')}) result`, values))[0].result;
}
async function count(table, where, params) {
  return Number((await query(`select count(*) n from ${table} where ${where}`, params))[0].n);
}
async function setup() {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;`);
  for (const [name, id] of Object.entries(ids)) {
    await query('insert into auth.users values($1,$2,now())', [id, `${name}@example.test`]);
  }
  for (const name of migrations) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }
}
async function workspace(who) {
  await asUser(ids[who]);
  const workspaceId = (await rpc('bootstrap_workspace', { p_name: `PDF 022 ${who}` })).id;
  const account = (await query(
    "select id,code,name from public.cash_accounts where workspace_id=$1 and code='BANK_CHINH'",
    [workspaceId],
  ))[0];
  await rpc('save_master', { p_kind: 'cash_accounts', p_payload: {
    workspace_id: workspaceId, ...account, opening_confirmed: true,
    opening_date: '2026-08-01', opening_balance: 0,
  } });
  return { workspaceId, accountId: account.id };
}
const sha = char => char.repeat(64);
const row = (rowNumber = 1) => ({
  row_number: rowNumber, source_page: 1, source_row: rowNumber,
  transaction_date: '2026-08-18', direction: 'out', amount: '100000',
  description: `Synthetic bank expense ${rowNumber}`, external_reference: '',
});
function payload(accountId, source = sha('a'), excluded = 12) {
  return {
    source_sha256: source, currency_confirmed_vnd: true,
    account_id: accountId, excluded_cctg_count: excluded,
    excluded_cctg_confirmed: excluded > 0, rows: [row()],
  };
}
async function stage(workspaceId, data, requestId = randomUUID()) {
  return rpc('stage_pdf_bank_statement_verified', {
    p_workspace_id: workspaceId, p_payload: data, p_request_id: requestId,
  });
}
async function page(workspaceId, batchId) {
  return rpc('get_bank_statement_import', { p_workspace_id: workspaceId, p_batch_id: batchId });
}
async function confirm(workspaceId, batchId, rowIds, requestId = randomUUID()) {
  return (await query('select public.confirm_bank_statement_rows($1,$2,$3::uuid[],$4) result',
    [workspaceId, batchId, rowIds, requestId]))[0].result;
}

try {
  await setup();
  const owner = await workspace('owner');
  const other = await workspace('other');
  await db.exec('reset role');
  await query('insert into public.workspace_members values($1,$2,$3),($1,$4,$5)',
    [owner.workspaceId, ids.staff, 'staff', ids.viewer, 'viewer']);
  await asUser(ids.owner);
  let staged;
  let stagedRow;

  await check('PDF staging saves account UUID and CCTG aggregate, without ledger effect', async () => {
    staged = await stage(owner.workspaceId, payload(owner.accountId));
    const preview = await page(owner.workspaceId, staged.batch_id);
    stagedRow = preview.rows[0];
    assert.equal(staged.account_id, owner.accountId);
    assert.equal(staged.excluded_cctg_count, 12);
    assert.equal(staged.excluded_cctg_confirmed, true);
    assert.equal(preview.batch.account_id, owner.accountId);
    assert.equal(preview.batch.excluded_cctg_count, 12);
    assert.equal(preview.batch.excluded_cctg_confirmed, true);
    assert.equal(preview.total, 1);
    assert.equal(stagedRow.account_id, owner.accountId);
    assert.deepEqual(stagedRow.raw_row, { source_page: 1, source_row: 1 });
    assert.equal(await count('public.cash_transactions', 'workspace_id=$1', [owner.workspaceId]), 0);
    assert.equal(await count('public.cash_movements', 'workspace_id=$1', [owner.workspaceId]), 0);
  });

  await check('same request and same file reuse batch; account/count changes are refused', async () => {
    const requestId = randomUUID();
    const data = payload(owner.accountId, sha('b'), 0);
    const first = await stage(owner.workspaceId, data, requestId);
    assert.deepEqual(await stage(owner.workspaceId, data, requestId), first);
    assert.equal((await stage(owner.workspaceId, data)).batch_id, first.batch_id);
    assert.equal((await page(owner.workspaceId, first.batch_id)).batch.excluded_cctg_confirmed, false);
    await assert.rejects(() => stage(owner.workspaceId,
      { ...data, excluded_cctg_count: 1, excluded_cctg_confirmed: true }, requestId),
    /PDF_BANK_FILE_CHANGED/);
    await assert.rejects(() => stage(owner.workspaceId,
      { ...data, account_id: other.accountId }), /PDF_BANK_ACCOUNT/);
    const secondAccount = (await query(
      "select id from public.cash_accounts where workspace_id=$1 and code='CASH'",
      [owner.workspaceId],
    ))[0].id;
    await assert.rejects(() => stage(owner.workspaceId,
      { ...data, account_id: secondAccount }), /PDF_BANK_FILE_CHANGED/);
    await assert.rejects(() => stage(owner.workspaceId,
      { ...data, rows: [{ ...row(), amount: '200000' }] }), /PDF_BANK_FILE_CHANGED/);
    assert.equal(await count('public.bank_statement_rows', 'workspace_id=$1 and batch_id=$2',
      [owner.workspaceId, first.batch_id]), 1);
  });

  await check('allowlist and explicit CCTG acknowledgement reject malformed payloads', async () => {
    const baseline = payload(owner.accountId, sha('c'));
    for (const bad of [
      { ...baseline, source_name: 'private.pdf' },
      { ...baseline, account_holder: 'Private Person' },
      { ...baseline, excluded_cctg_count: 12, excluded_cctg_confirmed: false },
      { ...baseline, excluded_cctg_count: 0, excluded_cctg_confirmed: true },
      { ...baseline, excluded_cctg_count: -1 },
      { ...baseline, excluded_cctg_count: 5001 },
      { ...baseline, excluded_cctg_count: 0.5 },
      { ...baseline, excluded_cctg_count: '12' },
      { ...baseline, rows: [{ ...row(), cctg_amount: '900000' }] },
    ]) {
      await assert.rejects(() => stage(owner.workspaceId, bad), /PDF_BANK_/);
    }
    assert.equal(await count('public.bank_statement_batches', 'workspace_id=$1 and source_sha256=$2',
      [owner.workspaceId, sha('c')]), 0);
  });

  await check('old direct PDF RPC is closed; staff and viewer cannot stage or preview PDF', async () => {
    const privilege = (await query(
      "select has_function_privilege('authenticated','public.stage_pdf_bank_statement(uuid,jsonb,uuid)','EXECUTE') p",
    ))[0].p;
    assert.equal(privilege, false);
    for (const role of ['staff', 'viewer']) {
      await asUser(ids[role]);
      await assert.rejects(() => stage(owner.workspaceId,
        payload(owner.accountId, sha(role === 'staff' ? 'd' : 'e'))),
      /role|permission|quyền|FORBIDDEN|owner|manager/i);
      await assert.rejects(() => page(owner.workspaceId, staged.batch_id),
      /role|permission|quyền|FORBIDDEN|owner|manager/i);
    }
    await asUser(ids.owner);
  });

  await check('cross-workspace account is rejected and identical SHA stays isolated', async () => {
    await assert.rejects(() => stage(owner.workspaceId,
      payload(other.accountId, sha('f'))), /PDF_BANK_ACCOUNT/);
    await asUser(ids.other);
    const foreign = await stage(other.workspaceId, payload(other.accountId));
    assert.notEqual(foreign.batch_id, staged.batch_id);
    await assert.rejects(() => page(other.workspaceId, staged.batch_id), /BANK_BATCH_NOT_FOUND/);
    await asUser(ids.owner);
  });

  await check('confirmation uses existing Thu Chi account and posts exactly once', async () => {
    await rpc('classify_bank_statement_row', {
      p_workspace_id: owner.workspaceId, p_row_id: stagedRow.id,
      p_account_id: owner.accountId, p_category_code: 'packaging',
      p_duplicate_reason: 'Dòng thử nghiệm độc lập đã đối chiếu nguồn.',
    });
    const requestId = randomUUID();
    const first = await confirm(owner.workspaceId, staged.batch_id, [stagedRow.id], requestId);
    assert.equal(first.posted_count, 1);
    assert.deepEqual(await confirm(owner.workspaceId, staged.batch_id, [stagedRow.id], requestId), first);
    assert.equal((await confirm(owner.workspaceId, staged.batch_id, [stagedRow.id])).posted_count, 0);
    const cash = (await query('select account_id,amount,provenance from public.cash_transactions where id=$1',
      [first.rows[0].cash_id]))[0];
    assert.equal(cash.account_id, owner.accountId);
    assert.equal(Number(cash.amount), 100000);
    assert.equal(cash.provenance.kind, 'bank_statement');
    assert.equal(await count('public.cash_movements', 'workspace_id=$1 and cash_id=$2',
      [owner.workspaceId, first.rows[0].cash_id]), 1);
    assert.equal(await count('public.bank_statement_rows', 'workspace_id=$1 and batch_id=$2',
      [owner.workspaceId, staged.batch_id]), 1);
  });

  console.log(`PDF account/CCTG security checks: ${passed} passed`);
} finally {
  await db.close();
}
