import { describe, expect, it } from 'vitest';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { buildMesh } from '../../src/mesh/mesh';
import type { MeshData } from '../../src/data/types';
import { UVTopo, SelEdit, selReader, visibleFaces, faceUVArea, type UVLayer } from '../../src/editors/uv/uvcore';
import {
  weld,
  mergeByDistance,
  align,
  alignRotation,
  minimizeStretch,
  stitch,
  packIslandsUV,
  arrangeIslands,
  randomizeIslands,
  copyMirroredFaces,
  seamsFromIslands,
  averageIslandsScale,
  islandCorners,
  cornersBounds,
  snapToAdjacentUnselected,
  minAreaAngle,
} from '../../src/editors/uv/uvalgo';
import { edgeLoop, edgeRing, growCorners, shrinkCorners, overlappingFaces, windingFaces, shortestVertPath, pickVert, pickEdge, pickFace, ripKeep, similarCorners, trisOverlap } from '../../src/editors/uv/uvselect';

function gridMesh(n = 4): MeshData {
  const me = newMeshData('Grid', prim.grid(n, n, 2));
  me.select_vert = new Uint8Array(me.positions.length / 3).fill(1);
  return me;
}

function layer(me: MeshData, sync = false): UVLayer {
  return { me, faces: visibleFaces(me, sync), sync };
}

/** Select every corner whose UV satisfies the test. */
function selectWhere(me: MeshData, fn: (u: number, v: number) => boolean) {
  const sel = new Uint8Array(me.indices.length);
  for (let c = 0; c < me.indices.length; c++) if (fn(me.uvs[c * 2], me.uvs[c * 2 + 1])) sel[c] = 1;
  me.uv_select = sel;
}

/** Two separate unit quads (two islands) far apart in UV. */
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

describe('UV topology', () => {
  it('groups corners into UV vertices and finds islands split by UV seams', () => {
    const me = gridMesh(2);
    const t = new UVTopo(layer(me));
    expect(t.vertCount).toBe(9);
    expect(t.islands.count).toBe(1);
    // tear the first face away in UV: it becomes its own island
    const uvs = new Float32Array(me.uvs);
    for (let c = me.offsets[0]; c < me.offsets[1]; c++) uvs[c * 2] += 5;
    me.uvs = uvs;
    const t2 = new UVTopo(layer(me));
    expect(t2.islands.count).toBe(2);
    expect(t2.vertCount).toBe(9 + 3);
  });

  it('shows only selected faces without sync, every face with sync', () => {
    const me = gridMesh(2);
    me.select_vert = new Uint8Array(9);
    me.select_vert[0] = me.select_vert[1] = me.select_vert[3] = me.select_vert[4] = 1;
    expect(visibleFaces(me, false)).toEqual([0]);
    expect(visibleFaces(me, true).length).toBe(4);
    me.uv_hide = new Uint8Array([1, 0, 0, 0]);
    expect(visibleFaces(me, false)).toEqual([]);
  });

  it('sync selection reads and writes the mesh vertex selection', () => {
    const me = gridMesh(2);
    me.select_vert = new Uint8Array(9);
    const l = layer(me, true);
    const e = new SelEdit(l);
    e.set(0, true);
    e.commit();
    expect(me.select_vert![me.indices[0]]).toBe(1);
    const sel = selReader(l);
    // every corner of that vertex now reads as selected
    const v = me.indices[0];
    for (let c = 0; c < me.indices.length; c++) if (me.indices[c] === v) expect(sel(c)).toBe(true);
  });
});

describe('UV picking and selection', () => {
  it('picks vertices, edges and faces', () => {
    const me = gridMesh(2);
    const t = new UVTopo(layer(me));
    const v = pickVert(t, 0.51, 0.49, 0.05)!;
    expect(t.vertUV(v.id)).toEqual([0.5, 0.5]);
    const e = pickEdge(t, 0.25, 0.01, 0.05)!;
    expect([t.u(e.corner), t.u(t.next(e.corner))].sort()).toEqual([0, 0.5]);
    const f = pickFace(t, 0.75, 0.75, 0.01);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(faceUVArea(me, f)).toBeCloseTo(0.25);
  });

  it('walks edge loops and rings on a grid', () => {
    const me = gridMesh(4);
    const t = new UVTopo(layer(me));
    // a horizontal interior edge at v = 0.5
    const e = pickEdge(t, 0.375, 0.5, 0.01)!;
    const loop = edgeLoop(t, e.corner);
    expect(loop.length).toBe(4);
    for (const c of loop) expect(t.v(c)).toBeCloseTo(0.5);
    const ring = edgeRing(t, e.corner);
    expect(ring.corners.length).toBe(5);
    expect(ring.faces.length).toBe(4);
  });

  it('follows the UV boundary as a loop', () => {
    const me = gridMesh(3);
    const t = new UVTopo(layer(me));
    const e = pickEdge(t, 0.5, 0, 0.01)!;
    expect(edgeLoop(t, e.corner).length).toBe(12);
  });

  it('grows and shrinks the selection', () => {
    const me = gridMesh(4);
    selectWhere(me, (u, v) => Math.abs(u - 0.5) < 1e-6 && Math.abs(v - 0.5) < 1e-6);
    const l = layer(me);
    const t = new UVTopo(l);
    const grown = new Set(growCorners(t, selReader(l), false).map((c) => t.uvVert[c]));
    expect(grown.size).toBe(9);
    selectWhere(me, (u, v) => u <= 0.75 + 1e-6 && u >= 0.25 - 1e-6 && v <= 0.75 + 1e-6 && v >= 0.25 - 1e-6);
    const l2 = layer(me);
    const t2 = new UVTopo(l2);
    const gone = new Set(shrinkCorners(t2, selReader(l2), false).map((c) => t2.uvVert[c]));
    expect(gone.size).toBe(8);
  });

  it('finds overlapping and flipped faces', () => {
    const me = twoQuads();
    const t = new UVTopo(layer(me));
    expect(overlappingFaces([t])[0]).toEqual([]);
    const uvs = new Float32Array(me.uvs);
    for (let c = 4; c < 8; c++) {
      uvs[c * 2] -= 0.4;
      uvs[c * 2 + 1] -= 0.4;
    }
    me.uvs = uvs;
    expect(overlappingFaces([new UVTopo(layer(me))])[0].sort()).toEqual([0, 1]);
    // touching along an edge is not an overlap
    expect(trisOverlap([0, 0, 1, 0, 0, 1], [1, 0, 1, 1, 0, 1])).toBe(false);
    // mirror the second face in UV: it winds the other way
    const m2 = twoQuads();
    const u2 = new Float32Array(m2.uvs);
    for (let c = 4; c < 8; c++) u2[c * 2] = 1.5 - u2[c * 2];
    m2.uvs = u2;
    expect(windingFaces(new UVTopo(layer(m2)), false)).toEqual([1]);
  });

  it('finds the shortest path between UV vertices', () => {
    const me = gridMesh(4);
    const t = new UVTopo(layer(me));
    const a = pickVert(t, 0, 0, 0.01)!.id,
      b = pickVert(t, 1, 0, 0.01)!.id;
    expect(shortestVertPath(t, a, b).length).toBe(5);
  });

  it('selects similar faces by area', () => {
    const me = twoQuads();
    selectWhere(me, (u) => u < 0.5);
    const l = layer(me);
    const t = new UVTopo(l);
    const out = similarCorners([{ t, sel: selReader(l), objectIndex: 0 }], 'FACE', 'AREA', 'EQUAL', 0.01);
    expect(out[0].length).toBe(4); // only the small face itself
    const all = similarCorners([{ t, sel: selReader(l), objectIndex: 0 }], 'FACE', 'AREA', 'GREATER', 0);
    expect(all[0].length).toBe(8);
  });

  it('rip keeps the corners on the side of the pointer', () => {
    const me = gridMesh(2);
    selectWhere(me, (u, v) => Math.abs(u - 0.5) < 1e-6 && Math.abs(v - 0.5) < 1e-6);
    const l = layer(me);
    const t = new UVTopo(l);
    const keep = ripKeep(t, selReader(l), 0.9, 0.9);
    expect(keep.size).toBe(1);
    const c = [...keep][0];
    const f = t.cornerFace[c];
    let cu = 0;
    for (let k = me.offsets[f]; k < me.offsets[f + 1]; k++) cu += me.uvs[k * 2] / 4;
    expect(cu).toBeGreaterThan(0.5);
  });
});

describe('UV editing algorithms', () => {
  it('welds the selection at its center and merges by distance', () => {
    const me = twoQuads();
    selectWhere(me, () => true);
    const l = layer(me);
    const t = new UVTopo(l);
    const uvs = new Float32Array(me.uvs);
    weld(t, uvs, selReader(l));
    // the center of the eight distinct UVs
    for (let c = 0; c < 8; c++) {
      expect(uvs[c * 2]).toBeCloseTo(0.475);
      expect(uvs[c * 2 + 1]).toBeCloseTo(0.475);
    }
    const m2 = gridMesh(2);
    // pull the corners of face 0 slightly apart from their neighbours
    const u2 = new Float32Array(m2.uvs);
    for (let c = m2.offsets[0]; c < m2.offsets[1]; c++) u2[c * 2] += 0.001;
    m2.uvs = u2;
    selectWhere(m2, () => true);
    const l2 = layer(m2);
    const t2 = new UVTopo(l2);
    expect(t2.vertCount).toBe(12);
    const out = new Float32Array(m2.uvs);
    expect(mergeByDistance(t2, out, selReader(l2), 0.01)).toBe(3);
    m2.uvs = out;
    expect(new UVTopo(layer(m2)).vertCount).toBe(9);
  });

  it('snaps selected UVs onto adjacent unselected ones', () => {
    const me = gridMesh(2);
    const u = new Float32Array(me.uvs);
    for (let c = me.offsets[0]; c < me.offsets[1]; c++) u[c * 2] += 0.2;
    me.uvs = u;
    const sel = new Uint8Array(me.indices.length);
    for (let c = me.offsets[0]; c < me.offsets[1]; c++) sel[c] = 1;
    me.uv_select = sel;
    const l = layer(me);
    const t = new UVTopo(l);
    const out = new Float32Array(me.uvs);
    expect(snapToAdjacentUnselected(t, out, selReader(l))).toBe(3);
    me.uvs = out;
    // joined again; the outer corner has no other face and stays where it was moved
    expect(new UVTopo(layer(me)).vertCount).toBe(9);
    expect(new UVTopo(layer(me)).islands.count).toBe(1);
  });

  it('aligns and straightens', () => {
    const me = gridMesh(4);
    const u = new Float32Array(me.uvs);
    // jitter the middle column vertically-aligned vertices in u
    for (let c = 0; c < me.indices.length; c++) if (Math.abs(me.uvs[c * 2] - 0.5) < 1e-6) u[c * 2] += Math.sin(me.uvs[c * 2 + 1] * 10) * 0.05;
    me.uvs = u;
    selectWhere(me, (x) => Math.abs(x - 0.5) < 0.06);
    const l = layer(me);
    const t = new UVTopo(l);
    const out = new Float32Array(me.uvs);
    expect(align(t, out, selReader(l), 'ALIGN_X', 'MEAN')).toBe(true);
    const sel = selReader(l);
    const xs = new Set<string>();
    for (let c = 0; c < me.indices.length; c++) if (sel(c)) xs.add(out[c * 2].toFixed(5));
    expect(xs.size).toBe(1);
    // straighten: the column becomes the line between its end points
    const out2 = new Float32Array(me.uvs);
    expect(align(t, out2, sel, 'ALIGN_S')).toBe(true);
    const ends = [0, 1].map((v) => {
      for (let c = 0; c < me.indices.length; c++) if (sel(c) && Math.abs(me.uvs[c * 2 + 1] - v) < 1e-6) return [me.uvs[c * 2], v];
      return [0, 0];
    });
    for (let c = 0; c < me.indices.length; c++) {
      if (!sel(c)) continue;
      const v = out2[c * 2 + 1];
      const expectU = ends[0][0] + (ends[1][0] - ends[0][0]) * ((v - ends[0][1]) / (ends[1][1] - ends[0][1]));
      expect(out2[c * 2]).toBeCloseTo(expectU, 3);
    }
  });

  it('rotates islands to their smallest bounding box', () => {
    const me = twoQuads();
    const a = Math.PI / 7;
    const u = new Float32Array(me.uvs);
    for (let c = 0; c < 4; c++) {
      const x = u[c * 2] - 0.2,
        y = u[c * 2 + 1] - 0.2;
      u[c * 2] = 0.2 + x * Math.cos(a) - y * Math.sin(a);
      u[c * 2 + 1] = 0.2 + x * Math.sin(a) + y * Math.cos(a);
    }
    me.uvs = u;
    selectWhere(me, (x) => x < 0.5);
    const l = layer(me);
    const t = new UVTopo(l);
    const out = new Float32Array(me.uvs);
    expect(alignRotation(t, out, selReader(l), 'AUTO')).toBe(1);
    const b = cornersBounds(out, [0, 1, 2, 3]);
    expect(b[2] - b[0]).toBeCloseTo(0.2, 5);
    expect(b[3] - b[1]).toBeCloseTo(0.2, 5);
    // the other island did not move
    expect(out[8]).toBeCloseTo(0.6);
    expect(minAreaAngle([[0, 0], [1, 0], [1, 1], [0, 1]])).toBeCloseTo(0);
  });

  it('minimize stretch moves a displaced UV back toward an undistorted layout', () => {
    const me = gridMesh(2);
    const t0 = new UVTopo(layer(me));
    const mid = pickVert(t0, 0.5, 0.5, 0.01)!.id;
    const u = new Float32Array(me.uvs);
    for (const c of t0.vertCorners[mid]) {
      u[c * 2] = 0.8;
      u[c * 2 + 1] = 0.7;
    }
    me.uvs = u;
    const t = new UVTopo(layer(me));
    const out = new Float32Array(me.uvs);
    minimizeStretch(t, out, new Set([mid]), 50);
    const c = t.vertCorners[mid][0];
    expect(Math.hypot(out[c * 2] - 0.5, out[c * 2 + 1] - 0.5)).toBeLessThan(0.02);
  });

  it('stitches split UVs and lines up the islands', () => {
    const me = gridMesh(2);
    // split the right column of faces off and move it away
    const u = new Float32Array(me.uvs);
    const faces = [1, 3].filter((f) => me.uvs[me.offsets[f] * 2] >= 0.5 - 1e-6);
    const right = new Set<number>();
    for (let f = 0; f < 4; f++) {
      let cu = 0;
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) cu += me.uvs[c * 2] / 4;
      if (cu > 0.5) right.add(f);
    }
    void faces;
    for (const f of right)
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
        u[c * 2] += 0.3;
        u[c * 2 + 1] += 0.1;
      }
    me.uvs = u;
    selectWhere(me, () => true);
    const l = layer(me);
    const t = new UVTopo(l);
    expect(t.islands.count).toBe(2);
    const out = new Float32Array(me.uvs);
    const r = stitch(t, out, selReader(l), { mode: 'VERTEX', snap_islands: true, midpoint_snap: false, use_limit: false, limit: 0.01, static_island: 0, clear_seams: true });
    expect(r.groups).toBe(3);
    me.uvs = out;
    const t2 = new UVTopo(layer(me));
    expect(t2.islands.count).toBe(1);
    expect(t2.vertCount).toBe(9);
  });

  it('packs islands into the unit square without overlaps', () => {
    const me = twoQuads();
    const l = layer(me);
    const t = new UVTopo(l);
    const out = new Float32Array(me.uvs);
    expect(packIslandsUV(t, out, t.islandFaces(), { margin: 0.01, rotate: false, scale: true })).toBe(true);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(-1e-6);
      expect(out[i]).toBeLessThanOrEqual(1 + 1e-6);
    }
    me.uvs = out;
    expect(overlappingFaces([new UVTopo(layer(me))])[0]).toEqual([]);
    // relative sizes are kept (0.2 vs 0.3 wide)
    const a = cornersBounds(out, [0, 1, 2, 3]),
      b = cornersBounds(out, [4, 5, 6, 7]);
    expect((a[2] - a[0]) / (b[2] - b[0])).toBeCloseTo(2 / 3, 4);
  });

  it('averages island scale to the same texel density', () => {
    const me = twoQuads();
    const l = layer(me);
    const t = new UVTopo(l);
    const out = new Float32Array(me.uvs);
    expect(averageIslandsScale(t, out, t.islandFaces())).toBe(2);
    me.uvs = out;
    expect(Math.abs(faceUVArea(me, 0))).toBeCloseTo(Math.abs(faceUVArea(me, 1)), 6);
  });

  it('arranges islands in a column and randomizes deterministically', () => {
    const me = twoQuads();
    const t = new UVTopo(layer(me));
    const out = new Float32Array(me.uvs);
    arrangeIslands(t, out, t.islandFaces(), { initial_position: 'UV_GRID', axis: 'Y', align: 'MIN', order: 'LARGE_TO_SMALL', margin: 0.05 });
    const big = cornersBounds(out, [4, 5, 6, 7]),
      small = cornersBounds(out, [0, 1, 2, 3]);
    expect(big[1]).toBeCloseTo(0);
    expect(small[1]).toBeCloseTo(0.35);
    expect(small[0]).toBeCloseTo(0);
    const r1 = new Float32Array(me.uvs),
      r2 = new Float32Array(me.uvs);
    const opts = { random_seed: 3, use_loc: true, loc: [0.1, 0.1] as [number, number], use_rot: true, rot: 1, use_scale: true, scale_even: false, scale: [1.5, 1.5] as [number, number] };
    randomizeIslands(t, r1, t.islandFaces(), opts);
    randomizeIslands(t, r2, t.islandFaces(), opts);
    expect(Array.from(r1)).toEqual(Array.from(r2));
    expect(Array.from(r1)).not.toEqual(Array.from(me.uvs));
  });

  it('marks seams along island borders', () => {
    const me = gridMesh(2);
    const u = new Float32Array(me.uvs);
    for (let c = me.offsets[0]; c < me.offsets[1]; c++) u[c * 2] -= 1;
    me.uvs = u;
    const t = new UVTopo(layer(me));
    const { seams } = seamsFromIslands(t);
    // face 0 has two inner edges; each is marked on both faces
    expect(seams.reduce((s, x) => s + x, 0)).toBe(4);
  });

  it('copies UVs to mirrored faces', () => {
    const me = gridMesh(2);
    const t = new UVTopo(layer(me));
    const out = new Float32Array(me.uvs);
    expect(copyMirroredFaces(t, out, 'POS_X', 3)).toBe(2);
    // faces on +X now use the same UVs as their -X mirror
    me.uvs = out;
    const t2 = new UVTopo(layer(me));
    const pos = (v: number) => [me.positions[v * 3], me.positions[v * 3 + 1]];
    for (let c = 0; c < me.indices.length; c++) {
      const [x, y] = pos(me.indices[c]);
      if (x <= 0) continue;
      for (let k = 0; k < me.indices.length; k++) {
        const [x2, y2] = pos(me.indices[k]);
        if (Math.abs(x2 + x) < 1e-6 && Math.abs(y2 - y) < 1e-6) {
          expect(out[c * 2]).toBeCloseTo(out[k * 2]);
          expect(out[c * 2 + 1]).toBeCloseTo(out[k * 2 + 1]);
        }
      }
    }
    expect(islandCorners(t2, [0]).length).toBe(4);
  });
});

describe('unwrap follow-ups', () => {
  it('fits islands back onto their pinned UVs', async () => {
    const { afterUnwrap, similarityFit } = await import('../../src/editors/uv/unwrapextra');
    const tf = similarityFit(
      [
        [0, 0],
        [1, 0],
      ],
      [
        [1, 1],
        [1, 3],
      ],
    );
    expect(tf(1, 0)[0]).toBeCloseTo(1);
    expect(tf(1, 0)[1]).toBeCloseTo(3);
    const me = gridMesh(2);
    const before = new Float32Array(me.uvs);
    // pin two corners, then pretend an unwrap scaled and moved everything
    const pin = new Uint8Array(me.indices.length);
    pin[0] = pin[me.offsets[3] + 2] = 1;
    me.uv_pin = pin;
    me.uvs = before.map((x) => x * 0.5 + 0.2);
    afterUnwrap(me, before, visibleFaces(me, false));
    for (let i = 0; i < before.length; i++) expect(me.uvs[i]).toBeCloseTo(before[i], 5);
  });
});
