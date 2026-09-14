import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export default defineConfig({
  testDir: './tests/cloud',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results/cloud-ui',
  use: {
    baseURL: 'http://127.0.0.1:5201',
    headless: true,
    reducedMotion: 'reduce',
    locale: 'vi-VN',
    launchOptions: existsSync(edge) ? { executablePath: edge } : {},
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 5201',
    url: 'http://127.0.0.1:5201',
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      VITE_DEMO_MODE: 'false',
      VITE_SUPABASE_URL: 'https://chidi-test.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_fixture_only',
    },
  },
});
