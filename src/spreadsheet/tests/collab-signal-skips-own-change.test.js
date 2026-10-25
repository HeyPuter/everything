import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { editor, environment, owner, SERVER, until, wait } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

// Every accepted change also signals the room, and the browser that made it read that notice as news: each edit cost
// its author a second round trip to the worker for records it already had.
it("skips the synchronization a notice of its own change asks for, while everyone else still synchronizes", async () => {
  const env = environment();
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb: new Workbook({ sheets: [{ name: 'Plan' }] }), name: 'Plan' });
  await env.service.call(owner, { op: 'invite-user', room, username: editor.username, role: 'editor' });
  const [alice, bob] = [owner, editor].map((user) => new RoomClient({ puter: env.sdk(user), server: SERVER, room, store: memoryOutbox(), poll: 60_000, noPeers: true }));
  open.push(alice, bob);
  await alice.open();
  await bob.open();
  await wait(250);
  const syncs = (user) => env.calls.filter((c) => c.op === 'sync' && c.user === user.uuid).length;
  const before = { alice: syncs(owner), bob: syncs(editor) };
  alice.wb.setInput(alice.wb.sheets[0].id, 0, 0, 'mine');
  await until(() => bob.replica.rev === 1, 4000, "bob's copy");
  await wait(250);
  expect(syncs(owner)).toBe(before.alice);
  expect(syncs(editor)).toBeGreaterThan(before.bob);
});
