// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { modifierTypes } from '../../src/eval/modifiers';
import '../../src/eval/modifiers_extra';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

const cube = () => newMeshData('c', prim.cube(2)) as unknown as EvalMesh;
const run = (type: string, m: EvalMesh, props: Record<string, unknown>) => {
  const t = modifierTypes[type];
  return t.apply(m, { ...t.defaults(), type, ...props } as never, { ob: { id: 'ob' } } as ModifierContext);
};
const counts = (m: EvalMesh) => [m.positions.length / 3, m.offsets.length - 1];

describe('Bevel options', () => {
  it('bevels vertices', () => {
    expect(counts(run('BEVEL', cube(), { affect: 'VERTICES', width: 0.2 }))).toEqual([24, 14]);
  });

  it('limits edges to a vertex group and sets the material of new faces', () => {
    const m = cube();
    m.vertex_groups = [{ name: 'G' }];
    // the four vertices of the top face
    m.weights = [Float32Array.from({ length: 8 }, (_, v) => (m.positions[v * 3 + 2] > 0 ? 1 : 0))];
    const out = run('BEVEL', m, { limit_method: 'VGROUP', vertex_group: 'G', width: 0.2, material: 2 });
    // only the four top edges are beveled: the six old faces stay, every new face gets material 2
    const nf = out.offsets.length - 1;
    expect(nf).toBeGreaterThan(6);
    expect(nf).toBeLessThan(26);
    expect(Array.from(out.material_index!).filter((x) => x === 2).length).toBe(nf - 6);
  });

  it('marks seams and sharp edges and hardens normals', () => {
    const out = run('BEVEL', cube(), { width: 0.2, mark_seam: true, mark_sharp: true, harden_normals: true });
    expect(out.seams?.some(Boolean)).toBe(true);
    expect(out.sharp?.some(Boolean)).toBe(true);
    expect(out.custom_normals?.length).toBe(out.indices.length * 3);
  });
});

describe('Solidify options', () => {
  const plane = () => newMeshData('p', prim.plane(2)) as unknown as EvalMesh;
  it('flips normals, creases the rim and fills output groups', () => {
    const m = plane();
    m.vertex_groups = [{ name: 'shell' }, { name: 'rim' }];
    m.weights = [new Float32Array(4), new Float32Array(4)];
    const out = run('SOLIDIFY', m, { thickness: 0.1, edge_crease_outer: 1, edge_crease_rim: 0.5, shell_vertex_group: 'shell', rim_vertex_group: 'rim' });
    expect(counts(out)).toEqual([8, 6]);
    expect(Math.max(...out.creases!)).toBe(1);
    expect(Array.from(out.creases!).filter((c) => c === 0.5).length).toBe(8);
    expect(Array.from(out.weights![0]).filter((w) => w === 1).length).toBe(4);
    expect(Array.from(out.weights![1]).filter((w) => w === 1).length).toBe(8);
    const flipped = run('SOLIDIFY', plane(), { thickness: 0.1, use_flip_normals: true });
    // the original side faces down after flipping
    expect(flipped.normals[2]).toBeCloseTo(-1, 5);
  });

  it('scales thickness by a vertex group and clamps it', () => {
    const m = plane();
    m.vertex_groups = [{ name: 'G' }];
    m.weights = [Float32Array.from([1, 1, 0, 0])];
    const out = run('SOLIDIFY', m, { thickness: 0.1, vertex_group: 'G', thickness_vertex_group: 0.5, use_rim: false });
    const zs = Array.from({ length: 4 }, (_, i) => out.positions[(4 + i) * 3 + 2]);
    expect(zs.map((z) => Math.round(z * 1000) / 1000)).toEqual([-0.1, -0.1, -0.05, -0.05]);
    const clamped = run('SOLIDIFY', plane(), { thickness: 5, thickness_clamp: 0.5, use_rim: false });
    expect(clamped.positions[4 * 3 + 2]).toBeCloseTo(-1, 5);
  });
});

describe('Weld, Mask and Triangulate options', () => {
  it('collapses only short edges in connected mode and respects a vertex group', () => {
    const g = newMeshData('g', prim.grid(2, 1, 2)) as unknown as EvalMesh;
    // squeeze the middle column so its edges to the left column are short
    const P = Float32Array.from(g.positions);
    for (let i = 0; i < P.length; i += 3) if (Math.abs(P[i]) < 1e-6) P[i] = -0.995;
    const m = { ...g, positions: P };
    expect(run('WELD', m, { merge_threshold: 0.01, mode: 'CONNECTED' }).positions.length / 3).toBe(4);
    const grouped = { ...m, vertex_groups: [{ name: 'G' }], weights: [Float32Array.from({ length: 6 }, (_, v) => (v === 0 ? 1 : 0))] };
    expect(run('WELD', grouped, { merge_threshold: 0.01, vertex_group: 'G' }).positions.length / 3).toBe(6);
  });

  it('masks by the selected bones of an armature', () => {
    const m = cube();
    m.vertex_groups = [{ name: 'A' }, { name: 'B' }];
    m.weights = [Float32Array.from({ length: 8 }, (_, v) => (m.positions[v * 3 + 2] > 0 ? 1 : 0)), Float32Array.from({ length: 8 }, (_, v) => (m.positions[v * 3 + 2] > 0 ? 0 : 1))];
    const doc = { objects: { arm: { id: 'arm', type: 'ARMATURE', data: 'ad' } }, armatures: { ad: { bones: [{ name: 'A', select: true }, { name: 'B', select: false }] } } };
    const t = modifierTypes.MASK;
    const out = t.apply(m, { ...t.defaults(), mode: 'ARMATURE', armature: 'arm' } as never, { doc } as unknown as ModifierContext);
    expect(out.positions.length / 3).toBe(4);
    expect(out.offsets.length - 1).toBe(1);
  });

  it('splits quads along the chosen diagonal', () => {
    const q = newMeshData('q', prim.plane(2)) as unknown as EvalMesh;
    const P = Float32Array.from(q.positions);
    P[0] = -3; // vertex 0 pulled out: the 1-3 diagonal is now the short one
    const m = { ...q, positions: P };
    const diag = (o: EvalMesh) => (Array.from(o.indices.subarray(0, 3)).includes(2) && Array.from(o.indices.subarray(0, 3)).includes(0) ? '02' : '13');
    expect(diag(run('TRIANGULATE', m, {}))).toBe('13');
    expect(diag(run('TRIANGULATE', m, { quad_method: 'LONGEST_DIAGONAL' }))).toBe('02');
    expect(diag(run('TRIANGULATE', m, { quad_method: 'FIXED' }))).toBe('02');
    expect(diag(run('TRIANGULATE', m, { quad_method: 'FIXED_ALTERNATE' }))).toBe('13');
  });
});
