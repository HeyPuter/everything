// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createCredentialManager, sha256 } from '../../src/lib/cred.js';
import { createWorkerClient } from '../../src/lib/api.js';
import { ORIGIN, USERS, WORKER, createHarness, expectError, id, memoryDb } from './harness.js';

const exec = (client, path, init = {}) => client.puter.workers.exec(ORIGIN + path, init);

describe('router shell', () => {
  it('serves /health without credentials and CORS on every response', async () => {
    const h = await createHarness();
    const bob = await h.client('bob');
    const health = await exec(bob, '/health', { headers: { 'x-puter-no-auth': '1' } });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, build: 'test000007', builtAt: 1_700_000_000_000, protocol: 1 });
    expect(health.headers.get('access-control-allow-origin')).toBe('*');
    const missing = await exec(bob, '/nope/deeper', { headers: { 'x-puter-no-auth': '1' } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('access-control-allow-origin')).toBe('*');
    expect(await missing.json()).toMatchObject({ code: 'not_found' });
    const root = await exec(bob, '/', { method: 'POST', headers: { 'x-puter-no-auth': '1' } });
    expect(root.status).toBe(404);
    const preflight = await exec(bob, '/api', { method: 'OPTIONS', headers: { 'x-puter-no-auth': '1' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-trips-proof');
  });

  it('answers hello unauthenticated and rejects bad bodies as JSON errors', async () => {
    const h = await createHarness();
    const bob = await h.client('bob');
    const hello = await exec(bob, '/api', { method: 'POST', headers: { 'x-puter-no-auth': '1' }, body: JSON.stringify({ op: 'hello' }) });
    expect(await hello.json()).toMatchObject({ ok: true, build: 'test000007', builtAt: 1_700_000_000_000, protocol: 1, features: expect.arrayContaining(['commit', 'sync']) });
    const bad = await exec(bob, '/api', { method: 'POST', headers: { 'x-puter-no-auth': '1' }, body: '{nope' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid_json' });
    const unknown = await exec(bob, '/api', { method: 'POST', headers: { 'x-puter-no-auth': '1' }, body: JSON.stringify({ op: 'constructor' }) });
    expect((await unknown.json()).code).toBe('unknown_op');
    const big = await exec(bob, '/api', { method: 'POST', headers: { 'x-puter-no-auth': '1' }, body: JSON.stringify({ op: 'hello', pad: 'x'.repeat(1_000_001) }) });
    expect(big.status).toBe(413);
    expect(big.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('maps owner 402s and platform 429s without internals', async () => {
    const h = await createHarness();
    const space = await h.trip();
    const alice = await h.client('alice');
    h.world.failNext({ method: 'kv.get', as: USERS.alice.uuid, status: 402 });
    h.advance(5000);
    await expectError(alice.in(space).call('sync', { since: 0 }), 402, 'owner_credit');
    h.world.failNext({ method: 'kv.get', as: USERS.alice.uuid, status: 429, code: 'rate_limit_exceeded' });
    h.advance(5000);
    const error = await expectError(alice.in(space).call('sync', { since: 0 }), 503, 'busy');
    expect(JSON.stringify(error)).not.toContain('rate_limit_exceeded');
  });
});

describe('restricted credential auth', () => {
  it('rejects session tokens, missing proofs and unsigned requests', async () => {
    const h = await createHarness();
    const bob = await h.client('bob');
    const body = JSON.stringify({ op: 'space.list' });
    const session = await exec(bob, '/api', { method: 'POST', headers: { 'puter-auth': bob.puter.authToken }, body });
    expect(session.status).toBe(401);
    expect((await session.json()).code).toBe('restricted_credential_required');
    const headers = await bob.credentials.headers(ORIGIN, body);
    const noProof = await exec(bob, '/api', { method: 'POST', headers: { 'puter-auth': headers['puter-auth'] }, body });
    expect(noProof.status).toBe(401);
    const forged = await exec(bob, '/api', { method: 'POST', headers: { ...headers, 'puter-auth': 'a.b.c' }, body });
    expect(forged.status).toBe(401);
  });

  it('binds the signature to the worker origin and the exact body', async () => {
    const h = await createHarness();
    const space = await h.team({ bob: 'editor' });
    const bob = await h.client('bob');
    const body = JSON.stringify({ op: 'open', space });
    const headers = await bob.credentials.headers(ORIGIN, body);
    expect((await exec(bob, '/api', { method: 'POST', headers, body })).status).toBe(200);
    expect((await exec(bob, '/api', { method: 'POST', headers, body: `${body} ` })).status).toBe(401);
    const other = await bob.credentials.headers('https://trips-0000000000.puter.work', body);
    expect((await exec(bob, '/api', { method: 'POST', headers: other, body })).status).toBe(401);
  });

  it('refuses replays older than 5 minutes and proofs without a signed time', async () => {
    const h = await createHarness();
    const space = await h.team({ bob: 'editor' });
    const bob = await h.client('bob');
    const body = JSON.stringify({ op: 'open', space });
    const headers = await bob.credentials.headers(ORIGIN, body);
    expect((await exec(bob, '/api', { method: 'POST', headers, body })).status).toBe(200);
    h.advance(4 * 60_000);
    expect((await exec(bob, '/api', { method: 'POST', headers, body })).status).toBe(200);
    h.advance(60_001);
    h.world.resetCounters();
    const replay = await exec(bob, '/api', { method: 'POST', headers, body });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ code: 'proof_expired', now: h.now() });
    expect(h.world.counters().calls['fs.stat'] ?? 0).toBe(0);
    const proof = JSON.parse(headers['x-trips-proof']);
    // Moving `at` breaks the signature; dropping it or the old version is refused outright.
    for (const changed of [{ ...proof, at: h.now() }, { ...proof, at: undefined }, { ...proof, version: 1, at: h.now() }]) {
      const response = await exec(bob, '/api', { method: 'POST', headers: { ...headers, 'x-trips-proof': JSON.stringify(changed) }, body });
      expect([response.status, (await response.json()).code]).toEqual([401, 'credential_rejected']);
    }
  });

  it('re-signs once with the worker clock when the device clock is off', async () => {
    const h = await createHarness();
    const space = await h.team({ bob: 'editor' });
    const bob = await h.client('bob');
    for (const skew of [-11 * 60_000, 9 * 60_000]) {
      const credentials = await createCredentialManager({ puter: bob.puter, db: memoryDb(USERS.bob.uuid), crypto: webcrypto, now: () => h.now() + skew });
      const api = createWorkerClient({ puter: bob.puter, credentials });
      h.world.resetCounters();
      expect(await api.call({ w: WORKER, s: space, k: 'trip' }, 'open')).toMatchObject({ role: 'editor' });
      expect(h.world.counters().calls['workers.exec']).toBe(2);
      expect(h.world.counters().calls['fs.getReadURL']).toBe(1);
      h.world.resetCounters();
      await api.call({ w: WORKER, s: space, k: 'trip' }, 'open');
      expect(h.world.counters().calls['workers.exec']).toBe(1);
    }
  });

  it('refuses proof files that are shared, foreign or not identity files', async () => {
    const h = await createHarness();
    const bob = await h.client('bob');
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const publicKey = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
    const sign = async (path, body, at) => btoa(String.fromCharCode(...new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(JSON.stringify([ORIGIN, path, await sha256(body, webcrypto), at]))))));
    const attempt = async (name) => {
      const file = await bob.puter.fs.write(name, JSON.stringify({ version: 1, publicKey }), { createMissingParents: true });
      const token = new URL(await bob.puter.fs.getReadURL(file.path)).searchParams.get('token');
      const body = JSON.stringify({ op: 'space.list' });
      const at = h.now();
      return exec(bob, '/api', { method: 'POST', headers: { 'puter-auth': token, 'x-trips-proof': JSON.stringify({ version: 2, path: file.path, at, signature: await sign(file.path, body, at) }) }, body });
    };
    expect((await attempt('identity/0123456789abcdef0123456789abcdef.json')).status).toBe(403);
    expect((await attempt('notes/key.json')).status).toBe(401);
  });

  it('refuses identity files that are shared or live in another app', async () => {
    const h = await createHarness();
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const publicKey = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
    const attempt = async (puter, sender) => {
      const file = await puter.fs.write('identity/0123456789abcdef0123456789abcdef.json', JSON.stringify({ version: 1, publicKey }), { createMissingParents: true });
      const token = new URL(await puter.fs.getReadURL(file.path)).searchParams.get('token');
      const body = JSON.stringify({ op: 'space.list' });
      const at = h.now();
      const signature = btoa(String.fromCharCode(...new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(JSON.stringify([ORIGIN, file.path, await sha256(body, webcrypto), at]))))));
      return exec(sender, '/api', { method: 'POST', headers: { 'puter-auth': token, 'x-trips-proof': JSON.stringify({ version: 2, path: file.path, at, signature }) }, body });
    };
    const dave = await h.client('dave');
    const otherApp = h.world.client(USERS.dave.uuid, 0, { appUid: 'other-app' });
    expect((await attempt(otherApp, dave)).status).toBe(401);
    expect((await attempt(dave.puter, dave)).status).toBe(403);
    await dave.puter.fs.share('identity', 'carol', 'read');
    h.advance(31_000);
    expect((await attempt(dave.puter, dave)).status).toBe(401);
  });

  it('caches validated proofs, revalidates every 30 s and drops revoked tokens', async () => {
    const h = await createHarness();
    const space = await h.team({ bob: 'editor' });
    const bob = await h.client('bob');
    await bob.in(space).call('open');
    h.world.resetCounters();
    h.advance(1000);
    await bob.in(space).call('open');
    expect(h.world.counters().calls['fs.stat'] ?? 0).toBe(0);
    h.advance(31_000);
    await bob.in(space).call('open');
    expect(h.world.counters().calls['fs.stat']).toBe(1);
    expect(h.world.counters().calls['fs.read'] ?? 0).toBe(0);
    const saved = await bob.credentials.headers(ORIGIN, '{}');
    const proof = JSON.parse(saved['x-trips-proof']);
    const url = `https://api.puter.test/token-read?token=${encodeURIComponent(saved['puter-auth'])}`;
    await bob.puter.fs.revokeReadURL(url);
    h.advance(31_000);
    const body = JSON.stringify({ op: 'open', space });
    const headers = await bob.credentials.headers(ORIGIN, body);
    expect(JSON.parse(headers['x-trips-proof']).path).toBe(proof.path);
    expect((await exec(bob, '/api', { method: 'POST', headers, body })).status).toBe(401);
  });

  it('uses the caller identity from the validated token, never from the body', async () => {
    const h = await createHarness();
    const space = await h.team({ bob: 'viewer' });
    const bob = await h.client('bob');
    await expectError(bob.in(space).call('commit', { uuid: USERS.alice.uuid, ops: [{ opId: id('o'), t: 'place', id: id('p'), put: { name: 'X' } }] }), 403, 'forbidden');
  });
});
