// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { installHandlers } from './fake-handlers.js';

const origin = 'https://trips-abcdefghij.puter.work';
async function fixture(options = {}) {
  const runtime = createFakePuter(options);
  const registration = await runtime.registerWorker('trips-abcdefghij', { owner: 'alice', setup: installHandlers });
  return { runtime, registration, alice: runtime.client('alice'), bob: runtime.client('bob') };
}

describe('in-page worker routing with imported JS handlers', () => {
  it('binds owner and caller clients, preserves raw route params and meters owner writes', async () => {
    const { runtime, bob } = await fixture();
    const identity = await (await bob.workers.exec(origin + '/identity/a%2Fb')).json();
    expect(identity).toMatchObject({ caller: { uuid: 'bob' }, owner: { uuid: 'alice' }, param: 'a%2Fb' });
    runtime.resetCounters();
    expect(await (await bob.workers.exec(origin + '/write', { method: 'POST', body: JSON.stringify({ value: 1 }) })).json()).toEqual({ ok: true });
    expect(runtime.inspectKv('alice')['shared:last']).toEqual({ by: 'bob', body: { value: 1 } }); expect(runtime.inspectKv('bob')).toEqual({});
    expect(runtime.counters().byUser.alice.calls['kv.set']).toBe(1);
    expect(runtime.counters().log.find(entry => entry.method === 'kv.set')).toMatchObject({ payer: 'alice', worker: true });
  });
  it('honors explicit credentials and x-puter-no-auth without forwarding a session', async () => {
    const { alice, bob } = await fixture();
    const explicit = await (await bob.workers.exec(origin + '/identity/id', { headers: { 'puter-auth': alice.authToken } })).json(); expect(explicit.caller.uuid).toBe('alice');
    expect((await bob.workers.exec(origin + '/health', { headers: { 'x-puter-no-auth': '1' } })).status).toBe(200);
    expect((await bob.workers.exec(origin + '/identity/id', { headers: { 'x-puter-no-auth': '1' } })).status).toBe(500);
    expect((await bob.workers.exec(origin + '/write', { method: 'POST', headers: { 'puter-auth': 'forged' }, body: '{}' })).status).toBe(401);
  });
  it('validates a restricted proof through actual WebCrypto and refuses wrong paths/revocation', async () => {
    const { runtime, alice, bob } = await fixture();
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const file = await bob.fs.write('identity.json', JSON.stringify({ publicKey }));
    const other = await bob.fs.write('private.json', 'private');
    const readURL = await bob.fs.getReadURL(file.uid, '24h'); const token = new URL(readURL).searchParams.get('token');
    const body = { value: 'signed' };
    const signature = [...new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(JSON.stringify([origin, file.path, body]))))];
    const call = path => bob.workers.exec(origin + '/proof', { method: 'POST', headers: { 'puter-auth': token }, body: JSON.stringify({ path, signature, body }) });
    expect(await (await call(file.path)).json()).toEqual({ ok: true, caller: 'bob' });
    expect(runtime.inspectKv('alice')['shared:proof']).toEqual({ by: 'bob', body });
    expect((await call(other.path)).status).toBe(401);
    await bob.fs.revokeReadURL(readURL); expect((await call(file.path)).status).toBe(401);
    expect(await alice.kv.get('shared:proof')).toEqual({ by: 'bob', body });
  });
  it('scopes read credentials away from auth, KV and other files inside a fetch handler', async () => {
    const { runtime, bob } = await fixture(); const file = await bob.fs.write('proof', 'x'); const token = new URL(await bob.fs.getReadURL(file.uid)).searchParams.get('token');
    await runtime.registerWorker('restricted', { owner: 'alice', fetch: async (_request, { user }) => {
      await expect(user.puter.auth.getUser()).rejects.toMatchObject({ status: 403 });
      await expect(user.puter.kv.get('anything')).rejects.toMatchObject({ status: 403 });
      await expect(user.puter.fs.write('proof', 'changed')).rejects.toMatchObject({ status: 403 });
      return { valid: (await user.puter.fs.stat(file.uid)).uid };
    } });
    expect(await (await bob.workers.exec('https://restricted.puter.work/', { headers: { 'puter-auth': token } })).json()).toEqual({ valid: file.uid });
  });
  it('tracks deferred work, custom routes and raw thrown-error/404 semantics', async () => {
    const { runtime, bob } = await fixture();
    await bob.workers.exec(origin + '/defer'); await runtime.flushWorkers(); expect(runtime.inspectKv('alice').deferred).toBe(true);
    expect(await (await bob.workers.exec(origin + '/find/a/b', { method: 'SEARCH' })).json()).toEqual({ rest: 'a/b' });
    const missing = await bob.workers.exec(origin + '/missing'); expect(missing.status).toBe(404); expect(missing.headers.has('access-control-allow-origin')).toBe(false);
    const thrown = await bob.workers.exec(origin + '/throws'); expect(thrown.status).toBe(500); expect(await thrown.text()).toBe('handler error');
  });
  it('selects region-specific worker registrations without sharing isolate state', async () => {
    const { runtime } = await fixture({ regions: 2 });
    for (const region of [0, 1]) await runtime.registerWorker('region', { owner: 'alice', region, setup({ router, me }) { let count = 0; router.get('/', async () => ({ count: ++count, rev: await me.puter.kv.incr('rev') })); } });
    expect(await (await runtime.client('bob', 0).workers.exec('https://region.puter.work')).json()).toEqual({ count: 1, rev: 1 });
    expect(await (await runtime.client('bob', 1).workers.exec('https://region.puter.work')).json()).toEqual({ count: 1, rev: 1 });
  });
  it('passes injected owner 402 errors through a wrapped handler', async () => {
    const { runtime, bob } = await fixture(); runtime.failNext({ as: 'alice', method: 'kv.set' });
    const reply = await bob.workers.exec(origin + '/write', { method: 'POST', body: '{}' }); expect(reply.status).toBe(402); expect(await reply.json()).toEqual({ code: 'insufficient_funds' }); expect(runtime.inspectKv('alice')).toEqual({});
  });
});

it('executes an actual Vite IIFE bundle with isolated lexical runtime bindings', async () => {
  const { build } = await import('vite');
  const artifact = await build({
    configFile: false, publicDir: false, logLevel: 'silent',
    build: { write: false, minify: false, lib: { entry: new URL('./fake-bundle-entry.js', import.meta.url).pathname, formats: ['iife'], name: 'fakeWorker' } },
  });
  const source = (Array.isArray(artifact) ? artifact[0] : artifact).output.find(output => output.type === 'chunk').code;
  const runtime = createFakePuter();
  const globals = { router: globalThis.router, me: globalThis.me };
  await runtime.registerWorker('bundle-alice', { owner: 'alice', source });
  await runtime.registerWorker('bundle-carol', { owner: 'carol', source });
  const bob = runtime.client('bob');
  const replies = await Promise.all(['bundle-alice', 'bundle-carol'].map(name => bob.workers.exec(`https://${name}.puter.work/write`, { method: 'POST', body: JSON.stringify({ worker: name }) })));
  expect(replies.map(reply => reply.status)).toEqual([200, 200]);
  expect(runtime.inspectKv('alice')['shared:last']).toEqual({ by: 'bob', body: { worker: 'bundle-alice' } });
  expect(runtime.inspectKv('carol')['shared:last']).toEqual({ by: 'bob', body: { worker: 'bundle-carol' } });
  expect(globalThis.router).toBe(globals.router); expect(globalThis.me).toBe(globals.me);
});
