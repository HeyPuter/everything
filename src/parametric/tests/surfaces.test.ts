// Surface modeling on the real OpenCascade kernel in Node: surface bodies
// (made, changed and used by the surface features) and the solid path left
// as it was for parts without them.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import { flangeExample, bracketExample } from '../src/app/examples';
import type { BuildResult } from '../src/kernel/protocol';
import type { EdgeRef, FaceRef, Feature, SkEntity, SketchFeature } from '../src/model/types';
import { newSurfaceFeature, type SurfaceFeature, type SurfaceFeatureType } from '../src/model/surfaces';
import { dependencies, consumedSketches } from '../src/model/features';
import { validFeature } from '../src/model/validate-feature';
import { circle, extrude, rect, req, sketch } from './helpers';

beforeAll(async () => {
  setOc(await init());
});

const P = (id: string, x: number, y: number): SkEntity => ({ id, t: 'point', x, y });
const L = (id: string, a: string, b: string, construction = false): SkEntity => ({ id, t: 'line', a, b, ...(construction ? { construction } : {}) });
/** An open polyline. */
const open = (prefix: string, pts: [number, number][]): SkEntity[] => [
  ...pts.map(([x, y], i) => P(`${prefix}p${i}`, x, y)),
  ...pts.slice(1).map((_, i) => L(`${prefix}l${i}`, `${prefix}p${i}`, `${prefix}p${i + 1}`)),
];

function surf<T extends SurfaceFeatureType>(type: T, id: string, extra: Partial<Extract<SurfaceFeature, { type: T }>>): Feature {
  return { ...newSurfaceFeature(type, id, id, 10), ...extra } as Feature;
}

const ok = (res: BuildResult) => {
  const bad = res.status.filter((s) => !s.ok);
  expect(bad, JSON.stringify(bad)).toEqual([]);
};

/** Surface area of the build's surface bodies (from the face list). */
const surfaceArea = (res: BuildResult) => res.faces.filter((f) => f.body).reduce((a, f) => a + f.area, 0);
const surfaceFaces = (res: BuildResult) => res.faces.filter((f) => f.body);
const faceRefOf = (res: BuildResult, pred: (f: BuildResult['faces'][number]) => boolean): FaceRef => {
  const f = res.faces.find(pred);
  if (!f) throw new Error('no such face');
  return { name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } };
};
const edgeRefOf = (res: BuildResult, pred: (e: BuildResult['edges'][number]) => boolean): EdgeRef[] =>
  res.edges.filter(pred).map((e) => ({ name: e.name, sig: { type: e.type, m: e.mid, len: e.length } }));

const near = (a: number[], b: number[], tol = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) < tol);

describe('surface bodies', () => {
  it('extrudes an open sketch into a surface body beside no solid', async () => {
    const b = new ModelBuilder();
    const res = await b.build(req([sketch('S1', open('a', [[0, 0], [20, 0], [20, 10]])), surf('surfaceExtrude', 'F1', { sketch: 'S1', depth: 5 })]));
    ok(res);
    expect(b.hasBody).toBe(false);
    expect(surfaceFaces(res)).toHaveLength(2);
    expect(surfaceFaces(res).map((f) => f.name).sort()).toEqual(['F1:side:al0', 'F1:side:al1']);
    expect(surfaceArea(res)).toBeCloseTo(150, 6);
    expect(res.surfaces).toEqual({ face: 0, edge: 0 });
    expect(near(res.bbox!.min, [0, 0, 0]) && near(res.bbox!.max, [20, 10, 5])).toBe(true);
    // The shared edge joins the two faces; the others bound one face each.
    const shared = res.edges.filter((e) => e.faces.length === 2);
    expect(shared).toHaveLength(1);
    expect(res.edges.every((e) => e.body === 'F1')).toBe(true);
    expect(res.mesh!.indices.length).toBeGreaterThan(0);
    const mp = b.massProperties()!;
    expect(mp.solid).toBe(false);
    expect(mp.volume).toBe(0);
    expect(mp.surfaceArea).toBeCloseTo(150, 6);
  });

  it('extrudes a closed sketch into an open tube, mid plane and in two directions', async () => {
    const b = new ModelBuilder();
    let res = await b.build(req([sketch('S1', rect(0, 0, 10, 6)), surf('surfaceExtrude', 'F1', { sketch: 'S1', depth: 4, end: 'midPlane' })]));
    ok(res);
    expect(surfaceFaces(res)).toHaveLength(4);
    expect(surfaceArea(res)).toBeCloseTo(32 * 4, 6);
    expect(res.bbox!.min[2]).toBeCloseTo(-2, 6);
    expect(res.bbox!.max[2]).toBeCloseTo(2, 6);
    res = await b.build(req([sketch('S1', rect(0, 0, 10, 6)), surf('surfaceExtrude', 'F1', { sketch: 'S1', depth: 4, dir2: { depth: 1 } })]));
    ok(res);
    expect(res.bbox!.min[2]).toBeCloseTo(-1, 6);
    expect(res.bbox!.max[2]).toBeCloseTo(4, 6);
    expect(surfaceArea(res)).toBeCloseTo(32 * 5, 6);
  });

  it('revolves a line into a cylindrical surface, skipping the axis', async () => {
    const b = new ModelBuilder();
    const ents = [...open('a', [[5, 0], [5, 10]]), P('c0', 0, -5), P('c1', 0, 15), L('cl', 'c0', 'c1', true)];
    const res = await b.build(req([sketch('S1', ents), surf('surfaceRevolve', 'F1', { sketch: 'S1', angle: 360 })]));
    ok(res);
    expect(surfaceArea(res)).toBeCloseTo(2 * Math.PI * 5 * 10, 3);
    const half = await b.build(req([sketch('S1', ents), surf('surfaceRevolve', 'F1', { sketch: 'S1', angle: 180, end: 'midPlane' })]));
    ok(half);
    expect(surfaceArea(half)).toBeCloseTo(Math.PI * 5 * 10, 3);
    // A line across the centerline says so.
    const across = [...open('a', [[-5, 0], [5, 10]]), P('c0', 0, -5), P('c1', 0, 15), L('cl', 'c0', 'c1', true)];
    const bad = await b.build(req([sketch('S1', across), surf('surfaceRevolve', 'F1', { sketch: 'S1', angle: 360 })]));
    expect(bad.status[1]).toMatchObject({ ok: false, error: expect.stringMatching(/crosses the axis of revolution/) });
  });

  it('lofts open and closed profiles into surfaces, and sweeps an open profile', async () => {
    const b = new ModelBuilder();
    const top = { kind: 'feature' as const, id: 'PL' };
    const plane: Feature = { id: 'PL', name: 'PL', type: 'plane', ref: { kind: 'base', plane: 'top' }, offset: 10, flip: false };
    // Two parallel lines 10 apart: a flat ruled strip.
    let res = await b.build(req([plane, sketch('S1', open('a', [[0, 0], [10, 0]]), { kind: 'base', plane: 'top' }), sketch('S2', open('b', [[0, 0], [10, 0]]), top),
      surf('surfaceLoft', 'F1', { profiles: ['S1', 'S2'] })]));
    ok(res);
    expect(surfaceArea(res)).toBeCloseTo(100, 4);
    // Circles of radius 5 and 3, 10 apart: a frustum's side.
    res = await b.build(req([plane, sketch('S1', circle(0, 0, 5), { kind: 'base', plane: 'top' }), sketch('S2', circle(0, 0, 3), top),
      surf('surfaceLoft', 'F1', { profiles: ['S1', 'S2'], ruled: true })]));
    ok(res);
    expect(surfaceArea(res)).toBeCloseTo(Math.PI * (5 + 3) * Math.hypot(10, 2), 2);
    // Mixed open and closed profiles cannot be lofted.
    res = await b.build(req([plane, sketch('S1', circle(0, 0, 5), { kind: 'base', plane: 'top' }), sketch('S2', open('b', [[0, 0], [10, 0]]), top),
      surf('surfaceLoft', 'F1', { profiles: ['S1', 'S2'] })]));
    expect(res.status[3]).toMatchObject({ ok: false, error: expect.stringMatching(/all open or all closed/) });
    // A 5 mm line swept 20 mm up its own perpendicular.
    res = await b.build(req([sketch('S1', open('p', [[0, 0], [5, 0]]), { kind: 'base', plane: 'top' }), sketch('S2', open('q', [[0, 0], [0, 20]]), { kind: 'base', plane: 'front' }),
      surf('surfaceSweep', 'F1', { profile: 'S1', path: 'S2' })]));
    ok(res);
    expect(surfaceArea(res)).toBeCloseTo(100, 3);
  });

  it('makes planar surfaces from a sketch and from a loop of edges', async () => {
    const b = new ModelBuilder();
    let res = await b.build(req([sketch('S1', [...rect(0, 0, 20, 10), ...circle(10, 5, 2)]), surf('surfacePlanar', 'F1', { sketch: 'S1' })]));
    ok(res);
    expect(surfaceArea(res)).toBeCloseTo(200 - Math.PI * 4, 4);
    // The top edges of an extruded tube close a loop.
    const tube = [sketch('S1', rect(0, 0, 10, 6)), surf('surfaceExtrude', 'F1', { sketch: 'S1', depth: 4 })];
    res = await b.build(req(tube));
    const topEdges = edgeRefOf(res, (e) => Math.abs(e.mid[2] - 4) < 1e-6);
    expect(topEdges).toHaveLength(4);
    res = await b.build(req([...tube, surf('surfacePlanar', 'F2', { sketch: null, edges: topEdges })]));
    ok(res);
    expect(surfaceFaces(res).filter((f) => f.body === 'F2')).toHaveLength(1);
    expect(surfaceFaces(res).find((f) => f.body === 'F2')!.area).toBeCloseTo(60, 6);
    // Edges that do not close a loop say so.
    res = await b.build(req([...tube, surf('surfacePlanar', 'F2', { sketch: null, edges: topEdges.slice(0, 2) })]));
    expect(res.status[2]).toMatchObject({ ok: false, error: expect.stringMatching(/closed loop/) });
  });

  it('offsets faces of the solid and copies them at zero distance', async () => {
    const b = new ModelBuilder();
    const box = [sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10)];
    const res0 = await b.build(req(box));
    const top = faceRefOf(res0, (f) => f.name === 'E1:cap1');
    let res = await b.build(req([...box, surf('surfaceOffset', 'F1', { faces: [top], distance: 5 })]));
    ok(res);
    const off = surfaceFaces(res);
    expect(off).toHaveLength(1);
    expect(off[0].area).toBeCloseTo(100, 6);
    expect(off[0].center[2]).toBeCloseTo(15, 6);
    expect(b.massProperties()!.volume).toBeCloseTo(1000, 6);
    // Flip offsets into the part; zero copies the face.
    res = await b.build(req([...box, surf('surfaceOffset', 'F1', { faces: [top], distance: 5, flip: true })]));
    expect(surfaceFaces(res)[0].center[2]).toBeCloseTo(5, 6);
    res = await b.build(req([...box, surf('surfaceOffset', 'F1', { faces: [top], distance: 0 })]));
    ok(res);
    expect(surfaceFaces(res)[0].center[2]).toBeCloseTo(10, 6);
  });

  it('refuses to offset a curved face inward by its radius or more', async () => {
    const b = new ModelBuilder();
    const cyl = [sketch('S1', circle(0, 0, 5)), extrude('E1', 'S1', 10)];
    const side = faceRefOf(await b.build(req(cyl)), (f) => f.type === 'cylinder');
    let res = await b.build(req([...cyl, surf('surfaceOffset', 'F1', { faces: [side], distance: 4, flip: true })]));
    ok(res);
    expect(surfaceFaces(res)[0].radius).toBeCloseTo(1, 6);
    // 5 collapses the face onto the axis; 6 and 12 turned it inside out (radius 1 and 7).
    for (const distance of [5, 6, 12]) {
      res = await b.build(req([...cyl, surf('surfaceOffset', 'F1', { faces: [side], distance, flip: true })]));
      expect(res.status[2]).toMatchObject({ ok: false, error: expect.stringMatching(/could not be offset/) });
      expect(surfaceFaces(res)).toHaveLength(0);
    }
    // Outward any distance is fine.
    res = await b.build(req([...cyl, surf('surfaceOffset', 'F1', { faces: [side], distance: 12 })]));
    ok(res);
    expect(surfaceFaces(res)[0].radius).toBeCloseTo(17, 6);
  });

  it('fills a closed boundary of edges', async () => {
    const b = new ModelBuilder();
    const tube = [sketch('S1', circle(0, 0, 5)), surf('surfaceExtrude', 'F1', { sketch: 'S1', depth: 10 })];
    let res = await b.build(req(tube));
    const rim = edgeRefOf(res, (e) => e.type === 'circle' && Math.abs(e.mid[2] - 10) < 1e-6);
    expect(rim).toHaveLength(1);
    res = await b.build(req([...tube, surf('surfaceFill', 'F2', { edges: rim })]));
    ok(res);
    expect(surfaceFaces(res).find((f) => f.body === 'F2')!.area).toBeCloseTo(Math.PI * 25, 2);
  });
});

describe('knit, thicken and cut', () => {
  /** A 10 × 6 × 4 tube with both ends capped by planar surfaces. */
  async function cappedTube(b: ModelBuilder) {
    const tube = [sketch('S1', rect(0, 0, 10, 6)), surf('surfaceExtrude', 'F1', { sketch: 'S1', depth: 4 })];
    const res = await b.build(req(tube));
    const bottom = edgeRefOf(res, (e) => Math.abs(e.mid[2]) < 1e-6);
    const top = edgeRefOf(res, (e) => Math.abs(e.mid[2] - 4) < 1e-6);
    return [...tube, surf('surfacePlanar', 'F2', { sketch: null, edges: bottom }), surf('surfacePlanar', 'F3', { sketch: null, edges: top })];
  }

  it('knits a closed set of surfaces into a solid of the right volume', async () => {
    const b = new ModelBuilder();
    const parts = await cappedTube(b);
    const res0 = await b.build(req(parts));
    const pick = (id: string) => faceRefOf(res0, (f) => f.body === id);
    let res = await b.build(req([...parts, surf('surfaceKnit', 'K1', { faces: [pick('F1'), pick('F2'), pick('F3')], solid: true })]));
    ok(res);
    expect(b.hasBody).toBe(true);
    expect(b.surfaceBodies()).toHaveLength(0);
    expect(b.massProperties()!.volume).toBeCloseTo(240, 4);
    expect(res.faces).toHaveLength(6);
    // The solid's faces keep the surfaces' names.
    expect(res.faces.map((f) => f.name)).toContain('F1:side:' + (parts[0] as SketchFeature).entities.find((e) => e.t === 'line')!.id);
    // Without a cap the surfaces do not close.
    res = await b.build(req([...parts, surf('surfaceKnit', 'K1', { faces: [pick('F1'), pick('F2')], solid: true })]));
    expect(res.status[4]).toMatchObject({ ok: false, error: expect.stringMatching(/do not form a closed volume \(4 open edges\)/) });
    // The failed knit leaves the surfaces as they were.
    expect(b.surfaceBodies()).toHaveLength(3);
    // As a surface: one body of the three.
    res = await b.build(req([...parts, surf('surfaceKnit', 'K1', { faces: [pick('F1'), pick('F2')] })]));
    ok(res);
    expect(b.surfaceBodies().map((x) => x.id).sort()).toEqual(['F3', 'K1']);
    expect(surfaceFaces(res).filter((f) => f.body === 'K1')).toHaveLength(5);
    // A tolerance as large as the part sews it into nothing.
    res = await b.build(req([...parts, surf('surfaceKnit', 'K1', { faces: [pick('F1'), pick('F2')], tolerance: 1e6 })]));
    expect(res.status[4]).toMatchObject({ ok: false, error: expect.stringMatching(/Use a smaller knit tolerance/) });
  });

  it('thickens a surface into a solid of area × thickness, either side or both', async () => {
    const b = new ModelBuilder();
    const base = [sketch('S1', rect(0, 0, 20, 10)), surf('surfacePlanar', 'F1', { sketch: 'S1' })];
    const res0 = await b.build(req(base));
    const face = faceRefOf(res0, (f) => f.body === 'F1');
    let res = await b.build(req([...base, surf('thicken', 'T1', { faces: [face], thickness: 2 })]));
    ok(res);
    expect(b.massProperties()!.volume).toBeCloseTo(400, 4);
    expect(b.surfaceBodies()).toHaveLength(0);
    expect(res.bbox!.min[2]).toBeCloseTo(0, 6);
    expect(res.bbox!.max[2]).toBeCloseTo(2, 6);
    res = await b.build(req([...base, surf('thicken', 'T1', { faces: [face], thickness: 2, side: 'back' })]));
    expect(res.bbox!.min[2]).toBeCloseTo(-2, 6);
    res = await b.build(req([...base, surf('thicken', 'T1', { faces: [face], thickness: 2, side: 'both' })]));
    expect(res.bbox!.min[2]).toBeCloseTo(-1, 6);
    expect(res.bbox!.max[2]).toBeCloseTo(1, 6);
    expect(b.massProperties()!.volume).toBeCloseTo(400, 4);
  });

  it('thickens a lofted surface and a surface with sharp edges', async () => {
    const b = new ModelBuilder();
    const plane: Feature = { id: 'PL', name: 'PL', type: 'plane', ref: { kind: 'base', plane: 'top' }, offset: 20, flip: false };
    const loft = [plane, sketch('S1', open('a', [[0, 0], [30, 0]]), { kind: 'base', plane: 'top' }),
      sketch('S2', [P('b0', 0, 0), P('b1', 15, -5), P('b2', 30, 0), { id: 'bs', t: 'spline', pts: ['b0', 'b1', 'b2'] }], { kind: 'feature', id: 'PL' }),
      surf('surfaceLoft', 'F1', { profiles: ['S1', 'S2'] })];
    let res = await b.build(req(loft));
    ok(res);
    const area = surfaceArea(res);
    res = await b.build(req([...loft, surf('thicken', 'T1', { faces: [faceRefOf(res, (f) => f.body === 'F1')], thickness: 1 })]));
    ok(res);
    expect(b.massProperties()!.volume / area).toBeGreaterThan(0.9);
    expect(b.massProperties()!.volume / area).toBeLessThan(1.1);
    // An L of two faces at a right angle.
    const ell = [sketch('S1', open('a', [[0, 0], [20, 0], [20, 10]])), surf('surfaceExtrude', 'F1', { sketch: 'S1', depth: 5 })];
    const lRes = await b.build(req(ell));
    const lFace = faceRefOf(lRes, (f) => f.body === 'F1');
    res = await b.build(req([...ell, surf('thicken', 'T1', { faces: [lFace], thickness: 1 })]));
    ok(res);
    // 150 of slabs, less the 5 they overlap inside the corner or with the 5 of the corner filled outside it.
    expect([145, 155].some((x) => Math.abs(b.massProperties()!.volume - x) < 1e-3)).toBe(true);
    const front = b.massProperties()!.volume;
    res = await b.build(req([...ell, surf('thicken', 'T1', { faces: [lFace], thickness: 1, side: 'back' })]));
    ok(res);
    expect(b.massProperties()!.volume).toBeCloseTo(300 - front, 3);
    res = await b.build(req([...ell, surf('thicken', 'T1', { faces: [lFace], thickness: 1, side: 'both' })]));
    ok(res);
    expect(b.massProperties()!.volume).toBeCloseTo(150, 3);
    // A closed rectangular tube, outward: 2 × (10 + 6) × 4 walls and the four corners.
    const tube = [sketch('S1', rect(0, 0, 10, 6)), surf('surfaceExtrude', 'F1', { sketch: 'S1', depth: 4 })];
    res = await b.build(req(tube));
    res = await b.build(req([...tube, surf('thicken', 'T1', { faces: [faceRefOf(res, (f) => f.body === 'F1')], thickness: 1 })]));
    ok(res);
    expect([128 + 16, 128 - 16].some((x) => Math.abs(b.massProperties()!.volume - x) < 1e-3)).toBe(true);
  });

  it('thickens strongly curved surfaces by more or less than area × thickness', async () => {
    const b = new ModelBuilder();
    // A dome of radius 5 (a quarter arc revolved about Y).
    const dome = [sketch('S1', [P('c0', 0, -5), P('c1', 5, 0), P('o', 0, 0), { id: 'arc', t: 'arc', c: 'o', a: 'c0', b: 'c1' }, P('x0', 0, -8), P('x1', 0, 8), L('cl', 'x0', 'x1', true)]),
      surf('surfaceRevolve', 'R1', { sketch: 'S1', angle: 360 })];
    const face = faceRefOf(await b.build(req(dome)), (f) => f.body === 'R1');
    const shell = (r0: number, r1: number) => (2 / 3) * Math.PI * (r1 ** 3 - r0 ** 3);
    let res = await b.build(req([...dome, surf('thicken', 'T1', { faces: [face], thickness: 7 })]));
    ok(res);
    expect(b.massProperties()!.volume).toBeCloseTo(shell(5, 12), 3);
    res = await b.build(req([...dome, surf('thicken', 'T1', { faces: [face], thickness: 4, side: 'back' })]));
    ok(res);
    expect(b.massProperties()!.volume).toBeCloseTo(shell(1, 5), 3);
    // Inward past the centre cannot be thickened.
    res = await b.build(req([...dome, surf('thicken', 'T1', { faces: [face], thickness: 6, side: 'back' })]));
    expect(res.status[2]).toMatchObject({ ok: false, error: expect.stringMatching(/could not be thickened/) });
    // An open tube of radius 5 thickened 20 outward.
    const tube = [sketch('S1', circle(0, 0, 5)), surf('surfaceExtrude', 'F1', { sketch: 'S1', depth: 10 })];
    const tf = faceRefOf(await b.build(req(tube)), (f) => f.body === 'F1');
    res = await b.build(req([...tube, surf('thicken', 'T1', { faces: [tf], thickness: 20, side: 'back' })]));
    ok(res);
    expect(b.massProperties()!.volume).toBeCloseTo(Math.PI * (25 ** 2 - 5 ** 2) * 10, 2);
  });

  it('cuts with a thickened surface', async () => {
    const b = new ModelBuilder();
    const parts = [sketch('S1', rect(0, 0, 20, 20)), extrude('E1', 'S1', 10),
      { ...sketch('S2', rect(5, 5, 15, 15)), plane: { kind: 'base', plane: 'front' } } as SketchFeature, surf('surfacePlanar', 'F1', { sketch: 'S2' })];
    // The surface lies on the bottom of the box and is thickened into it.
    const res0 = await b.build(req(parts));
    const res = await b.build(req([...parts, surf('thicken', 'T1', { faces: [faceRefOf(res0, (f) => f.body === 'F1')], thickness: 3, cut: true })]));
    ok(res);
    expect(b.massProperties()!.volume).toBeCloseTo(4000 - 300, 3);
  });

  it('cuts the solid with a surface, keeping the side against its normal (or the other)', async () => {
    const b = new ModelBuilder();
    const plane: Feature = { id: 'PL', name: 'PL', type: 'plane', ref: { kind: 'base', plane: 'front' }, offset: 3, flip: false };
    const parts = [sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10), plane, sketch('S2', rect(-5, -5, 15, 15), { kind: 'feature', id: 'PL' }), surf('surfacePlanar', 'F1', { sketch: 'S2' })];
    const res0 = await b.build(req(parts));
    const face = faceRefOf(res0, (f) => f.body === 'F1');
    let res = await b.build(req([...parts, surf('surfaceCut', 'C1', { face })]));
    ok(res);
    // The surface faces +Z: the material above it goes.
    expect(b.massProperties()!.volume).toBeCloseTo(300, 4);
    // The surface stays, at the top of what is left.
    expect(res.bbox!.max[2]).toBeCloseTo(3, 6);
    expect(b.surfaceBodies()).toHaveLength(1);
    res = await b.build(req([...parts, surf('surfaceCut', 'C1', { face, flip: true })]));
    ok(res);
    expect(b.massProperties()!.volume).toBeCloseTo(700, 4);
    // The new face is named by the cut.
    expect(res.faces.filter((f) => !f.body).some((f) => f.name.startsWith('C1:'))).toBe(true);
    // A surface that misses the body.
    const far: Feature = { id: 'PL', name: 'PL', type: 'plane', ref: { kind: 'base', plane: 'front' }, offset: 30, flip: false };
    res = await b.build(req([...parts.slice(0, 2), far, ...parts.slice(3), surf('surfaceCut', 'C1', { face: { ...face, sig: { ...face.sig, c: [5, 5, 30] } } })]));
    expect(res.status[5]).toMatchObject({ ok: false, error: expect.stringMatching(/does not cut the body/) });
  });
});

describe('trim, extend and delete face', () => {
  const square = [sketch('S1', rect(0, 0, 20, 20)), surf('surfacePlanar', 'F1', { sketch: 'S1' })];
  // A plane at x = 5 (the Right plane faces +X).
  const cutter: Feature = { id: 'PL', name: 'PL', type: 'plane', ref: { kind: 'base', plane: 'right' }, offset: 5, flip: false };

  it('trims with a plane, keeping the side or the picked piece', async () => {
    const b = new ModelBuilder();
    const res0 = await b.build(req([...square, cutter]));
    const face = faceRefOf(res0, (f) => f.body === 'F1');
    let res = await b.build(req([...square, cutter, surf('surfaceTrim', 'T1', { faces: [face], tool: { kind: 'plane', plane: { kind: 'feature', id: 'PL' } } })]));
    ok(res);
    expect(surfaceArea(res)).toBeCloseTo(15 * 20, 4);
    expect(b.surfaceBodies().map((x) => x.id)).toEqual(['T1']);
    // The trimmed face keeps its name.
    expect(surfaceFaces(res)[0].name).toBe('F1:p0');
    res = await b.build(req([...square, cutter, surf('surfaceTrim', 'T1', { faces: [face], tool: { kind: 'plane', plane: { kind: 'feature', id: 'PL' } }, flip: true })]));
    expect(surfaceArea(res)).toBeCloseTo(5 * 20, 4);
    res = await b.build(req([...square, cutter, surf('surfaceTrim', 'T1', { faces: [face], tool: { kind: 'plane', plane: { kind: 'feature', id: 'PL' } }, keep: [[2, 10, 0]] })]));
    expect(surfaceArea(res)).toBeCloseTo(5 * 20, 4);
    // A plane beyond the surface, on the side it keeps: it does not cross the surface, rather than "nothing left on that side".
    const far = { ...cutter, offset: 50 } as Feature;
    res = await b.build(req([...square, far, surf('surfaceTrim', 'T1', { faces: [face], tool: { kind: 'plane', plane: { kind: 'feature', id: 'PL' } } })]));
    expect(res.status[3]).toMatchObject({ ok: false, error: expect.stringMatching(/does not cross the surface/) });
  });

  it('trims with a sketch and with another surface', async () => {
    const b = new ModelBuilder();
    const line = sketch('S2', open('t', [[-5, 10], [25, 10]]));
    const res0 = await b.build(req([...square, line]));
    const face = faceRefOf(res0, (f) => f.body === 'F1');
    let res = await b.build(req([...square, line, surf('surfaceTrim', 'T1', { faces: [face], tool: { kind: 'sketch', sketch: 'S2' }, keep: [[10, 15, 0]] })]));
    ok(res);
    expect(surfaceArea(res)).toBeCloseTo(200, 4);
    expect(surfaceFaces(res)[0].center[1]).toBeCloseTo(15, 4);
    // A vertical wall surface across the square at y = 5.
    const wall = [sketch('S3', open('w', [[-5, 5], [25, 5]])), surf('surfaceExtrude', 'W1', { sketch: 'S3', depth: 10, end: 'midPlane' })];
    const res1 = await b.build(req([...square, ...wall]));
    res = await b.build(req([...square, ...wall, surf('surfaceTrim', 'T1', { faces: [faceRefOf(res1, (f) => f.body === 'F1')], tool: { kind: 'surface', face: faceRefOf(res1, (f) => f.body === 'W1') }, keep: [[10, 1, 0]] })]));
    ok(res);
    expect(surfaceFaces(res).filter((f) => f.body === 'T1').reduce((a, f) => a + f.area, 0)).toBeCloseTo(100, 4);
  });

  it('trims a hole with a circle sketch, keeping one side or the other', async () => {
    const b = new ModelBuilder();
    const hole = sketch('S2', circle(10, 10, 3));
    const face = faceRefOf(await b.build(req([...square, hole])), (f) => f.body === 'F1');
    // The square around the hole has the middle of its parameter range in the hole:
    // both pieces were taken for the same side, and both kept (or neither, flipped).
    const areas = [];
    for (const flip of [false, true]) {
      const res = await b.build(req([...square, hole, surf('surfaceTrim', 'T1', { faces: [face], tool: { kind: 'sketch', sketch: 'S2' }, flip })]));
      ok(res);
      expect(surfaceFaces(res)).toHaveLength(1);
      areas.push(surfaceArea(res));
    }
    expect(areas.sort((x, y) => x - y)[0]).toBeCloseTo(Math.PI * 9, 3);
    expect(areas[1]).toBeCloseTo(400 - Math.PI * 9, 3);
  });

  it('extends a surface past an edge, the same surface or straight', async () => {
    const b = new ModelBuilder();
    const res0 = await b.build(req(square));
    const right = edgeRefOf(res0, (e) => Math.abs(e.mid[0] - 20) < 1e-6);
    expect(right).toHaveLength(1);
    let res = await b.build(req([...square, surf('surfaceExtend', 'X1', { edges: right, distance: 5 })]));
    ok(res);
    expect(surfaceArea(res)).toBeCloseTo(25 * 20, 4);
    expect(res.bbox!.max[0]).toBeCloseTo(25, 6);
    res = await b.build(req([...square, surf('surfaceExtend', 'X1', { edges: right, distance: 5, mode: 'linear' })]));
    ok(res);
    expect(surfaceArea(res)).toBeCloseTo(25 * 20, 4);
    expect(res.bbox!.max[0]).toBeCloseTo(25, 6);
  });

  it('extends a flat disc past its circular edge as a ring, not a rectangle', async () => {
    const b = new ModelBuilder();
    const disc = [sketch('S1', circle(0, 0, 5)), surf('surfacePlanar', 'F1', { sketch: 'S1' })];
    const rim = edgeRefOf(await b.build(req(disc)), () => true);
    // Same surface grew one side of the plane's range: a 12 × 10 rectangle.
    let res = await b.build(req([...disc, surf('surfaceExtend', 'X1', { edges: rim, distance: 2 })]));
    expect(res.status[2]).toMatchObject({ ok: false, error: expect.stringMatching(/Use Linear/) });
    // Linear made a flat sliver along one direction.
    res = await b.build(req([...disc, surf('surfaceExtend', 'X1', { edges: rim, distance: 2, mode: 'linear' })]));
    ok(res);
    expect(surfaceArea(res)).toBeCloseTo(Math.PI * 49, 2);
    expect(res.bbox!.min[0]).toBeCloseTo(-7, 3);
    expect(res.bbox!.min[1]).toBeCloseTo(-7, 3);
    expect(res.edges.filter((e) => e.faces.length === 2)).toHaveLength(1);
    // A hole's edge grows into the hole, not over the face around it.
    const holed = [sketch('S1', [...rect(-10, -10, 10, 10), ...circle(0, 0, 4)]), surf('surfacePlanar', 'F1', { sketch: 'S1' })];
    const hole = edgeRefOf(await b.build(req(holed)), (e) => e.type === 'circle');
    res = await b.build(req([...holed, surf('surfaceExtend', 'X1', { edges: hole, distance: 2, mode: 'linear' })]));
    ok(res);
    expect(surfaceArea(res)).toBeCloseTo(400 - Math.PI * 4, 2);
  });

  it('deletes faces of the solid into a surface body, or patches the hole', async () => {
    const b = new ModelBuilder();
    const box = [sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10)];
    const res0 = await b.build(req(box));
    const top = faceRefOf(res0, (f) => f.name === 'E1:cap1');
    let res = await b.build(req([...box, surf('deleteFace', 'D1', { faces: [top] })]));
    ok(res);
    expect(b.hasBody).toBe(false);
    expect(surfaceFaces(res)).toHaveLength(5);
    expect(surfaceFaces(res).map((f) => f.name)).toContain('E1:cap0');
    res = await b.build(req([...box, surf('deleteFace', 'D1', { faces: [top], mode: 'patch' })]));
    ok(res);
    expect(b.massProperties()!.volume).toBeCloseTo(1000, 3);
  });
});

describe('surfaces with the rest of the part', () => {
  it('sketches on a planar surface face and extrudes from it', async () => {
    const b = new ModelBuilder();
    const plane: Feature = { id: 'PL', name: 'PL', type: 'plane', ref: { kind: 'base', plane: 'front' }, offset: 7, flip: false };
    const parts = [plane, sketch('S1', rect(0, 0, 20, 20), { kind: 'feature', id: 'PL' }), surf('surfacePlanar', 'F1', { sketch: 'S1' })];
    const res0 = await b.build(req(parts));
    const face = faceRefOf(res0, (f) => f.body === 'F1');
    const res = await b.build(req([...parts, sketch('S2', rect(2, 2, 6, 6), { kind: 'face', face }), extrude('E1', 'S2', 3)]));
    ok(res);
    expect(b.massProperties()!.volume).toBeCloseTo(48, 6);
    expect(res.bbox!.min[2]).toBeCloseTo(7, 6);
    expect(res.bbox!.max[2]).toBeCloseTo(10, 6);
  });

  it('says a surface face or edge picked for a solid feature is on a surface', async () => {
    const b = new ModelBuilder();
    const parts = [sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10), sketch('S2', open('a', [[20, 0], [30, 0], [30, 10]])), surf('surfaceExtrude', 'F1', { sketch: 'S2', depth: 10 })];
    const res0 = await b.build(req(parts));
    const edges = edgeRefOf(res0, (e) => e.body === 'F1' && e.faces.length === 2);
    const face = faceRefOf(res0, (f) => f.body === 'F1');
    let res = await b.build(req([...parts, { id: 'FL', name: 'FL', type: 'fillet', edges, faces: [], radius: 1 }]));
    expect(res.status[4]).toMatchObject({ ok: false, error: expect.stringMatching(/is on a surface body, not the solid/) });
    res = await b.build(req([...parts, { id: 'SH', name: 'SH', type: 'shell', faces: [face], thickness: 1, outward: false }]));
    expect(res.status[4]).toMatchObject({ ok: false, error: expect.stringMatching(/is on a surface body, not the solid/) });
  });

  it('exports surface bodies to STEP as shells beside the solid', async () => {
    const b = new ModelBuilder();
    await b.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10), sketch('S2', open('a', [[0, 0], [20, 5]])), surf('surfaceExtrude', 'F1', { sketch: 'S2', depth: 30 })]));
    const text = new TextDecoder().decode(b.exportStep('Part'));
    expect(text).toMatch(/MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS/);
    expect(text).toMatch(/OPEN_SHELL|SHELL_BASED_SURFACE_MODEL/);
    // Mass properties stay those of the solid.
    const mp = b.massProperties()!;
    expect(mp.volume).toBeCloseTo(1000, 6);
    expect(mp.area).toBeCloseTo(600, 6);
    expect(mp.surfaceArea).toBeCloseTo(Math.hypot(20, 5) * 30, 4);
  });

  it('measures to a surface face by its index after the solid faces', async () => {
    const b = new ModelBuilder();
    const res = await b.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 10), sketch('S2', open('a', [[20, 0], [20, 10]])), surf('surfaceExtrude', 'F1', { sketch: 'S2', depth: 10 })]));
    const si = res.faces.findIndex((f) => f.body === 'F1');
    const ti = res.faces.findIndex((f) => f.name.startsWith('E1:side:') && Math.abs(f.center[0] - 10) < 1e-6);
    expect(si).toBe(6);
    expect(b.measure({ kind: 'face', index: si }, { kind: 'face', index: ti }).distance).toBeCloseTo(10, 6);
  });

  it('builds a part without surface features exactly as before, after building one with them', async () => {
    for (const doc of [flangeExample(), bracketExample()]) {
      const fresh = new ModelBuilder();
      const a = await fresh.build(req(doc.features));
      const used = new ModelBuilder();
      await used.build(req([...doc.features, sketch('SX', open('z', [[0, 0], [50, 50]])), surf('surfaceExtrude', 'FX', { sketch: 'SX', depth: 20 })]));
      const b = await used.build(req(doc.features));
      expect(b.surfaces).toBeUndefined();
      expect(a.surfaces).toBeUndefined();
      expect(b.faces).toEqual(a.faces);
      expect(b.edges).toEqual(a.edges);
      expect(b.bbox).toEqual(a.bbox);
      expect(b.status).toEqual(a.status);
      for (const k of ['positions', 'normals', 'indices', 'vertexFace', 'edgePositions', 'edgeIds', 'vertices'] as const) expect(Array.from(b.mesh![k])).toEqual(Array.from(a.mesh![k]));
      expect(a.faces.some((f) => 'body' in f)).toBe(false);
      expect(used.massProperties()!.surfaceArea).toBeUndefined();
    }
  });

  it('previews a surface feature over the part, and a thicken in place of it', async () => {
    const b = new ModelBuilder();
    const base = [sketch('S1', rect(0, 0, 20, 10)), surf('surfacePlanar', 'F1', { sketch: 'S1' })];
    let res = await b.build(req([base[0]], { preview: base[1] }));
    expect(res.previewKind).toBe('tool');
    expect(res.preview!.indices.length).toBeGreaterThan(0);
    expect(res.surfaces).toBeUndefined();
    res = await b.build(req(base));
    const face = faceRefOf(res, (f) => f.body === 'F1');
    res = await b.build(req(base, { preview: surf('thicken', 'T1', { faces: [face], thickness: 2 }) }));
    expect(res.previewKind).toBe('body');
    expect(res.previewError).toBeUndefined();
    // A failing preview says why.
    res = await b.build(req(base, { preview: surf('surfaceKnit', 'K1', { faces: [face], solid: true }) }));
    expect(res.previewError).toMatch(/do not form a closed volume/);
  });

  it('keeps the surfaces of the step before a failed surface feature', async () => {
    const b = new ModelBuilder();
    const res = await b.build(req([sketch('S1', rect(0, 0, 20, 10)), surf('surfacePlanar', 'F1', { sketch: 'S1' }),
      surf('surfaceOffset', 'O1', { faces: [] }), surf('surfaceExtrude', 'X1', { sketch: 'S1', depth: 3 })]));
    expect(res.status[2]).toMatchObject({ ok: false, error: 'Select faces to offset' });
    expect(res.status[3].ok).toBe(true);
    expect(b.surfaceBodies().map((x) => x.id)).toEqual(['F1', 'X1']);
    // Only surfaces: STEP holds them.
    expect(new TextDecoder().decode(b.exportStep())).toMatch(/OPEN_SHELL|SHELL_BASED_SURFACE_MODEL|ADVANCED_FACE/);
    // STL does not, and says why.
    expect(() => b.exportStl(1)).toThrow(/STL files hold solids only/);
  });

  it('lists references, consumed sketches and validates surface features from files', () => {
    const face: FaceRef = { name: 'F1:p0', sig: { type: 'plane', c: [0, 0, 0], area: 1 } };
    const t = surf('thicken', 'T1', { faces: [face] });
    expect(dependencies(t)).toEqual(['F1']);
    const trim = surf('surfaceTrim', 'T2', { faces: [face], tool: { kind: 'sketch', sketch: 'S9' } });
    expect(consumedSketches(trim)).toEqual(['S9']);
    expect(dependencies(trim).sort()).toEqual(['F1', 'S9']);
    expect(validFeature(trim)).toBe(true);
    expect(validFeature({ ...trim, keep: [[1, 2]] } as unknown as Feature)).toBe(false);
    expect(validFeature({ ...t, faces: [{}] } as unknown as Feature)).toBe(false);
    expect(validFeature({ ...surf('surfaceExtrude', 'E', { sketch: 's' }), end: 'throughAll' } as unknown as Feature)).toBe(false);
  });
});
