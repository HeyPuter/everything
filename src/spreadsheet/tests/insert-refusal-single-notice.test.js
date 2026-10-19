// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

const toasts = vi.hoisted(() => []);
vi.mock('../src/ui/toast.js', () => ({ toast: (message) => { toasts.push(message); } }));

// Inserting rows, columns or cells inside a protected range or through an array formula is refused, and the workbook
// says why ("A1:C5 is protected (Budget)…", "Select the entire array…"). The command then added a toast of its own
// blaming the edge of the sheet — "cells would be pushed off the sheet" — which contradicted the first.
let view;
beforeEach(() => {
  toasts.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (q) => ({ matches: !/max-width|pointer/.test(q), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Element.prototype.setPointerCapture = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup() {
  const doc = new Doc({ name: 'Merge', path: 'Spreadsheets/Merge.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '4');
  wb.setInput(id, 0, 1, '=A1*2');
  wb.setInput(id, 1, 0, '5');
  wb.setInput(id, 1, 1, '=A2*2');
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  vi.runOnlyPendingTimers();
  return { wb, id };
}

describe('a refused insertion', () => {
  it('leaves the explanation to the workbook when a protected range is in the way', () => {
    const { wb, id } = setup();
    wb.protectRange(id, { r1: 0, c1: 0, r2: 4, c2: 2 }, 'Budget');
    view.goTo('Sheet1!B3'); vi.runOnlyPendingTimers();
    view.run('insertRows', 'above');
    view.run('insertCols', 'left');
    const notice = 'A1:C5 is protected (Budget). Unprotect it under Protected ranges in the cell menu';
    expect(toasts).toEqual([notice]); // the same notice twice in a row shows once
    expect(wb.sheet(id).rows).toBe(100);
  });

  it('leaves it to the workbook when an array formula is in the way', () => {
    const { wb, id } = setup();
    wb.setArrayFormula(id, { r1: 10, c1: 0, r2: 12, c2: 0 }, '=1');
    view.goTo('Sheet1!A12'); vi.runOnlyPendingTimers();
    view.run('insertRows', 'above');
    expect(toasts).toEqual(['Select the entire array A11:A13 to change it. You can format individual cells.']);
  });

  it('still names the sheet edge when that is what refuses it', () => {
    const { wb, id } = setup();
    wb.setInput(id, 1048575, 0, 'last');
    view.goTo('Sheet1!A3'); vi.runOnlyPendingTimers();
    view.run('insertRows', 'above');
    expect(toasts).toEqual(['The row cannot be inserted here: cells would be pushed off the sheet']);
  });
});
