import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

/**
 * Writes entities into a trip through the mock hook on a page of its own, then flushes and closes it.
 * `items`: `[{key?, type, fields, private?}]`; a field value `{$: key}` is replaced by that item's id. Returns key → id.
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
      const fields = resolve(item.fields);
      const id = item.private ? await globalThis.trips.putPrivate(ref, item.type, fields) : await globalThis.trips.create(ref, item.type, fields);
      if (item.key) ids[item.key] = id;
    }
    for (let round = 0; round < 20 && globalThis.trips.state(ref).pending > 0; round++) await globalThis.trips.flush(ref);
    globalThis.trips.close(ref);
    return ids;
  }, { ref, items });
  await page.close();
  return ids;
}

/** A trip's shared entities as the worker serves them to `as` (a fresh sync on a page of its own). */
export async function read(w, as, ref, types) {
  const page = await w.open(as);
  const out = await page.evaluate(async ({ ref, types }) => {
    await globalThis.trips.open(ref);
    await globalThis.trips.sync(ref);
    const result = Object.fromEntries(types.map((type) => [type, globalThis.trips.names(ref, type)]));
    globalThis.trips.close(ref);
    return result;
  }, { ref, types });
  await page.close();
  return out;
}

/**
 * Activates a control with the keyboard. Specs written while phone pages sometimes widened to 552 px use it for menus,
 * sheets and panels; the cause was the Collab tab badge's visually hidden label escaping the tab strip, now contained.
 */
export const press = (locator) => locator.press('Enter');

/** Opens the trip header's "Trip actions" menu and picks `label`. */
export async function tripMenu(page, label) {
  const trigger = page.getByRole('button', { name: 'Trip actions', exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await press(page.getByRole('menuitem', { name: label, exact: true }));
}

/** Runs `trigger` and resolves the browser download it starts: `{name, bytes, text}`. */
export async function download(page, trigger) {
  const [file] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const bytes = await readFile(await file.path());
  return { name: file.suggestedFilename(), bytes, text: bytes.toString('utf8') };
}

/** Answers the next file chooser `trigger` opens with `files` (`{name, mimeType, buffer}`). */
export async function chooseFiles(page, trigger, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), trigger()]);
  await chooser.setFiles(files);
}

/** Shows a Plan tab pane on narrow layouts, where only one pane is visible at a time. */
export async function planPane(page, name) {
  await page.locator('.plan .plan-panes').waitFor();
  const switcher = page.locator('.plan-switch');
  if (await switcher.isVisible()) await press(switcher.getByRole('button', { name, exact: true }));
}

/** Place names in the Plan tab's places pane. */
export async function placeNames(page) {
  await planPane(page, 'Places');
  return page.locator('.plan-places-pane .pl-row .pl-name').allTextContents();
}

/**
 * A recorded `puter.net.fetch` for every page of `context`. `handler({method, url, headers, body})` runs in Node and
 * returns `{status?, json?, text?, base64?, headers?}`; each request is appended to `calls`.
 */
export async function fakeNet(context, handler) {
  const calls = [];
  await context.exposeBinding('__tripsNetFetch', async (_source, request) => {
    const parsed = { ...request, url: new URL(request.url), body: request.body ?? null };
    calls.push(parsed);
    const reply = (await handler(parsed)) ?? { status: 404, json: { error: 'not found' } };
    const json = reply.json !== undefined;
    return {
      status: reply.status ?? 200,
      headers: { 'content-type': json ? 'application/json' : reply.base64 ? 'application/octet-stream' : 'text/plain', ...(reply.headers ?? {}) },
      body: json ? JSON.stringify(reply.json) : reply.text ?? null,
      base64: reply.base64 ?? null,
    };
  });
  await context.addInitScript(() => {
    const install = () => {
      if (!globalThis.puter) return false;
      globalThis.puter.net = {
        async fetch(input, init = {}) {
          const url = typeof input === 'string' ? input : input.url;
          const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
          const body = typeof init.body === 'string' ? init.body : init.body == null ? null : await new Response(init.body).text();
          const reply = await globalThis.__tripsNetFetch({ method: (init.method ?? 'GET').toUpperCase(), url, headers, body });
          const bytes = reply.base64 ? Uint8Array.from(atob(reply.base64), (char) => char.charCodeAt(0)) : reply.body;
          return new Response(reply.status === 204 ? null : bytes, { status: reply.status, headers: reply.headers });
        },
      };
      return true;
    };
    // The bridge client installs `puter` from its own init script, which runs first.
    if (!install()) addEventListener('DOMContentLoaded', install, { once: true });
  });
  return calls;
}

/** Waits until the shell reports the open trip as up to date (nothing queued). */
export const synced = (page) => expect(page.locator('.app-sync .save-state')).toHaveAttribute('data-state', 'synced', { timeout: 15_000 });

const anonymous = (w) => w.world.client('calendar-app');

/** A GET on a worker route from outside Trips (a calendar app): `{status, type, etag, text}`. */
export async function workerGet(w, url, headers = {}) {
  const response = await anonymous(w).workers.exec(new Request(url, { headers: { 'x-puter-no-auth': '1', ...headers } }));
  return { status: response.status, type: response.headers.get('content-type'), etag: response.headers.get('etag'), text: await response.text() };
}

/**
 * Workers run in this Node process: their `fetch` of another worker's public route goes to the fake world instead of
 * the network, and anything else is refused. Returns the restore function.
 */
export function routeWorkerFetch(w) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (!url.hostname.endsWith('.puter.work')) throw new TypeError('Network access is blocked in tests');
    const headers = { ...Object.fromEntries(new Headers(init.headers ?? {}).entries()), 'x-puter-no-auth': '1' };
    return anonymous(w).workers.exec(new Request(url, { method: init.method ?? 'GET', headers }));
  };
  return () => { globalThis.fetch = original; };
}
