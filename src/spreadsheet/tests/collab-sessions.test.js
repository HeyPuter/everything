import { afterEach, describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { environment, owner, editor, viewer, stranger, SERVER, until } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

async function setup() {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Budget' }] });
  wb.setInput(wb.sheets[0].id, 0, 0, 'Item');
  wb.setInput(wb.sheets[0].id, 0, 1, 'Cost');
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Budget', file: { path: '/alice/Spreadsheets/Budget.xlsx', uid: 'u1' } });
  const invite = async (role) => (await call(env.sdk(owner), SERVER, { op: 'invite', room, role })).token;
  const join = async (user, { token, store = memoryOutbox(), ...rest } = {}) => {
    const client = new RoomClient({ puter: env.sdk(user), server: SERVER, room, token, store, poll: 50, noPeers: true, ...rest });
    open.push(client);
    await client.open();
    return client;
  };
  return { env, room, invite, join };
}

const value = (c, r, col) => c.wb.getValue(c.wb.sheets[0].id, r, col);

describe('co-authoring sessions', () => {
  it('opens the shared workbook for its owner and an invited editor, and carries edits both ways', async () => {
    const { invite, join } = await setup();
    const a = await join(owner);
    const b = await join(editor, { token: await invite('editor') });
    expect(b.role).toBe('editor');
    expect(value(b, 0, 0)).toBe('Item');
    const s = a.wb.sheets[0].id;
    a.wb.setInput(s, 1, 0, 'Rent');
    b.wb.setInput(s, 1, 1, '1200');
    await until(() => value(a, 1, 1) === 1200 && value(b, 1, 0) === 'Rent', 4000, 'edits to arrive');
    expect(a.status.state).toBe('connected');
  });

  it('merges concurrent edits through the worker\'s ordering', async () => {
    const { invite, join } = await setup();
    const a = await join(owner);
    const b = await join(editor, { token: await invite('editor') });
    const s = a.wb.sheets[0].id;
    a.wb.insertRows(s, 1, 1);
    a.wb.setInput(s, 1, 0, 'from a');
    b.wb.setInput(s, 1, 0, 'from b');
    await until(() => !a.replica.pending.length && !b.replica.pending.length, 4000, 'delivery');
    await a.sync();
    await b.sync();
    expect([value(a, 1, 0), value(a, 2, 0)]).toEqual([value(b, 1, 0), value(b, 2, 0)]);
    expect([value(a, 1, 0), value(a, 2, 0)].sort()).toEqual(['from a', 'from b']);
  });

  it('refuses a viewer\'s changes in the worker, not only in the browser', async () => {
    const { env, room, invite, join } = await setup();
    const v = await join(viewer, { token: await invite('viewer') });
    expect(v.role).toBe('viewer');
    // The browser takes a viewer's edit back at once…
    v.wb.setInput(v.wb.sheets[0].id, 3, 3, 'nope');
    expect(value(v, 3, 3)).toBe(null);
    // …and the worker refuses a commit sent around it.
    const forged = { id: 'abcdefgh1234', label: 'Edit', ops: [{ t: 'cells', s: v.wb.sheets[0].id, v: { '3,3': { v: 'nope', f: null } } }] };
    await expect(call(env.sdk(viewer), SERVER, { op: 'commit', room, base: v.replica.rev, changes: [forged] })).rejects.toMatchObject({ status: 403 });
    await expect(call(env.sdk(viewer), SERVER, { op: 'checkpoint', room, rev: 0, state: 'x' })).rejects.toMatchObject({ status: 403 });
  });

  it('keeps people without an invitation out', async () => {
    const { env, room } = await setup();
    await expect(call(env.sdk(stranger), SERVER, { op: 'join', room })).rejects.toMatchObject({ status: 403 });
    await expect(call(env.sdk(stranger), SERVER, { op: 'sync', room, since: 0 })).rejects.toMatchObject({ status: 403 });
    await expect(call(env.sdk(stranger), SERVER, { op: 'join', room, token: 'not-a-real-invitation' })).rejects.toMatchObject({ status: 403 });
  });

  it('shows who is here and where', async () => {
    const { invite, join } = await setup();
    const a = await join(owner);
    const b = await join(editor, { token: await invite('editor') });
    const s = a.wb.sheets[0].id;
    b.setPresence({ sheet: s, sel: { r1: 2, c1: 1, r2: 4, c2: 2 }, active: { r: 2, c: 1 } });
    await b.checkIn();
    await a.checkIn();
    await until(() => [...a.people.values()].some((p) => p.username === 'bob' && p.state?.sel?.r2 === 4), 4000, 'presence');
    const bob = [...a.people.values()].find((p) => p.username === 'bob');
    expect(bob.state).toMatchObject({ sheet: s, active: { r: 2, c: 1 } });
  });

  it('queues edits made offline and merges them on reconnect, across a reload', async () => {
    const { env, invite, join } = await setup();
    const token = await invite('editor');
    const store = memoryOutbox();
    const a = await join(owner);
    const b = await join(editor, { token, store });
    const s = a.wb.sheets[0].id;
    env.offlineUsers.add(editor.uuid);
    b.wb.setInput(s, 5, 0, 'offline 1');
    b.wb.insertRows(s, 0, 1);
    b.wb.setInput(s, 0, 0, 'offline header');
    await until(() => b.status.state === 'offline', 4000, 'the failed send to show as offline');
    expect(b.status.pending).toBeGreaterThan(0);
    a.wb.setInput(s, 3, 3, 'online');
    await until(() => !a.replica.pending.length, 4000, 'a delivers');
    // b's tab closes while offline; its changes wait in the outbox.
    b.close();
    expect((await store.get(b.room)).pending.length).toBeGreaterThan(0);
    env.offlineUsers.delete(editor.uuid);
    const again = await join(editor, { token, store });
    await until(() => !again.replica.pending.length, 4000, 'queued edits delivered');
    await a.sync();
    for (const c of [a, again]) {
      expect(value(c, 0, 0)).toBe('offline header');
      expect(value(c, 6, 0)).toBe('offline 1');
      expect(value(c, 4, 3)).toBe('online'); // moved down by b's row
    }
    expect(await store.get(again.room)).toBe(null);
  });

  it('writes checkpoints that later joiners start from, and the .xlsx over the owner\'s file', async () => {
    const { env, room, invite, join } = await setup();
    const a = await join(owner, { toXlsx: async () => new Blob([new Uint8Array([0x50, 0x4b, 3, 4])]) });
    const s = a.wb.sheets[0].id;
    for (let i = 0; i < 5; i++) a.wb.setInput(s, 2 + i, 0, `row ${i}`);
    await until(() => !a.replica.pending.length, 4000, 'delivery');
    const res = await a.checkpoint({ file: true });
    expect(res).toMatchObject({ saved: true, wrote: true });
    expect(env.files.get('/alice/Spreadsheets/Budget.xlsx')).toBeInstanceOf(Uint8Array);
    const cp = await env.kv.get(`ss:${room}:cp`);
    expect(cp.rev).toBe(a.replica.rev);
    const b = await join(editor, { token: await invite('editor') });
    expect(b.replica.rev).toBe(a.replica.rev);
    expect(value(b, 6, 0)).toBe('row 4');
  });

  it('lets only the owner manage access, and applies a role change to an open session', async () => {
    const { env, room, invite, join } = await setup();
    const b = await join(editor, { token: await invite('editor') });
    await expect(call(env.sdk(editor), SERVER, { op: 'invite', room, role: 'editor' })).rejects.toMatchObject({ status: 403 });
    await call(env.sdk(owner), SERVER, { op: 'role', room, uuid: editor.uuid, role: 'viewer' });
    await b.sync();
    expect(b.role).toBe('viewer');
    expect(b.replica.readOnly).toBe(true);
    await call(env.sdk(owner), SERVER, { op: 'role', room, uuid: editor.uuid, role: 'removed' });
    await expect(b.sync()).rejects.toMatchObject({ status: 403 });
  });

  it('closes the room for everyone when the owner stops sharing', async () => {
    const { env, room, invite, join } = await setup();
    const b = await join(editor, { token: await invite('editor') });
    let closed = null;
    b.addEventListener('closed', (e) => { closed = e.detail.message; });
    await call(env.sdk(owner), SERVER, { op: 'stop', room });
    await b.sync().catch((e) => b.failed(e));
    expect(closed).toMatch(/stopped sharing/);
  });

  it('serves the same log from another worker instance', async () => {
    const { env, invite, join } = await setup();
    const a = await join(owner);
    const s = a.wb.sheets[0].id;
    a.wb.setInput(s, 9, 0, 'first');
    await until(() => !a.replica.pending.length, 4000, 'delivery');
    const other = env.instance();
    env.route = (user) => (user.uuid === editor.uuid ? other : undefined);
    const b = await join(editor, { token: await invite('editor') });
    expect(value(b, 9, 0)).toBe('first');
    b.wb.setInput(s, 9, 1, 'second');
    a.wb.setInput(s, 9, 2, 'third');
    await until(() => value(a, 9, 1) === 'second' && value(b, 9, 2) === 'third', 4000, 'edits across instances');
  });
});
