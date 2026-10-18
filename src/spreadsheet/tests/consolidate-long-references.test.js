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


// Data ▸ Consolidate read each reference no further than 5,001 rows and 501 columns, saying nothing: a list of
// 8,000 rows was totalled from its first 5,000, whether given as A1:B8001 or as whole columns. Each reference is
// now read as far as its sheet has data.
async function consolidateFrom(wb, one, refs, options) {
  view = editorView({ doc: options.doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  view.goTo(options.at); await vi.advanceTimersByTimeAsync(1);
  [...view.el.querySelectorAll('.ribbon [role="tab"]')].find(t => t.textContent === 'Data').click(); await vi.advanceTimersByTimeAsync(1);
  [...view.el.querySelectorAll('.ribbon-panels button')].find(b => b.getAttribute('aria-label') === 'Consolidate').click(); await vi.advanceTimersByTimeAsync(1);
  const dialog = document.querySelector('.consolidate-dialog');
  const reference = dialog.querySelector('input[aria-label="Reference"]');
  const addBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Add');
  for (const ref of refs) { reference.value = ref; addBtn.click(); }
  const [top, left] = dialog.querySelectorAll('input[type="checkbox"]');
  top.checked = !!options.topRow; left.checked = !!options.leftColumn;
  dialog.requestSubmit(); await vi.advanceTimersByTimeAsync(1);
}

it('totals every row of a long list, given as a range or as whole columns', async () => {
  const doc = new Doc({ name: 'Long' }); const wb = doc.wb; const one = wb.activeSheetId;
  const cells = [{ r: 0, c: 0, cell: { v: 'Item' } }, { r: 0, c: 1, cell: { v: 'Qty' } }];
  for (let r = 1; r <= 8000; r++) cells.push({ r, c: 0, cell: { v: r % 2 ? 'odd' : 'even' } }, { r, c: 1, cell: { v: 1 } });
  wb.setCells(one, cells);
  await consolidateFrom(wb, one, ['Sheet1!A1:B8001'], { doc, at: 'E1', topRow: true, leftColumn: true });
  expect([0, 1, 2].map(r => [wb.getValue(one, r, 4), wb.getValue(one, r, 5)])).toEqual([[null, 'Qty'], ['odd', 4000], ['even', 4000]]);
  wb.undo();
  view.destroy(); view = null; document.body.replaceChildren();
  // Whole columns, with the labels in them: every row there is.
  await consolidateFrom(wb, one, ['Sheet1!A:B'], { doc, at: 'H1', topRow: true, leftColumn: true });
  expect([1, 2].map(r => [wb.getValue(one, r, 7), wb.getValue(one, r, 8)])).toEqual([['odd', 4000], ['even', 4000]]);
});
