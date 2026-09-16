import { PGlite } from '@electric-sql/pglite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Real PostgreSQL execution, local memory only. Authentication is simulated.
// This suite never loads .env, contacts Supabase or sends customer messages.
const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);
const migrationNames = (await readdir(migrationDirectory))
  .filter((n) => /^00[1-6]_.*\.sql$/.test(n))
  .sort();
const migrations = new Map(
  await Promise.all(
    migrationNames.map(async (name) => [
      name,
      await readFile(new URL(name, migrationDirectory), 'utf8'),
    ]),
  ),
);
const db = new PGlite();
const checks = [];
const users = Object.fromEntries(
  ['owner', 'other', 'manager', 'staff', 'viewer'].map((name, i) => [
    name,
    `${i + 1}`.repeat(8) +
      '-' +
      `${i + 1}`.repeat(4) +
      '-4' +
      `${i + 1}`.repeat(3) +
      '-8' +
      `${i + 1}`.repeat(3) +
      '-' +
      `${i + 1}`.repeat(12),
  ]),
);
const authSql = `create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`;
const newId = () => crypto.randomUUID();
async function ok(name, run) {
  await run();
  checks.push(name);
  console.log('PASS', name);
}
async function user(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
  await db.exec('set role authenticated');
}
async function rpc(name, args) {
  const entries = Object.entries(args);
  const result = await db.query(
    `select public.${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(',')}) as result`,
    entries.map(([, v]) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)),
  );
  return result.rows[0].result;
}
async function denied(name, args, pattern) {
  await assert.rejects(() => rpc(name, args), pattern);
}
async function rows(table, w) {
  return (await db.query(`select * from public.${table} where workspace_id=$1 order by id`, [w]))
    .rows;
}
async function financialState(w) {
  const result = {};
  for (const table of [
    'purchase_receipts',
    'stock_movements',
    'cash_transactions',
    'cash_movements',
    'cash_accounts',
    'inventory_lots',
    'sales_allocations',
    'sales_order_lines',
    'sales_events',
  ])
    result[table] = await rows(table, w);
  return result;
}
const tableNames = ['customer_identities', 'customer_addresses', 'payment_intents'];
let w, otherW, customer, secondCustomer, otherCustomer, product, warehouse, defaultAddress, orderId;
async function foundation() {
  return rpc('get_customer_foundation', { p_workspace_id: w });
}
async function identity(payload, workspace = w) {
  return rpc('save_customer_identity', {
    p_workspace_id: workspace,
    p_payload: {
      customer_id: customer,
      channel: 'TIKTOK_LIVE_USER',
      external_id: 'user-stable-01',
      verified: false,
      verification_note: '',
      ...payload,
    },
  });
}
async function address(payload, workspace = w) {
  return rpc('save_customer_address', {
    p_workspace_id: workspace,
    p_payload: {
      customer_id: customer,
      recipient_name: 'Khách nhận A',
      phone: '0901234567',
      address_line: '10 Đường mẫu',
      city: 'TP Hồ Chí Minh',
      region: '',
      postal_code: '',
      country: 'VN',
      is_default: false,
      verified: false,
      verification_note: '',
      ...payload,
    },
  });
}
async function createOrder(code, cid = customer, quantity = 2) {
  return rpc('save_sales_order', {
    p_workspace_id: w,
    p_payload: {
      code,
      customer_id: cid,
      warehouse_id: warehouse,
      order_date: '2026-08-18',
      channel: 'Manual QA',
      lines: [{ product_id: product.id, qty: quantity, unit_price: '120000', discount: '0' }],
    },
  });
}
async function transition(id, action, payload = {}) {
  return rpc('transition_sales_order', {
    p_workspace_id: w,
    p_order_id: id,
    p_action: action,
    p_payload: { date: '2026-08-18', ...payload },
    p_request_id: newId(),
  });
}
async function plan(payload = {}) {
  return rpc('save_order_payment_intent', {
    p_workspace_id: w,
    p_payload: {
      order_id: orderId,
      kind: 'deposit',
      amount: '100000',
      method: 'bank',
      notes: 'Kế hoạch, chưa thu tiền',
      ...payload,
    },
  });
}

try {
  await db.exec(authSql);
  for (const [name, id] of Object.entries(users))
    await db.query('insert into auth.users values($1,$2,now())', [id, `${name}@chidi.test`]);
  for (const [name, sql] of migrations) if (/^00[1-3]_/.test(name)) await db.exec(sql);
  await user(users.owner);
  w = (await rpc('bootstrap_workspace', { p_name: 'Customer foundation QA' })).id;
  for (const name of ['manager', 'staff', 'viewer'])
    await rpc('add_workspace_member', {
      p_workspace_id: w,
      p_email: `${name}@chidi.test`,
      p_role: name,
    });
  await user(users.other);
  otherW = (await rpc('bootstrap_workspace', { p_name: 'Other tenant QA' })).id;
  otherCustomer = await rpc('save_customer', {
    p_workspace_id: otherW,
    p_payload: { code: 'OTHER-KH', name: 'Other customer' },
  });
  await user(users.owner);
  customer = await rpc('save_customer', {
    p_workspace_id: w,
    p_payload: {
      code: 'KH-A',
      name: 'Tên khách gốc',
      phone: '0901234567',
      email: 'first@chidi.test',
      address: 'Địa chỉ cũ chưa xác minh',
    },
  });
  secondCustomer = await rpc('save_customer', {
    p_workspace_id: w,
    p_payload: { code: 'KH-B', name: 'Tên khách gốc', phone: '0901234567' },
  });
  const supplier = await rpc('save_master', {
    p_kind: 'suppliers',
    p_payload: { workspace_id: w, code: 'NCC-A', name: 'NCC mẫu' },
  });
  product = await rpc('save_master', {
    p_kind: 'products',
    p_payload: {
      workspace_id: w,
      code: 'SKU-A',
      name: 'SKU mẫu',
      supplier_id: supplier.id,
      unit_cost: 80000,
      provisional: false,
    },
  });
  warehouse = (await rows('warehouses', w))[0].id;
  for (const unitCost of [80000, 90000]) {
    const receipt = await rpc('create_purchase', {
      p_payload: {
        workspace_id: w,
        supplier_id: supplier.id,
        product_id: product.id,
        warehouse_id: warehouse,
        received_date: '2026-08-18',
        date_estimated: false,
        qty: 5,
        unit_cost: unitCost,
        additional_cost: 0,
      },
    });
    await rpc('post_purchase', { p_id: receipt.id, p_request_id: newId() });
  }
  const historicOrder = await createOrder('HISTORIC-CONFIRMED', customer, 1);
  await transition(historicOrder, 'confirm');
  const beforeUpgrade = await financialState(w);
  await db.exec('reset role');
  if (migrationNames.some((n) => n.startsWith('004_')))
    await db.exec(migrations.get(migrationNames.find((n) => n.startsWith('004_'))));
  await ok('005 upgrades actual V2 with an existing confirmed order', () =>
    db.exec(migrations.get('005_customer_order_foundation.sql')),
  );
  if (migrationNames.some((n) => n.startsWith('006_')))
    await ok('006 remains compatible after customer snapshot migration', () =>
      db.exec(migrations.get(migrationNames.find((n) => n.startsWith('006_')))),
    );
  await user(users.owner);
  await ok(
    'Migration preserves existing receipt, allocation, event and cash records byte-for-byte',
    async () => assert.deepEqual(await financialState(w), beforeUpgrade),
  );
  await ok('Historic confirmed order has no invented contact/address snapshot', async () => {
    const historic = (await foundation()).orders.find((o) => o.id === historicOrder);
    assert.equal(historic.customer_snapshot, null);
    assert.equal(historic.snapshot_source, 'legacy_unavailable');
    assert.equal(historic.shipping_address_id, null);
    assert.deepEqual((await foundation()).identities, []);
    assert.deepEqual((await foundation()).addresses, []);
    assert.deepEqual((await foundation()).payment_intents, []);
  });

  let identityId;
  await ok(
    'Explicit identity linking preserves customers sharing names/phone and never merges',
    async () => {
      identityId = await identity({});
      assert.equal((await rows('customers', w)).length, 2);
      assert.equal((await foundation()).identities[0].customer_id, customer);
    },
  );
  await ok(
    'Same stable ID may occur in separate channels; stable provider IDs remain case-sensitive',
    async () => {
      await identity({ channel: 'TIKTOK_SHOP_BUYER' });
      await identity({ channel: 'ZALO_UID' });
      await identity({ external_id: 'USER-stable-01', customer_id: secondCustomer });
      assert.equal((await foundation()).identities.length, 4);
    },
  );
  await ok(
    'Duplicate channel identity rejects reassignment and leaves audit/customer data intact',
    async () => {
      const before = await foundation(),
        audit = await rows('audit_events', w);
      await assert.rejects(
        () => identity({ external_id: ' user-stable-01 ', customer_id: secondCustomer }),
        /không tự gộp/,
      );
      await assert.rejects(
        () => identity({ id: identityId, customer_id: secondCustomer }),
        /Không đổi khách hàng/,
      );
      await assert.rejects(
        () => identity({ id: identityId, channel: 'ZALO_UID' }),
        /Không đổi khách hàng/,
      );
      assert.deepEqual(await foundation(), before);
      assert.deepEqual(await rows('audit_events', w), audit);
    },
  );
  await ok(
    'Email is trimmed/lowercased; phone is explicit canonical international format only',
    async () => {
      const emailId = await identity({ channel: 'EMAIL', external_id: '  SALES@ChiDi.Test  ' });
      const found = (await foundation()).identities.find((i) => i.id === emailId);
      assert.equal(found.external_id, 'SALES@ChiDi.Test');
      assert.equal(found.normalized_external_id, 'sales@chidi.test');
      await assert.rejects(
        () =>
          identity({
            channel: 'EMAIL',
            external_id: 'sales@chidi.test',
            customer_id: secondCustomer,
          }),
        /Định danh đã/,
      );
      await identity({ channel: 'PHONE', external_id: '+84901234567' });
      for (const value of ['0901234567', '+84 901234567', '+084901234567', 'name', ''])
        await assert.rejects(() => identity({ channel: 'PHONE', external_id: value }));
      await assert.rejects(() => identity({ channel: 'EMAIL', external_id: 'not-an-email' }));
      await assert.rejects(() => identity({ channel: 'FACEBOOK', external_id: 'stable-id' }));
    },
  );
  await ok(
    'Verification requires manual evidence and uses current authenticated actor',
    async () => {
      await assert.rejects(
        () => identity({ id: identityId, verified: true, verification_note: 'short' }),
        /căn cứ/,
      );
      await user(users.manager);
      await identity({
        id: identityId,
        verified: true,
        verification_note: 'Đối chiếu khách xác nhận qua cuộc gọi',
        verified_by: users.other,
      });
      let current = (await foundation()).identities.find((i) => i.id === identityId);
      assert.equal(current.verified_by, users.manager);
      assert.ok(current.verified_at);
      assert.equal(current.verified, true);
      await identity({ id: identityId, verified: false });
      current = (await foundation()).identities.find((i) => i.id === identityId);
      assert.equal(current.verified_by, null);
      assert.equal(current.verified_at, null);
      await user(users.owner);
    },
  );
  await ok(
    'Unicode edge whitespace is trimmed without folding stable IDs or accepting blank evidence',
    async () => {
      const id = await identity({ channel: 'ZALO_UID', external_id: '\t\u00a0Stable  ID\u3000\n' });
      const row = (await foundation()).identities.find((i) => i.id === id);
      assert.equal(row.external_id, 'Stable  ID');
      assert.equal(row.normalized_external_id, 'Stable  ID');
      await assert.rejects(
        () => identity({ channel: 'ZALO_UID', external_id: 'Stable  ID' }),
        /Định danh đã/,
      );
      await assert.rejects(
        () => identity({ verified: true, verification_note: '\t\u00a0\n'.repeat(10) }),
        /căn cứ/,
      );
      await assert.rejects(() => address({ address_line: '\u3000'.repeat(10) }), /thiếu/);
    },
  );
  await ok('Typed and bounded identity/address inputs reject malformed payloads', async () => {
    for (const payload of [
      null,
      [],
      'text',
      { customer_id: customer, channel: 'PHONE', external_id: 123 },
      { customer_id: customer, channel: 'PHONE', external_id: '+84901234567', verified: 'true' },
    ])
      await denied('save_customer_identity', { p_workspace_id: w, p_payload: payload });
    await assert.rejects(() => identity({ external_id: 'a'.repeat(321) }));
    await assert.rejects(() => address({ is_default: 'false' }));
    await assert.rejects(() => address({ country: 'VNM' }));
    await assert.rejects(() => address({ recipient_name: '' }));
    await assert.rejects(() => address({ phone: '' }));
    await assert.rejects(() => address({ address_line: {} }));
  });

  let alternateAddress, secondAddress;
  await ok(
    'Address default switches atomically with exactly one default per customer',
    async () => {
      const first = await address({ is_default: true });
      defaultAddress = await address({
        is_default: true,
        address_line: '20 Đường đã kiểm tra',
        verified: true,
        verification_note: 'Khách đọc lại địa chỉ qua điện thoại',
      });
      alternateAddress = first;
      const list = (await foundation()).addresses;
      assert.equal(list.filter((a) => a.is_default).length, 1);
      assert.equal(list.find((a) => a.id === first).is_default, false);
      const selected = list.find((a) => a.id === defaultAddress);
      assert.equal(selected.verified_by, users.owner);
      assert.equal(selected.country, 'VN');
      secondAddress = await address({ customer_id: secondCustomer, is_default: true });
      assert.equal((await foundation()).addresses.filter((a) => a.is_default).length, 2);
    },
  );
  await ok(
    'Invalid address verification cannot clear an existing default or append audit',
    async () => {
      const before = await foundation(),
        audit = await rows('audit_events', w);
      await assert.rejects(
        () =>
          address({
            id: alternateAddress,
            is_default: true,
            verified: true,
            verification_note: 'short',
          }),
        /căn cứ/,
      );
      assert.deepEqual(await foundation(), before);
      assert.deepEqual(await rows('audit_events', w), audit);
      await assert.rejects(
        () => address({ id: defaultAddress, customer_id: secondCustomer }),
        /Không chuyển/,
      );
    },
  );

  await ok(
    'Address selection is explicit, draft-only and restricted to the order customer',
    async () => {
      orderId = await createOrder('NEW-SNAPSHOT', customer, 2);
      const blank = (await foundation()).orders.find((o) => o.id === orderId);
      assert.equal(blank.shipping_address_id, null);
      assert.equal(blank.customer_snapshot, null);
      await denied(
        'set_order_address',
        { p_workspace_id: w, p_order_id: orderId, p_address_id: secondAddress },
        /Địa chỉ không thuộc/,
      );
      await user(users.staff);
      await rpc('set_order_address', {
        p_workspace_id: w,
        p_order_id: orderId,
        p_address_id: defaultAddress,
      });
      await user(users.owner);
      const auditBefore = (await rows('audit_events', w)).length;
      await rpc('set_order_address', {
        p_workspace_id: w,
        p_order_id: orderId,
        p_address_id: defaultAddress,
      });
      assert.equal((await rows('audit_events', w)).length, auditBefore);
    },
  );
  let immutableSnapshot;
  await ok(
    'Existing confirm RPC atomically captures selected address and preserves reservation behavior',
    async () => {
      await transition(orderId, 'confirm');
      const current = (await foundation()).orders.find((o) => o.id === orderId);
      assert.equal(current.status, 'confirmed');
      assert.equal(current.snapshot_source, 'address_selected');
      assert.equal(current.customer_snapshot.customer.name, 'Tên khách gốc');
      assert.equal(current.customer_snapshot.shipping_address.address_line, '20 Đường đã kiểm tra');
      assert.equal(current.customer_snapshot.shipping_address.verified, true);
      assert.equal(current.customer_snapshot.captured_by, users.owner);
      immutableSnapshot = structuredClone(current.customer_snapshot);
      const state = await rpc('get_sales_state', { p_workspace_id: w });
      assert.equal(state.inventory[0].on_hand, 10);
      assert.equal(state.inventory[0].reserved, 3);
      assert.equal(state.inventory[0].available, 7);
      await denied(
        'set_order_address',
        { p_workspace_id: w, p_order_id: orderId, p_address_id: alternateAddress },
        /đơn nháp/,
      );
    },
  );
  await ok(
    'Editing customer/address masters never rewrites already-confirmed snapshots',
    async () => {
      await rpc('save_customer', {
        p_workspace_id: w,
        p_payload: {
          id: customer,
          code: 'KH-A',
          name: 'Tên mới sau đơn',
          phone: '0919999999',
          email: 'new@chidi.test',
          address: 'Địa chỉ mới sau đơn',
        },
      });
      await address({
        id: defaultAddress,
        recipient_name: 'Người nhận mới',
        address_line: '999 Đường mới',
        phone: '0919999999',
      });
      const after = (await foundation()).orders.find((o) => o.id === orderId);
      assert.deepEqual(after.customer_snapshot, immutableSnapshot);
      assert.equal(
        (await foundation()).orders.find((o) => o.id === historicOrder).customer_snapshot,
        null,
      );
    },
  );
  await ok('Snapshot trigger rejects alteration even through privileged direct SQL', async () => {
    await db.exec('reset role');
    await assert.rejects(
      () =>
        db.query("update public.sales_orders set customer_snapshot='{}' where id=$1", [orderId]),
      /giữ nguyên/,
    );
    await assert.rejects(
      () =>
        db.query("update public.sales_orders set snapshot_source='pending' where id=$1", [orderId]),
      /giữ nguyên/,
    );
    await assert.rejects(
      () =>
        db.query('update public.sales_orders set shipping_address_id=null where id=$1', [orderId]),
      /giữ nguyên/,
    );
    await user(users.owner);
  });
  await ok(
    'Confirm without a selected address explicitly captures unverified legacy contact',
    async () => {
      const id = await createOrder('LEGACY-FALLBACK', customer, 1);
      await transition(id, 'confirm');
      const current = (await foundation()).orders.find((o) => o.id === id);
      assert.equal(current.shipping_address_id, null);
      assert.equal(current.snapshot_source, 'legacy_contact_unverified');
      assert.equal(current.customer_snapshot.shipping_address.verified, false);
      assert.equal(current.customer_snapshot.shipping_address.country, null);
      assert.equal(current.customer_snapshot.shipping_address.address_line, 'Địa chỉ mới sau đơn');
    },
  );
  await ok(
    'Changing a draft customer clears the old selected address through the original draft RPC',
    async () => {
      const id = await createOrder('CHANGE-CUSTOMER', customer, 1);
      await rpc('set_order_address', {
        p_workspace_id: w,
        p_order_id: id,
        p_address_id: defaultAddress,
      });
      await rpc('save_sales_order', {
        p_workspace_id: w,
        p_payload: {
          id,
          code: 'CHANGE-CUSTOMER',
          customer_id: secondCustomer,
          warehouse_id: warehouse,
          order_date: '2026-08-18',
          lines: [{ product_id: product.id, qty: 1, unit_price: 120000 }],
        },
      });
      const current = (await foundation()).orders.find((o) => o.id === id);
      assert.equal(current.customer_id, secondCustomer);
      assert.equal(current.shipping_address_id, null);
      assert.equal(current.customer_snapshot, null);
    },
  );
  await ok('A failed stock confirmation does not leave a partial snapshot or audit', async () => {
    const id = await createOrder('OUT-OF-STOCK', customer, 99);
    await rpc('set_order_address', {
      p_workspace_id: w,
      p_order_id: id,
      p_address_id: defaultAddress,
    });
    const before = await foundation(),
      audit = await rows('audit_events', w);
    await assert.rejects(() => transition(id, 'confirm'), /Không đủ/);
    assert.deepEqual(await foundation(), before);
    assert.deepEqual(await rows('audit_events', w), audit);
  });
  await ok(
    'Original ship/deliver still uses stored FIFO costs and leaves cash unchanged',
    async () => {
      const cashBefore = await rows('cash_movements', w);
      await transition(orderId, 'ship', { carrier: 'QA Manual', tracking_number: 'QA-005' });
      await transition(orderId, 'deliver');
      const state = await rpc('get_sales_state', { p_workspace_id: w });
      assert.equal(state.summary.net_sales, '240000');
      assert.equal(state.summary.cost_of_goods, '160000');
      assert.equal(state.summary.gross_profit, '80000');
      assert.deepEqual(await rows('cash_movements', w), cashBefore);
      assert.deepEqual(
        (await foundation()).orders.find((o) => o.id === orderId).customer_snapshot,
        immutableSnapshot,
      );
    },
  );

  let plannedId;
  await ok(
    'Deposit, balance and refund plans never mutate cash, inventory, sales events or revenue',
    async () => {
      const before = await financialState(w);
      plannedId = await plan();
      await plan({ kind: 'balance', amount: '9000000000000', method: 'cod' });
      await plan({ kind: 'refund', amount: 10000, method: 'cash' });
      await plan({
        id: plannedId,
        amount: '120000',
        method: 'other',
        notes: 'Sửa kế hoạch, chưa thu tiền',
      });
      assert.deepEqual(await financialState(w), before);
      const plans = (await foundation()).payment_intents;
      assert.equal(plans.length, 3);
      assert.ok(plans.every((p) => p.status === 'planned' && typeof p.amount === 'string'));
      assert.equal(plans.find((p) => p.id === plannedId).amount, '120000');
      assert.ok(plans.some((p) => p.amount === '9000000000000'));
    },
  );
  await ok(
    'Payment plans reject paid/settled claims, invalid amounts, kind changes and cross-order edits',
    async () => {
      for (const amount of [0, -1, 1.5, '', null, 'NaN', 'Infinity', '9000000000001', {}, true])
        await assert.rejects(() => plan({ amount }));
      for (const status of ['paid', 'settled', 'void', null])
        await assert.rejects(() => plan({ status }), /chỉ là kế hoạch/);
      await assert.rejects(() => plan({ method: 'unrecognized' }));
      await assert.rejects(() => plan({ kind: 'payment' }));
      await assert.rejects(() => plan({ id: plannedId, kind: 'refund' }), /Không đổi đơn/);
      await assert.rejects(() => plan({ id: plannedId, order_id: historicOrder }), /Không đổi đơn/);
    },
  );
  await ok(
    'Void plan is idempotent, audited once, preserves facts and cannot be edited again',
    async () => {
      const before = await financialState(w),
        count = (await rows('audit_events', w)).length;
      const args = {
        p_workspace_id: w,
        p_id: plannedId,
        p_reason: 'Khách thay đổi kế hoạch thanh toán',
      };
      assert.equal(await rpc('void_order_payment_intent', args), plannedId);
      assert.equal(await rpc('void_order_payment_intent', args), plannedId);
      assert.equal((await rows('audit_events', w)).length, count + 1);
      const current = (await foundation()).payment_intents.find((p) => p.id === plannedId);
      assert.equal(current.status, 'void');
      assert.equal(current.voided_by, users.owner);
      assert.equal(current.amount, '120000');
      assert.deepEqual(await financialState(w), before);
      await assert.rejects(() => plan({ id: plannedId }), /Chỉ sửa kế hoạch/);
      await denied('void_order_payment_intent', { ...args, p_reason: 'short' });
    },
  );
  await ok('Cancelled orders reject new payment plans', async () => {
    const id = await createOrder('CANCELLED', customer, 1);
    await transition(id, 'cancel', { reason: 'Đơn kiểm tra hủy trước khi giữ' });
    await assert.rejects(() => plan({ order_id: id }), /đã hủy/);
  });

  await ok(
    'Owner cannot link other-tenant customers or addresses even using known IDs',
    async () => {
      await assert.rejects(() => identity({ customer_id: otherCustomer }), /không thuộc workspace/);
      await assert.rejects(() => address({ customer_id: otherCustomer }), /không thuộc workspace/);
      await denied('get_customer_foundation', { p_workspace_id: otherW }, /không có quyền/);
      await denied(
        'save_customer_identity',
        {
          p_workspace_id: otherW,
          p_payload: { customer_id: otherCustomer, channel: 'ZALO_UID', external_id: 'other' },
        },
        /không có quyền/,
      );
    },
  );
  await user(users.other);
  let otherAddress, otherIdentity, otherOrder, otherPlan;
  await ok('Tenant B can independently use the same normalized external ID', async () => {
    otherIdentity = await identity(
      { customer_id: otherCustomer, channel: 'TIKTOK_LIVE_USER', external_id: 'user-stable-01' },
      otherW,
    );
    otherAddress = await address({ customer_id: otherCustomer, is_default: true }, otherW);
    const otherProduct = await rpc('save_master', {
      p_kind: 'products',
      p_payload: {
        workspace_id: otherW,
        code: 'OTHER-SKU',
        name: 'Other SKU',
        provisional: false,
        unit_cost: 1,
      },
    });
    otherOrder = await rpc('save_sales_order', {
      p_workspace_id: otherW,
      p_payload: {
        code: 'OTHER-ORDER',
        customer_id: otherCustomer,
        warehouse_id: (await rows('warehouses', otherW))[0].id,
        order_date: '2026-08-18',
        lines: [{ product_id: otherProduct.id, qty: 1, unit_price: 100000 }],
      },
    });
    otherPlan = await rpc('save_order_payment_intent', {
      p_workspace_id: otherW,
      p_payload: { order_id: otherOrder, kind: 'balance', amount: '100000', method: 'cod' },
    });
    await denied('get_customer_foundation', { p_workspace_id: w }, /không có quyền/);
    for (const table of tableNames) assert.deepEqual(await rows(table, w), []);
    assert.equal(
      (await rpc('get_customer_foundation', { p_workspace_id: otherW })).identities[0].id,
      otherIdentity,
    );
  });
  await user(users.owner);
  await ok(
    'Cross-workspace UUID updates and selections cannot bypass composite ownership',
    async () => {
      await assert.rejects(() => identity({ id: otherIdentity }), /Không tìm thấy/);
      await assert.rejects(() => address({ id: otherAddress }), /Không tìm thấy/);
      const draft = await createOrder('CROSS-ADDRESS', customer, 1);
      await denied(
        'set_order_address',
        { p_workspace_id: w, p_order_id: draft, p_address_id: otherAddress },
        /Địa chỉ không thuộc/,
      );
      assert.deepEqual(await rows('customer_identities', otherW), []);
      assert.deepEqual(await rows('customer_addresses', otherW), []);
      assert.deepEqual(await rows('payment_intents', otherW), []);
      await assert.rejects(() => plan({ order_id: otherOrder }), /không thuộc workspace/);
      await assert.rejects(() => plan({ id: otherPlan }), /Chỉ sửa kế hoạch/);
      await denied(
        'void_order_payment_intent',
        { p_workspace_id: w, p_id: otherPlan, p_reason: 'Không thể hủy kế hoạch tenant khác' },
        /Không tìm thấy/,
      );
    },
  );
  await ok('Direct REST-style writes to every new business table are denied', async () => {
    for (const table of tableNames) {
      await assert.rejects(
        () => db.query(`delete from public.${table} where workspace_id=$1`, [w]),
        /permission denied/,
      );
      await assert.rejects(
        () =>
          db.query(`update public.${table} set workspace_id=workspace_id where workspace_id=$1`, [
            w,
          ]),
        /permission denied/,
      );
      await assert.rejects(
        () => db.query(`insert into public.${table}(workspace_id) values($1)`, [w]),
        /permission denied/,
      );
    }
  });
  await ok(
    'Private validation and snapshot helpers cannot be invoked by application users',
    async () => {
      await assert.rejects(
        () => db.query("select app_private.foundation_text('{}','name',10,false)"),
        /permission denied/,
      );
      await assert.rejects(
        () => db.query("select app_private.foundation_boolean('{}','verified',false)"),
        /permission denied/,
      );
      await assert.rejects(
        () => db.query('select app_private.capture_order_customer_snapshot()'),
        /permission denied/,
      );
    },
  );
  await ok(
    'Staff/viewer may read but cannot edit identity/address/payment foundations',
    async () => {
      for (const role of ['staff', 'viewer']) {
        await user(users[role]);
        assert.ok((await foundation()).orders.length > 0);
        await assert.rejects(
          () => identity({ external_id: `forbidden-${role}` }),
          /không có quyền/,
        );
        await assert.rejects(() => address({}), /không có quyền/);
        await assert.rejects(() => plan(), /không có quyền/);
        await denied(
          'void_order_payment_intent',
          { p_workspace_id: w, p_id: plannedId, p_reason: 'Không được thao tác người xem' },
          /không có quyền/,
        );
      }
      const draft = (await foundation()).orders.find((o) => o.status === 'draft');
      await denied(
        'set_order_address',
        { p_workspace_id: w, p_order_id: draft.id, p_address_id: null },
        /không có quyền/,
      );
      await user(users.owner);
    },
  );
  await ok('Manager can maintain contact foundations and create/void payment plans', async () => {
    await user(users.manager);
    await address({ address_line: 'Địa chỉ quản lý xác nhận' });
    const id = await plan({ kind: 'refund', amount: 2000 });
    await rpc('void_order_payment_intent', {
      p_workspace_id: w,
      p_id: id,
      p_reason: 'Quản lý điều chỉnh kế hoạch',
    });
    await user(users.owner);
  });
  await ok('New tables have RLS and workspace-safe unique/FK/default constraints', async () => {
    await db.exec('reset role');
    const security = (
      await db.query(
        "select relname,relrowsecurity from pg_class where relnamespace='public'::regnamespace and relname=any($1::text[])",
        [tableNames],
      )
    ).rows;
    assert.equal(security.length, 3);
    assert.ok(security.every((r) => r.relrowsecurity));
    await assert.rejects(
      () =>
        db.query(
          'insert into public.customer_identities(workspace_id,customer_id,channel,external_id,normalized_external_id,created_by) values($1,$2,$3,$4,$4,$5)',
          [w, otherCustomer, 'ZALO_UID', 'impossible', users.owner],
        ),
      /foreign key/,
    );
    await assert.rejects(
      () =>
        db.query(
          "insert into public.customer_addresses(workspace_id,customer_id,recipient_name,phone,address_line,is_default,created_by) values($1,$2,'X','09','X',true,$3)",
          [w, secondCustomer, users.owner],
        ),
      /unique/,
    );
    await assert.rejects(
      () => db.query("update public.payment_intents set status='paid' where id=$1", [plannedId]),
      /check constraint/,
    );
    await user(users.owner);
  });
  await ok('Foundation read refuses oversize results instead of silently truncating', async () => {
    await db.exec('reset role');
    await db.exec('begin');
    await db.query(
      "insert into public.customer_identities(workspace_id,customer_id,channel,external_id,normalized_external_id,created_by) select $1,$2,'ZALO_UID','scale-'||g,'scale-'||g,$3 from generate_series(1,50001) g",
      [w, customer, users.owner],
    );
    await assert.rejects(() => rpc('get_customer_foundation', { p_workspace_id: w }), /50.000/);
    await db.exec('rollback');
    await user(users.owner);
    assert.ok((await foundation()).identities.length < 50000);
  });
  await ok(
    'Missing Auth identity and anonymous clients cannot execute foundation RPCs',
    async () => {
      await user(null);
      await denied('get_customer_foundation', { p_workspace_id: w }, /không có quyền/);
      await assert.rejects(() => identity({}), /không có quyền/);
      await db.exec('reset role;set role anon');
      for (const table of tableNames)
        await assert.rejects(() => rows(table, w), /permission denied/);
      for (const [name, args] of [
        ['get_customer_foundation', { p_workspace_id: w }],
        ['save_customer_identity', { p_workspace_id: w, p_payload: {} }],
        ['save_customer_address', { p_workspace_id: w, p_payload: {} }],
        ['set_order_address', { p_workspace_id: w, p_order_id: orderId, p_address_id: null }],
        ['save_order_payment_intent', { p_workspace_id: w, p_payload: {} }],
        [
          'void_order_payment_intent',
          { p_workspace_id: w, p_id: plannedId, p_reason: 'anonymous must not alter data' },
        ],
      ])
        await denied(name, args, /permission denied/);
    },
  );

  await ok('All available 001–006 migrations also apply to a clean database in order', async () => {
    const clean = new PGlite();
    try {
      await clean.exec(authSql);
      for (const [, sql] of migrations) await clean.exec(sql);
    } finally {
      await clean.close();
    }
  });
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../test-results/customer-foundation.json', import.meta.url),
    JSON.stringify(
      {
        status: 'PASS',
        checks: checks.length,
        names: checks,
        migrations: migrationNames,
        engine: 'PGlite PostgreSQL with simulated auth.users/auth.uid, local memory only',
        limitations:
          'No live Auth/PostgREST, no cloud mutations or messaging; single connection does not prove concurrent behavior.',
      },
      null,
      2,
    ),
  );
  console.log(`Customer foundation: ${checks.length}/${checks.length} PASS`);
} finally {
  await db.close();
}
