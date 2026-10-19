import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { MAX_CHANGE, validateChange } from '../src/collab/ops.js';
import { environment, owner, editor, SERVER, until } from './collab-helpers.js';
import { call } from '../src/collab/api.js';

// A paste of a long list into a shared workbook: 6,000 rows of four columns of notes, more than the room takes in one change.
const ROWS = 6_000;
const NOTE = ' '.padEnd(200, 'lorem ipsum ');
const item = (i) => `Item ${i}${NOTE}`;
const paste = (wb, s) => wb.setCells(s, Array.from({ length: ROWS * 4 }, (_, i) => ({ r: i >> 2, c: i & 3, cell: { v: item(i) } })), 'Paste');

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

it('shares a paste larger than the room takes in one change, in several, and undoes it whole', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Data', file: null });
  const join = async (user) => {
    const token = user === owner ? undefined : (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
    const client = new RoomClient({ puter: env.sdk(user), server: SERVER, room, token, store: memoryOutbox(), poll: 50, noPeers: true });
    open.push(client);
    await client.open();
    return client;
  };
  const a = await join(owner);
  const b = await join(editor);
  const refused = [];
  a.addEventListener('refused', (e) => refused.push(e.detail.message));
  const s = a.wb.sheets[0].id;
  paste(a.wb, s);
  await a.settled();
  await until(() => a.replica.pending.length === 0, 20_000, 'the paste to be sent');
  expect(refused).toEqual([]);
  expect(a.wb.getValue(s, ROWS - 1, 3)).toBe(item(ROWS * 4 - 1));
  expect(env.calls.filter((c) => c.op === 'commit').every((c) => JSON.stringify(c.changes).length <= MAX_CHANGE)).toBe(true);
  await until(() => b.wb.getValue(s, ROWS - 1, 3) === item(ROWS * 4 - 1), 20_000, 'the paste to arrive');
  expect(b.wb.getValue(s, 0, 0)).toBe(item(0));
  // One step to undo, as it was one step to make.
  expect(a.wb.undoLabels(5)).toEqual(['Paste']);
  a.wb.undo();
  expect(a.wb.getValue(s, 0, 0)).toBe(null);
  await until(() => b.wb.getValue(s, ROWS - 1, 3) === null && b.wb.getValue(s, 0, 0) === null, 20_000, 'the undo to arrive');
  expect(refused).toEqual([]);
}, 60_000);

it('converges when someone else edits the pasted cells while the parts are still being sent', () => {
  const log = [];
  const initial = new Workbook({ sheets: [{ name: 'Data' }] }).toJSON();
  const commit = (rep, user) => {
    for (let tries = 0; tries < 20; tries++) {
      const out = rep.outgoing().slice(0, 2); // the room takes a few parts at a time
      if (!out.length) return;
      for (const ch of out) validateChange(ch);
      if (JSON.stringify(out).length > MAX_CHANGE) throw new Error('commit too large');
      if (rep.rev === log.length) log.push({ rev: log.length + 1, user, username: user, changes: JSON.parse(JSON.stringify(out)) });
      rep.receive(log.slice(rep.rev));
    }
  };
  const join = () => { const wb = new Workbook(structuredClone(initial)); return { wb, rep: new Replica(wb) }; };
  const a = join(), b = join();
  const s = a.wb.sheets[0].id;
  paste(a.wb, s);
  expect(a.rep.pending.length).toBeGreaterThan(1);
  // The first parts reach the room; then Bob's edits, made before he saw any of it, land between them.
  const first = a.rep.outgoing().slice(0, 1);
  log.push({ rev: 1, user: 'a', username: 'a', changes: JSON.parse(JSON.stringify(first)) });
  a.rep.receive(log.slice(a.rep.rev));
  b.wb.setInput(s, ROWS - 1, 3, 'bob late');
  b.wb.setInput(s, 0, 0, 'bob early');
  commit(b.rep, 'b');
  commit(a.rep, 'a');
  b.rep.receive(log.slice(b.rep.rev));
  a.rep.receive(log.slice(a.rep.rev));
  const fresh = join();
  fresh.rep.receive(log);
  for (const x of [a, b]) {
    // Ana's paste landed after Bob's edits wherever its parts came later in the room's order.
    expect(x.wb.getValue(s, 0, 0)).toBe(fresh.wb.getValue(s, 0, 0));
    expect(x.wb.getValue(s, ROWS - 1, 3)).toBe(item(ROWS * 4 - 1));
    expect(x.wb.getValue(s, 1234, 2)).toBe(item(1234 * 4 + 2));
    expect([...x.wb.sheets[0].cells.keys()].length).toBe(fresh.wb.sheets[0].cells.size);
  }
  expect(fresh.wb.getValue(s, 0, 0)).toBe('bob early');
}, 60_000);
