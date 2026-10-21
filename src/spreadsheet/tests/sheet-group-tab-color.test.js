// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// Tab Color on grouped sheets coloured the active tab alone, though Excel colours every selected tab. A colour picked
// for a grouped sheet now goes to each sheet of the group, in one undo step; a sheet outside the group keeps its own.
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
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('colours every grouped tab, and one undo takes the colour off them all', async () => {
  const doc = new Doc({ name: 'Tabs', path: 'Spreadsheets/Tabs.xlsx' });
  const wb = doc.wb;
  const [a, b, c] = [wb.activeSheetId, wb.addSheet('Feb').id, wb.addSheet('Mar').id];
  wb.setActiveSheet(a);
  wb.groupSheets([b]);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  await view.run('sheetColor');
  await vi.advanceTimersByTimeAsync(1);
  const swatch = document.querySelector('.swatches .swatch:not(.none)');
  swatch.click();
  const hex = wb.sheet(a).color;
  expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
  expect(wb.sheet(b).color).toBe(hex);
  expect(wb.sheet(c).color).toBeFalsy();
  expect(wb.undoLabels()).toHaveLength(1);
  wb.undo();
  expect(wb.sheet(a).color).toBeFalsy();
  expect(wb.sheet(b).color).toBeFalsy();
});
