import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { RoomService } from '../src/collab/server/service.js';
import { createSharedDoc, readState } from '../src/collab/shared-doc.js';
import { editorState } from '../src/collab/binding.js';
import { encode, decode } from '../src/collab/protocol.js';
import { tokenClaims } from '../src/collab/auth.js';
import { WorkerTransport } from '../src/collab/transports.js';

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

  it('keeps the edit log readable after a commit whose record could not be stored', async () => {
    const { service } = await sharedRoom();
    const write = service.fs.write;
    let failNext = true;
    service.fs.write = async (path, data, options) => {
      if (failNext && path.includes('/log/')) { failNext = false; throw new Error('network'); }
      return write(path, data, options);
    };
    // A large change goes to a file of its own; that write fails once, and the client sends the change again.
    const big = 'x'.repeat(90_000);
    const synced = await service.call(OWNER, { op: 'sync', room: 'room1' });
    const local = new Y.Doc(); Y.applyUpdate(local, decode(synced.update));
    const before = Y.encodeStateVector(local);
    local.getText('body').insert(0, big);
    const update = encode(Y.encodeStateAsUpdate(local, before));
    await expect(service.call(OWNER, { op: 'commit', room: 'room1', update })).rejects.toThrow('network');
    await service.call(OWNER, { op: 'commit', room: 'room1', update });
    // Storing a small change's record fails once too.
    const set = service.kv.set;
    let failSet = true;
    service.kv.set = async (key, value, ...rest) => {
      if (failSet && key.includes(':log:')) { failSet = false; throw new Error('kv down'); }
      return set(key, value, ...rest);
    };
    await expect(editAs(service, OWNER, doc => doc.getText('body').insert(0, 'Lost? '))).rejects.toThrow('kv down');
    await editAs(service, OWNER, doc => doc.getText('body').insert(0, 'Later. '));
    // Another worker instance (or this one after a restart) reads the room from the log.
    const fresh = new RoomService(service.puter, { rooms: new Map() });
    const doc = new Y.Doc(); Y.applyUpdate(doc, decode((await fresh.call(OWNER, { op: 'sync', room: 'room1' })).update));
    const body = doc.getText('body').toString();
    expect(body.startsWith('Later. ')).toBe(true);
    expect(body).toContain(big);
  });

  it('passes on a deletion that arrives without any insertion over the worker transport', async () => {
    const { service } = await sharedRoom();
    await service.call(OWNER, { op: 'invite-user', room: 'room1', username: 'bob', role: 'editor' });
    const transport = new WorkerTransport({ call: (op, input) => service.call(BOB, { op, ...input }), room: 'room1' });
    const updates = [];
    await transport.join({ session: 'bob-tab', update: u => updates.push(u), presence() {}, role() {}, closed() {} });
    clearTimeout(transport.timer);
    await editAs(service, OWNER, doc => doc.getText('body').delete(6, 5));
    await transport.poll(); clearTimeout(transport.timer);
    expect(updates).toHaveLength(1);
    expect(transport.doc.getText('body').toString().startsWith('Shared')).toBe(true);
    expect(transport.doc.getText('body').toString()).not.toContain('text');
    // Later answers repeat the deletion; nothing new is passed on.
    await transport.poll(); clearTimeout(transport.timer);
    expect(updates).toHaveLength(1);
    await transport.leave();
  });

  it('reads compressed token claims', () => {
    const payload = btoa(JSON.stringify({ t: 't', uu: '3q2-7w', exp: 10 })).replace(/=+$/, '');
    expect(tokenClaims(`x.${payload}.y`).type).toBe('access-token');
  });
});
