import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results/demo-ui',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    headless: true,
    reducedMotion: 'reduce',
    locale: 'vi-VN',
    launchOptions: existsSync(edge) ? { executablePath: edge } : {},
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 5199',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: false,
    env: { VITE_DEMO_MODE: 'true', VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' },
    timeout: 30000,
  },
});
