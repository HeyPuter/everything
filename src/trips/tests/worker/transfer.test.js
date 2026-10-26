// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { install } from '../../worker/app.js';
import { K } from '../../worker/keys.js';
import { handlers } from '../../worker/ops/index.js';
import { OPS } from '../../src/shared/protocol.js';
import { runTransfer, transferEntry } from '../../src/lib/transfer/index.js';
import { USERS, WORKER, createHarness, expectError, id } from './harness.js';

const WB = 'trips-bbbbbbbbbb';
const OWNER = USERS.alice.uuid;
const BOB = USERS.bob.uuid;
const PDF = new TextEncoder().encode('%PDF-1.7\nboarding pass');
const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });

function memoryJournal() {
  let value = null;
  return { get: async () => value, put: async (entry) => { value = structuredClone(entry); }, remove: async () => { value = null; }, peek: () => value };
}

async function setup() {
  const h = await createHarness();
  await h.world.registerWorker(WB, { owner: BOB, region: 0, setup: ({ router, me }) => { install({ router, me, options: { now: h.now, build: 'test000007', builtAt: 1_700_000_000_000 } }); } });
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const [alice, bob, carol, dave] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map((name) => h.client(name)));
  const onA = (client) => (op, input = {}) => client.in(space).call(op, input);
  const onB = (client) => (op, input = {}) => client.api.request(WB, JSON.stringify({ ...input, op, space }));
  const kvA = () => h.kv();
  const kvB = () => h.world.inspectKv(BOB);
  return { h, space, alice, bob, carol, dave, onA, onB, kvA, kvB, refA: { w: WORKER, s: space, k: 'trip' }, refB: { w: WB, s: space, k: 'trip' } };
}

async function seeded() {
  const f = await setup();
  const ids = { day: id('d'), place: id('p'), visit: id('v'), note: id('n'), poll: id('q'), gone: id('x') };
  await f.onA(f.alice)('commit', { ops: [
    put('day', { order: 'a', date: '2027-05-01' }, ids.day),
    put('place', { name: 'Castle', lat: 38.71, lng: -9.13, rating: { [OWNER]: 5 } }, ids.place),
    put('visit', { dayId: ids.day, placeId: ids.place, order: 'a', start: '10:00' }, ids.visit),
    put('place', { name: 'Removed later' }, ids.gone),
  ] });
  await f.onA(f.bob)('commit', { ops: [put('note', { title: 'Ideas', author: BOB }, ids.note), put('poll', { question: 'Dinner?', options: ['Early', 'Late'], author: BOB }, ids.poll)] });
  await f.onA(f.alice)('commit', { ops: [{ opId: id('o'), t: 'poll', id: ids.poll, set: { [`votes.${OWNER}`]: [1] } }] });
  await f.onA(f.alice)('commit', { ops: [{ opId: id('o'), t: 'place', id: ids.gone, del: true }] });
  ids.msg = id('m');
  await f.onA(f.bob)('commit', { ops: [put('msg', { text: 'Hello', author: BOB }, ids.msg)] });
  ids.file = id('f');
  await f.alice.api.upload(f.refA, ids.file, new Blob([PDF]));
  await f.onA(f.alice)('file.put', { fileId: ids.file, name: 'pass.pdf', mime: 'application/pdf', sha256: 'c'.repeat(64), kind: 'user' });
  await f.onA(f.alice)('commit', { ops: [{ opId: id('o'), t: 'file', id: ids.file, set: { links: [{ t: 'place', id: ids.place }], star: true } }] });
  return { ...f, ids };
}

/** Runner deps for Bob, the new owner, against the real workers. */
function bobDeps(f, overrides = {}) {
  const call = (worker, op, input = {}) => f.bob.api.request(worker, JSON.stringify({ ...input, op }));
  const indexed = [];
  return {
    indexed,
    deps: {
      uid: BOB, journal: memoryJournal(), call,
      ensureWorker: async () => WB,
      exportSpace: () => f.bob.api.request(WORKER, JSON.stringify({ op: 'transfer.export', space: f.space }), { binary: true }),
      async copyFile(file, entry) {
        let blob;
        try { blob = await f.bob.api.download(entry.from, file.id); } catch (error) { if (error.status === 404) return 'missing'; throw error; }
        const inboxName = `${file.id}.pdf`;
        await f.bob.puter.fs.write(`spaces/${entry.from.s}/inbox/${BOB}/${inboxName}`, blob, { overwrite: true, dedupeName: false, createMissingParents: true });
        await call(entry.to.w, 'file.put', { space: entry.from.s, fileId: file.id, name: file.name, mime: file.mime, sha256: file.sha256, kind: file.kind, inboxName });
        return 'copied';
      },
      index: async (entry) => { indexed.push(entry.to); },
      removeCopy: (entry) => call(entry.to.w, 'space.delete', { space: entry.from.s }),
      wait: async (ms) => { f.h.advance(ms); },
      now: f.h.now,
      ...overrides,
    },
  };
}

describe('transfer registry', () => {
  it('lists every handler in the shared protocol', () => {
    for (const name of Object.keys(handlers)) expect(OPS).toContain(name);
  });
});

describe('transfer.offer, cancel and accept', () => {
  it('lets only the owner offer, and only to an editor or viewer', async () => {
    const f = await setup();
    await expectError(f.onA(f.bob)('transfer.offer', { to: USERS.carol.uuid }), 403, 'forbidden');
    await expectError(f.onA(f.dave)('transfer.offer', { to: BOB }), 403);
    await expectError(f.onA(f.alice)('transfer.offer', { to: USERS.dave.uuid }), 404, 'not_member');
    await expectError(f.onA(f.alice)('transfer.offer', { to: OWNER }), 400, 'invalid_target');
    await expectError(f.onA(f.alice)('transfer.offer', { to: 'bob' }), 400, 'invalid_uuid');
    const { transfer } = await f.onA(f.alice)('transfer.offer', { to: BOB });
    expect(transfer).toMatchObject({ to: BOB, name: 'bob', state: 'offered' });
    expect(f.kvA()[K.entity(f.space, 'meta', 'meta')].transfer).toMatchObject({ to: BOB, state: 'offered' });
    // Offering again to the same member is a no-op.
    const before = f.kvA()[K.rev(f.space)];
    await f.onA(f.alice)('transfer.offer', { to: BOB });
    expect(f.kvA()[K.rev(f.space)]).toBe(before);
  });

  it('keeps transfer and movedTo out of reach of commits', async () => {
    const f = await setup();
    await expectError(f.onA(f.alice)('commit', { ops: [{ opId: id('o'), t: 'meta', id: 'meta', set: { transfer: { to: BOB, by: OWNER, at: 1, exp: 2, state: 'offered' } } }] }), 403, 'worker_only');
    await expectError(f.onA(f.alice)('commit', { ops: [{ opId: id('o'), t: 'meta', id: 'meta', set: { movedTo: { w: WB, s: f.space, at: 1 } } }] }), 403, 'worker_only');
  });

  it('accepts only for the offered member, freezes writes, and unfreezes on cancel', async () => {
    const f = await setup();
    await expectError(f.onA(f.bob)('transfer.accept', { worker: WB }), 404, 'no_offer');
    await f.onA(f.alice)('transfer.offer', { to: BOB });
    await expectError(f.onA(f.carol)('transfer.accept', { worker: WB }), 404, 'no_offer');
    await expectError(f.onA(f.bob)('transfer.accept', { worker: WORKER }), 400, 'invalid_worker');
    await expectError(f.onA(f.bob)('transfer.accept', { worker: 'evil.example' }), 400, 'invalid_worker');
    const accepted = await f.onA(f.bob)('transfer.accept', { worker: WB });
    expect(accepted.settleAt).toBe(f.h.now() + 6000);
    expect(await f.onA(f.bob)('transfer.accept', { worker: WB })).toMatchObject({ settleAt: accepted.settleAt });
    f.h.advance(6000);
    const rev = f.kvA()[K.rev(f.space)];
    await expectError(f.onA(f.bob)('commit', { ops: [put('day', { order: 'b', date: null })] }), 409, 'space_moving');
    await expectError(f.onA(f.alice)('commit', { ops: [put('day', { order: 'b', date: null })] }), 409, 'space_moving');
    await expectError(f.onA(f.alice)('invite.create', { role: 'viewer' }), 409, 'space_moving');
    await expectError(f.onA(f.alice)('member.role', { uuid: USERS.carol.uuid, role: 'editor' }), 409, 'space_moving');
    await expectError(f.alice.api.upload(f.refA, id('f'), new Blob([PDF])), 409, 'space_moving');
    // A refused write claims no revision.
    expect(f.kvA()[K.rev(f.space)]).toBe(rev);
    // Another member cannot stop the move; the offered member and the owner can.
    await expectError(f.onA(f.carol)('transfer.cancel'), 403, 'forbidden');
    expect((await f.onA(f.bob)('transfer.cancel')).cancelled).toBe(true);
    f.h.advance(6000);
    expect(f.kvA()[K.entity(f.space, 'meta', 'meta')]).not.toHaveProperty('transfer');
    await f.onA(f.alice)('commit', { ops: [put('day', { order: 'b', date: null })] });
  });

  it('refuses an expired offer', async () => {
    const f = await setup();
    await f.onA(f.alice)('transfer.offer', { to: BOB });
    f.h.advance(15 * 86_400_000);
    await expectError(f.onA(f.bob)('transfer.accept', { worker: WB }), 409, 'offer_expired');
  });
});

describe('transfer.export, import and complete', () => {
  it('exports only to the accepting member, after the settle time', async () => {
    const f = await seeded();
    await f.onA(f.alice)('transfer.offer', { to: BOB });
    await expectError(f.bob.api.request(WORKER, JSON.stringify({ op: 'transfer.export', space: f.space }), { binary: true }), 409, 'transfer_cancelled');
    await f.onA(f.bob)('transfer.accept', { worker: WB });
    const early = await expectError(f.bob.api.request(WORKER, JSON.stringify({ op: 'transfer.export', space: f.space }), { binary: true }), 409, 'transfer_settling');
    expect(early.retryAfter).toBe(6);
    f.h.advance(6000);
    await expectError(f.carol.api.request(WORKER, JSON.stringify({ op: 'transfer.export', space: f.space }), { binary: true }), 409, 'transfer_cancelled');
    const data = await f.bob.api.request(WORKER, JSON.stringify({ op: 'transfer.export', space: f.space }), { binary: true });
    expect(data).toMatchObject({ format: 'trips-transfer', version: 1, space: f.space, kind: 'trip' });
    expect(data.members.map((member) => member.uuid).sort()).toEqual([OWNER, BOB, USERS.carol.uuid].sort());
    expect(data.authors.note[f.ids.note]).toBe(BOB);
    expect(data.authors.msg[f.ids.msg]).toBe(BOB);
    expect(data.pollvoted).toEqual([f.ids.poll]);
    expect(data.ents.some((entity) => entity.t === 'msg' && entity.id === f.ids.msg)).toBe(true);
    expect(data.tombstones.some((item) => item.id === f.ids.gone)).toBe(true);
  });

  it('lets only the receiving worker owner import, and binds the copy to its source', async () => {
    const f = await seeded();
    const meta = { title: 'Lisbon', currency: 'EUR' };
    const from = { w: WORKER, s: f.space };
    await expectError(f.alice.api.request(WB, JSON.stringify({ op: 'transfer.import', space: f.space, from, create: { kind: 'trip', meta } })), 403, 'forbidden');
    await expectError(f.onB(f.bob)('transfer.import', { from: { w: WORKER, s: id('s') }, create: { kind: 'trip', meta } }), 400, 'invalid_source');
    await expectError(f.onB(f.bob)('transfer.import', { from: { w: WB, s: f.space }, create: { kind: 'trip', meta } }), 400, 'invalid_source');
    await expectError(f.onB(f.bob)('transfer.import', { from, ents: [] }), 409, 'import_conflict');
    await f.onB(f.bob)('transfer.import', { from, create: { kind: 'trip', meta: { ...meta, share: { on: true }, transfer: { to: BOB } } } });
    expect(f.kvB()[K.entity(f.space, 'meta', 'meta')]).not.toHaveProperty('share');
    await expectError(f.onB(f.bob)('transfer.import', { from: { w: 'trips-cccccccccc', s: f.space }, ents: [] }), 409, 'import_conflict');
    await expectError(f.onB(f.bob)('transfer.import', { from, ents: [{ t: 'member', id: OWNER, name: 'x', role: 'owner' }] }), 400, 'invalid_entity');
    await expectError(f.onB(f.bob)('transfer.import', { from, ents: [{ t: 'day', id: id('d'), order: 'a', date: null }] }), 400);
  });

  it('moves the whole trip with the same ids, files, authorship and members, then refuses writes on the stub', async () => {
    const f = await seeded();
    await f.onA(f.alice)('transfer.offer', { to: BOB });
    const { deps, indexed } = bobDeps(f);
    const result = await runTransfer(transferEntry({ from: f.refA, title: 'Lisbon', now: f.h.now() }), deps);
    expect(result.status).toBe('done');
    expect(indexed).toEqual([f.refB]);
    const a = f.kvA();
    const b = f.kvB();
    for (const [t, eid] of [['day', f.ids.day], ['place', f.ids.place], ['visit', f.ids.visit], ['note', f.ids.note], ['poll', f.ids.poll]]) {
      const { rev: _a, ...source } = a[K.entity(f.space, t, eid)];
      const { rev: _b, ...copy } = b[K.entity(f.space, t, eid)];
      expect(copy).toEqual(source);
    }
    expect(b[K.entity(f.space, 'msg', f.ids.msg)]).toMatchObject({ text: 'Hello', author: BOB });
    expect(b[K.entity(f.space, 'place', f.ids.gone)]).toBeUndefined();
    expect(b[K.author(f.space, 'note', f.ids.note)]).toBe(BOB);
    expect(b[K.pollvoted(f.space, f.ids.poll)]).toBe(true);
    expect(b[K.entity(f.space, 'file', f.ids.file)]).toMatchObject({ name: 'pass.pdf', star: true, links: [{ t: 'place', id: f.ids.place }], loc: { mode: 'direct' } });
    expect(b[K.entity(f.space, 'meta', 'meta')]).toMatchObject({ title: 'Lisbon' });
    expect(b[K.member(f.space, BOB)]).toMatchObject({ role: 'owner' });
    expect(a[K.entity(f.space, 'meta', 'meta')]).toMatchObject({ movedTo: { w: WB, s: f.space, name: 'bob' } });
    expect(a[K.entity(f.space, 'meta', 'meta')]).not.toHaveProperty('transfer');
    expect(deps.journal.peek()).toBeNull();

    f.h.advance(6000);
    await expectError(f.onA(f.alice)('commit', { ops: [put('day', { order: 'z', date: null })] }), 409, 'space_moved');
    await expectError(f.onA(f.alice)('transfer.offer', { to: BOB }), 409, 'space_moved');
    // Completing again answers the same move.
    expect((await f.onA(f.bob)('transfer.complete', { to: { w: WB, s: f.space }, rev: 0 })).movedTo.w).toBe(WB);

    // Members rejoin with their roles; the old owner as an editor; others need an invite.
    expect(await f.onB(f.carol)('transfer.join')).toMatchObject({ role: 'viewer', space: f.space, kind: 'trip' });
    expect((await f.onB(f.carol)('transfer.join')).role).toBe('viewer');
    expect((await f.onB(f.alice)('transfer.join')).role).toBe('editor');
    const refused = await expectError(f.onB(f.dave)('transfer.join'), 404, 'seat_invalid');
    expect(refused.reason).toBe('invalid');
    // A member removed after rejoining cannot use the seat again.
    await f.onB(f.bob)('member.remove', { uuid: USERS.carol.uuid });
    expect((await expectError(f.onB(f.carol)('transfer.join'), 404, 'seat_invalid')).reason).toBe('used');
    // Seats expire with the grace period.
    f.h.advance(31 * 86_400_000);
    await f.onB(f.bob)('transfer.import', { from: { w: WORKER, s: f.space }, seats: [{ uuid: USERS.dave.uuid, role: 'viewer' }] });
    f.h.advance(31 * 86_400_000);
    expect((await expectError(f.onB(f.dave)('transfer.join'), 404, 'seat_invalid')).reason).toBe('invalid');
  });

  it('re-imports what changed when a write lands after the export, and repeats calls without duplicates', async () => {
    const f = await seeded();
    await f.onA(f.alice)('transfer.offer', { to: BOB });
    let completes = 0;
    const { deps } = bobDeps(f);
    const call = deps.call;
    deps.call = async (worker, op, input) => {
      if (op === 'transfer.complete' && completes++ === 0) {
        // A worker-side write after the export (share settings are not frozen) moves the revision.
        await f.onA(f.alice)('share.set', { on: true });
      }
      return call(worker, op, input);
    };
    const result = await runTransfer(transferEntry({ from: f.refA, now: f.h.now() }), deps);
    expect(result.status).toBe('done');
    expect(completes).toBe(2);
    const part = id('o');
    const from = { w: WORKER, s: f.space };
    const first = await f.onB(f.bob)('transfer.import', { from, part, ents: [{ t: 'day', ...f.kvA()[K.entity(f.space, 'day', f.ids.day)] }] });
    const again = await f.onB(f.bob)('transfer.import', { from, part, ents: [] });
    expect(again.rev).toBe(first.rev);
    // Unchanged entities are not written again.
    const rev = f.kvB()[K.rev(f.space)];
    await f.onB(f.bob)('transfer.import', { from, ents: [{ t: 'day', ...f.kvA()[K.entity(f.space, 'day', f.ids.day)] }] });
    expect(f.kvB()[K.rev(f.space)]).toBe(rev);
  });

  it('resumes after a failure in the middle of the import', async () => {
    const f = await seeded();
    await f.onA(f.alice)('transfer.offer', { to: BOB });
    const { deps } = bobDeps(f);
    const call = deps.call;
    let failed = false;
    deps.call = async (worker, op, input) => {
      if (op === 'transfer.import' && input.ents && !failed) { failed = true; throw Object.assign(new Error('boom'), { status: 400, code: 'boom' }); }
      return call(worker, op, input);
    };
    await expect(runTransfer(transferEntry({ from: f.refA, now: f.h.now() }), deps)).rejects.toMatchObject({ code: 'import_failed', step: 'import' });
    expect(deps.journal.peek()).toMatchObject({ step: 'import', error: { code: 'boom' } });
    const result = await runTransfer(deps.journal.peek(), deps);
    expect(result.status).toBe('done');
    expect(f.kvB()[K.entity(f.space, 'visit', f.ids.visit)]).toMatchObject({ placeId: f.ids.place });
  });

  it('drops the copy when the owner stops the move, and can move again later', async () => {
    const f = await seeded();
    await f.onA(f.alice)('transfer.offer', { to: BOB });
    const { deps } = bobDeps(f);
    const call = deps.call;
    deps.call = async (worker, op, input) => {
      if (op === 'transfer.complete') await f.onA(f.alice)('transfer.cancel');
      return call(worker, op, input);
    };
    const result = await runTransfer(transferEntry({ from: f.refA, now: f.h.now() }), deps);
    expect(result.status).toBe('cancelled');
    await f.h.settle();
    expect(f.kvB()[K.acl(f.space)]).toMatchObject({ deleted: expect.any(Number) });
    f.h.advance(6000);
    await f.onA(f.alice)('commit', { ops: [put('day', { order: 'c', date: null })] });
    // A new offer reuses the same space id in the receiving worker.
    await f.onA(f.alice)('transfer.offer', { to: BOB });
    const again = bobDeps(f).deps;
    expect((await runTransfer(transferEntry({ from: f.refA, now: f.h.now() }), again)).status).toBe('done');
    expect(f.kvB()[K.acl(f.space)]).not.toHaveProperty('deleted');
    expect(f.kvB()[K.entity(f.space, 'visit', f.ids.visit)]).toBeTruthy();
  });
});
