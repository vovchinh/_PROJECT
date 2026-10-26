// Disposable PGlite security/ledger checks for migration 021. No real PDF data.
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
  '021_pdf_bank_statement_guard',
];
const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
};
const db = new PGlite();
let passed = 0;
async function check(label, run) { await run(); console.log('PASS', label); passed++; }
async function asUser(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
  await db.exec('set role authenticated');
}
async function query(sql, params = []) { return (await db.query(sql, params)).rows; }
async function count(table, where, params = []) {
  return Number((await query(`select count(*) n from ${table} where ${where}`, params))[0].n);
}
async function rpc(name, args) {
  const keys = Object.keys(args);
  const values = keys.map(key => {
    const value = args[key];
    return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
  });
  return (await query(`select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')}) result`, values))[0].result;
}
async function setup() {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;`);
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users values($1,$2,now())', [id, `${name}@example.test`]);
  }
  for (const name of migrations) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }
}
async function workspace(who) {
  await asUser(users[who]);
  const w = (await rpc('bootstrap_workspace', { p_name: `PDF security ${who}` })).id;
  const account = (await query("select id,code,name from public.cash_accounts where workspace_id=$1 and code='BANK_CHINH'", [w]))[0];
  await rpc('save_master', { p_kind: 'cash_accounts', p_payload: {
    workspace_id: w, ...account, opening_confirmed: true, opening_date: '2026-08-01', opening_balance: 0,
  } });
  return { w, account: account.id };
}
const sha = ch => ch.repeat(64);
const pdfRow = (row_number = 1) => ({
  row_number, source_page: 1, source_row: row_number,
  transaction_date: '2026-08-18', direction: 'out', amount: '100000',
  description: `Synthetic packaging charge ${row_number}`, external_reference: '',
});
const pdfPayload = (source = sha('a')) => ({ source_sha256: source, currency_confirmed_vnd: true, rows: [pdfRow()] });
const excelPayload = (source = sha('b')) => ({
  source_sha256: source, source_name: 'synthetic.xlsx', rows: [{
    row_number: 2, raw_row: ['redacted'], transaction_date: '2026-08-18',
    direction: 'out', amount: 50000, description: 'Synthetic Excel expense', external_reference: '',
  }],
});
async function stagePdf(w, payload, request = randomUUID()) {
  return rpc('stage_pdf_bank_statement', { p_workspace_id: w, p_payload: payload, p_request_id: request });
}
async function stageExcel(w, payload, request = randomUUID()) {
  return rpc('stage_bank_statement', { p_workspace_id: w, p_payload: payload, p_request_id: request });
}
async function page(w, batch) {
  return rpc('get_bank_statement_import', { p_workspace_id: w, p_batch_id: batch });
}
async function classify(w, row, account, category = 'packaging') {
  return rpc('classify_bank_statement_row', {
    p_workspace_id: w, p_row_id: row, p_account_id: account,
    p_category_code: category, p_duplicate_reason: null,
  });
}
async function confirm(w, batch, ids, request = randomUUID()) {
  const rows = await query('select public.confirm_bank_statement_rows($1,$2,$3::uuid[],$4) result',
    [w, batch, ids, request]);
  return rows[0].result;
}

try {
  await setup();
  const owner = await workspace('owner');
  const other = await workspace('other');
  await db.exec('reset role');
  await query('insert into public.workspace_members values($1,$2,$3),($1,$4,$5)',
    [owner.w, users.staff, 'staff', users.viewer, 'viewer']);
  await asUser(users.owner);
  const excel = await stageExcel(owner.w, excelPayload());
  let staged;
  let stagedRowId;

  await check('PDF stage is transaction-only, server-labeled, and ledger-neutral', async () => {
    staged = await stagePdf(owner.w, pdfPayload());
    const data = await page(owner.w, staged.batch_id);
    assert.equal(data.batch.source_format, 'pdf');
    assert.equal(data.batch.currency_confirmed_vnd, true);
    assert.equal(data.batch.source_name, `Techcombank PDF ${sha('a').slice(0, 12)}`);
    assert.deepEqual(data.rows[0].raw_row, { source_page: 1, source_row: 1 });
    stagedRowId = data.rows[0].id;
    assert.equal(data.rows[0].amount, 100000);
    assert.equal(await count('public.cash_movements', 'workspace_id=$1', [owner.w]), 0);
  });

  await check('PDF allowlist and full account-number guard reject tampered payload', async () => {
    for (const tampered of [
      { ...pdfPayload(sha('c')), source_name: 'private-name.pdf' },
      { ...pdfPayload(sha('d')), rows: [{ ...pdfRow(), raw_row: { owner: 'private' } }] },
      { ...pdfPayload(sha('e')), rows: [{ ...pdfRow(), description: 'ACCT 1234567890123456' }] },
      { ...pdfPayload(sha('6')), rows: [{ ...pdfRow(), description: 'ACCT 1234 5678 9012' }] },
      { ...pdfPayload(sha('7')), rows: [{ ...pdfRow(), description: 'contact@example.test' }] },
      { ...pdfPayload(sha('8')), rows: [{ ...pdfRow(), external_reference: '1234567890123456' }] },
      { ...pdfPayload(sha('f')), rows: [{ ...pdfRow(), amount: 100000 }] },
      { ...pdfPayload(sha('3')), currency_confirmed_vnd: false },
      { source_sha256: sha('4'), rows: [pdfRow()] },
    ]) {
      await assert.rejects(() => stagePdf(owner.w, tampered), /PDF_BANK_/);
    }
    assert.equal(await count('public.bank_statement_batches', "workspace_id=$1 and source_format='pdf'", [owner.w]), 1);
  });

  await check('PDF stage retry reuses batch; altered parse and request are rejected', async () => {
    const req = randomUUID();
    const p = { ...pdfPayload(sha('0')), rows: [{ ...pdfRow(2), description: 'Synthetic different charge' }] };
    const first = await stagePdf(owner.w, p, req);
    assert.deepEqual(await stagePdf(owner.w, p, req), first);
    assert.equal((await stagePdf(owner.w, p)).batch_id, first.batch_id);
    await assert.rejects(() => stagePdf(owner.w, { ...p, rows: [{ ...pdfRow(), amount: '200000' }] }, req), /REQUEST_REUSED/);
    await assert.rejects(() => stagePdf(owner.w, { ...p, rows: [{ ...pdfRow(), amount: '200000' }] }), /FILE_CHANGED/);
  });

  await check('staff/viewer cannot stage, list, preview, or classify PDF; Excel remains visible', async () => {
    for (const role of ['staff', 'viewer']) {
      await asUser(users[role]);
      await assert.rejects(() => stagePdf(owner.w, pdfPayload(sha(role === 'staff' ? '1' : '2'))), /role|quyền|permission|FORBIDDEN|owner|manager/i);
      const batches = await query('select id from public.bank_statement_batches where workspace_id=$1', [owner.w]);
      assert.deepEqual(batches.map(b => b.id), [excel.batch_id]);
      assert.equal(await count('public.bank_statement_rows', 'workspace_id=$1', [owner.w]), 1);
      await assert.rejects(() => page(owner.w, staged.batch_id), /role|quyền|permission|FORBIDDEN|owner|manager/i);
      const excelData = await page(owner.w, excel.batch_id);
      assert.equal(excelData.batch.source_format, 'excel');
      if (role === 'staff') {
        await assert.rejects(() => classify(owner.w, stagedRowId, owner.account), /BANK_ROW_NOT_FOUND/);
        await classify(owner.w, excelData.rows[0].id, owner.account);
      }
    }
    await asUser(users.owner);
  });

  let cashId;
  await check('owner confirms PDF through existing ledger once, with idempotent retry', async () => {
    const row = (await page(owner.w, staged.batch_id)).rows[0];
    await classify(owner.w, row.id, owner.account);
    const req = randomUUID();
    const first = await confirm(owner.w, staged.batch_id, [row.id], req);
    cashId = first.rows[0].cash_id;
    assert.equal(first.posted_count, 1);
    assert.deepEqual(await confirm(owner.w, staged.batch_id, [row.id], req), first);
    assert.equal((await confirm(owner.w, staged.batch_id, [row.id])).posted_count, 0);
    assert.equal(await count('public.cash_movements', 'workspace_id=$1 and cash_id=$2', [owner.w, cashId]), 1);
  });

  await check('staff/viewer direct reads hide PDF cash, movement, snapshot and audit', async () => {
    for (const role of ['staff', 'viewer']) {
      await asUser(users[role]);
      for (const table of ['cash_transactions', 'cash_movements', 'cash_category_snapshots']) {
        const key = table === 'cash_transactions' ? 'id' : 'cash_id';
        assert.equal(await count(`public.${table}`, `workspace_id=$1 and ${key}=$2`, [owner.w, cashId]), 0);
      }
      assert.equal(await count('public.audit_events', 'workspace_id=$1 and entity_id=$2', [owner.w, cashId]), 0);
      assert.equal(await count('public.audit_events', 'workspace_id=$1 and entity_id=$2', [owner.w, staged.batch_id]), 0);
      const report = await rpc('get_workspace_report', { p_workspace_id: owner.w, p_from: '2026-08-01', p_to: '2026-08-31' });
      assert.equal(report.cash_restricted, true);
      assert.equal(report.overview.cash_out, undefined);
      assert.deepEqual(report.cash_accounts, []);
      const cats = await rpc('get_expense_categories', { p_workspace_id: owner.w });
      assert.equal(cats.cash_restricted, true);
      assert.equal(cats.reconciliation, undefined);
    }
    await asUser(users.owner);
    assert.equal(await count('public.cash_transactions', 'workspace_id=$1 and id=$2', [owner.w, cashId]), 1);
  });

  await check('pending rows in another batch are flagged without exposing private PDF rows', async () => {
    const pendingPdf = await stagePdf(owner.w, { ...pdfPayload(sha('6')),
      rows: [{ ...pdfRow(3), amount: '200000', description: 'Synthetic pending comparison' }] });
    const pendingExcel = await stageExcel(owner.w, {
      source_sha256: sha('7'), source_name: 'synthetic-pending.xlsx', rows: [{
        row_number: 1, raw_row: ['redacted'], transaction_date: '2026-08-18',
        direction: 'out', amount: 200000, description: 'Synthetic pending comparison', external_reference: '',
      }],
    });
    assert.equal((await page(owner.w, pendingPdf.batch_id)).rows[0].duplicate.row_count, 1);
    assert.equal((await page(owner.w, pendingExcel.batch_id)).rows[0].duplicate.row_count, 1);
    await asUser(users.staff);
    assert.equal((await page(owner.w, pendingExcel.batch_id)).rows[0].duplicate.row_count, 0);
    await asUser(users.owner);
  });

  await check('Excel duplicate preview cannot probe private PDF cash', async () => {
    const probe = await stageExcel(owner.w, {
      source_sha256: sha('5'), source_name: 'synthetic-overlap.xlsx', rows: [{
        row_number: 1, raw_row: ['redacted'], transaction_date: '2026-08-18',
        direction: 'out', amount: 100000, description: 'Synthetic packaging charge 1',
        external_reference: 'T1',
      }],
    });
    assert.equal((await page(owner.w, probe.batch_id)).rows[0].duplicate.cash_count, 1);
    await asUser(users.staff);
    assert.equal((await page(owner.w, probe.batch_id)).rows[0].duplicate.cash_count, 0);
    await asUser(users.owner);
  });

  await check('PDF cash replacement stays private and another workspace cannot read', async () => {
    const correction = await rpc('correct_posted_document', {
      p_workspace_id: owner.w, p_kind: 'cash', p_id: cashId,
      p_reverse_date: '2026-08-20', p_reason: 'Synthetic correction for regression', p_request_id: randomUUID(),
    });
    const replacement = correction.replacement.id;
    assert.equal(await count('public.document_corrections', 'workspace_id=$1 and cash_original_id=$2', [owner.w, cashId]), 1);
    await asUser(users.staff);
    assert.equal(await count('public.cash_transactions', 'workspace_id=$1 and id=$2', [owner.w, replacement]), 0);
    assert.equal(await count('public.document_corrections', 'workspace_id=$1 and cash_original_id=$2', [owner.w, cashId]), 0);
    await asUser(users.owner);
    await rpc('post_cash', { p_id: replacement, p_request_id: randomUUID() });
    await asUser(users.staff);
    assert.equal(await count('public.cash_movements', 'workspace_id=$1 and cash_id=$2', [owner.w, replacement]), 0);
    await asUser(users.other);
    assert.equal(await count('public.bank_statement_batches', 'workspace_id=$1', [owner.w]), 0);
    await assert.rejects(() => page(owner.w, staged.batch_id), /role|quyền|permission|FORBIDDEN|owner|manager/i);
    await asUser(users.owner);
    assert.equal((await page(owner.w, staged.batch_id)).batch.id, staged.batch_id);
  });

  console.log(`PDF bank security checks: ${passed} passed`);
} finally {
  await db.close();
}
