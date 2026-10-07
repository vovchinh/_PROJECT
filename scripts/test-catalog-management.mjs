import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = new PGlite();
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const manager = '44444444-4444-4444-8444-444444444444';
const staff = '55555555-5555-4555-8555-555555555555';
const viewer = '66666666-6666-4666-8666-666666666666';
let passed = 0;

async function asUser(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
}
async function call(name, args) {
  const keys = Object.keys(args);
  const params = Object.values(args).map((v) =>
    v !== null && typeof v === 'object' ? JSON.stringify(v) : v,
  );
  const { rows } = await db.query(
    `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) as result`,
    params,
  );
  return rows[0].result;
}
async function check(name, run) {
  await run();
  passed++;
  console.log('PASS', name);
}

try {
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
  `);
  for (const id of [owner, other, manager, staff, viewer]) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [
      id,
      `${id.slice(0, 8)}@chidi.test`,
    ]);
  }
  const migrations = [
    '001_core', '002_operations', '003_sales_inventory', '004_catalog_variants_aliases',
    '005_customer_order_foundation', '006_inventory_reservations', '007_live_intake',
    '008_live_tickets_print', '009_live_operations', '010_tiktok_channel_flow',
    '011_tiktok_live_end', '012_live_runtime_telemetry', '013_catalog_management',
  ];
  for (let version = 1; version <= 12; version++) {
    const sql = await readFile(new URL(`../supabase/migrations/${migrations[version - 1]}.sql`, import.meta.url), 'utf8');
    await db.exec(sql);
  }
  await asUser(owner);
  const workspace = (await call('bootstrap_workspace', { p_name: 'Catalog 013 QA' })).id;
  for (const [id, role] of [[manager, 'manager'], [staff, 'staff'], [viewer, 'viewer']]) {
    await call('add_workspace_member', { p_workspace_id: workspace,
      p_email: `${id.slice(0, 8)}@chidi.test`, p_role: role });
  }
  const warehouse = (await db.query('select id from public.warehouses where workspace_id=$1', [workspace])).rows[0].id;
  const supplier = await call('save_master', { p_kind: 'suppliers', p_payload: {
    workspace_id: workspace, code: 'SUP-01', name: 'Nhà cung cấp test',
  } });
  const legacy = await call('save_master', { p_kind: 'products', p_payload: {
    workspace_id: workspace, code: 'LEGACY-01', name: 'SKU trước 013', unit_cost: 200000, provisional: false,
  } });
  const oldReceipt = await call('create_purchase', { p_payload: {
    workspace_id: workspace, product_id: legacy.id, warehouse_id: warehouse,
    supplier_id: supplier.id,
    received_date: '2026-08-18', qty: 2, unit_cost: 200000,
  } });
  await call('post_purchase', { p_id: oldReceipt.id,
    p_request_id: '33333333-3333-4333-8333-333333333333' });
  const before = (await db.query('select id,product_id,initial_qty,remaining_qty,initial_cost,remaining_cost from public.inventory_lots where workspace_id=$1 and product_id=$2', [workspace, legacy.id])).rows;
  await db.exec('reset role');
  await db.exec(await readFile(new URL(`../supabase/migrations/${migrations[12]}.sql`, import.meta.url), 'utf8'));
  await asUser(owner);
  await check('013 upgrades populated FIFO without changing historical product, receipt or lot', async () => {
    const current = (await db.query('select id,product_id,initial_qty,remaining_qty,initial_cost,remaining_cost from public.inventory_lots where workspace_id=$1 and product_id=$2', [workspace, legacy.id])).rows;
    assert.deepEqual(current, before);
    assert.equal((await db.query('select product_id from public.purchase_receipts where id=$1', [oldReceipt.id])).rows[0].product_id, legacy.id);
    assert.equal((await db.query('select id from public.product_variants where product_id=$1', [legacy.id])).rows[0].id, legacy.id);
  });
  await asUser(other);
  const otherWorkspace = (await call('bootstrap_workspace', { p_name: 'Catalog other QA' })).id;
  await asUser(owner);

  const group = await call('save_product_category', {
    p_workspace_id: workspace, p_payload: { code: 'JEAN', name: 'Jean', note: 'Quần jean' },
  });
  await check('Workspace category is created with RLS, normalized code and audit', async () => {
    assert.equal(group.code, 'JEAN');
    assert.equal(group.workspace_id, workspace);
    const audit = await db.query("select count(*)::integer n from public.audit_events where workspace_id=$1 and action='product_category.saved'", [workspace]);
    assert.equal(audit.rows[0].n, 1);
    await assert.rejects(() => call('save_product_category', {
      p_workspace_id: workspace, p_payload: { code: 'jean', name: 'Trùng' },
    }), /duplicate|tồn tại|unique/i);
  });
  await check('Manager may edit; staff and viewer read but cannot mutate category or SKU', async () => {
    await asUser(manager);
    const updated = await call('save_product_category', { p_workspace_id: workspace,
      p_payload: { id: group.id, code: group.code, name: 'Jean cập nhật' } });
    assert.equal(updated.name, 'Jean cập nhật');
    for (const id of [staff, viewer]) {
      await asUser(id);
      assert.equal((await db.query('select count(*)::integer n from public.product_categories where workspace_id=$1', [workspace])).rows[0].n, 1);
      await assert.rejects(() => call('save_product_category', { p_workspace_id: workspace,
        p_payload: { code: 'DENIED', name: 'Không được phép' } }), /permission|quyền|vai trò|role|42501/i);
    }
    await asUser(owner);
  });
  await check('Optional codes, hierarchy, sorting and cycle prevention are server-checked', async () => {
    const child = await call('save_product_category', { p_workspace_id: workspace,
      p_payload: { name: 'Jean nữ', description: 'Nhóm hàng nữ', parent_id: group.id, sort_order: 3 } });
    assert.equal(child.code, null);
    assert.equal(child.parent_id, group.id);
    assert.equal(child.sort_order, 3);
    const second = await call('save_product_category', { p_workspace_id: workspace,
      p_payload: { name: 'Jean nam' } });
    assert.equal(second.code, null);
    await assert.rejects(() => call('save_product_category', { p_workspace_id: workspace,
      p_payload: { id: group.id, code: group.code, name: group.name, parent_id: child.id } }), /CATALOG_PARENT/);
    await assert.rejects(() => call('set_product_category_archived', { p_workspace_id: workspace,
      p_id: group.id, p_archived: true, p_reason: 'Lưu trữ nhóm cha đang có nhóm con' }), /CATALOG_CHILD_ACTIVE/);
  });
  const product = await call('save_catalog_product', {
    p_workspace_id: workspace,
    p_payload: { code: 'J-01', name: 'Jean xanh', category_id: group.id, unit_cost: 600000,
      sale_price: 1000000, barcode: '8930123456789', provisional: false },
  });
  await check('Old SKU ID stays identical to compatibility variant and metadata is editable', async () => {
    assert.equal(product.category_id, group.id);
    const variant = await db.query('select id,product_id from public.product_variants where workspace_id=$1 and product_id=$2', [workspace, product.id]);
    assert.equal(variant.rows[0].id, product.id);
    const updated = await call('save_catalog_product', { p_workspace_id: workspace,
      p_payload: { id: product.id, code: product.code, name: 'Jean xanh mới', unit_cost: 600000,
        category_id: group.id, barcode: product.barcode, sale_price: 1100000, provisional: false } });
    assert.equal(updated.id, product.id);
    assert.equal(updated.sale_price, 1100000);
  });
  await check('Used category cannot be deleted, and member cannot write tables directly', async () => {
    await assert.rejects(() => call('delete_product_category', {
      p_workspace_id: workspace, p_id: group.id, p_reason: 'Kiểm thử xóa nhóm đang dùng',
    }), /CATALOG_IN_USE/);
    await assert.rejects(() => db.query('update public.products set name=$1 where id=$2', ['bypass', product.id]), /permission denied/i);
  });
  await check('Archive blocks new purchase but restore preserves SKU ID', async () => {
    await call('set_catalog_product_archived', { p_workspace_id: workspace, p_id: product.id,
      p_archived: true, p_reason: 'Tạm ngưng bán mẫu này để đối chiếu' });
    await assert.rejects(() => call('create_purchase', { p_payload: {
      workspace_id: workspace, product_id: product.id, warehouse_id: warehouse,
      received_date: '2026-08-18', qty: 1, unit_cost: 600000,
    } }), /CATALOG_ARCHIVED/);
    const restored = await call('set_catalog_product_archived', { p_workspace_id: workspace,
      p_id: product.id, p_archived: false, p_reason: 'Đã đối chiếu xong sản phẩm này' });
    assert.equal(restored.id, product.id);
    assert.equal(restored.archived_at, null);
  });
  const receipt = await call('create_purchase', { p_payload: {
    workspace_id: workspace, product_id: product.id, warehouse_id: warehouse,
    received_date: '2026-08-18', qty: 1, unit_cost: 600000,
  } });
  await check('Historical draft reference blocks deletion; archived SKU remains readable', async () => {
    const usage = await call('get_catalog_product_usage', { p_workspace_id: workspace, p_id: product.id });
    assert.equal(usage.can_delete, false);
    assert.equal(usage.references.purchase_receipts, 1);
    assert.ok(usage.reasons.includes('PRODUCT_HAS_HISTORY'));
    await assert.rejects(() => call('delete_catalog_product', { p_workspace_id: workspace,
      p_id: product.id, p_reason: 'Xóa sản phẩm đã có chứng từ' }), /PRODUCT_HAS_HISTORY/);
    assert.equal((await db.query('select product_id from public.purchase_receipts where id=$1', [receipt.id])).rows[0].product_id, product.id);
  });
  await check('Stock and active holds expose structured impact; held SKU cannot be archived', async () => {
    const held = await call('reserve_inventory', { p_workspace_id: workspace,
      p_payload: { product_id: legacy.id, warehouse_id: warehouse, qty: 1,
        date: '2026-10-06', reason: 'Giữ để thử an toàn lưu trữ' },
      p_request_id: '77777777-7777-4777-8777-777777777777' });
    const usage = await call('get_catalog_product_usage', { p_workspace_id: workspace, p_id: legacy.id });
    assert.ok(usage.reasons.includes('PRODUCT_HAS_HISTORY'));
    assert.ok(usage.reasons.includes('PRODUCT_HAS_STOCK'));
    assert.ok(usage.reasons.includes('PRODUCT_HAS_ACTIVE_RESERVATION'));
    await assert.rejects(() => call('set_catalog_product_archived', { p_workspace_id: workspace,
      p_id: legacy.id, p_archived: true, p_reason: 'Có giữ hàng nên chưa lưu trữ được' }), /PRODUCT_HAS_ACTIVE_RESERVATION/);
    await call('release_inventory_reservation', { p_workspace_id: workspace,
      p_reservation_id: held, p_date: '2026-10-06', p_reason: 'Kết thúc kiểm tra phiếu giữ hàng',
      p_request_id: '88888888-8888-4888-8888-888888888888' });
  });
  await check('Workspace isolation applies to category and product commands', async () => {
    await asUser(other);
    await assert.rejects(() => call('get_catalog_product_usage', { p_workspace_id: workspace, p_id: product.id }), /42501|quyền|permission|workspace|thành viên/i);
    await assert.rejects(() => call('set_catalog_product_archived', { p_workspace_id: workspace,
      p_id: product.id, p_archived: true, p_reason: 'Thử vượt quyền ở workspace khác' }), /42501|quyền|permission|workspace|thành viên/i);
    const rows = await db.query('select id from public.product_categories where workspace_id=$1', [workspace]);
    assert.equal(rows.rows.length, 0);
    await asUser(owner);
  });
  await check('Unreferenced product and category can be deleted with audit', async () => {
    const unused = await call('save_catalog_product', { p_workspace_id: workspace,
      p_payload: { code: 'UNUSED-01', name: 'Chưa dùng', unit_cost: 0, provisional: true } });
    const usage = await call('get_catalog_product_usage', { p_workspace_id: workspace, p_id: unused.id });
    assert.equal(usage.can_delete, true);
    await call('delete_catalog_product', { p_workspace_id: workspace, p_id: unused.id,
      p_reason: 'Chưa dùng trong bất kỳ nghiệp vụ nào' });
    assert.equal((await db.query('select count(*)::integer n from public.products where id=$1', [unused.id])).rows[0].n, 0);
    const unusedGroup = await call('save_product_category', { p_workspace_id: workspace,
      p_payload: { code: 'UNUSED', name: 'Nhóm chưa dùng' } });
    await call('delete_product_category', { p_workspace_id: workspace, p_id: unusedGroup.id,
      p_reason: 'Nhóm này chưa dùng trong chứng từ nào' });
    const aud = await db.query("select count(*)::integer n from public.audit_events where workspace_id=$1 and action in ('product.deleted','product_category.deleted')", [workspace]);
    assert.equal(aud.rows[0].n, 2);
  });
  await check('Clean 001–013 install creates workspace-scoped category schema', async () => {
    const fresh = new PGlite();
    try {
      await fresh.exec(`create role anon; create role authenticated; create schema auth;
        create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
        create function auth.uid() returns uuid language sql stable as $$
          select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        grant usage on schema auth to authenticated,anon;
        grant execute on function auth.uid() to authenticated,anon;`);
      for (const name of migrations) {
        await fresh.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
      }
      const tables = await fresh.query("select count(*)::integer n from pg_class where oid=to_regclass('public.product_categories')");
      assert.equal(tables.rows[0].n, 1);
    } finally { await fresh.close(); }
  });
  console.log(`Catalog management: ${passed} PASS, 0 FAIL`);
} finally {
  await db.close();
}
