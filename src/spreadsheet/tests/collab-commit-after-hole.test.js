import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { environment, owner, SERVER, until, wait } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

// A commit that failed half way leaves its place in the log claimed, and the room takes nothing else there until it
// gives that place up, twenty seconds on. A browser sending a change meanwhile asked fifty times in a row, as fast as the
// room answered, then gave up: the change stayed on screen, "Syncing…", reaching nobody until the next edit sent it.
it('sends a change again shortly while the room\'s next place is held, and delivers it once the room gives it up', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const alice = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 50, noPeers: true });
  open.push(alice);
  await alice.open();
  await env.kv.incr(`ss:${room}:claim:000000000001`); // a commit elsewhere claimed revision 1 and never wrote it
  const commits = () => env.calls.filter((c) => c.op === 'commit').length;
  alice.wb.setInput(alice.wb.sheets[0].id, 0, 0, 'mine');
  await wait(1500);
  expect(commits()).toBeLessThan(5);
  expect(alice.replica.pending).toHaveLength(1);
  env.now += 21_000; // the room gives the place up
  await until(() => !alice.replica.pending.length, 6000, 'delivery');
  expect(alice.replica.rev).toBe(2);
  expect((await env.service.call(owner, { op: 'sync', room, since: 1 })).records[0].changes[0].ops[0].v['0,0'].v).toBe('mine');
});
