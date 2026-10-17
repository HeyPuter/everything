import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { Doc, setAutoSaveEnabled } from '../src/lib/doc.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { environment, owner, SERVER, until, wait } from './collab-helpers.js';

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
afterEach(() => { delete globalThis.puter; setAutoSaveEnabled(true); });

const path = '/alice/Spreadsheets/Budget.xlsx';

async function setup() {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Budget' }] });
  env.files.set(path, new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()));
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Budget', file: { path, uid: 'u1' } });
  globalThis.puter = env.sdk(owner);
  const client = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 50, noPeers: true, toXlsx: (w) => workbookToXlsx(w) });
  await client.open();
  const doc = Doc.forRoom(client, { path, uid: 'u1' });
  const fileA1 = async () => {
    const file = await workbookFromFile(env.files.get(path).buffer, 'Budget.xlsx');
    return file.getValue(file.sheets[0].id, 0, 0);
  };
  return { env, client, doc, fileA1 };
}

it("counts the owner's file as still to be written until the quiet moment after the last change has written it", async () => {
  const { client, doc } = await setup();
  expect(doc.hasPendingWrites).toBe(false);
  client.wb.setInput(client.wb.sheets[0].id, 0, 0, 'last edit');
  await until(() => !client.replica.pending.length, 4000, 'delivery');
  await wait(50);
  // Every change is in the room, but the file is not written yet: the editor's flush and the page's
  // beforeunload save it rather than let the owner leave it behind.
  expect(doc.status).toBe('saved');
  expect(doc.hasPendingWrites).toBe(true);
  await doc.save();
  expect(doc.hasPendingWrites).toBe(false);
  client.close();
});

it("writes the owner's file on the way out when the owner leaves right after the last change", async () => {
  const { client, doc, fileA1 } = await setup();
  client.wb.setInput(client.wb.sheets[0].id, 0, 0, 'last edit');
  await until(() => !client.replica.pending.length, 4000, 'delivery');
  doc.destroy(); // leaving the editor, well within the 15 seconds the file waits for
  await until(async () => (await fileA1()) === 'last edit', 4000, 'the file to be written');
  await until(() => client.closed, 4000, 'the room to be left');
});

it('leaves the file to the next save when AutoSave is off', async () => {
  setAutoSaveEnabled(false);
  const { env, client, doc, fileA1 } = await setup();
  client.wb.setInput(client.wb.sheets[0].id, 0, 0, 'held back');
  await until(() => !client.replica.pending.length, 4000, 'delivery');
  expect(doc.hasPendingWrites).toBe(false);
  doc.destroy();
  await until(() => client.closed, 4000, 'the room to be left');
  expect(env.calls.some((c) => c.op === 'checkpoint')).toBe(false);
  expect(await fileA1()).toBe(null);
});
