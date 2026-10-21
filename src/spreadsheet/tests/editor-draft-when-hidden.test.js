// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc, setAutoSaveEnabled } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { loadDraft } from '../src/lib/drafts.js';
import { optionState } from '../src/lib/option-state.js';

// A phone can close a tab it has put in the background without a word: no beforeunload, nothing. The recovery copy of
// unsaved edits waited for the pause the options set (up to five minutes) after the last change, so the edits made
// in that pause were lost with the tab; they are copied into this browser as the page is hidden.

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

it('copies unsaved edits into this browser as soon as the page is hidden', async () => {
  const saved = optionState.draftDelay;
  setAutoSaveEnabled(false);
  try {
    const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
    view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
    document.querySelector('#app').append(view.el);
    await vi.advanceTimersByTimeAsync(1);
    optionState.draftDelay = 300; // Options ▸ Save: after 5 minutes
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'typed on the train');
    await vi.advanceTimersByTimeAsync(2000);
    expect(loadDraft(doc.draftKey)).toBe(null);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const draft = loadDraft(doc.draftKey);
    expect(draft).not.toBe(null);
    expect(new Workbook(draft.workbook).getValue(doc.wb.activeSheetId, 0, 0)).toBe('typed on the train');
  } finally {
    optionState.draftDelay = saved;
    setAutoSaveEnabled(true);
    delete document.visibilityState;
  }
});
