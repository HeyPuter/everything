// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import { pivotDateSerial, insertTimeline, setTimelineSelection } from '../src/core/timeline.js';
import { pivotBook } from './helpers/native-pivot-report-fixture.js';

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
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(1); };

// A timeline deleted on its own takes its filter off its PivotTable; deleted together with another object (both
// selected, or grouped, then Delete) it went without a word and left the report filtered to its dates, with no
// timeline left to clear them.
const serial = iso => pivotDateSerial(`${iso}T00:00:00`);

it('takes a timeline\'s filter off its PivotTable when it is deleted with other objects', async () => {
  const { wb, report, pivot } = pivotBook({ dateField: true });
  wb.setActiveSheet(report.id);
  const id = insertTimeline(wb, report.id, pivot, 2);
  const note = wb.addChart(report.id, { type: 'text', text: 'Note', anchor: { r: 12, c: 6 }, w: 100, h: 40 });
  setTimelineSelection(wb, report.id, id, serial('2025-01-01'), serial('2025-01-31'));
  expect(wb.getValue(report.id, 3, 1)).toBe(2);
  view = editorView({ doc: new Doc({ wb, name: 'Report' }), goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  view.run('deleteObjects', [id, note]); await flush();
  expect(wb.sheet(report.id).charts).toHaveLength(0);
  expect(wb.getValue(report.id, 3, 1)).toBe(6);
  // One step brings both back, with the filter.
  wb.undo();
  expect(wb.sheet(report.id).charts.map(o => o.type).sort()).toEqual(['text', 'timeline']);
  expect(wb.getValue(report.id, 3, 1)).toBe(2);
});
