import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { setup, calls, tab, openCommit, seedReferenceLive, wid } from './helpers/live-fixture.js';

const money = (value) =>
  new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(BigInt(value));
const cartCard = (page, number) =>
  page
    .locator('.live-customer-card')
    .filter({ has: page.getByText(`#${String(number).padStart(3, '0')}`, { exact: true }) });
async function start(page, options = {}) {
  await page.clock.setFixedTime(new Date('2026-09-21T05:00:00Z'));
  return setup(page, { seed: (state) => seedReferenceLive(state, options), ...options });
}
function noBusinessWrites(state) {
  for (const rpc of [
    'claim_live_comment',
    'commit_live_sale_ticket',
    'reserve_inventory',
    'claim_live_print_job',
    'finish_live_print_job',
  ])
    expect(calls(state, rpc), rpc).toHaveLength(0);
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
}

test('Comment search and status filters show only matching observations without creating sales', async ({
  page,
}) => {
  const state = await start(page);
  const comments = page.locator('.live-comment');
  await expect(comments).toHaveCount(4);
  await page.getByLabel('Tìm bình luận', { exact: true }).fill('MAI ANH');
  await expect(comments).toHaveCount(2);
  await page.getByLabel('Lọc trạng thái bình luận').selectOption('voided');
  await expect(comments).toHaveCount(1);
  await expect(comments).toContainText('Khách đổi ý không lấy');
  await expect(comments.getByRole('button', { name: 'Nhận & kiểm tra' })).toHaveCount(0);
  await page.getByLabel('Tìm bình luận', { exact: true }).fill('author-new');
  await expect(page.getByRole('heading', { name: 'Không có bình luận phù hợp' })).toBeVisible();
  await page.getByLabel('Lọc trạng thái bình luận').selectOption('new');
  await expect(comments).toHaveCount(1);
  await expect(comments).toContainText('Áo nóng xanh M');
  noBusinessWrites(state);
  expect(state.pageErrors).toEqual([]);
});

test('Queue-only printer mode commits once and leaves printing for the counter computer', async ({
  page,
}) => {
  const state = await setup(page);
  await tab(page, 'Thiết lập Live & máy in');
  await page.getByLabel('Cách in').selectOption('queue');
  await tab(page, 'Bàn live');
  await openCommit(page);
  await page.getByRole('button', { name: 'CHỐT & IN', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls(state, 'commit_live_sale_ticket')).toHaveLength(1);
  expect(calls(state, 'claim_live_print_job')).toHaveLength(0);
  expect(calls(state, 'finish_live_print_job')).toHaveLength(0);
  expect(await page.evaluate(() => window.__paperCalls)).toBe(0);
  expect(state.tickets).toHaveLength(1);
  expect(state.jobs).toHaveLength(1);
  expect(state.jobs[0].status).toBe('queued');
  await tab(page, 'Hàng đợi in');
  await expect(page.getByRole('row').filter({ hasText: 'LS-1' })).toContainText('Chờ in');
  expect(state.pageErrors).toEqual([]);
});

test('Cart search preserves original STT, same-name customers and cross-session VOID history', async ({
  page,
}) => {
  const state = await start(page);
  await tab(page, 'Giỏ khách');
  await expect(page.locator('.live-customer-card')).toHaveCount(2);
  await page.getByLabel('Tìm giỏ khách').fill('Nguyễn Mai Anh');
  await expect(page.locator('.live-customer-card')).toHaveCount(2);
  await page.getByLabel('Tìm giỏ khách').fill('#027');
  const card = cartCard(page, 27);
  await expect(page.locator('.live-customer-card')).toHaveCount(1);
  await expect(card).toContainText(money('900009'));
  await card.getByRole('button', { name: 'Xem giỏ & thông tin' }).click();
  const detail = page.getByRole('dialog', { name: 'Giỏ #027 · Nguyễn Mai Anh' });
  await expect(detail).toBeVisible();
  await expect(detail.getByText('LS-027', { exact: true })).toBeVisible();
  await expect(detail.getByText('LS-028', { exact: true })).toBeVisible();
  await expect(detail.getByText('LS-029', { exact: true })).toBeVisible();
  await expect(detail.getByText('Đã VOID', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Thông tin', exact: true }).click();
  await expect(detail.getByLabel('Liên kết khách ERP', { exact: true })).toHaveValue(
    'Chưa liên kết khách ERP',
  );
  await expect(detail.getByLabel('Điện thoại trong hồ sơ ERP hiện tại')).toHaveValue(
    'Chưa có thông tin',
  );
  await detail.getByRole('button', { name: 'Đóng giỏ' }).click();
  await page.getByLabel('Tìm giỏ khách').fill('#105');
  await expect(page.locator('.live-customer-card')).toHaveCount(0);
  await page.getByLabel('Lọc giỏ khách', { exact: true }).selectOption('all');
  await expect(cartCard(page, 105)).toContainText(money(0));
  await expect(cartCard(page, 105)).toContainText('#105');
  noBusinessWrites(state);
  expect(state.pageErrors).toEqual([]);
});

test('VOID from cart detail targets the selected ticket and retains its cart number and older ticket', async ({
  page,
}) => {
  const state = await start(page);
  await tab(page, 'Giỏ khách');
  await cartCard(page, 27).getByRole('button', { name: 'Xem giỏ & thông tin' }).click();
  await page.getByRole('button', { name: 'VOID phiếu LS-027', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'VOID LS-027', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Ngày VOID').fill('2026-09-21');
  await dialog.getByLabel('Lý do', { exact: true }).fill('Khách xác nhận hủy đúng phiếu LS-027.');
  await dialog.getByRole('button', { name: 'Xác nhận VOID', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls(state, 'void_live_sale_ticket')[0].input).toMatchObject({
    p_workspace_id: wid,
    p_ticket_id: 't27',
    p_date: '2026-09-21',
    p_reason: 'Khách xác nhận hủy đúng phiếu LS-027.',
  });
  await expect(cartCard(page, 27)).toContainText(money('700007'));
  expect(state.tickets.find((row) => row.id === 'tOld').status).toBe('committed');
  expect(state.jobs.find((row) => row.ticket_id === 't27').status).toBe('cancelled');
  noBusinessWrites(state);
  expect(state.pageErrors).toEqual([]);
});

test('Cart-specific print queue filters the selected original cart without starting a new print attempt', async ({
  page,
}) => {
  const state = await start(page);
  await tab(page, 'Giỏ khách');
  await cartCard(page, 8).getByRole('button', { name: 'Hàng đợi của giỏ', exact: true }).click();
  await expect(page.getByLabel('Lọc giỏ trong hàng đợi in')).toHaveValue('cart8');
  await expect(page.getByRole('row').filter({ hasText: 'LS-008' })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: 'LS-027' })).toHaveCount(0);
  await page.getByLabel('Lọc giỏ trong hàng đợi in').selectOption('');
  await expect(page.getByRole('row').filter({ hasText: 'LS-027' })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: 'LS-028' })).toContainText('Đã hủy');
  await expect(page.getByRole('row').filter({ hasText: 'LS-999' })).toHaveCount(0);
  noBusinessWrites(state);
  expect(state.pageErrors).toEqual([]);
});

test('Session history filters and opens the correct campaign while creation dates remain explicitly creation dates', async ({
  page,
}) => {
  const state = await start(page);
  await tab(page, 'Lịch sử phiên');
  await expect(page.getByRole('heading', { name: /Tạo ngày 21\/09\/2026/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Chưa rõ ngày tạo/ })).toBeVisible();
  await page.getByLabel('Tìm phiên live').fill('LIVE-ARCHIVE');
  await page.getByLabel('Lọc trạng thái phiên').selectOption('ended');
  await expect(page.locator('.live-session-row')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Mở phiên LIVE-ARCHIVE' })).toContainText(
    'Phiên đầu tháng',
  );
  await expect(page.getByRole('heading', { name: /Tạo ngày 05\/09\/2026/ })).toBeVisible();
  await page.getByLabel('Tìm phiên live').fill('');
  await page.getByLabel('Lọc nguồn phiên').selectOption('simulator');
  await expect(page.locator('.live-session-row')).toHaveCount(1);
  await expect(page.locator('.live-history')).not.toContainText(/Thời lượng|Bắt đầu lúc|\d+ phút/u);
  await page.getByRole('button', { name: 'Mở phiên LIVE-OLD' }).click();
  await expect(page.getByLabel('Phiên đang vận hành')).toHaveValue('s3');
  await expect(page.getByText('Bình luận phiên chiến dịch cũ', { exact: true })).toBeVisible();
  expect(calls(state, 'get_live_commerce').at(-1).input.p_campaign_id).toBe('cp2');
  expect(calls(state, 'get_live_intake').at(-1).input.p_session_id).toBe('s3');
  noBusinessWrites(state);
  expect(state.pageErrors).toEqual([]);
});

test('Campaign report totals exact integer money beyond Number precision and excludes VOID, other dates and campaigns', async ({
  page,
}) => {
  const state = await start(page, { reportExtras: 1002 });
  await tab(page, 'Báo cáo live');
  const report = page.locator('.live-reports');
  const large = 1002n * 8999999999999n;
  const sevenDay = large + 500005n;
  expect(sevenDay > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  expect(BigInt(Number(sevenDay))).not.toBe(sevenDay);
  await expect(report.locator('.live-kpi-value strong')).toHaveText(money(sevenDay));
  await expect(report).toContainText('15/09/2026 — 21/09/2026');
  await expect(report).toContainText('chưa ghi nhận doanh thu');
  await expect(report).toContainText('2 phiếu VOID trong kỳ');
  await report.getByText('Xem bảng số liệu theo ngày', { exact: true }).click();
  await expect(report.getByRole('row').filter({ hasText: '21/09/2026' })).toContainText(
    money(large + 200002n),
  );
  await page
    .getByRole('group', { name: 'Khoảng thời gian báo cáo live' })
    .getByRole('button', { name: '30 ngày', exact: true })
    .click();
  await expect(report.locator('.live-kpi-value strong')).toHaveText(money(large + 1200012n));
  await expect(report.getByRole('row').filter({ hasText: '01/09/2026' })).toContainText(
    money('700007'),
  );
  noBusinessWrites(state);
  expect(state.pageErrors).toEqual([]);
});

test('Mobile 390px keeps bottom navigation reachable and cart detail readable without page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await start(page);
  const nav = page.getByRole('navigation', { name: 'Phân hệ Live' });
  await expect(nav).toBeVisible();
  const position = await nav.evaluate((node) => getComputedStyle(node).position);
  expect(position).toBe('fixed');
  const box = await nav.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(845);
  expect(box.y).toBeGreaterThan(650);
  await tab(page, 'Giỏ khách');
  await noOverflow(page);
  await cartCard(page, 27).getByRole('button', { name: 'Xem giỏ & thông tin' }).click();
  const detail = page.getByRole('dialog', { name: 'Giỏ #027 · Nguyễn Mai Anh' });
  await expect(detail).toBeVisible();
  const detailBox = await detail.boundingBox();
  expect(detailBox.x).toBeGreaterThanOrEqual(0);
  expect(detailBox.width).toBeLessThanOrEqual(390);
  await detail.getByRole('button', { name: 'Đóng giỏ' }).click();
  await tab(page, 'Bàn live');
  await page.evaluate(() => window.scrollTo(0, 0));
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/live-ux-mobile.png', fullPage: true });
  expect(state.pageErrors).toEqual([]);
});

test('Desktop 1280px shows campaign report and navigation without horizontal page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const state = await start(page);
  await tab(page, 'Báo cáo live');
  await expect(page.locator('.live-reports .live-kpi-value strong')).toHaveText(money('500005'));
  await expect(
    page
      .getByRole('navigation', { name: 'Phân hệ Live' })
      .getByRole('button', { name: 'Báo cáo live', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('img', { name: /Biểu đồ giá trị phiếu/ })).toBeVisible();
  await noOverflow(page);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/live-ux-desktop.png', fullPage: true });
  noBusinessWrites(state);
  expect(state.pageErrors).toEqual([]);
});

test('Printer sample previews Vietnamese text and prints zero-value test paper without any business RPC', async ({
  page,
  browser,
  baseURL,
}) => {
  const state = await setup(page);
  await tab(page, 'Thiết lập Live & máy in');
  await page.getByRole('button', { name: 'Xem mẫu phiếu', exact: true }).click();
  await expect(page.locator('iframe[title="Mẫu phiếu Live 80 mm"]')).toHaveAttribute('sandbox', '');
  const preview = page.frameLocator('iframe[title="Mẫu phiếu Live 80 mm"]');
  await expect(preview.locator('body')).toContainText('IN-THU');
  await expect(preview.locator('body')).toContainText('KHÔNG PHẢI PHIẾU BÁN');
  await expect(preview.locator('body')).toContainText('Nguyễn Thị Diệu');
  await expect(preview.locator('body')).toContainText(/Tổng\s*0\s*đ/u);
  await expect(preview.locator('script,iframe,object,embed')).toHaveCount(0);
  await page.getByRole('button', { name: 'In thử 80 mm', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Đã mở hộp thoại in thử');
  expect(await page.evaluate(() => window.__paperCalls)).toBe(1);
  expect(state.tickets).toHaveLength(0);
  expect(state.jobs).toHaveLength(0);
  expect(
    state.requests.filter(
      (request) =>
        request.path.includes('/rpc/') && !request.path.split('/').at(-1).startsWith('get_'),
    ),
  ).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  const viewer = await browser.newPage({ baseURL });
  try {
    const viewerState = await setup(viewer, { role: 'viewer' });
    await tab(viewer, 'Thiết lập Live & máy in');
    await viewer.getByRole('button', { name: 'Xem mẫu phiếu', exact: true }).click();
    await expect(viewer.locator('iframe[title="Mẫu phiếu Live 80 mm"]')).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'In thử 80 mm', exact: true })).toHaveCount(0);
    noBusinessWrites(viewerState);
    expect(viewerState.pageErrors).toEqual([]);
  } finally {
    await viewer.close();
  }
});
