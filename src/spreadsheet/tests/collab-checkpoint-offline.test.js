import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { environment, owner, SERVER, until, wait } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); vi.restoreAllMocks(); });

it('does not pack the whole workbook every few seconds for a checkpoint that cannot be written while offline', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const client = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 50, noPeers: true });
  open.push(client);
  await client.open();
  client.wb.setInput(client.wb.sheets[0].id, 0, 0, 'x');
  await until(() => !client.replica.pending.length && client.replica.rev === 1, 4000, 'delivery');
  // A minute has gone by since the last checkpoint, and the connection drops.
  env.offline = true;
  client.lastCheckpointAt = Date.now() - 61_000;
  const packed = vi.spyOn(client.replica, 'checkpoint');
  await wait(4500); // two of the client's two-second ticks, and then some
  expect(packed.mock.calls.length).toBeLessThanOrEqual(1);
});
