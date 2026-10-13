import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createCompound } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { normalizeEffect } from '../src/features/paint/effects-model.js';
import '../src/features/effects/registry.js';
import '../src/features/three-d/index.js';
import { newParams } from '../src/features/three-d/params.js';
import { triangulate } from '../src/features/three-d/triangulate.js';
import { threeDObjects, collectSolids, writeOBJ, writeGLB, PT_M } from '../src/features/three-d/export-3d.js';

beforeAll(() => installCanvasStub());

const solid = (color) => ({ type: 'solid', color });
const fx3d = (kind, extra = {}) => normalizeEffect({ type: 'threeD', ...newParams(kind), ...extra });

function docWith(...nodes) {
  const doc = VDocument.create({ width: 600, height: 600 });
  const layer = doc.layers()[0].id;
  doc.transact('add', () => {
    for (const n of nodes) {
      if (n.kids) doc.insert(n.node, layer, Infinity, n.kids);
      else doc.insert(n, layer);
    }
  });
  doc.repairParents();
  return doc;
}

/** Signed volume of triangles (positions, 9 numbers each): positive when they face outward. */
function volume(pos) {
  let v = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.slice(i, i + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

const allPositions = (solids) => solids.flatMap((s) => s.parts.flatMap((p) => p.positions));

describe('triangulation', () => {
  const area = (pts, tris) => tris.reduce((s, [a, b, c]) => s + ((pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0])) / 2, 0);

  it('fills polygons with holes', () => {
    const outer = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole = [[3, 3], [3, 7], [7, 7], [7, 3]];
    const tris = triangulate(outer, [hole]);
    expect(area([...outer, ...hole], tris)).toBeCloseTo(100 - 16);
    const two = triangulate(outer, [[[1, 1], [1, 3], [3, 3], [3, 1]], [[6, 6], [6, 8], [8, 8], [8, 6]]]);
    expect(area([...outer, [1, 1], [1, 3], [3, 3], [3, 1], [6, 6], [6, 8], [8, 8], [8, 6]], two)).toBeCloseTo(100 - 8);
  });

  it('handles concave and clockwise outlines, keeping their winding', () => {
    const l = [[0, 0], [0, 10], [5, 10], [5, 5], [10, 5], [10, 0]];
    const tris = triangulate(l);
    expect(tris).toHaveLength(4);
    expect(area(l, tris)).toBeCloseTo(-75);
  });
});

describe('3D export', () => {
  const box = () => createPath(rectangle(100, 100, 72, 36), true, { fill: solid('#ff0000'), stroke: null, effects: [fx3d('extrude', { depth: 18, rotX: 0, rotY: 0, rotZ: 0, bevel: 'none' })] }, { name: 'Brick' });

  it('finds the 3D objects of a document or a region', () => {
    const plain = createPath(rectangle(400, 400, 20, 20), true, { fill: solid('#000000'), stroke: null });
    const b = box();
    const doc = docWith(b, plain);
    expect(threeDObjects(doc).map((n) => n.id)).toEqual([b.id]);
    expect(threeDObjects(doc, null, { x: 300, y: 300, w: 200, h: 200 })).toEqual([]);
  });

  it('collects closed solids with outward faces at their place and size', () => {
    const doc = docWith(box());
    const solids = collectSolids(doc, threeDObjects(doc), { orientation: 'model' });
    expect(solids).toHaveLength(1);
    expect(solids[0].name).toBe('Brick');
    const pos = allPositions(solids);
    const xs = pos.filter((_, i) => i % 3 === 0);
    const ys = pos.filter((_, i) => i % 3 === 1);
    const zs = pos.filter((_, i) => i % 3 === 2);
    expect(Math.min(...xs)).toBeCloseTo(100, 3);
    expect(Math.max(...xs)).toBeCloseTo(172, 3);
    // y is up: the document's y = 100..136 becomes -136..-100.
    expect(Math.max(...ys)).toBeCloseTo(-100, 3);
    expect(Math.min(...ys)).toBeCloseTo(-136, 3);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(18, 3);
    expect(volume(pos)).toBeCloseTo(72 * 36 * 18, 0);
    expect(solids[0].parts[0].material.color.map((c) => Math.round(c * 255))).toEqual([255, 0, 0]);
  });

  it('keeps outward faces for rotated, revolved and holed shapes', () => {
    const turned = createPath(rectangle(0, 0, 50, 50), true, { fill: solid('#00ff00'), stroke: null, effects: [fx3d('extrude', { depth: 20, rotX: 30, rotY: -40, rotZ: 10 })] });
    const vase = createPath(rectangle(200, 0, 40, 80), true, { fill: solid('#0000ff'), stroke: null, effects: [fx3d('revolve', { rotX: 10, rotY: 20, rotZ: 0 })] });
    const outer = createPath(rectangle(300, 300, 100, 100), true, { fill: null, stroke: null });
    const inner = createPath(ellipse(330, 330, 40, 40), true, { fill: null, stroke: null });
    const ring = createCompound([outer.id, inner.id], { fill: solid('#999999'), stroke: null, effects: [fx3d('extrude', { depth: 10, rotX: 0, rotY: 0, rotZ: 0, bevel: 'none' })] }, { fillRule: 'evenodd' });
    const doc = docWith(turned, vase, { node: ring, kids: [{ ...outer, parent: ring.id }, { ...inner, parent: ring.id }] });
    const solids = collectSolids(doc, threeDObjects(doc));
    expect(solids).toHaveLength(3);
    for (const s of solids) expect(volume(allPositions([s]))).toBeGreaterThan(0);
    // The ring's volume is the square minus the round hole (a fine polygon), times the depth.
    const want = (10000 - Math.PI * 400) * 10;
    expect(Math.abs(volume(allPositions([solids[2]])) - want) / want).toBeLessThan(0.01);
  });

  it('writes OBJ with materials', () => {
    const doc = docWith(box());
    const { obj, mtl } = writeOBJ(collectSolids(doc, threeDObjects(doc)), { scale: 1, name: 'brick model' });
    expect(obj).toContain('mtllib brick_model.mtl');
    expect(obj).toContain('o Brick');
    const v = obj.split('\n').filter((l) => l.startsWith('v ')).map((l) => l.split(' ').slice(1).map(Number));
    const f = obj.split('\n').filter((l) => l.startsWith('f ')).map((l) => l.split(' ').slice(1).map((x) => Number(x.split('//')[0]) - 1));
    expect(f.length).toBeGreaterThanOrEqual(12);
    expect(volume(f.flatMap((t) => t.flatMap((i) => v[i])))).toBeCloseTo(72 * 36 * 18, 0);
    expect(mtl).toMatch(/newmtl material_1\nKd 1 0 0/);
  });

  it('writes binary glTF with real-world size', () => {
    const doc = docWith(box());
    const bytes = writeGLB(collectSolids(doc, threeDObjects(doc)), { name: 'Brick' });
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(8, true)).toBe(bytes.length);
    const jsonLen = dv.getUint32(12, true);
    const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
    expect(gltf.asset.version).toBe('2.0');
    expect(gltf.nodes[0].name).toBe('Brick');
    const prim = gltf.meshes[0].primitives[0];
    const posAcc = gltf.accessors[prim.attributes.POSITION];
    expect(posAcc.max[0] - posAcc.min[0]).toBeCloseTo(72 * PT_M, 6);
    expect(gltf.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([1, 0, 0, 1]);
    // The binary chunk holds every buffer view.
    const binLen = dv.getUint32(20 + jsonLen, true);
    expect(binLen).toBe(gltf.buffers[0].byteLength);
    const view = gltf.bufferViews[posAcc.bufferView];
    const pos = new Float32Array(bytes.buffer.slice(28 + jsonLen + view.byteOffset, 28 + jsonLen + view.byteOffset + view.byteLength));
    expect(volume(Array.from(pos)) / (72 * 36 * 18 * PT_M ** 3)).toBeCloseTo(1, 4);
  });
});
