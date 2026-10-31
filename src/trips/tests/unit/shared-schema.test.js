import { describe, expect, it } from 'vitest';
import { schemas, validateEntity, validateTombstone, validateVacay } from '../../src/shared/schema/index.js';
import { applyPatch, authorizeOperation, validateCommit, validateOperation } from '../../src/shared/operations.js';
import { can, validatePermissions } from '../../src/shared/perms.js';
import { createClock } from '../../src/shared/hlc.js';

const id = '0000000000000001';
const id2 = '0000000000000002';
const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const v = createClock({ node: id, now: () => 1000 }).tick();
const stamps = { id, v, rev: 1, upd: 1000, by: alice, cr: 1000 };
const editor = { role: 'editor', uid: alice };
const op = (t, fields = {}) => ({ opId: id2, t, id: t === 'meta' ? 'meta' : id, ...fields });
const stored = (data = {}) => ({ ...stamps, ...data });
const file = { name: 'ticket.pdf', mime: 'application/pdf', size: 10, sha256: '0'.repeat(64), kind: 'user', loc: { mode: 'proxied' } };

const samples = {
  trip: {
    meta: { title: 'Autumn trip', currency: 'CAD', start: '2026-10-24', end: '2026-10-28' },
    member: { name: 'Alice', role: 'editor' },
    day: { date: '2026-10-24', order: 'V' }, place: { name: 'Museum', lat: 49, lng: -123 },
    visit: { dayId: id, placeId: null, title: 'Lunch', order: 'V' }, dayNote: { dayId: id, order: 'V', title: 'Reminder' },
    res: { type: 'flight', title: 'Outbound', status: 'confirmed', start: { date: '2026-10-24', time: '10:00', tz: 'Asia/Tokyo' }, end: { date: '2026-10-24', time: '03:00', tz: 'America/Vancouver' } },
    exp: { name: 'Lunch', amount: 101, currency: 'CAD', rate: null, payers: [], split: { mode: 'equal', parts: [{ who: alice }, { who: bob }] } },
    settle: { from: alice, to: bob, amount: 100, currency: 'CAD' }, splitPreset: { name: 'Family', weights: { [alice]: 2, [bob]: 1 } }, costCat: { cat: 'food', order: 'V' }, budget: { cat: 'food', amount: 50000 },
    pack: { name: 'Jacket', order: 'V', vis: 'people', for: [alice] }, bag: { name: 'Backpack', order: 'V' },
    todo: { name: 'Check in', order: 'V', prio: 1 }, listMeta: { kind: 'pack', name: 'Clothes', order: 'V' },
    note: { title: 'Ideas' }, link: { title: 'Hotel', url: 'https://example.com/' }, poll: { question: 'Dinner?', options: ['Early', 'Late'] },
    msg: { text: 'Hello' }, file, cat: { name: 'Lookout', color: '#1e6ac8', icon: 'mountain' }, guest: { name: 'Guest' },
    via: { dayId: id, after: id, order: 'V', lat: 49, lng: -123 }, dayEnd: { day: id, fromVisit: id, toVisit: id2, fraction: 0.5 },
    dayTrack: { dayId: id, placeId: id2, strayKm: 1 }, rtPrefs: {}, alt: { name: 'Plan B', order: 'V', dayId: id },
  },
  collection: { meta: { name: 'Ideas', share: { on: true, exp: null } }, saved: { name: 'Museum', status: 'idea', order: 'V', src: { trip: { w: 'trips-012345abcd', s: id, k: 'trip' }, placeId: id2 } }, label: { name: 'Food', order: 'V' }, member: { name: 'Alice', role: 'owner' }, file },
  journey: { meta: { title: 'Journal', share: { on: true, gallery: true } }, entry: { type: 'day', date: '2026-10-24', title: 'Arrival', order: 'V' }, book: { fileId: id }, bookPage: { book: id, kind: 'spread', order: 'V', els: { [id]: { k: 'photo', x: 0, y: 0, w: 0.5, h: 1, z: 1, file: id, fit: 'fill' } } }, member: { name: 'Alice', role: 'owner' }, file },
};

describe('entity schemas', () => {
  for (const [kind, types] of Object.entries(samples)) {
    it(`${kind} has a tested schema for every registered type`, () => expect(Object.keys(types).sort()).toEqual(Object.keys(schemas[kind]).sort()));
    for (const [type, value] of Object.entries(types)) {
      it(`validates ${kind}/${type} and its server envelope`, () => {
        expect(validateEntity(kind, type, value)).toBe(value);
        const server = { ...stamps, ...value, id: type === 'meta' ? 'meta' : type === 'member' ? alice : id };
        expect(validateEntity(kind, type, server, { server: true })).toBe(server);
        expect(() => validateEntity(kind, type, { ...value, unexpected: true })).toThrow('invalid');
      });
    }
  }
  it('never accepts server stamps from a create body', () => {
    for (const field of ['id', 'v', 'rev', 'by', 'upd', 'cr']) expect(() => validateEntity('trip', 'place', { name: 'Test', [field]: stamps[field] })).toThrow('invalid');
  });
  it('rejects invalid coordinates, missing free-form titles, invalid dates and empty names', () => {
    for (const [type, value] of [
      ['place', { name: 'Test', lat: 10 }], ['place', { name: 'Test', lat: NaN, lng: 10 }],
      ['place', { name: 'Test', lat: 91, lng: 10 }], ['visit', { dayId: id, placeId: null, order: 'V' }],
      ['day', { date: '2026-02-30', order: 'V' }], ['place', { name: ' ' }],
      ['meta', { title: 'Trip', currency: 'CAD', start: '2026-10-24', end: '2026-10-23' }],
    ]) expect(() => validateEntity('trip', type, value)).toThrow('invalid');
  });
  it.each(['javascript:alert(1)', 'data:text/html,a', 'file:///etc/passwd', 'https://username:password@example.com/', 'https://example.com/\n'])('rejects unsafe URLs %s', (url) => {
    expect(() => validateEntity('trip', 'link', { title: 'Link', url })).toThrow('invalid');
  });
  it('keeps public-link hashes out of every shared meta schema', () => {
    for (const kind of Object.keys(samples)) expect(() => validateEntity(kind, 'meta', { ...samples[kind].meta, share: { tokenHash: 'secret' } })).toThrow('invalid');
  });
  it('checks expense conservation and poll options', () => {
    const expense = samples.trip.exp;
    expect(() => validateEntity('trip', 'exp', { ...expense, payers: [{ who: alice, amount: 100 }] })).toThrow('invalid');
    expect(() => validateEntity('trip', 'poll', { question: 'Dinner?', options: ['Early', 'Late'], votes: { [alice]: [2] } })).toThrow('invalid');
    expect(() => validateEntity('trip', 'poll', { question: 'Dinner?', options: ['Early', 'Late'], votes: { [alice]: [0, 1] } })).toThrow('invalid');
  });
  it('rejects final stamped entities above the KV byte limit', () => {
    expect(() => validateEntity('trip', 'place', stored({ name: 'Big', notes: '界'.repeat(100000), desc: '界'.repeat(100000) }), { server: true })).toThrow('entity_too_large');
  });
  it('validates tombstones and personal vacay data', () => {
    expect(validateTombstone({ id, t: 'place', deleted: true, rev: 2, v }).deleted).toBe(true);
    expect(validateVacay('entry', { fraction: 0.5, kind: 'vacation' }).fraction).toBe(0.5);
    expect(() => validateVacay('entry', { fraction: 0.2, kind: 'vacation' })).toThrow('invalid');
  });
  it('validates cleared soft-deleted messages but rejects creating one through client authorization', () => {
    expect(validateEntity('trip', 'msg', stored({ text: '', deleted: true }), { server: true }).deleted).toBe(true);
    expect(() => validateEntity('trip', 'msg', stored({ text: 'Leaked text', deleted: true }), { server: true })).toThrow('invalid');
    expect(() => authorizeOperation(op('msg', { put: { text: '', deleted: true } }), editor)).toThrow('forbidden');
  });
});

describe('operation validation', () => {
  it('accepts exactly one operation kind and rejects unknown operations', () => {
    expect(validateOperation(op('place', { put: { name: 'Museum' } })).t).toBe('place');
    for (const value of [op('place', { put: { name: 'Museum' }, del: true }), op('place'), op('place', { del: false }), op('place', { del: true, role: 'owner' }), op('constructor', { del: true })]) {
      expect(() => validateOperation(value)).toThrow();
    }
  });
  it.each(['__proto__.polluted', 'constructor.prototype.polluted', 'name.__proto__', 'name..a', 'rev', 'id'])('rejects path %s', (path) => {
    expect(() => validateOperation(op('place', { set: { [path]: 1 } }))).toThrow();
    expect({}.polluted).toBeUndefined();
  });
  it('rejects overlapping and unknown paths, required unsets and duplicate op ids', () => {
    expect(() => validateOperation(op('place', { set: { price: { amount: 100, currency: 'USD' }, 'price.amount': 200 } }))).toThrow('overlapping_paths');
    expect(() => validateOperation(op('place', { set: { unrecognized: 2 } }))).toThrow('unknown_field');
    expect(() => validateOperation(op('place', { unset: ['name'] }))).toThrow('required_field');
    expect(() => validateCommit([op('place', { del: true }), op('place', { del: true })])).toThrow('duplicate_op');
  });
  it('validates the fully patched entity, including cross-field constraints', () => {
    const place = stored({ name: 'Museum', lat: 1, lng: 2 });
    expect(() => applyPatch('trip', 'place', place, op('place', { unset: ['lng'] }))).toThrow('invalid');
    expect(applyPatch('trip', 'place', place, op('place', { set: { [`rating.${alice}`]: 5 } }))).toBeDefined();
  });
});

describe('permissions and authorization', () => {
  it('uses the matrix defaults and rejects privilege escalation', () => {
    expect(can('editor', 'plan.edit')).toBe(true);
    expect(can('viewer', 'plan.edit')).toBe(false);
    expect(can('editor', 'trip.edit')).toBe(false);
    expect(can('editor', 'trip.edit', { 'trip.edit': 'editor' })).toBe(true);
    expect(can('viewer', 'collab.post', { 'collab.post': 'viewer' })).toBe(true);
    expect(can('owner', 'constructor')).toBe(false);
    expect(() => validatePermissions({ 'trip.delete': 'editor' })).toThrow('invalid_permissions');
  });
  it('permits viewer self fields and rejects other users and wholesale replacements', () => {
    const context = { role: 'viewer', uid: alice, entity: stored({ name: 'Museum' }) };
    expect(authorizeOperation(op('place', { set: { [`rating.${alice}`]: 5 } }), context)).toBe(true);
    expect(() => authorizeOperation(op('place', { set: { [`rating.${bob}`]: 5 } }), context)).toThrow('forbidden');
    expect(() => authorizeOperation(op('place', { set: { rating: { [alice]: 5 } } }), context)).toThrow('forbidden');
    expect(() => authorizeOperation(op('place', { set: { name: 'Renamed' } }), context)).toThrow('forbidden');
  });
  it('prevents creates from stamping other members’ data', () => {
    expect(() => authorizeOperation(op('place', { put: { name: 'Museum', rating: { [bob]: 5 } } }), editor)).toThrow('forbidden');
    expect(authorizeOperation(op('place', { put: { name: 'Museum', rating: { [alice]: 5 } } }), editor)).toBe(true);
  });
  it('never treats last-editor by as authorship', () => {
    const entity = stored({ title: 'Original', by: bob });
    expect(authorizeOperation(op('note', { set: { title: 'Author update' } }), { ...editor, entity, creator: alice })).toBe(true);
    expect(() => authorizeOperation(op('note', { set: { title: 'Takeover' } }), { role: 'editor', uid: bob, entity, creator: alice })).toThrow('forbidden');
    expect(() => authorizeOperation(op('note', { del: true }), { role: 'editor', uid: bob, entity })).toThrow('forbidden');
  });
  it('enforces message edit windows and owner-only moderation via delete', () => {
    const entity = stored({ text: 'Hello', by: bob });
    expect(authorizeOperation(op('msg', { set: { text: 'Edited' } }), { ...editor, entity, creator: alice, now: 1001 })).toBe(true);
    expect(() => authorizeOperation(op('msg', { set: { text: 'Too late' } }), { ...editor, entity, creator: alice, now: 901001 })).toThrow('forbidden');
    expect(() => authorizeOperation(op('msg', { set: { text: 'Moderated' } }), { role: 'owner', uid: bob, entity, creator: alice, now: 1001 })).toThrow('forbidden');
    expect(authorizeOperation(op('msg', { del: true }), { role: 'owner', uid: bob, entity, creator: alice })).toBe(true);
  });
  it('protects poll votes and locks options after a vote', () => {
    const entity = stored({ question: 'Dinner?', options: ['Early', 'Late'], votes: { [bob]: [0] } });
    expect(() => authorizeOperation(op('poll', { set: { options: ['A', 'B'] } }), { ...editor, entity, creator: alice })).toThrow('poll_has_votes');
    expect(() => authorizeOperation(op('poll', { set: { options: ['A', 'B'] } }), { ...editor, entity: { ...entity, votes: {} }, creator: alice, pollHasVoted: true })).toThrow('poll_has_votes');
    expect(authorizeOperation(op('poll', { set: { options: ['A', 'B'] } }), { ...editor, entity: { ...entity, votes: {} }, creator: alice, pollHasVoted: false })).toBe(true);
    expect(() => authorizeOperation(op('poll', { set: { [`votes.${alice}`]: [0] } }), { role: 'viewer', uid: alice, entity })).toThrow('forbidden');
    expect(authorizeOperation(op('poll', { set: { [`votes.${alice}`]: [0] } }), { role: 'viewer', uid: alice, entity, perms: { 'collab.post': 'viewer' } })).toBe(true);
    expect(() => authorizeOperation(op('poll', { set: { [`votes.${alice}`]: [0] } }), { ...editor, entity: { ...entity, closed: true } })).toThrow('poll_closed');
  });
  it('protects meta actions, file locations and worker-only entities', () => {
    const meta = { ...stamps, id: 'meta', title: 'Trip', currency: 'CAD' };
    expect(() => authorizeOperation(op('meta', { set: { title: 'Renamed' } }), { ...editor, entity: meta })).toThrow('forbidden');
    expect(authorizeOperation(op('meta', { set: { title: 'Renamed' } }), { ...editor, entity: meta, perms: { 'trip.edit': 'editor' } })).toBe(true);
    expect(() => authorizeOperation(op('meta', { set: { perms: { 'trip.edit': 'editor' } } }), { ...editor, entity: meta })).toThrow('forbidden');
    expect(() => authorizeOperation(op('file', { set: { loc: { mode: 'direct', uid: bob } } }), { ...editor, entity: stored(file) })).toThrow('forbidden');
    expect(() => authorizeOperation(op('file', { put: file }), { role: 'owner', uid: alice })).toThrow('worker_only');
    expect(() => authorizeOperation({ ...op('member', { put: { name: 'Bob', role: 'owner' } }), id: bob }, { role: 'owner', uid: alice })).toThrow('worker_only');
  });
  it('returns conflict errors for tombstones and stale base versions', () => {
    expect(() => authorizeOperation(op('place', { set: { name: 'X' } }), { ...editor, entity: { id, deleted: true } })).toThrow('gone');
    const newer = createClock({ node: id, now: () => 2000 }).tick();
    expect(() => authorizeOperation(op('place', { set: { name: 'X' }, base: v }), { ...editor, entity: stored({ name: 'X', v: newer }) })).toThrow('stale');
  });
});
