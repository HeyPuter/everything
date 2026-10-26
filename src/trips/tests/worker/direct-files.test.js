// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDatabase } from '../../src/lib/idb.js';
import { openSpace } from '../../src/lib/store/index.js';
import { directAvailable, fileBlob, startUpload } from '../../src/lib/files/index.js';
import { resetDirect } from '../../src/lib/files/direct.js';
import { K, P } from '../../worker/keys.js';
import { USERS, WORKER, createHarness } from './harness.js';

const PDF = new TextEncoder().encode('%PDF-1.7\nhello direct mode');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const pdf = (name = 'Ticket.pdf') => new File([PDF], name, { type: 'application/pdf' });
const opened = [];
beforeEach(() => resetDirect());
afterEach(() => { for (const { space, db } of opened.splice(0)) { space.close(); db.close(); } });

/** Alice (verified owner) with Bob as editor and Carol as viewer, each with a real openSpace. */
async function setup({ ownerVerified = true } = {}) {
  const h = await createHarness({ shareHandles: true, ownerVerified });
  const sid = await h.trip();
  const ref = { w: WORKER, s: sid, k: 'trip' };
  const alice = await h.client('alice');
  const people = { alice: { client: alice, joined: null } };
  for (const [name, role] of [['bob', 'editor'], ['carol', 'viewer']]) {
    const { token } = await alice.in(sid).call('invite.create', { role });
    const client = await h.client(name);
    people[name] = { client, joined: await client.in(sid).call('join', { token }), role };
  }
  async function open(name) {
    const { client, joined, role } = people[name];
    const db = await openDatabase(client.uuid, { indexedDB: new IDBFactory() });
    const space = await openSpace({ ref, db, api: client.api, puter: client.puter, handles: joined?.handles ?? null, files: joined?.files ?? null, role: role ?? 'owner',
      ownWorker: name === 'alice' ? WORKER : null, now: h.now, setTimer: () => 0, clearTimer: () => {}, document: null, window: null });
    opened.push({ space, db });
    return { space, client, options: { api: client.api, puter: client.puter } };
  }
  const usage = (name) => h.world.counters().byUser[USERS[name].uuid] ?? { calls: {}, egressBytes: 0 };
  return { h, sid, ref, people, open, usage };
}

describe('direct file mode', () => {
  it('uploads through the member inbox and lets members read straight from the shared folder, billed to the reader', async () => {
    const f = await setup();
    const bob = await f.open('bob');
    expect(await directAvailable(bob.space)).toBe(true);
    const puts = f.usage('bob').calls['workers.exec'];
    const task = startUpload(bob.space, pdf(), bob.options);
    const { id } = await task.run();
    expect(task.state.via).toBe('direct');
    // One worker call (`file.put`); the bytes never pass through the worker.
    expect(f.usage('bob').calls['workers.exec'] - puts).toBe(1);
    const entity = f.h.kv()[K.entity(f.sid, 'file', id)];
    expect(entity).toMatchObject({ name: 'Ticket.pdf', loc: { mode: 'direct', uid: expect.any(String) } });
    expect(f.h.world.inspectKv(USERS.alice.uuid)[K.pending(f.sid)] ?? {}).not.toHaveProperty(id);

    const carol = await f.open('carol');
    await carol.space.sync();
    const ownerEgress = f.usage('alice').egressBytes;
    const readerEgress = f.usage('carol').egressBytes;
    const blob = await fileBlob(carol.space, id, carol.options);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PDF);
    expect(blob.type).toBe('application/pdf');
    expect(f.usage('carol').egressBytes - readerEgress).toBe(PDF.length);
    expect(f.usage('alice').egressBytes).toBe(ownerEgress);
    expect(Object.keys(f.h.kv()).some((key) => key.includes(':rl:dlb:'))).toBe(false);
  });

  it('reads thumbnails from the shared folder too', async () => {
    const f = await setup();
    const bob = await f.open('bob');
    const { id } = await startUpload(bob.space, new File([PNG], 'map.png', { type: 'image/png' }), { ...bob.options, convert: false }).run();
    await bob.client.api.upload(bob.space.ref, id, new Blob([PNG]), { thumb: true });
    const carol = await f.open('carol');
    await carol.space.sync();
    expect(carol.space.get('file', id).thumb).toEqual(expect.any(String));
    const reads = f.usage('carol').calls['fs.read'] ?? 0;
    const thumb = await fileBlob(carol.space, id, { ...carol.options, thumb: true });
    expect(thumb.type).toBe('image/png');
    expect(f.usage('carol').calls['fs.read'] - reads).toBe(1);
  });

  it('falls back to the worker when the files share is gone, pauses direct reads and asks for a re-share', async () => {
    const f = await setup();
    const bob = await f.open('bob');
    const { id } = await startUpload(bob.space, pdf(), bob.options).run();
    const carol = await f.open('carol');
    await carol.space.sync();
    await carol.client.puter.fs.unshare({ uid: f.people.carol.joined.files.uid, recipient: 'carol' });
    const execs = f.usage('carol').calls['workers.exec'];
    const blob = await fileBlob(carol.space, id, carol.options);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PDF);
    // The proxied download, then `open {renew}` in the background.
    await vi.waitFor(() => expect(f.usage('carol').calls['workers.exec'] - execs).toBe(2));
    await vi.waitFor(async () => expect((await carol.client.puter.fs.stat({ uid: f.people.carol.joined.files.uid })).is_dir).toBe(true));
    const reads = f.usage('carol').calls['fs.read'] ?? 0;
    await fileBlob(carol.space, id, carol.options);
    expect(f.usage('carol').calls['fs.read'] ?? 0).toBe(reads);
  });

  it('falls back to a proxied upload when the inbox is unusable or the worker stopped taking inbox uploads', async () => {
    const f = await setup();
    const bob = await f.open('bob');
    await bob.client.puter.fs.unshare({ uid: f.people.bob.joined.files.inbox, recipient: 'bob' });
    const first = startUpload(bob.space, pdf('a.pdf'), bob.options);
    const { id } = await first.run();
    expect(first.state.via).toBe('proxied');
    expect(f.h.kv()[K.entity(f.sid, 'file', id)].loc.mode).toBe('proxied');

    resetDirect();
    await f.people.alice.client.puter.kv.set(K.filesMode(f.sid), 'proxied');
    const second = startUpload(bob.space, pdf('b.pdf'), { ...bob.options, dedupe: false });
    const result = await second.run();
    expect(second.state.via).toBe('proxied');
    expect(f.h.kv()[K.entity(f.sid, 'file', result.id)].loc.mode).toBe('proxied');
  });

  it('refuses a direct-only upload when the trip or the role cannot use an inbox', async () => {
    const f = await setup();
    const carol = await f.open('carol');
    expect(await directAvailable(carol.space)).toBe(false);
    const p = await setup({ ownerVerified: false });
    const bob = await p.open('bob');
    expect(await bob.space.fileAccess()).toEqual({ mode: 'proxied' });
    const task = startUpload(bob.space, pdf(), { ...bob.options, direct: 'require' });
    await expect(task.run()).rejects.toMatchObject({ code: 'direct_required' });
  });

  it('lets the owner upload and read through its own AppData', async () => {
    const f = await setup({ ownerVerified: false });
    const alice = await f.open('alice');
    const task = startUpload(alice.space, pdf(), alice.options);
    const { id } = await task.run();
    expect(task.state.via).toBe('direct');
    expect(f.h.kv()[K.entity(f.sid, 'file', id)].loc).toMatchObject({ mode: 'direct', uid: expect.any(String) });
    const listing = await alice.client.puter.fs.readdir(P.inboxOf(f.sid, USERS.alice.uuid));
    expect(listing).toEqual([]);
    const execs = f.usage('alice').calls['workers.exec'];
    const blob = await fileBlob(alice.space, id, alice.options);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PDF);
    expect(f.usage('alice').calls['workers.exec']).toBe(execs);
  });
});
