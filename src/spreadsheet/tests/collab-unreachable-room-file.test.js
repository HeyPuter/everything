import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { startSharing } from '../src/collab/session.js';
import { Doc, SHARED_FILE } from '../src/lib/doc.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { environment, owner, editor, SERVER, until } from './collab-helpers.js';

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
beforeEach(() => { vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: true }); });
afterEach(() => { delete globalThis.puter; vi.unstubAllGlobals(); });

const path = '/alice/Spreadsheets/Budget.xlsx';

// The owner opened their shared workbook's file while its room could not be reached, and the app opened the file on its
// own: what they saved there was written over by the room the next time anyone saved the shared workbook.
it("does not save into a shared workbook's file opened while its room could not be reached", async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Budget' }] });
  env.files.set(path, new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()));
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Budget', file: { path, uid: 'u1' } });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const bob = new RoomClient({ puter: env.sdk(editor), server: SERVER, room, token, store: memoryOutbox(), poll: 60_000, noPeers: true, toXlsx: (w) => workbookToXlsx(w) });
  await bob.open();
  globalThis.puter = env.sdk(owner);
  const stat = puter.fs.stat;
  puter.fs.stat = async (p) => { if (!env.files.has(p)) throw Object.assign(new Error(`${p} does not exist`), { code: 'subject_does_not_exist' }); return stat(p); };
  // The file, opened on its own.
  const file = await workbookFromFile(env.files.get(path).buffer, 'Budget.xlsx');
  const doc = new Doc({ wb: file, name: 'Budget', path, uid: 'u1' });
  doc.remoteModified = 0;
  doc.holdForRoom();
  doc.wb.setInput(doc.wb.sheets[0].id, 0, 0, 'mine');
  expect(await doc.save({ auto: true })).toBe(false);
  expect(doc.status).toBe('error');
  expect(doc.error).toBe(SHARED_FILE);
  await expect(doc.forceSave()).rejects.toThrow(SHARED_FILE);
  await expect(doc.save()).rejects.toThrow(SHARED_FILE);
  // The file is the room's alone, as everyone else's saves keep it.
  bob.wb.setInput(bob.wb.sheets[0].id, 0, 1, 'theirs');
  await until(() => !bob.replica.pending.length, 4000, 'delivery');
  await bob.checkpoint({ file: true });
  const after = await workbookFromFile(env.files.get(path).buffer, 'Budget.xlsx');
  expect(after.getValue(after.sheets[0].id, 0, 1)).toBe('theirs');
  // Starting to share it again would make a second room for the same file.
  await expect(startSharing(doc)).rejects.toThrow(SHARED_FILE);
  // Saved as a copy, the changes are a file of the owner's own, which saves as any does.
  expect(await doc.saveAs('Budget offline')).toBe(null);
  expect(doc.path).toBe('Spreadsheets/Budget offline.xlsx');
  doc.wb.setInput(doc.wb.sheets[0].id, 1, 0, 'more');
  expect(await doc.save()).toBe(true);
  bob.close();
  doc.destroy();
});
