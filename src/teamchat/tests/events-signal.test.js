/**
 * Events signalling on the worker side: which shards a write wakes
 * (worker/signal.js, audienceOf/touchConv in worker/index.js), and the
 * handle side (worker/events.js) — minting, caching, backoff, and the
 * bootstrap's `events` block. See
 * docs/systemDesignDocs/teamchatEventsSignaling.md for the design.
 *
 * A signal is gated first on whether anything could possibly be watching
 * (see "signal gating" below): a user-scoped worker (no app uid in its own
 * token — the harness's default, `boot()` with no auth token) can never be
 * watched by anyone, own mode or handle, so writing shard documents on one
 * would be pure cost with nobody to wake. The audience-targeting tests below
 * therefore boot with `fakeAuthToken()`, an app-bound token, so the writes
 * under test actually produce a signal to inspect; only the gating tests
 * themselves, and the handle-minting tests (which already needed it for
 * their own reasons), care about the token's shape directly.
 */
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import {
  boot, as, USERS, workspaceWith, fakeAuthToken,
} from './helpers/harness.js';
import { KEYS } from '../src/shared/blocks.js';
import { EV_SHARDS, evShard, appUidFromToken } from '../src/shared/events.js';
import { LIMITS } from '../src/shared/limits.js';

const { alice, bob, carol } = USERS;
const realFetch = globalThis.fetch;

let rt;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (rt) expect(rt.kv._calls.list).toBe(0);
  rt = null;
});

/** Clear every shard key of a workspace, so the next write's signal is the only thing that can put one back. */
async function resetShards(wsId) {
  for (let n = 0; n < EV_SHARDS; n++) await rt.kv.del(KEYS.evShard(wsId, n));
}

/** Which shards carry a fresh `{ t }` document right now. */
async function writtenShards(wsId) {
  const out = new Set();
  for (let n = 0; n < EV_SHARDS; n++) if (await rt.kv.get(KEYS.evShard(wsId, n))) out.add(n);
  return out;
}

async function expectShards(wsId, uuids) {
  const expected = uuids === null ? new Set(Array.from({ length: EV_SHARDS }, (_, n) => n)) : new Set(uuids.map(evShard));
  expect(await writtenShards(wsId)).toEqual(expected);
}

describe('reading the app uid out of a token', () => {
  // A real v2 token never carries `app_uid` at all: it carries the packed
  // `au` claim (see src/shared/events.js). These pin appUidFromToken against
  // fakeAuthToken's own fixture, and against a few hand-built payloads
  // fakeAuthToken has no reason to ever produce, so a regression to reading
  // `app_uid` alone — which found nothing in any real token and left every
  // worker reading as user-scoped — trips here rather than only in production.
  const seg = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rawToken = (payload) => `${seg({ alg: 'none' })}.${seg(payload)}.`;
  const b64OfBytes = (n) => btoa(String.fromCharCode(...Array.from({ length: n }, (_, i) => i)));

  it('a packed au round-trips through the default claim', () => {
    const uid = 'app-4b1d9c20-7e3a-4f56-9a08-2c6d5e1f8b34';
    expect(appUidFromToken(fakeAuthToken(uid))).toBe(uid);
  });

  it('the legacy app_uid claim still reads', () => {
    const uid = 'app-4b1d9c20-7e3a-4f56-9a08-2c6d5e1f8b34';
    expect(appUidFromToken(fakeAuthToken(uid, { claim: 'app_uid' }))).toBe(uid);
  });

  it('a default fakeAuthToken() actually carries the packed au claim, not app_uid, or nothing here would exercise the real shape', () => {
    const token = fakeAuthToken();
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(typeof payload.au).toBe('string');
    expect(payload.app_uid).toBeUndefined();
  });

  it('a dashed au was never packed and passes through verbatim', () => {
    expect(appUidFromToken(fakeAuthToken('app-teamchat-test'))).toBe('app-teamchat-test');
  });

  it('a dashed au that names no app is refused', () => {
    expect(appUidFromToken(fakeAuthToken('user-not-an-app'))).toBeNull();
  });

  it('an au of the wrong byte length is refused', () => {
    expect(appUidFromToken(rawToken({ au: b64OfBytes(15) }))).toBeNull();
    expect(appUidFromToken(rawToken({ au: b64OfBytes(17) }))).toBeNull();
  });

  it('a payload with neither claim, junk, and no token at all all come back null', () => {
    expect(appUidFromToken(rawToken({ alg: 'none' }))).toBeNull();
    expect(appUidFromToken('not-a-jwt')).toBeNull();
    expect(appUidFromToken('')).toBeNull();
    expect(appUidFromToken(null)).toBeNull();
    expect(appUidFromToken(undefined)).toBeNull();
    expect(appUidFromToken(`${seg({ alg: 'none' })}.not-base64-json.`)).toBeNull();
  });
});

describe('audience: who a write signals', () => {
  // These tests boot with an app-bound token (see the file docstring), so
  // every /api/join a workspaceWith() call makes now also attempts a real
  // handle mint for the joiner (see worker/events.js): stubbed to answer at
  // once, harmlessly, so a member joining costs no real network call.
  // Minting itself is exercised on its own terms in "handles" below.
  beforeEach(() => {
    globalThis.fetch = async () => new Response(JSON.stringify({ handle: 'kvh-audience-test' }), { status: 200 });
  });

  it('a message in a public channel signals every shard', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hi all' })).ok).toBe(true);
    await expectShards(wsId, null);
  });

  it('a message in a private channel signals only its members', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    const priv = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'secret', private: true })).data.channel.id;
    await as(alice).post(`/api/ws/${wsId}/channels/${priv}/members`, { uuids: [bob.uuid] });
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${priv}/messages`, { text: 'psst' })).ok).toBe(true);
    await expectShards(wsId, [alice.uuid, bob.uuid]);
  });

  it('a message in a direct message signals only its participants', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    const dm = (await as(alice).post(`/api/ws/${wsId}/dms`, { members: [bob.uuid] })).data.conv;
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${dm}/messages`, { text: 'hey' })).ok).toBe(true);
    await expectShards(wsId, [alice.uuid, bob.uuid]);
  });

  // The dms route was the one write path that moved a member's `u.*` with
  // nothing to wake them (see the route's own comment): opening a direct
  // message with someone used to leave the other side to find out on the
  // next plain poll, up to 20s later rather than 4.
  it('opening a new direct message wakes the person it names', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/dms`, { members: [bob.uuid] })).ok).toBe(true);
    await expectShards(wsId, [bob.uuid]);
  });

  it('an edit, a reaction, and a pin signal the same shards a post there does', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    const priv = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'secret', private: true })).data.channel.id;
    await as(alice).post(`/api/ws/${wsId}/channels/${priv}/members`, { uuids: [bob.uuid] });
    const msg = (await as(alice).post(`/api/ws/${wsId}/conv/${priv}/messages`, { text: 'first' })).data.message;

    await resetShards(wsId);
    expect((await as(alice).put(`/api/ws/${wsId}/conv/${priv}/messages/${msg.seq}`, { text: 'edited' })).ok).toBe(true);
    await expectShards(wsId, [alice.uuid, bob.uuid]);

    await resetShards(wsId);
    expect((await as(bob).post(`/api/ws/${wsId}/conv/${priv}/messages/${msg.seq}/reactions`, { reaction: 'tada' })).ok).toBe(true);
    await expectShards(wsId, [alice.uuid, bob.uuid]);

    // Pinning also posts a "X pinned a message" system line: every write
    // through writeMessage signals by default (see worker/index.js), and
    // postSystem never narrows it, so this one reaches every shard rather
    // than only touchConv's own [alice, bob] — over-inclusive, and safe.
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${priv}/pins`, { seq: msg.seq })).ok).toBe(true);
    await expectShards(wsId, null);
  });

  it('pokeMember signals exactly one shard', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    // Bob gets a mention badge on #general; every shard is touched by the post itself.
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: `hey @${bob.username}` });
    const latest = (await as(bob).get(`/api/ws/${wsId}/conv/${general.id}/messages`)).data.seq;
    await resetShards(wsId);
    // Reading to the end clears the badge, which pokes bob alone (see the read route).
    expect((await as(bob).post(`/api/ws/${wsId}/conv/${general.id}/read`, { seq: latest })).ok).toBe(true);
    await expectShards(wsId, [bob.uuid]);
  });

  it('a presence heartbeat and the pagehide keepalive signal nothing', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob]);
    await resetShards(wsId);
    expect((await as(alice).get(`/api/ws/${wsId}/sync?since=0&hb=1`)).ok).toBe(true);
    expect(await writtenShards(wsId)).toEqual(new Set());
    expect((await as(alice).del(`/api/ws/${wsId}/presence`)).ok).toBe(true);
    expect(await writtenShards(wsId)).toEqual(new Set());
  });

  it('typing signals on an explicit first write, and on one with no opinion at all, but not on an explicit non-first', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    // An old client sends no `first` at all: treated as "first" (the safe
    // direction), so it signals — an old client and a new worker together
    // signal on every typing write, which the composer's own four-second
    // throttle already bounds (see the design doc, section 9).
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/typing`, {})).ok).toBe(true);
    await expectShards(wsId, null); // #general is public
    // A new client's first write of a burst: signals.
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/typing`, { first: true })).ok).toBe(true);
    await expectShards(wsId, null);
    // A new client's later writes in the same burst: explicitly not first, no signal.
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/typing`, { first: false })).ok).toBe(true);
    expect(await writtenShards(wsId)).toEqual(new Set());
  });

  it('huddle join, leave, and end all signal; a repeat heartbeat from the same seat does not', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);

    await resetShards(wsId);
    const started = await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/huddle`, { invite: 'NJ-ALI0000' });
    expect(started.data.started).toBe(true);
    expect((await writtenShards(wsId)).size).toBeGreaterThan(0);

    await resetShards(wsId);
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/huddle`, { invite: 'NJ-ALI0000' });
    expect(await writtenShards(wsId)).toEqual(new Set()); // a heartbeat from the seat already held

    await resetShards(wsId);
    const joined = await as(bob).post(`/api/ws/${wsId}/conv/${general.id}/huddle`, { invite: 'NJ-BOB0000' });
    expect(joined.ok).toBe(true);
    expect((await writtenShards(wsId)).size).toBeGreaterThan(0);

    await resetShards(wsId);
    const bobLeft = await as(bob).del(`/api/ws/${wsId}/conv/${general.id}/huddle`);
    expect(bobLeft.data.ended).toBe(false);
    expect((await writtenShards(wsId)).size).toBeGreaterThan(0);

    await resetShards(wsId);
    const aliceLeft = await as(alice).del(`/api/ws/${wsId}/conv/${general.id}/huddle`);
    expect(aliceLeft.data.ended).toBe(true);
    expect((await writtenShards(wsId)).size).toBeGreaterThan(0);
  });

  it('deleting a workspace deletes its shard keys', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hi' });
    expect((await writtenShards(wsId)).size).toBeGreaterThan(0);
    expect((await as(alice).del(`/api/ws/${wsId}`)).ok).toBe(true);
    expect(await writtenShards(wsId)).toEqual(new Set());
  });
});

describe('signal ordering: every request that writes c.*/w/u.* ends with a signal covering it', () => {
  // The client's degradation detector (src/lib/store.js, _evMiss) treats a
  // plain safety poll that turns up a c.*/w/u.* change with no delivery in
  // between as evidence the subscription has gone silent. That is only
  // sound if a signal always lands *after* the write it is for, never
  // before it: these assert on the ordered op log (dev/worker-runtime.js),
  // not only on which keys ended up touched, so a signal race — the write
  // this route made landing after the wakeup it caused — would show up.
  beforeEach(() => {
    globalThis.fetch = async () => new Response(JSON.stringify({ handle: 'kvh-order-test' }), { status: 200 });
  });

  /** True when `key` is one of this workspace's signal shard keys. */
  const isShardKey = (key, wsId) => key.startsWith(`tc:ws:${wsId}:ev:s`);
  /**
   * The search index's own keys (`tc:ws:{ws}:idx:…`). A post writes these
   * behind its answer, after the signal (see postMessage's deferred tail),
   * and a woken subscriber never reads them: it re-reads the conversation,
   * the activity document and its own, all of which are written before the
   * signal. They are left out here so the ordering this guards — the signal
   * landing after every write a wakeup makes someone look for — is what is
   * actually measured.
   */
  const isIndexKey = (key, wsId) => key.startsWith(`tc:ws:${wsId}:idx:`);

  /** Run `fn`, then assert the last KV op it made that a woken subscriber could read was a shard write. */
  async function expectLastOpIsSignal(wsId, fn) {
    const before = rt.kv._calls.log.length;
    const res = await fn();
    expect(res.ok).toBe(true);
    const made = rt.kv._calls.log.slice(before).filter((op) => !isIndexKey(op.key, wsId));
    expect(made.length).toBeGreaterThan(0);
    expect(isShardKey(made[made.length - 1].key, wsId)).toBe(true);
    return res;
  }

  it('POST .../messages ends with a shard write', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    await expectLastOpIsSignal(wsId, () => as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hi all' }));
  });

  it('PUT .../messages/:seq (an edit) ends with a shard write', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    const msg = (await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'first' })).data.message;
    await expectLastOpIsSignal(wsId, () => as(alice).put(`/api/ws/${wsId}/conv/${general.id}/messages/${msg.seq}`, { text: 'edited' }));
  });

  it('POST .../reactions ends with a shard write', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    const msg = (await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'first' })).data.message;
    await expectLastOpIsSignal(wsId, () => as(bob).post(`/api/ws/${wsId}/conv/${general.id}/messages/${msg.seq}/reactions`, { reaction: 'tada' }));
  });

  it('POST .../dms ends with a shard write, for a brand-new conversation', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob]);
    await expectLastOpIsSignal(wsId, () => as(alice).post(`/api/ws/${wsId}/dms`, { members: [bob.uuid] }));
  });

  it('POST .../dms ends with a shard write, for a conversation handed to a member who lacked it', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob]);
    const convId = (await as(alice).post(`/api/ws/${wsId}/dms`, { members: [bob.uuid] })).data.conv;
    // The drift the route's own comment describes: bob's own side of the
    // conversation is gone, so posting again finds him lacking it and hands
    // it back to him.
    await rt.kv.remove(KEYS.member(wsId, bob.uuid), `dms.${convId}`);
    await expectLastOpIsSignal(wsId, () => as(alice).post(`/api/ws/${wsId}/dms`, { members: [bob.uuid] }));
  });

  it('POST /api/join ends with a shard write', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, code } = await workspaceWith(alice, []);
    await expectLastOpIsSignal(wsId, () => as(bob).post('/api/join', { code }));
  });

  it('POST /api/ws/:ws/channels ends with a shard write', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId } = await workspaceWith(alice, [bob]);
    await expectLastOpIsSignal(wsId, () => as(alice).post(`/api/ws/${wsId}/channels`, { name: 'ops' }));
  });
});

describe('handles: minting, caching, backoff, and the bootstrap block', () => {
  // workspaceWith's own joins run before a test gets to stub fetch, so a
  // scenario that cares which mint answer a particular join or bootstrap
  // sees creates the workspace bare (no auto-joined members) and joins each
  // member by hand once the stub for that member is in place.

  it('own mode for the owner, handle mode for a member, omitted while unavailable', async () => {
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    const { wsId, code } = await workspaceWith(alice, []);

    const ownerBoot = await as(alice).get(`/api/ws/${wsId}`);
    expect(ownerBoot.data.events).toEqual({
      mode: 'own', appUid: 'app-teamchat-test', key: KEYS.evShard(wsId, evShard(alice.uuid)), shards: EV_SHARDS, shard: evShard(alice.uuid),
    });

    globalThis.fetch = async () => new Response(JSON.stringify({ handle: 'kvh-bob' }), { status: 200 });
    await as(bob).post('/api/join', { code });
    const memberBoot = await as(bob).get(`/api/ws/${wsId}`);
    expect(memberBoot.data.events).toEqual({ mode: 'handle', handle: 'kvh-bob', shards: EV_SHARDS, shard: evShard(bob.uuid) });

    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'events_kv_handle_not_delegated' }), { status: 403 });
    await as(carol).post('/api/join', { code });
    const carolBoot = await as(carol).get(`/api/ws/${wsId}`);
    expect(carolBoot.data.events).toBeUndefined();
  });

  it('own mode keys on the worker account, not on whoever created the workspace (a shared worker)', async () => {
    // The worker's account is alice (the harness default owner); tc:config.open
    // lets bob create a workspace of his own on it (see README, "Optional: one
    // shared worker"). bob is that workspace's owner, but the KV namespace
    // `own` mode subscribes to is alice's, not his — he must never be handed
    // a subject pointing at his own empty namespace.
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    expect((await as(alice).put('/api/server', { open: true })).ok).toBe(true);
    const created = await as(bob).post('/api/workspaces', { name: "Bob's" });
    expect(created.ok).toBe(true);
    const wsId = created.data.workspace.id;
    globalThis.fetch = async () => new Response(JSON.stringify({ handle: 'kvh-bob-shared' }), { status: 200 });
    const bobBoot = await as(bob).get(`/api/ws/${wsId}`);
    expect(bobBoot.data.events?.mode).not.toBe('own');
    expect(bobBoot.data.events).toEqual({ mode: 'handle', handle: 'kvh-bob-shared', shards: EV_SHARDS, shard: evShard(bob.uuid) });
  });

  it('a member whose caller token names a different app gets no events block from either call site, and nothing is minted', async () => {
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    const { wsId, code } = await workspaceWith(alice, []);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ handle: 'kvh-mismatch' }), { status: 200 }); };
    const bobMismatched = { ...bob, authToken: fakeAuthToken('app-someone-elses') };
    expect((await as(bobMismatched).post('/api/join', { code })).ok).toBe(true);
    expect(calls).toBe(0); // the /api/join call site minted nothing
    expect((await as(bobMismatched).get(`/api/ws/${wsId}`)).data.events).toBeUndefined(); // nor did the bootstrap call site
    expect(calls).toBe(0);
    // No backoff was recorded against him either: the same member, back in
    // the app the worker runs as, still mints as anyone else would.
    const bobBack = { ...bob, authToken: fakeAuthToken('app-teamchat-test') };
    expect((await as(bobBack).get(`/api/ws/${wsId}`)).data.events).toMatchObject({ mode: 'handle', handle: 'kvh-mismatch' });
    expect(calls).toBe(1);
  });

  it('the owner calling the bootstrap with a token naming a different app gets no events block, own mode included', async () => {
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    const { wsId } = await workspaceWith(alice, []);
    const aliceMismatched = { ...alice, authToken: fakeAuthToken('app-someone-elses') };
    expect((await as(aliceMismatched).get(`/api/ws/${wsId}`)).data.events).toBeUndefined();
  });

  it('a member whose caller token names the same app as the worker still gets a handle', async () => {
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    const { wsId, code } = await workspaceWith(alice, []);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ handle: 'kvh-matched' }), { status: 200 }); };
    const bobMatched = { ...bob, authToken: fakeAuthToken('app-teamchat-test') };
    expect((await as(bobMatched).post('/api/join', { code })).ok).toBe(true);
    expect(calls).toBe(1);
    const memberBoot = await as(bobMatched).get(`/api/ws/${wsId}`);
    expect(memberBoot.data.events).toEqual({ mode: 'handle', handle: 'kvh-matched', shards: EV_SHARDS, shard: evShard(bob.uuid) });
  });

  it('a caller whose own token names no app is not gated by it', async () => {
    // Junk, and a claim that is no app uid: neither says which app the
    // caller runs as, so neither is evidence of a mismatch and both are
    // left to mint exactly as a caller carrying no token at all does.
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    const { wsId, code } = await workspaceWith(alice, []);
    globalThis.fetch = async () => new Response(JSON.stringify({ handle: 'kvh-unreadable' }), { status: 200 });
    for (const caller of [{ ...bob, authToken: 'not-a-jwt' }, { ...carol, authToken: fakeAuthToken('user-not-an-app') }]) {
      expect((await as(caller).post('/api/join', { code })).ok).toBe(true);
      expect((await as(caller).get(`/api/ws/${wsId}`)).data.events).toMatchObject({ mode: 'handle', handle: 'kvh-unreadable' });
    }
  });

  it('a worker with no app uid in its token never mints and never carries an events block', async () => {
    rt = await boot({ authToken: null });
    const { wsId, code } = await workspaceWith(alice, []);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ handle: 'kvh-nope' }), { status: 200 }); };
    await as(bob).post('/api/join', { code });
    expect((await as(alice).get(`/api/ws/${wsId}`)).data.events).toBeUndefined();
    expect((await as(bob).get(`/api/ws/${wsId}`)).data.events).toBeUndefined();
    expect(calls).toBe(0);
    expect((await as(alice).get('/api/server')).data.events).toEqual({ appUid: null, delegated: false, why: 'no_app_uid' });
  });

  // The worker used to answer bare nothing here, so an owner whose worker
  // can never do events had no way to learn it, and no bundle overwrite
  // could fix it either (an app identity is settled at creation): the owner
  // now gets a plain, distinguishable reason instead of silence. Only the
  // owner does, though — the reason names their own app and their own
  // consent, which is no more anyone else's to read than the rest of it.
  it('a worker with no app uid names the reason to its owner, and still tells nobody else', async () => {
    rt = await boot({ authToken: null });
    const { code } = await workspaceWith(alice, []);
    await as(bob).post('/api/join', { code });
    expect((await as(alice).get('/api/server')).data.events).toEqual({ appUid: null, delegated: false, why: 'no_app_uid' });
    expect((await as(bob).get('/api/server')).data.events).toBeUndefined();
  });

  it('mints a handle at join time and reuses it, never re-minting', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, code } = await workspaceWith(alice, []);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ handle: 'kvh-join' }), { status: 200 }); };
    expect((await as(bob).post('/api/join', { code })).ok).toBe(true);
    expect(calls).toBe(1); // minted eagerly for the joiner
    const first = await as(bob).get(`/api/ws/${wsId}`);
    expect(first.data.events).toMatchObject({ mode: 'handle', handle: 'kvh-join' });
    expect(calls).toBe(1); // reused from the member document, not re-minted
    const second = await as(bob).get(`/api/ws/${wsId}`);
    expect(second.data.events).toMatchObject({ handle: 'kvh-join' });
    expect(calls).toBe(1);
  });

  it('events_kv_handle_not_delegated backs the whole worker off, not just the member who hit it', async () => {
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: 'events_kv_handle_not_delegated', message: 'no consent' }), { status: 403 }); };
    // Bob's own join attempts the mint and hits the refusal; the verdict it
    // sets is worker-wide, so Carol's join right after never tries at all.
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    expect(calls).toBe(1);
    expect((await as(bob).get(`/api/ws/${wsId}`)).data.events).toBeUndefined();
    expect((await as(carol).get(`/api/ws/${wsId}`)).data.events).toBeUndefined();
    expect(calls).toBe(1); // neither bootstrap tried again
    const server = await as(alice).get('/api/server');
    expect(server.data.events).toEqual({ appUid: 'app-teamchat-test', delegated: false, why: 'events_kv_handle_not_delegated' });

    // The owner's consent clears the cached refusal, so the next mint re-probes.
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ handle: 'kvh-consented' }), { status: 200 }); };
    expect((await as(alice).put('/api/server', { events: true })).ok).toBe(true);
    const retried = await as(bob).get(`/api/ws/${wsId}`);
    expect(retried.data.events).toMatchObject({ handle: 'kvh-consented' });
    expect(calls).toBe(2);
    expect((await as(alice).get('/api/server')).data.events).toEqual({ appUid: 'app-teamchat-test', delegated: true, why: null });
  });

  it('events_kv_handle_owner_only backs the whole worker off too: it is this worker\'s own token, nothing a member can change', async () => {
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: 'events_kv_handle_owner_only', message: 'not this worker\'s handle to hold' }), { status: 403 }); };
    // Bob's own join hits the refusal; Carol's join right after never tries at all.
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    expect(calls).toBe(1);
    expect((await as(bob).get(`/api/ws/${wsId}`)).data.events).toBeUndefined();
    expect((await as(carol).get(`/api/ws/${wsId}`)).data.events).toBeUndefined();
    expect(calls).toBe(1); // neither bootstrap tried again
    expect((await as(alice).get('/api/server')).data.events).toEqual({ appUid: 'app-teamchat-test', delegated: false, why: 'events_kv_handle_owner_only' });
  });

  it('events_kv_handle_requires_account backs off only the member who hit it, not the worker', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, code } = await workspaceWith(alice, []);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: 'events_kv_handle_requires_account' }), { status: 403 }); };
    await as(bob).post('/api/join', { code }); // bob's temp account cannot be granted a handle
    expect(calls).toBe(1);
    expect((await as(bob).get(`/api/ws/${wsId}`)).data.events).toBeUndefined();
    expect(calls).toBe(1); // bob's own backoff still stands

    // A different member is not the worker's business to refuse over it.
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ handle: 'kvh-carol' }), { status: 200 }); };
    await as(carol).post('/api/join', { code });
    expect(calls).toBe(2);
    expect((await as(carol).get(`/api/ws/${wsId}`)).data.events).toMatchObject({ handle: 'kvh-carol' });
    expect(calls).toBe(2);
  });

  it('an owner account with no confirmed email backs the whole worker off', async () => {
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: 'account_is_not_verified' }), { status: 403 }); };
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    expect(calls).toBe(1);
    expect((await as(carol).get(`/api/ws/${wsId}`)).data.events).toBeUndefined();
    expect(calls).toBe(1);
    expect((await as(alice).get('/api/server')).data.events).toMatchObject({ delegated: false, why: 'account_is_not_verified' });
  });

  it('a member who takes no shares from the owner backs off alone, for hours', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, code } = await workspaceWith(alice, []);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: 'recipient_not_accepting_shares' }), { status: 400 }); };
    const before = Date.now();
    await as(bob).post('/api/join', { code });
    expect(calls).toBe(1);
    expect((await as(bob).get(`/api/ws/${wsId}`)).data.events).toBeUndefined();
    expect(calls).toBe(1);
    const doc = await rt.kv.get(KEYS.member(wsId, bob.uuid));
    expect(doc.ev.until - before).toBeGreaterThanOrEqual(6 * 3600_000 - 1000);
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ handle: 'kvh-carol' }), { status: 200 }); };
    await as(carol).post('/api/join', { code });
    expect(calls).toBe(2);
  });

  it('a 429 backs off the member alone; a different member still tries their own mint', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, code } = await workspaceWith(alice, []);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: 'too_many_requests' }), { status: 429 }); };
    await as(bob).post('/api/join', { code }); // bob's own join mints and hits the 429
    expect(calls).toBe(1);
    expect((await as(bob).get(`/api/ws/${wsId}`)).data.events).toBeUndefined();
    expect(calls).toBe(1); // bob's own backoff still stands

    // Carol is a different member: no worker-wide backoff was set by a 429, so her join still tries.
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ handle: 'kvh-carol' }), { status: 200 }); };
    await as(carol).post('/api/join', { code });
    expect(calls).toBe(2);
    const carolBoot = await as(carol).get(`/api/ws/${wsId}`);
    expect(carolBoot.data.events).toMatchObject({ handle: 'kvh-carol' });
    expect(calls).toBe(2);
  });

  it('events_kv_handle_not_delegated backs the worker off thirty minutes; the other worker-wide codes keep six hours', async () => {
    // Read tc:config directly rather than waiting the window out: mint and
    // revoke are both mocked to resolve at once, so the gap between "before"
    // and the moment ensureHandle stamps `until` is a few milliseconds.
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'events_kv_handle_not_delegated' }), { status: 403 });
    const before = Date.now();
    await workspaceWith(alice, [bob]);
    const consent = await rt.kv.get('tc:config');
    expect(consent.ev.until).toBeGreaterThanOrEqual(before + 29 * 60_000);
    expect(consent.ev.until).toBeLessThanOrEqual(before + 31 * 60_000);

    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'events_disabled' }), { status: 403 });
    const before2 = Date.now();
    await workspaceWith(alice, [bob]);
    const platform = await rt.kv.get('tc:config');
    expect(platform.ev.until).toBeGreaterThanOrEqual(before2 + 5.9 * 3600_000);
  });

  describe('remintHandle: re-minting a dead handle (POST /api/ws/:ws/events/handle)', () => {
    // Every fetch stub here answers by HTTP method: DELETE for revokeHandle,
    // anything else (POST) for mintHandle, since a re-mint always tries the
    // revoke first (see worker/events.js's remintHandle).
    const okDelete = () => new Response('{}', { status: 200 });
    const mintOf = (handle) => () => new Response(JSON.stringify({ handle }), { status: 200 });

    it('revokes the dead handle, clears the member document, and mints a fresh one', async () => {
      rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
      const { wsId, code } = await workspaceWith(alice, []);
      globalThis.fetch = mintOf('kvh-old');
      await as(bob).post('/api/join', { code });

      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init.method });
        return init.method === 'DELETE' ? okDelete() : mintOf('kvh-new')();
      };
      const res = await as(bob).post(`/api/ws/${wsId}/events/handle`);
      expect(res.data).toEqual({ events: { mode: 'handle', handle: 'kvh-new', shards: EV_SHARDS, shard: evShard(bob.uuid) } });
      const del = calls.find((c) => c.method === 'DELETE');
      expect(del?.url).toContain(encodeURIComponent('kvh-old'));

      // The member document now carries the fresh handle, reused without a
      // further mint (bob's own bootstrap never calls fetch again).
      globalThis.fetch = async () => { throw new Error('should not mint again: the fresh handle is cached'); };
      const boot2 = await as(bob).get(`/api/ws/${wsId}`);
      expect(boot2.data.events).toMatchObject({ handle: 'kvh-new' });
    });

    it('a dead handle whose revoke 404s is still replaced', async () => {
      rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
      const { wsId, code } = await workspaceWith(alice, []);
      globalThis.fetch = mintOf('kvh-gone');
      await as(bob).post('/api/join', { code });

      globalThis.fetch = async (url, init) => (init.method === 'DELETE'
        ? new Response(JSON.stringify({ code: 'subject_does_not_exist' }), { status: 404 })
        : mintOf('kvh-fresh')());
      const res = await as(bob).post(`/api/ws/${wsId}/events/handle`);
      expect(res.data.events).toMatchObject({ handle: 'kvh-fresh' });
    });

    it('serves only the caller: it takes no member id at all', async () => {
      rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
      const { wsId, code } = await workspaceWith(alice, []);
      globalThis.fetch = mintOf('kvh-bob');
      await as(bob).post('/api/join', { code });
      globalThis.fetch = mintOf('kvh-carol-1');
      await as(carol).post('/api/join', { code });

      globalThis.fetch = async (url, init) => (init.method === 'DELETE' ? okDelete() : mintOf('kvh-carol-2')());
      const res = await as(carol).post(`/api/ws/${wsId}/events/handle`);
      expect(res.data.events).toMatchObject({ handle: 'kvh-carol-2' });

      globalThis.fetch = async () => { throw new Error('bob\'s cached handle should not be touched'); };
      const bobBoot = await as(bob).get(`/api/ws/${wsId}`);
      expect(bobBoot.data.events).toMatchObject({ handle: 'kvh-bob' });
    });

    it('a non-member is refused, and nothing is minted', async () => {
      rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
      const { wsId } = await workspaceWith(alice, []);
      let calls = 0;
      globalThis.fetch = async () => { calls++; return mintOf('kvh-x')(); };
      const res = await as(carol).post(`/api/ws/${wsId}/events/handle`);
      expect(res.status).toBe(403);
      expect(calls).toBe(0);
    });

    it('the owner gets their own-mode block back, and nothing is minted or revoked', async () => {
      rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
      const { wsId } = await workspaceWith(alice, []);
      let calls = 0;
      globalThis.fetch = async () => { calls++; return mintOf('kvh-x')(); };
      const res = await as(alice).post(`/api/ws/${wsId}/events/handle`);
      expect(res.data.events).toMatchObject({ mode: 'own', appUid: 'app-teamchat-test' });
      expect(calls).toBe(0);
    });

    it('a standing worker-wide verdict means no block and no mint', async () => {
      rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: 'events_kv_handle_not_delegated' }), { status: 403 }); };
      // bob's own join attempts the mint and hits the refusal, which caches the worker-wide verdict this test is after.
      const { wsId } = await workspaceWith(alice, [bob]);
      expect(calls).toBe(1);
      const res = await as(bob).post(`/api/ws/${wsId}/events/handle`);
      expect(res.data.events).toBeUndefined();
      expect(calls).toBe(1); // ensureHandle short-circuits on the cached verdict; no revoke, no mint
    });

    it('the budget: LIMITS.evRemintsPerMember calls succeed, then a 429, with no further mint attempt', async () => {
      rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
      const { wsId, code } = await workspaceWith(alice, []);
      let n = 0;
      globalThis.fetch = async (url, init) => (init.method === 'DELETE' ? okDelete() : mintOf(`kvh-${++n}`)());
      await as(bob).post('/api/join', { code }); // mints kvh-1 at join

      for (let i = 0; i < LIMITS.evRemintsPerMember; i++) {
        const res = await as(bob).post(`/api/ws/${wsId}/events/handle`);
        expect(res.ok).toBe(true);
      }
      const refused = await as(bob).post(`/api/ws/${wsId}/events/handle`);
      expect(refused.status).toBe(429);
      expect(refused.data.code).toBe('too_many_remints');
      const mintedSoFar = n;
      const refusedAgain = await as(bob).post(`/api/ws/${wsId}/events/handle`);
      expect(refusedAgain.status).toBe(429);
      expect(n).toBe(mintedSoFar); // the budget refuses before any mint is attempted
    });

    it('a caller whose token names a different app gets nothing minted', async () => {
      rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
      const { wsId, code } = await workspaceWith(alice, []);
      globalThis.fetch = mintOf('kvh-bob');
      await as(bob).post('/api/join', { code });

      let calls = 0;
      globalThis.fetch = async () => { calls++; return mintOf('kvh-new')(); };
      const bobMismatched = { ...bob, authToken: fakeAuthToken('app-someone-elses') };
      const res = await as(bobMismatched).post(`/api/ws/${wsId}/events/handle`);
      expect(res.data.events).toBeUndefined();
      expect(calls).toBe(0);
    });
  });
});

describe('signal gating: no signal for a write nobody could ever be watching', () => {
  // A signal is a pure cost on top of the write that produced it (see
  // worker/signal.js): on a worker nothing can watch — no app uid at all, or
  // one where events.enabled is confirmed off for the whole platform region
  // — writing shard documents would be cost with nobody to wake, which is
  // exactly the regression this gate exists to avoid.

  it('a user-scoped worker (no app uid — the harness default) writes no shard keys at all', async () => {
    rt = await boot(); // authToken: null: a worker whose own token carries no app uid at all
    const { wsId, general } = await workspaceWith(alice, [bob]);
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hi' })).ok).toBe(true);
    expect(await writtenShards(wsId)).toEqual(new Set());
  });

  it('an app-bound worker with no verdict recorded yet signals optimistically', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hi' })).ok).toBe(true);
    await expectShards(wsId, null);
  });

  it('a cached events_disabled verdict, inside its window, suppresses every signal — even the owner\'s own', async () => {
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    const { wsId, code, general } = await workspaceWith(alice, []);
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'events_disabled', message: 'off in this region' }), { status: 403 });
    // Bob's own join attempts a mint and hits the refusal, which records the
    // worker-wide verdict this test is after (see ensureHandle).
    await as(bob).post('/api/join', { code });
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hi' })).ok).toBe(true);
    expect(await writtenShards(wsId)).toEqual(new Set());
  });

  it('events_kv_handles_disabled does not suppress signals: it only ever blocks members, never the owner\'s own subscription', async () => {
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    const { wsId, code, general } = await workspaceWith(alice, []);
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'events_kv_handles_disabled', message: 'no handles here' }), { status: 403 });
    await as(bob).post('/api/join', { code });
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hi' })).ok).toBe(true);
    await expectShards(wsId, null);
  });

  it('events_kv_handle_not_delegated does not suppress signals either, for the same reason', async () => {
    rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    const { wsId, code, general } = await workspaceWith(alice, []);
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'events_kv_handle_not_delegated', message: 'no consent' }), { status: 403 });
    await as(bob).post('/api/join', { code });
    await resetShards(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'hi' })).ok).toBe(true);
    await expectShards(wsId, null);
  });
});
