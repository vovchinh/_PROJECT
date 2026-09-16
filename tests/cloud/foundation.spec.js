import { test, expect } from '@playwright/test';

const wid = '11111111-1111-4111-8111-111111111111';
const widB = '22222222-2222-4222-8222-222222222222';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const instant = '2026-09-01T00:00:00Z';
const user = {
  id: userId,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'foundation@chidi.test',
  email_confirmed_at: instant,
  app_metadata: { provider: 'email' },
  user_metadata: {},
  created_at: instant,
};
const jwt = () =>
  [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    Buffer.from(
      JSON.stringify({
        sub: userId,
        aud: 'authenticated',
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url'),
    'testsignature',
  ].join('.');
const product = {
  id: 'sku1',
  code: 'AO-01',
  name: 'Áo xanh',
  provisional: false,
  unit_cost: '80000',
};
const customer = { id: 'c1', code: 'KH-01', name: 'Khách hiện tại', phone: '+84901234567' };
const address = {
  id: 'a1',
  customer_id: 'c1',
  recipient_name: 'Người nhận A',
  phone: '0901234567',
  address_line: '18 Đường Một',
  country: 'VN',
  verified: false,
  is_default: true,
};
const order = {
  id: 'o1',
  code: 'DH-01',
  customer_id: 'c1',
  warehouse_id: 'w1',
  order_date: '2026-09-01',
  status: 'draft',
  total_amount: '200000',
  shipping_address_id: null,
  customer_snapshot: null,
  snapshot_source: 'pending',
};
const fixture = () => ({
  catalog: {
    styles: [{ id: 's1', code: 'AO', name: 'Áo', notes: '' }],
    variants: [{ id: 'sku1', product_id: 'sku1', mapping_status: 'needs_review', review_note: '' }],
    aliases: [{ id: 'al1', product_id: 'sku1', alias_text: 'áo hot', active: true }],
    reconciliation: { product_count: 1, variant_count: 1, review_count: 1, unmapped_count: 0 },
  },
  customer: { identities: [], addresses: [address], payment_intents: [], orders: [order] },
  stock: {
    reservations: [
      {
        id: 'r1',
        product_id: 'sku1',
        warehouse_id: 'w1',
        qty: 2,
        reserved_date: '2026-09-01',
        reference: 'GIU-01',
        status: 'active',
      },
    ],
    allocations: [],
    order_reservations: [],
    inventory: [{ product_id: 'sku1', warehouse_id: 'w1', on_hand: 10, reserved: 2, available: 8 }],
  },
  sales: {
    customers: [customer],
    sales_orders: [order],
    sales_order_lines: [],
    sales_events: [],
    inventory: [],
    summary: {
      delivered_amount: '0',
      returned_amount: '0',
      net_sales: '0',
      cost_of_goods: '0',
      gross_profit: '0',
      in_transit_cost: '0',
    },
  },
});
async function setup(page, { role = 'owner', missing = false, failFirstReserve = false } = {}) {
  const state = {
    requests: [],
    data: fixture(),
    reserveCount: 0,
    hold: false,
    pending: [],
    errors: [],
  };
  page.on('pageerror', (e) => state.errors.push(e.message));
  await page.route('https://chidi-test.supabase.co/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      input = req.postDataJSON();
    state.requests.push({ path, input });
    const json = (data, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/auth/v1/token')
      return json({
        access_token: jwt(),
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'fake-refresh',
        user,
      });
    if (path === '/auth/v1/user') return json(user);
    if (path === '/rest/v1/workspace_members')
      return json(
        [wid, widB].map((id, i) => ({
          workspace_id: id,
          role,
          workspaces: { id, name: `Workspace ${i ? 'B' : 'A'}` },
        })),
      );
    if (path.startsWith('/rest/v1/rpc/')) {
      const rpc = path.split('/').at(-1);
      if (rpc === 'get_catalog_state') {
        if (missing) return json({ code: 'PGRST202', message: 'Missing catalog' }, 404);
        if (state.hold && input.p_workspace_id === wid)
          await new Promise((resolve) => state.pending.push(resolve));
        const catalog = structuredClone(state.data.catalog);
        catalog.styles[0].name =
          input.p_workspace_id === widB ? 'Kiểu dáng workspace B' : 'Kiểu dáng workspace A';
        return json(catalog);
      }
      if (rpc === 'get_customer_foundation') return json(state.data.customer);
      if (rpc === 'get_inventory_foundation') return json(state.data.stock);
      if (rpc === 'get_sales_state') return json(state.data.sales);
      if (rpc === 'resolve_product_alias')
        return json({
          normalized: input.p_query,
          status: 'ambiguous',
          product_id: null,
          candidates: [
            { product_id: 'sku1', code: 'AO-01', name: 'Áo xanh' },
            { product_id: 'sku2', code: 'AO-02', name: 'Áo đỏ' },
          ],
        });
      if (rpc === 'reserve_inventory') {
        state.reserveCount++;
        if (failFirstReserve && state.reserveCount === 1)
          return json({ code: 'P0001', message: 'Lỗi tạm thời, thử lại cùng yêu cầu.' }, 500);
      }
      return json('saved-id');
    }
    if (path.startsWith('/rest/v1/')) {
      const table = path.split('/').at(-1);
      return json(
        table === 'products'
          ? [product]
          : table === 'warehouses'
            ? [{ id: 'w1', code: 'KHO', name: 'Kho chính' }]
            : [],
      );
    }
    return json({ message: 'Unexpected fixture request' }, 500);
  });
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('FakePassword123!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByLabel('Workspace đang làm việc')).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Nền tảng thương mại', exact: true })
    .click();
  if (!missing)
    await expect(page.getByRole('heading', { name: 'Tương thích SKU và biến thể' })).toBeVisible();
  return state;
}
const tab = (page, name) =>
  page
    .getByRole('group', { name: 'Phân hệ nền tảng thương mại' })
    .getByRole('button', { name, exact: true })
    .click();
const calls = (state, name) => state.requests.filter((r) => r.path.endsWith(`/rpc/${name}`));

test('old SKU mapping sends original product ID; unknown attributes remain null', async ({
  page,
}) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Đối chiếu', exact: true }).click();
  await expect(page.getByLabel('Workspace đang làm việc')).toBeDisabled();
  await page.getByLabel('Kiểu dáng', { exact: true }).selectOption('s1');
  await page.getByLabel('Trạng thái đối chiếu').selectOption('confirmed');
  await page.getByLabel('Căn cứ đối chiếu').fill('Đã kiểm tra mã hàng và mẫu thực tế.');
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'save_product_variant')[0].input).toMatchObject({
    p_workspace_id: wid,
    p_payload: {
      product_id: 'sku1',
      style_id: 's1',
      size: null,
      color: null,
      mapping_status: 'confirmed',
    },
  });
  expect(state.errors).toEqual([]);
});

test('ambiguous alias lists candidates, never creates orders, clears stale result on edit', async ({
  page,
}) => {
  const state = await setup(page);
  await tab(page, 'Alias');
  await page.getByLabel('Tra cứu SKU hoặc alias').fill('áo hot');
  await page.getByRole('button', { name: 'Tra cứu', exact: true }).click();
  await expect(page.getByText('Mơ hồ: khớp nhiều SKU — cần chọn lại thông tin')).toBeVisible();
  await expect(page.getByText(/AO-02 · Áo đỏ/)).toBeVisible();
  expect(calls(state, 'save_sales_order')).toHaveLength(0);
  await page.getByLabel('Tra cứu SKU hoặc alias').fill('khác');
  await expect(page.getByText(/Mơ hồ:/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Thêm alias', exact: true }).click();
  await page.getByLabel('SKU', { exact: true }).selectOption('sku1');
  await page.getByLabel('Alias', { exact: true }).fill('mẫu xanh');
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'save_product_alias')[0].input.p_payload).toEqual({
    product_id: 'sku1',
    alias_text: 'mẫu xanh',
    active: true,
  });
});

test('identity verification and draft address selection use explicit customer relationships', async ({
  page,
}) => {
  const state = await setup(page);
  await tab(page, 'Hồ sơ khách');
  await page.getByRole('button', { name: 'Thêm định danh' }).click();
  await page.getByLabel('Khách hàng', { exact: true }).selectOption('c1');
  await page.getByLabel('Định danh chính xác').fill('+84901234567');
  await page.getByLabel('Đã kiểm tra và xác minh thủ công').check();
  await page.getByLabel('Căn cứ xác minh').fill('Khách đã xác nhận số điện thoại này.');
  await page.getByRole('button', { name: 'Lưu thay đổi' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'save_customer_identity')[0].input.p_payload).toMatchObject({
    customer_id: 'c1',
    external_id: '+84901234567',
    channel: 'PHONE',
    verified: true,
  });
  await page.getByRole('button', { name: 'Chọn địa chỉ', exact: true }).click();
  await page.getByLabel('Địa chỉ nhận hàng', { exact: true }).selectOption('a1');
  await page.getByRole('button', { name: 'Lưu thay đổi' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'set_order_address')[0].input).toEqual({
    p_workspace_id: wid,
    p_order_id: 'o1',
    p_address_id: 'a1',
  });
});

test('hold retry retains request ID and displays combined availability; transfer uses chosen holds', async ({
  page,
}) => {
  const state = await setup(page, { failFirstReserve: true });
  await tab(page, 'Giữ hàng');
  await expect(page.getByRole('cell', { name: '8', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tạo lượt giữ', exact: true }).click();
  await page.getByLabel('SKU cần giữ').selectOption('sku1');
  await page.getByLabel('Số lượng', { exact: true }).fill('2');
  await page.getByLabel('Lý do', { exact: true }).fill('Khách yêu cầu giữ hàng đến chiều.');
  await page.getByRole('button', { name: 'Lưu thay đổi' }).click();
  await expect(page.getByRole('alert')).toContainText('Lỗi tạm thời');
  await page.getByRole('button', { name: 'Lưu thay đổi' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const attempts = calls(state, 'reserve_inventory');
  expect(attempts).toHaveLength(2);
  expect(attempts[0].input).toEqual(attempts[1].input);
  await page.getByRole('button', { name: 'Chuyển sang đơn', exact: true }).click();
  await page.getByLabel('Đơn nháp', { exact: true }).selectOption('o1');
  await page.getByRole('checkbox', { name: /GIU-01/ }).check();
  await page.getByRole('button', { name: 'Chuyển và xác nhận đơn' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'transfer_inventory_reservations')[0].input).toMatchObject({
    p_workspace_id: wid,
    p_order_id: 'o1',
    p_reservation_ids: ['r1'],
  });
});

test('payment plan keeps integer VND and never calls cash posting', async ({ page }) => {
  const state = await setup(page);
  await tab(page, 'Kế hoạch thanh toán');
  await expect(page.getByText(/Dự kiến \/ chưa ghi nhận thu chi/)).toBeVisible();
  await page.getByRole('button', { name: 'Thêm kế hoạch' }).click();
  await page.getByLabel('Đơn hàng', { exact: true }).selectOption('o1');
  await page.getByLabel('Số tiền dự kiến (VND)').fill('199999');
  await page.getByRole('button', { name: 'Lưu thay đổi' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'save_order_payment_intent')[0].input.p_payload).toMatchObject({
    order_id: 'o1',
    amount: '199999',
    kind: 'balance',
  });
  expect(state.requests.some((r) => /post_cash|save_cash|post_purchase/.test(r.path))).toBe(false);
});

test('viewer sees all tabs with no mutation controls; mobile contains horizontal tables', async ({
  page,
}) => {
  const state = await setup(page, { role: 'viewer' });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of [
    'SKU & biến thể',
    'Alias',
    'Hồ sơ khách',
    'Giữ hàng',
    'Kế hoạch thanh toán',
  ]) {
    await tab(page, name);
    await expect(
      page.locator('.foundation-page').getByRole('button', {
        name: /^(Thêm|Tạo lượt|Chuyển sang đơn|Sửa|Hủy|Giải phóng|Đối chiếu|Chọn địa chỉ)/,
      }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  expect(state.errors).toEqual([]);
});

test('missing migration is actionable and never loads demo data', async ({ page }) => {
  const state = await setup(page, { missing: true });
  await expect(page.getByRole('alert')).toContainText('004_catalog_variants_aliases.sql');
  await expect(page.getByRole('button', { name: 'Thử lại Phase B' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('chidi.erp.demo.v1'))).toBeNull();
  expect(state.errors).toEqual([]);
});

test('late foundation response cannot overwrite data after workspace switch', async ({ page }) => {
  const state = await setup(page);
  state.hold = true;
  await page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await expect.poll(() => state.pending.length).toBe(1);
  await page.getByLabel('Workspace đang làm việc').selectOption(widB);
  await expect(page.getByText('Kiểu dáng workspace B', { exact: true })).toBeVisible();
  state.pending.forEach((resolve) => resolve());
  await expect(page.getByText('Kiểu dáng workspace A', { exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});
