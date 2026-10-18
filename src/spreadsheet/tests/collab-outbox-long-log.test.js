import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox, outboxKey } from '../src/collab/outbox.js';
import { environment, owner, SERVER } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

it('puts changes kept from a visit long ago back on the revision they were made on, however long the log after it', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const s = wb.sheets[0].id;
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  // A long-lived room: more records than one load carries (and no checkpoint at or before the kept revision).
  const commit = (rev, ops) => env.service.call(owner, { op: 'commit', room, base: rev - 1, changes: [{ id: `change${String(rev).padStart(8, '0')}`, label: 'Edit', ops }], session: 'elsewhere' });
  for (let rev = 1; rev <= 5050; rev++) {
    const res = await commit(rev, rev === 5010 ? [{ t: 'insert', s, axis: 'row', at: 0, n: 1 }] : [{ t: 'cells', s, v: { '5,5': { v: rev, f: null } } }]);
    expect(res.accepted).toBe(true);
  }
  // This browser typed "mine" in A1 at revision 5050, after the row inserted at 5010, and closed before sending it.
  const store = memoryOutbox();
  await store.put(outboxKey(owner.uuid, room), { room, user: owner.uuid, rev: 5050, pending: [{ id: 'minechange01', label: 'Typing', ops: [{ t: 'cells', s, v: { '0,0': { v: 'mine', f: null } } }] }], at: Date.now() });
  const client = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store, poll: 60_000, noPeers: true });
  open.push(client);
  await client.open();
  await client.settled();
  expect(client.replica.rev).toBe(5051);
  expect(client.wb.getValue(s, 0, 0)).toBe('mine');
  expect(client.wb.getValue(s, 1, 0)).toBe(null);
}, 60_000);
