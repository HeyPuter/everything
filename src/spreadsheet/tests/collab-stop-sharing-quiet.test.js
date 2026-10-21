import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { stopSharing } from '../src/collab/session.js';
import { Doc } from '../src/lib/doc.js';
import { workbookToXlsx } from '../src/core/io.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { environment, owner, SERVER, wait } from './collab-helpers.js';

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
afterEach(() => { delete globalThis.puter; });

const path = '/alice/Spreadsheets/Budget.xlsx';

// The owner stopping editing together closes the room, and the room's notice of it reached the owner's own browser
// while the workbook was being opened again as the file: the owner was told "The owner stopped sharing this workbook…
// use File > Save a copy to keep it", as if someone else had closed it on them.
it('does not tell the owner who stopped editing together that the owner stopped sharing it', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Budget' }] });
  env.files.set(path, new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()));
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Budget', file: { path, uid: 'u1' } });
  const sdk = env.sdk(owner);
  // Forgetting the file's room is one more request to Puter, which takes a moment.
  globalThis.puter = { ...sdk, kv: { ...sdk.kv, del: () => wait(400) } };
  const client = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 50, noPeers: true, toXlsx: (w) => workbookToXlsx(w) });
  await client.open();
  const doc = Doc.forRoom(client, { path, uid: 'u1' });
  const closed = [];
  client.addEventListener('closed', (e) => closed.push(e.detail.message));
  await stopSharing(doc);
  await wait(300);
  expect(closed).toEqual([]);
  doc.destroy();
});
