/**
 * Handle revocation (worker/events.js releaseHandle/revokeHandle, wired into
 * worker/index.js at every workspace-level membership ending): an admin
 * removal, a self-leave, an external seat ending on a host, and a workspace
 * deletion each give back the departing member's cached KV share handle, so
 * a removed member stops receiving even the opaque shard pings and the
 * owner's live-handle slot frees for someone still here. See
 * docs/systemDesignDocs/teamchatEventsSignaling.md, sections 7.2 and 7.3.
 *
 * Every scenario here boots with an app-bound token (see
 * tests/events-signal.test.js's file docstring for why): a user-scoped
 * worker can never hold a handle to revoke, which is covered on its own
 * terms in "a user-scoped worker" below.
 */
import {
  describe, it, expect, afterEach,
} from 'vitest';
import {
  boot, as, USERS, workspaceWith, fakeAuthToken,
} from './helpers/harness.js';
import { REVOKE_BATCH_MAX } from '../worker/events.js';
import { KEYS } from '../src/shared/blocks.js';

const {
  alice, bob, carol, dave,
} = USERS;
const SERVER = 'teamchat-api.test';

let rt;

afterEach(() => {
  if (rt) expect(rt.kv._calls.list).toBe(0);
  rt = null;
});

/** True when `key` is one of this workspace's signal shard keys (see tests/events-signal.test.js). */
const isShardKey = (key, wsId) => key.startsWith(`tc:ws:${wsId}:ev:s`);

/**
 * What the stub mints for one member of one workspace. Real handles are per
 * (owner, grantee, app, region), so the workspace belongs in the name: two
 * workspaces on this worker with the same member in both would otherwise
 * hand out the one handle, and a release that reached for the wrong
 * workspace's document would still look right.
 */
const handleFor = (uuid, wsId) => `kvh-${uuid}-${wsId}`;

/**
 * Answer the worker's me.puter.kv.share / unshare and record every call as
 * { op, handle, kvOps }, `kvOps` being how many mutating KV ops the request
 * had made so far — the one clock the share calls and the KV writes share,
 * so a test can tell which happened first. `mintFail`/`revokeFail` let a
 * test make one grantee's share, or one handle's unshare, fail: each takes
 * the id in question and returns null (succeed), `{ code }` (refused), or
 * `{ network: true }`.
 */
function installShareStub({ mintFail = () => null, revokeFail = () => null } = {}) {
  const calls = [];
  const fail = (bad) => {
    if (bad.network) throw new TypeError('fetch failed');
    throw Object.assign(new Error(bad.code), { code: bad.code });
  };
  rt.kv.share = async ({ prefix, recipient }) => {
    calls.push({ op: 'share', holder: recipient.uid, prefix, kvOps: rt.kv._calls.log.length });
    const bad = mintFail(recipient.uid);
    if (bad) fail(bad);
    // `prefix` is tc:ws:{id}:ev: — the region of the workspace being shared.
    return { handle: handleFor(recipient.uid, String(prefix).split(':')[2] || '') };
  };
  rt.kv.unshare = async (handle) => {
    calls.push({ op: 'unshare', handle, kvOps: rt.kv._calls.log.length });
    const bad = revokeFail(handle);
    if (bad) fail(bad);
    return { handle, revokedAt: Math.floor(Date.now() / 1000) };
  };
  return calls;
}

describe('removing a member revokes their cached handle', () => {
  it('an admin removing a member stops exactly one share, that member\'s own', async () => {
    const token = fakeAuthToken();
    rt = await boot({ authToken: token });
    const calls = installShareStub();
    const { wsId } = await workspaceWith(alice, [bob]);
    const before = calls.length;
    const res = await as(alice).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    const deletes = calls.slice(before).filter((c) => c.op === 'unshare');
    expect(deletes.length).toBe(1);
    expect(deletes[0].handle).toBe(handleFor(bob.uuid, wsId));
  });

  it('the unshare lands before the request\'s last mutating KV op, which is a shard write', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installShareStub();
    const { wsId } = await workspaceWith(alice, [bob]);
    const beforeCalls = calls.length;
    const beforeKv = rt.kv._calls.log.length;
    const res = await as(alice).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    const del = calls.slice(beforeCalls).find((c) => c.op === 'unshare');
    expect(del).toBeTruthy();
    const made = rt.kv._calls.log.slice(beforeKv);
    expect(made.length).toBeGreaterThan(0);
    expect(isShardKey(made[made.length - 1].key, wsId)).toBe(true);
    // del.kvOps is the log length as it stood the instant the unshare went
    // out; strictly less than the final length means at least the shard
    // write above still landed after it.
    expect(del.kvOps).toBeLessThan(beforeKv + made.length);
  });

  it('leaving on one\'s own also revokes the handle', async () => {
    const token = fakeAuthToken();
    rt = await boot({ authToken: token });
    const calls = installShareStub();
    const { wsId } = await workspaceWith(alice, [bob]);
    const before = calls.length;
    const res = await as(bob).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    const deletes = calls.slice(before).filter((c) => c.op === 'unshare');
    expect(deletes.length).toBe(1);
    expect(deletes[0].handle).toBe(handleFor(bob.uuid, wsId));
  });

  it('a member with no cached handle (their mint was refused) is removed with no unshare at all', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installShareStub({
      mintFail: (uid) => (uid === bob.uuid ? { code: 'too_many_requests' } : null),
    });
    const { wsId } = await workspaceWith(alice, [bob]);
    const before = calls.length;
    const res = await as(alice).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    expect(calls.slice(before).some((c) => c.op === 'unshare')).toBe(false);
  });

  it('an owner-only refusal (an older platform build) still lets the removal succeed, and changes nothing else', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installShareStub({
      revokeFail: () => ({ code: 'events_kv_handle_owner_only' }),
    });
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    const res = await as(alice).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    const after = await as(alice).get(`/api/ws/${wsId}`);
    expect(after.data.workspace.members[bob.uuid]).toBeUndefined();
    expect(after.data.workspace.members[carol.uuid]).toBeTruthy();
    expect(calls.some((c) => c.op === 'unshare')).toBe(true);
  });

  it('a network failure revoking the handle still lets the removal succeed, and changes nothing else', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installShareStub({ revokeFail: () => ({ network: true }) });
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    const before = calls.length;
    const res = await as(alice).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    // The revoke was attempted and threw; the removal went through regardless.
    expect(calls.slice(before).filter((c) => c.op === 'unshare').length).toBe(1);
    const after = await as(alice).get(`/api/ws/${wsId}`);
    expect(after.data.workspace.members[bob.uuid]).toBeUndefined();
    expect(after.data.workspace.members[carol.uuid]).toBeTruthy();
  });
});

describe('deleting a workspace revokes a bounded batch of handles', () => {
  it(`revokes at most REVOKE_BATCH_MAX (${REVOKE_BATCH_MAX}) handles, however many members are holding one`, async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installShareStub();
    const { wsId, code } = await workspaceWith(alice, []);
    const many = Array.from({ length: REVOKE_BATCH_MAX + 2 }, (_, i) => ({ uuid: `u-test-${String(i).padStart(2, '0')}`, username: `test${i}` }));
    for (const u of many) expect((await as(u).post('/api/join', { code })).ok).toBe(true);
    const before = calls.length;
    const res = await as(alice).del(`/api/ws/${wsId}`);
    expect(res.ok).toBe(true);
    const deletes = calls.slice(before).filter((c) => c.op === 'unshare');
    expect(deletes.length).toBe(REVOKE_BATCH_MAX);
  });
});

describe('an external member\'s seat ending on the host revokes their handle', () => {
  /**
   * Acme (alice, carol) hosts #design; Globex (alice owns it too, bob is its
   * admin, dave a member) is the partner. Bob accepts the share link,
   * records it on Globex, and joins the channel on Acme — copied from
   * tests/connect.test.js's shared(), with the share stub already in place
   * so every join along the way mints a real (stubbed) handle.
   */
  async function shared() {
    const acme = await workspaceWith(alice, [carol], 'Acme');
    const globex = await workspaceWith(alice, [bob, dave], 'Globex');
    expect((await as(alice).post(`/api/ws/${globex.wsId}/members/${bob.uuid}/role`, { role: 'admin' })).ok).toBe(true);
    const design = (await as(alice).post(`/api/ws/${acme.wsId}/channels`, { name: 'design', topic: 'Pixels' })).data.channel.id;
    await as(carol).post(`/api/ws/${acme.wsId}/channels/${design}/join`);
    const inv = await as(alice).post(`/api/ws/${acme.wsId}/channels/${design}/connect/invites`, { inviteTtl: '7d' });
    expect(inv.ok).toBe(true);
    const acc = await as(bob).post('/api/connect/accept', { code: inv.data.code, partner: { ref: `${globex.wsId}@${SERVER}`, name: 'Globex' }, profile: { name: 'Bob B.' } });
    expect(acc.ok).toBe(true);
    const added = await as(bob).post(`/api/ws/${globex.wsId}/channels/shared`, {
      ref: `${acme.wsId}@${SERVER}`, ch: design, conn: acc.data.conn, secret: acc.data.secret, name: 'design-with-acme', host: acc.data.workspace.name,
    });
    expect(added.ok).toBe(true);
    const local = added.data.channel.id;
    const att = await as(bob).post(`/api/ws/${globex.wsId}/channels/${local}/attest`, {});
    expect(att.ok).toBe(true);
    const j = await as(bob).post('/api/connect/join', { conn: att.data.conn, token: att.data.token, profile: { name: 'Bob B.', title: 'Globex ops' } });
    expect(j.ok).toBe(true);
    return { acme, globex, design, local, conn: acc.data.conn };
  }

  it('ending the connection from the host revokes the external member\'s handle', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installShareStub();
    const { acme, design, conn } = await shared();
    // Bob's own bootstrap on Acme is what mints and caches his handle there.
    const bobBoot = await as(bob).get(`/api/ws/${acme.wsId}`);
    expect(bobBoot.data.events).toMatchObject({ mode: 'handle', handle: handleFor(bob.uuid, acme.wsId) });
    const before = calls.length;
    const res = await as(alice).del(`/api/ws/${acme.wsId}/channels/${design}/connections/${conn}`);
    expect(res.ok).toBe(true);
    const deletes = calls.slice(before).filter((c) => c.op === 'unshare');
    expect(deletes.length).toBe(1);
    // Acme's handle, not the one bob holds on Globex, which he keeps.
    expect(deletes[0].handle).toBe(handleFor(bob.uuid, acme.wsId));
  });

  it('the partner\'s word that one of its people is out ends the seat here and gives the handle back', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installShareStub();
    const { acme, globex, conn } = await shared();
    expect((await as(bob).get(`/api/ws/${acme.wsId}`)).data.events).toMatchObject({ handle: handleFor(bob.uuid, acme.wsId) });
    // Globex takes bob out, which hands its admin the word for Acme (see
    // revocationsFor); that removal gives back the handle bob held on
    // Globex, and carrying the word to Acme gives back the one he held here.
    const removed = await as(alice).del(`/api/ws/${globex.wsId}/members/${bob.uuid}`);
    expect(removed.data.revocations).toHaveLength(1);
    expect(calls.filter((c) => c.op === 'unshare').map((c) => c.handle))
      .toEqual([handleFor(bob.uuid, globex.wsId)]);
    const before = calls.length;
    expect((await as(alice).post('/api/connect/revoke', { conn, token: removed.data.revocations[0].token })).data).toEqual({ ok: true });
    const deletes = calls.slice(before).filter((c) => c.op === 'unshare');
    expect(deletes.length).toBe(1);
    expect(deletes[0].handle).toBe(handleFor(bob.uuid, acme.wsId));
  });

  it('a standing that ran out long ago is swept, and the handle goes with the card', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installShareStub();
    const { acme } = await shared();
    expect((await as(bob).get(`/api/ws/${acme.wsId}`)).data.events).toMatchObject({ handle: handleFor(bob.uuid, acme.wsId) });
    // Past the sweep's grace (see EXTERNAL_LAPSE_GRACE_MS), so the next
    // bootstrap by anyone here lets the card go (see lapseExternals).
    await rt.kv.update(KEYS.ws(acme.wsId), { [`members.${bob.uuid}.exp`]: Date.now() - 31 * 86400_000 });
    const before = calls.length;
    expect((await as(carol).get(`/api/ws/${acme.wsId}`)).ok).toBe(true);
    const deletes = calls.slice(before).filter((c) => c.op === 'unshare');
    expect(deletes.length).toBe(1);
    expect(deletes[0].handle).toBe(handleFor(bob.uuid, acme.wsId));
  });

  it('an external member leaving their last shared channel gives their handle back too', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installShareStub();
    const { acme, design } = await shared();
    expect((await as(bob).get(`/api/ws/${acme.wsId}`)).data.events).toMatchObject({ handle: handleFor(bob.uuid, acme.wsId) });
    const before = calls.length;
    // The channel he is here for is his last one, so leaving it takes him
    // out of the host workspace altogether (see the leave route).
    const res = await as(bob).post(`/api/ws/${acme.wsId}/channels/${design}/leave`);
    expect(res.ok).toBe(true);
    const deletes = calls.slice(before).filter((c) => c.op === 'unshare');
    expect(deletes.length).toBe(1);
    expect(deletes[0].handle).toBe(handleFor(bob.uuid, acme.wsId));
  });
});

describe('a removal that is not the end of a membership revokes nothing', () => {
  it('leaving one channel of a workspace one stays in keeps the handle', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installShareStub();
    const { wsId } = await workspaceWith(alice, [bob]);
    const ops = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'ops' })).data.channel.id;
    expect((await as(bob).post(`/api/ws/${wsId}/channels/${ops}/join`)).ok).toBe(true);
    const before = calls.length;
    // The signal region is per workspace and a shard key names no channel,
    // so someone still in the workspace still has something to watch.
    expect((await as(bob).post(`/api/ws/${wsId}/channels/${ops}/leave`)).ok).toBe(true);
    expect(calls.slice(before).some((c) => c.op === 'unshare')).toBe(false);
    expect((await as(bob).get(`/api/ws/${wsId}`)).data.events).toMatchObject({ handle: handleFor(bob.uuid, wsId) });
  });
});

describe('a user-scoped worker', () => {
  it('never unshares on a removal (nor a mint on the join before it)', async () => {
    rt = await boot(); // authToken: null
    const calls = installShareStub();
    const { wsId } = await workspaceWith(alice, [bob]);
    const res = await as(alice).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(0);
  });
});
