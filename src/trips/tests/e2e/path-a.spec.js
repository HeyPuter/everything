import { test, expect as baseExpect } from '@playwright/test';
import { audit, bridgeWorld, USERS } from './helpers/bridge-world.js';

// Q8 path A in the app: members read the owner's KV through share handles and hear changes as events; a lost handle
// falls back to the worker and is renewed; without handles (state C) everything goes through the worker.
const expect = baseExpect.configure({ timeout: 15_000 });
test.use({ actionTimeout: 15_000 });

const message = (page, text) => page.locator('.chat-msg').filter({ has: page.locator('.chat-text', { hasText: text }) });
async function post(page, text) {
  await page.locator('.chat-input').fill(text);
  await page.locator('.chat-send').click();
  await expect(message(page, text)).not.toHaveClass(/is-pending/);
}
/** Worker ops a page sends from now on (`heads` from the dashboard is not involved on trip pages). */
const recordOps = (page) => page.evaluate(() => {
  const exec = puter.workers.exec.bind(puter.workers);
  globalThis.__ops = [];
  puter.workers.exec = (url, init) => {
    try { globalThis.__ops.push(JSON.parse(init.body).op); } catch { globalThis.__ops.push(new URL(url).pathname); }
    return exec(url, init);
  };
});
const ops = (page) => page.evaluate(() => [...globalThis.__ops]);
const bobHandles = (w, ref) => w.world.inspectKv(USERS.bob.uuid)['me:spaces'].find((entry) => entry.ref.s === ref.s)?.handles;

test('path A: the member hears the owner’s message as an event, with no worker call', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('collab'));
    const bob = await w.open('bob', trip.hash('collab'));
    await expect(bob.locator('.chat-input')).toBeVisible();
    expect(bobHandles(w, trip.ref)).toMatchObject({ read: expect.any(String), write: expect.any(String) });
    await recordOps(bob);
    await post(alice, 'Meet at the tram stop');
    const sentAt = Date.now();
    await expect(message(bob, 'Meet at the tram stop')).toBeVisible({ timeout: 5_000 });
    // Events, not polling: well under the 5 s active poll.
    expect(Date.now() - sentAt).toBeLessThan(3_000);
    expect((await ops(bob)).filter((op) => op === 'sync' || op === 'open')).toEqual([]);
    await audit(bob);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a revoked read handle falls back to the worker, renews and returns to path A; presence survives a lost write handle', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('collab'));
    const bob = await w.open('bob', trip.hash('collab'));
    await post(alice, 'First');
    await expect(message(bob, 'First')).toBeVisible();
    const before = bobHandles(w, trip.ref);
    await recordOps(bob);

    // The owner revokes Bob's read handle, which also retires his narrower write handle.
    expect(await alice.evaluate((handle) => puter.kv.unshare(handle), before.read)).toEqual({ handle: before.read, revokedAt: expect.any(Number) });
    await post(alice, 'After the read handle went away');
    await bob.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(message(bob, 'After the read handle went away')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => ops(bob)).toContain('open');
    await expect.poll(() => bobHandles(w, trip.ref)?.read).not.toBe(before.read);
    expect(bobHandles(w, trip.ref).write).not.toBe(before.write);

    // Renewed: the next message arrives as an event again, without worker syncs.
    const mark = (await ops(bob)).length;
    await post(alice, 'Back on the fast path');
    await expect(message(bob, 'Back on the fast path')).toBeVisible({ timeout: 10_000 });
    expect((await ops(bob)).slice(mark).filter((op) => op === 'sync')).toEqual([]);

    // A lost write handle: presence goes through the worker and Alice still sees Bob here.
    await alice.evaluate((handle) => puter.kv.unshare(handle), bobHandles(w, trip.ref).write);
    const members = await w.open('alice', trip.hash('members'));
    await bob.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(members.locator('.member-row', { hasText: 'bob' })).toContainText('Here now', { timeout: 30_000 });
    await post(bob, 'Still here');
    await expect(message(alice, 'Still here')).toBeVisible({ timeout: 30_000 });
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('without share handles (state C) the member syncs through the worker', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { shareHandles: false });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    expect(bobHandles(w, trip.ref)).toBeUndefined();
    const alice = await w.open('alice', trip.hash('collab'));
    const bob = await w.open('bob', trip.hash('collab'));
    await expect(bob.locator('.chat-input')).toBeVisible();
    await recordOps(bob);
    await post(alice, 'Through the worker');
    await expect(message(bob, 'Through the worker')).toBeVisible({ timeout: 30_000 });
    expect(await ops(bob)).toContain('sync');
    await post(bob, 'Reply through the worker');
    await expect(message(alice, 'Reply through the worker')).toBeVisible({ timeout: 30_000 });
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
