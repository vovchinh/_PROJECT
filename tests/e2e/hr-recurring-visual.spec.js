import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test('recurring schedule and overtime manager screens work on desktop and mobile', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  mkdirSync('test-results/screenshots', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto('/#/hr');
  await expect(page.locator('.hr-workspace')).toBeVisible();
  await page.evaluate(async () => {
    (await import('/tests/fixtures/hr-recurring-preview.jsx')).mountRecurringPreview();
  });
  await expect(page.getByRole('heading', { name: 'Ca làm việc lặp' })).toBeVisible();
  await page.getByLabel('Lịch tuần đã tạo').selectOption('44444444-4444-4444-8444-444444444444');
  await page.getByLabel('Cửa hàng chấm công').selectOption('33333333-3333-4333-8333-333333333333');
  await expect(page.getByText('NV-001 · Nhân viên thử')).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Xem trước 7 ngày' }).click();
  await expect(page.getByText('6 ca sẽ tạo')).toBeVisible();
  await page.screenshot({
    path: 'test-results/screenshots/hr-recurring-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('button', { name: 'Xác nhận phân ca cho 1 nhân viên' }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/screenshots/hr-recurring-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);

  await page.evaluate(async () => {
    (await import('/tests/fixtures/hr-recurring-preview.jsx')).mountOvertimePreview();
  });
  await expect(page.getByText('Duyệt tăng ca', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await expect(page.getByLabel('Số phút được tính lương')).toHaveValue('60');
  await page.screenshot({
    path: 'test-results/screenshots/hr-overtime-mobile.png',
    fullPage: true,
  });
  expect(pageErrors).toEqual([]);
});
