// Volume meshing for stress analysis on parts built by the real kernel:
// positive elements, the mesh's volume against the solid's, faces covered by
// boundary triangles of their own, and every example part meshed.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import { EXAMPLES } from '../src/app/examples';
import { SurfaceIndex } from '../src/fea/surface';
import { type TetMesh, defaultElementSize, maxElementSize, meshSolid, quadJacobian, tetVolume } from '../src/fea/mesher';
import { elementSizeFor } from '../src/model/fea';
import { integrateTriangle } from '../src/fea/elements';
import type { Feature } from '../src/model/types';
import { circle, extrude, rect, req, sketch } from './helpers';

beforeAll(async () => {
  setOc(await init());
});

async function surfaceOf(features: Feature[], tol = 0.01) {
  const b = new ModelBuilder();
  const res = await b.build(req(features, { quality: 1 }));
  expect(res.status.every((s) => s.ok)).toBe(true);
  const fs = b.feaSurface(tol);
  return { surf: new SurfaceIndex(fs), fs, faces: res.faces };
}

/** Every element positive, at its corners and at its quadrature points. */
function expectValid(m: TetMesh) {
  const ne = m.tets.length / 10;
  for (let e = 0; e < ne; e++) {
    const t = m.tets;
    expect(tetVolume(m.nodes, t[e * 10], t[e * 10 + 1], t[e * 10 + 2], t[e * 10 + 3])).toBeGreaterThan(0);
    for (const [a, b, c] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.25, 0.25, 0.25]]) expect(quadJacobian(m.nodes, t, e, a, b, c)).toBeGreaterThan(0);
  }
}

/** Area of the mesh's boundary triangles on each face. */
function meshFaceAreas(m: TetMesh): Map<number, number> {
  const out = new Map<number, number>();
  for (let f = 0; f < m.triFace.length; f++) out.set(m.triFace[f], (out.get(m.triFace[f]) ?? 0) + integrateTriangle(m.nodes, m.tris, f));
  return out;
}

describe('volume mesher', () => {
  it('meshes a box exactly: volume, faces, edges and corners', async () => {
    const { surf, faces } = await surfaceOf([sketch('s1', rect(0, 0, 200, 20)), extrude('f1', 's1', 10)]);
    expect(surf.volume()).toBeCloseTo(40000, 3);
    const m = meshSolid(surf, { size: 4 });
    expectValid(m);
    expect(m.stats.volume / 40000).toBeCloseTo(1, 6);
    expect(m.stats.unassigned).toBe(0);
    expect(m.stats.pieces).toBe(1);
    const areas = meshFaceAreas(m);
    faces.forEach((f, i) => expect(areas.get(i)! / f.area).toBeCloseTo(1, 4));
    expect(m.stats.minQuality).toBeGreaterThan(0.15);
  }, 60000);

  it('meshes a plate with a hole: curved boundary on the cylinder', async () => {
    const { surf, fs, faces } = await surfaceOf([sketch('s1', [...rect(-50, -25, 50, 25), ...circle(0, 0, 5)]), extrude('f1', 's1', 4)]);
    const m = meshSolid(surf, { size: 1.5 });
    expectValid(m);
    // Quadratic elements follow the hole: the volume is within a few parts in ten thousand of the exact one.
    expect(Math.abs(m.stats.volume / fs.volume - 1)).toBeLessThan(5e-4);
    const areas = meshFaceAreas(m);
    const hole = faces.findIndex((f) => f.type === 'cylinder');
    expect(areas.get(hole)! / faces[hole].area).toBeCloseTo(1, 2);
    faces.forEach((f, i) => expect(Math.abs(areas.get(i)! / f.area - 1)).toBeLessThan(0.01));
  }, 60000);

  for (const ex of EXAMPLES) {
    it(`meshes the ${ex.name} example at its automatic size, coarse and fine`, async () => {
      const { surf, fs, faces } = await surfaceOf(ex.make().features);
      const area = surf.faceAreas().reduce((a, b) => a + b, 0);
      const auto = defaultElementSize(fs.volume, area, surf.diag);
      const max = maxElementSize(fs.volume, area, surf.diag);
      for (const size of [elementSizeFor(auto, max, 0), elementSizeFor(auto, max, 0.5), elementSizeFor(auto, max, 1)]) {
        const m = meshSolid(surf, { size });
        expectValid(m);
        expect(m.stats.pieces).toBe(1);
        expect(Math.abs(m.stats.volume / fs.volume - 1)).toBeLessThan(size > auto ? 0.015 : 0.004);
        // Every face of the part is meshed, the large ones to within a few percent of their area.
        const areas = meshFaceAreas(m);
        faces.forEach((f, i) => {
          expect(areas.get(i) ?? 0, `${f.name} (${f.type}) at ${size}`).toBeGreaterThan(0);
          if (f.area > 40 * size * size) expect(Math.abs((areas.get(i) ?? 0) / f.area - 1), `${f.name} at ${size}`).toBeLessThan(size > auto ? 0.1 : 0.03);
        });
      }
    }, 120000);
  }
});
