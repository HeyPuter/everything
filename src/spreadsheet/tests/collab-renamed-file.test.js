import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { Doc, setAutoSaveEnabled } from '../src/lib/doc.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { environment, owner, editor, SERVER, until } from './collab-helpers.js';

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
afterEach(() => { delete globalThis.puter; setAutoSaveEnabled(true); });

const before = '/alice/Spreadsheets/Budget.xlsx';
const after = '/alice/Documents/Budget 2026.xlsx';

async function renamedRoom() {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Budget' }] });
  env.files.set(before, new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()));
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Budget', file: { path: before, uid: 'u1' } });
  // The owner renames and moves the file on the desktop; opening it again finds its room by the file's id.
  env.files.set(after, env.files.get(before));
  env.files.delete(before);
  globalThis.puter = env.sdk(owner);
  const join = async (user, token) => {
    const client = new RoomClient({ puter: env.sdk(user), server: SERVER, room, token, store: memoryOutbox(), poll: 50, noPeers: true, toXlsx: (w) => workbookToXlsx(w) });
    await client.open();
    return client;
  };
  const a1 = async (path) => {
    const file = await workbookFromFile(env.files.get(path).buffer, 'Budget.xlsx');
    return file.getValue(file.sheets[0].id, 0, 0);
  };
  return { env, room, join, a1 };
}

it("saves a shared workbook to its owner's file where the file is now, after it was renamed or moved", async () => {
  const { join, env, a1 } = await renamedRoom();
  const client = await join(owner);
  const doc = Doc.forRoom(client, { path: after, uid: 'u1' });
  expect(doc.path).toBe(after);
  client.wb.setInput(client.wb.sheets[0].id, 0, 0, 'kept');
  await doc.save();
  expect(await a1(after)).toBe('kept');
  // Nothing is written at the address the file left.
  expect(env.files.has(before)).toBe(false);
  client.close();
});

it("writes the file where its owner last saved it when someone else saves the shared workbook", async () => {
  const { join, env, room, a1 } = await renamedRoom();
  const mine = await join(owner);
  const doc = Doc.forRoom(mine, { path: after, uid: 'u1' });
  await doc.save();
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const theirs = await join(editor, token);
  theirs.wb.setInput(theirs.wb.sheets[0].id, 0, 0, 'from bob');
  await until(() => !theirs.replica.pending.length, 4000, 'delivery');
  const res = await theirs.checkpoint({ file: true });
  expect(res.wrote).toBe(true);
  expect(await a1(after)).toBe('from bob');
  expect(env.files.has(before)).toBe(false);
  mine.close();
  theirs.close();
});

// The room keeps the name the workbook had when sharing started: the owner opening the renamed file saw that old name
// in the title bar, as if the rename had been undone, while saving went to the file under its new one.
it("shows the owner a shared workbook under its file's name now, after the file was renamed", async () => {
  const { join } = await renamedRoom();
  const client = await join(owner);
  const doc = Doc.forRoom(client, { path: after, uid: 'u1' });
  expect(doc.name).toBe('Budget 2026');
  client.close();
});

// The worker writes the owner's file where the owner's browser last said it was, which it says when it saves. Renamed in
// the app, the file was not saved again until the owner next changed something: a save by anyone else in the meantime
// wrote a new file at the old name, and the renamed one stopped getting the shared workbook's changes.
it("writes the owner's file under its new name after the owner renames it, whoever saves next", async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Budget' }] });
  env.files.set(before, new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()));
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Budget', file: { path: before, uid: 'u1' } });
  const sdk = env.sdk(owner);
  // Puter says a file that is not there is not found.
  globalThis.puter = { ...sdk, fs: { ...sdk.fs, stat: async (p) => { if (!env.files.has(p)) throw Object.assign(new Error('Not found'), { code: 'subject_does_not_exist' }); return { path: p, size: env.files.get(p).length }; } } };
  const join = async (user, token) => {
    const client = new RoomClient({ puter: env.sdk(user), server: SERVER, room, token, store: memoryOutbox(), poll: 50, noPeers: true, toXlsx: (w) => workbookToXlsx(w) });
    await client.open();
    return client;
  };
  const a1 = async (path) => {
    const file = await workbookFromFile(env.files.get(path).buffer, 'Budget.xlsx');
    return file.getValue(file.sheets[0].id, 0, 0);
  };
  const mine = await join(owner);
  const doc = Doc.forRoom(mine, { path: before, uid: 'u1' });
  expect(await doc.rename('Budget 2026')).toBe(null);
  const renamed = '/alice/Spreadsheets/Budget 2026.xlsx';
  expect(doc.path).toBe(renamed);
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const theirs = await join(editor, token);
  theirs.wb.setInput(theirs.wb.sheets[0].id, 0, 0, 'from bob');
  await until(() => !theirs.replica.pending.length, 4000, 'delivery');
  expect((await theirs.checkpoint({ file: true })).wrote).toBe(true);
  expect(await a1(renamed)).toBe('from bob');
  expect(env.files.has(before)).toBe(false);
  mine.close();
  theirs.close();
});
