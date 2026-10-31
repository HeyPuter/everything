import { test, expect } from '@playwright/test';
import { e2eOrigin } from '../../tools/e2e-ports.mjs';
import { createClock } from '../../src/shared/hlc.js';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { createTestBridgeHost } from '../../dev/fake-puter/bridge-host.js';
import { attachFakePuterContext } from '../../dev/fake-puter/bridge-playwright.js';
import { stubWorker } from '../unit/helpers/stub-worker.js';

const ALICE = '00000000-0000-4000-8000-000000000001';
const PLACE = '0000000000000002';
const LOCAL = '0000000000000003';
const OP = '0000000000000010';
const LATER_OP = '0000000000000011';
const create = (name, id = PLACE, opId = OP) => ({ opId, t: 'place', id, put: { name } });
const patch = (name) => ({ opId: LATER_OP, t: 'place', id: PLACE, set: { name } });
function entity(name, rev, id = PLACE) {
  return { t: 'place', id, name, rev, v: createClock({ node: '0000000000000001', now: () => 1_000_000 + rev }).tick(), upd: 1_000_000 + rev, cr: 1_000_000, by: ALICE };
}
const record = (rev, name) => ({ rev, ents: [entity(name, rev)], del: [] });
const reply = (data) => ({ kind: 'reply', data });
const failure = (status) => ({ kind: 'error', status, code: `fixture_${status}` });
const ack = (name, rev, opId = OP) => reply({ rev, ents: [entity(name, rev)], del: [], done: { [opId]: rev } });
const state = (page) => page.evaluate(() => window.clientData.snapshot());
const apply = (page, ops) => page.evaluate((value) => window.clientData.apply(value), ops);
const script = (page, op, steps) => page.evaluate(({ op, steps }) => window.clientData.script(op, steps), { op, steps });
const flush = (page) => page.evaluate(() => window.clientData.flush());
let pageErrors = [];
let outsideRequests = [];
let extraContexts = [];

async function guardNetwork(context) {
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === e2eOrigin('client')) return route.continue();
    outsideRequests.push(route.request().url());
    return route.abort();
  });
}
async function open(context, as = 'a') {
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`/dev/client-data/index.html?as=${as}`);
  await expect(page.locator('html')).toHaveAttribute('data-client-data', 'ready');
  return page;
}
async function reload(page) {
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-client-data', 'ready');
}
async function isolated(browser) {
  const context = await browser.newContext({ baseURL: e2eOrigin('client') });
  extraContexts.push(context); await guardNetwork(context); return context;
}

test.beforeEach(async ({ context }, testInfo) => {
  test.skip(testInfo.project.metadata.clientDataFixture !== true, 'Use dev/client-data/playwright.config.js for this test-only fixture.');
  pageErrors = []; outsideRequests = []; extraContexts = [];
  await guardNetwork(context);
});
test.afterEach(async () => {
  for (const context of extraContexts) await context.close();
  expect(outsideRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('pending optimistic edits survive reload and remain isolated by account and browser context', async ({ context, browser }) => {
  const alice = await open(context);
  await apply(alice, [create('Alice durable draft')]);
  await reload(alice);
  expect((await state(alice)).places.map((item) => item.name)).toEqual(['Alice durable draft']);
  expect((await state(alice)).pending.map((op) => op.opId)).toEqual([OP]);
  const bob = await open(context, 'b');
  expect((await state(bob)).places).toEqual([]);
  await apply(bob, [create('Bob private draft')]);
  await alice.evaluate(() => window.clientData.refresh());
  expect((await state(alice)).places.map((item) => item.name)).toEqual(['Alice durable draft']);
  expect((await state(bob)).places.map((item) => item.name)).toEqual(['Bob private draft']);
  const separate = await open(await isolated(browser));
  expect((await state(separate)).pending).toEqual([]);
  expect((await state(separate)).places).toEqual([]);
});

test('an aborted native IndexedDB write never exposes the rejected optimistic edit', async ({ context }) => {
  const page = await open(context);
  await apply(page, [create('Existing draft')]);
  const before = await state(page);
  const beforeDOM = await page.locator('#state').textContent();
  await page.evaluate(() => window.clientData.failNextWrite());
  const error = await page.evaluate(async (op) => {
    try { await window.clientData.apply([op]); return null; }
    catch (error) { return { name: error.name, message: error.message }; }
  }, patch('Rejected draft'));
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/storage_aborted|storage_failed|abort/i);
  expect((await state(page)).notices).toBe(before.notices);
  expect((await state(page)).pending).toEqual(before.pending);
  expect(await page.locator('#state').textContent()).toBe(beforeDOM);
  await reload(page);
  expect((await state(page)).places.map((item) => item.name)).toEqual(['Existing draft']);
  expect((await state(page)).pending.map((op) => op.opId)).toEqual([OP]);
  const readError = await page.evaluate(() => window.clientData.failRead());
  expect(readError).not.toBeNull();
  expect(readError.message).toMatch(/storage_aborted|storage_failed|abort/i);
  expect((await state(page)).places.map((item) => item.name)).toEqual(['Existing draft']);
});

test('a second tab respects the lease, recovers a closed owner and retries frozen bytes before later edits', async ({ context }) => {
  const owner = await open(context);
  const next = await open(context);
  await apply(owner, [create('Frozen draft')]);
  await script(owner, 'commit', [{ kind: 'hold' }]);
  await owner.evaluate(() => window.clientData.beginFlush());
  await expect.poll(async () => (await state(owner)).commits.length).toBe(1);
  const frozen = (await state(owner)).commits[0];
  await apply(next, [patch('Later edit')]);
  expect((await flush(next)).status).toBe('busy');
  expect((await state(next)).commits).toEqual([]);
  await owner.close();
  await reload(next);
  expect((await state(next)).batch.body).toBe(frozen);
  expect((await state(next)).pending.map((op) => op.opId)).toEqual([OP, LATER_OP]);
  await next.evaluate(() => window.clientData.advance(1001));
  await script(next, 'commit', [ack('Frozen confirmed', 1), ack('Later confirmed', 2, LATER_OP)]);
  expect((await flush(next)).status).toBe('sent');
  const first = await state(next);
  expect(first.commits).toEqual([frozen]);
  expect(first.pending.map((op) => op.opId)).toEqual([LATER_OP]);
  expect(first.places.map((item) => item.name)).toEqual(['Later edit']);
  expect(first.rev).toBe(0);
  expect((await flush(next)).status).toBe('sent');
  const second = await state(next);
  expect(JSON.parse(second.commits[1]).ops.map((op) => op.opId)).toEqual([LATER_OP]);
  expect(second.pending).toEqual([]);
  expect(second.places.map((item) => item.name)).toEqual(['Later confirmed']);
});

test('an expired owner failing late cannot clear its replacement owner lease and enable a third send', async ({ context }) => {
  const original = await open(context);
  const replacement = await open(context);
  const third = await open(context);
  await apply(original, [create('Lease race')]);
  await script(original, 'commit', [{ kind: 'hold' }]);
  await original.evaluate(() => window.clientData.beginFlush());
  await expect.poll(async () => (await state(original)).commits.length).toBe(1);
  await replacement.evaluate(() => window.clientData.advance(1001));
  await script(replacement, 'commit', [{ kind: 'hold' }]);
  await replacement.evaluate(() => window.clientData.beginFlush());
  await expect.poll(async () => (await state(replacement)).commits.length).toBe(1);
  expect((await state(replacement)).commits).toEqual((await state(original)).commits);
  try {
    await original.evaluate((step) => window.clientData.release(step), failure(503));
    expect((await original.evaluate(() => window.clientData.finishFlush())).status).toBe('busy');
    await third.evaluate(() => window.clientData.advance(1001));
    expect((await flush(third)).status).toBe('busy');
    expect((await state(third)).commits).toEqual([]);
  } finally {
    await replacement.evaluate((step) => window.clientData.release(step), ack('Lease confirmed', 1));
    await replacement.evaluate(() => window.clientData.finishFlush());
  }
});

for (const [status, result, name, pending, conflicts] of [
  [403, 'rejected', 'Confirmed baseline', 0, 0],
  [409, 'conflict', 'Confirmed baseline', 0, 1],
  [402, 'queued', 'Proposed edit', 1, 0],
]) {
  test(`${status} ${result} persists the required rollback or retained work across reload`, async ({ context }) => {
    const page = await open(context);
    await page.evaluate((snapshot) => window.clientData.replace(snapshot), { rev: 1, ents: [entity('Confirmed baseline', 1)] });
    await apply(page, [patch('Proposed edit')]);
    await script(page, 'commit', [failure(status)]);
    expect((await flush(page)).status).toBe(result);
    const frozen = (await state(page)).commits[0];
    await reload(page);
    const current = await state(page);
    expect(current.places.map((item) => item.name)).toEqual([name]);
    expect(current.pending).toHaveLength(pending);
    expect(current.conflicts).toHaveLength(conflicts);
    if (conflicts) expect(current.conflicts[0]).toMatchObject({ op: { opId: LATER_OP }, code: 'fixture_409' });
    if (pending) {
      expect(current.batch.body).toBe(frozen);
      await script(page, 'commit', [ack('Recovered edit', 2, LATER_OP)]);
      expect((await flush(page)).status).toBe('sent');
      expect((await state(page)).commits).toEqual([frozen]);
      expect((await state(page)).pending).toEqual([]);
      expect((await state(page)).rev).toBe(1);
    }
  });
}

test('contiguous sync, persistent gap repair and native transaction rollback preserve pending edits', async ({ context }) => {
  const page = await open(context);
  await apply(page, [create('Local pending', LOCAL)]);
  await script(page, 'sync', [reply({ rev: 3, changes: [record(1, 'Remote first'), record(3, 'Must wait')] }), reply({ rev: 3, changes: [record(3, 'Must wait')] })]);
  await script(page, 'repair', [reply({ snap: { rev: 3 } })]);
  await script(page, 'snapshot', [reply({ rev: 3, ents: [entity('Remote repaired', 3)], tombstones: [] })]);
  await page.evaluate(() => window.clientData.startSync());
  let current = await state(page);
  expect(current.rev).toBe(1);
  expect(current.places.map((item) => item.name).sort()).toEqual(['Local pending', 'Remote first']);
  expect(current.pending).toHaveLength(1);
  const frozen = current.batch.body;
  await page.evaluate(() => window.clientData.advance(15_001));
  await page.evaluate(() => window.clientData.sync());
  current = await state(page);
  expect(current.calls).toEqual([{ op: 'sync', input: { since: 0 } }, { op: 'sync', input: { since: 1 } }, { op: 'repair', input: { since: 1 } }, { op: 'snapshot' }]);
  expect(current.rev).toBe(3);
  expect(current.places.map((item) => item.name).sort()).toEqual(['Local pending', 'Remote repaired']);
  expect(current.pending.map((op) => op.opId)).toEqual([OP]);
  expect(current.commits).toEqual([frozen, frozen]);
  const gapError = await page.evaluate(async (records) => {
    try { await window.clientData.receive(records); return null; } catch (error) { return error.code; }
  }, [record(4, 'Would roll back'), record(6, 'Invalid gap')]);
  expect(gapError).toBe('sync_gap');
  expect((await state(page)).rev).toBe(3);
  expect((await state(page)).places.map((item) => item.name).sort()).toEqual(['Local pending', 'Remote repaired']);
  await reload(page);
  current = await state(page);
  expect(current.rev).toBe(3);
  expect(current.pending.map((op) => op.opId)).toEqual([OP]);
  expect(current.batch.body).toBe(frozen);
  expect(current.places.map((item) => item.name).sort()).toEqual(['Local pending', 'Remote repaired']);
});

test('separate account contexts edit offline, reconnect with identical bytes and consume scripted remote changes', async ({ browser, context }) => {
  const alice = await open(context);
  const bobContext = await isolated(browser);
  const bob = await open(bobContext, 'b');
  await context.setOffline(true);
  await apply(alice, [create('Offline shared draft')]);
  expect((await flush(alice))).toEqual({ status: 'queued', code: 'fixture_offline' });
  const frozen = (await state(alice)).batch.body;
  expect((await state(bob)).places).toEqual([]);
  await context.setOffline(false);
  await script(alice, 'commit', [ack('Shared confirmed', 1)]);
  expect((await flush(alice)).status).toBe('sent');
  expect((await state(alice)).commits).toEqual([frozen, frozen]);
  await script(bob, 'sync', [reply({ rev: 1, changes: [record(1, 'Shared confirmed')] })]);
  await bob.evaluate(() => window.clientData.startSync());
  expect((await state(bob)).places.map((item) => item.name)).toEqual(['Shared confirmed']);
  expect((await state(bob)).pending).toEqual([]);
  expect((await state(bob)).rev).toBe(1);
  await reload(bob);
  expect((await state(bob)).places.map((item) => item.name)).toEqual(['Shared confirmed']);
});

test.describe('path A through KV handles', () => {
  const BOB = '00000000-0000-4000-8000-000000000002';
  const WORKER = 'trips-stubworker';
  async function fixture(browser) {
    const world = createFakePuter({ users: [{ uuid: ALICE, username: 'alice' }, { uuid: BOB, username: 'bob' }], shareHandles: true });
    // The owner allowed `kvShare` on `shared:`, so the stub worker can mint.
    world.grantShareConsent(ALICE, 'shared:', 'write');
    await world.registerWorker(WORKER, { owner: ALICE, setup: stubWorker({ name: WORKER }) });
    const host = createTestBridgeHost(world);
    async function account(as) {
      const context = await isolated(browser);
      await attachFakePuterContext(host, context, { as });
      const page = await context.newPage();
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`/dev/client-data/path-a.html?worker=${WORKER}`);
      await expect(page.locator('html')).toHaveAttribute('data-path-a', 'ready');
      return { page, context };
    }
    return { world, host, account };
  }
  const call = (page, method, ...args) => page.evaluate(({ method, args }) => window.pathA[method](...args), { method, args });

  test('two accounts join by named invite, load through the read handle and sync both ways', async ({ browser }) => {
    const f = await fixture(browser);
    try {
      const alice = await f.account('alice');
      const bob = await f.account('bob');
      const space = await call(alice.page, 'createSpace', 'Porto');
      await call(alice.page, 'invite', space, BOB);
      expect(await call(bob.page, 'invites')).toEqual([{ title: 'Porto', ownerName: 'alice', role: 'editor' }]);
      expect(await call(bob.page, 'accept', 0)).toEqual({ role: 'editor', handles: true });
      expect(await call(bob.page, 'open', space)).toMatchObject({ path: 'A', rev: 2, handles: true });
      expect(await call(bob.page, 'title')).toBe('Porto');
      expect(await call(alice.page, 'open', space, { owner: true })).toMatchObject({ path: 'A' });

      const place = await call(alice.page, 'create', 'place', { name: 'Livraria Lello' });
      expect((await call(alice.page, 'flush')).status).toBe('sent');
      await f.host.flush();
      await expect.poll(() => call(bob.page, 'names', 'place')).toEqual(['Livraria Lello']);
      expect((await call(bob.page, 'get', 'place', place)).by).toBe(ALICE);

      await call(bob.page, 'patch', 'place', place, { notes: 'Book ahead' });
      expect((await call(bob.page, 'flush')).status).toBe('sent');
      await f.host.flush();
      await expect.poll(() => call(alice.page, 'get', 'place', place).then((entity) => entity?.notes)).toBe('Book ahead');
      expect((await call(alice.page, 'get', 'place', place)).by).toBe(BOB);
      const bobCalls = f.world.counters().byUser[BOB].calls;
      expect(bobCalls['kv.list']).toBeGreaterThanOrEqual(2);
      expect(bobCalls['kv.get']).toBeGreaterThan(0);
      await expect.poll(() => call(alice.page, 'members').then((members) => members.find((member) => member.uid === BOB)?.active)).toBe(true);

      await bob.page.reload();
      await expect(bob.page.locator('html')).toHaveAttribute('data-path-a', 'ready');
      const restored = await call(bob.page, 'open', space, { autoStart: false });
      expect(restored.rev).toBeGreaterThanOrEqual(4);
      expect(await call(bob.page, 'names', 'place')).toEqual(['Livraria Lello']);
      await call(bob.page, 'start');
      expect(await call(bob.page, 'state')).toMatchObject({ path: 'A', sync: 'synced' });
      expect(await call(bob.page, 'errors')).toEqual([]);
    } finally { await f.host.close(); }
  });

  test('an offline edit stays queued in IndexedDB and reaches the owner after reconnecting', async ({ browser }) => {
    const f = await fixture(browser);
    try {
      const alice = await f.account('alice');
      const bob = await f.account('bob');
      const space = await call(alice.page, 'createSpace', 'Kyoto');
      await call(alice.page, 'invite', space, BOB);
      await call(bob.page, 'invites');
      await call(bob.page, 'accept', 0);
      await call(alice.page, 'open', space, { owner: true });
      const place = await call(alice.page, 'create', 'place', { name: 'Fushimi Inari' });
      await call(alice.page, 'flush');
      await call(bob.page, 'open', space);
      expect(await call(bob.page, 'names', 'place')).toEqual(['Fushimi Inari']);

      await bob.context.setOffline(true);
      await expect.poll(() => f.host.stats().offlinePages).toBe(1);
      await call(bob.page, 'patch', 'place', place, { notes: 'Go at dawn' });
      expect((await call(bob.page, 'flush')).status).toBe('queued');
      expect(await call(bob.page, 'state')).toMatchObject({ pending: 1 });
      expect((await call(bob.page, 'get', 'place', place)).notes).toBe('Go at dawn');
      await bob.context.setOffline(false);
      await expect.poll(() => f.host.stats().offlinePages).toBe(0);
      // The online event wakes the sync engine, which sends the queued batch.
      await expect.poll(() => call(bob.page, 'state').then((state) => state.pending)).toBe(0);
      await f.host.flush();
      await expect.poll(() => call(alice.page, 'get', 'place', place).then((entity) => entity?.notes)).toBe('Go at dawn');
    } finally { await f.host.close(); }
  });
});
