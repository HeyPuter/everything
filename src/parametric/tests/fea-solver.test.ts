// Accuracy of the static stress analysis against closed-form results, on
// parts built and triangulated by the real kernel and meshed with 10-node
// tetrahedra: a cantilever (Euler-Bernoulli deflection and bending stress),
// a bar in tension (F/A, FL/AE), a plate with a hole (stress concentration),
// equilibrium of reactions and loads, gravity, and an under-constrained study.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import type { FaceInfo } from '../src/kernel/protocol';
import { SurfaceIndex } from '../src/fea/surface';
import { meshSolid } from '../src/fea/mesher';
import { type LoadInput, type StaticInput, StudyError, solveStatic } from '../src/fea/static';
import type { Feature } from '../src/model/types';
import { circle, extrude, rect, req, sketch } from './helpers';

beforeAll(async () => {
  setOc(await init());
});

const STEEL = { E: 200000, nu: 0.3, density: 7.85e-9 };

async function meshOf(features: Feature[], size: number) {
  const b = new ModelBuilder();
  const res = await b.build(req(features, { quality: 1 }));
  expect(res.status.every((s) => s.ok)).toBe(true);
  const surf = new SurfaceIndex(b.feaSurface(size / 50));
  return { mesh: meshSolid(surf, { size }), faces: res.faces };
}

/** Index of the planar face whose outward normal is n and centre has coordinate k equal to v. */
function planar(faces: FaceInfo[], n: [number, number, number], k?: number, v?: number): number {
  const i = faces.findIndex((f) => f.type === 'plane' && f.normal && Math.abs(f.normal[0] - n[0]) + Math.abs(f.normal[1] - n[1]) + Math.abs(f.normal[2] - n[2]) < 1e-6 && (k === undefined || Math.abs(f.center[k] - v!) < 1e-6));
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
}

/** Value of a nodal field at the node nearest to p. */
function at(nodes: Float64Array, field: ArrayLike<number>, p: number[], stride = 1, comp = 0): number {
  let best = 0, bd = Infinity;
  for (let v = 0; v < nodes.length / 3; v++) {
    const d = (nodes[v * 3] - p[0]) ** 2 + (nodes[v * 3 + 1] - p[1]) ** 2 + (nodes[v * 3 + 2] - p[2]) ** 2;
    if (d < bd) { bd = d; best = v; }
  }
  return field[best * stride + comp];
}

describe('static analysis accuracy', () => {
  it('cantilever: tip deflection and bending stress (Euler-Bernoulli)', async () => {
    // 200 long (x), 20 deep (y), 10 wide (z); fixed at x = 0, 500 N down at the free end.
    const { mesh, faces } = await meshOf([sketch('s1', rect(0, 0, 200, 20)), extrude('f1', 's1', 10)], 2.5);
    const fixed = planar(faces, [-1, 0, 0]), tip = planar(faces, [1, 0, 0]);
    const F = 500, L = 200, I = (10 * 20 ** 3) / 12;
    const input: StaticInput = { ...STEEL, fixtures: [{ kind: 'fixed', faces: [fixed] }], loads: [{ kind: 'force', faces: [tip], total: F, dir: [0, -1, 0] }] };
    const r = solveStatic(mesh, input, undefined, console.log);
    const theory = (F * L ** 3) / (3 * STEEL.E * I);
    const tipDy = at(mesh.nodes, r.U, [200, 10, 5], 3, 1);
    console.log(`cantilever: ${r.dofs} dof, ${r.iterations} iterations, ${r.solver}, ms ${JSON.stringify(r.ms)}; tip ${tipDy} vs ${-theory}`);
    expect(-tipDy / theory).toBeGreaterThan(0.99);
    expect(-tipDy / theory).toBeLessThan(1.03);
    // Bending stress at mid span on the top and bottom fibres: M c / I.
    const sigma = (F * (L / 2) * 10) / I;
    const top = at(mesh.nodes, r.stress, [100, 20, 5], 6, 0), bottom = at(mesh.nodes, r.stress, [100, 0, 5], 6, 0);
    console.log(`bending stress ${top}, ${bottom} vs ${sigma}`);
    expect(top / sigma).toBeCloseTo(1, 1);
    expect(-bottom / sigma).toBeCloseTo(1, 1);
    // Equilibrium: the reaction balances the load.
    const sum = r.reactions[0].map((x, k) => x + r.applied[k]);
    expect(Math.hypot(...sum)).toBeLessThan(1e-5 * F);
    expect(r.applied[1]).toBeCloseTo(-F, 6);
  }, 120000);

  it('bar in tension: uniform stress F/A and elongation FL/AE', async () => {
    // 100 x 10 x 10, held by rollers on three faces (free to contract sideways).
    const { mesh, faces } = await meshOf([sketch('s1', rect(0, 0, 100, 10)), extrude('f1', 's1', 10)], 2.5);
    const F = 1000, A = 100, L = 100;
    const input: StaticInput = {
      ...STEEL,
      fixtures: [{ kind: 'roller', faces: [planar(faces, [-1, 0, 0])] }, { kind: 'roller', faces: [planar(faces, [0, -1, 0])] }, { kind: 'roller', faces: [planar(faces, [0, 0, -1])] }],
      loads: [{ kind: 'force', faces: [planar(faces, [1, 0, 0])], total: F, dir: null }],
    };
    // A normal force presses on the face: flipped (pulling) here by a negative value.
    input.loads[0] = { kind: 'force', faces: [planar(faces, [1, 0, 0])], total: -F, dir: null };
    const r = solveStatic(mesh, input);
    const ux = at(mesh.nodes, r.U, [100, 5, 5], 3, 0);
    expect(ux / ((F * L) / (A * STEEL.E))).toBeCloseTo(1, 2);
    let lo = Infinity, hi = -Infinity;
    for (let v = 0; v < mesh.nodes.length / 3; v++) { lo = Math.min(lo, r.stress[v * 6]); hi = Math.max(hi, r.stress[v * 6]); }
    console.log(`bar: stress ${lo}..${hi} vs ${F / A}; elongation ${ux}`);
    expect(Math.abs(lo / (F / A) - 1)).toBeLessThan(0.01);
    expect(Math.abs(hi / (F / A) - 1)).toBeLessThan(0.01);
    const total = r.reactions.reduce((s, x) => [s[0] + x[0], s[1] + x[1], s[2] + x[2]], [0, 0, 0]);
    expect(total[0]).toBeCloseTo(-F, 3);
  }, 120000);

  it('plate with a hole in tension: stress concentration about 3', async () => {
    // 120 x 60 x 4 plate with a 10 mm hole (d / W = 1/6); Peterson: Kt (gross) about 3.1.
    const { mesh, faces } = await meshOf([sketch('s1', [...rect(-60, -30, 60, 30), ...circle(0, 0, 5)]), extrude('f1', 's1', 4)], 2.5);
    const sNom = 10;
    const input: StaticInput = {
      ...STEEL,
      fixtures: [{ kind: 'roller', faces: [planar(faces, [-1, 0, 0])] }, { kind: 'roller', faces: [planar(faces, [0, 0, -1])] }, { kind: 'roller', faces: [planar(faces, [0, -1, 0])] }],
      loads: [{ kind: 'pressure', faces: [planar(faces, [1, 0, 0])], value: -sNom }],
    };
    // Symmetry would need a roller at y = 0; a roller on the bottom edge face holds y instead (it carries no load in x).
    const r = solveStatic(mesh, input, undefined, console.log);
    let peak = 0;
    for (let v = 0; v < mesh.nodes.length / 3; v++) if (Math.hypot(mesh.nodes[v * 3], mesh.nodes[v * 3 + 1]) < 5.5) peak = Math.max(peak, r.stress[v * 6]);
    console.log(`plate with hole: peak ${peak}, Kt ${peak / sNom}, ${r.dofs} dof, ${r.iterations} iterations, ms ${JSON.stringify(r.ms)}`);
    expect(peak / sNom).toBeGreaterThan(2.7);
    expect(peak / sNom).toBeLessThan(3.4);
  }, 120000);

  it('gravity: the reactions carry the weight', async () => {
    const { mesh, faces } = await meshOf([sketch('s1', rect(0, 0, 100, 20)), extrude('f1', 's1', 10)], 3);
    const g = 9810;
    const r = solveStatic(mesh, { ...STEEL, fixtures: [{ kind: 'fixed', faces: [planar(faces, [-1, 0, 0])] }], loads: [{ kind: 'gravity', accel: [0, -g, 0] }] });
    const weight = STEEL.density * 100 * 20 * 10 * g;
    expect(r.applied[1] / -weight).toBeCloseTo(1, 6);
    expect(r.reactions[0][1] / weight).toBeCloseTo(1, 6);
  }, 120000);

  it('explains an under-constrained study', async () => {
    const { mesh, faces } = await meshOf([sketch('s1', rect(0, 0, 100, 20)), extrude('f1', 's1', 10)], 4);
    const load: LoadInput = { kind: 'force', faces: [planar(faces, [1, 0, 0])], total: 100, dir: [0, -1, 0] };
    expect(() => solveStatic(mesh, { ...STEEL, fixtures: [], loads: [load] })).toThrow(StudyError);
    // A roller on one face leaves the part free to slide and turn in its plane.
    const err = (() => { try { solveStatic(mesh, { ...STEEL, fixtures: [{ kind: 'roller', faces: [planar(faces, [-1, 0, 0])] }], loads: [load] }); } catch (e) { return e as Error; } return null; })();
    expect(err).toBeInstanceOf(StudyError);
    expect(err!.message).toMatch(/free to move along Y/);
    expect(err!.message).toMatch(/free to move along Z/);
    expect(err!.message).toMatch(/free to turn about X/);
  }, 120000);
});
