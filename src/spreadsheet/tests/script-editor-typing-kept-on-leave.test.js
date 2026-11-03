// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';

// Code typed into the Code Editor goes into the workbook half a second after the typing stops. Leaving the
// workbook (Home, opening another file) within that half second saved the book and closed it without the
// last keystrokes: reopened, the script was as it had been before them. Saving, downloading and the copy
// kept when the page is hidden or closed missed them in the same way.
let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const settle = () => vi.advanceTimersByTimeAsync(1);

async function typed() {
  const doc = new Doc({ name: 'Book' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await settle();
  await view.run('newScript');
  await settle();
  const textarea = view.el.querySelector('.ce-input');
  textarea.value = 'async function main(workbook) { /* the last words typed */ }';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  return doc.wb;
}

it('puts the code just typed into the workbook before the workbook is left', async () => {
  const wb = await typed();
  expect(wb.scripts[0].code).not.toMatch(/the last words typed/);
  view.flush();
  expect(wb.scripts[0].code).toMatch(/the last words typed/);
});

it('puts the code just typed into the workbook as the page is hidden', async () => {
  const wb = await typed();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(wb.scripts[0].code).toMatch(/the last words typed/);
});
