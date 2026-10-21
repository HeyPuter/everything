import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { packState } from '../src/collab/protocol.js';
import { environment, owner, SERVER } from './collab-helpers.js';

// Browsers write a checkpoint of the whole workbook a minute into each spell of editing; the worker lists the last 50,
// and the file of every one before them stayed on the owner's drive for good, read by nothing.
it('removes the file of a checkpoint that falls out of the list of the last 50', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const s = wb.sheets[0].id;
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  for (let rev = 1; rev <= 60; rev++) {
    await env.service.call(owner, { op: 'commit', room, base: rev - 1, changes: [{ id: `change${String(rev).padStart(8, '0')}`, label: 'Edit', ops: [{ t: 'cells', s, v: { '0,0': { v: rev, f: null } } }] }], session: 'here' });
    const book = new Workbook({ sheets: [{ name: 'Plan' }] });
    book.setInput(book.sheets[0].id, 0, 0, String(rev));
    expect(await env.service.call(owner, { op: 'checkpoint', room, rev, state: await packState(book.toJSON()) })).toMatchObject({ saved: true });
  }
  const kept = [...env.files.keys()].filter((path) => path.startsWith(`spreadsheet/shared/${room}/cp-`));
  expect(kept).toHaveLength(50);
  const listed = (await env.kv.get(`ss:${room}:cps`)).map((c) => c.path);
  expect(kept.sort()).toEqual(listed.sort());
  // A browser bringing back changes made on an earlier revision loads a checkpoint still listed, or, older than them
  // all, the initial state and the whole log.
  expect(await env.service.call(owner, { op: 'load', room, at: 20 })).toMatchObject({ rev: 20, records: expect.arrayContaining([expect.objectContaining({ rev: 21 })]) });
  const early = await env.service.call(owner, { op: 'load', room, at: 5 });
  expect(early.rev).toBe(0);
  expect(early.records.map((r) => r.rev)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
});
