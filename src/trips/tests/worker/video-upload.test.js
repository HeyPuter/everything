// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDatabase } from '../../src/lib/idb.js';
import { openSpace } from '../../src/lib/store/index.js';
import { fileBlob, startUpload } from '../../src/lib/files/index.js';
import { resetDirect } from '../../src/lib/files/direct.js';
import { K } from '../../worker/keys.js';
import { USERS, WORKER, createHarness } from './harness.js';

// An ISO base media header: enough for the worker's magic-byte check.
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
const clip = (name = 'clip.mp4') => new File([MP4], name, { type: 'video/mp4' });
const opened = [];
beforeEach(() => resetDirect());
afterEach(() => { for (const { space, db } of opened.splice(0)) { space.close(); db.close(); } });

async function setup({ ownerVerified = true } = {}) {
  const h = await createHarness({ shareHandles: true, ownerVerified });
  const sid = await h.trip();
  const alice = await h.client('alice');
  const { token } = await alice.in(sid).call('invite.create', { role: 'editor' });
  const bob = await h.client('bob');
  const joined = await bob.in(sid).call('join', { token });
  const db = await openDatabase(bob.uuid, { indexedDB: new IDBFactory() });
  const space = await openSpace({ ref: { w: WORKER, s: sid, k: 'trip' }, db, api: bob.api, puter: bob.puter, handles: joined.handles ?? null, files: joined.files ?? null, role: 'editor',
    now: h.now, setTimer: () => 0, clearTimer: () => {}, document: null, window: null });
  opened.push({ space, db });
  const execs = () => h.world.counters().byUser[USERS.bob.uuid]?.calls['workers.exec'] ?? 0;
  return { h, sid, space, options: { api: bob.api, puter: bob.puter }, execs };
}

describe('video uploads', () => {
  it('go through the inbox in direct file mode and play back with a video type', async () => {
    const f = await setup();
    const task = startUpload(f.space, clip(), f.options);
    const { id } = await task.run();
    expect(task.state.via).toBe('direct');
    expect(f.h.kv()[K.entity(f.sid, 'file', id)]).toMatchObject({ name: 'clip.mp4', mime: 'video/mp4', loc: { mode: 'direct' } });
    const blob = await fileBlob(f.space, id, f.options);
    expect(blob.type).toBe('video/mp4');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(MP4);
  });

  it('are refused before hashing or any upload when the trip sends files through its server', async () => {
    const f = await setup({ ownerVerified: false });
    const before = f.execs();
    const task = startUpload(f.space, clip(), f.options);
    await expect(task.run()).rejects.toMatchObject({ code: 'video_direct' });
    expect(f.execs() - before).toBeLessThanOrEqual(1);
    expect(task.state.via).toBeNull();
  });

  it('refuse formats the worker does not take', async () => {
    const f = await setup();
    await expect(startUpload(f.space, new File([MP4], 'clip.mkv', { type: 'video/x-matroska' }), f.options).run()).rejects.toMatchObject({ code: 'video_format' });
  });
});
