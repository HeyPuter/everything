import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installCanvasStub } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import '../src/features/effects/registry.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup, createCompound } from '../src/model/nodes.js';
import { rectangle, ellipse, line } from '../src/model/shapes.js';
import { pathBounds, flattenPath, segmentCount, segmentPoints, isLine } from '../src/model/bezier.js';
import { effectiveSubpaths, subpathsBounds, paintParts } from '../src/model/geom-effects.js';
import { visualBounds, nodeBounds } from '../src/model/geometry.js';
import { liveArtwork } from '../src/model/live.js';
import { createEffect, normalizeEffect, parseEffects, serializeEffects, effectLabel } from '../src/features/paint/effects-model.js';
import { freeDistort, freeDistortMapping, puckerBloat, roughen, zigzag, tweak, twist, transformEffect, hash32, noise } from '../src/features/effects/geom/distort.js';
import { convertToShape, cropMarks, CROP_MARK_PAINT } from '../src/features/effects/geom/shapes.js';
import { scribble, SCRIBBLE_PRESETS } from '../src/features/effects/geom/scribble.js';
import { offsetPath, outlineStroke, pathfinderCombine, pathfinderOnShape } from '../src/features/effects/geom/engine.js';

beforeAll(async () => {
  installCanvasStub();
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
});

const B = { x: 0, y: 0, w: 100, h: 50 };
const rect = () => [{ anchors: rectangle(0, 0, 100, 50), closed: true }];
const red = { type: 'solid', color: '#ff0000' };
const blue = { type: 'solid', color: '#0000ff' };

function area(subs) {
  let s = 0;
  for (const sp of subs) {
    const pts = flattenPath(sp.anchors, true, 0.01);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      s += p.x * q.y - q.x * p.y;
    }
  }
  return Math.abs(s / 2);
}

function docWith(...nodes) {
  const doc = VDocument.create({ width: 400, height: 400 });
  const layer = doc.layers()[0].id;
  doc.transact('add', () => {
    for (const n of nodes) doc.insert(n.node || n, layer, Infinity, n.descendants || []);
  });
  return doc;
}

describe('randomness', () => {
  it('is deterministic per seed and position', () => {
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3));
    expect(hash32(1, 2, 3)).not.toBe(hash32(2, 2, 3));
    const vals = Array.from({ length: 2000 }, (_, i) => noise(7, i));
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...vals)).toBeLessThan(1);
    // Roughly uniform.
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    expect(Math.abs(mean)).toBeLessThan(0.08);
  });
});

describe('effect records', () => {
  it('normalizes, labels and round-trips vector effects', () => {
    const w = normalizeEffect({ type: 'warp', style: 'flag', bend: 3, distortH: -0.2, junk: 1 });
    expect(w).toEqual({ type: 'warp', style: 'flag', bend: 1, vertical: false, distortH: -0.2, distortV: 0 });
    expect(effectLabel(w)).toBe('Warp: Flag');
    expect(normalizeEffect({ type: 'warp', style: 'bogus' }).style).toBe('arc');
    expect(effectLabel(createEffect('pathfinder', { kind: 'minusFront' }))).toBe('Pathfinder: Subtract');
    expect(effectLabel(createEffect('puckerBloat', { amount: -0.5 }))).toBe('Pucker 50%');
    const r = createEffect('roughen');
    expect(r.seed).toBeGreaterThan(0);
    expect(createEffect('roughen').seed).not.toBe(r.seed);
    const t = normalizeEffect({ type: 'transform', origin: [0.3, 1], copies: 2.6 });
    expect(t.origin).toEqual([0.5, 1]);
    expect(t.copies).toBe(3);
    const fd = normalizeEffect({ type: 'freeDistort', corners: [{ x: 0 }] });
    expect(fd.corners).toHaveLength(4);
    const list = [w, r, createEffect('scribble'), createEffect('cropMarks')];
    expect(parseEffects(serializeEffects(list))).toEqual(list);
  });
});

describe('distort & transform', () => {
  it('Free Distort maps the box corners to the new corners', () => {
    const corners = [{ x: 0.1, y: 0 }, { x: 0.9, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const f = freeDistortMapping(corners, B);
    expect(f(0, 0)).toEqual({ x: 10, y: 0 });
    expect(f(100, 50)).toEqual({ x: 100, y: 50 });
    const [out] = freeDistort(rect(), { corners }, B);
    const b = pathBounds(out.anchors, true);
    expect(b.w).toBeCloseTo(100, 6);
    // The top edge got shorter: a trapezoid.
    const top = out.anchors.filter((a) => Math.abs(a.y) < 1e-6).map((a) => a.x);
    expect(Math.min(...top)).toBeCloseTo(10, 6);
    expect(Math.max(...top)).toBeCloseTo(90, 6);
    expect(freeDistort(rect(), { corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }, B)).toEqual(rect());
  });

  it('Pucker pulls edges in, Bloat pushes them out', () => {
    const a0 = area(rect());
    expect(area(puckerBloat(rect(), { amount: 0.5 }, B))).toBeGreaterThan(a0);
    expect(area(puckerBloat(rect(), { amount: -0.5 }, B))).toBeLessThan(a0);
    // Anchors stay where they were.
    const [p] = puckerBloat(rect(), { amount: -1 }, B);
    expect(p.anchors.map((a) => [a.x, a.y])).toEqual(rect()[0].anchors.map((a) => [a.x, a.y]));
    expect(puckerBloat(rect(), { amount: 0 }, B)).toEqual(rect());
  });

  it('Roughen adds points per inch, stays within size and never jitters', () => {
    const fx = { size: 0.1, relative: true, detail: 10, smooth: false, seed: 42 };
    const [a] = roughen(rect(), fx, B);
    const [b] = roughen(rect(), fx, B);
    expect(a).toEqual(b);
    // 300 pt perimeter at 10 per inch: about 41 inserted points + 4 anchors.
    expect(a.anchors.length).toBeGreaterThan(30);
    const size = 0.1 * 75;
    for (const p of a.anchors) {
      expect(p.x).toBeGreaterThanOrEqual(-size - 1e-9);
      expect(p.x).toBeLessThanOrEqual(100 + size + 1e-9);
    }
    // Corner points are straight segments; smooth ones curve.
    expect(isLine(segmentPoints(a.anchors, 0))).toBe(true);
    const [s] = roughen(rect(), { ...fx, smooth: true }, B);
    expect(isLine(segmentPoints(s.anchors, 0))).toBe(false);
    const [c] = roughen(rect(), { ...fx, seed: 43 }, B);
    expect(c).not.toEqual(a);
    // Absolute size, no detail: only the anchors move.
    const [d] = roughen(rect(), { size: 5, relative: false, detail: 0, smooth: false, seed: 1 }, B);
    expect(d.anchors).toHaveLength(4);
  });

  it('Zig Zag alternates ridges across every segment', () => {
    const [z] = zigzag([{ anchors: line(0, 0, 100, 0), closed: false }], { size: 10, relative: false, ridges: 4, smooth: false }, B);
    expect(z.anchors).toHaveLength(6);
    expect(z.anchors.map((a) => Math.round(a.y))).toEqual([10, -10, 10, -10, 10, -10]);
    expect(z.anchors.map((a) => Math.round(a.x))).toEqual([0, 20, 40, 60, 80, 100]);
    const [sm] = zigzag([{ anchors: line(0, 0, 100, 0), closed: false }], { size: 10, relative: false, ridges: 4, smooth: true }, B);
    expect(isLine(segmentPoints(sm.anchors, 1))).toBe(false);
  });

  it('Tweak moves only what it is told to, by at most the amounts', () => {
    const fx = { h: 0.1, v: 0.2, relative: true, anchors: true, inHandles: false, outHandles: false, seed: 9 };
    const [t] = tweak(rect(), fx, B);
    rect()[0].anchors.forEach((a, i) => {
      expect(Math.abs(t.anchors[i].x - a.x)).toBeLessThanOrEqual(10);
      expect(Math.abs(t.anchors[i].y - a.y)).toBeLessThanOrEqual(10);
      // Handles travel with the anchor (still retracted).
      expect(t.anchors[i].ox).toBe(t.anchors[i].x);
    });
    const [hOnly] = tweak(rect(), { ...fx, anchors: false, outHandles: true }, B);
    expect(hOnly.anchors.map((a) => [a.x, a.y])).toEqual(rect()[0].anchors.map((a) => [a.x, a.y]));
    expect(hOnly.anchors.some((a) => a.ox !== a.x)).toBe(true);
  });

  it('Twist turns the middle and keeps the far corners', () => {
    const [t] = twist([{ anchors: line(0, 25, 100, 25), closed: false }], { angle: 90 }, B);
    const mid = flattenPath(t.anchors, false, 0.01);
    // Ends are halfway out (turned less), so the line bends.
    const b = pathBounds(t.anchors, false);
    expect(b.h).toBeGreaterThan(5);
    expect(mid.length).toBeGreaterThan(2);
    expect(twist(rect(), { angle: 0 }, B)).toEqual(rect());
  });

  it('Transform scales, moves, rotates about the reference point and makes copies', () => {
    const [s] = transformEffect(rect(), { scaleH: 0.5, scaleV: 0.5, origin: [0, 0] }, B);
    expect(pathBounds(s.anchors, true)).toEqual({ x: 0, y: 0, w: 50, h: 25 });
    const [m] = transformEffect(rect(), { moveH: 10, moveV: -5, origin: [0.5, 0.5] }, B);
    expect(pathBounds(m.anchors, true)).toEqual({ x: 10, y: -5, w: 100, h: 50 });
    // Counterclockwise rotation by 90 about the center swaps the box.
    const [r] = transformEffect(rect(), { angle: 90 }, B);
    const rb = pathBounds(r.anchors, true);
    expect(rb.w).toBeCloseTo(50, 6);
    expect(rb.h).toBeCloseTo(100, 6);
    const copies = transformEffect(rect(), { moveH: 120, copies: 3 }, B);
    expect(copies).toHaveLength(4);
    expect(pathBounds(copies[3].anchors, true).x).toBeCloseTo(360, 6);
    // Reflections keep the winding so overlapping copies do not cancel out.
    const sign = (sp) => {
      const pts = flattenPath(sp.anchors, true, 0.1);
      let a = 0;
      for (let i = 0; i < pts.length; i++) a += pts[i].x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * pts[i].y;
      return Math.sign(a);
    };
    const [fl] = transformEffect(rect(), { reflectX: true }, B);
    expect(sign(fl)).toBe(sign(rect()[0]));
    // Random draws stay between nothing and the full move.
    const rnd = transformEffect(rect(), { moveH: 100, copies: 5, random: true, seed: 3 }, B);
    for (let i = 1; i < rnd.length; i++) expect(pathBounds(rnd[i].anchors, true).x).toBeGreaterThanOrEqual(pathBounds(rnd[i - 1].anchors, true).x - 1e-9);
  });
});

describe('shapes and marks', () => {
  it('converts to a rectangle, rounded rectangle or ellipse around the bounds', () => {
    const [r] = convertToShape(rect(), { shape: 'rectangle', sizeMode: 'relative', extraW: 10, extraH: 5 }, B);
    expect(pathBounds(r.anchors, true)).toEqual({ x: -10, y: -5, w: 120, h: 60 });
    const [e] = convertToShape(rect(), { shape: 'ellipse', sizeMode: 'absolute', width: 40, height: 20 }, B);
    expect(pathBounds(e.anchors, true)).toEqual({ x: 30, y: 15, w: 40, h: 20 });
    const [rr] = convertToShape(rect(), { shape: 'roundedRectangle', sizeMode: 'relative', extraW: 0, extraH: 0, radius: 10 }, B);
    expect(rr.anchors).toHaveLength(8);
  });

  it('adds crop marks painted as thin black lines', () => {
    const subs = cropMarks(rect(), { gap: 9, length: 18 }, B);
    expect(subs).toHaveLength(9);
    const marks = subs.slice(1);
    for (const m of marks) {
      expect(m.closed).toBe(false);
      expect(m.paint).toBe(CROP_MARK_PAINT);
    }
    const b = subpathsBounds(marks);
    expect(b).toEqual({ x: -27, y: -27, w: 154, h: 104 });
  });
});

describe('scribble', () => {
  it('fills the shape with back-and-forth passes painted in the fill', () => {
    const fx = { ...SCRIBBLE_PRESETS[1], seed: 5 };
    const out = scribble(rect(), fx, B);
    const lines = out.filter((s) => s.paint?.stroke === 'fill');
    const outline = out.filter((s) => s.paint && s.paint.fill === null && !s.paint.stroke);
    expect(lines.length).toBeGreaterThan(0);
    expect(outline).toHaveLength(1);
    expect(lines[0].paint.strokeWidth).toBe(fx.lineWidth);
    // Spacing 3 at 45 degrees across a 100x50 box: dozens of passes.
    const passes = lines.reduce((n, l) => n + l.anchors.length, 0);
    expect(passes).toBeGreaterThan(20);
    // With a negative overlap every pass stays inside the shape.
    for (const l of lines) for (const a of l.anchors) {
      expect(a.x).toBeGreaterThan(-0.5);
      expect(a.x).toBeLessThan(100.5);
      expect(a.y).toBeGreaterThan(-0.5);
      expect(a.y).toBeLessThan(50.5);
    }
    expect(scribble(rect(), fx, B)).toEqual(out);
  });

  it('respects holes and leaves already-painted outlines alone', () => {
    const ring = [
      { anchors: rectangle(0, 0, 100, 100), closed: true },
      { anchors: rectangle(30, 30, 40, 40).reverse(), closed: true },
    ];
    const out = scribble(ring, { angle: 0, spacing: 4, spacingVar: 0, overlap: 0, overlapVar: 0, lineWidth: 1, curviness: 0, curvinessVar: 0, seed: 1 }, { x: 0, y: 0, w: 100, h: 100 }, { evenodd: true });
    const lines = out.filter((s) => s.paint?.stroke === 'fill');
    // No pass crosses the hole.
    for (const l of lines) {
      for (let i = 0; i + 1 < l.anchors.length; i++) {
        const a = l.anchors[i];
        const b = l.anchors[i + 1];
        if (Math.abs(a.y - b.y) < 1e-6 && a.y > 31 && a.y < 69) expect(Math.min(a.x, b.x) > 69 || Math.max(a.x, b.x) < 31).toBe(true);
      }
    }
    const marked = [{ anchors: line(0, 0, 10, 0), closed: false, paint: CROP_MARK_PAINT }];
    expect(scribble(marked, { spacing: 3, seed: 1 }, B)).toEqual(marked);
  });

  it('paints in parts on a node and exposes the line width in visual bounds', () => {
    const p = createPath(rectangle(0, 0, 100, 50), true, { fill: red, stroke: blue, strokeWidth: 1, effects: [createEffect('scribble', { lineWidth: 6, overlap: 0, overlapVar: 0, seed: 2 })] });
    const doc = docWith(p);
    const n = doc.get(p.id);
    const parts = paintParts(n, effectiveSubpaths(doc, n));
    expect(parts).toHaveLength(2);
    expect(parts[0].style).toMatchObject({ fill: null, stroke: red, strokeWidth: 6 });
    expect(parts[1].style).toEqual({ fill: null });
    const vb = visualBounds(doc, n);
    expect(vb.x).toBeLessThanOrEqual(-3);
  });
});

describe('engine effects', () => {
  it('offsets closed outlines outward and inward', () => {
    const info = { node: { type: 'path' }, pending: () => {} };
    const out = offsetPath(rect(), { offset: 5, joins: 'miter', miterLimit: 4 }, info);
    expect(subpathsBounds(out)).toEqual(expect.objectContaining({ x: expect.closeTo(-5, 3), w: expect.closeTo(110, 3) }));
    const inner = offsetPath(rect(), { offset: -5, joins: 'round', miterLimit: 4 }, info);
    expect(subpathsBounds(inner).w).toBeCloseTo(90, 3);
    // An open line offsets into the band around it.
    const band = offsetPath([{ anchors: line(0, 0, 100, 0), closed: false }], { offset: 4, joins: 'miter', miterLimit: 4 }, info);
    expect(subpathsBounds(band).h).toBeCloseTo(8, 3);
  });

  it('outlines the stroke as drawn', () => {
    const node = { type: 'path', stroke: blue, strokeWidth: 10, fill: null };
    const out = outlineStroke([{ anchors: line(0, 0, 100, 0), closed: false }], {}, { node, pending: () => {} });
    expect(subpathsBounds(out).h).toBeCloseTo(10, 3);
    expect(outlineStroke(rect(), {}, { node: { type: 'path', stroke: null } })).toEqual(rect());
  });

  it('outlines the dots of a dotted stroke (zero-length dashes with round caps)', () => {
    const node = { type: 'path', stroke: blue, strokeWidth: 10, strokeCap: 'round', dash: [0, 20], fill: null };
    const out = outlineStroke([{ anchors: line(0, 0, 100, 0), closed: false }], {}, { node, pending: () => {} });
    expect(out).toHaveLength(5);
    for (const s of out) expect(area([s])).toBeCloseTo(Math.PI * 25, 0);
  });

  it('combines group items with the pathfinder style rules', () => {
    const items = [
      { style: { fill: red, stroke: null }, subpaths: [{ anchors: rectangle(0, 0, 60, 60), closed: true }] },
      { style: { fill: blue, stroke: blue, strokeWidth: 2 }, subpaths: [{ anchors: rectangle(30, 30, 60, 60), closed: true }] },
    ];
    const unite = pathfinderCombine(items, { kind: 'unite' });
    expect(unite).toHaveLength(1);
    expect(unite[0].style.fill).toBe(blue);
    expect(area(unite[0].subpaths)).toBeCloseTo(60 * 60 * 2 - 30 * 30, 0);
    const sub = pathfinderCombine(items, { kind: 'minusFront' });
    expect(area(sub[0].subpaths)).toBeCloseTo(60 * 60 - 30 * 30, 0);
    expect(sub[0].style.fill).toBe(red);
    const inter = pathfinderCombine(items, { kind: 'intersect' });
    expect(area(inter[0].subpaths)).toBeCloseTo(900, 0);
    const divide = pathfinderCombine(items, { kind: 'divide' });
    expect(divide).toHaveLength(3);
    const trim = pathfinderCombine(items, { kind: 'trim' });
    expect(trim.every((it) => it.style.stroke === null)).toBe(true);
    const outline = pathfinderCombine(items, { kind: 'outline' });
    expect(outline.every((it) => it.style.fill === null && it.style.strokeWidth > 0)).toBe(true);
    // One shape alone is left as it is.
    expect(pathfinderCombine(items.slice(0, 1), { kind: 'intersect' })).toEqual(items.slice(0, 1));
  });

  it('runs on a single compound path as separate shapes', () => {
    const subs = [{ anchors: rectangle(0, 0, 60, 60), closed: true }, { anchors: rectangle(30, 30, 60, 60), closed: true }];
    const out = pathfinderOnShape(subs, { kind: 'unite' }, { pending: () => {} });
    expect(out).toHaveLength(1);
    expect(area(out)).toBeCloseTo(6300, 0);
  });

  it('cuts the contents of a clipping group to its clipping path, which paints nothing', () => {
    const a = createPath(rectangle(0, 0, 60, 60), true, { fill: blue, stroke: null });
    const big = createPath(rectangle(50, 0, 300, 300), true, { fill: red, stroke: null });
    const clip = createPath(rectangle(50, 0, 60, 60), true, { fill: null, stroke: null });
    const cg = createGroup([big.id, clip.id], { clip: true });
    const g = createGroup([a.id, cg.id], { effects: [createEffect('pathfinder', { kind: 'unite' })] });
    const doc = docWith({ node: g, descendants: [{ ...a, parent: g.id }, { ...cg, parent: g.id }, { ...big, parent: cg.id }, { ...clip, parent: cg.id }] });
    const { items, vdoc } = liveArtwork(doc, doc.get(g.id));
    const kids = items[0].children.map((id) => vdoc.get(id));
    expect(kids).toHaveLength(1);
    // The united shape takes the clipped artwork's paint, not the unpainted clipping path's.
    expect(kids[0].fill).toBe(red);
    const b = pathBounds(kids[0].anchors, true);
    expect(b.x).toBeCloseTo(0, 3);
    expect(b.x + b.w).toBeCloseTo(110, 3);
    expect(b.y + b.h).toBeCloseTo(60, 3);
  });

  it('applies Pathfinder effects to a group as a whole', () => {
    const a = createPath(rectangle(0, 0, 60, 60), true, { fill: red, stroke: null });
    const b = createPath(rectangle(30, 30, 60, 60), true, { fill: blue, stroke: null });
    const g = createGroup([a.id, b.id], { effects: [createEffect('pathfinder', { kind: 'unite' })] });
    const doc = docWith({ node: g, descendants: [{ ...a, parent: g.id }, { ...b, parent: g.id }] });
    const grp = doc.get(g.id);
    const { items, vdoc } = liveArtwork(doc, grp);
    expect(items).toHaveLength(1);
    const kids = items[0].children.map((id) => vdoc.get(id));
    expect(kids).toHaveLength(1);
    expect(kids[0].fill).toBe(blue);
    expect(nodeBounds(doc, grp)).toEqual({ x: 0, y: 0, w: 90, h: 90 });
    // A Warp after the Pathfinder bends the combined shape.
    doc.transact('warp', () => doc.update(g.id, { effects: [...grp.effects, createEffect('warp', { style: 'arc', bend: 0.5 })] }));
    const art2 = liveArtwork(doc, doc.get(g.id));
    const shape = art2.vdoc.get(art2.items[0].children[0]);
    expect(shape.anchors?.length || shape.children.length).toBeGreaterThan(4);
  });
});

describe('effects on compound paths', () => {
  it('apply across all subpaths of a compound', () => {
    const k1 = createPath(rectangle(0, 0, 100, 100), true);
    const k2 = createPath(ellipse(25, 25, 50, 50), true);
    const c = createCompound([k1.id, k2.id], { fill: red, effects: [createEffect('warp', { style: 'bulge', bend: 0.5 })] });
    const doc = docWith({ node: c, descendants: [{ ...k1, parent: c.id }, { ...k2, parent: c.id }] });
    const subs = effectiveSubpaths(doc, doc.get(c.id));
    expect(subs).toHaveLength(2);
    expect(subpathsBounds(subs).h).toBeGreaterThan(100);
    // A parabolic bulge is exactly one cubic per edge: the straight edges became curves.
    expect(isLine(segmentPoints(subs[0].anchors, 0))).toBe(false);
  });
});
