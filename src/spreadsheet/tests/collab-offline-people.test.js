import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { peopleHere } from '../src/ui/coauthor.js';
import { environment, owner, editor, SERVER, until } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

// Offline, this browser hears from nobody, yet the others' selections stayed on the grid, frozen where they last
// were, for two minutes after their last check-in, as though they were still there and working.
it("takes the others' selections off the grid soon once this browser cannot reach the room", async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const join = async (user, invite) => {
    const client = new RoomClient({ puter: env.sdk(user), server: SERVER, room, token: invite, store: memoryOutbox(), poll: 60_000, noPeers: true });
    open.push(client);
    await client.open();
    return client;
  };
  const alice = await join(owner);
  const bob = await join(editor, token);
  alice.setPresence({ sheet: alice.wb.sheets[0].id, sel: { r1: 1, c1: 1, r2: 2, c2: 2 }, active: { r: 1, c: 1 } });
  await alice.checkIn();
  await bob.checkIn();
  await until(() => peopleHere(bob).length === 1, 4000, 'alice to show');
  env.offlineUsers.add(editor.uuid);
  await bob.checkIn().catch(() => {});
  expect(bob.status.state).toBe('offline');
  // Half a minute without word of her.
  for (const p of bob.people.values()) p.at -= 30_000;
  bob.tick();
  expect(peopleHere(bob)).toEqual([]);
  // Back online, she shows again.
  env.offlineUsers.delete(editor.uuid);
  await bob.checkIn();
  expect(peopleHere(bob)).toHaveLength(1);
});

it('keeps someone who checked in a while ago while the room answers', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const alice = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 60_000, noPeers: true });
  const bob = new RoomClient({ puter: env.sdk(editor), server: SERVER, room, token, store: memoryOutbox(), poll: 60_000, noPeers: true });
  open.push(alice, bob);
  await alice.open();
  await bob.open();
  await bob.checkIn();
  await until(() => peopleHere(bob).length === 1, 4000, 'alice to show');
  // A background tab checks in about once a minute.
  for (const p of bob.people.values()) p.at -= 30_000;
  bob.tick();
  expect(peopleHere(bob)).toHaveLength(1);
});
