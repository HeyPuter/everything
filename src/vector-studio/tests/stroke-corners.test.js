// Corners for the Pencil, Paintbrush and Merge Brush: sharp turns stay sharp while Fidelity and Smoothing smooth the rest.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { toolSettings } from '../src/features/tool-props/index.js';
import { detectCorners, cornerAngle, fitStroke, restoreCorners } from '../src/tools/corners.js';
import { Stabilizer } from '../src/tools/stabilizer.js';
import { isSmooth } from '../src/tools/direct-selection.js';

let app;
beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
  app = await bootAppWithFeatures();
});

/** Deterministic pen jitter in -0.5 .. 0.5. */
function jitter(seed = 1) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
}

/** Pen samples every `step` units along the straight runs between vertices, with +-jit/2 of jitter. */
function polyline(verts, step = 1.5, jit = 0, seed = 1) {
  const r = jitter(seed);
  const out = [];
  for (let i = 0; i + 1 < verts.length; i++) {
    const [a, b] = [verts[i], verts[i + 1]];
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
    for (let k = 0; k < n; k++) out.push({ x: a[0] + ((b[0] - a[0]) * k) / n + r() * jit, y: a[1] + ((b[1] - a[1]) * k) / n + r() * jit });
  }
  const last = verts.at(-1);
  out.push({ x: last[0], y: last[1] });
  return out;
}

/** Pen samples along an arc. */
function arc(cx, cy, radius, a0, a1, step = 1.5, jit = 0) {
  const r = jitter(7);
  const n = Math.ceil((Math.abs(a1 - a0) * radius) / step);
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return { x: cx + radius * Math.cos(a) + r() * jit, y: cy + radius * Math.sin(a) + r() * jit };
  });
}

const near = (p, x, y, d = 2) => Math.hypot(p.x - x, p.y - y) <= d;

describe('detectCorners', () => {
  it('finds the sharp turns of a hand-drawn square, not the jitter along its sides', () => {
    const square = polyline([[50, 0], [100, 0], [100, 100], [0, 100], [0, 0], [40, 0]], 1.5, 1.2);
    const found = detectCorners(square, { amount: 50 }).map((i) => square[i]);
    expect(found).toHaveLength(4);
    [[100, 0], [100, 100], [0, 100], [0, 0]].forEach(([x, y], k) => expect(near(found[k], x, y, 3)).toBe(true));
  });

  it('is off at 0 and never marks a stroke end', () => {
    const v = polyline([[0, 0], [60, 80], [120, 0]]);
    expect(detectCorners(v, { amount: 0 })).toEqual([]);
    const found = detectCorners(v, { amount: 50 });
    expect(found).toHaveLength(1);
    expect(found[0]).toBeGreaterThan(0);
    expect(found[0]).toBeLessThan(v.length - 1);
  });

  it('leaves curves alone, even tight ones at the highest setting', () => {
    expect(detectCorners(arc(0, 0, 60, 0, 6, 1.5, 0.8), { amount: 100 })).toEqual([]);
    expect(detectCorners(arc(0, 0, 25, 0, 6, 1.5, 0.8), { amount: 100 })).toEqual([]);
    // A small loop, like the bowl of an "e".
    expect(detectCorners(arc(0, 0, 12, 0, 6, 1.5, 0.5), { amount: 100 })).toEqual([]);
    const wave = Array.from({ length: 121 }, (_, i) => ({ x: 100 + i * 3, y: 200 + 40 * Math.sin(i / 8) }));
    expect(detectCorners(wave, { amount: 100 })).toEqual([]);
  });

  it('keeps shallower turns as corners the higher the setting', () => {
    // A 60 degree turn.
    const bend = polyline([[0, 0], [100, 0], [150, 86.6]]);
    expect(detectCorners(bend, { amount: 50 })).toEqual([]);
    expect(detectCorners(bend, { amount: 75 })).toHaveLength(1);
    expect(cornerAngle(0)).toBe(Infinity);
    expect(cornerAngle(100)).toBeLessThan(cornerAngle(50));
  });

  it('measures in screen pixels: the same drawing on screen gives the same corners at any zoom', () => {
    const z1 = polyline([[0, 0], [40, 0], [40, 40]], 1);
    const z4 = z1.map((p) => ({ x: p.x / 4, y: p.y / 4 }));
    expect(detectCorners(z4, { amount: 50, zoom: 4 })).toEqual(detectCorners(z1, { amount: 50, zoom: 1 }));
  });

  it('takes a turn the pen slowed down into as a corner more readily', () => {
    // A 70 degree turn: not sharp enough at 50 when drawn at an even pace.
    const pts = polyline([[0, 0], [100, 0], [134.2, 94]], 1);
    const apex = pts.findIndex((p) => p.x === 100 && p.y === 0);
    const even = pts.map((_, i) => i * 2);
    // The same stroke with the pen lingering over the samples around the turn.
    let t = 0;
    const paused = pts.map((_, i) => (t += Math.abs(i - apex) < 6 ? 40 : 2));
    expect(detectCorners(pts, { amount: 50, times: even })).toEqual([]);
    const found = detectCorners(pts, { amount: 50, times: paused });
    expect(found).toHaveLength(1);
    expect(near(pts[found[0]], 100, 0)).toBe(true);
  });
});

describe('fitStroke and restoreCorners', () => {
  it('fits the curves between corners and gives each corner its own handles', () => {
    // A straight run to the right, then a half circle that sets off upward: a corner where they meet.
    const pts = [...polyline([[0, 100], [100, 100]]).slice(0, -1), ...arc(150, 100, 50, Math.PI, 2 * Math.PI)];
    const corners = detectCorners(pts, { amount: 50 });
    expect(corners).toHaveLength(1);
    const anchors = fitStroke(pts, corners, 1, 0.5);
    const corner = anchors.find((a) => near(a, 100, 100, 1.5));
    expect(corner).toBeTruthy();
    expect(isSmooth(corner)).toBe(false);
    // The anchors in the half circle stay smooth.
    const curve = anchors.filter((a) => a.x > 120 && a !== anchors.at(-1));
    expect(curve.length).toBeGreaterThan(0);
    expect(curve.every(isSmooth)).toBe(true);
  });

  it('restarts the Smoothing string at each corner, one point per pen sample', () => {
    const pts = polyline([[0, 0], [100, 0], [100, 100]]);
    const corners = detectCorners(pts, { amount: 50 });
    const out = restoreCorners(pts, corners, 20);
    expect(out).toHaveLength(pts.length);
    expect(out[corners[0]]).toEqual(pts[corners[0]]);
    // Without the restart the string cuts across the corner by about its length.
    const s = new Stabilizer(50, 1, pts[0], undefined, 'string');
    const cut = [pts[0], ...pts.slice(1).map((p) => s.push(p))];
    const closest = (list) => Math.min(...list.map((p) => Math.hypot(p.x - 100, p.y)));
    expect(closest(cut)).toBeGreaterThan(5);
    expect(closest(out)).toBeLessThan(0.5);
  });

  it('live Smoothing rounds a corner, and keeps it with Corners on', () => {
    const pts = polyline([[0, 0], [100, 0], [100, 100]]);
    const closest = (list) => Math.min(...list.map((p) => Math.hypot(p.x - 100, p.y)));
    const draw = () => {
      const s = new Stabilizer(50, 1, pts[0]);
      return { s, drawn: [pts[0], ...pts.slice(1).map((p) => s.push(p))] };
    };
    const round = draw();
    expect(closest(round.s.settle(round.drawn, 0).points)).toBeGreaterThan(3);
    const sharp = draw();
    const kept = sharp.s.settle(sharp.drawn, 50);
    expect(kept.corners).toHaveLength(1);
    expect(kept.points).toHaveLength(pts.length);
    expect(kept.points[kept.corners[0]]).toEqual(pts[kept.corners[0]]);
    expect(closest(kept.points)).toBeLessThan(0.5);
    // The straight runs on either side of the corner stay straight.
    for (const p of kept.points) expect(Math.min(Math.abs(p.y), Math.abs(p.x - 100))).toBeLessThan(0.01);
  });
});

function newDoc() {
  const ed = app.newDocument();
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  return ed;
}

function ev(x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

async function stroke(tool, points, extra = () => ({})) {
  tool.onPointerDown(ev(points[0].x, points[0].y, extra(0)));
  points.slice(1).forEach((p, i) => tool.onPointerMove(ev(p.x, p.y, extra(i + 1))));
  await tool.onPointerUp(ev(points.at(-1).x, points.at(-1).y, extra(points.length - 1)));
}

/** A zigzag with jitter: three sharp corners at (230, 300), (260, 200), (290, 300). */
const zigzag = polyline([[200, 200], [230, 300], [260, 200], [290, 300], [320, 200]], 1.5, 0.8, 3);
const ZIG_CORNERS = [[230, 300], [260, 200], [290, 300]];

/** The anchor nearest each corner and how far it is. */
function cornerAnchors(n) {
  return ZIG_CORNERS.map(([x, y]) => {
    const a = n.anchors.reduce((b, c) => (Math.hypot(c.x - x, c.y - y) < Math.hypot(b.x - x, b.y - y) ? c : b));
    return { a, d: Math.hypot(a.x - x, a.y - y) };
  });
}

describe('Corners in the freehand tools', () => {
  it('the Pencil keeps sharp corners with high Fidelity and Smoothing, and remembers the setting', async () => {
    const ed = newDoc();
    app.setTool('pencil');
    const tool = app.tool;
    tool.fidelity = 80;
    tool.smoothing = 60;
    tool.corners = 0;
    await stroke(tool, zigzag);
    const rounded = ed.doc.leaves().at(-1);
    ed.clearSelection();
    tool.corners = 50;
    expect(app.prefs.get('pencilCorners')).toBe(50);
    await stroke(tool, zigzag);
    const sharp = ed.doc.leaves().at(-1);
    expect(sharp.id).not.toBe(rounded.id);
    // Without Corners, Smoothing cuts across the turns.
    expect(Math.max(...cornerAnchors(rounded).map((c) => c.d))).toBeGreaterThan(5);
    for (const { a, d } of cornerAnchors(sharp)) {
      expect(d).toBeLessThan(2);
      expect(isSmooth(a)).toBe(false);
    }
    tool.corners = 0;
    tool.smoothing = 0;
    app.setTool('selection');
  });

  it('the Paintbrush keeps corners and one pen pressure per point', async () => {
    const ed = newDoc();
    app.setTool('paintbrush');
    const tool = app.tool;
    tool.smoothing = 60;
    tool.corners = 50;
    expect(app.prefs.get('paintbrushOptions').corners).toBe(50);
    const pen = (i) => ({ pointerType: 'pen', pressure: 0.3 + (0.5 * i) / zigzag.length });
    tool.onPointerDown(ev(zigzag[0].x, zigzag[0].y, pen(0)));
    zigzag.slice(1).forEach((p, i) => tool.onPointerMove(ev(p.x, p.y, pen(i + 1))));
    await tool.onPointerUp(ev(zigzag.at(-1).x, zigzag.at(-1).y, pen(zigzag.length - 1)));
    const n = ed.doc.leaves().at(-1);
    for (const { a, d } of cornerAnchors(n)) {
      expect(d).toBeLessThan(2);
      expect(isSmooth(a)).toBe(false);
    }
    expect(n.widthProfile).toBeTruthy();
    tool.corners = 0;
    tool.smoothing = 0;
    app.setTool('selection');
  });

  it('the Merge Brush keeps the corners of its brush path, with and without pen pressure', async () => {
    const ed = newDoc();
    app.setTool('blob-brush');
    const tool = app.tool;
    tool.size = 6;
    tool.smoothing = 60;
    tool.corners = 0;
    await stroke(tool, zigzag);
    const rounded = ed.doc.leaves().at(-1);
    ed.doc.transact('Clear', () => ed.doc.remove(rounded.id));
    tool.corners = 50;
    expect(app.prefs.get('blobBrushCorners')).toBe(50);
    await stroke(tool, zigzag);
    const blob = ed.doc.leaves().at(-1);
    // Around the top corner at (260, 200): the blob reaches over it by half the brush size, and the inside
    // of the turn is a sharp notch (a 33 degree turn puts it 3 / sin(16.7) = 10.4 below), not a rounded dip.
    const top = (n) => Math.min(...n.anchors.filter((a) => Math.abs(a.x - 260) < 6).map((a) => a.y));
    const notch = (n) => Math.max(...n.anchors.filter((a) => Math.abs(a.x - 260) < 1 && a.y < 230).map((a) => a.y));
    expect(top(blob)).toBeCloseTo(197, 0);
    expect(top(rounded)).toBeGreaterThan(top(blob) + 5);
    expect(notch(blob)).toBeGreaterThan(209);
    expect(notch(blob)).toBeLessThan(212);
    ed.doc.transact('Clear', () => ed.doc.remove(blob.id));
    const pen = (i) => ({ pointerType: 'pen', pressure: 0.3 + (0.5 * i) / zigzag.length });
    await stroke(tool, zigzag, pen);
    const pressed = ed.doc.leaves().at(-1);
    expect(pressed.type).toBe('path');
    expect(pressed.anchors.length).toBeGreaterThan(4);
    ed.doc.transact('Clear', () => ed.doc.remove(pressed.id));
    tool.corners = 0;
    tool.smoothing = 0;
    app.setTool('selection');
  });

  it('shows Corners in the Properties panel and the tool options', () => {
    newDoc();
    for (const id of ['pencil', 'paintbrush', 'blob-brush']) {
      app.setTool(id);
      const s = toolSettings(app);
      const keys = s.fields.map((f) => f.key);
      expect(keys.indexOf('corners')).toBe(keys.indexOf('smoothing') + 1);
      s.set('corners', 30);
      expect(app.tool.corners).toBe(30);
      s.set('corners', 0);
    }
    app.setTool('selection');
  });
});
