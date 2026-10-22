// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Row Height… over the whole sheet (Ctrl+A, then Home ▸ Format ▸ Row Height) gave each of the 1,048,576 rows a height
// and an undo step of its own: seconds of work, a million entries kept in memory and written into the file. As in
// Excel, it now sets the sheet's default height, in one step; Column Width… over every column sets the default width.
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Sizes' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'a');
  wb.setRowHeight(id, 3, 60);
  wb.setColWidth(id, 2, 300);
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id, view };
}

async function resize(view, cmd, value) {
  const done = view.run(cmd);
  await vi.advanceTimersByTimeAsync(1);
  const input = document.querySelector('.modal-root:not(.closing) input');
  input.value = value;
  input.form.requestSubmit();
  await done;
}

it('sets the default row height when every row is selected, as one undo step', async () => {
  const { wb, id, view } = await mount();
  const defaultHeight = wb.sheet(id).defaultRowHeight;
  view.goTo('Sheet1!1:1048576');
  await resize(view, 'resizeRows', '40');
  expect(wb.sheet(id).defaultRowHeight).toBe(40);
  expect(wb.sheet(id).rowHeights.size).toBe(0);
  expect(wb.rowHeight(id, 3)).toBe(40);
  expect(wb.rowHeight(id, 900000)).toBe(40);
  wb.undo();
  expect(wb.sheet(id).defaultRowHeight).toBe(defaultHeight);
  expect(wb.rowHeight(id, 3)).toBe(60);
  expect(wb.rowHeight(id, 500)).toBe(defaultHeight);
  wb.redo();
  expect(wb.rowHeight(id, 3)).toBe(40);
  view.destroy();
});

it('sets the default column width when every column is selected', async () => {
  const { wb, id, view } = await mount();
  view.goTo('Sheet1!A:XFD');
  await resize(view, 'resizeCols', '90');
  expect(wb.sheet(id).defaultColWidth).toBe(90);
  expect(wb.sheet(id).colWidths.size).toBe(0);
  expect(wb.colWidth(id, 2)).toBe(90);
  wb.undo();
  expect(wb.colWidth(id, 2)).toBe(300);
  view.destroy();
});

it('still sizes the rows of a selection of rows one by one', async () => {
  const { wb, id, view } = await mount();
  const defaultHeight = wb.sheet(id).defaultRowHeight;
  view.goTo('Sheet1!2:5');
  await resize(view, 'resizeRows', '40');
  expect(wb.rowHeight(id, 1)).toBe(40);
  expect(wb.rowHeight(id, 4)).toBe(40);
  expect(wb.rowHeight(id, 5)).toBe(defaultHeight);
  expect(wb.sheet(id).defaultRowHeight).toBe(defaultHeight);
  view.destroy();
});

it('sets the default row height when a row edge is dragged with every row selected', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = () => {};
  Element.prototype.setPointerCapture = () => {};
  const { createGrid } = await import('../src/ui/grid.js');
  const { Workbook } = await import('../src/core/workbook.js');
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await new Promise((r) => setTimeout(r, 5));
  grid.selectAll();
  expect(grid.range.r2).toBe(1048575);
  const before = wb.rowHeight(id, 0);
  const clip = grid.el.querySelector('.grid-rowhead-clip');
  const pointer = (target, type, init) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ...init }));
  pointer(clip.querySelector('.row-resizer[data-r="0"]'), 'pointerdown', { clientX: 10, clientY: 20 });
  pointer(clip, 'pointermove', { clientX: 10, clientY: 40 });
  pointer(clip, 'pointerup', { clientX: 10, clientY: 40 });
  expect(wb.sheet(id).rowHeights.size).toBe(0);
  expect(wb.sheet(id).defaultRowHeight).toBeGreaterThan(before);
  expect(wb.rowHeight(id, 700000)).toBe(wb.sheet(id).defaultRowHeight);
  grid.destroy();
});

it('sets the default row height of every grouped sheet', async () => {
  const { Workbook } = await import('../src/core/workbook.js');
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const other = wb.addSheet().id;
  wb.setActiveSheet(id);
  wb.groupSheets([id, other]);
  wb.setDefaultLineSize(id, 'row', 44);
  expect(wb.sheet(id).defaultRowHeight).toBe(44);
  expect(wb.sheet(other).defaultRowHeight).toBe(44);
  wb.undo();
  expect(wb.sheet(other).defaultRowHeight).not.toBe(44);
});
