// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { createBridgeCodec } from '../../dev/fake-puter/bridge-codec.js';
import { createTestBridgeHost } from '../../dev/fake-puter/bridge-host.js';
import { createRemoteFakePuter } from '../../dev/fake-puter/bridge-client.js';
const codec = createBridgeCodec();
async function fixture(as = 'alice') {
  const world = createFakePuter({ shareHandles: true }); const host = createTestBridgeHost(world); const bound = host.openContext({ as });
  let remote; const endpoint = bound.connect(message => remote?.receive(message));
  remote = createRemoteFakePuter({ request: envelope => endpoint.request(envelope), documentId: 'fixture-document', isOnline: () => true }); await remote.client.ready;
  return { world, host, bound, endpoint, remote, client: remote.client };
}
describe('bridge wire values', () => {
  it('keeps tagged user objects ordinary and preserves binary leaves', async () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 128]);
    const result = codec.decode(await codec.encode({ t: 'request', value: undefined, data: [new Blob([bytes], { type: 'application/octet-stream' }), bytes.subarray(1, 4)] }));
    expect(result.t).toBe('request'); expect(result).toHaveProperty('value', undefined); expect([...new Uint8Array(await result.data[0].arrayBuffer())]).toEqual([...bytes]); expect(result.data[0].type).toBe('application/octet-stream'); expect([...result.data[1]]).toEqual([255, 13, 10]);
  });
  it('round-trips Request/Response bytes, headers, status and null bodies', async () => {
    const bytes = new Uint8Array([0, 255, 13, 10]);
    const request = codec.decode(await codec.encode(new Request('https://worker.puter.work/', { method: 'POST', headers: { 'X-Test': 'yes' }, body: bytes })));
    expect(request.headers.get('x-test')).toBe('yes'); expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([...bytes]);
    const response = codec.decode(await codec.encode(new Response(bytes, { status: 201, statusText: 'Created' })));
    expect(response.status).toBe(201); expect(response.statusText).toBe('Created'); expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes]); expect(codec.decode(await codec.encode(new Response(null, { status: 204 }))).body).toBeNull();
  });
  it('refuses executable values, malformed tags, duplicate keys and oversize bodies', async () => {
    for (const value of [() => 1, new Date()]) await expect(codec.encode(value)).rejects.toMatchObject({ code: 'bridge_invalid_value' });
    await expect(createBridgeCodec({ maxBytes: 3 }).encode(new Blob(['1234']))).rejects.toThrow(); expect(() => codec.decode({ t: 'constructor' })).toThrow();
    expect(() => codec.decode({ t: 'object', v: [['a', { t: 'scalar', v: 1 }], ['a', { t: 'scalar', v: 2 }]] })).toThrow(); expect(() => codec.decode({ t: 'bytes', data: 'bad data' })).toThrow();
  });
});
describe('bound SDK bridge', () => {
  it('pins identity on the server and restores the same account after sign-out', async () => {
    const { client, endpoint, host } = await fixture('bob'); expect((await client.auth.getUser()).uuid).toBe('bob');
    const raw = { version: 1, documentId: 'fake', requestId: 'one', method: 'auth.getUser', args: await codec.encode([]) };
    expect((await endpoint.request({ ...raw, as: 'alice' })).error.code).toBe('bridge_invalid_request');
    for (const method of ['constructor', 'kv.__proto__', 'eval', 'world.setOffline']) expect((await endpoint.request({ ...raw, method })).error.code).toBe('bridge_method_denied');
    expect(() => { client.authToken = 'forged'; }).toThrow(); await client.auth.signOut(); expect(client.auth.isSignedIn()).toBe(false); expect(client.authToken).toBeNull(); await expect(client.auth.getUser()).rejects.toMatchObject({ status: 401 });
    await client.auth.signIn(); expect((await client.auth.getUser()).uuid).toBe('bob'); await host.close();
  });
  it('owns subscriptions per page and tears them down at navigation/context close', async () => {
    const { client, world, host, endpoint, bound } = await fixture(); const receive = vi.fn(); const sub = await client.events.onLocal('kv:trips:k', receive); const other = bound.connect(() => {});
    const request = { version: 1, documentId: 'other', requestId: 'one', method: 'bridge.hello', args: await codec.encode([]) }; await other.request(request);
    expect((await other.request({ ...request, requestId: 'two', method: 'events.unsubscribe', args: await codec.encode([sub.subId]) })).error.code).toBe('bridge_subscription_not_found');
    await client.kv.set('k', 1); await host.flush(); expect(receive).toHaveBeenCalledOnce(); await endpoint.navigate(); expect(host.stats().subscriptions).toBe(0);
    await world.client('alice').kv.set('k', 2); await host.flush(); expect(receive).toHaveBeenCalledOnce(); await host.close(); expect(host.stats()).toMatchObject({ contexts: 0, pages: 0, subscriptions: 0 });
  });
  it('shares KV and Blob files only through native grants, with holder billing', async () => {
    const { client: alice, world, host } = await fixture(); const bound = host.openContext({ as: 'bob' }); let remote; const endpoint = bound.connect(message => remote.receive(message)); remote = createRemoteFakePuter({ request: message => endpoint.request(message), isOnline: () => true }); const bob = await remote.client.ready;
    expect(await alice.perms.request('kvShare', { prefix: 's:', access: 'write' })).toBe(true);
    await alice.kv.set('s:k', 1); expect(await bob.kv.get('s:k')).toBeNull(); const grant = await alice.kv.share('s:', 'bob', 'write'); await bob.kv.update('k', { '': 2 }, { handle: grant.handle }); expect(await alice.kv.get('s:k')).toBe(2);
    const file = await alice.fs.write('file', new Blob([new Uint8Array([0, 255])], { type: 'x-test' })); await alice.fs.share(file.uid, 'bob', 'read'); expect([...new Uint8Array(await (await bob.fs.read(file.uid)).arrayBuffer())]).toEqual([0, 255]); expect(world.counters().byUser.bob.calls['kv.update']).toBe(1); await host.close();
  });
  it('implements streamed KV lists as remote pages', async () => {
    const { client, host } = await fixture(); await client.kv.set(['a', 'b', 'c'].map(key => ({ key, value: key }))); const pages = []; for await (const page of client.kv.list({ stream: true, limit: 2 })) pages.push(page.items); expect(pages).toEqual([['a', 'b'], ['c']]); await host.close();
  });
  it('rejects foreign worker credentials before reaching the runtime', async () => {
    const { client, world, host } = await fixture(); const bob = world.client('bob'); await expect(client.workers.exec('https://none.puter.work', { headers: { 'puter-auth': bob.authToken } })).rejects.toMatchObject({ code: 'bridge_credential_scope' }); expect(world.counters().calls['workers.exec']).toBeUndefined(); await host.close();
  });
  it('isolates local abort from another consumer', async () => {
    const { world, client, host } = await fixture(); await world.registerWorker('slow', { owner: 'alice', fetch: async request => { await new Promise(resolve => setTimeout(resolve, 100)); return new Response(await request.arrayBuffer()); } });
    const controller = new AbortController(); const one = client.workers.exec('https://slow.puter.work', { method: 'POST', body: 'one', signal: controller.signal }); const two = client.workers.exec('https://slow.puter.work', { method: 'POST', body: 'two' });
    await vi.waitFor(() => expect(world.counters().calls['workers.exec']).toBe(2)); controller.abort(); await expect(one).rejects.toMatchObject({ name: 'AbortError' }); expect(await (await two).text()).toBe('two'); await host.close();
  });
});

it('enforces the declared offline connection on raw SDK RPC calls', async () => {
  const { world, endpoint, host } = await fixture(); let sequence = 0;
  const raw = async (method, args) => endpoint.request({ version: 1, documentId: 'fixture-document', requestId: 'raw-' + ++sequence, method, args: await codec.encode(args) });
  expect((await raw('bridge.connection', [false])).ok).toBe(true);
  const offline = await raw('kv.set', ['should-not-exist', 1]); expect(offline.error).toMatchObject({ code: 'offline', status: 0 }); expect(world.inspectKv('alice')).toEqual({}); expect(world.counters().calls['kv.set']).toBeUndefined();
  expect((await raw('bridge.connection', [true])).ok).toBe(true); expect((await raw('kv.set', ['online', 1])).ok).toBe(true); expect(world.inspectKv('alice')).toEqual({ online: 1 }); await host.close();
});

it('gives each page its own 50-subscription socket allowance', async () => {
  const { client, host, bound } = await fixture(); let remote;
  const endpoint = bound.connect(message => remote.receive(message)); remote = createRemoteFakePuter({ request: message => endpoint.request(message), isOnline: () => true }); const peer = await remote.client.ready;
  for (let i = 0; i < 50; i++) await client.events.onLocal('kv:trips:capacity', () => {});
  for (let i = 0; i < 50; i++) await peer.events.onLocal('kv:trips:capacity', () => {});
  expect(host.stats().subscriptions).toBe(100); await expect(client.events.onLocal('kv:trips:overflow', () => {})).rejects.toMatchObject({ status: 429 });
  await host.close(); expect(host.stats().subscriptions).toBe(0);
});
