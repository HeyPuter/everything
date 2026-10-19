import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { roomStatus } from '../src/ui/coauthor.js';
import { environment, owner, SERVER, until } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

it('still says Offline after a save with nothing to send while the connection is gone', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan', file: null });
  const client = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 60_000, noPeers: true });
  open.push(client);
  await client.open();
  env.offline = true;
  client.scheduleSync(0);
  await until(() => client.status.state === 'offline', 4000, 'offline');
  // Saving delivers what is pending first: here nothing, so nothing reached the room.
  await client.flush();
  expect(client.status.state).toBe('offline');
  expect(roomStatus(client)[1]).toBe('Offline');
  // A change made now waits, and goes once the room answers again.
  client.wb.setInput(client.wb.sheets[0].id, 0, 0, 'later');
  await client.settled();
  expect(roomStatus(client)[1]).toBe('Offline · 1 change waiting');
  env.offline = false;
  await client.flush();
  expect(client.status.state).toBe('connected');
});
