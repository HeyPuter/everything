// Sheet metal features: types, factories, validation and the bend math the
// geometry kernel and the flat pattern share. Lengths are millimetres and
// angles degrees, as everywhere in the document.

import type { Vec2 } from '../math/vec';
import { SketchIndex } from '../sketch/geom';
import type { EdgeRef, FeatureBase, Id, Param, SkEntity } from './types';

/** How the flat length of a bend is found. */
export type BendAllowanceType = 'kFactor' | 'bendAllowance' | 'bendDeduction';
export type ReliefType = 'rectangular' | 'obround' | 'none';

/** The part's sheet metal parameters, kept on its first Base Flange. */
export interface SheetMetalParams {
  thickness: Param;
  /** Inner bend radius. */
  radius: Param;
  allowance: BendAllowanceType;
  /** Position of the neutral fibre as a fraction of the thickness (0 to 1). */
  kFactor: number;
  /** Bend allowance or bend deduction, for those allowance types. */
  allowanceValue: Param;
  relief: ReliefType;
  /** Relief width and extra depth as a multiple of the thickness. */
  reliefRatio: number;
}

/**
 * Base Flange from a sketch: a closed profile makes a flat plate, an open
 * line/arc chain is thickened and extruded, with a bend at each sharp corner.
 * A later Base Flange in a part is a Tab: a flat region added on a face of the
 * sheet in the same thickness (its own sheet metal parameters are not used).
 */
export interface BaseFlangeFeature extends FeatureBase {
  type: 'baseFlange';
  sketch: Id;
  sm: SheetMetalParams;
  /** Thickness on the other side of the sketch. */
  flip: boolean;
  /** Thickness centred on the sketch. */
  mid: boolean;
  /** Open profiles: how far the profile is extruded. */
  depth: Param;
  depthEnd: 'blind' | 'midPlane';
  depthFlip: boolean;
}

export type FlangeLengthRef = 'outer' | 'inner' | 'tangent';
export type FlangePosition = 'materialInside' | 'materialOutside' | 'bendOutside';

export interface EdgeFlangeFeature extends FeatureBase {
  type: 'edgeFlange';
  edges: EdgeRef[];
  length: Param;
  angle: Param;
  /** What the length is measured from: outer or inner virtual sharp, or the end of the bend. */
  lengthRef: FlangeLengthRef;
  position: FlangePosition;
  /** Bend to the other side. */
  flip: boolean;
  /** Distances the flange stops short of each end of the edge (with bend reliefs). */
  offset1: Param;
  offset2: Param;
}

export type SketchedBendPosition = 'centerline' | FlangePosition;

export interface SketchedBendFeature extends FeatureBase {
  type: 'sketchedBend';
  sketch: Id;
  angle: Param;
  position: SketchedBendPosition;
  /** Bend toward the other side of the face. */
  flip: boolean;
  /** Keep the other side of the line fixed. */
  flipFixed: boolean;
}

export interface HemFeature extends FeatureBase {
  type: 'hem';
  edges: EdgeRef[];
  kind: 'closed' | 'open';
  length: Param;
  /** Open hems: the gap between the sheet and the hem. */
  gap: Param;
  position: 'materialInside' | 'bendOutside';
  flip: boolean;
}

export type SheetMetalFeature = BaseFlangeFeature | EdgeFlangeFeature | SketchedBendFeature | HemFeature;

export const SHEET_METAL_TYPES = ['baseFlange', 'edgeFlange', 'sketchedBend', 'hem'] as const;

export const isSheetMetalType = (t: string): t is SheetMetalFeature['type'] => (SHEET_METAL_TYPES as readonly string[]).includes(t);

/** Gap a closed hem leaves between the layers, as a fraction of the thickness (a zero radius has no bend). */
export const CLOSED_HEM_GAP = 0.02;

export const defaultSheetParams = (thickness: number): SheetMetalParams => ({
  thickness, radius: thickness, allowance: 'kFactor', kFactor: 0.5, allowanceValue: thickness * 1.5, relief: 'rectangular', reliefRatio: 0.5,
});

export const newBaseFlange = (id: Id, name: string, sketch: Id, thickness: number, depth: number): BaseFlangeFeature => ({
  id, name, type: 'baseFlange', sketch, sm: defaultSheetParams(thickness), flip: false, mid: false, depth, depthEnd: 'blind', depthFlip: false,
});

export const newEdgeFlange = (id: Id, name: string, length: number): EdgeFlangeFeature => ({
  id, name, type: 'edgeFlange', edges: [], length, angle: 90, lengthRef: 'outer', position: 'materialInside', flip: false, offset1: 0, offset2: 0,
});

export const newSketchedBend = (id: Id, name: string, sketch: Id): SketchedBendFeature => ({
  id, name, type: 'sketchedBend', sketch, angle: 90, position: 'centerline', flip: false, flipFixed: false,
});

export const newHem = (id: Id, name: string, length: number, gap: number): HemFeature => ({
  id, name, type: 'hem', edges: [], kind: 'closed', length, gap, position: 'materialInside', flip: false,
});

// ---- bend math ----

export interface BendParams {
  thickness: number;
  radius: number;
  allowance: BendAllowanceType;
  kFactor: number;
  allowanceValue: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Outside setback: from the bend's tangent line to the virtual sharp of a surface of radius r. */
export const setback = (angleDeg: number, r: number) => Math.tan(rad(angleDeg) / 2) * r;

/**
 * Flat length of a bend of the given angle and inner radius (the bend
 * allowance). K-factor: BA = pi/180 * angle * (R + K*T). A bend allowance is
 * used as given; a bend deduction BD gives BA = 2 * OSSB - BD, with the
 * outside setback OSSB = tan(angle/2) * (R + T).
 */
export function bendAllowance(angleDeg: number, radius: number, p: BendParams): number {
  switch (p.allowance) {
    case 'bendAllowance': return p.allowanceValue;
    case 'bendDeduction': return 2 * setback(angleDeg, radius + p.thickness) - p.allowanceValue;
    default: return rad(angleDeg) * (radius + p.kFactor * p.thickness);
  }
}

/** Why sheet metal parameters cannot be used, or null. */
export function sheetParamsError(p: BendParams): string | null {
  if (!(p.thickness > 0)) return 'Thickness must be greater than zero';
  if (!(p.radius >= 0)) return 'The bend radius cannot be negative';
  if (p.allowance === 'kFactor' && !(p.kFactor >= 0 && p.kFactor <= 1)) return 'The K-factor must be between 0 and 1';
  if (p.allowance !== 'kFactor' && !Number.isFinite(p.allowanceValue)) return 'The bend allowance has an invalid value';
  return null;
}

// ---- validation of files ----

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const param = (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string';
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const oneOf = (v: unknown, list: readonly string[]) => typeof v === 'string' && list.includes(v);
const edgeList = (v: unknown) => Array.isArray(v) && v.every((e) => object(e) && typeof e.name === 'string');

function validParams(v: unknown): boolean {
  return object(v) && param(v.thickness) && param(v.radius) && oneOf(v.allowance, ['kFactor', 'bendAllowance', 'bendDeduction']) && finite(v.kFactor)
    && param(v.allowanceValue) && oneOf(v.relief, ['rectangular', 'obround', 'none']) && finite(v.reliefRatio);
}

/** Checks a sheet metal feature read from a file (its fields are walked by the tree and the rebuild). */
export function validSheetMetalFeature(r: Record<string, unknown>): boolean {
  switch (r.type) {
    case 'baseFlange':
      return typeof r.sketch === 'string' && validParams(r.sm) && param(r.depth) && oneOf(r.depthEnd, ['blind', 'midPlane']);
    case 'edgeFlange':
      return edgeList(r.edges) && param(r.length) && param(r.angle) && param(r.offset1) && param(r.offset2)
        && oneOf(r.lengthRef, ['outer', 'inner', 'tangent']) && oneOf(r.position, ['materialInside', 'materialOutside', 'bendOutside']);
    case 'sketchedBend':
      return typeof r.sketch === 'string' && param(r.angle) && oneOf(r.position, ['centerline', 'materialInside', 'materialOutside', 'bendOutside']);
    case 'hem':
      return edgeList(r.edges) && param(r.length) && param(r.gap) && oneOf(r.kind, ['closed', 'open']) && oneOf(r.position, ['materialInside', 'bendOutside']);
    default:
      return true;
  }
}

// ---- open profiles ----

export type ChainSeg =
  | { k: 'line'; a: Vec2; b: Vec2; src: Id }
  /** sweep: signed angle in radians, positive turning left (counter-clockwise). */
  | { k: 'arc'; c: Vec2; r: number; a: Vec2; b: Vec2; sweep: number; src: Id };

const d2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * The lines and arcs of a sketch as one open chain, in order from the end
 * whose curve comes first in the sketch (so the thickness side stays put when
 * the sketch is edited). An error says why the sketch is not one.
 */
export function openChain(entities: SkEntity[]): { segs: ChainSeg[] } | { error: string } {
  const ix = new SketchIndex(entities);
  const curves = entities.filter((e) => e.t !== 'point' && !e.construction);
  if (!curves.length) return { error: 'The sketch has no lines or arcs' };
  if (curves.some((c) => c.t !== 'line' && c.t !== 'arc')) return { error: 'An open profile can only have lines and arcs' };
  const ends = curves.map((c) => (c.t === 'line' || c.t === 'arc' ? [ix.pt(c.a), ix.pt(c.b)] : []) as [Vec2, Vec2]);
  let size = 0;
  for (const [a, b] of ends) size = Math.max(size, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]), d2(a, b));
  const tol = Math.max(1e-7, size * 1e-7);
  const verts: Vec2[] = [];
  const vertexOf = (p: Vec2) => {
    const i = verts.findIndex((v) => d2(v, p) <= tol);
    if (i >= 0) return i;
    verts.push(p);
    return verts.length - 1;
  };
  const cv = ends.map(([a, b]) => [vertexOf(a), vertexOf(b)]);
  if (cv.some(([a, b]) => a === b)) return { error: 'A curve of the profile has no length' };
  const incident: number[][] = verts.map(() => []);
  cv.forEach(([a, b], i) => { incident[a].push(i); incident[b].push(i); });
  if (incident.some((l) => l.length > 2)) return { error: 'The open profile must be a single chain of lines and arcs without branches' };
  const tips = incident.flatMap((l, v) => (l.length === 1 ? [v] : []));
  if (tips.length !== 2) return { error: tips.length ? 'The open profile must be a single chain of lines and arcs' : 'The profile is closed' };
  // Start at the end whose curve comes first in the sketch.
  let at = Math.min(incident[tips[0]][0], incident[tips[1]][0]) === incident[tips[0]][0] ? tips[0] : tips[1];
  const used = new Set<number>();
  const segs: ChainSeg[] = [];
  for (;;) {
    const next = incident[at].find((i) => !used.has(i));
    if (next === undefined) break;
    used.add(next);
    const c = curves[next];
    const forward = cv[next][0] === at;
    const [pa, pb] = forward ? ends[next] : [ends[next][1], ends[next][0]];
    if (c.t === 'line') segs.push({ k: 'line', a: pa, b: pb, src: c.id });
    else if (c.t === 'arc') {
      const ctr = ix.pt(c.c);
      let sweep = Math.atan2(ends[next][1][1] - ctr[1], ends[next][1][0] - ctr[0]) - Math.atan2(ends[next][0][1] - ctr[1], ends[next][0][0] - ctr[0]);
      while (sweep <= 0) sweep += 2 * Math.PI;
      segs.push({ k: 'arc', c: ctr, r: d2(ctr, ends[next][0]), a: pa, b: pb, sweep: forward ? sweep : -sweep, src: c.id });
    }
    at = forward ? cv[next][1] : cv[next][0];
  }
  if (used.size !== curves.length) return { error: 'The open profile must be a single chain of lines and arcs' };
  return { segs };
}

export interface OpenRun {
  /** Flat x range of the straight part. */
  x0: number;
  x1: number;
  /** Start of the straight part in the sketch, and its direction. */
  a: Vec2;
  d: Vec2;
  src: Id;
}

export interface OpenBend {
  /** Flat x where the bend starts, and its flat width (bend allowance). */
  x: number;
  width: number;
  angle: number;
  up: boolean;
  radius: number;
  src: Id;
}

/**
 * Unrolls an open profile: the straight parts and bends along the flat x
 * axis. The sketch lies on the surface at height zl of the sheet (0 on the
 * side the thickness grows from, T on the other, T/2 mid-plane); thickness
 * grows to the left of the chain. Bends turning left go "up" (toward the
 * material). A sharp corner gets the sheet's bend radius on its inside and
 * is the virtual sharp of the sketched surface; an arc between two lines
 * is a bend of its own radius.
 */
export function layoutOpenProfile(segs: ChainSeg[], p: BendParams, zl: number): { runs: OpenRun[]; bends: OpenBend[] } | { error: string } {
  const T = p.thickness;
  const dir = (a: Vec2, b: Vec2): Vec2 => { const l = d2(a, b); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  // Runs of collinear lines with what joins each to the next.
  const runs: { a: Vec2; b: Vec2; src: Id }[] = [];
  const joints: ({ k: 'sharp' } | { k: 'arc'; seg: Extract<ChainSeg, { k: 'arc' }> })[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.k === 'arc') {
      if (!runs.length || i === segs.length - 1 || segs[i + 1].k !== 'line') return { error: 'Arcs in an open profile must lie between two lines' };
      const prev = runs[runs.length - 1];
      const next = segs[i + 1] as Extract<ChainSeg, { k: 'line' }>;
      const tangent = (pt: Vec2): Vec2 => { const r: Vec2 = [(pt[0] - s.c[0]) / s.r, (pt[1] - s.c[1]) / s.r]; return s.sweep > 0 ? [-r[1], r[0]] : [r[1], -r[0]]; };
      const t0 = tangent(s.a), t1 = tangent(s.b), d0 = dir(prev.a, prev.b), d1 = dir(next.a, next.b);
      if (Math.abs(t0[0] * d0[1] - t0[1] * d0[0]) > 1e-4 || t0[0] * d0[0] + t0[1] * d0[1] < 0 || Math.abs(t1[0] * d1[1] - t1[1] * d1[0]) > 1e-4 || t1[0] * d1[0] + t1[1] * d1[1] < 0) {
        return { error: 'Arcs in an open profile must be tangent to the lines they join' };
      }
      joints.push({ k: 'arc', seg: s });
      continue;
    }
    const prev = runs[runs.length - 1];
    if (prev && joints.length < runs.length) {
      // Two lines meeting: one line if they go on straight, else a sharp bend.
      const a = dir(prev.a, prev.b), b = dir(s.a, s.b);
      if (Math.abs(a[0] * b[1] - a[1] * b[0]) < 1e-9 && a[0] * b[0] + a[1] * b[1] > 0) { prev.b = s.b; continue; }
      joints.push({ k: 'sharp' });
    }
    runs.push({ a: s.a, b: s.b, src: s.src });
  }
  const tanHalf = (deg: number) => Math.tan((deg * Math.PI) / 360);
  const bends: (OpenBend & { setback: number })[] = joints.map((j, i) => {
    if (j.k === 'arc') {
      const up = j.seg.sweep > 0;
      return { x: 0, width: 0, angle: (Math.abs(j.seg.sweep) * 180) / Math.PI, up, radius: up ? j.seg.r - (T - zl) : j.seg.r - zl, src: j.seg.src, setback: 0 };
    }
    const a = dir(runs[i].a, runs[i].b), b = dir(runs[i + 1].a, runs[i + 1].b);
    const turn = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
    const angle = (Math.abs(turn) * 180) / Math.PI;
    const up = turn > 0;
    const R = p.radius;
    return { x: 0, width: 0, angle, up, radius: R, src: runs[i].src, setback: tanHalf(angle) * (up ? R + T - zl : R + zl) };
  });
  for (const b of bends) {
    if (b.angle > 179.5) return { error: 'The profile folds back on itself; the angle between lines must be less than 180 degrees' };
    if (b.radius < -1e-9) return { error: 'An arc of the profile is too small for the thickness on its inside' };
    b.radius = Math.max(0, b.radius);
    b.width = bendAllowance(b.angle, b.radius, p);
    if (!(b.width > 0)) return { error: 'The bend allowance must be greater than zero' };
  }
  const out: OpenRun[] = [];
  let x = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const d = dir(r.a, r.b);
    const sb0 = i > 0 ? bends[i - 1].setback : 0, sb1 = i < bends.length ? bends[i].setback : 0;
    const L = d2(r.a, r.b) - sb0 - sb1;
    if (L < 1e-6) return { error: 'A line of the profile is too short for the bend radius and thickness' };
    out.push({ x0: x, x1: x + L, a: [r.a[0] + d[0] * sb0, r.a[1] + d[1] * sb0], d, src: r.src });
    x += L;
    if (i < bends.length) { bends[i].x = x; x += bends[i].width; }
  }
  return { runs: out, bends: bends.map(({ setback: _s, ...b }) => b) };
}
