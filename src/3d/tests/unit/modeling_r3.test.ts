// @vitest-environment happy-dom
// Modeling round 3: monkey primitive, interactive add shape math and the other new modeling helpers.
import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { monkey } from '../../src/mesh/monkey';
import { newMeshData } from '../../src/data/defaults';
import { MeshEdit } from '../../src/modes/editmesh/meshedit';
import { baseRect, heightRange, shapeTransform, planeAxes } from '../../src/modeling/interactiveadd';

describe('monkey primitive', () => {
  it('is a set of closed, outward facing shells of a few hundred vertices', () => {
    const arr = monkey(2);
    const m = MeshEdit.from(newMeshData('M', arr));
    expect(m.vcount).toBeGreaterThan(450);
    expect(m.vcount).toBeLessThan(600);
    // every edge has two faces, used once in each direction
    for (const [k, l] of m.edgeFaces()) {
      expect(l.length, k).toBe(2);
      const [a] = k.split(':').map(Number);
      expect(m.faces[l[0][0]].verts[l[0][1]] === a).not.toBe(m.faces[l[1][0]].verts[l[1][1]] === a);
    }
    // positive enclosed volume: normals point out
    let vol = 0;
    for (const f of m.faces)
      for (let i = 1; i < f.verts.length - 1; i++) vol += new Vector3(...m.p(f.verts[0])).dot(new Vector3(...m.p(f.verts[i])).cross(new Vector3(...m.p(f.verts[i + 1]))));
    expect(vol).toBeGreaterThan(0);
    // faces -Y, roughly 2.4 across the ears at size 2, and scales with the size
    const xs = Array.from({ length: m.vcount }, (_, i) => m.p(i)[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(2);
    const small = monkey(1).positions;
    expect(small[3]).toBeCloseTo(arr.positions[3] / 2, 5);
  });
});

describe('interactive add shapes', () => {
  it('base rectangles from the drag: corner or centre origin, free or square', () => {
    expect(baseRect(2, -1, false, false)).toEqual({ u0: 0, u1: 2, v0: -1, v1: 0 });
    expect(baseRect(2, -1, true, false)).toEqual({ u0: -2, u1: 2, v0: 1, v1: -1 });
    expect(baseRect(2, -1, false, true)).toEqual({ u0: 0, u1: 2, v0: -2, v1: 0 });
  });
  it('height ranges and the primitive transform', () => {
    const base = { u0: 0, u1: 2, v0: 0, v1: 1 };
    expect(heightRange(0.5, base, false, false)).toEqual({ h0: 0, h1: 0.5 });
    expect(heightRange(0.5, base, true, false)).toEqual({ h0: -0.5, h1: 0.5 });
    expect(heightRange(0.1, base, false, true)).toEqual({ h0: 0, h1: 2 });
    const n = new Vector3(0, 0, 1);
    const t = shapeTransform({ frame: { origin: new Vector3(1, 1, 0), n, ...planeAxes(n) }, ...base, h0: 0, h1: 3 });
    expect(t.location).toEqual([2, 1.5, 1.5]);
    expect(t.scale).toEqual([1, 0.5, 1.5]);
    t.rotation.forEach((r) => expect(r).toBeCloseTo(0, 9));
    // a wall: the base lies in the X-Z plane
    const wall = new Vector3(0, -1, 0);
    const w = shapeTransform({ frame: { origin: new Vector3(), n: wall, ...planeAxes(wall) }, u0: 0, u1: 2, v0: 0, v1: 2, h0: 0, h1: 1 });
    expect(w.location[1]).toBeCloseTo(-0.5, 9);
  });
});
