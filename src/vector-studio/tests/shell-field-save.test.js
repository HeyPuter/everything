// Save from a panel field (its own file: every app booted in a file keeps listening on the document).
import { describe, it, expect } from 'vitest';

describe('save from a field', () => {
  it('Mod+S in a panel field commits the typed value, saves, and keeps focus in the field', async () => {
    const { bootAppWithFeatures } = await import('./helpers.js');
    const { IS_MAC } = await import('../src/commands/registry.js');
    const { numberField } = await import('../src/ui/widgets.js');
    const app = await bootAppWithFeatures();
    app.newDocument({ name: 'Field' });
    const ran = [];
    app.commands.get('file.save').run = () => ran.push('file.save');
    let committed = null;
    const f = numberField({ label: 'W', value: 10, onCommit: (v) => (committed = v) });
    document.body.append(f.el);
    f.input.focus();
    f.input.value = '25 pt';
    const key = (k, mod) =>
      new KeyboardEvent('keydown', {
        key: k,
        code: `Key${k.toUpperCase()}`,
        metaKey: mod && IS_MAC,
        ctrlKey: mod && !IS_MAC,
        bubbles: true,
        cancelable: true,
      });
    const save = key('s', true);
    f.input.dispatchEvent(save);
    expect(save.defaultPrevented).toBe(true);
    expect(committed).toBe(25);
    expect(ran).toEqual(['file.save']);
    expect(document.activeElement).toBe(f.input);
    // Other keys stay in the field: no tool change, and undo is the field's own.
    f.input.dispatchEvent(key('p', false));
    expect(app.toolId).toBe('selection');
    const undo = key('z', true);
    f.input.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(false);
    expect(ran).toEqual(['file.save']);
  });
});
