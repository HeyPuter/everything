// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// The format painter carried only the cells' own styles: a merged header painted onto another row arrived
// unmerged, and a cell's conditional formatting (red when over budget) was left behind, though Excel's Format
// Painter brings both, as Paste Special > Formats here already did. Both now come along.
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

async function mount() {
  const doc = new Doc({ name: 'Paint', path: 'Spreadsheets/Paint.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Header');
  wb.mergeCells(id, { r1: 0, c1: 0, r2: 0, c2: 1 });
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 1 }, { bold: true });
  wb.setInput(id, 1, 2, '7');
  wb.addRule(id, { range: { r1: 1, c1: 2, r2: 1, c2: 2 }, type: 'gt', value: 5, style: { bg: '#ffc7ce' } });
  for (let r = 4; r < 6; r++) wb.setInput(id, r, 2, String(r * 2));
  wb.setInput(id, 4, 0, 'Second');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id };
}

async function paint(from, to) {
  view.goTo(`Sheet1!${from}`);
  await vi.advanceTimersByTimeAsync(1);
  await view.run('paintFormat');
  view.goTo(`Sheet1!${to}`);
  await vi.advanceTimersByTimeAsync(1);
  await view.run('paintFormat');
  await vi.advanceTimersByTimeAsync(1);
}

it('paints a merged block as a merged block', async () => {
  const { wb, id } = await mount();
  await paint('A1:B1', 'A5');
  expect(wb.sheet(id).merges).toContainEqual({ r1: 4, c1: 0, r2: 4, c2: 1 });
  expect(wb.getCell(id, 4, 0).s.bold).toBe(true);
  expect(wb.getValue(id, 4, 0)).toBe('Second');
});

it('paints a cell\'s conditional formatting onto the target', async () => {
  const { wb, id } = await mount();
  await paint('C2', 'C5:C6');
  expect(wb.conditionalStyle(id, 4, 2, wb.getValue(id, 4, 2))).toMatchObject({ bg: '#ffc7ce' });
  expect(wb.conditionalStyle(id, 5, 2, wb.getValue(id, 5, 2))).toMatchObject({ bg: '#ffc7ce' });
  expect(wb.getValue(id, 4, 2)).toBe(8);
  // The source keeps its own rule.
  expect(wb.conditionalStyle(id, 1, 2, 7)).toMatchObject({ bg: '#ffc7ce' });
});
