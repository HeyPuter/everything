// @vitest-environment happy-dom
// Edit Mode operators on small reference meshes: element counts, face sizes, surface area and
// vertex positions must match the recorded expected results (tests/fixtures/editmesh_numerics.json).
import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/editmesh_numerics.json';
(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
import { App, setApp, app } from '../../src/app/app';
import { startupDocument, newMeshData, newObject } from '../../src/data/defaults';
import { buildMesh, type PolyFace } from '../../src/mesh/mesh';
import { addObjectToScene } from '../../src/ops/object';
import { MeshEdit } from '../../src/modes/editmesh/meshedit';
import '../../src/ops/data';
import '../../src/modes/index';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ring = (n: number, r: number, z: number) => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), z]);

function addPy(verts: number[][], edges: number[][], faces: number[][]) {
  const arr = buildMesh(verts.flat(), faces.map((f) => ({ verts: f }) as PolyFace));
  const me = newMeshData('M', arr);
  if (edges.length) me.loose_edges = Uint32Array.from(edges.flat());
  app.doc.meshes[me.id] = me;
  addObjectToScene(app.doc, newObject('M', 'MESH', me.id), { location: [0, 0, 0] });
}

function makeBase(name: string) {
  setApp(new App(startupDocument()));
  const cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
  if (name === 'cube' || name === 'lopsided') {
    if (name === 'lopsided') {
      const me = app.doc.meshes[cube.data!];
      const P = new Float32Array(me.positions);
      for (let i = 0; i < P.length; i += 3) {
        const k = [P[i], P[i + 1], P[i + 2]].map(Math.round).join();
        if (k === '1,1,1') P.set([1.5, 1.2, 1.3], i);
        if (k === '-1,-1,-1') P.set([-1.3, -1, -1], i);
      }
      me.positions = P;
    }
    return;
  }
  cube.select = false;
  app.doc.scene.active_object = null as Any;
  if (name === 'uvsphere') return void app.run('mesh.primitive_uv_sphere_add', { location: [0, 0, 0] });
  if (name === 'grid') return void app.run('mesh.primitive_grid_add', { location: [0, 0, 0] });
  if (name === 'tworings') {
    const e = [];
    for (let i = 0; i < 8; i++) e.push([i, (i + 1) % 8], [8 + i, 8 + ((i + 1) % 8)]);
    return addPy([...ring(8, 1, 0), ...ring(8, 1, 1)], e, []);
  }
  if (name === 'twoboxes') {
    const v: number[][] = [],
      f: number[][] = [];
    for (const cx of [0, 3]) {
      const b = v.length;
      for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) v.push([cx + x, y, z]);
      const q = (xi: number, yi: number, zi: number) => b + xi * 4 + yi * 2 + zi;
      f.push([q(0, 0, 0), q(0, 0, 1), q(0, 1, 1), q(0, 1, 0)], [q(1, 0, 0), q(1, 1, 0), q(1, 1, 1), q(1, 0, 1)], [q(0, 0, 0), q(1, 0, 0), q(1, 0, 1), q(0, 0, 1)], [q(0, 1, 0), q(0, 1, 1), q(1, 1, 1), q(1, 1, 0)], [q(0, 0, 0), q(0, 1, 0), q(1, 1, 0), q(1, 0, 0)], [q(0, 0, 1), q(1, 0, 1), q(1, 1, 1), q(0, 1, 1)]);
    }
    return addPy(v, [], f);
  }
  if (name === 'circle12') return addPy(ring(12, 1, 0), Array.from({ length: 12 }, (_, i) => [i, (i + 1) % 12]), []);
  if (name === 'circle12f') return addPy(ring(12, 1, 0), [], [Array.from({ length: 12 }, (_, i) => i)]);
  if (name === 'gridhole') {
    const n = 6,
      v: number[][] = [],
      f: number[][] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) v.push([-1 + (2 * i) / n, -1 + (2 * j) / n, 0]);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        if (i >= 2 && i <= 3 && j >= 2 && j <= 3) continue;
        const a = j * (n + 1) + i;
        f.push([a, a + 1, a + n + 2, a + n + 1]);
      }
    return addPy(v, [], f);
  }
  if (name === 'ngonfan') return addPy([[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 2, 0], [0, 1, 0], [0, 0.5, 0]], [], [[0, 1, 2, 3, 4, 5]]);
  if (name === 'skewgrid') {
    const n = 3,
      v: number[][] = [],
      f: number[][] = [];
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const x = -1 + (2 * i) / n,
          y = -1 + (2 * j) / n;
        v.push([x + 0.3 * y, y, 0.3 * Math.sin(3 * x + 2 * y)]);
      }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        f.push([a, a + 1, a + n + 2, a + n + 1]);
      }
    return addPy(v, [], f);
  }
  if (name === 'screwprofile') return addPy([[1, 0, 0], [1.5, 0, 0.5], [1, 0, 1]], [[0, 1], [1, 2]], []);
  throw new Error('base ' + name);
}

function test(c: [string, string, number][], p: number[]) {
  const vals: Record<string, number> = { x: p[0], y: p[1], z: p[2], ax: Math.abs(p[0]), ay: Math.abs(p[1]), az: Math.abs(p[2]) };
  return c.every(([k, op, v]) => (op === '>' ? vals[k] > v : vals[k] < v));
}

interface Case {
  name: string;
  base: string;
  mode: 'VERT' | 'EDGE' | 'FACE';
  sel?: 'all' | 'none' | [string, string, number][] | null;
  selOr?: [string, string, number][][];
  selPos?: number[][];
  pre?: [string, Record<string, unknown>][];
  op: string | null;
  props: Record<string, unknown>;
  edgeNear?: number[];
  expected: { V: number; E: number; F: number; sizes: Record<string, number>; area: number; pos?: number[][] };
}

function run(c: Case) {
  makeBase(c.base);
  app.run('object.mode_set', { mode: 'EDIT' });
  const me = app.doc.meshes[app.activeObject!.data!];
  app.doc.scene.tool_settings.mesh_select_mode = [c.mode === 'VERT', c.mode === 'EDGE', c.mode === 'FACE'];
  const nv = me.positions.length / 3;
  const sel = new Uint8Array(nv);
  for (let i = 0; i < nv; i++) {
    const p = [me.positions[i * 3], me.positions[i * 3 + 1], me.positions[i * 3 + 2]];
    if (c.sel === 'all') sel[i] = 1;
    else if (Array.isArray(c.sel)) sel[i] = test(c.sel, p) ? 1 : 0;
    if (c.selOr) sel[i] = c.selOr.some((g) => test(g, p)) ? 1 : 0;
    if (c.selPos) sel[i] = c.selPos.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-4) ? 1 : 0;
  }
  me.select_vert = sel;
  for (const [op, props] of c.pre ?? []) app.run(op, props, { invoke: false });
  let props = { ...c.props };
  if (c.edgeNear) {
    const m = MeshEdit.from(me);
    let best: number[] = [],
      bd = Infinity;
    for (const [a, b] of m.edges()) {
      const d = [0, 1, 2].reduce((s, k) => s + ((m.p(a)[k] + m.p(b)[k]) / 2 - c.edgeNear![k]) ** 2, 0);
      if (d < bd) ((bd = d), (best = [a, b]));
    }
    props = { ...props, object: app.activeObject!.id, edge: best };
  }
  if (c.op) app.run(c.op, props, { invoke: false });
  app.run('object.mode_set', { mode: 'OBJECT' });
  return MeshEdit.from(app.doc.meshes[app.activeObject!.data!]);
}

function area(m: MeshEdit) {
  let a = 0;
  for (const f of m.faces) {
    let nx = 0,
      ny = 0,
      nz = 0;
    const n = f.verts.length;
    for (let i = 0; i < n; i++) {
      const p = m.p(f.verts[i]),
        q = m.p(f.verts[(i + 1) % n]);
      nx += (p[1] - q[1]) * (p[2] + q[2]);
      ny += (p[2] - q[2]) * (p[0] + q[0]);
      nz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    a += Math.hypot(nx, ny, nz) / 2;
  }
  return a;
}

/** Largest distance from a point of either set to the nearest point of the other. */
function hausdorff(a: number[][], b: number[][]) {
  const one = (x: number[][], y: number[][]) => Math.max(0, ...x.map((p) => Math.min(...y.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])))));
  return Math.max(one(a, b), one(b, a));
}

const cases = fixture as unknown as Case[];

describe('edit mode operator results', () => {
  for (const c of cases)
    it(c.name, () => {
      const m = run(c);
      const sizes: Record<string, number> = {};
      for (const f of m.faces) sizes[f.verts.length] = (sizes[f.verts.length] ?? 0) + 1;
      expect([m.vcount, m.edges().length, m.faces.length]).toEqual([c.expected.V, c.expected.E, c.expected.F]);
      expect(sizes).toEqual(c.expected.sizes);
      expect(area(m)).toBeCloseTo(c.expected.area, 3);
      if (c.expected.pos) expect(hausdorff(Array.from({ length: m.vcount }, (_, i) => m.p(i)), c.expected.pos)).toBeLessThan(1e-3);
    });
});

describe('bevel profile shapes', () => {
  it('samples a quarter circle at equal angles and a chamfer evenly', async () => {
    const { profileSamples, profileExponent } = await import('../../src/modes/editmesh/bevelprofile');
    expect(profileExponent(0.5)).toBeCloseTo(2, 6);
    expect(profileExponent(0.25)).toBeCloseTo(1, 6);
    const circle = profileSamples(4, 0.5);
    expect(circle[1][0]).toBeCloseTo(Math.sin(Math.PI / 8), 6);
    expect(profileSamples(4, 0.25)[1]).toEqual([0.25, 0.75]);
    // other shapes: points stay on u^r + w^r = 1 and are evenly spaced along the curve
    const s = profileSamples(4, 0.75);
    const r = profileExponent(0.75);
    for (const [u, w] of s) expect(u ** r + w ** r).toBeCloseTo(1, 3);
    const d = s.slice(1).map((p, i) => Math.hypot(p[0] - s[i][0], p[1] - s[i][1]));
    expect(Math.max(...d) - Math.min(...d)).toBeLessThan(0.02);
  });
});
