import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { Doc } from '../src/lib/doc.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { environment, owner, editor, SERVER, until, wait } from './collab-helpers.js';

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
afterEach(() => { delete globalThis.puter; });

async function setup() {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const sdk = env.sdk(editor);
  // The drive answers a look-up of a missing file as Puter does.
  globalThis.puter = { ...sdk, fs: { ...sdk.fs, mkdir: async () => ({}), stat: async (p) => {
    if (!env.files.has(p)) throw Object.assign(new Error('Not found'), { code: 'subject_does_not_exist' });
    return sdk.fs.stat(p);
  } } };
  const client = new RoomClient({ puter: sdk, server: SERVER, room, token, store: memoryOutbox(), poll: 50, noPeers: true });
  await client.open();
  const doc = Doc.forRoom(client);
  const a1 = async (path) => {
    const file = await workbookFromFile(env.files.get(path).buffer, 'Copy.xlsx');
    return file.getValue(file.sheets[0].id, 0, 0);
  };
  return { env, room, client, doc, a1 };
}

it('keeps saving the edits made after Save a copy of a shared workbook whose owner stopped sharing it', async () => {
  const { env, room, client, doc, a1 } = await setup();
  await call(env.sdk(owner), SERVER, { op: 'stop', room });
  await until(() => client.status.state === 'error', 4000, 'the room to close');
  // As the notice says: File > Save a copy keeps the workbook, and work continues in the copy.
  expect(await doc.saveAs('Plan copy')).toBe(null);
  const s = doc.wb.sheets[0].id;
  doc.wb.setInput(s, 0, 0, 'after the copy');
  expect(await doc.save()).toBe(true);
  expect(await a1(doc.path)).toBe('after the copy');
  expect(doc.status).toBe('saved');
});

it('leaves the shared workbook once a copy is saved: later edits are the copy\'s alone', async () => {
  const { env, client, doc } = await setup();
  const s = doc.wb.sheets[0].id;
  doc.wb.setInput(s, 1, 0, 'shared');
  await until(() => !client.replica.pending.length, 4000, 'delivery');
  expect(await doc.saveAs('Plan copy')).toBe(null);
  const commits = () => env.calls.filter((c) => c.op === 'commit').length;
  const sent = commits();
  doc.wb.setInput(s, 2, 0, 'mine alone');
  await wait(100);
  expect(commits()).toBe(sent);
  expect(client.closed).toBe(true);
  doc.destroy();
});
