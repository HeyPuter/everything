import { describe, expect, it, vi } from 'vitest';
import type { SkConstraint, SkDimension, SkEntity } from '../src/model/types';
import { SketchSystem, solveSketch, splineSignedDist } from '../src/sketch/solver';
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

  it('keeps a shape that a conflicting relation cannot be added to, and blames only that relation', () => {
    const ents: SkEntity[] = [
      pt('p1', 0, 0), pt('p2', 20, 0), pt('p3', 20, 10), pt('p4', 0, 10),
      line('l1', 'p1', 'p2'), line('l2', 'p2', 'p3'), line('l3', 'p3', 'p4'), line('l4', 'p4', 'p1'),
      // A separate shape whose dimension changed still solves.
      pt('q1', 40, 0), pt('q2', 45, 0), line('m', 'q1', 'q2'),
    ];
    const cons: SkConstraint[] = [
      { id: 'h1', type: 'horizontal', refs: ['l1'] }, { id: 'h2', type: 'horizontal', refs: ['l3'] },
      { id: 'v1', type: 'vertical', refs: ['l2'] }, { id: 'v2', type: 'vertical', refs: ['l4'] },
      { id: 'o', type: 'coincident', refs: ['p1', 'O'] },
      dim('w', 'distance', ['l1'], 20), dim('h', 'distance', ['l2'], 10),
      { id: 'eq', type: 'equal', refs: ['l1', 'l2'] },
      dim('m', 'distance', ['m'], 8),
    ];
    const res = solveSketch(ents, cons, { value });
    expect(res.status).toBe('over');
    // It made the rectangle 16.7 by 13.3, a compromise that also blamed both dimensions.
    expect([...res.conflicting]).toEqual(['eq']);
    expect(['p1', 'p2', 'p3', 'p4'].map((id) => [P(ents, id).x, P(ents, id).y])).toEqual([[0, 0], [20, 0], [20, 10], [0, 10]]);
    expect(Math.hypot(P(ents, 'q2').x - P(ents, 'q1').x, P(ents, 'q2').y - P(ents, 'q1').y)).toBeCloseTo(8, 9);
    // Nor does dragging it pull it into that compromise.
    const drag = solveSketch(ents, cons, { value, drag: { kind: 'points', ids: ['p3'], targets: [[25, 14]] }, analyze: false });
    expect([...drag.conflicting]).toEqual(['eq']);
    expect(['p1', 'p2', 'p3', 'p4'].map((id) => [P(ents, id).x, P(ents, id).y])).toEqual([[0, 0], [20, 0], [20, 10], [0, 10]]);
  });

  it('solves a conflicting angle directly instead of stepping towards it', () => {
    const ents: SkEntity[] = [pt('a', 0, 0), pt('b', 10, 0), line('l1', 'a', 'b'), pt('c', 0, 0), pt('d', 0, 8), line('l2', 'c', 'd')];
    const cons: SkConstraint[] = [
      { id: 'f', type: 'fix', refs: ['l1'] },
      { id: 'cc', type: 'coincident', refs: ['c', 'a'] },
      { id: 'pp', type: 'perpendicular', refs: ['l1', 'l2'] },
      dim('ang', 'angle', ['l1', 'l2'], 30),
    ];
    const solveAll = vi.spyOn(SketchSystem.prototype as unknown as { solveAll(n: number): boolean }, 'solveAll');
    try {
      const res = solveSketch(ents, cons, { value });
      expect(res.status).toBe('over');
      expect(res.conflicting.size).toBeGreaterThan(0);
      // One failed step, then the direct solve: not all sixteen steps.
      expect(solveAll.mock.calls.length).toBeLessThan(5);
    } finally {
      solveAll.mockRestore();
    }
  });

  it('evaluates each driving dimension once per solve, dragging included', () => {
    const ents = rectangle();
    const cons: SkConstraint[] = [
      { id: 'c1', type: 'horizontal', refs: ['l1'] },
      { id: 'c3', type: 'vertical', refs: ['l2'] },
      dim('d1', 'distance', ['l1'], 30),
      dim('d2', 'distance', ['l2'], 20),
      dim('d3', 'distance', ['l3'], 25, { driven: true }),
    ];
    // An expression value re-evaluates every variable it uses: evaluating it in
    // each residual and Jacobian column made drag frames many times slower.
    const calls = new Map<string, number>();
    const counted = (d: SkDimension) => { calls.set(d.id, (calls.get(d.id) ?? 0) + 1); return value(d); };
    solveSketch(ents, cons, { value: counted });
    expect(Object.fromEntries(calls)).toEqual({ d1: 1, d2: 1 });
    calls.clear();
    solveSketch(ents, cons, { value: counted, drag: { kind: 'points', ids: ['p3'], targets: [[50, 40]] }, analyze: false });
    expect(Object.fromEntries(calls)).toEqual({ d1: 1, d2: 1 });
    expect(Math.hypot(P(ents, 'p2').x - P(ents, 'p1').x, P(ents, 'p2').y - P(ents, 'p1').y)).toBeCloseTo(30, 6);
  });

  it('reports a dimension whose value does not resolve as a conflict and solves the rest', () => {
    const ents = rectangle();
    const cons: SkConstraint[] = [
      { id: 'c1', type: 'horizontal', refs: ['l1'] },
      { id: 'c2', type: 'horizontal', refs: ['l3'] },
      { id: 'c3', type: 'vertical', refs: ['l2'] },
      { id: 'c4', type: 'vertical', refs: ['l4'] },
      dim('d1', 'distance', ['l1'], 30),
      dim('d2', 'distance', ['l2'], NaN),
    ];
    const res = solveSketch(ents, cons, { value });
    expect(res.status).toBe('over');
    expect([...res.conflicting]).toEqual(['d2']);
    expect(P(ents, 'p2').x - P(ents, 'p1').x).toBeCloseTo(30, 6);
    expect(P(ents, 'p1').y).toBeCloseTo(P(ents, 'p2').y, 9);
    expect(ents.every((e) => e.t !== 'point' || (Number.isFinite(e.x) && Number.isFinite(e.y)))).toBe(true);
  });

  it('turns a free line to a much larger angle without stretching it', () => {
    for (const [v, sector] of [[90, 0], [150, 0], [180, 0], [5, 0], [170, 1]] as const) {
      const ents: SkEntity[] = [pt('a', 0, 0), pt('b', 10, 0), line('l1', 'a', 'b'), pt('c', 0, 0), pt('d', 8, 5), line('l2', 'c', 'd')];
      const cons: SkConstraint[] = [
        { id: 'f', type: 'fix', refs: ['l1'] },
        { id: 'cc', type: 'coincident', refs: ['c', 'a'] },
        dim('ang', 'angle', ['l1', 'l2'], v, { sector }),
      ];
      const before = Math.hypot(8, 5);
      const res = solveSketch(ents, cons, { value });
      expect(res.converged).toBe(true);
      expect(res.status).toBe('under');
      const d = P(ents, 'd');
      // Solved in one step, 150 degrees landed the end three times as far out.
      expect(Math.hypot(d.x, d.y) / before).toBeGreaterThan(0.9);
      expect(Math.hypot(d.x, d.y) / before).toBeLessThan(1.25);
      const ang = (Math.abs(Math.atan2(d.y, d.x)) * 180) / Math.PI;
      expect(sector ? 180 - ang : ang).toBeCloseTo(v, 6);
    }
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

  it.each([false, true])('makes two lines symmetric end to nearer end (drawn the same way %s)', (sameWay) => {
    const ents: SkEntity[] = [
      pt('a', 0, -20), pt('b', 0, 20), { id: 'axis', t: 'line', a: 'a', b: 'b', construction: true },
      pt('p0', -10, 0), pt('p1', -5, 5), line('l1', 'p0', 'p1'),
      // The mirror image of l1 is (10, 0)-(5, 5), drawn either way round.
      pt('q0', sameWay ? 5 : 10.5, sameWay ? 5 : 0.3), pt('q1', sameWay ? 10.5 : 5, sameWay ? 0.3 : 5), line('l2', 'q0', 'q1'),
    ];
    const cons: SkConstraint[] = [
      { id: 'v', type: 'vertical', refs: ['axis'] },
      { id: 'o', type: 'coincident', refs: ['a', 'O'] },
      { id: 's', type: 'symmetric', refs: ['l1', 'l2', 'axis'] },
    ];
    const res = solveSketch(ents, cons, { value });
    expect(res.converged).toBe(true);
    expect(res.badConstraints.size).toBe(0);
    // The lines stay where they were drawn instead of folding onto the axis.
    const [near, far] = sameWay ? ['q0', 'q1'] : ['q1', 'q0'];
    expect(P(ents, far).x).toBeCloseTo(-P(ents, 'p0').x, 7);
    expect(P(ents, near).x).toBeCloseTo(-P(ents, 'p1').x, 7);
    expect(P(ents, far).x).toBeGreaterThan(9);
    expect(P(ents, near).x).toBeLessThan(6);
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

  it('orders a cluster so the factorisation stays narrow whatever order constraints were added in', () => {
    const ents: SkEntity[] = [];
    const cons: SkConstraint[] = [];
    const N = 600;
    for (let i = 0; i < N; i++) ents.push(pt(`p${i}`, 40 * Math.cos((i / N) * 2 * Math.PI), 40 * Math.sin((i / N) * 2 * Math.PI)));
    for (let i = 0; i < N; i++) ents.push(line(`l${i}`, `p${i}`, `p${(i + 1) % N}`));
    for (let i = 0; i < N; i += 2) cons.push({ id: `e${i}`, type: 'equal', refs: [`l${i}`, `l${i + 1}`] });
    for (let i = 0; i < N; i += 4) cons.push({ id: `h${i}`, type: 'horizontal', refs: [`l${i}`] });
    cons.reverse();
    const sys = new SketchSystem(ents, cons, { value });
    const clusters = (sys as unknown as { clusters(): { eqs: { vars: number[] }[] }[] }).clusters();
    expect(clusters).toHaveLength(1);
    // Rows of J J^T reach back to the first earlier row sharing a variable; the
    // Cholesky factor fills everything in between. In the order added (equal
    // relations, then horizontals) that reached across the whole chain, and a
    // drag frame of 2000 such lines took over a second.
    const eqs = clusters[0].eqs;
    const seen = new Map<number, number>();
    let envelope = 0;
    eqs.forEach((eq, i) => {
      let first = i;
      for (const v of eq.vars) first = Math.min(first, seen.get(v) ?? i);
      for (const v of eq.vars) if (!seen.has(v)) seen.set(v, i);
      envelope += i - first;
    });
    expect(envelope).toBeLessThan(10 * eqs.length);
    const res = solveSketch(ents, cons, { value, drag: { kind: 'points', ids: ['p1'], targets: [[41, 3]] }, analyze: false });
    expect(res.converged).toBe(true);
  });

  it('analyses separate shapes each on their own, with the same verdicts', () => {
    const shape = (k: number, extra: SkConstraint[] = []) => {
      const ents = rectangle().map((e) => (e.t === 'point' ? { ...e, id: `${e.id}_${k}`, x: e.x + 40 * k } : e.t === 'line' ? { ...e, id: `${e.id}_${k}`, a: `${e.a}_${k}`, b: `${e.b}_${k}` } : e));
      const cons: SkConstraint[] = [
        { id: `h1_${k}`, type: 'horizontal', refs: [`l1_${k}`] }, { id: `h2_${k}`, type: 'horizontal', refs: [`l3_${k}`] },
        { id: `v1_${k}`, type: 'vertical', refs: [`l2_${k}`] }, { id: `v2_${k}`, type: 'vertical', refs: [`l4_${k}`] },
        ...extra,
      ];
      return { ents, cons };
    };
    // Fully defined and fixed; with a redundant length; free to move.
    const a = shape(0, [{ id: 'fix0', type: 'fix', refs: ['p1_0'] }, dim('w0', 'distance', ['l1_0'], 30), dim('t0', 'distance', ['l2_0'], 20)]);
    const b = shape(1, [dim('w1', 'distance', ['l1_1'], 30), dim('w1b', 'distance', ['l3_1'], 30)]);
    const c = shape(2);
    const ents = [...a.ents, ...b.ents, ...c.ents, pt('q', 200, 5)];
    // A dimension between two fixed things holds nothing either.
    const cons = [...a.cons, ...b.cons, ...c.cons, { id: 'fixq', type: 'fix', refs: ['q'] } as SkConstraint, dim('qq', 'distance', ['q', 'p1_0'], Math.hypot(200, 5))];
    const res = solveSketch(ents, cons, { value });
    expect([...res.badConstraints].sort()).toEqual(['qq', 'w1b']);
    expect(res.dof).toBe(3 + 4);
    expect(['l1_0', 'l2_0', 'l3_0', 'l4_0', 'q'].some((id) => res.freeEntities.has(id))).toBe(false);
    expect(['l1_1', 'l2_1', 'l1_2', 'p3_2'].every((id) => res.freeEntities.has(id))).toBe(true);
    // Many separate shapes: each edit of such a sketch analysed rows as wide
    // as the whole sketch (over 800 ms for 1200 rectangles on a fast machine).
    const many: SkEntity[] = [], manyCons: SkConstraint[] = [];
    for (let k = 0; k < 1200; k++) { const s = shape(k, [dim(`w${k}`, 'distance', [`l1_${k}`], 30)]); many.push(...s.ents); manyCons.push(...s.cons); }
    const t0 = performance.now();
    const big = solveSketch(many, manyCons, { value });
    const ms = performance.now() - t0;
    expect(big.dof).toBe(1200 * 3);
    expect(ms).toBeLessThan(4000);
  });

  it('keeps memory for a large connected cluster in proportion to its size', () => {
    const ents: SkEntity[] = [];
    const cons: SkConstraint[] = [];
    const N = 1000;
    for (let i = 0; i <= N; i++) ents.push(pt(`p${i}`, i * 1.1, (i % 2) * 0.3));
    for (let i = 0; i < N; i++) {
      ents.push(line(`l${i}`, `p${i}`, `p${i + 1}`));
      cons.push({ id: `h${i}`, type: 'horizontal', refs: [`l${i}`] }, dim(`d${i}`, 'distance', [`l${i}`], 2));
    }
    // A full m x m J J^T for this one cluster of 2000 equations is 4 million
    // numbers; 35000 such lines took over a minute to drag and tens of gigabytes.
    const Native = globalThis.Float64Array;
    let largest = 0;
    globalThis.Float64Array = new Proxy(Native, {
      construct(target, args: unknown[]) {
        if (typeof args[0] === 'number') largest = Math.max(largest, args[0]);
        return Reflect.construct(target, args);
      },
    });
    try {
      const res = solveSketch(ents, cons, { value, drag: { kind: 'points', ids: [`p${N}`], targets: [[3000, 5]] }, analyze: false });
      expect(res.converged).toBe(true);
    } finally {
      globalThis.Float64Array = Native;
    }
    expect(P(ents, `p${N}`).x - P(ents, 'p0').x).toBeCloseTo(2 * N, 6);
    expect(largest).toBeLessThan(50 * 2 * N);
  });

  it('analyses a long dimensioned chain without filling the reduced rows', () => {
    const ents: SkEntity[] = [];
    const cons: SkConstraint[] = [];
    const N = 600;
    for (let i = 0; i <= N; i++) ents.push(pt(`p${i}`, i * 2, 0));
    for (let i = 0; i < N; i++) {
      ents.push(line(`l${i}`, `p${i}`, `p${i + 1}`));
      cons.push({ id: `h${i}`, type: 'horizontal', refs: [`l${i}`] }, dim(`d${i}`, 'distance', [`l${i}`], 2));
    }
    cons.push({ id: 'twice', type: 'horizontal', refs: ['p0', `p${N}`] });
    // Dense rows as wide as the cluster, filled in by every pivot: 1.4 million
    // numbers here, and seconds per edit for 2000 lines.
    const Native = globalThis.Float64Array;
    let total = 0;
    globalThis.Float64Array = new Proxy(Native, {
      construct(target, args: unknown[]) {
        if (typeof args[0] === 'number') total += args[0];
        return Reflect.construct(target, args);
      },
    });
    let res: ReturnType<typeof solveSketch>;
    try {
      res = solveSketch(ents, cons, { value });
    } finally {
      globalThis.Float64Array = Native;
    }
    // The horizontal chain already holds the end points level.
    expect([...res.badConstraints]).toEqual(['twice']);
    expect(res.dof).toBe(2);
    expect(res.freeEntities.size).toBe(ents.length);
    expect(total).toBeLessThan(20 * 2 * N);
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
