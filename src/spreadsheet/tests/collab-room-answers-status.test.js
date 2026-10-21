import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call, CollabError } from '../src/collab/api.js';
import { roomStatus } from '../src/ui/coauthor.js';
import { environment, owner, editor, SERVER } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

async function room(env) {
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  return RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
}

// The room turning this person away from its list of who is here (it holds as many as it takes) is no lost
// connection: their changes still go through. The status said "Offline", and that the changes were kept until
// the connection returned, flickering back to Live at each synchronization.
it("says the room is full, not Offline, when it has no place for this person's presence", async () => {
  const env = environment();
  const id = await room(env);
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room: id, role: 'editor' })).token;
  // Bob is here already in as many tabs as one person may be.
  for (let n = 0; n < 16; n++) {
    const session = `bobtab${String(n).padStart(2, '0')}`;
    env.data.set(`ss:${id}:presence:${session}`, { room: id, session, user: editor.uuid, username: 'bob', role: 'editor', expires: env.now + 90_000, at: env.now });
  }
  const bob = new RoomClient({ puter: env.sdk(editor), server: SERVER, room: id, token, store: memoryOutbox(), poll: 60_000, noPeers: true });
  open.push(bob);
  await bob.open();
  await bob.checkIn().catch(() => {});
  expect(bob.status.state).toBe('connected');
  const [, label, title] = roomStatus(bob);
  expect(label).toBe('Live · Saved');
  expect(title).toMatch(/participant limit/);
  // Edits still go through.
  bob.wb.setInput(bob.wb.sheets[0].id, 0, 0, 'still saved');
  await bob.settled();
  expect(bob.replica.pending).toHaveLength(0);
  expect(bob.status.state).toBe('connected');
  // A place frees up: the status says no more of it.
  for (const key of [...env.data.keys()]) if (key.includes(':presence:bobtab')) env.data.delete(key);
  await bob.checkIn();
  expect(roomStatus(bob)[2]).not.toMatch(/participant limit/);
});

// The room answering that this copy is ahead of it is no lost connection either: the status said "Offline", with the
// room's "Open it again" beside the promise that the changes are sent when the connection returns.
it('says the room answered that this copy is ahead of it, and Live again once the room catches up', async () => {
  const env = environment();
  const id = await room(env);
  const alice = new RoomClient({ puter: env.sdk(owner), server: SERVER, room: id, store: memoryOutbox(), poll: 60_000, noPeers: true });
  open.push(alice);
  await alice.open();
  const request = alice.request.bind(alice);
  let ahead = true;
  alice.request = (input) => (ahead && input.op === 'sync' ? Promise.reject(new CollabError('This copy is ahead of the shared workbook. Open it again.', 409)) : request(input));
  await alice.sync().catch((e) => alice.failed(e));
  expect(alice.status.state).toBe('error');
  expect(roomStatus(alice).slice(1)).toEqual(['Not connected', 'This copy is ahead of the shared workbook. Open it again.']);
  expect(alice.halted).toBeFalsy();
  ahead = false;
  await alice.sync();
  expect(alice.status.state).toBe('connected');
});
