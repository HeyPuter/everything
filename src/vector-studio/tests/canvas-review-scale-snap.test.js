import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';
import { boxHandles } from '../src/render/overlay.js';

let clock = 0;
const ptr = (x, y) => ({
  pointerId: 1,
  pointerType: 'mouse',
  button: 0,
  clientX: x,
  clientY: y,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  timeStamp: (clock += 1000),
});

describe('Scaling with the bounding box snaps the dragged handle', () => {
  let app;
  let ed;
  let doc;
  let id;
  beforeAll(() => {
    app = bootApp();
    app.newDocument();
  });
  beforeEach(() => {
    ed = app.editor;
    doc = ed.doc;
    ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    for (const k of ['snapToGrid', 'snapToPixel']) ed.setViewOption(k, false);
    ed.setViewOption('alignmentGuides', true);
    ed.setViewOption('snapToPoint', true);
    const layer = ed.targetLayer().id;
    const kids = [...doc.get(layer).children];
    doc.transact('Reset', () => kids.forEach((k) => doc.remove(k)));
    const p = createPath(rectangle(100, 100, 100, 50), true, {
      fill: { type: 'solid', color: '#f00' },
    });
    const other = createPath(rectangle(260, 400, 40, 40), true, {
      fill: { type: 'solid', color: '#00f' },
    });
    doc.transact('Add', () => {
      doc.insert(p, layer);
      doc.insert(other, layer);
    });
    id = p.id;
    ed.select([id]);
    app.setTool('selection');
  });

  const dragEast = (toX, toY = 125) => {
    const h = boxHandles(ed, ed.selectionFrame());
    app.input.down(ptr(h.e.x, h.e.y));
    app.input.move(ptr(toX - 20, toY));
    app.input.move(ptr(toX, toY));
    const guides = ed.alignmentGuides;
    app.input.up(ptr(toX, toY));
    return guides;
  };

  it('to the edges of other objects (alignment guides)', () => {
    const guides = dragEast(257);
    const b = nodeBounds(doc, doc.get(id));
    expect(b.x).toBeCloseTo(100, 6);
    expect(b.x + b.w).toBeCloseTo(260, 6);
    expect(b.h).toBeCloseTo(50, 6);
    // A vertical guide at the edge it snapped to.
    expect(guides.lines.some((l) => l.x1 === 260 && l.x2 === 260)).toBe(true);
    expect(guides.lines.every((l) => l.x1 === l.x2)).toBe(true);
  });

  it('to the grid', () => {
    ed.setViewOption('snapToGrid', true);
    dragEast(240.4);
    const b = nodeBounds(doc, doc.get(id));
    // The default grid has a line every 9 pt.
    expect(b.x + b.w).toBeCloseTo(243, 6);
  });

  it('to whole pixels', () => {
    ed.setViewOption('alignmentGuides', false);
    ed.setViewOption('snapToPoint', false);
    ed.setViewOption('snapToPixel', true);
    dragEast(233.6);
    const b = nodeBounds(doc, doc.get(id));
    expect(b.x + b.w).toBe(234);
  });
});
