// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import * as P from '../src/lib/puter.js';
import { toast } from '../src/ui/toast.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

// On a phone the assistant is a sheet over the grid, drawn over the task panes (Check Accessibility, the Thesaurus,
// Show Changes, the Selection pane, Queries): one opened while it was up came up unseen beneath it. The assistant now
// goes down for it, as the task panes already take turns among themselves. Beside a wide sheet it stays open.
let view, phone = false;
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (q) => ({ matches: phone ? true : !/max-width/.test(q), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (t) => ({ width: t.length * 7 }) });
  vi.spyOn(P, 'canAI').mockReturnValue(true);
  vi.spyOn(P, 'hasAI').mockReturnValue(true);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  view?.destroy();
  view = null;
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
  return { wb: doc.wb, id: doc.wb.activeSheetId };
}

for (const [cmd, pane] of [['accessibility', '.a11y-pane'], ['thesaurus', '.lang-pane'], ['watchWindow', '.watch-window']]) {
  it(`puts the assistant down on a phone for ${cmd}`, async () => {
    phone = true;
    await mount();
    const panel = view.el.querySelector('.ai-panel');
    view.run('aiPanel');
    await vi.advanceTimersByTimeAsync(1);
    expect(panel.hidden).toBe(false);
    await view.run(cmd);
    await vi.advanceTimersByTimeAsync(1);
    expect(view.el.querySelector(pane).hidden).toBe(false);
    expect(panel.hidden).toBe(true);
  });
}

it('leaves the assistant open beside a wide sheet', async () => {
  phone = false;
  await mount();
  const panel = view.el.querySelector('.ai-panel');
  expect(panel.hidden).toBe(false);
  await view.run('accessibility');
  expect(view.el.querySelector('.a11y-pane').hidden).toBe(false);
  expect(panel.hidden).toBe(false);
});
