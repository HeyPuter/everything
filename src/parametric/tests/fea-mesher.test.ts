// Volume meshing for stress analysis on parts built by the real kernel:
// positive elements, the mesh's volume against the solid's, faces covered by
// boundary triangles of their own, and every example part meshed.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import { EXAMPLES } from '../src/app/examples';
import { SurfaceIndex } from '../src/fea/surface';
import { MAX_DOFS, MeshError, type TetMesh, defaultElementSize, estimateDofs, maxElementSize, meshSolid, meshWalls, minElementSize, quadJacobian, tetVolume } from '../src/fea/mesher';
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

  it('meshes the same part the same way every time', async () => {
    const { surf } = await surfaceOf([sketch('s1', [...rect(-20, -20, 20, 20), ...circle(0, 0, 8)]), extrude('f1', 's1', 30)]);
    const a = meshSolid(surf, { size: 2.5 }), b = meshSolid(surf, { size: 2.5 });
    expect(Array.from(b.nodes)).toEqual(Array.from(a.nodes));
    expect(Array.from(b.tets)).toEqual(Array.from(a.tets));
    expect(Array.from(b.triFace)).toEqual(Array.from(a.triFace));
  }, 60000);

  /** The sizes the mesh panel offers for a part: automatic, largest, smallest, and the one for a fineness. */
  const sizesOf = (surf: SurfaceIndex, volume: number) => {
    const area = surf.faceAreas().reduce((a, b) => a + b, 0);
    const auto = defaultElementSize(volume, area, surf.diag), max = maxElementSize(volume, area, surf.diag), min = minElementSize(volume, area, surf.diag);
    return { area, auto, max, min, at: (fineness: number) => elementSizeFor(auto, max, fineness, min) };
  };

  it('meshes a 1.5 mm plate at the default size: elements as thick as the plate, the unknowns estimated', async () => {
    // 200 x 100 x 1.5: the default for its volume alone (2.35 mm) left no mesh in the plate.
    const { surf, fs } = await surfaceOf([sketch('s1', rect(0, 0, 200, 100)), extrude('f1', 's1', 1.5)]);
    const z = sizesOf(surf, fs.volume);
    const size = z.at(0.5);
    expect(size).toBeLessThanOrEqual(1.5);
    const m = meshSolid(surf, { size });
    expect(Math.abs(m.stats.volume / fs.volume - 1)).toBeLessThan(1e-3);
    expect(m.stats.pieces).toBe(1);
    const est = estimateDofs(fs.volume, size, z.area);
    expect(Math.abs(est / (m.stats.nodes * 3) - 1)).toBeLessThan(0.1);
    // Fine stops at what a browser can solve.
    expect(estimateDofs(fs.volume, z.at(1), z.area)).toBeLessThanOrEqual(MAX_DOFS * 1.001);
  }, 60000);

  it('keeps the sizes of compact parts, and caps their fine end at what a browser can solve', async () => {
    const { surf, fs } = await surfaceOf([sketch('s1', rect(0, 0, 50, 50)), extrude('f1', 's1', 50)]);
    const z = sizesOf(surf, fs.volume);
    expect(z.at(0.5)).toBeCloseTo(Math.cbrt(125000 / 2300), 6);
    expect(z.at(1)).toBeCloseTo(Math.cbrt(125000 / 2300) / 2, 6);
    // Within 5% of the 960,960 unknowns of that mesh.
    expect(Math.abs(estimateDofs(fs.volume, z.at(1), z.area) / 960960 - 1)).toBeLessThan(0.05);
    // A plate with many holes: half the automatic size would be 1.2 million unknowns.
    const big = await surfaceOf([sketch('s1', [...rect(0, 0, 200, 100), ...Array.from({ length: 40 }, (_, i) => circle(10 + (i % 10) * 20, 12.5 + Math.floor(i / 10) * 25, 4)).flat()]), extrude('f1', 's1', 5)]);
    const zb = sizesOf(big.surf, big.fs.volume);
    expect(zb.at(1)).toBeGreaterThan(zb.auto / 2);
    expect(estimateDofs(big.fs.volume, zb.at(1), zb.area)).toBeCloseTo(MAX_DOFS, -3);
  }, 60000);

  it('meshes finer where walls are thinner than the size set (a thin plate with a thick boss)', async () => {
    const { surf, fs } = await surfaceOf([sketch('s1', rect(0, 0, 200, 100)), extrude('f1', 's1', 1.5), sketch('s2', circle(100, 50, 12)), extrude('f2', 's2', 25)]);
    const z = sizesOf(surf, fs.volume);
    const size = z.at(0.5);
    expect(() => meshSolid(surf, { size })).toThrow(/walls are thinner than the elements/);
    const m = meshWalls(surf, { size, min: z.min });
    expect(m.stats.size).toBeLessThan(size);
    expect(m.stats.size).toBeGreaterThanOrEqual(z.min);
    expect(Math.abs(m.stats.volume / fs.volume - 1)).toBeLessThan(1e-2);
  }, 60000);

  it('refuses a plate too thin for any mesh a browser can solve, instead of meshing a fraction of it', async () => {
    // 100 x 100 x 0.5: elements as thin as that would make several million unknowns.
    const { surf, fs } = await surfaceOf([sketch('s1', rect(0, 0, 100, 100)), extrude('f1', 's1', 0.5)]);
    const z = sizesOf(surf, fs.volume);
    expect(z.at(1)).toBeGreaterThan(0.5);
    expect(() => meshSolid(surf, { size: z.at(1) })).toThrow(MeshError);
    expect(() => meshSolid(surf, { size: z.at(1) })).toThrow(/misses \d+% of the part's volume/);
    expect(() => meshWalls(surf, { size: z.at(0.5), min: z.min })).toThrow(/misses \d+% of the part's volume: some of its walls are thinner than the elements\. Elements small enough for those walls would make more unknowns than a browser can solve\./);
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
        // Coarse meshes may cut a little off small fillets (below the 2% the mesh panel warns about).
        expect(Math.abs(m.stats.volume / fs.volume - 1)).toBeLessThan(size > auto ? 0.02 : 0.004);
        // No slivers on the bracket: the edge recovery stops before it squashes elements (it went to 0.008 coarse).
        if (ex.id === 'bracket') expect(m.stats.minQuality, `quality at ${size}`).toBeGreaterThan(0.04);
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
