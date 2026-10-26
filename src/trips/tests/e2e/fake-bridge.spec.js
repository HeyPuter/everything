import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { createTestBridgeHost } from '../../dev/fake-puter/bridge-host.js';
import { attachFakePuterContext, bridgeBrowserSource } from '../../dev/fake-puter/bridge-playwright.js';

const origin = 'https://trips-abcdefghij.puter.work';
let workerSource, clientSource;
test.beforeAll(async () => {
  clientSource = await bridgeBrowserSource();
  const bundle = await build({ configFile: false, publicDir: false, logLevel: 'silent', build: { write: false, target: 'es2022', minify: false, lib: { entry: fileURLToPath(new URL('./fake-bridge-worker-entry.js', import.meta.url)), formats: ['iife'], name: 'bridgeWorkerFixture' } } });
  workerSource = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(item => item.type === 'chunk').code;
});
async function setup(browser, options = {}) {
  const world = createFakePuter({ shareHandles: true, ...options });
  world.grantShareConsent('alice', 'shared:', 'write');
  await world.registerWorker('trips-abcdefghij', { owner: 'alice', source: workerSource });
  const host = createTestBridgeHost(world);
  const aliceContext = await browser.newContext(), bobContext = await browser.newContext();
  for (const context of [aliceContext, bobContext]) await context.route('**/*', route => route.abort());
  const aliceBinding = await attachFakePuterContext(host, aliceContext, { as: 'alice', source: clientSource });
  const bobBinding = await attachFakePuterContext(host, bobContext, { as: 'bob', region: options.regions === 2 ? 1 : 0, source: clientSource });
  const page = async context => { const page = await context.newPage(); await page.goto('about:blank'); await page.evaluate(async () => { if (!globalThis.__fakePuterBridgeReady) throw new Error('Bridge bootstrap did not install'); await globalThis.__fakePuterBridgeReady; }); return page; };
  const alice = await page(aliceContext), bob = await page(bobContext);
  return { world, host, alice, bob, aliceContext, bobContext, aliceBinding, bobBinding, async close() { await aliceContext.close(); await bobContext.close(); await host.close(); } };
}

test('two isolated accounts create, discover, edit and observe real worker writes across replicas', async ({ browser }) => {
  const f = await setup(browser, { regions: 2, replicationDelay: 60_000 });
  try {
    await f.aliceContext.addCookies([{ name: 'isolation', value: 'alice', url: 'https://trips.test' }]); expect(await f.bobContext.cookies('https://trips.test')).toEqual([]);
    await f.alice.evaluate(async () => { await puter.kv.set('shared:record', { title: 'First', by: 'alice' }); await puter.kv.share('shared:', 'bob', 'read'); });
    expect(await f.bob.evaluate(() => puter.kv.get('shared:record'))).toBeNull();
    expect(await f.bob.evaluate(async () => { const { items: [grant] } = await puter.kv.listShared(); globalThis.handle = grant.handle; return puter.kv.get('record', { handle: grant.handle }); })).toBeNull();
    f.world.flushReplication(); expect(await f.bob.evaluate(() => puter.kv.get('record', { handle }))).toEqual({ title: 'First', by: 'alice' });
    await f.bob.evaluate(async () => { globalThis.changes = []; globalThis.subscription = await puter.events.onLocal(`kv:${handle}:record`, ({ event }) => changes.push(event), { includeValue: true }); });
    const result = await f.bob.evaluate(async origin => (await puter.workers.exec(origin + '/edit', { method: 'POST', body: JSON.stringify({ title: 'Edited', by: 'alice' }) })).json(), origin);
    expect(result).toEqual({ ok: true, record: { title: 'Edited', by: 'bob' } }); await f.host.flush();
    await expect.poll(() => f.bob.evaluate(() => changes.length)).toBe(1); expect(await f.bob.evaluate(() => changes[0])).toMatchObject({ value: { title: 'Edited', by: 'bob' }, viaWorker: true, self: false });
    expect(await f.alice.evaluate(() => puter.kv.get('shared:record'))).toMatchObject({ title: 'Edited', by: 'bob' });
    expect(await f.bob.evaluate(() => puter.kv.get('record', { handle }))).toMatchObject({ title: 'First' });
    f.world.flushReplication(); expect(await f.bob.evaluate(() => puter.kv.get('record', { handle }))).toMatchObject({ title: 'Edited' });
    expect(f.world.counters().byUser.alice.calls['kv.update']).toBe(1); expect(f.world.counters().byUser.bob.calls['workers.exec']).toBe(1);
  } finally { await f.close(); }
});

test('Blob files and worker Request/Response bodies remain byte exact over RPC', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const file = await f.alice.evaluate(async () => { const file = await puter.fs.write('binary', new Blob([new Uint8Array([0, 255, 13, 10, 128, 195, 169])], { type: 'application/octet-stream' })); await puter.fs.share(file.uid, 'bob', 'write'); return file; });
    expect(await f.bob.evaluate(async uid => [...new Uint8Array(await (await puter.fs.read(uid)).arrayBuffer())], file.uid)).toEqual([0, 255, 13, 10, 128, 195, 169]);
    await f.bob.evaluate(uid => puter.fs.write(uid, new Blob([new Uint8Array([255, 0, 10])])), file.uid);
    expect(await f.alice.evaluate(async uid => [...new Uint8Array(await (await puter.fs.read(uid)).arrayBuffer())], file.uid)).toEqual([255, 0, 10]);
    const result = await f.bob.evaluate(async origin => {
      const request = new Request(origin + '/bytes', { method: 'POST', body: new Uint8Array([0, 255, 13, 10, 195, 169]) }); const response = await puter.workers.exec(request);
      return { status: response.status, statusText: response.statusText, caller: response.headers.get('x-caller'), mime: response.headers.get('content-type'), bytes: [...new Uint8Array(await response.arrayBuffer())], empty: (await puter.workers.exec(origin + '/empty')).body === null };
    }, origin);
    expect(result).toEqual({ status: 201, statusText: 'Created', caller: 'bob', mime: 'application/octet-stream', bytes: [0, 255, 13, 10, 195, 169], empty: true });
    expect(f.world.counters().byUser.bob.fsWriteOps).toBe(1);
  } finally { await f.close(); }
});

test('offline/reconnect preserves state, emits a gap and resumes SDK writes', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.alice.evaluate(async () => { await puter.kv.set('shared:record', { title: 'Before' }); await puter.kv.share('shared:', 'bob', 'write'); });
    await f.bob.evaluate(async () => { globalThis.handle = (await puter.kv.listShared()).items[0].handle; globalThis.events = []; await puter.events.onLocal(`kv:${handle}:*`, ({ event }) => events.push(event), { includeValue: true }); });
    await f.bobContext.setOffline(true); await expect.poll(() => f.host.stats().offlinePages).toBe(1);
    const before = f.world.counters().byUser.bob.calls['kv.set'] ?? 0;
    expect(await f.bob.evaluate(async () => { try { await puter.kv.set('record', { title: 'Offline' }, { handle }); } catch (cause) { return { code: cause.code, status: cause.status }; } })).toEqual({ code: 'offline', status: 0 });
    expect(f.world.counters().byUser.bob.calls['kv.set'] ?? 0).toBe(before);
    await f.alice.evaluate(() => puter.kv.set('shared:record', { title: 'While offline' })); await f.host.flush(); expect(await f.bob.evaluate(() => events.length)).toBe(0);
    await f.bobContext.setOffline(false); await expect.poll(() => f.bob.evaluate(() => events.some(event => event.op === 'gap'))).toBe(true);
    expect(await f.bob.evaluate(() => puter.kv.get('record', { handle }))).toEqual({ title: 'While offline' });
    await f.bob.evaluate(() => puter.kv.set('record', { title: 'Reconnected' }, { handle })); expect(await f.alice.evaluate(() => puter.kv.get('shared:record'))).toEqual({ title: 'Reconnected' });
  } finally { await f.close(); }
});

test('auth metadata, subscription ownership, iframe boundaries and context teardown remain scoped', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const subId = await f.alice.evaluate(async () => { globalThis.changes = []; const sub = await puter.events.onLocal('kv:trips:k', ({ event }) => changes.push(event)); return sub.subId; });
    expect(await f.bob.evaluate(async id => { try { await puter.events.unsubscribe(id); } catch (cause) { return cause.code; } }, subId)).toBe('bridge_subscription_not_found');
    await f.alice.evaluate(() => puter.kv.set('k', 1)); await f.host.flush(); expect(await f.alice.evaluate(() => changes.length)).toBe(1);
    const peer = await f.bobContext.newPage(); await peer.goto('about:blank'); await peer.evaluate(async () => { if (!globalThis.__fakePuterBridgeReady) throw new Error('Bridge bootstrap did not install'); await __fakePuterBridgeReady; });
    await f.bob.evaluate(() => puter.auth.signOut()); await expect.poll(() => peer.evaluate(() => puter.auth.isSignedIn())).toBe(false); expect(await f.bob.evaluate(() => puter.authToken)).toBeNull();
    await f.bob.evaluate(() => puter.auth.signIn()); await expect.poll(() => peer.evaluate(() => puter.auth.isSignedIn())).toBe(true); expect(await peer.evaluate(async () => (await puter.auth.getUser()).uuid)).toBe('bob');
    const denied = await f.bob.evaluate(async binding => globalThis[binding]({ version: 1, documentId: 'attack', requestId: 'attack', method: 'eval', args: { t: 'array', v: [] } }), f.bobBinding.binding); expect(denied.error.code).toBe('bridge_method_denied');
    await f.bob.evaluate(() => { const frame = document.createElement('iframe'); document.body.append(frame); }); const child = f.bob.frames().find(frame => frame !== f.bob.mainFrame());
    expect((await child.evaluate(binding => globalThis[binding]({}), f.bobBinding.binding)).error.code).toBe('bridge_context_denied');
    await f.aliceContext.close(); await expect.poll(() => f.host.stats().subscriptions).toBe(0); await expect.poll(() => f.host.stats().contexts).toBe(1);
    const events = f.world.counters().events; await f.world.client('alice').kv.set('k', 2); await f.host.flush(); expect(f.world.counters().events).toBe(events);
  } finally { await f.close(); }
});

test('aborting one worker consumer does not cancel another or undo server-side writes', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.bob.evaluate(origin => {
      globalThis.controller = new AbortController();
      globalThis.first = puter.workers.exec(origin + '/slow', { method: 'POST', body: 'one', signal: controller.signal }).then(() => 'resolved', cause => cause.name);
      globalThis.second = puter.workers.exec(origin + '/slow', { method: 'POST', body: 'two' }).then(response => response.text());
    }, origin);
    await expect.poll(() => f.world.counters().byUser.bob.calls['workers.exec']).toBe(2); await f.bob.evaluate(() => controller.abort());
    expect(await f.bob.evaluate(() => first)).toBe('AbortError'); expect(await f.bob.evaluate(() => second)).toBe('two'); await expect.poll(() => f.host.stats().inFlight).toBe(0);
    expect(f.world.inspectKv('alice')).toMatchObject({ 'shared:slow:one': 'bob', 'shared:slow:two': 'bob' });
  } finally { await f.close(); }
});

test('navigation closes old subscriptions and rebinds the new document to the same account', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const id = await f.bob.evaluate(async () => (await puter.events.onLocal('kv:trips:personal', () => {})).subId);
    expect(f.host.stats().subscriptions).toBe(1); await f.bob.reload();
    await f.bob.evaluate(async () => { if (!globalThis.__fakePuterBridgeReady) throw new Error('Missing bridge'); await __fakePuterBridgeReady; });
    expect(f.host.stats().subscriptions).toBe(0); expect(await f.bob.evaluate(async () => (await puter.auth.getUser()).uuid)).toBe('bob');
    expect(await f.bob.evaluate(async id => { try { await puter.events.unsubscribe(id); } catch (cause) { return cause.code; } }, id)).toBe('bridge_subscription_not_found');
  } finally { await f.close(); }
});

test('registered read credentials retain their file scope through worker RPC and revocation', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const result = await f.bob.evaluate(async origin => {
      const file = await puter.fs.write('identity-proof', 'proof'); const other = await puter.fs.write('other-private', 'other');
      const url = await puter.fs.getReadURL(file.uid); const token = new URL(url).searchParams.get('token');
      const call = path => puter.workers.exec(origin + '/proof', { method: 'POST', headers: { 'puter-auth': token }, body: JSON.stringify({ path }) });
      const valid = await (await call(file.path)).json(); const denied = (await call(other.path)).status;
      await puter.fs.revokeReadURL(url); const revoked = (await call(file.path)).status;
      return { valid, denied, revoked };
    }, origin);
    expect(result).toEqual({ valid: { owner: 'bob', content: 'proof' }, denied: 403, revoked: 403 });
  } finally { await f.close(); }
});

test('two pages of one account have independent 50-subscription socket budgets', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const peer = await f.aliceContext.newPage(); await peer.goto('about:blank'); await peer.evaluate(async () => { await __fakePuterBridgeReady; });
    for (const page of [f.alice, peer]) await page.evaluate(async () => { globalThis.deliveries = 0; for (let i = 0; i < 50; i++) await puter.events.onLocal('kv:trips:capacity', () => deliveries++); });
    expect(f.host.stats().subscriptions).toBe(100);
    expect(await f.alice.evaluate(async () => { try { await puter.events.onLocal('kv:trips:overflow', () => {}); } catch (cause) { return cause.status; } })).toBe(429);
    await f.world.client('alice').kv.set('capacity', 1); await f.host.flush();
    expect(await f.alice.evaluate(() => deliveries)).toBe(50); expect(await peer.evaluate(() => deliveries)).toBe(50);
    await peer.close(); await expect.poll(() => f.host.stats().subscriptions).toBe(50);
  } finally { await f.close(); }
});
