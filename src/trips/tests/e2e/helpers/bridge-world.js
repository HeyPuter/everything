import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect } from '@playwright/test';
import { createFakePuter } from '../../../dev/fake-puter/index.js';
import { createTestBridgeHost } from '../../../dev/fake-puter/bridge-host.js';
import { attachFakePuterContext } from '../../../dev/fake-puter/bridge-playwright.js';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const LOCAL = new Set(['127.0.0.1', 'localhost']);

export const USERS = Object.freeze({
  alice: { uuid: '00000000-0000-4000-8000-000000000001', username: 'alice' },
  bob: { uuid: '00000000-0000-4000-8000-000000000002', username: 'bob' },
  carol: { uuid: '00000000-0000-4000-8000-000000000003', username: 'carol' },
});

export async function audit(page) {
  await page.evaluate(async () => Promise.all(document.getAnimations().filter((animation) => animation.effect.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: axeSource });
  expect(await page.evaluate(async () => (await window.axe.run()).violations)).toEqual([]);
}
export async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`); await page.screenshot({ path, fullPage: true }); await testInfo.attach(name, { path, contentType: 'image/png' });
}
/** No horizontal scroll at the project's width. Phone emulation widens the layout viewport to fit wide content, so `innerWidth` is checked too. */
export async function noOverflow(page) {
  const width = page.viewportSize().width;
  const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  expect(inner).toBe(width);
  expect(scroll).toBeLessThanOrEqual(width);
}

/**
 * Several accounts on one Node-side fake world, each in its own browser context with the project's theme and viewport.
 * The bridge follows full page loads, so open a new page per route instead of changing the hash in place.
 */
export async function bridgeWorld(browser, testInfo, baseURL, { users = ['alice', 'bob'], verified = true, ...options } = {}) {
  // Verified accounts can share folders, so trips use direct file mode; `verified: false` keeps files proxied.
  const world = createFakePuter({ users: users.map((name) => ({ ...USERS[name], verified })), shareHandles: true, ...options });
  const host = createTestBridgeHost(world);
  const contexts = new Map();
  const errors = [];
  /** `device` > 1 is another browser of the same account (its own storage). */
  async function context(as, device = 1) {
    const key = device === 1 ? as : `${as}#${device}`;
    if (contexts.has(key)) return contexts.get(key);
    const { colorScheme, viewport, isMobile, hasTouch } = testInfo.project.use;
    const created = await browser.newContext({ colorScheme, viewport, isMobile, hasTouch });
    // Tests stay offline: tiles, holidays and other providers are refused unless a spec routes them itself.
    await created.route((url) => !LOCAL.has(url.hostname), (route) => route.abort('blockedbyclient'));
    await attachFakePuterContext(host, created, { as });
    contexts.set(key, created);
    return created;
  }
  /** A page for `as` (null: a signed-out visitor) at `mock.html<hash>`, booted; page errors collect in `errors`. */
  async function open(as, hash = '', { device = 1 } = {}) {
    const page = await (await context(as, device)).newPage();
    page.on('pageerror', (error) => errors.push(`${as} ${hash}: ${error.message}`));
    await page.goto(`${baseURL}/mock.html${hash}`);
    // Boot waits are generous: specs run several multi-user contexts per worker.
    await expect(page.locator('html')).toHaveAttribute('data-runtime', 'mock-bridge', { timeout: 30_000 });
    await expect(page.locator('html')).toHaveAttribute('data-boot', 'ready', { timeout: 30_000 });
    return page;
  }
  /**
   * `owner` (the first user by default) creates a trip through the mock hook; `members` join through the app's invite
   * link. `role` is one role for everyone or a map of member → role.
   */
  async function sharedTrip({ title = 'Lisbon', start, end, role = 'editor', owner = users[0], members = users.filter((name) => name !== owner) } = {}) {
    const page = await open(owner);
    await expect(page.locator('html')).toHaveAttribute('data-worker', 'ready', { timeout: 30_000 });
    const ref = await page.evaluate((meta) => globalThis.trips.createTrip(meta), { title, ...(start ? { start } : {}), ...(end ? { end } : {}) });
    const base = `#/t/${ref.w}/${ref.s}`;
    for (const member of members) {
      const { token } = await page.evaluate(([target, value]) => globalThis.trips.invite(target, { role: value }), [ref, typeof role === 'string' ? role : role[member] ?? 'editor']);
      const joining = await open(member, `#/join/${ref.w}/${ref.s}/${token}`);
      await joining.getByRole('button', { name: 'Join trip', exact: true }).click();
      await joining.waitForURL((url) => url.hash.startsWith(base));
      await joining.close();
    }
    await page.close();
    return { ref, hash: (tab = 'plan') => `${base}/${tab}` };
  }
  // One at a time: contexts of a browser share its trace resources, and closing two at once can zip a file mid-write.
  async function close() { for (const item of contexts.values()) await item.close(); await host.close(); }
  return { world, host, context, open, sharedTrip, errors, close };
}
