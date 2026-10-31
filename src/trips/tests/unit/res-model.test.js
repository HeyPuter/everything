// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../src/shared/operations.js';
import {
  compareRes, duplicateDraft, emptyLeg, filterRes, groupByStatus, normalizeRes, resIssues, resPatch, returnDraft, suggestTitle,
} from '../../src/lib/res/model.js';
import { removalOps, fileLinkChanges, soleExpenses } from '../../src/lib/res/links.js';
import { phaseName, isTransport, RES_TYPES } from '../../src/lib/res/types.js';

const DAY = 'd000000000000001';
const DAY2 = 'd000000000000002';
const flightDraft = {
  type: 'flight', title: '  ', status: 'confirmed', code: ' abc123 ', people: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'],
  location: { name: 'ignored' }, stay: { fromDayId: DAY },
  legs: [
    { from: { code: 'lis', name: 'Lisbon', lat: 38.77, lng: -9.13, tz: 'Europe/Lisbon' }, to: { code: 'MAD', tz: 'Europe/Madrid' }, dep: { date: '2027-05-03', time: '08:00' }, arr: { date: '', time: '10:15' }, carrier: ' TAP ', coach: '7', seat: '' },
    { from: { code: 'MAD', tz: 'Europe/Madrid' }, to: { code: 'JFK', tz: 'America/New_York' }, dep: { date: '2027-05-03', time: '12:00' }, arr: { date: '2027-05-03', time: '14:30' } },
  ],
};

describe('normalizeRes', () => {
  it('keeps transports to legs and derives start and end from them', () => {
    const fields = normalizeRes({ ...flightDraft, title: 'Lisbon to New York' });
    expect(resIssues(fields)).toEqual([]);
    expect(fields).toMatchObject({
      code: 'abc123', people: ['00000000-0000-4000-8000-000000000001'],
      start: { date: '2027-05-03', time: '08:00', tz: 'Europe/Lisbon' }, end: { date: '2027-05-03', time: '14:30', tz: 'America/New_York' },
    });
    expect(fields.legs[0]).toEqual({ from: { code: 'LIS', name: 'Lisbon', lat: 38.77, lng: -9.13, tz: 'Europe/Lisbon' }, to: { code: 'MAD', tz: 'Europe/Madrid' }, dep: { date: '2027-05-03', time: '08:00' }, arr: { date: '2027-05-03', time: '10:15' }, carrier: 'TAP' });
    expect(fields).not.toHaveProperty('location');
    expect(fields).not.toHaveProperty('stay');
  });

  it('keeps lodging to a location and stay, and drops what belongs to other types', () => {
    const fields = normalizeRes({
      type: 'lodging', title: 'Hotel', status: 'weird', legs: flightDraft.legs, stayId: 'r000000000000001',
      start: { date: '2027-05-02', time: '', tz: 'Europe/Lisbon' }, end: { date: '2027-05-04' },
      location: { name: ' Hotel Avenida ', lat: 38.7, lng: -9.1 }, stay: { checkInFrom: '15:00', checkOut: 'noon', fromDayId: DAY, toDayId: DAY2 },
    });
    expect(resIssues(fields)).toEqual([]);
    expect(fields).toEqual({
      type: 'lodging', title: 'Hotel', status: 'pending', start: { date: '2027-05-02', tz: 'Europe/Lisbon' }, end: { date: '2027-05-04' },
      location: { name: 'Hotel Avenida', lat: 38.7, lng: -9.1 }, stay: { checkInFrom: '15:00', fromDayId: DAY, toDayId: DAY2 },
    });
  });

  it('reports schema issues instead of saving an invalid leg', () => {
    const fields = normalizeRes({ type: 'train', title: 'T', legs: [emptyLeg()] });
    expect(resIssues(fields).length).toBeGreaterThan(0);
    expect(resIssues(normalizeRes({ type: 'other', title: '' })).length).toBeGreaterThan(0);
  });

  it('drops an end without a start and a lone toDayId', () => {
    const fields = normalizeRes({ type: 'lodging', title: 'H', end: { date: '2027-05-04' }, stay: { toDayId: DAY2 } });
    expect(fields).toEqual({ type: 'lodging', title: 'H', status: 'pending' });
  });
});

describe('resPatch', () => {
  it('patches changed fields, unsets removed ones and touches dayPos per day', () => {
    const before = { id: 'r000000000000001', v: 'x', type: 'tour', title: 'A', status: 'pending', code: 'X', dayPos: { [DAY]: 'a1', [DAY2]: 'a2' } };
    const after = { type: 'tour', title: 'B', status: 'pending', dayPos: { [DAY]: 'a3' }, notes: 'n' };
    const patch = resPatch(before, after);
    expect(patch).toEqual({ set: { title: 'B', [`dayPos.${DAY}`]: 'a3', notes: 'n' }, unset: ['code', `dayPos.${DAY2}`] });
    const { id: _id, v: _v, ...plain } = before;
    expect(applyPatch('trip', 'res', plain, patch)).toEqual({ ...after, dayPos: { [DAY]: 'a3' } });
  });
});

describe('drafts', () => {
  it('builds the way back with reversed, swapped legs', () => {
    const fields = normalizeRes({ ...flightDraft, title: 'Out' });
    const back = returnDraft({ ...fields, id: 'r000000000000001', code: 'X' });
    expect(back.legs.map((item) => [item.from.code, item.to.code])).toEqual([['JFK', 'MAD'], ['MAD', 'LIS']]);
    expect(back.legs[0].dep).toEqual({ date: '', time: '' });
    expect(back).not.toHaveProperty('code');
    expect(suggestTitle(back)).toBe('JFK → LIS');
  });

  it('duplicates without identity, positions or import state', () => {
    const copy = duplicateDraft({ id: 'r000000000000001', v: 'x', rev: 3, type: 'tour', title: 'A', status: 'confirmed', dayPos: { [DAY]: 'a' }, review: true, src: { kind: 'ai' } });
    expect(copy).toEqual({ type: 'tour', title: 'A', status: 'confirmed' });
  });

  it('chains a connecting leg from the previous arrival', () => {
    expect(emptyLeg({ to: { code: 'MAD', tz: 'Europe/Madrid' }, arr: { date: '2027-05-03' } })).toMatchObject({ from: { code: 'MAD' }, dep: { date: '2027-05-03' } });
  });

  it('suggests titles from places or carriers', () => {
    expect(suggestTitle({ type: 'lodging', location: { name: 'Casa' } })).toBe('Casa');
    expect(suggestTitle({ type: 'train', legs: [{ from: {}, to: {}, carrier: 'CP', number: '123' }] })).toBe('CP 123');
    expect(suggestTitle({ type: 'event' })).toBe('');
  });
});

describe('lists', () => {
  const a = { id: 'r000000000000001', type: 'flight', title: 'B', status: 'confirmed', people: ['p1'], start: { date: '2027-05-03', time: '08:00', tz: 'Europe/Lisbon' } };
  const b = { id: 'r000000000000002', type: 'lodging', title: 'A', status: 'pending', start: { date: '2027-05-02' } };
  const c = { id: 'r000000000000003', type: 'tour', title: 'C', status: 'confirmed' };
  const d = { id: 'r000000000000004', type: 'flight', title: 'D', status: 'confirmed', start: { date: '2027-05-03', time: '07:30', tz: 'Europe/Madrid' } };

  it('filters by group, type, traveler and status', () => {
    expect(filterRes([a, b, c], { group: 'transport' })).toEqual([a]);
    expect(filterRes([a, b, c], { group: 'booking' })).toEqual([b, c]);
    expect(filterRes([a, b, c], { traveler: 'p1' })).toEqual([a]);
    expect(filterRes([a, b, c], { status: 'confirmed', type: 'tour' })).toEqual([c]);
  });

  it('groups by status in time order, undated last, zones respected', () => {
    const groups = groupByStatus([c, a, b, d]);
    // 07:30 in Madrid is 06:30 in Lisbon, before 08:00 in Lisbon.
    expect(groups.confirmed.map((item) => item.id)).toEqual([d.id, a.id, c.id]);
    expect(groups.pending).toEqual([b]);
    expect([a, d].sort(compareRes)[0]).toBe(d);
  });
});

describe('links', () => {
  const resId = 'r000000000000001';
  const ops = {
    remove: (t, id, opts) => ({ t, id, del: true, ...opts }),
    patch: (t, id, patch, opts) => ({ t, id, ...patch, ...opts }),
  };
  const files = [
    { id: 'f1', kind: 'user', links: [{ t: 'res', id: resId }] },
    { id: 'f2', kind: 'user', links: [{ t: 'res', id: resId }, { t: 'place', id: 'p1' }] },
    { id: 'f3', kind: 'user' },
    { id: 'f4', kind: 'user', linked: { [`res_${resId}`]: true } },
  ];
  const exps = [{ id: 'e1', links: [{ t: 'res', id: resId }] }, { id: 'e2', links: [{ t: 'res', id: resId }, { t: 'res', id: 'r2' }] }];

  it('lists sole expenses and file link changes', () => {
    expect(soleExpenses(exps, resId).map((exp) => exp.id)).toEqual(['e1']);
    expect(fileLinkChanges(files, resId, new Set(['f2', 'f3']))).toEqual({
      f1: { unset: ['links'] }, f3: { set: { [`linked.res_${resId}`]: true } }, f4: { unset: [`linked.res_${resId}`] },
    });
  });

  it('unlinks, optionally deletes sole expenses, and respects permissions', () => {
    const lodging = { id: resId, type: 'lodging' };
    const all = removalOps({ res: lodging, files, exps, visits: [{ id: 'v1', stayId: resId }], reservations: [{ id: 'r2', stayId: resId }], ops, can: () => true, deleteExpenses: ['e1', 'e2'] });
    expect(all).toEqual([
      { t: 'res', id: resId, del: true, base: true },
      { t: 'file', id: 'f1', unset: ['links'] },
      { t: 'file', id: 'f2', set: { links: [{ t: 'place', id: 'p1' }] } },
      { t: 'file', id: 'f4', unset: [`linked.res_${resId}`] },
      { t: 'exp', id: 'e1', del: true, base: true },
      { t: 'exp', id: 'e2', set: { links: [{ t: 'res', id: 'r2' }] }, base: true },
      { t: 'visit', id: 'v1', unset: ['stayId'] },
      { t: 'res', id: 'r2', unset: ['stayId'] },
    ]);
    const limited = removalOps({ res: lodging, files, exps, ops, can: (action) => action === 'res.edit' });
    expect(limited).toEqual([{ t: 'res', id: resId, del: true, base: true }]);
  });
});

describe('types', () => {
  it('names phases per type family', () => {
    expect(RES_TYPES).toHaveLength(16);
    expect(['flight', 'train', 'ferry'].map((type) => phaseName(type, 'start'))).toEqual(['depart', 'depart', 'depart']);
    expect(phaseName('bike', 'end')).toBe('return');
    expect(phaseName('lodging', 'middle')).toBe('stay');
    expect(phaseName('tour', 'single')).toBe('single');
    expect(isTransport('parking')).toBe(false);
  });
});
