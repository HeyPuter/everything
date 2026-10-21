import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { roomStatus } from '../src/ui/coauthor.js';
import { environment, owner, SERVER, until } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

// Offline, the status pill's tooltip joined the request's own explanation to its own, and both said the changes are
// kept: "Could not reach the shared workbook. Check your connection; your changes are kept and sent when it returns..
// Your changes are kept on this device and sent when the connection returns".
it('explains being offline once, in sentences that end where they should', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const client = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 60_000, noPeers: true });
  open.push(client);
  await client.open();
  env.offline = true;
  client.wb.setInput(client.wb.sheets[0].id, 0, 0, 'later');
  await until(() => client.status.state === 'offline', 4000, 'offline');
  const [, label, title] = roomStatus(client);
  expect(label).toBe('Offline · 1 change waiting');
  expect(title).not.toMatch(/\.\./);
  expect(title.match(/kept/g)).toHaveLength(1);
  // Another reason the room is out of reach still says the changes are kept.
  client.status = { state: 'offline', pending: 1, message: 'Could not synchronize this workbook.' };
  expect(roomStatus(client)[2]).toBe('Could not synchronize this workbook. Your changes are kept on this device and sent when the connection returns');
});
