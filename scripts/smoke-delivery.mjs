import { chromium, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
});
try {
  const context = await browser.newContext({
    locale: 'vi-VN',
    viewport: { width: 1440, height: 960 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto('http://localhost:2000');
  assert.equal(response.status(), 200);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).waitFor();
  mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/cloud-login.png', fullPage: true });
  await page.goto(pathToFileURL(resolve('docs/index.html')).href);
  await page.getByRole('button', { name: 'Bước tiếp V1.1', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Thiết lập và vận hành ChiDi ERP V1.1', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Prompt triển khai', exact: true }).click();
  await page.getByRole('button', { name: 'Sao chép toàn bộ prompt' }).click();
  await expect(page.locator('#copy-prompt')).toHaveText(/Đã sao chép|Markdown/);
  await page.getByRole('button', { name: 'Kiến trúc', exact: true }).click();
  await page.screenshot({ path: 'test-results/screenshots/documentation.png' });
  assert.deepEqual(errors, []);
  writeFileSync(
    'test-results/smoke-delivery.json',
    JSON.stringify(
      {
        local_url: 'http://localhost:2000',
        login_screen: true,
        real_signin_performed: false,
        docs_navigation: true,
        copy_button: true,
        page_errors: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS Local cloud login screen, standalone documents navigation/copy and no page errors. No real sign-in or data writes.',
  );
} finally {
  await browser.close();
}
