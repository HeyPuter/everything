// Point cloud data helpers: factories, attribute access, selection and point subsets. Pure
// functions over PointCloudData (no app state), shared by the operators, Edit Mode and tests.
import { uid } from '../data/defaults';
import type { DocumentData, ObjectData } from '../data/types';
import { allocData, dataComps, type AttrArray, type DataType } from '../geonodes/types';
import type { PointCloudAttribute, PointCloudData } from './types';

/** Radius of points without a radius attribute. */
export const DEFAULT_RADIUS = 0.01;
export const SELECTION = '.selection';

export function newPointCloud(name = 'PointCloud'): PointCloudData {
  return { id: uid('pc'), name, positions: new Float32Array(0), attributes: [], active_attribute: -1, materials: [] };
}

export function pointCloudOf(doc: DocumentData, ob: ObjectData | null | undefined): PointCloudData | null {
  if (!ob || ob.type !== 'POINTCLOUD' || !ob.data) return null;
  return doc.pointclouds?.[ob.data] ?? null;
}

export const pointCount = (pc: Pick<PointCloudData, 'positions'>) => pc.positions.length / 3;

export function uniquePointCloudName(doc: DocumentData, base: string) {
  const names = new Set(Object.values(doc.pointclouds ?? {}).map((m) => m.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

/** An attribute whose size matches the point count (stale ones are ignored). */
export function getAttr(pc: PointCloudData, name: string): PointCloudAttribute | undefined {
  const a = pc.attributes.find((x) => x.name === name);
  return a && a.data.length === pointCount(pc) * dataComps(a.data_type) ? a : undefined;
}

/** Set (replace) an attribute, creating it when missing. */
export function setAttr(pc: PointCloudData, name: string, type: DataType, data: AttrArray) {
  const i = pc.attributes.findIndex((x) => x.name === name);
  const a: PointCloudAttribute = { name, data_type: type, data };
  pc.attributes = i < 0 ? [...pc.attributes, a] : pc.attributes.map((x, k) => (k === i ? a : x));
}

export function removeAttr(pc: PointCloudData, name: string): boolean {
  const i = pc.attributes.findIndex((x) => x.name === name);
  if (i < 0) return false;
  pc.attributes = pc.attributes.filter((_, k) => k !== i);
  if ((pc.active_attribute ?? -1) >= pc.attributes.length) pc.active_attribute = pc.attributes.length - 1;
  return true;
}

export function radii(pc: PointCloudData): Float32Array {
  const a = getAttr(pc, 'radius');
  if (a && a.data_type === 'FLOAT') return a.data as Float32Array;
  return new Float32Array(pointCount(pc)).fill(DEFAULT_RADIUS);
}

/** Selection per point (1 / 0); a missing selection attribute means everything is selected. */
export function selection(pc: PointCloudData): Uint8Array {
  const a = getAttr(pc, SELECTION);
  const n = pointCount(pc);
  if (!a) return new Uint8Array(n).fill(1);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = a.data[i] ? 1 : 0;
  return out;
}

export function setSelection(pc: PointCloudData, sel: Uint8Array) {
  setAttr(pc, SELECTION, 'BOOLEAN', sel);
}

/** Keep the points where `keep[i]` is set (every attribute follows). */
export function subsetPoints(pc: PointCloudData, keep: ArrayLike<number>): PointCloudData {
  const n = pointCount(pc);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  return { ...pc, positions: gather(pc.positions, 3, idx) as Float32Array, attributes: pc.attributes.filter((a) => a.data.length === n * dataComps(a.data_type)).map((a) => ({ ...a, data: gather(a.data, dataComps(a.data_type), idx) })) };
}

/** Append copies of the points `idx` at the end; returns the data and the index of the first copy. */
export function duplicatePoints(pc: PointCloudData, idx: number[]): PointCloudData {
  const n = pointCount(pc);
  const all = [...Array(n).keys(), ...idx];
  return { ...pc, positions: gather(pc.positions, 3, all) as Float32Array, attributes: pc.attributes.filter((a) => a.data.length === n * dataComps(a.data_type)).map((a) => ({ ...a, data: gather(a.data, dataComps(a.data_type), all) })) };
}

/** Append points with default attribute values (radius `radius`). */
export function appendPoints(pc: PointCloudData, positions: ArrayLike<number>, radius: number | ArrayLike<number> = DEFAULT_RADIUS): PointCloudData {
  const n = pointCount(pc),
    add = positions.length / 3;
  const pos = new Float32Array((n + add) * 3);
  pos.set(pc.positions);
  pos.set(positions, n * 3);
  const r = new Float32Array(n + add);
  r.set(radii(pc));
  for (let i = 0; i < add; i++) r[n + i] = typeof radius === 'number' ? radius : radius[i];
  const attrs = pc.attributes
    .filter((a) => a.name !== 'radius' && a.data.length === n * dataComps(a.data_type))
    .map((a) => {
      const d = allocData(a.data_type, n + add);
      d.set(a.data as never);
      return { ...a, data: d };
    });
  return { ...pc, positions: pos, attributes: [...attrs, { name: 'radius', data_type: 'FLOAT', data: r }] };
}

function gather(src: AttrArray, comps: number, idx: number[]): AttrArray {
  const out = new (src.constructor as { new (n: number): AttrArray })(idx.length * comps);
  for (let k = 0; k < idx.length; k++) for (let c = 0; c < comps; c++) out[k * comps + c] = src[idx[k] * comps + c];
  return out;
}

/** Points scattered uniformly in a cube of half size `size` with random radii (deterministic). */
export function randomPoints(count: number, size = 1, maxRadius = 0.05, seed = 1): { positions: Float32Array; radius: Float32Array } {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const positions = new Float32Array(count * 3);
  const radius = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (rnd() * 2 - 1) * size;
    positions[i * 3 + 1] = (rnd() * 2 - 1) * size;
    positions[i * 3 + 2] = (rnd() * 2 - 1) * size;
    radius[i] = rnd() * maxRadius;
  }
  return { positions, radius };
}

export function applySelectAction(sel: Uint8Array, action: string): Uint8Array {
  let a = action;
  if (a === 'TOGGLE') a = sel.some((x) => x) ? 'DESELECT' : 'SELECT';
  return Uint8Array.from(sel, (x) => (a === 'SELECT' ? 1 : a === 'DESELECT' ? 0 : x ? 0 : 1));
}

/** Random selection: each point is (de)selected with probability `ratio` (deterministic per seed). */
export function randomSelection(sel: Uint8Array, ratio: number, seed: number, select: boolean): Uint8Array {
  let s = (seed * 2654435761 + 1) >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const out = Uint8Array.from(sel);
  for (let i = 0; i < out.length; i++) if (rnd() < ratio) out[i] = select ? 1 : 0;
  return out;
}
