import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default defineConfig({
  testDir: fileURLToPath(new URL('../../tests/e2e', import.meta.url)),
  testMatch: 'fake-bridge.spec.js',
  fullyParallel: false, workers: 1, timeout: 30_000,
  forbidOnly: Boolean(process.env.CI), retries: 0,
  outputDir: join(tmpdir(), 'trips-fake-bridge-results'),
  use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure' },
});
