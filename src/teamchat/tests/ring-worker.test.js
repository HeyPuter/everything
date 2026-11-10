/**
 * Ring entries on the worker side (worker/ring.js, worker/signal.js): which
 * shards a change's entries reach, what they carry, who can open them, and
 * that every write still lands the plain `s{n}` shard for clients from
 * before ring entries. Also the shared pieces both sides use
 * (src/shared/ring.js, applyOverlayPatch).
 */
import {
  describe, it, expect, afterEach,
} from 'vitest';
import {
  boot, as, USERS, workspaceWith, fakeAuthToken,
} from './helpers/harness.js';
import {
  KEYS, mergeBlock, applyOverlayPatch, threadConvId,
} from '../src/shared/blocks.js';
import {
  EV_SHARDS, EV_RING_SHARDS, RING_SLOTS, evShard, evRingShard,
} from '../src/shared/events.js';
import {
  ringKeysFrom, sealEntry, openEntry, parseTag, threadTag, RING_TAG_LEN,
} from '../src/shared/ring.js';
import { signal } from '../worker/signal.js';
import { ringSecret } from '../worker/ring.js';
import { serverConfig, CONFIG_KEY } from '../worker/lib.js';

// The caller's own background-push keys ride along with every events block (see worker/events.js pushBlock).

const { alice, bob, carol, dave } = USERS;
let rt;

afterEach(() => {
  if (rt) expect(rt.kv._calls.list).toBe(0);
  rt = null;
});

const allRing = () => new Set(Array.from({ length: EV_RING_SHARDS }, (_, n) => n));

/** Every slot of every ring shard, then cleared, so the next write's entries are the only ones there. */
async function takeSlots(wsId) {
  const out = new Map();
  for (let n = 0; n < EV_RING_SHARDS; n++) {
    const list = [];
    for (let k = 0; k < RING_SLOTS; k++) {
      const key = KEYS.evRingSlot(wsId, n, k);
      const v = await rt.kv.get(key);
      if (v) list.push(v);
      await rt.kv.del(key);
    }
    if (list.length) out.set(n, list.sort((a, b) => a.n - b.n));
  }
  return out;
}

async function takePings(wsId) {
  const o = new Set();
  const s = new Set();
  for (let n = 0; n < EV_RING_SHARDS; n++) {
    if (await rt.kv.get(KEYS.evPing(wsId, n))) o.add(n);
    await rt.kv.del(KEYS.evPing(wsId, n));
  }
  for (let n = 0; n < EV_SHARDS; n++) {
    if (await rt.kv.get(KEYS.evShard(wsId, n))) s.add(n);
    await rt.kv.del(KEYS.evShard(wsId, n));
  }
  return { o, s };
}

async function clear(wsId) {
  await takeSlots(wsId);
  await takePings(wsId);
}

/** Open a slot value with a bootstrap's keys: `{ conv, body }`, or null when none of them is its conversation's. */
async function openSlot(value, ek) {
  const p = parseTag(value.g);
  if (!p) return null;
  for (const [conv, root] of Object.entries(ek)) {
    const { tag, aes } = await ringKeysFrom(root);
    if (tag !== p.tag) continue;
    return { conv: p.seq ? threadConvId(conv, p.seq) : conv, body: await openEntry(aes, value.g, value.d) };
  }
  return null;
}

const ringOf = async (user, wsId) => (await as(user).get(`/api/ws/${wsId}`)).data.ring;

describe('shared ring crypto', () => {
  it('seals and opens under the same key and tag, and nothing else', async () => {
    const a = await ringKeysFrom('A'.repeat(43));
    const b = await ringKeysFrom('B'.repeat(43));
    expect(a.tag).toHaveLength(RING_TAG_LEN);
    expect(a.tag).not.toBe(b.tag);
    const d = await sealEntry(a.aes, a.tag, { hello: 'world' });
    expect(await openEntry(a.aes, a.tag, d)).toEqual({ hello: 'world' });
    expect(await openEntry(b.aes, a.tag, d)).toBeNull();
    expect(await openEntry(a.aes, threadTag(a.tag, 3), d)).toBeNull();
    expect(await openEntry(a.aes, a.tag, 'not-base64!!')).toBeNull();
  });

  it('reads tags for a conversation and its threads, and refuses anything else', () => {
    const tag = 'x'.repeat(RING_TAG_LEN);
    expect(parseTag(tag)).toEqual({ tag, seq: null });
    expect(parseTag(threadTag(tag, 42))).toEqual({ tag, seq: 42 });
    expect(parseTag(`${tag}t0`)).toBeNull();
    expect(parseTag(`${tag}q1`)).toBeNull();
    expect(parseTag('short')).toBeNull();
    expect(parseTag(null)).toBeNull();
  });
});

describe('applyOverlayPatch matches mergeBlock', () => {
  const raw = { s: 5, u: 'u1', t: 'hello https://a.test', ts: 1000 };
  const merged = (x) => mergeBlock({ m: [raw], x: { s5: x } })[0] || null;
  const cases = [
    ['an edit', {}, { t: 'edited', e: 2000 }, { t: 'edited', e: 2000 }],
    ['an edit that drops the card', { uf: { url: 'https://a.test', title: 'A' } }, { t: 'edited', e: 2000 }, { t: 'edited', e: 2000, uf: null }],
    ['a reaction put on', { r: { thumbsup: { u2: 1 } } }, { r: { thumbsup: { u2: 1, u3: 1 } } }, { r: 'thumbsup', ru: 'u3', on: 1 }],
    ['the last reaction taken off', { r: { thumbsup: { u2: 1 } } }, { r: { thumbsup: {} } }, { r: 'thumbsup', ru: 'u2', on: 0 }],
    ['a reply', { rc: 1, rt: 1500 }, { rc: 2, rt: 1800, f: { u4: 1 } }, { rc: 2, rt: 1800, f: ['u4'] }],
    ['a pin', {}, { p: 1 }, { p: 1 }],
    ['an unpin', { p: 1 }, {}, { p: 0 }],
    ['a card', {}, { uf: { url: 'https://a.test', title: 'A' } }, { uf: { url: 'https://a.test', title: 'A' } }],
    ['a card taken down', { uf: { url: 'https://a.test', title: 'A' } }, { uf: { off: 1 } }, { uf: null }],
    ['a deletion with no replies', {}, { d: 1 }, { d: 1 }],
    ['a deletion over replies', { rc: 2, rt: 1500 }, { rc: 2, rt: 1500, d: 1 }, { d: 1 }],
  ];
  for (const [name, before, after, patch] of cases) {
    it(name, () => {
      const out = applyOverlayPatch(merged(before), patch);
      expect(out).toEqual(merged(after));
      // Applying it again changes nothing (a poll that already brought it, a duplicate delivery).
      expect(out ? applyOverlayPatch(out, patch) : null).toEqual(out);
    });
  }

  it('keeps a newer edit over an older one, and a larger count over a smaller one', () => {
    const now = applyOverlayPatch(merged({ t: 'new', e: 3000, rc: 4, rt: 2000 }), { t: 'old', e: 2000, rc: 3, rt: 1500 });
    expect(now.text).toBe('new');
    expect(now.replyCount).toBe(4);
    expect(now.lastReplyAt).toBe(2000);
  });
});

describe('the secret', () => {
  it('an isolate whose cached config predates it reads it afresh rather than writing a second', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    expect((await serverConfig()).evs).toBeUndefined();
    // Another isolate made it since, and its claim has long lapsed.
    await rt.kv.update(CONFIG_KEY, { evs: 'made-elsewhere' });
    expect(await ringSecret()).toBe('made-elsewhere');
    expect((await rt.kv.get(CONFIG_KEY)).evs).toBe('made-elsewhere');
  });
});

describe('the bootstrap ring block', () => {
  it('is absent on a worker nothing can watch, and so are ring writes', async () => {
    rt = await boot();
    const { wsId, general } = await workspaceWith(alice, [bob]);
    const boot0 = (await as(alice).get(`/api/ws/${wsId}`)).data;
    expect(boot0.ring).toBeUndefined();
    expect(boot0.events).toBeUndefined();
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hi' });
    expect((await takeSlots(wsId)).size).toBe(0);
    expect(await rt.kv.get(KEYS.evCounter(wsId))).toBeNull();
    expect((await as(alice).get(`/api/ws/${wsId}/sync?since=0`)).data.rn).toBeUndefined();
  });

  it('names the shard, the keys to watch in own mode, and leaves the events block as it was', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob]);
    const own = (await as(alice).get(`/api/ws/${wsId}`)).data;
    expect(own.events).toEqual({ mode: 'own', appUid: expect.any(String), key: KEYS.evShard(wsId, evShard(alice.uuid)), shards: EV_SHARDS, shard: evShard(alice.uuid) });
    expect(own.ring).toMatchObject({ rs: evRingShard(alice.uuid), ke: 0, okey: KEYS.evPing(wsId, evRingShard(alice.uuid)), rkey: KEYS.evRingPrefix(wsId, evRingShard(alice.uuid)) });
    const member = (await as(bob).get(`/api/ws/${wsId}`)).data;
    expect(member.events).toEqual({ mode: 'handle', handle: expect.stringMatching(/^kvh-/), shards: EV_SHARDS, shard: evShard(bob.uuid) });
    expect(member.ring.rs).toBe(evRingShard(bob.uuid));
    expect(member.ring.okey).toBeUndefined();
    expect(member.ring.rkey).toBeUndefined();
  });

  it('carries keys for what the caller can read and nothing else', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob, carol]);
    const secret = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'secret', private: true })).data.channel.id;
    await as(alice).post(`/api/ws/${wsId}/channels/${secret}/members`, { uuids: [bob.uuid] });
    const design = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'design' })).data.channel.id;
    const dm = (await as(alice).post(`/api/ws/${wsId}/dms`, { members: [bob.uuid] })).data.conv;
    const inv = await as(alice).post(`/api/ws/${wsId}/channels/${design}/invites`, {});
    expect((await as(dave).post('/api/join', { code: inv.data.code })).data.guest).toBe(true);
    const keys = async (u) => Object.keys((await ringOf(u, wsId)).ek).sort();
    expect(await keys(bob)).toEqual([general.id, secret, design, dm].sort());
    expect(await keys(carol)).toEqual([general.id, design].sort());
    expect(await keys(dave)).toEqual([design]);
    // One conversation has one key, whoever is handed it.
    expect((await ringOf(bob, wsId)).ek[general.id]).toBe((await ringOf(carol, wsId)).ek[general.id]);
  });
});

describe('what a change writes', () => {
  it('a message in a public channel: an entry on every ring shard, the plain shards too, and no ping', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    const ring = await ringOf(bob, wsId);
    await clear(wsId);
    const res = await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hi all' });
    const slots = await takeSlots(wsId);
    expect(new Set(slots.keys())).toEqual(allRing());
    const { o, s } = await takePings(wsId);
    expect(o.size).toBe(0);
    expect(s).toEqual(new Set(Array.from({ length: EV_SHARDS }, (_, n) => n)));
    const mine = slots.get(ring.rs);
    expect(mine).toHaveLength(1);
    expect(mine[0].n).toBe(ring.rn + 1);
    const opened = await openSlot(mine[0], ring.ek);
    expect(opened.conv).toBe(general.id);
    expect(opened.body.a).toMatchObject({ s: res.data.message.seq, u: alice.uuid });
    expect(mergeBlock({ m: [opened.body.m] })[0]).toMatchObject({ seq: res.data.message.seq, text: 'hi all', user: alice.uuid });
    // Numbered on from the shard's own counter, which the next poll reports.
    expect((await as(bob).get(`/api/ws/${wsId}/sync?since=0`)).data.rn).toBe(mine[0].n);
  });

  it('a message in a private channel reaches only its members\' ring shards, and cannot be opened without its key', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    const secret = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'secret', private: true })).data.channel.id;
    await as(alice).post(`/api/ws/${wsId}/channels/${secret}/members`, { uuids: [bob.uuid] });
    await clear(wsId);
    await as(alice).post(`/api/ws/${wsId}/conv/${secret}/messages`, { text: 'psst' });
    const slots = await takeSlots(wsId);
    expect(new Set(slots.keys())).toEqual(new Set([evRingShard(alice.uuid), evRingShard(bob.uuid)]));
    const entry = slots.get(evRingShard(bob.uuid))[0];
    expect((await openSlot(entry, (await ringOf(bob, wsId)).ek)).body.m.t).toBe('psst');
    expect(await openSlot(entry, (await ringOf(carol, wsId)).ek)).toBeNull();
    expect(JSON.stringify(entry)).not.toContain('psst');
  });

  it('a mention still pings the shard of whoever it counted for, whose own document moved', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob, carol]);
    await clear(wsId);
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hey @bob' });
    expect((await takePings(wsId)).o).toEqual(new Set([evRingShard(bob.uuid)]));
  });

  it('a change no entry describes pings every shard of its audience, with no entries', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob]);
    await clear(wsId);
    expect((await as(alice).put(`/api/ws/${wsId}`, { name: 'Renamed' })).ok).toBe(true);
    expect((await takePings(wsId)).o).toEqual(allRing());
    expect((await takeSlots(wsId)).size).toBe(0);
  });

  it('a change its caller could not describe goes out as a plain signal, entries and all', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    await clear(wsId);
    await signal(wsId, null, { entries: [{ conv: general.id, body: { a: { x: 1 } } }, null] });
    expect((await takeSlots(wsId)).size).toBe(0);
    expect((await takePings(wsId)).o).toEqual(allRing());
  });

  it('edits, reactions, pins, cards and deletions carry the patch a window needs, matching a fresh read', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    const ring = await ringOf(bob, wsId);
    const base = `/api/ws/${wsId}/conv/${general.id}`;
    const seq = (await as(alice).post(`${base}/messages`, { text: 'first' })).data.message.seq;
    const read = async () => (await as(bob).get(`${base}/messages?from=${seq}&to=${seq}`)).data.messages[0] || null;
    const steps = [
      () => as(alice).put(`${base}/messages/${seq}`, { text: 'second' }),
      () => as(bob).post(`${base}/messages/${seq}/reactions`, { reaction: 'thumbsup' }),
      () => as(alice).post(`${base}/messages/${seq}/reactions`, { reaction: 'thumbsup' }),
      () => as(bob).post(`${base}/messages/${seq}/reactions`, { reaction: 'thumbsup' }),
      () => as(alice).post(`${base}/pins`, { seq }),
      () => as(alice).del(`${base}/pins/${seq}`),
      () => as(alice).del(`${base}/messages/${seq}`),
    ];
    let shown = await read();
    for (const step of steps) {
      await clear(wsId);
      expect((await step()).ok).toBe(true);
      const mine = (await takeSlots(wsId)).get(ring.rs) || [];
      const opened = [];
      for (const v of mine) opened.push(await openSlot(v, ring.ek));
      const patches = opened.filter((x) => x?.conv === general.id && x.body.p);
      expect(patches).toHaveLength(1);
      expect(patches[0].body.s).toBe(seq);
      shown = applyOverlayPatch(shown, patches[0].body.p);
      expect(shown).toEqual(await read());
    }
    expect(shown).toBeNull();
  });

  it('a reply carries itself under the thread\'s tag and the root\'s new count under its channel\'s', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    const ring = await ringOf(bob, wsId);
    const root = (await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'root' })).data.message.seq;
    await clear(wsId);
    const thread = threadConvId(general.id, root);
    await as(bob).post(`/api/ws/${wsId}/conv/${thread}/messages`, { text: 'a reply' });
    const mine = (await takeSlots(wsId)).get(ring.rs);
    const opened = await Promise.all(mine.map((v) => openSlot(v, ring.ek)));
    expect(opened.map((x) => x.conv)).toEqual([thread, general.id]);
    expect(opened[0].body.m.t).toBe('a reply');
    expect(opened[1].body).toMatchObject({ s: root, p: { rc: 1, f: [bob.uuid] } });
    expect(mine.map((v) => v.n)).toEqual([mine[0].n, mine[0].n + 1]);
  });

  it('typing names who started, and wakes no poll', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    const ring = await ringOf(bob, wsId);
    await clear(wsId);
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/typing`, {});
    const opened = await openSlot((await takeSlots(wsId)).get(ring.rs)[0], ring.ek);
    expect(opened.body.ty).toMatchObject({ u: alice.uuid, at: expect.any(Number) });
    expect((await takePings(wsId)).o.size).toBe(0);
  });
});

describe('replacing keys', () => {
  it('a private channel\'s key follows its member list', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    const secret = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'secret', private: true })).data.channel.id;
    const before = (await ringOf(alice, wsId)).ek[secret];
    await as(alice).post(`/api/ws/${wsId}/channels/${secret}/members`, { uuids: [bob.uuid] });
    const added = (await ringOf(alice, wsId)).ek[secret];
    expect(added).not.toBe(before);
    expect((await as(bob).post(`/api/ws/${wsId}/channels/${secret}/leave`)).ok).toBe(true);
    const left = (await ringOf(alice, wsId)).ek[secret];
    expect(left).not.toBe(added);
    // Entries written after the leave do not open under the key bob was last handed.
    await clear(wsId);
    await as(alice).post(`/api/ws/${wsId}/conv/${secret}/messages`, { text: 'after bob' });
    const entry = (await takeSlots(wsId)).get(evRingShard(alice.uuid))[0];
    expect(await openSlot(entry, { [secret]: added })).toBeNull();
    expect((await openSlot(entry, { [secret]: left })).body.m.t).toBe('after bob');
  });

  it('removing a member replaces every key, and entries say which epoch sealed them', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob, carol]);
    const before = await ringOf(alice, wsId);
    expect((await as(alice).del(`/api/ws/${wsId}/members/${carol.uuid}`)).ok).toBe(true);
    const after = await ringOf(alice, wsId);
    expect(after.ke).toBe(before.ke + 1);
    expect(after.ek[general.id]).not.toBe(before.ek[general.id]);
    await clear(wsId);
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'after carol' });
    const entry = (await takeSlots(wsId)).get(after.rs)[0];
    expect(entry.e).toBe(after.ke);
    expect(await openSlot(entry, before.ek)).toBeNull();
  });

  it('a guest leaving a public channel replaces its key; a member leaving one does not', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob]);
    const design = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'design' })).data.channel.id;
    const other = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'other' })).data.channel.id;
    const inv = await as(alice).post(`/api/ws/${wsId}/channels/${design}/invites`, {});
    await as(dave).post('/api/join', { code: inv.data.code });
    await as(alice).post(`/api/ws/${wsId}/channels/${other}/members`, { uuids: [dave.uuid] });
    await as(bob).post(`/api/ws/${wsId}/channels/${design}/join`, {});
    const ke = async () => (await ringOf(alice, wsId)).ke;
    const k0 = await ke();
    expect((await as(bob).post(`/api/ws/${wsId}/channels/${design}/leave`)).ok).toBe(true);
    expect(await ke()).toBe(k0);
    expect((await as(dave).post(`/api/ws/${wsId}/channels/${design}/leave`)).ok).toBe(true);
    expect(await ke()).toBe(k0 + 1);
    expect(Object.keys((await ringOf(dave, wsId)).ek)).toEqual([other]);
  });

  it('a member made a guest replaces every key', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob]);
    const k0 = (await ringOf(alice, wsId)).ke;
    expect((await as(alice).post(`/api/ws/${wsId}/members/${bob.uuid}/role`, { role: 'guest' })).ok).toBe(true);
    expect((await ringOf(alice, wsId)).ke).toBe(k0 + 1);
  });
});

describe('deleting a workspace', () => {
  it('takes the ring\'s keys with it', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hi' });
    await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'design' });
    expect((await as(alice).del(`/api/ws/${wsId}`)).ok).toBe(true);
    const left = [...rt.kv._map().keys()].filter((k) => k.startsWith(`tc:ws:${wsId}:ev`));
    expect(left).toEqual([]);
  });
});
