import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { SpatialIndex } from '../src/core/spatial.js';

const P = { layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1 };

function setup() {
  const d = new Drawing();
  const idx = new SpatialIndex(d);
  d.on((c) => idx.applyChange(c));
  return { d, idx };
}

describe('SpatialIndex', () => {
  it('bounds wide polylines by the band they draw', () => {
    const { d, idx } = setup();
    const [w, arc] = d.transaction('Add', () => [
      d.add({ ...P, type: 'polyline', pts: [0, 0, 0, 100, 0, 0], closed: false, width: 20 }),
      d.add({ ...P, type: 'polyline', pts: [200, 0, 1, 220, 0, 0], closed: false, width: 2 }),
    ]);
    const b = idx.bounds(w.id);
    [0, -10, 100, 10].forEach((v, i) => expect(b[i]).toBeCloseTo(v, 9));
    // Picking on the band finds it; a window around the centre line only does not enclose it.
    expect(idx.search(49, 7, 51, 9)).toContain(w.id);
    expect(idx.searchInside(-1, -5, 101, 5)).not.toContain(w.id);
    expect(idx.searchInside(-1, -11, 101, 11)).toContain(w.id);
    // A half-circle arc segment: the band reaches 1 beyond the arc (radius 10),
    // within the tessellation tolerance.
    const a = idx.bounds(arc.id);
    expect(a[1]).toBeLessThan(-10.99);
    expect(a[1]).toBeGreaterThanOrEqual(-11 - 1e-9);
  });

  it('indexes lines, circles and text', () => {
    const { d, idx } = setup();
    const [l, c, t] = d.transaction('Add', () => [
      d.add({ ...P, type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }),
      d.add({ ...P, type: 'circle', cx: 50, cy: 50, r: 5 }),
      d.add({ ...P, type: 'text', x: 100, y: 0, h: 2, rot: 0, value: 'Hi', style: 'Standard', halign: 'left', valign: 'baseline', widthFactor: 1, oblique: 0 }),
    ]);
    expect(idx.search(-1, -1, 11, 1)).toContain(l.id);
    expect(idx.search(44, 44, 46, 46)).toContain(c.id);
    const tb = idx.bounds(t.id);
    // Bounds follow the ink, so the glyph side bearing shows on the left.
    expect(tb[0]).toBeGreaterThanOrEqual(100);
    expect(tb[0]).toBeLessThan(100.5);
    expect(tb[2]).toBeGreaterThan(101);
    expect(tb[3]).toBeGreaterThan(1.5);
  });

  it('distinguishes window (inside) from overlap searches', () => {
    const { d, idx } = setup();
    const l = d.transaction('Add', () => d.add({ ...P, type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }));
    expect(idx.searchInside(-1, -1, 5, 1)).not.toContain(l.id);
    expect(idx.searchInside(-1, -1, 11, 1)).toContain(l.id);
  });

  it('follows edits, undo and removal', () => {
    const { d, idx } = setup();
    const l = d.transaction('Add', () => d.add({ ...P, type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }));
    d.transaction('Move', () => d.update(l.id, { x1: 100, x2: 110 }));
    expect(idx.search(-1, -1, 11, 1, false)).not.toContain(l.id);
    expect(idx.search(99, -1, 111, 1, false)).toContain(l.id);
    d.undo();
    expect(idx.search(-1, -1, 11, 1, false)).toContain(l.id);
    d.transaction('Erase', () => d.remove(l.id));
    expect(idx.search(-1000, -1000, 1000, 1000)).toHaveLength(0);
  });

  it('keeps construction lines out of the tree but returns them from searches', () => {
    const { d, idx } = setup();
    const x = d.transaction('Add', () => d.add({ ...P, type: 'xline', x: 0, y: 0, dx: 1, dy: 0 }));
    expect(idx.search(500, 500, 501, 501)).toContain(x.id);
    expect(idx.search(500, 500, 501, 501, false)).not.toContain(x.id);
    expect(idx.extents()).toBeNull();
  });

  it('computes extents with an optional filter', () => {
    const { d, idx } = setup();
    d.transaction('Add', () => {
      d.add({ ...P, type: 'line', x1: -5, y1: 0, x2: 5, y2: 0 });
      d.add({ ...P, type: 'circle', cx: 100, cy: 100, r: 10, layer: 'Hidden' });
    });
    expect(idx.extents()).toEqual([-5, 0, 110, 110]);
    expect(idx.extents((id) => d.get(id).layer === '0')).toEqual([-5, 0, 5, 0]);
  });

  it('measures block references through their definition', () => {
    const { d, idx } = setup();
    const ins = d.transaction('Add', () => {
      d.setBlock('Box', { name: 'Box', bx: 0, by: 0, entities: [{ ...P, id: 1, type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] });
      return d.add({ ...P, type: 'insert', name: 'Box', x: 100, y: 50, sx: 2, sy: 2, rot: 0 });
    });
    const b = idx.bounds(ins.id);
    expect(b[0]).toBeCloseTo(100);
    expect(b[2]).toBeCloseTo(120);
    expect(b[1]).toBeCloseTo(50);
  });

  it('rebuilds after very large edits', () => {
    const { d, idx } = setup();
    d.transaction('Add', () => {
      for (let i = 0; i < 6000; i++) d.add({ ...P, type: 'line', x1: i, y1: 0, x2: i + 1, y2: 0 });
    });
    expect(idx.items.size).toBe(6000);
    expect(idx.search(10.2, -1, 10.4, 1, false)).toHaveLength(1);
  });

  it('updates dimension extents when the unit format changes', () => {
    const { d, idx } = setup();
    const geom = { x1: 0, y1: 0, x2: 3, y2: 0, lx: 1.5, ly: 10, style: 'Standard' };
    const dim = d.transaction('Add', () =>
      d.add({ ...P, type: 'dimension', dimType: 'aligned', ...geom }),
    );
    const before = idx.bounds(dim.id);
    d.transaction('Units', () => d.setHeader({ linearFormat: 'scientific', linearPrecision: 8 }));
    expect(idx.bounds(dim.id)[2]).toBeGreaterThan(before[2]);
    expect(idx.bounds(dim.id)).toEqual(new SpatialIndex(d).bounds(dim.id));
  });
});

describe('SpatialIndex block changes', () => {
  it('moves references to a block that nests a redefined block', () => {
    const { d, idx } = setup();
    const line = (x2) => ({ ...P, type: 'line', x1: 0, y1: 0, x2, y2: 0 });
    const insert = (name) => ({ ...P, type: 'insert', name, x: 0, y: 0, sx: 1, sy: 1, rot: 0 });
    let y, other;
    d.transaction('Add', () => {
      d.setBlock('X', { name: 'X', bx: 0, by: 0, entities: [line(10)] });
      d.setBlock('Y', { name: 'Y', bx: 0, by: 0, entities: [insert('X')] });
      d.setBlock('Z', { name: 'Z', bx: 0, by: 0, entities: [line(5)] });
      y = d.add(insert('Y')).id;
      other = d.add(insert('Z')).id;
    });
    expect(idx.bounds(y)[2]).toBeCloseTo(10, 9);
    d.transaction('Redefine', () => d.setBlock('X', { name: 'X', bx: 0, by: 0, entities: [line(50)] }));
    expect(idx.bounds(y)[2]).toBeCloseTo(50, 9);
    expect(idx.bounds(other)[2]).toBeCloseTo(5, 9);
  });
});
