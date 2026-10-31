import { defineConfig } from '@playwright/test';
import { E2E_PORTS, e2eOrigin } from './tools/e2e-ports.mjs';

export default defineConfig({
  testDir: './tests/e2e',
  // Each runs once under its own config: test:e2e:client and test:e2e:bridge.
  testIgnore: ['**/client-data.spec.js', '**/fake-bridge.spec.js'],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: e2eOrigin('mock'),
    trace: 'retain-on-failure',
  },
  projects: ['light', 'dark'].flatMap((colorScheme) => [
    { name: `desktop-${colorScheme}`, use: { colorScheme, viewport: { width: 1280, height: 800 } } },
    { name: `phone-${colorScheme}`, use: { colorScheme, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ]),
  webServer: {
    command: `npm run build:mock && npm run preview:mock -- --host 127.0.0.1 --port ${E2E_PORTS.mock}`,
    url: e2eOrigin('mock'),
    reuseExistingServer: false,
  },
});
