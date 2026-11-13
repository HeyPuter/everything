import { describe, expect, it } from 'vitest';
import { parseSetsData, exportSetsData, defaultSets, stepDetail } from '../src/features/panels/actions-model.js';

const file = (dialogs) => exportSetsData([{ name: 'Imported', actions: [{ name: 'Command', steps: [{ kind: 'command', cmd: 'edit.copy', dialogs }] }] }]);

describe('imported action dialog records', () => {
  it.each([{}, 'dialog', [null], [true], [[]], [{ title: 4, value: {} }], [{ title: 'Options' }]])('rejects malformed records: %j', (dialogs) => {
    expect(() => parseSetsData(file(dialogs))).toThrow(/invalid dialog records/);
  });

  it.each([undefined, null, []])('allows commands with no recorded dialogs: %j', (dialogs) => {
    const step = parseSetsData(file(dialogs))[0].actions[0].steps[0];
    expect(stepDetail(step)).toBe('');
  });

  it('preserves scalar and structured answers and built-in action dialogs', () => {
    const dialogs = [true, 'choice', 12, { amount: 4, preview: false, items: ['a', 'b'] }].map((value) => ({ title: 'Options', value }));
    const step = parseSetsData(file(dialogs))[0].actions[0].steps[0];
    expect(step.dialogs).toEqual(dialogs);
    expect(() => stepDetail(step)).not.toThrow();
    const imported = parseSetsData(exportSetsData(defaultSets()));
    for (const set of imported) for (const action of set.actions) for (const s of action.steps) expect(() => stepDetail(s)).not.toThrow();
  });
});
