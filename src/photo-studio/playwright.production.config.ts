import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const port = Number(process.env.PHOTO_EDITOR_TEST_PORT ?? 5187);
export default defineConfig({
  ...base,
  testDir: 'tests/production',
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}` },
});
