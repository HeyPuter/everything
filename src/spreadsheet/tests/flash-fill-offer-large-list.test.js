// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { resetAppOptions, reloadAppOptions } from '../src/lib/app-options.js';
import { toast } from '../src/ui/toast.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn(() => ({ dismiss: () => {} })) }));

// Flash Fill as you type looks for a pattern only where it could offer one: an entry added at the foot of a long
// list, or changed inside a filled column, no longer reads every cell of the list after each Enter.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i], get length() { return m.size; } };
}

let view;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  reloadAppOptions();
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
afterEach(() => { toast.mockClear(); closeMenu(); closeAllModals(); view?.destroy(); view = null; resetAppOptions(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  const doc = new Doc({ name: 'Book', path: 'Spreadsheets/Book.xlsx' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  const key = (target, k) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const type = async (a, text) => {
    view.goTo(`Sheet1!${a}`);
    await vi.advanceTimersByTimeAsync(1);
    key(viewport, text[0]);
    const editor = view.el.querySelector('.grid-editor');
    editor.value = text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text.slice(-1), inputType: 'insertText' }));
    key(editor, 'Enter');
    await vi.advanceTimersByTimeAsync(1);
  };
  return { wb: doc.wb, id: doc.wb.activeSheetId, type };
}

const ROWS = 2000;
function fillList(wb, id) {
  const entries = [];
  for (let r = 0; r < ROWS; r++) {
    entries.push({ r, c: 0, cell: { v: `First${r} Last${r}` } });
    entries.push({ r, c: 1, cell: { v: `First${r}` } });
    entries.push({ r, c: 2, cell: { v: r } });
  }
  wb.setCells(id, entries);
}
const offers = () => toast.mock.calls.filter(([message]) => /Flash Fill can fill/.test(message));

describe('Flash Fill as you type in a long list', () => {
  it('does not read the list when a row is added at its foot', async () => {
    const { wb, id, type } = await mount();
    fillList(wb, id);
    const reads = vi.spyOn(wb, 'getDisplay');
    await type(`B${ROWS + 1}`, 'Newcomer');
    expect(offers()).toHaveLength(0);
    expect(reads.mock.calls.length).toBeLessThan(50);
  });

  it('does not read the list when an entry inside a filled column changes', async () => {
    const { wb, id, type } = await mount();
    fillList(wb, id);
    const reads = vi.spyOn(wb, 'getDisplay');
    await type('B500', 'Changed');
    expect(offers()).toHaveLength(0);
    expect(reads.mock.calls.length).toBeLessThan(50);
  });

  it('still offers once two examples head an empty column', async () => {
    const { wb, id, type } = await mount();
    const entries = [];
    for (let r = 0; r < 50; r++) { entries.push({ r, c: 0, cell: { v: `First${r} Last${r}` } }); entries.push({ r, c: 2, cell: { v: r } }); }
    wb.setCells(id, entries);
    await type('B1', 'First0');
    await type('B2', 'First1');
    expect(offers()).toHaveLength(1);
    expect(offers()[0][0]).toMatch(/fill 48 more cells/);
  });

  it('still offers when an error stands below the second example', async () => {
    const { wb, id, type } = await mount();
    const entries = [];
    for (let r = 0; r < 6; r++) entries.push({ r, c: 0, cell: { v: `First${r} Last${r}` } });
    wb.setCells(id, entries);
    wb.setInput(id, 2, 1, '=1/0');
    await type('B1', 'First0');
    await type('B2', 'First1');
    expect(offers()).toHaveLength(1);
  });
});
