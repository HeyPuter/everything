import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { stopSharing } from '../src/collab/session.js';
import { Doc } from '../src/lib/doc.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { environment, owner, editor, SERVER, until } from './collab-helpers.js';

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); delete globalThis.puter; });

const path = '/alice/Spreadsheets/Plan.xlsx';

async function setup() {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  env.files.set(path, new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()));
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan', file: { path, uid: 'u1' } });
  globalThis.puter = env.sdk(owner);
  const join = async (user, token) => {
    // The owner's browser has not heard of the latest change yet: its next poll is a while away.
    const client = new RoomClient({ puter: env.sdk(user), server: SERVER, room, token, store: memoryOutbox(), poll: 60_000, noPeers: true, toXlsx: (w) => workbookToXlsx(w) });
    open.push(client);
    await client.open();
    client.subscription?.off();
    return client;
  };
  const mine = await join(owner);
  const theirs = await join(editor, (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token);
  const doc = Doc.forRoom(mine, { path, uid: 'u1' });
  const fileA1 = async () => {
    const file = await workbookFromFile(env.files.get(path).buffer, 'Plan.xlsx');
    return file.getValue(file.sheets[0].id, 0, 0);
  };
  return { env, mine, theirs, doc, fileA1 };
}

it("writes everyone's changes that reached the room to the owner's file when the owner stops sharing", async () => {
  const { theirs, doc, fileA1 } = await setup();
  theirs.wb.setInput(theirs.wb.sheets[0].id, 0, 0, 'from bob');
  await until(() => !theirs.replica.pending.length, 4000, 'delivery');
  // "The file keeps every change made so far."
  await stopSharing(doc);
  expect(await fileA1()).toBe('from bob');
});

it("saves the shared workbook as the room has it, not as this browser last heard of it", async () => {
  const { theirs, doc, fileA1 } = await setup();
  theirs.wb.setInput(theirs.wb.sheets[0].id, 0, 0, 'from bob');
  await until(() => !theirs.replica.pending.length, 4000, 'delivery');
  await doc.save();
  expect(await fileA1()).toBe('from bob');
});

it("keeps the workbook shared when the owner's file cannot take its last changes, rather than closing the room on them", async () => {
  const { env, mine, theirs, doc, fileA1 } = await setup();
  theirs.wb.setInput(theirs.wb.sheets[0].id, 0, 0, 'from bob');
  await until(() => !theirs.replica.pending.length, 4000, 'delivery');
  // Neither the room's worker nor the owner's browser can write the file (the owner's drive is full).
  const full = () => Promise.reject(Object.assign(new Error('Your storage is full.'), { code: 'storage_limit_reached' }));
  env.workerPuter.fs.write = full;
  globalThis.puter.fs.write = full;
  await expect(stopSharing(doc)).rejects.toThrow(/storage is full/);
  expect(await fileA1()).toBe(null);
  // Nobody was shut out: the changes are still in the room, for the next try.
  expect((await mine.request({ op: 'sync', since: 0 })).head).toBeGreaterThan(0);
  theirs.wb.setInput(theirs.wb.sheets[0].id, 1, 0, 'still here');
  await until(() => !theirs.replica.pending.length, 4000, 'a later change');
});
