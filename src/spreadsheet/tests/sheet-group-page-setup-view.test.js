// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Page Layout's page setup choices (orientation, margins, size, scaling, print gridlines and headings) and View ▸
// Gridlines and Headings changed the active sheet alone while sheets were grouped, though Excel changes every sheet
// of the group: printing the group mixed portrait and landscape pages. Each grouped sheet now takes the choice, over
// its own page setup, in one undo step.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function grouped() {
  const doc = new Doc({ name: 'Group', path: 'Spreadsheets/Group.xlsx' });
  const wb = doc.wb;
  const a = wb.activeSheetId;
  const b = wb.addSheet('Sheet2').id;
  const c = wb.addSheet('Sheet3').id;
  wb.setActiveSheet(a);
  wb.setPrintSettings(b, { areas: [{ r1: 0, c1: 0, r2: 4, c2: 2 }], margins: { top: 2 } });
  wb.groupSheets([b]);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, a, b, c };
}

it('sets the orientation and margins of every grouped sheet, each keeping the rest of its own page setup', async () => {
  const { wb, a, b, c } = await grouped();
  await view.run('pageSetup', { orientation: 'landscape', margins: { left: 1 } });
  expect(wb.sheet(a).printSettings.orientation).toBe('landscape');
  expect(wb.sheet(b).printSettings.orientation).toBe('landscape');
  expect(wb.sheet(b).printSettings.margins).toMatchObject({ left: 1, top: 2 });
  expect(wb.sheet(b).printSettings.areas).toEqual([{ r1: 0, c1: 0, r2: 4, c2: 2 }]);
  expect(wb.sheet(c).printSettings).toBeFalsy();
  expect(wb.undoLabels()).toHaveLength(1);
  wb.undo();
  expect(wb.sheet(b).printSettings.orientation).toBe('portrait');
});

it.each([['gridlines', 'gridlines'], ['toggleHeaders', 'headers']])('%s turns every grouped sheet’s setting off and on together', async (cmd, field) => {
  const { wb, a, b, c } = await grouped();
  await view.run(cmd);
  expect(wb.sheet(a)[field]).toBe(false);
  expect(wb.sheet(b)[field]).toBe(false);
  expect(wb.sheet(c)[field]).not.toBe(false);
  expect(wb.undoLabels()).toHaveLength(1);
  wb.undo();
  expect(wb.sheet(b)[field]).not.toBe(false);
});
