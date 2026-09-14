import { test, expect } from '@playwright/test';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222';
const instant = '2026-09-01T00:00:00Z';
const fixtureUser = {
  id: userId,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'owner@chidi.test',
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
async function mockCloud(page, { role = 'owner', missingReport = false } = {}) {
  const state = {
    hold: false,
    pending: [],
    requests: [],
    members: [{ user_id: userId, role, email_hint: 'o***@chidi.test', is_self: true }],
  };
  await page.route('https://chidi-test.supabase.co/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    state.requests.push({ path, body: req.postDataJSON?.() });
    const json = (body) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/v1/token')
      return json({
        access_token: jwt(),
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'fake-refresh-token',
        user: fixtureUser,
      });
    if (path === '/auth/v1/user') return json(fixtureUser);
    if (path === '/auth/v1/logout') return route.fulfill({ status: 204 });
    if (path === '/rest/v1/workspace_members')
      return json(
        [a, b].map((id, i) => ({
          workspace_id: id,
          role,
          workspaces: { id, name: `Workspace ${i ? 'B' : 'A'}` },
        })),
      );
    if (path === '/rest/v1/rpc/list_workspace_members') return json(state.members);
    if (path === '/rest/v1/rpc/add_workspace_member') {
      const input = req.postDataJSON();
      state.members.push({
        user_id: b,
        role: input.p_role,
        email_hint: 's***@chidi.test',
        is_self: false,
      });
      return json(state.members.at(-1));
    }
    if (path === '/rest/v1/rpc/get_workspace_report') {
      if (missingReport)
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'PGRST202', message: 'Function missing' }),
        });
      const input = req.postDataJSON(),
        zero = '0';
      return json({
        workspace_id: input.p_workspace_id,
        from: input.p_from,
        to: input.p_to,
        generated_at: instant,
        warnings: [],
        overview: {
          cash_in: '9007199254740993',
          cash_out: zero,
          net_cash_flow: '9007199254740993',
          opening_cash: zero,
          openings_in_period: zero,
          closing_cash: '9007199254740993',
          reconciliation_difference: zero,
          purchase_qty: zero,
          purchase_amount: zero,
          stock_qty_as_of: zero,
          stock_value_as_of: zero,
        },
        cash_accounts: [],
        cash_categories: [],
        stock_by_sku: [],
      });
    }
    if (path.startsWith('/rest/v1/')) {
      const id = url.searchParams.get('workspace_id')?.replace('eq.', ''),
        table = path.split('/').at(-1);
      if (state.hold && id === a && table === 'suppliers') {
        await new Promise((resolve) => state.pending.push(resolve));
      }
      if (table === 'suppliers')
        return json([
          {
            id: `${id}-supplier`,
            workspace_id: id,
            code: 'SUP',
            name: `NCC ${id === a ? 'A' : 'B'}`,
            created_at: instant,
          },
        ]);
      return json([]);
    }
    return route.fulfill({ status: 500, body: 'Unexpected mocked request' });
  });
  return state;
}
async function signin(page) {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('owner@chidi.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('FakePassword123!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByLabel('Workspace đang làm việc')).toBeVisible();
}
const nav = (page, label) =>
  page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();

test('cloud login does not instantiate corrupted demo storage; workspace switch loads correct data', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('chidi.erp.demo.v1', '{broken'));
  await mockCloud(page);
  await signin(page);
  await page.getByLabel('Workspace đang làm việc').selectOption(b);
  await nav(page, 'Danh mục');
  await page.getByRole('button', { name: /Nhà cung cấp/ }).click();
  await expect(page.getByRole('cell', { name: 'NCC B', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'NCC A', exact: true })).toHaveCount(0);
});

test('late refresh from previous workspace cannot overwrite the newly selected workspace', async ({
  page,
}) => {
  const state = await mockCloud(page);
  await signin(page);
  await nav(page, 'Danh mục');
  await page.getByRole('button', { name: /Nhà cung cấp/ }).click();
  await expect(page.getByRole('cell', { name: 'NCC A', exact: true })).toBeVisible();
  state.hold = true;
  await page.getByRole('button', { name: 'Tải lại dữ liệu' }).click();
  await expect.poll(() => state.pending.length).toBeGreaterThan(0);
  await page.getByLabel('Workspace đang làm việc').selectOption(b);
  await page.getByRole('button', { name: /Nhà cung cấp/ }).click();
  await expect(page.getByRole('cell', { name: 'NCC B', exact: true })).toBeVisible();
  state.hold = false;
  state.pending.splice(0).forEach((resolve) => resolve());
  await expect
    .poll(() => state.requests.filter((r) => r.path === '/rest/v1/suppliers').length)
    .toBeGreaterThan(2);
  await page.getByRole('button', { name: 'Tải lại dữ liệu' }).click();
  await expect(page.getByRole('cell', { name: 'NCC B', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'NCC A', exact: true })).toHaveCount(0);
});

test('logout clears access even with a previous refresh in flight', async ({ page }) => {
  const state = await mockCloud(page);
  await signin(page);
  await expect(page.getByRole('heading', { name: 'Tổng quan', exact: true })).toBeVisible();
  state.hold = true;
  await page.getByRole('button', { name: 'Tải lại dữ liệu' }).click();
  await expect.poll(() => state.pending.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Đăng nhập', exact: true })).toBeVisible();
  state.pending.splice(0).forEach((resolve) => resolve());
  await expect(page.getByLabel('Workspace đang làm việc')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Tổng quan', exact: true })).toHaveCount(0);
});

test('viewer cannot create documents or manage the team; report preserves integers beyond Number', async ({
  page,
}) => {
  await mockCloud(page, { role: 'viewer' });
  await signin(page);
  await nav(page, 'Nhập hàng');
  await expect(page.getByRole('button', { name: 'Tạo phiếu nhập', exact: true })).toHaveCount(0);
  await nav(page, 'Thiết lập');
  await expect(
    page.getByText('Bạn không có quyền quản lý thành viên.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Thêm thành viên', exact: true })).toHaveCount(0);
  await nav(page, 'Báo cáo');
  await expect(page.getByText('9.007.199.254.740.993', { exact: false }).first()).toBeVisible();
});

test('missing operations migration gives explicit upgrade error', async ({ page }) => {
  await mockCloud(page, { missingReport: true });
  await signin(page);
  await nav(page, 'Báo cáo');
  await expect(page.getByRole('alert')).toContainText('002_operations.sql');
  await expect(page.getByText('Chưa lấy được báo cáo', { exact: true })).toBeVisible();
});

test('owner adds a registered member to the selected workspace with explicit role', async ({
  page,
}) => {
  const state = await mockCloud(page);
  await signin(page);
  await page.getByLabel('Workspace đang làm việc').selectOption(b);
  await nav(page, 'Thiết lập');
  await page.getByLabel('Email đã đăng ký và xác nhận').fill('staff@chidi.test');
  await page.getByLabel('Quyền cấp').selectOption('staff');
  await page.getByRole('button', { name: 'Thêm thành viên', exact: true }).click();
  await expect(page.getByRole('cell', { name: /s\*\*\*@chidi.test/ })).toBeVisible();
  const call = state.requests.find((r) => r.path === '/rest/v1/rpc/add_workspace_member');
  expect(call.body).toEqual({ p_workspace_id: b, p_email: 'staff@chidi.test', p_role: 'staff' });
});
