import { describe, it, expect } from 'vitest';
import { uniqueNameAmong, renamedIn } from '../../src/data/names';

describe('unique names in a list', () => {
  it('numbers a taken name like Blender', () => {
    expect(uniqueNameAmong(['Group'], 'Weights')).toBe('Weights');
    expect(uniqueNameAmong(['Group', 'Group.001'], 'Group')).toBe('Group.002');
    expect(uniqueNameAmong(['Group', 'Group.001'], 'Group.001')).toBe('Group.002');
  });

  it('renames an item: trimmed, unique among the others, nothing for empty or unchanged names', () => {
    const list = [{ name: 'Subdivision' }, { name: 'Bevel' }];
    expect(renamedIn(list, list[1], ' Subdivision ')).toBe('Subdivision.001');
    expect(renamedIn(list, list[1], 'Bevel')).toBeNull();
    expect(renamedIn(list, list[1], '   ')).toBeNull();
    expect(renamedIn(list, list[0], 'Subdivision.001')).toBe('Subdivision.001');
  });
});
