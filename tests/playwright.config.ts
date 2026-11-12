import { defineConfig, devices } from '@playwright/test';

// A port of its own: never reuse a `pnpm dev` / `pnpm dev:hosted` server on 5173,
// so the tests always talk to the LOCAL Supabase stack (mode development -> apps/web/.env.local).
const port = 5199;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './support/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    locale: 'bg-BG',
    timezoneId: 'Europe/Sofia',
  },
  webServer: {
    command: `pnpm --filter @happyhome/web exec vite --mode development --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
