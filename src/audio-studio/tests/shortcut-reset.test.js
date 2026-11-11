// Resetting a command's shortcuts takes its default keys back from commands they were moved to.
import { describe, it, expect } from 'vitest';
import { CommandRegistry, normalizeShortcut } from '../src/commands/registry.js';
import { Prefs } from '../src/lib/prefs.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};

describe('shortcut reset', () => {
  it('leaves no key bound to two commands', () => {
    const app = { prefs: new Prefs(memory()), documentKinds: new Map() };
    const C = new CommandRegistry(app);
    C.register([
      { id: 'save', label: 'Save', shortcut: 'Mod+S', run() {} },
      { id: 'open', label: 'Open', shortcut: 'Mod+O', run() {} },
    ]);
    // Mod+S moves to Open, then Save is reset to its defaults.
    C.setShortcuts('open', [normalizeShortcut('Mod+S')]);
    expect(C.keysFor('save')).toEqual([]);
    C.resetShortcuts('save');
    expect(C.keysFor('save')).toEqual(['Mod+S']);
    expect(C.commandFor('Mod+S')).toBe('save');
    // Open no longer claims the key, so the dialog and the menus agree.
    expect(C.keysFor('open').map(normalizeShortcut)).not.toContain('mod+s');
    expect(app.prefs.get('shortcuts').open).toEqual([]);
  });
});

describe('shortcuts dialog capture', () => {
  it('shows "Press keys…" on the clicked shortcut and keeps focus on it', async () => {
    const { shortcutsDialog } = await import('../src/ui/shortcuts-dialog.js');
    const store = {};
    const app = { prefs: { get: (k) => store[k], set: (k, v) => (store[k] = v) } };
    app.commands = new CommandRegistry(app);
    app.commands.register([{ id: 'edit.copy', label: 'Copy', shortcut: 'Mod+C', run() {} }]);
    const done = shortcutsDialog(app);
    const search = document.querySelector('.sc-search');
    search.value = 'copy';
    search.dispatchEvent(new Event('input'));
    const chip = () => document.querySelector('.sc-row[data-id="edit.copy"] .sc-chip:not(.sc-add)');
    chip().click();
    expect(chip().textContent).toBe('Press keys…');
    expect(document.activeElement).toBe(chip());
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    document.querySelectorAll('.dialog-backdrop').forEach((d) => d.remove());
    void done;
  });
});
