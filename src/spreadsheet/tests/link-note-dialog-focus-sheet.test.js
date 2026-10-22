// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

// Insert ▸ Link and Insert (or Review) ▸ Note gave the keyboard back to the sheet when saved, but when cancelled
// (Escape, Cancel, the close button) it stayed on the ribbon button they were opened from, so the arrows no
// longer moved the active cell. Every other dialog the ribbon opens hands it back to the sheet.
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
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const flush = () => vi.advanceTimersByTimeAsync(1);
const dialog = () => document.querySelector('.modal-root:not(.closing) .modal-panel');
async function mount() {
  const doc = new Doc({ name: 'Focus' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
}
const ribbonButton = (label) => [...view.el.querySelectorAll('.ribbon .tb-btn')].find((b) => b.getAttribute('aria-label') === label);

it.each([
  ['Insert link', 'Insert', (panel) => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
  ['Insert link', 'Insert', (panel) => [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click()],
  ['Note', 'Review', (panel) => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
  ['Note', 'Review', (panel) => panel.querySelector('[aria-label="Close"]').click()],
])('hands the keyboard back to the sheet when %s from the %s tab is cancelled', async (label, tab, cancel) => {
  await mount();
  [...view.el.querySelectorAll('.ribbon-tab')].find((t) => t.textContent === tab).click();
  await flush();
  const button = ribbonButton(label);
  button.focus();
  button.click();
  await flush();
  const panel = dialog();
  expect(panel).toBeTruthy();
  cancel(panel);
  await flush();
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(view.el.querySelector('.grid-viewport'));
});
