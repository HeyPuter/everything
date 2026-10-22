// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import * as notifications from '../src/ui/toast.js';

// Replace image (Change Picture) kept the old picture's crop and frame: a picture cropped to its top-left quarter,
// replaced with a wide one, showed the top-left quarter of the new one, stretched into the old square. The new
// picture now shows whole, in its own proportions, as large as fits in the old frame from the same corner.
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
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('shows a replacement picture whole and undistorted in the old frame', async () => {
  vi.stubGlobal('FileReader', class { readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; setTimeout(() => this.onload(), 0); } });
  vi.stubGlobal('Image', class { set src(v) { this.naturalWidth = 400; this.naturalHeight = 100; setTimeout(() => this.onload(), 0); } });
  const doc = new Doc({ name: 'Pictures', path: 'Spreadsheets/Pictures.xlsx' });
  const wb = doc.wb, id = wb.activeSheetId;
  const pic = wb.addChart(id, { type: 'image', src: 'data:image/png;base64,BBBB', title: 'square.png', anchor: { r: 1, c: 1 }, dx: 4, dy: 4, w: 100, h: 100,
    srcRect: { l: 0, t: 0, r: 0.5, b: 0.5 } });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.run('replaceImage', pic);
  const input = [...view.el.querySelectorAll('input[type="file"]')].find(i => /^image\/png,image\/jpeg,image\/gif,image\/webp/.test(i.accept));
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array(10)], 'wide.png', { type: 'image/png' })] });
  input.dispatchEvent(new Event('change'));
  await vi.advanceTimersByTimeAsync(10);
  const obj = wb.chartById(id, pic);
  expect(obj).toMatchObject({ src: 'data:image/png;base64,AAAA', title: 'wide.png', anchor: { r: 1, c: 1 }, dx: 4, dy: 4, w: 100, h: 25 });
  expect(obj.srcRect).toBeUndefined();
  expect(wb.undoLabel()).toBe('Replace image');
});
