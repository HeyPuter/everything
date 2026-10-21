// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// Dragging a column or row header to reorder lines left the selection on where the move landed, and undoing
// the move put the lines back but left it there, so the lines just restored had to be picked out again. The
// selection the user had joins the step now, as it does for Insert and Delete rows; a press that never moved
// records nothing.
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
  Element.prototype.scrollBy = () => {};
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const pointer = (target, type, init) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ...init }));

async function mount() {
  const doc = new Doc({ name: 'Move', path: 'Spreadsheets/Move.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) wb.setInput(id, r, c, `${String.fromCharCode(65 + c)}${r + 1}`);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.getBoundingClientRect = () => ({ left: 48, top: 26, right: 848, bottom: 426, width: 800, height: 400 });
  const colClip = view.el.querySelector('.grid-colhead-clip');
  const goTo = async (a) => { view.goTo(`Sheet1!${a}`); await vi.advanceTimersByTimeAsync(1); };
  const selected = () => view.el.querySelector('.status-left .status-item').textContent;
  const menu = async (...path) => {
    view.el.querySelector(`[data-menu="${path[0]}"]`).click();
    for (const label of path.slice(1)) {
      [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label).click();
      await vi.advanceTimersByTimeAsync(1);
    }
  };
  /** Press the header of column `c` (inside a whole-column selection) and release it at `x`. */
  const dragHeader = async (c, x) => {
    pointer(colClip.querySelector(`.hcell[data-c="${c}"]`), 'pointerdown', { clientX: c * 100 + 98, clientY: 13 });
    if (x != null) pointer(colClip, 'pointermove', { clientX: x, clientY: 13 });
    pointer(colClip, 'pointerup', { clientX: x ?? c * 100 + 98, clientY: 13 });
    await vi.advanceTimersByTimeAsync(5);
  };
  return { wb, id, goTo, selected, menu, dragHeader };
}

const column = (wb, id, c) => [0, 1, 2].map((r) => wb.getValue(id, r, c));

it('puts the selection back where it was when a header move is undone, and on the moved lines on redo', { timeout: 20000 }, async () => {
  const { wb, id, goTo, selected, menu, dragHeader } = await mount();
  await goTo('A:A');
  const before = selected();
  await dragHeader(0, 330); // column A dropped past C
  expect(column(wb, id, 0)).toEqual(['B1', 'B2', 'B3']); // the move went through
  const after = selected();
  expect(after).not.toBe(before);
  await menu('edit', 'Undo');
  expect(column(wb, id, 0)).toEqual(['A1', 'A2', 'A3']);
  expect(selected()).toBe(before);
  await menu('edit', 'Redo');
  expect(column(wb, id, 0)).toEqual(['B1', 'B2', 'B3']);
  expect(selected()).toBe(after);
});

it('records nothing for a press on a header that never moved', { timeout: 20000 }, async () => {
  const { wb, id, goTo, selected, menu, dragHeader } = await mount();
  await goTo('A:A');
  wb.setInput(id, 5, 0, 'later'); // an ordinary step to undo
  await vi.advanceTimersByTimeAsync(1);
  await dragHeader(2, null); // pressed and released on C's header: a click, not a move
  expect(selected()).toBe('C:C');
  expect(column(wb, id, 0)).toEqual(['A1', 'A2', 'A3']); // nothing moved
  await menu('edit', 'Undo');
  // Undoing the cell edit shows the cell it changed, as any cell step does; no selection was kept for the click.
  expect(wb.getValue(id, 5, 0)).toBeNull();
  expect(selected()).toBe('A6');
});
