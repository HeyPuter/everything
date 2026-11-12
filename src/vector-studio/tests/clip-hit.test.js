import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { hitTest } from '../src/render/hit.js';
import { nodeBounds } from '../src/model/geometry.js';

const red = { type: 'solid', color: '#ff0000' };

function clipGroup(doc, mask, parts = []) {
  const art = createPath(rectangle(0, 0, 400, 200), true, { fill: red, stroke: null });
  const g = createGroup([art.id, mask.id], { clip: true });
  doc.transact('t', () => doc.insert(g, doc.layers()[0].id, Infinity, [art, mask, ...parts]));
  return { art, g };
}

// A clip group shows its content only inside the clipping path's real shape, so only there is the
// content clickable: not across the bounding box of a group or of type used as the clipping path.
describe('clicking a clip group', () => {
  beforeAll(() => installCanvasStub());

  it('with a group as its clipping path hits the content only inside the group parts', () => {
    const doc = VDocument.create({ width: 400, height: 200 });
    const a = createPath(rectangle(10, 10, 50, 50), true, { fill: null, stroke: null });
    const b = createPath(rectangle(200, 10, 50, 50), true, { fill: null, stroke: null });
    const { art } = clipGroup(doc, createGroup([a.id, b.id]), [a, b]);
    expect(hitTest(doc, 30, 30, 2)?.id).toBe(art.id);
    expect(hitTest(doc, 220, 40, 2)?.id).toBe(art.id);
    // Between the parts, inside the group's bounds: nothing shows there.
    expect(hitTest(doc, 120, 30, 2)).toBe(null);
    // Outside the bounds, as before.
    expect(hitTest(doc, 300, 150, 2)).toBe(null);
  });

  it('with type as its clipping path does not hit across the type bounding box', () => {
    const doc = VDocument.create({ width: 400, height: 200 });
    const t = createText('I        I', 10, 100);
    const mask = { ...t, char: { ...t.char, fontSize: 72 } };
    clipGroup(doc, mask);
    const b = nodeBounds(doc, doc.get(mask.id));
    // The canvas stub paints no glyphs: a point inside the type's bounds (between the letters)
    // shows nothing, so neither the content nor the type is picked.
    expect(hitTest(doc, b.x + b.w / 2, b.y + b.h / 2, 2)).toBe(null);
  });
});
