import { test, expect } from '@playwright/test';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { createTestBridgeHost } from '../../dev/fake-puter/bridge-host.js';
import { attachFakePuterContext } from '../../dev/fake-puter/bridge-playwright.js';

const alice = { uuid: '00000000-0000-4000-8000-000000000001', username: 'alice' };
const bob = { uuid: '00000000-0000-4000-8000-000000000002', username: 'bob' };
const saved = 'Saved to your account.';

async function fixture(browser, testInfo, baseURL) {
  const world = createFakePuter({ users: [alice, bob] });
  const host = createTestBridgeHost(world);
  const contexts = [];
  async function page(as) {
    const { colorScheme, viewport, isMobile, hasTouch } = testInfo.project.use;
    const context = await browser.newContext({ colorScheme, viewport, isMobile, hasTouch });
    contexts.push(context);
    await attachFakePuterContext(host, context, { as });
    const page = await context.newPage();
    await page.goto(`${baseURL}/mock.html#/settings/appearance`);
    await expect(page.locator('html')).toHaveAttribute('data-runtime', 'mock-bridge');
    await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'System', exact: true })).toBeVisible();
    return { page, context };
  }
  return { world, host, page, async close() { for (const context of contexts) await context.close(); await host.close(); } };
}

test('real app preferences use one shared fake backend while isolating accounts and browser storage', async ({ browser, baseURL }, testInfo) => {
  const f = await fixture(browser, testInfo, baseURL);
  try {
    const a = await f.page('alice'); const b = await f.page('bob');
    const theme = testInfo.project.use.colorScheme === 'dark' ? 'light' : 'dark';
    await a.page.getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
    await expect(a.page.getByText(saved, { exact: true })).toBeVisible();
    expect(f.world.inspectKv(alice.uuid)['me:prefs'].theme).toBe(theme);
    expect(f.world.inspectKv(bob.uuid)['me:prefs']).toBeUndefined();
    await expect(b.page.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(b.page.locator('html')).toHaveCSS('color-scheme', testInfo.project.use.colorScheme);
    const fresh = await f.page('alice');
    await expect(fresh.page.getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(f.world.counters().calls['workers.exec']).toBeUndefined();
  } finally { await f.close(); }
});

test('real app offline preference choice survives reconnect, saves itself, and retries after a credit denial', async ({ browser, baseURL }, testInfo) => {
  const f = await fixture(browser, testInfo, baseURL);
  try {
    const { page, context } = await f.page('alice');
    const theme = testInfo.project.use.colorScheme === 'dark' ? 'light' : 'dark';
    const before = f.world.counters().calls['kv.update'] ?? 0;
    await context.setOffline(true);
    await expect.poll(() => f.host.stats().offlinePages).toBe(1);
    await page.getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
    await expect(page.getByText('Saved on this device. It will be saved to your account when you are back online.', { exact: true })).toBeVisible();
    expect(f.world.counters().calls['kv.update'] ?? 0).toBe(before);
    // The first save after reconnecting is refused for credit.
    f.world.failNext({ method: 'kv.update', as: alice.uuid, status: 402 });
    await context.setOffline(false);
    await expect.poll(() => f.host.stats().offlinePages).toBe(0);
    await expect(page.getByText('Saved on this device. Your Puter credit has run out, so it could not be saved to your account. Add credit, then retry.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText(saved, { exact: true })).toBeVisible();
    expect(f.world.inspectKv(alice.uuid)['me:prefs'].theme).toBe(theme);
    expect(f.world.counters().calls['workers.exec']).toBeUndefined();
  } finally { await f.close(); }
});

test('mock reset preserves device appearance and clears only the selected fixture cache', async ({ page }) => {
  await page.goto('/mock.html#/settings/appearance');
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.getByText(saved, { exact: true })).toBeVisible();
  await page.goto('/mock.html?as=alice&reset=1#/settings');
  await expect(page.locator('html')).toHaveAttribute('data-reset', 'ready');
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('blocked mock reset presents recovery and resumes after the other tab closes', async ({ page, context }) => {
  await page.goto('/mock.html');
  await expect(page.getByRole('heading', { name: 'Your trips', exact: true })).toBeVisible();
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('trips-v1:00000000-0000-4000-8000-000000000001', 1);
    request.onsuccess = () => { globalThis.heldMockDatabase = request.result; resolve(); };
    request.onerror = () => reject(request.error);
  }));
  const resetting = await context.newPage();
  await resetting.goto('/mock.html?reset=1');
  await expect(resetting.getByRole('heading', { name: 'Preview reset is waiting', exact: true })).toBeVisible();
  await expect(resetting.locator('html')).toHaveAttribute('data-reset', 'blocked');
  await page.close();
  await resetting.getByRole('button', { name: 'Reload preview', exact: true }).click();
  await expect(resetting.getByRole('heading', { name: 'Your trips', exact: true })).toBeVisible();
  await expect(resetting.locator('html')).toHaveAttribute('data-reset', 'ready');
});

test('signed-out bridge reset waits for sign-in before opening account storage', async ({ browser, baseURL }, testInfo) => {
  const f = await fixture(browser, testInfo, baseURL);
  try {
    const { page } = await f.page('alice');
    await page.evaluate(() => puter.auth.signOut());
    await page.goto(`${baseURL}/mock.html?reset=1`);
    await expect(page.getByRole('button', { name: 'Sign in with Puter', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-reset', 'account-required');
    await page.getByRole('button', { name: 'Sign in with Puter', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your trips', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-reset', 'ready');
  } finally { await f.close(); }
});

test('mock reset recovers from a synchronous blocked-storage getter', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', {
    configurable: true, get() { throw new DOMException('Denied', 'SecurityError'); },
  }));
  await page.goto('/mock.html?reset=1');
  await expect(page.getByRole('heading', { name: 'Preview reset is waiting', exact: true })).toBeVisible();
  await expect(page.getByText('Local storage could not be opened. Allow site storage, then retry.', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-boot', 'ready');
});
