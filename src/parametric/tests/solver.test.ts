import { describe, expect, it } from 'vitest';
import type { SkConstraint, SkDimension, SkEntity } from '../src/model/types';
import { solveSketch, splineSignedDist } from '../src/sketch/solver';
import { SketchIndex, distanceToCurve } from '../src/sketch/geom';

const pt = (id: string, x: number, y: number): SkEntity => ({ id, t: 'point', x, y });
const line = (id: string, a: string, b: string): SkEntity => ({ id, t: 'line', a, b });
const dim = (id: string, type: SkDimension['type'], refs: string[], value: number, extra: Partial<SkDimension> = {}): SkDimension => ({
  id, type, refs, value, at: [0, 0], name: id, ...extra,
});
const value = (d: SkDimension) => Number(d.value);
const P = (ents: SkEntity[], id: string) => ents.find((e) => e.id === id) as { x: number; y: number };

function rectangle(): SkEntity[] {
  return [
    pt('p1', 0.3, -0.2), pt('p2', 9, 0.4), pt('p3', 10.5, 6), pt('p4', -0.4, 5),
    line('l1', 'p1', 'p2'), line('l2', 'p2', 'p3'), line('l3', 'p3', 'p4'), line('l4', 'p4', 'p1'),
  ];
}

describe('sketch solver', () => {
  it('fully defines a dimensioned rectangle anchored at the origin', () => {
    const ents = rectangle();
    const cons: SkConstraint[] = [
      { id: 'c1', type: 'horizontal', refs: ['l1'] },
      { id: 'c2', type: 'horizontal', refs: ['l3'] },
      { id: 'c3', type: 'vertical', refs: ['l2'] },
      { id: 'c4', type: 'vertical', refs: ['l4'] },
      { id: 'c5', type: 'coincident', refs: ['p1', 'O'] },
      dim('d1', 'distance', ['l1'], 30),
      dim('d2', 'distance', ['l2'], 20),
    ];
    const res = solveSketch(ents, cons, { value });
    expect(res.converged).toBe(true);
    expect(res.status).toBe('full');
    expect(res.dof).toBe(0);
    expect(P(ents, 'p1').x).toBeCloseTo(0, 9);
    expect(P(ents, 'p3').x).toBeCloseTo(30, 9);
    expect(P(ents, 'p3').y).toBeCloseTo(20, 9);
    expect(res.freeEntities.size).toBe(0);
  });

  it('reports remaining degrees of freedom when under defined', () => {
    const ents = rectangle();
    const cons: SkConstraint[] = [
      { id: 'c1', type: 'horizontal', refs: ['l1'] },
      { id: 'c2', type: 'horizontal', refs: ['l3'] },
      { id: 'c3', type: 'vertical', refs: ['l2'] },
      { id: 'c4', type: 'vertical', refs: ['l4'] },
    ];
    const res = solveSketch(ents, cons, { value });
    expect(res.status).toBe('under');
    expect(res.dof).toBe(4);
    expect(res.freeEntities.has('l1')).toBe(true);
  });

  it('flags a redundant relation as over defined and blames the later one', () => {
    const ents = rectangle();
    const cons: SkConstraint[] = [
      { id: 'c1', type: 'horizontal', refs: ['l1'] },
      { id: 'c2', type: 'horizontal', refs: ['l3'] },
      { id: 'c3', type: 'vertical', refs: ['l2'] },
      { id: 'c4', type: 'vertical', refs: ['l4'] },
      { id: 'c5', type: 'parallel', refs: ['l1', 'l3'] },
    ];
    const res = solveSketch(ents, cons, { value });
    expect(res.status).toBe('over');
    expect(res.badConstraints.has('c5')).toBe(true);
    expect(res.badConstraints.has('c1')).toBe(false);
  });

  it('detects conflicting dimensions', () => {
    const ents = [pt('a', 0, 0), pt('b', 10, 0), line('l', 'a', 'b')];
    const cons: SkConstraint[] = [
      { id: 'c1', type: 'coincident', refs: ['a', 'O'] },
      { id: 'c2', type: 'horizontal', refs: ['l'] },
      dim('d1', 'distance', ['l'], 10),
      dim('d2', 'hdistance', ['a', 'b'], 25),
    ];
    const res = solveSketch(ents, cons, { value });
    expect(res.status).toBe('over');
    expect(res.badConstraints.size).toBeGreaterThan(0);
  });

  it('solves tangency between a line and a circle', () => {
    const ents: SkEntity[] = [
      pt('c', 0, 0), { id: 'circ', t: 'circle', c: 'c', r: 5 },
      pt('a', -10, 7), pt('b', 10, 7.5), line('l', 'a', 'b'),
    ];
    const cons: SkConstraint[] = [
      { id: 'c1', type: 'coincident', refs: ['c', 'O'] },
      { id: 't', type: 'tangent', refs: ['l', 'circ'] },
      { id: 'h', type: 'horizontal', refs: ['l'] },
      dim('r', 'radius', ['circ'], 4),
    ];
    const res = solveSketch(ents, cons, { value });
    expect(res.converged).toBe(true);
    expect(Math.abs(P(ents, 'a').y)).toBeCloseTo(4, 7);
  });

  it('keeps arc end points on the arc and honours radius', () => {
    const ents: SkEntity[] = [pt('c', 0, 0), pt('a', 5, 0), pt('b', 0, 6), { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'b' }];
    const cons: SkConstraint[] = [dim('r', 'radius', ['arc'], 8), { id: 'f', type: 'fix', refs: ['c'] }];
    const res = solveSketch(ents, cons, { value });
    expect(res.converged).toBe(true);
    const a = P(ents, 'a'), b = P(ents, 'b');
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(8, 7);
    expect(Math.hypot(b.x, b.y)).toBeCloseTo(8, 7);
  });

  it('drags an under-defined point while keeping relations', () => {
    const ents = [pt('a', 0, 0), pt('b', 10, 0), line('l', 'a', 'b')];
    const cons: SkConstraint[] = [{ id: 'c1', type: 'coincident', refs: ['a', 'O'] }, { id: 'h', type: 'horizontal', refs: ['l'] }];
    const res = solveSketch(ents, cons, { value, drag: { kind: 'points', ids: ['b'], targets: [[20, 3]] } });
    expect(res.converged).toBe(true);
    // The line must stay horizontal, so the point lands as close as possible.
    expect(P(ents, 'b').y).toBeCloseTo(0, 7);
    expect(P(ents, 'b').x).toBeGreaterThan(10);
  });

  it('solves angle, perpendicular, equal and midpoint relations together', () => {
    const ents: SkEntity[] = [
      pt('a', 0, 0), pt('b', 9, 1), line('l1', 'a', 'b'),
      pt('c', 1, 0.5), pt('d', 2, 8), line('l2', 'c', 'd'),
      pt('m', 4, 1),
    ];
    const cons: SkConstraint[] = [
      { id: 'o', type: 'coincident', refs: ['a', 'O'] },
      dim('ang', 'angle', ['l1'], 30),
      { id: 'pp', type: 'perpendicular', refs: ['l1', 'l2'] },
      { id: 'eq', type: 'equal', refs: ['l1', 'l2'] },
      { id: 'mid', type: 'midpoint', refs: ['m', 'l1'] },
      { id: 'cc', type: 'coincident', refs: ['c', 'b'] },
      dim('len', 'distance', ['l1'], 10),
    ];
    const res = solveSketch(ents, cons, { value });
    expect(res.converged).toBe(true);
    const b = P(ents, 'b');
    expect(Math.atan2(b.y, b.x) * 180 / Math.PI).toBeCloseTo(30, 6);
    const d = P(ents, 'd');
    expect(Math.hypot(d.x - b.x, d.y - b.y)).toBeCloseTo(10, 6);
    const m = P(ents, 'm');
    expect(m.x).toBeCloseTo(b.x / 2, 7);
    expect(res.status).toBe('full');
  });

  it('enforces symmetry about a centerline', () => {
    const ents: SkEntity[] = [
      pt('a', 0, -10), pt('b', 0, 10), { id: 'axis', t: 'line', a: 'a', b: 'b', construction: true },
      pt('p', -3, 2), pt('q', 5, 4),
    ];
    const cons: SkConstraint[] = [
      { id: 'v', type: 'vertical', refs: ['axis'] },
      { id: 'o', type: 'coincident', refs: ['a', 'O'] },
      { id: 's', type: 'symmetric', refs: ['p', 'q', 'axis'] },
    ];
    const res = solveSketch(ents, cons, { value });
    expect(res.converged).toBe(true);
    const p = P(ents, 'p'), q = P(ents, 'q');
    expect(p.x).toBeCloseTo(-q.x, 7);
    expect(p.y).toBeCloseTo(q.y, 7);
  });

  it('keeps the geometry when a dimension value overflows the solver', () => {
    const ents = [pt('a', -15, -9), pt('b', 15, -3), line('l', 'a', 'b')];
    const res = solveSketch(ents, [dim('d', 'hdistance', ['l'], 1e300)], { value });
    expect(res.status).toBe('over');
    expect([P(ents, 'a').x, P(ents, 'a').y, P(ents, 'b').x, P(ents, 'b').y]).toEqual([-15, -9, 15, -3]);
  });

  it('keeps a point coincident with a spline on the spline', () => {
    const ents: SkEntity[] = [
      pt('s0', 0, 0), pt('s1', 10, 6), pt('s2', 20, -2), pt('s3', 30, 4),
      { id: 'sp', t: 'spline', pts: ['s0', 's1', 's2', 's3'] },
      pt('q', 14, 3),
    ];
    const cons: SkConstraint[] = [
      { id: 'f', type: 'fix', refs: ['s0', 's1', 's2', 's3'] },
      { id: 'c', type: 'coincident', refs: ['q', 'sp'] },
    ];
    const onSpline = () => distanceToCurve(new SketchIndex(ents), ents[4] as never, [P(ents, 'q').x, P(ents, 'q').y]).d;
    let res = solveSketch(ents, cons, { value });
    expect(res.converged).toBe(true);
    expect(res.dof).toBe(1);
    expect(res.badConstraints.size).toBe(0);
    expect(onSpline()).toBeLessThan(1e-3);
    // Moving a spline point drags the coincident point along with the curve.
    cons.shift();
    const s1 = P(ents, 's1');
    res = solveSketch(ents, cons, { value, drag: { kind: 'points', ids: ['s1'], targets: [[s1.x, s1.y + 8]] } });
    expect(res.converged).toBe(true);
    expect(P(ents, 's1').y).toBeCloseTo(14, 6);
    expect(onSpline()).toBeLessThan(1e-3);
    expect(Math.abs(splineSignedDist([P(ents, 'q').x, P(ents, 'q').y], ['s0', 's1', 's2', 's3'].map((id) => [P(ents, id).x, P(ents, id).y])))).toBeLessThan(1e-9);
  });

  it('measures a signed distance to a spline that is smooth past its ends', () => {
    const pts: [number, number][] = [[0, 0], [10, 0]];
    expect(splineSignedDist([5, 2], pts)).toBeCloseTo(2, 9);
    expect(splineSignedDist([5, -3], pts)).toBeCloseTo(-3, 9);
    expect(splineSignedDist([15, 1], pts)).toBeCloseTo(1, 9);
  });

  it('solves a large chained sketch quickly', () => {
    const ents: SkEntity[] = [];
    const cons: SkConstraint[] = [];
    const N = 120;
    for (let i = 0; i <= N; i++) ents.push(pt(`p${i}`, i * 1.1, (i % 2) * 0.3));
    for (let i = 0; i < N; i++) {
      ents.push(line(`l${i}`, `p${i}`, `p${i + 1}`));
      cons.push({ id: `h${i}`, type: 'horizontal', refs: [`l${i}`] });
      cons.push(dim(`d${i}`, 'distance', [`l${i}`], 2));
    }
    cons.push({ id: 'o', type: 'coincident', refs: ['p0', 'O'] });
    const t0 = performance.now();
    const res = solveSketch(ents, cons, { value });
    const ms = performance.now() - t0;
    expect(res.converged).toBe(true);
    expect(res.status).toBe('full');
    expect(P(ents, `p${N}`).x).toBeCloseTo(2 * N, 6);
    expect(ms).toBeLessThan(1500);
  });

  it('solves one long connected chain without a dense factorization', () => {
    const ents: SkEntity[] = [];
    const cons: SkConstraint[] = [];
    const N = 400;
    for (let i = 0; i <= N; i++) ents.push(pt(`p${i}`, i * 1.1, (i % 2) * 0.3));
    for (let i = 0; i < N; i++) {
      ents.push(line(`l${i}`, `p${i}`, `p${i + 1}`));
      cons.push({ id: `h${i}`, type: i % 2 ? 'horizontal' : 'vertical', refs: [`l${i}`] });
      cons.push(dim(`d${i}`, 'distance', [`l${i}`], 2));
    }
    cons.push({ id: 'o', type: 'coincident', refs: ['p0', 'O'] });
    const t0 = performance.now();
    const res = solveSketch(ents, cons, { value });
    const ms = performance.now() - t0;
    expect(res.status).toBe('full');
    expect(P(ents, `p${N}`).x).toBeCloseTo(N, 6);
    expect(P(ents, `p${N}`).y).toBeCloseTo(N, 6);
    // About 250 ms with a dense m x m Cholesky and 15 ms within the envelope
    // on a fast machine. Timings vary too much on shared CI runners to tell
    // the two apart, so this is only a sanity bound, like the test above.
    expect(ms).toBeLessThan(1500);
  });
});
