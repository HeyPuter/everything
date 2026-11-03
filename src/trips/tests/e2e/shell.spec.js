import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { createTestBridgeHost } from '../../dev/fake-puter/bridge-host.js';
import { attachFakePuterContext } from '../../dev/fake-puter/bridge-playwright.js';
const require = createRequire(import.meta.url);
const alice = { uuid: '00000000-0000-4000-8000-000000000001', username: 'alice' };
const bob = { uuid: '00000000-0000-4000-8000-000000000002', username: 'bob' };
const axe = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
async function audit(page) {
  await page.evaluate(async () => Promise.all(document.getAnimations().filter((animation) => animation.effect.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: axe });
  expect(await page.evaluate(async () => (await window.axe.run()).violations)).toEqual([]);
}
async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`); await page.screenshot({ path, fullPage: true }); await testInfo.attach(name, { path, contentType: 'image/png' });
}
async function mock(page, path = '/mock.html') {
  await page.goto(path); await expect(page.locator('html')).toHaveAttribute('data-boot', 'ready'); await expect(page.getByRole('heading', { name: 'Your trips', exact: true })).toBeVisible();
}
test.beforeEach(async ({ page }) => { page.on('pageerror', (error) => { throw error; }); });
test('responsive dashboard shell passes axe', async ({ page }, testInfo) => {
  await mock(page); await expect(page.getByText('No trip is syncing.', { exact: true })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => window.__TRIPS_MOCK__.counters().calls['workers.exec'] ?? 0)).toBe(0);
  await audit(page); await capture(page, testInfo, 'shell-dashboard');
});
test('palette, shortcuts, focus return and skip link work by keyboard', async ({ page }, testInfo) => {
  await mock(page); const opener = page.getByRole('button', { name: 'Command palette', exact: true }); await opener.focus();
  await page.keyboard.press('ControlOrMeta+k'); const dialog = page.getByRole('dialog', { name: 'Command palette', exact: true }); await expect(dialog).toBeVisible();
  const search = dialog.getByRole('combobox', { name: 'Search commands' }); await expect(search).toBeFocused();
  const initialSelection = await search.getAttribute('aria-activedescendant');
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) await search.dispatchEvent('keydown', { key, ...composition });
    await expect(search).toHaveAttribute('aria-activedescendant', initialSelection); await expect(dialog).toBeVisible();
  }
  await audit(page); await capture(page, testInfo, 'shell-palette');
  await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
  await page.keyboard.press('ControlOrMeta+k'); await search.fill('appearance'); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible(); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click(); const help = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true }); await expect(help).toBeVisible(); await audit(page);
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Keyboard shortcuts', exact: true })).toBeFocused();
  const skip = page.getByRole('link', { name: 'Skip to content' }); await skip.focus(); await page.keyboard.press('Enter'); await expect(page.locator('#app-content')).toBeFocused(); await expect(page).toHaveURL(/#\/settings\/appearance$/);
});
test('appearance persists to local and account storage and recovers from write errors', async ({ page }, testInfo) => {
  await mock(page); await page.goto('/mock.html#/settings/appearance'); await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await expect(page.locator('.settings-status')).toBeHidden(); await audit(page); await capture(page, testInfo, 'shell-settings-initial');
  await page.evaluate(() => window.__TRIPS_MOCK__.failNext({ method: 'kv.update', status: 402 }));
  await page.getByRole('button', { name: 'Dark', exact: true }).click(); await expect(page.getByText('Saved on this device. Your Puter credit has run out, so it could not be saved to your account. Add credit, then retry.', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); expect(await page.evaluate(() => localStorage.getItem('trips:theme'))).toBe('dark');
  await page.getByRole('button', { name: 'Retry', exact: true }).click(); await expect(page.getByText('Saved to your account.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__TRIPS_MOCK__.inspectKv('alice')['me:prefs'].theme)).toBe('dark');
  await expect(page.locator('.settings-status')).toHaveText('Saved to your account.');
  await expect(page.locator('main')).not.toContainText(/undefined|false/); await audit(page); await capture(page, testInfo, 'shell-settings');
  await page.reload(); await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'System', exact: true }).click(); await expect(page.getByText('Saved to your account.', { exact: true })).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
});
test('offline appearance stays on the device and saves itself after reconnect', async ({ page, context }) => {
  await mock(page); await page.goto('/mock.html#/settings'); await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await context.setOffline(true); await expect(page.getByText('You are offline. Account changes require a connection.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Light', exact: true }).click(); await expect(page.getByText('Saved on this device. It will be saved to your account when you are back online.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__TRIPS_MOCK__.inspectKv('alice')['me:prefs'])).toBeUndefined();
  await context.setOffline(false); await expect(page.getByText('Saved to your account.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__TRIPS_MOCK__.inspectKv('alice')['me:prefs'].theme)).toBe('light');
});
test('account isolation, valid trip links and malformed links remain safe', async ({ page, browser, baseURL }, testInfo) => {
  // The in-page mock world resets on every load, so account preferences that must outlive a reload use the bridge world.
  const world = createFakePuter({ users: [alice, bob] }); const host = createTestBridgeHost(world); const contexts = [];
  async function open(as) {
    const { colorScheme, viewport, isMobile, hasTouch } = testInfo.project.use;
    const context = await browser.newContext({ colorScheme, viewport, isMobile, hasTouch }); contexts.push(context);
    await attachFakePuterContext(host, context, { as });
    const tab = await context.newPage(); tab.on('pageerror', (error) => { throw error; });
    await tab.goto(`${baseURL}/mock.html#/settings`); await expect(tab.locator('html')).toHaveAttribute('data-runtime', 'mock-bridge');
    await expect(tab.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
    return tab;
  }
  // Stands in for another account choosing a theme on the same device.
  async function deviceTheme(tab, theme) {
    await tab.evaluate((value) => localStorage.setItem('trips:theme', value), theme); await tab.reload();
    await expect(tab.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  }
  try {
    const a = await open('alice'); await a.getByRole('button', { name: 'Dark', exact: true }).click(); await expect(a.getByText('Saved to your account.', { exact: true })).toBeVisible();
    // With nothing in Bob's account, the device theme shows.
    const b = await open('bob'); await deviceTheme(b, 'dark'); await expect(b.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await b.getByRole('button', { name: 'Light', exact: true }).click(); await expect(b.getByText('Saved to your account.', { exact: true })).toBeVisible();
    expect(world.inspectKv(bob.uuid)['me:prefs'].theme).toBe('light'); expect(world.inspectKv(alice.uuid)['me:prefs'].theme).toBe('dark');
    // Alice's account choice wins over the device theme when she comes back.
    await deviceTheme(a, 'light'); await expect(a.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally { for (const context of contexts) await context.close(); await host.close(); }
  await mock(page); await page.goto('/mock.html#/t/trips-abcdefghij/0000000000000001/members');
  await expect(page).toHaveURL(/0000000000000001\/members$/); expect(await page.evaluate(() => window.__TRIPS_MOCK__.counters().calls['workers.exec'] ?? 0)).toBe(0);
  await page.goto('/mock.html#/t/evil.example/0000000000000001'); await expect(page.getByRole('heading', { name: 'This link is invalid or unsupported', exact: true }).first()).toBeVisible();
});
test('sign-in requires a click and SDK/storage failures are actionable', async ({ page }) => {
  await page.route('https://js.puter.com/v2/', (route) => route.fulfill({ contentType: 'application/javascript', body: 'window.signIns=0;window.puter={auth:{isSignedIn:()=>false,signIn:async()=>{window.signIns++}},kv:{},fs:{},workers:{}};' }));
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Sign in with Puter' })).toBeVisible(); expect(await page.evaluate(() => window.signIns)).toBe(0);
  await page.getByRole('button', { name: 'Sign in with Puter' }).click(); await expect.poll(() => page.evaluate(() => window.signIns)).toBe(1); await audit(page);
  await page.unroute('https://js.puter.com/v2/'); await page.route('https://js.puter.com/v2/', (route) => route.fulfill({ contentType: 'application/javascript', body: 'window.puter={};' }));
  await page.reload(); await expect(page.getByText('Puter could not be loaded. Check your connection, then retry.', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
  await page.goto('/mock.html'); await expect(page.getByText('Local storage could not be opened. Allow site storage, then retry.', { exact: true })).toBeVisible(); await audit(page);
});
