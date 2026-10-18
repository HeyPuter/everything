// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolbar, swatchColor } from '../src/ui/toolbar.js';
import { createSheetTabs } from '../src/ui/sheettabs.js';
import { closeMenu } from '../src/ui/menu.js';
import { rememberColor, colorLabel } from '../src/ui/colorpicker.js';
import { Workbook } from '../src/core/workbook.js';
import { memoryStorage } from './helpers/memory-storage.js';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { closeMenu(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

function toolbarShowing(style) {
  const wb = new Workbook();
  const toolbar = createToolbar({
    wb, run() {}, activeCell: () => ({}), style: () => style, active: () => ({ r: 0, c: 0 }),
    range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), sheetId: () => wb.activeSheetId,
    grid: { editing: false }, subscribe: () => () => {},
  });
  document.body.append(toolbar.el);
  toolbar.refresh();
  const bars = toolbar.el.querySelectorAll('.color-bar');
  return { toolbar, text: bars[0], fill: bars[1] };
}
// Swatches are named for a screen reader ("Red", "Dark blue, #123456"): the checked one is told by that name.
const checkedSwatch = () => document.querySelector('.menu .swatch[aria-checked="true"]')?.getAttribute('aria-label') ?? null;

// The swatch bars accepted any 3-to-8-digit hex string, 5 and 7 digits included, which the CSSOM
// rejects: the assignment was ignored and the bar kept the previous cell's colour.
describe('the colour bars under the text and fill buttons', () => {
  it('show the defaults for a hex string of 5 or 7 digits instead of the previous colour', () => {
    const style = { color: '#c22a2a', bg: '#fde8e8' };
    const { toolbar, text, fill } = toolbarShowing(style);
    expect(text.style.backgroundColor).toBe('rgb(194, 42, 42)');
    style.color = '#12345';
    style.bg = '#1234567';
    toolbar.refresh();
    expect(text.style.backgroundColor).toBe('var(--ink)');
    expect(fill.style.backgroundColor).toBe('transparent');
    expect(fill.classList.contains('no-fill')).toBe(true);
  });

  it('accept 3, 4, 6 and 8 digits in either case, and nothing else', () => {
    for (const hex of ['#abc', '#ABCD', '#0A63F0', '#0a63f080']) expect(swatchColor(hex), hex).toBe(hex);
    for (const bad of ['#12345', '#1234567', '#123456789', '#ab', 'red', 'url(#abc)', '', null, undefined]) expect(swatchColor(bad), String(bad)).toBeNull();
    const { text } = toolbarShowing({ color: '#0A63F0' });
    expect(text.style.backgroundColor).toBe('rgb(10, 99, 240)');
  });
});

// The colour menus compared the cell's colour with the swatches as strings, and .xlsx files spell colours
// in upper case: a cell in the palette's own red showed no checked swatch.
describe('the checked swatch of a colour menu', () => {
  it('matches the cell\'s colour whatever its case, in the palette and among the recent colours', () => {
    rememberColor('#123456');
    const { toolbar } = toolbarShowing({ color: '#C22A2A', bg: '#FDE8E8' });
    toolbar.el.querySelector('[aria-label="Text color"]').click();
    expect(checkedSwatch()).toBe(colorLabel('#c22a2a'));
    closeMenu();
    toolbar.el.querySelector('[aria-label="Fill color"]').click();
    expect(checkedSwatch()).toBe(colorLabel('#fde8e8'));
    closeMenu();
    document.body.replaceChildren();
    const recent = toolbarShowing({ color: '#123456'.toUpperCase() });
    recent.toolbar.el.querySelector('[aria-label="Text color"]').click();
    expect(checkedSwatch()).toBe(colorLabel('#123456'));
    expect(document.querySelector('.menu .color-hex').value).toBe('#123456');
  });

  it('matches the border pen\'s colour and a sheet tab\'s colour whatever their case', () => {
    const { toolbar } = toolbarShowing({ bt: true, bc: '#0A63F0' });
    toolbar.el.querySelector('[aria-label="Borders"]').click();
    [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Border color')).click();
    expect(checkedSwatch()).toBe(colorLabel('#0a63f0'));
    closeMenu();
    const wb = new Workbook({ sheets: [{ name: 'Data' }] });
    wb.setSheetColor(wb.sheets[0].id, '#C22A2A');
    const tabs = createSheetTabs({ wb });
    document.body.append(tabs.el);
    tabs.colorMenu(wb.sheets[0], tabs.el.querySelector('.tab-menu-btn'));
    expect(checkedSwatch()).toBe(colorLabel('#c22a2a'));
    tabs.destroy();
  });
});
