import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { environment, owner, SERVER, wait } from './collab-helpers.js';

const change = (text) => ({ id: `change${text.replace(/\W/g, '').slice(0, 8).padEnd(8, 'x')}`, label: 'Edit', ops: [{ t: 'cells', s: 'sheet', v: { '0,0': { v: text, f: null } } }] });

/** A room, and a store whose first write matching `slow` waits until released. */
async function setup(slow) {
  const env = environment();
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb: new Workbook({ sheets: [{ name: 'Plan' }] }), name: 'Plan' });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { kv, fs } = env.workerPuter;
  const set = kv.set, write = fs.write;
  kv.set = async (key, value, ...rest) => { if (slow(key, value)) await held; return set.call(kv, key, value, ...rest); };
  fs.write = async (path, value, ...rest) => { if (slow(path, value)) await held; return write.call(fs, path, value, ...rest); };
  return { env, room, release };
}

/** Commit `ch` on one worker instance while another, `wait` later, finds its place still empty and may give it up. */
async function race({ env, room, release }, ch, after) {
  const other = env.instance();
  const committing = env.instance().call(owner, { op: 'commit', room, base: 0, changes: [ch], session: 'a' });
  await wait(20);
  await other.call(owner, { op: 'sync', room, since: 0 }); // finds the place claimed, and empty
  env.now += after;
  const seen = await other.call(owner, { op: 'sync', room, since: 0 });
  release();
  const res = await committing;
  const later = await env.instance().call(owner, { op: 'sync', room, since: 0 });
  return { res, seen: seen.records.find((r) => r.rev === 1), landed: later.records.find((r) => r.rev === 1) };
}

// A commit whose record took longer to write than the room waits on a claimed place (a large change written to a
// file, a slow store) had its place given up by another worker instance meanwhile, which wrote an empty record there.
// The slow write then landed over it, and its author was told the change was taken: everyone who had read the empty
// record went on without the change, for good.
it('does not take a change whose place the room gave up while it was being written', async () => {
  const big = change(`big ${'x'.repeat(120_000)}`);
  const { res, seen, landed } = await race(await setup((key) => String(key).endsWith('/log/000000000001.json')), big, 21_000);
  expect(seen.changes).toEqual([]);
  expect(landed.changes).toEqual([]);
  expect(res.accepted).toBe(false);
});

it('waits on a place whose commit is writing its record, and delivers the change', async () => {
  const ctx = await setup((key, value) => String(key).endsWith(':log:000000000001') && value.changes?.length);
  const { res, seen, landed } = await race(ctx, change('slow'), 21_000);
  expect(seen).toBeUndefined();
  expect(res.accepted).toBe(true);
  expect(landed.changes.map((c) => c.id)).toEqual([change('slow').id]);
});

// The five minutes a sealed place is waited on were counted from when the room first found the place empty, not from
// when its commit sealed it: a commit whose large change took nearly that long to write sealed its place, and a worker
// instance that had seen the place empty since the start gave it up at once, while the record was being written over.
it('counts the wait on a sealed place from when it was found sealed', async () => {
  const env = environment();
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb: new Workbook({ sheets: [{ name: 'Plan' }] }), name: 'Plan' });
  const { kv, fs } = env.workerPuter;
  const set = kv.set, write = fs.write;
  let releaseFile, releaseRecord;
  const file = new Promise((resolve) => { releaseFile = resolve; });
  const recordHeld = new Promise((resolve) => { releaseRecord = resolve; });
  fs.write = async (path, value, ...rest) => { if (String(path).endsWith('/log/000000000001.json')) await file; return write.call(fs, path, value, ...rest); };
  kv.set = async (key, value, ...rest) => { if (String(key).endsWith(':log:000000000001') && value.file) await recordHeld; return set.call(kv, key, value, ...rest); };
  const other = env.instance();
  const big = change(`big ${'x'.repeat(120_000)}`);
  const committing = env.instance().call(owner, { op: 'commit', room, base: 0, changes: [big], session: 'a' });
  await wait(20);
  await other.call(owner, { op: 'sync', room, since: 0 }); // finds the place claimed, and empty
  env.now += 299_000;
  releaseFile(); // the commit seals its place, and writes its record
  await wait(20);
  env.now += 2_000;
  const seen = await other.call(owner, { op: 'sync', room, since: 0 });
  releaseRecord();
  const res = await committing;
  const later = await env.instance().call(owner, { op: 'sync', room, since: 0 });
  expect(res.accepted).toBe(true);
  expect(seen.records.find((r) => r.rev === 1)).toBeUndefined();
  expect(later.records.find((r) => r.rev === 1).changes.map((c) => c.id)).toEqual([big.id]);
});
