import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { Doc } from '../src/lib/doc.js';
import { workbookToXlsx } from '../src/core/io.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { environment, owner, editor, SERVER, until } from './collab-helpers.js';

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

// Each time the connection came back, every member's browser saved the shared workbook as if Ctrl+S had been pressed:
// it encoded the whole workbook as .xlsx and sent it for the worker to write over the owner's file, however little had
// changed, and on a phone whose connection comes and goes that was the whole file again and again.
it('does not upload the whole shared workbook each time the connection comes back', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan', file: { path: 'Spreadsheets/Plan.xlsx', uid: 'u1' } });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const client = new RoomClient({ puter: env.sdk(editor), server: SERVER, room, token, store: memoryOutbox(), poll: 50, noPeers: true, toXlsx: (w) => workbookToXlsx(w) });
  open.push(client);
  await client.open();
  const doc = Doc.forRoom(client);
  client.wb.setInput(client.wb.sheets[0].id, 0, 0, 'mine');
  await until(() => !client.replica.pending.length, 4000, 'delivery');
  await doc.reconnected();
  expect(env.calls.filter((c) => c.op === 'checkpoint' && c.xlsx)).toEqual([]);
  doc.destroy();
});

// The editor saves on its own when the session changes (a sign-in, or any setting: the theme, the regional format) and
// when AutoSave is turned on. In a member's browser a shared workbook is never "saved" (others' changes keep arriving),
// so each of those uploaded the whole workbook too.
it('does not upload the whole shared workbook for a save nobody asked for in a member\'s browser', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan', file: { path: 'Spreadsheets/Plan.xlsx', uid: 'u1' } });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const client = new RoomClient({ puter: env.sdk(editor), server: SERVER, room, token, store: memoryOutbox(), poll: 50, noPeers: true, toXlsx: (w) => workbookToXlsx(w) });
  open.push(client);
  await client.open();
  const doc = Doc.forRoom(client);
  client.wb.setInput(client.wb.sheets[0].id, 0, 0, 'mine');
  expect(await doc.save({ auto: true })).toBe(true);
  expect(client.replica.pending).toEqual([]);
  expect(env.calls.filter((c) => c.op === 'checkpoint' && c.xlsx)).toEqual([]);
  // Saving by hand still writes it, for the owner's file.
  expect(await doc.save()).toBe(true);
  expect(env.calls.filter((c) => c.op === 'checkpoint' && c.xlsx)).toHaveLength(1);
  doc.destroy();
});
