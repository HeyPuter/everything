import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { E2E_PORTS, e2eOrigin } from '../../tools/e2e-ports.mjs';

// WebGL map checks on a built fixture; styles, tiles, glyphs and imagery are intercepted in the spec.
export default defineConfig({
  testDir: fileURLToPath(new URL('./', import.meta.url)),
  testMatch: '*.spec.js',
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  use: {
    baseURL: e2eOrigin('map'),
    trace: 'retain-on-failure',
    browserName: 'chromium',
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  projects: [
    { name: 'map-desktop', use: { colorScheme: 'light', viewport: { width: 1280, height: 800 } } },
    { name: 'map-phone', use: { colorScheme: 'dark', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: `node tests/map/serve.mjs ${E2E_PORTS.map}`,
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    url: `${e2eOrigin('map')}/tests/map/fixture.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
