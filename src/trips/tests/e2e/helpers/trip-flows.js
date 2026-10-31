import { expect } from '@playwright/test';
import { bridgeWorld } from './bridge-world.js';
import { dateRange } from '../../../src/shared/dates.js';
import { orderKeys } from '../../../src/shared/order.js';

/**
 * `bridgeWorld` whose `open(as, hash)` allows a slow boot (parallel suites share the machine). Page errors still
 * collect in `errors`.
 */
export async function patientWorld(browser, testInfo, baseURL, options) {
  const w = await bridgeWorld(browser, testInfo, baseURL, options);
  w.open = async (as, hash = '') => {
    const page = await (await w.context(as)).newPage();
    page.on('pageerror', (error) => w.errors.push(`${as} ${hash}: ${error.message}`));
    await page.goto(`${baseURL}/mock.html${hash}`);
    await expect(page.locator('html')).toHaveAttribute('data-runtime', 'mock-bridge', { timeout: 20_000 });
    await expect(page.locator('html')).toHaveAttribute('data-boot', 'ready', { timeout: 20_000 });
    return page;
  };
  return w;
}

/**
 * Alice creates a trip through the mock hook with its days (one per date, or `days` undated ones), and every user in
 * `roles` joins through the app's invite link with that role. Returns `{ref, hash(tab), days}` (day ids in order).
 */
export async function tripFor(w, { title = 'Lisbon', start, end, days: count = 3, currency, roles = { bob: 'editor' }, owner = 'alice' } = {}) {
  const page = await w.open(owner);
  await expect(page.locator('html')).toHaveAttribute('data-worker', 'ready');
  const ref = await page.evaluate((meta) => globalThis.trips.createTrip(meta), { title, ...(start ? { start } : {}), ...(end ? { end } : {}), ...(currency ? { currency } : {}) });
  const dates = start && end ? dateRange(start, end) : Array.from({ length: count }, () => null);
  const keys = orderKeys(dates.length);
  const dayIds = Object.values(await seed(w, owner, ref, dates.map((date, index) => ({ key: `d${index}`, type: 'day', fields: { date, order: keys[index] } }))));
  const base = `#/t/${ref.w}/${ref.s}`;
  for (const [member, role] of Object.entries(roles)) {
    const { token } = await page.evaluate(([target, value]) => globalThis.trips.invite(target, { role: value }), [ref, role]);
    const joining = await w.open(member, `#/join/${ref.w}/${ref.s}/${token}`);
    await joining.getByRole('button', { name: 'Join trip', exact: true }).click();
    await joining.waitForURL((url) => url.hash.startsWith(base));
    await joining.close();
  }
  await page.close();
  return { ref, days: dayIds, hash: (tab = 'plan') => `${base}/${tab}` };
}

/**
 * Writes shared entities through the mock hook on a page of its own and waits until the worker has them.
 * `items`: `[{key?, type, fields}]`; a field value `{$: key}` becomes that item's id. Returns key → id.
 */
export async function seed(w, as, ref, items) {
  const page = await w.open(as);
  const ids = await page.evaluate(async ({ ref, items }) => {
    const ids = {};
    const resolve = (value) => {
      if (Array.isArray(value)) return value.map(resolve);
      if (!value || typeof value !== 'object') return value;
      if (Object.keys(value).length === 1 && '$' in value) return ids[value.$];
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, resolve(item)]));
    };
    await globalThis.trips.open(ref);
    for (const item of items) {
      const id = await globalThis.trips.create(ref, item.type, resolve(item.fields));
      if (item.key) ids[item.key] = id;
    }
    for (let round = 0; round < 20 && globalThis.trips.state(ref).pending > 0; round++) await globalThis.trips.flush(ref);
    globalThis.trips.close(ref);
    return ids;
  }, { ref, items });
  await page.close();
  return ids;
}

/** Names of the shared entities of `type` as the worker serves them to `as`, read on a page of its own. */
export async function serverNames(w, as, ref, type) {
  const page = await w.open(as);
  const names = await page.evaluate(async ({ ref, type }) => {
    await globalThis.trips.open(ref);
    await globalThis.trips.sync(ref);
    const result = globalThis.trips.names(ref, type);
    globalThis.trips.close(ref);
    return result;
  }, { ref, type });
  await page.close();
  return names.sort();
}

/** Waits until the shell reports the open trip as up to date. */
export const synced = (page) => expect(page.locator('.app-sync .save-state')).toHaveAttribute('data-state', 'synced', { timeout: 15_000 });

/** Cuts the context off (the bridge follows the browser's offline event) or reconnects it. */
export async function setOnline(context, online) {
  await context.setOffline(!online);
}

/**
 * The page's next `times` trip commits are answered with `status` and `code`, as the worker would (402 owner out of
 * credit, 403 refused). `world.failNext` cannot pick the commit out of presence and other worker calls. The sync engine
 * retries a 402 on its next poll, so a refusal the spec must see until it presses Retry needs `times: Infinity` and
 * `stopFailingCommits` before the Retry.
 */
export async function failNextCommit(page, status, code, { match = '"op":"commit"', times = 1 } = {}) {
  await page.evaluate(([status, code, match, times]) => {
    const exec = globalThis.puter.workers.exec.bind(globalThis.puter.workers);
    const failure = { left: times };
    (globalThis.__tripsCommitFailures ??= []).push(failure);
    globalThis.puter.workers.exec = async (input, init) => {
      const request = new Request(input, init);
      if (failure.left > 0 && (await request.clone().text()).includes(match)) {
        failure.left -= 1;
        // Status 0 stands for a dropped connection.
        if (!status) throw Object.assign(new Error('offline'), { code: 'offline', status: 0 });
        return new Response(JSON.stringify({ code, message: code }), { status, headers: { 'content-type': 'application/json' } });
      }
      return exec(request);
    };
  }, [status, code, match, times]);
}

/** Ends every refusal `failNextCommit` armed on the page (the owner added credit). */
export const stopFailingCommits = (page) => page.evaluate(() => { for (const failure of globalThis.__tripsCommitFailures ?? []) failure.left = 0; });

/** Opens the menu behind `trigger` and picks the item named `name`. */
export async function choose(page, trigger, name) {
  await trigger.click();
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitem', { name, exact: true }).or(menu.getByRole('menuitemcheckbox', { name, exact: true })).click();
}

/** Presses Tab (Shift+Tab with `back`) until `target` has focus. */
export async function tabTo(page, target, { back = false, max = 80 } = {}) {
  for (let step = 0; step < max; step++) {
    if (await target.evaluate((node) => node === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
  }
  await expect(target).toBeFocused();
}

/** Presses ArrowDown in an open menu until the item named `name` has focus, then picks it with Enter. */
export async function arrowTo(page, name, { max = 30 } = {}) {
  const item = page.getByRole('menu').getByRole('menuitem', { name, exact: true }).or(page.getByRole('menu').getByRole('menuitemcheckbox', { name, exact: true }));
  for (let step = 0; step < max; step++) {
    if (await item.evaluate((node) => node === document.activeElement).catch(() => false)) break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(item).toBeFocused();
  await page.keyboard.press('Enter');
}

/** Answers the next file chooser `trigger` opens with `files` (`{name, mimeType, buffer}`). */
export async function chooseFiles(page, trigger, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), trigger()]);
  await chooser.setFiles(files);
}

/** Runs `trigger` and returns the download it starts as `{name, text}`. */
export async function download(page, trigger) {
  const [file] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(await file.path());
  return { name: file.suggestedFilename(), bytes, text: bytes.toString('utf8') };
}

/** Frankfurter answers with fixed rates per base currency (`{USD: {EUR: 0.9}}`). Returns the request log. */
export async function fakeRates(context, table) {
  const calls = [];
  await context.route((url) => url.hostname === 'api.frankfurter.dev', async (route) => {
    const url = new URL(route.request().url());
    const base = url.searchParams.get('base');
    const date = url.searchParams.get('date') ?? '2026-10-23';
    calls.push({ base, date });
    const quotes = table[base] ?? {};
    await route.fulfill({ json: Object.entries(quotes).map(([quote, rate]) => ({ base, quote, rate, date })) });
  });
  return calls;
}
