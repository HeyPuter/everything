// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { createKeymap, shownShortcuts } from '../src/views/keymap.js';
import { syncShownShortcuts, withShownShortcuts } from '../src/ui/command-index.js';

afterEach(() => localStorage.clear());
const keymap = () => createKeymap({ defaults: {}, run: () => {}, storage: localStorage, mac: false });

it('shows a command\'s built-in chord until another command takes it, then its own chords', () => {
  const map = keymap();
  expect(shownShortcuts(map, 'bold', 'Ctrl+B', false)).toEqual(['Ctrl+B']);
  map.assign('italic', 'Mod+B');
  expect(shownShortcuts(map, 'bold', 'Ctrl+B', false)).toEqual([]);
  expect(shownShortcuts(map, 'italic', 'Ctrl+I', false)).toEqual(['Ctrl+I', 'Ctrl+B']);
  expect(shownShortcuts(map, 'none', null, false)).toEqual([]);
});

it('rewrites ribbon tooltips and aria-keyshortcuts, and menu items, from the keymap', () => {
  const map = keymap(), shown = (id, builtIn) => shownShortcuts(map, id, builtIn, false);
  const button = (label, shortcut, title = `${label} (${shortcut})`) => { const b = document.createElement('button'); b.title = title; if (shortcut) b.dataset.shortcut = shortcut; return b; };
  const bold = button('Bold', 'Ctrl+B'), clear = button('Clear', 'Ctrl+Space', 'Clear All Formatting (Ctrl+Space). Keeps styles.'), plain = button('Plain', null, 'Plain');
  const entries = [{ id: 'bold', label: 'Bold', control: bold }, { id: 'clear', label: 'Clear', control: clear }, { id: 'plain', label: 'Plain', control: plain }];
  map.assign('italic', 'Mod+B'); map.assign('plain', 'Mod+Alt+P'); map.assign('other', 'Mod+Space');
  syncShownShortcuts(entries, shown);
  expect([bold.title, bold.hasAttribute('aria-keyshortcuts')]).toEqual(['Bold', false]);
  expect(clear.title).toBe('Clear All Formatting. Keeps styles.');
  expect([plain.title, plain.getAttribute('aria-keyshortcuts')]).toEqual(['Plain (Ctrl+Alt+P)', 'Control+Alt+P']);
  // The built-in chord stays the command's own, for Customize Keyboard.
  expect(bold.dataset.shortcut).toBe('Ctrl+B');
  map.reset();
  syncShownShortcuts(entries, shown);
  expect([bold.title, bold.getAttribute('aria-keyshortcuts')]).toEqual(['Bold (Ctrl+B)', 'Control+B']);
  expect([clear.title, plain.title]).toEqual(['Clear All Formatting (Ctrl+Space). Keeps styles.', 'Plain']);
  // Menu items, by the ids their entries have.
  map.assign('menu:format/Text/Bold', 'Mod+Alt+B'); map.assign('elsewhere', 'Mod+D');
  const items = withShownShortcuts([{ label: 'Font…', shortcut: 'Ctrl+D', onSelect() {} }, { separator: true }, { label: 'Text', items: [{ label: 'Bold', onSelect() {} }] }], 'menu:format', shown);
  expect(items[0].shortcut).toBeNull();
  expect(items[2].items[0].shortcut).toBe('Ctrl+Alt+B');
});
