import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Visual fixture mounts the real HR React components under the existing shell.
// The fixture API is local to this test; production remains Supabase-only.
test('HR desktop and mobile layout from real React components', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  mkdirSync('test-results/screenshots', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto('/#/hr');
  await expect(page.getByRole('heading', { name: 'Nhân sự & Tiền lương', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nhân sự cần Supabase' })).toBeVisible();
  await page.evaluate(async () => {
    const { mountHrPreview } = await import('/tests/fixtures/hr-preview.jsx');
    mountHrPreview();
  });
  await expect(page.getByText('Tổng nhân viên')).toBeVisible();
  await expect(page.getByText('Kho vận')).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/hr-desktop-dashboard.png', fullPage: true });
  await page.getByRole('navigation', { name: 'Phân hệ nhân sự xem thử' })
    .getByRole('button', { name: 'Nhân viên' }).click();
  await expect(page.getByText('NV-001')).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/hr-desktop-employees.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/screenshots/hr-mobile-employees.png', fullPage: true });
  await page.getByRole('button', { name: '+ Thêm nhân viên' }).click();
  await expect(page.getByText('Thông tin cơ bản')).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/hr-mobile-employee-form.png', fullPage: true });
  await page.getByRole('navigation', { name: 'Phân hệ nhân sự xem thử' })
    .getByRole('button', { name: 'Tổng quan' }).click();
  await page.screenshot({ path: 'test-results/screenshots/hr-mobile-dashboard.png', fullPage: true });
  expect(pageErrors).toEqual([]);
});
