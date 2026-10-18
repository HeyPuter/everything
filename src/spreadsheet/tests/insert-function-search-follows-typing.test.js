// @vitest-environment jsdom
// Insert Function filtered its list only on Enter or Go: typing "vlookup" left the list of recently used
// functions in place, so Down and Enter, the natural next keys, inserted the function heading that old list
// (SUM, SPARKLINE…) instead. The list now follows the search as it is typed.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openInsertFunctionDialog } from '../src/ui/insertfunction.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  Element.prototype.scrollIntoView = () => {};
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

const key = (target, name) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
const options = () => [...document.querySelectorAll('.fn-dialog-list [role="option"]')].map((o) => o.textContent);

it('filters the functions as the search is typed, so Down and Enter pick from the matches', () => {
  const onPick = vi.fn();
  openInsertFunctionDialog({ grid: { focus() {} } }, { onPick });
  const search = document.querySelector('input[type="search"]');
  expect(document.activeElement).toBe(search);
  search.value = 'vlookup';
  search.dispatchEvent(new InputEvent('input', { bubbles: true }));
  expect(options()[0]).toBe('VLOOKUP');
  key(search, 'ArrowDown');
  key(document.activeElement, 'Enter');
  expect(onPick).toHaveBeenCalledWith('VLOOKUP');
});

it('waits for a composed word before searching, and goes back to the category when cleared', () => {
  openInsertFunctionDialog({ grid: { focus() {} } }, { onPick() {} });
  const search = document.querySelector('input[type="search"]');
  const before = options();
  search.value = 'xlook';
  search.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
  expect(options()).toEqual(before);
  search.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  expect(options()).toContain('XLOOKUP');
  search.value = '';
  search.dispatchEvent(new InputEvent('input', { bubbles: true }));
  expect(options()).toEqual(before);
});
