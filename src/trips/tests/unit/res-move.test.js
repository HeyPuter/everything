import { describe, expect, it, vi } from 'vitest';
import { bookingDates, expenseCopy, findSamePlace, newTripDates, personMapper, planMove, refreshPatch } from '../../src/views/trip/bookings/move/plan.js';
import { moveEntry, moveJournal, runMove, undoMove } from '../../src/views/trip/bookings/move/run.js';
import { splitAmount } from '../../src/shared/money.js';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const carol = '00000000-0000-4000-8000-000000000003';
let sequence = 0;
const makeId = () => `n${String(++sequence).padStart(15, '0')}`;
const sid = (prefix) => `${prefix}${'0'.repeat(15)}`.slice(0, 16);

function memoryDb() {
  const map = new Map();
  return { get: async (key) => structuredClone(map.get(key)), update: async (key, change) => { const value = change(structuredClone(map.get(key))); if (value === undefined) map.delete(key); else map.set(key, value); return value; } };
}

const day1 = { id: sid('d1'), date: '2027-05-01' };
const day2 = { id: sid('d2'), date: '2027-05-02' };
const place = { id: sid('p1'), name: 'Hotel Sol', lat: 38.7, lng: -9.1, cat: 'hotel', rating: { [alice]: 5 }, tags: { [alice]: ['fav'] }, img: { fileId: sid('f9') } };
const guest = { id: sid('g1'), name: 'Dana' };
const hotel = {
  id: sid('r1'), v: 'v-1', type: 'lodging', title: 'Hotel Sol', status: 'confirmed', start: { date: '2027-05-01' }, end: { date: '2027-05-02' }, placeId: place.id,
  stay: { checkInFrom: '15:00', fromDayId: day1.id, toDayId: day2.id }, people: [alice, bob, guest.id, carol], dayPos: { [day1.id]: 'b' }, visitId: sid('v1'),
};
const sole = { id: sid('e1'), name: 'Hotel', amount: 1001, currency: 'EUR', cat: 'accommodation', payers: [{ who: alice, amount: 1001 }],
  split: { mode: 'equal', parts: [{ who: alice }, { who: bob }] }, links: [{ t: 'res', id: hotel.id }] };
const shared = { ...sole, id: sid('e2'), links: [{ t: 'res', id: hotel.id }, { t: 'place', id: place.id }] };
const file = { id: sid('f1'), name: 'booking.pdf', mime: 'application/pdf', size: 10, kind: 'user', links: [{ t: 'res', id: hotel.id }] };
const trashed = { ...file, id: sid('f2'), trashed: 1 };
const source = (extra = {}) => ({
  currency: 'EUR', files: [file, trashed], exps: [sole, shared], visits: [{ id: sid('v2'), stayId: hotel.id }], reservations: [hotel, { id: sid('r2'), stayId: hotel.id }],
  places: [place], guests: [guest], days: [day1, day2], can: () => true, ...extra,
});
const target = (extra = {}) => ({
  currency: 'EUR', members: [alice, bob], guests: [{ id: sid('g7'), name: ' dana ' }], places: [], days: [{ id: sid('t1'), date: '2027-05-01' }], can: () => true, ...extra,
});

describe('planMove', () => {
  it('copies the booking with remapped days, people and a fresh place, and lists the source side', () => {
    const plan = planMove({ res: hotel, source: source(), target: target(), options: { copyFiles: true, moveExpenses: true }, makeId });
    expect(plan.fields).toEqual({
      type: 'lodging', title: 'Hotel Sol', status: 'confirmed', start: { date: '2027-05-01' }, end: { date: '2027-05-02' },
      stay: { checkInFrom: '15:00', fromDayId: sid('t1') }, dayPos: { [sid('t1')]: 'b' }, people: [alice, bob, sid('g7')], placeId: plan.place.id,
    });
    expect(plan.dropped).toEqual([carol]);
    expect(plan.place).toMatchObject({ reused: false, fields: { name: 'Hotel Sol', lat: 38.7, lng: -9.1, cat: 'hotel' } });
    expect(plan.place.fields).not.toHaveProperty('rating');
    expect(plan.place.fields).not.toHaveProperty('img');
    expect(plan.files).toEqual([{ id: file.id, name: 'booking.pdf', mime: 'application/pdf', size: 10 }]);
    expect(plan.expenses.map((item) => item.from)).toEqual([sole.id]);
    expect(plan.blocked).toEqual([{ id: shared.id, reason: 'links' }]);
    expect(plan.targetOps.map((op) => op.t)).toEqual(['place', 'res', 'exp']);
    expect(plan.sourceArgs).toEqual({ res: hotel.id, base: 'v-1', files: [file.id, trashed.id], exps: [sole.id, shared.id], moved: [sole.id], visits: [sid('v2')], stays: [sid('r2')] });
    expect(plan.created).toEqual([{ t: 'exp', id: plan.expenses[0].id }, { t: 'res', id: plan.resId }, { t: 'place', id: plan.place.id }]);
    expect(plan.privateExps).toEqual([]);
  });

  it('moves the mover\'s private expenses that only belong to the booking and unlinks the others', () => {
    const mine = { ...sole, id: sid('m1'), payers: [{ who: alice, amount: 1001 }], split: { mode: 'equal', parts: [{ who: alice }] } };
    const both = { ...mine, id: sid('m2'), links: [{ t: 'res', id: hotel.id }, { t: 'place', id: place.id }] };
    const unrelated = { ...mine, id: sid('m3'), links: [{ t: 'place', id: place.id }] };
    const privateExps = [mine, both, unrelated];
    const plan = planMove({ res: hotel, source: source({ privateExps }), target: target({ currency: 'USD' }), options: { moveExpenses: true }, makeId });
    expect(plan.privateExps).toEqual([
      { from: mine.id, id: expect.any(String), fields: expect.objectContaining({ links: [{ t: 'res', id: plan.resId }], rate: null, payers: [{ who: alice, amount: 1001 }] }) },
      { from: both.id, links: [{ t: 'place', id: place.id }] },
    ]);
    const kept = planMove({ res: hotel, source: source({ privateExps }), target: target(), options: { moveExpenses: false }, makeId });
    expect(kept.privateExps).toEqual([{ from: mine.id, links: [] }, { from: both.id, links: [{ t: 'place', id: place.id }] }]);
  });

  it('reuses a matching place and respects missing permissions in the target', () => {
    const existing = { id: sid('t9'), name: 'hotel sol', lat: 38.7002, lng: -9.1001 };
    const plan = planMove({ res: hotel, source: source(), target: target({ places: [existing], can: (action) => action === 'res.edit' }), options: { copyFiles: true, moveExpenses: true }, makeId });
    expect(plan.place).toMatchObject({ id: existing.id, reused: true });
    expect(plan.targetOps.map((op) => op.t)).toEqual(['res']);
    expect(plan.files).toEqual([]);
    expect(plan.expenses).toEqual([]);
    expect(plan.staying).toEqual([sole.id, shared.id]);
    expect(plan.sourceArgs).not.toHaveProperty('moved');
    const noPlaces = planMove({ res: hotel, source: source(), target: target({ can: (action) => action !== 'plan.edit' }), makeId });
    expect(noPlaces.fields).not.toHaveProperty('placeId');
    expect(noPlaces.notes).toEqual(['place_skipped']);
  });

  it('lays out new days for a new trip and drops links it cannot map', () => {
    const plan = planMove({ res: { ...hotel, people: [carol] }, source: source(), target: target({ days: [], newDays: newTripDates(hotel) }), makeId });
    expect(plan.days.map((day) => day.date)).toEqual(['2027-05-01', '2027-05-02']);
    expect(plan.fields.stay).toEqual({ checkInFrom: '15:00', fromDayId: plan.days[0].id, toDayId: plan.days[1].id });
    expect(plan.fields).not.toHaveProperty('people');
    expect(plan.targetOps.slice(0, 2).map((op) => op.t)).toEqual(['day', 'day']);
    const undated = planMove({ res: hotel, source: source(), target: target({ days: [] }), makeId });
    expect(undated.fields.stay).toEqual({ checkInFrom: '15:00' });
    expect(undated.fields).not.toHaveProperty('dayPos');
  });

  it('refuses a booking it cannot copy validly', () => {
    expect(() => planMove({ res: { ...hotel, title: '' }, source: source(), target: target(), makeId })).toThrow('invalid_booking');
    expect(() => planMove({ res: null, source: source(), target: target(), makeId })).toThrow('gone');
  });
});

describe('expenseCopy', () => {
  const mapPerson = personMapper({ sourceGuests: [guest], targetMembers: [alice, bob], targetGuests: [{ id: sid('g7'), name: 'Dana' }] });
  const base = { from: hotel.id, resId: sid('nr'), mapPerson, sourceCurrency: 'EUR', targetCurrency: 'EUR' };

  it('blocks expenses with people outside the target', () => {
    expect(expenseCopy({ ...sole, split: { mode: 'equal', parts: [{ who: alice }, { who: carol }] } }, { ...base, id: sid('n1') })).toEqual({ reason: 'people' });
    expect(expenseCopy({ ...sole, payers: [{ who: guest.id, amount: 1001 }] }, { ...base, id: sid('n1') }).fields.payers).toEqual([{ who: sid('g7'), amount: 1001 }]);
  });

  it('keeps or resets the frozen rate by trip currency', () => {
    const usd = { ...sole, currency: 'USD', rate: '0.9' };
    expect(expenseCopy(usd, { ...base, id: sid('n1') }).fields.rate).toBe('0.9');
    expect(expenseCopy(usd, { ...base, id: sid('n1'), targetCurrency: 'GBP' }).fields.rate).toBeNull();
    expect(expenseCopy(usd, { ...base, id: sid('n1'), targetCurrency: 'USD' }).fields).not.toHaveProperty('rate');
    expect(expenseCopy({ ...sole, cat: sid('c1') }, { ...base, id: sid('n1') }).fields.cat).toBe('other');
  });

  it('re-fits a paid-back share to the new expense id', () => {
    const paidShare = splitAmount(1001, sole.split, { expenseId: sole.id })[1].amount;
    const paid = { ...sole, split: { mode: 'equal', parts: [{ who: alice }, { who: bob, paid: paidShare }] } };
    for (const id of [sid('n1'), sid('n2'), sid('n3'), sid('n4')]) {
      const { fields } = expenseCopy(paid, { ...base, id });
      const share = splitAmount(1001, fields.split, { expenseId: id })[1].amount;
      expect(fields.split.parts[1].paid).toBeLessThanOrEqual(share);
      expect(fields.links).toEqual([{ t: 'res', id: base.resId }]);
    }
  });
});

describe('helpers', () => {
  it('finds dates across legs and matches places by OSM id or name and distance', () => {
    expect(bookingDates({ legs: [{ dep: { date: '2027-05-03' }, arr: { date: '2027-05-04' } }, { dep: { date: '2027-05-01' }, arr: { date: '2027-05-01' } }] })).toEqual({ start: '2027-05-01', end: '2027-05-04' });
    expect(newTripDates({})).toEqual([]);
    expect(findSamePlace({ name: 'X', ids: { osm: 'node/1' } }, [{ id: 'a', name: 'Y', ids: { osm: 'node/1' } }])?.id).toBe('a');
    expect(findSamePlace({ name: 'Cafe', lat: 1, lng: 1 }, [{ id: 'a', name: 'Cafe', lat: 1.01, lng: 1 }])).toBeNull();
    expect(findSamePlace({ name: 'Cafe', address: 'Main St 1' }, [{ id: 'b', name: 'cafe', address: 'main st 1' }])?.id).toBe('b');
  });

  it('builds a refresh patch that keeps remapped links', () => {
    const patch = refreshPatch({ title: 'Old', code: 'X', placeId: 'p', stay: { fromDayId: 't1', checkInFrom: '14:00' } }, { title: 'New', type: 'lodging', status: 'confirmed', stay: { checkInFrom: '16:00', fromDayId: 'd1' } });
    expect(patch.set).toMatchObject({ title: 'New', stay: { checkInFrom: '16:00', fromDayId: 't1' } });
    expect(patch.set).not.toHaveProperty('placeId');
    expect(patch.unset).toEqual(['code']);
  });
});

describe('runMove failure recovery', () => {
  const from = { w: 'trips-aaaaaaaaaa', s: sid('s1'), k: 'trip' };
  const to = { w: 'trips-bbbbbbbbbb', s: sid('s2'), k: 'trip' };
  function setup({ files = [] } = {}) {
    const plan = { ...planMove({ res: hotel, source: source({ files: [] }), target: target(), makeId }), files };
    const journal = moveJournal(memoryDb(), from.s);
    const entry = moveEntry({ plan, from, to, toTitle: 'Porto', title: hotel.title, makeId });
    return { plan, journal, entry };
  }
  const fail = (status, code, extra = {}) => Object.assign(new Error(code), { status, code, ...extra });

  it('drops the journal when the target refuses, and keeps it when the target is unreachable', async () => {
    const { journal, entry } = setup();
    await journal.put(entry);
    const refused = vi.fn().mockRejectedValue(fail(403, 'forbidden'));
    await expect(runMove(entry, { journal, commit: refused, copyFile: vi.fn() })).rejects.toMatchObject({ code: 'target_failed' });
    expect(await journal.list()).toEqual([]);

    await journal.put(entry);
    const offline = vi.fn().mockRejectedValue(fail(0, 'network'));
    await expect(runMove(entry, { journal, commit: offline, copyFile: vi.fn() })).rejects.toMatchObject({ code: 'target_pending' });
    expect(await journal.list()).toEqual([expect.objectContaining({ stage: 'target', error: 'network' })]);
    expect(offline).toHaveBeenCalledTimes(1);
  });

  it('treats our own copy already being there as created', async () => {
    const { journal, entry, plan } = setup();
    const commit = vi.fn()
      .mockRejectedValueOnce(fail(409, 'already_exists', { server: { t: 'res', id: plan.resId } }))
      .mockResolvedValue({ done: {} });
    await expect(runMove(entry, { journal, commit, copyFile: vi.fn() })).resolves.toMatchObject({ status: 'done' });
    expect(commit.mock.calls[1][0]).toEqual(from);
    const someoneElse = vi.fn().mockRejectedValue(fail(409, 'already_exists', { server: { t: 'res', id: sid('zz') } }));
    await expect(runMove(entry, { journal, commit: someoneElse, copyFile: vi.fn() })).rejects.toMatchObject({ code: 'target_failed' });
  });

  it('carries on past failed file copies, and resumes at the source step', async () => {
    const files = [{ id: sid('f1'), name: 'a.pdf' }, { id: sid('f2'), name: 'b.pdf' }];
    const { journal, entry } = setup({ files });
    const copyFile = vi.fn().mockResolvedValueOnce({ id: sid('c1') }).mockRejectedValueOnce(new Error('too big'));
    const commit = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(fail(503, 'busy'));
    await expect(runMove(entry, { journal, commit, copyFile })).rejects.toMatchObject({ code: 'source_pending' });
    const [saved] = await journal.list();
    expect(saved).toMatchObject({ stage: 'source', copied: { [sid('f1')]: { id: sid('c1'), duplicate: false } }, failedFiles: [sid('f2')] });

    const resume = vi.fn().mockResolvedValue({});
    const result = await runMove(saved, { journal, commit: resume, copyFile });
    expect(result).toMatchObject({ status: 'done', entry: { failedFiles: [sid('f2')] } });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]).toEqual([from, [saved.source]]);
    expect(copyFile).toHaveBeenCalledTimes(2);
    expect(await journal.list()).toEqual([]);
  });

  it('finishes when the source booking is already gone, and stops when the copy was deleted', async () => {
    const { journal, entry } = setup();
    const gone = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(fail(409, 'gone'));
    await expect(runMove(entry, { journal, commit: gone, copyFile: vi.fn() })).resolves.toMatchObject({ status: 'done', alreadyGone: true });

    const stale = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(fail(409, 'stale', { server: { t: 'res', id: hotel.id, v: 'v-2', title: 'Renamed', type: 'lodging', status: 'confirmed' } }))
      .mockRejectedValueOnce(fail(409, 'gone'));
    await expect(runMove(entry, { journal, commit: stale, copyFile: vi.fn() })).rejects.toMatchObject({ code: 'copy_gone' });
    expect(await journal.list()).toEqual([expect.objectContaining({ error: 'copy_gone' })]);
  });

  it('marks a source refusal as failed so the user can undo or keep both', async () => {
    const { journal, entry } = setup();
    const commit = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(fail(403, 'forbidden'));
    await expect(runMove(entry, { journal, commit, copyFile: vi.fn() })).rejects.toMatchObject({ code: 'source_failed' });
    const [saved] = await journal.list();
    // An entity already gone from the target counts as undone.
    const undo = vi.fn().mockRejectedValueOnce(fail(409, 'gone'));
    expect(await undoMove(saved, { journal, commit: undo, trash: vi.fn(), sourceHas: async () => true, makeId })).toMatchObject({ status: 'undone' });
    expect(undo.mock.calls.map(([ref, [op]]) => [ref, op.t, op.del])).toEqual([[to, 'res', true], [to, 'place', true]]);
    expect(await journal.list()).toEqual([]);
  });

  it('keeps a copied place that the target uses meanwhile, or when that cannot be checked', async () => {
    const { journal, entry, plan } = setup();
    for (const placeInUse of [async () => true, async () => { throw new Error('offline'); }]) {
      const commit = vi.fn().mockResolvedValue({});
      expect(await undoMove(entry, { journal, commit, trash: vi.fn(), sourceHas: async () => true, placeInUse, makeId })).toMatchObject({ status: 'undone' });
      expect(commit.mock.calls.map(([, [op]]) => op.t)).toEqual(['res']);
    }
    const commit = vi.fn().mockResolvedValue({});
    const placeInUse = vi.fn(async () => false);
    await undoMove(entry, { journal, commit, trash: vi.fn(), sourceHas: async () => true, placeInUse, makeId });
    expect(placeInUse).toHaveBeenCalledWith(plan.place.id);
    expect(commit.mock.calls.map(([, [op]]) => op.t)).toEqual(['res', 'place']);
  });

  it('settles private expenses only once the booking has left the source', async () => {
    const mine = { ...sole, id: sid('m1'), split: { mode: 'equal', parts: [{ who: alice }] } };
    const plan = planMove({ res: hotel, source: source({ files: [], privateExps: [mine] }), target: target(), options: { moveExpenses: true }, makeId });
    const journal = moveJournal(memoryDb(), from.s);
    const entry = moveEntry({ plan, from, to, toTitle: 'Porto', title: hotel.title, makeId });
    expect(entry.private).toHaveLength(1);
    const movePrivate = vi.fn(async () => {});
    const refused = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(fail(403, 'forbidden'));
    await expect(runMove(entry, { journal, commit: refused, copyFile: vi.fn(), movePrivate })).rejects.toMatchObject({ code: 'source_failed' });
    expect(movePrivate).not.toHaveBeenCalled();
    const [saved] = await journal.list();
    const failing = vi.fn(async () => { throw new Error('quota'); });
    await expect(runMove(saved, { journal, commit: vi.fn().mockResolvedValue({}), copyFile: vi.fn(), movePrivate: failing })).resolves.toMatchObject({ status: 'done' });
    expect(failing).toHaveBeenCalledWith(expect.objectContaining({ private: entry.private }));
  });

  it('never undoes a move whose source step had in fact landed', async () => {
    const { journal, entry } = setup();
    const saved = { ...entry, stage: 'source' };
    await journal.put(saved);
    const commit = vi.fn();
    expect(await undoMove(saved, { journal, commit, trash: vi.fn(), sourceHas: async () => false })).toMatchObject({ status: 'finished' });
    expect(commit).not.toHaveBeenCalled();
  });
});
