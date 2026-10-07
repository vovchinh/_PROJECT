// Synthetic local PostgreSQL only. No cloud credentials or customer data.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const db = new PGlite();
const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  manager: '33333333-3333-4333-8333-333333333333',
  staff: '44444444-4444-4444-8444-444444444444',
  viewer: '55555555-5555-4555-8555-555555555555',
};
const migrations = [
  '001_core', '002_operations', '003_sales_inventory',
  '004_catalog_variants_aliases', '005_customer_order_foundation',
  '006_inventory_reservations', '007_live_intake', '008_live_tickets_print',
  '009_live_operations', '010_tiktok_channel_flow', '011_tiktok_live_end',
  '012_live_runtime_telemetry', '013_catalog_management',
  '014_expense_categories', '015_document_corrections',
];
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('PASS', name);
}
async function asUser(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
  await db.exec('set role authenticated');
}
async function call(name, args) {
  const keys = Object.keys(args);
  const { rows } = await db.query(
    `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) result`,
    Object.values(args).map((value) =>
      value !== null && typeof value === 'object' ? JSON.stringify(value) : value),
  );
  return rows[0].result;
}
async function count(sql, params = []) {
  return Number((await db.query(sql, params)).rows[0].n);
}
async function setupWorkspace(who) {
  await asUser(users[who]);
  const w = (await call('bootstrap_workspace', { p_name: `Correction ${who}` })).id;
  const warehouse = (await db.query('select id from public.warehouses where workspace_id=$1', [w])).rows[0].id;
  const account = (await db.query("select * from public.cash_accounts where workspace_id=$1 and code='CASH'", [w])).rows[0];
  await call('save_master', { p_kind: 'cash_accounts', p_payload: {
    workspace_id: w, id: account.id, code: account.code, name: account.name,
    opening_balance: 0, opening_confirmed: true, opening_date: '2026-08-01',
  } });
  const supplier = await call('save_master', { p_kind: 'suppliers', p_payload: {
    workspace_id: w, code: 'SUP-1', name: 'Supplier test',
  } });
  const product = await call('save_master', { p_kind: 'products', p_payload: {
    workspace_id: w, code: 'SKU-1', name: 'Product test', provisional: false,
    unit_cost: 100,
  } });
  return { w, warehouse, account: account.id, supplier: supplier.id, product: product.id };
}
async function purchase(f, extra = {}) {
  return call('create_purchase', { p_payload: {
    workspace_id: f.w, supplier_id: f.supplier, warehouse_id: f.warehouse,
    product_id: f.product, received_date: '2026-08-18',
    qty: 3, unit_cost: 100, additional_cost: 10, notes: 'Initial draft', ...extra,
  } });
}
async function cash(f, extra = {}) {
  return call('create_cash', { p_payload: {
    workspace_id: f.w, account_id: f.account, transaction_date: '2026-08-18',
    direction: 'out', category: 'packaging', amount: 200,
    description: 'Initial draft', ...extra,
  } });
}
const reason = 'Correcting an operational entry';
async function remove(f, kind, id, request = randomUUID(), why = reason) {
  return call('delete_draft_document', {
    p_workspace_id: f.w, p_kind: kind, p_id: id,
    p_request_id: request, p_reason: why,
  });
}
async function correct(f, kind, id, request = randomUUID(), date = '2026-08-19', why = reason) {
  return call('correct_posted_document', {
    p_workspace_id: f.w, p_kind: kind, p_id: id,
    p_reverse_date: date, p_reason: why, p_request_id: request,
  });
}

try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users values($1,$2,now())', [id, `${name}@correction.test`]);
  }
  for (const name of migrations.slice(0, -1)) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }
  const upgrade = await setupWorkspace('other');
  const existingDraft = await purchase(upgrade, { legacy_id: 'EXISTING-IMPORT-DRAFT' });
  const existingPurchase = await purchase(upgrade, { qty: 2, unit_cost: 75 });
  const existingCash = await cash(upgrade, { amount: 425 });
  await call('post_purchase', { p_id: existingPurchase.id, p_request_id: randomUUID() });
  await call('post_cash', { p_id: existingCash.id, p_request_id: randomUUID() });
  const beforeUpgrade = {
    stock: await count('select coalesce(sum(amount),0) n from public.stock_movements where workspace_id=$1', [upgrade.w]),
    cash: await count('select coalesce(sum(signed_amount),0) n from public.cash_movements where workspace_id=$1', [upgrade.w]),
    lots: await count('select coalesce(sum(remaining_qty),0) n from public.inventory_lots where workspace_id=$1', [upgrade.w]),
  };
  await db.exec('reset role');
  await db.exec(await readFile(new URL('../supabase/migrations/015_document_corrections.sql', import.meta.url), 'utf8'));
  await asUser(users.other);
  await check('015 installs after 014 without rewriting historical migrations', async () => {
    assert.equal(await count("select count(*) n from pg_tables where schemaname='public' and tablename='document_corrections'"), 1);
    assert.equal((await db.query('select status from public.purchase_receipts where id=$1', [existingDraft.id])).rows[0].status, 'draft');
    assert.equal((await db.query('select legacy_id from public.purchase_receipts where id=$1', [existingDraft.id])).rows[0].legacy_id, 'EXISTING-IMPORT-DRAFT');
    assert.equal((await db.query('select status from public.purchase_receipts where id=$1', [existingPurchase.id])).rows[0].status, 'posted');
    assert.equal((await db.query('select status from public.cash_transactions where id=$1', [existingCash.id])).rows[0].status, 'posted');
    assert.deepEqual({
      stock: await count('select coalesce(sum(amount),0) n from public.stock_movements where workspace_id=$1', [upgrade.w]),
      cash: await count('select coalesce(sum(signed_amount),0) n from public.cash_movements where workspace_id=$1', [upgrade.w]),
      lots: await count('select coalesce(sum(remaining_qty),0) n from public.inventory_lots where workspace_id=$1', [upgrade.w]),
    }, beforeUpgrade);
  });
  const f = await setupWorkspace('owner');
  for (const [name, role] of [['manager', 'manager'], ['staff', 'staff'], ['viewer', 'viewer']]) {
    await call('add_workspace_member', {
      p_workspace_id: f.w, p_email: `${name}@correction.test`, p_role: role,
    });
  }
  await asUser(users.owner);

  const draftPurchase = await purchase(f, { legacy_id: 'LEGACY-DRAFT-1' });
  const draftCash = await cash(f, { legacy_id: 'LEGACY-CASH-1' });
  await check('Draft purchase and cash edits retain IDs and record before/after audit', async () => {
    const editedPurchase = await purchase(f, { id: draftPurchase.id, qty: 5, unit_cost: 110 });
    const editedCash = await cash(f, { id: draftCash.id, amount: 350, category: 'marketing' });
    assert.equal(editedPurchase.id, draftPurchase.id);
    assert.equal(editedPurchase.total_amount, 560);
    assert.equal(editedCash.id, draftCash.id);
    assert.equal(await count("select count(*) n from public.audit_events where workspace_id=$1 and action in ('purchase.draft_updated','cash.draft_updated') and details ? 'before' and details ? 'after'", [f.w]), 2);
  });
  await check('Staff may delete both drafts; tombstones preserve legacy IDs and create no ledger effects', async () => {
    await asUser(users.staff);
    const p = await remove(f, 'purchase', draftPurchase.id);
    const c = await remove(f, 'cash', draftCash.id);
    assert.equal(p.status, 'deleted');
    assert.equal(c.status, 'deleted');
    assert.equal(p.legacy_id, 'LEGACY-DRAFT-1');
    assert.equal(c.legacy_id, 'LEGACY-CASH-1');
    assert.equal(await count('select count(*) n from public.stock_movements where purchase_id=$1', [p.id]), 0);
    assert.equal(await count('select count(*) n from public.cash_movements where cash_id=$1', [c.id]), 0);
    assert.equal(await count("select count(*) n from public.audit_events where workspace_id=$1 and action in ('purchase.draft_deleted','cash.draft_deleted')", [f.w]), 2);
  });
  await check('Delete request replay is stable; changed payload, new request, edit or post fail', async () => {
    const p = (await db.query('select delete_request_id from public.purchase_receipts where id=$1', [draftPurchase.id])).rows[0];
    assert.equal((await remove(f, 'purchase', draftPurchase.id, p.delete_request_id)).id, draftPurchase.id);
    await assert.rejects(() => remove(f, 'purchase', draftPurchase.id, p.delete_request_id, 'A different reason here'), /DOCUMENT_ALREADY_DELETED|DOCUMENT_REQUEST_CONFLICT/);
    await assert.rejects(() => remove(f, 'purchase', draftPurchase.id), /DOCUMENT_ALREADY_DELETED/);
    await assert.rejects(() => purchase(f, { id: draftPurchase.id }), /draft|nháp|DOCUMENT_DELETED/i);
    await asUser(users.owner);
    await assert.rejects(() => call('post_purchase', { p_id: draftPurchase.id, p_request_id: randomUUID() }), /deleted|đảo|DOCUMENT/i);
    await assert.rejects(() => call('post_cash', { p_id: draftCash.id, p_request_id: randomUUID() }), /deleted|đảo|DOCUMENT/i);
  });
  await check('Workspace and viewer isolation protect deletions, corrections and correction links', async () => {
    await asUser(users.other);
    await assert.rejects(() => remove(f, 'purchase', draftPurchase.id), /permission|quyền|workspace/i);
    await assert.rejects(() => correct(f, 'purchase', draftPurchase.id), /permission|quyền|workspace/i);
    assert.equal(await count('select count(*) n from public.document_corrections where workspace_id=$1', [f.w]), 0);
    await asUser(users.viewer);
    await assert.rejects(() => remove(f, 'cash', draftCash.id), /permission|quyền|workspace/i);
    await asUser(users.owner);
  });

  const postedPurchase = await purchase(f, { qty: 4, unit_cost: 125 });
  await call('post_purchase', { p_id: postedPurchase.id, p_request_id: randomUUID() });
  await check('Posted purchase cannot be deleted or raw edited', async () => {
    await assert.rejects(() => remove(f, 'purchase', postedPurchase.id), /DOCUMENT_ALREADY_POSTED/);
    await assert.rejects(() => purchase(f, { id: postedPurchase.id, qty: 99 }), /draft|nháp/i);
  });
  const purchaseRequest = randomUUID();
  let purchaseResult;
  await check('Posted purchase reverse and replacement are atomic, linked, editable and stock-neutral before repost', async () => {
    purchaseResult = await correct(f, 'purchase', postedPurchase.id, purchaseRequest);
    assert.equal(purchaseResult.original.status, 'reversed');
    assert.equal(purchaseResult.replacement.status, 'draft');
    assert.equal(purchaseResult.replacement.received_date, '2026-08-19');
    assert.equal(purchaseResult.replacement.legacy_id, null);
    assert.equal(purchaseResult.replacement.provenance.correction_of, postedPurchase.id);
    const link = (await db.query('select * from public.document_corrections where id=$1', [purchaseResult.correction_id])).rows[0];
    assert.equal(link.purchase_original_id, postedPurchase.id);
    assert.equal(link.purchase_replacement_id, purchaseResult.replacement.id);
    assert.equal(await count("select count(*) n from public.stock_movements where purchase_id=$1 and movement_kind='reversal'", [postedPurchase.id]), 1);
    assert.equal(await count('select coalesce(sum(remaining_qty),0) n from public.inventory_lots where source_purchase_id=$1', [postedPurchase.id]), 0);
    assert.equal(await count('select count(*) n from public.stock_movements where purchase_id=$1', [purchaseResult.replacement.id]), 0);
    assert.equal((await purchase(f, { id: purchaseResult.replacement.id,
      received_date: '2026-08-19', qty: 6, unit_cost: 130 })).qty, 6);
  });
  await check('Purchase correction retry does not reverse or create another draft', async () => {
    const replay = await correct(f, 'purchase', postedPurchase.id, purchaseRequest);
    assert.equal(replay.correction_id, purchaseResult.correction_id);
    assert.equal(replay.replacement.id, purchaseResult.replacement.id);
    await assert.rejects(() => correct(f, 'purchase', postedPurchase.id, purchaseRequest, '2026-08-19', 'A different correction reason'), /DOCUMENT_REQUEST_CONFLICT/);
    await assert.rejects(() => correct(f, 'purchase', postedPurchase.id), /DOCUMENT_ALREADY_CORRECTED/);
  });
  await check('Posting corrected purchase changes stock exactly once', async () => {
    await call('post_purchase', { p_id: purchaseResult.replacement.id, p_request_id: randomUUID() });
    assert.equal(await count('select coalesce(sum(remaining_qty),0) n from public.inventory_lots where workspace_id=$1 and product_id=$2', [f.w, f.product]), 6);
    assert.equal(await count("select count(*) n from public.stock_movements where purchase_id=$1 and movement_kind='post'", [purchaseResult.replacement.id]), 1);
  });

  const postedCash = await cash(f, { amount: 1000, description: 'Original expense' });
  await call('post_cash', { p_id: postedCash.id, p_request_id: randomUUID() });
  await check('Posted cash cannot be deleted or raw edited', async () => {
    await assert.rejects(() => remove(f, 'cash', postedCash.id), /DOCUMENT_ALREADY_POSTED/);
    await assert.rejects(() => cash(f, { id: postedCash.id, amount: 10 }), /draft|nháp/i);
  });
  const cashRequest = randomUUID();
  let cashResult;
  await check('Cash reverse and corrected draft retain immutable post/reversal pair and category snapshot', async () => {
    cashResult = await correct(f, 'cash', postedCash.id, cashRequest);
    assert.equal(cashResult.original.status, 'reversed');
    assert.equal(cashResult.replacement.status, 'draft');
    assert.equal(cashResult.replacement.transaction_date, '2026-08-19');
    assert.equal(await count('select coalesce(sum(signed_amount),0) n from public.cash_movements where cash_id=$1', [postedCash.id]), 0);
    assert.equal(await count('select count(*) n from public.cash_category_snapshots where cash_id=$1', [postedCash.id]), 1);
    assert.equal(await count('select count(*) n from public.cash_movements where cash_id=$1', [cashResult.replacement.id]), 0);
    const updated = await cash(f, { id: cashResult.replacement.id, amount: 850, category: 'marketing' });
    assert.equal(updated.amount, 850);
  });
  await check('Cash correction retry and second attempt do not create duplicate ledger effects', async () => {
    const replay = await correct(f, 'cash', postedCash.id, cashRequest);
    assert.equal(replay.correction_id, cashResult.correction_id);
    assert.equal(await count('select count(*) n from public.cash_movements where cash_id=$1', [postedCash.id]), 2);
    await assert.rejects(() => correct(f, 'cash', postedCash.id), /DOCUMENT_ALREADY_CORRECTED/);
    await call('post_cash', { p_id: cashResult.replacement.id, p_request_id: randomUUID() });
    assert.equal(await count('select coalesce(sum(signed_amount),0) n from public.cash_movements where workspace_id=$1', [f.w]), -850);
    assert.equal(await count('select count(*) n from public.cash_movements where cash_id=$1', [cashResult.replacement.id]), 1);
  });
  await check('Manager may edit and delete drafts but only owner may reverse posted documents', async () => {
    const draft = await cash(f, { amount: 77 });
    const posted = await cash(f, { amount: 66 });
    await call('post_cash', { p_id: posted.id, p_request_id: randomUUID() });
    await asUser(users.manager);
    assert.equal((await cash(f, { id: draft.id, amount: 88 })).amount, 88);
    assert.equal((await remove(f, 'cash', draft.id)).status, 'deleted');
    await assert.rejects(() => correct(f, 'cash', posted.id), /permission|quyền|workspace/i);
    await asUser(users.owner);
  });
  await check('Already reversed cash can be linked once without a second reversal movement', async () => {
    const old = await cash(f, { amount: 31 });
    await call('post_cash', { p_id: old.id, p_request_id: randomUUID() });
    await call('reverse_document', { p_kind: 'cash', p_id: old.id,
      p_request_id: randomUUID(), p_date: '2026-08-20', p_reason: reason });
    const result = await correct(f, 'cash', old.id, randomUUID(), '2026-08-20');
    assert.equal(result.original.status, 'reversed');
    assert.equal(result.replacement.status, 'draft');
    assert.equal(await count("select count(*) n from public.cash_movements where cash_id=$1 and movement_kind='reversal'", [old.id]), 1);
    await assert.rejects(() => correct(f, 'cash', old.id, randomUUID(), '2026-08-21'), /DOCUMENT_ALREADY_CORRECTED/);
  });
  await check('Failed FIFO reversal rolls back correction link, status and request claim', async () => {
    const held = await purchase(f, { received_date: '2026-08-20', qty: 2 });
    await call('post_purchase', { p_id: held.id, p_request_id: randomUUID() });
    // Directly lowering the lot simulates a consumed FIFO lot; the existing
    // reverse RPC must reject and the correction RPC must not leave a draft.
    await db.exec('reset role');
    await db.query('update public.inventory_lots set remaining_qty=1,remaining_cost=125 where source_purchase_id=$1', [held.id]);
    await asUser(users.owner);
    const before = await count('select count(*) n from public.purchase_receipts where workspace_id=$1', [f.w]);
    await assert.rejects(() => correct(f, 'purchase', held.id, randomUUID(), '2026-08-21'), /lô|lot|giữ|xuất|inventory/i);
    assert.equal(await count('select count(*) n from public.purchase_receipts where workspace_id=$1', [f.w]), before);
    assert.equal(await count('select count(*) n from public.document_corrections where workspace_id=$1 and purchase_original_id=$2', [f.w, held.id]), 0);
    assert.equal((await db.query('select status from public.purchase_receipts where id=$1', [held.id])).rows[0].status, 'posted');
  });
  await check('Correction link is read-only through REST grants and RLS hides other workspace', async () => {
    await asUser(users.other);
    assert.equal(await count('select count(*) n from public.document_corrections where workspace_id=$1', [f.w]), 0);
    await assert.rejects(() => correct(upgrade, 'purchase', postedPurchase.id), /DOCUMENT_NOT_FOUND/);
    await assert.rejects(() => db.query('delete from public.document_corrections where id=$1', [purchaseResult.correction_id]), /permission denied/i);
    await asUser(users.owner);
    assert.equal(await count('select count(*) n from public.document_corrections where workspace_id=$1', [f.w]), 3);
  });
  console.log(`${passed} document correction checks passed`);
} finally {
  await db.close();
}
