import { describe, it, expect } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle, ellipse, star } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';
import {
  addArtboard,
  moveArtboard,
  resizeArtboard,
  duplicateArtboard,
  deleteArtboard,
  reorderArtboard,
  rearrangeArtboards,
  fitArtboardToArtwork,
  fitArtboardToIds,
  artworkOnArtboard,
  convertToArtboards,
  resizeRect,
  presetFor,
} from '../src/features/artboards/artboard-ops.js';
import { matchAnchors, lerpAnchors, lerpPaint, lerpColor, blendStepCount, blendSteps, interpolateNode, virtualDoc } from '../src/features/artboards/blend-math.js';
import { makeBlend, releaseBlend, expandBlend } from '../src/features/artboards/blend.js';
import { wandMatches, magicWandSelect, colorsMatch, DEFAULT_WAND } from '../src/features/artboards/magic-wand.js';
import { projectiveMap, bilinearMap, rectQuad, perspectiveQuad, distortAnchors } from '../src/features/artboards/distort.js';
import { reshapeWeights, reshapeAnchors, measureValues } from '../src/features/artboards/measure-reshape.js';
import { align, distribute } from '../src/ops/object-ops.js';

function setup() {
  const doc = VDocument.create({ width: 100, height: 100 });
  const layer = doc.layers()[0];
  const add = (anchors, style = {}) => {
    const p = createPath(anchors, true, style);
    doc.transact('Add', () => doc.insert(p, layer.id));
    return p.id;
  };
  return { doc, layer, add };
}

const solid = (color) => ({ type: 'solid', color });

describe('artboard operations', () => {
  it('creates, moves with artwork, resizes and deletes', () => {
    const { doc, add } = setup();
    const r = add(rectangle(10, 10, 20, 20));
    let i;
    doc.transact('New', () => {
      i = addArtboard(doc, { x: 200, y: 0, w: 50, h: 60 });
    });
    expect(i).toBe(1);
    expect(doc.artboards[1]).toMatchObject({ name: 'Artboard 2', x: 200, w: 50, h: 60 });
    expect(artworkOnArtboard(doc, 0)).toEqual([r]);
    expect(artworkOnArtboard(doc, 1)).toEqual([]);
    doc.transact('Move', () => moveArtboard(doc, 0, 5, 7, { withArtwork: true }));
    expect(doc.artboards[0]).toMatchObject({ x: 5, y: 7 });
    expect(nodeBounds(doc, doc.get(r))).toMatchObject({ x: 15, y: 17 });
    doc.transact('Move', () => moveArtboard(doc, 0, 5, 0));
    expect(nodeBounds(doc, doc.get(r)).x).toBe(15);
    doc.transact('Resize', () => resizeArtboard(doc, 1, { x: 190, y: 0, w: 80, h: 40 }));
    expect(doc.artboards[1]).toMatchObject({ x: 190, w: 80, h: 40 });
    doc.transact('Delete', () => deleteArtboard(doc, 1));
    expect(doc.artboards).toHaveLength(1);
    let refused;
    doc.transact('Delete', () => {
      refused = deleteArtboard(doc, 0);
    });
    expect(refused).toBe(false);
    expect(doc.artboards).toHaveLength(1);
    doc.undo();
    expect(doc.artboards).toHaveLength(2);
  });

  it('duplicates an artboard with its artwork', () => {
    const { doc, add } = setup();
    add(rectangle(10, 10, 20, 20));
    let res;
    doc.transact('Dup', () => {
      res = duplicateArtboard(doc, 0, 150, 0, { withArtwork: true });
    });
    expect(res.index).toBe(1);
    expect(doc.artboards[1]).toMatchObject({ x: 150, y: 0, w: 100, h: 100, name: 'Artboard 1 copy' });
    expect(res.ids).toHaveLength(1);
    expect(nodeBounds(doc, doc.get(res.ids[0]))).toMatchObject({ x: 160, y: 10, w: 20 });
    expect(doc.layers()[0].children).toHaveLength(2);
  });

  it('reorders artboards', () => {
    const doc = VDocument.create({ artboards: 3 });
    const ids = doc.artboards.map((a) => a.id);
    doc.transact('Reorder', () => reorderArtboard(doc, 0, 2));
    expect(doc.artboards.map((a) => a.id)).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('rearranges artboards in a grid, row or column, moving artwork', () => {
    const doc = VDocument.create({ width: 100, height: 50, artboards: 4 });
    const layer = doc.layers()[0];
    const p = createPath(rectangle(doc.artboards[3].x + 10, doc.artboards[3].y + 10, 10, 10), true);
    doc.transact('Add', () => doc.insert(p, layer.id));
    doc.transact('Grid', () => rearrangeArtboards(doc, { layout: 'gridRow', columns: 3, spacing: 10, moveArtwork: true }));
    expect(doc.artboards.map((a) => [a.x, a.y])).toEqual([[0, 0], [110, 0], [220, 0], [0, 60]]);
    expect(nodeBounds(doc, doc.get(p.id))).toMatchObject({ x: 10, y: 70 });
    doc.transact('Row', () => rearrangeArtboards(doc, { layout: 'row', spacing: 0 }));
    expect(doc.artboards.map((a) => a.x)).toEqual([0, 100, 200, 300]);
    doc.transact('Col', () => rearrangeArtboards(doc, { layout: 'column', spacing: 5, moveArtwork: false }));
    expect(doc.artboards.map((a) => a.y)).toEqual([0, 55, 110, 165]);
    doc.transact('GridCol', () => rearrangeArtboards(doc, { layout: 'gridColumn', columns: 2, spacing: 0 }));
    expect(doc.artboards.map((a) => [a.x, a.y])).toEqual([[0, 0], [0, 50], [100, 0], [100, 50]]);
  });

  it('fits to artwork bounds and to the selection', () => {
    const { doc, add } = setup();
    const a = add(rectangle(10, 20, 30, 40), { stroke: null });
    const b = add(rectangle(50, 50, 10, 10), { stroke: null });
    doc.transact('Fit', () => fitArtboardToArtwork(doc, 0));
    expect(doc.artboards[0]).toMatchObject({ x: 10, y: 20, w: 50, h: 40 });
    doc.transact('Fit', () => fitArtboardToIds(doc, 0, [b]));
    expect(doc.artboards[0]).toMatchObject({ x: 50, y: 50, w: 10, h: 10 });
    expect(a).toBeTruthy();
  });

  it('converts rectangles to artboards', () => {
    const { doc, add } = setup();
    const r = add(rectangle(300, 0, 40, 30));
    const e = add(ellipse(0, 0, 10, 10));
    let made;
    doc.transact('Convert', () => {
      made = convertToArtboards(doc, [r, e]);
    });
    expect(made).toEqual([1]);
    expect(doc.artboards[1]).toMatchObject({ x: 300, y: 0, w: 40, h: 30 });
    expect(doc.has(r)).toBe(false);
    expect(doc.has(e)).toBe(true);
  });

  it('resizes rects from handles with shift and alt', () => {
    const r = { x: 0, y: 0, w: 100, h: 50 };
    expect(resizeRect(r, 'se', 150, 80)).toEqual({ x: 0, y: 0, w: 150, h: 80 });
    // Shift on a side handle keeps the proportions about the other axis' center.
    expect(resizeRect(r, 'e', 200, 0, { shift: true })).toEqual({ x: 0, y: -25, w: 200, h: 100 });
    expect(resizeRect(r, 'w', -10, 0, { alt: true })).toEqual({ x: -10, y: 0, w: 120, h: 50 });
    expect(resizeRect(r, 'nw', 50, 0)).toEqual({ x: 50, y: 0, w: 50, h: 50 });
    expect(presetFor(792, 612)).toBe('letter');
    expect(presetFor(123, 456)).toBe('custom');
  });
});

describe('blend interpolation', () => {
  it('matches anchor counts and interpolates halfway', () => {
    const sq = rectangle(0, 0, 10, 10);
    const st = star(100, 5, 10, 5, 5);
    const [A, B] = matchAnchors(sq, true, st, true);
    expect(A).toHaveLength(10);
    expect(B).toHaveLength(10);
    const mid = lerpAnchors(A, B, 0.5);
    expect(mid[0].x).toBeCloseTo((A[0].x + B[0].x) / 2);
    // Subdividing keeps the square's shape.
    for (const p of A) expect(p.x >= -1e-9 && p.x <= 10 + 1e-9 && p.y >= -1e-9 && p.y <= 10 + 1e-9).toBe(true);
  });

  it('interpolates colors, paints and step counts', () => {
    expect(lerpColor('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(lerpPaint(solid('#ff0000'), solid('#0000ff'), 0.5)).toEqual(solid('#800080'));
    expect(lerpPaint(null, solid('#ff0000'), 0.25)).toMatchObject({ color: '#ff0000', opacity: 0.25 });
    const { doc, add } = setup();
    const a = doc.get(add(rectangle(0, 0, 10, 10), { fill: solid('#000000'), stroke: null }));
    const b = doc.get(add(rectangle(100, 0, 10, 10), { fill: solid('#0a0000'), stroke: null }));
    expect(blendStepCount(doc, { spacing: 'steps', steps: 4 }, a, b)).toBe(4);
    expect(blendStepCount(doc, { spacing: 'distance', distance: 20 }, a, b)).toBe(4);
    expect(blendStepCount(doc, { spacing: 'smooth' }, a, b)).toBe(10);
  });

  it('blends gradients smoothly into solid colors and gradients with other stops', () => {
    const lin = (stops) => ({ type: 'linear', angle: 0, stops: stops.map(([offset, color]) => ({ offset, color, opacity: 1 })) });
    const two = lin([[0, '#ff0000'], [1, '#0000ff']]);
    const three = lin([[0, '#000000'], [0.5, '#ffffff'], [1, '#000000']]);
    // Different stop counts: both are read at the stops of either, so the middle step is a mix.
    const mid = lerpPaint(two, three, 0.5);
    expect(mid.stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
    expect(mid.stops.map((s) => s.color)).toEqual(['#800000', '#c080c0', '#000080']);
    expect(lerpPaint(two, three, 0.01).stops[0].color).toBe('#fc0000');
    // A solid color (or none) turns into the gradient gradually instead of switching halfway.
    const fromSolid = lerpPaint(solid('#00ff00'), two, 0.5);
    expect(fromSolid.type).toBe('linear');
    expect(fromSolid.stops.map((s) => s.color)).toEqual(['#808000', '#008080']);
    expect(lerpPaint(two, solid('#00ff00'), 0.25).stops[0].color).toBe('#bf4000');
    const fromNone = lerpPaint(null, two, 0.25);
    expect(fromNone.stops.map((s) => [s.color, s.opacity])).toEqual([['#ff0000', 0.25], ['#0000ff', 0.25]]);
  });

  it('makes, renders, expands and releases a blend', () => {
    const { doc, add, layer } = setup();
    const a = add(rectangle(0, 0, 10, 10), { fill: solid('#ff0000') });
    const b = add(rectangle(90, 0, 20, 20), { fill: solid('#0000ff') });
    let g;
    doc.transact('Blend', () => {
      g = makeBlend(doc, [a, b], { spacing: 'steps', steps: 3 });
    });
    const group = doc.get(g);
    expect(group.children).toEqual([a, b]);
    const { runs } = blendSteps(doc, group);
    expect(runs).toHaveLength(1);
    expect(runs[0].nodes).toHaveLength(3);
    const mid = runs[0].nodes[1];
    expect(mid.fill.color).toBe('#800080');
    expect(mid.anchors[0]).toMatchObject({ x: 45, y: 0 });
    // Cached until a key object changes.
    expect(blendSteps(doc, doc.get(g))).toBe(blendSteps(doc, doc.get(g)));
    doc.transact('Edit', () => doc.update(b, { fill: solid('#00ff00') }));
    expect(blendSteps(doc, doc.get(g)).runs[0].nodes[1].fill.color).toBe('#808000');
    doc.transact('Expand', () => expandBlend(doc, g));
    expect(doc.get(g).blend).toBeUndefined();
    expect(doc.get(g).children).toHaveLength(5);
    expect(doc.get(doc.get(g).children[0]).id).toBe(a);
    expect(doc.get(doc.get(g).children[4]).id).toBe(b);
    doc.undo();
    let released;
    doc.transact('Release', () => {
      released = releaseBlend(doc, g);
    });
    expect(released).toEqual([a, b]);
    expect(doc.has(g)).toBe(false);
    expect(doc.get(layer.id).children).toEqual([a, b]);
  });

  it('blends groups child by child and other objects by box', () => {
    const { doc, add, layer } = setup();
    const g1 = createGroup([]);
    const g2 = createGroup([]);
    doc.transact('G', () => {
      doc.insert(g1, layer.id);
      doc.insert(g2, layer.id);
      doc.insert(createPath(rectangle(0, 0, 10, 10), true), g1.id);
      doc.insert(createPath(rectangle(100, 0, 10, 10), true), g2.id);
    });
    const extra = new Map();
    const v = interpolateNode(doc, doc.get(g1.id), doc.get(g2.id), 0.5, extra);
    expect(v.type).toBe('group');
    expect(extra.get(v.children[0]).anchors[0]).toMatchObject({ x: 50, y: 0 });
    const p = doc.get(add(rectangle(0, 0, 10, 10)));
    const extra2 = new Map();
    const v2 = interpolateNode(doc, p, doc.get(g2.id), 0.5, extra2);
    expect(nodeBounds(virtualDoc(doc, extra2), v2)).toMatchObject({ x: 50, y: 0, w: 10, h: 10 });
  });
});

describe('magic wand', () => {
  it('matches fill color within tolerance and other attributes', () => {
    const ref = { fill: solid('#ff0000'), stroke: solid('#000000'), strokeWidth: 1, opacity: 1, blendMode: 'normal' };
    const opts = structuredClone(DEFAULT_WAND);
    expect(wandMatches(ref, { ...ref, fill: solid('#f01010') }, opts)).toBe(true);
    expect(wandMatches(ref, { ...ref, fill: solid('#c00000') }, opts)).toBe(false);
    expect(colorsMatch(null, null, 0)).toBe(true);
    expect(colorsMatch(null, solid('#000000'), 255)).toBe(false);
    opts.strokeWeight = { on: true, tol: 0.5 };
    expect(wandMatches(ref, { ...ref, strokeWidth: 3 }, opts)).toBe(false);
    opts.strokeWeight.on = false;
    opts.blendMode = { on: true };
    expect(wandMatches(ref, { ...ref, blendMode: 'multiply' }, opts)).toBe(false);
  });

  it('selects similar objects in the document, skipping locked ones', () => {
    const { doc, add } = setup();
    const a = add(rectangle(0, 0, 10, 10), { fill: solid('#ff0000') });
    const b = add(rectangle(20, 0, 10, 10), { fill: solid('#fa0505') });
    const c = add(rectangle(40, 0, 10, 10), { fill: solid('#00ff00') });
    const d = add(rectangle(60, 0, 10, 10), { fill: solid('#ff0000') });
    doc.transact('Lock', () => doc.update(d, { locked: true }));
    expect(magicWandSelect(doc, doc.get(a), structuredClone(DEFAULT_WAND)).sort()).toEqual([a, b].sort());
    expect(c).toBeTruthy();
  });
});

describe('free distort math', () => {
  const r = { x: 0, y: 0, w: 100, h: 100 };
  it('maps rect corners onto the quad (projective and bilinear)', () => {
    const q = [
      { x: 10, y: 0 },
      { x: 90, y: 10 },
      { x: 120, y: 100 },
      { x: -20, y: 110 },
    ];
    for (const map of [projectiveMap(r, q), bilinearMap(r, q)]) {
      const pts = rectQuad(r).map((p) => map(p.x, p.y));
      pts.forEach((p, i) => {
        expect(p.x).toBeCloseTo(q[i].x, 6);
        expect(p.y).toBeCloseTo(q[i].y, 6);
      });
    }
  });

  it('is the identity for an undistorted quad and keeps straight lines straight in perspective', () => {
    const id = projectiveMap(r, rectQuad(r));
    expect(id(25, 75)).toMatchObject({ x: 25, y: 75 });
    const q = perspectiveQuad(rectQuad(r), 1, 20, 3);
    expect(q[1].x).toBe(120);
    expect(q[0].x).toBe(-20);
    const map = projectiveMap(r, q);
    // Points on the diagonal of the rect stay collinear after the projective map.
    const a = map(0, 0);
    const b = map(50, 50);
    const c = map(100, 100);
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    expect(Math.abs(cross)).toBeLessThan(1e-6);
    const anchors = distortAnchors([{ x: 0, y: 0, ix: 0, iy: 0, ox: 10, oy: 0 }], map);
    expect(anchors[0].x).toBeCloseTo(-20);
  });
});

describe('reshape and measure', () => {
  it('weights anchors by distance with a falloff', () => {
    const anchors = [0, 10, 20, 100].map((x) => ({ x, y: 0, ix: x, iy: 0, ox: x, oy: 0 }));
    const w = reshapeWeights(anchors, new Set([0]), 40);
    expect(w[0]).toBe(1);
    expect(w[1]).toBeGreaterThan(w[2]);
    expect(w[3]).toBe(0);
    const moved = reshapeAnchors(anchors, w, 0, 10);
    expect(moved[0].y).toBe(10);
    expect(moved[3]).toBe(anchors[3]);
  });

  it('measures distance and angle', () => {
    const v = measureValues({ x1: 0, y1: 0, x2: 30, y2: -40 });
    expect(v.d).toBe(50);
    expect(v.angle).toBeCloseTo(53.13, 2);
  });
});

describe('align to key object', () => {
  it('aligns and distributes against the key object, which stays put', () => {
    const { doc, add } = setup();
    const a = add(rectangle(0, 0, 10, 10), { stroke: null });
    const b = add(rectangle(50, 30, 20, 20), { stroke: null });
    const c = add(rectangle(100, 60, 10, 10), { stroke: null });
    const editor = { doc, topSelection: () => [a, b, c], artboard: () => doc.artboards[0] };
    align(editor, 'left', { to: 'key', key: b });
    expect(nodeBounds(doc, doc.get(a)).x).toBe(50);
    expect(nodeBounds(doc, doc.get(b)).x).toBe(50);
    expect(nodeBounds(doc, doc.get(c)).x).toBe(50);
    align(editor, 'bottom', { to: 'key', key: b });
    expect(nodeBounds(doc, doc.get(a)).y).toBe(40);
    distribute(editor, 'hspace', { spacing: 5, key: b });
    // Sorted by x (all equal); the key keeps its place.
    expect(nodeBounds(doc, doc.get(b)).x).toBe(50);
  });
});

describe('Artboards panel drag reorder', () => {
  it('drops an artboard into the gap under the pointer', async () => {
    const { bootApp } = await import('./helpers.js');
    const { ArtboardsPanel, artboardDropIndex } = await import('../src/features/artboards/artboards-panel.js');
    expect(artboardDropIndex(0, 3)).toBe(2);
    expect(artboardDropIndex(3, 1)).toBe(1);
    const app = bootApp();
    const ed = app.newDocument({ name: 'Boards', width: 100, height: 100 });
    ed.doc.transact('Boards', () =>
      ed.doc.updateRoot({ artboards: ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ id: `ab${i}`, name, x: i * 120, y: 0, w: 100, h: 100 })) }),
    );
    const panel = new ArtboardsPanel(app);
    document.body.append(panel.el);
    panel.ensureBuilt();
    panel.update();
    const rows = [...panel.el.querySelectorAll('.ab-row')];
    expect(rows).toHaveLength(5);
    rows.forEach((r, k) => (r.getBoundingClientRect = () => ({ top: k * 30, bottom: k * 30 + 30, height: 30, left: 0, right: 200, width: 200 })));
    const ev = (type, y, target = window) => {
      const e = new MouseEvent(type, { bubbles: true, clientX: 10, clientY: y, button: 0 });
      target.dispatchEvent(e);
    };
    ev('pointerdown', 15, rows[0]);
    ev('pointermove', 60);
    ev('pointermove', 95);
    ev('pointerup', 95);
    expect(ed.doc.artboards.map((a) => a.name)).toEqual(['B', 'C', 'A', 'D', 'E']);
  });
});
