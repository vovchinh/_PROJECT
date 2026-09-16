// B1 catalog compatibility checks in disposable PostgreSQL/PGlite databases.
// No cloud, .env, production rows or historical migration writes.
import { PGlite } from '@electric-sql/pglite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const migrationNames = [
  '001_core.sql',
  '002_operations.sql',
  '003_sales_inventory.sql',
  '004_catalog_variants_aliases.sql',
];
const migrations = [];
const checks = [];
const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  otherOwner: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
  manager: '55555555-5555-4555-8555-555555555555',
};
const preservedTables = [
  'workspaces',
  'workspace_members',
  'suppliers',
  'products',
  'warehouses',
  'cash_accounts',
  'purchase_receipts',
  'cash_transactions',
  'stock_movements',
  'cash_movements',
  'import_batches',
  'customers',
  'sales_orders',
  'sales_order_lines',
  'sales_events',
  'inventory_lots',
  'sales_allocations',
];
const catalogTables = ['product_styles', 'product_variants', 'product_aliases'];
const opened = [];
let stage = 'loading';

async function ok(name, fn) {
  try {
    await fn();
    checks.push({ name, status: 'PASS' });
    console.log('PASS', name);
  } catch (error) {
    checks.push({ name, status: 'FAIL', code: error.code || error.name, detail: error.message });
    throw error;
  }
}
async function user(db, id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
  await db.exec('set role authenticated');
}
async function rpc(db, name, args) {
  const keys = Object.keys(args);
  const { rows } = await db.query(
    `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) as value`,
    Object.values(args).map((value) =>
      value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
    ),
  );
  return rows[0].value;
}
async function setup(migrationCount = 3) {
  const db = new PGlite();
  opened.push(db);
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
  `);
  for (const [name, id] of Object.entries(users))
    await db.query('insert into auth.users values($1,$2,now())', [id, `${name}@b1.example.test`]);
  // Install 003 while the business database is empty. A1 separately records the
  // inherited 003/55006 failure when upgrading a populated V1 database.
  for (const migration of migrations.slice(0, migrationCount)) await db.exec(migration.sql);
  return db;
}
async function snapshot(db, tables = preservedTables) {
  await db.exec('reset role');
  const result = {};
  for (const table of tables) {
    const qualified = table.includes('.') ? table : `public.${table}`;
    result[table] = (
      await db.query(`select to_jsonb(t) as row from ${qualified} t order by to_jsonb(t)::text`)
    ).rows;
  }
  return result;
}
async function existingRoutines(db) {
  await db.exec('reset role');
  return (
    await db.query(`
    select n.nspname as schema,p.proname as name,
      pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_functiondef(p.oid) as definition,p.proacl::text as acl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','app_private') and p.prokind='f'
    order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)
  `)
  ).rows;
}
async function product(db, workspace, supplier, code, provisional = false) {
  return rpc(db, 'save_master', {
    p_kind: 'products',
    p_payload: {
      workspace_id: workspace,
      supplier_id: supplier,
      code,
      name: `Synthetic ${code}`,
      unit_cost: 80000,
      provisional,
    },
  });
}
async function transition(db, workspace, order, action, payload, request = randomUUID()) {
  return rpc(db, 'transition_sales_order', {
    p_workspace_id: workspace,
    p_order_id: order,
    p_action: action,
    p_payload: payload,
    p_request_id: request,
  });
}
async function draft(db, fixture, code, productId, qty = 7) {
  return rpc(db, 'save_sales_order', {
    p_workspace_id: fixture.workspace,
    p_payload: {
      code,
      customer_id: fixture.customer,
      warehouse_id: fixture.warehouse,
      order_date: '2026-08-03',
      lines: [{ product_id: productId, qty, unit_price: 120000, discount: 0 }],
    },
  });
}
async function stock(db, fixture, productId) {
  const state = await rpc(db, 'get_sales_state', { p_workspace_id: fixture.workspace });
  return state.inventory.find(
    (row) => row.product_id === productId && row.warehouse_id === fixture.warehouse,
  );
}
async function fifoLifecycle(db, fixture, code, phase) {
  const sku = await product(db, fixture.workspace, fixture.supplier, code);
  for (const [received_date, unit_cost] of [
    ['2026-08-01', 80000],
    ['2026-08-02', 90000],
  ]) {
    const receipt = await rpc(db, 'create_purchase', {
      p_payload: {
        workspace_id: fixture.workspace,
        supplier_id: fixture.supplier,
        product_id: sku.id,
        warehouse_id: fixture.warehouse,
        received_date,
        date_estimated: false,
        qty: 5,
        unit_cost,
        additional_cost: 0,
      },
    });
    await rpc(db, 'post_purchase', { p_id: receipt.id, p_request_id: randomUUID() });
  }
  const order = await draft(db, fixture, `${code}-ORDER`, sku.id);
  const request = randomUUID();
  await ok(
    `${phase}: confirmed sales keep original product IDs and reserve without movement`,
    async () => {
      const before = await stock(db, fixture, sku.id);
      assert.deepEqual([before.on_hand, before.reserved, before.stock_value], [10, 0, '850000']);
      await transition(db, fixture.workspace, order, 'confirm', { date: '2026-08-03' }, request);
      await transition(db, fixture.workspace, order, 'confirm', { date: '2026-08-03' }, request);
      const after = await stock(db, fixture, sku.id);
      assert.deepEqual(
        [after.on_hand, after.reserved, after.available, after.stock_value],
        [10, 7, 3, '850000'],
      );
      const lines = await db.query(
        'select product_id from public.sales_order_lines where order_id=$1',
        [order],
      );
      assert.deepEqual(lines.rows, [{ product_id: sku.id }]);
    },
  );
  await ok(
    `${phase}: unchanged 003 FIFO ships seven for 580000 and does not create cash`,
    async () => {
      const cashBefore = (await db.query('select count(*)::int n from public.cash_movements'))
        .rows[0].n;
      await transition(db, fixture.workspace, order, 'ship', {
        date: '2026-08-04',
        carrier: 'Synthetic Carrier',
        tracking_number: `${code}-TRACK`,
      });
      const after = await stock(db, fixture, sku.id);
      assert.deepEqual(
        [after.on_hand, after.reserved, after.in_transit, after.stock_value],
        [3, 0, 7, '270000'],
      );
      const line = (
        await db.query(
          'select cost_amount::text cost from public.sales_order_lines where order_id=$1',
          [order],
        )
      ).rows[0];
      assert.equal(line.cost, '580000');
      assert.equal(
        (await db.query('select count(*)::int n from public.cash_movements')).rows[0].n,
        cashBefore,
      );
    },
  );
  await transition(db, fixture.workspace, order, 'deliver', { date: '2026-08-05' });
  const line = (
    await db.query('select id from public.sales_order_lines where order_id=$1', [order])
  ).rows[0].id;
  await ok(
    `${phase}: unchanged 003 partial return restores two units and 160000 original FIFO cost`,
    async () => {
      const returnRequest = randomUUID();
      const payload = {
        date: '2026-08-06',
        reason: 'Synthetic checked resellable return',
        disposition: 'resellable',
        lines: [{ line_id: line, qty: 2 }],
      };
      await transition(db, fixture.workspace, order, 'return', payload, returnRequest);
      await transition(db, fixture.workspace, order, 'return', payload, returnRequest);
      const after = await stock(db, fixture, sku.id);
      assert.deepEqual([after.on_hand, after.in_transit, after.stock_value], [5, 0, '430000']);
      const events = (
        await db.query(
          `select sum(revenue_effect)::text revenue,sum(cogs_effect)::text cost,
      sum(transit_cost_effect)::text transit from public.sales_events where order_id=$1`,
          [order],
        )
      ).rows[0];
      assert.deepEqual(events, { revenue: '600000', cost: '420000', transit: '0' });
      assert.equal(
        (
          await db.query(
            "select count(*)::int n from public.sales_events where order_id=$1 and action='return'",
            [order],
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(() =>
        transition(db, fixture.workspace, order, 'return', {
          ...payload,
          lines: [{ line_id: line, qty: 6 }],
        }),
      );
    },
  );
  return { product: sku, order, line };
}
async function baseFixture(db) {
  await user(db, users.owner);
  const workspace = (await rpc(db, 'bootstrap_workspace', { p_name: 'Synthetic B1 owner' })).id;
  const supplier = (
    await rpc(db, 'save_master', {
      p_kind: 'suppliers',
      p_payload: { workspace_id: workspace, code: 'B1-NCC', name: 'Synthetic supplier' },
    })
  ).id;
  const warehouse = (
    await db.query('select id from public.warehouses where workspace_id=$1', [workspace])
  ).rows[0].id;
  const customer = await rpc(db, 'save_customer', {
    p_workspace_id: workspace,
    p_payload: { code: 'B1-KH', name: 'Synthetic customer' },
  });
  const fixture = { workspace, supplier, warehouse, customer };
  fixture.other = await product(db, workspace, supplier, 'B1-SKU-B');
  fixture.provisional = await product(db, workspace, supplier, 'OLD-UNCERTAIN-29-XANH', true);
  const account = (
    await db.query("select * from public.cash_accounts where workspace_id=$1 and code='CASH'", [
      workspace,
    ])
  ).rows[0];
  await rpc(db, 'save_master', {
    p_kind: 'cash_accounts',
    p_payload: {
      ...account,
      opening_balance: 1000000,
      opening_date: '2026-08-01',
      opening_confirmed: true,
    },
  });
  const cash = await rpc(db, 'create_cash', {
    p_payload: {
      workspace_id: workspace,
      account_id: account.id,
      direction: 'out',
      transaction_date: '2026-08-01',
      date_estimated: false,
      category: 'packaging',
      amount: 25000,
      description: 'Synthetic packaging',
    },
  });
  await rpc(db, 'post_cash', { p_id: cash.id, p_request_id: randomUUID() });
  await user(db, users.otherOwner);
  fixture.otherWorkspace = (
    await rpc(db, 'bootstrap_workspace', { p_name: 'Synthetic B1 outside workspace' })
  ).id;
  fixture.foreignProduct = await product(db, fixture.otherWorkspace, null, 'B1-SKU-B');
  await db.exec('reset role');
  for (const role of ['staff', 'viewer', 'manager'])
    await db.query('insert into public.workspace_members values($1,$2,$3)', [
      workspace,
      users[role],
      role,
    ]);
  await user(db, users.owner);
  return fixture;
}

try {
  for (const name of migrationNames) {
    const bytes = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url));
    migrations.push({
      name,
      sql: bytes.toString('utf8'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  stage = 'existing 003 fixture before B1';
  const db = await setup();
  const fixture = await baseFixture(db);
  const historical = await fifoLifecycle(db, fixture, 'B1-PRE', 'Before 004');
  fixture.main = historical.product;
  fixture.confirmed = await draft(db, fixture, 'B1-HELD', fixture.main.id, 1);
  await transition(db, fixture.workspace, fixture.confirmed, 'confirm', { date: '2026-08-07' });
  fixture.shipped = await draft(db, fixture, 'B1-TRANSIT', fixture.main.id, 1);
  await transition(db, fixture.workspace, fixture.shipped, 'confirm', { date: '2026-08-07' });
  await transition(db, fixture.workspace, fixture.shipped, 'ship', {
    date: '2026-08-08',
    carrier: 'Synthetic carrier',
    tracking_number: 'B1-TRANSIT-TRACK',
  });

  const protectedBefore = await snapshot(db, [
    ...preservedTables,
    'audit_events',
    'app_private.inventory_timeline',
    'app_private.sales_requests',
    'app_private.posting_requests',
  ]);
  const routinesBefore = await existingRoutines(db);
  stage = '004 migration';
  await ok(
    '004 upgrades existing V2 with posted cash, FIFO lots, held/shipped orders and a partial return',
    () => db.exec(migrations[3].sql),
  );
  await ok(
    '004 preserves every pre-existing product, document, ledger, audit and private posting/request row',
    async () => {
      assert.deepEqual(await snapshot(db, Object.keys(protectedBefore)), protectedBefore);
    },
  );
  await ok('004 preserves all historical function definitions and execution ACLs', async () => {
    const after = await existingRoutines(db);
    for (const old of routinesBefore)
      assert.deepEqual(
        after.find(
          (row) =>
            row.schema === old.schema && row.name === old.name && row.arguments === old.arguments,
        ),
        old,
      );
  });
  await user(db, users.owner);
  stage = 'B1 contracts';
  // Additional security/catalog assertions follow in the same disposable DB.
  const initialCatalog = await rpc(db, 'get_catalog_state', { p_workspace_id: fixture.workspace });
  await ok(
    'Every legacy SKU receives exactly one unmapped variant without inferred style, size or color',
    async () => {
      const products = (
        await db.query('select id from public.products where workspace_id=$1', [fixture.workspace])
      ).rows;
      assert.equal(initialCatalog.variants.length, products.length);
      for (const { id } of products) {
        const variants = initialCatalog.variants.filter((row) => row.product_id === id);
        assert.equal(variants.length, 1);
        assert.deepEqual(
          [
            variants[0].id,
            variants[0].style_id,
            variants[0].size,
            variants[0].color,
            variants[0].mapping_status,
            variants[0].origin,
          ],
          [id, null, null, null, 'needs_review', 'legacy_backfill'],
        );
      }
      assert.equal(initialCatalog.styles.length, 0);
      assert.equal(initialCatalog.aliases.length, 0);
    },
  );

  const catalog = () => rpc(db, 'get_catalog_state', { p_workspace_id: fixture.workspace });
  const resolve = (query, workspace = fixture.workspace) =>
    rpc(db, 'resolve_product_alias', { p_workspace_id: workspace, p_query: query });
  const style = (payload, workspace = fixture.workspace) =>
    rpc(db, 'save_product_style', { p_workspace_id: workspace, p_payload: payload });
  const variant = (payload, workspace = fixture.workspace) =>
    rpc(db, 'save_product_variant', { p_workspace_id: workspace, p_payload: payload });
  const alias = (payload, workspace = fixture.workspace) =>
    rpc(db, 'save_product_alias', { p_workspace_id: workspace, p_payload: payload });
  const review = (product_id, style_id, size = 'M', color = 'Xanh') => ({
    product_id,
    style_id,
    size,
    color,
    mapping_status: 'confirmed',
    review_note: 'Staff checked label against the physical SKU',
  });

  await ok(
    'Legacy reconciliation reports pending mappings and never invents a backfill actor',
    async () => {
      assert.deepEqual(initialCatalog.reconciliation, {
        product_count: 3,
        variant_count: 3,
        unmapped_count: 0,
        review_count: 3,
      });
      for (const row of initialCatalog.variants)
        assert.deepEqual([row.created_by, row.reviewed_by, row.reviewed_at], [null, null, null]);
    },
  );
  await ok('Pending SKU code returns needs_review with no selected product', async () => {
    const result = await resolve(fixture.main.code.toLowerCase());
    assert.equal(result.status, 'needs_review');
    assert.equal(result.product_id, null);
    assert.equal(result.candidates[0].product_id, fixture.main.id);
  });

  const mainStyle = await style({
    code: '  jean\t basic  ',
    name: '  Jean  Basic ',
    notes: 'Explicitly grouped by staff',
  });
  await ok(
    'Style normalization is explicit and same-workspace normalized codes stay unique',
    async () => {
      const row = (await catalog()).styles.find((entry) => entry.id === mainStyle);
      assert.equal(row.code, 'JEAN BASIC');
      assert.equal(row.name, 'Jean Basic');
      await assert.rejects(() => style({ code: 'jean\u00a0basic', name: 'Duplicate' }));
      await assert.rejects(() => style({ id: mainStyle, code: 'RENAMED', name: 'Wrong' }));
      await assert.rejects(() => style({ code: '', name: 'Empty code' }));
      await assert.rejects(() => style({ code: 'X', name: 'N'.repeat(201) }));
    },
  );
  await user(db, users.otherOwner);
  const foreignStyle = await style(
    { code: 'JEAN BASIC', name: 'Other workspace style' },
    fixture.otherWorkspace,
  );
  await user(db, users.owner);
  await ok(
    'Confirmation rejects foreign/missing style, provisional SKU, short evidence and invalid status',
    async () => {
      const before = await catalog();
      for (const payload of [
        review(fixture.main.id, foreignStyle),
        review(fixture.main.id, null),
        review(fixture.provisional.id, mainStyle),
        { ...review(fixture.main.id, mainStyle), review_note: 'short' },
        { ...review(fixture.main.id, mainStyle), review_note: '\u00a0'.repeat(20) },
        { ...review(fixture.main.id, mainStyle), mapping_status: 'unknown' },
        { ...review(fixture.main.id, mainStyle), size: 'X'.repeat(101) },
        review(fixture.foreignProduct.id, mainStyle),
      ])
        await assert.rejects(() => variant(payload));
      assert.deepEqual(await catalog(), before);
    },
  );
  await ok(
    'Confirmation preserves SKU UUID and records authenticated review evidence',
    async () => {
      assert.equal(await variant(review(fixture.main.id, mainStyle)), fixture.main.id);
      const row = (await catalog()).variants.find((entry) => entry.product_id === fixture.main.id);
      assert.equal(row.id, fixture.main.id);
      assert.equal(row.reviewed_by, users.owner);
      assert.ok(row.reviewed_at);
      assert.equal(row.origin, 'legacy_backfill');
      assert.equal((await resolve(fixture.main.code)).status, 'unique');
      assert.equal((await resolve(fixture.main.code)).product_id, fixture.main.id);
    },
  );
  await ok(
    'Confirmed style-size-color uniqueness is enforced after whitespace/case normalization',
    async () => {
      await assert.rejects(() =>
        variant(review(fixture.other.id, mainStyle, ' m ', '  XANH\u00a0')),
      );
      await variant(review(fixture.other.id, mainStyle, 'L', 'Xanh'));
    },
  );

  let sharedAlias;
  let otherAlias;
  await ok(
    'Aliases normalize Unicode NFC, case and all supported whitespace without removing accents',
    async () => {
      sharedAlias = await alias({
        product_id: fixture.main.id,
        alias_text: '  A\u0301O\u0085\u00a0 ĐỎ  ',
        active: true,
      });
      const row = (await catalog()).aliases.find((entry) => entry.id === sharedAlias);
      assert.equal(row.alias_text, 'ÁO ĐỎ');
      assert.equal(row.alias_key, 'áo đỏ');
      const match = await resolve('a\u0301o\t đo\u0309');
      assert.equal(match.status, 'unique');
      assert.equal(match.product_id, fixture.main.id);
      assert.equal((await resolve('ao do')).status, 'not_found');
      assert.equal((await resolve('áo-đỏ')).status, 'not_found');
      assert.equal((await resolve('áo đỏ extra')).status, 'not_found');
    },
  );
  await ok('Duplicate normalized alias for the same SKU is denied even when inactive', async () => {
    await assert.rejects(() =>
      alias({ product_id: fixture.main.id, alias_text: 'áo đỏ', active: false }),
    );
    await alias({
      id: sharedAlias,
      product_id: fixture.main.id,
      alias_text: 'Áo Đỏ',
      active: false,
    });
    assert.equal((await resolve('áo đỏ')).status, 'not_found');
    await assert.rejects(() =>
      alias({ product_id: fixture.main.id, alias_text: ' ÁO  ĐỎ ', active: true }),
    );
    await alias({
      id: sharedAlias,
      product_id: fixture.main.id,
      alias_text: 'Áo Đỏ',
      active: true,
    });
  });
  await ok(
    'Shared live alias across different SKUs reports ambiguous and never chooses one',
    async () => {
      otherAlias = await alias({ product_id: fixture.other.id, alias_text: 'áo đỏ', active: true });
      const result = await resolve('ÁO ĐỎ');
      assert.equal(result.status, 'ambiguous');
      assert.equal(result.product_id, null);
      assert.deepEqual(
        new Set(result.candidates.map((entry) => entry.product_id)),
        new Set([fixture.main.id, fixture.other.id]),
      );
      await alias({
        id: otherAlias,
        product_id: fixture.other.id,
        alias_text: 'áo đỏ',
        active: false,
      });
      assert.equal((await resolve('áo đỏ')).product_id, fixture.main.id);
    },
  );
  await ok(
    'Alias collision with another SKU code is ambiguous; matching code plus own alias is deduplicated',
    async () => {
      await alias({ product_id: fixture.main.id, alias_text: fixture.main.code, active: true });
      assert.equal((await resolve(fixture.main.code)).candidates.length, 1);
      const collision = await alias({
        product_id: fixture.other.id,
        alias_text: fixture.main.code,
        active: true,
      });
      assert.equal((await resolve(fixture.main.code)).status, 'ambiguous');
      await alias({
        id: collision,
        product_id: fixture.other.id,
        alias_text: fixture.main.code,
        active: false,
      });
      assert.equal((await resolve(fixture.main.code)).status, 'unique');
    },
  );
  await ok(
    'Alias editing cannot move its product, cross workspaces, use nonboolean active or exceed limits',
    async () => {
      const before = await catalog();
      for (const payload of [
        { id: sharedAlias, product_id: fixture.other.id, alias_text: 'Moved', active: true },
        { product_id: fixture.foreignProduct.id, alias_text: 'Foreign' },
        { product_id: fixture.main.id, alias_text: 'Bad bool', active: 'false' },
        { product_id: fixture.main.id, alias_text: 'x'.repeat(201) },
        { product_id: fixture.main.id, alias_text: '\u00a0\n' },
      ])
        await assert.rejects(() => alias(payload));
      await assert.rejects(() => resolve('x'.repeat(201)));
      assert.equal((await resolve(' \t ')).status, 'not_found');
      assert.deepEqual(await catalog(), before);
    },
  );
  await ok('SKU names alone and partial alias strings never perform fuzzy matching', async () => {
    assert.equal((await resolve(fixture.main.name)).status, 'not_found');
    assert.equal((await resolve('áo')).status, 'not_found');
    assert.equal((await resolve('B1-P')).status, 'not_found');
  });
  await ok(
    'Returning a mapping to review clears review actor/time and prevents automatic alias selection',
    async () => {
      await variant({ ...review(fixture.main.id, mainStyle), mapping_status: 'needs_review' });
      const row = (await catalog()).variants.find((entry) => entry.product_id === fixture.main.id);
      assert.equal(row.reviewed_by, null);
      assert.equal(row.reviewed_at, null);
      assert.equal((await resolve('áo đỏ')).status, 'needs_review');
      assert.equal((await resolve('áo đỏ')).product_id, null);
      await variant(review(fixture.main.id, mainStyle));
    },
  );

  for (const role of ['staff', 'viewer']) {
    await user(db, users[role]);
    await ok(
      `${role} can read catalog/resolve aliases but cannot mutate styles, variants or aliases`,
      async () => {
        assert.ok((await catalog()).variants.length > 0);
        assert.equal((await resolve('áo đỏ')).status, 'unique');
        await assert.rejects(() => style({ code: `${role}-DENIED`, name: 'Denied' }), {
          code: '42501',
        });
        await assert.rejects(() => variant(review(fixture.main.id, mainStyle)), { code: '42501' });
        await assert.rejects(() => alias({ product_id: fixture.main.id, alias_text: 'Denied' }), {
          code: '42501',
        });
      },
    );
  }
  await user(db, users.manager);
  await ok(
    'Manager mutations are allowed and attributed to that authenticated manager',
    async () => {
      const managerStyle = await style({ code: 'MANAGER', name: 'Manager style' });
      assert.equal(
        (await catalog()).styles.find((entry) => entry.id === managerStyle).created_by,
        users.manager,
      );
      await variant(review(fixture.main.id, mainStyle));
      assert.equal(
        (await catalog()).variants.find((entry) => entry.product_id === fixture.main.id)
          .reviewed_by,
        users.manager,
      );
    },
  );
  await user(db, users.otherOwner);
  await ok(
    'Another workspace cannot read rows or call any catalog RPC across tenant boundaries',
    async () => {
      for (const table of catalogTables)
        assert.equal(
          (
            await db.query(`select * from public.${table} where workspace_id=$1`, [
              fixture.workspace,
            ])
          ).rows.length,
          0,
        );
      await assert.rejects(() => catalog(), { code: '42501' });
      await assert.rejects(() => resolve('áo đỏ'), { code: '42501' });
      await assert.rejects(() => style({ code: 'FOREIGN', name: 'Denied' }), { code: '42501' });
      await assert.rejects(() => variant(review(fixture.main.id, mainStyle)), { code: '42501' });
      await assert.rejects(() => alias({ product_id: fixture.main.id, alias_text: 'Denied' }), {
        code: '42501',
      });
      const ownResult = await resolve(fixture.foreignProduct.code, fixture.otherWorkspace);
      assert.equal(ownResult.status, 'needs_review');
      assert.equal(ownResult.candidates.length, 1);
      assert.equal(ownResult.candidates[0].product_id, fixture.foreignProduct.id);
    },
  );
  await user(db, users.owner);
  await ok('Even owners cannot bypass RPCs with direct INSERT, UPDATE or DELETE', async () => {
    for (const table of catalogTables) {
      await assert.rejects(() => db.query(`insert into public.${table} default values`), {
        code: '42501',
      });
      await assert.rejects(
        () => db.query(`update public.${table} set workspace_id=workspace_id where false`),
        { code: '42501' },
      );
      await assert.rejects(() => db.query(`delete from public.${table} where false`), {
        code: '42501',
      });
    }
  });
  await ok('Private catalog helpers cannot be invoked by browser roles', async () => {
    await assert.rejects(() => db.query("select app_private.catalog_normalize('ABC')"), {
      code: '42501',
    });
    await assert.rejects(
      () => db.query('select app_private.catalog_lock($1)', [fixture.workspace]),
      { code: '42501' },
    );
  });
  await db.exec('reset role; set role anon');
  await ok(
    'Anonymous clients cannot SELECT catalog tables or execute public catalog RPCs',
    async () => {
      for (const table of catalogTables)
        await assert.rejects(() => db.query(`select * from public.${table}`), { code: '42501' });
      await assert.rejects(() => catalog(), { code: '42501' });
      await assert.rejects(() => resolve('áo đỏ'), { code: '42501' });
      await assert.rejects(() => style({ code: 'ANON', name: 'Denied' }), { code: '42501' });
    },
  );
  await user(db, users.owner);
  let newSku;
  await ok(
    'Existing save_master inserts automatically create one pending sku_created compatibility row',
    async () => {
      newSku = await product(db, fixture.workspace, fixture.supplier, 'NEW-29-XANH');
      const row = (await catalog()).variants.find((entry) => entry.product_id === newSku.id);
      assert.deepEqual(
        [row.id, row.origin, row.mapping_status, row.style_id, row.size, row.color, row.created_by],
        [newSku.id, 'sku_created', 'needs_review', null, null, null, users.owner],
      );
      assert.equal((await catalog()).reconciliation.unmapped_count, 0);
    },
  );
  await ok(
    'Null variant dimensions normalize to one exact confirmed combination per style',
    async () => {
      const unknownStyle = await style({ code: 'UNKNOWN-DIMS', name: 'Unspecified dimensions' });
      await variant(review(newSku.id, unknownStyle, '', '  '));
      const row = (await catalog()).variants.find((entry) => entry.product_id === newSku.id);
      assert.equal(row.size, null);
      assert.equal(row.color, null);
      await assert.rejects(() => variant(review(fixture.other.id, unknownStyle, null, null)));
    },
  );
  await ok('Updating an existing SKU never overwrites its confirmed variant metadata', async () => {
    const before = (await catalog()).variants.find((entry) => entry.product_id === fixture.main.id);
    await rpc(db, 'save_master', {
      p_kind: 'products',
      p_payload: { ...fixture.main, name: 'Updated product label', provisional: true },
    });
    assert.deepEqual(
      (await catalog()).variants.find((entry) => entry.product_id === fixture.main.id),
      before,
    );
    assert.equal((await resolve('áo đỏ')).status, 'needs_review');
    await rpc(db, 'save_master', {
      p_kind: 'products',
      p_payload: { ...fixture.main, provisional: false },
    });
    assert.equal((await resolve('áo đỏ')).status, 'unique');
  });
  await ok(
    'Catalog mutations have audit events with real actors and no financial movement side effect',
    async () => {
      const actions = (
        await db.query(
          "select distinct action from public.audit_events where workspace_id=$1 and action like 'product_%'",
          [fixture.workspace],
        )
      ).rows.map((row) => row.action);
      for (const action of [
        'product_style.saved',
        'product_variant.reviewed',
        'product_alias.saved',
        'product_variant.compatibility_created',
      ])
        assert.ok(actions.includes(action), action);
      const preserved = await snapshot(db, [
        'purchase_receipts',
        'stock_movements',
        'cash_transactions',
        'cash_movements',
        'sales_orders',
        'sales_order_lines',
        'sales_events',
        'inventory_lots',
        'sales_allocations',
      ]);
      for (const [table, rows] of Object.entries(preserved))
        assert.deepEqual(rows, protectedBefore[table], table);
      await user(db, users.owner);
    },
  );
  await fifoLifecycle(db, fixture, 'B1-AFTER', 'After 004');
  await ok(
    'A pre-migration reservation can still ship through the unchanged V2 RPC after 004',
    async () => {
      await transition(db, fixture.workspace, fixture.confirmed, 'ship', {
        date: '2026-08-09',
        carrier: 'Existing flow',
        tracking_number: 'PRE-004-RESERVATION',
      });
      const row = (
        await db.query(
          'select product_id,cost_amount::text as cost from public.sales_order_lines where order_id=$1',
          [fixture.confirmed],
        )
      ).rows[0];
      assert.equal(row.product_id, fixture.main.id);
      assert.equal(row.cost, '90000');
    },
  );
  await db.exec('reset role');
  await ok(
    'All new tables have RLS and exact normalized variant uniqueness exists at database level',
    async () => {
      const rows = (
        await db.query(
          "select tablename,rowsecurity from pg_tables where schemaname='public' and tablename=any($1)",
          [catalogTables],
        )
      ).rows;
      assert.equal(rows.length, 3);
      assert.ok(rows.every((row) => row.rowsecurity));
      await assert.rejects(
        () =>
          db.query(
            `update public.product_variants set style_id=$1,size='m',color='xanh',mapping_status='confirmed',
      reviewed_by=$2,reviewed_at=now(),review_note='Synthetic privileged integrity probe' where product_id=$3`,
            [mainStyle, users.owner, fixture.other.id],
          ),
        { code: '23505' },
      );
      await assert.rejects(
        () =>
          db.query('update public.product_variants set style_id=$1 where product_id=$2', [
            foreignStyle,
            fixture.main.id,
          ]),
        { code: '23503' },
      );
    },
  );

  // The remainder is intentionally scoped to catalog compatibility; it does not
  // implement/verify future commerce phases or claim live Supabase concurrency.
  const clean = await setup();
  await ok('Clean 001 -> 002 -> 003 -> 004 installation passes', () =>
    clean.exec(migrations[3].sql),
  );
  await ok(
    'Accidental replay of one-time 004 fails explicitly and leaves catalog schema intact',
    async () => {
      await assert.rejects(() => clean.exec(migrations[3].sql), /already exist/);
      await clean.exec('rollback');
      const rows = (
        await clean.query(
          "select tablename from pg_tables where schemaname='public' and tablename=any($1)",
          [catalogTables],
        )
      ).rows;
      assert.equal(rows.length, 3);
    },
  );
  const incomplete = await setup(2);
  await ok('Missing 003 dependency fails before creating any B1 catalog objects', async () => {
    await assert.rejects(
      () => incomplete.exec(migrations[3].sql),
      /requires completed V2 migration 003/,
    );
    await incomplete.exec('rollback');
    assert.equal(
      (
        await incomplete.query(
          "select tablename from pg_tables where schemaname='public' and tablename=any($1)",
          [catalogTables],
        )
      ).rows.length,
      0,
    );
  });

  await ok('Test runner leaves all migration bytes unchanged', async () => {
    for (const { name, sha256 } of migrations) {
      const bytes = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
    }
  });
} catch (error) {
  if (!checks.some((check) => check.status === 'FAIL'))
    checks.push({
      name: `Setup/fixture: ${stage}`,
      status: 'FAIL',
      code: error.code || error.name,
      detail: error.message,
    });
  console.error(`FAIL ${stage}: ${error.code || error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const db of opened) await db.close();
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../test-results/catalog-database.json', import.meta.url),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        engine: 'PGlite PostgreSQL',
        cloud_tested: false,
        simultaneous_sessions_tested: false,
        upgrade_scope:
          '003 installed on an empty database; V2 rows populated before 004. Existing 003/55006 populated-V1 upgrade blocker is separate and unchanged.',
        migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })),
        status: checks.some((check) => check.status === 'FAIL') ? 'FAIL' : 'PASS',
        checks,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `B1 database: ${checks.filter((check) => check.status === 'PASS').length} PASS, ${checks.filter((check) => check.status === 'FAIL').length} FAIL`,
  );
}
