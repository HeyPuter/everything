// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc, setAutoSaveEnabled } from '../src/lib/doc.js';
import { session } from '../src/lib/session.js';

// With AutoSave off, edits wait for Save. The editor saved them all the same whenever the session announced a change:
// signing in, and every preference kept with the account (choosing a theme or a regional format), so turning the
// theme dark wrote the what-if edits held back into the file.

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
const state = session.state;
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
afterEach(() => {
  view?.destroy(); view = null; session.state = state; setAutoSaveEnabled(true);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

async function editedWhileSignedOut(autoSave) {
  setAutoSaveEnabled(autoSave);
  session.state = 'out';
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  const save = vi.spyOn(doc, 'save').mockResolvedValue(true);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'what-if');
  await vi.advanceTimersByTimeAsync(2000);
  session.state = 'in';
  session.dispatchEvent(new CustomEvent('change')); // signed in
  session.dispatchEvent(new CustomEvent('change')); // and a theme chosen
  await vi.advanceTimersByTimeAsync(1);
  return save;
}

it('leaves edits held back with AutoSave off unsaved when the session changes', async () => {
  expect(await editedWhileSignedOut(false)).not.toHaveBeenCalled();
});

it('saves edits made before signing in once signed in, with AutoSave on', async () => {
  expect(await editedWhileSignedOut(true)).toHaveBeenCalledWith({ auto: true });
});
