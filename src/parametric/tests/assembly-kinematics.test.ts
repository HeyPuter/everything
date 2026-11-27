import { describe, expect, it } from 'vitest';
import { type Geo, MateSolver, type SolverBody, type SolverMate, applyPlacement, camProfile, mateBodies, mateMeasure, matesMoving, placeGeo, profileSupport, relativePlacement, turnAbout } from '../src/assembly/solver';
import { type PartGeometry, camProfileOf } from '../src/assembly/compose';
import { type MotorInput, MotionRun, computeMotion, degreesAbout, derivatives, framesSpread, mateSeries, pointPath, profileOf, resultsCsv, sameMotionGroups, turnPath, vectorDerivatives } from '../src/assembly/motion';
import { type Quat, type Vec3, dot, len, normalize, qAxisAngle, qRotate, sub } from '../src/math/vec';
import type { MateType, Placement } from '../src/model/assembly';

const Z: Vec3 = [0, 0, 1], Y3: Vec3 = [0, 1, 0];
const plane = (o: Vec3, n: Vec3): Geo => ({ kind: 'plane', o, n });
const axis = (p: Vec3, d: Vec3 = Z, r = 2): Geo => ({ kind: 'axis', p, d, r, surface: 'cylinder' });
const body = (id: string, fixed: boolean, p: Vec3 = [0, 0, 0], q: Quat = [0, 0, 0, 1]): SolverBody => ({ id, fixed, placement: { p, q }, center: [0, 0, 0] });
let n = 0;
const mate = (type: MateType, a: [string | null, Geo], b: [string | null, Geo], extra: Partial<SolverMate> = {}): SolverMate => ({
  id: `m${++n}`, type, a: { body: a[0], geo: a[1] }, b: { body: b[0], geo: b[1] }, aligned: true, value: 0, flip: false, ...extra,
});
/** A hinge between a's axis at pa and b's at pb (both along z), their z = 0 faces touching. */
const hinge = (a: string, pa: Vec3, b: string, pb: Vec3, extra: Partial<SolverMate> = {}) => mate('hinge', [a, axis(pa)], [b, axis(pb)], {
  a2: { body: a, geo: plane([0, 0, 0], Z) }, b2: { body: b, geo: plane([0, 0, 0], [0, 0, -1]) }, aligned2: false, ...extra,
});
const deg = (r: number) => (r * 180) / Math.PI;
const angleZ = (q: Quat) => Math.atan2(qRotate(q, [1, 0, 0])[1], qRotate(q, [1, 0, 0])[0]);
const rotary = (bodyId: string, entity: Geo, speed: number, extra: Partial<MotorInput> = {}): MotorInput => ({
  id: 'motor', name: 'RotaryMotor1', kind: 'rotary', body: bodyId, entity: { body: bodyId, geo: entity }, at: profileOf('rotary', { profile: 'constant', speed }, 1), ...extra,
});

describe('limit mates', () => {
  const TOP = plane([0, 5, 0], [0, 1, 0]), BOTTOM = plane([0, -5, 0], [0, -1, 0]);
  const blockOnSlide = (limit: { min: number; max: number }, y = 40) => {
    const bodies = [body('base', true), body('blk', false, [3, y, 1])];
    // Kept upright and sliding along y only (two faces), with the distance between the limits.
    const mates = [
      mate('coincident', ['base', plane([5, 0, 0], [1, 0, 0])], ['blk', plane([5, 0, 0], [1, 0, 0])]),
      mate('coincident', ['base', plane([0, 0, 5], Z)], ['blk', plane([0, 0, 5], Z)]),
      mate('distance', ['base', TOP], ['blk', BOTTOM], { aligned: false, limit, value: 10 }),
    ];
    return new MateSolver(bodies, mates);
  };
  const gap = (pl: Map<string, Placement>) => (placeGeo(BOTTOM, pl.get('blk')!) as { o: Vec3 }).o[1] - 5;

  it('a distance limit lets the component move between its values, and stops a drag at them', () => {
    const s = blockOnSlide({ min: 5, max: 20 });
    const r = s.analyze();
    // Moved in to the largest distance, still free to slide: one degree of freedom.
    expect(gap(r.placements)).toBeCloseTo(20, 4);
    expect(r.status).toBe('under');
    expect(r.dof).toBe(1);
    expect(r.defined.size).toBe(0);
    // Inside the range it stays where it is put.
    const inside = blockOnSlide({ min: 5, max: 20 }, 22).solve();
    expect(gap(inside.placements)).toBeCloseTo(12, 9);
    // Dragged far down, it stops at the smallest distance.
    const down = s.solve({ drag: { kind: 'move', body: 'blk', local: [0, 0, 0], target: [0, -100, 0] } }, s.mates, r.placements);
    expect(down.ok).toBe(true);
    expect(gap(down.placements)).toBeCloseTo(5, 4);
    const up = s.solve({ drag: { kind: 'move', body: 'blk', local: [0, 0, 0], target: [0, 300, 0] } }, s.mates, r.placements);
    expect(gap(up.placements)).toBeCloseTo(20, 4);
  });

  it('a limit that cannot be met with the other mates conflicts; one upside down is a mate error', () => {
    const base = blockOnSlide({ min: 5, max: 20 });
    const over = new MateSolver(base.bodies, [...base.mates, mate('distance', ['base', TOP], ['blk', BOTTOM], { aligned: false, value: 30 })]).analyze();
    expect(over.status).toBe('over');
    expect(over.conflicts.size).toBe(1);
    const bad = blockOnSlide({ min: 20, max: 5 }).analyze();
    expect(bad.status).toBe('error');
    expect([...bad.invalid.values()][0]).toMatch(/smallest/);
  });

  it('a limit whose smallest and largest values are equal holds the component there (it takes the freedom away)', () => {
    const r = blockOnSlide({ min: 12, max: 12 }).analyze();
    expect(r.status).toBe('full');
    expect(r.dof).toBe(0);
    expect(r.defined.has('blk')).toBe(true);
    expect(gap(r.placements)).toBeCloseTo(12, 6);
    const start: Placement = { p: [0, 0, 0], q: [0, 0, 0, 1] };
    const held = new MateSolver([body('base', true), body('lid', false)], [mate('hinge', ['base', axis([0, 0, 0])], ['lid', axis([0, 0, 0])], { a2: { body: 'base', geo: plane([0, 0, 0], Z) }, b2: { body: 'lid', geo: plane([0, 0, 0], [0, 0, -1]) }, aligned2: false, rel: start, limit: { min: 20, max: 20 } })]).analyze();
    expect(held.dof).toBe(0);
    expect(deg(angleZ(held.placements.get('lid')!.q))).toBeCloseTo(20, 4);
  });

  it('an angle limit stops a lid turning on its hinge', () => {
    const lidTop = plane([20, 1, 0], [0, 1, 0]);
    const mates = [
      mate('concentric', ['base', axis([0, 0, 0])], ['lid', axis([0, 0, 0])]),
      mate('coincident', ['base', plane([0, 0, 0], Z)], ['lid', plane([0, 0, 0], Z)]),
      mate('angle', ['base', plane([0, 0, 0], [0, 1, 0])], ['lid', lidTop], { limit: { min: 0, max: 60 }, value: 0 }),
    ];
    const s = new MateSolver([body('base', true), body('lid', false)], mates);
    const r = s.analyze();
    expect(r.dof).toBe(1);
    // Dragging the lid's end straight up: it turns until 60°, then stops.
    let pl = r.placements;
    for (let k = 1; k <= 8; k++) pl = s.solve({ drag: { kind: 'move', body: 'lid', local: [40, 0, 0], target: [0, 10 * k, 0] } }, s.mates, pl).placements;
    expect(deg(angleZ(pl.get('lid')!.q))).toBeCloseTo(60, 3);
  });
});

describe('mechanical mates', () => {
  it('a hinge is concentric and coincident in one, with angle limits from where it was added', () => {
    const lid = body('lid', false, [5, 3, 7], qAxisAngle(normalize([1, 2, 0]), 0.3));
    const free = new MateSolver([body('base', true), lid], [hinge('base', [0, 0, 0], 'lid', [0, 0, 0])]).analyze();
    expect(free.dof).toBe(1);
    const p = free.placements.get('lid')!;
    expect(len(applyPlacement(p, [0, 0, 0]))).toBeLessThan(1e-6);
    expect(dot(qRotate(p.q, Z), Z)).toBeCloseTo(1, 8);
    // With limits of -30° to 45° measured from the lid where it is now.
    const start: Placement = { p: [0, 0, 0], q: [0, 0, 0, 1] };
    const limited = hinge('base', [0, 0, 0], 'lid', [0, 0, 0], { rel: relativePlacement(start, start), limit: { min: -30, max: 45 } });
    const s = new MateSolver([body('base', true), body('lid', false)], [limited]);
    expect(s.analyze().dof).toBe(1);
    let pl = new Map([['base', start], ['lid', start]]);
    for (let k = 1; k <= 12; k++) pl = s.solve({ drag: { kind: 'rotate', body: 'lid', q: qAxisAngle(Z, (k * 10 * Math.PI) / 180) } }, s.mates, pl).placements;
    expect(deg(angleZ(pl.get('lid')!.q))).toBeCloseTo(45, 3);
    expect(mateMeasure(limited, pl)!.value).toBeCloseTo(45, 3);
    for (let k = 1; k <= 12; k++) pl = s.solve({ drag: { kind: 'rotate', body: 'lid', q: qAxisAngle(Z, ((45 - k * 10) * Math.PI) / 180) } }, s.mates, pl).placements;
    expect(deg(angleZ(pl.get('lid')!.q))).toBeCloseTo(-30, 3);
    // Faces on the wrong components are refused.
    const crossed = { ...limited, a2: limited.b2, b2: limited.a2 };
    expect(new MateSolver([body('base', true), body('lid', false)], [crossed]).analyze().invalid.get(crossed.id)).toMatch(/component of the round entity/);
  });

  it('hinge limits past ±180° (a door that opens 270°) stop at their ends, not at 180°', () => {
    const start: Placement = { p: [0, 0, 0], q: [0, 0, 0, 1] };
    const door = hinge('base', [0, 0, 0], 'lid', [0, 0, 0], { rel: relativePlacement(start, start), limit: { min: 0, max: 270 } });
    const bodies = [body('base', true), body('lid', false)];
    const run = (speed: number) => computeMotion({ bodies, mates: [door], motors: [{ id: 'mo', name: 'RotaryMotor1', kind: 'rotary', on: door, at: profileOf('rotary', { profile: 'constant', speed }, 4) }], duration: 4, fps: 10, scale: 100 });
    const open = run(90);
    expect(open.stop?.kind).toBe('limit');
    expect(open.stop?.time).toBeCloseTo(3.1, 6);
    expect(degreesAbout(turnPath(open, 'lid'), Z).at(-1)).toBeCloseTo(270, 4);
    expect(mateSeries(open, door)!.values.at(-1)).toBeCloseTo(270, 4);
    // Kept at one angle, it cannot turn: the study stops at that limit.
    const shut0 = { ...door, limit: { min: 0, max: 0 } };
    const stuck = computeMotion({ bodies, mates: [shut0], motors: [{ id: 'mo', name: 'RotaryMotor1', kind: 'rotary', on: shut0, at: profileOf('rotary', { profile: 'constant', speed: 90 }, 4) }], duration: 4, fps: 10, scale: 100 });
    expect(stuck.stop?.kind).toBe('limit');
    expect(stuck.stop?.mate).toBe(door.id);
    // The other way it is at its end already.
    const shut = run(-90);
    expect(shut.stop?.kind).toBe('limit');
    expect(shut.frames).toHaveLength(1);
    // Dragged round past 180°, it stops at 270°.
    const s = new MateSolver(bodies, [door]);
    let pl = new Map([['base', start], ['lid', start]]);
    for (let k = 1; k <= 32; k++) pl = s.solve({ drag: { kind: 'rotate', body: 'lid', q: qAxisAngle(Z, (k * 10 * Math.PI) / 180) } }, s.mates, pl).placements;
    expect(mateMeasure(door, pl)!.value).toBeCloseTo(-90, 3);
  });

  /** Two gears on hinges, 30 mm apart: A (pitch Ø20) at the origin, B (Ø40) beside it. */
  const gears = (extra: Partial<SolverMate> = {}) => {
    const bodies = [body('g', true), body('A', false), body('B', false, [30, 0, 0])];
    const mates = [hinge('g', [0, 0, 0], 'A', [0, 0, 0]), hinge('g', [30, 0, 0], 'B', [0, 0, 0]), mate('gear', ['A', axis([0, 0, 0])], ['B', axis([0, 0, 0], [0, 0, -1])], { value: 20, value2: 40, ...extra })];
    return new MateSolver(bodies, mates);
  };

  it('a gear mate couples two turns by the ratio, the other way round, past ±180°', () => {
    const s = gears();
    const r = s.analyze();
    expect(r.status).toBe('under');
    expect(r.dof).toBe(1);
    // Turning A by 30° steps to 390° (dragged round): B turns half as far the other way, also past 180°.
    let pl = r.placements;
    let a = 0, b = 0;
    for (let k = 1; k <= 13; k++) {
      const next = s.solve({ drag: { kind: 'rotate', body: 'A', q: qAxisAngle(Z, (k * 30 * Math.PI) / 180) } }, s.mates, pl);
      expect(next.ok).toBe(true);
      a += turnAbout(next.placements.get('A')!.q, pl.get('A')!.q, Z);
      b += turnAbout(next.placements.get('B')!.q, pl.get('B')!.q, Z);
      pl = next.placements;
    }
    expect(deg(a)).toBeCloseTo(390, 2);
    expect(deg(b)).toBeCloseTo(-195, 2);
    // B's orientation is that turn, not one wrapped to ±180°.
    expect(dot(qRotate(pl.get('B')!.q, [1, 0, 0]), [Math.cos(b), Math.sin(b), 0])).toBeCloseTo(1, 6);
    // Reversed (an internal gear): the same way round.
    const rev = gears({ reverse: true });
    const turned = rev.solve({ drag: { kind: 'rotate', body: 'A', q: qAxisAngle(Z, 0.5) } }, rev.mates);
    expect(turnAbout(turned.placements.get('B')!.q, [0, 0, 0, 1], Z)).toBeCloseTo(0.25, 5);
  });

  it('a gear mate contradicting the mates before it is over defined; a repeated or consistent one is not', () => {
    const s = gears();
    const [h1, h2, g1] = s.mates;
    const other = { ...g1, id: 'g2', value2: 60 };
    const r = new MateSolver(s.bodies, [h1, h2, g1, other]).analyze();
    expect(r.status).toBe('over');
    expect([...r.conflicts]).toEqual(['g2']);
    expect(r.dof).toBe(1);
    expect(new MateSolver(s.bodies, [h1, h2, g1, { ...g1, id: 'g3' }]).analyze().status).toBe('under');
    // Three external gears in a ring cannot turn; with an internal one (reversed) they can.
    const C = body('C', false, [15, 26, 0]);
    const ring = (reverse: boolean) => [h1, h2, hinge('g', [15, 26, 0], 'C', [0, 0, 0]), { ...g1, value2: 20 }, mate('gear', ['B', axis([0, 0, 0])], ['C', axis([0, 0, 0])], { value: 20, value2: 20 }), mate('gear', ['C', axis([0, 0, 0])], ['A', axis([0, 0, 0])], { value: 20, value2: 20, reverse, id: 'last' })];
    const odd = new MateSolver([...s.bodies, C], ring(false)).analyze();
    expect([...odd.conflicts]).toEqual(['last']);
    const even = new MateSolver([...s.bodies, C], ring(true)).analyze();
    expect(even.status).toBe('under');
    expect(even.dof).toBe(1);
    // A gear meshing with a fixed one just holds it.
    const held = new MateSolver(s.bodies, [h1, h2, mate('gear', ['A', axis([0, 0, 0])], ['g', axis([30, 0, 0])], { value: 20, value2: 40 })]).analyze();
    expect(held.conflicts.size).toBe(0);
    expect(held.defined.has('A')).toBe(true);
  });

  it('dragging one gear by a tooth turns the other', () => {
    const s = gears();
    let pl = s.analyze().placements;
    // Grab A's rim at (10, 0) and pull it up: A turns, and B with it.
    for (let k = 1; k <= 6; k++) pl = s.solve({ drag: { kind: 'move', body: 'A', local: [10, 0, 0], target: [10, 3 * k, 0] } }, s.mates, pl).placements;
    const ta = angleZ(pl.get('A')!.q), tb = angleZ(pl.get('B')!.q);
    expect(ta).toBeGreaterThan(0.5);
    expect(tb).toBeCloseTo(-ta / 2, 5);
  });

  it('a gear pair keeps its ratio over a full turn of a motor', () => {
    const s = gears();
    const res = computeMotion({ bodies: s.bodies, mates: s.mates, motors: [rotary('A', axis([0, 0, 0]), 360)], duration: 1.5, fps: 40, scale: 100 });
    expect(res.stop).toBeNull();
    expect(res.frames).toHaveLength(61);
    const a = degreesAbout(turnPath(res, 'A'), Z), b = degreesAbout(turnPath(res, 'B'), Z);
    expect(a[60]).toBeCloseTo(540, 4);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(-a[i] / 2, 4);
    // Angular velocity from the frames: 360°/s and −180°/s.
    const w = derivatives(res.times, b).d1;
    expect(w[30]).toBeCloseTo(-180, 3);
  });

  it('a motor (or a gear it drives) turning more than half a turn a frame is followed in smaller steps', () => {
    // 1000 rpm at 30 frames a second: 200° a frame.
    const s = gears();
    const fast = computeMotion({ bodies: s.bodies, mates: s.mates, motors: [rotary('A', axis([0, 0, 0]), 1000, { at: profileOf('rotary', { profile: 'constant', speed: 1000, rpm: true }, 1) })], duration: 0.5, fps: 30, scale: 100 });
    expect(fast.stop).toBeNull();
    expect(fast.times[fast.times.length - 1]).toBeCloseTo(0.5, 12);
    for (let i = 1; i < fast.times.length; i++) expect(fast.times[i]).toBeGreaterThan(fast.times[i - 1]);
    expect(degreesAbout(turnPath(fast, 'A'), Z).at(-1)).toBeCloseTo(3000, 3);
    expect(degreesAbout(turnPath(fast, 'B'), Z).at(-1)).toBeCloseTo(-1500, 3);
    // A slow motor on the large gear: the small one turns 240° a frame.
    const big = new MateSolver(s.bodies, [s.mates[0], s.mates[1], { ...s.mates[2], value: 40, value2: 10 }]);
    const res = computeMotion({ bodies: big.bodies, mates: big.mates, motors: [rotary('A', axis([0, 0, 0]), 1800)], duration: 0.5, fps: 30, scale: 100 });
    expect(res.stop).toBeNull();
    expect(degreesAbout(turnPath(res, 'B'), Z).at(-1)).toBeCloseTo(-3600, 3);
  });

  /** A pinion (Ø20) on a hinge at the origin, its rack below it sliding along x. */
  const rackAndPinion = (extra: Partial<SolverMate> = {}) => {
    const bodies = [body('g', true), body('P', false), body('R', false, [0, -10, 0])];
    const mates = [
      hinge('g', [0, 0, 0], 'P', [0, 0, 0]),
      mate('coincident', ['g', plane([0, -10, 0], [0, 1, 0])], ['R', plane([0, 0, 0], [0, 1, 0])]),
      mate('coincident', ['g', plane([0, 0, 0], Z)], ['R', plane([0, 0, 0], Z)]),
      mate('rackPinion', ['P', axis([0, 0, 0])], ['R', { kind: 'line', p: [0, 0, 0], d: [1, 0, 0] }], { value: 20, ...extra }),
    ];
    return new MateSolver(bodies, mates);
  };

  it('rack and pinion: turning the pinion moves the rack, and dragging the rack turns the pinion', () => {
    const s = rackAndPinion();
    expect(s.analyze().dof).toBe(1);
    const res = computeMotion({ bodies: s.bodies, mates: s.mates, motors: [rotary('P', axis([0, 0, 0]), 90)], duration: 1, fps: 20, scale: 100 });
    expect(res.stop).toBeNull();
    // A quarter turn moves the rack by a quarter of the pitch circle, the way the pinion's bottom moves.
    expect(res.frames[20].get('R')!.p[0]).toBeCloseTo((Math.PI / 2) * 10, 5);
    // Dragged 10π mm along: the pinion turns half a turn (past 90°, in steps as a pointer moves).
    let pl = s.analyze().placements;
    for (let k = 1; k <= 10; k++) pl = s.solve({ drag: { kind: 'move', body: 'R', local: [0, 0, 0], target: [k * Math.PI, -10, 0] } }, s.mates, pl).placements;
    expect(pl.get('R')!.p[0]).toBeCloseTo(10 * Math.PI, 3);
    expect(Math.abs(deg(angleZ(pl.get('P')!.q)))).toBeCloseTo(180, 2);
    // Pulled 50 mm in one pointer move (more than half a turn of the pinion): the rack follows, the pinion turns 5 rad with it.
    for (const dx of [50, 80]) {
      const one = s.solve({ drag: { kind: 'move', body: 'R', local: [0, 0, 0], target: [dx, -10, 0] } }, s.mates, s.analyze().placements);
      expect(one.ok).toBe(true);
      expect(one.placements.get('R')!.p[0]).toBeCloseTo(dx, 3);
      const t = dx / 10;
      expect(dot(qRotate(one.placements.get('P')!.q, [1, 0, 0]), [Math.cos(t), Math.sin(t), 0])).toBeCloseTo(1, 6);
    }
    // A mate's new value moving the rack 50 or 100 mm at once: the pinion turns with it (not a conflict).
    for (const v of [50, 100]) {
      const to = mate('distance', ['g', plane([0, 0, 0], [1, 0, 0])], ['R', plane([0, 0, 0], [1, 0, 0])], { value: v });
      const r = new MateSolver(s.bodies, [...s.mates, to]).analyze();
      expect(r.status).toBe('full');
      expect(r.placements.get('R')!.p[0]).toBeCloseTo(v, 6);
      expect(dot(qRotate(r.placements.get('P')!.q, [1, 0, 0]), [Math.cos(v / 10), Math.sin(v / 10), 0])).toBeCloseTo(1, 6);
    }
    // A rack along the pinion's axis is refused.
    const along = { ...s.mates[3], b: { body: 'R', geo: { kind: 'line', p: [0, 0, 0], d: [0, 0, 1] } as Geo } };
    const bad = new MateSolver(s.bodies, [...s.mates.slice(0, 3), along]).analyze();
    expect(bad.status).toBe('error');
    expect(bad.invalid.get(along.id)).toMatch(/across the pinion's axis/);
    // Along the axis where it was put, across it where the other mates put it: told where they end up
    // (so the assembly opened again, solved where it was saved, says the same).
    const turnedR = body('R', false, [0, -10, 0], qAxisAngle([0, 1, 0], -Math.PI / 2));
    const squared = [...s.mates.slice(0, 2), mate('parallel', ['g', plane([0, 0, 0], Z)], ['R', plane([0, 0, 0], Z)]), s.mates[3]];
    const first = new MateSolver([s.bodies[0], s.bodies[1], turnedR], squared).analyze();
    expect(first.invalid.size).toBe(0);
    const reopened = new MateSolver([s.bodies[0], s.bodies[1], { ...turnedR, placement: first.placements.get('R')! }], squared).analyze();
    expect([reopened.status, reopened.dof]).toEqual([first.status, first.dof]);
    // By travel per turn, and reversed.
    const per = rackAndPinion({ by: 'revolution', value: 50, reverse: true });
    const r2 = computeMotion({ bodies: per.bodies, mates: per.mates, motors: [rotary('P', axis([0, 0, 0]), 360)], duration: 1, fps: 30, scale: 100 });
    expect(r2.frames[30].get('R')!.p[0]).toBeCloseTo(-50, 4);
  });

  it('a screw turns a nut along its axis by the pitch per turn, right or left hand', () => {
    const run = (reverse: boolean) => {
      const mates = [mate('screw', ['g', axis([0, 0, 0])], ['N', axis([0, 0, 0])], { value: 2, reverse })];
      const s = new MateSolver([body('g', true), body('N', false, [0, 0, 5])], mates);
      expect(s.analyze().dof).toBe(1);
      return computeMotion({ bodies: s.bodies, mates, motors: [rotary('N', axis([0, 0, 0]), 360)], duration: 3, fps: 24, scale: 50 });
    };
    const right = run(false);
    expect(right.stop).toBeNull();
    expect(right.frames[72].get('N')!.p[2]).toBeCloseTo(11, 4);
    expect(run(true).frames[72].get('N')!.p[2]).toBeCloseTo(-1, 4);
  });

  it('a width mate centres a tab in a groove', () => {
    const groove: [Geo, Geo] = [plane([-10, 0, 0], [1, 0, 0]), plane([10, 0, 0], [-1, 0, 0])];
    const tab: [Geo, Geo] = [plane([-3, 0, 0], [-1, 0, 0]), plane([3, 0, 0], [1, 0, 0])];
    const m = mate('width', ['g', groove[0]], ['T', tab[0]], { a2: { body: 'g', geo: groove[1] }, b2: { body: 'T', geo: tab[1] } });
    const s = new MateSolver([body('g', true), body('T', false, [6, 2, 1], qAxisAngle([0, 1, 0], 0.2))], [m]);
    const r = s.analyze();
    expect(r.dof).toBe(3);
    const t = r.placements.get('T')!;
    expect(t.p[0]).toBeCloseTo(0, 6);
    expect(Math.abs(qRotate(t.q, [1, 0, 0])[0])).toBeCloseTo(1, 8);
    const skew = { ...m, a2: { body: 'g', geo: plane([10, 0, 0], normalize([-1, 1, 0])) } };
    expect(new MateSolver(s.bodies, [skew]).analyze().invalid.get(skew.id)).toMatch(/parallel/);
  });

  it('a slot mate keeps a pin on the slot, between its ends', () => {
    const m = mate('slot', ['g', axis([0, 0, 0], Z, 3)], ['pin', axis([0, 0, 0], Z, 3)], { a2: { body: 'g', geo: axis([30, 0, 0], Z, 3) } });
    const s = new MateSolver([body('g', true), body('pin', false, [10, 5, 3], qAxisAngle([1, 0, 0], 0.2))], [m]);
    const r = s.analyze();
    expect(r.dof).toBe(3);
    const p = r.placements.get('pin')!;
    expect(p.p[1]).toBeCloseTo(0, 6);
    expect(dot(qRotate(p.q, Z), Z)).toBeCloseTo(1, 8);
    expect(mateMeasure(m, r.placements)!.value).toBeCloseTo(p.p[0], 6);
    // Dragged past the end, it stops there.
    let pl = r.placements;
    for (let k = 1; k <= 5; k++) pl = s.solve({ drag: { kind: 'move', body: 'pin', local: [0, 0, 0], target: [10 + 10 * k, 0, p.p[2]] } }, s.mates, pl).placements;
    expect(pl.get('pin')!.p[0]).toBeCloseTo(30, 4);
    const same = { ...m, a2: { body: 'g', geo: axis([0, 0, 9], Z, 3) } };
    expect(new MateSolver(s.bodies, [same]).analyze().invalid.get(same.id)).toMatch(/same axis/);
  });

  it('mates of more than two components link them for dragging', () => {
    const m = mate('width', ['a', plane([0, 0, 0], [1, 0, 0])], ['b', plane([0, 0, 0], [1, 0, 0])], { a2: { body: 'c', geo: plane([1, 0, 0], [1, 0, 0]) }, b2: { body: 'b', geo: plane([1, 0, 0], [1, 0, 0]) } });
    expect(mateBodies(m)).toEqual(['a', 'b', 'c']);
    const bodies = [body('a', false), body('b', false), body('c', false), body('d', false)];
    expect(matesMoving('c', bodies, [m]).map((x) => x.id)).toEqual([m.id]);
  });
});

describe('motion studies', () => {
  const r = 20, l = 60;
  /** A crank (r), rod (l) and slider on x, the crank at θ0 (degrees). */
  const crankSlider = (theta0: number, extraMates: SolverMate[] = []) => {
    const th = (theta0 * Math.PI) / 180;
    const pin: Vec3 = [r * Math.cos(th), r * Math.sin(th), 0];
    const phi = Math.asin((-r * Math.sin(th)) / l);
    const x = pin[0] + l * Math.cos(phi);
    const bodies = [body('g', true), body('crank', false, [0, 0, 0], qAxisAngle(Z, th)), body('rod', false, pin, qAxisAngle(Z, phi)), body('slider', false, [x, 0, 0])];
    const mates = [
      hinge('g', [0, 0, 0], 'crank', [0, 0, 0]),
      hinge('crank', [r, 0, 0], 'rod', [0, 0, 0]),
      hinge('rod', [l, 0, 0], 'slider', [0, 0, 0]),
      mate('coincident', ['g', plane([0, 0, 0], [0, 1, 0])], ['slider', plane([0, 0, 0], [0, 1, 0])]),
      ...extraMates,
    ];
    return { bodies, mates };
  };
  const slide = (theta: number) => {
    const t = (theta * Math.PI) / 180;
    return r * Math.cos(t) + Math.sqrt(l * l - r * r * Math.sin(t) ** 2);
  };

  it('a crank-slider has one degree of freedom and its slider follows the closed-form position', () => {
    const cs = crankSlider(30);
    expect(new MateSolver(cs.bodies, cs.mates).analyze().dof).toBe(1);
    const res = computeMotion({ ...cs, motors: [rotary('crank', axis([0, 0, 0]), 90)], duration: 4, fps: 25, scale: 200 });
    expect(res.stop).toBeNull();
    expect(res.times).toHaveLength(101);
    res.frames.forEach((f, i) => expect(f.get('slider')!.p[0]).toBeCloseTo(slide(30 + 90 * res.times[i]), 4));
    // Velocity and acceleration of the slider from the frames, against the derivatives of the formula.
    const path = pointPath(res, 'slider', [0, 0, 0]);
    const { d1, d2 } = vectorDerivatives(res.times, path);
    const h = 1e-4, x = (t: number) => slide(30 + 90 * t);
    const v = (t: number) => (x(t + h) - x(t - h)) / (2 * h), a = (t: number) => (x(t + h) - 2 * x(t) + x(t - h)) / (h * h);
    expect(d1[50][0]).toBeCloseTo(v(2), 0);
    expect(d2[50][0] / a(2)).toBeCloseTo(1, 1);
    // A crank angle reading past a full turn: 30° + 360°.
    expect(degreesAbout(turnPath(res, 'crank'), Z)[100]).toBeCloseTo(360, 3);
  });

  it('stops at a limit and says which', () => {
    // The slider kept beyond 45 mm from the crank's axis: the crank turning down toward 180° pushes it there.
    const limit = mate('distance', ['g', plane([0, 0, 0], [1, 0, 0])], ['slider', plane([0, 0, 0], [1, 0, 0])], { limit: { min: 45, max: 100 }, value: 60 });
    const cs = crankSlider(30, [limit]);
    const res = computeMotion({ ...cs, motors: [rotary('crank', axis([0, 0, 0]), 90)], duration: 4, fps: 25, scale: 200, names: new Map([[limit.id, 'LimitDistance1']]) });
    expect(res.stop?.kind).toBe('limit');
    expect(res.stop?.mate).toBe(limit.id);
    expect(res.stop?.message).toMatch(/LimitDistance1 reached its limit/);
    const last = res.frames[res.frames.length - 1].get('slider')!.p[0];
    expect(last).toBeGreaterThan(45 - 1e-6);
    expect(last).toBeLessThan(47);
  });

  it('reports a mechanism that locks up', () => {
    // The crank also held at its angle by an angle mate: the motor cannot turn it.
    const held = mate('angle', ['g', plane([0, 0, 0], [0, 1, 0])], ['crank', plane([0, 0, 0], [0, 1, 0])], { value: 30 });
    const cs = crankSlider(30, [held]);
    const res = computeMotion({ ...cs, motors: [rotary('crank', axis([0, 0, 0]), 90)], duration: 1, fps: 10, scale: 200 });
    expect(res.stop?.kind).toBe('locked');
    expect(res.stop?.time).toBeCloseTo(0.1, 6);
    expect(res.frames).toHaveLength(1);
  });

  it('drives a distance mate by a ramp, and the crank follows', () => {
    const drive = mate('distance', ['g', plane([0, 0, 0], [1, 0, 0])], ['slider', plane([0, 0, 0], [1, 0, 0])], { value: slide(30) });
    const cs = crankSlider(30, [drive]);
    expect(new MateSolver(cs.bodies, cs.mates).analyze().dof).toBe(0);
    const motor: MotorInput = { id: 'mo', name: 'MateDriver1', kind: 'mate', mate: drive.id, at: profileOf('mate', { profile: 'ramp', from: slide(30), to: 50 }, 2) };
    const run = new MotionRun({ ...cs, motors: [motor], duration: 2, fps: 10, scale: 200 });
    let steps = 0;
    while (run.step()) steps++;
    expect(steps).toBe(19);
    expect(run.done).toBe(true);
    const res = run.result;
    expect(res.stop).toBeNull();
    res.frames.forEach((f, i) => expect(f.get('slider')!.p[0]).toBeCloseTo(slide(30) + ((50 - slide(30)) * res.times[i]) / 2, 5));
    // The crank's angle where the slider is at 50 mm: r cos θ + √(l² − r² sin² θ) = 50.
    const th = angleZ(res.frames[20].get('crank')!.q);
    expect(slide(deg(th))).toBeCloseTo(50, 4);
    // The mate's measure as a result: its distance.
    expect(mateSeries(res, drive)!.values[20]).toBeCloseTo(50, 5);
  });

  it('profiles: constant speed (deg/s or rpm), oscillation, ramp, reversed', () => {
    expect(profileOf('rotary', { profile: 'constant', speed: 90 }, 1)(2)).toBeCloseTo(Math.PI, 12);
    expect(profileOf('rotary', { profile: 'constant', speed: 60, rpm: true }, 1)(0.5)).toBeCloseTo(Math.PI, 9);
    expect(profileOf('linear', { profile: 'oscillate', amplitude: 10, frequency: 0.25, reverse: true }, 1)(1)).toBeCloseTo(-10, 12);
    expect(profileOf('mate', { profile: 'constant', speed: 5 }, 1, 20)(2)).toBe(30);
    expect(profileOf('mate', { profile: 'ramp', from: 10, to: 30 }, 4)(1)).toBe(15);
    expect(profileOf('mate', { profile: 'ramp', from: 10, to: 30 }, 4)(9)).toBe(30);
  });

  it('a linear motor moves a component along a direction', () => {
    const mates = [mate('coincident', ['g', plane([0, 0, 0], [0, 1, 0])], ['s', plane([0, 0, 0], [0, 1, 0])]), mate('coincident', ['g', plane([0, 0, 0], Z)], ['s', plane([0, 0, 0], Z)])];
    const motor: MotorInput = { id: 'mo', name: 'LinearMotor1', kind: 'linear', body: 's', entity: { body: 's', geo: { kind: 'line', p: [0, 0, 0], d: [1, 0, 0] } }, at: profileOf('linear', { profile: 'oscillate', amplitude: 10, frequency: 0.5 }, 2) };
    const res = computeMotion({ bodies: [body('g', true), body('s', false)], mates, motors: [motor], duration: 2, fps: 20, scale: 100 });
    res.frames.forEach((f, i) => expect(f.get('s')!.p[0]).toBeCloseTo(10 * Math.sin(Math.PI * res.times[i]), 6));
  });

  it('frames keep only the components that move (a long study of a large assembly fits in memory)', () => {
    const cs = crankSlider(30);
    // 500 components the mechanism does not touch, one of them turned and floating.
    const idle = Array.from({ length: 500 }, (_, i) => body(`idle${i}`, i > 0, [i, 50, 0], i === 1 ? qAxisAngle(Z, 0.5) : [0, 0, 0, 1]));
    const res = computeMotion({ bodies: [...cs.bodies, ...idle], mates: cs.mates, motors: [rotary('crank', axis([0, 0, 0]), 90)], duration: 4, fps: 25, scale: 200 });
    expect(res.stop).toBeNull();
    expect(res.frames).toHaveLength(101);
    expect(res.frames[50].size).toBeLessThan(10);
    // The others read where they are.
    expect(res.frames[50].has('idle1')).toBe(true);
    expect(res.frames[50].get('idle1')).toEqual(idle[1].placement);
    expect(pointPath(res, 'idle1', [1, 0, 0])[100]).toEqual(pointPath(res, 'idle1', [1, 0, 0])[0]);
    expect(degreesAbout(turnPath(res, 'idle1'), Z)[100]).toBe(0);
    res.frames.forEach((f, i) => expect(f.get('slider')!.p[0]).toBeCloseTo(slide(30 + 90 * res.times[i]), 4));
    const gap = mate('distance', ['idle1', plane([0, 0, 0], [1, 0, 0])], ['slider', plane([0, 0, 0], [1, 0, 0])], { value: 0 });
    const series = mateSeries(res, gap)!.values;
    expect(series[100] - series[0]).toBeCloseTo(slide(390) - slide(30), 4);
  });

  it('spreads interference checks over the time, and groups components that moved together', () => {
    // Frames 0.1 s apart, then (a fast stretch) 0.025 s apart.
    const times = [0, 0.1, 0.2, 0.225, 0.25, 0.275, 0.3, 0.325, 0.35, 0.375, 0.4];
    expect(framesSpread(times, 5)).toEqual([0, 1, 2, 6, 10]);
    expect(framesSpread(times, 50)).toHaveLength(11);
    // As many as asked for, each a frame of its own (frames 0.1 s apart where 0.05 s would be wanted).
    const picks = framesSpread([0, 0.1, 0.2, 0.3, 0.325, 0.35, 0.375, 0.4], 7);
    expect(picks).toEqual([0, 1, 2, 3, 4, 5, 7]);
    expect(framesSpread([0], 40)).toEqual([0]);
    const at = (p: Vec3, q: Quat = [0, 0, 0, 1]): Placement => ({ p, q });
    const turn = qAxisAngle(Z, 0.7);
    const from = [at([0, 0, 0]), at([10, 0, 0]), at([0, 5, 0]), at([3, 3, 3]), at([1, 2, 3])];
    // 0 and 1 still; 2 and 3 turned together about z; 4 moved.
    const rot = (p: Placement): Placement => ({ p: qRotate(turn, p.p), q: turn });
    const g = sameMotionGroups(from, [from[0], from[1], rot(from[2]), rot(from[3]), at([1, 2, 4])]);
    expect(g[0]).toBe(g[1]);
    expect(g[2]).toBe(g[3]);
    expect(new Set([g[0], g[2], g[4]]).size).toBe(3);
  });

  it('differentiates samples and writes CSV', () => {
    const t = [0, 0.1, 0.2, 0.3, 0.4];
    const { d1, d2 } = derivatives(t, t.map((x) => x * x));
    expect(d1[2]).toBeCloseTo(0.4, 12);
    expect(d2[2]).toBeCloseTo(2, 9);
    expect(d2[0]).toBeCloseTo(2, 9);
    // At the first and last samples too: the velocity of t² there, and of a harmonic motion's acceleration (zero at its middle position).
    expect(d1[0]).toBeCloseTo(0, 12);
    expect(d1[4]).toBeCloseTo(0.8, 12);
    const ts = Array.from({ length: 31 }, (_, i) => i / 30), x = ts.map((s) => 10 * Math.sin(2 * Math.PI * s));
    const h = derivatives(ts, x), peak = 10 * (2 * Math.PI) ** 2;
    expect(Math.abs(h.d2[0])).toBeLessThan(0.02 * peak);
    expect(Math.abs(h.d2[30])).toBeLessThan(0.02 * peak);
    expect(h.d1[0] / (20 * Math.PI)).toBeCloseTo(1, 1);
    // Frames not evenly spaced (a study took smaller steps between 0.5 s and 0.8 s): the slope where the steps change is as good as elsewhere.
    const tu: number[] = [];
    for (let k = 0; k <= 20; k++) { if (k > 5 && k <= 8) for (let j = 1; j < 4; j++) tu.push((k - 1 + j / 4) / 10); tu.push(k / 10); }
    const f = (s: number) => 400 * Math.sin(2 * Math.PI * s), df = (s: number) => 800 * Math.PI * Math.cos(2 * Math.PI * s);
    const even = Array.from({ length: 21 }, (_, k) => k / 10), de = derivatives(even, even.map(f)).d1;
    const worstEven = Math.max(...even.map((s, i) => Math.abs(de[i] - df(s))));
    const du = derivatives(tu, tu.map(f)).d1;
    tu.forEach((s, i) => expect(Math.abs(du[i] - df(s))).toBeLessThanOrEqual(worstEven + 1e-9));
    expect(derivatives([0, 0.5], [1, 2]).d1).toEqual([2, 2]);
    expect(resultsCsv([{ name: 'Time (s)', values: [0, 0.5] }, { name: 'X, mm', values: [1, 2.25] }])).toBe('Time (s),"X, mm"\n0,1\n0.5,2.25');
    expect(len(sub(pointPath({ times: [0], frames: [new Map([['a', { p: [1, 2, 3], q: [0, 0, 0, 1] }]])], stop: null, duration: 1 }, 'a', [1, 0, 0])[0], [2, 2, 3]))).toBe(0);
  });
});

describe('slider, cam and universal joint mates', () => {
  const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0];
  const line = (p: Vec3, d: Vec3): Geo => ({ kind: 'line', p, d });
  const at0: Placement = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  /** A slider of `b` along x on the ground's x axis (straight edges), from where b is. */
  const slider = (b: SolverBody, extra: Partial<SolverMate> = {}) => mate('slider', ['g', line([0, 0, 0], X)], [b.id, line([0, 0, 0], X)], { rel: relativePlacement(at0, b.placement), ...extra });

  it('a slider on straight edges leaves one move along them, no turn, and stops at its travel limits', () => {
    const blk = body('blk', false, [5, 3, -2]);
    const s = new MateSolver([body('g', true), blk], [slider(blk, { limit: { min: -10, max: 20 } })]);
    const r = s.analyze();
    expect(r.status).toBe('under');
    expect(r.dof).toBe(1);
    const p = r.placements.get('blk')!;
    expect(Math.hypot(p.p[1], p.p[2])).toBeLessThan(1e-6);
    expect(p.q[3]).toBeCloseTo(1, 9);
    // Dragged up and along: it only slides, and stops 20 mm from where it was added.
    let pl = r.placements;
    for (let k = 1; k <= 8; k++) pl = s.solve({ drag: { kind: 'move', body: 'blk', local: [0, 0, 0], target: [5 + 5 * k, 30, 0] } }, s.mates, pl).placements;
    expect(pl.get('blk')!.p[0]).toBeCloseTo(25, 4);
    expect(pl.get('blk')!.p[1]).toBeCloseTo(0, 6);
    expect(mateMeasure(s.mates[0], pl)!.value).toBeCloseTo(20, 4);
    // A turn about the edge is held too.
    const turned = s.solve({ drag: { kind: 'rotate', body: 'blk', q: qAxisAngle(X, 0.8) } }, s.mates, pl);
    expect(turned.placements.get('blk')!.q[3]).toBeCloseTo(1, 6);
  });

  it('a slider on two faces of each component slides along the line where they meet', () => {
    const m = mate('slider', ['g', plane([0, 0, 0], Y)], ['blk', plane([0, 0, 0], [0, -1, 0])], {
      a2: { body: 'g', geo: plane([0, 0, 0], Z) }, b2: { body: 'blk', geo: plane([0, 0, 0], [0, 0, -1]) }, aligned: false, aligned2: false, rel: at0,
    });
    const r = new MateSolver([body('g', true), body('blk', false, [7, 4, 3], qAxisAngle(normalize([1, 1, 1]), 0.2))], [m]).analyze();
    expect(r.dof).toBe(1);
    const p = r.placements.get('blk')!;
    expect(Math.hypot(p.p[1], p.p[2])).toBeLessThan(1e-6);
    const bad = { ...m, a2: { body: 'g', geo: plane([0, 5, 0], Y) } };
    expect(new MateSolver([body('g', true), body('blk', false)], [bad]).analyze().invalid.get(bad.id)).toMatch(/must not be parallel/);
  });

  it('motors on a slider and on a hinge drive them directly', () => {
    const blk = body('blk', false, [0, 0, 0]);
    const sl = slider(blk);
    const lin: MotorInput = { id: 'mo', name: 'LinearMotor1', kind: 'linear', on: sl, at: profileOf('linear', { profile: 'constant', speed: 4 }, 3) };
    const res = computeMotion({ bodies: [body('g', true), blk], mates: [sl], motors: [lin], duration: 3, fps: 10, scale: 100 });
    expect(res.stop).toBeNull();
    res.frames.forEach((f, i) => expect(f.get('blk')!.p[0]).toBeCloseTo(4 * res.times[i], 6));
    // A hinge whose second component is fixed: the first turns, the other way.
    const h = hinge('arm', [0, 0, 0], 'g', [0, 0, 0]);
    const rot: MotorInput = { id: 'mo', name: 'RotaryMotor1', kind: 'rotary', on: h, at: profileOf('rotary', { profile: 'constant', speed: 90 }, 1) };
    const r2 = computeMotion({ bodies: [body('g', true), body('arm', false)], mates: [h], motors: [rot], duration: 1, fps: 20, scale: 100 });
    expect(r2.stop).toBeNull();
    expect(degreesAbout(turnPath(r2, 'arm'), Z)[20]).toBeCloseTo(-90, 5);
  });

  /** A cam turning on a hinge about z at the origin; a follower sliding along y on the line x = 0. */
  const camRig = (profile: Geo, follower: Geo, y0: number) => {
    const fol = body('fol', false, [0, y0, 0]);
    const mates = [
      hinge('g', [0, 0, 0], 'cam', [0, 0, 0]),
      mate('slider', ['g', line([0, 0, 0], Y)], ['fol', line([0, 0, 0], Y)], { rel: relativePlacement(at0, fol.placement) }),
      mate('cam', ['cam', profile], ['fol', follower]),
    ];
    const drive: MotorInput = { id: 'mo', name: 'RotaryMotor1', kind: 'rotary', on: mates[0], at: profileOf('rotary', { profile: 'constant', speed: 90 }, 4) };
    return { bodies: [body('g', true), body('cam', false), fol], mates, motors: [drive] };
  };
  const e = 6, R = 20;
  /** An eccentric: a round face of radius R whose axis is e from the turning axis (its low side up at first). */
  const eccentric = camProfile(Z, [{ c: [0, -e, 0], r: R }], []);

  it('an eccentric cam lifts a flat follower by e(1 − cos θ) over a turn', () => {
    expect(eccentric.circle).not.toBeNull();
    const rig = camRig(eccentric, plane([0, 0, 0], [0, -1, 0]), R - e);
    expect(new MateSolver(rig.bodies, rig.mates).analyze().dof).toBe(1);
    const res = computeMotion({ ...rig, duration: 4, fps: 60, scale: 100 });
    expect(res.stop).toBeNull();
    const theta = degreesAbout(turnPath(res, 'cam'), Z).map((d) => (d * Math.PI) / 180);
    expect(theta[240]).toBeCloseTo(2 * Math.PI, 6);
    res.frames.forEach((f, i) => expect(f.get('fol')!.p[1] - (R - e)).toBeCloseTo(e * (1 - Math.cos(theta[i])), 7));
  });

  it('roller and knife-edge followers on an eccentric match the closed form', () => {
    const rho = 5;
    const lift = (th: number, r: number) => { const cx = e * Math.sin(th), cy = -e * Math.cos(th); return cy + Math.sqrt(r * r - cx * cx); };
    for (const [follower, r] of [[axis([0, 0, 0], Z, rho), R + rho], [{ kind: 'point', p: [0, 0, 0] } as Geo, R]] as [Geo, number][]) {
      const rig = camRig(eccentric, follower, r - e);
      const res = computeMotion({ ...rig, duration: 4, fps: 60, scale: 100 });
      expect(res.stop).toBeNull();
      const theta = degreesAbout(turnPath(res, 'cam'), Z).map((d) => (d * Math.PI) / 180);
      res.frames.forEach((f, i) => expect(f.get('fol')!.p[1]).toBeCloseTo(lift(theta[i], r), 7));
    }
  });

  it('a lobed cam (arcs and corners) lifts a flat follower to its nose; a hollow profile is refused', () => {
    // A base circle of 20 and a nose of 5 at 25 above the axis, joined by tangent lines (touching both at 90° ± 53.13°).
    const p = (r: number, deg: number, c: Vec3 = [0, 0, 0]): Vec3 => [c[0] + r * Math.cos((deg * Math.PI) / 180), c[1] + r * Math.sin((deg * Math.PI) / 180), 0];
    const t = (Math.acos(0.6) * 180) / Math.PI, nose: Vec3 = [0, 25, 0];
    const lobed = camProfile(Z, [{ c: [0, 0, 0], r: 20, ends: [p(20, 90 + t), p(20, 90 - t), p(20, 270)] }, { c: nose, r: 5, ends: [p(5, 90 - t, nose), p(5, 90 + t, nose), p(5, 90, nose)] }], []);
    expect(lobed.concave).toBeLessThan(1e-9);
    const rig = camRig(lobed, plane([0, 0, 0], [0, -1, 0]), 30);
    const res = computeMotion({ ...rig, duration: 2, fps: 60, scale: 100 });
    expect(res.stop).toBeNull();
    expect(res.frames[0].get('fol')!.p[1]).toBeCloseTo(30, 6);
    // Half a turn: the base circle under the follower.
    expect(res.frames[120].get('fol')!.p[1]).toBeCloseTo(20, 7);
    // A notch: corners of a square with one side dented in.
    const notched = camProfile(Z, [], [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [0, 4, 0], [-10, 10, 0]]);
    expect(notched.concave).toBeCloseTo(6, 9);
    const bad = new MateSolver(rig.bodies, [...rig.mates.slice(0, 2), mate('cam', ['cam', notched], ['fol', plane([0, 0, 0], [0, -1, 0])])]).analyze();
    expect([...bad.invalid.values()][0]).toMatch(/hollow 6 mm deep/);
  });

  /** Two shafts on hinges, meeting at the origin: a along z, b at β to it in the xz plane. */
  const uJoint = (betaDeg: number) => {
    const b = (betaDeg * Math.PI) / 180;
    const db: Vec3 = [Math.sin(b), 0, Math.cos(b)];
    const qb = qAxisAngle(Y, b);
    const bodies = [body('g', true), body('A', false), body('B', false, [0, 0, 0], qb)];
    const mates = [
      hinge('g', [0, 0, 0], 'A', [0, 0, 0]),
      mate('hinge', ['g', { kind: 'axis', p: [0, 0, 0], d: db, r: 2, surface: 'cylinder' }], ['B', axis([0, 0, 0])], { a2: { body: 'g', geo: plane([0, 0, 0], db) }, b2: { body: 'B', geo: plane([0, 0, 0], [0, 0, -1]) }, aligned2: false }),
      mate('universal', ['A', axis([0, 0, 0])], ['B', axis([0, 0, 0])], { rel: relativePlacement(at0, { p: [0, 0, 0], q: qb }) }),
    ];
    return { bodies, mates, db, b };
  };

  it('a universal joint turns its output by atan(tan φ / cos β) over a full turn, with that velocity ratio', () => {
    const u = uJoint(30);
    expect(new MateSolver(u.bodies, u.mates).analyze().dof).toBe(1);
    const motor: MotorInput = { id: 'mo', name: 'RotaryMotor1', kind: 'rotary', on: u.mates[0], at: profileOf('rotary', { profile: 'constant', speed: 90 }, 4) };
    const res = computeMotion({ bodies: u.bodies, mates: u.mates, motors: [motor], duration: 4, fps: 90, scale: 100 });
    expect(res.stop).toBeNull();
    const phi = degreesAbout(turnPath(res, 'A'), Z).map((d) => (d * Math.PI) / 180);
    const out = degreesAbout(turnPath(res, 'B'), u.db).map((d) => (d * Math.PI) / 180);
    // The closed form, unwrapped past ±90° and ±180°.
    let prev = 0, acc = 0;
    const expected = phi.map((f) => { const a = Math.atan2(Math.sin(f), Math.cos(u.b) * Math.cos(f)); let d = a - prev; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI)); acc += d; prev = a; return acc; });
    expect(phi[360]).toBeCloseTo(2 * Math.PI, 6);
    out.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6));
    expect(out[360]).toBeCloseTo(2 * Math.PI, 6);
    // Velocity ratio from the frames against cos β / (cos²β cos²φ + sin²φ).
    const w1 = derivatives(res.times, phi).d1, w2 = derivatives(res.times, out).d1;
    for (const i of [0, 45, 90, 135, 200, 300]) {
      const f = phi[i], k = Math.cos(u.b) / (Math.cos(u.b) ** 2 * Math.cos(f) ** 2 + Math.sin(f) ** 2);
      expect(w2[i] / w1[i]).toBeCloseTo(k, 2);
    }
  });

  it('a universal joint with straight shafts turns 1:1, and can hold its joint point', () => {
    const u = uJoint(0);
    const motor: MotorInput = { id: 'mo', name: 'RotaryMotor1', kind: 'rotary', on: u.mates[0], at: profileOf('rotary', { profile: 'constant', speed: 120 }, 3) };
    const res = computeMotion({ bodies: u.bodies, mates: u.mates, motors: [motor], duration: 3, fps: 30, scale: 100 });
    const a = degreesAbout(turnPath(res, 'A'), Z), b = degreesAbout(turnPath(res, 'B'), Z);
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 6));
    expect(a[90]).toBeCloseTo(360, 5);
    // Free shafts with a joint point 10 along a's axis: b's axis passes through it.
    const joint = mate('universal', ['A', axis([0, 0, 0])], ['B', axis([0, 0, 0])], { rel: relativePlacement(at0, { p: [3, 4, 30], q: qAxisAngle(Y, 0.4) }), by: 'point', value: 10 });
    const r = new MateSolver([body('A', true), body('B', false, [3, 4, 30], qAxisAngle(Y, 0.4))], [joint]).analyze();
    expect(r.dof).toBe(3);
    const pb = r.placements.get('B')!;
    const db = qRotate(pb.q, Z);
    const off = sub([0, 0, 10], pb.p);
    expect(len([off[1] * db[2] - off[2] * db[1], off[2] * db[0] - off[0] * db[2], off[0] * db[1] - off[1] * db[0]])).toBeLessThan(1e-6);
  });

  it('a universal joint between shafts at 90° is refused (it cannot turn), one at 89° works', () => {
    const square = uJoint(90);
    const r = new MateSolver(square.bodies, square.mates).analyze();
    expect(r.status).toBe('error');
    expect(r.invalid.get(square.mates[2].id)).toMatch(/90°/);
    const steep = uJoint(89);
    const s = new MateSolver(steep.bodies, steep.mates).analyze();
    expect(s.invalid.size).toBe(0);
    expect(s.dof).toBe(1);
  });
});

describe('cam profiles from part faces', () => {
  const deg = (r: number, a: number, c: Vec3 = [0, 0, 0], z = 0): Vec3 => [c[0] + r * Math.cos((a * Math.PI) / 180), c[1] + r * Math.sin((a * Math.PI) / 180), z];
  const t = (Math.acos(0.6) * 180) / Math.PI, nose: Vec3 = [0, 25, 0];
  const cyl = (name: string, c: Vec3, r: number) => ({ name, type: 'cylinder', center: c, area: 1, axis: { p: c, d: Z }, radius: r, feature: 'E1' });
  const flat = (name: string, n: Vec3, c: Vec3) => ({ name, type: 'plane', center: c, area: 1, normal: n, feature: 'E1' });
  const arc = (name: string, face: number, c: Vec3, r: number, a0: number, a1: number, am: number) => ({ name, type: 'circle', a: deg(r, a0, c), b: deg(r, a1, c), mid: deg(r, am, c), length: (r * Math.abs(a1 - a0) * Math.PI) / 180, faces: [face], center: c, axis: Z, radius: r });
  const seg = (name: string, face: number, a: Vec3, b: Vec3) => ({ name, type: 'line', a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0] as Vec3, length: len(sub(b, a)), faces: [face], dir: normalize(sub(b, a)) });
  // A lobed cam: base circle 20, nose 5 at 25, two flanks tangent to both.
  const lobed = {
    mesh: null, bbox: null, cones: {},
    faces: [cyl('base', [0, 0, 0], 20), cyl('nose', nose, 5), flat('right', normalize(deg(1, 90 - t)), deg(20, 90 - t)), flat('left', normalize(deg(1, 90 + t)), deg(20, 90 + t))],
    edges: [
      arc('e0', 0, [0, 0, 0], 20, 90 + t, 90 - t + 360, 270), arc('e1', 1, nose, 5, 90 - t, 90 + t, 90),
      seg('e2', 2, deg(20, 90 - t), deg(5, 90 - t, nose)), seg('e3', 3, deg(20, 90 + t), deg(5, 90 + t, nose)),
      // Where the sides meet, along the axis (base and right flank, right flank and nose, ...).
      ...([[0, 2, deg(20, 90 - t)], [2, 1, deg(5, 90 - t, nose)], [1, 3, deg(5, 90 + t, nose)], [3, 0, deg(20, 90 + t)]] as [number, number, Vec3][]).map(([f, g, p], k) => ({ ...seg(`s${k}`, f, p, [p[0], p[1], 10]), faces: [f, g] })),
    ],
  } as unknown as PartGeometry;
  const ref = (name: string) => ({ name, sig: { type: 'x', c: [0, 0, 0] as Vec3, area: 1 } });

  it('reads arcs from round faces and their edges, corners from flat faces, and an eccentric as a circle', () => {
    const p = camProfileOf(lobed, ['base', 'nose', 'right', 'left'].map(ref), 'Cam<1>');
    if (typeof p === 'string') throw new Error(p);
    expect(p.circle).toBeNull();
    expect(p.concave).toBeLessThan(1e-9);
    const up = profileSupport(p, [dot(Y3, p.u), dot(Y3, p.v)]), down = profileSupport(p, [-dot(Y3, p.u), -dot(Y3, p.v)]);
    expect(up).toBeCloseTo(30, 9);
    expect(down).toBeCloseTo(20, 9);
    // Just the base face, whole: a circle.
    const whole = camProfileOf({ ...lobed, faces: [cyl('base', [5, 0, 0], 20)], edges: [{ ...arc('e', 0, [5, 0, 0], 20, 0, 360, 180), a: deg(20, 0, [5, 0, 0]), b: deg(20, 0, [5, 0, 0]) }] } as unknown as PartGeometry, [ref('base')], 'Cam<1>');
    expect(typeof whole !== 'string' && whole.circle?.r).toBe(20);
    // An end face (across the axis) is not part of a profile.
    expect(camProfileOf({ ...lobed, faces: [...lobed.faces, flat('end', Z, [0, 0, 10])] } as unknown as PartGeometry, ['base', 'end'].map(ref), 'Cam<1>')).toMatch(/one direction/);
  });

  it('refuses a profile that does not go all the way round (the follower would ride across the gap)', () => {
    for (const some of [['base', 'nose'], ['right', 'left'], ['base', 'nose', 'right']]) expect(camProfileOf(lobed, some.map(ref), 'Cam<1>')).toMatch(/all the way round/);
    expect(typeof camProfileOf(lobed, ['left', 'nose', 'base', 'right'].map(ref), 'Cam<1>')).toBe('object');
  });
});
