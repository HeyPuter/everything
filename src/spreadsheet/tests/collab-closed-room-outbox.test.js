import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { environment, owner, editor, SERVER, until } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

// Changes made offline to a shared workbook whose owner stopped sharing meanwhile can never be sent: nothing opens a
// closed room again. Their record stayed in this browser's database all the same, for good (until signing out).
it('lets go of the unsent changes kept for a room that was closed', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const store = memoryOutbox();
  const bob = new RoomClient({ puter: env.sdk(editor), server: SERVER, room, token, store, poll: 60_000, noPeers: true });
  open.push(bob);
  await bob.open();
  env.offlineUsers.add(editor.uuid);
  bob.wb.setInput(bob.wb.sheets[0].id, 0, 0, 'offline edit');
  await until(() => bob.status.state === 'offline', 4000, 'offline');
  await until(async () => (await store.get(bob.outboxKey))?.pending.length === 1, 4000, 'the change to be kept');
  await call(env.sdk(owner), SERVER, { op: 'stop', room });
  env.offlineUsers.delete(editor.uuid);
  bob.resume();
  await until(() => bob.halted, 4000, 'the room to close');
  await until(async () => (await store.get(bob.outboxKey)) === null, 4000, 'the record to go');
  // What is on screen stays, for Save a copy; an edit made there now is not kept for the room either.
  expect(bob.wb.getValue(bob.wb.sheets[0].id, 0, 0)).toBe('offline edit');
  bob.wb.setInput(bob.wb.sheets[0].id, 1, 0, 'after');
  await bob.settled();
  await new Promise((r) => setTimeout(r, 50));
  expect(await store.get(bob.outboxKey)).toBe(null);
});
