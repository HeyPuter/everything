import { describe, expect, it } from 'vitest';
import { filterPoints, splineSamples, simplify, strokeOutline, strokeBounds, strokeHit, eraseFromStroke, lassoContains, pointInPolygon, rulerEdge, snapToEdge, straightenAlongEdge, widthAt, sweepHits } from '../src/engine/ink-geometry.js';
import { recognizeStroke, recognizeStrokes, resample } from '../src/engine/ink-recognizer.js';

// A deterministic wobble so the tests are repeatable.
const jitter = (points, amount = 1.2, seed = 7) => {
  let s = seed;
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  return points.map(p => ({ x: p.x + rand() * amount, y: p.y + rand() * amount, p: 0.5 }));
};
const line = (a, b, n = 40) => Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n, p: 0.5 }));
const polyline = (...corners) => corners.slice(1).flatMap((c, i) => line(corners[i], c, 30).slice(i ? 1 : 0));
const ellipse = (cx, cy, rx, ry, n = 90, turns = 1.03) => Array.from({ length: n + 1 }, (_, i) => { const a = 2 * Math.PI * turns * i / n; return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), p: 0.5 }; });

describe('stroke smoothing', () => {
  it('steadies shaky samples while ending where the pointer lifted', () => {
    const raw = jitter(line({ x: 0, y: 0 }, { x: 200, y: 0 }, 120), 4);
    const smooth = filterPoints(raw);
    const wobble = pts => Math.max(...pts.map(p => Math.abs(p.y)));
    expect(wobble(smooth)).toBeLessThan(wobble(raw));
    expect(smooth.at(-1)).toMatchObject({ x: raw.at(-1).x, y: raw.at(-1).y });
    expect(smooth.length).toBeLessThan(raw.length);
  });
  it('merges samples closer than the minimum gap', () => {
    const smooth = filterPoints([{ x: 0, y: 0, p: 0.5 }, { x: 0.1, y: 0, p: 0.9 }, { x: 0.2, y: 0, p: 0.5 }]);
    expect(smooth).toHaveLength(1);
    expect(smooth[0].p).toBe(0.9);
  });
  it('passes the spline through every input point', () => {
    const pts = [{ x: 0, y: 0, p: 0.5 }, { x: 10, y: 10, p: 0.5 }, { x: 20, y: 0, p: 0.5 }, { x: 30, y: 10, p: 0.5 }];
    const samples = splineSamples(pts, 1);
    for (const p of pts) expect(samples.some(s => Math.hypot(s.x - p.x, s.y - p.y) < 1e-9)).toBe(true);
    // Samples are no farther apart than about the requested step.
    for (let i = 1; i < samples.length; i++) expect(Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y)).toBeLessThan(2);
  });
  it('simplifies straight runs but keeps pressure changes', () => {
    const straight = line({ x: 0, y: 0 }, { x: 100, y: 0 }, 50);
    expect(simplify(straight, 0.5)).toHaveLength(2);
    const taper = straight.map((p, i) => ({ ...p, p: i < 25 ? 0.2 : 0.9 }));
    expect(simplify(taper, 0.5).length).toBeGreaterThan(2);
  });
});

describe('stroke outline', () => {
  it('surrounds the centre line at half the pen width', () => {
    const stroke = { tool: 'pen', color: '000000', width: 4, points: line({ x: 10, y: 50 }, { x: 110, y: 50 }, 10) };
    const outline = strokeOutline(stroke);
    const ys = outline.map(p => p.y), xs = outline.map(p => p.x);
    expect(Math.min(...ys)).toBeCloseTo(48, 5); expect(Math.max(...ys)).toBeCloseTo(52, 5);
    expect(Math.min(...xs)).toBeCloseTo(8, 0); expect(Math.max(...xs)).toBeCloseTo(112, 0);
    expect(pointInPolygon({ x: 60, y: 50 }, outline)).toBe(true);
    expect(pointInPolygon({ x: 60, y: 53 }, outline)).toBe(false);
  });
  it('widens with pressure for pens but not for highlighters', () => {
    expect(widthAt(2, 1, 'pen')).toBeGreaterThan(widthAt(2, 0.5, 'pen'));
    expect(widthAt(2, 0.5, 'pen')).toBeCloseTo(2, 5);
    expect(widthAt(8, 1, 'highlighter')).toBe(8);
  });
  it('draws a dot for a tap', () => {
    const outline = strokeOutline({ tool: 'pen', color: '000000', width: 6, points: [{ x: 5, y: 5, p: 0.5 }] });
    expect(outline.length).toBeGreaterThan(8);
    for (const p of outline) expect(Math.hypot(p.x - 5, p.y - 5)).toBeCloseTo(3, 5);
  });
  it('measures bounds including the ink width', () => {
    expect(strokeBounds({ tool: 'pen', width: 4, points: [{ x: 0, y: 0, p: 0.5 }, { x: 10, y: 0, p: 0.5 }] })).toMatchObject({ left: -2, top: -2, right: 12, bottom: 2 });
  });
});

describe('erasing and lasso', () => {
  const stroke = { tool: 'pen', color: '000000', width: 2, points: [{ x: 0, y: 0, p: 0.5 }, { x: 100, y: 0, p: 0.5 }] };
  it('hits a stroke within the eraser radius', () => {
    expect(strokeHit(stroke, { x: 50, y: 4 }, 3.5)).toBe(true);
    expect(strokeHit(stroke, { x: 50, y: 10 }, 3)).toBe(false);
    expect(sweepHits(stroke, { x: 50, y: -20 }, { x: 50, y: 20 }, 2)).toBe(true);
  });
  it('splits a stroke where the point eraser passes', () => {
    const pieces = eraseFromStroke(stroke, { x: 50, y: 0 }, 5);
    expect(pieces).toHaveLength(2);
    expect(Math.max(...pieces[0].points.map(p => p.x))).toBeLessThan(46);
    expect(Math.min(...pieces[1].points.map(p => p.x))).toBeGreaterThan(54);
    expect(eraseFromStroke(stroke, { x: 50, y: 30 }, 5)).toEqual([stroke]);
    expect(eraseFromStroke({ ...stroke, points: line({ x: 0, y: 0 }, { x: 4, y: 0 }, 4) }, { x: 2, y: 0 }, 10)).toEqual([]);
  });
  it('selects strokes mostly inside a loop', () => {
    const loop = [{ x: -10, y: -10 }, { x: 60, y: -10 }, { x: 60, y: 10 }, { x: -10, y: 10 }];
    expect(lassoContains(loop, { points: line({ x: 0, y: 0 }, { x: 50, y: 0 }) })).toBe(true);
    expect(lassoContains(loop, { points: line({ x: 0, y: 0 }, { x: 200, y: 0 }) })).toBe(false);
  });
});

describe('ruler', () => {
  const ruler = { x: 100, y: 100, angle: 0, length: 400, thickness: 60 };
  it('offers the near edge to a stroke that starts just outside it', () => {
    expect(rulerEdge(ruler, { x: 120, y: 135 })).toMatchObject({ side: 1, y: 130 });
    expect(rulerEdge(ruler, { x: 120, y: 65 })).toMatchObject({ side: -1, y: 70 });
    expect(rulerEdge(ruler, { x: 120, y: 100 })).toBeNull();
    expect(rulerEdge(ruler, { x: 120, y: 200 })).toBeNull();
  });
  it('projects strokes onto a rotated edge', () => {
    const edge = rulerEdge({ ...ruler, angle: Math.PI / 4 }, { x: 100 - 32 * Math.SQRT1_2, y: 100 + 32 * Math.SQRT1_2 });
    expect(edge).not.toBeNull();
    const snapped = snapToEdge([{ x: 70, y: 140, p: 0.5 }, { x: 110, y: 160, p: 0.5 }], edge);
    for (const p of snapped) expect(Math.abs(-(p.x - edge.x) * Math.sin(edge.angle) + (p.y - edge.y) * Math.cos(edge.angle))).toBeLessThan(1e-9);
    expect(straightenAlongEdge(snapped, edge)).toHaveLength(2);
  });
});

describe('ink to shape recognizer', () => {
  it('recognises a line', () => {
    const shape = recognizeStroke(jitter(line({ x: 10, y: 10 }, { x: 210, y: 60 }), 1.5));
    expect(shape.kind).toBe('line');
    expect(shape.from.x).toBeCloseTo(10, -1); expect(shape.to.x).toBeCloseTo(210, -1);
  });
  it('recognises a rectangle and snaps it to the axes', () => {
    const shape = recognizeStroke(jitter(polyline({ x: 0, y: 0 }, { x: 160, y: 2 }, { x: 161, y: 90 }, { x: 1, y: 91 }, { x: 0, y: 3 }), 2));
    expect(shape.kind).toBe('rect');
    expect(shape.angle).toBe(0);
    expect(shape.width).toBeGreaterThan(150); expect(shape.height).toBeGreaterThan(80); expect(shape.height).toBeLessThan(100);
  });
  it('recognises a rotated rectangle', () => {
    const a = Math.PI / 6, rot = (x, y) => ({ x: 200 + x * Math.cos(a) - y * Math.sin(a), y: 200 + x * Math.sin(a) + y * Math.cos(a) });
    const shape = recognizeStroke(jitter(polyline(rot(-80, -40), rot(80, -40), rot(80, 40), rot(-80, 40), rot(-80, -38)), 1.5));
    expect(shape.kind).toBe('rect');
    expect(Math.abs(Math.abs(shape.angle) - a) < 0.08 || Math.abs(Math.abs(shape.angle) - (Math.PI / 2 - a)) < 0.08).toBe(true);
  });
  it('recognises ellipses and circles', () => {
    const oval = recognizeStroke(jitter(ellipse(100, 100, 90, 45), 2));
    expect(oval.kind).toBe('ellipse');
    expect(oval.width).toBeGreaterThan(160); expect(oval.height).toBeLessThan(110);
    const circle = recognizeStroke(jitter(ellipse(50, 50, 40, 37), 1.5));
    expect(circle.kind).toBe('ellipse');
    expect(circle.width).toBe(circle.height);
  });
  it('recognises a triangle', () => {
    const shape = recognizeStroke(jitter(polyline({ x: 100, y: 0 }, { x: 180, y: 120 }, { x: 20, y: 121 }, { x: 99, y: 3 }), 2));
    expect(shape.kind).toBe('triangle');
    expect(shape.vertices).toHaveLength(3);
  });
  it('recognises a one-stroke arrow and a line capped by a V', () => {
    const arrow = recognizeStroke(jitter(polyline({ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 180, y: -18 }), 1));
    expect(arrow).toMatchObject({ kind: 'arrow' });
    expect(arrow.to.x).toBeGreaterThan(190);
    const two = recognizeStrokes([{ points: jitter(line({ x: 0, y: 0 }, { x: 0, y: 200 }), 1) }, { points: polyline({ x: -15, y: 180 }, { x: 0, y: 201 }, { x: 15, y: 181 }) }]);
    expect(two).toMatchObject({ kind: 'arrow' });
    expect(two.to.y).toBeGreaterThan(190);
  });
  it('leaves scribbles unrecognised', () => {
    const scribble = Array.from({ length: 120 }, (_, i) => ({ x: i * 2, y: 40 * Math.sin(i / 3), p: 0.5 }));
    expect(recognizeStroke(scribble)).toBeNull();
    expect(recognizeStroke([{ x: 0, y: 0 }, { x: 3, y: 1 }])).toBeNull();
  });
  it('resamples to evenly spaced points', () => {
    const pts = resample(line({ x: 0, y: 0 }, { x: 100, y: 0 }, 3), 11);
    expect(pts).toHaveLength(11);
    pts.forEach((p, i) => expect(p.x).toBeCloseTo(i * 10, 5));
  });
});
