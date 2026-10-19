// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

const toasts = vi.hoisted(() => []);
vi.mock('../src/ui/toast.js', () => ({ toast: (message) => { toasts.push(message); } }));

// Go To Special with one cell selected looked only inside the block of typed values. Dropdowns, notes and
// conditional formats laid on empty cells — a form waiting to be filled in — lie outside it, so the command
// said there were none, or that the sheet was empty, as Excel's searches the whole sheet for them.
let view;
beforeEach(() => {
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

function setup(fill) {
  const doc = new Doc({ name: 'Form', path: 'Spreadsheets/Form.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  fill(wb, id);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  vi.runOnlyPendingTimers();
  return { wb, id };
}
const lastToast = () => toasts.at(-1) || '';

describe('Go To Special from one cell', () => {
  it('finds dropdowns, notes and conditional formats on empty cells past the data', () => {
    setup((wb, id) => {
      wb.setInput(id, 0, 0, 'Name');
      wb.setInput(id, 0, 1, 'Team');
      wb.addValidation(id, { type: 'list', source: 'Red,Blue', range: { r1: 1, c1: 3, r2: 9, c2: 3 } });
      wb.setNote(id, 11, 5, 'Sign here');
      wb.addRule(id, { type: 'cellIs', op: '>', value: '5', range: { r1: 0, c1: 7, r2: 4, c2: 7 }, style: { bold: true } });
    });
    view.goTo('Sheet1!A1'); vi.runOnlyPendingTimers();
    view.run('selectSpecial', 'validation');
    expect(lastToast()).toMatch(/Selected 9 cells/);
    view.goTo('Sheet1!A1'); vi.runOnlyPendingTimers();
    view.run('selectSpecial', 'notes');
    expect(lastToast()).toMatch(/Selected 1 cell\b/);
    view.goTo('Sheet1!A1'); vi.runOnlyPendingTimers();
    view.run('selectSpecial', 'conditionalFormats');
    expect(lastToast()).toMatch(/Selected 5 cells/);
  });

  it('finds them on a sheet that holds no values at all', () => {
    setup((wb, id) => {
      wb.addValidation(id, { type: 'list', source: 'Yes,No', range: { r1: 2, c1: 2, r2: 3, c2: 2 } });
    });
    view.goTo('Sheet1!A1'); vi.runOnlyPendingTimers();
    view.run('selectSpecial', 'validation');
    expect(lastToast()).toMatch(/Selected 2 cells/);
  });

  it('says the sheet has none when there are none anywhere', () => {
    setup((wb, id) => { wb.setInput(id, 0, 0, 'x'); });
    view.goTo('Sheet1!A1'); vi.runOnlyPendingTimers();
    view.run('selectSpecial', 'notes');
    expect(lastToast()).toBe('No cells with notes on this sheet');
  });

  it('still keeps to a selected range', () => {
    setup((wb, id) => {
      wb.setInput(id, 0, 0, 'x');
      wb.addValidation(id, { type: 'list', source: 'Red,Blue', range: { r1: 1, c1: 3, r2: 9, c2: 3 } });
    });
    view.goTo('Sheet1!A1:D4'); vi.runOnlyPendingTimers();
    view.run('selectSpecial', 'validation');
    expect(lastToast()).toMatch(/Selected 3 cells/);
  });
});
