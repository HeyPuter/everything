import { describe, expect, it } from 'vitest';
import { lastIdentity, rememberIdentity } from '../../src/lib/identity.js';
import { createCredentialManager } from '../../src/lib/cred.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { createFakePuter } from '../../dev/fake-puter/index.js';

const alice = { uuid: '11111111-1111-4111-8111-111111111111', username: 'alice' };
function memory() {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), map };
}

describe('last-known identity', () => {
  it('returns the identity only for the token it was stored with, and never stores the token', async () => {
    const storage = memory();
    await rememberIdentity(alice, 'token-a', storage);
    expect([...storage.map.values()].join('')).not.toContain('token-a');
    expect(await lastIdentity('token-a', storage)).toEqual(alice);
    expect(await lastIdentity('token-b', storage)).toBeNull();
    expect(await lastIdentity('', storage)).toBeNull();
  });
  it('ignores invalid or missing records', async () => {
    const storage = memory();
    expect(await lastIdentity('token-a', storage)).toBeNull();
    storage.setItem('trips:identity', '{"uuid":"nope","token":"x"}');
    expect(await lastIdentity('token-a', storage)).toBeNull();
    storage.setItem('trips:identity', 'not json');
    expect(await lastIdentity('token-a', storage)).toBeNull();
    await rememberIdentity({ uuid: 'bad' }, 'token-a', storage);
    expect(storage.getItem('trips:identity')).toBe('not json');
  });
  it('lets the credential manager start offline only for the token the identity was stored with', async () => {
    const world = createFakePuter({ users: [alice, { uuid: '22222222-2222-4222-8222-222222222222', username: 'bob' }] });
    const puter = world.client(alice.uuid);
    const db = { account: alice.uuid, get: async () => undefined };
    try {
      await rememberIdentity(alice, puter.authToken);
      world.setOffline('*');
      await expect(createCredentialManager({ puter, db })).resolves.toBeTruthy();
      // Bob's token, or a new session for Alice, cannot borrow the remembered identity.
      await expect(createCredentialManager({ puter: world.client('bob'), db })).rejects.toMatchObject({ code: 'offline' });
      await expect(createCredentialManager({ puter: world.client(alice.uuid), db })).rejects.toMatchObject({ code: 'offline' });
      // A refused token is not an offline failure.
      world.setOffline('*', false);
      world.failNext({ method: 'auth.getUser', code: 'token_auth_failed', status: 401 });
      await expect(createCredentialManager({ puter, db })).rejects.toMatchObject({ status: 401 });
    } finally { localStorage.clear(); }
  });
  it('lets the personal store read its cache offline only for the token the identity was stored with', async () => {
    const world = createFakePuter({ users: [alice, { uuid: '22222222-2222-4222-8222-222222222222', username: 'bob' }] });
    const puter = world.client(alice.uuid);
    const cache = new Map([['personal:me:spaces', [{ ref: { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' }, role: 'owner', title: 'Lisbon' }]]]);
    const db = { account: alice.uuid, get: async (key) => cache.get(key), put: async (key, value) => { cache.set(key, value); }, remove: async (key) => { cache.delete(key); } };
    try {
      await rememberIdentity(alice, puter.authToken);
      world.setOffline('*');
      expect((await createPersonalStore({ puter, db, locks: null }).spaces.list()).map((entry) => entry.title)).toEqual(['Lisbon']);
      await expect(createPersonalStore({ puter: world.client(alice.uuid), db, locks: null }).spaces.list()).rejects.toMatchObject({ code: 'offline' });
      world.setOffline('*', false);
      world.failNext({ method: 'auth.getUser', code: 'token_auth_failed', status: 401 });
      await expect(createPersonalStore({ puter, db, locks: null }).get('me:spaces')).rejects.toMatchObject({ status: 401 });
    } finally { localStorage.clear(); }
  });
});
