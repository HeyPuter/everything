import { describe, expect, it } from 'vitest';
import type { SkDimension, SkEntity, SkLine, SketchFeature } from '../src/model/types';
import { ORIGIN_ID, SketchIndex, arcAngles, arcRadius, distanceToCurve } from '../src/sketch/geom';
import {
  availableRelations, deleteItems, extendAt, filletCorner, idFactory, makeRelations, measureDimension, mirrorEntities,
  offsetCurves, pickMirrorAxis, relationsOf, smartDimension, trimAt,
} from '../src/sketch/ops';
import { solveSketch } from '../src/sketch/solver';
import { buildProfiles } from '../src/sketch/profiles';
import { rect, sketch } from './helpers';

const sk = (entities: SkEntity[]): SketchFeature => sketch('S', entities);
const value = (d: SkDimension) => Number(d.value);

describe('relations', () => {
  it('offers relations that fit the selection', () => {
    const s = sk([...rect(0, 0, 10, 5, 'r'), { id: 'c0', t: 'point', x: 2, y: 2 }, { id: 'circ', t: 'circle', c: 'c0', r: 1 }]);
    expect(availableRelations(s, ['rl0'])).toEqual(['horizontal', 'vertical', 'fix']);
    expect(availableRelations(s, ['rl0', 'rl1'])).toContain('perpendicular');
    expect(availableRelations(s, ['rl0', 'circ'])).toContain('tangent');
    expect(availableRelations(s, ['rp0', 'rl1'])).toEqual(['coincident', 'midpoint', 'fix']);
    expect(availableRelations(s, ['O'])).toEqual([]);
  });

  it.each([['axis', 'l1', 'l2'], ['l1', 'axis', 'l2'], ['l1', 'l2', 'axis'], ['axis', 'p', 'q'], ['p', 'axis', 'q']])('makes %s, %s, %s symmetric about the centerline whatever the selection order', (...ids) => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: -20 }, { id: 'b', t: 'point', x: 0, y: 20 }, { id: 'axis', t: 'line', a: 'a', b: 'b', construction: true },
      { id: 'p0', t: 'point', x: -10, y: 0 }, { id: 'p1', t: 'point', x: -5, y: 5 }, { id: 'l1', t: 'line', a: 'p0', b: 'p1' },
      { id: 'q0', t: 'point', x: 10, y: 0 }, { id: 'q1', t: 'point', x: 5, y: 5 }, { id: 'l2', t: 'line', a: 'q0', b: 'q1' },
      { id: 'p', t: 'point', x: -3, y: 9 }, { id: 'q', t: 'point', x: 3, y: 9 },
    ]);
    expect(availableRelations(s, ids)).toContain('symmetric');
    const [rel] = makeRelations(s, 'symmetric', ids, idFactory(s));
    expect(rel.refs[2]).toBe('axis');
    expect([...rel.refs].sort()).toEqual([...ids].sort());
  });

  it('offers a point on a spline, which the solver keeps there', () => {
    const s = sk([
      { id: 's0', t: 'point', x: 0, y: 0 }, { id: 's1', t: 'point', x: 10, y: 6 }, { id: 's2', t: 'point', x: 20, y: 0 },
      { id: 'sp', t: 'spline', pts: ['s0', 's1', 's2'] }, { id: 'q', t: 'point', x: 9, y: 2 },
    ]);
    expect(availableRelations(s, ['q', 'sp'])).toEqual(['coincident', 'fix']);
    expect(availableRelations(s, ['s1', 'sp'])).toEqual(['fix']);
    s.constraints.push(...makeRelations(s, 'coincident', ['q', 'sp'], idFactory(s)));
    expect(solveSketch(s.entities, s.constraints, { value }).badConstraints.size).toBe(0);
    const ix = new SketchIndex(s.entities);
    expect(distanceToCurve(ix, ix.get('sp') as never, ix.pt('q')).d).toBeLessThan(1e-3);
  });

  it('creates one horizontal relation per line and solves them', () => {
    const s = sk([{ id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 5, y: 1 }, { id: 'l1', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 0, y: 3 }, { id: 'd', t: 'point', x: 5, y: 2 }, { id: 'l2', t: 'line', a: 'c', b: 'd' }]);
    const rels = makeRelations(s, 'horizontal', ['l1', 'l2'], idFactory(s));
    expect(rels).toHaveLength(2);
    s.constraints.push(...rels);
    solveSketch(s.entities, s.constraints, { value });
    const ix = new SketchIndex(s.entities);
    expect(ix.pt('a')[1]).toBeCloseTo(ix.pt('b')[1], 9);
    expect(relationsOf(s, ['l1'])).toHaveLength(1);
  });
});

describe('deletion', () => {
  it('removes curves with their orphan points and dependent relations', () => {
    const s = sk(rect(0, 0, 10, 5, 'r'));
    s.constraints.push({ id: 'h', type: 'horizontal', refs: ['rl0'] });
    deleteItems(s, ['rl0']);
    expect(s.entities.find((e) => e.id === 'rl0')).toBeUndefined();
    // End points are still used by the neighbouring lines.
    expect(s.entities.find((e) => e.id === 'rp0')).toBeDefined();
    expect(s.constraints).toHaveLength(0);
    deleteItems(s, ['rp0']);
    expect(s.entities.some((e) => e.t === 'line' && (e.a === 'rp0' || e.b === 'rp0'))).toBe(false);
  });
});

describe('dimensions', () => {
  const splineSketch = () => sk([
    { id: 'a', t: 'point', x: 20, y: 30 }, { id: 'b', t: 'point', x: 40, y: 30 }, { id: 'c', t: 'point', x: 60, y: 30 },
    { id: 'sp', t: 'spline', pts: ['a', 'b', 'c'] }, { id: 'sp2', t: 'spline', pts: ['a', 'c'] },
    { id: 'l', t: 'line', a: 'a', b: 'c' }, { id: 'circle', t: 'circle', c: 'a', r: 5 },
    { id: 'd', t: 'point', x: 20, y: 50 }, { id: 'arc', t: 'arc', c: 'a', a: 'b', b: 'd' },
  ]);

  it.each(['a', ORIGIN_ID, 'l', 'circle', 'arc', 'sp2'])('rejects unsupported spline dimensions paired with %s in either order', (other) => {
    const s = splineSketch();
    for (const ids of [['sp', other], [other, 'sp']]) expect(smartDimension(s, ids, [80, 50])).toBeNull();
  });

  it('still dimensions the points of a spline', () => {
    const s = splineSketch();
    expect(smartDimension(s, ['a', 'b'], [30, 50])).toMatchObject({ type: 'hdistance', refs: ['a', 'b'], value: 20 });
    expect(smartDimension(s, ['sp'], [80, 50])).toBeNull();
  });

  it('chooses horizontal, vertical or aligned by label placement', () => {
    const s = sk([{ id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 10, y: 5 }, { id: 'l', t: 'line', a: 'a', b: 'b' }]);
    expect(smartDimension(s, ['l'], [5, 20])?.type).toBe('hdistance');
    expect(smartDimension(s, ['l'], [20, 2])?.type).toBe('vdistance');
    const aligned = smartDimension(s, ['l'], [5, 2]);
    expect(aligned?.type).toBe('distance');
    expect(aligned?.value).toBeCloseTo(Math.hypot(10, 5), 9);
  });

  it('measures angles between lines and diameters of circles', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 10, y: 0 }, { id: 'l1', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 0, y: 0 }, { id: 'd', t: 'point', x: 5, y: 5 }, { id: 'l2', t: 'line', a: 'c', b: 'd' },
      { id: 'cc', t: 'point', x: 20, y: 0 }, { id: 'circ', t: 'circle', c: 'cc', r: 3 },
    ]);
    const ang = smartDimension(s, ['l1', 'l2'], [4, 1])!;
    expect(ang.type).toBe('angle');
    expect(ang.value).toBeCloseTo(45, 9);
    const dia = smartDimension(s, ['circ'], [25, 3])!;
    expect(dia).toMatchObject({ type: 'diameter', value: 6 });
    expect(measureDimension(s, { type: 'distance', refs: ['circ', 'a'] })).toBeCloseTo(20, 9);
  });
});

describe('editing tools', () => {
  it.each(['line', 'arc'])('splitting a slot %s by trimming moves the far tangency to the new piece', (piece) => {
    const s = sk([
      { id: 'ca', t: 'point', x: 10, y: 5 }, { id: 'cb', t: 'point', x: 30, y: 5 },
      { id: 'p1', t: 'point', x: 10, y: 8 }, { id: 'p2', t: 'point', x: 10, y: 2 }, { id: 'q1', t: 'point', x: 30, y: 8 }, { id: 'q2', t: 'point', x: 30, y: 2 },
      { id: 'l1', t: 'line', a: 'p1', b: 'q1' }, { id: 'l2', t: 'line', a: 'q2', b: 'p2' },
      { id: 'arcB', t: 'arc', c: 'cb', a: 'q2', b: 'q1' }, { id: 'arcA', t: 'arc', c: 'ca', a: 'p1', b: 'p2' },
    ]);
    s.constraints.push(
      { id: 't1', type: 'tangent', refs: ['l1', 'arcA'] }, { id: 't2', type: 'tangent', refs: ['l1', 'arcB'] },
      { id: 't3', type: 'tangent', refs: ['l2', 'arcA'] }, { id: 't4', type: 'tangent', refs: ['l2', 'arcB'] },
      { id: 'eq', type: 'equal', refs: ['arcA', 'arcB'] },
    );
    // Two cutters across the piece, then a click between them.
    const cut = (id: string, a: [number, number], b: [number, number]) => s.entities.push(
      { id: `${id}a`, t: 'point', x: a[0], y: a[1] }, { id: `${id}b`, t: 'point', x: b[0], y: b[1] }, { id, t: 'line', a: `${id}a`, b: `${id}b` });
    if (piece === 'line') { cut('k1', [15, 0], [15, 12]); cut('k2', [25, 0], [25, 12]); } else { cut('k1', [0, 6], [8, 6]); cut('k2', [0, 4], [8, 4]); }
    const before = solveSketch(structuredClone(s.entities), s.constraints, { value });
    expect(before.badConstraints.size).toBe(0);
    const id = piece === 'line' ? 'l1' : 'arcA';
    expect(trimAt(s, id, piece === 'line' ? [20, 8] : [7, 5], idFactory(s))).toBe(true);
    const copy = s.entities.find((e) => (e.t === 'line' || e.t === 'arc') && e.id !== id && !['l1', 'l2', 'arcA', 'arcB', 'k1', 'k2'].includes(e.id))!;
    // The far end's tangent curve now refers to the piece that reaches it.
    const far = piece === 'line' ? 't2' : 't3';
    expect(s.constraints.find((c) => c.id === far)!.refs).toContain(copy.id);
    expect(s.constraints.find((c) => c.id === 't1')!.refs).toContain(id);
    const after = solveSketch(s.entities, s.constraints, { value });
    expect(after.badConstraints.size).toBe(0);
    expect(after.status).toBe('under');
  });

  it('trims a line between two crossing lines', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 10, y: 0 }, { id: 'h', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 3, y: -2 }, { id: 'd', t: 'point', x: 3, y: 2 }, { id: 'v1', t: 'line', a: 'c', b: 'd' },
      { id: 'e', t: 'point', x: 7, y: -2 }, { id: 'f', t: 'point', x: 7, y: 2 }, { id: 'v2', t: 'line', a: 'e', b: 'f' },
    ]);
    expect(trimAt(s, 'h', [5, 0], idFactory(s))).toBe(true);
    const lines = s.entities.filter((e): e is SkLine => e.t === 'line' && e.id !== 'v1' && e.id !== 'v2');
    expect(lines).toHaveLength(2);
    const ix = new SketchIndex(s.entities);
    const lengths = lines.map((l) => Math.abs(ix.pt(l.b)[0] - ix.pt(l.a)[0])).sort();
    expect(lengths[0]).toBeCloseTo(3, 9);
    expect(lengths[1]).toBeCloseTo(3, 9);
  });

  it.each([10, 1e6, 1e9])('trims one unit from either end of a line of length %s', (length) => {
    for (const atStart of [false, true]) for (const reverse of [false, true]) {
      const x = atStart ? 1 : length - 1;
      const s = sk([
        { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: length, y: 0 },
        { id: 'h', t: 'line', a: reverse ? 'b' : 'a', b: reverse ? 'a' : 'b' },
        { id: 'c', t: 'point', x, y: -2 }, { id: 'd', t: 'point', x, y: 2 }, { id: 'v', t: 'line', a: 'c', b: 'd' },
      ]);
      expect(trimAt(s, 'h', [atStart ? 0.5 : length - 0.5, 0], idFactory(s))).toBe(true);
      const line = s.entities.find((e) => e.id === 'h');
      expect(line?.t).toBe('line');
      if (line?.t !== 'line') throw new Error('Expected retained line');
      const ix = new SketchIndex(s.entities);
      const xs = [ix.pt(line.a)[0], ix.pt(line.b)[0]].sort((a, b) => a - b);
      expect(xs[0]).toBeCloseTo(atStart ? 1 : 0, 6);
      expect(xs[1]).toBeCloseTo(atStart ? length : length - 1, 6);
      expect(solveSketch(s.entities, s.constraints, { value }).status).toBe('under');
    }
  });

  it.each([10, 1e6, 1e9])('trims near either end of an arc of radius %s', (radius) => {
    for (const atStart of [false, true]) {
      const s = sk([
        { id: 'o', t: 'point', x: 0, y: 0 },
        { id: 'a', t: 'point', x: radius, y: 0 }, { id: 'b', t: 'point', x: 0, y: radius },
        { id: 'arc', t: 'arc', c: 'o', a: 'a', b: 'b' },
        { id: 'c', t: 'point', x: atStart ? radius - 2 : 1, y: atStart ? 1 : radius - 2 },
        { id: 'd', t: 'point', x: atStart ? radius + 2 : 1, y: atStart ? 1 : radius + 2 },
        { id: 'l', t: 'line', a: 'c', b: 'd' },
      ]);
      const angle = atStart ? 0.5 / radius : Math.PI / 2 - 0.5 / radius;
      expect(trimAt(s, 'arc', [radius * Math.cos(angle), radius * Math.sin(angle)], idFactory(s))).toBe(true);
      const arc = s.entities.find((e) => e.id === 'arc');
      expect(arc?.t).toBe('arc');
      if (arc?.t !== 'arc') throw new Error('Expected retained arc');
      const ix = new SketchIndex(s.entities), end = ix.pt(atStart ? arc.a : arc.b);
      expect(end[atStart ? 1 : 0]).toBeCloseTo(1, 6);
      expect(end[atStart ? 0 : 1]).toBeCloseTo(Math.sqrt(radius * radius - 1), 6);
      expect(atStart ? arc.b : arc.a).toBe(atStart ? 'b' : 'a');
      expect(solveSketch(s.entities, s.constraints, { value }).status).toBe('under');
    }
  });

  it('retains a valid near-end cut on a very short line', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 1e-4, y: 0 },
      { id: 'h', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 1e-8, y: -1 }, { id: 'd', t: 'point', x: 1e-8, y: 1 },
      { id: 'v', t: 'line', a: 'c', b: 'd' },
    ]);
    expect(trimAt(s, 'h', [0, 0], idFactory(s))).toBe(true);
    const line = s.entities.find((e) => e.id === 'h');
    expect(line?.t).toBe('line');
    if (line?.t !== 'line') throw new Error('Expected retained line');
    expect(new SketchIndex(s.entities).pt(line.a)[0]).toBeCloseTo(1e-8, 12);
  });

  it.each([10, 1e9])('ignores endpoint and out-of-segment cuts on a line of length %s', (length) => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: length, y: 0 },
      { id: 'h', t: 'line', a: 'a', b: 'b' },
      ...[-0.1, 0, length, length + 0.1].flatMap((x, i): SkEntity[] => [
        { id: `a${i}`, t: 'point', x, y: -1 }, { id: `b${i}`, t: 'point', x, y: 1 },
        { id: `l${i}`, t: 'line', a: `a${i}`, b: `b${i}` },
      ]),
    ]);
    expect(trimAt(s, 'h', [length / 2, 0], idFactory(s))).toBe(true);
    expect(s.entities.find((e) => e.id === 'h')).toBeUndefined();
    expect(s.entities.filter((e) => e.t === 'line')).toHaveLength(4);
  });

  it.each([10, 1e9])('does not delete a spline of length %s when partial trimming is unsupported', (length) => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: length, y: 0 },
      { id: 'spline', t: 'spline', pts: ['a', 'b'] },
      { id: 'c', t: 'point', x: 1, y: -1 }, { id: 'd', t: 'point', x: 1, y: 1 },
      { id: 'v', t: 'line', a: 'c', b: 'd' },
    ]);
    const before = structuredClone(s);
    expect(trimAt(s, 'spline', [0.5, 0], idFactory(s))).toBe(false);
    expect(s).toEqual(before);
  });

  it.each(['line', 'arc', 'circle'] as const)('leaves a %s unchanged when Trim clicks exactly on an interior cut', (type) => {
    const entities: SkEntity[] = [
      { id: 'o', t: 'point', x: 0, y: 0 },
      { id: 'a', t: 'point', x: 5, y: 0 }, { id: 'b', t: 'point', x: -5, y: 0 },
      { id: 'c', t: 'point', x: 0, y: -10 }, { id: 'd', t: 'point', x: 0, y: 10 },
      { id: 'cut', t: 'line', a: 'c', b: 'd' },
    ];
    if (type === 'line') entities.push({ id: 'target', t: 'line', a: 'a', b: 'b' });
    else if (type === 'arc') entities.push({ id: 'target', t: 'arc', c: 'o', a: 'a', b: 'b' });
    else entities.push({ id: 'target', t: 'circle', c: 'o', r: 5 });
    const s = sk(entities), before = structuredClone(s);
    expect(trimAt(s, 'target', [0, type === 'line' ? 0 : 5], idFactory(s))).toBe(false);
    expect(s).toEqual(before);
  });

  it('does not trim across an exact clicked cut between two other cuts', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 10, y: 0 },
      { id: 'h', t: 'line', a: 'a', b: 'b' },
      ...[3, 5, 7].flatMap((x, i): SkEntity[] => [
        { id: `a${i}`, t: 'point', x, y: -2 }, { id: `b${i}`, t: 'point', x, y: 2 },
        { id: `l${i}`, t: 'line', a: `a${i}`, b: `b${i}` },
      ]),
    ]);
    const before = structuredClone(s);
    expect(trimAt(s, 'h', [5, 0], idFactory(s))).toBe(false);
    expect(s).toEqual(before);
  });

  it.each([-1e-6, 1e-6])('still trims the clicked side just %s units from an intersection', (offset) => {
    const s = sk([
      { id: 'a', t: 'point', x: -5, y: 0 }, { id: 'b', t: 'point', x: 5, y: 0 },
      { id: 'h', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 0, y: -10 }, { id: 'd', t: 'point', x: 0, y: 10 },
      { id: 'cut', t: 'line', a: 'c', b: 'd' },
    ]);
    expect(trimAt(s, 'h', [offset, 0], idFactory(s))).toBe(true);
    const line = s.entities.find((e) => e.id === 'h');
    expect(line?.t).toBe('line');
    if (line?.t !== 'line') throw new Error('Expected retained line');
    const ix = new SketchIndex(s.entities);
    expect(ix.pt(line.a)[0]).toBe(offset < 0 ? 0 : -5);
    expect(ix.pt(line.b)[0]).toBe(offset < 0 ? 5 : 0);
  });

  it('keeps both pieces of a line split by trimming on one line', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 10, y: 0 }, { id: 'h', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 3, y: -2 }, { id: 'd', t: 'point', x: 3, y: 2 }, { id: 'v1', t: 'line', a: 'c', b: 'd' },
      { id: 'e', t: 'point', x: 7, y: -2 }, { id: 'f', t: 'point', x: 7, y: 2 }, { id: 'v2', t: 'line', a: 'e', b: 'f' },
    ]);
    s.constraints.push({ id: 'hz', type: 'horizontal', refs: ['h'] }, { id: 'o', type: 'coincident', refs: ['a', 'O'] });
    const before = solveSketch(s.entities, s.constraints, { value }).dof;
    expect(trimAt(s, 'h', [5, 0], idFactory(s))).toBe(true);
    // The far piece stays on the line of the original (it does not swing free).
    const res = solveSketch(s.entities, s.constraints, { value, drag: { kind: 'points', ids: ['b'], targets: [[12, 4]] } });
    expect(res.converged).toBe(true);
    expect(new SketchIndex(s.entities).pt('b')[1]).toBeCloseTo(0, 6);
    expect(solveSketch(s.entities, s.constraints, { value }).dof).toBe(before);
  });

  it('keeps both pieces of a split arc on one circle', () => {
    const s = sk([
      { id: 'o', t: 'point', x: 0, y: 0 }, { id: 'pa', t: 'point', x: 5, y: 0 }, { id: 'pb', t: 'point', x: -5, y: 0 },
      { id: 'arc', t: 'arc', c: 'o', a: 'pa', b: 'pb' },
      { id: 'c', t: 'point', x: -1, y: -8 }, { id: 'd', t: 'point', x: -1, y: 8 }, { id: 'v1', t: 'line', a: 'c', b: 'd' },
      { id: 'e', t: 'point', x: 1, y: -8 }, { id: 'f', t: 'point', x: 1, y: 8 }, { id: 'v2', t: 'line', a: 'e', b: 'f' },
    ]);
    expect(trimAt(s, 'arc', [0, 5], idFactory(s))).toBe(true);
    const res = solveSketch(s.entities, s.constraints, { value, drag: { kind: 'points', ids: ['pb'], targets: [[-8, 0]] } });
    expect(res.converged).toBe(true);
    const ix = new SketchIndex(s.entities);
    const arcs = s.entities.filter((e) => e.t === 'arc') as Parameters<typeof arcRadius>[1][];
    expect(arcs).toHaveLength(2);
    expect(arcRadius(ix, arcs[0])).toBeCloseTo(arcRadius(ix, arcs[1]), 6);
  });

  it('keeps a trimmed line trimmed and its new end on the cutting line', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 10, y: 0 }, { id: 'h', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 3, y: -2 }, { id: 'd', t: 'point', x: 3, y: 2 }, { id: 'v', t: 'line', a: 'c', b: 'd' },
    ]);
    s.constraints.push({ id: 'len', type: 'distance', refs: ['h'], value: 10, at: [5, -3], name: 'D1' });
    expect(trimAt(s, 'h', [8, 0], idFactory(s))).toBe(true);
    // The length dimension no longer applies, so solving does not undo the trim.
    expect(s.constraints.some((c) => c.id === 'len')).toBe(false);
    solveSketch(s.entities, s.constraints, { value });
    const h = s.entities.find((e) => e.id === 'h') as SkLine;
    expect(new SketchIndex(s.entities).pt(h.b)).toEqual([expect.closeTo(3, 9), expect.closeTo(0, 9)]);
    // Dragging the cutting line carries the trimmed end along.
    const res = solveSketch(s.entities, s.constraints, { value, drag: { kind: 'points', ids: ['c', 'd'], targets: [[5, -2], [5, 2]] } });
    expect(res.converged).toBe(true);
    expect(new SketchIndex(s.entities).pt(h.b)[0]).toBeCloseTo(5, 6);
  });

  it.each(['one tangent', 'split tangent', 'two tangent curves'])('counts a repeated circle intersection once with %s', (cutters) => {
    const entities: SkEntity[] = [
      { id: 'o', t: 'point', x: 0, y: 0 }, { id: 'circ', t: 'circle', c: 'o', r: 5 },
      { id: 'a', t: 'point', x: 5, y: -10 }, { id: 'b', t: 'point', x: 5, y: 0 },
      { id: 'd', t: 'point', x: 5, y: 10 }, { id: 'l', t: 'line', a: 'a', b: 'b' },
    ];
    if (cutters === 'split tangent') entities.push({ id: 'l2', t: 'line', a: 'b', b: 'd' });
    if (cutters === 'two tangent curves') entities.push(
      { id: 'o2', t: 'point', x: 10, y: 0 }, { id: 'circ2', t: 'circle', c: 'o2', r: 5 },
    );
    const s = sk(entities);
    expect(trimAt(s, 'circ', [-5, 0], idFactory(s))).toBe(true);
    // With only one distinct cut there is no separate arc to retain.
    expect(s.entities.find((e) => e.id === 'circ')).toBeUndefined();
    expect(s.entities.some((e) => e.t === 'arc')).toBe(false);
    expect(s.entities.find((e) => e.id === 'l')?.t).toBe('line');
  });

  it('merges roundoff-sized duplicate circle cuts across the angle seam', () => {
    const s = sk([
      { id: 'o', t: 'point', x: 0, y: 0 }, { id: 'circ', t: 'circle', c: 'o', r: 5 },
      ...[-4e-15, 4e-15].flatMap((y, i): SkEntity[] => [
        { id: `a${i}`, t: 'point', x: 4, y }, { id: `b${i}`, t: 'point', x: 6, y },
        { id: `l${i}`, t: 'line', a: `a${i}`, b: `b${i}` },
      ]),
    ]);
    expect(trimAt(s, 'circ', [-5, 0], idFactory(s))).toBe(true);
    expect(s.entities.find((e) => e.id === 'circ')).toBeUndefined();
  });

  it('retains the correct arc when both distinct circle cuts are reported twice', () => {
    const s = sk([
      { id: 'o', t: 'point', x: 0, y: 0 }, { id: 'circ', t: 'circle', c: 'o', r: 5 },
      { id: 'a', t: 'point', x: -10, y: 0 }, { id: 'b', t: 'point', x: 10, y: 0 },
      { id: 'l1', t: 'line', a: 'a', b: 'b' }, { id: 'l2', t: 'line', a: 'b', b: 'a' },
    ]);
    expect(trimAt(s, 'circ', [0, 5], idFactory(s))).toBe(true);
    const arc = s.entities.find((e) => e.id === 'circ');
    expect(arc?.t).toBe('arc');
    if (arc?.t !== 'arc') throw new Error('Expected trimmed arc');
    const ix = new SketchIndex(s.entities);
    expect(ix.pt(arc.a)[0]).toBeCloseTo(-5, 9);
    expect(ix.pt(arc.b)[0]).toBeCloseTo(5, 9);
    expect(s.constraints.filter((c) => c.type === 'coincident')).toHaveLength(2);
    expect(solveSketch(s.entities, s.constraints, { value }).status).toBe('under');
  });

  it('retains distinct cuts on a tiny circle', () => {
    const radius = 1e-8;
    const s = sk([
      { id: 'o', t: 'point', x: 0, y: 0 }, { id: 'circ', t: 'circle', c: 'o', r: radius },
      { id: 'a', t: 'point', x: -2 * radius, y: 0 }, { id: 'b', t: 'point', x: 2 * radius, y: 0 },
      { id: 'l', t: 'line', a: 'a', b: 'b' },
    ]);
    expect(trimAt(s, 'circ', [0, radius], idFactory(s))).toBe(true);
    const arc = s.entities.find((e) => e.id === 'circ');
    expect(arc?.t).toBe('arc');
    if (arc?.t !== 'arc') throw new Error('Expected trimmed arc');
    const ix = new SketchIndex(s.entities);
    expect(ix.pt(arc.a)[0]).toBeCloseTo(-radius, 15);
    expect(ix.pt(arc.b)[0]).toBeCloseTo(radius, 15);
  });

  it('retains close but physically distinct cuts on a large circle', () => {
    const radius = 1e9;
    const s = sk([
      { id: 'o', t: 'point', x: 0, y: 0 }, { id: 'circ', t: 'circle', c: 'o', r: radius },
      ...[-0.1, 0.1].flatMap((y, i): SkEntity[] => [
        { id: `a${i}`, t: 'point', x: radius - 1, y }, { id: `b${i}`, t: 'point', x: radius + 1, y },
        { id: `l${i}`, t: 'line', a: `a${i}`, b: `b${i}` },
      ]),
    ]);
    expect(trimAt(s, 'circ', [radius, 0], idFactory(s))).toBe(true);
    const arc = s.entities.find((e) => e.id === 'circ');
    expect(arc?.t).toBe('arc');
    if (arc?.t !== 'arc') throw new Error('Expected trimmed arc');
    const ix = new SketchIndex(s.entities);
    expect(ix.pt(arc.a)[1]).toBeCloseTo(0.1, 6);
    expect(ix.pt(arc.b)[1]).toBeCloseTo(-0.1, 6);
    expect(s.constraints.filter((c) => c.type === 'coincident')).toHaveLength(2);
  });

  it.each([10, 1e9])('trims a circle into an arc whose ends stay on a cutting line of half-length %s', (length) => {
    const s = sk([
      { id: 'o', t: 'point', x: 0, y: 0 }, { id: 'circ', t: 'circle', c: 'o', r: 5 },
      { id: 'c', t: 'point', x: -length, y: 3 }, { id: 'd', t: 'point', x: length, y: 3 }, { id: 'l', t: 'line', a: 'c', b: 'd' },
    ]);
    expect(trimAt(s, 'circ', [0, 5], idFactory(s))).toBe(true);
    const arc = s.entities.find((e) => e.id === 'circ')!;
    expect(arc.t).toBe('arc');
    expect(s.constraints.filter((c) => c.type === 'coincident' && c.refs[1] === 'l')).toHaveLength(2);
    expect(solveSketch(s.entities, s.constraints, { value }).status).toBe('under');
    if (arc.t !== 'arc') throw new Error('Expected trimmed arc');
    const ix = new SketchIndex(s.entities);
    const ends = [ix.pt(arc.a), ix.pt(arc.b)].sort((a, b) => a[0] - b[0]);
    expect(ends[0][0]).toBeCloseTo(-4, 6);
    expect(ends[1][0]).toBeCloseTo(4, 6);
    for (const point of ends) expect(point[1]).toBeCloseTo(3, 6);
  });

  it.each(['small', 'large'])('trims the %s circle at both intersections when radii differ greatly', (target) => {
    const s = sk([
      { id: 'o', t: 'point', x: 0, y: 0 }, { id: 'small', t: 'circle', c: 'o', r: 5 },
      { id: 'p', t: 'point', x: 1e9, y: 0 }, { id: 'large', t: 'circle', c: 'p', r: 1e9 },
    ]);
    expect(trimAt(s, target, [target === 'small' ? 5 : 0, 0], idFactory(s))).toBe(true);
    const arc = s.entities.find((e) => e.id === target);
    expect(arc?.t).toBe('arc');
    if (arc?.t !== 'arc') throw new Error('Expected trimmed arc');
    const ix = new SketchIndex(s.entities);
    const ends = [ix.pt(arc.a), ix.pt(arc.b)].sort((a, b) => a[1] - b[1]);
    for (const point of ends) expect(point[0]).toBeCloseTo(0, 6);
    expect(ends[0][1]).toBeCloseTo(-5, 6);
    expect(ends[1][1]).toBeCloseTo(5, 6);
    expect(s.constraints.filter((c) => c.type === 'coincident' && c.refs[1] === (target === 'small' ? 'large' : 'small'))).toHaveLength(2);
    expect(solveSketch(s.entities, s.constraints, { value }).status).toBe('under');
  });

  it.each([9, 1e6 + 9, 1e9])('extends a line to the next curve at x=%s', (x) => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 4, y: 0 }, { id: 'h', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x, y: -5 }, { id: 'd', t: 'point', x, y: 5 }, { id: 'v', t: 'line', a: 'c', b: 'd' },
    ]);
    s.constraints.push({ id: 'len', type: 'hdistance', refs: ['h'], value: 4, at: [2, -3], name: 'D1' });
    expect(extendAt(s, 'h', [3.9, 0])).toBe(true);
    expect(new SketchIndex(s.entities).pt('b')[0]).toBeCloseTo(x, 9);
    // The old length would pull the end back.
    expect(s.constraints).toHaveLength(0);
  });

  it.each([-0.0005, 0.0005])('only extends forward past an intersection %s from the endpoint', (offset) => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 4, y: 0 }, { id: 'h', t: 'line', a: 'a', b: 'b' },
      ...[4 + offset, 9].flatMap((x, i): SkEntity[] => [
        { id: `c${i}`, t: 'point', x, y: -5 }, { id: `d${i}`, t: 'point', x, y: 5 },
        { id: `v${i}`, t: 'line', a: `c${i}`, b: `d${i}` },
      ]),
    ]);
    expect(extendAt(s, 'h', [3.9, 0], idFactory(s))).toBe(true);
    expect(new SketchIndex(s.entities).pt('b')[0]).toBeCloseTo(offset > 0 ? 4 + offset : 9, 9);
    expect(s.constraints).toEqual([expect.objectContaining({ type: 'coincident', refs: ['b', offset > 0 ? 'v0' : 'v1'] })]);
  });

  it('leaves a line and its length dimension unchanged if every target is behind its end', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 4, y: 0 }, { id: 'h', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 3.9995, y: -5 }, { id: 'd', t: 'point', x: 3.9995, y: 5 }, { id: 'v', t: 'line', a: 'c', b: 'd' },
    ]);
    s.constraints.push({ id: 'len', type: 'hdistance', refs: ['h'], value: 4, at: [2, -3], name: 'D1' });
    const before = structuredClone(s);
    expect(extendAt(s, 'h', [3.9, 0], idFactory(s))).toBe(false);
    expect(s).toEqual(before);
  });

  it.each([-1, 1])('extends to the nearer side of a distant circle in direction %s', (direction) => {
    for (const reverse of [false, true]) {
      const s = sk([
        { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: direction * 4, y: 0 },
        { id: 'h', t: 'line', a: reverse ? 'b' : 'a', b: reverse ? 'a' : 'b' },
        { id: 'o', t: 'point', x: direction * 1e9, y: 0 }, { id: 'circ', t: 'circle', c: 'o', r: 5 },
      ]);
      expect(extendAt(s, 'h', [direction * 3.9, 0], idFactory(s))).toBe(true);
      expect(new SketchIndex(s.entities).pt('b')[0]).toBeCloseTo(direction * (1e9 - 5), 6);
      expect(new SketchIndex(s.entities).pt('a')).toEqual([0, 0]);
      expect(s.constraints).toEqual([expect.objectContaining({ type: 'coincident', refs: ['b', 'circ'] })]);
    }
  });

  it('keeps target segments and arcs bounded when extending the selected line', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 4, y: 0 }, { id: 'h', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 6, y: 1 }, { id: 'd', t: 'point', x: 6, y: 2 }, { id: 'miss', t: 'line', a: 'c', b: 'd' },
      { id: 'behind', t: 'circle', c: 'a', r: 3.9995 },
      { id: 'o', t: 'point', x: 10, y: 0 }, { id: 'aa', t: 'point', x: 10, y: -5 }, { id: 'ab', t: 'point', x: 10, y: 5 },
      { id: 'arc', t: 'arc', c: 'o', a: 'aa', b: 'ab' },
    ]);
    expect(extendAt(s, 'h', [3.9, 0], idFactory(s))).toBe(true);
    expect(new SketchIndex(s.entities).pt('b')).toEqual([15, 0]);
    expect(s.constraints).toEqual([expect.objectContaining({ type: 'coincident', refs: ['b', 'arc'] })]);
    expect(solveSketch(s.entities, s.constraints, { value }).converged).toBe(true);
  });

  it.each([[1, 1], [0, 1]])('extends a translated line far in direction %s,%s', (dx, dy) => {
    const origin = 1e9, x = origin + dx * 1e9, y = origin + dy * 1e9;
    const s = sk([
      { id: 'a', t: 'point', x: origin, y: origin }, { id: 'b', t: 'point', x: origin + 4 * dx, y: origin + 4 * dy },
      { id: 'h', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: x - dy * 10, y: y + dx * 10 }, { id: 'd', t: 'point', x: x + dy * 10, y: y - dx * 10 },
      { id: 'v', t: 'line', a: 'c', b: 'd' },
    ]);
    expect(extendAt(s, 'h', [origin + 3.9 * dx, origin + 3.9 * dy], idFactory(s))).toBe(true);
    expect(new SketchIndex(s.entities).pt('b')).toEqual([x, y]);
    expect(new SketchIndex(s.entities).pt('a')).toEqual([origin, origin]);
  });

  it('does not extend a collapsed line', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 4, y: 0 }, { id: 'b', t: 'point', x: 4, y: 0 }, { id: 'h', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 9, y: -5 }, { id: 'd', t: 'point', x: 9, y: 5 }, { id: 'v', t: 'line', a: 'c', b: 'd' },
    ]);
    const before = structuredClone(s);
    expect(extendAt(s, 'h', [4, 0], idFactory(s))).toBe(false);
    expect(s).toEqual(before);
  });

  it('keeps an extended line end on the curve it reached', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 4, y: 0 }, { id: 'h', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 9, y: -5 }, { id: 'd', t: 'point', x: 9, y: 5 }, { id: 'v', t: 'line', a: 'c', b: 'd' },
    ]);
    s.constraints.push({ id: 'hz', type: 'horizontal', refs: ['h'] }, { id: 'o', type: 'coincident', refs: ['a', 'O'] });
    expect(extendAt(s, 'h', [3.9, 0], idFactory(s))).toBe(true);
    // Moving the boundary line carries the extended end with it.
    const res = solveSketch(s.entities, s.constraints, { value, drag: { kind: 'points', ids: ['c', 'd'], targets: [[12, -5], [12, 5]] } });
    expect(res.converged).toBe(true);
    expect(new SketchIndex(s.entities).pt('b')[0]).toBeCloseTo(12, 6);
  });

  it('keeps a line extended or trimmed at a spline on the spline', () => {
    const spline = (): SkEntity[] => [
      { id: 's0', t: 'point', x: 9, y: -6 }, { id: 's1', t: 'point', x: 10, y: 0 }, { id: 's2', t: 'point', x: 9, y: 6 },
      { id: 'sp', t: 'spline', pts: ['s0', 's1', 's2'] },
    ];
    const onSpline = (s: SketchFeature, p: string) => {
      const ix = new SketchIndex(s.entities);
      return distanceToCurve(ix, ix.get('sp') as never, ix.pt(p)).d;
    };
    const ext = sk([{ id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 4, y: 0 }, { id: 'h', t: 'line', a: 'a', b: 'b' }, ...spline()]);
    ext.constraints.push({ id: 'hz', type: 'horizontal', refs: ['h'] }, { id: 'o', type: 'coincident', refs: ['a', 'O'] });
    expect(extendAt(ext, 'h', [3.9, 0], idFactory(ext))).toBe(true);
    expect(ext.constraints.some((c) => c.type === 'coincident' && c.refs.join() === 'b,sp')).toBe(true);
    // Bending the spline carries the extended end with it.
    let res = solveSketch(ext.entities, ext.constraints, { value, drag: { kind: 'points', ids: ['s1'], targets: [[14, 0]] } });
    expect(res.converged).toBe(true);
    expect(new SketchIndex(ext.entities).pt('b')[0]).toBeGreaterThan(12);
    expect(onSpline(ext, 'b')).toBeLessThan(1e-3);

    const tr = sk([{ id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 20, y: 0 }, { id: 'h', t: 'line', a: 'a', b: 'b' }, ...spline()]);
    expect(trimAt(tr, 'h', [15, 0], idFactory(tr))).toBe(true);
    const end = tr.constraints.find((c) => c.type === 'coincident' && c.refs[1] === 'sp')!.refs[0];
    res = solveSketch(tr.entities, tr.constraints, { value, drag: { kind: 'points', ids: ['s1'], targets: [[13, 0]] } });
    expect(res.converged).toBe(true);
    expect(onSpline(tr, end)).toBeLessThan(1e-3);
  });

  it('fillets a rectangle corner tangentially', () => {
    const s = sk(rect(0, 0, 20, 10, 'r'));
    expect(filletCorner(s, 'rp1', 3, idFactory(s))).toBeNull();
    expect(s.entities.some((e) => e.id === 'rp1')).toBe(false);
    const arc = s.entities.find((e) => e.t === 'arc');
    expect(arc).toBeDefined();
    const ix = new SketchIndex(s.entities);
    expect(arcRadius(ix, arc as never)).toBeCloseTo(3, 9);
    const res = solveSketch(s.entities, s.constraints, { value });
    expect(res.converged).toBe(true);
    expect(filletCorner(s, 'rp0', 50, idFactory(s))).toMatch(/too large/);
  });

  it.each(['circle', 'spline', 'arc'] as const)('keeps a fillet virtual corner shared with a %s at the line intersection', (other) => {
    const s = sk([
      { id: 'corner', t: 'point', x: 0, y: 0 }, { id: 'a', t: 'point', x: 10, y: 0 }, { id: 'b', t: 'point', x: 0, y: 10 },
      { id: 'h', t: 'line', a: 'corner', b: 'a' }, { id: 'v', t: 'line', a: 'b', b: 'corner' },
      ...(other === 'circle' ? [{ id: 'circle', t: 'circle', c: 'corner', r: 2 } as SkEntity] : other === 'spline' ? [
        { id: 'c', t: 'point', x: -5, y: -5 }, { id: 'spline', t: 'spline', pts: ['corner', 'c'] },
      ] as SkEntity[] : [
        { id: 'o', t: 'point', x: -5, y: 0 }, { id: 'c', t: 'point', x: -5, y: 5 },
        { id: 'arc', t: 'arc', c: 'o', a: 'corner', b: 'c' },
      ] as SkEntity[]),
    ]);
    s.constraints.push({ id: 'hz', type: 'horizontal', refs: ['h'] }, { id: 'vt', type: 'vertical', refs: ['v'] });
    expect(filletCorner(s, 'corner', 1, idFactory(s))).toBeNull();
    const result = solveSketch(s.entities, s.constraints, { value, drag: { kind: 'points', ids: ['corner'], targets: [[3, 4]] } });
    expect(result.converged).toBe(true);
    const ix = new SketchIndex(s.entities), h = ix.get('h') as SkLine, v = ix.get('v') as SkLine;
    expect(ix.pt('corner')[0]).toBeCloseTo(3, 6);
    expect(ix.pt('corner')[1]).toBeCloseTo(4, 6);
    expect(ix.pt(h.a)[1]).toBeCloseTo(ix.pt('corner')[1], 6);
    expect(ix.pt(v.a)[0]).toBeCloseTo(ix.pt('corner')[0], 6);
    const shared = ix.get(other);
    expect(shared?.t === 'circle' ? shared.c : shared?.t === 'spline' ? shared.pts[0] : shared?.t === 'arc' ? shared.a : null).toBe('corner');
    expect(ix.get('corner')?.construction).toBeFalsy();
    expect(s.constraints.filter((c) => c.type === 'coincident').map((c) => c.refs)).toEqual([['corner', 'h'], ['corner', 'v']]);
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])('preserves construction fillets for source flags %s,%s', (first, second) => {
    const s = sk([
      { id: 'corner', t: 'point', x: 0, y: 0 }, { id: 'a', t: 'point', x: 10, y: 0 }, { id: 'b', t: 'point', x: 0, y: 10 },
      { id: 'h', t: 'line', a: 'corner', b: 'a', construction: first },
      { id: 'v', t: 'line', a: 'b', b: 'corner', construction: second },
      { id: 'c', t: 'point', x: 1, y: 0 }, { id: 'd', t: 'point', x: 0, y: 1 }, { id: 'chord', t: 'line', a: 'c', b: 'd' },
    ]);
    expect(buildProfiles(s.entities).regions).toHaveLength(0);
    expect(filletCorner(s, 'corner', 1, idFactory(s))).toBeNull();
    // A construction fillet must not close an otherwise open solid profile.
    expect(buildProfiles(s.entities).regions).toHaveLength(first && second ? 0 : 1);
    expect(!!s.entities.find((e) => e.t === 'arc')?.construction).toBe(first && second);
    expect(s.entities.find((e) => e.id === 'h')?.construction).toBe(first);
    expect(s.entities.find((e) => e.id === 'v')?.construction).toBe(second);
    expect(solveSketch(s.entities, s.constraints, { value }).converged).toBe(true);
  });

  it('keeps a dimensioned rectangle in shape when a corner is filleted', () => {
    const s = sk(rect(0, 0, 50, 30, 'r'));
    s.constraints.push(
      { id: 'h0', type: 'horizontal', refs: ['rl0'] }, { id: 'h2', type: 'horizontal', refs: ['rl2'] },
      { id: 'v1', type: 'vertical', refs: ['rl1'] }, { id: 'v3', type: 'vertical', refs: ['rl3'] },
      { id: 'o', type: 'coincident', refs: ['rp0', 'O'] },
      { id: 'd1', type: 'distance', refs: ['rl0'], value: 50, at: [25, -5], name: 'D1' },
      { id: 'd2', type: 'vdistance', refs: ['rl1'], value: 30, at: [55, 15], name: 'D2' },
    );
    expect(filletCorner(s, 'rp2', 5, idFactory(s))).toBeNull();
    expect(filletCorner(s, 'rp0', 4, idFactory(s))).toBeNull();
    const res = solveSketch(s.entities, s.constraints, { value });
    expect(res.status).toBe('under');
    const ix = new SketchIndex(s.entities);
    // The dimensions now measure to the virtual sharps, which stay at the corners.
    expect(ix.pt('rp2')).toEqual([expect.closeTo(50, 9), expect.closeTo(30, 9)]);
    expect(ix.pt('rp0')).toEqual([expect.closeTo(0, 9), expect.closeTo(0, 9)]);
    expect(measureDimension(s, s.constraints.find((c) => c.id === 'd1') as SkDimension)).toBeCloseTo(50, 9);
    const arcs = s.entities.filter((e) => e.t === 'arc');
    expect(arcs.map((a) => arcRadius(ix, a as never)).sort()).toEqual([expect.closeTo(4, 9), expect.closeTo(5, 9)]);
  });

  it.each([false, true])('never folds a fillet back over its lines when a dimension shrinks (radius dimensioned: %s)', (radiusDim) => {
    const s = sk(rect(0, 0, 20, 10, 'r'));
    s.constraints.push(
      { id: 'h0', type: 'horizontal', refs: ['rl0'] }, { id: 'h2', type: 'horizontal', refs: ['rl2'] },
      { id: 'v1', type: 'vertical', refs: ['rl1'] }, { id: 'v3', type: 'vertical', refs: ['rl3'] },
      { id: 'o', type: 'coincident', refs: ['rp0', 'O'] },
      { id: 'd1', type: 'distance', refs: ['rl0'], value: 20, at: [10, -5], name: 'D1' },
      { id: 'd2', type: 'distance', refs: ['rl1'], value: 10, at: [25, 5], name: 'D2' },
    );
    for (const p of ['rp0', 'rp1', 'rp2', 'rp3']) expect(filletCorner(s, p, 3, idFactory(s))).toBeNull();
    if (radiusDim) for (const a of s.entities.filter((e) => e.t === 'arc')) s.constraints.push({ id: `R${a.id}`, type: 'radius', refs: [a.id], value: 3, at: [0, 0], name: `R${a.id}` });
    const width = s.constraints.find((c) => c.id === 'd1') as SkDimension;
    const bottom = () => { const ix = new SketchIndex(s.entities), l = ix.get('rl0') as SkLine; return [ix.pt(l.a)[0], ix.pt(l.b)[0]]; };
    // Room for the fillets: the bottom line shrinks and keeps its direction.
    width.value = 8;
    let res = solveSketch(s.entities, s.constraints, { value });
    expect(res.converged).toBe(true);
    expect(res.conflicting.size).toBe(0);
    const [x0, x1] = bottom();
    expect(x1 - x0).toBeGreaterThan(0);
    expect(x1).toBeLessThanOrEqual(8 + 1e-6);
    expect(measureDimension(s, width)).toBeCloseTo(8, 6);
    // No room: the conflict is reported and the shape is kept, not inverted.
    width.value = radiusDim ? 4 : 1;
    res = solveSketch(s.entities, s.constraints, { value });
    expect(res.converged).toBe(false);
    expect(res.status).toBe('over');
    expect(res.conflicting.has('d1')).toBe(true);
    expect(bottom()).toEqual([expect.closeTo(x0, 6), expect.closeTo(x1, 6)]);
  });

  for (const distance of [1, 1e6]) for (const reverse of [false, true]) it(`joins line/arc offsets at distance ${distance}, reverse traversal ${reverse}`, () => {
    const s = sk([
      { id: 'c', t: 'point', x: 0, y: 0 }, { id: 'a', t: 'point', x: 1, y: 0 }, { id: 'b', t: 'point', x: 0, y: 1 },
      { id: 'line', t: 'line', a: 'c', b: 'a' }, { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'b' },
    ]);
    const original = structuredClone(s.entities);
    const created = offsetCurves(s, reverse ? ['arc', 'line'] : ['line', 'arc'], reverse ? distance : -distance, idFactory(s));
    expect(created).toHaveLength(2);
    const ix = new SketchIndex(s.entities);
    const line = created.map((id) => ix.get(id)).find((e) => e?.t === 'line')!;
    const arc = created.map((id) => ix.get(id)).find((e) => e?.t === 'arc')!;
    expect([line.a, line.b]).toContain(arc.a);
    expect(ix.pt(arc.a)[0]).toBeCloseTo(Math.sqrt(1 + 2 * distance), 6);
    expect(ix.pt(arc.a)[1]).toBeCloseTo(-distance, 6);
    expect(arcRadius(ix, arc)).toBeCloseTo(1 + distance, 6);
    expect(s.entities.filter((e) => original.some((o) => o.id === e.id))).toEqual(original);
    expect(solveSketch(s.entities, s.constraints, { value }).converged).toBe(true);
  });

  for (const shape of ['semicircle', 'lens'] as const) for (const excess of [-0.01, 0, 0.5]) it(`handles ${shape} inward offset at its collapse distance plus ${excess}`, () => {
    const s = sk(shape === 'semicircle' ? [
      { id: 'c', t: 'point', x: 0, y: 0 }, { id: 'a', t: 'point', x: 5, y: 0 }, { id: 'b', t: 'point', x: -5, y: 0 },
      { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'b' }, { id: 'line', t: 'line', a: 'b', b: 'a' },
    ] : [
      { id: 'c', t: 'point', x: 3, y: 0 }, { id: 'd', t: 'point', x: -3, y: 0 },
      { id: 'a', t: 'point', x: 0, y: 4 }, { id: 'b', t: 'point', x: 0, y: -4 },
      { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'b' }, { id: 'arc2', t: 'arc', c: 'd', a: 'b', b: 'a' },
    ]);
    const original = structuredClone(s);
    const ids = s.entities.filter((e) => e.t !== 'point').map((e) => e.id);
    const distance = (shape === 'semicircle' ? 2.5 : 2) + excess;
    const made = offsetCurves(s, ids, -distance, idFactory(s));
    if (excess >= 0) {
      expect(made).toEqual([]);
      expect(s).toEqual(original);
    } else {
      expect(made).toHaveLength(2);
      const ix = new SketchIndex(s.entities);
      const curves = made.map((id) => ix.get(id)).filter((e) => e?.t === 'line' || e?.t === 'arc');
      expect(new Set(curves.flatMap((e) => [e.a, e.b])).size).toBe(2);
      expect(buildProfiles(s.entities.filter((e) => e.t === 'point' || made.includes(e.id))).regions).toHaveLength(1);
      expect(solveSketch(s.entities, s.constraints, { value }).converged).toBe(true);
    }
  });

  it('keeps a valid independent chain when another selected chain cannot be offset', () => {
    const s = sk([
      { id: 'c', t: 'point', x: 0, y: 0 }, { id: 'a', t: 'point', x: 5, y: 0 }, { id: 'b', t: 'point', x: -5, y: 0 },
      { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'b' }, { id: 'line', t: 'line', a: 'b', b: 'a' },
      { id: 'u', t: 'point', x: 20, y: 0 }, { id: 'v', t: 'point', x: 30, y: 0 },
      { id: 'independent', t: 'line', a: 'u', b: 'v' },
    ]);
    const original = structuredClone(s.entities);
    const made = offsetCurves(s, ['arc', 'line', 'independent'], -3, idFactory(s));
    expect(made).toHaveLength(1);
    const ix = new SketchIndex(s.entities), line = ix.get(made[0]) as SkLine;
    expect(ix.pt(line.a)).toEqual([20, -3]);
    expect(ix.pt(line.b)).toEqual([30, -3]);
    expect(s.entities).toHaveLength(original.length + 3);
    expect(s.entities.slice(0, original.length)).toEqual(original);
    expect(s.constraints).toEqual([expect.objectContaining({ type: 'parallel', refs: ['independent', line.id] })]);
  });

  it('preserves full-circle arcs when offsetting', () => {
    const s = sk([
      { id: 'c', t: 'point', x: 0, y: 0 }, { id: 'a', t: 'point', x: 5, y: 0 },
      { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'a' },
    ]);
    const made = offsetCurves(s, ['arc'], -1, idFactory(s));
    expect(made).toHaveLength(1);
    const ix = new SketchIndex(s.entities), arc = ix.get(made[0]);
    if (arc?.t !== 'arc') throw new Error('Missing offset arc');
    expect(arc.a).toBe(arc.b);
    expect(arcRadius(ix, arc)).toBeCloseTo(6, 9);
    expect(arcAngles(ix, arc).sweep).toBe(2 * Math.PI);
  });

  it('keeps an offset chain joined across collinear segments', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 5, y: 0 }, { id: 'c', t: 'point', x: 10, y: 0 },
      { id: 'l1', t: 'line', a: 'a', b: 'b' }, { id: 'l2', t: 'line', a: 'b', b: 'c' },
    ]);
    const made = offsetCurves(s, ['l1', 'l2'], 2, idFactory(s));
    expect(made).toHaveLength(2);
    const ix = new SketchIndex(s.entities), lines = made.map((id) => ix.get(id) as SkLine);
    expect(lines[0].b).toBe(lines[1].a);
    expect(ix.pt(lines[0].b)).toEqual([5, 2]);
  });

  it.each(['trim', 'extend'])('%s leaves an equal-sided polygon as it was', (op) => {
    const s = sk([{ id: 'c', t: 'point', x: 0, y: 0 }, { id: 'circ', t: 'circle', c: 'c', r: 20, construction: true }]);
    for (let i = 0; i < 6; i++) s.entities.push({ id: `v${i}`, t: 'point', x: 20 * Math.cos((i * Math.PI) / 3), y: 20 * Math.sin((i * Math.PI) / 3) });
    for (let i = 0; i < 6; i++) s.entities.push({ id: `l${i}`, t: 'line', a: `v${i}`, b: `v${(i + 1) % 6}` });
    for (let i = 0; i < 6; i++) s.constraints.push({ id: `k${i}`, type: 'coincident', refs: [`v${i}`, 'circ'] });
    s.constraints.push({ id: 'eq', type: 'equal', refs: ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'] });
    // A line across side l0 to trim it back to, or a short line inside to extend to l0.
    s.entities.push({ id: 'q0', t: 'point', x: 15, y: op === 'trim' ? -5 : 2 }, { id: 'q1', t: 'point', x: 15, y: op === 'trim' ? 30 : 6 }, { id: 'm', t: 'line', a: 'q0', b: 'q1' });
    if (op === 'extend') {
      // ...whose length is tied to another short line, which must not follow the extension.
      s.entities.push({ id: 'n0', t: 'point', x: 40, y: 0 }, { id: 'n1', t: 'point', x: 40, y: 4 }, { id: 'n', t: 'line', a: 'n0', b: 'n1' });
      s.constraints.push({ id: 'eqm', type: 'equal', refs: ['m', 'n'] });
    }
    solveSketch(s.entities, s.constraints, { value });
    const corners = () => ['v1', 'v2', 'v3', 'v4', 'v5', ...(op === 'extend' ? ['n0', 'n1'] : [])].map((id) => new SketchIndex(s.entities).pt(id).map((v) => Math.round(v * 1e6) / 1e6));
    const before = corners();
    expect(op === 'trim' ? trimAt(s, 'l0', [18, 3.5], idFactory(s)) : extendAt(s, 'm', [15, 5.5], idFactory(s))).toBe(true);
    const res = solveSketch(s.entities, s.constraints, { value });
    expect(res.badConstraints.size).toBe(0);
    expect(corners()).toEqual(before);
    // The changed line left the equal relation; the others still share it.
    expect(s.constraints.find((c) => c.id === 'eq')!.refs).toEqual(op === 'trim' ? ['l1', 'l2', 'l3', 'l4', 'l5'] : ['l0', 'l1', 'l2', 'l3', 'l4', 'l5']);
    expect(s.constraints.some((c) => c.id === 'eqm')).toBe(false);
  });

  it('fillets a corner that a construction diagonal also ends at, keeping the diagonal on the virtual sharp', () => {
    const s = sk([...rect(0, 0, 40, 30, 'r'), { id: 'c', t: 'point', x: 20, y: 15 },
      { id: 'd1', t: 'line', a: 'rp0', b: 'rp2', construction: true }, { id: 'd2', t: 'line', a: 'rp1', b: 'rp3', construction: true }]);
    s.constraints.push({ id: 'm', type: 'midpoint', refs: ['c', 'd1'] });
    expect(filletCorner(s, 'rp1', 4, idFactory(s))).toBeNull();
    expect(s.entities.find((e) => e.id === 'd2')).toMatchObject({ a: 'rp1', b: 'rp3' });
    expect(s.entities.filter((e) => e.t === 'arc')).toHaveLength(1);
    expect(solveSketch(s.entities, s.constraints, { value }).badConstraints.size).toBe(0);
  });

  it.each(['polygon', 'square'])('filleting corners of a %s keeps the shape its equal relation holds', (shape) => {
    const s = sk([]);
    const n = shape === 'polygon' ? 6 : 4;
    if (shape === 'polygon') {
      s.entities.push({ id: 'c', t: 'point', x: 0, y: 0 }, { id: 'circ', t: 'circle', c: 'c', r: 20, construction: true });
      for (let i = 0; i < n; i++) s.entities.push({ id: `v${i}`, t: 'point', x: 20 * Math.cos((i * 2 * Math.PI) / n), y: 20 * Math.sin((i * 2 * Math.PI) / n) });
      for (let i = 0; i < n; i++) s.constraints.push({ id: `k${i}`, type: 'coincident', refs: [`v${i}`, 'circ'] });
    } else {
      [[0, 0], [30, 0], [30, 30], [0, 30]].forEach(([x, y], i) => s.entities.push({ id: `v${i}`, t: 'point', x, y }));
      s.constraints.push({ id: 'h0', type: 'horizontal', refs: ['l0'] }, { id: 'h2', type: 'horizontal', refs: ['l2'] },
        { id: 'v1', type: 'vertical', refs: ['l1'] }, { id: 'v3', type: 'vertical', refs: ['l3'] });
    }
    for (let i = 0; i < n; i++) s.entities.push({ id: `l${i}`, t: 'line', a: `v${i}`, b: `v${(i + 1) % n}` });
    s.constraints.push({ id: 'eq', type: 'equal', refs: shape === 'polygon' ? ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'] : ['l0', 'l1'] });
    // A point held at the middle of a side stays there too.
    s.entities.push({ id: 'm', t: 'point', x: 0, y: 0 });
    s.constraints.push({ id: 'mid', type: 'midpoint', refs: ['m', 'l1'] });
    expect(solveSketch(s.entities, s.constraints, { value }).badConstraints.size).toBe(0);
    const at = (id: string) => new SketchIndex(s.entities).pt(id);
    const corners = () => Array.from({ length: n }, (_, i) => at(`v${i}`).map((v) => Math.round(v * 1e6) / 1e6));
    const before = corners(), mid = at('m');
    for (const corner of shape === 'polygon' ? ['v0', 'v3'] : ['v0', 'v1', 'v2', 'v3']) {
      expect(filletCorner(s, corner, 3, idFactory(s))).toBeNull();
      const res = solveSketch(s.entities, s.constraints, { value });
      expect(res.badConstraints.size).toBe(0);
      expect(res.converged).toBe(true);
    }
    // (A sharp no relation needs any more is removed.)
    corners().forEach((p, i) => { if (!Number.isNaN(p[0])) expect(p).toEqual(before[i]); });
    expect(corners().filter((p) => !Number.isNaN(p[0])).length).toBeGreaterThanOrEqual(n - 1);
    expect(at('m')[0]).toBeCloseTo(mid[0], 6);
    expect(at('m')[1]).toBeCloseTo(mid[1], 6);
  });

  it('offsets the outline of a box-selected center rectangle, not its construction diagonals', () => {
    const s = sk([...rect(0, 0, 40, 30, 'r'), { id: 'c', t: 'point', x: 20, y: 15 },
      { id: 'd1', t: 'line', a: 'rp0', b: 'rp2', construction: true }, { id: 'd2', t: 'line', a: 'rp1', b: 'rp3', construction: true }]);
    s.constraints.push({ id: 'm', type: 'midpoint', refs: ['c', 'd1'] });
    const all = s.entities.filter((e) => e.t !== 'point').map((e) => e.id);
    const made = offsetCurves(s, all, 2, idFactory(s));
    expect(made).toHaveLength(4);
    expect(made.every((id) => !(s.entities.find((e) => e.id === id) as SkLine).construction)).toBe(true);
    // Construction geometry offset on its own stays construction.
    const [diagonal] = offsetCurves(s, ['d1'], 2, idFactory(s));
    expect(s.entities.find((e) => e.id === diagonal)).toMatchObject({ t: 'line', construction: true });
  });

  it.each(['filleted rectangle', 'slot'])('offsets a %s without over-defining it, keeping the corners tangent', (shape) => {
    const s = sk(rect(0, 0, 40, 30, 'r'));
    s.constraints.push(...['rl0', 'rl2'].map((id) => ({ id: `h${id}`, type: 'horizontal' as const, refs: [id] })), ...['rl1', 'rl3'].map((id) => ({ id: `v${id}`, type: 'vertical' as const, refs: [id] })));
    if (shape === 'filleted rectangle') {
      for (const corner of ['rp0', 'rp1', 'rp2', 'rp3']) expect(filletCorner(s, corner, 5, idFactory(s))).toBeNull();
    } else {
      // Round both short sides fully: a slot of width 30.
      expect(filletCorner(s, 'rp1', 14.999, idFactory(s))).toBeNull();
      expect(filletCorner(s, 'rp2', 14.999, idFactory(s))).toBeNull();
      expect(filletCorner(s, 'rp3', 14.999, idFactory(s))).toBeNull();
      expect(filletCorner(s, 'rp0', 14.999, idFactory(s))).toBeNull();
    }
    const before = solveSketch(s.entities, s.constraints, { value });
    expect(before.badConstraints.size).toBe(0);
    const ids = s.entities.filter((e) => e.t !== 'point').map((e) => e.id);
    const made = offsetCurves(s, ids, 3, idFactory(s));
    expect(made).toHaveLength(8);
    const after = solveSketch(s.entities, s.constraints, { value });
    expect(after.badConstraints.size).toBe(0);
    expect(after.status).toBe('under');
    // Only the offset distance is new freedom.
    expect(after.dof).toBe(before.dof + 1);
    expect(s.constraints.filter((c) => c.type === 'tangent' && c.refs.every((r) => made.includes(r)))).toHaveLength(8);
  });

  it('offsets a closed rectangle outward', () => {
    const s = sk(rect(0, 0, 10, 10, 'r'));
    const created = offsetCurves(s, ['rl0', 'rl1', 'rl2', 'rl3'], 2, idFactory(s));
    expect(created).toHaveLength(4);
    const ix = new SketchIndex(s.entities);
    const xs = created.flatMap((id) => { const l = ix.get(id) as SkLine; return [ix.pt(l.a)[0], ix.pt(l.b)[0]]; });
    expect(Math.min(...xs)).toBeCloseTo(-2, 9);
    expect(Math.max(...xs)).toBeCloseTo(12, 9);
  });

  for (const origin of [0, 1e9, 1e10]) for (const clockwise of [false, true]) it(`keeps offset direction at origin ${origin}, clockwise ${clockwise}`, () => {
    for (const distance of [-1, 1]) {
      const s = sk(rect(origin, origin, origin + 10, origin + 6, 'r'));
      if (clockwise) for (const e of s.entities) if (e.t === 'line') [e.a, e.b] = [e.b, e.a];
      const created = offsetCurves(s, ['rl0', 'rl1', 'rl2', 'rl3'], distance, idFactory(s));
      expect(created).toHaveLength(4);
      const ix = new SketchIndex(s.entities);
      const points = created.flatMap((id) => { const l = ix.get(id) as SkLine; return [ix.pt(l.a), ix.pt(l.b)]; });
      expect(Math.min(...points.map((p) => p[0])) - origin).toBe(-distance);
      expect(Math.max(...points.map((p) => p[0])) - origin).toBe(10 + distance);
      expect(Math.min(...points.map((p) => p[1])) - origin).toBe(-distance);
      expect(Math.max(...points.map((p) => p[1])) - origin).toBe(6 + distance);
    }
  });

  it.each([0, 1e9])('keeps mixed arc/line offset direction at origin %s', (origin) => {
    for (const distance of [-1, 1]) {
      const s = sk([
        { id: 'c', t: 'point', x: origin, y: origin },
        { id: 'a', t: 'point', x: origin + 5, y: origin }, { id: 'b', t: 'point', x: origin - 5, y: origin },
        { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'b' }, { id: 'line', t: 'line', a: 'b', b: 'a' },
      ]);
      const created = offsetCurves(s, ['arc', 'line'], distance, idFactory(s));
      expect(created).toHaveLength(2);
      const ix = new SketchIndex(s.entities);
      const arc = ix.get(created[0]);
      expect(arc?.t).toBe('arc');
      if (arc?.t !== 'arc') throw new Error('Missing offset arc');
      expect(arcRadius(ix, arc)).toBeCloseTo(5 + distance, 5);
      expect(ix.pt(arc.a)[1] - origin).toBeCloseTo(-distance, 5);
      expect(ix.pt(arc.b)[1] - origin).toBeCloseTo(-distance, 5);
    }
  });

  it('offsets a loop whose lines point in mixed directions, joining every corner', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 10, y: 0 }, { id: 'c', t: 'point', x: 10, y: 6 }, { id: 'd', t: 'point', x: 0, y: 6 },
      { id: 'l1', t: 'line', a: 'a', b: 'b' }, { id: 'l2', t: 'line', a: 'c', b: 'b' }, { id: 'l3', t: 'line', a: 'c', b: 'd' }, { id: 'l4', t: 'line', a: 'a', b: 'd' },
    ]);
    const created = offsetCurves(s, ['l1', 'l2', 'l3', 'l4'], -1, idFactory(s));
    const ix = new SketchIndex(s.entities);
    const pts = created.flatMap((id) => { const l = ix.get(id) as SkLine; return [l.a, l.b]; });
    // Four corners, each shared by two lines.
    expect(new Set(pts).size).toBe(4);
    const xs = pts.map((p) => ix.pt(p)[0]), ys = pts.map((p) => ix.pt(p)[1]);
    expect(Math.min(...xs)).toBeCloseTo(1, 9);
    expect(Math.max(...xs)).toBeCloseTo(9, 9);
    expect(Math.min(...ys)).toBeCloseTo(1, 9);
    expect(Math.max(...ys)).toBeCloseTo(5, 9);
  });

  it('refuses an inward offset larger than the loop instead of turning it inside out', () => {
    const s = sk(rect(0, 0, 20, 10, 'r'));
    const n = s.entities.length;
    // 6 inward from both long sides crosses over: the result would be inverted.
    expect(offsetCurves(s, ['rl0', 'rl1', 'rl2', 'rl3'], -6, idFactory(s))).toHaveLength(0);
    expect(s.entities).toHaveLength(n);
    expect(offsetCurves(s, ['rl0', 'rl1', 'rl2', 'rl3'], -4, idFactory(s))).toHaveLength(4);
    // A rounded rectangle offset inward by less than its corner radius still works.
    const r = sk(rect(0, 0, 20, 10, 'r'));
    for (const p of ['rp0', 'rp1', 'rp2', 'rp3']) filletCorner(r, p, 4, idFactory(r));
    const ids = r.entities.filter((e) => e.t === 'line' || e.t === 'arc').map((e) => e.id);
    expect(offsetCurves(r, ids, -3, idFactory(r))).toHaveLength(8);
  });

  it('offsets a rounded rectangle outward, growing its corner arcs', () => {
    const s = sk(rect(0, 0, 20, 10, 'r'));
    for (const p of ['rp0', 'rp1', 'rp2', 'rp3']) filletCorner(s, p, 2, idFactory(s));
    const ids = s.entities.filter((e) => e.t === 'line' || e.t === 'arc').map((e) => e.id);
    const created = offsetCurves(s, ids, 1, idFactory(s));
    expect(created).toHaveLength(8);
    const ix = new SketchIndex(s.entities);
    for (const id of created) {
      const e = ix.get(id)!;
      if (e.t === 'arc') expect(arcRadius(ix, e)).toBeCloseTo(3, 9);
    }
    const res = solveSketch(s.entities, s.constraints, { value });
    expect(res.converged).toBe(true);
  });

  it('mirrors a box selection about its centerline, not a center rectangle diagonal or a fillet construction line', () => {
    // Center rectangle (with construction diagonals) left of a centerline drawn later.
    const s = sk([
      ...rect(-30, -5, -10, 5, 'r'),
      { id: 'd1', t: 'line', a: 'rp0', b: 'rp2', construction: true }, { id: 'd2', t: 'line', a: 'rp1', b: 'rp3', construction: true },
      { id: 'a', t: 'point', x: 0, y: -20 }, { id: 'b', t: 'point', x: 0, y: 20 }, { id: 'axis', t: 'line', a: 'a', b: 'b', construction: true },
    ]);
    const box = s.entities.filter((e) => e.t === 'line').map((e) => e.id);
    expect(pickMirrorAxis(s, box)).toEqual({ axis: 'axis' });
    // Unambiguous selections keep their axis: the only centerline, else the last line.
    expect(pickMirrorAxis(s, ['rl0', 'd1', 'rl1'])).toEqual({ axis: 'd1' });
    expect(pickMirrorAxis(s, ['rl0', 'rl1', 'rl2'])).toEqual({ axis: 'rl2' });
    expect(pickMirrorAxis(s, ['rp0'])).toBeNull();
    // A fillet that keeps the full side length as a construction line.
    s.constraints.push({ id: 'eq', type: 'equal', refs: ['rl0', 'rl2'] });
    filletCorner(s, 'rp1', 2, idFactory(s));
    const box2 = s.entities.filter((e) => e.t === 'line' || e.t === 'arc').map((e) => e.id);
    expect(s.entities.filter((e) => e.t === 'line' && e.construction).length).toBeGreaterThan(3);
    expect(pickMirrorAxis(s, box2)).toEqual({ axis: 'axis' });
    // Only connected centerlines (a center rectangle alone), or two free ones: ask.
    expect(pickMirrorAxis(s, ['rl0', 'rl1', 'rl2', 'rl3', 'd1', 'd2'])).toHaveProperty('error');
    s.entities.push({ id: 'h0', t: 'point', x: 5, y: 0 }, { id: 'h1', t: 'point', x: 9, y: 0 }, { id: 'h', t: 'line', a: 'h0', b: 'h1', construction: true });
    expect(pickMirrorAxis(s, [...box2, 'h'])).toHaveProperty('error');
  });

  it.each([0, Math.PI / 4])('keeps a shared endpoint on its moving mirror axis at angle %s', (angle) => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: -10 }, { id: 'b', t: 'point', x: 0, y: 10 }, { id: 'axis', t: 'line', a: 'a', b: 'b', construction: true },
      { id: 'p', t: 'point', x: 0, y: 0 }, { id: 'q', t: 'point', x: 6, y: 4 }, { id: 'line', t: 'line', a: 'p', b: 'q' },
    ]);
    const rotate = (x: number, y: number): [number, number] => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
    for (const e of s.entities) if (e.t === 'point') [e.x, e.y] = rotate(e.x, e.y);
    const created = mirrorEntities(s, ['line'], 'axis', idFactory(s));
    expect(created).toHaveLength(1);
    const result = solveSketch(s.entities, s.constraints, { value, drag: { kind: 'points', ids: ['a', 'b'], targets: [rotate(2, -10), rotate(2, 10)] } });
    expect(result.converged).toBe(true);
    expect(result.badConstraints.size).toBe(0);
    const ix = new SketchIndex(s.entities);
    const mirrored = ix.get(created[0]) as SkLine;
    expect(mirrored.a).toBe('p');
    const across = (id: string) => ix.pt(id)[0] * Math.cos(angle) + ix.pt(id)[1] * Math.sin(angle);
    const along = (id: string) => -ix.pt(id)[0] * Math.sin(angle) + ix.pt(id)[1] * Math.cos(angle);
    expect(across('a')).toBeCloseTo(2, 6);
    expect(across('b')).toBeCloseTo(2, 6);
    expect(across('p')).toBeCloseTo(2, 6);
    expect(across('q') + across(mirrored.b)).toBeCloseTo(4, 6);
    expect(along('q')).toBeCloseTo(along(mirrored.b), 6);
  });

  it.each(['endpoint', 'coincident', 'midpoint', 'chain', 'aligned', 'fixed', 'dimension', 'repeat'])('avoids redundant mirror-axis relations for %s points', (kind) => {
    const s = sk([
      { id: 'a', t: 'point', x: 4, y: -10 }, { id: 'b', t: 'point', x: 4, y: 10 }, { id: 'axis', t: 'line', a: 'a', b: 'b', construction: true },
      { id: 'p', t: 'point', x: 4, y: 0 }, { id: 'q', t: 'point', x: 6, y: 4 }, { id: 'line', t: 'line', a: kind === 'endpoint' ? 'a' : 'p', b: 'q' },
    ]);
    if (kind === 'coincident') s.constraints.push({ id: 'on', type: 'coincident', refs: ['axis', 'p'] });
    if (kind === 'midpoint') s.constraints.push({ id: 'mid', type: 'midpoint', refs: ['p', 'axis'] });
    if (kind === 'chain') {
      s.entities.push({ id: 'r', t: 'point', x: 4, y: 0 });
      s.constraints.push({ id: 'on', type: 'coincident', refs: ['r', 'axis'] }, { id: 'pair', type: 'coincident', refs: ['p', 'r'] });
    }
    if (kind === 'aligned') s.constraints.push({ id: 'v', type: 'vertical', refs: ['axis'] }, { id: 'v2', type: 'vertical', refs: ['a', 'p'] });
    if (kind === 'fixed') s.constraints.push({ id: 'f', type: 'fix', refs: ['axis'] }, { id: 'f2', type: 'fix', refs: ['p'] });
    if (kind === 'dimension') {
      s.constraints.push({ id: 'v', type: 'vertical', refs: ['axis'] });
      for (const p of ['a', 'p']) s.constraints.push({ id: `d${p}`, type: 'hdistance', name: `D${p}`, refs: [ORIGIN_ID, p], value: 'Width', at: [2, -3] });
    }
    if (kind === 'repeat') mirrorEntities(s, ['line'], 'axis', idFactory(s));
    const before = structuredClone(s.constraints);
    const points = structuredClone(s.entities);
    const created = mirrorEntities(s, ['line'], 'axis', idFactory(s));
    expect(created).toHaveLength(1);
    expect(s.entities.slice(0, points.length)).toEqual(points);
    expect(s.constraints.slice(0, before.length)).toEqual(before);
    expect(s.constraints.slice(before.length).map((c) => c.type)).toEqual(['symmetric']);
    const result = solveSketch(s.entities, s.constraints, { value: () => 4 });
    expect(result.converged).toBe(true);
    expect(result.badConstraints.size).toBe(0);
  });

  it('mirrors entities about a centerline with symmetric relations', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: -10 }, { id: 'b', t: 'point', x: 0, y: 10 }, { id: 'axis', t: 'line', a: 'a', b: 'b', construction: true },
      { id: 'p', t: 'point', x: 3, y: 1 }, { id: 'q', t: 'point', x: 6, y: 4 }, { id: 'l', t: 'line', a: 'p', b: 'q' },
    ]);
    const created = mirrorEntities(s, ['l'], 'axis', idFactory(s));
    expect(created).toHaveLength(1);
    const ix = new SketchIndex(s.entities);
    const m = ix.get(created[0]) as SkLine;
    expect(ix.pt(m.a)).toEqual([-3, 1]);
    expect(s.constraints.filter((c) => c.type === 'symmetric')).toHaveLength(2);
    expect(solveSketch(s.entities, s.constraints, { value }).converged).toBe(true);
  });

  it('rejects a mirror axis collapsed by coincidence without changing the sketch', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: -10 }, { id: 'b', t: 'point', x: 0, y: 10 }, { id: 'axis', t: 'line', a: 'a', b: 'b', construction: true },
      { id: 'p', t: 'point', x: 3, y: 1 }, { id: 'q', t: 'point', x: 6, y: 4 }, { id: 'line', t: 'line', a: 'p', b: 'q' },
    ]);
    s.constraints.push({ id: 'collapse', type: 'coincident', refs: ['a', 'b'] });
    expect(solveSketch(s.entities, s.constraints, { value }).converged).toBe(true);
    const before = structuredClone(s);
    expect(mirrorEntities(s, ['line'], 'axis', idFactory(s))).toEqual([]);
    expect(s).toEqual(before);
  });

  it.each([0, 1e-10, 1e-9, 1e-6])('handles a mirror axis of length %s without silently duplicating its source', (length) => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 0, y: length }, { id: 'axis', t: 'line', a: 'a', b: 'b' },
      { id: 'p', t: 'point', x: 3, y: 1 }, { id: 'q', t: 'point', x: 6, y: 4 }, { id: 'line', t: 'line', a: 'p', b: 'q' },
    ]);
    const before = structuredClone(s);
    const made = mirrorEntities(s, ['line'], 'axis', idFactory(s));
    if (length < 1e-9) {
      expect(made).toEqual([]);
      expect(s).toEqual(before);
    } else {
      expect(made).toHaveLength(1);
      const ix = new SketchIndex(s.entities);
      const line = ix.get(made[0]) as SkLine;
      expect(ix.pt(line.a)).toEqual([-3, 1]);
      expect(ix.pt(line.b)).toEqual([-6, 4]);
    }
  });

  it.each(['arc', 'arc ending on the axis', 'filleted corner', 'slot'])('mirrors a %s without over-defining the copy, and the copy follows the source', (shape) => {
    const s = sk([{ id: 'a', t: 'point', x: 0, y: -10 }, { id: 'b', t: 'point', x: 0, y: 30 }, { id: 'axis', t: 'line', a: 'a', b: 'b', construction: true }]);
    s.constraints.push({ id: 'fixAxis', type: 'fix', refs: ['axis'] });
    let ids: string[];
    if (shape === 'arc') {
      s.entities.push({ id: 'c', t: 'point', x: 20, y: 10 }, { id: 'p', t: 'point', x: 30, y: 10 }, { id: 'q', t: 'point', x: 20, y: 20 },
        { id: 'arc', t: 'arc', c: 'c', a: 'p', b: 'q' });
      ids = ['arc'];
    } else if (shape === 'arc ending on the axis') {
      s.entities.push({ id: 'c', t: 'point', x: 10, y: 10 }, { id: 'p', t: 'point', x: 10, y: 0 }, { id: 'q', t: 'point', x: 0, y: 10 },
        { id: 'arc', t: 'arc', c: 'c', a: 'p', b: 'q' });
      ids = ['arc'];
    } else if (shape === 'filleted corner') {
      s.entities.push({ id: 'k', t: 'point', x: 30, y: 0 }, { id: 'h0', t: 'point', x: 5, y: 0 }, { id: 'v0', t: 'point', x: 30, y: 20 },
        { id: 'h', t: 'line', a: 'h0', b: 'k' }, { id: 'v', t: 'line', a: 'k', b: 'v0' });
      s.constraints.push({ id: 'hh', type: 'horizontal', refs: ['h'] }, { id: 'vv', type: 'vertical', refs: ['v'] });
      expect(filletCorner(s, 'k', 4, idFactory(s))).toBeNull();
      ids = ['h', 'v', s.entities.find((e) => e.t === 'arc')!.id];
    } else {
      // A slot drawn by the tool: two tangent arcs, two lines and a construction axis sharing the arc centres.
      s.entities.push(
        { id: 'ca', t: 'point', x: 10, y: 5 }, { id: 'cb', t: 'point', x: 30, y: 5 },
        { id: 'p1', t: 'point', x: 10, y: 8 }, { id: 'p2', t: 'point', x: 10, y: 2 }, { id: 'q1', t: 'point', x: 30, y: 8 }, { id: 'q2', t: 'point', x: 30, y: 2 },
        { id: 'l1', t: 'line', a: 'p1', b: 'q1' }, { id: 'l2', t: 'line', a: 'q2', b: 'p2' },
        { id: 'arcB', t: 'arc', c: 'cb', a: 'q2', b: 'q1' }, { id: 'arcA', t: 'arc', c: 'ca', a: 'p1', b: 'p2' },
        { id: 'slotAxis', t: 'line', a: 'ca', b: 'cb', construction: true },
      );
      s.constraints.push(
        { id: 't1', type: 'tangent', refs: ['l1', 'arcA'] }, { id: 't2', type: 'tangent', refs: ['l1', 'arcB'] },
        { id: 't3', type: 'tangent', refs: ['l2', 'arcA'] }, { id: 't4', type: 'tangent', refs: ['l2', 'arcB'] },
        { id: 'eq', type: 'equal', refs: ['arcA', 'arcB'] }, { id: 'hz', type: 'horizontal', refs: ['slotAxis'] },
      );
      ids = ['l1', 'l2', 'arcA', 'arcB', 'slotAxis'];
    }
    const before = solveSketch(s.entities, s.constraints, { value });
    expect(before.status).toBe('under');
    const made = mirrorEntities(s, ids, 'axis', idFactory(s));
    const after = solveSketch(s.entities, s.constraints, { value });
    // Mirrored geometry adds no freedom and no redundant relation.
    expect(after.badConstraints.size).toBe(0);
    expect(after.status).toBe('under');
    // (An end point shared with the copy is also held on the axis.)
    expect(after.dof).toBe(before.dof - (shape === 'arc ending on the axis' ? 1 : 0));
    // Moving the source moves the copy with it, still mirrored.
    const src = s.entities.find((e) => e.t === 'arc' && !made.includes(e.id)) as Extract<SkEntity, { t: 'arc' }>;
    const start = new SketchIndex(s.entities).pt(src.a);
    const moved = solveSketch(s.entities, s.constraints, { value, drag: { kind: 'points', ids: [src.a], targets: [[start[0] + 2, start[1] + 1]] } });
    expect(moved.converged).toBe(true);
    const ix = new SketchIndex(s.entities);
    for (const id of made) {
      const copy = ix.get(id)!;
      const orig = ix.get(ids[made.indexOf(id)])!;
      if (copy.t !== 'arc' || orig.t !== 'arc') continue;
      const c = ix.pt(orig.c), mc = ix.pt(copy.c);
      expect(mc[0]).toBeCloseTo(-c[0], 6);
      expect(mc[1]).toBeCloseTo(c[1], 6);
      expect(arcRadius(ix, copy)).toBeCloseTo(arcRadius(ix, orig), 6);
      expect(ix.pt(copy.a)[0]).toBeCloseTo(-ix.pt(orig.b)[0], 6);
    }
  });

  it('keeps shared circle centers and repeated spline points on the mirror axis', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: -10 }, { id: 'b', t: 'point', x: 0, y: 10 }, { id: 'axis', t: 'line', a: 'a', b: 'b', construction: true },
      { id: 'p', t: 'point', x: 0, y: 0 }, { id: 'q', t: 'point', x: 6, y: 4 },
      { id: 'circle', t: 'circle', c: 'p', r: 3 }, { id: 'spline', t: 'spline', pts: ['p', 'q', 'p'] },
    ]);
    mirrorEntities(s, ['circle', 'spline'], 'axis', idFactory(s));
    expect(s.constraints.filter((c) => c.type === 'coincident')).toHaveLength(1);
    const result = solveSketch(s.entities, s.constraints, { value, drag: { kind: 'points', ids: ['a', 'b'], targets: [[2, -10], [2, 10]] } });
    expect(result.converged).toBe(true);
    expect(result.badConstraints.size).toBe(0);
    expect(new SketchIndex(s.entities).pt('p')[0]).toBeCloseTo(2, 6);
    const circles = s.entities.filter((e) => e.t === 'circle');
    expect(circles.map((e) => [e.c, e.r])).toEqual([['p', 3], ['p', 3]]);
    const splines = s.entities.filter((e) => e.t === 'spline');
    expect(splines.map((e) => [e.pts[0], e.pts[2]])).toEqual([['p', 'p'], ['p', 'p']]);
  });
});
