// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { SYMBOL_GROUPS, symbolName, openSymbolPicker } from '../src/ui/symbols.js';
import { formatToday } from '../src/lib/editor-helpers.js';

describe('symbols', () => {
  // A closed dialog leaves the page 200 ms later; let that finish before the environment goes away.
  afterEach(() => new Promise(resolve => setTimeout(resolve, 250)));

  it('lists distinct single characters with readable names for the cryptic ones', () => {
    const all = SYMBOL_GROUPS.flatMap(([, chars]) => chars);
    expect(all.length).toBeGreaterThan(60);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((c) => [...c].length === 1)).toBe(true);
    expect(symbolName('—')).toBe('Em dash');
    expect(symbolName('é')).toBe('é');
  });

  it('inserts the picked character and closes', () => {
    document.body.innerHTML = '<div id="app"></div>';
    window.matchMedia = () => ({ matches: true, addEventListener() {} });
    const picked = [];
    openSymbolPicker({ onPick: (ch) => picked.push(ch) });
    const btn = [...document.querySelectorAll('.symbol')].find((b) => b.textContent === '→');
    expect(btn.getAttribute('aria-label')).toBe('Right arrow');
    btn.click();
    expect(picked).toEqual(['→']);
    expect(document.querySelector('.modal-root').classList.contains('closing')).toBe(true);
  });

  it('moves through the grids with the arrow keys and offers one Tab stop per group', () => {
    document.body.innerHTML = '<div id="app"></div>';
    window.matchMedia = () => ({ matches: true, addEventListener() {} });
    openSymbolPicker({ onPick: () => {} });
    const grids = [...document.querySelectorAll('.symbol-grid')];
    // Four buttons per row, as the layout would report it.
    for (const grid of grids) [...grid.children].forEach((button, i) => Object.defineProperty(button, 'offsetTop', { value: Math.floor(i / 4) * 44 }));
    const first = [...grids[0].children], second = [...grids[1].children];
    expect(document.querySelectorAll('.symbol[tabindex="0"]')).toHaveLength(grids.length);
    expect(first.map((b) => b.tabIndex)).toEqual(first.map((_, i) => (i ? -1 : 0)));
    const press = (key, shiftKey = false) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    first[0].focus();
    press('ArrowRight'); expect(document.activeElement).toBe(first[1]);
    press('ArrowDown'); expect(document.activeElement).toBe(first[5]);
    press('ArrowUp'); expect(document.activeElement).toBe(first[1]);
    press('End'); expect(document.activeElement).toBe(first.at(-1));
    press('ArrowRight'); expect(document.activeElement).toBe(second[0]);
    press('ArrowLeft'); expect(document.activeElement).toBe(first.at(-1));
    press('Home'); expect(document.activeElement).toBe(first[0]);
    press('ArrowUp'); expect(document.activeElement).toBe(first[0]);
    // Down from the last row lands in the same column of the next group; the visited button keeps the group's Tab stop.
    first.at(-1).focus(); press('ArrowDown');
    expect(document.activeElement).toBe(second[Math.min((first.length - 1) % 4, second.length - 1)]);
    expect(first.filter((b) => b.tabIndex === 0)).toEqual([first.at(-1)]);
    press('End', true); expect(document.activeElement).toBe([...grids.at(-1).children].at(-1));
    press('Home', true); expect(document.activeElement).toBe(first[0]);
  });

  it('formats today like a letter would', () => {
    expect(formatToday(new Date(2026, 7, 27), 'en-US')).toBe('August 27, 2026');
  });
});
