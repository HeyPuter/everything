// @vitest-environment node
// Fixes from the security review (S1): path C read budgets, scrubbed change history, inbox and share revocation.
import { describe, expect, it, vi } from 'vitest';
import { readDirect, resetDirect } from '../../src/lib/files/direct.js';
import { resetAllFeedCache } from '../../worker/ops/feed/all.js';
import { COLLAB_CAP } from '../../worker/engine/commit.js';
import { stripLocation } from '../../worker/engine/exif.js';
import { project } from '../../worker/engine/projection.js';
import { READ_BUDGET } from '../../worker/engine/sync.js';
import { K } from '../../worker/keys.js';
import { USERS, WORKER, createHarness, expectError, id } from './harness.js';

const A = USERS.alice.uuid;
const B = USERS.bob.uuid;
const owner = (h) => h.world.counters().byUser[A]?.calls ?? {};
const ownerKv = (h) => Object.entries(owner(h)).filter(([method]) => method.startsWith('kv.')).reduce((n, [, count]) => n + count, 0);
const ref = (space) => ({ w: WORKER, s: space, k: 'trip' });

async function team(options, roles = { bob: 'editor' }) {
  const h = await createHarness(options);
  const space = await h.team(roles);
  const alice = await h.client('alice');
  const bob = await h.client('bob');
  return { h, space, alice: alice.in(space), bob: bob.in(space), clients: { alice, bob } };
}

const commitOne = (member, op) => member.call('commit', { ops: [{ opId: id('o'), ...op }] });

describe('path C read budget (H1)', () => {
  it('serves settled records from the isolate cache on a repeated catch-up', async () => {
    const { h, bob } = await team();
    for (let i = 0; i < 20; i++) await commitOne(bob, { t: 'guest', id: id('g'), put: { name: `G${i}` } });
    h.advance(180_000);
    expect((await bob.call('sync', { since: 2 })).changes).toHaveLength(20);
    h.world.resetCounters();
    expect((await bob.call('sync', { since: 2 })).changes).toHaveLength(20);
    expect(owner(h)['kv.get'] ?? 0).toBe(0);
  });

  it('charges the bytes a catch-up reads to a KV window counter per member', async () => {
    const { h, space, bob } = await team();
    const notes = 'x'.repeat(9000);
    await bob.call('commit', { ops: Array.from({ length: 40 }, (_, i) => ({ opId: id('o'), t: 'place', id: id('p'), put: { name: `P${i}`, notes } })) });
    h.advance(2000);
    await bob.call('sync', { since: 2 });
    const window = Math.floor(h.now() / READ_BUDGET.windowMs);
    expect(h.kv()[K.rl(space, 'rdb', B, window)]).toBeGreaterThan(40 * 9000);
  });

  it('refuses path C reads once the member spent the daily budget, in every isolate', async () => {
    const { h, space, bob, clients } = await team({ regions: 2 });
    const notes = 'x'.repeat(9000);
    await bob.call('commit', { ops: Array.from({ length: 40 }, (_, i) => ({ opId: id('o'), t: 'place', id: id('p'), put: { name: `P${i}`, notes } })) });
    const window = Math.floor(h.now() / READ_BUDGET.windowMs);
    await clients.alice.puter.kv.set(K.rl(space, 'rdb', B, window), READ_BUDGET.limit - 1000);
    await h.settle();
    h.advance(2000);
    await expectError(bob.call('sync', { since: 2 }), 429, 'rate_limited');
    h.world.resetCounters();
    // The isolate remembers, so further calls read nothing.
    await expectError(bob.call('sync', { since: 2 }), 429, 'rate_limited');
    await expectError(bob.call('chat.page'), 429, 'rate_limited');
    expect(owner(h)['kv.get'] ?? 0).toBeLessThanOrEqual(1);
    // Another region's isolate reads the same counter.
    const other = (await h.client('bob', 1)).in(space);
    await expectError(other.call('sync', { since: 2 }), 429, 'rate_limited');
  });

  async function records(h, space, clients, rev) {
    const items = Array.from({ length: rev - 2 }, (_, i) => ({ key: K.ch(space, i + 3, 0), value: { rev: i + 3, parts: 1, at: 1, by: B, ents: [], del: [], sum: [] } }));
    await clients.alice.puter.kv.set(items);
    await clients.alice.puter.kv.set(K.rev(space), rev);
    h.advance(2000);
  }

  it('allows one long catch-up per minute when no snapshot covers it', async () => {
    const { h, space, bob, clients } = await team();
    await records(h, space, clients, 150);
    expect((await bob.call('sync', { since: 20 })).changes).toHaveLength(130);
    await expectError(bob.call('sync', { since: 30 }), 429, 'rate_limited');
    expect((await bob.call('sync', { since: 120 })).changes).toHaveLength(30);
    h.advance(60_000);
    expect((await bob.call('sync', { since: 30 })).changes).toHaveLength(120);
  });

  it('answers a long catch-up the snapshot covers with a reset that reads nothing', async () => {
    const { h, space, bob, clients } = await team();
    await records(h, space, clients, 300);
    await bob.call('sync', { since: 290 });
    // That call rebuilt the snapshot at rev 300 in the background.
    await h.settle();
    h.world.resetCounters();
    expect(await bob.call('sync', { since: 100 })).toMatchObject({ reset: true, rev: 300 });
    expect(await bob.call('sync', { since: 0 })).toMatchObject({ reset: true, rev: 300 });
    expect(ownerKv(h)).toBe(0);
  });
});

/** Bob's direct-mode folders: `{files, inbox}` paths and uids. */
async function folders(bob) {
  const { files } = await bob.call('open');
  expect(files).toMatchObject({ mode: 'direct', uid: expect.any(String), inbox: expect.any(String) });
  return files;
}

describe('direct-mode inboxes (M2)', () => {
  it('sweeps a member inbox when another member opens the trip and charges the deleted bytes to its member', async () => {
    const { h, space, bob, clients } = await team({ shareHandles: true }, { bob: 'editor', carol: 'viewer' });
    const { inbox } = await folders(bob);
    const path = (await clients.bob.puter.fs.stat({ uid: inbox })).path;
    await clients.bob.puter.fs.write(`${path}/parked.bin`, new Blob([new Uint8Array(300_000)]));
    h.advance(2 * 3_600_000);
    // Bob never calls `file.put`; Carol opening the trip is enough.
    await (await h.client('carol')).in(space).call('open');
    expect(await clients.bob.puter.fs.readdir(path)).toEqual([]);
    expect(h.kv()[K.rl(space, 'upb', B, Math.floor(h.now() / 86_400_000))]).toBe(300_000);
  });

  it('takes the inbox away for the day once swept bytes pass the upload budget of its member', async () => {
    const { h, space, bob, clients } = await team({ shareHandles: true }, { bob: 'editor', carol: 'viewer' });
    const { inbox } = await folders(bob);
    const path = (await clients.bob.puter.fs.stat({ uid: inbox })).path;
    // Subfolders are never part of an upload and count as a full inbox each.
    for (const name of ['a', 'b']) await clients.bob.puter.fs.write(`${path}/${name}/x.bin`, new Blob([new Uint8Array(10)]), { createMissingParents: true });
    // Sweeps run at most once per 10 minutes; Bob's `open` above used this window's.
    h.advance(10 * 60_000);
    await (await h.client('carol')).in(space).call('open');
    await expect(clients.bob.puter.fs.readdir(path)).rejects.toMatchObject({ status: 404 });
    expect(h.kv()[K.handles(space, B)]).toMatchObject({ inbox: null, inboxHold: expect.any(Number) });
    h.advance(11 * 60_000);
    expect((await bob.call('open')).files.inbox).toBeUndefined();
  });

  it('revokes inboxes when a perms change takes uploads away from the role', async () => {
    const { h, space, alice, bob, clients } = await team({ shareHandles: true });
    const { inbox } = await folders(bob);
    const path = (await clients.bob.puter.fs.stat({ uid: inbox })).path;
    await commitOne(alice, { t: 'meta', id: 'meta', set: { perms: { 'files.upload': 'owner' } } });
    await h.settle();
    await expect(clients.bob.puter.fs.write(`${path}/late.pdf`, new Blob(['%PDF-'])).then(() => 'written')).rejects.toBeTruthy();
    expect(h.kv()[K.handles(space, B)]).toMatchObject({ inbox: null });
  });
});

describe('file share revocation (M3)', () => {
  it('revokes the folder share of a member who renamed their account before removal', async () => {
    const { h, alice, bob, clients } = await team({ shareHandles: true });
    const { uid, inbox } = await folders(bob);
    expect(await clients.bob.puter.fs.readdir(uid)).toBeDefined();
    h.world.renameUser('bob', 'bob2');
    await alice.call('member.remove', { uuid: B });
    await expect(clients.bob.puter.fs.readdir(uid)).rejects.toMatchObject({ status: 403 });
    await expect(clients.bob.puter.fs.readdir(inbox)).rejects.toMatchObject({ status: 404 });
  });

  it('drops folder shares held by non-members during owner maintenance', async () => {
    const { h, space, alice, clients } = await team({ shareHandles: true });
    const carol = await h.client('carol');
    const files = (await clients.alice.puter.fs.stat(`spaces/${space}/files`)).uid;
    await clients.alice.puter.fs.share(`spaces/${space}/files`, 'carol', 'read');
    expect(await carol.puter.fs.readdir(files)).toBeDefined();
    h.advance(3_600_000);
    await alice.call('open');
    await h.settle();
    await expect(carol.puter.fs.readdir(files)).rejects.toMatchObject({ status: 403 });
    // Members keep theirs.
    expect(await clients.bob.puter.fs.readdir(files)).toBeDefined();
  });
});

describe('deleted content in change history (M1)', () => {
  it('scrubs a deleted message from every record a later member can read', async () => {
    const { h, space, alice, bob, clients } = await team({ shareHandles: true });
    const msg = id('m');
    await commitOne(bob, { t: 'msg', id: msg, put: { text: 'door code 4471' } });
    await commitOne(alice, { t: 'msg', id: msg, set: { [`react.👍.${A}`]: 1 } });
    await commitOne(bob, { t: 'msg', id: msg, set: { [`react.🎉.${B}`]: 1 } });
    const { rev } = await commitOne(bob, { t: 'msg', id: msg, del: true });
    const { token } = await alice.call('invite.create', { role: 'viewer' });
    const carol = await h.client('carol');
    const joined = await carol.in(space).call('join', { token });
    const records = await carol.puter.kv.get(Array.from({ length: rev + 2 }, (_, i) => `ch:${i + 1}:0`), { handle: joined.handles.read });
    expect(records.filter(Boolean).length).toBeGreaterThan(4);
    expect(JSON.stringify(records)).not.toContain('4471');
    expect(JSON.stringify(await carol.in(space).call('sync', { since: 0 }))).not.toContain('4471');
    expect(JSON.stringify(await carol.api.snapshot(ref(space)))).not.toContain('4471');
    expect(JSON.stringify(h.kv())).not.toContain('4471');
    void clients;
  });

  it('scrubs earlier versions of a deleted booking and its edited message text', async () => {
    const { h, bob } = await team();
    const res = id('r');
    await commitOne(bob, { t: 'res', id: res, put: { type: 'lodging', title: 'Hotel', status: 'confirmed', code: 'PNR9876' } });
    await commitOne(bob, { t: 'res', id: res, set: { notes: 'safe 5512' } });
    await commitOne(bob, { t: 'res', id: res, del: true });
    const msg = id('m');
    await commitOne(bob, { t: 'msg', id: msg, put: { text: 'wifi pass hunter2' } });
    await commitOne(bob, { t: 'msg', id: msg, set: { text: 'wifi pass on the fridge' } });
    const kv = JSON.stringify(h.kv());
    expect(kv).not.toContain('PNR9876');
    expect(kv).not.toContain('5512');
    expect(kv).not.toContain('hunter2');
    expect(kv).toContain('on the fridge');
  });

  it('rebuilds a snapshot older than the last scrub before serving it', async () => {
    const { h, space, bob, clients } = await team();
    const note = id('n');
    await commitOne(bob, { t: 'note', id: note, put: { title: 'Passport X1234567' } });
    expect(JSON.stringify(await clients.bob.api.snapshot(ref(space)))).toContain('X1234567');
    h.advance(121_000);
    await commitOne(bob, { t: 'note', id: note, del: true });
    h.advance(6000);
    const snapshot = await clients.bob.api.snapshot(ref(space));
    expect(JSON.stringify(snapshot)).not.toContain('X1234567');
    expect(h.kv()[K.snap(space)].rev).toBeGreaterThanOrEqual(h.kv()[K.scrub(space)]);
  });

  it('keeps clients converging when they replay scrubbed records from the start', async () => {
    const { bob } = await team();
    const keep = id('p');
    const gone = id('p');
    await commitOne(bob, { t: 'place', id: keep, put: { name: 'Keep' } });
    await commitOne(bob, { t: 'place', id: gone, put: { name: 'Gone' } });
    await commitOne(bob, { t: 'place', id: keep, set: { name: 'Kept' } });
    await commitOne(bob, { t: 'place', id: gone, del: true });
    const { changes } = await bob.call('sync', { since: 0 });
    const state = new Map();
    for (const record of changes) {
      for (const entity of record.ents) state.set(`${entity.t}:${entity.id}`, entity);
      for (const item of record.del) state.delete(`${item.t}:${item.id}`);
    }
    expect(state.get(`place:${keep}`)).toMatchObject({ name: 'Kept' });
    expect(state.has(`place:${gone}`)).toBe(false);
  });
});

describe('low-severity fixes', () => {
  it('L1: caps notes, links and polls apart from the space cap, and slows bursts of creates', async () => {
    const { h, space, alice, clients } = await team({}, { bob: 'editor', carol: 'viewer' });
    await commitOne(alice, { t: 'meta', id: 'meta', set: { perms: { 'collab.post': 'viewer' } } });
    const carol = (await h.client('carol')).in(space);
    await clients.alice.puter.kv.set(K.count(space), { e: 10, collab: COLLAB_CAP - 1 });
    h.advance(2000);
    await commitOne(carol, { t: 'note', id: id('n'), put: { title: 'Last one' } });
    await expectError(commitOne(carol, { t: 'note', id: id('n'), put: { title: 'Too many' } }), 409, 'space_full');
    // Other types still fit.
    await commitOne(alice, { t: 'guest', id: id('g'), put: { name: 'G' } });
    const burst = () => carol.call('commit', { ops: Array.from({ length: 200 }, () => ({ opId: id('o'), t: 'msg', id: id('m'), put: { text: 'spam' } })) });
    await burst();
    await burst();
    await expectError(burst(), 429, 'rate_limited');
  });

  it('L2: keeps the daily write-byte budget on a KV counter every isolate reads', async () => {
    const { h, space, bob, clients } = await team({ regions: 2 });
    const big = () => ({ opId: id('o'), t: 'place', id: id('p'), put: { name: 'Big', desc: 'd'.repeat(100_000), notes: 'n'.repeat(100_000) } });
    const window = Math.floor(h.now() / 86_400_000);
    await clients.alice.puter.kv.set(K.rl(space, 'wb', B, window), 512 * 1024 ** 2 - 1000);
    await h.settle();
    await expectError(bob.call('commit', { ops: [big(), big(), big()] }), 429, 'rate_limited');
    const other = (await h.client('bob', 1)).in(space);
    await expectError(other.call('commit', { ops: [big(), big(), big()] }), 429, 'rate_limited');
  });

  it('L3: public links name members by initial only', async () => {
    const { h, space, alice } = await team({}, { bob: 'editor', carol: 'viewer' });
    const { token } = await alice.call('share.set', { on: true, plan: true });
    const response = await (await h.client('dave')).puter.workers.exec(`https://${WORKER}.puter.work/pub/${space}/${token}`, { headers: { 'x-puter-no-auth': '1' } });
    const body = await response.json();
    expect(body.members.map((member) => member.name).sort()).toEqual(['A.', 'B.', 'C.']);
    for (const name of ['alice', 'bob', 'carol']) expect(JSON.stringify(body)).not.toContain(name);
  });

  it('L7: a flood of bad tokens never locks out the link the isolate already accepted', async () => {
    const { h, space, alice } = await team();
    const { token } = await alice.call('share.set', { on: true, plan: true });
    const dave = await h.client('dave');
    const view = (value) => dave.puter.workers.exec(`https://${WORKER}.puter.work/pub/${space}/${value}`, { headers: { 'x-puter-no-auth': '1' } });
    expect((await view(token)).status).toBe(200);
    for (let i = 0; i < 610; i++) await view(i.toString(16).padStart(32, '0'));
    h.advance(31_000);
    expect((await view(token)).status).toBe(200);
  });

  it('L4: drops JPEG trailers, MPF and comments, keeps every scan and the ICC profile', () => {
    const encode = (text) => new TextEncoder().encode(text);
    const segment = (marker, payload) => concat([new Uint8Array([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
    const gps = new Uint8Array(12).fill(0x5a);
    const scan = (data) => concat([segment(0xda, new Uint8Array([1, 2])), data]);
    const input = concat([
      new Uint8Array([0xff, 0xd8]), segment(0xe0, encode('JFIF\0')), segment(0xe2, encode('ICC_PROFILE\0\x01\x01')), segment(0xe2, concat([encode('MPF\0'), gps])),
      segment(0xfe, encode('shot at 38.7N')), segment(0xc4, new Uint8Array([0, 1])), scan(new Uint8Array([0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33])),
      segment(0xc4, new Uint8Array([0, 2])), scan(new Uint8Array([0x44])), new Uint8Array([0xff, 0xd9]),
      // A second image appended after EOI, as MPF and motion photos do.
      new Uint8Array([0xff, 0xd8]), segment(0xe1, concat([encode('Exif\0\0'), gps])), new Uint8Array([0xff, 0xd9]),
    ]);
    const out = stripLocation(input, 'image/jpeg');
    const text = new TextDecoder('latin1').decode(out);
    expect(text).toContain('JFIF');
    expect(text).toContain('ICC_PROFILE');
    expect(text).not.toContain('MPF');
    expect(text).not.toContain('38.7N');
    expect(out.some((byte, i) => byte === 0x5a && out[i + 1] === 0x5a)).toBe(false);
    // Both scans with their stuffed bytes and restart markers, then the first EOI.
    expect(out.filter((byte, i) => byte === 0xff && out[i + 1] === 0xda)).toHaveLength(2);
    expect(text).toContain(new TextDecoder('latin1').decode(new Uint8Array([0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33])));
    expect([...out.slice(-3)]).toEqual([0x44, 0xff, 0xd9]);
    expect(out.length).toBeLessThan(input.length - 20);
  });

  it('L4: drops GIF application and comment extensions but keeps the loop block', () => {
    const encode = (text) => new TextEncoder().encode(text);
    const header = concat([encode('GIF89a'), new Uint8Array([1, 0, 1, 0, 0x80, 0, 0]), new Uint8Array(6)]);
    const loop = concat([new Uint8Array([0x21, 0xff, 11]), encode('NETSCAPE2.0'), new Uint8Array([3, 1, 0, 0, 0])]);
    const xmp = concat([new Uint8Array([0x21, 0xff, 11]), encode('XMP DataXMP'), new Uint8Array([4]), encode('GPS!'), new Uint8Array([0])]);
    const comment = concat([new Uint8Array([0x21, 0xfe, 5]), encode('Paris'), new Uint8Array([0])]);
    const image = new Uint8Array([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0]);
    const out = stripLocation(concat([header, loop, xmp, comment, image, new Uint8Array([0x3b])]), 'image/gif');
    const text = new TextDecoder('latin1').decode(out);
    expect(text).toContain('NETSCAPE2.0');
    expect(text).not.toContain('XMP');
    expect(text).not.toContain('Paris');
    expect(out.at(-1)).toBe(0x3b);
  });

  it('L4: keeps HEIC, AVIF and video attachments private when the map is hidden', () => {
    const R = '0000000000000r01';
    const file = (id, name, mime) => ({ t: 'file', id, name, mime, size: 10, sha256: 'a'.repeat(64), kind: 'user', loc: { mode: 'proxied' }, links: [{ t: 'res', id: R }] });
    const snapshot = { rev: 3, at: 1, ents: [
      { t: 'meta', id: 'meta', title: 'Trip', currency: 'EUR' }, { t: 'res', id: R, type: 'lodging', title: 'Hotel', status: 'confirmed' },
      file('0000000000000f01', 'a.heic', 'image/heic'), file('0000000000000f02', 'b.mp4', 'video/mp4'), file('0000000000000f03', 'c.pdf', 'application/pdf'), file('0000000000000f04', 'd.jpg', 'image/jpeg'),
    ] };
    expect(project(snapshot, 'trip', { on: true, bookings: true, files: true, map: false }).files.sort()).toEqual(['0000000000000f03', '0000000000000f04']);
    expect(project(snapshot, 'trip', { on: true, bookings: true, files: true }).files).toHaveLength(4);
  });

  it('L5: stops reading a remote calendar that never ends', async () => {
    resetAllFeedCache();
    let pulled = 0;
    const endless = () => new ReadableStream({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(64 * 1024).fill(0x41)); } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(endless(), { status: 200 })));
    try {
      const { h, space, alice } = await team();
      const { token } = await alice.call('feed.set', { scope: 'all' });
      const created = await alice.call('feed.all', { add: [
        { w: WORKER, s: space, uuid: A, token, title: 'Here' },
        { w: 'trips-zzzzzzzzzz', s: id('s'), uuid: A, token: 'b'.repeat(32), title: 'Endless' },
      ] });
      const response = await (await h.client('dave')).puter.workers.exec(`https://${WORKER}.puter.work${created.path}`, { headers: { 'x-puter-no-auth': '1' } });
      expect(response.status).toBe(200);
      expect(pulled).toBeLessThan(40);
    } finally { vi.unstubAllGlobals(); }
  });

  it('L6: direct reads go by path inside the trip folder, never by a uid the trip owner wrote', async () => {
    const { h, space } = await team({ shareHandles: true }, { bob: 'editor', carol: 'viewer' });
    const carol = await h.client('carol');
    const { files } = await carol.in(space).call('open');
    // A file only Carol can read, in her own storage.
    const secret = await carol.puter.fs.write('private/secret.txt', new Blob(['carol only']), { createMissingParents: true });
    const own = (await carol.puter.fs.stat('private')).uid;
    const fake = { ref: { w: WORKER, s: space, k: 'trip' }, fileAccess: async () => ({ mode: 'direct', uid: files.uid }) };
    const entity = { id: id('f'), name: 'x.txt', loc: { mode: 'direct', uid: secret.uid } };
    resetDirect();
    expect(await readDirect(fake, entity, { puter: carol.puter })).toBeNull();
    // A worker naming a folder outside the trip is refused too.
    resetDirect();
    const elsewhere = { ...fake, fileAccess: async () => ({ mode: 'direct', uid: own }) };
    expect(await readDirect(elsewhere, { ...entity, name: 'secret.txt' }, { puter: carol.puter })).toBeNull();
    resetDirect();
  });

  it('L8: removing a former member of a moved trip revokes their seat', async () => {
    const { h, space, alice, clients } = await team();
    const C = USERS.carol.uuid;
    await clients.alice.puter.kv.set(K.xin(space), { from: { w: 'trips-zzzzzzzzzz', s: space }, by: A, at: h.now() });
    await clients.alice.puter.kv.set(K.seat(space, C), { role: 'editor', username: 'carol', exp: h.now() + 86_400_000 });
    expect((await alice.call('invite.list')).seats).toEqual([{ uuid: C, username: 'carol', role: 'editor', exp: expect.any(Number) }]);
    expect(await alice.call('member.remove', { uuid: C })).toMatchObject({ removed: true, seat: true });
    expect((await alice.call('invite.list')).seats).toBeUndefined();
    const carol = (await h.client('carol')).in(space);
    await expectError(carol.call('transfer.join'), 404, 'seat_invalid');
    await expectError(alice.call('member.remove', { uuid: C }), 404, 'not_member');
  });
});

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
