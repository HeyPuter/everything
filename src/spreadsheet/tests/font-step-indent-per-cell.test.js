// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { heightForLines } from '../src/core/textfit.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';

// Larger font and Increase indent read the active cell's size and indent and wrote the one result over the
// whole selection, so Larger font shrank a 24px cell to 14 and Increase indent pulled a cell indented five
// levels back to one. Each cell now steps from its own value.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const menuItem = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);

async function open(styles, prepare = () => {}) {
  const doc = new Doc({ name: 'Steps', path: 'Spreadsheets/Steps.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  styles.forEach((s, r) => {
    wb.setInput(id, r, 0, 'x');
    if (s) wb.applyStyle(id, { r1: r, c1: 0, r2: r, c2: 0 }, s);
  });
  prepare(wb, id);
  wb.clearHistory();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo(`Sheet1!A1:A${styles.length}`);
  await vi.advanceTimersByTimeAsync(1);
  const menu = async (...path) => {
    view.el.querySelector(`[data-menu="${path[0]}"]`).click();
    for (const label of path.slice(1)) { menuItem(label).click(); await vi.advanceTimersByTimeAsync(1); }
  };
  const button = (label) => { view.el.querySelector(`[aria-label="${label}"]`).click(); return vi.advanceTimersByTimeAsync(1); };
  const key = (name) => styles.map((_, r) => wb.getCell(id, r, 0)?.s?.[name] ?? null);
  return { wb, id, menu, button, key };
}

// Sizes are stored in pixels and step along the standard list of point sizes (a point is 4/3 px).
const pt = (points) => points * 4 / 3;

it('steps each selected cell\'s font size from its own, so Larger font never shrinks a cell', { timeout: 20000 }, async () => {
  const { wb, menu, key } = await open([null, { size: pt(18) }, { size: pt(72) }]);
  await menu('format', 'Text', 'Larger font');
  expect(key('size')).toEqual([pt(10), pt(20), pt(72)]); // 72 points is the largest the list offers, so it stays
  expect(wb.undoLabels()).toEqual(['Font size']);
  await menu('format', 'Text', 'Smaller font');
  expect(key('size')).toEqual([pt(9), pt(18), pt(48)]);
  wb.undo();
  wb.undo();
  expect(key('size')).toEqual([null, pt(18), pt(72)]);
});

it('grows each row to at least the size its own cell gained', { timeout: 20000 }, async () => {
  const { wb, id, menu } = await open([null, { size: pt(18) }]);
  const before = [wb.rowHeight(id, 0), wb.rowHeight(id, 1)];
  await menu('format', 'Text', 'Larger font');
  // Each row is tall enough for its own new size: an automatic row, fitted to its text as the grid measures it.
  expect(wb.rowHeight(id, 0)).toBeGreaterThanOrEqual(heightForLines(1, pt(10)));
  expect(wb.rowHeight(id, 1)).toBeGreaterThanOrEqual(heightForLines(1, pt(20)));
  expect(wb.rowHeight(id, 1)).toBeGreaterThan(wb.rowHeight(id, 0));
  expect(wb.rowHeight(id, 0)).toBeGreaterThan(before[0]);
});

it('steps the font sizes inherited from columns and rows, preserving cell overrides and undo', async () => {
  const { wb, id, menu } = await open([null, null, { size: 14, italic: true }], (wb, id) => {
    // Imported line styles do not have to be repeated on the cells themselves.
    wb.sheet(id).colStyles.set(0, { size: 24, bold: true });
    wb.sheet(id).rowStyles.set(1, { size: 36 });
  });
  const sizes = () => [0, 1, 2].map((r) => wb.styleAt(id, r, 0)?.size);
  expect(sizes()).toEqual([24, 36, 14]);
  await menu('format', 'Text', 'Larger font');
  expect(sizes()).toEqual([pt(20), pt(28), pt(11)]);
  expect(wb.rowHeight(id, 1)).toBeGreaterThanOrEqual(heightForLines(1, pt(28)));
  expect(wb.styleAt(id, 2, 0)).toMatchObject({ italic: true, bold: true });
  expect(wb.styleAt(id, 3, 0)?.size).toBe(24);
  expect([0, 1, 2].map((r) => wb.getValue(id, r, 0))).toEqual(['x', 'x', 'x']);
  wb.undo();
  expect(sizes()).toEqual([24, 36, 14]);
  wb.redo();
  expect(sizes()).toEqual([pt(20), pt(28), pt(11)]);
});

it.each(['Larger font', 'Smaller font'])('steps a cell\'s own size over a different inherited size with %s', async (command) => {
  const { wb, id, menu } = await open([{ size: command === 'Larger font' ? pt(9) : pt(11) }], (wb, id) => {
    wb.sheet(id).colStyles.set(0, { size: 24 });
  });
  await menu('format', 'Text', command);
  expect(wb.styleAt(id, 0, 0)?.size).toBe(pt(10));
  expect(wb.styleAt(id, 1, 0)?.size).toBe(24);
});

it('steps each selected cell\'s indent from its own, from the toolbar and the Format menu', { timeout: 20000 }, async () => {
  const { wb, button, menu, key } = await open([null, { indent: 5 }, { indent: 10 }]);
  await button('Increase indent');
  expect(key('indent')).toEqual([1, 6, 10]); // ten is the deepest indent, so it stays
  expect(wb.undoLabels()).toEqual(['Indent']);
  await menu('format', 'Alignment', 'Decrease indent');
  expect(key('indent')).toEqual([null, 5, 9]);
  wb.undo();
  wb.undo();
  expect(key('indent')).toEqual([null, 5, 10]);
});

it('leaves a cell alone when its own value cannot step, keeping its other formatting', { timeout: 20000 }, async () => {
  const { wb, id, button, key } = await open([{ bold: true, indent: 0 }, { indent: 3 }]);
  await button('Increase indent');
  expect(key('indent')).toEqual([1, 4]);
  expect(wb.getCell(id, 0, 0).s.bold).toBe(true);
});

it('steps indentation from the row and column defaults, preserving cell overrides', async () => {
  const { wb, id, button, menu } = await open([null, null, { indent: 1, italic: true }], (wb, id) => {
    wb.sheet(id).colStyles.set(0, { indent: 5, bold: true });
    wb.sheet(id).rowStyles.set(1, { indent: 8 });
  });
  const indents = () => [0, 1, 2].map((r) => wb.styleAt(id, r, 0)?.indent);
  expect(indents()).toEqual([5, 8, 1]);
  await button('Increase indent');
  expect(indents()).toEqual([6, 9, 2]);
  expect(wb.styleAt(id, 2, 0)).toMatchObject({ italic: true, bold: true });
  await menu('format', 'Alignment', 'Decrease indent');
  expect(indents()).toEqual([5, 8, 1]);
  expect(wb.styleAt(id, 3, 0)?.indent).toBe(5);
  wb.undo();
  wb.undo();
  expect(indents()).toEqual([5, 8, 1]);
  expect(wb.canUndo()).toBe(false);
  wb.redo();
  expect(indents()).toEqual([6, 9, 2]);
});

it.each([null, { indent: 1 }])('can remove the last indent over a row default (%j)', async (style) => {
  const { wb, id, button } = await open([style], (wb, id) => {
    wb.sheet(id).rowStyles.set(0, { indent: style ? 5 : 1 });
  });
  await button('Decrease indent');
  expect(wb.styleAt(id, 0, 0)?.indent || 0).toBe(0);
  expect(view.el.querySelector('[aria-label="Decrease indent"]').disabled).toBe(true);
  expect(wb.styleAt(id, 0, 1)?.indent).toBe(style ? 5 : 1);
  wb.undo();
  expect(wb.styleAt(id, 0, 0)?.indent).toBe(1);
});

it('applies a fractional custom font size across the selection with a single undo step', async () => {
  const { wb, id, menu, key } = await open([{ size: pt(10), bold: true }, { size: 24 }, null]);
  await menu('format', 'Text', 'Custom font size…');
  const input = document.querySelector('[aria-label="Font size"]');
  expect(input.value).toBe('10'); // in points
  expect(input.getAttribute('inputmode')).toBe('decimal');
  input.value = '18.5';
  input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(5);
  expect(key('size')).toEqual([pt(18.5), pt(18.5), pt(18.5)]);
  expect(wb.styleAt(id, 0, 0).bold).toBe(true);
  expect(wb.rowHeight(id, 0)).toBeGreaterThanOrEqual(heightForLines(1, pt(18.5)));
  expect(wb.undoLabels()).toEqual(['Font size']);
  wb.undo();
  expect(key('size')).toEqual([pt(10), 24, null]);
});

it('keeps invalid custom sizes in the dialog and makes cancellation a no-op', async () => {
  const { wb, menu, key } = await open([{ size: 12.5 }]);
  await menu('format', 'Text', 'Custom font size…');
  const input = document.querySelector('[aria-label="Font size"]');
  expect(input.value).toBe('9.38'); // 12.5px in points
  for (const value of ['', '0', '410', 'Infinity', '12px']) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(5);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input);
    expect(key('size')).toEqual([12.5]);
  }
  document.querySelector('.modal-panel .btn-ghost').click();
  await vi.advanceTimersByTimeAsync(5);
  expect(wb.undoLabels()).toEqual([]);
  expect(key('size')).toEqual([12.5]);
});

it('changes the font size of a pending entry without committing or losing its text', async () => {
  const { wb, id, menu, key } = await open([null]);
  const formula = view.el.querySelector('.formula-input');
  formula.focus(); formula.value = 'Still being typed'; formula.dispatchEvent(new Event('input'));
  await vi.advanceTimersByTimeAsync(5);
  await menu('format', 'Text', 'Custom font size…');
  const input = document.querySelector('[aria-label="Font size"]');
  input.value = '22.5';
  input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(5);
  expect(key('size')).toEqual([pt(22.5)]);
  expect(wb.getValue(id, 0, 0)).toBe('x');
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(true);
  expect(view.el.querySelector('.grid-editor').value).toBe('Still being typed');
  // The keyboard goes back to the formula bar, where the entry was being typed.
  expect(document.activeElement).toBe(formula);
});
