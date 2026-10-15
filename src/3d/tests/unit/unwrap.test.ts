import { expect, it } from 'vitest';
import { markSeams, packUV, seamEdges, unwrapUV } from '../../src/edit/unwrap';
import {
  edges,
  pack,
  topologyMesh,
  cloneTopology,
  validateTopology,
} from '../../src/edit/topology';
import { uvElements } from '../../src/edit/uv';
import { Scene } from '../../src/core/scene';
import { parseDocument, serializeDocument } from '../../src/storage/document';
import { flatFace } from '../../src/edit/mesh-tools';

function folded() {
  const p = [0, 0, 0, 4, 0, 0, 4, 2, 0, 0, 2, 0, 4, 0, 2, 4, 2, 2];
  return pack(
    p,
    [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
    ].map((v) => flatFace(v, p)),
  );
}
function cube() {
  const p = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
  return pack(
    p,
    [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [3, 7, 6, 2],
      [0, 4, 7, 3],
      [1, 2, 6, 5],
    ].map((v) => flatFace(v, p)),
  );
}
it('unwraps a bent strip with continuous shared corners and preserved proportions', () => {
  const t = folded(),
    result = unwrapUV(t, [0, 1], 0.02);
  expect(result.positions).toBe(t.positions);
  expect(t.uvs.every((v) => v === 0)).toBe(true);
  expect(uvElements(result, 'island')).toHaveLength(1);
  expect(result.uvs[2]).toBeCloseTo(result.uvs[8]);
  expect(result.uvs[3]).toBeCloseTo(result.uvs[9]);
  const length = (a: number, b: number) =>
    Math.hypot(
      result.uvs[a * 2] - result.uvs[b * 2],
      result.uvs[a * 2 + 1] - result.uvs[b * 2 + 1],
    );
  expect(length(0, 1) / length(1, 2)).toBeCloseTo(2, 4);
  expect(result.uvs.every((v) => v >= 0.01999 && v <= 0.98001)).toBe(true);
});
it('seams split charts and packing keeps their bounds separated by padding', () => {
  const t = folded(),
    edge = edges(t).findIndex((e) => e.a === 1 && e.b === 2);
  const marked = markSeams(t, [edge], true),
    result = unwrapUV(marked, [0, 1], 0.04);
  expect(seamEdges(marked).size).toBe(1);
  expect(t.seams).toBeUndefined();
  expect(uvElements(result, 'island')).toHaveLength(2);
  const bounds = [0, 1].map((f) => {
    const cs = Array.from({ length: 4 }, (_, i) => f * 4 + i);
    return [
      Math.min(...cs.map((c) => result.uvs[c * 2])),
      Math.max(...cs.map((c) => result.uvs[c * 2])),
      Math.min(...cs.map((c) => result.uvs[c * 2 + 1])),
      Math.max(...cs.map((c) => result.uvs[c * 2 + 1])),
    ];
  });
  const [a, b] = bounds;
  expect(Math.max(b[0] - a[1], a[0] - b[1], b[2] - a[3], a[2] - b[3])).toBeGreaterThan(0.03999);
  expect(seamEdges(markSeams(marked, [edge], false)).size).toBe(0);
});
it('rejects a closed shell and unwraps it once all edges are seams', () => {
  const t = cube(),
    ids = [0, 1, 2, 3, 4, 5];
  expect(() => unwrapUV(t, ids, 0.02)).toThrow(/seams/);
  const result = unwrapUV(
    markSeams(
      t,
      edges(t).map((_, i) => i),
      true,
    ),
    ids,
    0.02,
  );
  expect(uvElements(result, 'island')).toHaveLength(6);
});
it('unwraps a cube net connected across uncut edges', () => {
  const t = cube(),
    joined = new Set(['0:1', '1:2', '2:3', '0:3', '4:5']);
  const marked = markSeams(
    t,
    edges(t).flatMap((e, i) => (joined.has(`${e.a}:${e.b}`) ? [] : [i])),
    true,
  );
  const result = unwrapUV(marked, [0, 1, 2, 3, 4, 5], 0.02);
  expect(uvElements(result, 'island')).toHaveLength(1);
});
it('preserves unselected UVs, rejects partial-island packing and validates input', () => {
  const t = unwrapUV(folded(), [0, 1], 0.02);
  expect(() => packUV(t, [0], 0.02)).toThrow(/complete/);
  const result = unwrapUV(t, [0], 0.02);
  expect(result.uvs.slice(8)).toEqual(t.uvs.slice(8));
  for (const padding of [NaN, -1, 0, 0.5])
    expect(() => packUV(t, [0, 1], padding)).toThrow(/padding/);
  expect(() => unwrapUV(t, [-1], 0.02)).toThrow(/Select/);
  expect(() => packUV(folded(), [0, 1], 0.02)).toThrow(/zero-area/);
});
it('retains seam flags and UVs through history, native files and topology copies', () => {
  const scene = new Scene(),
    source = folded();
  const initial = topologyMesh('source', source);
  scene.begin('source');
  scene.replaceGeometry(initial, initial);
  scene.commit();
  const marked = markSeams(source, [0], true),
    result = unwrapUV(marked, [0, 1], 0.02);
  const asset = topologyMesh('unwrapped', result);
  scene.begin('unwrap');
  scene.replaceGeometry(asset, asset);
  scene.commit();
  const saved = serializeDocument(scene.state),
    restored = parseDocument(saved);
  expect(restored.meshes.unwrapped.topology!.seams).toEqual(marked.seams);
  expect(restored.meshes.unwrapped.topology!.uvs).toEqual(result.uvs);
  scene.undo();
  expect(scene.state.meshes.source.topology!.seams).toBeUndefined();
  scene.redo();
  expect(serializeDocument(scene.state)).toEqual(saved);
  const cloned = cloneTopology(result);
  expect(cloned.seams).toEqual(result.seams);
  expect(cloned.seams).not.toBe(result.seams);
  expect(() => validateTopology({ ...result, seams: new Uint32Array([2]) })).toThrow(/seam/);
});

it('solves a triangulated chart with an interior vertex', () => {
  const p = [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, 1, 1, 0.5];
  const t = pack(
    p,
    [
      [0, 1, 4],
      [1, 2, 4],
      [2, 3, 4],
      [3, 0, 4],
    ].map((v) => flatFace(v, p)),
  );
  const result = unwrapUV(t, [0, 1, 2, 3], 0.02);
  expect(uvElements(result, 'island')).toHaveLength(1);
  expect(result.uvs.every(Number.isFinite)).toBe(true);
});
it('rejects a chart with a hole until it is cut open', () => {
  const p = [-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0, -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  const t = pack(
    p,
    [
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ].map((v) => flatFace(v, p)),
  );
  expect(() => unwrapUV(t, [0, 1, 2, 3], 0.02)).toThrow(/disk/);
  const cut = markSeams(t, [edges(t).findIndex((e) => e.a === 0 && e.b === 4)], true);
  expect(unwrapUV(cut, [0, 1, 2, 3], 0.02).uvs.every(Number.isFinite)).toBe(true);
});
it('packing normalizes texel density across islands with different existing UV scales', () => {
  const t = markSeams(
    folded(),
    edges(folded()).map((_, i) => i),
    true,
  );
  // 3D areas are 8 and 4, while input UV areas are 1 and 100.
  t.uvs.set([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 10, 0, 10, 10, 0, 10]);
  const result = packUV(t, [0, 1], 0.02);
  const area = (offset: number) =>
    Math.abs(
      (result.uvs[offset + 2] - result.uvs[offset]) *
        (result.uvs[offset + 5] - result.uvs[offset + 1]),
    );
  expect(area(0) / area(8)).toBeCloseTo(2, 5);
});
it('retains seams through loop cuts, merge, bevel clipping and modifiers', async () => {
  const { meshTool } = await import('../../src/edit/mesh-tools');
  const { evaluateModifiers } = await import('../../src/modifiers/geometry');
  const t = markSeams(
    cube(),
    edges(cube()).map((_, i) => i),
    true,
  );
  const cut = meshTool(t, {
    type: 'loopcut',
    mode: 'edge',
    ids: [0],
    cuts: 1,
    slide: 0,
  }).topology;
  expect(seamEdges(cut).size).toBe(16);
  const sub = evaluateModifiers(t, [{ id: 'sub', type: 'subdivision', enabled: true, levels: 1 }]);
  expect(seamEdges(sub).size).toBe(24);
  const mirrored = evaluateModifiers(t, [
    {
      id: 'mirror',
      type: 'mirror',
      enabled: true,
      axis: 0,
      offset: 0,
      bisect: true,
      merge: true,
      tolerance: 0.0001,
    },
  ]);
  expect(seamEdges(mirrored).size).toBeGreaterThan(0);
  const beveled = meshTool(t, {
    type: 'bevel',
    mode: 'edge',
    ids: [0],
    amount: 0.1,
    segments: 1,
  }).topology;
  expect(seamEdges(beveled).size).toBe(11);
  const merged = meshTool(t, {
    type: 'merge',
    mode: 'vertex',
    ids: [0, 1],
  }).topology;
  expect(seamEdges(merged).size).toBeGreaterThan(0);
  expect(() => meshTool(t, { type: 'dissolve', mode: 'edge', ids: [0] })).toThrow(/marked UV seam/);
});
it('rejects corrupted native seam flags', async () => {
  const t = unwrapUV(markSeams(folded(), [0], true), [0, 1], 0.02);
  const scene = new Scene(),
    asset = topologyMesh('uv-export', t);
  scene.begin('unwrap');
  scene.replaceGeometry(asset, asset);
  scene.commit();
  const document = JSON.parse(serializeDocument(scene.state));
  document.meshes[0].topology.seams = 'AgAAAA==';
  expect(() => parseDocument(JSON.stringify(document))).toThrow(/seam/);
});

it('keeps pinned UVs exactly where they are and leaves that chart unpacked', () => {
  const t = folded();
  // pin the two outer corners of the strip far apart
  const outer = [0, t.offsets[1] + 1];
  const pins = new Map<number, [number, number]>([
    [outer[0], [0.1, 0.2]],
    [outer[1], [0.9, 0.2]],
  ]);
  const r = unwrapUV(t, [0, 1], 0.01, pins);
  for (const [c, [u, v]] of pins) {
    expect(r.uvs[c * 2]).toBeCloseTo(u, 6);
    expect(r.uvs[c * 2 + 1]).toBeCloseTo(v, 6);
  }
  // the rest of the strip follows conformally: every UV is finite
  expect(Array.from(r.uvs).every(Number.isFinite)).toBe(true);
});
