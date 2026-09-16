import { test, expect } from '@playwright/test';

// Browser contract tests against simulated API replies, never the real project.
const wid = '11111111-1111-4111-8111-111111111111';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const instant = '2026-09-01T00:00:00Z';
const user = {
  id: userId,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'snapshot@chidi.test',
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

function fixture() {
  const customers = [
    { id: 'c1', code: 'KH-01', name: 'Tên mới trong danh bạ', phone: '0919999999' },
    { id: 'c2', code: 'KH-02', name: 'Khách khác', phone: '0981234567' },
  ];
  const addresses = [
    {
      id: 'a1',
      customer_id: 'c1',
      recipient_name: 'Người nhận mới',
      phone: '0919999999',
      address_line: '999 Địa chỉ đã thay đổi',
      city: 'TP Hồ Chí Minh',
      region: '',
      postal_code: '',
      country: 'VN',
      verified: false,
      verification_note: '',
      is_default: true,
    },
    {
      id: 'a2',
      customer_id: 'c1',
      recipient_name: 'Người nhận thứ hai',
      phone: '0921234567',
      address_line: '25 Địa chỉ phụ',
      city: '',
      region: '',
      postal_code: '',
      country: 'VN',
      verified: false,
      verification_note: '',
      is_default: false,
    },
    {
      id: 'foreign-address',
      customer_id: 'c2',
      recipient_name: 'Khách khác',
      phone: '0981234567',
      address_line: 'Địa chỉ không thuộc đơn này',
      country: 'VN',
      is_default: true,
      verified: false,
    },
  ];
  const snapshot = {
    source: 'address_selected',
    captured_at: instant,
    captured_by: userId,
    customer: {
      id: 'c1',
      code: 'KH-01',
      name: 'Tên khách khi chốt',
      phone: '0901234567',
      email: 'old@chidi.test',
    },
    shipping_address: {
      id: 'a1',
      recipient_name: 'Người nhận lúc xác nhận',
      phone: '0901234567',
      address_line: '18 Địa chỉ khi xác nhận',
      city: 'TP Hồ Chí Minh',
      region: 'Khu vực cũ',
      country: 'VN',
      verified: true,
    },
  };
  const orders = [
    {
      id: 'snapshot-order',
      code: 'DH-SNAPSHOT',
      status: 'confirmed',
      shipping_address_id: 'a1',
      customer_snapshot: snapshot,
      snapshot_source: 'address_selected',
    },
    {
      id: 'legacy-order',
      code: 'DH-LEGACY',
      status: 'confirmed',
      shipping_address_id: null,
      customer_snapshot: null,
      snapshot_source: 'legacy_unavailable',
    },
    {
      id: 'draft-order',
      code: 'DH-DRAFT',
      status: 'draft',
      shipping_address_id: null,
      customer_snapshot: null,
      snapshot_source: 'pending',
    },
  ].map((o) => ({
    ...o,
    customer_id: 'c1',
    warehouse_id: 'w1',
    order_date: '2026-09-01',
    channel: 'Manual',
    total_amount: '120000',
  }));
  return {
    catalog: {
      styles: [],
      variants: [],
      aliases: [],
      reconciliation: { product_count: 1, variant_count: 1, review_count: 1, unmapped_count: 0 },
    },
    customer: { identities: [], addresses, payment_intents: [], orders },
    stock: { reservations: [], allocations: [], order_reservations: [], inventory: [] },
    sales: {
      customers,
      sales_orders: orders,
      sales_order_lines: orders.map((o) => ({
        id: `line-${o.id}`,
        order_id: o.id,
        product_id: 'sku1',
        qty: 1,
        returned_qty: 0,
        unit_price: '120000',
        discount: '0',
        line_total: '120000',
        cost_amount: '0',
      })),
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
  };
}

async function setup(page, role = 'owner') {
  const state = { data: fixture(), requests: [], errors: [] };
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('https://chidi-test.supabase.co/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      input = request.postDataJSON();
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
      return json([{ workspace_id: wid, role, workspaces: { id: wid, name: 'Snapshot QA' } }]);
    if (path.startsWith('/rest/v1/rpc/')) {
      const name = path.split('/').at(-1);
      const reads = {
        get_catalog_state: 'catalog',
        get_customer_foundation: 'customer',
        get_inventory_foundation: 'stock',
        get_sales_state: 'sales',
      };
      if (reads[name]) return json(state.data[reads[name]]);
      if (name === 'set_order_address') {
        state.data.customer.orders.find((o) => o.id === input.p_order_id).shipping_address_id =
          input.p_address_id;
        return json(input.p_order_id);
      }
      if (name === 'save_customer_address') {
        const saved = input.p_payload;
        if (saved.is_default)
          state.data.customer.addresses
            .filter((a) => a.customer_id === saved.customer_id)
            .forEach((a) => {
              a.is_default = false;
            });
        Object.assign(
          state.data.customer.addresses.find((a) => a.id === saved.id),
          saved,
        );
        return json(saved.id);
      }
      return json({ message: `Unexpected RPC ${name}` }, 500);
    }
    if (path.startsWith('/rest/v1/')) {
      const table = path.split('/').at(-1);
      return json(
        table === 'products'
          ? [{ id: 'sku1', code: 'AO-01', name: 'Áo xanh', provisional: false, unit_cost: 80000 }]
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
  return state;
}
async function openFoundation(page) {
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Nền tảng thương mại', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Tương thích SKU và biến thể' })).toBeVisible();
}
const tab = (page, name) =>
  page
    .getByRole('group', { name: 'Phân hệ nền tảng thương mại' })
    .getByRole('button', { name, exact: true })
    .click();
const calls = (state, name) => state.requests.filter((r) => r.path.endsWith(`/rpc/${name}`));

test('confirmed sales detail uses captured customer/address instead of mutable current masters', async ({
  page,
}) => {
  const state = await setup(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Bán hàng', exact: true }).click();
  await page.getByRole('button', { name: 'Xem đơn DH-SNAPSHOT', exact: true }).click();
  const detail = page.getByRole('dialog');
  await expect(detail).toContainText('Tên khách khi chốt');
  await expect(detail).toContainText('Người nhận lúc xác nhận');
  await expect(detail).toContainText('18 Địa chỉ khi xác nhận');
  await expect(detail).toContainText('Địa chỉ đã xác minh thủ công.');
  await expect(detail).not.toContainText('Tên mới trong danh bạ');
  await expect(detail).not.toContainText('999 Địa chỉ đã thay đổi');
  expect(
    state.requests.filter((r) =>
      /set_order_address|save_customer_address|save_customer_identity|transition_sales_order/.test(
        r.path,
      ),
    ),
  ).toHaveLength(0);
  expect(state.errors).toEqual([]);
});

test('legacy confirmed order without snapshot explicitly shows historical address unavailable', async ({
  page,
}) => {
  const state = await setup(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Bán hàng', exact: true }).click();
  await page.getByRole('button', { name: 'Xem đơn DH-LEGACY', exact: true }).click();
  const detail = page.getByRole('dialog');
  await expect(detail).toContainText('Đơn này chưa có bản chụp thông tin nhận hàng lịch sử.');
  await expect(detail.getByLabel('Thông tin nhận hàng lúc xác nhận')).toHaveCount(0);
  await expect(detail).not.toContainText('999 Địa chỉ đã thay đổi');
  await expect(detail).not.toContainText('Địa chỉ đã xác minh thủ công.');
  expect(state.errors).toEqual([]);
});

test('staff can choose or clear only the draft customer address without identity or inventory controls', async ({
  page,
}) => {
  const state = await setup(page, 'staff');
  await openFoundation(page);
  await tab(page, 'Hồ sơ khách');
  await expect(page.getByRole('button', { name: /Thêm định danh|Thêm địa chỉ|^Sửa$/ })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Chọn địa chỉ', exact: true }).click();
  const choice = page.getByLabel('Địa chỉ nhận hàng', { exact: true });
  await expect(choice.locator('option[value="foreign-address"]')).toHaveCount(0);
  await choice.selectOption('a2');
  await expect(page.getByLabel('Workspace đang làm việc')).toBeDisabled();
  await page.getByRole('button', { name: 'Lưu thay đổi' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Chọn địa chỉ', exact: true }).click();
  await expect(page.getByLabel('Địa chỉ nhận hàng', { exact: true })).toHaveValue('a2');
  await page.getByLabel('Địa chỉ nhận hàng', { exact: true }).selectOption('');
  await page.getByRole('button', { name: 'Lưu thay đổi' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'set_order_address').map((r) => r.input)).toEqual([
    { p_workspace_id: wid, p_order_id: 'draft-order', p_address_id: 'a2' },
    { p_workspace_id: wid, p_order_id: 'draft-order', p_address_id: null },
  ]);
  await tab(page, 'Giữ hàng');
  await expect(
    page.getByRole('button', { name: /Tạo lượt giữ|Chuyển sang đơn|Giải phóng/ }),
  ).toHaveCount(0);
  await tab(page, 'Kế hoạch thanh toán');
  await expect(page.getByRole('button', { name: 'Thêm kế hoạch' })).toHaveCount(0);
  expect(calls(state, 'save_customer_address')).toHaveLength(0);
  expect(calls(state, 'save_customer_identity')).toHaveLength(0);
  expect(state.errors).toEqual([]);
});

test('editing address submits stable ownership, explicit default and manual verification evidence', async ({
  page,
}) => {
  const state = await setup(page);
  await openFoundation(page);
  await tab(page, 'Hồ sơ khách');
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: /25 Địa chỉ phụ/ }) });
  await row.getByRole('button', { name: 'Sửa', exact: true }).click();
  await expect(page.getByLabel('Khách hàng', { exact: true })).toBeDisabled();
  await page.getByLabel('Người nhận', { exact: true }).fill('Người nhận đã đối chiếu');
  await page.getByLabel('Địa chỉ mặc định').check();
  await page.getByLabel('Đã xác minh địa chỉ').check();
  await page.getByLabel('Căn cứ xác minh').fill('Khách đọc lại toàn bộ địa chỉ qua cuộc gọi.');
  await page.getByRole('button', { name: 'Lưu thay đổi' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'save_customer_address')[0].input).toMatchObject({
    p_workspace_id: wid,
    p_payload: {
      id: 'a2',
      customer_id: 'c1',
      recipient_name: 'Người nhận đã đối chiếu',
      is_default: true,
      verified: true,
      verification_note: 'Khách đọc lại toàn bộ địa chỉ qua cuộc gọi.',
    },
  });
  expect(
    state.requests.filter((r) => /set_order_address|transition_sales_order|post_cash/.test(r.path)),
  ).toHaveLength(0);
  expect(state.errors).toEqual([]);
});
