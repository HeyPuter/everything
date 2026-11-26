import { describe, expect, it } from 'vitest';
import { type Geo, MateSolver, type SolverBody, type SolverMate, applyPlacement, fittingMates, initialMateSettings, matesMoving, matrixRank, placeGeo, relativePlacement } from '../src/assembly/solver';
import { type Quat, type Vec3, cross, dot, len, normalize, qAxisAngle, qRotate, sub } from '../src/math/vec';
import type { MateType, Placement } from '../src/model/assembly';

// A 10 mm cube centred on its origin: its six faces and a hole along y.
const face = (n: Vec3): Geo => ({ kind: 'plane', o: [n[0] * 5, n[1] * 5, n[2] * 5], n });
const TOP = face([0, 1, 0]), BOTTOM = face([0, -1, 0]), RIGHT = face([1, 0, 0]), FRONT = face([0, 0, 1]), BACK = face([0, 0, -1]);
const HOLE: Geo = { kind: 'axis', p: [0, 0, 0], d: [0, 1, 0], r: 2, surface: 'cylinder' };

const body = (id: string, fixed: boolean, p: Vec3 = [0, 0, 0], q: Quat = [0, 0, 0, 1]): SolverBody => ({ id, fixed, placement: { p, q } });
let n = 0;
const mate = (type: MateType, a: [string | null, Geo], b: [string | null, Geo], extra: Partial<SolverMate> = {}): SolverMate => ({
  id: `m${++n}`, type, a: { body: a[0], geo: a[1] }, b: { body: b[0], geo: b[1] }, aligned: false, value: 0, flip: false, ...extra,
});
const world = (pl: Map<string, Placement>, id: string, g: Geo) => placeGeo(g, pl.get(id)!);
const tilted: Quat = qAxisAngle(normalize([1, 2, 3]), 0.6);

describe('mate solver', () => {
  it('coincident planes put the faces together, facing each other, leaving three degrees of freedom', () => {
    const s = new MateSolver([body('base', true), body('blk', false, [30, 40, -7], tilted)], [mate('coincident', ['base', TOP], ['blk', BOTTOM])]);
    const r = s.analyze();
    expect(r.status).toBe('under');
    expect(r.dof).toBe(3);
    const bottom = world(r.placements, 'blk', BOTTOM) as Extract<Geo, { kind: 'plane' }>;
    expect(bottom.o[1]).toBeCloseTo(5, 6);
    expect(dot(bottom.n, [0, -1, 0])).toBeCloseTo(1, 8);
    expect(r.defined.size).toBe(0);
  });

  it('three pairs of coincident faces fully define a block', () => {
    const s = new MateSolver([body('base', true), body('blk', false, [12, 9, 3], tilted)], [
      mate('coincident', ['base', TOP], ['blk', BOTTOM]),
      mate('coincident', ['base', RIGHT], ['blk', RIGHT], { aligned: true }),
      mate('coincident', ['base', FRONT], ['blk', FRONT], { aligned: true }),
    ]);
    const r = s.analyze();
    expect(r.status).toBe('full');
    expect(r.dof).toBe(0);
    expect(r.defined.has('blk')).toBe(true);
    const p = r.placements.get('blk')!;
    expect(p.p[0]).toBeCloseTo(0, 6);
    expect(p.p[1]).toBeCloseTo(10, 6);
    expect(p.p[2]).toBeCloseTo(0, 6);
  });

  it('reports the later of two conflicting mates and keeps the first', () => {
    const s = new MateSolver([body('base', true), body('blk', false, [0, 20, 0])], [
      mate('coincident', ['base', TOP], ['blk', BOTTOM]),
      mate('distance', ['base', TOP], ['blk', BOTTOM], { value: 5 }),
    ]);
    const r = s.analyze();
    expect(r.status).toBe('over');
    expect([...r.conflicts]).toEqual([s.mates[1].id]);
    expect((world(r.placements, 'blk', BOTTOM) as { o: Vec3 }).o[1]).toBeCloseTo(5, 6);
  });

  it('distance keeps parallel faces apart by the value, on the side they start on', () => {
    const s = new MateSolver([body('base', true), body('blk', false, [3, 40, 1], qAxisAngle([0, 0, 1], 0.2))], [mate('distance', ['base', TOP], ['blk', BOTTOM], { value: 12 })]);
    const r = s.solve();
    expect(r.ok).toBe(true);
    expect((world(r.placements, 'blk', BOTTOM) as { o: Vec3 }).o[1]).toBeCloseTo(17, 6);
    const flipped = new MateSolver(s.bodies, [{ ...s.mates[0], flip: true }]).solve();
    expect((world(flipped.placements, 'blk', BOTTOM) as { o: Vec3 }).o[1]).toBeCloseTo(-7, 6);
  });

  it('concentric aligns axes and leaves sliding and turning free', () => {
    const pin: Geo = { kind: 'axis', p: [0, 0, 0], d: [0, 0, 1], r: 2, surface: 'cylinder' };
    const s = new MateSolver([body('base', true), body('pin', false, [5, 3, 2], tilted)], [mate('concentric', ['base', HOLE], ['pin', pin], { aligned: true })]);
    const r = s.analyze();
    expect(r.dof).toBe(2);
    const a = world(r.placements, 'pin', pin) as { p: Vec3; d: Vec3 };
    expect(Math.abs(dot(a.d, [0, 1, 0]))).toBeCloseTo(1, 8);
    expect(len(cross(a.p, [0, 1, 0]))).toBeCloseTo(0, 6);
  });

  it('parallel, perpendicular and angle mates set directions', () => {
    const start = body('blk', false, [20, 0, 0], tilted);
    const par = new MateSolver([body('base', true), start], [mate('parallel', ['base', TOP], ['blk', TOP], { aligned: true })]).analyze();
    expect(dot((world(par.placements, 'blk', TOP) as { n: Vec3 }).n, [0, 1, 0])).toBeCloseTo(1, 8);
    expect(par.dof).toBe(4);
    const perp = new MateSolver([body('base', true), start], [mate('perpendicular', ['base', TOP], ['blk', TOP])]).analyze();
    expect(dot((world(perp.placements, 'blk', TOP) as { n: Vec3 }).n, [0, 1, 0])).toBeCloseTo(0, 8);
    expect(perp.dof).toBe(5);
    const ang = new MateSolver([body('base', true), start], [mate('angle', ['base', TOP], ['blk', TOP], { value: 30, aligned: true })]).solve();
    expect(dot((world(ang.placements, 'blk', TOP) as { n: Vec3 }).n, [0, 1, 0])).toBeCloseTo(Math.cos(Math.PI / 6), 8);
  });

  it('tangent puts a cylinder against a plane', () => {
    const roller: Geo = { kind: 'axis', p: [0, 0, 0], d: [1, 0, 0], r: 4, surface: 'cylinder' };
    const s = new MateSolver([body('base', true), body('roll', false, [0, 30, 0], qAxisAngle([0, 1, 0], 0.3))], [mate('tangent', ['base', TOP], ['roll', roller])]);
    const r = s.solve();
    expect(r.ok).toBe(true);
    const a = world(r.placements, 'roll', roller) as { p: Vec3; d: Vec3 };
    expect(a.p[1]).toBeCloseTo(9, 6);
    expect(a.d[1]).toBeCloseTo(0, 8);
  });

  it('lock keeps two components where they were relative to each other', () => {
    const a = body('a', false, [1, 2, 3], tilted), b = body('b', false, [10, 0, 0]);
    const rel = relativePlacement(a.placement, b.placement);
    const s = new MateSolver([body('base', true), a, b], [
      mate('coincident', ['base', TOP], ['a', BOTTOM]),
      mate('lock', ['a', { kind: 'body' }], ['b', { kind: 'body' }], { rel }),
    ]);
    const r = s.analyze();
    expect(r.dof).toBe(3);
    const after = relativePlacement(r.placements.get('a')!, r.placements.get('b')!);
    expect(len(sub(after.p, rel.p))).toBeLessThan(1e-6);
  });

  it('mates to an assembly plane', () => {
    const s = new MateSolver([body('blk', false, [4, 4, 4])], [mate('coincident', [null, { kind: 'plane', o: [0, 0, 0], n: [0, 0, 1] }], ['blk', BACK])]);
    const r = s.solve();
    expect(r.ok).toBe(true);
    expect((world(r.placements, 'blk', BACK) as { o: Vec3 }).o[2]).toBeCloseTo(0, 6);
  });

  it('turns a face that faces the wrong way for its alignment', () => {
    const s = new MateSolver([body('base', true), body('blk', false, [0, 20, 0])], [mate('coincident', ['base', TOP], ['blk', TOP])]);
    const r = s.solve();
    expect(r.ok).toBe(true);
    expect(dot((world(r.placements, 'blk', TOP) as { n: Vec3 }).n, [0, -1, 0])).toBeCloseTo(1, 6);
  });

  it('dragging a lid on a hinge turns it about the hinge', () => {
    // Base fixed; the lid's hinge axis (along z through its left edge) concentric with the base's pin.
    const pin: Geo = { kind: 'axis', p: [0, 0, 0], d: [0, 0, 1], r: 1, surface: 'cylinder' };
    const lidHinge: Geo = { kind: 'axis', p: [-20, 0, 0], d: [0, 0, 1], r: 1, surface: 'cylinder' };
    const lidSide: Geo = { kind: 'plane', o: [0, 0, 5], n: [0, 0, 1] };
    const baseSide: Geo = { kind: 'plane', o: [0, 0, 5], n: [0, 0, 1] };
    const lid = body('lid', false, [20, 0, 0]);
    const mates = [mate('concentric', ['base', pin], ['lid', lidHinge], { aligned: true }), mate('coincident', ['base', baseSide], ['lid', lidSide], { aligned: true })];
    const s = new MateSolver([body('base', true), lid], mates);
    expect(s.analyze().dof).toBe(1);
    // Grab the lid's far end (40 mm from the hinge) and drag it straight up.
    const r = s.solve({ drag: { kind: 'move', body: 'lid', local: [20, 0, 0], target: [20, 30, 0] } });
    expect(r.ok).toBe(true);
    const tip = applyPlacement(r.placements.get('lid')!, [20, 0, 0]);
    // Still 40 mm from the hinge, and turned up toward the cursor.
    expect(len(tip)).toBeCloseTo(40, 4);
    expect(tip[1]).toBeGreaterThan(20);
    const hinge = applyPlacement(r.placements.get('lid')!, [-20, 0, 0]);
    expect(len(hinge)).toBeLessThan(1e-6);
  });

  it('a free drag follows the cursor; fixed components never move', () => {
    const s = new MateSolver([body('base', true), body('blk', false)], []);
    const r = s.solve({ drag: { kind: 'move', body: 'blk', local: [0, 0, 0], target: [5, 6, 7] } });
    const p = r.placements.get('blk')!.p;
    expect(p[0]).toBeCloseTo(5, 3);
    expect(p[1]).toBeCloseTo(6, 3);
    const f = new MateSolver([body('base', true)], []).solve({ drag: { kind: 'move', body: 'base', local: [0, 0, 0], target: [5, 6, 7] } });
    expect(f.placements.get('base')!.p).toEqual([0, 0, 0]);
  });

  it('rotating toward an orientation respects mates', () => {
    const s = new MateSolver([body('base', true), body('blk', false, [0, 10, 0])], [mate('coincident', ['base', TOP], ['blk', BOTTOM])]);
    const r = s.solve({ drag: { kind: 'rotate', body: 'blk', q: qAxisAngle(normalize([1, 1, 0]), 0.5) } });
    expect(r.ok).toBe(true);
    // Only the turn about the face normal is allowed.
    expect(dot(qRotate(r.placements.get('blk')!.q, [0, -1, 0]), [0, -1, 0])).toBeCloseTo(1, 6);
  });

  it('suggests the mates that fit two entities and takes settings from where they are', () => {
    expect(fittingMates(HOLE, { kind: 'axis', p: [0, 0, 0], d: [0, 1, 0], r: 2, surface: 'cylinder' })[0]).toBe('concentric');
    expect(fittingMates(TOP, BOTTOM)).toContain('coincident');
    expect(fittingMates(TOP, BOTTOM)).not.toContain('concentric');
    expect(fittingMates(TOP, { kind: 'axis', p: [0, 0, 0], d: [1, 0, 0], r: 3, surface: 'cylinder' })[0]).toBe('tangent');
    const st = initialMateSettings('distance', TOP, placeGeo(BOTTOM, { p: [0, 20, 0], q: [0, 0, 0, 1] }));
    expect(st.value).toBeCloseTo(10, 9);
    expect(st.flip).toBe(false);
    expect(st.aligned).toBe(false);
  });

  it('computes matrix rank', () => {
    expect(matrixRank([[1, 0, 0], [0, 1, 0], [1, 1, 0]], 3)).toBe(2);
    expect(matrixRank([[1, 2], [2, 4]], 2)).toBe(1);
    expect(matrixRank([], 3)).toBe(0);
  });

  it('tells fully defined components from those that move with an under-defined one', () => {
    const full = (a: string, b: string) => [
      mate('coincident', [a, TOP], [b, BOTTOM]),
      mate('coincident', [a, RIGHT], [b, RIGHT], { aligned: true }),
      mate('coincident', [a, FRONT], [b, FRONT], { aligned: true }),
    ];
    // c1 is fixed to the base; c3 is fixed to c2, which slides on c1; c4 turns on a pin.
    const bodies = [body('base', true), body('c1', false, [20, 3, 1], tilted), body('c2', false, [40, 3, 1], tilted), body('c3', false, [60, 3, 1], tilted), body('c4', false, [80, 1, 1], tilted)];
    const r = new MateSolver(bodies, [
      ...full('base', 'c1'), mate('coincident', ['c1', TOP], ['c2', BOTTOM]), ...full('c2', 'c3'),
      mate('concentric', ['base', HOLE], ['c4', HOLE], { aligned: true }), mate('coincident', ['base', TOP], ['c4', BOTTOM]),
    ]).analyze();
    expect([...r.defined]).toEqual(['c1']);
    expect(r.dof).toBe(3 + 1);
  });

  it('a drag solves only the mates of the components linked to the dragged one', () => {
    const bodies = [body('base', true), body('a', false), body('b', false), body('c', false), body('d', false)];
    const ab = mate('coincident', ['a', TOP], ['b', BOTTOM]), bc = mate('coincident', ['b', TOP], ['c', BOTTOM]);
    const baseA = mate('coincident', ['base', TOP], ['a', BOTTOM]), baseD = mate('coincident', ['base', TOP], ['d', BOTTOM]);
    const planeC = mate('coincident', [null, FRONT], ['c', FRONT]);
    const all = [ab, bc, baseA, baseD, planeC];
    // The base and the assembly planes do not move, so they do not link a to d.
    expect(matesMoving('a', bodies, all).map((m) => m.id)).toEqual([ab, bc, baseA, planeC].map((m) => m.id));
    expect(matesMoving('d', bodies, all).map((m) => m.id)).toEqual([baseD.id]);
    // A fixed component in a chain does not link either.
    const fixedB = bodies.map((x) => (x.id === 'b' ? { ...x, fixed: true } : x));
    expect(matesMoving('a', fixedB, all).map((m) => m.id)).toEqual([ab, baseA].map((m) => m.id));
  });

  it('analyses an assembly of fifty components', () => {
    const bodies = [body('c0', true)];
    const mates: SolverMate[] = [];
    for (let i = 1; i < 50; i++) {
      bodies.push(body(`c${i}`, false, [i * 13 + 1, i * 3, 2], tilted));
      mates.push(mate('coincident', [`c${i - 1}`, TOP], [`c${i}`, BOTTOM]));
      mates.push(mate('coincident', [`c${i - 1}`, RIGHT], [`c${i}`, RIGHT], { aligned: true }));
      if (i % 10) mates.push(mate('coincident', [`c${i - 1}`, FRONT], [`c${i}`, FRONT], { aligned: true }));
    }
    const r = new MateSolver(bodies, mates).analyze({ scale: 500 });
    expect(r.status).toBe('under');
    expect(r.dof).toBe(4);
    // Every tenth component slides, and those after it with it.
    expect([...r.defined]).toEqual(bodies.slice(1, 10).map((b) => b.id));
  });
});
