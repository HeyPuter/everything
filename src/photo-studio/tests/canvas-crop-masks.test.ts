import { describe, expect, it } from 'vitest';
import { cropDocument, layer, newDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { filledMask, gridDocBounds, gridFromImage, TileStore } from '../src/model/tiles';

describe('canvas crops and layer masks', () => {
  it('keeps group masks and unlinked masks over the same pixels', () => {
    const store = new TileStore();
    const doc = newDocument(200, 100);
    const px = newPixelLayer('Pixels', doc, gridFromImage(store, { width: 200, height: 100, data: new Uint8ClampedArray(200 * 100 * 4).fill(255) }));
    px.maskGrid = filledMask(store, { x: 0, y: 0, width: 40, height: 100 });
    px.maskUnlinked = true;
    const g = layer('group', 'Group', 200, 100);
    g.maskGrid = filledMask(store, { x: 0, y: 0, width: 60, height: 100 });
    doc.layers = [px, g];
    cropDocument(doc, { x: 30, y: 10, width: 100, height: 60 });
    expect(gridDocBounds(doc.layers[1].maskGrid!)).toEqual({ x: -30, y: -10, width: 60, height: 100 });
    expect(gridDocBounds(doc.layers[0].maskGrid!)).toEqual({ x: -30, y: -10, width: 40, height: 100 });
  });
});
