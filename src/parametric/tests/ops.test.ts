import { describe, expect, it } from 'vitest';
import type { SkDimension, SkEntity, SkLine, SketchFeature } from '../src/model/types';
import { SketchIndex, arcRadius, distanceToCurve } from '../src/sketch/geom';
import {
  availableRelations, deleteItems, extendAt, filletCorner, idFactory, makeRelations, measureDimension, mirrorEntities,
  offsetCurves, relationsOf, smartDimension, trimAt,
} from '../src/sketch/ops';
import { solveSketch } from '../src/sketch/solver';
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

  it('trims a circle into an arc whose ends stay on the cutting lines', () => {
    const s = sk([
      { id: 'o', t: 'point', x: 0, y: 0 }, { id: 'circ', t: 'circle', c: 'o', r: 5 },
      { id: 'c', t: 'point', x: -10, y: 3 }, { id: 'd', t: 'point', x: 10, y: 3 }, { id: 'l', t: 'line', a: 'c', b: 'd' },
    ]);
    expect(trimAt(s, 'circ', [0, 5], idFactory(s))).toBe(true);
    const arc = s.entities.find((e) => e.id === 'circ')!;
    expect(arc.t).toBe('arc');
    expect(s.constraints.filter((c) => c.type === 'coincident' && c.refs[1] === 'l')).toHaveLength(2);
    expect(solveSketch(s.entities, s.constraints, { value }).status).toBe('under');
  });

  it('extends a line to the next curve', () => {
    const s = sk([
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 4, y: 0 }, { id: 'h', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 9, y: -5 }, { id: 'd', t: 'point', x: 9, y: 5 }, { id: 'v', t: 'line', a: 'c', b: 'd' },
    ]);
    s.constraints.push({ id: 'len', type: 'hdistance', refs: ['h'], value: 4, at: [2, -3], name: 'D1' });
    expect(extendAt(s, 'h', [3.9, 0])).toBe(true);
    expect(new SketchIndex(s.entities).pt('b')[0]).toBeCloseTo(9, 9);
    // The old length would pull the end back.
    expect(s.constraints).toHaveLength(0);
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
    const arc = s.entities.find((e) => e.t === 'arc');
    expect(arc).toBeDefined();
    const ix = new SketchIndex(s.entities);
    expect(arcRadius(ix, arc as never)).toBeCloseTo(3, 9);
    const res = solveSketch(s.entities, s.constraints, { value });
    expect(res.converged).toBe(true);
    expect(filletCorner(s, 'rp0', 50, idFactory(s))).toMatch(/too large/);
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

  it('offsets a closed rectangle outward', () => {
    const s = sk(rect(0, 0, 10, 10, 'r'));
    const created = offsetCurves(s, ['rl0', 'rl1', 'rl2', 'rl3'], 2, idFactory(s));
    expect(created).toHaveLength(4);
    const ix = new SketchIndex(s.entities);
    const xs = created.flatMap((id) => { const l = ix.get(id) as SkLine; return [ix.pt(l.a)[0], ix.pt(l.b)[0]]; });
    expect(Math.min(...xs)).toBeCloseTo(-2, 9);
    expect(Math.max(...xs)).toBeCloseTo(12, 9);
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
});
