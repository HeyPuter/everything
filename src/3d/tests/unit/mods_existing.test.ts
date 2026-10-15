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
