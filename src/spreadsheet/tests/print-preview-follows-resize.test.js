// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// The preview fits the page to the room its pane gives it, measured when it was drawn. A tablet turned with the Print
// dialog open lays the dialog out again (one column upright, the preview beside the choices on its side), and the page
// kept the size it had: drawn 507 pixels wide for the upright pane, it was cut off on both sides of the 300 beside.
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
let observers;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  observers = [];
  vi.stubGlobal('ResizeObserver', class { constructor(fn) { this.fn = fn; this.targets = new Set(); observers.push(this); } observe(t) { this.targets.add(t); } unobserve(t) { this.targets.delete(t); } disconnect() { this.targets.clear(); } });
  const g = new Proxy({}, { get: () => () => {}, set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

it('draws the page again to fit when its pane changes size, and lets go of the pane when the dialog closes', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (let r = 0; r < 20; r++) wb.setInput(id, r, 0, `Item ${r + 1}`);
  const modal = openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  modal.panel.querySelector('[aria-label="Orientation"] [data-key="landscape"]').click();
  const stage = modal.panel.querySelector('.print-preview-stage');
  const canvas = stage.querySelector('canvas');
  let room = { w: 676, h: 400 };
  Object.defineProperty(stage, 'clientWidth', { configurable: true, get: () => room.w });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, get: () => room.h });
  await vi.advanceTimersByTimeAsync(5);
  const wide = parseFloat(canvas.style.width);
  expect(wide).toBeGreaterThan(500);
  // Turned on its side: the pane beside the choices is 300 wide.
  room = { w: 300, h: 400 };
  const watching = observers.filter((o) => o.targets.has(stage));
  expect(watching).toHaveLength(1);
  watching[0].fn([{ target: stage }]);
  await vi.advanceTimersByTimeAsync(5);
  expect(parseFloat(canvas.style.width)).toBeLessThanOrEqual(300);
  expect(modal.panel.querySelector('.print-preview-count').textContent).toBe('Page 1 of 1');
  modal.close();
  expect(watching[0].targets.size).toBe(0);
});
