// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/memory-storage.js';
import { openMenu, closeMenu, isMenuOpen } from '../src/ui/menu.js';
import { createToolbar } from '../src/ui/toolbar.js';
import { createSheetTabs } from '../src/ui/sheettabs.js';
import { Workbook } from '../src/core/workbook.js';
import { rememberColor } from '../src/ui/colorpicker.js';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { closeMenu(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

const key = (name, extra = {}) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra }));
const menuEl = () => document.querySelector('.menu');
const swatches = () => [...menuEl().querySelectorAll('.swatches:not(.swatches-recent):not(.swatches-theme) .swatch')];

function toolbar() {
  const wb = new Workbook();
  const bar = createToolbar({
    wb, run() {}, activeCell: () => null, style: () => ({}), active: () => ({ r: 0, c: 0 }),
    range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), sheetId: () => wb.activeSheetId,
    grid: { editing: false }, subscribe: () => () => {},
  });
  document.body.append(bar.el);
  return bar;
}

// The 13-swatch grid clamped its own arrow keys to the grid, so Down or Right from the last swatch
// stayed put, and the recent colours, the Custom swatch and the hex field below were never reached
// by an arrow; Tab, the one key that could reach the field, closed the menu instead.
describe('keyboard in a colour menu', () => {
  it('walks out of the swatch grid into the Custom swatch, and Tab reaches the hex field', () => {
    toolbar();
    document.querySelector('[aria-label="Text color"]').click();
    const grid = swatches();
    expect(grid).toHaveLength(13);
    grid.at(-1).focus();
    key('ArrowDown');
    expect(document.activeElement).toBe(menuEl().querySelector('.swatch.custom'));
    key('ArrowLeft');
    expect(document.activeElement).toBe(grid.at(-1));
    key('ArrowRight');
    expect(document.activeElement).toBe(menuEl().querySelector('.swatch.custom'));
    key('Tab');
    expect(document.activeElement).toBe(menuEl().querySelector('.color-hex'));
    expect(isMenuOpen()).toBe(true);
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(menuEl().querySelector('.swatch.custom'));
    key('Tab');
    key('Tab'); // past the last control, Tab leaves the menu as before
    expect(isMenuOpen()).toBe(false);
  });

  it('moves a row at a time inside the grid and wraps from its first row to the menu end', () => {
    toolbar();
    document.querySelector('[aria-label="Fill color"]').click();
    const grid = swatches();
    grid[1].focus();
    key('ArrowDown');
    expect(document.activeElement).toBe(grid[7]);
    key('ArrowDown'); // the third row has one swatch; past it comes the Custom swatch
    expect(document.activeElement).toBe(menuEl().querySelector('.swatch.custom'));
    key('ArrowUp');
    expect(document.activeElement).toBe(grid.at(-1));
    // Above the standard colours sit the theme colours; Up from their top row wraps to the menu end.
    grid[0].focus();
    key('ArrowUp');
    const theme = [...menuEl().querySelectorAll('.swatches-theme .swatch')];
    expect(document.activeElement).toBe(theme.at(-1));
    theme[0].focus();
    key('ArrowUp');
    expect(document.activeElement).toBe(menuEl().querySelector('.swatch.custom'));
  });

  it('reaches the recent colours row under the grid by arrow', () => {
    rememberColor('#123456');
    toolbar();
    document.querySelector('[aria-label="Text color"]').click();
    swatches().at(-1).focus();
    key('ArrowDown');
    expect(document.activeElement.getAttribute('aria-label')).toBe('Dark blue, #123456');
    key('ArrowDown');
    expect(document.activeElement).toBe(menuEl().querySelector('.swatch.custom'));
  });

  it('does the same in the border colour and sheet tab colour menus', () => {
    toolbar();
    document.querySelector('[aria-label="Borders"]').click();
    [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Border color')).click();
    expect(menuEl().getAttribute('aria-label')).toBe('Border color');
    swatches().at(-1).focus();
    key('ArrowDown');
    expect(document.activeElement).toBe(menuEl().querySelector('.swatch.custom'));
    key('Tab');
    expect(document.activeElement).toBe(menuEl().querySelector('.color-hex'));
    closeMenu();
    document.body.replaceChildren();

    const wb = new Workbook({ sheets: [{ name: 'First' }] });
    const tabs = createSheetTabs({ wb });
    document.body.append(tabs.el);
    tabs.el.querySelector('.tab-menu-btn').click();
    [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Tab Color')).click();
    expect(menuEl().getAttribute('aria-label')).toBe('Tab color');
    swatches().at(-1).focus();
    key('ArrowRight');
    expect(document.activeElement).toBe(menuEl().querySelector('.swatch.custom'));
    key('Tab');
    expect(document.activeElement).toBe(menuEl().querySelector('.color-hex'));
    tabs.destroy();
  });
});

describe('a menu without a field', () => {
  it('still leaves the whole menu on Tab', () => {
    openMenu({ x: 10, y: 10, items: [{ label: 'One' }, { label: 'Two' }] });
    key('Tab');
    expect(isMenuOpen()).toBe(false);
  });

  it('steps a data-cols grid by row and out of it at either edge', () => {
    const grid = document.createElement('div');
    grid.dataset.cols = '3';
    grid.innerHTML = Array.from({ length: 7 }, (_, i) => `<button role="menuitemradio">${i}</button>`).join('');
    openMenu({ x: 10, y: 10, items: [{ custom: grid }, { label: 'After' }] });
    grid.children[4].focus();
    key('ArrowDown');
    expect(document.activeElement.textContent).toBe('After'); // no cell below 4; the item after the grid comes next
    key('ArrowUp');
    expect(document.activeElement.textContent).toBe('6'); // back onto the grid's last cell
    key('ArrowUp');
    expect(document.activeElement.textContent).toBe('3');
    grid.children[1].focus();
    key('ArrowUp');
    expect(document.activeElement.textContent).toBe('After'); // nothing before the grid: round to the end
    grid.children[6].focus();
    key('ArrowRight');
    expect(document.activeElement.textContent).toBe('After');
  });
});
