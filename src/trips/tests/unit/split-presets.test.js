import { describe, expect, it } from 'vitest';
import { applyPreset, buildPreset, matchPreset, parseWeight, sameWeight, sortPresets, weightsFromRows } from '../../src/views/trip/costs/presets/model.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { splitAmount } from '../../src/shared/money.js';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const carol = '00000000-0000-4000-8000-000000000003';
const guest = 'g000000000000001';

describe('weights', () => {
  it('parses typed weights in either decimal style and stores integers as numbers', () => {
    expect(parseWeight('2', 'en')).toBe(2);
    expect(parseWeight('1,5', 'de')).toBe('1.5');
    expect(parseWeight('1.50', 'en')).toBe('1.5');
    expect(parseWeight('', 'en')).toBe(0);
    expect(parseWeight('-1', 'en')).toBeNull();
    expect(parseWeight('two', 'en')).toBeNull();
  });

  it('compares weights exactly', () => {
    expect(sameWeight(1, '1.0')).toBe(true);
    expect(sameWeight('0.10', '0.1')).toBe(true);
    expect(sameWeight('0.3', '0.30000000000000004')).toBe(false);
  });
});

describe('buildPreset', () => {
  it('drops zero weights and produces a valid splitPreset', () => {
    const preset = buildPreset('  Family   of three ', [[alice, '2'], [bob, '0'], [carol, ''], [guest, '0,5']], { locale: 'de' });
    expect(preset).toEqual({ name: 'Family of three', weights: { [alice]: 2, [guest]: '0.5' } });
    expect(() => validateEntity('trip', 'splitPreset', preset)).not.toThrow();
  });

  it('rejects empty names, bad weights and presets without anyone', () => {
    expect(() => buildPreset(' ', [[alice, '1']])).toThrow('preset_name');
    expect(() => buildPreset('x'.repeat(101), [[alice, '1']])).toThrow('preset_name');
    let error;
    try { buildPreset('Bad', [[alice, '1'], [bob, 'lots']]); } catch (failure) { error = failure; }
    expect(error).toMatchObject({ code: 'preset_weight', who: bob });
    expect(() => buildPreset('Nobody', [[alice, '0'], [bob, '']])).toThrow('preset_empty');
  });
});

describe('applyPreset', () => {
  const preset = { id: 'p1', name: 'Couples', weights: { [alice]: 2, [bob]: '1.5', [carol]: 0, gone000000000001: 1 } };

  it('includes only positively weighted people on the expense, in roster order', () => {
    const result = applyPreset(preset, [carol, bob, alice, guest]);
    expect(result.participants).toEqual([bob, alice]);
    expect([...result.weights]).toEqual([[bob, '1.5'], [alice, 2]]);
    expect(result.excluded).toEqual([carol, guest]);
    expect(result.missing).toEqual(['gone000000000001']);
  });

  it('yields shares that split an amount by the weights', () => {
    const { participants, weights } = applyPreset(preset, [alice, bob]);
    const split = { mode: 'shares', parts: participants.map((who) => ({ who, value: weights.get(who) })) };
    expect(splitAmount(3500, split, { expenseId: 'e1' }).map((share) => share.amount)).toEqual([2000, 1500]);
  });

  it('applies nothing for a preset with nobody on the expense', () => {
    expect(applyPreset(preset, [guest]).participants).toEqual([]);
    expect(applyPreset(null, [alice])).toMatchObject({ participants: [], excluded: [alice] });
  });
});

describe('matching the form to a preset', () => {
  const presets = [{ id: 'a', name: 'Even', weights: { [alice]: 1, [bob]: 1 } }, { id: 'b', name: 'Family', weights: { [alice]: 2, [bob]: 1 } }];

  it('finds the preset equal to the typed shares, ignoring zero rows', () => {
    expect(matchPreset(presets, weightsFromRows([[alice, '2'], [bob, '1.0'], [carol, '0']], 'en'))?.id).toBe('b');
    expect(matchPreset(presets, weightsFromRows([[alice, '1'], [bob, '1']], 'en'))?.id).toBe('a');
    expect(matchPreset(presets, weightsFromRows([[alice, '1']], 'en'))).toBeNull();
    expect(weightsFromRows([[alice, 'x']], 'en')).toBeNull();
  });

  it('sorts presets by name', () => {
    expect(sortPresets([{ id: '2', name: 'beta' }, { id: '1', name: 'Alpha' }, { id: '3', name: 'alpha' }], 'en').map((preset) => preset.id)).toEqual(['1', '3', '2']);
  });
});
