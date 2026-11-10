// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openAutoCorrectDialog, resetAutoCorrectCache } from '../src/ui/autocorrect.js';
import { closeAllModals } from '../src/ui/modal.js';

// In Tools ▸ AutoCorrect Options, the arrows walk the list of replacements. Picking one puts its word in the
// Replace field, and the list put the entries beginning with that field's text first: the entry picked jumped
// to the top, and the next Down went back to the one before it, so the arrows swung between two entries and
// never got further. The list is ordered by what was typed in Replace, not by what the arrows picked.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  resetAutoCorrectCache();
  Element.prototype.scrollIntoView = () => {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

const key = (target, name) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

it('walks down the whole list of replacements with the arrow keys', () => {
  openAutoCorrectDialog();
  const list = document.querySelector('.autocorrect-list');
  const [from] = document.querySelectorAll('.autocorrect-fields input');
  const order = [...list.children].map((n) => n.querySelector('.autocorrect-from').textContent);
  list.focus();
  const seen = [];
  for (let i = 0; i < 5; i++) { key(list, 'ArrowDown'); seen.push(from.value); }
  expect(seen).toEqual(order.slice(0, 5));
  key(list, 'ArrowUp');
  expect(from.value).toBe(order[3]);
  key(list, 'End');
  expect(from.value).toBe(order.at(-1));
});
