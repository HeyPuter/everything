// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// A form on a protected sheet leaves its entry cells unlocked, and Excel's Delete empties them as typing fills them.
// Here Delete (and Clear Contents) asked whether the selection lay on a protected sheet at all, and on one it did
// nothing, so an entry could be typed over but never taken back out. Clearing is now refused only by a locked cell
// it would change.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
let view;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
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
  const doc = new Doc({ name: 'Form', path: 'Spreadsheets/Form.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Name');
  wb.setInput(id, 0, 1, 'Ada');
  wb.setInput(id, 1, 0, 'Phone');
  wb.setInput(id, 1, 1, '555');
  wb.applyStyle(id, { r1: 0, c1: 1, r2: 1, c2: 1 }, { locked: false });
  wb.setSheetProtected(id, true);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  const press = async (ref) => {
    view.goTo(ref);
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);
  };
  return { wb, id, press };
}

it('empties unlocked cells of a protected sheet, and the clear is undone', async () => {
  const { wb, id, press } = await mount();
  await press('B1:B2');
  expect([wb.getValue(id, 0, 1), wb.getValue(id, 1, 1)]).toEqual([null, null]);
  // Still unlocked, so typing goes on working.
  expect(wb.getCell(id, 0, 1).s?.locked).toBe(false);
  wb.undo();
  expect([wb.getValue(id, 0, 1), wb.getValue(id, 1, 1)]).toEqual(['Ada', 555]);
});

it('clears nothing when the selection holds a locked cell', async () => {
  const { wb, id, press } = await mount();
  const said = [];
  wb.addEventListener('change', (e) => { if (e.detail.type === 'protected') said.push(e.detail.sheetId); });
  await press('A1:B2');
  expect([wb.getValue(id, 0, 0), wb.getValue(id, 0, 1), wb.getValue(id, 1, 1)]).toEqual(['Name', 'Ada', 555]);
  expect(said).toContain(id);
  expect(wb.canUndo()).toBe(false);
});
