// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { cleanInvite, cleanPresence, createPresence, kvRendezvous } from '../../src/lib/book/peer.js';
import { createFakePeerNetwork } from './helpers/fake-peer.js';

const BOOK = '0000000000000bk1';
const PAGE = '0000000000000pg1';
const SPACE = '00000000000000sp';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function memoryRendezvous(store, uid) {
  return {
    publish: async (value) => { store.set(uid, value); },
    clear: async () => { store.delete(uid); },
    read: async (uids) => new Map(uids.map((member) => [member, store.get(member) ?? null])),
  };
}

describe('peer values', () => {
  it('accepts fresh invites only', () => {
    const now = 1_000_000;
    expect(cleanInvite({ v: 1, invite: 'abc', book: BOOK, at: now }, now)).toEqual({ invite: 'abc', book: BOOK, at: now });
    expect(cleanInvite({ v: 1, invite: 'abc', book: BOOK, at: now - 6 * 60_000 }, now)).toBeNull();
    expect(cleanInvite({ v: 1, invite: 'a b', book: BOOK, at: now }, now)).toBeNull();
    expect(cleanInvite({ v: 1, invite: 'abc', book: 'x', at: now }, now)).toBeNull();
    expect(cleanInvite({ v: 2, invite: 'abc', book: BOOK, at: now }, now)).toBeNull();
  });

  it('clamps presence and drops junk', () => {
    expect(cleanPresence({ v: 1, page: PAGE, x: 0.123456, y: 9, sel: 'nope', drag: { id: PAGE, x: 0, y: 0, w: -1, h: 0.5 } }))
      .toEqual({ page: PAGE, x: 0.1235, y: 1.5, sel: null, drag: { id: PAGE, x: 0, y: 0, w: 0, h: 0.5 } });
    expect(cleanPresence({ v: 1, x: 0.5, y: 0.5 })).toEqual({ page: null, x: null, y: null, sel: null, drag: null });
    expect(cleanPresence('x')).toBeNull();
  });

  it('reads and writes invites in member regions', async () => {
    const calls = [];
    const puter = { appID: 'app', kv: {
      set: async (...args) => { calls.push(['set', ...args]); },
      del: async (...args) => { calls.push(['del', ...args]); },
      get: async (keys, ...config) => { calls.push(['get', keys, ...config]); return keys.map(() => null); },
    } };
    const member = kvRendezvous({ puter, space: SPACE, uid: BOB, handles: { read: 'r1', write: 'w1' } });
    await member.publish({ v: 1 });
    await member.read([ALICE, BOB]);
    await member.clear();
    expect(calls).toEqual([['set', 'peer', { v: 1 }, { handle: 'w1' }], ['get', [`u:${ALICE}:peer`], { handle: 'r1' }], ['del', 'peer', { handle: 'w1' }]]);
    calls.length = 0;
    const owner = kvRendezvous({ puter, space: SPACE, uid: ALICE, owner: true });
    await owner.publish({ v: 1 });
    await owner.read([BOB]);
    expect(calls).toEqual([['set', `shared:${SPACE}:u:${ALICE}:peer`, { v: 1 }], ['get', [`shared:${SPACE}:u:${BOB}:peer`]]]);
    expect(kvRendezvous({ puter, space: SPACE, uid: BOB })).toBeNull();
  });
});

describe('live presence', () => {
  it('links two editors and attributes cursors to the invite owner', async () => {
    vi.useFakeTimers();
    try {
      const network = createFakePeerNetwork();
      const store = new Map();
      const members = () => [ALICE, BOB];
      const changes = { alice: 0, bob: 0 };
      const alice = createPresence({ peer: network.peer('alice'), rendezvous: memoryRendezvous(store, ALICE), uid: ALICE, book: BOOK, members, onChange: () => { changes.alice += 1; }, document: null });
      const bob = createPresence({ peer: network.peer('bob'), rendezvous: memoryRendezvous(store, BOB), uid: BOB, book: BOOK, members, onChange: () => { changes.bob += 1; }, document: null });
      expect(alice.available).toBe(true);
      alice.start(); bob.start();
      await flush();
      // Each found the other's invite on its first poll only if it was already published; the next poll links both.
      await vi.advanceTimersByTimeAsync(10_000);
      await flush();
      expect(alice.status).toBe('live');
      expect(alice.links).toBe(2);
      alice.update({ page: PAGE, x: 0.25, y: 0.5, sel: PAGE });
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(bob.peers()).toEqual([expect.objectContaining({ uid: ALICE, page: PAGE, x: 0.25, y: 0.5, sel: PAGE })]);
      expect(changes.bob).toBeGreaterThan(0);

      // Whatever arrives on a link someone else dialed is ignored: a dialer cannot speak for anyone.
      const [aliceServer] = [...network.servers.values()].filter((server) => server.inviteCode.includes('alice'));
      const accepted = [...aliceServer.conns][0];
      accepted.other.send(JSON.stringify({ v: 1, page: PAGE, x: 0.9, y: 0.9 }));
      await flush();
      expect(alice.peers().every((peer) => peer.uid === BOB)).toBe(true);

      // Stopping clears the invite, and the other side lets the peer go once it is stale.
      bob.stop();
      expect(store.has(BOB)).toBe(true);
      await flush();
      expect(store.has(BOB)).toBe(false);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(alice.peers()).toEqual([]);
      alice.stop();
    } finally { vi.useRealTimers(); }
  });

  it('is unavailable without the peer API or a rendezvous', () => {
    expect(createPresence({ peer: null, rendezvous: {}, uid: ALICE, book: BOOK }).available).toBe(false);
    expect(createPresence({ peer: createFakePeerNetwork().peer('a'), rendezvous: null, uid: ALICE, book: BOOK }).available).toBe(false);
  });
});
