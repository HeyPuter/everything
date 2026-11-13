import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createImage, createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { addPattern, PATTERN_DEFAULTS } from '../src/features/patterns/model.js';
import { cellBitmap, patternCss } from '../src/features/patterns/render.js';

let pending;
function renderedImage(canvas) {
  const ctx = canvas.getContext('2d');
  return (Object.hasOwn(ctx, 'recordedImage') ? ctx.recordedImage : null) || (ctx.fillStyle?.canvas ? renderedImage(ctx.fillStyle.canvas) : null);
}
beforeEach(() => {
  pending = [];
  installCanvasStub();
  vi.stubGlobal('Image', class { constructor() { pending.push(this); } finish() { this.onload?.(); } });
  vi.stubGlobal('navigator', { userAgent: 'Pattern image test' });
  const getContext = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    const ctx = getContext.call(this);
    ctx.createPattern = (canvas) => ({ canvas, setTransform() {} });
    ctx.drawImage = (img) => { ctx.recordedImage = img; };
    return ctx;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function () {
    return `data:image/png,${renderedImage(this)?.src || 'empty'}`;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(nested) {
  const doc = VDocument.create();
  doc.assets.set('photo', { mime: 'image/png', data: 'first-image' });
  const node = createImage('photo', 10, 10);
  let def;
  doc.transact('Patterns', () => {
    def = addPattern(doc, { ...PATTERN_DEFAULTS, id: 'image', width: 10, height: 10, art: { roots: [node.id], nodes: [node] } });
    if (nested) {
      const path = createPath(rectangle(0, 0, 10, 10), true, { fill: { type: 'pattern', id: def.id }, stroke: null });
      def = addPattern(doc, { ...PATTERN_DEFAULTS, id: 'outer', width: 10, height: 10, art: { roots: [path.id], nodes: [path] } });
    }
  });
  return { doc, def, paint: { type: 'pattern', id: def.id } };
}
it.each([false, true])('redraws decoded images in pattern bitmaps (nested: %s)', (nested) => {
  const { doc, def } = setup(nested);
  expect(renderedImage(cellBitmap(doc, def, 1).canvas)).toBeNull();
  expect(pending).toHaveLength(1);
  pending[0].finish();
  const ready = cellBitmap(doc, def, 1);
  expect(renderedImage(ready.canvas)).toBe(pending[0]);
  expect(cellBitmap(doc, def, 1)).toBe(ready);
});
it.each([false, true])('refreshes swatch thumbnails when images decode (nested: %s)', (nested) => {
  const { doc, paint } = setup(nested);
  expect(patternCss(paint, doc)).toContain('empty');
  pending[0].finish();
  expect(patternCss(paint, doc)).toContain('first-image');
});
it.each([false, true])('refreshes bitmaps and thumbnails after replacing an image asset (nested: %s)', (nested) => {
  const { doc, def, paint } = setup(nested);
  cellBitmap(doc, def, 1);
  pending[0].finish();
  const original = cellBitmap(doc, def, 1);
  expect(patternCss(paint, doc)).toContain('first-image');
  doc.assets.set('photo', { mime: 'image/png', data: 'replacement-image' });
  expect(renderedImage(cellBitmap(doc, def, 1).canvas)).toBeNull();
  expect(pending).toHaveLength(2);
  pending[1].finish();
  const replaced = cellBitmap(doc, def, 1);
  expect(replaced).not.toBe(original);
  expect(renderedImage(replaced.canvas)).toBe(pending[1]);
  expect(patternCss(paint, doc)).toContain('replacement-image');
});
it('reuses cached images when an unrelated asset is replaced', () => {
  const { doc, def } = setup(true);
  cellBitmap(doc, def, 1);
  pending[0].finish();
  const bitmap = cellBitmap(doc, def, 1);
  doc.assets.set('other', { data: 'unrelated' });
  expect(cellBitmap(doc, def, 1)).toBe(bitmap);
  expect(pending).toHaveLength(1);
});
