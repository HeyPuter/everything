import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { Doc } from '../src/lib/doc.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { environment, owner, SERVER, until } from './collab-helpers.js';

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
afterEach(() => { delete globalThis.puter; vi.useRealTimers(); });

const path = '/alice/Spreadsheets/Budget.xlsx';

// The owner's browser writes a shared workbook's file a quiet moment after the last change. When that write failed (a
// full drive, a dropped connection), nothing tried it again and nothing counted it as still to do: leaving went
// without a word, and the file kept missing the last changes until someone changed the workbook again.
it("keeps the owner's file due, and tries it again, when writing it failed", async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Budget' }] });
  env.files.set(path, new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()));
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Budget', file: { path, uid: 'u1' } });
  globalThis.puter = env.sdk(owner);
  const client = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 60_000, noPeers: true, toXlsx: (w) => workbookToXlsx(w) });
  await client.open();
  const doc = Doc.forRoom(client, { path, uid: 'u1' });
  const fileA1 = async () => { const file = await workbookFromFile(env.files.get(path).buffer, 'Budget.xlsx'); return file.getValue(file.sheets[0].id, 0, 0); };
  // Neither the worker nor the owner's browser can write the file for now.
  let full = true;
  for (const fs of [env.workerPuter.fs, puter.fs]) {
    const write = fs.write;
    fs.write = async (p, ...rest) => { if (full && p === path) throw new Error('Storage capacity limit reached.'); return write(p, ...rest); };
  }
  client.wb.setInput(client.wb.sheets[0].id, 0, 0, 'last edit');
  await until(() => !client.replica.pending.length, 4000, 'delivery');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  expect(await doc.save({ auto: true })).toBe(false);
  // Still to be written: leaving saves it (or says it could not), rather than leave the file behind.
  expect(doc.hasPendingWrites).toBe(true);
  full = false;
  await vi.advanceTimersByTimeAsync(9000);
  vi.useRealTimers();
  await until(async () => (await fileA1()) === 'last edit', 4000, 'the file to be written');
  await until(() => !doc.hasPendingWrites, 4000, 'nothing left to write');
  client.close();
});
