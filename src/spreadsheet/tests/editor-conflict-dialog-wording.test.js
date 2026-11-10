// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';

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
afterEach(() => {
  closeAllModals();
  view?.destroy();
  view = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// The dialog claimed another copy had been saved, though the file may only have been moved or
// renamed elsewhere (for a file too large to read back and compare, that is all the time can tell).
it('says the file was saved, moved or renamed since it was opened, rather than that another copy was saved', async () => {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  doc.dispatchEvent(new CustomEvent('conflict', { detail: { kind: 'changed', remoteModified: Date.now() } }));
  await vi.advanceTimersByTimeAsync(1);
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog.textContent).toContain('"Budget" was saved, moved or renamed since you opened it');
  expect(dialog.textContent).not.toContain('Another copy');
  // What "Overwrite with mine" writes over is kept as a version first (see Doc#forceSave): the dialog says where.
  expect(dialog.textContent).toContain('theirs is kept in Version history');
  expect([...dialog.querySelectorAll('button')].map((b) => b.textContent)).toEqual(expect.arrayContaining(['Overwrite with mine', 'Reload theirs']));
});
