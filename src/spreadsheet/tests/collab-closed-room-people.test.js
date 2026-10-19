import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { peopleHere } from '../src/ui/coauthor.js';
import { environment, owner, editor, SERVER, until } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

it('stops showing the others once the owner stopped sharing, rather than their selections frozen where they were', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const join = async (user, invite) => {
    const client = new RoomClient({ puter: env.sdk(user), server: SERVER, room, token: invite, store: memoryOutbox(), poll: 50, noPeers: true });
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
  let told = 0;
  bob.addEventListener('people', () => { told++; });
  await call(env.sdk(owner), SERVER, { op: 'stop', room });
  await until(() => bob.status.state === 'error', 4000, 'the room to close');
  expect(peopleHere(bob)).toEqual([]);
  expect(told).toBeGreaterThan(0);
});
