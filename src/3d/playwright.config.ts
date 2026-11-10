import { defineConfig, devices } from '@playwright/test';

// E2E_BASE_URL runs the suite against an already running server (no web server is started).
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  retries: 0,
  workers: 2,
  timeout: 60_000,
  use: {
    baseURL: external ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        // index.html loads the Puter SDK; the suite runs without it (as offline) unless a test stubs it
        '--host-resolver-rules=MAP js.puter.com ~NOTFOUND',
        '--enable-unsafe-webgpu',
        process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: external
    ? undefined
    : {
        command: 'npm run dev -- --port 4173 --strictPort',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI,
      },
});
