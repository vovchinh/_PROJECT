import { test, expect } from '@playwright/test';
import { sampleImport } from '../../src/demo-sample.js';
import { mkdirSync } from 'node:fs';
const errors = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tổng quan', exact: true })).toBeVisible();
});
test.afterEach(() => expect(errors).toEqual([]));
const navigate = async (page, name) => {
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
};
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('chidi.erp.demo.v1')));
async function confirm(page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test('sample data, nine navigation pages, modal keyboard access and desktop capture', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Nạp dữ liệu minh họa', exact: true }).click();
  await expect.poll(async () => (await stored(page)).purchase_receipts.length).toBe(3);
  for (const name of [
    'Nhập hàng',
    'Kho hàng',
    'Thu chi',
    'Danh mục',
    'Đối chiếu dữ liệu',
    'Báo cáo',
    'Nhật ký',
    'Thiết lập',
    'Tổng quan',
  ]) {
    await page
      .getByRole('navigation')
      .getByRole('button', { name, exact: name !== 'Đối chiếu dữ liệu' })
      .click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/desktop.png', fullPage: true });
  await navigate(page, 'Nhập hàng');
  await page.getByRole('button', { name: 'Tạo phiếu nhập', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('create masters, draft a receipt, post exactly once, reverse without deleting source', async ({
  page,
}) => {
  await navigate(page, 'Danh mục');
  await page.getByRole('button', { name: /Nhà cung cấp/ }).click();
  await page.getByRole('button', { name: 'Thêm danh mục' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Mã/).fill('NCC-TEST');
  await dialog.getByLabel('Tên', { exact: true }).fill('Nhà cung cấp kiểm thử');
  await dialog.getByRole('button', { name: 'Lưu danh mục' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: /Sản phẩm \/ SKU/ }).click();
  await page.getByRole('button', { name: 'Thêm danh mục' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Mã/).fill('JEAN-TEST');
  await dialog.getByLabel('Tên', { exact: true }).fill('Jean xanh size M');
  await dialog
    .getByLabel('Nhà cung cấp mặc định')
    .selectOption({ label: 'NCC-TEST · Nhà cung cấp kiểm thử' });
  await dialog.getByLabel('Giá mua tham khảo (đ)').fill('85000');
  await dialog.getByRole('button', { name: 'Lưu danh mục' }).click();
  await expect(dialog).not.toBeVisible();
  await navigate(page, 'Nhập hàng');
  await page.getByRole('button', { name: 'Tạo phiếu nhập', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Sản phẩm / SKU').selectOption({ label: 'JEAN-TEST · Jean xanh size M' });
  await dialog.getByLabel('Ngày nhận').fill('2026-08-18');
  await dialog.getByLabel('Số lượng', { exact: true }).fill('3');
  await dialog.getByLabel(/^Chi phí nhập thêm/).fill('5000');
  await dialog.getByRole('button', { name: 'Lưu chờ xác nhận' }).click();
  await expect(dialog).not.toBeVisible();
  expect((await stored(page)).stock_movements).toHaveLength(0);
  await page.getByRole('button', { name: 'Ghi sổ', exact: true }).click();
  await confirm(page);
  let data = await stored(page);
  expect(data.stock_movements).toHaveLength(1);
  expect(data.stock_movements[0].amount).toBe(260000);
  await expect(page.getByRole('button', { name: 'Ghi sổ', exact: true })).toHaveCount(0);
  await navigate(page, 'Kho hàng');
  await expect(page.getByRole('row').filter({ hasText: 'JEAN-TEST' })).toContainText('260.000');
  await navigate(page, 'Nhập hàng');
  await page.getByRole('button', { name: 'Đảo', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Ngày đảo').fill('2026-08-19');
  await dialog.getByLabel('Lý do đảo').fill('Sai phiếu nhập cần kiểm tra lại');
  await confirm(page);
  data = await stored(page);
  expect(data.purchase_receipts).toHaveLength(1);
  expect(data.purchase_receipts[0].status).toBe('reversed');
  expect(data.stock_movements.reduce((n, r) => n + r.qty, 0)).toBe(0);
});

test('cash opening verification, posting guard, cash report and reversal', async ({ page }) => {
  await navigate(page, 'Thu chi');
  await page.getByRole('button', { name: 'Tạo thu chi' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Ngày thực tế').fill('2026-08-18');
  await dialog.getByLabel('Nội dung', { exact: true }).fill('Mua bao bì kiểm thử');
  await dialog.getByLabel('Tài khoản tiền').selectOption({ label: 'CASH · Tiền mặt' });
  await dialog.getByLabel('Số tiền (đ)', { exact: true }).fill('125000');
  await dialog.getByRole('button', { name: 'Lưu chờ xác nhận' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Ghi sổ', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('chưa xác nhận');
  await page.keyboard.press('Escape');
  await navigate(page, 'Danh mục');
  await page.getByRole('button', { name: /Tài khoản tiền/ }).click();
  await page.getByRole('button', { name: 'Sửa CASH', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Số dư đầu (đ)').fill('1000000');
  await dialog.getByLabel('Ngày mở sổ', { exact: true }).fill('2026-08-01');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Lưu danh mục' }).click();
  await expect(dialog).not.toBeVisible();
  await navigate(page, 'Thu chi');
  await page.getByRole('button', { name: 'Ghi sổ', exact: true }).click();
  await confirm(page);
  await navigate(page, 'Báo cáo');
  await page.getByLabel('Từ ngày báo cáo').fill('2026-08-01');
  await page.getByLabel('Đến ngày báo cáo').fill('2026-08-31');
  await expect(page.getByRole('row').filter({ hasText: 'Tiền mặt' })).toContainText('875.000');
  await navigate(page, 'Thu chi');
  await page.getByRole('button', { name: 'Đảo', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Ngày đảo').fill('2026-08-19');
  await dialog.getByLabel('Lý do đảo').fill('Đối chiếu phát hiện khoản chi trùng');
  await confirm(page);
  await navigate(page, 'Báo cáo');
  await expect(page.getByRole('row').filter({ hasText: 'Tiền mặt' })).toContainText('1.000.000');
  await expect(
    page.getByRole('heading', { name: 'Chưa có khoản chi ghi sổ trong kỳ' }),
  ).toBeVisible();
});

test('file import preview and idempotent reimport', async ({ page }) => {
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /Đối chiếu dữ liệu/ })
    .click();
  const file = {
    name: 'fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(sampleImport('2026-08-18'))),
  };
  await page.locator('input[type=file]').setInputFiles(file);
  expect((await stored(page)).purchase_receipts).toHaveLength(0);
  await page.getByRole('button', { name: 'Nhập vào workspace hiện tại' }).click();
  await expect(page.getByText('Đã hoàn tất nhập dữ liệu.', { exact: true })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(file);
  await page.getByRole('button', { name: 'Nhập vào workspace hiện tại' }).click();
  await expect(page.getByText('File này đã được nhập trước đó.', { exact: true })).toBeVisible();
  const data = await stored(page);
  expect(data.purchase_receipts).toHaveLength(3);
  expect(data.cash_transactions).toHaveLength(3);
  expect(data.cash_movements).toHaveLength(0);
});

test('mobile navigation and tables do not overflow the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Nạp dữ liệu minh họa', exact: true }).click();
  await page.getByRole('button', { name: 'Mở menu' }).click();
  await navigate(page, 'Nhập hàng');
  await expect(page.getByRole('heading', { name: 'Nhập hàng', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Mở menu' }).click();
  await navigate(page, 'Tổng quan');
  await page.screenshot({ path: 'test-results/screenshots/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});
