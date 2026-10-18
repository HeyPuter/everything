// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// With a chart selected, going to a cell by the Name Box (or Go To, or a link) moved the cell
// selection but left the chart selected, so the next Delete removed the chart instead of clearing
// the cell gone to. Going to cells now selects them in place of the object.
let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('deselects the chart when the Name Box goes to a cell, so Delete clears that cell', async () => {
  const doc = new Doc({ name: 'Goto', path: 'Spreadsheets/Goto.xlsx' });
  const { wb } = doc; const id = wb.activeSheetId;
  [['Item', 'Q1'], ['Pens', '3'], ['Ink', '4']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(5);
  view.goTo('A1:B3'); await vi.advanceTimersByTimeAsync(20);
  view.run('chart', { action: 'insert', subtype: 'columnClustered' }); await vi.advanceTimersByTimeAsync(20);
  expect(wb.sheet(id).charts).toHaveLength(1);
  const box = view.el.querySelector('input.name-box');
  box.focus(); box.value = 'A2';
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(20);
  const vp = view.el.querySelector('.grid-viewport'); vp.focus();
  vp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(20);
  expect(wb.sheet(id).charts).toHaveLength(1);
  expect(wb.getValue(id, 1, 0)).toBeNull();
});
