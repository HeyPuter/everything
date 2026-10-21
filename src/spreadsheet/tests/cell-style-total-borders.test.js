// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { borderSnapshot } from '../src/core/border-regions.js';

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
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const pen = (wb, id, r, c) => {
  const s = borderSnapshot(wb.styleAt(id, r, c));
  return Object.fromEntries(['bt', 'bb', 'bl', 'br'].map(k => [k, s[k] ? s[`${k}Border`]?.bs || s.bs || 'thin' : null]));
};

// The Total cell style drew its thin top line double: its two edges were drawn one after the other with a pen
// shared by the whole cell, so the double bottom repainted the top. Excel's Total has a thin top and a double
// bottom, and so does a cell here now.
it('gives a Total cell a thin top and a double bottom', async () => {
  const doc = new Doc({ name: 'Total' }); const wb = doc.wb; const id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  view.goTo('B5:D5');
  view.run('cellStyle', 'total');
  for (const c of [1, 2, 3]) expect(pen(wb, id, 4, c)).toMatchObject({ bt: 'thin', bb: 'double' });
  expect(wb.styleAt(id, 4, 1).bold).toBe(true);
});
