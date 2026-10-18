// @vitest-environment jsdom
// Insert ▸ Symbol listed its symbols as a listbox but made each one a Tab stop and gave the arrow keys
// nothing to do: reaching Insert from the search field took about a hundred presses of Tab. On a phone its
// sixteen 30px columns ran past the screen's edge. Each list is now one Tab stop walked with the arrows
// (by the columns drawn), Enter inserts the symbol, and a narrow window draws as many columns as fit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSymbolDialog } from '../src/ui/symboldialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { stylesheet, declared } from './helpers/css.js';

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  Element.prototype.scrollIntoView = () => {};
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  localStorage.clear();
});
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

const key = (name) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
const cells = () => [...document.querySelectorAll('.symbol-grid .symbol-cell')];
const open = () => {
  const ctx = { run: vi.fn(), grid: { focus() {} } };
  openSymbolDialog(ctx);
  return ctx;
};

describe('Symbol dialog keyboard', () => {
  it('makes the symbol list a single Tab stop, on the chosen symbol', () => {
    open();
    const stops = cells().filter((b) => b.tabIndex >= 0);
    expect(stops).toHaveLength(1);
    expect(stops[0].getAttribute('aria-selected')).toBe('true');
    expect(stops[0].dataset.ch).toBe('©');
  });

  it('walks the symbols with the arrow keys, a row at a time by the columns drawn', () => {
    open();
    const start = cells().findIndex((b) => b.dataset.ch === '©');
    cells()[start].focus();
    key('ArrowRight');
    expect(document.activeElement).toBe(cells()[start + 1]);
    expect(document.activeElement.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement.tabIndex).toBe(0);
    key('ArrowDown');
    expect(document.activeElement).toBe(cells()[start + 17]);
    key('Home');
    expect(document.activeElement).toBe(cells()[0]);
    key('ArrowUp'); // nothing above the first row
    expect(document.activeElement).toBe(cells()[0]);
    // Three columns drawn (a narrow window): Down goes three along.
    document.querySelector('.symbol-grid').style.gridTemplateColumns = '30px 30px 30px';
    key('ArrowDown');
    expect(document.activeElement).toBe(cells()[3]);
    key('End');
    expect(document.activeElement).toBe(cells().at(-1));
  });

  it('inserts the focused symbol with Enter', () => {
    const ctx = open();
    const start = cells().findIndex((b) => b.dataset.ch === '©');
    cells()[start].focus();
    key('ArrowLeft');
    const ch = document.activeElement.dataset.ch;
    key('Enter');
    expect(ctx.run).toHaveBeenCalledWith('insertSymbol', ch);
    expect(document.querySelector('.modal-root:not(.closing)')).toBe(null);
  });

  it('keeps one Tab stop after a search narrows the list', () => {
    open();
    const search = document.querySelector('input[type="search"]');
    search.value = 'pound';
    search.dispatchEvent(new Event('input'));
    expect(cells().length).toBeGreaterThan(0);
    expect(cells().filter((b) => b.tabIndex >= 0)).toHaveLength(1);
  });

  it('draws as many columns as fit on a phone', () => {
    const css = stylesheet('chrome.css');
    expect(declared(css, '.symbol-grid', false)['grid-template-columns']).toBe('repeat(16, minmax(0, 1fr))');
    expect(declared(css, '.symbol-grid', 'max-width: 639px')['grid-template-columns']).toBe('repeat(auto-fill, minmax(30px, 1fr))');
  });
});
