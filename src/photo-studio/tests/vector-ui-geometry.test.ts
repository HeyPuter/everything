import { describe, expect, it } from 'vitest';
import {
  rectKnots, ellipseKnots, polygonKnots, triangleKnots, lineKnots, closedPath, insertKnot, segment, cubicAt,
  commandsToPaths, parseSvgPath, fitPath, componentAt, deleteKnots, dragSegment, nearestSegment, hitAnchor,
  maskToSvg, autoSmooth, corner, reverseSubPath, smoothKnot, fitRadii, resample, flatten, type Pt,
} from '../src/features/vector/geometry';
import { builtinShapes, customShapePaths, shapeFromMask } from '../src/features/vector/custom-shapes';
import { validateVectorMask, vectorBounds, type VectorMask } from '../src/model/vector';

const bounds = (paths: VectorMask['paths']) => vectorBounds({ paths })!;
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('shape builders', () => {
  it('builds sharp and rounded rectangles with exact bounds', () => {
    const sharp = rectKnots(10, 20, 100, 50);
    expect(sharp).toHaveLength(4);
    expect(sharp.every((k) => !k.linked)).toBe(true);
    const b = bounds([closedPath(sharp)]);
    expect(b).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    const round = rectKnots(10, 20, 100, 50, [10, 0, 20, 5]);
    expect(round).toHaveLength(4 + 3);
    const rb = bounds([closedPath(round)]);
    close(rb.x, 10); close(rb.y, 20); close(rb.width, 100); close(rb.height, 50);
    validateVectorMask({ paths: [closedPath(round)] });
  });
  it('scales radii like CSS so adjacent corners never overlap', () => {
    expect(fitRadii(100, 50, [100, 100, 0, 0])).toEqual([50, 50, 0, 0]);
    // A full pill: the two tangent points of each short side merge into one knot.
    const pill = rectKnots(0, 0, 100, 50, [25, 25, 25, 25]);
    const b = bounds([closedPath(pill)]);
    close(b.width, 100); close(b.height, 50);
    expect(pill.length).toBe(6);
  });
  it('approximates ellipses within 0.03% of the radius', () => {
    const k = ellipseKnots(0, 0, 200, 100);
    const p = closedPath(k);
    for (let i = 0; i < 4; i++)
      for (let t = 0; t <= 1; t += 0.1) {
        const [x, y] = cubicAt(segment(p, i), t);
        const r = Math.hypot((x - 100) / 100, (y - 50) / 50);
        expect(Math.abs(r - 1)).toBeLessThan(3e-4);
      }
    expect(bounds([p])).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });
  it('fits polygons and stars to their box', () => {
    const hex = polygonKnots(0, 0, 120, 80, 6);
    expect(hex).toHaveLength(6);
    const b = bounds([closedPath(hex)]);
    close(b.width, 120); close(b.height, 80);
    const st = polygonKnots(5, 5, 100, 100, 5, 0.5);
    expect(st).toHaveLength(10);
    const sb = bounds([closedPath(st)]);
    close(sb.x, 5); close(sb.y, 5); close(sb.width, 100); close(sb.height, 100);
    // Rounded corners keep the shape inside the box.
    const rounded = bounds([closedPath(polygonKnots(0, 0, 100, 100, 5, 0, 10))]);
    expect(rounded.x).toBeGreaterThanOrEqual(-1e-9);
    expect(rounded.width).toBeLessThanOrEqual(100 + 1e-9);
    expect(triangleKnots(0, 0, 10, 10)).toHaveLength(3);
  });
  it('outlines lines with optional arrowheads', () => {
    const plain = lineKnots(0, 0, 100, 0, 4);
    expect(bounds([closedPath(plain)])).toEqual({ x: 0, y: -2, width: 100, height: 4 });
    const arrow = lineKnots(0, 0, 100, 0, 4, { end: true, width: 5, length: 5 });
    const b = bounds([closedPath(arrow)]);
    close(b.height, 20); close(b.width, 100);
    const both = lineKnots(0, 0, 100, 0, 2, { start: true, end: true, width: 4, length: 6, concavity: 0.3 });
    validateVectorMask({ paths: [closedPath(both)] });
    expect(both.length).toBe(10);
  });
});

describe('path editing', () => {
  it('inserts a knot without changing the curve', () => {
    const p = closedPath(ellipseKnots(0, 0, 100, 100));
    const before = segment(p, 1);
    const at = cubicAt(before, 0.3);
    const i = insertKnot(p, 1, 0.3);
    expect(p.knots).toHaveLength(5);
    close(p.knots[i].points[2], at[0]);
    close(p.knots[i].points[3], at[1]);
    // The two halves trace the original curve.
    const mid = cubicAt(before, 0.15), half = cubicAt(segment(p, 1), 0.5);
    close(mid[0], half[0], 1e-9); close(mid[1], half[1], 1e-9);
    expect(smoothKnot(p.knots[i])).toBe(true);
  });
  it('drags a curve point by exactly the pointer delta', () => {
    const c: [Pt, Pt, Pt, Pt] = [[0, 0], [30, -40], [70, -40], [100, 0]];
    for (const t of [0.2, 0.5, 0.8]) {
      const [c1, c2] = dragSegment(c, t, 7, -3);
      const before = cubicAt(c, t), after = cubicAt([c[0], c1, c2, c[3]], t);
      close(after[0] - before[0], 7, 1e-9);
      close(after[1] - before[1], -3, 1e-9);
    }
  });
  it('deletes knots and drops degenerate subpaths, keeping component operations', () => {
    const m: VectorMask = {
      paths: [
        { ...closedPath([corner(0, 0), corner(10, 0)]), operation: 'subtract' },
        { open: false, fillRule: 'non-zero', knots: rectKnots(0, 0, 5, 5) },
      ],
    };
    deleteKnots(m, [{ path: 0, knot: 0 }]);
    expect(m.paths).toHaveLength(1);
    expect(m.paths[0].operation).toBe('subtract');
  });
  it('hit tests anchors and segments', () => {
    const m: VectorMask = { paths: [closedPath(rectKnots(0, 0, 100, 100))] };
    expect(hitAnchor(m, 101, 99, 3)).toEqual({ path: 0, knot: 2 });
    expect(hitAnchor(m, 50, 50, 3)).toBeUndefined();
    const s = nearestSegment(m, 50, 2)!;
    expect(s.segment).toBe(0);
    close(s.distance, 2);
    close(s.t, 0.5);
  });
  it('hit tests straight segments away from their middle', () => {
    // A rectangle edge clicked a third of the way along is on the path.
    const m: VectorMask = { paths: [closedPath(rectKnots(0, 0, 300, 300))] };
    const s = nearestSegment(m, 100, 0)!;
    expect(s.segment).toBe(0);
    close(s.distance, 0);
    close(s.point[0], 100);
    close(s.point[1], 0);
    // The parameter puts an inserted anchor where the edge was clicked.
    const k = insertKnot(m.paths[0], s.segment, s.t);
    close(m.paths[0].knots[k].points[2], 100);
    close(m.paths[0].knots[k].points[3], 0);
    const near = nearestSegment({ paths: [closedPath(rectKnots(0, 0, 300, 300))] }, 3, 250)!;
    close(near.distance, 3);
    close(near.point[1], 250);
  });
  it('finds filled components with holes', () => {
    const ring = builtinShapes.find((s) => s.id === 'ring')!;
    const m: VectorMask = { paths: customShapePaths(ring, 0, 0, 100, 100) };
    expect(m.paths).toHaveLength(2);
    expect(m.paths[1].operation).toBeUndefined();
    expect(componentAt(m, 10, 50)).toBe(0);
    expect(componentAt(m, 50, 50)).toBeUndefined();
  });
  it('reverses subpaths and auto-smooths curvature points', () => {
    const p = { open: true, fillRule: 'non-zero' as const, knots: [corner(0, 0), corner(50, 50), corner(100, 0)] };
    p.knots.forEach((k) => (k.linked = true));
    autoSmooth(p);
    const mid = p.knots[1];
    // The middle tangent is horizontal (parallel to the chord of its neighbours).
    close(mid.points[1], 50); close(mid.points[5], 50);
    expect(smoothKnot(mid)).toBe(true);
    reverseSubPath(p);
    expect(p.knots[0].points[2]).toBe(100);
  });
});

describe('path data', () => {
  it('parses absolute and relative SVG commands', () => {
    const cmds = parseSvgPath('M10 10 h20 v20 H10 z m5 5 c1 1 2 2 3 3 s 4 4 5 5 q1 1 2 2 t3 3');
    expect(cmds[0]).toEqual(['M', 10, 10]);
    expect(cmds[1]).toEqual(['L', 30, 10]);
    expect(cmds[2]).toEqual(['L', 30, 30]);
    expect(cmds[5]).toEqual(['M', 15, 15]);
    expect(cmds[6]).toEqual(['C', 16, 16, 17, 17, 18, 18]);
    expect(cmds[7]).toEqual(['C', 19, 19, 22, 22, 23, 23]);
  });
  it('converts commands to knots, merging the closing point', () => {
    const paths = commandsToPaths([['M', 0, 0], ['L', 10, 0], ['Q', 10, 10, 0, 10], ['L', 0, 0], ['Z']]);
    expect(paths).toHaveLength(1);
    expect(paths[0].open).toBe(false);
    expect(paths[0].knots).toHaveLength(3);
    // Quadratic controls become exact 2/3 cubic controls.
    close(paths[0].knots[1].points[4], 10); close(paths[0].knots[1].points[5], 20 / 3);
    const svg = maskToSvg({ paths });
    expect(svg.startsWith('M0 0L10 0C')).toBe(true);
  });
  it('round-trips a custom shape through the 100-unit grid', () => {
    const heart = builtinShapes.find((s) => s.id === 'heart')!;
    const paths = customShapePaths(heart, 200, 300, 50, 50);
    const d = shapeFromMask({ paths })!;
    const again = customShapePaths({ id: 'x', name: 'x', d }, 200, 300, 50, 50);
    expect(again[0].knots.length).toBe(paths[0].knots.length);
    for (let i = 0; i < paths[0].knots.length; i++)
      for (let j = 0; j < 6; j++) close(again[0].knots[i].points[j], paths[0].knots[i].points[j], 1e-2);
  });
  it('builds every custom shape as a valid mask filling its box', () => {
    expect(builtinShapes.length).toBeGreaterThanOrEqual(20);
    for (const s of builtinShapes) {
      const paths = customShapePaths(s, 0, 0, 80, 60);
      validateVectorMask({ paths });
      const b = bounds(paths);
      close(b.width, 80, 1e-6); close(b.height, 60, 1e-6);
    }
  });
});

describe('curve fitting', () => {
  it('fits a sampled circle with few smooth knots within tolerance', () => {
    const pts: Pt[] = [];
    for (let i = 0; i < 400; i++) pts.push([100 + Math.cos((i / 400) * Math.PI * 2) * 60, 100 + Math.sin((i / 400) * Math.PI * 2) * 60]);
    const p = fitPath(pts, 1, true)!;
    expect(p.open).toBe(false);
    expect(p.knots.length).toBeLessThanOrEqual(8);
    expect(p.knots.every((k) => k.linked)).toBe(true);
    for (const q of flatten(p, 0.25)) expect(Math.abs(Math.hypot(q[0] - 100, q[1] - 100) - 60)).toBeLessThan(1.5);
  });
  it('keeps the corners of a pixel staircase square as straight sides', () => {
    const sq: Pt[] = [[10, 10], [60, 10], [60, 60], [10, 60]];
    const p = fitPath(sq, 2, true)!;
    expect(p.knots).toHaveLength(4);
    const b = bounds([p]);
    close(b.x, 10, 0.6); close(b.width, 50, 1.2);
    for (const k of p.knots) expect(k.points[0] === k.points[2] && k.points[4] === k.points[2]).toBe(true);
  });
  it('fits a hand-drawn open wave without clustered end knots', () => {
    const pts: Pt[] = [];
    for (let i = 0; i <= 60; i++) pts.push([80 + i * 5, 120 + Math.sin(i / 6) * 40 + (i % 2 ? 0.4 : -0.4)]);
    const p = fitPath(pts, 2, false, { spacing: 1.5 })!;
    expect(p.open).toBe(true);
    for (let i = 1; i < p.knots.length; i++) {
      const a = p.knots[i - 1].points, b = p.knots[i].points;
      expect(Math.hypot(a[2] - b[2], a[3] - b[3])).toBeGreaterThan(8);
    }
    expect(p.knots.length).toBeLessThanOrEqual(10);
    // No spurious corners: every interior knot is smooth.
    expect(p.knots.slice(1, -1).every((k) => k.linked)).toBe(true);
  });
  it('resamples polylines at uniform spacing', () => {
    const r = resample([[0, 0], [10, 0]], 2.5);
    expect(r.map((p) => p[0])).toEqual([0, 2.5, 5, 7.5, 10]);
  });
});
