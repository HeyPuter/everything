// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { resetAppOptions, setAppOptions } from '../src/lib/app-options.js';

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
afterEach(() => { resetAppOptions(['showObjects']); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = () => vi.advanceTimersByTimeAsync(5);
async function mount() {
  const doc = new Doc({ name: 'Ink' }); const wb = doc.wb;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  [...view.el.querySelectorAll('.ribbon [role="tab"]')].find(n => n.textContent === 'Draw').click(); await flush();
  return { wb, id: wb.activeSheetId };
}
const button = label => [...view.el.querySelectorAll('.ribbon-panels button')].find(b => b.getAttribute('aria-label') === label) || null;
function pointer(type, x, y) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 });
  for (const [k, v] of Object.entries({ pointerId: 1, pointerType: 'mouse', pressure: 0.5 })) Object.defineProperty(e, k, { value: v });
  return e;
}
function drag(points) {
  const surface = view.el.querySelector('.ink-surface');
  surface.dispatchEvent(pointer('pointerdown', ...points[0]));
  for (const p of points.slice(1)) surface.dispatchEvent(pointer('pointermove', ...p));
  surface.dispatchEvent(pointer('pointerup', ...points.at(-1)));
}
const wave = (x0, y0) => Array.from({ length: 30 }, (_, i) => [x0 + i * 5, y0 + Math.sin(i / 4) * 12]);

async function strokes(...rows) {
  const { wb, id } = await mount();
  view.el.querySelector('.ribbon [data-ink-pen="pen-1"]').click(); await flush();
  for (const y of rows) drag(wave(200, y));
  await flush();
  return { wb, id, first: wb.sheet(id).charts[0].id };
}

it('leaves a stroke hidden in the Selection Pane alone when the eraser passes over it', async () => {
  const { wb, id, first } = await strokes(100, 250);
  wb.setObjectsHidden(id, [first], true); await flush();
  button('Eraser').click(); await flush();
  drag([[260, 60], [262, 140]]); await flush();
  expect(wb.sheet(id).charts.map(c => c.id)).toContain(first);
});

it('leaves strokes alone with every object hidden in Options', async () => {
  const { wb, id } = await strokes(100, 250);
  setAppOptions({ showObjects: false });
  button('Eraser').click(); await flush();
  drag([[260, 60], [262, 140]]); await flush();
  expect(wb.sheet(id).charts).toHaveLength(2);
});

it('does not lasso a hidden stroke, so dragging or Delete cannot reach it', async () => {
  const { wb, id, first } = await strokes(100, 160, 250);
  wb.setObjectsHidden(id, [first], true); await flush();
  button('Lasso Select').click(); await flush();
  drag([[180, 70], [400, 70], [400, 300], [180, 300], [181, 71]]); await flush();
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })); await flush();
  expect(wb.sheet(id).charts.map(c => c.id)).toEqual([first]);
});
