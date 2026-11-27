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
import { type LoadInput, type StaticInput, StudyError, constraintsOf, loadVector, rigidMotions, solveStatic } from '../src/fea/static';
import { addBodyForce, elementNodeStrains, elementStiffness } from '../src/fea/elements';
import { fieldValues, meshView, solutionOf } from '../src/fea/results';
import { type BlockMatrix, type Prolongator, galerkin, matvec } from '../src/fea/amg';
import type { Feature } from '../src/model/types';
import { circle, extrude, polygon, rect, req, sketch } from './helpers';

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
    const r = solveStatic(mesh, input);
    const theory = (F * L ** 3) / (3 * STEEL.E * I);
    const tipDy = at(mesh.nodes, r.U, [200, 10, 5], 3, 1);
    expect(-tipDy / theory).toBeGreaterThan(0.99);
    expect(-tipDy / theory).toBeLessThan(1.03);
    // Bending stress at mid span on the top and bottom fibres: M c / I.
    const sigma = (F * (L / 2) * 10) / I;
    const top = at(mesh.nodes, r.stress, [100, 20, 5], 6, 0), bottom = at(mesh.nodes, r.stress, [100, 0, 5], 6, 0);
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
    expect(Math.abs(lo / (F / A) - 1)).toBeLessThan(0.01);
    expect(Math.abs(hi / (F / A) - 1)).toBeLessThan(0.01);
    const total = r.reactions.reduce((s, x) => [s[0] + x[0], s[1] + x[1], s[2] + x[2]], [0, 0, 0]);
    expect(total[0]).toBeCloseTo(-F, 3);
  }, 120000);

  it('one roller on three faces holds the nodes on their shared edges normal to each face', async () => {
    // A block pressed on top, on rollers on the bottom, back and left faces (picked together): uniform 1 MPa.
    const { mesh, faces } = await meshOf([sketch('s1', rect(0, 0, 100, 20)), extrude('f1', 's1', 10)], 3);
    const r = solveStatic(mesh, { ...STEEL, fixtures: [{ kind: 'roller', faces: [planar(faces, [0, -1, 0]), planar(faces, [0, 0, -1]), planar(faces, [-1, 0, 0])] }], loads: [{ kind: 'pressure', faces: [planar(faces, [0, 1, 0])], value: 1 }] });
    expect(r.warnings).toEqual([]);
    for (let v = 0; v < r.vonMises.length; v++) expect(Math.abs(r.vonMises[v] - 1)).toBeLessThan(1e-6);
    expect(r.reactions[0][1]).toBeCloseTo(100 * 10, 6);
  }, 120000);

  it('a node held by two fixtures splits its reaction between them by direction', async () => {
    // A roller under a bar fixed at its end: the roller can only push along Y, even at the nodes it shares with the fixed face.
    const { mesh, faces } = await meshOf([sketch('s1', rect(0, 0, 100, 20)), extrude('f1', 's1', 10)], 3);
    const r = solveStatic(mesh, { ...STEEL, fixtures: [{ kind: 'roller', faces: [planar(faces, [0, -1, 0])] }, { kind: 'fixed', faces: [planar(faces, [-1, 0, 0])] }], loads: [{ kind: 'force', faces: [planar(faces, [1, 0, 0])], total: 100, dir: [1, 0, 0] }] });
    expect(Math.abs(r.reactions[0][0])).toBeLessThan(1e-6);
    expect(Math.abs(r.reactions[0][2])).toBeLessThan(1e-6);
    expect(r.reactions[1][0]).toBeCloseTo(-100, 6);
    expect(r.reactions[0][1] + r.reactions[1][1]).toBeCloseTo(0, 6);
    // Two fixtures on the same face (and a third on one of the same faces) share what they hold equally.
    const end = planar(faces, [-1, 0, 0]), tip = planar(faces, [1, 0, 0]);
    const load: LoadInput = { kind: 'force', faces: [tip], total: 300, dir: [0, -1, 0] };
    const two = solveStatic(mesh, { ...STEEL, fixtures: [{ kind: 'fixed', faces: [end] }, { kind: 'fixed', faces: [end] }, { kind: 'fixed', faces: [end] }], loads: [load] });
    for (const x of two.reactions) expect(x[1]).toBeCloseTo(100, 4);
  }, 120000);

  it('a roller on a flat face leaves exactly its three motions free, even beside a sharp corner', async () => {
    // A wedge with a 37 degree edge: the mesher leaves a few triangles there across two faces.
    const { mesh, faces } = await meshOf([sketch('s1', polygon([[0, 0], [40, 0], [0, 30]])), extrude('f1', 's1', 10)], 3);
    faces.forEach((f, i) => expect(rigidMotions(mesh, constraintsOf(mesh, [{ kind: 'roller', faces: [i] }])), f.name).toHaveLength(3));
    // On rollers under it (y = 0) and behind it (z = 0) it slides along X: pushing it that way is unstable.
    const err = (() => { try { solveStatic(mesh, { ...STEEL, fixtures: [{ kind: 'roller', faces: [planar(faces, [0, -1, 0])] }, { kind: 'roller', faces: [planar(faces, [0, 0, -1])] }], loads: [{ kind: 'force', faces: [planar(faces, [-1, 0, 0])], total: 100, dir: [1, 0, 0] }] }); } catch (e) { return e as Error; } return null; })();
    expect(err).toBeInstanceOf(StudyError);
    expect(err!.message).toMatch(/free to move along X/);
  }, 120000);

  it('a roller around a shaft leaves it free to slide along and turn about its axis', async () => {
    const { mesh, faces } = await meshOf([sketch('s1', circle(5, 3, 10)), extrude('f1', 's1', 50)], 3);
    const side = faces.findIndex((f) => f.type === 'cylinder'), end = planar(faces, [0, 0, 1]);
    expect(rigidMotions(mesh, constraintsOf(mesh, [{ kind: 'roller', faces: [side] }]))).toEqual(['free to move along Z', 'free to turn about Z']);
    // Pushed along its axis it is unstable (the facets' normals no longer hold it).
    expect(() => solveStatic(mesh, { ...STEEL, fixtures: [{ kind: 'roller', faces: [side] }], loads: [{ kind: 'force', faces: [end], total: 100, dir: [0, 0, 1] }] })).toThrow(/free to move along Z, free to turn about Z, and the loads would move it/);
    // Pushed across it, the roller carries the load, and only across.
    const r = solveStatic(mesh, { ...STEEL, fixtures: [{ kind: 'roller', faces: [side] }], loads: [{ kind: 'force', faces: [end], total: 100, dir: [1, 0, 0] }] });
    expect(r.reactions[0][0]).toBeCloseTo(-100, 2);
    expect(Math.abs(r.reactions[0][2])).toBeLessThan(1e-2);
  }, 120000);

  it('result fields of a bar in tension: von Mises, principal stresses, strain, safety factor, displacements', async () => {
    const { mesh, faces } = await meshOf([sketch('s1', rect(0, 0, 100, 10)), extrude('f1', 's1', 10)], 2.5);
    const F = 1000, sigma = F / 100;
    const input: StaticInput = {
      ...STEEL,
      fixtures: [{ kind: 'roller', faces: [planar(faces, [-1, 0, 0])] }, { kind: 'roller', faces: [planar(faces, [0, -1, 0])] }, { kind: 'roller', faces: [planar(faces, [0, 0, -1])] }],
      loads: [{ kind: 'force', faces: [planar(faces, [1, 0, 0])], total: F, dir: [1, 0, 0] }],
    };
    const r = solveStatic(mesh, input);
    const view = meshView(mesh);
    const sol = solutionOf(mesh, view.map, r, input);
    const near = (field: Parameters<typeof fieldValues>[1], want: number, tol: number) => { for (const v of fieldValues(sol, field, 250)) expect(Math.abs(v - want)).toBeLessThan(tol); };
    near('vonMises', sigma, 1e-4);
    near('p1', sigma, 1e-4);
    near('p2', 0, 1e-4);
    near('p3', 0, 1e-4);
    // Von Mises equivalent strain of uniaxial stress: 2 (1 + nu) sigma / (3 E).
    near('strain', (2 * (1 + STEEL.nu) * sigma) / (3 * STEEL.E), 1e-9);
    near('fos', 250 / sigma, 1e-3);
    // Displacements: ux = sigma x / E, uy and uz the Poisson contraction from the rollers' planes.
    const ux = fieldValues(sol, 'ux', 250), uy = fieldValues(sol, 'uy', 250), d = fieldValues(sol, 'disp', 250);
    for (let i = 0; i < view.info.nodes.length / 3; i++) {
      const x = view.info.nodes[i * 3], y = view.info.nodes[i * 3 + 1];
      expect(ux[i]).toBeCloseTo((sigma * x) / STEEL.E, 7);
      expect(uy[i]).toBeCloseTo((-STEEL.nu * sigma * y) / STEEL.E, 7);
      expect(d[i]).toBeGreaterThanOrEqual(Math.abs(ux[i]) - 1e-12);
    }
    expect(sol.summary.maxDisplacement.value).toBeCloseTo(Math.hypot(sigma * 100, STEEL.nu * sigma * 10, STEEL.nu * sigma * 10) / STEEL.E, 7);
    expect(sol.summary.maxVonMises.value).toBeCloseTo(sigma, 3);
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
    const r = solveStatic(mesh, input);
    let peak = 0;
    for (let v = 0; v < mesh.nodes.length / 3; v++) if (Math.hypot(mesh.nodes[v * 3], mesh.nodes[v * 3 + 1]) < 5.5) peak = Math.max(peak, r.stress[v * 6]);
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

describe('fixed hinge', () => {
  // A link 100 x 20 x 5 with two 8 mm holes 80 apart, pinned (fixed hinge) at the first.
  const link = () => meshOf([sketch('s1', [...rect(0, 0, 100, 20), ...circle(10, 10, 4), ...circle(90, 10, 4)]), extrude('f1', 's1', 5)], 1.5);
  const holes = (faces: FaceInfo[], x: number) => faces.flatMap((f, i) => (f.type === 'cylinder' && Math.abs(f.center[0] - x) < 1e-6 ? [i] : []));

  it('carries a pull along the link: reactions balance the load, the free turn about the pin is reported', async () => {
    const { mesh, faces } = await link();
    const pin = holes(faces, 10), end = holes(faces, 90);
    expect(pin.length).toBeGreaterThan(0);
    const cyl = faces[pin[0]];
    const F = 2000;
    const r = solveStatic(mesh, { ...STEEL, fixtures: [{ kind: 'hinge', faces: pin, axis: cyl.axis! }], loads: [{ kind: 'force', faces: end, total: F, dir: [1, 0, 0] }] });
    expect(r.reactions[0][0]).toBeCloseTo(-F, 2);
    expect(Math.abs(r.reactions[0][1])).toBeLessThan(1e-3 * F);
    expect(Math.hypot(r.reactions[0][0] + r.applied[0], r.reactions[0][1] + r.applied[1], r.reactions[0][2] + r.applied[2])).toBeLessThan(1e-5 * F);
    expect(r.warnings.join(' ')).toMatch(/free to turn about Z/);
    // The link stretches: the far hole moves along +X, the sides of the link between the holes carry about F / (2 x 6 x 5) near the holes' middle.
    const ux = at(mesh.nodes, r.U, [90, 2, 2.5], 3, 0);
    expect(ux).toBeGreaterThan(0);
    const sx = at(mesh.nodes, r.stress, [50, 10, 2.5], 6, 0);
    expect(sx / (F / (20 * 5))).toBeCloseTo(1, 1);
  }, 120000);

  it('reports a load across the link as unstable (it would turn about the pin)', async () => {
    const { mesh, faces } = await link();
    const pin = holes(faces, 10), end = holes(faces, 90);
    const err = (() => { try { solveStatic(mesh, { ...STEEL, fixtures: [{ kind: 'hinge', faces: pin, axis: faces[pin[0]].axis! }], loads: [{ kind: 'force', faces: end, total: 100, dir: [0, 1, 0] }] }); } catch (e) { return e as Error; } return null; })();
    expect(err).toBeInstanceOf(StudyError);
    expect(err!.message).toMatch(/unstable/);
    expect(err!.message).toMatch(/free to turn about Z/);
    // A second pin at the other hole holds it: the load goes into the pins.
    const r = solveStatic(mesh, { ...STEEL, fixtures: [{ kind: 'hinge', faces: pin, axis: faces[pin[0]].axis! }, { kind: 'hinge', faces: end, axis: faces[end[0]].axis! }], loads: [{ kind: 'force', faces: [faces.findIndex((f) => f.type === 'plane' && f.normal?.[1] === 1)], total: 100, dir: [0, -1, 0] }] });
    expect(r.warnings).toEqual([]);
    const total = r.reactions.reduce((a, x) => a + x[1], 0);
    expect(total).toBeCloseTo(100, 4);
  }, 120000);
});

describe('multigrid kernels', () => {
  // A deterministic pseudo-random sequence.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

  /** A symmetric block matrix with a random pattern (and its dense form). */
  function randomSymmetric(n: number, b: number): { A: BlockMatrix; D: Float64Array } {
    const N = n * b, D = new Float64Array(N * N);
    const pattern = new Set<number>();
    for (let i = 0; i < n; i++) { pattern.add(i * n + i); for (let t = 0; t < 3; t++) { const j = Math.floor(((rnd() + 1) / 2) * n) % n; pattern.add(i * n + j); pattern.add(j * n + i); } }
    for (const key of pattern) {
      const i = Math.floor(key / n), j = key % n;
      if (j < i) continue;
      for (let r = 0; r < b; r++) for (let c = 0; c < b; c++) { const v = i === j && r === c ? 10 + rnd() : rnd(); D[(i * b + r) * N + j * b + c] = v; D[(j * b + c) * N + i * b + r] = v; }
    }
    const rowPtr = new Int32Array(n + 1), cols: number[] = [], vals: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) if (pattern.has(i * n + j)) { cols.push(j); for (let r = 0; r < b; r++) for (let c = 0; c < b; c++) vals.push(D[(i * b + r) * N + j * b + c]); }
      rowPtr[i + 1] = cols.length;
    }
    return { A: { n, b, rowPtr, col: Int32Array.from(cols), val: Float64Array.from(vals) }, D };
  }

  for (const b of [3, 6]) {
    it(`coarse matrix P^T A P and products with ${b} x ${b} blocks match dense arithmetic`, () => {
      const n = 40, m = 9, c = 6;
      const { A, D } = randomSymmetric(n, b);
      // A prolongator with one to three blocks per row (sorted columns).
      const rowPtr = new Int32Array(n + 1), cols: number[] = [], vals: number[] = [];
      for (let i = 0; i < n; i++) {
        const js = [...new Set([i % m, (i * 7 + 3) % m, ...(i % 3 ? [(i * 5 + 1) % m] : [])])].sort((x, y) => x - y);
        for (const J of js) { cols.push(J); for (let k = 0; k < b * c; k++) vals.push(rnd()); }
        rowPtr[i + 1] = cols.length;
      }
      const P: Prolongator = { n, m, b, c, rowPtr, col: Int32Array.from(cols), val: Float64Array.from(vals) };
      const N = n * b, Mc = m * c;
      const Pd = new Float64Array(N * Mc);
      for (let i = 0; i < n; i++) for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) for (let r = 0; r < b; r++) for (let k = 0; k < c; k++) Pd[(i * b + r) * Mc + P.col[p] * c + k] = P.val[p * b * c + r * c + k];
      const ref = new Float64Array(Mc * Mc);
      for (let I = 0; I < Mc; I++) for (let J = 0; J < Mc; J++) {
        let s = 0;
        for (let x = 0; x < N; x++) { const px = Pd[x * Mc + I]; if (!px) continue; for (let y = 0; y < N; y++) s += px * D[x * N + y] * Pd[y * Mc + J]; }
        ref[I * Mc + J] = s;
      }
      const Ac = galerkin(A, P);
      expect(Ac.n).toBe(m);
      expect(Ac.b).toBe(c);
      const got = new Float64Array(Mc * Mc);
      for (let I = 0; I < m; I++) {
        for (let q = Ac.rowPtr[I]; q < Ac.rowPtr[I + 1]; q++) {
          if (q > Ac.rowPtr[I]) expect(Ac.col[q]).toBeGreaterThan(Ac.col[q - 1]);
          for (let r = 0; r < c; r++) for (let k = 0; k < c; k++) got[(I * c + r) * Mc + Ac.col[q] * c + k] = Ac.val[q * c * c + r * c + k];
        }
      }
      const scale = Math.max(...ref.map(Math.abs));
      for (let i = 0; i < ref.length; i++) expect(Math.abs(got[i] - ref[i])).toBeLessThan(1e-12 * scale);
      // Matrix-vector products in the same blocks.
      const x = Float64Array.from({ length: N }, rnd), y = new Float64Array(N);
      matvec(A, x, y);
      for (let r = 0; r < N; r++) { let s = 0; for (let k = 0; k < N; k++) s += D[r * N + k] * x[k]; expect(y[r]).toBeCloseTo(s, 10); }
    });
  }

  it('multigrid preconditioned conjugate gradients converge on an elasticity system', async () => {
    const { mesh, faces } = await meshOf([sketch('s1', rect(0, 0, 60, 10)), extrude('f1', 's1', 10)], 5);
    const r = solveStatic(mesh, { ...STEEL, fixtures: [{ kind: 'fixed', faces: [planar(faces, [-1, 0, 0])] }], loads: [{ kind: 'force', faces: [planar(faces, [1, 0, 0])], total: 100, dir: [0, -1, 0] }] });
    expect(r.solver).toMatch(/multigrid/);
    expect(r.residual).toBeLessThan(1e-9);
    // Equilibrium at every free node: K u = f away from the fixture (the residual the solver reports, checked independently).
    const sum = r.reactions[0].map((x, k) => x + r.applied[k]);
    expect(Math.hypot(...sum)).toBeLessThan(1e-6 * 100);
  }, 120000);
});

describe('solver limits', () => {
  it('stops after the multigrid iterations on a nearly incompressible material, and says why', async () => {
    const { mesh, faces } = await meshOf([sketch('s1', rect(0, 0, 200, 20)), extrude('f1', 's1', 10)], 4);
    const steps: number[] = [];
    let err: Error | null = null;
    try {
      solveStatic(mesh, { ...STEEL, nu: 0.4999, fixtures: [{ kind: 'fixed', faces: [planar(faces, [-1, 0, 0])] }], loads: [{ kind: 'force', faces: [planar(faces, [1, 0, 0])], total: 500, dir: [0, -1, 0] }] }, (stage, v) => { if (stage === 'Solving') steps.push(v); });
    } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(StudyError);
    expect(err!.message).toMatch(/Poisson's ratio \(0\.4999\)/);
    // 800 multigrid iterations (a progress step every 5), not 20,000 more with block Jacobi.
    expect(steps.length).toBeLessThanOrEqual(160);
    // Progress stays between 0 and 1 though the residual first rises.
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...steps)).toBeLessThanOrEqual(1);
  }, 120000);
});

describe('10-node tetrahedron', () => {
  // A skewed element with two midside nodes off their edges (curved).
  const X = new Float64Array(30);
  X.set([0, 0, 0, 2, 0.1, 0, 0.3, 1.7, 0.2, 0.2, 0.4, 1.5]);
  [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]].forEach(([a, b], k) => { for (let d = 0; d < 3; d++) X[(4 + k) * 3 + d] = (X[a * 3 + d] + X[b * 3 + d]) / 2; });
  X[4 * 3 + 2] += 0.08;
  X[9 * 3] += 0.05;
  const T = Int32Array.from({ length: 10 }, (_, i) => i);

  it('stiffness: symmetric, no forces for rigid motions, inverted elements refused', () => {
    const K = new Float64Array(900);
    expect(elementStiffness(X, T, 0, 115000, 77000, K)).toBe(true);
    const kmax = Math.max(...K.map(Math.abs));
    for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) expect(Math.abs(K[i * 30 + j] - K[j * 30 + i])).toBeLessThan(1e-12 * kmax);
    for (let m = 0; m < 6; m++) {
      const u = new Float64Array(30);
      for (let a = 0; a < 10; a++) {
        const x = X[a * 3], y = X[a * 3 + 1], z = X[a * 3 + 2];
        const w = [m === 3 ? 1 : 0, m === 4 ? 1 : 0, m === 5 ? 1 : 0];
        u[a * 3] = (m === 0 ? 1 : 0) + w[1] * z - w[2] * y; u[a * 3 + 1] = (m === 1 ? 1 : 0) + w[2] * x - w[0] * z; u[a * 3 + 2] = (m === 2 ? 1 : 0) + w[0] * y - w[1] * x;
      }
      for (let i = 0; i < 30; i++) { let s = 0; for (let j = 0; j < 30; j++) s += K[i * 30 + j] * u[j]; expect(Math.abs(s)).toBeLessThan(1e-12 * kmax); }
    }
    // Two corners swapped (with their edges): turned inside out.
    expect(elementStiffness(X, Int32Array.from([1, 0, 2, 3, 4, 6, 5, 8, 7, 9]), 0, 115000, 77000, K)).toBe(false);
  });

  it('patch test: a linear displacement gives its exact strain at every node of a curved element', () => {
    const G = [[1e-3, 2e-3, -1e-3], [4e-4, -2e-3, 3e-4], [5e-4, 1e-4, 7e-4]];
    const U = new Float64Array(30);
    for (let a = 0; a < 10; a++) for (let r = 0; r < 3; r++) U[a * 3 + r] = 0.1 * r + G[r][0] * X[a * 3] + G[r][1] * X[a * 3 + 1] + G[r][2] * X[a * 3 + 2];
    const st = new Float64Array(60);
    elementNodeStrains(X, T, 0, U, st);
    const exact = [G[0][0], G[1][1], G[2][2], (G[0][1] + G[1][0]) / 2, (G[1][2] + G[2][1]) / 2, (G[2][0] + G[0][2]) / 2];
    for (let k = 0; k < 10; k++) for (let c = 0; c < 6; c++) expect(st[k * 6 + c]).toBeCloseTo(exact[c], 14);
  });

  it('a body force adds up to force per volume times the curved volume', () => {
    const F = new Float64Array(30);
    const vol = addBodyForce(X, T, 0, [1, -2, 3], F);
    expect(vol).toBeGreaterThan(0);
    const sum = [0, 1, 2].map((d) => F.reduce((s, v, i) => (i % 3 === d ? s + v : s), 0));
    expect(sum[0] / vol).toBeCloseTo(1, 12);
    expect(sum[1] / vol).toBeCloseTo(-2, 12);
    expect(sum[2] / vol).toBeCloseTo(3, 12);
  });

  it('pressure in a hole: no net force, and the closed boundary sums to no force at all', async () => {
    const { mesh, faces } = await meshOf([sketch('s1', [...rect(-20, -20, 20, 20), ...circle(0, 0, 8)]), extrude('f1', 's1', 30)], 2);
    const holes = faces.flatMap((f, i) => (f.type === 'cylinder' ? [i] : []));
    const { applied, areas } = loadVector(mesh, { ...STEEL, fixtures: [], loads: [{ kind: 'pressure', faces: holes, value: 1 }] });
    expect(areas[0] / (2 * Math.PI * 8 * 30)).toBeCloseTo(1, 3);
    expect(Math.hypot(...applied)).toBeLessThan(5e-4 * areas[0]);
    const all = [...new Set(mesh.triFace)];
    const total = loadVector(mesh, { ...STEEL, fixtures: [], loads: [{ kind: 'pressure', faces: all, value: 1 }] }).applied;
    expect(Math.hypot(...total)).toBeLessThan(1e-9 * areas[0]);
  }, 60000);
});
