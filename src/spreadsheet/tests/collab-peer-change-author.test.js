import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { environment, owner, editor, SERVER, until } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

it("names a change that arrives over a peer link after the person the room says made it, whatever the sender claims", async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  await call(env.sdk(editor), SERVER, { op: 'join', room, token });
  const client = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 60_000, noPeers: true });
  open.push(client);
  await client.open();
  client.subscription?.off();
  const sheet = client.wb.sheets[0].id;
  // Bob's change, accepted by the room, with its receipt…
  const change = { id: 'bobchange001', label: 'Typing', ops: [{ t: 'cells', s: sheet, v: { '0,0': { v: 'from bob', f: null } } }] };
  const res = await call(env.sdk(editor), SERVER, { op: 'commit', room, base: 0, changes: [change], session: 'bobsession' });
  const record = res.records.find((r) => r.rev === res.rev);
  expect(record.username).toBe('bob');
  // …sent over a peer link by Bob, who says in the record that Alice made it. The room's receipt covers who made
  // it (by account) and what it changes, not the name that comes with it.
  const ticket = { session: 'bobsession', user: editor.uuid, username: 'bob', role: 'editor' };
  await client.receivePeer('change', { record: { ...record, username: 'alice' }, receipt: res.receipt }, ticket);
  await until(() => client.replica.rev === 1, 4000, 'the change');
  expect(client.wb.getValue(sheet, 0, 0)).toBe('from bob');
  const authors = client.wb.changeHistory.filter((e) => e.kind === 'cells').map((e) => e.author);
  expect(authors).toEqual(['bob']);
});
