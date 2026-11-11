import { describe, it, expect, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { install as installLiquify } from '../src/features/liquify/index.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { pathBounds, nearestOnPath, segmentCount } from '../src/model/bezier.js';
import { densify, deformAnchors, falloff, brushDistance, simplifyAnchors, detailLength } from '../src/features/liquify/liquify-math.js';

const brush = (cx, cy, d = 100, angle = 0) => ({ cx, cy, w: d, h: d, angle });

describe('liquify math', () => {
  it('falls off smoothly from the center to the rim of an angled ellipse', () => {
    const b = { cx: 0, cy: 0, w: 200, h: 50, angle: 90 };
    expect(falloff(b, 0, 0)).toBe(1);
    // Turned 90 degrees, the long axis is vertical.
    expect(brushDistance(b, 0, 99)).toBeLessThan(1);
    expect(brushDistance(b, 99, 0)).toBeGreaterThan(1);
    expect(falloff(b, 0, 120)).toBe(0);
  });

  it('densifies only where the brush reaches, without changing the shape', () => {
    const a = rectangle(0, 0, 400, 100);
    const out = densify(a, true, brush(0, 0, 80), 10);
    expect(out.length).toBeGreaterThan(a.length + 4);
    // Every new anchor lies on the original outline.
    for (const p of out) expect(p.x === 0 || p.x === 400 || p.y === 0 || p.y === 100).toBe(true);
    // Straight edges stay straight and evenly split.
    const top = out.filter((p) => p.y === 0 && p.x > 0 && p.x < 40);
    expect(top.every((p) => p.iy === 0 && p.oy === 0 && p.ix < p.x && p.ox > p.x)).toBe(true);
    // The far corner is untouched.
    expect(out.some((p) => p.x === 400 && p.y === 100)).toBe(true);
    // Curves keep their shape too.
    const e = ellipse(0, 0, 100, 100);
    for (const p of densify(e, true, brush(50, 0, 60), 5)) expect(nearestOnPath(e, true, p.x, p.y).d).toBeLessThan(1e-3);
  });

  it('warp pushes points along the drag inside the brush only', () => {
    const a = densify(rectangle(0, 0, 400, 100), true, brush(200, 0, 100), 5);
    const out = deformAnchors(a, true, 'warp', brush(200, 0, 100), 1, { dx: 0, dy: -20 });
    const mid = out.find((p, i) => Math.abs(a[i].x - 200) < 3 && a[i].y === 0);
    expect(mid.y).toBeLessThan(-15);
    out.forEach((p, i) => {
      if (Math.abs(a[i].x - 200) > 60 || a[i].y === 100) expect(p.y).toBeCloseTo(a[i].y);
    });
  });

  it('pucker pulls toward the center, bloat pushes away, twirl turns', () => {
    const a = densify(ellipse(0, 0, 100, 100), true, brush(0, 0, 200), 10);
    const dist = (pts) => pts.reduce((s, p) => s + Math.hypot(p.x, p.y), 0) / pts.length;
    const d0 = dist(a);
    expect(dist(deformAnchors(a, true, 'pucker', brush(0, 0, 200), 2))).toBeLessThan(d0);
    expect(dist(deformAnchors(a, true, 'bloat', brush(0, 0, 200), 2))).toBeGreaterThan(d0);
    const tw = deformAnchors(a, true, 'twirl', brush(0, 0, 200), 1, { rate: 40 });
    expect(dist(tw)).toBeCloseTo(d0, 5);
    expect(tw[0].x).not.toBeCloseTo(a[0].x, 3);
  });

  it('crystallize and wrinkle are repeatable for a seed', () => {
    const a = densify(ellipse(0, 0, 100, 100), true, brush(0, 0, 200), 10);
    const one = deformAnchors(a, true, 'crystallize', brush(0, 0, 200), 1, { anchors: true }, 42);
    const two = deformAnchors(a, true, 'crystallize', brush(0, 0, 200), 1, { anchors: true }, 42);
    expect(one).toEqual(two);
    const w = deformAnchors(a, true, 'wrinkle', brush(0, 0, 200), 1, { anchors: true, horizontal: 0, vertical: 1 }, 7);
    // Horizontal 0%: anchors only move vertically.
    w.forEach((p, i) => expect(p.x).toBeCloseTo(a[i].x));
    expect(w.some((p, i) => Math.abs(p.y - a[i].y) > 1e-3)).toBe(true);
  });

  it('leaves paths out of reach untouched (same array)', () => {
    const a = rectangle(0, 0, 10, 10);
    expect(deformAnchors(a, true, 'warp', brush(500, 500), 1, { dx: 5, dy: 5 })).toBe(a);
  });

  it('simplify keeps corners and untouched geometry', () => {
    const r = rectangle(0, 0, 400, 100);
    const dense = densify(r, true, brush(200, 0, 100), 5);
    const s = simplifyAnchors(dense, true, 0.5);
    expect(s).toHaveLength(4);
    for (const c of r) expect(s.some((p) => p.x === c.x && p.y === c.y)).toBe(true);
  });

  it('simplify only removes anchors inside the given region', () => {
    const e = ellipse(0, 0, 100, 100);
    const dense = densify(e, true, brush(0, 0, 400), detailLength(brush(0, 0, 400), 10));
    const region = { x: -10, y: -10, w: 40, h: 120 };
    const s = simplifyAnchors(dense, true, 0.5, region);
    expect(s.length).toBeLessThan(dense.length);
    const outside = dense.filter((a) => a.x > 30);
    for (const a of outside) expect(s.some((b) => b.x === a.x && b.y === a.y)).toBe(true);
  });

  it('simplify removes most of the added anchors', () => {
    const e = ellipse(0, 0, 100, 100);
    const dense = densify(e, true, brush(0, 0, 400), detailLength(brush(0, 0, 400), 10));
    const s = simplifyAnchors(dense, true, 0.5);
    expect(s.length).toBeLessThan(dense.length);
    const b = pathBounds(s, true);
    expect(b.w).toBeCloseTo(100, 0);
    expect(segmentCount(s, true)).toBe(s.length);
  });
});

describe('liquify tools', () => {
  let app;
  const ev = (x, y, extra = {}) => ({ x, y, sx: x, sy: y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra });
  beforeEach(() => {
    app = bootApp({ install: installLiquify });
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  });

  function addRect() {
    const doc = app.editor.doc;
    const n = createPath(rectangle(100, 100, 300, 100), true, { fill: { type: 'solid', color: '#ff0000' } });
    doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
    return n.id;
  }

  it('registers all seven tools', () => {
    for (const id of ['warp', 'twirl', 'pucker', 'bloat', 'scallop', 'crystallize', 'wrinkle']) expect(app.toolClasses.has(id)).toBe(true);
  });

  it('a Warp stroke distorts the selected path in one undo step', () => {
    const id = addRect();
    app.editor.select([id]);
    app.setTool('warp');
    const t = app.tool;
    const before = app.editor.doc.get(id);
    t.onPointerDown(ev(250, 100));
    for (let i = 1; i <= 5; i++) t.onPointerMove(ev(250, 100 - i * 8));
    t.onPointerUp(ev(250, 60));
    const after = app.editor.doc.get(id);
    expect(after).not.toBe(before);
    expect(pathBounds(after.anchors, true).y).toBeLessThan(80);
    app.editor.doc.undo();
    expect(app.editor.doc.get(id)).toBe(before);
  });

  it('Simplify after a stroke leaves the anchors the brush never reached', () => {
    // A finely drawn wavy outline, warped at one spot on its right side.
    const anchors = [];
    for (let i = 0; i < 600; i++) {
      const t = (i / 600) * 2 * Math.PI;
      const r = 150 * (1 + 0.05 * Math.sin(40 * t));
      anchors.push({ x: 300 + r * Math.cos(t), y: 300 + r * Math.sin(t) });
    }
    const n = createPath(anchors.map((p) => ({ ...p, ix: p.x, iy: p.y, ox: p.x, oy: p.y })), true, { fill: { type: 'solid', color: '#ff0000' } });
    const doc = app.editor.doc;
    doc.transact('Wavy', () => doc.insert(n, app.editor.targetLayer().id));
    app.editor.select([n.id]);
    app.setTool('warp');
    const t = app.tool;
    t.onPointerDown(ev(457, 300));
    for (let i = 1; i <= 4; i++) t.onPointerMove(ev(457 + i * 4, 300));
    t.onPointerUp(ev(473, 300));
    const after = doc.get(n.id).anchors;
    // Every original anchor on the left half is still there.
    const left = n.anchors.filter((a) => a.x < 250);
    expect(left.length).toBeGreaterThan(100);
    for (const a of left) expect(after.some((b) => b.x === a.x && b.y === a.y)).toBe(true);
  });

  it('distorts unselected paths under the brush when nothing is selected', () => {
    const id = addRect();
    app.editor.select([]);
    app.setTool('pucker');
    const t = app.tool;
    t.onPointerDown(ev(250, 115));
    t.onPointerMove(ev(251, 115));
    t.onPointerUp(ev(251, 115));
    expect(app.editor.doc.get(id).anchors.length).toBeGreaterThan(4);
  });

  it('Option-drag resizes the shared brush instead of distorting', () => {
    const id = addRect();
    const before = app.editor.doc.get(id);
    app.setTool('twirl');
    const t = app.tool;
    t.onPointerDown(ev(500, 500, { alt: true }));
    t.onPointerMove(ev(560, 520, { alt: true }));
    t.onPointerUp(ev(560, 520, { alt: true }));
    expect(t.brush.w).toBeCloseTo(120);
    expect(t.brush.h).toBeCloseTo(40);
    expect(app.editor.doc.get(id)).toBe(before);
    app.setTool('bloat');
    expect(app.tool.brush.w).toBeCloseTo(120);
  });
});

describe('pin warp', () => {
  it('maps pins exactly and keeps a single translated pin rigid', async () => {
    const { rigidMLS, controlPoints, restPoint } = await import('../src/features/liquify/pin-warp-math.js');
    const pins = [{ p: { x: 0, y: 0 }, q: { x: 0, y: 0 } }, { p: { x: 100, y: 0 }, q: { x: 100, y: 50 } }, { p: { x: 200, y: 0 }, q: { x: 200, y: 0 } }];
    const f = rigidMLS(controlPoints(pins, 10));
    expect(f(100, 0)).toEqual({ x: 100, y: 50 });
    expect(f(0, 0)).toEqual({ x: 0, y: 0 });
    // Between pins the artwork bends toward the moved one.
    expect(f(50, 0).y).toBeGreaterThan(5);
    expect(f(50, 0).y).toBeLessThan(50);
    // Unmoved pins: identity everywhere.
    const id = rigidMLS(controlPoints(pins.map((p) => ({ ...p, q: p.p })), 10));
    const v = id(37, 81);
    expect(v.x).toBeCloseTo(37);
    expect(v.y).toBeCloseTo(81);
    // restPoint inverts the mapping.
    const r = restPoint(f, f(70, 20).x, f(70, 20).y);
    expect(r.x).toBeCloseTo(70, 4);
    expect(r.y).toBeCloseTo(20, 4);
  });

  it('a turned pin rotates the area around it', async () => {
    const { rigidMLS, controlPoints } = await import('../src/features/liquify/pin-warp-math.js');
    const f = rigidMLS(controlPoints([{ p: { x: 0, y: 0 }, q: { x: 0, y: 0 }, angle: Math.PI / 2 }, { p: { x: 1000, y: 0 }, q: { x: 1000, y: 0 } }], 10));
    const q = f(5, 0);
    expect(q.y).toBeGreaterThan(3);
  });

  it('the tool bends the selection from its start state and Escape restores it', () => {
    const app = bootApp({ install: installLiquify });
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    const doc = app.editor.doc;
    const n = createPath(rectangle(100, 100, 300, 60), true, { fill: { type: 'solid', color: '#ff0000' } });
    doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
    app.editor.select([n.id]);
    app.setTool('pin-warp');
    const t = app.tool;
    expect(t.session.pins).toHaveLength(3);
    const pin = t.session.pins[2].q;
    const ev = (x, y, extra = {}) => ({ x, y, sx: x, sy: y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra });
    t.onPointerDown(ev(pin.x, pin.y));
    t.onPointerMove(ev(pin.x, pin.y + 80));
    t.onPointerUp(ev(pin.x, pin.y + 80));
    const b = nodeBoundsOf(doc.get(n.id));
    expect(b.y + b.h).toBeGreaterThan(200);
    t.onKeyDown({ key: 'Escape' });
    expect(doc.get(n.id).anchors).toBe(n.anchors);
  });
});

function nodeBoundsOf(n) {
  return pathBounds(n.anchors, n.closed);
}

describe('sketch shape gestures', () => {
  let recognizeGesture;
  beforeEach(async () => {
    ({ recognizeGesture } = await import('../src/features/liquify/gestures.js'));
  });
  // Deterministic wobble so tests are repeatable.
  const wob = (i, amp) => Math.sin(i * 1.7) * amp;
  const trace = (corners, perSide = 20, amp = 1.5) => {
    const pts = [];
    for (let c = 0; c < corners.length; c++) {
      const a = corners[c];
      const b = corners[(c + 1) % corners.length];
      for (let i = 0; i < perSide; i++) {
        const t = i / perSide;
        pts.push({ x: a.x + (b.x - a.x) * t + wob(pts.length, amp), y: a.y + (b.y - a.y) * t + wob(pts.length + 3, amp) });
      }
    }
    pts.push({ x: corners[0].x + 2, y: corners[0].y + 1 });
    return pts;
  };

  it('recognizes a rough rectangle as an axis-aligned live rectangle', () => {
    const g = recognizeGesture(trace([{ x: 0, y: 0 }, { x: 200, y: 4 }, { x: 198, y: 100 }, { x: 2, y: 96 }]));
    expect(g.shape.kind).toBe('rect');
    expect(g.shape.angle).toBe(0);
    expect(g.shape.w).toBeGreaterThan(180);
    expect(g.shape.h).toBeGreaterThan(85);
  });

  it('recognizes ellipses, circles, triangles, hexagons and lines', () => {
    const ring = (rx, ry, n = 60) => Array.from({ length: n + 1 }, (_, i) => ({ x: 100 + rx * Math.cos((i / n) * Math.PI * 2) + wob(i, 1), y: 100 + ry * Math.sin((i / n) * Math.PI * 2) + wob(i + 5, 1) }));
    const e = recognizeGesture(ring(120, 60));
    expect(e.shape.kind).toBe('ellipse');
    expect(e.shape.w).toBeGreaterThan(e.shape.h * 1.5);
    const c = recognizeGesture(ring(80, 78));
    expect(c.shape.kind).toBe('ellipse');
    expect(c.shape.w).toBe(c.shape.h);
    const t = recognizeGesture(trace([{ x: 100, y: 0 }, { x: 200, y: 170 }, { x: 0, y: 170 }]));
    expect(t.anchors).toHaveLength(3);
    const hex = Array.from({ length: 6 }, (_, i) => ({ x: 100 + 80 * Math.cos(-Math.PI / 2 + (i * Math.PI) / 3), y: 100 + 80 * Math.sin(-Math.PI / 2 + (i * Math.PI) / 3) }));
    const p = recognizeGesture(trace(hex, 12, 0.8));
    expect(p.shape.kind).toBe('polygon');
    expect(p.shape.sides).toBe(6);
    const l = recognizeGesture(Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: i * 10.3 + wob(i, 0.5) })));
    expect(l.shape.kind).toBe('line');
    expect(l.shape.y2 - l.shape.y1).toBeCloseTo(l.shape.x2 - l.shape.x1, 5);
  });

  it('recognizes a scribble', () => {
    const pts = [];
    for (let i = 0; i < 8; i++) pts.push({ x: i % 2 ? 100 : 0, y: i * 6 });
    expect(recognizeGesture(pts).type).toBe('scribble');
  });

  it('the tool deletes a shape scribbled over', async () => {
    const app = bootApp({ install: installLiquify });
    app.newDocument();
    const doc = app.editor.doc;
    const n = createPath(rectangle(0, 0, 200, 200), true, { fill: { type: 'solid', color: '#ff0000' } });
    doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
    app.setTool('sketch-shape');
    const t = app.tool;
    const ev = (x, y) => ({ x, y, sx: x, sy: y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {} });
    t.onPointerDown(ev(20, 20));
    for (let i = 1; i < 8; i++) t.onPointerMove(ev(i % 2 ? 150 : 20, 20 + i * 15));
    await t.onPointerUp(ev(20, 140));
    expect(doc.get(n.id)).toBeUndefined();
  });
});
