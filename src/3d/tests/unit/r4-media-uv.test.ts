import { describe, expect, it } from 'vitest';
import { newMeshData } from '../../src/data/defaults';
import { buildMesh } from '../../src/mesh/mesh';
import type { ImageData, MeshData } from '../../src/data/types';
import { UVTopo, visibleFaces } from '../../src/editors/uv/uvcore';
import { packIslandsUV, cornersBounds } from '../../src/editors/uv/uvalgo';
import { overlappingFaces } from '../../src/editors/uv/uvselect';
import { packRegion, tileNumber } from '../../src/editors/uv/uvpackregion';
import { hsvToRgb } from '../../src/render/genpatterns';

function twoQuads(): MeshData {
  const arr = buildMesh(
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 3, 0, 0, 4, 0, 0, 4, 1, 0, 3, 1, 0],
    [
      { verts: [0, 1, 2, 3], uvs: [0.1, 0.1, 0.3, 0.1, 0.3, 0.3, 0.1, 0.3] },
      { verts: [4, 5, 6, 7], uvs: [0.6, 0.6, 0.9, 0.6, 0.9, 0.9, 0.6, 0.9] },
    ],
  );
  const me = newMeshData('Q', arr);
  me.select_vert = new Uint8Array(8).fill(1);
  return me;
}
const layer = (me: MeshData) => ({ me, faces: visibleFaces(me, false), sync: false });

describe('UV packing into a region', () => {
  it('packs every island inside a wide custom region, keeping shapes and relative sizes', () => {
    const me = twoQuads();
    const t = new UVTopo(layer(me));
    const out = new Float32Array(me.uvs);
    const region: [number, number, number, number] = [0.2, 0.5, 0.6, 0.25];
    expect(packIslandsUV(t, out, t.islandFaces(), { margin: 0.01, rotate: false, scale: true, region })).toBe(true);
    for (let i = 0; i < out.length; i += 2) {
      expect(out[i]).toBeGreaterThanOrEqual(0.2 - 1e-6);
      expect(out[i]).toBeLessThanOrEqual(0.8 + 1e-6);
      expect(out[i + 1]).toBeGreaterThanOrEqual(0.5 - 1e-6);
      expect(out[i + 1]).toBeLessThanOrEqual(0.75 + 1e-6);
    }
    const a = cornersBounds(out, [0, 1, 2, 3]),
      b = cornersBounds(out, [4, 5, 6, 7]);
    // squares stay square and keep their 2 : 3 size ratio
    expect(a[2] - a[0]).toBeCloseTo(a[3] - a[1], 5);
    expect(b[2] - b[0]).toBeCloseTo(b[3] - b[1], 5);
    expect((a[2] - a[0]) / (b[2] - b[0])).toBeCloseTo(2 / 3, 4);
    me.uvs = out;
    expect(overlappingFaces([new UVTopo(layer(me))])[0]).toEqual([]);
  });

  it('packs into a UDIM tile and keeps sizes when not scaling', () => {
    const me = twoQuads();
    const t = new UVTopo(layer(me));
    const out = new Float32Array(me.uvs);
    packIslandsUV(t, out, t.islandFaces(), { margin: 0.01, rotate: false, scale: false, region: [2, 1, 1, 1] });
    const a = cornersBounds(out, [0, 1, 2, 3]);
    expect(a[0]).toBeGreaterThanOrEqual(2);
    expect(a[1]).toBeGreaterThanOrEqual(1);
    expect(a[2] - a[0]).toBeCloseTo(0.2, 5);
  });

  it('picks the pack target of each source', () => {
    const tiled = { tiles: [{ number: 1001 }, { number: 1013 }], active_tile_index: 1, source: 'TILED' } as unknown as ImageData;
    expect(packRegion('CLOSEST_UDIM', [1.2, 0.1, 1.6, 0.4], null)).toEqual([1, 0, 1, 1]);
    expect(packRegion('CLOSEST_UDIM', [-0.5, -0.2, -0.1, 0.1], null)).toEqual([0, 0, 1, 1]);
    expect(packRegion('ACTIVE_UDIM', null, tiled)).toEqual([2, 1, 1, 1]);
    expect(packRegion('ACTIVE_UDIM', null, null)).toEqual([0, 0, 1, 1]);
    const r = packRegion('ORIGINAL_AABB', [0.1, 0.2, 0.5, 0.6], null);
    expect(r[0]).toBeCloseTo(0.1);
    expect(r[2]).toBeCloseTo(0.4);
    expect(tileNumber(2, 1)).toBe(1013);
  });
});

describe('generated image patterns', () => {
  it('converts the cross hues of the UV grid', () => {
    expect(hsvToRgb(0, 0.9, 0.9)).toEqual([230, 23, 23]);
    expect(hsvToRgb(0.5, 0.9, 0.9)).toEqual([23, 230, 230]);
    expect(hsvToRgb(0.25, 1, 1)).toEqual([128, 255, 0]);
  });
});

describe('UV packing groups', () => {
  it('merges islands whose bounds overlap', async () => {
    const { mergeOverlapping } = await import('../../src/editors/uv/uvalgo');
    const arr = buildMesh(
      [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 3, 0, 0, 4, 0, 0, 4, 1, 0, 3, 1, 0, 6, 0, 0, 7, 0, 0, 7, 1, 0, 6, 1, 0],
      [
        { verts: [0, 1, 2, 3], uvs: [0.1, 0.1, 0.3, 0.1, 0.3, 0.3, 0.1, 0.3] },
        { verts: [4, 5, 6, 7], uvs: [0.2, 0.2, 0.4, 0.2, 0.4, 0.4, 0.2, 0.4] },
        { verts: [8, 9, 10, 11], uvs: [0.6, 0.6, 0.9, 0.6, 0.9, 0.9, 0.6, 0.9] },
      ],
    );
    const me = newMeshData('Q3', arr);
    me.select_vert = new Uint8Array(12).fill(1);
    const t = new UVTopo(layer(me));
    const groups = mergeOverlapping(t, new Float32Array(me.uvs), t.islandFaces());
    expect(groups.map((g) => g.length).sort()).toEqual([1, 2]);
  });
});

describe('UV shortest path fill', () => {
  it('selects the region between two corners of a grid', async () => {
    const { shortestVertFill, shortestVertPath } = await import('../../src/editors/uv/uvselect');
    const prim = await import('../../src/mesh/primitives');
    const me = newMeshData('G', prim.grid(4, 4, 2));
    me.select_vert = new Uint8Array(me.positions.length / 3).fill(1);
    const t = new UVTopo(layer(me));
    // UV vertices at two opposite corners of a 2 × 2 cell block
    const at = (u: number, v: number) => {
      let best = -1,
        bd = Infinity;
      for (let id = 0; id < t.vertCount; id++) {
        const [x, y] = t.vertUV(id);
        const d = Math.hypot(x - u, y - v);
        if (d < bd) ((bd = d), (best = id));
      }
      return best;
    };
    const a = at(0, 0),
      b = at(0.5, 0.5);
    const path = shortestVertPath(t, a, b, true);
    const fill = shortestVertFill(t, a, b, true);
    expect(path.length).toBe(5);
    // the 3 × 3 block of grid vertices between them
    expect(fill.length).toBe(9);
  });
});
