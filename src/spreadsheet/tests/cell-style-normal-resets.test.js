// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// The Normal cell style reset bold, italics, colours and borders but left a cell's font family, number format,
// alignment, wrapping, indent and rotation as they were, and set its font size to none, so it drew smaller than
// the sheet's text. Normal now gives the cell the sheet's own look, as Clear Formats does, and in a formatted
// column it also sets aside the column's format, as Excel's Normal style does.
it('gives a cell the sheet\'s default look', async () => {
  const doc = new Doc({ name: 'Normal' }); const wb = doc.wb; const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1234.5'); wb.setInput(id, 0, 1, '1234.5'); wb.setInput(id, 0, 3, '0.5');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 1 }, { fmt: 'currency', align: 'center', wrap: true, bold: true, font: 'georgia', italic: true, indent: 2, rot: 45, bg: '#ff0000', size: 20 });
  wb.applyStyle(id, { r1: 0, c1: 3, r2: 1048575, c2: 3 }, { bold: true, fmt: 'percent' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  view.goTo('A1'); view.run('cellStyle', 'normal');
  view.goTo('B1'); view.run('clearFormat');
  view.goTo('D1'); view.run('cellStyle', 'normal');
  const shown = (c) => Object.fromEntries(Object.entries(wb.styleAt(id, 0, c) || {}).filter(([, v]) => v != null));
  expect(shown(0)).toEqual(shown(1));
  expect(shown(0)).toEqual(shown(5));
  expect(wb.getDisplay(id, 0, 0)).toBe('1234.5');
  expect(wb.getDisplay(id, 0, 3)).toBe('0.5');
  expect(wb.styleAt(id, 0, 3)?.bold).toBeFalsy();
  expect(wb.getDisplay(id, 1, 3) === '' && wb.styleAt(id, 1, 3)?.bold).toBe(true);
});
