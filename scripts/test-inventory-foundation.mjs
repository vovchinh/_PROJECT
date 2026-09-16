// Phase B inventory holds: disposable PostgreSQL/PGlite integration tests.
// No production connection, .env access or historical migration edits.
import { PGlite } from '@electric-sql/pglite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const names = ['001_core.sql', '002_operations.sql', '003_sales_inventory.sql',
  '004_catalog_variants_aliases.sql', '005_customer_order_foundation.sql',
  '006_inventory_reservations.sql'];
const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  outsider: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
  manager: '55555555-5555-4555-8555-555555555555',
};
const db = new PGlite();
const checks = [];
const migrations = [];
const historicTables = ['products', 'purchase_receipts', 'stock_movements', 'inventory_lots',
  'sales_orders', 'sales_order_lines', 'sales_allocations', 'sales_events', 'cash_accounts',
  'cash_transactions', 'cash_movements', 'audit_events', 'app_private.inventory_timeline',
  'app_private.sales_requests', 'app_private.posting_requests'];
const allBusinessTables = [...historicTables, 'inventory_reservations', 'reservation_lots',
  'app_private.inventory_reservation_requests'];
let stage = 'setup';
async function ok(name, fn) {
  try { await fn(); checks.push({ name, status: 'PASS' }); console.log('PASS', name); }
  catch (error) { checks.push({ name, status: 'FAIL', code: error.code || error.name, detail: error.message }); throw error; }
}
async function user(id = users.owner) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
  await db.exec('set role authenticated');
}
async function rpc(name, args) {
  const keys = Object.keys(args);
  const { rows } = await db.query(
    `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) as value`,
    Object.entries(args).map(([key, value]) => key === 'p_reservation_ids' ? value
      : value !== null && typeof value === 'object' ? JSON.stringify(value) : value),
  );
  return rows[0].value;
}
async function snapshot(tables = allBusinessTables) {
  await db.exec('reset role');
  const value = {};
  for (const table of tables) value[table] = (await db.query(
    `select to_jsonb(t) as row from ${table.includes('.') ? table : `public.${table}`} t order by to_jsonb(t)::text`,
  )).rows;
  await user();
  return value;
}
async function functions() {
  await db.exec('reset role');
  return (await db.query(`select n.nspname as schema,p.proname as name,
    pg_get_function_identity_arguments(p.oid) as arguments,
    pg_get_functiondef(p.oid) as definition,p.proacl::text as acl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','app_private') and p.prokind='f'
    order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`)).rows;
}
async function sku(f, code, provisional = false) {
  return rpc('save_master', { p_kind: 'products', p_payload: {
    workspace_id: f.w, supplier_id: f.supplier, code, name: `Synthetic ${code}`,
    unit_cost: 80000, provisional,
  } });
}
async function purchase(f, productId, qty, unit_cost, date, additional_cost = 0) {
  const row = await rpc('create_purchase', { p_payload: {
    workspace_id: f.w, supplier_id: f.supplier, product_id: productId, warehouse_id: f.warehouse,
    received_date: date, date_estimated: false, qty, unit_cost, additional_cost,
  } });
  await rpc('post_purchase', { p_id: row.id, p_request_id: randomUUID() });
  return row;
}
async function stocked(f, code) {
  const product = await sku(f, code);
  const receipts = [await purchase(f, product.id, 5, 80000, '2026-08-01'),
    await purchase(f, product.id, 5, 90000, '2026-08-02')];
  return { product, receipts };
}
async function order(f, code, productId, qty, warehouse = f.warehouse) {
  return rpc('save_sales_order', { p_workspace_id: f.w, p_payload: {
    code, customer_id: f.customer, warehouse_id: warehouse, order_date: '2026-08-03',
    lines: [{ product_id: productId, qty, unit_price: 120000, discount: 0 }],
  } });
}
async function transition(f, id, action, payload, request = randomUUID()) {
  return rpc('transition_sales_order', { p_workspace_id: f.w, p_order_id: id,
    p_action: action, p_payload: payload, p_request_id: request });
}
function holdPayload(f, productId, qty, date = '2026-08-03') {
  return { product_id: productId, warehouse_id: f.warehouse, qty, date,
    reference: 'SYNTHETIC-HOLD', reason: 'Synthetic manual inventory hold' };
}
async function reserve(f, payload, request = randomUUID()) {
  return rpc('reserve_inventory', { p_workspace_id: f.w, p_payload: payload, p_request_id: request });
}
async function release(f, id, date = '2026-08-06', reason = 'Synthetic full release of hold', request = randomUUID()) {
  return rpc('release_inventory_reservation', { p_workspace_id: f.w,
    p_reservation_id: id, p_date: date, p_reason: reason, p_request_id: request });
}
async function transfer(f, orderId, ids, date = '2026-08-05', request = randomUUID()) {
  return rpc('transfer_inventory_reservations', { p_workspace_id: f.w, p_order_id: orderId,
    p_reservation_ids: ids, p_date: date, p_request_id: request });
}
async function inventory(f, productId) {
  return (await rpc('get_inventory_foundation', { p_workspace_id: f.w })).inventory.find(
    (row) => row.product_id === productId && row.warehouse_id === f.warehouse,
  );
}
async function balance(f, productId, expected) {
  const row = await inventory(f, productId);
  assert.deepEqual([row.on_hand, row.reserved, row.available, row.in_transit, row.stock_value], expected);
}
async function fixture(name) {
  const w = (await rpc('bootstrap_workspace', { p_name: name })).id;
  const supplier = (await rpc('save_master', { p_kind: 'suppliers', p_payload: { workspace_id: w, code: 'INV-NCC', name: 'Synthetic supplier' } })).id;
  const warehouse = (await db.query('select id from public.warehouses where workspace_id=$1', [w])).rows[0].id;
  const customer = await rpc('save_customer', { p_workspace_id: w, p_payload: { code: 'INV-CUSTOMER', name: 'Synthetic customer', phone: '0000000000' } });
  return { w, supplier, warehouse, customer };
}
async function rejectsUnchanged(fn, matcher) {
  const before = await snapshot();
  await assert.rejects(fn, matcher);
  assert.deepEqual(await snapshot(), before);
}

try {
  for (const name of names) {
    const bytes = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url));
    migrations.push({ name, sql: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
  for (const [name, id] of Object.entries(users))
    await db.query('insert into auth.users values($1,$2,now())', [id, `${name}@inventory.example.test`]);
  // 003 on EMPTY V1 business state; the known populated-V1 55006 blocker is not repaired or bypassed here.
  for (const migration of migrations.slice(0, 5)) await db.exec(migration.sql);
  await user();
  const f = await fixture('Inventory foundation owner');
  const historical = await stocked(f, 'INV-HISTORICAL');
  const heldOrder = await order(f, 'HISTORICAL-HELD', historical.product.id, 2);
  await transition(f, heldOrder, 'confirm', { date: '2026-08-03' });
  const pastOrder = await order(f, 'HISTORICAL-DELIVERED', historical.product.id, 3);
  await transition(f, pastOrder, 'confirm', { date: '2026-08-03' });
  await transition(f, pastOrder, 'ship', { date: '2026-08-04', carrier: 'Synthetic carrier', tracking_number: 'HISTORY-001' });
  await transition(f, pastOrder, 'deliver', { date: '2026-08-05' });
  const pastLine = (await db.query('select id from public.sales_order_lines where order_id=$1', [pastOrder])).rows[0].id;
  await transition(f, pastOrder, 'return', { date: '2026-08-06', reason: 'Synthetic original return checked', disposition: 'resellable', lines: [{ line_id: pastLine, qty: 1 }] });
  const primary = await stocked(f, 'INV-PRIMARY');
  const movable = await stocked(f, 'INV-TRANSFER');
  const provisional = await sku(f, 'INV-PROVISIONAL', true);
  const account = (await db.query("select * from public.cash_accounts where workspace_id=$1 and code='CASH'", [f.w])).rows[0];
  await rpc('save_master', { p_kind: 'cash_accounts', p_payload: { ...account, opening_confirmed: true, opening_date: '2026-08-01', opening_balance: 1000000 } });
  const cash = await rpc('create_cash', { p_payload: { workspace_id: f.w, account_id: account.id, direction: 'out', amount: 25000, category: 'packaging', transaction_date: '2026-08-01', date_estimated: false, description: 'Synthetic historical cash' } });
  await rpc('post_cash', { p_id: cash.id, p_request_id: randomUUID() });
  await user(users.outsider);
  const outside = await fixture('Other workspace');
  const outsideStock = await stocked(outside, 'INV-OUTSIDE');
  await db.exec('reset role');
  for (const role of ['staff', 'viewer', 'manager'])
    await db.query('insert into public.workspace_members values($1,$2,$3)', [f.w, users[role], role]);
  await user();
  const oldState = await rpc('get_sales_state', { p_workspace_id: f.w });
  const beforeMigration = await snapshot(historicTables);
  const oldRoutines = await functions();
  stage = '006 installation and preservation';
  await ok('006 upgrades populated V2/005 with unchanged historical FIFO, returns, held orders and cash', () => db.exec(migrations[5].sql));
  await ok('Migration does not change any original document, ledger, allocation, lot ID, request or audit row', async () => {
    assert.deepEqual(await snapshot(historicTables), beforeMigration);
    assert.deepEqual(await rpc('get_sales_state', { p_workspace_id: f.w }), oldState);
  });
  await ok('Only availability RPCs change; historical posting, reversal, catalog and snapshot functions remain byte-identical', async () => {
    const current = await functions();
    for (const old of oldRoutines) {
      if (old.schema === 'public' && ['transition_sales_order', 'get_sales_state'].includes(old.name)) continue;
      assert.deepEqual(current.find((r) => r.schema === old.schema && r.name === old.name && r.arguments === old.arguments), old);
    }
    for (const name of ['transition_sales_order', 'get_sales_state'])
      assert.equal(current.find((r) => r.schema === 'public' && r.name === name).acl,
        oldRoutines.find((r) => r.schema === 'public' && r.name === name).acl);
    await user();
  });
  await ok('New tables enforce RLS/read-only client grants; private requests and helpers are not callable', async () => {
    for (const table of ['inventory_reservations', 'reservation_lots']) {
      const row = (await db.query(`select c.relrowsecurity rls,
        has_table_privilege('authenticated',c.oid,'SELECT') reads,
        has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') writes,
        has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon
        from pg_class c where c.oid=to_regclass($1)`, [`public.${table}`])).rows[0];
      assert.deepEqual(row, { rls: true, reads: true, writes: false, anon: false });
    }
    await assert.rejects(() => db.query('select * from app_private.inventory_reservation_requests'), { code: '42501' });
    await assert.rejects(() => db.query("select app_private.inventory_reservation_date('2026-08-03')"), { code: '42501' });
  });
  stage = 'manual holds and shared order inventory';
  const initialPayload = holdPayload(f, primary.product.id, 3);
  const reserveRequest = randomUUID();
  let held;
  await ok('Manual hold is atomic, auditable and idempotent, without inventory movement or cash', async () => {
    const protectedRows = await snapshot(['stock_movements', 'inventory_lots', 'sales_allocations', 'cash_movements']);
    held = await reserve(f, initialPayload, reserveRequest);
    assert.equal(await reserve(f, initialPayload, reserveRequest), held);
    assert.deepEqual(await snapshot(['stock_movements', 'inventory_lots', 'sales_allocations', 'cash_movements']), protectedRows);
    await balance(f, primary.product.id, [10, 3, 7, 0, '850000']);
    const rows = (await db.query("select actor_id from public.audit_events where action='inventory.reserved' and entity_id=$1", [held])).rows;
    assert.deepEqual(rows, [{ actor_id: users.owner }]);
    assert.equal((await db.query('select count(*)::int n from public.inventory_reservations where id=$1', [held])).rows[0].n, 1);
  });
  await ok('Replay with changed hold payload and cross-action reuse of request UUID fail without effects', async () => {
    await rejectsUnchanged(() => reserve(f, { ...initialPayload, qty: 4 }, reserveRequest));
    await rejectsUnchanged(() => release(f, held, '2026-08-03', 'Wrong action under same request', reserveRequest));
  });
  await ok('Held physical lot cannot be reversed through unchanged legacy purchase reversal RPC', async () => {
    await rejectsUnchanged(() => rpc('reverse_document', { p_kind: 'purchase', p_id: primary.receipts[0].id,
      p_request_id: randomUUID(), p_date: '2026-08-03', p_reason: 'Attempt reversal while actively held' }), /INVENTORY_HELD/);
  });
  const tooLargeOrder = await order(f, 'TOO-LARGE', primary.product.id, 8);
  const availableOrder = await order(f, 'AVAILABLE-SEVEN', primary.product.id, 7);
  await ok('Old order confirmation sees manual holds: eight fail atomically, seven succeed without overselling', async () => {
    await rejectsUnchanged(() => transition(f, tooLargeOrder, 'confirm', { date: '2026-08-03' }));
    await transition(f, availableOrder, 'confirm', { date: '2026-08-03' });
    await balance(f, primary.product.id, [10, 10, 0, 0, '850000']);
    await rejectsUnchanged(() => reserve(f, holdPayload(f, primary.product.id, 1)));
  });
  await ok('New foundation reports expose manual and original order reservations separately without duplication', async () => {
    const state = await rpc('get_inventory_foundation', { p_workspace_id: f.w });
    assert.equal(state.reservations.find((row) => row.id === held).status, 'active');
    assert.equal(state.allocations.filter((row) => row.reservation_id === held).reduce((sum, row) => sum + row.qty, 0), 3);
    assert.equal(state.order_reservations.filter((row) => row.order_id === availableOrder).reduce((sum, row) => sum + row.qty, 0), 7);
  });
  await ok('Shipping never consumes manual-held units; available-lot FIFO costs 610000 with first three held', async () => {
    await transition(f, availableOrder, 'ship', { date: '2026-08-04', carrier: 'Synthetic carrier', tracking_number: 'AVAILABLE-7' });
    await balance(f, primary.product.id, [3, 3, 0, 7, '240000']);
    assert.equal((await db.query('select cost_amount::text cost from public.sales_order_lines where order_id=$1', [availableOrder])).rows[0].cost, '610000');
  });
  const releaseRequest = randomUUID();
  await ok('Release restores availability once, preserves history and never adds stock or cash', async () => {
    const protectedRows = await snapshot(['stock_movements', 'inventory_lots', 'sales_allocations', 'cash_movements']);
    assert.equal(await release(f, held, '2026-08-06', 'Synthetic release after shipping', releaseRequest), held);
    assert.equal(await release(f, held, '2026-08-06', 'Synthetic release after shipping', releaseRequest), held);
    assert.equal(await reserve(f, initialPayload, reserveRequest), held); // replay does not reactivate a released hold
    assert.deepEqual(await snapshot(['stock_movements', 'inventory_lots', 'sales_allocations', 'cash_movements']), protectedRows);
    await balance(f, primary.product.id, [3, 0, 3, 7, '240000']);
    assert.equal((await db.query("select count(*)::int n from public.audit_events where entity_id=$1 and action='inventory.released'", [held])).rows[0].n, 1);
    await rejectsUnchanged(() => release(f, held, '2026-08-06', 'Different request payload reason', releaseRequest));
  });
  stage = 'atomic transfer';
  const transferHold = await reserve(f, holdPayload(f, movable.product.id, 7, '2026-08-04'));
  const remainingHold = await reserve(f, holdPayload(f, movable.product.id, 1, '2026-08-04'));
  const wrongQtyOrder = await order(f, 'TRANSFER-WRONG-QUANTITY', movable.product.id, 6);
  const transferOrder = await order(f, 'TRANSFER-SEVEN', movable.product.id, 7);
  const transferRequest = randomUUID();
  await ok('Transfer rejects partial quantities, duplicate IDs and wrong workspace without releasing holds', async () => {
    await rejectsUnchanged(() => transfer(f, wrongQtyOrder, [transferHold]));
    await rejectsUnchanged(() => transfer(f, transferOrder, [transferHold, transferHold]));
    await rejectsUnchanged(() => transfer(f, transferOrder, []));
  });
  await ok('Failure after hold consumption rolls back consumption, order, allocations and request registration', async () => {
    await rpc('save_master', { p_kind: 'products', p_payload: { ...movable.product, provisional: true } });
    await rejectsUnchanged(() => transfer(f, transferOrder, [transferHold], '2026-08-05', transferRequest), /SKU chưa được xác nhận/);
    await rpc('save_master', { p_kind: 'products', p_payload: { ...movable.product, provisional: false } });
  });
  await ok('Successful transfer confirms the existing order atomically, invokes 005 snapshots, and never doubles reservations', async () => {
    const protectedRows = await snapshot(['inventory_lots', 'stock_movements', 'cash_movements']);
    assert.equal(await transfer(f, transferOrder, [transferHold], '2026-08-05', transferRequest), transferOrder);
    assert.equal(await transfer(f, transferOrder, [transferHold], '2026-08-05', transferRequest), transferOrder);
    assert.deepEqual(await snapshot(['inventory_lots', 'stock_movements', 'cash_movements']), protectedRows);
    await balance(f, movable.product.id, [10, 8, 2, 0, '850000']);
    const row = (await db.query('select status,customer_snapshot,snapshot_source from public.sales_orders where id=$1', [transferOrder])).rows[0];
    assert.equal(row.status, 'confirmed');
    assert.equal(row.customer_snapshot.customer.id, f.customer);
    assert.equal(row.snapshot_source, 'legacy_contact_unverified');
    const hold = (await db.query('select status,order_id from public.inventory_reservations where id=$1', [transferHold])).rows[0];
    assert.deepEqual(hold, { status: 'consumed', order_id: transferOrder });
    assert.equal((await db.query("select count(*)::int n from public.sales_events where order_id=$1 and action='confirm'", [transferOrder])).rows[0].n, 1);
    await rejectsUnchanged(() => release(f, transferHold));
    await rejectsUnchanged(() => transfer(f, transferOrder, [remainingHold], '2026-08-05', transferRequest));
  });
  await ok('Transferred seven use unchanged FIFO 580000, delivery revenue and partial return original cost 160000', async () => {
    await transition(f, transferOrder, 'ship', { date: '2026-08-06', carrier: 'Synthetic carrier', tracking_number: 'TRANSFER-7' });
    await balance(f, movable.product.id, [3, 1, 2, 7, '270000']);
    await transition(f, transferOrder, 'deliver', { date: '2026-08-07' });
    const line = (await db.query('select id,cost_amount::text cost from public.sales_order_lines where order_id=$1', [transferOrder])).rows[0];
    assert.equal(line.cost, '580000');
    const returnRequest = randomUUID();
    const payload = { date: '2026-08-08', reason: 'Synthetic checked resellable return', disposition: 'resellable', lines: [{ line_id: line.id, qty: 2 }] };
    await transition(f, transferOrder, 'return', payload, returnRequest);
    await transition(f, transferOrder, 'return', payload, returnRequest);
    await balance(f, movable.product.id, [5, 1, 4, 0, '430000']);
    assert.deepEqual((await db.query('select sum(revenue_effect)::text revenue,sum(cogs_effect)::text cost,sum(transit_cost_effect)::text transit from public.sales_events where order_id=$1', [transferOrder])).rows[0],
      { revenue: '600000', cost: '420000', transit: '0' });
  });
  stage = 'validation and security';
  await ok('Future dates, backward stock dates, provisional SKUs and invalid quantities fail without any effects', async () => {
    const future = (await db.query("select (((now() at time zone 'Asia/Ho_Chi_Minh')::date)+1)::text as day")).rows[0].day;
    for (const payload of [holdPayload(f, primary.product.id, 1, future), holdPayload(f, primary.product.id, 1, '2026-08-01'),
      holdPayload(f, provisional.id, 1), ...[0, 1.5, 1000001].map((qty) => holdPayload(f, primary.product.id, qty, '2026-08-08'))])
      await rejectsUnchanged(() => reserve(f, payload));
    await rejectsUnchanged(() => release(f, remainingHold, future));
    await rejectsUnchanged(() => release(f, remainingHold, '2026-08-01'));
    await rejectsUnchanged(() => transfer(f, wrongQtyOrder, [remainingHold], future));
  });
  await ok('All workspace roles may read; staff/viewer cannot reserve, release or transfer', async () => {
    for (const role of ['staff', 'viewer']) {
      await user(users[role]);
      assert.ok((await rpc('get_inventory_foundation', { p_workspace_id: f.w })).reservations.length > 0);
      await assert.rejects(() => reserve(f, holdPayload(f, primary.product.id, 1, '2026-08-08')), { code: '42501' });
      await assert.rejects(() => release(f, remainingHold, '2026-08-08'), { code: '42501' });
      await assert.rejects(() => transfer(f, wrongQtyOrder, [remainingHold], '2026-08-08'), { code: '42501' });
    }
    await user(users.manager);
    const managerHold = await reserve(f, holdPayload(f, primary.product.id, 1, '2026-08-08'));
    await release(f, managerHold, '2026-08-08');
    assert.equal((await db.query("select actor_id from public.audit_events where entity_id=$1 and action='inventory.reserved'", [managerHold])).rows[0].actor_id, users.manager);
    await user();
  });
  await ok('Workspace isolation applies to reads, mutation RPCs and foreign product/warehouse inputs', async () => {
    await user(users.outsider);
    assert.equal((await db.query('select id from public.inventory_reservations where workspace_id=$1', [f.w])).rows.length, 0);
    assert.equal((await db.query('select lot_id from public.reservation_lots where workspace_id=$1', [f.w])).rows.length, 0);
    await assert.rejects(() => rpc('get_inventory_foundation', { p_workspace_id: f.w }), { code: '42501' });
    await assert.rejects(() => reserve(f, initialPayload), { code: '42501' });
    await assert.rejects(() => release(f, remainingHold, '2026-08-08'), { code: '42501' });
    await assert.rejects(() => transfer(f, wrongQtyOrder, [remainingHold], '2026-08-08'), { code: '42501' });
    await user();
    await rejectsUnchanged(() => reserve(f, holdPayload(f, outsideStock.product.id, 1, '2026-08-08')));
    await rejectsUnchanged(() => reserve(f, { ...holdPayload(f, primary.product.id, 1, '2026-08-08'), warehouse_id: outside.warehouse }));
  });
  await ok('Composite foreign keys and direct-write restrictions prevent bypassing workspace/lot ownership', async () => {
    await assert.rejects(() => db.query("update public.inventory_reservations set status='released' where id=$1", [remainingHold]), { code: '42501' });
    await assert.rejects(() => db.query('delete from public.reservation_lots where reservation_id=$1', [remainingHold]), { code: '42501' });
    await db.exec('reset role');
    const foreignLot = (await db.query('select id from public.inventory_lots where workspace_id=$1 limit 1', [outside.w])).rows[0].id;
    await assert.rejects(() => db.query('insert into public.reservation_lots values($1,$2,$3,1)', [f.w, remainingHold, foreignLot]), { code: '23503' });
    await assert.rejects(() => db.query(`insert into public.inventory_reservations(workspace_id,product_id,warehouse_id,qty,reserved_date,reason,created_by)
      values($1,$2,$3,1,'2026-08-08','Synthetic cross-workspace attempt',$4)`, [f.w, outsideStock.product.id, f.warehouse, users.owner]), { code: '23503' });
    await user();
  });
  await ok('Anonymous sessions cannot read tables or execute inventory RPCs', async () => {
    await db.exec('reset role;set role anon');
    await assert.rejects(() => db.query('select * from public.inventory_reservations'), { code: '42501' });
    await assert.rejects(() => rpc('get_inventory_foundation', { p_workspace_id: f.w }), { code: '42501' });
    await assert.rejects(() => reserve(f, initialPayload), { code: '42501' });
    await user();
  });
  await ok('Unrelated historical inventory and all original immutable financial/event rows remain unchanged', async () => {
    const current = await snapshot(historicTables);
    for (const table of historicTables) {
      for (const old of beforeMigration[table]) {
        // These two SKUs were intentionally shipped/returned after 006. Their
        // mutable lot balances/timelines are asserted exactly in the lifecycle
        // checks above; the upgrade/no-movement checks already cover old bytes.
        if (['inventory_lots', 'app_private.inventory_timeline'].includes(table)
          && [primary.product.id, movable.product.id].includes(old.row.product_id)) continue;
        assert.ok(current[table].some((row) => JSON.stringify(row) === JSON.stringify(old)), `Historical ${table} row changed`);
      }
    }
  });
  await ok('All 001 through 006 migration bytes remain unchanged by tests', async () => {
    for (const migration of migrations) {
      const bytes = await readFile(new URL(`../supabase/migrations/${migration.name}`, import.meta.url));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), migration.sha256);
    }
  });
} catch (error) {
  if (!checks.some((check) => check.status === 'FAIL'))
    checks.push({ name: `Fixture: ${stage}`, status: 'FAIL', code: error.code || error.name, detail: error.message });
  console.error(`FAIL ${stage}: ${error.code || error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(new URL('../test-results/inventory-foundation.json', import.meta.url), JSON.stringify({
    checked_at: new Date().toISOString(), engine: 'PGlite PostgreSQL', cloud_tested: false,
    simultaneous_sessions_tested: false,
    migration_scope: '001/002/003 empty; 004/005; populated V2 before 006. Existing populated-V1 003/55006 remains separate.',
    migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })), checks,
    status: checks.some((check) => check.status === 'FAIL') ? 'FAIL' : 'PASS',
  }, null, 2) + '\n');
  console.log(`Inventory foundation: ${checks.filter((check) => check.status === 'PASS').length} PASS, ${checks.filter((check) => check.status === 'FAIL').length} FAIL`);
}
