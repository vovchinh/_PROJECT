import { test, expect } from '@playwright/test';
import { setup, calls, tab, review, wid, widB, instant } from './helpers/live-fixture.js';

test('TikTok account setup stores public username only and session is explicitly linked', async ({
  page,
}) => {
  const state = await setup(page);
  await tab(page, 'Thiết lập Live & máy in');
  await expect(page.getByRole('heading', { name: 'Máy in ZYWELL 822 · USB + LAN' })).toBeVisible();
  await page.getByRole('button', { name: 'Thêm tài khoản TikTok', exact: true }).click();
  await page.getByLabel('Tên hồ sơ kết nối').fill('TikTok ChiDi');
  await page.getByLabel('TikTok username (không có @)').fill('chidi.shop');
  await expect(page.getByRole('dialog').locator('input[type=password]')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'save_live_integration_account')[0].input).toEqual({
    p_workspace_id: wid,
    p_payload: { name: 'TikTok ChiDi', username: 'chidi.shop', enabled: true },
  });
  await page.getByRole('button', { name: 'Tạo phiên live', exact: true }).click();
  await page.getByLabel('Mã phiên', { exact: true }).fill('LIVE-TIKTOK');
  await page.getByLabel('Tên phiên', { exact: true }).fill('TikTok thật');
  await page.getByLabel('Nguồn bình luận').selectOption('tiktok_live');
  await page.getByLabel('Hồ sơ TikTok (khi dùng TikTok LIVE)').selectOption('a1');
  await page.getByLabel('Room / username của nguồn').fill('chidi.shop');
  await page.getByRole('dialog').getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'save_live_session')[0].input.p_payload).toMatchObject({
    campaign_id: 'cp1',
    provider: 'tiktok_live',
    integration_account_id: 'a1',
    room_id: 'chidi.shop',
  });
});

test('ingest and parser do not create a ticket or reservation; viewer sees suggestions', async ({
  page,
}) => {
  const state = await setup(page);
  await expect(page.getByText(/Có gợi ý SKU.*AO-01 × 2/)).toBeVisible();
  expect(calls(state, 'commit_live_sale_ticket')).toHaveLength(0);
  expect(calls(state, 'reserve_inventory')).toHaveLength(0);
  await page.getByRole('button', { name: 'Nhập bình luận', exact: true }).click();
  await page.getByLabel('ID người bình luận ổn định').fill('90071992547409933');
  await page.getByLabel('Tên hiển thị', { exact: true }).fill('Khách mới');
  await page.getByLabel('Nội dung bình luận').fill('áo hot 2c');
  await page.getByRole('dialog').getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'ingest_live_comments')[0].input.p_comments[0].author_external_id).toBe(
    '90071992547409933',
  );
  expect(state.tickets).toHaveLength(0);
});

test('CHOT retry uses same UUID; printing needs explicit paper confirmation, no duplicate ticket', async ({
  page,
}) => {
  const state = await setup(page, { failCommitResponse: true });
  await review(page);
  await expect(page.getByLabel('Workspace đang làm việc')).toBeDisabled();
  await page.getByRole('button', { name: 'CHỐT & IN', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Phản hồi gián đoạn');
  await page.getByRole('button', { name: 'CHỐT & IN', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Đối chiếu giấy');
  expect(calls(state, 'commit_live_sale_ticket')[0].input).toEqual(
    calls(state, 'commit_live_sale_ticket')[1].input,
  );
  expect(state.tickets).toHaveLength(1);
  expect(state.items).toHaveLength(1);
  expect(calls(state, 'finish_live_print_job')).toHaveLength(0);
  expect(await page.evaluate(() => window.__paperCalls)).toBe(1);
  await expect(page.getByRole('button', { name: 'Xác nhận giấy đã in' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /Tôi đã nhìn thấy giấy/ }).check();
  await page.getByRole('button', { name: 'Xác nhận giấy đã in' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'finish_live_print_job')[0].input).toMatchObject({
    p_workspace_id: wid,
    p_job_id: 'j1',
    p_lease_token: 'print-token',
    p_outcome: 'printed',
  });
  expect(state.pageErrors).toEqual([]);
});

test('claim conflict never opens commit form and stock failure leaves form without print job', async ({
  page,
}) => {
  const state = await setup(page, { otherClaim: true });
  await page.getByRole('button', { name: 'Nhận & kiểm tra' }).click();
  await expect(page.getByRole('alert')).toContainText('COMMENT_ALREADY_CLAIMED');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'commit_live_sale_ticket')).toHaveLength(0);
});

test('insufficient stock does not print or silently change to demo', async ({ page }) => {
  const state = await setup(page, { insufficient: true });
  await review(page);
  await page.getByRole('button', { name: 'CHỐT & IN', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Không đủ hàng');
  expect(state.jobs).toHaveLength(0);
  expect(await page.evaluate(() => window.__paperCalls)).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('chidi.erp.demo.v1'))).toBeNull();
});

test('blocked printer popup keeps committed sale; reprint only claims same print job', async ({
  page,
}) => {
  const state = await setup(page, { blockedPopup: true });
  await review(page);
  await page.getByRole('button', { name: 'CHỐT & IN', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Phiếu vẫn được giữ');
  expect(state.tickets).toHaveLength(1);
  expect(state.jobs[0].status).toBe('failed');
  await tab(page, 'Hàng đợi in');
  await page.getByRole('button', { name: 'Kiểm tra / in lại' }).click();
  await page.getByLabel('Lý do', { exact: true }).fill('Đã kiểm tra giấy và cần xử lý lại.');
  await page.getByRole('button', { name: 'Đưa vào hàng đợi' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Đối soát giấy', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Đối chiếu giấy');
  await page.getByRole('button', { name: 'Chưa rõ / đã hủy in' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'commit_live_sale_ticket')).toHaveLength(1);
  expect(state.items).toHaveLength(1);
  expect(state.jobs).toHaveLength(1);
  expect(calls(state, 'requeue_live_print_job')[0].input.p_job_id).toBe('j1');
});

test('viewer cannot change accounts, ingest, claim, commit or print; mobile remains readable', async ({
  page,
}) => {
  const state = await setup(page, { role: 'viewer' });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['Bàn live', 'Giỏ khách', 'Hàng đợi in', 'Thiết lập Live & máy in']) {
    await tab(page, name);
    await expect(
      page.locator('.live-page').getByRole('button', {
        name: /^(Nhận &|Nhập bình luận|Nhập JSON|Tạo chiến dịch|Tạo phiên|Thêm tài khoản|Sửa chiến dịch|Sửa phiên|Thiết lập tài khoản|CHỐT)/,
      }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
  }
  expect(state.pageErrors).toEqual([]);
});

test('staff can review a comment but cannot administer TikTok accounts or campaign settings', async ({
  page,
}) => {
  const state = await setup(page, { role: 'staff' });
  await review(page);
  await page.getByRole('button', { name: 'Bỏ nhận bình luận' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'release_live_comment_claim')).toHaveLength(1);
  await tab(page, 'Thiết lập Live & máy in');
  await expect(page.getByRole('button', { name: 'Thêm tài khoản TikTok' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tạo chiến dịch', exact: true })).toHaveCount(0);
});

test('keyset pagination sends complete cursor and latest reset clears both values', async ({
  page,
}) => {
  const state = await setup(page);
  state.hasMore = true;
  await page.getByRole('button', { name: 'Tải lại bàn live' }).click();
  await page.getByRole('button', { name: 'Xem bình luận cũ hơn' }).click();
  await expect(page.getByText('Bình luận trang cũ', { exact: true })).toBeVisible();
  expect(calls(state, 'get_live_intake').at(-1).input).toMatchObject({
    p_before: instant,
    p_before_id: 'cm1',
    p_limit: 100,
  });
  await page.getByRole('button', { name: 'Về bình luận mới nhất' }).click();
  await expect(page.getByText('áo hot 2c', { exact: true })).toBeVisible();
  expect(calls(state, 'get_live_intake').at(-1).input.p_before).toBeNull();
});

test('late live response is ignored after workspace switch', async ({ page }) => {
  const state = await setup(page);
  state.hold = true;
  await page.getByRole('button', { name: 'Tải lại bàn live' }).click();
  await expect.poll(() => state.pending.length).toBeGreaterThan(0);
  await page.getByLabel('Workspace đang làm việc').selectOption(widB);
  // Workspace remount starts in the seller flow; explicitly reopen legacy tools.
  await page.getByRole('button', { name: 'Thủ công / mô phỏng', exact: true }).click();
  await expect(page.getByLabel('Phiên đang vận hành')).toBeVisible();
  await tab(page, 'Thiết lập Live & máy in');
  await expect(page.getByText('Hồ sơ B', { exact: true })).toBeVisible();
  state.hold = false;
  state.pending.forEach((resolve) => resolve());
  await expect(page.getByText('Hồ sơ A', { exact: true })).toHaveCount(0);
  expect(state.pageErrors).toEqual([]);
});

test('missing Phase C migration shows precise upgrade file without loading demo', async ({
  page,
}) => {
  const state = await setup(page, { missing: true });
  await expect(page.getByRole('alert')).toContainText('007_live_intake.sql');
  expect(await page.evaluate(() => localStorage.getItem('chidi.erp.demo.v1'))).toBeNull();
  expect(state.pageErrors).toEqual([]);
});

test('catalog refresh error survives successful intake refresh and can recover', async ({
  page,
}) => {
  const state = await setup(page);
  const catalogRoute = '**/rest/v1/rpc/get_catalog_state';
  await page.route(catalogRoute, (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'P0001', message: 'Catalog tạm thời không khả dụng.' }),
    }),
  );
  await page.getByRole('button', { name: 'Tải lại bàn live' }).click();
  await expect(page.getByRole('alert')).toContainText('Catalog tạm thời không khả dụng.');
  await expect.poll(() => calls(state, 'get_live_intake').length).toBeGreaterThan(1);
  await expect(page.getByRole('alert')).toContainText('Catalog tạm thời không khả dụng.');
  await page.unroute(catalogRoute);
  await page.getByRole('button', { name: 'Tải lại bàn live' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.pageErrors).toEqual([]);
});

test('polling heals missed realtime comments without business side effects', async ({ page }) => {
  await page.clock.install();
  const state = await setup(page);
  state.comment.raw_text = 'Bình luận mới khi realtime mất kết nối';
  await page.clock.runFor(11000);
  await expect(page.getByText(state.comment.raw_text, { exact: true })).toBeVisible();
  expect(calls(state, 'commit_live_sale_ticket')).toHaveLength(0);
  expect(state.pageErrors).toEqual([]);
});
