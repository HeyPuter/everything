// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Insert ▸ Icons places the icons chosen in a row from the active cell. Every one of them was anchored to the
// active cell, the later ones by offsets reaching several columns past it, so they followed that cell's column
// rather than the ones they lay over: a column inserted under the row of icons left them where they were, over
// the new empty column, and the offsets a file keeps reached past their cells. Each icon is now anchored to the
// cell its own corner lies in.
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
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('anchors each icon of a row to the cell under its own corner', async () => {
  const doc = new Doc({ name: 'Icons', path: 'Spreadsheets/Icons.xlsx' });
  const { wb } = doc; const id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(5);
  view.goTo('Sheet1!B2'); await vi.advanceTimersByTimeAsync(5);
  view.run('insertIcons', ['bold', 'italic', 'underline']); await vi.advanceTimersByTimeAsync(5);
  const icons = wb.sheet(id).charts;
  expect(icons).toHaveLength(3);
  const rects = icons.map((o) => wb.objectRect(id, o.id));
  // Side by side, 8 pixels apart, as before.
  expect(rects[1].x - rects[0].x).toBeCloseTo(rects[0].w + 8, 6);
  expect(rects[2].x - rects[1].x).toBeCloseTo(rects[1].w + 8, 6);
  for (const o of icons) expect(o.dx).toBeLessThan(wb.colWidth(id, o.anchor.c));
  expect(icons[0].anchor).toEqual({ r: 1, c: 1 });
  expect(icons[2].anchor.c).toBeGreaterThan(1);
  // A column inserted before the last icon's cell moves that icon with it, and leaves the first where it is.
  const last = icons[2].anchor.c;
  wb.insertCols(id, last, 1);
  expect(wb.objectRect(id, icons[2].id).x).toBeCloseTo(rects[2].x + wb.colWidth(id, last), 6);
  expect(wb.objectRect(id, icons[0].id).x).toBeCloseTo(rects[0].x, 6);
});
