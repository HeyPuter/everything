// Sheet metal features on the real OpenCascade kernel: volumes, bounding
// boxes and the flat pattern against the bend allowance formula.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import type { BuildResult } from '../src/kernel/protocol';
import type { EdgeInfo, FaceInfo } from '../src/kernel/protocol';
import type { EdgeRef, Feature, FilletFeature, SkEntity } from '../src/model/types';
import {
  type BaseFlangeFeature, type EdgeFlangeFeature, type HemFeature, type SketchedBendFeature, newBaseFlange, newEdgeFlange, newHem, newSketchedBend,
} from '../src/model/sheetmetal';
import { flatPatternDxf, flatSize, parseDxfEntities } from '../src/model/flat-pattern';
import { circle, extrude, rect, req, sketch } from './helpers';

beforeAll(async () => {
  setOc(await init());
}, 60000);

const T = 2, R = 1, K = 0.5;
const BA90 = (Math.PI / 2) * (R + K * T);

/** Open polyline sketch entities. */
function chain(pts: [number, number][], prefix = 'c'): SkEntity[] {
  const ents: SkEntity[] = pts.map(([x, y], i) => ({ id: `${prefix}p${i}`, t: 'point', x, y }));
  for (let i = 0; i + 1 < pts.length; i++) ents.push({ id: `${prefix}l${i}`, t: 'line', a: `${prefix}p${i}`, b: `${prefix}p${i + 1}` });
  return ents;
}

function base(id: string, sk: string, extra: Partial<BaseFlangeFeature> = {}): BaseFlangeFeature {
  const f = newBaseFlange(id, id, sk, T, 40);
  f.sm.radius = R;
  f.sm.kFactor = K;
  return { ...f, ...extra };
}

const edgeRef = (e: EdgeInfo): EdgeRef => ({ name: e.name, sig: { type: e.type, m: e.mid, len: e.length } });

function flange(id: string, edges: EdgeRef[], extra: Partial<EdgeFlangeFeature> = {}): EdgeFlangeFeature {
  return { ...newEdgeFlange(id, id, 20), edges, ...extra };
}

const volume = (b: ModelBuilder) => b.massProperties()!.volume;
const ok = (res: BuildResult) => expect(res.status.map((s) => s.error ?? s.warning ?? 'ok')).toEqual(res.status.map(() => 'ok'));
const size = (res: BuildResult) => res.bbox!.max.map((v, i) => v - res.bbox!.min[i]);

/** Straight edges of a face parallel to a direction, longest first. */
function edgesOn(res: BuildResult, face: FaceInfo, dir: [number, number, number]): EdgeInfo[] {
  const fi = res.faces.indexOf(face);
  return res.edges
    .filter((e) => e.faces.includes(fi) && e.type === 'line' && Math.abs(e.dir![0] * dir[0] + e.dir![1] * dir[1] + e.dir![2] * dir[2]) > 0.999)
    .sort((a, b) => b.length - a.length);
}

describe('base flange', () => {
  it('makes a flat plate from a closed profile', async () => {
    const b = new ModelBuilder();
    const res = await b.build(req([sketch('S1', [...rect(0, 0, 100, 60), ...circle(50, 30, 10)]), base('B1', 'S1')]));
    ok(res);
    expect(volume(b)).toBeCloseTo((6000 - Math.PI * 100) * T, 3);
    expect(size(res)).toEqual([expect.closeTo(100, 6), expect.closeTo(60, 6), expect.closeTo(T, 6)]);
    expect(res.faces.map((f) => f.name)).toEqual(expect.arrayContaining(['B1:cap0', 'B1:cap1']));
    const flat = b.flatPattern().pattern!;
    expect(flatSize(flat)).toEqual([expect.closeTo(100, 6), expect.closeTo(60, 6)]);
    expect(flat.bends).toHaveLength(0);
    expect(flat.loops.filter((l) => !l.outer)).toHaveLength(1);
    expect(flat.notes).toEqual([]);
  });

  it('thickens an L profile with a bend at the corner (outer virtual sharps on the sketch)', async () => {
    const b = new ModelBuilder();
    const res = await b.build(req([sketch('S1', chain([[0, 0], [50, 0], [50, 30]])), base('B1', 'S1')]));
    ok(res);
    // Material to the left of the chain: inside the corner, so the sketch is the outside.
    expect(res.bbox!.min).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6), expect.closeTo(0, 6)]);
    expect(res.bbox!.max).toEqual([expect.closeTo(50, 6), expect.closeTo(30, 6), expect.closeTo(40, 6)]);
    const straight = (50 - (R + T)) + (30 - (R + T));
    const bendVolume = (Math.PI / 4) * ((R + T) ** 2 - R ** 2);
    expect(volume(b)).toBeCloseTo((straight * T + bendVolume) * 40, 3);
    const names = res.faces.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['B1:cap0', 'B1:cap1', 'B1:end0', 'B1:end1', 'B1:bend:cl0:in', 'B1:bend:cl0:out', 'B1:cl0:a', 'B1:cl1:b']));
    const flat = b.flatPattern().pattern!;
    // Flat length: A + B - 2 * setback + bend allowance.
    expect(flatSize(flat)[0]).toBeCloseTo(50 + 30 - 2 * (R + T) + BA90, 6);
    expect(flatSize(flat)[1]).toBeCloseTo(40, 6);
    expect(flat.bends).toHaveLength(1);
    expect(flat.bends[0]).toMatchObject({ up: true, angle: expect.closeTo(90, 9), radius: R, allowance: expect.closeTo(BA90, 9) });
    expect(flat.notes).toEqual([]);
  });

  it('bends the other way with the thickness flipped, and centres it on mid-plane', async () => {
    const b = new ModelBuilder();
    let res = await b.build(req([sketch('S1', chain([[0, 0], [50, 0], [50, 30]])), base('B1', 'S1', { flip: true })]));
    ok(res);
    // Material outside the corner: the sketch is the inside.
    expect(res.bbox!.min.slice(0, 2)).toEqual([expect.closeTo(0, 6), expect.closeTo(-T, 6)]);
    expect(res.bbox!.max.slice(0, 2)).toEqual([expect.closeTo(50 + T, 6), expect.closeTo(30, 6)]);
    expect(flatSize(b.flatPattern().pattern!)[0]).toBeCloseTo(50 + 30 - 2 * R + BA90, 6);
    res = await b.build(req([sketch('S1', chain([[0, 0], [50, 0], [50, 30]])), base('B1', 'S1', { mid: true })]));
    ok(res);
    expect(res.bbox!.max[0]).toBeCloseTo(50 + T / 2, 6);
    expect(flatSize(b.flatPattern().pattern!)[0]).toBeCloseTo(50 + 30 - 2 * (R + T / 2) + BA90, 6);
  });

  it('makes a U channel with two bends and uses an arc as a bend of its own radius', async () => {
    const b = new ModelBuilder();
    let res = await b.build(req([sketch('S1', chain([[0, 30], [0, 0], [40, 0], [40, 30]])), base('B1', 'S1', { flip: true })]));
    ok(res);
    expect(b.flatPattern().pattern!.bends).toHaveLength(2);
    // Line, tangent arc of radius 5 (the sketch is on the outside: inner radius 5 - T), line.
    const ents: SkEntity[] = [
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 30, y: 0 }, { id: 'c', t: 'point', x: 35, y: 5 }, { id: 'd', t: 'point', x: 35, y: 30 },
      { id: 'o', t: 'point', x: 30, y: 5 },
      { id: 'l1', t: 'line', a: 'a', b: 'b' }, { id: 'arc', t: 'arc', c: 'o', a: 'b', b: 'c' }, { id: 'l2', t: 'line', a: 'c', b: 'd' },
    ];
    res = await b.build(req([sketch('S1', ents), base('B1', 'S1')]));
    ok(res);
    const flat = b.flatPattern().pattern!;
    expect(flat.bends[0].radius).toBeCloseTo(5 - T, 9);
    expect(flatSize(flat)[0]).toBeCloseTo(30 + 25 + (Math.PI / 2) * (5 - T + K * T), 6);
  });

  it('reports profiles it cannot use', async () => {
    const b = new ModelBuilder();
    const branch: SkEntity[] = [...chain([[0, 0], [10, 0]], 'a'), ...chain([[10, 0], [10, 10]], 'b'), ...chain([[10, 0], [20, 0]], 'd')];
    let res = await b.build(req([sketch('S1', branch), base('B1', 'S1')]));
    expect(res.status[1].error).toMatch(/single chain/);
    res = await b.build(req([sketch('S1', chain([[0, 0], [2, 0], [2, 30]])), base('B1', 'S1')]));
    expect(res.status[1].error).toMatch(/too short/);
    // A chain that crosses itself, and one whose last leg runs into the first one's thickness.
    res = await b.build(req([sketch('S1', chain([[0, 0], [50, 0], [50, 30], [20, 30], [20, -20]])), base('B1', 'S1')]));
    expect(res.status[1].error).toMatch(/crosses itself/);
    res = await b.build(req([sketch('S1', chain([[0, 0], [50, 0], [50, 30], [10, 30], [10, 1]])), base('B1', 'S1')]));
    expect(res.status[1].error).toMatch(/crosses itself/);
    res = await b.build(req([sketch('S1', chain([[0, 0], [50, 0], [50, 30], [10, 30], [10, 10]])), base('B1', 'S1')]));
    ok(res);
    res = await b.build(req([sketch('S1', rect(0, 0, 10, 10)), base('B1', 'S1', { sm: { ...base('x', 'x').sm, thickness: 0 } })]));
    expect(res.status[1].error).toMatch(/Thickness/);
  });
});

/** A 100 x 60 plate on the front plane, its top face at z = T. */
const plate = (): Feature[] => [sketch('S1', rect(0, 0, 100, 60, 'pl')), base('B1', 'S1')];

async function plateEdge(b: ModelBuilder, y = 60): Promise<EdgeInfo> {
  const res = await b.build(req(plate()));
  const top = res.faces.find((f) => f.name === 'B1:cap1')!;
  return edgesOn(res, top, [1, 0, 0]).find((e) => Math.abs(e.mid[1] - y) < 1e-6)!;
}

describe('edge flange', () => {
  it('adds a 90 degree flange inside the plate (material inside, outer virtual sharp)', async () => {
    const b = new ModelBuilder();
    const e = await plateEdge(b);
    const res = await b.build(req([...plate(), flange('F1', [edgeRef(e)])]));
    ok(res);
    // The outer face of the flange is flush with the plate's old edge; the flange is 20 high from the outer sharp.
    expect(res.bbox!.max).toEqual([expect.closeTo(100, 6), expect.closeTo(60, 6), expect.closeTo(20, 6)]);
    expect(res.bbox!.min).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6), expect.closeTo(0, 6)]);
    const flatPlate = 60 - (R + T), flatFlange = 20 - (R + T);
    const bendVolume = (Math.PI / 4) * ((R + T) ** 2 - R ** 2) * 100;
    expect(volume(b)).toBeCloseTo((flatPlate + flatFlange) * T * 100 + bendVolume, 3);
    const flat = b.flatPattern().pattern!;
    expect(flatSize(flat)).toEqual([expect.closeTo(100, 6), expect.closeTo(flatPlate + BA90 + flatFlange, 6)]);
    expect(flat.bends[0]).toMatchObject({ up: true, angle: 90 });
    expect(res.faces.map((f) => f.name)).toEqual(expect.arrayContaining(['F1:e0:bend:in', 'F1:e0:bend:out', 'F1:e0:flange:in', 'F1:e0:flange:out', 'F1:e0:end']));
  });

  it('measures the length and places the bend as asked', async () => {
    const b = new ModelBuilder();
    const e = await plateEdge(b);
    // Bend outside, length from the bend's end: plate untouched, flange straight 20 past the bend.
    let res = await b.build(req([...plate(), flange('F1', [edgeRef(e)], { position: 'bendOutside', lengthRef: 'tangent' })]));
    ok(res);
    expect(res.bbox!.max[1]).toBeCloseTo(60 + R + T, 6);
    expect(res.bbox!.max[2]).toBeCloseTo(T + R + 20, 6);
    expect(flatSize(b.flatPattern().pattern!)[1]).toBeCloseTo(60 + BA90 + 20, 6);
    // Material outside, inner virtual sharp: the inner face is flush with the edge.
    res = await b.build(req([...plate(), flange('F1', [edgeRef(e)], { position: 'materialOutside', lengthRef: 'inner' })]));
    ok(res);
    expect(res.bbox!.max[1]).toBeCloseTo(60 + T, 6);
    expect(res.bbox!.max[2]).toBeCloseTo(20 + T, 6);
    // Flipped: the flange goes down.
    res = await b.build(req([...plate(), flange('F1', [edgeRef(e)], { flip: true })]));
    ok(res);
    expect(res.bbox!.min[2]).toBeCloseTo(T - 20, 6);
    expect(b.flatPattern().pattern!.bends[0].up).toBe(false);
  });

  it('bends at other angles with the K-factor bend allowance', async () => {
    for (const angle of [45, 120]) {
      const b = new ModelBuilder();
      const e = await plateEdge(b);
      const res = await b.build(req([...plate(), flange('F1', [edgeRef(e)], { angle, position: 'bendOutside', lengthRef: 'tangent' })]));
      ok(res);
      const a = (angle * Math.PI) / 180;
      // Top of the flange's end: on its inner face below 90 degrees, its outer face past it.
      const top = T + R + 20 * Math.sin(a) - (angle <= 90 ? R : R + T) * Math.cos(a);
      expect(res.bbox!.max[2]).toBeCloseTo(top, 6);
      const ba = a * (R + K * T);
      expect(flatSize(b.flatPattern().pattern!)[1]).toBeCloseTo(60 + ba + 20, 6);
      const bendVolume = (a / 2) * ((R + T) ** 2 - R ** 2) * 100;
      expect(volume(b)).toBeCloseTo((60 + 20) * T * 100 + bendVolume, 3);
    }
  });

  it('adds reliefs where the flange stops short of the edge', async () => {
    const b = new ModelBuilder();
    const e = await plateEdge(b);
    const res = await b.build(req([...plate(), flange('F1', [edgeRef(e)], { offset1: 10, offset2: 20 })]));
    ok(res);
    const rw = 0.5 * T;
    const trim = R + T;
    const flatPlate = 60 * 100 - trim * 70 - 2 * rw * (trim + rw);
    const bendVolume = (Math.PI / 4) * ((R + T) ** 2 - R ** 2) * 70;
    expect(volume(b)).toBeCloseTo(flatPlate * T + (20 - trim) * T * 70 + bendVolume, 3);
    const flat = b.flatPattern().pattern!;
    expect(flat.notes).toEqual([]);
    expect(Math.abs(flat.bends[0].b[0] - flat.bends[0].a[0])).toBeCloseTo(70, 6);
  });

  it('flanges two edges in one feature, and rejects edges that are not sheet edges', async () => {
    const b = new ModelBuilder();
    let res = await b.build(req(plate()));
    const top = res.faces.find((f) => f.name === 'B1:cap1')!;
    const [e1, e2] = edgesOn(res, top, [1, 0, 0]);
    res = await b.build(req([...plate(), flange('F1', [edgeRef(e1), edgeRef(e2)])]));
    ok(res);
    expect(size(res)).toEqual([expect.closeTo(100, 6), expect.closeTo(60, 6), expect.closeTo(20, 6)]);
    expect(b.flatPattern().pattern!.bends).toHaveLength(2);
    // An edge across the thickness.
    res = await b.build(req(plate()));
    const short = res.edges.find((x) => x.type === 'line' && Math.abs(x.length - T) < 1e-6)!;
    res = await b.build(req([...plate(), flange('F1', [edgeRef(short)])]));
    expect(res.status[2].error).toMatch(/across its thickness/);
    // Without a sheet metal part.
    res = await b.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 5), flange('F1', [edgeRef(short)])]));
    expect(res.status[2].error).toMatch(/Base Flange/);
  });

  it('says when a hole is where the bend of a flange goes', async () => {
    const b = new ModelBuilder();
    const holed: Feature[] = [sketch('S1', [...rect(0, 0, 100, 60, 'pl'), ...circle(50, 58, 1.5)]), base('B1', 'S1')];
    let res = await b.build(req(holed));
    const top = res.faces.find((f) => f.name === 'B1:cap1')!;
    const e = edgesOn(res, top, [1, 0, 0]).find((x) => Math.abs(x.mid[1] - 60) < 1e-6)!;
    res = await b.build(req([...holed, flange('F1', [edgeRef(e)])]));
    expect(res.status[2].error).toMatch(/hole or cut where its bend goes/);
    ok(await b.build(req([...holed, flange('F1', [edgeRef(e)], { position: 'bendOutside' })])));
  });

  it('says when a flange would run into the part instead of merging into it', async () => {
    const b = new ModelBuilder();
    const L: Feature[] = [sketch('S1', chain([[0, 0], [60, 0], [60, 40]])), base('B1', 'S1')];
    let res = await b.build(req(L));
    // The top edge of the upright leg, on its inner face: a 135 degree flange back over the base reaches through it.
    const e = res.edges.find((x) => x.type === 'line' && Math.abs(x.mid[1] - 40) < 1e-6 && Math.abs(x.mid[0] - (60 - T)) < 1e-6 && Math.abs(x.dir![2]) > 0.99)!;
    res = await b.build(req([...L, flange('F1', [edgeRef(e)], { angle: 135, length: 80 })]));
    expect(res.status[2].error).toMatch(/runs into the part/);
    res = await b.build(req([...L, flange('F1', [edgeRef(e)], { angle: 135, length: 30 })]));
    ok(res);
    res = await b.build(req([...L, flange('F1', [edgeRef(e)], { angle: 135, length: 80, flip: true })]));
    ok(res);
  });

  it('keeps fillets and holes on sheet metal faces through thickness changes', async () => {
    const b = new ModelBuilder();
    const e = await plateEdge(b);
    const f1 = flange('F1', [edgeRef(e)]);
    let res = await b.build(req([...plate(), f1]));
    const out = res.faces.find((f) => f.name === 'F1:e0:flange:out')!;
    const corner = res.edges.find((x) => x.name.includes('F1:e0:end') && Math.abs(x.length - T) < 1e-6)!;
    expect(corner).toBeTruthy();
    const fillet: FilletFeature = { id: 'FL', name: 'FL', type: 'fillet', edges: [edgeRef(corner)], faces: [], radius: 3 };
    const hole = sketch("S2", circle(50, -10, 3), { kind: 'face', face: { name: out.name, sig: { type: 'plane', c: out.center, n: out.normal, area: out.area } } });
    const cutHole = extrude('C1', 'S2', 1, { cut: true, end: 'throughAll' });
    res = await b.build(req([...plate(), f1, fillet, hole, cutHole]));
    ok(res);
    const v1 = volume(b);
    const thicker = plate();
    (thicker[1] as BaseFlangeFeature).sm.thickness = 3;
    res = await b.build(req([...thicker, f1, fillet, hole, cutHole]));
    ok(res);
    expect(volume(b)).toBeGreaterThan(v1);
    // The hole through the flange shows in the flat pattern.
    const flat = b.flatPattern().pattern!;
    expect(flat.loops.filter((l) => !l.outer)).toHaveLength(1);
  });
});

describe('sketched bend and hem', () => {
  it('bends a plate along a sketched line, keeping its flat size', async () => {
    const b = new ModelBuilder();
    let res = await b.build(req(plate()));
    const top = res.faces.find((f) => f.name === 'B1:cap1')!;
    const line = sketch('S2', [{ id: 'p', t: 'point', x: 0, y: 40 }, { id: 'q', t: 'point', x: 100, y: 40 }, { id: 'l', t: 'line', a: 'p', b: 'q' }],
      { kind: 'face', face: { name: top.name, sig: { type: 'plane', c: top.center, n: top.normal, area: top.area } } });
    const bend: SketchedBendFeature = newSketchedBend('SB', 'SB', 'S2');
    res = await b.build(req([...plate(), line, bend]));
    ok(res);
    expect(volume(b)).toBeCloseTo(6000 * T, 3);
    const flat = b.flatPattern().pattern!;
    expect(flatSize(flat)).toEqual([expect.closeTo(100, 6), expect.closeTo(60, 6)]);
    expect(flat.bends).toHaveLength(1);
    expect(flat.bends[0].a[1]).toBeCloseTo(40, 6);
    // The side left of the line (drawn either way) stays on the plane, the other stands up 90 degrees.
    expect(res.bbox!.max[1]).toBeCloseTo(60, 6);
    expect(res.bbox!.min[1]).toBeGreaterThan(30);
    expect(res.bbox!.max[2]).toBeCloseTo(T + R + (40 - BA90 / 2), 6);
    expect(res.faces.map((f) => f.name)).toEqual(expect.arrayContaining(['SB:bend:in', 'SB:bend:out']));
    // The other side fixed.
    res = await b.build(req([...plate(), line, { ...bend, flipFixed: true }]));
    ok(res);
    expect(res.bbox!.min[1]).toBeCloseTo(0, 6);
    expect(res.bbox!.max[1]).toBeLessThan(50);
    expect(res.bbox!.max[2]).toBeCloseTo(T + R + (20 - BA90 / 2), 6);
  });

  it('folds a closed and an open hem back over the sheet', async () => {
    const b = new ModelBuilder();
    const e = await plateEdge(b);
    const hem: HemFeature = { ...newHem('H1', 'H1', 10, 1), edges: [edgeRef(e)] };
    let res = await b.build(req([...plate(), hem]));
    ok(res);
    expect(res.bbox!.max[1]).toBeCloseTo(60, 6);
    expect(res.bbox!.max[2]).toBeCloseTo(2 * T + 0.02 * T, 6);
    res = await b.build(req([...plate(), { ...hem, kind: 'open' as const }]));
    ok(res);
    expect(res.bbox!.max[2]).toBeCloseTo(2 * T + 1, 6);
    const r = 0.5;
    const flat = b.flatPattern().pattern!;
    expect(flatSize(flat)[1]).toBeCloseTo(60 - (r + T) + Math.PI * (r + K * T) + (10 - (r + T)), 6);
  });

  it('flattens a hem in a part that uses a bend deduction', async () => {
    const b = new ModelBuilder();
    const e = await plateEdge(b);
    const sheet = plate();
    Object.assign((sheet[1] as BaseFlangeFeature).sm, { allowance: 'bendDeduction', allowanceValue: 3 });
    const res = await b.build(req([...sheet, { ...newHem('H1', 'H1', 10, 1), edges: [edgeRef(e)], kind: 'open' as const }]));
    ok(res);
    // The deduction's 90 degree allowance (2 * (R + T) - 3) gives the K-factor for the hem's radius.
    const r = 0.5, k = ((2 * (R + T) - 3) / (Math.PI / 2) - R) / T;
    expect(flatSize(b.flatPattern().pattern!)[1]).toBeCloseTo(60 - (r + T) + Math.PI * (r + k * T) + (10 - (r + T)), 6);
  });
});

describe('combinations', () => {
  const faceRef = (f: FaceInfo) => ({ name: f.name, sig: { type: 'plane', c: f.center, n: f.normal, area: f.area } });

  it('adds a tab on the sheet and flattens it with the plate', async () => {
    const b = new ModelBuilder();
    const res = await b.build(req(plate()));
    const top = res.faces.find((f) => f.name === 'B1:cap1')!;
    // A 20 x 10 tab sticking out of the plate's top edge (sketch y is world y on this face).
    const tab = sketch('S2', rect(40, 55, 60, 70, 'tb'), { kind: 'face', face: faceRef(top) });
    const r2 = await b.build(req([...plate(), tab, base('T1', 'S2')]));
    ok(r2);
    expect(volume(b)).toBeCloseTo((6000 + 20 * 10) * T, 3);
    expect(size(r2)).toEqual([expect.closeTo(100, 6), expect.closeTo(70, 6), expect.closeTo(T, 6)]);
    expect(flatSize(b.flatPattern().pattern!)).toEqual([expect.closeTo(100, 6), expect.closeTo(70, 6)]);
    // The tab's edge takes a flange.
    const tabEdge = r2.edges.find((e) => e.type === 'line' && Math.abs(e.mid[1] - 70) < 1e-6 && Math.abs(e.mid[2] - T) < 1e-6)!;
    const r3 = await b.build(req([...plate(), tab, base('T1', 'S2'), flange('F1', [edgeRef(tabEdge)])]));
    ok(r3);
    expect(b.flatPattern().pattern!.bends).toHaveLength(1);
    // Off the sheet, or open: errors.
    const far = sketch('S2', rect(200, 200, 210, 210, 'tf'), { kind: 'face', face: faceRef(top) });
    expect((await b.build(req([...plate(), far, base('T1', 'S2')]))).status[3].error).toMatch(/touch/);
    const open = sketch('S2', chain([[10, 10], [20, 10]], 'to'), { kind: 'face', face: faceRef(top) });
    expect((await b.build(req([...plate(), open, base('T1', 'S2')]))).status[3].error).toMatch(/tab/);
  });

  it('flanges the end of a flange, and carries flanges with a sketched bend', async () => {
    const b = new ModelBuilder();
    const e = await plateEdge(b);
    const f1 = flange('F1', [edgeRef(e)], { position: 'bendOutside', lengthRef: 'tangent' });
    let res = await b.build(req([...plate(), f1]));
    // The top edge of the flange (on its inner face) gets a flange of its own, back over the plate.
    const end = res.faces.find((f) => f.name === 'F1:e0:end')!;
    const inner = res.faces.find((f) => f.name === 'F1:e0:flange:in')!;
    const top = res.edges.find((x) => x.faces.includes(res.faces.indexOf(end)) && x.faces.includes(res.faces.indexOf(inner)))!;
    const f2 = flange('F2', [edgeRef(top)], { position: 'bendOutside', lengthRef: 'tangent', length: 10 });
    res = await b.build(req([...plate(), f1, f2]));
    ok(res);
    let flat = b.flatPattern().pattern!;
    expect(flatSize(flat)[1]).toBeCloseTo(60 + BA90 + 20 + BA90 + 10, 6);
    expect(flat.notes).toEqual([]);
    // A sketched bend across the plate moves the side with the flanges.
    const plateTop = res.faces.find((f) => f.name === 'B1:cap1')!;
    const line = sketch('S3', [{ id: 'p', t: 'point', x: 0, y: 20 }, { id: 'q', t: 'point', x: 100, y: 20 }, { id: 'l', t: 'line', a: 'p', b: 'q' }], { kind: 'face', face: faceRef(plateTop) });
    res = await b.build(req([...plate(), f1, f2, line, { ...newSketchedBend('SB', 'SB', 'S3'), flipFixed: true }]));
    ok(res);
    flat = b.flatPattern().pattern!;
    expect(flatSize(flat)[1]).toBeCloseTo(60 + BA90 + 20 + BA90 + 10, 6);
    expect(flat.bends).toHaveLength(3);
    expect(flat.notes).toEqual([]);
    // The y < 20 side stays; the rest stands up about the bend axis (y = 20 - BA/2, z = T + R), turning the
    // flanges' top (z = T + R + 20 + R + T before) toward -y.
    expect(res.bbox!.min[2]).toBeCloseTo(0, 6);
    expect(res.bbox!.min[1]).toBeCloseTo(20 - BA90 / 2 + (T + R) - (T + R + 20 + R + T), 6);
    // Highest: F1's bend, which reached R + T past y = 60.
    expect(res.bbox!.max[2]).toBeCloseTo(T + R + (60 + R + T) - (20 - BA90 / 2) - BA90, 6);
  });

  it('says when a sketched bend would fold the sheet into itself', async () => {
    const b = new ModelBuilder();
    const e = await plateEdge(b);
    const f1 = flange('F1', [edgeRef(e)]);
    const res = await b.build(req([...plate(), f1]));
    const plateTop = res.faces.find((f) => f.name === 'B1:cap1')!;
    // Folding the 20 wide side with the flange back over the plate drives the flange through it.
    const line = sketch('S3', [{ id: 'p', t: 'point', x: 0, y: 40 }, { id: 'q', t: 'point', x: 100, y: 40 }, { id: 'l', t: 'line', a: 'p', b: 'q' }], { kind: 'face', face: faceRef(plateTop) });
    const bend = { ...newSketchedBend('SB', 'SB', 'S3'), flipFixed: true };
    expect((await b.build(req([...plate(), f1, line, { ...bend, angle: 170 }]))).status[4].error).toMatch(/folds the sheet into itself/);
    ok(await b.build(req([...plate(), f1, line, { ...bend, angle: 90 }])));
  });

  it('asks for offsets when two sloped flanges in one feature meet at a corner', async () => {
    const b = new ModelBuilder();
    const res = await b.build(req(plate()));
    const top = res.faces.find((f) => f.name === 'B1:cap1')!;
    const e1 = edgesOn(res, top, [1, 0, 0]).find((e) => Math.abs(e.mid[1] - 60) < 1e-6)!;
    const e2 = edgesOn(res, top, [0, 1, 0]).find((e) => Math.abs(e.mid[0] - 100) < 1e-6)!;
    const f = flange('F1', [edgeRef(e1), edgeRef(e2)], { angle: 135 });
    expect((await b.build(req([...plate(), f]))).status[2].error).toMatch(/offsets/);
    ok(await b.build(req([...plate(), { ...f, offset1: 16, offset2: 16 }])));
  });

  it('flanges two edges meeting at a corner one after the other', async () => {
    const b = new ModelBuilder();
    let res = await b.build(req(plate()));
    const top = res.faces.find((f) => f.name === 'B1:cap1')!;
    const e1 = edgesOn(res, top, [1, 0, 0]).find((e) => Math.abs(e.mid[1] - 60) < 1e-6)!;
    const f1 = flange('F1', [edgeRef(e1)]);
    res = await b.build(req([...plate(), f1]));
    const top2 = res.faces.find((f) => f.name === 'B1:cap1')!;
    const e2 = edgesOn(res, top2, [0, 1, 0]).find((e) => Math.abs(e.mid[0] - 100) < 1e-6)!;
    res = await b.build(req([...plate(), f1, flange('F2', [edgeRef(e2)])]));
    ok(res);
    expect(size(res)).toEqual([expect.closeTo(100, 6), expect.closeTo(60, 6), expect.closeTo(20, 6)]);
    const flat = b.flatPattern().pattern!;
    expect(flat.bends).toHaveLength(2);
    expect(flat.notes).toEqual([]);
  });

  it('patterns, mirrors and fillets the folded body like any body', async () => {
    const b = new ModelBuilder();
    const e = await plateEdge(b);
    const res = await b.build(req([...plate(), flange('F1', [edgeRef(e)])]));
    const out = res.faces.find((f) => f.name === 'F1:e0:flange:out')!;
    const hole = sketch('S2', circle(20, -10, 2), { kind: 'face', face: faceRef(out) });
    const cutHole = extrude('C1', 'S2', 1, { cut: true, end: 'throughAll' });
    const pattern = { id: 'LP', name: 'LP', type: 'linearPattern' as const, seeds: ['C1'], dir1: { ref: { kind: 'base' as const, axis: 'x' as const }, spacing: 20, count: 3, flip: false }, dir2: null };
    const r2 = await b.build(req([...plate(), flange('F1', [edgeRef(e)]), hole, cutHole, pattern]));
    ok(r2);
    const flat = b.flatPattern().pattern!;
    expect(flat.loops.filter((l) => !l.outer)).toHaveLength(3);
    expect(flat.notes).toEqual([]);
    // A sheet metal feature is not a seed: copies of its wall alone would sit in the sheet without their bend cut.
    const flangePattern = { ...pattern, seeds: ['F1'] };
    expect((await b.build(req([...plate(), flange('F1', [edgeRef(e)]), flangePattern]))).status[3].error).toMatch(/cannot be patterned/);
    const mirror = { id: 'M', name: 'M', type: 'mirror' as const, seeds: [], plane: { kind: 'base' as const, plane: 'top' as const } };
    const r3 = await b.build(req([...plate(), flange('F1', [edgeRef(e)]), hole, cutHole, pattern, mirror]));
    ok(r3);
    expect(r3.bbox!.min[1]).toBeCloseTo(-60, 6);
  });
});

describe('flat pattern export', () => {
  it('writes the outline, cuts and bend lines on their layers', async () => {
    const b = new ModelBuilder();
    const e = await plateEdge(b);
    await b.build(req([sketch('S1', [...rect(0, 0, 100, 60), ...circle(30, 30, 5)]), base('B1', 'S1'), flange('F1', [edgeRef(e)])]));
    const flat = b.flatPattern().pattern!;
    const dxf = flatPatternDxf(flat);
    const ents = parseDxfEntities(dxf);
    const layers = (l: string) => ents.filter((x) => x.layer === l);
    expect(layers('OUTLINE').length).toBe(4);
    expect(layers('OUTLINE').every((x) => x.type === 'LINE')).toBe(true);
    expect(layers('CUTS').map((x) => x.type)).toEqual(['CIRCLE']);
    expect(Number(layers('CUTS')[0].values.get(40)![0])).toBeCloseTo(5, 9);
    expect(layers('BEND_UP').map((x) => x.type)).toEqual(['LINE']);
    expect(layers('BEND_NOTES')[0].values.get(1)![0]).toBe('UP 90%%d R 1');
    // The outline lines join into one closed loop of the flat size.
    const xs = layers('OUTLINE').flatMap((x) => [Number(x.values.get(10)![0]), Number(x.values.get(11)![0])]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100, 6);
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
  });

  it('says what it leaves out', async () => {
    const b = new ModelBuilder();
    const res = await b.build(req(plate()));
    const top = res.faces.find((f) => f.name === 'B1:cap1')!;
    // A boss on the sheet is not sheet metal.
    const boss = sketch('S2', rect(10, 10, 20, 20), { kind: 'face', face: { name: top.name, sig: { type: 'plane', c: top.center, n: top.normal, area: top.area } } });
    await b.build(req([...plate(), boss, extrude('E1', 'S2', 5)]));
    expect(b.flatPattern().pattern!.notes.join(' ')).toMatch(/cannot show/);
    const plain = new ModelBuilder();
    await plain.build(req([sketch('S1', rect(0, 0, 10, 10)), extrude('E1', 'S1', 5)]));
    expect(plain.flatPattern().error).toMatch(/no sheet metal/);
  });
});
