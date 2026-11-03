import { describe, expect, it } from 'vitest';
import { validatePayers } from '../../src/shared/money.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { authorizeOperation } from '../../src/shared/operations.js';
import { project } from '../../worker/engine/projection.js';

const exp = (extra = {}) => ({ name: 'Hotel', amount: 1000, currency: 'EUR', payers: [{ who: 'aaaaaaaaaaaaaaaa', amount: 1000 }], split: { mode: 'equal', parts: [{ who: 'aaaaaaaaaaaaaaaa' }] }, ...extra });
const uid = '11111111-1111-4111-8111-111111111111';

describe('partial payers', () => {
  it('allows less than the amount only when partial', () => {
    expect(() => validatePayers(100, [{ who: 'a', amount: 30 }])).toThrow('payer_total');
    expect(validatePayers(100, [{ who: 'a', amount: 30 }], { partial: true })).toBe(true);
    expect(validatePayers(100, [{ who: 'a', amount: 100 }], { partial: true })).toBe(true);
    expect(() => validatePayers(100, [{ who: 'a', amount: 101 }], { partial: true })).toThrow('payer_total');
  });
  it('keeps the sign rules for refunds', () => {
    expect(validatePayers(-100, [{ who: 'a', amount: -40 }], { partial: true })).toBe(true);
    expect(() => validatePayers(-100, [{ who: 'a', amount: -140 }], { partial: true })).toThrow('payer_total');
    expect(() => validatePayers(-100, [{ who: 'a', amount: 40 }], { partial: true })).toThrow('invalid_amount');
  });
});

describe('expense schema', () => {
  it('takes a due date with a partial payment', () => {
    expect(() => validateEntity('trip', 'exp', exp({ payers: [{ who: 'aaaaaaaaaaaaaaaa', amount: 300 }] }))).toThrow();
    expect(validateEntity('trip', 'exp', exp({ payers: [{ who: 'aaaaaaaaaaaaaaaa', amount: 300 }], due: '2026-12-01' }))).toBeTruthy();
    expect(validateEntity('trip', 'exp', exp({ payers: [], due: '2026-12-01' }))).toBeTruthy();
    expect(() => validateEntity('trip', 'exp', exp({ due: '2026-13-01' }))).toThrow();
  });
  it('checks cross-trip parts add up and name distinct trips', () => {
    const across = { group: 'bbbbbbbbbbbbbbbb', total: 1500, parts: [{ w: 'trips-abcdefghij', s: 'cccccccccccccccc', amount: 1000 }, { w: 'trips-abcdefghij', s: 'dddddddddddddddd', amount: 500 }] };
    expect(validateEntity('trip', 'exp', exp({ across }))).toBeTruthy();
    expect(() => validateEntity('trip', 'exp', exp({ across: { ...across, total: 1400 } }))).toThrow();
    expect(() => validateEntity('trip', 'exp', exp({ across: { ...across, parts: [across.parts[0], { ...across.parts[1], s: across.parts[0].s }] } }))).toThrow();
    expect(() => validateEntity('trip', 'exp', exp({ across: { ...across, parts: [{ ...across.parts[0], w: 'evil.example' }, across.parts[1]] } }))).toThrow();
  });
  it('validates budgets and needs costs.edit for them', () => {
    expect(validateEntity('trip', 'budget', { amount: 200000 })).toBeTruthy();
    expect(validateEntity('trip', 'budget', { cat: 'food', amount: 0, note: 'Cheap eats' })).toBeTruthy();
    expect(() => validateEntity('trip', 'budget', { amount: -1 })).toThrow();
    const op = { opId: 'eeeeeeeeeeeeeeee', t: 'budget', id: 'ffffffffffffffff', put: { amount: 5 } };
    expect(authorizeOperation(op, { role: 'editor', uid })).toBe(true);
    expect(() => authorizeOperation(op, { role: 'viewer', uid })).toThrow('forbidden');
    expect(() => authorizeOperation(op, { role: 'editor', uid, perms: { 'costs.edit': 'owner' } })).toThrow('forbidden');
  });
});

describe('public projection', () => {
  it('drops cross-trip links and budgets', () => {
    const snapshot = { rev: 3, at: 1, ents: [
      { t: 'meta', id: 'meta', title: 'T', currency: 'EUR' },
      { t: 'exp', id: 'aaaaaaaaaaaaaaab', ...exp({ across: { group: 'bbbbbbbbbbbbbbbb', total: 1500, parts: [{ w: 'trips-abcdefghij', s: 'cccccccccccccccc', amount: 1000 }, { w: 'trips-abcdefghij', s: 'dddddddddddddddd', amount: 500 }] } }) },
      { t: 'budget', id: 'aaaaaaaaaaaaaaac', amount: 5 },
    ] };
    const body = project(snapshot, 'trip', { on: true, costs: true });
    const expense = body.ents.find((entity) => entity.t === 'exp');
    expect(expense).toBeTruthy();
    expect(expense.across).toBeUndefined();
    expect(body.ents.some((entity) => entity.t === 'budget')).toBe(false);
  });
});
