import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test('QR kiosk and employee attendance render on desktop and mobile', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  mkdirSync('test-results/screenshots', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto('/#/hr');
  await expect(page.locator('.hr-workspace')).toBeVisible();
  await page.evaluate(async () => {
    const preview = await import('/tests/fixtures/hr-qr-preview.jsx');
    preview.mountQrManagerPreview();
  });
  await expect(page.getByText('Chấm công QR theo cửa hàng')).toBeVisible();
  await page
    .getByLabel('Cửa hàng hiển thị QR')
    .selectOption('33333333-3333-4333-8333-333333333333');
  await page.getByRole('button', { name: 'Mở kiosk' }).click();
  await expect(page.getByAltText('Mã QR chấm công đang có hiệu lực')).toBeVisible();
  await page.screenshot({
    path: 'test-results/screenshots/hr-qr-kiosk-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: 'test-results/screenshots/hr-qr-kiosk-mobile.png',
    fullPage: true,
  });
  const tableOverflow = await page
    .locator('.hr-qr-setup .table-scroll')
    .evaluateAll((tables) => tables.map((table) => table.scrollWidth - table.clientWidth));
  expect(tableOverflow.every((width) => width <= 1)).toBe(true);
  await page.getByRole('button', { name: 'Dừng kiosk' }).click();
  await expect(page.getByRole('button', { name: 'Mở kiosk' })).toBeVisible();
  await page.evaluate(async () => {
    const preview = await import('/tests/fixtures/hr-qr-preview.jsx');
    preview.mountQrEmployeePreview();
  });
  await expect(page.getByRole('heading', { name: 'Chấm công của tôi' })).toBeVisible();
  await expect(page.getByText('Ca sáng')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Quét giờ vào' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Phiếu lương của tôi' })).toBeVisible();
  await expect(page.getByText(/Thực nhận:.*480\.000/)).toBeVisible();
  await page.screenshot({
    path: 'test-results/screenshots/hr-qr-employee-mobile.png',
    fullPage: true,
  });
  expect(pageErrors).toEqual([]);
});
