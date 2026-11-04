import { it, expect } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { RoomService } from '../src/collab/server/service.js';
import { createSharedDoc } from '../src/collab/shared-doc.js';
import { editorState } from '../src/collab/binding.js';
import { encode } from '../src/collab/protocol.js';

function fakePuter(owner) {
  const kv = new Map(), files = new Map();
  return {
    auth: { getUser: async () => owner },
    kv: {
      async get(k) { return kv.has(k) ? structuredClone(kv.get(k)) : null; },
      async set(k, v) { kv.set(k, structuredClone(v)); return true; },
      async del(k) { kv.delete(k); return true; },
      async incr(k, n = 1) { const v = Number(kv.get(k) || 0) + n; kv.set(k, v); return v; },
      async list({ pattern }) { return [...kv.keys()].filter(k => k.startsWith(pattern)).sort().map(key => ({ key, value: structuredClone(kv.get(key)) })); },
    },
    fs: { async write(path, data) { files.set(path, data); return { path }; }, async read(path) { return new Blob([files.get(path)]); } },
  };
}
const OWNER = { uuid: 'owner-1', username: 'ada' }, BOB = { uuid: 'user-2', username: 'bob' };

/**
 * Someone the owner removed stays out with the links they had, but a link the owner makes for them afterwards (an
 * emailed invitation is one) lets them in again, as inviting them by username already did.
 */
it('admits a removed person with a link made after the removal, and not with an earlier one', async () => {
  let now = 1_000_000;
  const service = new RoomService(fakePuter(OWNER), { rooms: new Map(), now: () => now });
  const doc = createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('Shared text')]), storyEdits: {} } }));
  await service.call(OWNER, { op: 'create', room: 'room1', name: 'Plan', initial: encode(Y.encodeStateAsUpdate(doc)), base: encode(new Uint8Array([80, 75, 3, 4])) });
  const { token: early } = await service.call(OWNER, { op: 'invite', room: 'room1', role: 'editor' });
  now += 1000;
  expect((await service.call(BOB, { op: 'join', room: 'room1', token: early })).role).toBe('editor');
  now += 1000;
  await service.call(OWNER, { op: 'role', room: 'room1', uuid: BOB.uuid, role: 'removed' });
  now += 1000;
  // The link Bob had no longer admits him.
  await expect(service.call(BOB, { op: 'join', room: 'room1', token: early })).rejects.toMatchObject({ status: 403 });
  await expect(service.call(BOB, { op: 'join', room: 'room1' })).rejects.toMatchObject({ status: 403 });
  // A new invitation does, with its role.
  const { token: fresh } = await service.call(OWNER, { op: 'invite', room: 'room1', role: 'commenter' });
  now += 1000;
  expect((await service.call(BOB, { op: 'join', room: 'room1', token: fresh })).role).toBe('commenter');
  const { members } = await service.call(OWNER, { op: 'members', room: 'room1' });
  expect(members.find(m => m.username === 'bob').role).toBe('commenter');
});
