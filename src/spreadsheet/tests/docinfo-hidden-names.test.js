// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';

// Hidden names (a pivot table's definition kept here, Excel's _xlnm._FilterDatabase, Solver's model) are left out of
// the Name Manager and the Name Box, but Document details counted them among the named ranges: a book with one named
// range and a filter read as three.
const book = () => new Workbook({ sheets: [{ name: 'Sheet1' }], names: [
  { name: 'Total', ref: 'Sheet1!$A$1' },
  { name: '_FilterDatabase', ref: 'Sheet1!$A$1:$B$9', hidden: true, sheet: 'Sheet1' },
  { name: 'Secret_Rate', ref: '0.2', hidden: true },
] });

let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
});
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('counts only the names the Name Manager shows in Document details', async () => {
  view = editorView({ doc: new Doc({ wb: book(), name: 'Book' }), goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  await view.run('docInfo');
  const row = [...document.querySelectorAll('.details-table th')].find((th) => th.textContent === 'Named ranges');
  expect(row.nextElementSibling.textContent).toBe('1');
});
