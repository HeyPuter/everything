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

// The ribbon's Borders menu repainted every side of each cell it touched in its pen: Thick outside borders
// around a gridded block made the grid lines next to the outline thick too, and Bottom double border under a
// cell with a thin top line turned that line double. Excel's pens draw only the sides they name.
it('draws only the sides a border command names, in its pen', async () => {
  const doc = new Doc({ name: 'Borders' }); const wb = doc.wb; const id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  view.goTo('B2:D4');
  view.run('borders', { kind: 'all', style: 'thin', color: null });
  view.run('borders', { kind: 'outer', style: 'thick', color: null });
  expect(pen(wb, id, 1, 1)).toEqual({ bt: 'thick', bb: 'thin', bl: 'thick', br: 'thin' });
  expect(pen(wb, id, 2, 2)).toEqual({ bt: 'thin', bb: 'thin', bl: 'thin', br: 'thin' });
  expect(pen(wb, id, 3, 3)).toEqual({ bt: 'thin', bb: 'thick', bl: 'thin', br: 'thick' });
  view.goTo('F6');
  view.run('borders', { kind: 'top', style: 'thin', color: null });
  view.run('borders', { kind: 'bottom', style: 'double', color: '#ff0000' });
  expect(pen(wb, id, 5, 5)).toEqual({ bt: 'thin', bb: 'double', bl: null, br: null });
  expect(borderSnapshot(wb.styleAt(id, 5, 5)).btBorder?.bc ?? null).toBeNull();
});

// Picking a colour under Borders ▸ Border color restyled the selection's lines in the pen's line style too, so
// colouring a gridded block with a thick outline turned its thin inner lines thick (and picking a line style
// reset their colours). A colour now changes only colours, and a line style only line styles.
it('restyles only the colour or only the line picked', async () => {
  const doc = new Doc({ name: 'Restyle' }); const wb = doc.wb; const id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  view.goTo('B2:D4');
  view.run('borders', { kind: 'all', style: 'thin', color: null });
  view.run('borders', { kind: 'outer', style: 'thick', color: null });
  view.run('borders', { kind: 'restyle', color: '#ff0000' });
  expect(pen(wb, id, 1, 1)).toEqual({ bt: 'thick', bb: 'thin', bl: 'thick', br: 'thin' });
  expect(pen(wb, id, 2, 2)).toEqual({ bt: 'thin', bb: 'thin', bl: 'thin', br: 'thin' });
  expect(borderSnapshot(wb.styleAt(id, 2, 2)).btBorder.bc).toBe('#ff0000');
  view.run('borders', { kind: 'restyle', style: 'dashed' });
  expect(pen(wb, id, 1, 1)).toEqual({ bt: 'dashed', bb: 'dashed', bl: 'dashed', br: 'dashed' });
  expect(borderSnapshot(wb.styleAt(id, 1, 1)).btBorder.bc).toBe('#ff0000');
});
