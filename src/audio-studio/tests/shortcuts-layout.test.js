import { afterEach, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../src/commands/registry.js';
import { localKey, keyCode, shortcutsDialog } from '../src/ui/shortcuts-dialog.js';

// A French keyboard: the A and Q keys, the Z and W keys swap, and M sits where ";" is.
const AZERTY = new Map([['KeyQ', 'a'], ['KeyA', 'q'], ['KeyW', 'z'], ['KeyZ', 'w'], ['Semicolon', 'm'], ['KeyM', ','], ['Digit1', '&']]);

afterEach(() => {
  document.querySelectorAll('.dialog-backdrop').forEach((d) => d.remove());
  vi.unstubAllGlobals();
});

it('names keys as the keyboard types them', () => {
  expect(keyCode('Q')).toBe('KeyQ');
  expect(keyCode(';')).toBe('Semicolon');
  expect(keyCode('Home')).toBe(null);
  expect(localKey('Q', AZERTY)).toBe('A');
  expect(localKey(';', AZERTY)).toBe('M');
  // Keys that type no letter keep their place: shortcuts use their position.
  expect(localKey('M', AZERTY)).toBe('M');
  expect(localKey('1', AZERTY)).toBe('1');
  expect(localKey('Q', null)).toBe('Q');
});

it('draws the board in the layout of this keyboard, or U.S. on request', async () => {
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { keyboard: { getLayoutMap: async () => AZERTY } }));
  const store = {};
  const app = { prefs: { get: (k) => store[k], set: (k, v) => (store[k] = v) } };
  app.commands = new CommandRegistry(app);
  app.commands.register([{ id: 'tool.time', label: 'Time Selection', shortcut: 'T', run() {} }, { id: 'edit.addA', label: 'Do A', shortcut: 'A', run() {} }]);
  shortcutsDialog(app);
  const dlg = document.querySelector('.shortcuts-dialog');
  await vi.waitFor(() => expect(dlg.querySelector('.sc-layout-row').hidden).toBe(false));
  // The key drawn where Q is on a U.S. keyboard types A here, and runs A's command.
  const caps = [...dlg.querySelectorAll('.sc-key[data-key]')];
  const row = caps.filter((b) => b.closest('.sc-board') && ['A', 'Z', 'E', 'R', 'T'].includes(b.dataset.key)).map((b) => b.dataset.key);
  expect(row.slice(0, 5)).toEqual(['A', 'Z', 'E', 'R', 'T']);
  expect(dlg.querySelector('.sc-key[data-key="A"] .sc-key-cmd').textContent).toBe('Do A');
  const sel = dlg.querySelector('[aria-label="Keyboard layout"]');
  sel.value = 'us';
  sel.dispatchEvent(new Event('change'));
  expect(store.shortcutLayout).toBe('us');
  expect(caps.slice(caps.findIndex((b) => b.dataset.key === 'Q'), caps.findIndex((b) => b.dataset.key === 'Q') + 2).map((b) => b.dataset.key)).toEqual(['Q', 'W']);
});
