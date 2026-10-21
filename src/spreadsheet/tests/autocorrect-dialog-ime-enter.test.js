// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openAutoCorrectDialog, resetAutoCorrectCache } from '../src/ui/autocorrect.js';
import { closeAllModals } from '../src/ui/modal.js';

// In Tools ▸ AutoCorrect Options, Enter in the Replace or With field adds the entry. Enter also confirms a word
// being composed with an input method (Japanese, Chinese, Korean), and that press added the entry there and then,
// with the word half-converted and the other field still empty. A press that ends a composition now only ends it.
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

const count = () => Number(document.querySelector('.autocorrect-actions .small').textContent.match(/\d+/)[0]);

it('leaves the entry alone on an Enter that confirms a composed word', () => {
  openAutoCorrectDialog();
  const [from, to] = document.querySelectorAll('.autocorrect-fields input');
  const before = count();
  from.value = 'かな';
  from.dispatchEvent(new Event('input', { bubbles: true }));
  from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  expect(count()).toBe(before);
  to.value = '仮名';
  to.dispatchEvent(new Event('input', { bubbles: true }));
  to.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
  expect(count()).toBe(before);
  // An Enter of its own adds it.
  to.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(count()).toBe(before + 1);
});
