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

function mount() {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  return doc;
}
const pill = () => view.el.querySelector('.save-status');

// When the look-up failed at open, the first save asked with the dialog for a file that changed
// elsewhere, "saved, moved or renamed since you opened it", though nobody had touched it, and the
// pill read "Changed elsewhere"; only the document's own error, shown in the tooltip, told the truth.
it('asks whether to save anyway when the file could not be checked, rather than claiming it changed elsewhere', async () => {
  const doc = mount();
  doc.dispatchEvent(new CustomEvent('conflict', { detail: { kind: 'unchecked', remoteModified: Date.now() } }));
  await vi.advanceTimersByTimeAsync(1);
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog.querySelector('.modal-title').textContent).toBe('This file could not be checked');
  expect(dialog.textContent).toContain('could not be checked');
  expect(dialog.textContent).not.toContain('was saved, moved or renamed');
  expect(dialog.textContent).not.toContain('changed elsewhere');
  expect([...dialog.querySelectorAll('button')].map((b) => b.textContent)).toEqual(expect.arrayContaining(['Save anyway', 'Reload the file']));
});

it('names the state in the pill: could not be checked, apart from changed elsewhere and moved or deleted', () => {
  const doc = mount();
  // The document says which conflict it is (conflictKind), as its message is in the interface language.
  const show = (error, kind) => { doc.status = 'conflict'; doc.error = error; doc.conflictKind = kind; doc.dispatchEvent(new CustomEvent('status')); return pill().textContent; };
  expect(show('This file could not be checked for changes made elsewhere', 'unchecked')).toBe('Could not be checked');
  expect(pill().title).toContain('could not be checked for changes made elsewhere');
  expect(show('This file changed elsewhere', 'changed')).toBe('Changed elsewhere');
  expect(show('This file was moved or deleted', 'missing')).toBe('Moved or deleted');
});
