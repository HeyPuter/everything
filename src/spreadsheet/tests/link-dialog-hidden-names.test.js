// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { buildPivot } from '../src/core/pivot.js';
import { insertPivotSheet } from '../src/ui/pivotdialog.js';

// A pivot table built from the PivotTable dialog keeps its definition as hidden names (_PuterPivot_Source and
// _PuterPivot_Area, references), as Solver keeps its model. Insert Link listed every name that is a reference,
// hidden or not, so each pivot table put its workings among the named ranges a link can go to, where Excel lists
// only the names the Name Manager shows.
let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('lists only the names the Name Manager shows among the places a link can go', async () => {
  const doc = new Doc({ name: 'Sales' });
  const { wb } = doc, id = wb.activeSheetId;
  [['Region', 'Units'], ['East', '5'], ['West', '3']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  insertPivotSheet(wb, id, buildPivot(wb, id, { range: { r1: 0, c1: 0, r2: 2, c2: 1 }, rowField: 0, colField: null, valueField: 1, agg: 'sum', filters: [] }));
  wb.defineName('Units', 'Sheet1!$B$2:$B$3');
  expect(wb.names.filter((n) => n.hidden).length).toBeGreaterThan(0);
  wb.setActiveSheet(id);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.el.querySelector('[aria-label="Insert link"]').click();
  const group = document.querySelector('[aria-label="Link to"] optgroup[label="Named ranges"]');
  expect([...group.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Units']);
});
