import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { e2eOrigin } from '../../tools/e2e-ports.mjs';

export default defineConfig({
  testDir: fileURLToPath(new URL('../../tests/e2e/', import.meta.url)),
  testMatch: 'client-data.spec.js',
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  use: { baseURL: e2eOrigin('client'), trace: 'retain-on-failure' },
  projects: [{ name: 'client-data-chromium', metadata: { clientDataFixture: true }, use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node dev/client-data/serve.mjs',
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    url: `${e2eOrigin('client')}/dev/client-data/index.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
