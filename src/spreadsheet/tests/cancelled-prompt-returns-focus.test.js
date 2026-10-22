// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Row Height…, Column Width… and a custom Text Rotation hand the keyboard back to the sheet once a size is given,
// but cancelled they left it on the ribbon button that asked, or on nothing when a menu had asked: the arrow keys
// then moved along the ribbon, or did nothing, instead of moving the active cell.
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Focus' });
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { view, viewport: view.el.querySelector('.grid-viewport') };
}

it.each([['resizeRows'], ['resizeCols'], ['rotate', 'custom']])('puts the keyboard back on the sheet when %s is cancelled', async (cmd, arg) => {
  const { view, viewport } = await mount();
  const button = view.el.querySelector('.ribbon button, .toolbar button');
  button.focus();
  const done = view.run(cmd, arg);
  await vi.advanceTimersByTimeAsync(1);
  const cancel = [...document.querySelectorAll('.modal-root:not(.closing) button')].find((b) => b.textContent === 'Cancel');
  cancel.click();
  await done;
  await vi.advanceTimersByTimeAsync(1);
  expect(document.activeElement).toBe(viewport);
  view.destroy();
});
