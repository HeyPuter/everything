import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { peopleHere } from '../src/ui/coauthor.js';
import { environment, owner, editor, SERVER, until, wait } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

// Without live peer links, people are known from the worker's check-ins, which say when each person last checked in by
// the worker's clock. They were timed out by this browser's: on a computer whose clock ran a few minutes fast, everyone
// else was taken off the list at the next tick after each check-in, and showed for two seconds in every fifteen.
it('keeps showing the others on a computer whose clock runs a few minutes ahead of the worker\'s', async () => {
  const env = environment();
  env.now = Date.now() - 5 * 60_000; // the worker's clock, five minutes behind this one
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
  bob.tick();
  expect(peopleHere(bob).map((p) => p.name)).toEqual(['alice']);
  await wait(2500); // a tick of the client's own
  expect(peopleHere(bob).map((p) => p.name)).toEqual(['alice']);
});
