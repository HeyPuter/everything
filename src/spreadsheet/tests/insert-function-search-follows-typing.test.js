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

// The matches were listed in name order alone: "sum" listed DEVSQ, DSUM, GROUPBY... before SUM (found in their
// descriptions), and "count" listed AMORDEGRC first, so Down and Enter inserted a function nobody searched for.
it('lists the function named by the search first, then the names that begin with it', () => {
  openInsertFunctionDialog({ grid: { focus() {} } }, { onPick() {} });
  const search = document.querySelector('input[type="search"]');
  const find = (text) => { search.value = text; search.dispatchEvent(new InputEvent('input', { bubbles: true })); return options(); };
  const sum = find('sum');
  expect(sum[0]).toBe('SUM');
  expect(sum.slice(1, 4)).toEqual(['SUMIF', 'SUMIFS', 'SUMPRODUCT']);
  expect(sum.indexOf('DSUM')).toBeLessThan(sum.indexOf('DEVSQ'));
  expect(find('count')[0]).toBe('COUNT');
  expect(find('if')[0]).toBe('IF');
});
