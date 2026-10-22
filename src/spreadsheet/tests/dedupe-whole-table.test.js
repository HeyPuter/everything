// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// Selecting the scores of a list (B2:B5) and removing duplicates removed the repeated score alone and moved the
// scores below it up, each now beside another name. Excel first warns that data lies next to the selection and
// offers to expand it; so does the app now, and the expanded list loses whole rows.
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
afterEach(() => { closeMenu(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const LIST = [['Name', 'Score'], ['Ann', '10'], ['Bob', '10'], ['Cid', '20'], ['Dee', '30']];

// Remove Duplicates from one cell of a table read the block of data around the cell, which stops at a blank row:
// a table with a gap had only the rows above it checked. Excel checks the whole table.
it('checks the whole table from one of its cells, past a blank row inside it', async () => {
  const doc = new Doc({ name: 'Dedupe', path: 'Spreadsheets/Dedupe.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  [['Name', 'Score'], ['Ann', '10'], ['Bob', '20'], ['', ''], ['Ann', '10'], ['Cid', '30']].forEach((row, r) => row.forEach((t, c) => wb.setInput(id, r, c, t)));
  wb.addTable(id, { r1: 0, c1: 0, r2: 5, c2: 1 });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!A2');
  await vi.advanceTimersByTimeAsync(1);
  view.run('dedupe');
  await vi.advanceTimersByTimeAsync(1);
  const top = [...document.querySelectorAll('.modal-root:not(.closing) .modal-panel')].pop();
  expect(top.textContent).toContain('A1:B6');
  top.querySelector('button[type=submit]').click();
  await vi.advanceTimersByTimeAsync(1);
  expect([1, 2, 3, 4].map((r) => wb.getDisplay(id, r, 0))).toEqual(['Ann', 'Bob', '', 'Cid']);
});
