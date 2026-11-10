// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc, THEIRS_NOT_KEPT } from '../src/lib/doc.js';
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
});

const buttons = () => [...document.querySelectorAll('[role="dialog"] button')];
const button = (label) => buttons().find((b) => b.textContent === label);

/** The editor of a file changed elsewhere whose version cannot be kept: forceSave refuses until told not to keep it. */
async function conflictedEditor() {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  const forceSave = vi.spyOn(doc, 'forceSave').mockImplementation(async ({ keepTheirs = true } = {}) => {
    if (keepTheirs) throw new Error(THEIRS_NOT_KEPT, { cause: new Error('Storage is full') });
    return true;
  });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  doc.dispatchEvent(new CustomEvent('conflict', { detail: { kind: 'changed', remoteModified: Date.now() } }));
  await vi.advanceTimersByTimeAsync(1);
  button('Overwrite with mine').click();
  await vi.advanceTimersByTimeAsync(500);
  return forceSave;
}

// The conflict dialog says theirs is kept in Version history; when it could not be, the overwrite went ahead all the
// same, the failure only logged. Now the user is told, and theirs is written over only when they say so.
it('asks before overwriting their version when it could not be kept in Version history', async () => {
  const forceSave = await conflictedEditor();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain('could not be kept in Version history (Storage is full)');
  expect(forceSave).toHaveBeenCalledTimes(1);
  button('Overwrite anyway').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(forceSave).toHaveBeenCalledTimes(2);
  expect(forceSave).toHaveBeenLastCalledWith({ keepTheirs: false });
});

it('leaves their version as it is when the user cancels', async () => {
  const forceSave = await conflictedEditor();
  button('Cancel').click();
  await vi.advanceTimersByTimeAsync(500);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(forceSave).toHaveBeenCalledTimes(1);
});
