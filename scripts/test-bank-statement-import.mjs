// Disposable local PostgreSQL/PGlite integration checks for migration 016.
// No cloud connection, production data or environment variables are read.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const names = [
  '001_core',
  '002_operations',
  '003_sales_inventory',
  '004_catalog_variants_aliases',
  '005_customer_order_foundation',
  '006_inventory_reservations',
  '007_live_intake',
  '008_live_tickets_print',
  '009_live_operations',
  '010_tiktok_channel_flow',
  '011_tiktok_live_end',
  '012_live_runtime_telemetry',
  '013_catalog_management',
  '014_expense_categories',
  '015_document_corrections',
  '016_bank_statement_import',
];
const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
};
const db = new PGlite();
let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}
async function asUser(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
  await db.exec('set role authenticated');
}
async function query(sql, params = []) {
  return (await db.query(sql, params)).rows;
}
async function rpc(name, args) {
  const keys = Object.keys(args);
  const rows = await query(
    `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) result`,
    keys.map((key) => {
      const value = args[key];
      return key === 'p_row_ids'
        ? value
        : value !== null && typeof value === 'object'
          ? JSON.stringify(value)
          : value;
    }),
  );
  return rows[0].result;
}
async function count(table, where, values) {
  await db.exec('reset role');
  return Number((await query(`select count(*) n from ${table} where ${where}`, values))[0].n);
}
async function setup() {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users values($1,$2,now())', [id, `${name}@bank.example.test`]);
  }
  for (const name of names) {
    const sql = await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
    await db.exec(sql);
  }
}
async function workspace(who) {
  await asUser(users[who]);
  const w = (await rpc('bootstrap_workspace', { p_name: `Bank test ${who}` })).id;
  const account = (await query("select id,code,name from public.cash_accounts where workspace_id=$1 and code='BANK_CHINH'", [w]))[0];
  await rpc('save_master', {
    p_kind: 'cash_accounts',
    p_payload: { workspace_id: w, ...account, opening_confirmed: true, opening_date: '2026-08-01', opening_balance: 0 },
  });
  return { w, account: account.id };
}
const sourceA = 'a'.repeat(64);
const sourceB = 'b'.repeat(64);
function entry(row_number, description, amount = 100000, external_reference = '') {
  return {
    row_number,
    transaction_date: '2026-08-18',
    direction: 'out',
    amount,
    description,
    external_reference,
    raw_row: ['18/08/2026', description, amount],
  };
}
function payload(hash = sourceA) {
  return {
    source_name: 'synthetic-bank-statement.xlsx',
    source_sha256: hash,
    rows: [entry(2, 'Phí    quảng cáo', 100000, 'TX100'), entry(3, 'Phí quảng cáo', 100000, 'TX100'), entry(4, 'Tiền in bill', 50000, 'TX200')],
  };
}
async function stage(w, data, request = randomUUID()) {
  return rpc('stage_bank_statement', { p_workspace_id: w, p_payload: data, p_request_id: request });
}
async function page(w, batch) {
  return rpc('get_bank_statement_import', { p_workspace_id: w, p_batch_id: batch });
}
async function classify(w, row, account, category, reason = null) {
  return rpc('classify_bank_statement_row', {
    p_workspace_id: w,
    p_row_id: row,
    p_account_id: account,
    p_category_code: category,
    p_duplicate_reason: reason,
  });
}
async function confirm(w, batch, rows, request = randomUUID()) {
  return rpc('confirm_bank_statement_rows', { p_workspace_id: w, p_batch_id: batch, p_row_ids: rows, p_request_id: request });
}

try {
  await setup();
  const owner = await workspace('owner');
  const other = await workspace('other');
  await db.exec('reset role');
  await db.query('insert into public.workspace_members values($1,$2,$3),($1,$4,$5)', [
    owner.w, users.staff, 'staff', users.viewer, 'viewer',
  ]);
  await asUser(users.owner);

  let batch;
  await check('stage retains file SHA, filename, source row and has no cash/ledger effect', async () => {
    const beforeCash = await count('public.cash_transactions', 'workspace_id=$1', [owner.w]);
    const beforeLedger = await count('public.cash_movements', 'workspace_id=$1', [owner.w]);
    await asUser(users.owner);
    batch = await stage(owner.w, payload());
    assert.equal(batch.row_count, 3);
    const data = await page(owner.w, batch.batch_id);
    assert.equal(data.batch.source_sha256, sourceA);
    assert.equal(data.batch.source_name, 'synthetic-bank-statement.xlsx');
    assert.deepEqual(data.rows[0].raw_row, ['18/08/2026', 'Phí    quảng cáo', 100000]);
    assert.equal(data.pending, 3);
    assert.equal(await count('public.cash_transactions', 'workspace_id=$1', [owner.w]), beforeCash);
    assert.equal(await count('public.cash_movements', 'workspace_id=$1', [owner.w]), beforeLedger);
    await asUser(users.owner);
  });

  await check('staging retry and same-file retry do not create more rows', async () => {
    const request = randomUUID();
    const otherPayload = payload(sourceB);
    const first = await stage(owner.w, otherPayload, request);
    const again = await stage(owner.w, otherPayload, request);
    assert.deepEqual(again, first);
    const sameFile = await stage(owner.w, otherPayload);
    assert.equal(sameFile.batch_id, first.batch_id);
    assert.equal(sameFile.reused, true);
    assert.equal(await count('public.bank_statement_rows', 'workspace_id=$1 and batch_id=$2', [owner.w, first.batch_id]), 3);
    await asUser(users.owner);
    await assert.rejects(() => stage(owner.w, { ...otherPayload, source_name: 'changed.xlsx' }, request), /BANK_REQUEST_REUSED/);
    await assert.rejects(() => stage(owner.w, { ...otherPayload, source_name: 'changed.xlsx' }), /BANK_FILE_CHANGED/);
  });

  let rows;
  await check('preview flags same-file normalized duplicates', async () => {
    const data = await page(owner.w, batch.batch_id);
    rows = data.rows;
    assert.equal(data.total, 3);
    assert.equal(rows[0].duplicate.possible_duplicate, true);
    assert.equal(Number(rows[0].duplicate.row_count), 1);
    assert.equal(Number(rows[1].duplicate.row_count), 1);
    assert.equal(rows[2].duplicate.possible_duplicate, false);
  });

  await check('workspace RLS and RPCs hide other workspace batches', async () => {
    await asUser(users.other);
    assert.equal((await query('select count(*) n from public.bank_statement_batches where workspace_id=$1', [owner.w]))[0].n, 0);
    await assert.rejects(() => page(owner.w, batch.batch_id), /quyền|permission|workspace/i);
    await assert.rejects(() => classify(owner.w, rows[0].id, owner.account, 'marketing'), /quyền|permission|workspace/i);
    await assert.rejects(() => confirm(owner.w, batch.batch_id, [rows[0].id]), /quyền|permission|workspace/i);
    await asUser(users.owner);
    await assert.rejects(() => page(other.w, batch.batch_id), /quyền|permission/i);
  });

  await check('staff can classify but viewer cannot stage/classify/confirm', async () => {
    await asUser(users.viewer);
    await assert.rejects(() => stage(owner.w, payload('c'.repeat(64))), /quyền|permission/i);
    await assert.rejects(() => classify(owner.w, rows[0].id, owner.account, 'marketing'), /quyền|permission/i);
    await assert.rejects(() => confirm(owner.w, batch.batch_id, [rows[0].id]), /quyền|permission/i);
    await asUser(users.staff);
    await classify(owner.w, rows[0].id, owner.account, 'marketing');
    await asUser(users.owner);
  });

  await check('classification checks workspace account, direction and category', async () => {
    await assert.rejects(() => classify(owner.w, rows[1].id, other.account, 'marketing'), /BANK_ACCOUNT/);
    await assert.rejects(() => classify(owner.w, rows[1].id, owner.account, 'capital'), /BANK_CATEGORY/);
    await assert.rejects(() => classify(owner.w, rows[1].id, owner.account, 'missing'), /BANK_CATEGORY/);
    await assert.rejects(() => classify(owner.w, rows[1].id, owner.account, 'marketing', 'short'), /BANK_DUPLICATE_REASON/);
    await classify(owner.w, rows[1].id, owner.account, 'marketing', 'Hai khoản phí khác nhau theo sao kê ngân hàng.');
    await classify(owner.w, rows[2].id, owner.account, 'packaging');
  });

  await check('confirmation refuses duplicates without reason and rolls back entire selection', async () => {
    const beforeCash = await count('public.cash_transactions', 'workspace_id=$1', [owner.w]);
    const beforeLedger = await count('public.cash_movements', 'workspace_id=$1', [owner.w]);
    await asUser(users.owner);
    await assert.rejects(() => confirm(owner.w, batch.batch_id, rows.map((r) => r.id)), /BANK_POSSIBLE_DUPLICATE/);
    assert.equal(await count('public.cash_transactions', 'workspace_id=$1', [owner.w]), beforeCash);
    assert.equal(await count('public.cash_movements', 'workspace_id=$1', [owner.w]), beforeLedger);
    await asUser(users.owner);
  });

  await check('multiple rows confirm atomically, preserve cash source, and only post once', async () => {
    await classify(owner.w, rows[0].id, owner.account, 'marketing', 'Khoản thứ nhất đã đối chiếu mã chứng từ nguồn.');
    const request = randomUUID();
    const result = await confirm(owner.w, batch.batch_id, rows.map((r) => r.id), request);
    assert.equal(result.posted_count, 3);
    assert.equal(result.rows.length, 3);
    const before = await count('public.cash_movements', 'workspace_id=$1 and movement_kind=$2', [owner.w, 'post']);
    assert.equal(before, 3);
    await asUser(users.owner);
    const replay = await confirm(owner.w, batch.batch_id, [...rows].reverse().map((r) => r.id), request);
    assert.deepEqual(replay, result);
    const another = await confirm(owner.w, batch.batch_id, rows.map((r) => r.id));
    assert.equal(another.posted_count, 0);
    assert.equal(await count('public.cash_movements', 'workspace_id=$1 and movement_kind=$2', [owner.w, 'post']), before);
    await db.exec('reset role');
    const linked = await query('select r.row_number,r.id row_id,r.cash_id,c.status,c.source_id,c.legacy_id,c.provenance from public.bank_statement_rows r join public.cash_transactions c on c.workspace_id=r.workspace_id and c.id=r.cash_id where r.workspace_id=$1 and r.batch_id=$2 order by r.row_number', [owner.w, batch.batch_id]);
    assert.equal(linked.length, 3);
    for (const row of linked) {
      assert.equal(row.status, 'posted');
      assert.equal(row.source_id, sourceA);
      assert.equal(row.provenance.kind, 'bank_statement');
      assert.equal(row.provenance.batch_id, batch.batch_id);
      assert.equal(row.provenance.row_id, row.row_id);
      assert.equal(row.provenance.row_number, row.row_number);
      assert.equal(row.provenance.source_name, 'synthetic-bank-statement.xlsx');
      assert.equal(row.legacy_id, `BANK:${sourceA}:${row.row_number}`);
    }
    await asUser(users.owner);
  });

  await check('preview detects previously posted cash from another file and ignores its own cash', async () => {
    const firstPage = await page(owner.w, batch.batch_id);
    assert.equal(Number(firstPage.rows[2].duplicate.cash_count), 0);
    const otherBatch = (await query('select id from public.bank_statement_batches where workspace_id=$1 and source_sha256=$2', [owner.w, sourceB]))[0].id;
    const preview = await page(owner.w, otherBatch);
    assert.ok(Number(preview.rows[0].duplicate.cash_count) >= 1);
    assert.equal(preview.rows[0].duplicate.possible_duplicate, true);
  });

  await check('posted import reverses through existing ledger command while source stays linked', async () => {
    const id = (await page(owner.w, batch.batch_id)).rows[2].cash_id;
    await rpc('reverse_document', { p_kind: 'cash', p_id: id, p_request_id: randomUUID(), p_date: '2026-08-18', p_reason: 'Synthetic bank reversal for audit' });
    const movements = await count('public.cash_movements', 'workspace_id=$1 and cash_id=$2', [owner.w, id]);
    assert.equal(movements, 2);
    const record = (await page(owner.w, batch.batch_id)).rows[2];
    assert.equal(record.cash_id, id);
  });

  await check('a single valid row can be confirmed independently', async () => {
    const single = await stage(owner.w, {
      source_name: 'one-row.xlsx',
      source_sha256: 'd'.repeat(64),
      rows: [entry(9, 'Phí bao bì cho mẫu in đơn', 76000, 'TX300')],
    });
    const row = (await page(owner.w, single.batch_id)).rows[0];
    const category = await rpc('save_expense_category', {
      p_workspace_id: owner.w,
      p_payload: { code: 'bank_pending_test', name: 'Bank pending test', direction: 'out', category_kind: 'operating_expense' },
    });
    await classify(owner.w, row.id, owner.account, category.code);
    await assert.rejects(
      () => rpc('delete_expense_category', { p_workspace_id: owner.w, p_id: category.id, p_reason: 'Synthetic pending row category removal' }),
      /EXPENSE_IN_USE/,
    );
    await classify(owner.w, row.id, owner.account, 'packaging');
    await rpc('delete_expense_category', { p_workspace_id: owner.w, p_id: category.id, p_reason: 'Synthetic unused category removal' });
    const result = await confirm(owner.w, single.batch_id, [row.id]);
    assert.equal(result.posted_count, 1);
    assert.equal(result.rows[0].row_id, row.id);
    assert.equal((await page(owner.w, single.batch_id)).confirmed, 1);
  });

  await check('another workspace can stage identical SHA without seeing or altering first workspace', async () => {
    await asUser(users.other);
    const foreign = await stage(other.w, payload());
    assert.notEqual(foreign.batch_id, batch.batch_id);
    assert.equal((await page(other.w, foreign.batch_id)).total, 3);
    await assert.rejects(() => page(other.w, batch.batch_id), /BANK_BATCH_NOT_FOUND/);
  });

  console.log(`Bank statement import: ${passed} PASS`);
} finally {
  await db.close();
}
