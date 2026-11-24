// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createKeymap } from '../src/views/keymap.js';
import { openCustomizeKeyboard } from '../src/views/customize-keyboard.js';

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); document.body.replaceChildren(); });

it('Customize Keyboard says when its list leaves commands out, and how to find them', () => {
  const keymap = createKeymap({ defaults: {}, run: () => {}, storage: localStorage, mac: false });
  // More commands than the list shows at once, as the app has (over 1,500 under All commands).
  const entries = Array.from({ length: 450 }, (_, i) => ({ id: `c${i}`, label: `Command ${String(i).padStart(3, '0')}`, path: [i < 300 ? 'Home' : 'View', 'Group'] }));
  const modal = openCustomizeKeyboard({ entries: () => entries, keymap });
  const options = () => document.querySelectorAll('.kb-list [role="option"]').length;
  const note = document.querySelector('.kb-more');
  expect(options()).toBe(400);
  // The list ended at Command 399 with nothing to say the other 50 exist.
  expect(note.hidden).toBe(false);
  expect(note.textContent).toBe('Showing 400 of 450 commands. Choose a category or search to find the others.');
  const category = document.querySelector('select[aria-label="Category"]');
  category.value = 'View';
  category.dispatchEvent(new Event('change'));
  expect(options()).toBe(150);
  expect(note.hidden).toBe(true);
  category.value = '';
  category.dispatchEvent(new Event('change'));
  const search = document.querySelector('input[aria-label="Search commands"]');
  search.value = 'Command 44';
  search.dispatchEvent(new Event('input'));
  expect(options()).toBe(10);
  expect(note.hidden).toBe(true);
  modal.close();
});
