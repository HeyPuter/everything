// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.classList.contains('prompt-pop') ? 280 : 0; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// A validation rule's input message sat under the selected cell starting at its left edge, so under a cell near
// the right of the window (on a phone, nearly every cell) most of the message ran out of sight. It now slides left
// to stay inside the window, and stays at the cell where there is room.
it('keeps an input message inside the window', async () => {
  const doc = new Doc({ name: 'Prompt' }); const wb = doc.wb; const id = wb.activeSheetId;
  wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 9, c2: 20 }, type: 'whole', min: 1, max: 9, prompt: 'Enter a whole number from one to nine.', promptTitle: 'Score' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  const pop = view.el.querySelector('.prompt-pop');
  const left = () => Number(/translate\(([-\d.]+)px/.exec(pop.style.transform)[1]);
  view.goTo('B3'); await vi.advanceTimersByTimeAsync(50);
  expect(pop.hidden).toBe(false);
  const b = left();
  view.goTo('K3'); await vi.advanceTimersByTimeAsync(50);
  expect(left()).toBeGreaterThan(b);
  expect(left() + 280).toBeLessThanOrEqual(800);
});
