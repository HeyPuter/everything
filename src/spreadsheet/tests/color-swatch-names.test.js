// @vitest-environment jsdom
// The colour palettes named each swatch by its hex code, so a screen reader read "#c22a2a" for the text
// colour red, and the Font Color button became "Apply font color #ff0000". Swatches are now named as a
// person reads them: the palettes' colours by name, any other colour by a plain description and its code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { colorLabel, rememberColor } from '../src/ui/colorpicker.js';
import { createToolbar, TEXT_COLORS, FILL_COLORS } from '../src/ui/toolbar.js';
import { createSheetTabs } from '../src/ui/sheettabs.js';
import { closeMenu } from '../src/ui/menu.js';
import { Workbook } from '../src/core/workbook.js';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
beforeEach(() => { document.body.innerHTML = ''; localStorage.clear(); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { closeMenu(); document.body.replaceChildren(); });

const ctxFor = (wb) => ({ wb, style: () => ({}), run() {}, activeCell: () => ({}), grid: { editing: false }, sheetId: () => wb.activeSheetId, active: () => ({ r: 0, c: 0 }), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), subscribe: () => () => {} });
const swatchLabels = () => [...document.querySelectorAll('.menu .swatches:not(.swatches-theme) .swatch:not(.none)')].map((b) => b.getAttribute('aria-label'));

describe('colour swatch names', () => {
  it('names every palette colour, and describes any other with its code', () => {
    for (const hex of [...TEXT_COLORS, ...FILL_COLORS]) expect(colorLabel(hex)).toMatch(/^[A-Z][a-z]+( [A-Z][a-z]+)?$/);
    expect(colorLabel('#C22A2A')).toBe('Red');
    expect(colorLabel('#e0ecff')).toBe('Light Blue');
    expect(colorLabel('#ffff00')).toBe('Yellow');
    expect(colorLabel('#1e5631')).toBe('Dark green, #1e5631');
    expect(colorLabel('#a1c4fd')).toBe('Light blue, #a1c4fd');
    expect(colorLabel('#808080')).toBe('Gray, #808080');
  });

  it('reads the text colour palette by name (the ribbon\'s Apply buttons: command-icons.test.js)', () => {
    const wb = new Workbook({ sheets: [{ name: 'Data' }] });
    rememberColor('#123456');
    const toolbar = createToolbar(ctxFor(wb));
    document.body.append(toolbar.el);
    toolbar.el.querySelector('[aria-label="Text color"]').click();
    const labels = swatchLabels();
    expect(labels).toContain('Red');
    expect(labels).toContain('Dark blue, #123456'); // a recent custom colour
    expect(labels.some((l) => /^#/.test(l))).toBe(false);
  });

  it('reads the sheet tab colours by name', () => {
    const wb = new Workbook({ sheets: [{ name: 'Data' }] });
    const tabs = createSheetTabs({ wb, grid: null });
    document.body.append(tabs.el);
    tabs.colorMenu(wb.sheet(wb.activeSheetId), document.body);
    const labels = swatchLabels();
    expect(labels.slice(0, 3)).toEqual(['Red', 'Orange', 'Amber']);
    expect(labels.some((l) => /^#/.test(l))).toBe(false);
  });
});
