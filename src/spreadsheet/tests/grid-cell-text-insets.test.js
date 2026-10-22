// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { buildPrintTable } from '../src/ui/print.js';
import { declared, parseRules, stylesheet } from './helpers/css.js';

const grids = [];
const flush = () => new Promise(resolve => setTimeout(resolve, 5));
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({
    font: '', measureText(text) { return { width: text.length * parseFloat(this.font) / 2 }; },
  });
  Element.prototype.scrollTo = function () {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => {
  for (const grid of grids.splice(0)) grid.destroy();
  document.body.replaceChildren(); document.head.replaceChildren();
});

// Equal measured text has equal available space in every font. Eight glyphs
// at 14px measure 56px; OOXML adds 4px of margins and 1px of gridline, so a
// 61px column fits exactly and a 60px column must hash a fixed-format number.
it.each([undefined, 'arial', 'calibri', 'font:Geneva', 'font:An Uninstalled Font'])('uses font-independent number-fit boundaries (%s)', async font => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '12345.67');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { font, size: 14, fmt: 'custom', code: '0.00' });
  const grid = createGrid({ wb, sheetId: id }); grids.push(grid); document.body.append(grid.el);
  for (const zoom of [0.5, 1, 2]) {
    grid.setZoom(zoom);
    // Text margins scale with the font and column; the screen gridline stays 1px.
    const width = 60 + 1 / zoom;
    wb.setColWidth(id, 0, width);
    await flush();
    expect(grid.el.style.getPropertyValue('--cell-text-inset')).toBe(`${2 * zoom}px`);
    expect(grid.el.querySelector('#gc-0-0').textContent).toBe('12345.67');
    wb.setColWidth(id, 0, width - 2);
    await flush();
    expect(grid.el.querySelector('#gc-0-0').textContent).toBe('###');
  }
});

it('fits wrapped labels across merged columns using the same margins', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'abcdefgh');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { size: 14, wrap: true });
  wb.mergeCells(id, { r1: 0, c1: 0, r2: 0, c2: 1 });
  wb.setColWidth(id, 0, 30); wb.setColWidth(id, 1, 31);
  const grid = createGrid({ wb, sheetId: id }); grids.push(grid); document.body.append(grid.el);
  await flush(); grid.autoFitRows(0, 0);
  expect(wb.rowHeight(id, 0)).toBe(22);
  wb.setColWidth(id, 1, 30);
  await flush(); grid.autoFitRows(0, 0);
  expect(wb.rowHeight(id, 0)).toBe(41);
});

it('shares horizontal insets between display and editing without font overrides', () => {
  const css = stylesheet('grid.css');
  for (const selector of ['.cell', '.grid-editor']) {
    expect(declared(css, selector, false).padding).toBe('0 var(--cell-text-inset, 2px)');
  }
  for (const selector of ['.cell.calibri', '.grid-editor.calibri']) {
    const rule = declared(css, selector, false);
    expect(rule.padding).toBeUndefined();
    expect(rule['padding-left']).toBeUndefined();
    expect(rule['padding-right']).toBeUndefined();
  }
});

it.each(['arial', 'calibri', 'font:Geneva'])('prints ordinary and constrained %s cells with two-pixel horizontal margins', font => {
  const css = document.createElement('style');
  css.textContent = parseRules(stylesheet('editor.css'))
    .filter(rule => rule.media.includes('@media print') || rule.selectors.some(s => s.startsWith('.print-')))
    .map(rule => `${rule.selectors.join(',')} {${rule.body}}`).join('\n');
  document.head.append(css);
  const wb = new Workbook(), id = wb.activeSheetId;
  for (const r of [0, 1]) {
    wb.setInput(id, r, 0, '12345.67');
    wb.applyStyle(id, { r1: r, c1: 0, r2: r, c2: 0 }, { font, size: 14, wrap: r === 1 });
  }
  const table = buildPrintTable(wb, id, { fit: 'actual' }); document.body.append(table);
  for (const td of table.querySelectorAll('td')) {
    const text = td.querySelector('.print-cell') || td;
    expect(getComputedStyle(text).paddingLeft).toBe('2px');
    expect(getComputedStyle(text).paddingRight).toBe('2px');
  }
});
