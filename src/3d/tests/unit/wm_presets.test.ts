// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { App, setApp, app, operators, registerOperators } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { registerPresetKind, savePreset, allPresets, applyPreset, removePreset, operatorPresetValues, presetMenu } from '../../src/ui/presets';
import { operatorCheatSheet } from '../../src/ops/wm_misc';

beforeEach(() => setApp(new App(startupDocument())));

describe('presets', () => {
  it('lists built-in presets before the user ones and applies them', () => {
    const target = { size: 1, color: 'red' };
    registerPresetKind({ id: 'test_kind', label: 'Test Presets', addOp: 'test.preset_add', capture: () => ({ ...target }), apply: (v) => Object.assign(target, v), builtins: () => [['Small', { size: 0.5 }]] });
    expect(operators.has('test.preset_add')).toBe(true);
    target.size = 7;
    app.run('test.preset_add', { name: 'Mine' });
    expect(allPresets('test_kind').map((p) => [p.name, p.builtin])).toEqual([
      ['Small', true],
      ['Mine', false],
    ]);
    applyPreset('test_kind', 'Small');
    expect(target.size).toBe(0.5);
    applyPreset('test_kind', 'Mine');
    expect(target).toEqual({ size: 7, color: 'red' });
    const labels = presetMenu('test_kind').map((i) => i.label ?? (i.separator ? '---' : i.heading));
    expect(labels).toEqual(['Small', 'Mine', '---', 'Add Preset…', 'Remove Preset']);
    app.run('test.preset_add', { name: 'Mine', remove_name: true });
    expect(allPresets('test_kind').map((p) => p.name)).toEqual(['Small']);
    expect(removePreset('test_kind', 'Small')).toBe(false);
  });

  it('operator presets keep only visible operator properties', () => {
    registerOperators([{ idname: 'test.op', label: 'Test', props: [{ id: 'a', type: 'float', default: 1 }, { id: 'b', type: 'int', default: 2, hidden: true }], exec: () => {} }]);
    expect(operatorPresetValues('test.op', { a: 3, b: 4, c: 5 })).toEqual({ a: 3 });
    savePreset('op:test.op', 'Three', { a: 3 });
    expect(allPresets('op:test.op').map((p) => p.name)).toEqual(['Three']);
    expect(presetMenu('op:test.op').some((i) => i.label === 'Restore Defaults')).toBe(true);
  });

  it('writes the operator cheat sheet with default values', () => {
    registerOperators([{ idname: 'test.sheet', label: 'Sheet', props: [{ id: 'count', type: 'int', default: 4 }, { id: 'mode', type: 'enum', default: 'A', items: [['A', 'A']] }], exec: () => {} }]);
    expect(operatorCheatSheet()).toContain("bpy.ops.test.sheet(count=4, mode='A')");
  });
});

describe('colour drops', () => {
  it('keeps the target alpha unless the dropped colour has one; starts from the default of unset inputs', async () => {
    const { dropColor } = await import('../../src/ui/eyedroppers');
    const owner: Record<string, unknown> = { color: [0, 0, 0, 0.5] };
    expect(dropColor({ id: 'a', owner, key: 'color', label: 'Color', kind: 'color' }, [1, 0.5, 0.25])).toBe(true);
    expect(owner.color).toEqual([1, 0.5, 0.25, 0.5]);
    const inputs: Record<string, unknown> = {};
    expect(dropColor({ id: 'b', owner: inputs, key: 'Base Color', label: 'Base Color', kind: 'color', def: [0.8, 0.8, 0.8, 1] }, [0.1, 0.2, 0.3, 0.4])).toBe(true);
    expect(inputs['Base Color']).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(dropColor({ id: 'c', owner, key: 'color', label: 'X', kind: 'number' }, [1, 1, 1])).toBe(false);
  });
});
