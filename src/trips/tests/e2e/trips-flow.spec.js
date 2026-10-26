import { test, expect } from '@playwright/test';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { createTestBridgeHost } from '../../dev/fake-puter/bridge-host.js';
import { attachFakePuterContext } from '../../dev/fake-puter/bridge-playwright.js';

// Two isolated browser contexts on one Node-side fake world, with the real worker bundle deployed by the real
// deployer, and the real worker client, stores and sync engine (dev/mock-trips.js stands in for the trip views).
const alice = { uuid: '00000000-0000-4000-8000-000000000001', username: 'alice' };
const bob = { uuid: '00000000-0000-4000-8000-000000000002', username: 'bob' };
const call = (page, method, ...args) => page.evaluate(({ method, args }) => globalThis.trips[method](...args), { method, args });
// Worker ops a page has sent so far. Bob's open page is the dashboard, which refreshes trip heads (`heads`) on load and
// on focus; that call can land anywhere in the flow, so path A checks count the other ops.
const recordOps = (page) => page.evaluate(() => {
  const exec = puter.workers.exec.bind(puter.workers);
  globalThis.__ops = [];
  puter.workers.exec = (url, init) => {
    try { globalThis.__ops.push(JSON.parse(init.body).op); } catch { globalThis.__ops.push(new URL(url).pathname); }
    return exec(url, init);
  };
});
const sentOps = (page) => page.evaluate(() => [...globalThis.__ops]);
const failure = (page, method, ...args) => page.evaluate(async ({ method, args }) => {
  try { await globalThis.trips[method](...args); return null; } catch (error) { return { status: error.status, code: error.code }; }
}, { method, args });

test('two accounts share a trip on the real worker across paths A and C, offline and after removal', async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Protocol flow without UI; one project is enough.');
  test.setTimeout(90_000);
  const world = createFakePuter({ users: [alice, bob], shareHandles: true });
  const host = createTestBridgeHost(world);
  const contexts = [];
  const pageErrors = [];
  async function account(user) {
    const context = await browser.newContext();
    contexts.push(context);
    await attachFakePuterContext(host, context, { as: user.username });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${baseURL}/mock.html`);
    await expect(page.locator('html')).toHaveAttribute('data-runtime', 'mock-bridge');
    await expect(page.locator('html')).toHaveAttribute('data-worker', 'ready');
    return { page, context };
  }
  // Pulls the latest state (events are hints) and reads it back.
  const read = async (page, ref, method, ...args) => { await host.flush(); await call(page, 'sync', ref); return call(page, method, ref, ...args); };
  const notes = async (page, ref, id) => (await read(page, ref, 'get', 'place', id))?.notes ?? null;
  try {
    const a = await account(alice);
    const b = await account(bob);
    await recordOps(b.page);

    // 1. Alice's first trip deploys her worker through workers.create, from the built bundle.
    const ref = await call(a.page, 'createTrip', { title: 'Lisbon' });
    expect(ref).toMatchObject({ w: expect.stringMatching(/^trips-[a-z0-9]{10}$/), k: 'trip' });
    expect(world.counters().calls['workers.create']).toBe(1);
    expect(world.inspectKv(alice.uuid)['me:worker']).toMatchObject({ name: ref.w, path: expect.stringMatching(/\/AppData\/trips\/worker\/trips-worker\.js$/) });

    // 2–3. Invite by link; Bob joins with the token and gets handles and the files folder.
    const { token } = await call(a.page, 'invite', ref, { role: 'editor' });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(await call(b.page, 'join', ref, token)).toMatchObject({ role: 'editor', rev: 2, handles: true, files: { mode: 'direct', uid: expect.any(String) } });

    // 4a. Path A: Alice reads her own KV, Bob reads through his read handle and pays for it.
    expect(await call(a.page, 'open', ref)).toMatchObject({ path: 'A', handles: true, sync: 'synced' });
    expect(await call(b.page, 'open', ref)).toMatchObject({ path: 'A', handles: true, sync: 'synced', rev: 2 });
    expect((await call(b.page, 'members', ref)).map((member) => member.name).sort()).toEqual(['alice', 'bob']);
    const tower = await call(a.page, 'create', ref, 'place', { name: 'Belém Tower' });
    expect((await call(a.page, 'flush', ref)).status).toBe('sent');
    const bobOps = (await sentOps(b.page)).length;
    await expect.poll(() => read(b.page, ref, 'names', 'place')).toEqual(['Belém Tower']);
    expect((await sentOps(b.page)).slice(bobOps).filter((op) => op !== 'heads')).toEqual([]);
    expect((await call(b.page, 'get', ref, 'place', tower)).by).toBe(alice.uuid);
    await call(b.page, 'patch', ref, 'place', tower, { notes: 'Go early' });
    expect((await call(b.page, 'flush', ref)).status).toBe('sent');
    await expect.poll(() => notes(a.page, ref, tower)).toBe('Go early');
    expect((await call(a.page, 'get', ref, 'place', tower)).by).toBe(bob.uuid);

    // 4b. Path C: Bob drops the handles and syncs through the worker.
    expect(await call(b.page, 'open', ref, { path: 'C' })).toMatchObject({ path: 'C', handles: false });
    const tram = await call(a.page, 'create', ref, 'place', { name: 'Tram 28' });
    expect((await call(a.page, 'flush', ref)).status).toBe('sent');
    await expect.poll(() => read(b.page, ref, 'names', 'place').then((names) => names.sort())).toEqual(['Belém Tower', 'Tram 28']);
    expect((await sentOps(b.page)).slice(bobOps)).toContain('sync');
    await call(b.page, 'patch', ref, 'place', tram, { notes: 'Ride from Martim Moniz' });
    expect((await call(b.page, 'flush', ref)).status).toBe('sent');
    await expect.poll(() => notes(a.page, ref, tram)).toBe('Ride from Martim Moniz');

    // 5. Bob edits offline; the batch stays queued, then reaches Alice after he reconnects, and he gets her edit.
    await b.context.setOffline(true);
    await expect.poll(() => host.stats().offlinePages).toBe(1);
    await call(b.page, 'patch', ref, 'place', tower, { notes: 'Closed Mondays' });
    expect((await call(b.page, 'flush', ref)).status).toBe('queued');
    expect(await call(b.page, 'state', ref)).toMatchObject({ pending: 1 });
    await call(a.page, 'patch', ref, 'place', tram, { notes: 'Busy at noon' });
    expect((await call(a.page, 'flush', ref)).status).toBe('sent');
    await b.context.setOffline(false);
    await expect.poll(() => host.stats().offlinePages).toBe(0);
    await expect.poll(() => call(b.page, 'state', ref).then((state) => state.pending)).toBe(0);
    await expect.poll(() => notes(a.page, ref, tower)).toBe('Closed Mondays');
    await expect.poll(() => notes(b.page, ref, tram)).toBe('Busy at noon');
    expect(await call(a.page, 'errors')).toEqual([]);
    expect((await call(b.page, 'errors')).filter((code) => code !== 'offline')).toEqual([]);

    // 6. Alice removes Bob: his worker calls and his read handle stop working.
    const { handles } = world.inspectKv(bob.uuid)['me:spaces'].find((entry) => entry.ref.s === ref.s);
    await call(a.page, 'call', ref, 'member.remove', { uuid: bob.uuid });
    await expect.poll(async () => { await call(b.page, 'sync', ref); return (await call(b.page, 'state', ref)).sync; }).toBe('forbidden');
    expect(await failure(b.page, 'call', ref, 'open')).toEqual({ status: 403, code: 'not_member' });
    expect(await b.page.evaluate((handle) => puter.kv.get('sig', { handle }).then(() => null, (error) => error.code), handles.read)).toBe('kv_handle_not_found');
    // Reopening with the cached handles falls back to path C at once, where the worker refuses him.
    expect(await call(b.page, 'open', ref)).toMatchObject({ path: 'C' });
    await expect.poll(async () => { await call(b.page, 'sync', ref); return (await call(b.page, 'state', ref)).sync; }).toBe('forbidden');
    expect((await read(a.page, ref, 'members')).map((member) => member.name)).toEqual(['alice']);
    expect(pageErrors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    await host.close();
  }
});
