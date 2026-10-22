// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// View ▸ Page Break Preview (and Page Layout, and back to Normal) changed the active sheet alone while sheets were
// grouped, though Excel switches every sheet of the group, as it does for Page Setup, Gridlines and Headings: the
// other grouped sheets stayed in Normal view. Every grouped worksheet now takes the view.
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
  wb.groupSheets([b]);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, a, b, c };
}

it('switches every grouped sheet to Page Break Preview and back to Normal', async () => {
  const { wb, a, b, c } = await grouped();
  await view.run('viewMode', 'pageBreak');
  expect(wb.sheet(a).viewMode).toBe('pageBreak');
  expect(wb.sheet(b).viewMode).toBe('pageBreak');
  expect(wb.sheet(c).viewMode).toBeUndefined();
  await view.run('viewMode', 'pageLayout');
  expect(wb.sheet(b).viewMode).toBe('pageLayout');
  await view.run('viewMode', 'normal');
  expect(wb.sheet(a).viewMode).toBeUndefined();
  expect(wb.sheet(b).viewMode).toBeUndefined();
});

it('still switches the sheet in view alone when no sheets are grouped', async () => {
  const { wb, a, b } = await grouped();
  wb.ungroupSheets();
  await view.run('viewMode', 'pageBreak');
  expect(wb.sheet(a).viewMode).toBe('pageBreak');
  expect(wb.sheet(b).viewMode).toBeUndefined();
});
