import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { RoomService } from '../src/collab/server/service.js';
import { createSharedDoc, readState } from '../src/collab/shared-doc.js';
import { editorState } from '../src/collab/binding.js';
import { encode, decode } from '../src/collab/protocol.js';
import { tokenClaims } from '../src/collab/auth.js';

/** An in-memory Puter for the service: KV and files. */
function fakePuter(owner) {
  const kv = new Map(), files = new Map();
  return {
    auth: { getUser: async () => owner },
    kv: {
      async get(k) { return kv.has(k) ? structuredClone(kv.get(k)) : null; },
      async set(k, v) { kv.set(k, structuredClone(v)); return true; },
      async del(k) { kv.delete(k); return true; },
      async incr(k, n = 1) { const v = Number(kv.get(k) || 0) + n; kv.set(k, v); return v; },
      async list({ pattern, cursor }) { const keys = [...kv.keys()].filter(k => k.startsWith(pattern)).sort(); const at = Number(cursor || 0), end = at + 2; return { items: keys.slice(at, end).map(key => ({ key, value: structuredClone(kv.get(key)) })), cursor: end < keys.length ? String(end) : undefined }; },
    },
    fs: {
      async write(path, data) { files.set(path, data); return { path }; },
      async read(path) { if (!files.has(path)) throw new Error('missing'); return new Blob([files.get(path)]); },
      async stat(path) { if (!files.has(path)) throw new Error('missing'); return {}; },
    },
  };
}
const OWNER = { uuid: 'owner-1', username: 'ada' }, BOB = { uuid: 'user-2', username: 'bob' }, EVE = { uuid: 'user-3', username: 'eve' };

async function sharedRoom() {
  const service = new RoomService(fakePuter(OWNER), { rooms: new Map() });
  const doc = createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('Shared text')]), storyEdits: {} } }));
  await service.call(OWNER, { op: 'create', room: 'room1', name: 'Plan', initial: encode(Y.encodeStateAsUpdate(doc)), base: encode(new Uint8Array([80, 75, 3, 4])) });
  return { service, doc };
}
const editAs = async (service, user, edit) => {
  const synced = await service.call(user, { op: 'sync', room: 'room1' });
  const doc = new Y.Doc(); Y.applyUpdate(doc, decode(synced.update));
  const before = Y.encodeStateVector(doc);
  edit(doc);
  return service.call(user, { op: 'commit', room: 'room1', update: encode(Y.encodeStateAsUpdate(doc, before)) });
};

describe('room service', () => {
  it('admits invited people with their role and keeps strangers out', async () => {
    const { service } = await sharedRoom();
    await expect(service.call(BOB, { op: 'join', room: 'room1' })).rejects.toMatchObject({ status: 403 });
    await service.call(OWNER, { op: 'invite-user', room: 'room1', username: 'bob', role: 'commenter' });
    expect((await service.call(BOB, { op: 'join', room: 'room1' })).role).toBe('commenter');
    const { token } = await service.call(OWNER, { op: 'invite', room: 'room1', role: 'viewer' });
    expect((await service.call(EVE, { op: 'join', room: 'room1', token })).role).toBe('viewer');
    const { members, named } = await service.call(OWNER, { op: 'members', room: 'room1' });
    expect(members.map(m => [m.username, m.role]).sort()).toEqual([['ada', 'owner'], ['bob', 'commenter'], ['eve', 'viewer']]);
    expect(named.map(n => n.username)).toEqual(['bob']);
    // Only the owner manages access.
    await expect(service.call(BOB, { op: 'invite', room: 'room1', role: 'editor' })).rejects.toMatchObject({ status: 403 });
  });

  it('enforces roles on commits: viewers cannot write, commenters only comment', async () => {
    const { service } = await sharedRoom();
    const { token } = await service.call(OWNER, { op: 'invite', room: 'room1', role: 'viewer' });
    await service.call(EVE, { op: 'join', room: 'room1', token });
    await expect(editAs(service, EVE, doc => doc.getText('body').insert(0, 'x'))).rejects.toMatchObject({ status: 403 });
    await service.call(OWNER, { op: 'invite-user', room: 'room1', username: 'bob', role: 'commenter' });
    await service.call(BOB, { op: 'join', room: 'room1' });
    await expect(editAs(service, BOB, doc => doc.getText('body').insert(0, 'x'))).rejects.toMatchObject({ status: 403 });
    await editAs(service, BOB, doc => doc.getMap('comments').set('0', JSON.stringify({ id: '0', author: 'bob', text: 'Hi' })));
    // Editors change the text, and everyone reads the merged state.
    await service.call(OWNER, { op: 'role', room: 'room1', uuid: BOB.uuid, role: 'editor' });
    await editAs(service, BOB, doc => doc.getText('body').insert(0, 'Our '));
    const synced = await service.call(EVE, { op: 'sync', room: 'room1' });
    const doc = new Y.Doc(); Y.applyUpdate(doc, decode(synced.update));
    const state = readState(doc);
    expect(state.paragraphs[0].runs.map(r => r.text).join('')).toBe('Our Shared text');
    expect(state.comments.map(c => c.text)).toEqual(['Hi']);
  });

  it('returns the base document, the roster with presence, and only missing updates', async () => {
    const { service } = await sharedRoom();
    expect(decode((await service.call(OWNER, { op: 'base', room: 'room1' })).base)).toEqual(new Uint8Array([80, 75, 3, 4]));
    const first = await service.call(OWNER, { op: 'sync', room: 'room1', presence: { session: 's1', anchor: null } });
    expect(first.roster.map(p => [p.session, p.name])).toEqual([['s1', 'ada']]);
    const doc = new Y.Doc(); Y.applyUpdate(doc, decode(first.update));
    const again = await service.call(OWNER, { op: 'sync', room: 'room1', vector: encode(Y.encodeStateVector(doc)) });
    expect(decode(again.update).length).toBeLessThan(4);
    await service.call(OWNER, { op: 'leave', room: 'room1', session: 's1' });
    expect((await service.call(OWNER, { op: 'sync', room: 'room1' })).roster).toEqual([]);
  });

  it('closes the room when the owner stops sharing', async () => {
    const { service } = await sharedRoom();
    await service.call(OWNER, { op: 'stop', room: 'room1' });
    await expect(service.call(OWNER, { op: 'sync', room: 'room1' })).rejects.toMatchObject({ status: 410 });
  });

  it('refuses room creation by anyone but the worker owner', async () => {
    const service = new RoomService(fakePuter(OWNER), { rooms: new Map() });
    await expect(service.call(BOB, { op: 'create', room: 'x', initial: '', base: '' })).rejects.toMatchObject({ status: 403 });
  });

  it('reads compressed token claims', () => {
    const payload = btoa(JSON.stringify({ t: 't', uu: '3q2-7w', exp: 10 })).replace(/=+$/, '');
    expect(tokenClaims(`x.${payload}.y`).type).toBe('access-token');
  });
});
