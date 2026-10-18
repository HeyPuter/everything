import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { packState } from '../src/collab/protocol.js';
import { environment, owner, SERVER } from './collab-helpers.js';

it('serves a browser that is up to date from a worker instance just started, however long the log since the last checkpoint', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const s = wb.sheets[0].id;
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  for (let rev = 1; rev <= 1200; rev++) {
    const res = await env.service.call(owner, { op: 'commit', room, base: rev - 1, changes: [{ id: `change${String(rev).padStart(8, '0')}`, label: 'Edit', ops: [{ t: 'cells', s, v: { '0,0': { v: rev, f: null } } }] }], session: 'here' });
    expect(res.accepted).toBe(true);
  }
  // Another instance of the worker (a fresh start, nothing loaded) answers this browser's next requests.
  const fresh = env.instance();
  const synced = await fresh.call(owner, { op: 'sync', room, since: 1200 });
  expect(synced).toMatchObject({ head: 1200, records: [] });
  const next = await env.instance().call(owner, { op: 'commit', room, base: 1200, changes: [{ id: 'change00001201', label: 'Edit', ops: [{ t: 'cells', s, v: { '0,0': { v: 'next', f: null } } }] }], session: 'here' });
  expect(next).toMatchObject({ accepted: true, rev: 1201 });
  const state = await packState(new Workbook({ sheets: [{ name: 'Plan' }] }).toJSON());
  expect(await env.instance().call(owner, { op: 'checkpoint', room, rev: 1201, state })).toMatchObject({ saved: true });
}, 60_000);
