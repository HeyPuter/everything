import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { anchor } from '../src/model/bezier.js';
import { nodeBounds } from '../src/model/geometry.js';
import { liveArtwork } from '../src/model/live.js';
import { pathSampler } from '../src/model/path-sampler.js';
import { blendSteps, blendKeys, blendSpine, virtualDoc } from '../src/features/artboards/blend-math.js';
import { makeBlend, releaseBlend, expandBlend, replaceSpine, reverseSpine, reverseFrontToBack, spineOperands } from '../src/features/artboards/blend.js';

beforeAll(() => installCanvasStub());

const solid = (c) => ({ type: 'solid', color: c });

function setup() {
  const doc = VDocument.create({ width: 600, height: 600 });
  const layer = doc.layers()[0].id;
  const a = createPath(rectangle(0, 0, 20, 20), true, { fill: solid('#ff0000'), stroke: null });
  const b = createPath(rectangle(200, 0, 20, 20), true, { fill: solid('#0000ff'), stroke: null });
  // A quarter-circle-ish spine from (10, 200) up to (210, 10) via a corner.
  const spine = createPath([anchor(10, 200), anchor(10, 10), anchor(210, 10)], false, { fill: null, stroke: solid('#00ff00'), strokeWidth: 2 });
  let g;
  doc.transact('add', () => {
    doc.insert(a, layer);
    doc.insert(b, layer);
    doc.insert(spine, layer);
    g = makeBlend(doc, [a.id, b.id], { spacing: 'steps', steps: 3, orientation: 'page' });
  });
  return { doc, g, a: a.id, b: b.id, spine: spine.id, layer };
}

const stepCenters = (doc, g) => {
  const { runs, extra } = blendSteps(doc, doc.get(g));
  const v = virtualDoc(doc, extra);
  return runs[0].nodes.map((n) => {
    const bb = nodeBounds(v, n);
    return { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
  });
};

describe('path sampler', () => {
  it('measures and walks a path by length', () => {
    const s = pathSampler([anchor(0, 0), anchor(100, 0), anchor(100, 50)], false);
    expect(s.length).toBeCloseTo(150);
    const p = s.at(125);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(25);
    expect(p.angle).toBeCloseTo(Math.PI / 2);
    expect(s.nearest(40, 7).s).toBeCloseTo(40);
    const c = pathSampler([anchor(0, 0), anchor(10, 0), anchor(10, 10), anchor(0, 10)], true);
    expect(c.length).toBeCloseTo(40);
    expect(c.at(45).x).toBeCloseTo(5);
  });
});

describe('blend spine', () => {
  it('replaces the spine: keys move onto it and steps follow it', () => {
    const { doc, g, a, b, spine } = setup();
    expect(spineOperands({ doc, topSelection: () => [g, spine] })).toEqual({ blend: g, path: spine });
    doc.transact('spine', () => replaceSpine(doc, g, spine));
    const grp = doc.get(g);
    expect(blendSpine(doc, grp).id).toBe(spine);
    expect(doc.get(spine).fill).toBe(null);
    expect(doc.get(spine).stroke).toBe(null);
    expect(blendKeys(doc, grp).map((n) => n.id)).toEqual([a, b]);
    // Keys at the spine's ends.
    const ba = nodeBounds(doc, doc.get(a));
    expect(ba.x + 10).toBeCloseTo(10);
    expect(ba.y + 10).toBeCloseTo(200);
    const bb = nodeBounds(doc, doc.get(b));
    expect(bb.x + 10).toBeCloseTo(210);
    expect(bb.y + 10).toBeCloseTo(10);
    // The middle step sits half way along the spine: 5 past its corner.
    const cs = stepCenters(doc, g);
    expect(cs).toHaveLength(3);
    expect(cs[1].x).toBeCloseTo(15);
    expect(cs[1].y).toBeCloseTo(10);
    // The spine is part of the artwork (unpainted) so it outlines and clicks.
    expect(liveArtwork(doc, grp).items[0].id).toBe(spine);
    doc.undo();
    expect(doc.get(spine).parent).not.toBe(g);
    expect(nodeBounds(doc, doc.get(a)).x).toBeCloseTo(0);
  });

  it('aligns steps to the path when the orientation says so', () => {
    const { doc, g, spine } = setup();
    doc.transact('spine', () => replaceSpine(doc, g, spine));
    doc.transact('orient', () => doc.update(g, { blend: { ...doc.get(g).blend, orientation: 'path' } }));
    const { runs } = blendSteps(doc, doc.get(g));
    // Steps on the vertical leg turn with it; the first step's first edge is no longer horizontal.
    const n = runs[0].nodes[0];
    const [p, q] = n.anchors;
    expect(Math.abs(p.y - q.y)).toBeGreaterThan(1);
  });

  it('reverses the spine and the stacking order', () => {
    const { doc, g, a, b, spine } = setup();
    doc.transact('spine', () => replaceSpine(doc, g, spine));
    doc.transact('rev', () => reverseSpine(doc, g));
    expect(doc.get(spine).anchors[0].x).toBeCloseTo(210);
    expect(nodeBounds(doc, doc.get(a)).x + 10).toBeCloseTo(210);
    expect(nodeBounds(doc, doc.get(b)).y + 10).toBeCloseTo(200);
    doc.transact('order', () => reverseFrontToBack(doc, g));
    expect(doc.get(g).children).toEqual([spine, b, a]);
    // Without a spine the keys trade places.
    const s2 = setup();
    s2.doc.transact('rev', () => reverseSpine(s2.doc, s2.g));
    expect(nodeBounds(s2.doc, s2.doc.get(s2.a)).x).toBeCloseTo(200);
    expect(nodeBounds(s2.doc, s2.doc.get(s2.b)).x).toBeCloseTo(0);
  });

  it('reverses a closed spine: the keys trade places on the same loop', () => {
    const doc = VDocument.create({ width: 600, height: 600 });
    const layer = doc.layers()[0].id;
    const red = { fill: solid('#ff0000'), stroke: null };
    const keys = [0, 1, 2].map((i) => createPath(rectangle(i * 100, 300, 20, 20), true, red));
    // A closed square spine starting at its top-left corner (100, 100).
    const square = [anchor(100, 100), anchor(300, 100), anchor(300, 300), anchor(100, 300)];
    const line = { fill: null, stroke: solid('#000000'), strokeWidth: 1 };
    const spine = createPath(square, true, line);
    let g;
    doc.transact('add', () => {
      for (const k of keys) doc.insert(k, layer);
      doc.insert(spine, layer);
      g = makeBlend(doc, keys.map((k) => k.id), { spacing: 'steps', steps: 2 });
    });
    doc.transact('spine', () => replaceSpine(doc, g, spine.id));
    const center = (id) => {
      const b = nodeBounds(doc, doc.get(id));
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    };
    const before = keys.map((k) => center(k.id));
    // The first and last keys sit where the loop starts and ends, the middle one half way round.
    expect(before[0]).toEqual({ x: 100, y: 100 });
    expect(before[1].x).toBeCloseTo(300);
    expect(before[1].y).toBeCloseTo(300);
    doc.transact('rev', () => reverseSpine(doc, g));
    const after = keys.map((k) => center(k.id));
    for (let i = 0; i < 3; i++) {
      expect(after[i].x).toBeCloseTo(before[2 - i].x);
      expect(after[i].y).toBeCloseTo(before[2 - i].y);
    }
    // The loop keeps its start point and runs the other way round.
    const rev = doc.get(spine.id).anchors;
    expect(rev.map((p) => [p.x, p.y])).toEqual([[100, 100], [100, 300], [300, 300], [300, 100]]);
  });

  it('releases the spine with its paint and drops it on expand', () => {
    const { doc, g, spine, layer } = setup();
    doc.transact('spine', () => replaceSpine(doc, g, spine));
    let out;
    doc.transact('release', () => {
      out = releaseBlend(doc, g);
    });
    expect(out).toContain(spine);
    expect(doc.get(spine).parent).toBe(layer);
    expect(doc.get(spine).stroke.color).toBe('#00ff00');
    expect(doc.get(spine).blendSpine).toBeUndefined();
    doc.undo();
    doc.transact('expand', () => expandBlend(doc, g));
    expect(doc.get(spine)).toBeUndefined();
    expect(doc.get(g).children).toHaveLength(5);
  });
});
