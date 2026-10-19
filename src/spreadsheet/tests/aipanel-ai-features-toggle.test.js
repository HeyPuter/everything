// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { setAppOptions, resetAppOptions, reloadAppOptions } from '../src/lib/app-options.js';
import { toast } from '../src/ui/toast.js';

// Options ▸ Privacy ▸ Offer AI features, turned off and on again with a workbook open. Turned on in a workbook opened
// with it off, the assistant never came (Ctrl+J said "AI is not available here" until the page was reloaded); turned
// off and on with the assistant collapsed, its panel came back empty and broken beside the strip that stands in for it.
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}

let view;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  reloadAppOptions();
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (q) => ({ matches: !/max-width/.test(q), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (t) => ({ width: t.length * 7 }) });
  window.puter = { ai: { chat: vi.fn() } };
  toast.mockClear();
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  view?.destroy();
  view = null;
  resetAppOptions();
  delete window.puter;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function mount() {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
}
const panel = () => view.el.querySelector('.ai-panel');
const rail = () => view.el.querySelector('.ai-rail');
const ctrlJ = () => view.el.querySelector('.grid-viewport').dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true, bubbles: true, cancelable: true }));

it('brings the assistant when AI features are turned on in a workbook opened with them off', async () => {
  setAppOptions({ aiFeatures: false });
  await mount();
  expect(!panel() || panel().hidden).toBe(true);
  expect(!rail() || rail().hidden).toBe(true);
  setAppOptions({ aiFeatures: true });
  await vi.advanceTimersByTimeAsync(1);
  expect(rail()?.hidden).toBe(false);
  expect(panel().hidden).toBe(true);
  ctrlJ();
  await vi.advanceTimersByTimeAsync(1);
  expect(panel().hidden).toBe(false);
  expect(rail().hidden).toBe(true);
  expect(toast).not.toHaveBeenCalled();
});

it('comes back as it was left, collapsed or open, when AI features are turned off and on', async () => {
  await mount();
  expect(panel().hidden).toBe(false);
  view.run('aiPanel', false); // collapsed to its strip
  expect([panel().hidden, rail().hidden]).toEqual([true, false]);
  setAppOptions({ aiFeatures: false });
  expect([panel().hidden, rail().hidden]).toEqual([true, true]);
  setAppOptions({ aiFeatures: true });
  expect([panel().hidden, rail().hidden]).toEqual([true, false]);
  // Left open, it opens again.
  ctrlJ();
  expect([panel().hidden, rail().hidden]).toEqual([false, true]);
  setAppOptions({ aiFeatures: false });
  expect([panel().hidden, rail().hidden]).toEqual([true, true]);
  setAppOptions({ aiFeatures: true });
  expect([panel().hidden, rail().hidden]).toEqual([false, true]);
  // Turned off, Ctrl+J says where to turn them on, and opens nothing.
  setAppOptions({ aiFeatures: false });
  ctrlJ();
  expect([panel().hidden, rail().hidden]).toEqual([true, true]);
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/turned off in Options/), expect.anything());
});
