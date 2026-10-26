import { describe, expect, it } from 'vitest';
import { createClock } from '../../src/shared/hlc.js';
import {
  GRACE, STEPS, followMove, importParts, readTransferExport, replayInto, runTransfer, seatsFor, transferEntry, transferState,
} from '../../src/lib/transfer/index.js';

const SID = '0000000000000001';
const WA = 'trips-aaaaaaaaaa';
const WB = 'trips-bbbbbbbbbb';
const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const CAROL = '00000000-0000-4000-8000-000000000003';
const clock = createClock({ node: '000000000000000z', now: () => 1_800_000_000_000 });
let counter = 100;
const nextId = () => String(++counter).padStart(16, '0');
const stamp = (t, fields, eid = nextId()) => ({ t, id: eid, ...fields, v: clock.tick(), rev: 1, upd: 1, by: ALICE, cr: 1 });
const from = { w: WA, s: SID, k: 'trip' };

function memoryJournal() {
  let value = null;
  return { get: async () => value, put: async (entry) => { value = structuredClone(entry); }, remove: async () => { value = null; }, peek: () => value };
}

/** An in-memory source worker and receiving worker answering the transfer ops the runner sends. */
function world({ days = 3, files = 2 } = {}) {
  const meta = stamp('meta', { title: 'Lisbon', currency: 'EUR', start: '2027-05-01', end: '2027-05-03' }, 'meta');
  const source = {
    rev: 10, offer: true, frozen: false, cancelled: false, moved: null,
    ents: Array.from({ length: days }, () => stamp('day', { order: 'a', date: null })),
    files: Array.from({ length: files }, (_, i) => stamp('file', { name: `f${i}.pdf`, mime: 'application/pdf', size: 3, sha256: 'a'.repeat(64), kind: 'user', loc: { mode: 'proxied' }, star: true })),
    members: [{ uuid: ALICE, role: 'owner', username: 'alice' }, { uuid: BOB, role: 'editor', username: 'bob' }, { uuid: CAROL, role: 'viewer', username: 'carol' }],
  };
  const dest = { created: 0, ents: new Map(), writes: 0, files: new Map(), patched: new Map(), seats: null, deleted: false, indexed: null, copies: 0 };
  const calls = [];
  async function call(worker, op, input) {
    calls.push(op);
    if (op === 'transfer.accept') {
      if (!source.offer) throw Object.assign(new Error('no_offer'), { status: 404, code: 'no_offer' });
      source.frozen = true;
      return { settleAt: 0 };
    }
    if (op === 'transfer.import') {
      expect(worker).toBe(WB);
      if (input.create) dest.created += 1;
      if (!dest.created) throw Object.assign(new Error('import_conflict'), { status: 409, code: 'import_conflict' });
      for (const entity of input.ents ?? []) { dest.ents.set(`${entity.t}:${entity.id}`, entity); dest.writes += 1; }
      for (const item of input.del ?? []) dest.ents.delete(`${item.t}:${item.id}`);
      for (const patch of input.files ?? []) dest.patched.set(patch.id, patch);
      if (input.seats) dest.seats = input.seats;
      return { rev: dest.writes };
    }
    if (op === 'transfer.complete') {
      if (source.cancelled) throw Object.assign(new Error('transfer_cancelled'), { status: 409, code: 'transfer_cancelled' });
      if (source.rev > input.rev) throw Object.assign(new Error('transfer_stale'), { status: 409, code: 'transfer_stale' });
      source.moved = { w: input.to.w, s: SID, at: 1 };
      return { movedTo: source.moved };
    }
    if (op === 'space.delete') { dest.deleted = true; return { deleted: true }; }
    throw new Error(`unexpected ${op}`);
  }
  const deps = {
    uid: BOB, journal: memoryJournal(), call,
    ensureWorker: async () => WB,
    exportSpace: async () => ({ format: 'trips-transfer', version: 1, space: SID, kind: 'trip', rev: source.rev, at: 1,
      ents: [meta, ...source.ents, ...source.files], tombstones: [], members: source.members, authors: {}, pollvoted: [] }),
    copyFile: async (file) => { dest.copies += 1; dest.files.set(file.id, file.name); return 'copied'; },
    index: async (entry) => { dest.indexed = entry.to; },
    removeCopy: async () => { dest.deleted = true; },
    wait: async () => {},
  };
  return { source, dest, deps, calls };
}

/** Wraps `deps` so the step's first call fails once with `error`. */
function failOnce(deps, step, error, { after = 0 } = {}) {
  let seen = 0;
  let failed = false;
  const trip = () => { if (!failed && seen++ === after) { failed = true; throw error; } };
  const wrapped = { ...deps };
  const byOp = { accept: 'transfer.accept', complete: 'transfer.complete' };
  if (step === 'deploy') wrapped.ensureWorker = async () => { trip(); return deps.ensureWorker(); };
  else if (step === 'export') wrapped.exportSpace = async () => { trip(); return deps.exportSpace(); };
  else if (step === 'files') wrapped.copyFile = async (...args) => { trip(); return deps.copyFile(...args); };
  else if (step === 'index') wrapped.index = async (...args) => { trip(); return deps.index(...args); };
  else {
    wrapped.call = async (worker, op, input) => {
      const matches = byOp[step] ? op === byOp[step]
        : step === 'create' ? op === 'transfer.import' && input.create
          : step === 'import' ? op === 'transfer.import' && input.ents
            : step === 'seats' ? op === 'transfer.import' && input.seats : false;
      if (matches) trip();
      return deps.call(worker, op, input);
    };
  }
  return wrapped;
}

const definite = () => Object.assign(new Error('refused'), { status: 400, code: 'refused' });

describe('transfer runner', () => {
  it('runs every step in order and leaves no journal', async () => {
    const { source, dest, deps } = world();
    const steps = [];
    const result = await runTransfer(transferEntry({ from, title: 'Lisbon', now: 1 }), { ...deps, onProgress: (entry) => steps.push(entry.step) });
    expect(result.status).toBe('done');
    expect([...new Set(steps)]).toEqual(STEPS);
    expect(source.moved).toEqual({ w: WB, s: SID, at: 1 });
    expect(dest.ents.size).toBe(3);
    expect(dest.files.size).toBe(2);
    expect([...dest.patched.values()].every((patch) => patch.star === true)).toBe(true);
    expect(dest.seats).toEqual([{ uuid: ALICE, role: 'editor', username: 'alice' }, { uuid: CAROL, role: 'viewer', username: 'carol' }]);
    expect(dest.indexed).toEqual({ w: WB, s: SID, k: 'trip' });
    expect(await deps.journal.get()).toBeNull();
  });

  for (const step of ['deploy', 'accept', 'export', 'create', 'import', 'files', 'seats', 'complete', 'index']) {
    it(`fails at ${step}, records it, and resumes from there without duplicates`, async () => {
      const { source, dest, deps } = world({ days: 400, files: 3 });
      const failing = failOnce(deps, step, definite(), { after: step === 'import' || step === 'files' ? 1 : 0 });
      await expect(runTransfer(transferEntry({ from, now: 1 }), failing)).rejects.toMatchObject({ step, definite: true, reason: 'refused' });
      const saved = await deps.journal.get();
      expect(saved).toMatchObject({ step, error: { code: 'refused', step, definite: true } });
      const result = await runTransfer(saved, failing);
      expect(result.status).toBe('done');
      expect(source.moved?.w).toBe(WB);
      expect(dest.ents.size).toBe(400);
      expect(dest.writes).toBe(400);
      expect(dest.files.size).toBe(3);
      expect(dest.copies).toBe(3);
      expect(dest.indexed).toEqual({ w: WB, s: SID, k: 'trip' });
      expect(await deps.journal.get()).toBeNull();
    });
  }

  it('retries a transient failure inside the step', async () => {
    const { dest, deps } = world();
    const waits = [];
    const failing = failOnce({ ...deps, wait: async (ms) => { waits.push(ms); } }, 'accept', Object.assign(new Error('busy'), { status: 503, code: 'busy' }));
    expect((await runTransfer(transferEntry({ from, now: 1 }), failing)).status).toBe('done');
    expect(waits).toEqual([1000]);
    expect(dest.ents.size).toBe(3);
  });

  it('pauses on a rate limit with its retry time', async () => {
    const { deps } = world();
    const failing = failOnce(deps, 'files', Object.assign(new Error('rate_limited'), { status: 429, code: 'rate_limited', retryAfter: 3600 }));
    await expect(runTransfer(transferEntry({ from, now: 1 }), failing)).rejects.toMatchObject({ step: 'files', definite: false, retryAfter: 3600 });
    expect(await deps.journal.get()).toMatchObject({ step: 'files', error: { code: 'rate_limited', retryAfter: 3600 } });
  });

  it('waits for the source to settle before exporting', async () => {
    const { deps } = world();
    const waits = [];
    let first = true;
    const settling = { ...deps, wait: async (ms) => { waits.push(ms); },
      exportSpace: async () => { if (first) { first = false; throw Object.assign(new Error('transfer_settling'), { status: 409, code: 'transfer_settling', retryAfter: 2 }); } return deps.exportSpace(); } };
    expect((await runTransfer(transferEntry({ from, now: 1 }), settling)).status).toBe('done');
    expect(waits).toEqual([2000]);
  });

  it('exports again and imports only the difference when the source changed', async () => {
    const { source, dest, deps } = world();
    let completes = 0;
    const changing = { ...deps, call: async (worker, op, input) => {
      if (op === 'transfer.complete' && completes++ === 0) {
        source.rev += 1;
        source.ents[0] = { ...source.ents[0], title: 'Arrival', v: clock.tick() };
        source.ents.splice(1, 1);
      }
      return deps.call(worker, op, input);
    } };
    expect((await runTransfer(transferEntry({ from, now: 1 }), changing)).status).toBe('done');
    expect(completes).toBe(2);
    expect(dest.writes).toBe(4);
    expect(dest.ents.size).toBe(2);
    expect([...dest.ents.values()].find((entity) => entity.id === source.ents[0].id).title).toBe('Arrival');
  });

  it('stops and removes the copy when the owner withdrew', async () => {
    const { source, dest, deps } = world();
    source.cancelled = true;
    const result = await runTransfer(transferEntry({ from, now: 1 }), deps);
    expect(result.status).toBe('cancelled');
    expect(dest.deleted).toBe(true);
    expect(await deps.journal.get()).toBeNull();
  });

  it('stops before creating anything when the offer is gone', async () => {
    const { source, dest, deps } = world();
    source.offer = false;
    expect((await runTransfer(transferEntry({ from, now: 1 }), deps)).status).toBe('cancelled');
    expect(dest.created).toBe(0);
    expect(dest.deleted).toBe(false);
  });

  it('keeps the copy when the source was deleted after the import', async () => {
    const { dest, deps } = world();
    const gone = { ...deps, call: async (worker, op, input) => {
      if (op === 'transfer.complete') throw Object.assign(new Error('space_not_found'), { status: 404, code: 'space_not_found' });
      return deps.call(worker, op, input);
    } };
    const result = await runTransfer(transferEntry({ from, now: 1 }), gone);
    expect(result).toMatchObject({ status: 'done', entry: { sourceGone: true } });
    expect(dest.indexed).toBeTruthy();
  });
});

describe('transfer export and plan', () => {
  const raw = (overrides = {}) => ({ format: 'trips-transfer', version: 1, space: SID, kind: 'trip', rev: 3, ents: [stamp('meta', { title: 'T', currency: 'EUR' }, 'meta')], tombstones: [], members: [], ...overrides });

  it('refuses another space, format or version', () => {
    expect(() => readTransferExport(raw({ space: '0000000000000009' }), { space: SID })).toThrow('invalid_export');
    expect(() => readTransferExport(raw({ format: 'trips-export' }), { space: SID })).toThrow('invalid_export');
    expect(() => readTransferExport(raw({ version: 2 }), { space: SID })).toThrow('invalid_export');
    expect(() => readTransferExport(raw({ ents: [] }), { space: SID })).toThrow('invalid_export');
  });

  it('counts entities the schema refuses and drops member entities', () => {
    const data = readTransferExport(raw({ ents: [...raw().ents, { t: 'day', id: 'bad' }, { t: 'unknown', id: nextId() }, stamp('member', { name: 'Bob', role: 'editor' }, BOB), stamp('day', { order: 'a', date: null })] }), { space: SID });
    expect(data.invalid).toBe(2);
    expect(data.ents.map((entity) => entity.t)).toEqual(['day']);
  });

  it('plans upserts by version, deletions of earlier imports, and splits large imports', () => {
    const days = Array.from({ length: 250 }, () => stamp('day', { order: 'a', date: null }));
    const data = readTransferExport(raw({ ents: [...raw().ents, ...days] }), { space: SID });
    const parts = importParts(data);
    expect(parts.length).toBe(2);
    expect(parts.flatMap((part) => part.ents)).toHaveLength(250);
    const imported = Object.assign({}, ...parts.map((part) => part.keys), { [`day:${nextId()}`]: days[0].v });
    const next = importParts(data, imported);
    expect(next).toHaveLength(1);
    expect(next[0].ents).toHaveLength(0);
    expect(next[0].del).toHaveLength(1);
  });

  it('seats the members chosen, the old owner as an editor, never the new owner', () => {
    const members = [{ uuid: ALICE, role: 'owner', username: 'alice' }, { uuid: BOB, role: 'editor', username: 'bob' }, { uuid: CAROL, role: 'viewer', username: 'carol' }];
    expect(seatsFor(members, BOB).map((seat) => [seat.uuid, seat.role])).toEqual([[ALICE, 'editor'], [CAROL, 'viewer']]);
    expect(seatsFor(members, BOB, [CAROL]).map((seat) => seat.uuid)).toEqual([CAROL]);
  });
});

describe('transfer state', () => {
  const offer = { to: BOB, by: ALICE, at: 1, exp: 1000, state: 'offered' };
  it('reads offers, expiry, moves and moved trips', () => {
    expect(transferState({}, BOB).phase).toBe('none');
    expect(transferState({ transfer: offer }, BOB, { now: 10 })).toMatchObject({ phase: 'offered', mine: true });
    expect(transferState({ transfer: offer }, CAROL, { now: 10 })).toMatchObject({ phase: 'offered', mine: false });
    expect(transferState({ transfer: offer }, BOB, { now: 2000 })).toMatchObject({ phase: 'none', expired: true });
    expect(transferState({ transfer: { ...offer, state: 'moving' } }, BOB, { now: 2000 }).phase).toBe('moving');
    expect(transferState({ movedTo: { w: WB, s: SID, at: 5 } }, BOB)).toMatchObject({ phase: 'moved', movedTo: { w: WB, s: SID } });
    expect(transferState({ movedTo: { w: 'evil.example', s: SID } }, BOB).phase).toBe('none');
  });
});

describe('following a moved trip', () => {
  function spacesIndex() {
    const list = [{ ref: from, role: 'editor' }];
    return { list, upsert: async (entry) => { list.push(entry); }, remove: async (ref) => { list.splice(list.findIndex((item) => item.ref.w === ref.w && item.ref.s === ref.s), 1); } };
  }
  function stashStore() {
    let value = null;
    return { get: async () => value, add: async (to, ops) => { value = { to, ops: [...(value?.ops ?? []), ...ops] }; }, remove: async () => { value = null; } };
  }
  const movedTo = { w: WB, s: SID, at: 1000, name: 'bob' };

  it('rejoins, swaps the trip index and keeps refused edits for the new trip', async () => {
    const spaces = spacesIndex();
    const stash = stashStore();
    const dropped = [];
    const op = { opId: nextId(), t: 'day', id: nextId(), put: { order: 'a', date: null } };
    const result = await followMove({ from, movedTo, meta: { title: 'Lisbon' }, role: 'editor' }, {
      call: async (worker, name, input) => { expect([worker, name, input]).toEqual([WB, 'transfer.join', { space: SID }]); return { role: 'editor', handles: { read: 'r', write: 'w' }, files: { mode: 'proxied' } }; },
      spaces, stash, conflicts: () => [{ code: 'space_moving', op }, { code: 'stale', op: { opId: nextId() } }], dropConflict: (id) => { dropped.push(id); },
    });
    expect(result).toMatchObject({ status: 'joined', role: 'editor', kept: 1 });
    expect(spaces.list.map((item) => item.ref.w)).toEqual([WB]);
    expect(spaces.list[0]).toMatchObject({ title: 'Lisbon', handles: { read: 'r', write: 'w' } });
    expect(dropped).toEqual([op.opId]);
    const applied = [];
    expect(await replayInto({ ref: { w: WB, s: SID, k: 'trip' }, apply: async (ops) => { applied.push(...ops); } }, stash)).toEqual({ applied: 1, failed: 0 });
    expect(applied).toEqual([op]);
    expect(await stash.get()).toBeNull();
  });

  it('keeps the old owner’s stub until the grace period ends, then deletes it', async () => {
    const calls = [];
    const call = async (worker, name) => { calls.push(name); return { role: 'editor' }; };
    const spaces = spacesIndex();
    await followMove({ from, movedTo, role: 'owner' }, { call, spaces, stash: stashStore(), now: () => 2000 });
    expect(spaces.list.map((item) => item.ref.w)).toEqual([WA, WB]);
    expect(calls).toEqual(['transfer.join']);
    await followMove({ from, movedTo, role: 'owner' }, { call, spaces, stash: stashStore(), now: () => 1000 + GRACE });
    expect(calls).toEqual(['transfer.join', 'transfer.join', 'space.delete']);
    expect(spaces.list.some((item) => item.ref.w === WA)).toBe(false);
  });

  it('reports a missing seat without touching the index', async () => {
    const spaces = spacesIndex();
    const result = await followMove({ from, movedTo }, { call: async () => { throw Object.assign(new Error('seat_invalid'), { status: 404, code: 'seat_invalid', reason: 'used' }); }, spaces, stash: stashStore() });
    expect(result).toEqual({ status: 'no_seat', reason: 'used' });
    expect(spaces.list).toHaveLength(1);
  });
});
