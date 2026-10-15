import { describe, it, expect } from 'vitest';
import { Matrix4, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { combDab, makeProjector, segmentLengths, falloff } from '../../src/hair/brushmath';

/** Front view (looking down -Y onto the XZ plane), 1 unit = 100 px, centre at (200, 200). */
function frontProjector() {
  const cam = new OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
  cam.position.set(0, -10, 0);
  cam.up.set(0, 0, 1);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const m = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  return makeProjector(m.elements, 400, 400);
}

const strand = (n: number, len: number) => {
  const P = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) P[i * 3 + 2] = (i / (n - 1)) * len;
  return P;
};

describe('hair brush math', () => {
  it('projects and unprojects', () => {
    const p = frontProjector();
    const out = new Float64Array(3);
    p.toScreen(1, 0, 1, out);
    expect(out[0]).toBeCloseTo(300, 3);
    expect(out[1]).toBeCloseTo(100, 3);
    const back = new Float64Array(3);
    p.fromScreen(out[0], out[1], out[2], back);
    expect(Array.from(back).map((x) => +x.toFixed(4))).toEqual([1, 0, 1]);
    const persp = new PerspectiveCamera(50, 1, 0.1, 100);
    persp.position.set(0, -10, 2);
    persp.lookAt(new Vector3(0, 0, 0));
    persp.updateMatrixWorld();
    const pp = makeProjector(new Matrix4().multiplyMatrices(persp.projectionMatrix, persp.matrixWorldInverse).elements, 400, 400);
    pp.toScreen(0.3, 0.2, 0.5, out);
    pp.fromScreen(out[0], out[1], out[2], back);
    expect(Array.from(back).map((x) => +x.toFixed(3))).toEqual([0.3, 0.2, 0.5]);
  });

  it('falloff goes from 1 at the centre to 0 at the rim', () => {
    for (const k of ['SMOOTH', 'SPHERE', 'ROOT', 'SHARP', 'LINEAR'] as const) {
      expect(falloff(0, k)).toBe(1);
      expect(falloff(1, k)).toBe(0);
      expect(falloff(0.5, k)).toBeGreaterThan(0);
    }
    expect(falloff(0.7, 'CONSTANT')).toBe(1);
  });

  it('comb drags points sideways keeping roots and lengths', () => {
    const P = strand(5, 1);
    const s = { positions: P, offsets: [0, 5] };
    const L = segmentLengths(s);
    const ch = combDab(s, frontProjector(), { x: 200, y: 150, radius: 80, strength: 1, falloff: 'CONSTANT' }, 30, 0, L);
    expect(ch).toEqual([0]);
    expect(Array.from(P.subarray(0, 3))).toEqual([0, 0, 0]);
    // the tip moved to +x, segment lengths unchanged
    expect(P[4 * 3]).toBeGreaterThan(0.05);
    const L2 = segmentLengths(s);
    for (let i = 1; i < 5; i++) expect(L2[i]).toBeCloseTo(L[i], 5);
  });
});

import { deleteHits, growShrinkDab, moveTipAndResample, newStrandShape, pinchDab, polylineLength, puffDab, resamplePolyline, rotate, rotationBetween, selectionPaintDab, slideDab, smoothDab, snakeHookDab, symmetryPasses, thinRoots, trimPolyline, mirroredProjector } from '../../src/hair/brushmath';
import { appendCurves, copyRanges, curveCount, curveLengths, getAttr, keepCurves, keepPoints, newHairCurves, pointCount, pointSelection, curveSelection, radii, reverseCurves, selectedRanges, setCurves, setSelection, setSelectionDomain, subdivideSelected, arcLengths, DEFAULT_RADIUS } from '../../src/hair/data';
import { growPoints, linkedPoints, selectEnds, randomSelect, applyAction, combine } from '../../src/hair/select';
import { hairToComponent, componentToHair } from '../../src/hair/component';
import { strandTubes } from '../../src/hair/render';
import { Surface } from '../../src/hair/surface';
import { growStrands, noise3 } from '../../src/hair/generate';
import { deleteKeys, deleteStrands, editedFromStrands, mirrorStrands, rekey, removeDoubles, selectedStrands, subdivideKeys, unifyLength } from '../../src/hair/particle/keys';
import { resampleKeys } from '../../src/physics/particles';
import { cube, plane } from '../../src/mesh/primitives';
import type { EvalMesh } from '../../src/eval/types';

const pts = (...p: number[][]) => Float32Array.from(p.flat());
const r3 = (a: ArrayLike<number>) => Array.from(a, (x) => Math.round(x * 1000) / 1000);

function twoCurves() {
  const hc = newHairCurves('T');
  setCurves(hc, [
    { points: pts([0, 0, 0], [0, 0, 1], [0, 0, 2]), radius: 0.1 },
    { points: pts([1, 0, 0], [1, 0, 1]), radius: 0.2, uv: [0.5, 0.25] },
  ]);
  return hc;
}

function evalMeshOf(p: { positions: Float32Array; offsets: Uint32Array; indices: Uint32Array; uvs: Float32Array }): EvalMesh {
  return { positions: p.positions, offsets: p.offsets, indices: p.indices, uvs: p.uvs, normals: new Float32Array(p.indices.length * 3) };
}

describe('hair curves data', () => {
  it('builds curves with radius and surface UVs', () => {
    const hc = twoCurves();
    expect(curveCount(hc)).toBe(2);
    expect(pointCount(hc)).toBe(5);
    expect(Array.from(hc.curve_offsets)).toEqual([0, 3, 5]);
    expect(r3(radii(hc))).toEqual([0.1, 0.1, 0.1, 0.2, 0.2]);
    expect(Array.from(getAttr(hc, 'surface_uv_coordinate')!.data)).toEqual([0, 0, 0.5, 0.25]);
    expect(Array.from(curveLengths(hc))).toEqual([2, 1]);
    expect(Array.from(arcLengths(hc.positions, hc.curve_offsets))).toEqual([0, 1, 2, 0, 1]);
  });

  it('appends with default values on existing attributes and keeps the selection', () => {
    const hc = twoCurves();
    setSelection(hc, Float32Array.from([1, 0, 0, 0, 1]), 'POINT');
    appendCurves(hc, [{ points: pts([2, 0, 0], [2, 0, 1]) }]);
    expect(curveCount(hc)).toBe(3);
    expect(Array.from(pointSelection(hc))).toEqual([1, 0, 0, 0, 1, 1, 1]);
    expect(radii(hc)[5]).toBeCloseTo(DEFAULT_RADIUS, 6);
    appendCurves(hc, [{ points: pts([3, 0, 0], [3, 0, 1]) }], false);
    expect(Array.from(pointSelection(hc)).slice(-2)).toEqual([0, 0]);
  });

  it('keeps points and curves with their attributes', () => {
    const hc = twoCurves();
    keepPoints(hc, [1, 0, 1, 1, 1]);
    expect(Array.from(hc.curve_offsets)).toEqual([0, 2, 4]);
    expect(r3(hc.positions.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 2]);
    keepCurves(hc, [0, 1]);
    expect(curveCount(hc)).toBe(1);
    expect(r3(radii(hc))).toEqual([0.2, 0.2]);
    expect(Array.from(getAttr(hc, 'surface_uv_coordinate')!.data)).toEqual([0.5, 0.25]);
  });

  it('removes curves that lose all their points', () => {
    const hc = twoCurves();
    keepPoints(hc, [1, 1, 1, 0, 0]);
    expect(curveCount(hc)).toBe(1);
  });

  it('copies point runs into new curves', () => {
    const hc = twoCurves();
    const runs = selectedRanges(hc, [0, 1, 1, 1, 0]);
    expect(runs).toEqual([
      [0, 1, 2],
      [1, 3, 3],
    ]);
    copyRanges(hc, runs);
    expect(Array.from(hc.curve_offsets)).toEqual([0, 3, 5, 7, 8]);
    expect(r3(radii(hc).slice(5))).toEqual([0.1, 0.1, 0.2]);
  });

  it('reverses curves and subdivides selected segments', () => {
    const hc = twoCurves();
    reverseCurves(hc, [1, 0]);
    expect(r3(hc.positions.slice(0, 9))).toEqual([0, 0, 2, 0, 0, 1, 0, 0, 0]);
    expect(subdivideSelected(hc, [1, 1, 0, 1, 1], 1)).toBe(true);
    expect(Array.from(hc.curve_offsets)).toEqual([0, 4, 7]);
    expect(r3(hc.positions.slice(3, 6))).toEqual([0, 0, 1.5]);
    expect(r3(hc.positions.slice(15, 18))).toEqual([1, 0, 0.5]);
  });

  it('converts the selection between points and curves', () => {
    const hc = twoCurves();
    setSelection(hc, Float32Array.from([0, 1, 0, 0, 0]), 'POINT');
    expect(Array.from(curveSelection(hc))).toEqual([1, 0]);
    setSelectionDomain(hc, 'CURVE');
    expect(hc.selection_domain).toBe('CURVE');
    expect(Array.from(pointSelection(hc))).toEqual([1, 1, 1, 0, 0]);
  });

  it('round-trips through the geometry nodes curves component', () => {
    const hc = twoCurves();
    hc.attributes.push({ name: 'cyclic', domain: 'CURVE', data_type: 'BOOLEAN', data: Uint8Array.from([0, 1]) });
    const c = hairToComponent(hc);
    expect(c.curveCount).toBe(2);
    expect(Array.from(c.cyclic)).toEqual([0, 1]);
    expect(c.attrs.get('radius')!.domain).toBe('POINT');
    expect(hairToComponent(hc)).toBe(c);
    const back = newHairCurves('B');
    componentToHair(c, back);
    expect(Array.from(back.curve_offsets)).toEqual([0, 3, 5]);
    expect(Array.from(getAttr(back, 'cyclic')!.data)).toEqual([0, 1]);
    expect(r3(radii(back))).toEqual(r3(radii(hc)));
  });
});

describe('hair selection logic', () => {
  const offs = [0, 4, 7];
  it('grows and shrinks along curves', () => {
    expect(Array.from(growPoints([0, 1, 0, 0, 0, 0, 1], offs, true))).toEqual([1, 1, 1, 0, 0, 1, 1]);
    expect(Array.from(growPoints([1, 1, 1, 0, 1, 1, 1], offs, false))).toEqual([1, 1, 0, 0, 1, 1, 1]);
  });
  it('selects ends, linked curves, random and actions', () => {
    expect(Array.from(selectEnds(offs, 7, 1, 1))).toEqual([1, 0, 0, 1, 1, 0, 1]);
    expect(Array.from(linkedPoints([0, 0, 1, 0, 0, 0, 0], offs))).toEqual([1, 1, 1, 1, 0, 0, 0]);
    const r = randomSelect(new Float32Array(1000), 0.3, 4, true);
    const n = r.reduce((a, b) => a + b, 0);
    expect(n).toBeGreaterThan(220);
    expect(n).toBeLessThan(380);
    expect(Array.from(applyAction(Float32Array.from([1, 0]), 'INVERT'))).toEqual([0, 1]);
    expect(Array.from(applyAction(Float32Array.from([1, 0]), 'TOGGLE'))).toEqual([0, 0]);
    expect([combine(1, 1, 'SUB'), combine(0, 1, 'ADD'), combine(1, 1, 'XOR'), combine(1, 0, 'AND')]).toEqual([0, 1, 0, 0]);
  });
});

describe('hair brushes', () => {
  const p = frontProjector();
  const one = () => ({ positions: strand(5, 1), offsets: [0, 5] });

  it('snake hook drags the tip and the strand follows', () => {
    const s = one();
    const ch = snakeHookDab(s, p, { x: 200, y: 100, radius: 30, strength: 1, falloff: 'CONSTANT' }, 50, 0);
    expect(ch).toEqual([0]);
    expect(s.positions[12]).toBeCloseTo(0.5, 3);
    expect(Array.from(s.positions.subarray(0, 3))).toEqual([0, 0, 0]);
  });

  it('grows and shrinks strands, uniformly or along the tip', () => {
    const s = one();
    growShrinkDab(s, p, { x: 200, y: 150, radius: 100, strength: 1, falloff: 'CONSTANT' }, true, { rate: 0.5 });
    expect(polylineLength(s.positions)).toBeCloseTo(1.5, 4);
    const u = one();
    growShrinkDab(u, p, { x: 200, y: 150, radius: 100, strength: 1, falloff: 'CONSTANT' }, false, { uniform: true, rate: 1, minLength: 0.8 });
    expect(polylineLength(u.positions)).toBeCloseTo(0.8, 4);
  });

  it('pinches toward the brush centre keeping lengths', () => {
    const s = { positions: Float32Array.from([...strand(3, 1), ...Array.from(strand(3, 1)).map((v, i) => (i % 3 === 0 ? v + 0.5 : v))]), offsets: [0, 3, 6] };
    const L = segmentLengths(s);
    pinchDab(s, p, { x: 200, y: 100, radius: 100, strength: 1, falloff: 'CONSTANT' }, false, L);
    expect(s.positions[3 * 5]).toBeLessThan(0.5);
    expect(segmentLengths(s)[5]).toBeCloseTo(L[5], 5);
  });

  it('puffs strands up along their root normal (and lays them down inverted)', () => {
    const s = { positions: pts([0, 0, 0], [1, 0, 0], [2, 0, 0]), offsets: [0, 3] };
    const L = segmentLengths(s);
    for (let i = 0; i < 30; i++) puffDab(s, p, { x: 300, y: 200, radius: 200, strength: 1, falloff: 'CONSTANT' }, [0, 0, 1], L);
    expect(s.positions[8]).toBeGreaterThan(1.5);
    const flat = { positions: pts([0, 0, 0], [0.3, 0, 1], [0.6, 0, 2]), offsets: [0, 3] };
    const L2 = segmentLengths(flat);
    for (let i = 0; i < 30; i++) puffDab(flat, p, { x: 200, y: 100, radius: 300, strength: 1, falloff: 'CONSTANT' }, [0, 0, 1], L2, true);
    expect(flat.positions[8]).toBeLessThan(0.5);
  });

  it('smooths kinks', () => {
    const s = { positions: pts([0, 0, 0], [0.5, 0, 1], [0, 0, 2]), offsets: [0, 3] };
    smoothDab(s, p, { x: 250, y: 100, radius: 100, strength: 1, falloff: 'CONSTANT' });
    expect(s.positions[3]).toBeCloseTo(0.25, 4);
  });

  it('slides strands with their roots snapped', () => {
    const s = one();
    slideDab(s, p, { x: 200, y: 200, radius: 20, strength: 1, falloff: 'CONSTANT' }, 100, 0, (x, y) => [x, y, 0]);
    expect(r3(s.positions.subarray(0, 3))).toEqual([1, 0, 0]);
    expect(s.positions[12]).toBeCloseTo(1, 4);
  });

  it('deletes strands crossed by the brush, respecting the mask', () => {
    const s = { positions: Float32Array.from([...strand(2, 1), ...Array.from(strand(2, 1)).map((v, i) => (i % 3 === 0 ? v + 1 : v))]), offsets: [0, 2, 4] };
    expect(Array.from(deleteHits(s, p, { x: 300, y: 150, radius: 10, strength: 1 }))).toEqual([0, 1]);
    expect(Array.from(deleteHits(s, p, { x: 300, y: 150, radius: 10, strength: 1, mask: [1, 1, 0, 0] }))).toEqual([0, 0]);
  });

  it('paints selection per point or per strand', () => {
    const s = one();
    const sel = new Float32Array(5);
    selectionPaintDab(s, p, { x: 200, y: 200, radius: 30, strength: 1, falloff: 'CONSTANT' }, sel, 1, false);
    expect(Array.from(sel)).toEqual([1, 1, 0, 0, 0]);
    const cs = new Float32Array(1);
    selectionPaintDab(s, p, { x: 200, y: 200, radius: 30, strength: 1, falloff: 'CONSTANT' }, cs, 1, true);
    expect(cs[0]).toBe(1);
  });

  it('mirrors brushes for symmetry passes', () => {
    expect(symmetryPasses(true, false, false)).toEqual([
      [false, false, false],
      [true, false, false],
    ]);
    expect(symmetryPasses(true, true, true).length).toBe(8);
    const out = new Float64Array(3);
    mirroredProjector(p, [true, false, false]).toScreen(1, 0, 0, out);
    expect(out[0]).toBeCloseTo(100, 3);
  });

  it('thins roots to a minimum distance', () => {
    const roots = Float32Array.from([0, 0, 0, 0.01, 0, 0, 0.02, 0, 0, 1, 0, 0]);
    const kill = thinRoots(roots, [1, 1, 1, 1], 0.05, () => 0.5);
    expect(kill.reduce((a, b) => a + b, 0)).toBe(2);
    expect(kill[3]).toBe(0);
  });

  it('shapes new strands straight or from neighbours', () => {
    const straight = newStrandShape([0, 0, 0], [0, 0, 1], { length: 2, points: 3 });
    expect(r3(straight)).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 2]);
    const bent = newStrandShape([5, 0, 0], [0, 0, 1], { length: 1, points: 3, neighbours: [{ root: [0, 0, 0], normal: [0, 0, 1], points: pts([0, 0, 0], [0, 0, 1], [1, 0, 1]), weight: 1 }], interpolateLength: true, interpolateShape: true, interpolatePointCount: true });
    expect(r3(bent)).toEqual([5, 0, 0, 5, 0, 1, 6, 0, 1]);
    const q = rotationBetween([0, 0, 1], [1, 0, 0]);
    expect(r3(rotate(q, 0, 0, 1))).toEqual([1, 0, 0]);
  });

  it('resamples, trims and extends polylines', () => {
    expect(r3(resamplePolyline(pts([0, 0, 0], [0, 0, 1], [0, 0, 3]), 4))).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3]);
    expect(r3(trimPolyline(pts([0, 0, 0], [0, 0, 1], [0, 0, 3]), 2, 3))).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 2]);
    const P = pts([0, 0, 0], [0, 0, 1], [0, 0, 2]);
    moveTipAndResample(P, 0, 3, [2, 0, 2]);
    // the old tip stays on the path: the strand bends and grows by the pull
    expect(r3(P)).toEqual([0, 0, 0, 0, 0, 2, 2, 0, 2]);
  });
});

describe('hair surface and generation', () => {
  const plane2 = () => evalMeshOf(plane(2));
  it('finds closest points, ray hits and UV positions', () => {
    const s = Surface.of(plane2());
    const h = s.closest(new Vector3(0.2, 0.3, 1))!;
    expect(r3(h.point.toArray())).toEqual([0.2, 0.3, 0]);
    expect(Math.abs(h.normal.z)).toBeCloseTo(1, 4);
    const r = s.raycast(new Vector3(0.5, -0.5, 3), new Vector3(0, 0, -1))!;
    expect(r3(r.point.toArray())).toEqual([0.5, -0.5, 0]);
    expect(h.uv).not.toBeNull();
    const back = s.lookupUV(h.uv!)!;
    expect(back.point.distanceTo(h.point)).toBeLessThan(1e-4);
    expect(s.area).toBeCloseTo(4, 4);
  });

  it('grows evenly spread strands along the normal', () => {
    const s = Surface.of(evalMeshOf(cube(2)));
    const list = growStrands(s, { count: 200, length: 0.5, radius: 0.01, points: 4, seed: 1 });
    expect(list.length).toBeGreaterThan(150);
    for (const c of list.slice(0, 20)) expect(polylineLength(c.points)).toBeCloseTo(0.5, 3);
    expect(Math.abs(noise3(0.3, 1.2, 4.5, 2))).toBeLessThanOrEqual(1);
  });

  it('builds tube geometry around strands', () => {
    const t = strandTubes([{ points: pts([0, 0, 0], [0, 0, 1], [0, 0, 2]) }], 0.1, 3);
    expect(t.positions.length / 3).toBe(9);
    expect(t.offsets.length - 1).toBe(6);
    for (let i = 0; i < 9; i++) expect(Math.hypot(t.positions[i * 3], t.positions[i * 3 + 1])).toBeCloseTo(0.1, 4);
    const ribbon = strandTubes([{ points: pts([0, 0, 0], [1, 0, 0]) }], [0.2, 0.1], 2);
    expect(ribbon.offsets.length - 1).toBe(1);
  });
});

describe('particle edit keys', () => {
  const ed0 = () => editedFromStrands(Float32Array.from([0, 0, 0, 0, 0, 1, 0, 0, 2, 1, 0, 0, 1, 0, 1, 1, 0, 2]), 3, 2);

  it('rekeys, subdivides and unifies lengths', () => {
    const ed = ed0();
    const r = rekey(ed, [1, 0], 5);
    expect(Array.from(r.key_offsets)).toEqual([0, 5, 8]);
    expect(r3(r.co.slice(3, 6))).toEqual([0, 0, 0.5]);
    const s = subdivideKeys({ ...ed, select: Uint8Array.from([1, 1, 0, 0, 0, 0]) });
    expect(Array.from(s.key_offsets)).toEqual([0, 4, 7]);
    const u = unifyLength({ ...ed, co: Float32Array.from([0, 0, 0, 0, 0, 1, 0, 0, 2, 1, 0, 0, 1, 0, 2, 1, 0, 4]) }, [1, 1]);
    expect(u.co[17]).toBeCloseTo(3, 4);
    expect(u.co[8]).toBeCloseTo(3, 4);
  });

  it('mirrors, removes doubles and deletes', () => {
    const ed = ed0();
    const m = mirrorStrands(ed, [0, 1]);
    expect(m.key_offsets.length - 1).toBe(3);
    expect(m.co[18]).toBe(-1);
    const dbl = removeDoubles(editedFromStrands(Float32Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0.00001, 0, 0, 1]), 2, 2), 0.001, null);
    expect(dbl.removed).toBe(1);
    expect(deleteStrands(ed, [1, 0]).key_offsets.length - 1).toBe(1);
    const k = deleteKeys(ed, [0, 1, 0, 0, 1, 1]);
    expect(Array.from(k.key_offsets)).toEqual([0, 2]);
    expect(Array.from(selectedStrands({ ...ed, select: Uint8Array.from([0, 0, 0, 0, 1, 0]) }))).toEqual([0, 1]);
  });

  it('resamples keys smoothly through the key positions', () => {
    const out = new Float32Array(5 * 3);
    resampleKeys(Float32Array.from([0, 0, 0, 0, 0, 1, 0, 0, 2]), 0, 3, 5, out, 0);
    expect(r3(out)).toEqual([0, 0, 0, 0, 0, 0.5, 0, 0, 1, 0, 0, 1.5, 0, 0, 2]);
  });
});
