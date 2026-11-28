// Random small assemblies (a fixed seed each): plain and mechanical mates with
// limits, gears, racks, screws, slots, width, cams and universal joints between
// 3 to 8 components, one of them grounded. Every one must keep the invariants:
// the degrees of freedom are the rank deficiency of the mates' Jacobian, every
// motion called free keeps the mates (to second order), nothing turns NaN or
// throws, solving again where it was saved changes nothing, and a motion study
// on each hinge or slider stays within every limit and stops with a message.
import { expect, it } from 'vitest';
import { type Geo, MateSolver, type SolverBody, type SolverMate, applyPlacement, camProfile, mateMeasure, matrixRank, nullSpace, relativePlacement, rotVecQuat } from '../src/assembly/solver';
import { type MotorInput, computeMotion, profileOf } from '../src/assembly/motion';
import { type Quat, type Vec3, add, qMul, qNormalize, qRotate, sub, normalize } from '../src/math/vec';
import type { MateType, Placement } from '../src/model/assembly';

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const Z: Vec3 = [0, 0, 1], X: Vec3 = [1, 0, 0];
type R = () => number;
const pickOf = <T,>(r: R, a: T[]) => a[Math.floor(r() * a.length)];

function makeAssembly(seed: number) {
  const r = rng(seed);
  const nb = 3 + Math.floor(r() * 6);
  const bodies: SolverBody[] = [{ id: 'g', fixed: true, placement: { p: [0, 0, 0], q: [0, 0, 0, 1] }, center: [0, 0, 0] }];
  for (let i = 1; i < nb; i++) {
    const q = qNormalize([r() - 0.5, r() - 0.5, r() - 0.5, 1 + r()] as Quat);
    bodies.push({ id: `b${i}`, fixed: r() < 0.1, placement: { p: [(r() - 0.5) * 80, (r() - 0.5) * 80, (r() - 0.5) * 80], q: r() < 0.5 ? [0, 0, 0, 1] : q }, center: [r() * 10, r() * 10, r() * 10] });
  }
  const pl = new Map(bodies.map((b) => [b.id, b.placement]));
  const rel = (a: string, b: string) => relativePlacement(pl.get(a)!, pl.get(b)!);
  const axis = (p: Vec3 = [0, 0, 0], d: Vec3 = Z, rad = 2): Geo => ({ kind: 'axis', p, d, r: rad, surface: 'cylinder' });
  const plane = (o: Vec3, n: Vec3): Geo => ({ kind: 'plane', o, n });
  const line = (p: Vec3, d: Vec3): Geo => ({ kind: 'line', p, d });
  const mates: SolverMate[] = [];
  const nm = 1 + Math.floor(r() * (nb + 2));
  let k = 0;
  for (let i = 0; i < nm; i++) {
    const ids = bodies.map((b) => b.id);
    const a = pickOf(r, ids);
    let b = pickOf(r, ids);
    if (b === a) b = ids[(ids.indexOf(a) + 1) % ids.length];
    const base = { id: `m${++k}`, aligned: r() < 0.7, value: 0, flip: r() < 0.2 };
    const lim = (lo: number, hi: number) => { const x = lo + r() * (hi - lo), y = lo + r() * (hi - lo); return r() < 0.15 ? { min: x, max: x } : { min: Math.min(x, y), max: Math.max(x, y) }; };
    const t: MateType = pickOf(r, ['coincident', 'concentric', 'distance', 'angle', 'parallel', 'hinge', 'hinge', 'slider', 'gear', 'rackPinion', 'screw', 'width', 'slot', 'cam', 'universal', 'distance', 'angle'] as MateType[]);
    const P = (): Vec3 => [Math.round((r() - 0.5) * 20), Math.round((r() - 0.5) * 20), Math.round((r() - 0.5) * 20)];
    const N = (): Vec3 => pickOf(r, [X, Z, [0, 1, 0], [0, 0, -1], [-1, 0, 0]] as Vec3[]);
    let m: SolverMate;
    switch (t) {
      case 'coincident': case 'parallel': m = { ...base, type: t, a: { body: a, geo: plane(P(), N()) }, b: { body: b, geo: plane(P(), N()) } }; break;
      case 'concentric': m = { ...base, type: t, a: { body: a, geo: axis(P(), N()) }, b: { body: b, geo: axis(P(), N()) } }; break;
      case 'distance': m = { ...base, type: t, value: r() * 30, a: { body: a, geo: r() < 0.5 ? plane(P(), N()) : { kind: 'point', p: P() } }, b: { body: b, geo: r() < 0.5 ? plane(P(), N()) : { kind: 'point', p: P() } }, ...(r() < 0.6 ? { limit: lim(-10, 40) } : {}) }; break;
      case 'angle': m = { ...base, type: t, value: r() * 180, a: { body: a, geo: plane(P(), N()) }, b: { body: b, geo: plane(P(), N()) }, ...(r() < 0.6 ? { limit: lim(0, 180) } : {}) }; break;
      case 'hinge': m = { ...base, type: t, a: { body: a, geo: axis(P()) }, b: { body: b, geo: axis(P()) }, a2: { body: a, geo: plane([0, 0, 0], Z) }, b2: { body: b, geo: plane([0, 0, 0], [0, 0, -1]) }, aligned2: r() < 0.3, ...(r() < 0.5 ? { rel: rel(a, b), limit: lim(-200, 200) } : {}) }; break;
      case 'slider': m = { ...base, type: t, rel: rel(a, b), a: { body: a, geo: line(P(), X) }, b: { body: b, geo: line(P(), X) }, ...(r() < 0.5 ? { limit: lim(-30, 30) } : {}) }; break;
      case 'gear': m = { ...base, type: t, value: 5 + r() * 40, value2: 5 + r() * 40, reverse: r() < 0.3, a: { body: a, geo: axis(P()) }, b: { body: b, geo: axis(P(), r() < 0.3 ? X : Z) } }; break;
      case 'rackPinion': m = { ...base, type: t, value: 5 + r() * 40, by: r() < 0.3 ? 'revolution' : undefined, a: { body: a, geo: axis(P()) }, b: { body: b, geo: line(P(), pickOf(r, [X, [0, 1, 0], Z] as Vec3[])) } }; break;
      case 'screw': m = { ...base, type: t, value: (r() - 0.5) * 6, a: { body: a, geo: axis(P()) }, b: { body: b, geo: axis(P()) } }; break;
      case 'width': { const w = 5 + r() * 10, tw = r() * 8; m = { ...base, type: t, a: { body: a, geo: plane([-w, 0, 0], X) }, a2: { body: a, geo: plane([w, 0, 0], [-1, 0, 0]) }, b: { body: b, geo: plane([-tw, 0, 0], [-1, 0, 0]) }, b2: { body: b, geo: plane([tw, 0, 0], X) } }; break; }
      case 'slot': m = { ...base, type: t, a: { body: a, geo: axis([0, 0, 0]) }, a2: { body: a, geo: axis([r() < 0.1 ? 0 : 5 + r() * 30, 0, 0]) }, b: { body: b, geo: r() < 0.5 ? axis(P()) : { kind: 'point', p: P() } } }; break;
      case 'cam': { const prof = r() < 0.5 ? camProfile(Z, [{ c: [0, -3 - r() * 5, 0], r: 10 + r() * 10 }], []) : camProfile(Z, [], [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [r() < 0.3 ? 0 : -10, r() < 0.3 ? 4 : 10, 0]]); m = { ...base, type: t, a: { body: a, geo: prof }, b: { body: b, geo: pickOf(r, [{ kind: 'point', p: P() }, axis(P(), Z, 3), plane(P(), [0, -1, 0]), plane(P(), Z)] as Geo[]) } }; break; }
      default: m = { ...base, type: 'universal', rel: rel(a, b), a: { body: a, geo: axis(P()) }, b: { body: b, geo: axis(P(), r() < 0.5 ? Z : normalize([0.3, 0, 1])) }, ...(r() < 0.3 ? { by: 'point', value: r() * 10 } : {}) };
    }
    mates.push(m);
  }
  return { bodies, mates };
}

const finitePl = (pl: Map<string, Placement>) => [...pl.values()].every((p) => [...p.p, ...p.q].every(Number.isFinite));

function placementWith(base: Placement, center: Vec3, x: number[], L: number): Placement {
  const dq = rotVecQuat([x[3], x[4], x[5]]);
  const c = applyPlacement(base, center);
  return { p: add(add(qRotate(dq, sub(base.p, c)), c), [x[0] * L, x[1] * L, x[2] * L]), q: qNormalize(qMul(dq, base.q)) };
}

function fuzzOne(seed: number, log: string[]) {
  const { bodies, mates } = makeAssembly(seed);
  const L = 100;
  const s = new MateSolver(bodies, mates);
  let an;
  try { an = s.analyze({ scale: L }); } catch (e) { log.push(`seed ${seed}: analyze threw ${(e as Error).stack}`); return; }
  if (!finitePl(an.placements)) { log.push(`seed ${seed}: non-finite placements`); return; }
  // (a) DOF vs rank of an independent Jacobian of the active mates (all floating bodies).
  const active = mates.filter((m) => !an.conflicts.has(m.id) && !an.invalid.has(m.id));
  const floating = bodies.filter((b) => !b.fixed);
  const n = floating.length * 6;
  const pl = an.placements;
  const rows: number[][] = [];
  const allHold = active.every((m) => (s.mateResidual(m, pl, L, pl, true) ?? [Infinity]).every((v) => Math.abs(v) < 1e-6));
  for (const m of active) {
    const r0 = s.mateResidual(m, pl, L, pl, false) ?? [];
    const blk = r0.map(() => new Array<number>(n).fill(0));
    floating.forEach((b, bi) => {
      for (let j = 0; j < 6; j++) {
        const x = [0, 0, 0, 0, 0, 0];
        x[j] = 1e-6; const rp = s.mateResidual(m, new Map(pl).set(b.id, placementWith(pl.get(b.id)!, b.center ?? [0, 0, 0], x, L)), L, pl, false) ?? [];
        x[j] = -1e-6; const rm = s.mateResidual(m, new Map(pl).set(b.id, placementWith(pl.get(b.id)!, b.center ?? [0, 0, 0], x, L)), L, pl, false) ?? [];
        for (let i = 0; i < r0.length; i++) blk[i][bi * 6 + j] = (rp[i] - rm[i]) / 2e-6;
      }
    });
    rows.push(...blk);
  }
  const dof = n - matrixRank(rows, n);
  // Every motion the rank calls free keeps the mates to second order (a residual with a vanishing gradient would not).
  if (allHold && n) {
    for (const v of nullSpace(rows, n).basis) {
      const mx = Math.max(...v.map(Math.abs));
      const moved = new Map(pl);
      floating.forEach((b, bi) => moved.set(b.id, placementWith(pl.get(b.id)!, b.center ?? [0, 0, 0], v.slice(bi * 6, bi * 6 + 6).map((x) => (x / mx) * 1e-4), L)));
      let worst = 0, who = '';
      for (const m of active) { if (m.type === 'cam') continue; const rr = s.mateResidual(m, moved, L, pl, false) ?? []; for (const x of rr) if (Math.abs(x) > worst) { worst = Math.abs(x); who = `${m.id} ${m.type}`; } }
      if (worst > 1e-5) { log.push(`seed ${seed}: a free motion breaks ${who} by ${worst.toExponential(2)}`); break; }
    }
  }
  if (dof !== an.dof && allHold) log.push(`seed ${seed}: dof ${an.dof} reported, rank says ${dof} (status ${an.status}, types ${active.map((m) => m.type).join(',')})`);
  // (b) drags never produce NaN or throw.
  const r = rng(seed + 7);
  for (const b of floating.slice(0, 3)) {
    try {
      const d = s.solve({ scale: L, drag: r() < 0.5 ? { kind: 'move', body: b.id, local: [0, 0, 0], target: [(r() - 0.5) * 100, (r() - 0.5) * 100, (r() - 0.5) * 100] } : { kind: 'rotate', body: b.id, q: qNormalize([r() - 0.5, r() - 0.5, r() - 0.5, r()]) }, maxIter: 25 }, active, pl);
      if (!finitePl(d.placements)) log.push(`seed ${seed}: drag gave non-finite placements`);
    } catch (e) { log.push(`seed ${seed}: drag threw ${(e as Error).stack}`); }
  }
  // (c) solving again from the solved (saved) placements keeps them.
  if (an.status !== 'over' && allHold) {
    const again = new MateSolver(bodies.map((b) => ({ ...b, placement: pl.get(b.id)! })), mates).analyze({ scale: L });
    let worst = 0;
    for (const [id, p] of again.placements) { const q = pl.get(id)!; worst = Math.max(worst, Math.hypot(...sub(p.p, q.p)), Math.min(Math.hypot(...p.q.map((v, i) => v - q.q[i])), Math.hypot(...p.q.map((v, i) => v + q.q[i])))); }
    if (worst > 1e-3) log.push(`seed ${seed}: re-solve moved by ${worst.toExponential(2)}`);
    if (again.dof !== an.dof || again.status !== an.status) log.push(`seed ${seed}: re-solve status ${an.status}/${an.dof} -> ${again.status}/${again.dof}`);
  }
  // (d) a motion study over each hinge or slider.
  for (const m of active.filter((x) => x.type === 'hinge' || x.type === 'slider')) {
    if (mates.every((x) => x === m || !x)) continue;
    const motor: MotorInput = { id: 'mo', name: 'Motor', kind: m.type === 'hinge' ? 'rotary' : 'linear', on: m, at: profileOf(m.type === 'hinge' ? 'rotary' : 'linear', { profile: 'oscillate', amplitude: m.type === 'hinge' ? 120 : 25, frequency: 0.5 }, 2) };
    if (m.a.body && m.b.body && bodies.find((b) => b.id === m.a.body)?.fixed && bodies.find((b) => b.id === m.b.body)?.fixed) continue;
    let res;
    try { res = computeMotion({ bodies: bodies.map((b) => ({ ...b, placement: pl.get(b.id)! })), mates: active, motors: [motor], duration: 2, fps: 15, scale: L, names: new Map(mates.map((x) => [x.id, `Mate ${x.id}`])) }); } catch (e) { log.push(`seed ${seed}: motion threw ${(e as Error).stack}`); continue; }
    if (!res.frames.every(finitePl)) log.push(`seed ${seed}: motion NaN`);
    if (res.stop && (!res.stop.message || /undefined|NaN/.test(res.stop.message))) log.push(`seed ${seed}: bad stop message ${res.stop.message}`);
    for (const x of active) {
      if (!x.limit) continue;
      for (const f of res.frames) {
        const v = mateMeasure(x, f, L);
        if (!v) continue;
        let val = v.value;
        if (x.type === 'hinge') { if (x.limit.max - x.limit.min >= 360) continue; const mid = (x.limit.min + x.limit.max) / 2; val = mid + ((((val - mid + 180) % 360) + 360) % 360) - 180; }
        const tol = v.kind === 'angle' ? 1e-3 : 1e-3;
        if (x.type === 'angle' || x.type === 'distance' || x.type === 'slider' || x.type === 'hinge') {
          if (x.type === 'distance' && x.limit.min < 0 && !(x.a.geo.kind === 'plane' || x.b.geo.kind === 'plane')) continue;
          if (val < x.limit.min - tol || val > x.limit.max + tol) { log.push(`seed ${seed}: ${x.type} limit [${x.limit.min.toFixed(2)}, ${x.limit.max.toFixed(2)}] exceeded: ${val.toFixed(4)} (motor on ${m.type} ${m.id}, frame ok)`); break; }
        }
      }
    }
  }
}


it('random assemblies keep the solver invariants', () => {
  const log: string[] = [];
  // Seeds 5, 187 (and 402) and 2107 found a rack checked where it started, bevel gears flipping sense and a turned-over slider.
  for (const seed of [...Array.from({ length: 40 }, (_, i) => i + 1), 187, 402, 2107]) fuzzOne(seed, log);
  expect(log).toEqual([]);
}, 60_000);
