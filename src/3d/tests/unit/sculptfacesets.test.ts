import { describe, it, expect } from 'vitest';
import { cube, grid } from '../../src/mesh/primitives';
import { newMeshData } from '../../src/data/defaults';
import { buildMesh } from '../../src/mesh/mesh';
import {
  boundaryVerts,
  faceSetBoundaryVerts,
  faceSetColor,
  growFaceSet,
  hiddenVertsFromFaces,
  initFaceSets,
  looseVertexParts,
  maxFaceSet,
  setHiddenFaces,
  shrinkFaceSet,
  syncHiddenFromVerts,
} from '../../src/paint/fsdata';
import { gestureTest, gestureFromProps, propsFromGesture } from '../../src/paint/gshape';

const mesh = (a: ReturnType<typeof cube>) => newMeshData('T', a);

/** Two separate quads (loose parts). */
function twoQuads() {
  const p = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 5, 0, 0, 6, 0, 0, 6, 1, 0, 5, 1, 0];
  return newMeshData('Q', buildMesh(p, [{ verts: [0, 1, 2, 3] }, { verts: [4, 5, 6, 7] }]) as never);
}

describe('face set initialization', () => {
  it('splits a cube by normals into six sets', () => {
    const me = mesh(cube());
    const fs = initFaceSets(me, 'NORMALS', 0.3);
    expect(new Set(fs).size).toBe(6);
  });
  it('keeps a flat grid in one set by normals', () => {
    const me = mesh(grid(4, 4, 2));
    expect(new Set(initFaceSets(me, 'NORMALS', 0.3)).size).toBe(1);
  });
  it('finds loose parts', () => {
    const me = twoQuads();
    const fs = initFaceSets(me, 'LOOSE_PARTS');
    expect(Array.from(fs)).toEqual([1, 2]);
    expect(looseVertexParts(me).count).toBe(2);
  });
  it('uses material slots', () => {
    const me = mesh(cube());
    me.material_index = new Uint16Array([0, 0, 1, 1, 2, 2]);
    expect(Array.from(initFaceSets(me, 'MATERIALS'))).toEqual([1, 1, 2, 2, 3, 3]);
  });
  it('splits along sharp edges', () => {
    const me = mesh(grid(2, 1, 2));
    // mark the middle edge sharp on one side only: the other face's corner must be honoured too
    const sharp = new Uint32Array(me.indices.length);
    // find the corner of face 0 whose edge is shared with face 1
    for (let c = me.offsets[0]; c < me.offsets[1]; c++) {
      const a = me.indices[c],
        b = me.indices[c + 1 < me.offsets[1] ? c + 1 : me.offsets[0]];
      const f1 = Array.from(me.indices.subarray(me.offsets[1], me.offsets[2]));
      if (f1.includes(a) && f1.includes(b)) sharp[c] = 1;
    }
    me.sharp = sharp;
    expect(new Set(initFaceSets(me, 'SHARP_EDGES')).size).toBe(2);
    me.sharp = undefined;
    expect(new Set(initFaceSets(me, 'SHARP_EDGES')).size).toBe(1);
  });
  it('splits disconnected regions of one face set', () => {
    const me = mesh(grid(3, 1, 2));
    me.sculpt_face_set = new Int32Array([1, 2, 1]);
    const fs = initFaceSets(me, 'FACE_SET_BOUNDARIES');
    expect(new Set(fs).size).toBe(3);
  });
});

describe('face set grow / shrink', () => {
  it('grows into neighbouring faces and shrinks back', () => {
    const me = mesh(grid(5, 1, 2));
    const fs = new Int32Array([1, 1, 2, 1, 1]);
    const g = growFaceSet(me, fs, 2, null);
    expect(Array.from(g)).toEqual([1, 2, 2, 2, 1]);
    const s = shrinkFaceSet(me, g, 2, null);
    expect(Array.from(s)).toEqual([1, 1, 2, 1, 1].map((x, i) => (i === 2 ? s[2] : x)));
    expect(s[1]).toBe(1);
    expect(s[3]).toBe(1);
    expect(maxFaceSet(g)).toBe(2);
  });
  it('does not grow into hidden faces', () => {
    const me = mesh(grid(3, 1, 2));
    const g = growFaceSet(me, new Int32Array([1, 2, 1]), 2, new Uint8Array([1, 0, 0]));
    expect(Array.from(g)).toEqual([1, 2, 2]);
  });
});

describe('visibility', () => {
  it('hides vertices only when all their faces are hidden', () => {
    const me = mesh(grid(2, 1, 2));
    const hv = hiddenVertsFromFaces(me, new Uint8Array([1, 0]));
    // 6 vertices: 2 only in face 0, 2 shared, 2 only in face 1
    expect(hv.reduce((s, x) => s + x, 0)).toBe(2);
  });
  it('mirrors face visibility into the edit-mode vertex flags and back', () => {
    const me = mesh(grid(2, 1, 2));
    setHiddenFaces(me, new Uint8Array([1, 0]));
    expect(me.hide_vert?.reduce((s, x) => s + x, 0)).toBe(2);
    setHiddenFaces(me, new Uint8Array([0, 0]));
    expect(me.hide_poly).toBeUndefined();
    expect(me.hide_vert).toBeUndefined();
    // edit mode hid a vertex of face 1 → face 1 hidden on entering sculpt mode
    me.hide_vert = new Uint8Array(6);
    me.hide_vert[me.indices[me.offsets[1]]] = 1;
    syncHiddenFromVerts(me);
    expect(me.hide_poly?.[1]).toBe(1);
    // edit mode revealed everything → faces revealed too
    me.hide_vert = undefined;
    syncHiddenFromVerts(me);
    expect(me.hide_poly).toBeUndefined();
  });
  it('finds mesh and face set boundaries', () => {
    const me = mesh(grid(2, 2, 2));
    const b = boundaryVerts(me);
    expect(b.reduce((s, x) => s + x, 0)).toBe(8);
    me.sculpt_face_set = new Int32Array([1, 1, 2, 2]);
    expect(faceSetBoundaryVerts(me).reduce((s, x) => s + x, 0)).toBe(3);
  });
});

describe('face set colors', () => {
  it('draws the default set white and others in distinct colors', () => {
    expect(faceSetColor(1)).toEqual([1, 1, 1]);
    const a = faceSetColor(2),
      b = faceSetColor(3);
    expect(a).not.toEqual(b);
    for (const c of [...a, ...b]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    expect(faceSetColor(2, 5)).not.toEqual(a);
  });
});

describe('gesture shapes', () => {
  it('tests points against box, lasso and line', () => {
    const box = gestureTest({ kind: 'BOX', x0: 10, y0: 10, x1: 0, y1: 0 });
    expect(box(5, 5)).toBe(true);
    expect(box(11, 5)).toBe(false);
    const tri = gestureTest({ kind: 'LASSO', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] });
    expect(tri(2, 2)).toBe(true);
    expect(tri(8, 8)).toBe(false);
    const line = { kind: 'LINE' as const, a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, flip: false, limit: false };
    const below = gestureTest(line)(5, 5);
    expect(gestureTest({ ...line, flip: true })(5, 5)).toBe(!below);
    expect(gestureTest(line)(50, below ? 5 : -5)).toBe(true);
    expect(gestureTest({ ...line, limit: true })(50, below ? 5 : -5)).toBe(false);
  });
  it('round-trips gestures through operator props', () => {
    const g = { kind: 'POLYLINE' as const, pts: [{ x: 1, y: 2 }, { x: 30, y: 2 }, { x: 5, y: 40 }] };
    expect(gestureFromProps('POLYLINE', propsFromGesture(g))).toEqual(g);
    const b = gestureFromProps('BOX', propsFromGesture({ kind: 'BOX', x0: 50, y0: 60, x1: 10, y1: 20 }));
    expect(b).toEqual({ kind: 'BOX', x0: 10, y0: 20, x1: 50, y1: 60 });
    expect(gestureFromProps('LASSO', { path: '[[0,0],[1,1]]' })).toBeNull();
  });
});

describe('trim geometry helpers', async () => {
  const { cleanPolygon, triangulate2D, closeTJunctions } = await import('../../src/paint/trimmath');
  it('drops collinear points and triangulates concave polygons', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(cleanPolygon(square)).toHaveLength(4);
    // an L shape (concave) has 6 corners → 4 triangles
    const L = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    const t = triangulate2D(L);
    expect(t).toHaveLength(12);
    let area = 0;
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [L[t[i]], L[t[i + 1]], L[t[i + 2]]];
      area += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
    }
    expect(area).toBeCloseTo(64);
  });
  it('splits triangles at T-junctions', () => {
    // two triangles on the left share the edge 0-1 split at vertex 4, with one big triangle on the right
    const P = [0, 0, 0, 0, 2, 0, 1, 1, 0, -1, 1, 0, 0, 1, 0];
    const faces = [{ verts: [0, 1, 2] }, { verts: [1, 4, 3] }, { verts: [4, 0, 3] }];
    closeTJunctions(P, faces);
    expect(faces).toHaveLength(4);
  });
});
