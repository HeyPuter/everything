import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';

const require = createRequire(import.meta.url);
const axe = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

for (const entry of ['/', '/mock.html']) {
  test(`${entry} boots with the expected theme and SDK boundary`, async ({ page }, testInfo) => {
    const errors = [];
    const puterRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).hostname.endsWith('puter.com')) puterRequests.push(request.url());
    });
    await page.route('https://js.puter.com/v2/', (route) => route.fulfill({
      contentType: 'application/javascript', body: 'window.puter = { auth: { isSignedIn: () => false }, kv: {}, fs: {}, workers: {} };',
    }));
    await page.goto(entry);
    await expect(page.locator('html')).toHaveAttribute('data-boot', 'ready');
    await expect(page.getByRole('heading', { name: entry === '/' ? 'Trips' : 'Your trips', exact: true })).toBeVisible();
    await expect(page.locator(entry === '/' ? '.app-logo' : '.app-brand img')).toHaveJSProperty('naturalWidth', 192);
    const background = testInfo.project.use.colorScheme === 'dark' ? 'rgb(11, 11, 13)' : 'rgb(241, 241, 238)';
    await expect(page.locator('html')).toHaveCSS('background-color', background);
    expect(errors).toEqual([]);
    expect(puterRequests).toEqual(entry === '/' ? ['https://js.puter.com/v2/'] : []);
    if (entry === '/mock.html') await expect(page.locator('html')).toHaveAttribute('data-runtime', 'mock');
    await page.addScriptTag({ content: axe });
    expect(await page.evaluate(async () => (await window.axe.run()).violations)).toEqual([]);
    const screenshot = testInfo.outputPath('boot.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach('boot', { path: screenshot, contentType: 'image/png' });
  });
}

test('saved preference overrides the system theme', async ({ page }, testInfo) => {
  const theme = testInfo.project.use.colorScheme === 'dark' ? 'light' : 'dark';
  await page.addInitScript((value) => localStorage.setItem('trips:theme', value), theme);
  await page.goto('/mock.html');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
});

test('blocked local storage does not prevent boot', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {
    get() { throw new DOMException('Storage disabled', 'SecurityError'); },
  }));
  await page.goto('/mock.html');
  await expect(page.locator('html')).toHaveAttribute('data-boot', 'ready');
});

test('manifest icons resolve from the built app', async ({ request }) => {
  const manifestResponse = await request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('image/png');
  }
});
