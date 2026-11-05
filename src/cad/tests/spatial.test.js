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
