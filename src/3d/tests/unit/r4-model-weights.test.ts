// @vitest-environment happy-dom
// Edge / vertex creases and bevel weights: relative edits in Edit Mode, carried through topology
// changes, read by Subdivision Surface (sharpness per level, recorded results) and Bevel (Weight limit).
import { describe, it, expect } from 'vitest';
(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/data';
import '../../src/modes/index';
import '../../src/modeling/index';
import '../../src/eval/modifiers_extra';
import { buildMesh } from '../../src/mesh/mesh';
import { MeshEdit } from '../../src/modes/editmesh/meshedit';
import { addEdgeCrease, addEdgeBevelWeight, addVertexLayer } from '../../src/modes/editmesh/edgedata';
import { catmullClark, modifierTypes, newModifier } from '../../src/eval/modifiers';
import { baseEvalMesh } from '../../src/eval/depsgraph';
import type { EvalMesh } from '../../src/eval/types';
import type { MeshData } from '../../src/data/types';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function cubeEval(edgeCrease: number, vertCrease: number): EvalMesh {
  const v: number[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push(x, y, z);
  const q = (x: number, y: number, z: number) => x * 4 + y * 2 + z;
  const faces = [
    [q(0, 0, 0), q(0, 0, 1), q(0, 1, 1), q(0, 1, 0)],
    [q(1, 0, 0), q(1, 1, 0), q(1, 1, 1), q(1, 0, 1)],
    [q(0, 0, 0), q(1, 0, 0), q(1, 0, 1), q(0, 0, 1)],
    [q(0, 1, 0), q(0, 1, 1), q(1, 1, 1), q(1, 1, 0)],
    [q(0, 0, 0), q(0, 1, 0), q(1, 1, 0), q(1, 0, 0)],
    [q(0, 0, 1), q(1, 0, 1), q(1, 1, 1), q(0, 1, 1)],
  ];
  const arr = buildMesh(v, faces.map((verts) => ({ verts })));
  return { ...arr, creases: new Float32Array(arr.indices.length).fill(edgeCrease), crease_vert: new Float32Array(8).fill(vertCrease) } as unknown as EvalMesh;
}
const maxLen = (m: EvalMesh) => {
  let best = 0;
  for (let i = 0; i < m.positions.length; i += 3) best = Math.max(best, Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]));
  return best;
};

describe('subdivision creases (recorded reference results, no limit surface)', () => {
  // largest vertex distance from the centre of a 2 m cube after 1, 2, 3 levels
  const EDGE: [number, number[]][] = [
    [0, [1.06066, 0.90966, 0.87383]],
    [0.25, [1.44338, 1.17274, 1.14267]],
    [0.5, [1.73205, 1.73205, 1.63583]],
    [0.75, [1.73205, 1.73205, 1.73205]],
    [1, [1.73205, 1.73205, 1.73205]],
  ];
  const VERT: [number, number[]][] = [
    [0.25, [1.44338, 1.08253, 1.05246]],
    [0.5, [1.73205, 1.73205, 1.55764]],
    [1, [1.73205, 1.73205, 1.73205]],
  ];
  it.each(EDGE)('edge crease %f', (c, want) => {
    want.forEach((w, i) => expect(maxLen(catmullClark(cubeEval(c, 0), i + 1)), `level ${i + 1}`).toBeCloseTo(w, 3));
  });
  it.each(VERT)('vertex crease %f', (c, want) => {
    want.forEach((w, i) => expect(maxLen(catmullClark(cubeEval(0, c), i + 1)), `level ${i + 1}`).toBeCloseTo(w, 3));
  });
  it('without creases enabled the weights are ignored', () => {
    expect(maxLen(catmullClark(cubeEval(1, 1), 2, false, false))).toBeCloseTo(0.90966, 3);
  });
});

function cubeEdit() {
  setApp(new App(startupDocument()));
  const cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
  const me = app.doc.meshes[cube.data!] as MeshData;
  return { cube, me };
}

describe('crease / bevel weight editing', () => {
  it('adds to the current value and clamps (relative like the interactive tool)', () => {
    const { me } = cubeEdit();
    const m = MeshEdit.from(me);
    m.sel = m.sel.map(() => 0);
    const [a, b] = m.edges()[0];
    m.sel[a] = m.sel[b] = 1;
    expect(addEdgeCrease(m, 0.3)).toBe(1);
    addEdgeCrease(m, 0.5);
    m.write(me);
    const crease = Array.from(me.creases!).filter((x) => x > 0);
    expect(crease.length).toBe(2); // both face corners of the edge
    crease.forEach((x) => expect(x).toBeCloseTo(0.8, 5));
    const m2 = MeshEdit.from(me);
    addEdgeCrease(m2, -0.2);
    addEdgeBevelWeight(m2, 0.4);
    addEdgeBevelWeight(m2, 0.9);
    addVertexLayer(m2, 'crease_vert', 0.7);
    m2.write(me);
    Array.from(me.creases!).filter((x) => x > 0).forEach((x) => expect(x).toBeCloseTo(0.6, 5));
    const bw = Array.from(me.bevel_weight_edge!).filter((x) => x > 0);
    expect(bw).toEqual([1, 1]);
    expect(Array.from(me.crease_vert!).filter((x) => x > 0).map((x) => +x.toFixed(3))).toEqual([0.7, 0.7]);
  });

  it('weights survive subdivision of the weighted edge and vertex removal', () => {
    const { me } = cubeEdit();
    const m = MeshEdit.from(me);
    m.sel = m.sel.map(() => 0);
    const [a, b] = m.edges()[0];
    m.sel[a] = m.sel[b] = 1;
    addEdgeBevelWeight(m, 0.5);
    addVertexLayer(m, 'bevel_weight_vert', 0.25);
    m.write(me);
    app.doc.mode = 'EDIT';
    app.run('mesh.subdivide', { number_cuts: 1 });
    // the two halves of the edge keep the weight; the new middle vertex interpolates the vertex weight
    const m2 = MeshEdit.from(me);
    const weighted = m2.edges().filter(([x, y]) => m2.edgeBevelWeight(x, y) > 0);
    expect(weighted.length).toBe(2);
    weighted.forEach(([x, y]) => expect(m2.edgeBevelWeight(x, y)).toBeCloseTo(0.5, 5));
    const vb = me.bevel_weight_vert!;
    expect(vb.length).toBe(me.positions.length / 3);
    expect(Array.from(vb).filter((x) => Math.abs(x - 0.25) < 1e-6).length).toBeGreaterThanOrEqual(3);
  });

  it('operators run relative in Edit Mode and the Bevel modifier limits by weight', () => {
    const { cube, me } = cubeEdit();
    app.run('object.mode_set', { mode: 'EDIT' });
    app.run('mesh.select_all', { action: 'DESELECT' });
    const m = MeshEdit.from(me);
    const [a, b] = m.edges()[0];
    const sel = new Uint8Array(me.positions.length / 3);
    sel[a] = sel[b] = 1;
    me.select_vert = sel;
    expect(app.run('transform.edge_bevelweight', { value: 1 }, { invoke: false })).toBe('FINISHED');
    expect(app.run('transform.vert_crease', { value: 0.5 }, { invoke: false })).toBe('FINISHED');
    expect(app.run('transform.edge_crease', { value: 1 }, { invoke: false })).toBe('FINISHED');
    app.run('object.mode_set', { mode: 'OBJECT' });
    expect(Array.from(me.bevel_weight_edge!).filter(Boolean).length).toBe(2);
    expect(Array.from(me.crease_vert!).filter(Boolean).length).toBe(2);
    // bevel limited by weight touches only the weighted edge: a cube with one beveled edge has 7 faces
    const mod = newModifier('BEVEL', 'bv', []) as Any;
    mod.limit_method = 'WEIGHT';
    mod.width = 0.2;
    const out = modifierTypes.BEVEL.apply(baseEvalMesh(me), mod, { doc: app.doc, ob: cube, graph: app.graph, frame: 1, source: me } as Any);
    expect(out.offsets.length - 1).toBe(7);
    // no weights: nothing beveled
    me.bevel_weight_edge = undefined;
    const out2 = modifierTypes.BEVEL.apply(baseEvalMesh(me), mod, { doc: app.doc, ob: cube, graph: app.graph, frame: 1, source: me } as Any);
    expect(out2.offsets.length - 1).toBe(6);
  });
});
