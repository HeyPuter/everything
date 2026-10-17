// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// Undoing or redoing a cell edit left the selection and the sheet where they were, so a change made
// out of sight was taken back unseen. Excel and Sheets bring the step's sheet into view and select
// the cells it changed; structural steps keep putting back their own selection.
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


async function mount() {
  const doc = new Doc({ name: 'Undo', path: 'Spreadsheets/Undo.xlsx' });
  const wb = doc.wb;
  wb.addSheet('Other');
  wb.setActiveSheet(wb.sheets[0].id);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const goTo = async (range) => { view.goTo(range); await vi.advanceTimersByTimeAsync(1); };
  const selected = () => view.el.querySelector('.status-left .status-item').textContent;
  const viewport = () => view.el.querySelector('.grid-viewport');
  const type = async (text) => {
    const vp = viewport();
    vp.focus();
    vp.dispatchEvent(new KeyboardEvent('keydown', { key: text[0], bubbles: true, cancelable: true }));
    const editor = view.el.querySelector('.grid-editor');
    editor.value = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);
  };
  return { wb, goTo, selected, type };
}

it('selects the cell an undone or redone edit changed, on its own sheet', async () => {
  const { wb, goTo, selected, type } = await mount();
  const [one, other] = wb.sheets;
  await goTo('Sheet1!C40');
  await type('far');
  expect(wb.getValue(one.id, 39, 2)).toBe('far');
  // Away on another sheet, and away on this one.
  await goTo('Other!A1');
  expect(wb.activeSheetId).toBe(other.id);
  view.run('undo');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getValue(one.id, 39, 2)).toBeNull();
  expect(wb.activeSheetId).toBe(one.id);
  expect(selected()).toBe('C40');
  await goTo('Sheet1!A1');
  view.run('redo');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getValue(one.id, 39, 2)).toBe('far');
  expect(selected()).toBe('C40');
});

it('selects the range a fill wrote when it is undone', async () => {
  const { wb, goTo, selected } = await mount();
  await goTo('Sheet1!B2:D5');
  wb.fillInput(wb.sheets[0].id, { r1: 1, c1: 1, r2: 4, c2: 3 }, 'x', { r: 1, c: 1 });
  await goTo('Sheet1!H20');
  view.run('undo');
  await vi.advanceTimersByTimeAsync(1);
  expect(selected()).toBe('B2:D5');
});

it('leaves the selection alone for a step that wrote no cells', async () => {
  const { wb, goTo, selected } = await mount();
  wb.renameSheet(wb.sheets[1].id, 'Renamed');
  await goTo('Sheet1!E7');
  view.run('undo');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.sheets[1].name).toBe('Other');
  expect(selected()).toBe('E7');
});
