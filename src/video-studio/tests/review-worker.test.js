import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { setup, publish, invite, bundleFetcher, USERS } from './review-helpers.js';
import { deploy, call, WORKER_KEY } from '../src/review/api.js';
import { authorize } from '../src/review/auth.js';
import { LIMITS, DAY } from '../src/review/protocol.js';
import { LOST_CHANGE_MS } from '../worker/service.js';

const statusOf = (p) => p.then(() => 200, (e) => e.status ?? 'error');

describe('review worker: deployment', () => {
  it('deploys once, records the worker in the owner KV and reuses it', async () => {
    const env = await setup();
    expect(env.server).toMatch(/^https:\/\/video-review-[a-f0-9]{16}\.puter\.work$/);
    const config = await env.sdk.alice.kv.get(WORKER_KEY);
    expect(config.server).toBe(env.server);
    expect(config.path).toBe('/alice/AppData/video-studio/video-studio/worker/review-worker.js');
    const again = await deploy(env.sdk.alice, { fetcher: bundleFetcher(), wait: async () => {} });
    expect(again).toBe(env.server);
  });

  it('updates the worker file only for a newer build', async () => {
    const env = await setup();
    const path = (await env.sdk.alice.kv.get(WORKER_KEY)).path;
    await deploy(env.sdk.alice, { fetcher: bundleFetcher('dev', 0), wait: async () => {}, attempts: 1 }).catch(() => {});
    expect(await (await env.sdk.alice.fs.read(path)).text()).toContain('build=dev at=1');
    // A newer build is written (the fake worker still reports "dev", so health never matches and it gives up).
    await expect(deploy(env.sdk.alice, { fetcher: bundleFetcher('abc123', 5), wait: async () => {}, attempts: 1 })).rejects.toThrow(/still starting/);
    expect(await (await env.sdk.alice.fs.read(path)).text()).toContain('build=abc123 at=5');
  });

  it('refuses servers outside puter.work before sending anything', async () => {
    const env = await setup();
    const before = env.world.calls.length;
    await expect(call(env.sdk.bob, 'https://evil.example.com', { op: 'review.get', review: 'r_abcdef' })).rejects.toThrow(/unknown server/);
    await expect(call(env.sdk.bob, 'http://x.puter.work', { op: 'review.get', review: 'r_abcdef' })).rejects.toThrow(/unknown server/);
    expect(env.world.calls.length).toBe(before);
  });
});

describe('review worker: authentication', () => {
  it('never accepts a session token, only a restricted one with a valid proof', async () => {
    const env = await setup();
    const { review } = await publish(env);
    const body = JSON.stringify({ op: 'review.get', review: review.id });
    const exec = (headers, b = body) => env.sdk.alice.workers.exec(`${env.server}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: b });
    // The owner's own session is refused: nobody sends a full session.
    expect((await exec({})).status).toBe(401);
    const good = await authorize(env.sdk.alice, env.server, body);
    expect((await exec(good)).status).toBe(200);
    // The proof is bound to the body.
    expect((await exec(good, JSON.stringify({ op: 'review.get', review: 'r_other1' }))).status).toBe(401);
    // And to the worker.
    const elsewhere = await authorize(env.sdk.alice, 'https://other-worker.puter.work', body);
    expect((await exec(elsewhere)).status).toBe(401);
    // A token without the proof header is refused.
    expect((await exec({ 'puter-auth': good['puter-auth'] })).status).toBe(401);
    // Someone else's token with alice's proof is refused.
    const bobs = await authorize(env.sdk.bob, env.server, body);
    expect((await exec({ ...good, 'puter-auth': bobs['puter-auth'] })).status).toBe(401);
  });

  it('identifies the caller by the owner of their proof file', async () => {
    const env = await setup();
    const { review } = await publish(env);
    const token = await invite(env, review.id);
    const joined = await env.as('bob')('join', { review: review.id, token });
    expect(joined.review.me).toEqual({ uuid: USERS.bob.uuid, username: 'bob' });
    expect(joined.review.role).toBe('commenter');
  });

  it('keeps the credential in the person\'s KV and reuses it', async () => {
    const env = await setup();
    await publish(env);
    await publish(env);
    const mints = await env.world.storage.get('mints', USERS.alice.uuid);
    expect(mints.length).toBe(1);
  });
});

describe('review worker: publishing', () => {
  it('creates a review and adds versions when the same project is shared again', async () => {
    const env = await setup();
    const first = await publish(env, { title: 'Cut A' });
    expect(first.version).toBe(1);
    expect(first.review.versions.map((v) => v.n)).toEqual([1]);
    expect(first.review.versions[0]).not.toHaveProperty('path');
    const second = await publish(env, { title: 'Cut B', range: { in: 2_000_000, out: 12_000_000 } });
    expect(second.review.id).toBe(first.review.id);
    expect(second.version).toBe(2);
    expect(second.review.title).toBe('Cut B');
    expect(second.review.versions[1].range).toEqual({ in: 2_000_000, out: 12_000_000 });
    const other = await publish(env, { projectId: 'proj_000002' });
    expect(other.review.id).not.toBe(first.review.id);
    const found = await env.as('alice')('review.find', { projectId: 'proj_000001' });
    expect(found.review.versions.length).toBe(2);
    expect((await env.as('alice')('review.find', { projectId: 'proj_none01' })).review).toBe(null);
  });

  it('is idempotent by client id', async () => {
    const env = await setup();
    const a = await publish(env, { clientId: 'pub_same01' });
    const b = await publish(env, { clientId: 'pub_same01' });
    expect(b.review.versions.length).toBe(1);
    expect(b.version).toBe(a.version);
  });

  it('only lets the owner publish, find and manage', async () => {
    const env = await setup();
    const { review } = await publish(env);
    const token = await invite(env, review.id);
    await env.as('bob')('join', { review: review.id, token });
    for (const [op, f] of [['review.find', { projectId: 'proj_000001' }], ['invite.create', { review: review.id, role: 'viewer' }], ['invite.list', { review: review.id }], ['members', { review: review.id }], ['member.remove', { review: review.id, uuid: USERS.bob.uuid }]]) {
      expect(await statusOf(env.as('bob')(op, f))).toBe(403);
      expect(await statusOf(env.as('dave')(op, f))).toBe(403);
    }
    expect(await statusOf(env.as('bob')('review.publish', { clientId: 'pub_bob001', projectId: 'proj_000001', video: {} }))).toBe(403);
  });

  it('validates the video it is told about', async () => {
    const env = await setup();
    const pub = (video) => env.as('alice')('review.publish', { clientId: `pub_${Math.random().toString(36).slice(2, 10)}`, projectId: 'proj_000009', video });
    const ok = { path: '/alice/AppData/video-studio/missing.mp4', mime: 'video/mp4', fps: 30, duration: 1_000_000, width: 640, height: 360 };
    expect(await statusOf(pub(ok))).toBe(400);
    expect(await statusOf(pub({ ...ok, mime: 'text/html' }))).toBe(400);
    expect(await statusOf(pub({ ...ok, fps: 0 }))).toBe(400);
    expect(await statusOf(pub({ ...ok, path: '../../x.mp4' }))).toBe(400);
    expect(await statusOf(pub({ ...ok, range: { in: 5, out: 2 } }))).toBe(400);
  });
});

describe('review worker: invites and members', () => {
  it('admits people with a link, refuses outsiders without one', async () => {
    const env = await setup();
    const { review } = await publish(env);
    expect(await statusOf(env.as('dave')('review.get', { review: review.id }))).toBe(403);
    expect(await statusOf(env.as('dave')('sync', { review: review.id, since: 0 }))).toBe(403);
    expect(await statusOf(env.as('dave')('video.url', { review: review.id, version: 1 }))).toBe(403);
    expect(await statusOf(env.as('dave')('join', { review: review.id }))).toBe(403);
    const token = await invite(env, review.id, 'viewer');
    const j = await env.as('carol')('join', { review: review.id, token });
    expect(j.review.role).toBe('viewer');
    // Joining again without the token works once a member.
    expect((await env.as('carol')('join', { review: review.id })).review.role).toBe('viewer');
    // A commenter link raises a viewer; a viewer link never lowers.
    const c = await invite(env, review.id, 'commenter');
    expect((await env.as('carol')('join', { review: review.id, token: c })).review.role).toBe('commenter');
    expect((await env.as('carol')('join', { review: review.id, token })).review.role).toBe('commenter');
    const members = await env.as('alice')('members', { review: review.id });
    expect(members.members.map((m) => [m.username, m.role])).toEqual([['carol', 'commenter']]);
  });

  it('stores invite tokens hashed', async () => {
    const env = await setup();
    const { review } = await publish(env);
    const token = await invite(env, review.id);
    const all = JSON.stringify([...env.world.storage.tables.get('kv').values()]);
    expect(all).not.toContain(token);
  });

  it('refuses expired and revoked links', async () => {
    const env = await setup();
    const { review } = await publish(env);
    const day = await invite(env, review.id, 'commenter', 1);
    const week = await invite(env, review.id, 'commenter', 7);
    env.advance(DAY + 1000);
    await expect(env.as('bob')('join', { review: review.id, token: day })).rejects.toThrow(/expired/);
    const list = await env.as('alice')('invite.list', { review: review.id });
    expect(list.invites.map((i) => i.expired)).toEqual([false, true]);
    await env.as('alice')('invite.revoke', { review: review.id, invite: list.invites[0].id });
    await expect(env.as('bob')('join', { review: review.id, token: week })).rejects.toThrow(/turned off/);
    expect((await env.as('alice')('invite.list', { review: review.id })).invites[0].revoked).toBe(true);
  });

  it('lets a member reopen the link they joined with after it expired or was turned off', async () => {
    const env = await setup();
    const { review } = await publish(env);
    const token = await invite(env, review.id, 'commenter', 1);
    expect((await env.as('bob')('join', { review: review.id, token })).review.role).toBe('commenter');
    env.advance(DAY + 1000);
    for (let i = 0; i <= LIMITS.failedJoins; i++) expect((await env.as('bob')('join', { review: review.id, token })).review.role).toBe('commenter');
    const viewer = await invite(env, review.id, 'viewer', 7);
    expect((await env.as('carol')('join', { review: review.id, token: viewer })).review.role).toBe('viewer');
    const list = await env.as('alice')('invite.list', { review: review.id });
    await env.as('alice')('invite.revoke', { review: review.id, invite: list.invites[0].id });
    expect((await env.as('carol')('join', { review: review.id, token: viewer })).review.role).toBe('viewer');
    // A link that doesn't work never raises a role, and removed people stay out.
    expect((await env.as('carol')('join', { review: review.id, token })).review.role).toBe('viewer');
    await env.as('alice')('member.remove', { review: review.id, uuid: USERS.bob.uuid });
    await expect(env.as('bob')('join', { review: review.id, token })).rejects.toThrow(/expired/);
    // Outsiders with the expired link are still refused and counted.
    expect(await statusOf(env.as('dave')('join', { review: review.id, token }))).toBe(403);
  });

  it('throttles repeated failed joins', async () => {
    const env = await setup();
    const { review } = await publish(env);
    const bad = 'A'.repeat(43);
    for (let i = 0; i < LIMITS.failedJoins; i++) expect(await statusOf(env.as('dave')('join', { review: review.id, token: bad }))).toBe(403);
    expect(await statusOf(env.as('dave')('join', { review: review.id, token: bad }))).toBe(429);
    // Even a good link waits out the window.
    const good = await invite(env, review.id);
    expect(await statusOf(env.as('dave')('join', { review: review.id, token: good }))).toBe(429);
    env.advance(20 * 60_000);
    expect(await statusOf(env.as('dave')('join', { review: review.id, token: good }))).toBe(200);
  });

  it('removes people: no access, no rejoin with an old link, a new link works', async () => {
    const env = await setup();
    const { review } = await publish(env);
    const token = await invite(env, review.id);
    await env.as('bob')('join', { review: review.id, token });
    const link = await env.as('bob')('video.url', { review: review.id, version: 1 });
    expect((await env.world.fetchReadURL(link.url)).status).toBe(200);
    env.advance(1000);
    await env.as('alice')('member.remove', { review: review.id, uuid: USERS.bob.uuid });
    expect(await statusOf(env.as('bob')('sync', { review: review.id, since: 0 }))).toBe(403);
    // The link handed out before was revoked.
    expect((await env.world.fetchReadURL(link.url)).status).toBe(401);
    await expect(env.as('bob')('join', { review: review.id, token })).rejects.toThrow(/removed you/);
    env.advance(1000);
    const fresh = await invite(env, review.id, 'viewer');
    expect((await env.as('bob')('join', { review: review.id, token: fresh })).review.role).toBe('viewer');
    expect((await env.as('alice')('members', { review: review.id })).members.length).toBe(1);
  });

  it('changes roles', async () => {
    const env = await setup();
    const { review } = await publish(env);
    await env.as('bob')('join', { review: review.id, token: await invite(env, review.id) });
    await env.as('alice')('member.role', { review: review.id, uuid: USERS.bob.uuid, role: 'viewer' });
    expect(await statusOf(env.as('bob')('comment.add', { review: review.id, id: 'c_bob0001', version: 1, text: 'hi', t: 0 }))).toBe(403);
    expect(await statusOf(env.as('alice')('member.role', { review: review.id, uuid: USERS.bob.uuid, role: 'owner' }))).toBe(400);
  });
});

describe('review worker: video links', () => {
  it('hands out a short-lived read link for one file, with range requests', async () => {
    const env = await setup();
    const { review } = await publish(env);
    const a = await env.as('alice')('video.url', { review: review.id, version: 1 });
    expect(a.url).toMatch(/^https:\/\/api\.puter\.mock\/token-read\?uid=/);
    expect(a.expires - env.now()).toBe(4 * 3_600_000);
    const whole = await env.world.fetchReadURL(a.url);
    expect(whole.status).toBe(200);
    expect((await whole.blob()).size).toBe(4096);
    const part = await env.world.fetchReadURL(a.url, { range: 'bytes=100-199' });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 100-199/4096');
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    // The link is reused (Puter limits how many can be made) until it nears expiry.
    const b = await env.as('alice')('video.url', { review: review.id, version: 1 });
    expect(b.url).toBe(a.url);
    env.advance(4 * 3_600_000 - 10 * 60_000);
    const c = await env.as('alice')('video.url', { review: review.id, version: 1 });
    expect(c.url).not.toBe(a.url);
    env.advance(11 * 60_000);
    expect((await env.world.fetchReadURL(a.url)).status).toBe(401);
    expect((await env.world.fetchReadURL(c.url)).status).toBe(200);
    expect(await statusOf(env.as('alice')('video.url', { review: review.id, version: 9 }))).toBe(404);
  });
});

describe('review worker: comments', () => {
  async function withPeople() {
    const env = await setup();
    const { review } = await publish(env);
    await env.as('bob')('join', { review: review.id, token: await invite(env, review.id, 'commenter') });
    await env.as('carol')('join', { review: review.id, token: await invite(env, review.id, 'viewer') });
    return { env, rid: review.id };
  }

  it('posts, replies, resolves, edits and deletes with role checks', async () => {
    const { env, rid } = await withPeople();
    const add = (who, f) => env.as(who)('comment.add', { review: rid, version: 1, ...f });
    const c1 = (await add('bob', { id: 'c_bob0001', text: '  Too dark here  ', t: 2_000_000 })).comment;
    expect(c1).toMatchObject({ text: 'Too dark here', t: 2_000_000, end: null, author: { username: 'bob' }, resolved: false, seq: 1 });
    expect(await statusOf(add('carol', { id: 'c_car0001', text: 'Hi', t: 0 }))).toBe(403);
    expect(await statusOf(add('dave', { id: 'c_dav0001', text: 'Hi', t: 0 }))).toBe(403);
    const r1 = (await add('alice', { id: 'c_ali0001', parent: 'c_bob0001', text: 'Fixed in v2', t: 999 })).comment;
    expect(r1).toMatchObject({ parent: 'c_bob0001', t: null });
    expect(await statusOf(add('bob', { id: 'c_bob0002', parent: 'c_ali0001', text: 'nested' }))).toBe(404);
    // Retrying a saved comment returns it; someone else cannot take its id.
    expect((await add('bob', { id: 'c_bob0001', text: 'Too dark here', t: 2_000_000 })).comment.seq).toBe(1);
    expect(await statusOf(add('alice', { id: 'c_bob0001', text: 'x', t: 0 }))).toBe(409);
    // Resolve: commenters and the owner; not viewers; not replies.
    expect(await statusOf(env.as('carol')('comment.resolve', { review: rid, id: 'c_bob0001', resolved: true }))).toBe(403);
    expect(await statusOf(env.as('bob')('comment.resolve', { review: rid, id: 'c_ali0001', resolved: true }))).toBe(400);
    const res = (await env.as('bob')('comment.resolve', { review: rid, id: 'c_bob0001', resolved: true })).comment;
    expect(res.resolved).toBe(true);
    expect(res.resolvedBy.username).toBe('bob');
    expect((await env.as('alice')('comment.resolve', { review: rid, id: 'c_bob0001', resolved: false })).comment.resolved).toBe(false);
    // Edit own only.
    expect(await statusOf(env.as('alice')('comment.edit', { review: rid, id: 'c_bob0001', text: 'mine now' }))).toBe(403);
    const ed = (await env.as('bob')('comment.edit', { review: rid, id: 'c_bob0001', text: 'Too dark, lift shadows' })).comment;
    expect(ed.edited).toBeGreaterThan(0);
    // Delete own; the owner may delete anyone's.
    expect(await statusOf(env.as('bob')('comment.delete', { review: rid, id: 'c_ali0001' }))).toBe(403);
    expect((await env.as('alice')('comment.delete', { review: rid, id: 'c_bob0001' })).comment).toMatchObject({ deleted: true, text: '' });
    expect(await statusOf(env.as('bob')('comment.edit', { review: rid, id: 'c_bob0001', text: 'back' }))).toBe(409);
    expect(await statusOf(add('bob', { id: 'c_bob0003', parent: 'c_bob0001', text: 'reply to deleted' }))).toBe(409);
  });

  it('validates text, times and versions', async () => {
    const { env, rid } = await withPeople();
    const add = (f) => statusOf(env.as('bob')('comment.add', { review: rid, version: 1, id: `c_${Math.random().toString(36).slice(2, 10)}`, text: 'ok', t: 0, ...f }));
    expect(await add({ text: 'x'.repeat(LIMITS.text) })).toBe(200);
    expect(await add({ text: 'x'.repeat(LIMITS.text + 1) })).toBe(400);
    expect(await add({ text: '   ' })).toBe(400);
    expect(await add({ t: -1 })).toBe(400);
    expect(await add({ t: 10_000_001 })).toBe(400);
    expect(await add({ t: 1.5 })).toBe(400);
    expect(await add({ t: 1_000_000, end: 500_000 })).toBe(400);
    expect(await add({ t: 1_000_000, end: 3_000_000 })).toBe(200);
    expect(await add({ version: 7 })).toBe(404);
    expect(await add({ id: 'bad id!' })).toBe(400);
  });

  it('limits how fast one person comments', async () => {
    const { env, rid } = await withPeople();
    const add = (i) => statusOf(env.as('bob')('comment.add', { review: rid, version: 1, id: `c_rate${String(i).padStart(4, '0')}`, text: `n${i}`, t: 0 }));
    for (let i = 0; i < LIMITS.commentsPerMinute; i++) expect(await add(i)).toBe(200);
    expect(await add(99)).toBe(429);
    // Others are not affected; the next minute is fine.
    expect(await statusOf(env.as('alice')('comment.add', { review: rid, version: 1, id: 'c_alice001', text: 'still ok', t: 0 }))).toBe(200);
    env.advance(60_000);
    expect(await add(100)).toBe(200);
  });

  it('syncs changes since a cursor, in batches', async () => {
    const { env, rid } = await withPeople();
    for (let i = 0; i < 3; i++) await env.as('alice')('comment.add', { review: rid, version: 1, id: `c_sync${i}000`, text: `n${i}`, t: i * 1000 });
    const s0 = await env.as('carol')('sync', { review: rid, since: 0 });
    expect(s0.changes.map((c) => c.text)).toEqual(['n0', 'n1', 'n2']);
    expect(s0).toMatchObject({ cursor: 3, more: false, role: 'viewer', versions: 1 });
    await env.as('alice')('comment.resolve', { review: rid, id: 'c_sync1000', resolved: true });
    const s1 = await env.as('carol')('sync', { review: rid, since: 3 });
    expect(s1.changes).toHaveLength(1);
    expect(s1.changes[0]).toMatchObject({ id: 'c_sync1000', resolved: true, seq: 4 });
    // Many changes come in batches.
    const kv = env.sdk.alice.kv;
    const n = LIMITS.syncBatch + 5;
    for (let i = 0; i < n; i++) {
      const seq = await kv.incr(`vsr:r:${rid}:seq`);
      await kv.set(`vsr:r:${rid}:log:${seq}`, { at: env.now(), comment: { id: `c_bulk${i}`, version: 1, seq } });
    }
    const b1 = await env.as('carol')('sync', { review: rid, since: 4 });
    expect(b1.changes.length).toBe(LIMITS.syncBatch);
    expect(b1.more).toBe(true);
    const b2 = await env.as('carol')('sync', { review: rid, since: b1.cursor });
    expect(b2.changes.length).toBe(5);
    expect(b2.more).toBe(false);
  });

  it('waits for a change being written, and skips one that was lost', async () => {
    const { env, rid } = await withPeople();
    const kv = env.sdk.alice.kv;
    await env.as('alice')('comment.add', { review: rid, version: 1, id: 'c_first001', text: 'one', t: 0 });
    await kv.incr(`vsr:r:${rid}:seq`); // change 2: number taken, record never written
    await env.as('alice')('comment.add', { review: rid, version: 1, id: 'c_third001', text: 'three', t: 0 });
    const s = await env.as('bob')('sync', { review: rid, since: 0 });
    expect(s.changes.map((c) => c.text)).toEqual(['one']);
    expect(s.cursor).toBe(1);
    env.advance(LOST_CHANGE_MS + 1000);
    const t = await env.as('bob')('sync', { review: rid, since: 1 });
    expect(t.changes.map((c) => c.text)).toEqual(['three']);
    expect(t.cursor).toBe(3);
  });

  it('gives each of several concurrent comments its own change number', async () => {
    const { env, rid } = await withPeople();
    const saved = await Promise.all([0, 1, 2, 3].map((i) => env.as(i % 2 ? 'bob' : 'alice')('comment.add', { review: rid, version: 1, id: `c_conc${i}000`, text: `n${i}`, t: 0 })));
    expect(new Set(saved.map((r) => r.comment.seq)).size).toBe(4);
  });
});

describe('review worker: storage rules', () => {
  it('never lists KV keys', () => {
    for (const f of ['worker/service.js', 'worker/http.js', 'worker/auth.js', 'src/review/api.js', 'src/review/session.js', 'src/review/auth.js']) {
      const text = readFileSync(`${process.cwd()}/${f}`, 'utf8');
      expect(text, f).not.toMatch(/kv\.list|\.list\(/);
    }
  });

  it('keeps every KV value small', async () => {
    const env = await setup();
    const { review } = await publish(env);
    for (let v = 0; v < 5; v++) await publish(env);
    await env.as('bob')('join', { review: review.id, token: await invite(env, review.id) });
    for (const rec of env.world.storage.tables.get('kv').values()) expect(JSON.stringify(rec).length).toBeLessThan(4000);
  });
});
