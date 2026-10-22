// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { openShortcuts } from '../src/ui/shortcuts.js';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// Ctrl+D duplicates a selected chart, picture or text box, as in Excel, instead of filling the cells hidden behind
// it; the Keyboard Shortcuts list names it beside the other keys for objects, so it can be found.
it('lists Ctrl+D for duplicating the selected object among the keys for objects', () => {
  document.body.replaceChildren();
  openShortcuts();
  const rows = [...document.querySelectorAll('.modal-panel.wide .shortcut-row')];
  const row = rows.find((r) => r.querySelector('.shortcut-what').textContent === 'Duplicate the selected chart, image, or text box');
  expect(row.querySelector('.shortcut-keys').textContent).toBe('Ctrl+D');
  expect(row.closest('.shortcut-group').querySelector('h3').textContent).toBe('Navigate');
});
