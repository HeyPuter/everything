// Hair curves data helpers: factories, attribute access, selection and topology edits (subsets,
// copies, appends). Pure functions over HairCurvesData (no app state), used by the edit and
// sculpt modes, the converters and the tests.
import { uid } from '../data/defaults';
import type { DocumentData, ObjectData } from '../data/types';
import { allocData, dataComps, type AttrArray, type DataType } from '../geonodes/types';
import type { HairAttribute, HairCurvesData, HairDomain } from './types';

/** Radius of strands without a radius attribute. */
export const DEFAULT_RADIUS = 0.005;
export const SELECTION = '.selection';
export const SURFACE_UV = 'surface_uv_coordinate';

export function newHairCurves(name = 'Curves'): HairCurvesData {
  return {
    id: uid('hc'),
    name,
    positions: new Float32Array(0),
    curve_offsets: new Uint32Array([0]),
    attributes: [],
    active_attribute: -1,
    surface: null,
    surface_uv_map: '',
    selection_domain: 'POINT',
    use_mirror_x: false,
    use_mirror_y: false,
    use_mirror_z: false,
    use_sculpt_collision: true,
    materials: [],
  };
}

export function hairOf(doc: DocumentData, ob: ObjectData | null | undefined): HairCurvesData | null {
  if (!ob || ob.type !== 'CURVES' || !ob.data) return null;
  return doc.hair_curves?.[ob.data] ?? null;
}

export const curveCount = (hc: Pick<HairCurvesData, 'curve_offsets'>) => Math.max(0, hc.curve_offsets.length - 1);
export const pointCount = (hc: Pick<HairCurvesData, 'positions'>) => hc.positions.length / 3;
export const domainSize = (hc: HairCurvesData, d: HairDomain) => (d === 'POINT' ? pointCount(hc) : curveCount(hc));

/** Curve index of every point. */
export function pointCurves(hc: Pick<HairCurvesData, 'curve_offsets' | 'positions'>): Uint32Array {
  const out = new Uint32Array(pointCount(hc));
  const o = hc.curve_offsets;
  for (let c = 0; c + 1 < o.length; c++) out.fill(c, o[c], o[c + 1]);
  return out;
}

export function getAttr(hc: HairCurvesData, name: string): HairAttribute | undefined {
  const a = hc.attributes.find((x) => x.name === name);
  if (!a) return undefined;
  return a.data.length === domainSize(hc, a.domain) * dataComps(a.data_type) ? a : undefined;
}

/** Float values of an attribute on its own domain, or `def` everywhere. */
export function floatAttr(hc: HairCurvesData, name: string, domain: HairDomain, def: number): Float32Array {
  const a = getAttr(hc, name);
  const n = domainSize(hc, domain);
  if (a && a.domain === domain && dataComps(a.data_type) === 1) return a.data instanceof Float32Array ? a.data : Float32Array.from(a.data);
  if (a && a.domain !== domain && dataComps(a.data_type) === 1) return adaptDomain(hc, Float32Array.from(a.data), a.domain, domain);
  return new Float32Array(n).fill(def);
}

/** Move single-component values between the point and curve domains (curve → point repeats, point → curve averages). */
export function adaptDomain(hc: HairCurvesData, v: Float32Array, from: HairDomain, to: HairDomain): Float32Array {
  if (from === to) return v;
  const o = hc.curve_offsets;
  const nc = curveCount(hc);
  if (from === 'CURVE') {
    const out = new Float32Array(pointCount(hc));
    for (let c = 0; c < nc; c++) out.fill(v[c], o[c], o[c + 1]);
    return out;
  }
  const out = new Float32Array(nc);
  for (let c = 0; c < nc; c++) {
    let s = 0;
    for (let i = o[c]; i < o[c + 1]; i++) s += v[i];
    out[c] = o[c + 1] > o[c] ? s / (o[c + 1] - o[c]) : 0;
  }
  return out;
}

/** Set (replace) an attribute's data, creating it when missing. */
export function setAttr(hc: HairCurvesData, name: string, domain: HairDomain, type: DataType, data: AttrArray) {
  const i = hc.attributes.findIndex((x) => x.name === name);
  const a: HairAttribute = { name, domain, data_type: type, data };
  if (i < 0) hc.attributes = [...hc.attributes, a];
  else hc.attributes = hc.attributes.map((x, k) => (k === i ? a : x));
}

export function removeAttr(hc: HairCurvesData, name: string) {
  const i = hc.attributes.findIndex((x) => x.name === name);
  if (i < 0) return false;
  hc.attributes = hc.attributes.filter((_, k) => k !== i);
  if ((hc.active_attribute ?? -1) >= hc.attributes.length) hc.active_attribute = hc.attributes.length - 1;
  return true;
}

export function radii(hc: HairCurvesData): Float32Array {
  return floatAttr(hc, 'radius', 'POINT', DEFAULT_RADIUS);
}

// ---------------------------------------------------------------------------
// Selection (soft: 0..1, stored in the selection domain; missing means all selected)

export function selectionOf(hc: HairCurvesData, domain: HairDomain = hc.selection_domain): Float32Array {
  return floatAttr(hc, SELECTION, domain, 1);
}

/** Selection of every point (curve selection spread to its points). */
export function pointSelection(hc: HairCurvesData): Float32Array {
  return selectionOf(hc, 'POINT');
}

export function curveSelection(hc: HairCurvesData): Float32Array {
  const a = getAttr(hc, SELECTION);
  if (!a) return new Float32Array(curveCount(hc)).fill(1);
  if (a.domain === 'CURVE') return Float32Array.from(a.data);
  // a curve counts as selected when any of its points is
  const o = hc.curve_offsets;
  const out = new Float32Array(curveCount(hc));
  for (let c = 0; c < out.length; c++) for (let i = o[c]; i < o[c + 1]; i++) out[c] = Math.max(out[c], a.data[i]);
  return out;
}

export function setSelection(hc: HairCurvesData, values: Float32Array, domain: HairDomain = hc.selection_domain) {
  setAttr(hc, SELECTION, domain, 'FLOAT', values);
}

/** Change the selection domain, converting the stored selection. */
export function setSelectionDomain(hc: HairCurvesData, domain: HairDomain) {
  if (hc.selection_domain === domain) return;
  const a = getAttr(hc, SELECTION);
  if (a && a.domain !== domain) setSelection(hc, domain === 'CURVE' ? curveSelection(hc) : adaptDomain(hc, Float32Array.from(a.data), a.domain, 'POINT'), domain);
  hc.selection_domain = domain;
}

// ---------------------------------------------------------------------------
// Building and topology edits

export interface CurveInput {
  points: ArrayLike<number>; // xyz
  radius?: number | ArrayLike<number>;
  uv?: [number, number];
}

/** Replace the curves with new ones (all attributes dropped except radius / surface UVs given here). */
export function setCurves(hc: HairCurvesData, list: CurveInput[]) {
  hc.positions = new Float32Array(0);
  hc.curve_offsets = new Uint32Array([0]);
  hc.attributes = [];
  hc.active_attribute = -1;
  appendCurves(hc, list);
}

/** Append curves. Existing attributes get default values on the new elements. */
export function appendCurves(hc: HairCurvesData, list: CurveInput[], selected = true): void {
  if (!list.length) return;
  const n0 = pointCount(hc),
    c0 = curveCount(hc);
  let add = 0;
  for (const c of list) add += c.points.length / 3;
  const pos = new Float32Array((n0 + add) * 3);
  pos.set(hc.positions);
  const offs = new Uint32Array(c0 + list.length + 1);
  offs.set(hc.curve_offsets.subarray(0, c0 + 1));
  let o = n0;
  list.forEach((c, k) => {
    pos.set(c.points, o * 3);
    o += c.points.length / 3;
    offs[c0 + k + 1] = o;
  });
  const hadRadius = !!getAttr(hc, 'radius');
  const anyRadius = list.some((c) => c.radius !== undefined);
  const hadUV = !!getAttr(hc, SURFACE_UV);
  const anyUV = list.some((c) => !!c.uv);
  const oldR = hadRadius || anyRadius ? radii(hc) : null;
  const oldUV = hadUV ? getAttr(hc, SURFACE_UV)!.data : null;
  const oldSel = getAttr(hc, SELECTION);
  // generic attributes grow with zero / default values
  hc.attributes = hc.attributes
    .filter((a) => a.name !== 'radius' && a.name !== SURFACE_UV && a.name !== SELECTION)
    .map((a) => ({ ...a, data: grown(a, a.domain === 'POINT' ? n0 + add : c0 + list.length) }));
  hc.positions = pos;
  hc.curve_offsets = offs;
  if (oldR) {
    const r = new Float32Array(n0 + add);
    r.set(oldR);
    let w = n0;
    for (const c of list) {
      const m = c.points.length / 3;
      for (let i = 0; i < m; i++) r[w + i] = c.radius === undefined ? DEFAULT_RADIUS : typeof c.radius === 'number' ? c.radius : (c.radius[i] ?? DEFAULT_RADIUS);
      w += m;
    }
    setAttr(hc, 'radius', 'POINT', 'FLOAT', r);
  }
  if (oldUV || anyUV) {
    const uv = new Float32Array((c0 + list.length) * 2);
    if (oldUV) uv.set(oldUV);
    list.forEach((c, k) => c.uv && uv.set(c.uv, (c0 + k) * 2));
    setAttr(hc, SURFACE_UV, 'CURVE', 'FLOAT2', uv);
  }
  // new elements get `selected`; existing ones keep theirs (missing selection = all selected)
  if (oldSel || !selected) {
    const dom = oldSel?.domain ?? hc.selection_domain;
    const oldN = dom === 'POINT' ? n0 : c0;
    const next = new Float32Array(domainSize(hc, dom));
    if (oldSel) next.set(Float32Array.from(oldSel.data).subarray(0, oldN));
    else next.fill(1, 0, oldN);
    next.fill(selected ? 1 : 0, oldN);
    setAttr(hc, SELECTION, dom, 'FLOAT', next);
  }
}

function grown(a: HairAttribute, n: number): AttrArray {
  const comps = dataComps(a.data_type);
  const out = allocData(a.data_type, n);
  (out as Float32Array).set(a.data.subarray(0, Math.min(a.data.length, n * comps)) as Float32Array);
  // new curves are poly curves (the built-in defaults of the type settings)
  if (a.name === 'curve_type') out.fill(1, a.data.length);
  if (a.name === 'resolution') out.fill(12, a.data.length);
  if (a.name === 'nurbs_order') out.fill(4, a.data.length);
  if (a.name === 'nurbs_weight') out.fill(1, a.data.length);
  return out;
}

/** Keep only some points (curves left without points disappear). Attributes follow. */
export function keepPoints(hc: HairCurvesData, keep: ArrayLike<boolean | number>) {
  const np = pointCount(hc),
    nc = curveCount(hc);
  const o = hc.curve_offsets;
  const pointMap: number[] = [];
  const curveMap: number[] = [];
  const offs: number[] = [0];
  for (let c = 0; c < nc; c++) {
    let k = 0;
    for (let i = o[c]; i < o[c + 1]; i++)
      if (keep[i]) {
        pointMap.push(i);
        k++;
      }
    if (k) {
      curveMap.push(c);
      offs.push(pointMap.length);
    }
  }
  if (pointMap.length === np) return false;
  remap(hc, pointMap, curveMap, Uint32Array.from(offs));
  return true;
}

/** Keep only some curves. */
export function keepCurves(hc: HairCurvesData, keep: ArrayLike<boolean | number>) {
  const nc = curveCount(hc);
  const o = hc.curve_offsets;
  const pointMap: number[] = [];
  const curveMap: number[] = [];
  const offs: number[] = [0];
  for (let c = 0; c < nc; c++) {
    if (!keep[c]) continue;
    curveMap.push(c);
    for (let i = o[c]; i < o[c + 1]; i++) pointMap.push(i);
    offs.push(pointMap.length);
  }
  if (curveMap.length === nc) return false;
  remap(hc, pointMap, curveMap, Uint32Array.from(offs));
  return true;
}

/** Rebuild the data from source point / curve indices (in output order) and new offsets. */
export function remap(hc: HairCurvesData, pointMap: ArrayLike<number>, curveMap: ArrayLike<number>, offsets: Uint32Array) {
  const pos = new Float32Array(pointMap.length * 3);
  for (let i = 0; i < pointMap.length; i++) {
    const s = pointMap[i] * 3;
    pos[i * 3] = hc.positions[s];
    pos[i * 3 + 1] = hc.positions[s + 1];
    pos[i * 3 + 2] = hc.positions[s + 2];
  }
  hc.attributes = hc.attributes.map((a) => {
    if (a.data.length !== domainSize(hc, a.domain) * dataComps(a.data_type)) return { ...a, data: allocData(a.data_type, a.domain === 'POINT' ? pointMap.length : curveMap.length) };
    const map = a.domain === 'POINT' ? pointMap : curveMap;
    const comps = dataComps(a.data_type);
    const out = allocData(a.data_type, map.length);
    for (let i = 0; i < map.length; i++) for (let k = 0; k < comps; k++) out[i * comps + k] = a.data[map[i] * comps + k];
    return { ...a, data: out };
  });
  hc.positions = pos;
  hc.curve_offsets = offsets;
}

/** Copy point ranges into new curves appended at the end: [curve, first point, last point] per new curve. */
export function copyRanges(hc: HairCurvesData, ranges: [number, number, number][]): number {
  if (!ranges.length) return 0;
  const np = pointCount(hc),
    nc = curveCount(hc);
  const pointMap: number[] = [];
  const curveMap: number[] = [];
  for (let i = 0; i < np; i++) pointMap.push(i);
  for (let c = 0; c < nc; c++) curveMap.push(c);
  const offs = Array.from(hc.curve_offsets);
  for (const [c, a, b] of ranges) {
    for (let i = a; i <= b; i++) pointMap.push(i);
    curveMap.push(c);
    offs.push(pointMap.length);
  }
  remap(hc, pointMap, curveMap, Uint32Array.from(offs));
  return ranges.length;
}

/** Runs of consecutive selected points per curve: [curve, first, last]. */
export function selectedRanges(hc: HairCurvesData, sel: ArrayLike<number>): [number, number, number][] {
  const out: [number, number, number][] = [];
  const o = hc.curve_offsets;
  for (let c = 0; c < curveCount(hc); c++) {
    let start = -1;
    for (let i = o[c]; i <= o[c + 1]; i++) {
      const on = i < o[c + 1] && sel[i] > 0;
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        out.push([c, start, i - 1]);
        start = -1;
      }
    }
  }
  return out;
}

/** Reverse the point order of some curves (point attributes follow). */
export function reverseCurves(hc: HairCurvesData, which: ArrayLike<boolean | number>) {
  const o = hc.curve_offsets;
  const map: number[] = [];
  for (let c = 0; c < curveCount(hc); c++) {
    if (which[c]) for (let i = o[c + 1] - 1; i >= o[c]; i--) map.push(i);
    else for (let i = o[c]; i < o[c + 1]; i++) map.push(i);
  }
  const curves = Array.from({ length: curveCount(hc) }, (_, i) => i);
  remap(hc, map, curves, hc.curve_offsets.slice());
  // Bézier handles swap sides when a curve is reversed
  const l = hc.attributes.find((a) => a.name === 'handle_left'),
    r = hc.attributes.find((a) => a.name === 'handle_right');
  if (l && r) {
    const ln = l.data,
      rn = r.data;
    l.data = rn;
    r.data = ln;
  }
}

/** Insert `cuts` evenly spaced points into every segment whose two ends are selected. */
export function subdivideSelected(hc: HairCurvesData, sel: ArrayLike<number>, cuts: number) {
  const o = hc.curve_offsets;
  const nc = curveCount(hc);
  const offs: number[] = [0];
  const src: [number, number, number][] = []; // a, b, t
  let added = 0;
  for (let c = 0; c < nc; c++) {
    for (let i = o[c]; i < o[c + 1]; i++) {
      src.push([i, i, 0]);
      if (i + 1 < o[c + 1] && sel[i] > 0 && sel[i + 1] > 0)
        for (let k = 1; k <= cuts; k++) {
          src.push([i, i + 1, k / (cuts + 1)]);
          added++;
        }
    }
    offs.push(src.length);
  }
  if (!added) return false;
  const P = hc.positions;
  const pos = new Float32Array(src.length * 3);
  src.forEach(([a, b, t], j) => {
    for (let k = 0; k < 3; k++) pos[j * 3 + k] = P[a * 3 + k] * (1 - t) + P[b * 3 + k] * t;
  });
  hc.attributes = hc.attributes.map((a) => {
    if (a.domain !== 'POINT') return a;
    const comps = dataComps(a.data_type);
    const d = allocData(a.data_type, src.length);
    const interp = a.data instanceof Float32Array;
    src.forEach(([x, y, t], j) => {
      for (let k = 0; k < comps; k++) d[j * comps + k] = interp ? a.data[x * comps + k] * (1 - t) + a.data[y * comps + k] * t : a.data[(t < 0.5 ? x : y) * comps + k];
    });
    return { ...a, data: d };
  });
  hc.positions = pos;
  hc.curve_offsets = Uint32Array.from(offs);
  return true;
}

/** Arc length of every point along its curve (0 at the root). */
export function arcLengths(positions: ArrayLike<number>, offsets: ArrayLike<number>): Float32Array {
  const out = new Float32Array(positions.length / 3);
  for (let c = 0; c + 1 < offsets.length; c++) {
    let acc = 0;
    for (let i = offsets[c] + 1; i < offsets[c + 1]; i++) {
      acc += Math.hypot(positions[i * 3] - positions[i * 3 - 3], positions[i * 3 + 1] - positions[i * 3 - 2], positions[i * 3 + 2] - positions[i * 3 - 1]);
      out[i] = acc;
    }
  }
  return out;
}

/** Total length of each curve. */
export function curveLengths(hc: Pick<HairCurvesData, 'positions' | 'curve_offsets'>): Float32Array {
  const arc = arcLengths(hc.positions, hc.curve_offsets);
  const o = hc.curve_offsets;
  const out = new Float32Array(Math.max(0, o.length - 1));
  for (let c = 0; c < out.length; c++) out[c] = o[c + 1] > o[c] ? arc[o[c + 1] - 1] : 0;
  return out;
}

export function uniqueHairName(doc: DocumentData, base: string) {
  const names = new Set(Object.values(doc.hair_curves ?? {}).map((m) => m.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

/** Deep copy (fresh typed arrays). */
export function cloneHair(hc: HairCurvesData): HairCurvesData {
  return {
    ...hc,
    positions: hc.positions.slice(),
    curve_offsets: hc.curve_offsets.slice(),
    attributes: hc.attributes.map((a) => ({ ...a, data: a.data.slice() })),
    materials: [...hc.materials],
  };
}

/** Small deterministic random generator. */
export function rng(seed: number) {
  let a = (seed * 2654435761) >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
