import { defineConfig, devices } from '@playwright/test';

// E2E_BASE_URL runs the suite against an already running server.
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: external ?? 'http://127.0.0.1:4176',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // Software WebGL2 so the suite runs on machines without a GPU.
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /phone\.spec\.js/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /phone\.spec\.js/ },
  ],
  webServer: external
    ? undefined
    : {
        command: 'npm run dev -- --port 4176 --strictPort --host 127.0.0.1',
        url: 'http://127.0.0.1:4176',
        reuseExistingServer: !process.env.CI,
      },
});
