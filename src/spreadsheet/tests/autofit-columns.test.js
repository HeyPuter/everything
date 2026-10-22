// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';
import { heightForLines } from '../src/core/textfit.js';

/** The height a row fitted to one line of 13px text takes (never less than the default row). */
const ONE_LINE = heightForLines(1, 13, DEFAULT_ROW_HEIGHT);

// Node ships a placeholder localStorage that jsdom does not replace; use a real in-memory one.
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
const canvas = {
  font: '',
  measureText(text) {
    const size = Number(/([\d.]+)px/.exec(this.font)?.[1] || 13);
    const family = this.font.includes('Courier') ? 1.2 : 1;
    const weight = this.font.includes('600') ? 1.1 : 1;
    const slant = this.font.includes('italic') ? 1.05 : 1;
    return { width: text.length * size * family * weight * slant };
  },
};
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvas);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  view?.destroy();
  view = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each(['menu', 'header'])('fits columns containing only spilled results via %s and keeps empty columns unchanged', async (path) => {
  const doc = new Doc({ name: 'Spilled widths', path: 'Spreadsheets/Spilled widths.xlsx' });
  const wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '={"M","MMMMMMMMMM"}');
  expect(wb.getValue(id, 0, 1)).toBe('MMMMMMMMMM');
  expect(wb.getCell(id, 0, 1)).toBeUndefined();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('B1:C1');
  await vi.advanceTimersByTimeAsync(1);
  wb.clearHistory();
  if (path === 'menu') {
    view.el.querySelector('[data-menu="format"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === label);
    item('Rows and columns').click();
    item('Fit columns to content').click();
  } else view.el.querySelector('.col-resizer[data-c="1"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  expect(wb.colWidth(id, 1)).toBe(144);
  expect(wb.colWidth(id, 2)).toBe(100);
  expect(wb.colWidth(id, 0)).toBe(100);
  wb.undo();
  expect(wb.colWidth(id, 1)).toBe(100);
  expect(wb.canUndo()).toBe(false);
  wb.redo();
  expect(wb.colWidth(id, 1)).toBe(144);
});

it.each(['manual', 'filter'])('includes longer vertical spills while excluding %s-hidden rows', async (hidden) => {
  const doc = new Doc({ name: 'Spilled rows', path: 'Spreadsheets/Spilled rows.xlsx' });
  const wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '={"M";"MMMMM";"MMMMMMMMMM"}');
  if (hidden === 'manual') wb.setHidden(id, 'row', [2], true);
  else {
    wb.setFilterRange(id, { r1: 0, c1: 0, r2: 2, c2: 0 });
    wb.setFilterCriteria(id, 0, { values: ['MMMMM'] });
  }
  expect(wb.isRowHidden(id, 2)).toBe(true);
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const fit = () => {
    view.el.querySelector('[data-menu="format"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === label);
    item('Rows and columns').click();
    item('Fit columns to content').click();
  };
  fit();
  expect(wb.colWidth(id, 0)).toBe(79);
  if (hidden === 'manual') wb.setHidden(id, 'row', [2], false);
  else wb.clearFilter(id);
  fit();
  expect(wb.colWidth(id, 0)).toBe(144);
});

it('measures spilled number formats with the destination font, conditional bold and indentation', async () => {
  const doc = new Doc({ name: 'Spilled formats', path: 'Spreadsheets/Spilled formats.xlsx' });
  const wb = doc.wb, id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { f: 'SEQUENCE(1,2)', s: { fmt: 'currency', cur: 'EUR', dec: 2, size: 40 } } }]);
  wb.sheet(id).colStyles.set(1, { size: 20, fmt: 'percent', dec: 0 });
  wb.applyStyle(id, { r1: 0, c1: 1, r2: 0, c2: 1 }, { indent: 2, align: 'right' });
  wb.addRule(id, { range: { r1: 0, c1: 1, r2: 0, c2: 1 }, type: 'notEmpty', style: { bold: true } });
  expect(wb.getDisplay(id, 0, 1)).toBe('€2.00');
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('B1');
  await vi.advanceTimersByTimeAsync(1);
  view.el.querySelector('[data-menu="format"]').click();
  const item = (label) => [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === label);
  item('Rows and columns').click();
  item('Fit columns to content').click();
  expect(wb.colWidth(id, 1)).toBe(148); // 5 characters × 20px × 1.1 bold + 14px padding + 24px indent.
});

it.each(['menu', 'header'].flatMap((path) => [100, 200].flatMap((zoom) => [false, true].map((styled) => [path, zoom, styled]))))('fits the displayed font via %s with zoom=%s and styled=%s', async (path, zoom, styled) => {
  const doc = new Doc({ name: 'Widths', path: 'Spreadsheets/Widths.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'MMMMM');
  if (styled) wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { size: 28, font: 'courier', bold: true, italic: true });
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const item = (label) => [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === label);
  if (zoom !== 100) {
    view.el.querySelector('.zoom-label').click();
    item(`${zoom}%`).click();
    await vi.advanceTimersByTimeAsync(1);
  }
  const before = wb.colWidth(id, 0);
  if (path === 'menu') {
    view.el.querySelector('[data-menu="format"]').click();
    item('Rows and columns').click();
    item('Fit columns to content').click();
  } else view.el.querySelector('.col-resizer[data-c="0"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  expect(wb.colWidth(id, 0)).toBe(styled ? 209 : 79);
  wb.undo();
  expect(wb.colWidth(id, 0)).toBe(before);
  wb.redo();
  expect(wb.colWidth(id, 0)).toBe(styled ? 209 : 79);
});

it('includes long labels after the first 2,001 populated cells when fitting from the header', async () => {
  const doc = new Doc({ name: 'Long column', path: 'Spreadsheets/Long column.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setCells(id, Array.from({ length: 2200 }, (_, r) => ({ r, c: 0, cell: { v: r === 2199 ? 'MMMMMMMMMM' : 'M' } })));
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const before = wb.colWidth(id, 0);
  view.el.querySelector('.col-resizer[data-c="0"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  expect(wb.colWidth(id, 0)).toBe(144);
  wb.undo();
  expect(wb.colWidth(id, 0)).toBe(before);
  wb.redo();
  expect(wb.colWidth(id, 0)).toBe(144);
});

it.each(['menu', 'header'])('fits the longest explicit line via %s', async (path) => {
  const doc = new Doc({ name: 'Multiline', path: 'Spreadsheets/Multiline.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'MMMMM\nMM\n');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { wrap: true });
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const before = wb.colWidth(id, 0);
  if (path === 'menu') {
    view.el.querySelector('[data-menu="format"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === label);
    item('Rows and columns').click();
    item('Fit columns to content').click();
  } else view.el.querySelector('.col-resizer[data-c="0"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  expect(wb.colWidth(id, 0)).toBe(79);
  wb.undo();
  expect(wb.colWidth(id, 0)).toBe(before);
  wb.redo();
  expect(wb.colWidth(id, 0)).toBe(79);
});

it('fits every selected column in one undo step without rescanning the sheet for each column', async () => {
  const doc = new Doc({ name: 'Wide sheet', path: 'Spreadsheets/Wide sheet.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setCells(id, Array.from({ length: 71 }, (_, c) => ({ r: 0, c, cell: { v: 'MMMMM' } })));
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const name = view.el.querySelector('[aria-label="Cell reference"]');
  name.value = 'A1:BR1';
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  const widths = () => Array.from({ length: 71 }, (_, c) => wb.colWidth(id, c));
  const before = widths();
  wb.clearHistory();
  const cells = wb.sheet(id).cells;
  const iterate = cells[Symbol.iterator].bind(cells);
  let visited = 0;
  vi.spyOn(cells, Symbol.iterator).mockImplementation(function* () {
    for (const entry of iterate()) { visited++; yield entry; }
  });
  view.el.querySelector('[data-menu="format"]').click();
  const item = (label) => [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === label);
  item('Rows and columns').click();
  visited = 0;
  item('Fit columns to content').click();
  expect.soft(widths()).toEqual([...Array(70).fill(79), before[70]]);
  expect.soft(visited).toBeLessThanOrEqual(cells.size * 2);
  wb.undo();
  expect(widths()).toEqual(before);
  wb.redo();
  expect(widths()).toEqual([...Array(70).fill(79), before[70]]);
});

it('keeps automatic column fitting on open clean and respects its narrower width limit', async () => {
  const doc = new Doc({ name: 'Imported data', path: 'Spreadsheets/Imported data.csv' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'M'.repeat(100));
  wb.setInput(id, 0, 1, 'MMMMM');
  wb.fitColumnsOnOpen = [id];
  wb.markClean();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.colWidth(id, 0)).toBe(320);
  expect(wb.colWidth(id, 1)).toBe(79);
  expect(wb.colWidth(id, 2)).toBe(100);
  expect(wb.dirty).toBe(false);
  expect(wb.canUndo()).toBe(false);
  expect(wb.fitColumnsOnOpen).toBeNull();
});

it.each([false, true])('uses the displayed italic font for overflow and row height (italic=%s)', async (italic) => {
  const doc = new Doc({ name: 'Italic metrics', path: 'Spreadsheets/Italic metrics.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '12345');
  wb.setInput(id, 1, 0, 'MMMMM');
  wb.setInput(id, 2, 0, 'MMMMM');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 2, c2: 0 }, { italic });
  wb.applyStyle(id, { r1: 2, c1: 0, r2: 2, c2: 0 }, { wrap: true });
  wb.setColWidth(id, 0, 72);
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  expect.soft(view.el.querySelector('#gc-0-0').textContent).toBe(italic ? '###' : '12345');
  expect.soft(view.el.querySelector('#gc-1-0').classList.contains('spill')).toBe(italic);
  view.el.querySelector('.row-resizer[data-r="2"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  expect(wb.rowHeight(id, 2)).toBe(italic ? 37 : ONE_LINE);
});

it.each(['menu', 'header'].flatMap((path) => [
  [undefined, 'MMMMM', 115], ['right', '12345', 115], ['center', 'MMMMM', 79], [undefined, 'TRUE', 66],
].map(([align, input, width]) => [path, align, input, width])))('includes visible indentation via %s for align=%s and value=%s', async (path, align, input, width) => {
  const doc = new Doc({ name: 'Indented', path: 'Spreadsheets/Indented.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, input);
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { indent: 3, align });
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  if (path === 'menu') {
    view.el.querySelector('[data-menu="format"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === label);
    item('Rows and columns').click();
    item('Fit columns to content').click();
  } else view.el.querySelector('.col-resizer[data-c="0"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  expect(wb.colWidth(id, 0)).toBe(width);
  wb.undo();
  expect(wb.colWidth(id, 0)).toBe(100);
});

it.each(['left', 'right', 'center'])('fits wrapped rows within the space left by %s indentation', async (align) => {
  const doc = new Doc({ name: 'Indented rows', path: 'Spreadsheets/Indented rows.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'MMMMM');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { indent: 3, align, wrap: true });
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.el.querySelector('.row-resizer[data-r="0"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  expect(wb.rowHeight(id, 0)).toBe(align === 'center' ? ONE_LINE : 37);
});

it.each([105, 106])('retains both margins at the indented overflow boundary (%spx)', async width => {
  const doc = new Doc({ name: 'Indent edge', path: 'Spreadsheets/Indent edge.xlsx' });
  const wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '12345');
  wb.setInput(id, 1, 0, 'MMMMM');
  wb.applyStyle(id, { r1: 0, r2: 1, c1: 0, c2: 0 }, { indent: 3 });
  wb.applyStyle(id, { r1: 0, r2: 0, c1: 0, c2: 0 }, { fmt: 'number', dec: 0, group: false });
  wb.setColWidth(id, 0, width);
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('#gc-0-0').textContent).toBe(width < 106 ? '###' : '12345');
  expect(view.el.querySelector('#gc-1-0').classList.contains('spill')).toBe(width < 106);
  expect(wb.colWidth(id, 0)).toBe(width);
});

it.each([100, 200].flatMap((zoom) => [0, 3].map((indent) => [zoom, indent])))('uses the remaining cell space for overflow at zoom=%s and indent=%s', async (zoom, indent) => {
  const doc = new Doc({ name: 'Indented overflow', path: 'Spreadsheets/Indented overflow.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  for (let r = 0; r < 4; r++) wb.setInput(id, r, 0, r % 2 ? 'MMMMM' : '12345');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 3, c2: 0 }, { indent });
  wb.applyStyle(id, { r1: 2, c1: 0, r2: 3, c2: 0 }, { align: 'center' });
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  if (zoom !== 100) {
    view.el.querySelector('.zoom-label').click();
    [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === `${zoom}%`).click();
    await vi.advanceTimersByTimeAsync(1);
  }
  expect.soft(view.el.querySelector('#gc-0-0').textContent).toBe(indent ? '###' : '12345');
  expect.soft(view.el.querySelector('#gc-1-0').classList.contains('spill')).toBe(!!indent);
  expect(view.el.querySelector('#gc-2-0').textContent).toBe('12345');
  expect(view.el.querySelector('#gc-3-0').classList.contains('spill')).toBe(false);
});

it.each(['menu', 'header'].flatMap((path) => [false, true].map((conditional) => [path, conditional])))('measures conditional bold text for overflow and %s fitting (conditional=%s)', async (path, conditional) => {
  const doc = new Doc({ name: 'Conditional metrics', path: 'Spreadsheets/Conditional metrics.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '12345');
  wb.setInput(id, 1, 0, 'MMMMM');
  wb.setInput(id, 2, 0, 'MMMMM');
  wb.applyStyle(id, { r1: 2, c1: 0, r2: 2, c2: 0 }, { wrap: true });
  if (conditional) wb.addRule(id, { range: { r1: 0, c1: 0, r2: 2, c2: 0 }, type: 'notEmpty', style: { bold: true } });
  wb.setColWidth(id, 0, 75);
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('#gc-0-0').classList.contains('b')).toBe(conditional);
  expect.soft(view.el.querySelector('#gc-0-0').textContent).toBe(conditional ? '###' : '12345');
  expect.soft(view.el.querySelector('#gc-1-0').classList.contains('spill')).toBe(conditional);
  view.el.querySelector('.row-resizer[data-r="2"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  expect.soft(wb.rowHeight(id, 2)).toBe(conditional ? 37 : ONE_LINE);
  if (path === 'menu') {
    view.el.querySelector('[data-menu="format"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === label);
    item('Rows and columns').click();
    item('Fit columns to content').click();
  } else view.el.querySelector('.col-resizer[data-c="0"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  expect(wb.colWidth(id, 0)).toBe(conditional ? 86 : 79);
});

it.each(['menu', 'header'].flatMap(path => [['Arial', 6, 8], ['Courier New', 12, 28]].map(font => [path, ...font])))('fits using Normal-font indentation via %s (%s %spt)', async (path, name, sz, unit) => {
  const doc = new Doc({ name: 'Normal indent', path: 'Spreadsheets/Normal indent.xlsx' });
  const wb = doc.wb, id = wb.activeSheetId;
  wb.normalFont = { name, sz };
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'MMMMM', s: { font: 'arial', size: 13, indent: 2 } } }]);
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  if (path === 'menu') {
    view.el.querySelector('[data-menu="format"]').click();
    const item = label => [...document.querySelectorAll('.menu-item')].find(node => node.querySelector('.menu-label')?.textContent === label);
    item('Rows and columns').click(); item('Fit columns to content').click();
  } else view.el.querySelector('.col-resizer[data-c="0"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  expect(wb.colWidth(id, 0)).toBe(65 + 14 + 2 * unit);
  wb.undo(); expect(wb.colWidth(id, 0)).toBe(100);
});
