import { describe, it, expect, afterEach } from 'vitest';
import { CommandRegistry } from '../src/commands/registry.js';
import { comboFor, shortcutListText, KEY_ROWS, NAV_ROWS, categoryOf, modsLabel, shortcutsDialog } from '../src/ui/shortcuts-dialog.js';

function makeApp(stored = {}) {
  const store = { ...stored };
  const app = { prefs: { get: (k) => store[k], set: (k, v) => (store[k] = v) }, store };
  app.commands = new CommandRegistry(app);
  app.commands.register([
    { id: 'clip.split', label: 'Split', shortcut: 'Mod+K', run() {} },
    { id: 'transport.shuttleStop', label: 'Shuttle Stop', shortcut: 'K', run() {} },
    { id: 'edit.copy', label: 'Copy', shortcut: 'Mod+C', run() {} },
    { id: 'transport.jumpToTime', label: 'Jump to Time...', run() {} },
  ]);
  return app;
}

const press = (init) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const dialog = () => document.querySelector('.shortcuts-dialog');
const keyCap = (key) => dialog().querySelector(`.sc-key[data-key="${key}"]`);
const ctrlKey = () => [...dialog().querySelectorAll('.sc-mod')].find((b) => b.textContent.includes('Ctrl'));
const footButton = (text) => [...dialog().querySelectorAll('.dialog-foot button')].find((b) => b.textContent === text);

afterEach(() => document.querySelectorAll('.dialog-backdrop').forEach((d) => d.remove()));

describe('shortcuts dialog helpers', () => {
  it('builds combos in a fixed modifier order', () => {
    expect(comboFor('S', new Set(['Shift', 'Mod']))).toBe('Mod+Shift+S');
    expect(comboFor('F1', new Set())).toBe('F1');
    expect(modsLabel(new Set())).toBe('None');
    expect(modsLabel(new Set(['Shift', 'Mod']))).toBe('Ctrl+Shift');
  });

  it('lists every bound command as text, optionally by category', () => {
    const store = {};
    const C = new CommandRegistry({ prefs: { get: (k) => store[k], set: (k, v) => (store[k] = v) } });
    C.register([{ id: 'a.one', label: 'Beta', shortcut: 'B', run() {} }, { id: 'a.two', label: 'Alpha', shortcut: 'A', run() {} }, { id: 'a.three', label: 'None', run() {} }, { id: 'clip.x', label: 'Gamma', shortcut: 'Mod+G', run() {} }]);
    expect(shortcutListText(C, (id) => C.label(id))).toBe('Alpha\tA\nBeta\tB\nGamma\tCtrl+G');
    expect(shortcutListText(C, (id) => C.label(id), categoryOf)).toBe('A\n  Alpha\tA\n  Beta\tB\n\nClip\n  Gamma\tCtrl+G');
  });

  it('groups commands like the menus', () => {
    expect(categoryOf('clip.split')).toBe('Clip');
    expect(categoryOf('zero.inward')).toBe('Edit');
    expect(categoryOf('spectral.opacityUp')).toBe('Tools');
    expect(categoryOf('transport.meterInput')).toBe('Metering');
    expect(categoryOf('prefs.general')).toBe('Preferences');
  });

  it('switches whole keymaps', () => {
    const store = {};
    const C = new CommandRegistry({ prefs: { get: (k) => store[k], set: (k, v) => (store[k] = v) } });
    C.register({ id: 'x.play', label: 'Play', shortcut: 'Space', run() {} });
    C.replaceOverrides({ 'x.play': ['Enter'] });
    expect(C.commandFor('Enter')).toBe('x.play');
    expect(C.commandFor('Space')).toBe(null);
    C.replaceOverrides({});
    expect(C.commandFor('Space')).toBe('x.play');
    expect(store.shortcuts).toEqual({});
  });

  it('draws every key once, with rows of equal width', () => {
    const keys = [...KEY_ROWS, ...NAV_ROWS].flat().map((k) => k[0]).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    const widths = KEY_ROWS.map((row) => row.reduce((s, k) => s + Math.round((k[2] ?? 1) * 4), 0));
    expect(new Set(widths)).toEqual(new Set([60]));
    for (const row of NAV_ROWS) if (row.length) expect(row.reduce((s, k) => s + Math.round((k[2] ?? 1) * 4), 0)).toBe(12);
  });
});

describe('shortcuts dialog', () => {
  it('shows the commands of the modifier layer in view', () => {
    const app = makeApp();
    shortcutsDialog(app);
    expect(keyCap('K').classList.contains('k-app')).toBe(true);
    expect(keyCap('K').textContent).toContain('Shuttle Stop');
    expect(keyCap('Escape').classList.contains('k-panel')).toBe(true);
    // The Ctrl (Mod) key switches the map to its layer.
    ctrlKey().click();
    expect(keyCap('K').textContent).toContain('Split');
    expect(keyCap('W').classList.contains('k-reserved')).toBe(true);
    // Holding a modifier shows its layer too.
    ctrlKey().click();
    press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    expect(dialog().querySelector('.sc-layer').textContent).toContain('Shift');
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft' }));
    expect(dialog().querySelector('.sc-layer').textContent).not.toContain('Showing');
  });

  it('lists what a key does with each modifier and selects its command', () => {
    const app = makeApp();
    shortcutsDialog(app);
    keyCap('K').click();
    const rows = [...dialog().querySelectorAll('.sc-key-row')];
    // Buttons keep their role (a listitem role would hide that they can be pressed).
    expect(rows.every((r) => r.tagName === 'BUTTON' && !r.hasAttribute('role'))).toBe(true);
    expect(dialog().querySelector('.sc-pane-title').textContent).toBe('Key: K');
    expect(rows[0].textContent).toContain('Shuttle Stop');
    expect(rows[1].textContent).toContain('Split');
    rows[1].click();
    expect(dialog().querySelector('.sc-row.k-selected').dataset.id).toBe('clip.split');
  });

  it('searches commands by name and by key', () => {
    const app = makeApp();
    shortcutsDialog(app);
    const search = dialog().querySelector('.sc-search');
    search.value = 'jump';
    search.dispatchEvent(new Event('input'));
    expect([...dialog().querySelectorAll('.sc-row')].map((r) => r.dataset.id)).toEqual(['transport.jumpToTime']);
    search.value = 'ctrl+c';
    search.dispatchEvent(new Event('input'));
    expect([...dialog().querySelectorAll('.sc-row')].map((r) => r.dataset.id)).toEqual(['edit.copy']);
  });

  it('records a new key, moves it from another command, undoes, and keeps changes on OK', async () => {
    const app = makeApp();
    const done = shortcutsDialog(app);
    const search = dialog().querySelector('.sc-search');
    search.value = 'jump';
    search.dispatchEvent(new Event('input'));
    dialog().querySelector('.sc-row .sc-add').click();
    press({ key: 'k', code: 'KeyK' });
    expect(app.commands.commandFor('K')).toBe('transport.jumpToTime');
    expect(app.commands.keysFor('transport.shuttleStop')).toEqual([]);
    expect(dialog().querySelector('.sc-status').textContent).toContain('instead of');
    expect(dialog().querySelector('.sc-preset').selectedOptions[0].textContent).toContain('modified');
    // A key the browser keeps is refused.
    dialog().querySelector('.sc-row .sc-add').click();
    press({ key: 'w', code: 'KeyW', ctrlKey: true });
    expect(app.commands.commandFor('Mod+W')).toBe(null);
    // Tab and Shift+Tab move keyboard focus, so they are refused too.
    dialog().querySelector('.sc-row .sc-add').click();
    press({ key: 'Tab', code: 'Tab' });
    expect(app.commands.commandFor('Tab')).toBe(null);
    expect(dialog().querySelector('.sc-status').textContent).toContain('moves keyboard focus');
    dialog().querySelector('.sc-row .sc-add').click();
    press({ key: 'Tab', code: 'Tab', shiftKey: true });
    expect(app.commands.commandFor('Shift+Tab')).toBe(null);
    // Undo restores the previous keymap.
    [...dialog().querySelectorAll('.sc-actions button')].find((b) => b.textContent.includes('Undo')).click();
    expect(app.commands.commandFor('K')).toBe('transport.shuttleStop');
    dialog().querySelector('.sc-row .sc-add').click();
    press({ key: 'j', code: 'KeyJ', shiftKey: true });
    footButton('OK').click();
    await done;
    expect(app.commands.commandFor('Shift+J')).toBe('transport.jumpToTime');
    expect(app.store.shortcuts['transport.jumpToTime']).toEqual(['shift+j']);
  });

  it('Cancel restores the keymap it opened with', async () => {
    const app = makeApp();
    const done = shortcutsDialog(app);
    keyCap('K').click();
    const row = [...dialog().querySelectorAll('.sc-key-row')][0];
    row.click();
    [...dialog().querySelectorAll('.sc-actions button')].find((b) => b.textContent === 'Clear').click();
    expect(app.commands.commandFor('K')).toBe(null);
    footButton('Cancel').click();
    await done;
    expect(app.commands.commandFor('K')).toBe('transport.shuttleStop');
  });

  it('switches to a saved preset; the default set stays read-only', () => {
    const app = makeApp({ shortcutSets: { Mine: { 'clip.split': ['Mod+Shift+K'] } } });
    shortcutsDialog(app);
    const sel = dialog().querySelector('.sc-preset');
    expect(sel.options[0].textContent).toBe('Default Set (read-only)');
    expect(dialog().querySelector('[aria-label="Delete this preset"]').disabled).toBe(true);
    sel.value = 'Mine';
    sel.dispatchEvent(new Event('change'));
    expect(app.commands.commandFor('Mod+Shift+K')).toBe('clip.split');
    expect(app.store.shortcutSet).toBe('Mine');
    expect(dialog().querySelector('[aria-label="Delete this preset"]').disabled).toBe(false);
  });
});
