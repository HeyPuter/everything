import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { hitTest } from '../src/render/hit.js';

beforeAll(() => installCanvasStub());

function docWith(style) {
  const doc = VDocument.create({ width: 400, height: 400 });
  const p = createPath(rectangle(100, 100, 100, 100), true, {
    fill: null,
    stroke: { type: 'solid', color: '#000000' },
    strokeWidth: 20,
    ...style,
  });
  doc.transact('Add', () => doc.insert(p, doc.root.children[0]));
  return { doc, id: p.id };
}

describe('Clicking strokes aligned inside or outside the path', () => {
  it('an outside stroke is clickable over its whole width, and not inside the shape', () => {
    const { doc, id } = docWith({ strokeAlign: 'outside' });
    // 15 pt outside the left edge: on the 20 pt stroke.
    expect(hitTest(doc, 85, 150, 1)?.id).toBe(id);
    expect(hitTest(doc, 82, 150, 1)?.id).toBe(id);
    // 8 pt inside the edge: nothing is painted there.
    expect(hitTest(doc, 108, 150, 1)).toBe(null);
    // Past the stroke.
    expect(hitTest(doc, 75, 150, 1)).toBe(null);
  });

  it('an inside stroke is clickable over its whole width, and not outside the shape', () => {
    const { doc, id } = docWith({ strokeAlign: 'inside' });
    expect(hitTest(doc, 115, 150, 1)?.id).toBe(id);
    expect(hitTest(doc, 118, 150, 1)?.id).toBe(id);
    expect(hitTest(doc, 92, 150, 1)).toBe(null);
    expect(hitTest(doc, 125, 150, 1)).toBe(null);
  });

  it('the path itself stays clickable within the tolerance', () => {
    const { doc, id } = docWith({ strokeAlign: 'outside', strokeWidth: 0.5 });
    expect(hitTest(doc, 101.5, 150, 2)?.id).toBe(id);
  });
});
