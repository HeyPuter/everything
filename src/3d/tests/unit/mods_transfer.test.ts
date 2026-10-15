// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { modifierTypes } from '../../src/eval/modifiers';
import '../../src/eval/mods/index';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

// Expected values measured for a 4×4 source grid (size 2) with weights 0.8·(x+1)/2 + 0.2·(y+1)/2,
// transferred to a 3×3 grid (size 1.6) moved by (0.1, 0.05, 0.2) and turned 20° around Z.
const REF = {"NEAREST": [0.2, 0.4, 0.65, 0.85, 0.25, 0.45, 0.7, 0.9, 0.3, 0.5, 0.75, 0.95, 0.15, 0.35, 0.6, 0.8], "EDGE_NEAREST": [0.2, 0.4, 0.65, 0.85, 0.25, 0.45, 0.7, 0.9, 0.3, 0.5, 0.75, 0.95, 0.15, 0.35, 0.6, 0.8], "EDGEINTERP_NEAREST": [0.24874, 0.4207, 0.69968, 0.85719, 0.22578, 0.47082, 0.68906, 0.9073, 0.20282, 0.40328, 0.65375, 0.85422, 0.17985, 0.37105, 0.5893, 0.83126], "POLY_NEAREST": [0.2, 0.4, 0.65, 0.85, 0.25, 0.45, 0.7, 0.9, 0.3, 0.5, 0.75, 0.95, 0.15, 0.35, 0.6, 0.8], "POLYINTERP_NEAREST": [0.25121, 0.46992, 0.68863, 0.85719, 0.22836, 0.44707, 0.66578, 0.88449, 0.20551, 0.42422, 0.64293, 0.86164, 0.18267, 0.40137, 0.62008, 0.83126], "POLYINTERP_VNORPROJ": [0.25121, 0.46992, 0.68863, null, 0.22836, 0.44707, 0.66578, 0.88449, 0.20551, 0.42422, 0.64293, 0.86164, 0.18267, 0.40137, 0.62008, null], "mix": [0.05, 0.1, 0.1625, 0.2125, 0.0625, 0.1125, 0.175, 0.225, 0.075, 0.125, 0.1875, 0.2375, 0.0375, 0.0875, 0.15, 0.2], "uv_NEAREST_POLYNOR": [[0.25, 0.0], [0.5, 0.0], [0.5, 0.25], [0.25, 0.25], [0.5, 0.0], [0.75, 0.25], [0.75, 0.5], [0.5, 0.25], [0.75, 0.25], [1.0, 0.25], [1.0, 0.5], [0.75, 0.5], [0.25, 0.25], [0.5, 0.25], [0.5, 0.5], [0.25, 0.5], [0.5, 0.25], [0.75, 0.5], [0.75, 0.75], [0.5, 0.5], [0.75, 0.5], [1.0, 0.5], [1.0, 0.75], [0.75, 0.75], [0.25, 0.5], [0.5, 0.5], [0.25, 0.75], [0.0, 0.75], [0.5, 0.5], [0.75, 0.75], [0.5, 1.0], [0.25, 0.75], [0.75, 0.75], [1.0, 0.75], [0.75, 1.0], [0.5, 1.0]], "uv_NEAREST_POLY": [[0.25, 0.0], [0.5, 0.0], [0.5, 0.25], [0.25, 0.25], [0.5, 0.0], [0.75, 0.25], [0.75, 0.5], [0.5, 0.25], [0.75, 0.25], [1.0, 0.25], [1.0, 0.5], [0.75, 0.5], [0.25, 0.25], [0.5, 0.25], [0.5, 0.5], [0.25, 0.5], [0.5, 0.25], [0.75, 0.5], [0.75, 0.75], [0.5, 0.5], [0.75, 0.5], [1.0, 0.5], [1.0, 0.75], [0.75, 0.75], [0.25, 0.5], [0.5, 0.5], [0.25, 0.75], [0.0, 0.75], [0.5, 0.5], [0.75, 0.75], [0.5, 1.0], [0.25, 0.75], [0.75, 0.75], [1.0, 0.75], [0.75, 1.0], [0.5, 1.0]], "uv_POLYINTERP_NEAREST": [[0.3109, 0.0123], [0.5615, 0.1035], [0.4703, 0.3541], [0.2197, 0.2629], [0.5615, 0.1035], [0.8121, 0.1947], [0.7209, 0.4453], [0.4703, 0.3541], [0.8121, 0.1947], [1.0, 0.2859], [0.9715, 0.5365], [0.7209, 0.4453], [0.2197, 0.2629], [0.4703, 0.3541], [0.3791, 0.6047], [0.1285, 0.5135], [0.4703, 0.3541], [0.7209, 0.4453], [0.6297, 0.6959], [0.3791, 0.6047], [0.7209, 0.4453], [0.9715, 0.5365], [0.8803, 0.7871], [0.6297, 0.6959], [0.1285, 0.5135], [0.3791, 0.6047], [0.2879, 0.8553], [0.0373, 0.7641], [0.3791, 0.6047], [0.6297, 0.6959], [0.5385, 0.9465], [0.2879, 0.8553], [0.6297, 0.6959], [0.8803, 0.7871], [0.7891, 1.0], [0.5385, 0.9465]]};

function setup() {
  const src = newMeshData('s', prim.grid(4, 4, 2)) as unknown as EvalMesh;
  const P = src.positions;
  src.vertex_groups = [{ name: 'G' }];
  src.weights = [Float32Array.from({ length: P.length / 3 }, (_, i) => ((P[i * 3] + 1) / 2) * 0.8 + ((P[i * 3 + 1] + 1) / 2) * 0.2)];
  const dst = newMeshData('d', prim.grid(3, 3, 1.6)) as unknown as EvalMesh;
  dst.vertex_groups = [{ name: 'G' }];
  dst.weights = [new Float32Array(16)];
  const world = new Matrix4().compose(new Vector3(0.1, 0.05, 0.2), new Quaternion().setFromEuler(new Euler(0, 0, (20 * Math.PI) / 180)), new Vector3(1, 1, 1));
  const objs: Record<string, unknown> = { ob: { world }, src: { world: new Matrix4(), mesh: src } };
  const ctx = { ob: { id: 'ob', name: 'Dst' }, doc: { objects: { src: {} } }, graph: { get: (id: string) => objs[id] } } as unknown as ModifierContext;
  return { dst, ctx };
}
const run = (props: Record<string, unknown>) => {
  const { dst, ctx } = setup();
  const t = modifierTypes.DATA_TRANSFER;
  return t.apply(dst, { ...t.defaults(), type: 'DATA_TRANSFER', name: 'D', id: 'md', object: 'src', ...props } as never, ctx);
};
const close = (a: ArrayLike<number>, b: (number | null)[], skipNull = false) =>
  b.forEach((v, i) => {
    if (v === null && skipNull) return;
    expect(a[i]).toBeCloseTo(v ?? 0, 3);
  });

describe('Data Transfer', () => {
  it('transfers vertex group weights with each vertex mapping', () => {
    for (const mp of ['NEAREST', 'EDGE_NEAREST', 'EDGEINTERP_NEAREST', 'POLY_NEAREST', 'POLYINTERP_NEAREST', 'POLYINTERP_VNORPROJ'] as const) {
      const out = run({ use_vert_data: true, data_types_verts: ['VGROUP_WEIGHTS'], vert_mapping: mp });
      close(out.weights![0], REF[mp], true);
    }
  });

  it('mixes with the existing weights', () => {
    close(run({ use_vert_data: true, data_types_verts: ['VGROUP_WEIGHTS'], mix_mode: 'MIX', mix_factor: 0.5 }).weights![0], REF.mix);
  });

  it('transfers UVs per face corner', () => {
    for (const mp of ['NEAREST_POLYNOR', 'NEAREST_POLY', 'POLYINTERP_NEAREST'] as const) {
      const out = run({ use_loop_data: true, data_types_loops: ['UV'], loop_mapping: mp });
      close(out.uvs, REF[`uv_${mp}`].flat());
    }
  });

  it('copies edge flags and face smoothing between matching meshes', () => {
    const src = newMeshData('s', prim.grid(3, 3, 2)) as unknown as EvalMesh;
    src.sharp = new Uint32Array(src.indices.length);
    src.seams = new Uint32Array(src.indices.length);
    src.sharp[0] = 1; // edge v0-v1
    src.seams[1] = 1; // edge v1-v5
    src.smooth = new Uint8Array(9).fill(1);
    const objs: Record<string, unknown> = { ob: { world: new Matrix4() }, src: { world: new Matrix4(), mesh: src } };
    const ctx = { ob: { id: 'ob' }, doc: { objects: {} }, graph: { get: (id: string) => objs[id] } } as unknown as ModifierContext;
    const t = modifierTypes.DATA_TRANSFER;
    for (const mapping of ['TOPOLOGY', 'NEAREST', 'VERT_NEAREST', 'POLY_NEAREST']) {
      const dst = newMeshData('d', prim.grid(3, 3, 2)) as unknown as EvalMesh;
      const out = t.apply(dst, { ...t.defaults(), object: 'src', use_edge_data: true, data_types_edges: ['SHARP_EDGE', 'SEAM'], edge_mapping: mapping, use_poly_data: true, data_types_polys: ['SMOOTH'] } as never, ctx);
      expect(Array.from(out.smooth!).every((x) => x === 1)).toBe(true);
      // every corner on the v0-v1 edge is sharp, and only those
      const onEdge = (k: number, a: number, b: number) => {
        const f = [...Array(9).keys()].find((ff) => out.offsets[ff] <= k && k < out.offsets[ff + 1])!;
        const n = out.indices[k + 1 < out.offsets[f + 1] ? k + 1 : out.offsets[f]];
        return (out.indices[k] === a && n === b) || (out.indices[k] === b && n === a);
      };
      for (let k = 0; k < out.indices.length; k++) {
        expect(!!out.sharp![k], mapping).toBe(onEdge(k, 0, 1));
        expect(!!out.seams![k], mapping).toBe(onEdge(k, 1, 5));
      }
    }
  });
});
