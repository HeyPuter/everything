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
const key = (node, key, extra = {}) => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
const flush = () => vi.advanceTimersByTimeAsync(1);
async function mount() {
  const doc = new Doc({ name: 'Ribbon focus' }); const wb = doc.wb; const id = wb.activeSheetId;
  [['Item', 'Quantity', 'Price', 'Total'], ['Notebook', '3', '4.5', '=B2*C2'], ['Pencil', '6', '1.25', '=B3*C3'], ['Folder', '2', '3', '=B4*C4']]
    .forEach((row, r) => row.forEach((value, c) => wb.setInput(id, r, c, value)));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}
const button = label => [...view.el.querySelectorAll(`button[aria-label="${label}"]`)].find(b => !b.closest('[hidden]'));
const ribbonTab = name => [...view.el.querySelectorAll('.ribbon [role="tab"]')].find(n => n.textContent === name);

it('hands the keyboard back to the sheet after a ribbon command that leaves the focus on its button', async () => {
  await mount();
  const viewport = view.el.querySelector('.grid-viewport');
  ribbonTab('Formulas').click(); await flush();
  for (const label of ['Show Formulas', 'Error Checking']) {
    const b = button(label);
    expect(b, label).toBeTruthy();
    b.focus(); b.click(); await flush(); await flush();
    expect(document.activeElement, label).toBe(viewport);
  }
  // Paste with nothing copied says so and comes back too (the Home tab's own button).
  ribbonTab('Home').click(); await flush();
  const paste = button('Paste');
  paste.focus(); paste.click(); await vi.advanceTimersByTimeAsync(1500);
  expect(document.activeElement).toBe(viewport);
});

it('leaves the focus where a command put it, as in a menu it opened', async () => {
  await mount();
  ribbonTab('Home').click(); await flush();
  const b = button('Borders');
  b.focus(); b.click(); await flush(); await flush();
  expect(document.activeElement.closest('.menu')).toBeTruthy();
});
