import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { Doc } from '../src/lib/doc.js';
import { workbookToXlsx } from '../src/core/io.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { environment, owner, SERVER, until } from './collab-helpers.js';

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
afterEach(() => { delete globalThis.puter; vi.restoreAllMocks(); });

const path = 'Spreadsheets/Budget.xlsx';

// A file's history keeps a snapshot of it every ten minutes or so as it is saved. A shared workbook's file is saved
// by its owner's browser too, but that save took no snapshots: while a workbook was edited together, the time it most
// needs one (anyone in it can change anything), Version history had nothing to go back to but snapshots taken by hand.
it("keeps snapshots of a shared workbook's file in its history as its owner's browser saves it", async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Budget' }] });
  env.files.set(path, new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()));
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Budget', file: { path, uid: 'u1' } });
  globalThis.puter = env.sdk(owner);
  const client = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 50, noPeers: true, toXlsx: (w) => workbookToXlsx(w) });
  await client.open();
  const doc = Doc.forRoom(client, { path, uid: 'u1' });
  client.wb.setInput(client.wb.sheets[0].id, 0, 0, 'worth keeping');
  await until(() => !client.replica.pending.length, 4000, 'delivery');
  expect(await doc.save()).toBe(true);
  await until(() => [...env.files.keys()].some((p) => p.startsWith('Spreadsheets/.versions/')), 4000, 'a snapshot');
  client.close();
});
