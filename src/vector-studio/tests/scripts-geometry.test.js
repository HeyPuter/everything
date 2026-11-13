// Script geometry: bounds, filled area and label points in document coordinates.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { createPath, createCompound, createGroup } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import {
  areasOf,
  labelPointsOf,
  boundsOf,
  poleOfInaccessibility,
  ringsArea,
} from '../src/features/scripts/geometry.js';

let app;
beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
  app = await bootAppWithFeatures();
});

const solid = (color) => ({ type: 'solid', color });

function setup() {
  const ed = app.newDocument();
  const doc = ed.doc;
  const layer = ed.targetLayer().id;
  const add = (node, descendants = []) => {
    doc.transact('add', () => doc.insert(node, layer, Infinity, descendants));
    return doc.get(node.id);
  };
  const compound = (rects, fillRule = 'nonzero') => {
    const c = createCompound([], { fill: solid('#ff0000') }, { fillRule });
    const kids = rects.map((r) => ({ ...createPath(r, true, {}), parent: c.id }));
    c.children = kids.map((k) => k.id);
    return add(c, kids);
  };
  return { ed, doc, add, compound };
}

describe('script geometry', () => {
  it('measures a rectangle: bounds, area and the center as label point', async () => {
    const { doc, add } = setup();
    const r = add(createPath(rectangle(10, 20, 40, 10), true, { fill: solid('#00f') }));
    expect(boundsOf(doc, r)).toEqual({ x: 10, y: 20, w: 40, h: 10 });
    const [area] = await areasOf(doc, [r]);
    expect(area).toBeCloseTo(400, 3);
    const [lp] = await labelPointsOf(doc, [r]);
    expect(lp.radius).toBeCloseTo(5, 1);
    expect(lp.y).toBeCloseTo(25, 1);
    expect(lp.x).toBeGreaterThan(14);
    expect(lp.x).toBeLessThan(46);
  });

  it('subtracts the holes of a compound path, whichever way its subpaths wind', async () => {
    const { doc, compound } = setup();
    // Outer 100x100 with a 50x50 hole; the hole is drawn the same direction (even-odd makes it a hole).
    const c = compound([rectangle(0, 0, 100, 100), rectangle(25, 25, 50, 50)], 'evenodd');
    const [area] = await areasOf(doc, [c]);
    expect(area).toBeCloseTo(10000 - 2500, 1);
    // The best label spot is in the 25-wide ring, not in the hole at the center.
    const [lp] = await labelPointsOf(doc, [c]);
    // Its corners hold the largest circle: r = sqrt2 (25 - r).
    expect(lp.radius).toBeCloseTo((25 * Math.SQRT2) / (1 + Math.SQRT2), 0);
    const inHole = lp.x > 25 && lp.x < 75 && lp.y > 25 && lp.y < 75;
    expect(inHole).toBe(false);
  });

  it('counts overlapping parts of a nonzero compound once', async () => {
    const { doc, compound } = setup();
    const c = compound([rectangle(0, 0, 20, 10), rectangle(10, 0, 20, 10)]);
    const [area] = await areasOf(doc, [c]);
    expect(area).toBeCloseTo(300, 1);
  });

  it('measures a group as the area its paths cover together', async () => {
    const { doc, add } = setup();
    const a = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#f00') });
    const b = createPath(rectangle(5, 0, 10, 10), true, { fill: solid('#0f0') });
    const g = createGroup([a.id, b.id]);
    const grp = add(g, [
      { ...a, parent: g.id },
      { ...b, parent: g.id },
    ]);
    const [area] = await areasOf(doc, [grp]);
    expect(area).toBeCloseTo(150, 1);
    expect(boundsOf(doc, grp)).toEqual({ x: 0, y: 0, w: 15, h: 10 });
  });

  it('finds the inscribed circle of a circle and an L shape', async () => {
    const { doc, add } = setup();
    const circle = add(createPath(ellipse(0, 0, 40, 40), true, { fill: solid('#f00') }));
    const L = add(
      createPath(
        [
          [0, 0],
          [10, 0],
          [10, 40],
          [40, 40],
          [40, 50],
          [0, 50],
        ].map(([x, y]) => ({ x, y, ix: x, iy: y, ox: x, oy: y })),
        true,
        { fill: solid('#0f0') },
      ),
    );
    const [c, l] = await labelPointsOf(doc, [circle, L]);
    expect(c.radius).toBeCloseTo(20, 0);
    expect(Math.hypot(c.x - 20, c.y - 20)).toBeLessThan(0.5);
    // The widest spot of the L is in its corner square, against the inside corner.
    expect(l.radius).toBeCloseTo((10 * Math.SQRT2) / (1 + Math.SQRT2), 0);
    expect(l.x).toBeLessThan(12);
    expect(l.y).toBeGreaterThan(38);
    const [ca, la] = await areasOf(doc, [circle, L]);
    expect(ca).toBeCloseTo(Math.PI * 400, -1);
    expect(la).toBeCloseTo(10 * 40 + 40 * 10, 1);
  });

  it('gives no area for text and empty input', async () => {
    const { doc } = setup();
    expect(await areasOf(doc, [null])).toEqual([null]);
    expect(ringsArea([])).toBe(0);
    expect(poleOfInaccessibility([])).toBeNull();
  });
});
