// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { setLocale } from '../src/core/format.js';
import { closeAllModals } from '../src/ui/modal.js';

// Format ▸ Custom font size asks for a size and says decimals are supported, but read only a full stop: in a regional
// format that writes decimals with a comma, 10,5 was refused as "not a number from 1 to 409", and the size offered
// was written 10.5. It now reads and writes the regional decimal mark, as a cell's entry does.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

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
afterEach(() => { closeAllModals(); setLocale('en-US'); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });


async function ask(locale, typed) {
  setLocale(locale);
  const doc = new Doc({ name: 'Size', path: 'Spreadsheets/Size.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'x');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { size: 14 }); // 10.5 points
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.run('fontSize');
  await vi.advanceTimersByTimeAsync(1);
  const input = document.querySelector('.modal-panel input');
  const offered = input.value;
  input.value = typed;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form').requestSubmit();
  await vi.advanceTimersByTimeAsync(1);
  return { offered, size: wb.styleAt(id, 0, 0)?.size };
}

it('reads and offers the size with a decimal comma where the regional format uses one', async () => {
  const { offered, size } = await ask('de-DE', '12,5');
  expect(offered).toBe('10,5');
  expect(size).toBeCloseTo(12.5 * 4 / 3, 5);
});

it('still reads a full stop in English', async () => {
  const { offered, size } = await ask('en-US', '12.5');
  expect(offered).toBe('10.5');
  expect(size).toBeCloseTo(12.5 * 4 / 3, 5);
});
