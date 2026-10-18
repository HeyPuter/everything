// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { installMockPuter } from './helpers/mock-puter.js';

// On a slow or stalled connection the save on the way out could take minutes, or never end: Back, Home and every
// other way out waited on it with nothing said, and pressing Back again did nothing. After a while the user is
// now asked: wait (and leave once saved), keep editing, or leave with the edits kept in the local draft.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), keys: () => [...m.keys()] };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
beforeEach(() => {
  localStorage.clear();
  installMockPuter();
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete globalThis.puter; document.body.replaceChildren(); });

/** An editor on a saved file whose next write hangs until `release(error?)` settles it. */
async function stalled() {
  const doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'saved');
  await doc.rename('Budget');
  await doc.save();
  const goHome = vi.fn();
  view = editorView({ doc, goHome, openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  const write = puter.fs.write;
  let release;
  puter.fs.write = (path, ...rest) => (path !== doc.path ? write.call(puter.fs, path, ...rest)
    : new Promise((resolve, reject) => { release = (error) => (error ? reject(error) : resolve(write.call(puter.fs, path, ...rest))); }));
  doc.wb.setInput(doc.wb.activeSheetId, 1, 0, 'unsaved');
  return { doc, goHome, release: (error) => release(error) };
}
const dialog = () => document.querySelector('.modal-root:not(.closing) .modal-panel[aria-label="Still saving"]');
const button = (label) => [...dialog().querySelectorAll('button')].find((b) => b.textContent === label);
const back = () => view.el.querySelector('[aria-label="Back to all spreadsheets"]').click();

it('asks after a while, and leaves on its own once the save lands', async () => {
  const { doc, goHome, release } = await stalled();
  back();
  await vi.advanceTimersByTimeAsync(5000);
  expect(dialog()).toBeNull(); // an ordinary slow save is waited for without a word
  await vi.advanceTimersByTimeAsync(6000);
  expect(dialog()).not.toBeNull();
  expect(dialog().textContent).toContain('stay in this browser');
  release();
  await vi.advanceTimersByTimeAsync(10);
  expect(dialog()).toBeNull();
  expect(goHome).toHaveBeenCalledOnce();
  expect(doc.wb.dirty).toBe(false);
});

it('leaves with the edits in the local draft, and the stalled save, when it fails later, tries no more', async () => {
  const { doc, goHome, release } = await stalled();
  back();
  await vi.advanceTimersByTimeAsync(11_000);
  button('Leave').click();
  await vi.advanceTimersByTimeAsync(10);
  expect(goHome).toHaveBeenCalledOnce();
  expect(localStorage.keys().some((key) => key.includes('Budget'))).toBe(true);
  // The router flushes once more on the way out, and does not wait for the same save again.
  await expect(view.flush()).resolves.toBe(true);
  view.destroy();
  view = null;
  const writes = vi.spyOn(puter.fs, 'write');
  release(new TypeError('Failed to fetch'));
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(writes.mock.calls.filter(([path]) => path === doc.path)).toEqual([]); // no retries from a document that was closed
  expect(localStorage.keys().some((key) => key.includes('Budget'))).toBe(true);
  expect(doc.wb.dirty).toBe(true);
});

it('keeps editing, the save going on, or waits and asks again', async () => {
  const { goHome, release } = await stalled();
  const leaving = view.flush();
  await vi.advanceTimersByTimeAsync(11_000);
  button('Wait').click();
  await vi.advanceTimersByTimeAsync(5000);
  expect(dialog()).toBeNull();
  await vi.advanceTimersByTimeAsync(6000);
  button('Keep editing').click();
  await expect(leaving).resolves.toBe(false);
  expect(goHome).not.toHaveBeenCalled();
  release();
  await vi.advanceTimersByTimeAsync(10);
  expect(view.doc.status).toBe('saved');
});
