// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { parseHtmlClipboard } from '../src/core/clipboard.js';

let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: t => ({ width: t.length * 7 }), font: '' });
  document.body.replaceChildren();
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// In a workbook with its own Normal font (any file from Excel), a copy pasted within the workbook wrote the
// complete font a copy to another workbook pins on (bold, italic, underline and strike off, black ink) into
// every pasted cell, so a pasted #DIV/0! lost its red. A paste here now carries what the cells show here; the
// HTML for another workbook or app still carries the complete font.
const FONT_FLAGS = ['bold', 'italic', 'underline', 'strike', 'color'];
it('pastes within the workbook without pinning a black, regular font', async () => {
  const doc = new Doc({ name: 'Excel book' });
  doc.wb = new Workbook({ normalFont: { name: 'Calibri', sz: 11 }, sheets: [{ name: 'S',
    cells: { '0,0': { f: '1/0' }, '0,1': { v: 'x' } }, colStyles: { 1: { bg: '#ffff00' } } }] });
  const wb = doc.wb, id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  view.goTo('A1:B1'); viewport.focus();
  const copied = {};
  const copy = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(copy, 'clipboardData', { value: { setData: (type, value) => { copied[type] = value; } } });
  document.dispatchEvent(copy);
  view.goTo('A3'); viewport.focus();
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData: type => copied[type] ?? '', files: [] } });
  viewport.dispatchEvent(paste);
  await vi.advanceTimersByTimeAsync(10);
  expect(wb.getCell(id, 2, 0).f).toBe('1/0');
  for (const c of [0, 1]) expect(FONT_FLAGS.filter((k) => k in (wb.getCell(id, 2, c).s || {}))).toEqual([]);
  expect(wb.styleAt(id, 2, 1)).toMatchObject({ bg: '#ffff00' });
  // Another workbook still reads the complete font from the HTML.
  const outward = parseHtmlClipboard(copied['text/html'], copied['text/plain']);
  expect(outward.cells[0][0].s).toMatchObject({ bold: false, color: '#000000' });
});
