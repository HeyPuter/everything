/**
 * Ring entries on the client (src/lib/store.js, "ring entries"): which
 * subscriptions a holder takes with and without keys, and, against the real
 * worker on the in-memory runtime, that a change delivered as an entry lands
 * in the window, the activity and the typing state without the requests a
 * poll would make, while anything the entries cannot carry still polls.
 *
 * Puter Events is faked at `puter.events.onLocal`; a test delivers to the
 * ring shard exactly the slot values the worker wrote.
 */
import {
  describe, it, expect, beforeAll, beforeEach, afterEach, vi,
} from 'vitest';
import { store, RING_GRACE_MS } from '../src/lib/store.js';
import { KEYS } from '../src/shared/blocks.js';
import { EV_SHARDS, RING_SLOTS, evRingShard } from '../src/shared/events.js';
import { ringKeysFrom, sealEntry } from '../src/shared/ring.js';
import {
  boot as bootRuntime, as, USERS, workspaceWith, fakeAuthToken,
} from './helpers/harness.js';

const { alice, bob, carol } = USERS;
const APP = 'app-4b1d9c20-7e3a-4f56-9a08-2c6d5e1f8b34';
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await tick();
}

function fakeEvents() {
  const subs = [];
  const refuse = new Map();
  return {
    subs,
    refuse(subject, err) { refuse.set(subject, err); },
    onLocal: async (subject, handler, opts = {}) => {
      if (refuse.has(subject)) throw refuse.get(subject);
      const sub = { subject, handler, onError: opts.onError, opts, offCalls: 0, off() { sub.offCalls++; } };
      subs.push(sub);
      return sub;
    },
    live() { return subs.filter((s) => !s.offCalls); },
    deliver(subject, event) { for (const s of subs) if (s.subject === subject && !s.offCalls) s.handler({ event }); },
  };
}

let ev;
let calls;
let scheduled;

function resetStore() {
  store.stopPolling();
  clearTimeout(store.ev.retryTimer);
  Object.assign(store.ev, {
    state: 'off', sub: null, rsub: null, desc: null, lastDesc: null, retryIdx: 0, retryTimer: null, retryUntil: 0, retryDesc: null,
    degradedUntil: 0, misses: 0, reminted: null, ring: null, lastN: null, pending: new Map(), applied: new Set(), chain: Promise.resolve(),
    sig: undefined, retrySig: undefined, noRingUntil: 0, staleAt: 0,
  });
  clearTimeout(store._timer);
  store._timer = null;
  store.wsId = null;
  store.ws = null;
  store.me = null;
  store.profile = null;
  store.links = new Map();
  store.convs.clear();
  store.act = { c: {}, p: {}, w: 0, u: 0 };
  store._typing = { at: 0, byConv: {} };
  store._evNoValues = false;
  store.openConv = null;
  store.openThread = null;
  delete globalThis.puter;
  delete globalThis.document;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetStore();
});

describe('which subscriptions a holder takes', () => {
  const WS = 'abc123def0';
  const REF = `${WS}@teamchat-test`;
  const desc = { mode: 'handle', handle: 'kvh-me', shards: EV_SHARDS, shard: 2 };
  const ring = { rs: 5, rn: 0, ke: 0, ek: { c1: 'A'.repeat(43) } };

  beforeEach(() => {
    ev = fakeEvents();
    globalThis.document = { hidden: false };
    globalThis.puter = { appID: APP, events: ev, workers: { exec: async () => new Response('{}', { status: 404 }) } };
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', prefs: {} };
    store._timer = setTimeout(() => {}, 999_000);
    vi.spyOn(store, '_schedule').mockImplementation(() => {});
  });

  it('without keys, the plain shard alone, exactly as before', async () => {
    store._evSetOwn(REF, desc, null);
    await settle();
    expect(ev.live().map((s) => s.subject)).toEqual(['kv:kvh-me:s2']);
    expect(store.ev.state).toBe('on');
  });

  it('with keys, the ring shard and its ping, both with values, and not the plain shard', async () => {
    store._evSetOwn(REF, desc, ring);
    await settle();
    expect(ev.live().map((s) => s.subject).sort()).toEqual(['kv:kvh-me:o5', 'kv:kvh-me:r5:*']);
    expect(ev.live().every((s) => s.opts.includeValue === true)).toBe(true);
    expect(store.ev.state).toBe('on');
  });

  it('in own mode, the keys the bootstrap named', async () => {
    store._evSetOwn(REF, { mode: 'own', appUid: APP, key: `tc:ws:${WS}:ev:s1`, shards: EV_SHARDS, shard: 1 }, { ...ring, okey: `tc:ws:${WS}:ev:o5`, rkey: `tc:ws:${WS}:ev:r5:` });
    await settle();
    expect(ev.live().map((s) => s.subject).sort()).toEqual([`kv:${APP}:tc:ws:${WS}:ev:o5`, `kv:${APP}:tc:ws:${WS}:ev:r5:*`]);
  });

  it('a ring shard refused while its ping was taken drops back to the plain shard', async () => {
    ev.refuse('kv:kvh-me:r5:*', Object.assign(new Error('nope'), { code: 'invalid_kv_pattern' }));
    store._evSetOwn(REF, desc, ring);
    await settle();
    expect(ev.live().map((s) => s.subject)).toEqual(['kv:kvh-me:s2']);
    expect(ev.subs.find((s) => s.subject === 'kv:kvh-me:o5').offCalls).toBe(1);
  });

  it('a ring shard that ends takes its ping down with it, and both come back together', async () => {
    store._evSetOwn(REF, desc, ring);
    await settle();
    const shard = ev.live().find((s) => s.subject === 'kv:kvh-me:r5:*');
    // After onError the SDK has ended that subscription itself; its ping is taken down here.
    shard.onError({ code: 'events_connection_failed' });
    expect(ev.subs.find((s) => s.subject === 'kv:kvh-me:o5').offCalls).toBe(1);
    expect(store.ev.sub).toBeNull();
    expect(store.ev.rsub).toBeNull();
    expect(store.ev.state).toBe('off');
    expect(store.ev.retryUntil).toBeGreaterThan(Date.now());
    // The wait over (cut short here), both are taken again.
    store._evArmRetry(store.ev, REF, 0);
    await tick(5);
    await settle();
    expect(ev.subs.map((s) => s.subject)).toEqual(['kv:kvh-me:o5', 'kv:kvh-me:r5:*', 'kv:kvh-me:o5', 'kv:kvh-me:r5:*']);
    expect(store.ev.state).toBe('on');
  });

  it('a shared channel\'s host: its entries land under the local id, with no request', async () => {
    const HOST = 'hostws0001@teamchat-test';
    const requests = [];
    globalThis.puter.workers.exec = async (url) => { requests.push(url); return new Response('{}', { status: 404 }); };
    store.ws = { id: WS, name: 'Acme', channels: { lc1: { id: 'lc1', name: 'shared', shared: { ref: HOST, ch: 'hc1' } } }, members: { 'u-me': {} } };
    store.me = { dms: {}, channels: ['lc1'], reads: {}, mentions: {}, threads: {}, notify: {} };
    store.act = { c: { lc1: { s: 1, t: 1 } }, p: {}, w: 0, u: 0 };
    const link = { ref: HOST, convs: new Map([['hc1', 'lc1']]), loaded: true, loading: null, me: { role: 'member' }, ws: { members: { 'u-ann': {} } } };
    store.links.set(HOST, link);
    const c = store.conv('lc1');
    Object.assign(c, { loaded: true, hasNewer: false, seq: 1, xSeen: 0, messages: [{ seq: 1, user: 'u-ann', text: 'one', ts: 1, kind: 'msg', attachments: [], mentions: [], reactions: {}, replyCount: 0 }] });
    const root = 'H'.repeat(43);
    store._evSetLink(link, REF, { mode: 'handle', handle: 'kvh-host', shards: EV_SHARDS, shard: 0 }, { rs: 3, rn: 0, ke: 0, ek: { hc1: root } });
    await settle();
    await link.ev.ring.ready;
    expect(ev.live().map((s) => s.subject).sort()).toEqual(['kv:kvh-host:o3', 'kv:kvh-host:r3:*']);
    const { tag, aes } = await ringKeysFrom(root);
    const t = Date.now();
    const d = await sealEntry(aes, tag, { a: { s: 2, t, u: 'u-ann' }, m: { s: 2, u: 'u-ann', t: 'from the host', ts: t } });
    ev.deliver('kv:kvh-host:r3:*', { op: 'set', key: 'r3:k1', value: { n: 1, g: tag, d, e: 0 } });
    await settle();
    await link.ev.chain;
    expect(c.messages.map((m) => m.text)).toEqual(['one', 'from the host']);
    expect(store.act.c.lc1.s).toBe(2);
    expect(requests).toEqual([]);
  });

  it('keys handed again unchanged change nothing; a bootstrap without them goes back to the plain shard', async () => {
    store._evSetOwn(REF, desc, ring);
    await settle();
    const before = ev.subs.length;
    store._evSetOwn(REF, desc, { ...ring });
    store._evSetOwn(REF, desc, undefined); // an answer that does not carry keys (the re-mint's) keeps them
    await settle();
    expect(ev.subs.length).toBe(before);
    store._evSetOwn(REF, desc, null);
    await settle();
    expect(ev.live().map((s) => s.subject)).toEqual(['kv:kvh-me:s2']);
  });
});

describe('entries from the real worker', () => {
  let runtime;
  let wsId;
  let general;
  let ref;
  let shard; // bob's ring shard subscription subject
  let ping; // and its ping's

  beforeAll(async () => {
    runtime = await bootRuntime({ authToken: fakeAuthToken() });
    ({ wsId, general } = await workspaceWith(alice, [bob, carol]));
    ref = `${wsId}@teamchat-api`;
  });

  /** Every slot on bob's ring shard written since the last call, oldest first, as deliveries. */
  let seen = 0;
  async function newSlots() {
    const rs = evRingShard(bob.uuid);
    const out = [];
    for (let k = 0; k < RING_SLOTS; k++) {
      const value = await runtime.kv.get(KEYS.evRingSlot(wsId, rs, k));
      if (value && value.n > seen) out.push({ op: 'set', key: `r${rs}:k${k}`, value });
    }
    out.sort((a, b) => a.value.n - b.value.n);
    if (out.length) seen = out[out.length - 1].value.n;
    return out;
  }

  async function deliver(events) {
    for (const e of events) ev.deliver(shard, e);
    await settle();
    await store.ev.chain;
    await settle();
  }

  beforeEach(async () => {
    ev = fakeEvents();
    calls = [];
    scheduled = [];
    globalThis.document = { hidden: false };
    globalThis.puter = {
      appID: APP,
      events: ev,
      workers: {
        exec: (url, init = {}) => {
          const u = new URL(url);
          calls.push(`${init.method || 'GET'} ${u.pathname}${u.search}`);
          return runtime.dispatch(url, init, bob);
        },
      },
    };
    const doc = (await as(bob).get(`/api/ws/${wsId}`)).data;
    expect(doc.ring).toBeTruthy();
    store.wsId = ref;
    store.profile = { uuid: bob.uuid, username: 'bob', name: 'Bob', prefs: {} };
    store.ws = doc.workspace;
    store.me = doc.me;
    store.act = { c: { ...(doc.activity.c || {}) }, p: {}, ps: {}, w: doc.activity.w || 0, u: doc.activity.u?.[bob.uuid] || 0 };
    store.convs.clear();
    store._typing = { at: 0, byConv: {} };
    store.ev.lastN = null;
    store.ev.ring = null;
    store._timer = setTimeout(() => {}, 999_000);
    vi.spyOn(store, '_schedule').mockImplementation((ms, reason) => { scheduled.push(reason); });
    store._evSetOwn(ref, doc.events, doc.ring);
    await settle();
    await store.ev.ring.ready;
    shard = `kv:${doc.events.handle}:r${doc.ring.rs}:*`;
    ping = `kv:${doc.events.handle}:o${doc.ring.rs}`;
    expect(ev.live().map((s) => s.subject)).toContain(shard);
    seen = doc.ring.rn;
    await store.loadConversation(general.id);
    // The poll subscribing asks for (see _ringArm), as the app would make it.
    expect(scheduled).toContain('signal');
    store._lastHeartbeat = Date.now();
    await store.poll();
    calls.length = 0;
    scheduled.length = 0;
  });

  it('a message lands in the open window and the sidebar with no request at all', async () => {
    const incoming = [];
    const off = store.on('incoming', (list) => incoming.push(...list));
    const seq = (await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hello bob' })).data.message.seq;
    await deliver(await newSlots());
    off();
    const w = store.convs.get(general.id);
    expect(w.messages.at(-1)).toMatchObject({ seq, text: 'hello bob', user: alice.uuid });
    expect(store.act.c[general.id].s).toBe(seq);
    expect(incoming).toEqual([{ conv: general.id, from: alice.uuid, seq }]);
    expect(calls).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  it('an edit, a reaction and a deletion change the window in place, with no re-read', async () => {
    const base = `/api/ws/${wsId}/conv/${general.id}`;
    const seq = (await as(alice).post(`${base}/messages`, { text: 'v1' })).data.message.seq;
    await deliver(await newSlots());
    await as(alice).put(`${base}/messages/${seq}`, { text: 'v2' });
    await as(carol).post(`${base}/messages/${seq}/reactions`, { reaction: 'thumbsup' });
    await deliver(await newSlots());
    const held = () => store.convs.get(general.id).messages.find((m) => m.seq === seq);
    expect(held()).toMatchObject({ text: 'v2', reactions: { thumbsup: { [carol.uuid]: 1 } } });
    expect(held().editedAt).toBeTruthy();
    expect(store.convs.get(general.id).xSeen).toBe(store.act.c[general.id].x);
    await as(alice).del(`${base}/messages/${seq}`);
    await deliver(await newSlots());
    expect(held()).toBeUndefined();
    expect(calls).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  it('after a ping no poll has answered yet, a patch is laid in but the window is still re-read', async () => {
    const base = `/api/ws/${wsId}/conv/${general.id}`;
    const seq = (await as(alice).post(`${base}/messages`, { text: 'v1' })).data.message.seq;
    await deliver(await newSlots());
    expect(calls).toEqual([]);
    // Something entries did not carry (a change that could not be sealed, say) pinged instead.
    ev.deliver(ping, { op: 'set', key: `o${store.ev.ring.rs}`, value: { t: Date.now() + 60_000 } });
    expect(scheduled).toEqual(['signal']);
    await as(carol).post(`${base}/messages/${seq}/reactions`, { reaction: 'thumbsup' });
    await deliver(await newSlots());
    expect(store.convs.get(general.id).messages.find((m) => m.seq === seq).reactions).toEqual({ thumbsup: { [carol.uuid]: 1 } });
    await until(() => calls.some((c) => c.startsWith(`GET /api/ws/${wsId}/conv/${general.id}/messages?from=`)));
  });

  it('typing shows at once, and goes when the message it was for arrives', async () => {
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/typing`, {});
    await deliver(await newSlots());
    expect(store.typingIn(general.id)).toEqual([alice.uuid]);
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'done typing' });
    await deliver(await newSlots());
    expect(store.typingIn(general.id)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('an entry that arrives ahead of a missing one waits a moment, then a poll fills the gap', async () => {
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'one' });
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'two' });
    const [first, second] = await newSlots();
    await deliver([second]);
    expect(scheduled).toEqual([]);
    // The missing one arriving in time is applied in order, and nothing polls.
    await deliver([first]);
    expect(store.convs.get(general.id).messages.slice(-2).map((m) => m.text)).toEqual(['one', 'two']);
    expect(scheduled).toEqual([]);
    // One that never comes: the poll fills it.
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'three' });
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'four' });
    const [, fourth] = await newSlots();
    await deliver([fourth]);
    await tick(RING_GRACE_MS + 50);
    expect(scheduled).toEqual(['signal']);
    expect(store.ev.lastN).toBe(fourth.value.n);
  });

  it('a poll\'s count passes over entries still waiting, which are laid in all the same', async () => {
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'five' });
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'six' });
    const [fifth, sixth] = await newSlots();
    await deliver([sixth]);
    expect(store.ev.pending.size).toBe(1);
    store._lastHeartbeat = Date.now();
    await store.poll();
    await store.ev.chain;
    await settle();
    expect(store.ev.lastN).toBe(sixth.value.n);
    expect(store.ev.pending.size).toBe(0);
    expect(store.convs.get(general.id).messages.slice(-2).map((m) => m.text)).toEqual(['five', 'six']);
    // The one that was missing, arriving late, changes nothing and asks for nothing.
    calls.length = 0;
    scheduled.length = 0;
    await deliver([fifth]);
    expect(store.convs.get(general.id).messages.slice(-2).map((m) => m.text)).toEqual(['five', 'six']);
    expect(calls).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  it('a document re-read does not move the count on past entries still waiting', async () => {
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'seven' });
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'eight' });
    const [, eighth] = await newSlots();
    const before = store.ev.lastN;
    await deliver([eighth]);
    await store.refreshWorkspace();
    expect(store.ev.lastN).toBe(before);
    expect(store.ev.pending.size).toBe(1);
    // The wait runs out and a poll fills the gap, as without the re-read.
    await tick(RING_GRACE_MS + 50);
    expect(scheduled).toContain('signal');
  });

  it('a document re-read with the same keys changes nothing: no poll, and patches still vouch for the window', async () => {
    const scope = store.ev.ring;
    await store.refreshWorkspace();
    await settle();
    expect(store.ev.ring).toBe(scope);
    expect(scheduled).toEqual([]);
    const base = `/api/ws/${wsId}/conv/${general.id}`;
    const seq = (await as(alice).post(`${base}/messages`, { text: 'still vouched' })).data.message.seq;
    await as(carol).post(`${base}/messages/${seq}/reactions`, { reaction: 'tada' });
    calls.length = 0;
    await deliver(await newSlots());
    expect(store.convs.get(general.id).xSeen).toBe(store.act.c[general.id].x);
    expect(calls).toEqual([]);
  });

  it('a reaction put on, arriving after it was taken off, does not put it back', async () => {
    const base = `/api/ws/${wsId}/conv/${general.id}`;
    const seq = (await as(alice).post(`${base}/messages`, { text: 'react to me' })).data.message.seq;
    await deliver(await newSlots());
    await as(carol).post(`${base}/messages/${seq}/reactions`, { reaction: 'heart', on: true });
    await as(carol).post(`${base}/messages/${seq}/reactions`, { reaction: 'heart', on: false });
    const [on, off] = await newSlots();
    await deliver([off]);
    await tick(RING_GRACE_MS + 50);
    await store.ev.chain;
    await deliver([on]);
    expect(store.convs.get(general.id).messages.find((m) => m.seq === seq).reactions).toEqual({});
  });

  it('an entry sealed with the keys just replaced is still read', async () => {
    const old = store.ev.ring;
    const base = `/api/ws/${wsId}/conv/${general.id}`;
    await as(alice).post(`${base}/messages`, { text: 'under the old keys' });
    const slots = await newSlots();
    // The keys change before the entry arrives (someone removed, say).
    expect((await as(alice).del(`/api/ws/${wsId}/members/${carol.uuid}`)).ok).toBe(true);
    await store.refreshWorkspace();
    await store.ev.ring.ready;
    expect(store.ev.ring).not.toBe(old);
    seen = Math.max(seen, (await runtime.kv.get(KEYS.evCounter(wsId)))[`s${store.ev.ring.rs}`]);
    await deliver(slots);
    expect(store.convs.get(general.id).messages.at(-1).text).toBe('under the old keys');
    const code = (await as(alice).get(`/api/ws/${wsId}`)).data.workspace.invite;
    await as(carol).post('/api/join', { code });
  });

  it('typing past its freshness goes when someone else starts', async () => {
    store._typing = { at: Date.now(), byConv: { [general.id]: { [carol.uuid]: Date.now() - 60_000 } } };
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/typing`, {});
    await deliver(await newSlots());
    expect(store.typingIn(general.id)).toEqual([alice.uuid]);
  });

  it('a gap marker or a value left out polls; an entry for a conversation bob cannot read changes nothing', async () => {
    ev.deliver(shard, { op: 'gap', reason: 'delivery_rate_limit' });
    expect(scheduled).toEqual(['signal']);
    scheduled.length = 0;
    const n = store.ev.lastN;
    ev.deliver(shard, { op: 'set', key: 'r0:k0' });
    expect(scheduled).toEqual(['signal']);
    scheduled.length = 0;
    const ke = store.ev.ring.ke;
    await deliver([{ op: 'set', key: 'r0:k1', value: { n: n + 1, g: 'z'.repeat(22), d: 'AAAA', e: ke } }]);
    expect(store.ev.lastN).toBe(n + 1);
    expect(scheduled).toEqual([]);
    expect(calls).toEqual([]);
    // One sealed under an epoch this tab has moved past, with no key for it, may be its own: a poll.
    await deliver([{ op: 'set', key: 'r0:k2', value: { n: n + 2, g: 'y'.repeat(22), d: 'AAAA', e: ke - 1 } }]);
    expect(scheduled).toEqual(['signal']);
  });

  it('an entry sealed under newer keys fetches the document, which brings them', async () => {
    expect((await as(alice).del(`/api/ws/${wsId}/members/${carol.uuid}`)).ok).toBe(true);
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'after carol' });
    const slots = await newSlots();
    expect(slots.at(-1).value.e).toBe(store.ev.ring.ke + 1);
    await deliver(slots);
    await until(() => calls.includes(`GET /api/ws/${wsId}`));
    await until(() => store.ev.ring.ke === slots.at(-1).value.e);
    await store.ev.ring.ready;
    await settle();
    expect(scheduled).toContain('signal');
    // Re-joined for the next test's sake.
    const code = (await as(alice).get(`/api/ws/${wsId}`)).data.workspace.invite;
    await as(carol).post('/api/join', { code });
  });
});

async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await tick(10);
  }
}
