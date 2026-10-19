// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';

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
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = () => vi.advanceTimersByTimeAsync(1);
async function mount() {
  const doc = new Doc({ name: 'Bar' }); const wb = doc.wb; const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '2'); wb.setInput(id, 1, 0, '3');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}
const bar = () => view.el.querySelector('.formula-input');
async function typeInBar(text, caret) {
  view.goTo('C1'); await flush();
  bar().focus(); await flush();
  bar().value = text; bar().dispatchEvent(new Event('input', { bubbles: true }));
  bar().setSelectionRange(caret, caret);
}

it('puts a function picked from a menu in at the formula bar’s caret, not at the end of the entry', async () => {
  await mount();
  await typeInBar('=1+*2', 3);
  // The fx list, the ribbon's function library or a menu takes the focus before the pick.
  const elsewhere = view.el.querySelector('.fx-btn'); elsewhere.focus(); await flush();
  view.run('insertFunction', 'SUM'); await flush();
  expect(bar().value).toBe('=1+SUM(*2');
  expect(document.activeElement).toBe(bar());
  expect(bar().selectionStart).toBe(7);
});

it('gives the keyboard back to the formula bar, where the typing was, after a ribbon command mid-entry', async () => {
  const { wb, id } = await mount();
  await typeInBar('=A1+', 4);
  view.el.querySelector('.fx-btn').focus(); await flush();
  view.run('bold'); await flush();
  expect(document.activeElement).toBe(bar());
  expect(bar().selectionStart).toBe(4);
  bar().value = '=A1+A2'; bar().dispatchEvent(new Event('input', { bubbles: true }));
  bar().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await flush();
  expect(wb.getValue(id, 0, 2)).toBe(5);
  expect(wb.styleAt(id, 0, 2)?.bold).toBe(true);
});

it('carries an entry typed in the formula bar on in the cell when the bar is hidden under it', async () => {
  const { wb, id } = await mount();
  await typeInBar('=1+', 3);
  // View ▸ Formula Bar (or Focus mode) hides the bar while its field has the keyboard.
  view.el.querySelector('.formula-bar').style.display = 'none';
  bar().checkVisibility = () => false; // jsdom lays nothing out
  bar().blur(); await flush();
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(true);
  expect(document.activeElement).toBe(view.el.querySelector('.grid-editor'));
  view.run('bold'); await flush();
  expect(document.activeElement).toBe(view.el.querySelector('.grid-editor'));
  expect(wb.getCell(id, 0, 2)?.f ?? null).toBeNull(); // still an entry, not committed
});
