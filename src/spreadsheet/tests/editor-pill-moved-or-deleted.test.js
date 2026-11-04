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

function setup() {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  return { doc, pill: view.el.querySelector('.save-status') };
}

// The pill said "Changed elsewhere" for every conflict, a file moved or deleted elsewhere included,
// though the dialog and the tooltip's own reason spoke of a moved or deleted file.
it('says the file was moved or deleted when that is the conflict, changed elsewhere when it changed, and could not be checked when nobody knows', () => {
  const { doc, pill } = setup();
  doc._setStatus('conflict', 'This file was moved or deleted', 'missing');
  expect(pill.textContent).toBe('Moved or deleted');
  expect(pill.title).toBe('Moved or deleted: This file was moved or deleted');
  expect(pill.classList.contains('conflict')).toBe(true);
  doc._setStatus('conflict', 'This file changed elsewhere', 'changed');
  expect(pill.textContent).toBe('Changed elsewhere');
  expect(pill.title).toBe('Changed elsewhere: This file changed elsewhere');
  // An unknown baseline is its own state: nobody knows that the file changed.
  doc._setStatus('conflict', 'This file could not be checked for changes made elsewhere', 'unchecked');
  expect(pill.textContent).toBe('Could not be checked');
  expect(pill.title).toBe('Could not be checked: This file could not be checked for changes made elsewhere');
});
