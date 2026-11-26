/* eslint-disable @typescript-eslint/no-explicit-any */
// Sheet metal features and the flat pattern.
//
// Alongside the body, a sheet metal part keeps a model of its sheet built
// from the feature definitions: flat regions (panels) and the bends joining
// them. Every panel is a planar face in one common flat-pattern plane (z = 0,
// the sheet spanning z = 0..T) with the rigid placement that takes it to the
// folded part. A bend is a strip of the flat pattern, as wide as its bend
// allowance, between the panel it starts from (fixed) and the panel it
// carries (moving); the moving panel's placement is the fixed one's followed
// by the bend's motion. Features change both the body (with booleans, so cuts,
// fillets and holes made in between are kept) and this model, from which the
// flat pattern is laid out: panels where they are, bends as strips, with the
// body's material in each panel (holes and cuts through the sheet) found by
// sectioning it at the panel's mid-plane.

import * as R from 'replicad';
import type { Frame, Vec2, Vec3 } from '../math/vec';
import { add, cross, dot, normalize, scale, sub, toLocal } from '../math/vec';
import type { Id } from '../model/types';
import type { Region } from '../sketch/profiles';
import { buildProfiles } from '../sketch/profiles';
import {
  type BendParams, type HemFeature, type ReliefType, CLOSED_HEM_GAP, bendAllowance, layoutOpenProfile, openChain, setback, sheetParamsError,
  type BaseFlangeFeature, type EdgeFlangeFeature, type SheetMetalFeature, type SketchedBendFeature,
} from '../model/sheetmetal';
import type { FlatBend, FlatLoop, FlatPattern, FlatSeg } from '../model/flat-pattern';
import type { EdgeRef, SketchFeature } from '../model/types';
import {
  type Sh, type SurfDesc, common, cut, describeEdge, describeFace, faceProps, fuse, fuseAll, getOc, isEmpty, subShapes, transformShape,
  translated, vertexPoint, volumeOf, wrap, xyz,
} from './occ';

// ---- the sheet model ----

export interface SmPanel {
  id: string;
  /** Planar face in the flat-pattern plane (z = 0). */
  face: Sh;
  /** Flat-pattern coordinates to the folded part. */
  xf: Frame;
}

export interface SmBend {
  id: string;
  feature: Id;
  fixed: string;
  moving: string;
  /** Start of the bend line on the fixed panel, its direction u and the direction w across it toward the moving panel (flat). */
  s0: Vec2;
  u: Vec2;
  w: Vec2;
  length: number;
  /** Flat width (bend allowance). */
  width: number;
  angle: number;
  radius: number;
  /** Bends toward +z of the flat pattern. */
  up: boolean;
}

export interface SheetParams extends BendParams {
  relief: ReliefType;
  reliefRatio: number;
}

export interface SheetModel {
  /** The Base Flange holding the parameters. */
  owner: Id;
  p: SheetParams;
  panels: SmPanel[];
  bends: SmBend[];
}

/** Named face of a body (as in build.ts). */
export interface SmNamedFace {
  shape: Sh;
  name: string;
  desc: SurfDesc;
  feature: Id;
}

/** The builder's state, as far as sheet metal uses it. */
export interface SmState {
  body: Sh | null;
  faces: SmNamedFace[];
  edges: unknown;
  frames: Map<Id, Frame>;
  sketches: Map<Id, SketchFeature>;
  sheet?: SheetModel | null;
}

/** What sheet metal features use of the model builder. */
export interface SheetHost {
  sketchRegions(id: Id, st: SmState): { regions: Region[]; frame: Frame; sketch: SketchFeature };
  regionFace(r: Region, fr: Frame): any;
  nearestSrc(regions: Region[], p: Vec2): string;
  applyTool(featId: Id, st: SmState, tool: Sh, faces: SmNamedFace[], isCut: boolean, noGain?: string): void;
  nameFaces(featId: Id, body: Sh, st: SmState, tool: SmNamedFace[]): SmNamedFace[];
  edges(st: SmState): { shape: Sh; name: string }[];
  resolveEdge(ref: EdgeRef, st: SmState): number;
  missing(id: Id, what: string): Error;
  error(message: string): Error;
  warn(message: string): void;
}

// ---- rigid placements (Frame: o + x*px + y*py + n*pz) ----

const EZ: Vec3 = [0, 0, 1];

export const xfApply = (f: Frame, p: Vec3): Vec3 => [
  f.o[0] + f.x[0] * p[0] + f.y[0] * p[1] + f.n[0] * p[2],
  f.o[1] + f.x[1] * p[0] + f.y[1] * p[1] + f.n[1] * p[2],
  f.o[2] + f.x[2] * p[0] + f.y[2] * p[1] + f.n[2] * p[2],
];

const xfDir = (f: Frame, d: Vec3): Vec3 => [
  f.x[0] * d[0] + f.y[0] * d[1] + f.n[0] * d[2],
  f.x[1] * d[0] + f.y[1] * d[1] + f.n[1] * d[2],
  f.x[2] * d[0] + f.y[2] * d[1] + f.n[2] * d[2],
];

export const xfLocal = (f: Frame, p: Vec3): Vec3 => { const d = sub(p, f.o); return [dot(d, f.x), dot(d, f.y), dot(d, f.n)]; };

export function xfInverse(f: Frame): Frame {
  const x: Vec3 = [f.x[0], f.y[0], f.n[0]], y: Vec3 = [f.x[1], f.y[1], f.n[1]], n: Vec3 = [f.x[2], f.y[2], f.n[2]];
  return { o: [-dot(f.x, f.o), -dot(f.y, f.o), -dot(f.n, f.o)], x, y, n };
}

/** a after b. */
export const xfCompose = (a: Frame, b: Frame): Frame => ({ o: xfApply(a, b.o), x: xfDir(a, b.x), y: xfDir(a, b.y), n: xfDir(a, b.n) });

export function placed(shape: Sh, f: Frame): Sh {
  const oc = getOc();
  const tr = new oc.gp_Trsf();
  try {
    tr.SetValues(f.x[0], f.y[0], f.n[0], f.o[0], f.x[1], f.y[1], f.n[1], f.o[1], f.x[2], f.y[2], f.n[2], f.o[2]);
    return transformShape(shape, tr);
  } finally {
    tr.delete();
  }
}

const rotate = (v: Vec3, d: Vec3, a: number): Vec3 => {
  const c = Math.cos(a), s = Math.sin(a);
  return add(add(scale(v, c), scale(cross(d, v), s)), scale(d, dot(d, v) * (1 - c)));
};

const w3 = (v: Vec2): Vec3 => [v[0], v[1], 0];
const add2 = (a: Vec2, b: Vec2, k = 1): Vec2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const dot2 = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];

/** Axis of a bend in the flat coordinates of its fixed panel. */
function bendAxis(b: Pick<SmBend, 's0' | 'w' | 'radius' | 'up'>, T: number): { c: Vec3; d: Vec3 } {
  return { c: [b.s0[0], b.s0[1], b.up ? T + b.radius : -b.radius], d: b.up ? cross(w3(b.w), EZ) : cross(EZ, w3(b.w)) };
}

/** The bend's motion in flat coordinates: the moving side is moved back over the bend's width and turned about its axis. */
export function bendMotion(b: Pick<SmBend, 's0' | 'w' | 'width' | 'angle' | 'radius' | 'up'>, T: number): Frame {
  const { c, d } = bendAxis(b, T);
  const a = (b.angle * Math.PI) / 180;
  const shift = scale(w3(b.w), -b.width);
  return { o: add(rotate(sub(shift, c), d, a), c), x: rotate([1, 0, 0], d, a), y: rotate([0, 1, 0], d, a), n: rotate(EZ, d, a) };
}

// ---- shapes ----

function polyFace(pts: Vec3[]): Sh {
  return R.makeFace(R.assembleWire(pts.map((p, i) => R.makeLine(p, pts[(i + 1) % pts.length])))) as unknown as Sh;
}

/** Rectangle in the flat plane from a corner along two directions. */
const rectFace = (o: Vec2, u: Vec2, lu: number, w: Vec2, lw: number, z = 0): Sh => {
  const p = (a: number, b: number): Vec3 => [o[0] + u[0] * a + w[0] * b, o[1] + u[1] * a + w[1] * b, z];
  return polyFace([p(0, 0), p(lu, 0), p(lu, lw), p(0, lw)]);
};

const extrudeZ = (face: Sh, from: number, to: number): Sh => {
  const f = from !== 0 ? translated(face, [0, 0, from]) : face;
  return R.basicFaceExtrusion(f as any, new R.Vector([0, 0, to - from])) as unknown as Sh;
};

/** The solid of a bend in its fixed panel's flat coordinates (z0, z1 widen it past the sheet). */
function bendSolid(b: SmBend, T: number, z0 = 0, z1 = T): Sh {
  const { c, d } = bendAxis(b, T);
  const p = (t: number, z: number): Vec3 => [b.s0[0] + b.u[0] * t, b.s0[1] + b.u[1] * t, z];
  const face = polyFace([p(0, z0), p(b.length, z0), p(b.length, z1), p(0, z1)]);
  return R.revolution(face as any, c, d, b.angle) as unknown as Sh;
}

/** Faces of a fused flat region merged where they meet (the boolean leaves them apart). */
function unified(shape: Sh): Sh {
  const oc = getOc();
  const u = new oc.ShapeUpgrade_UnifySameDomain(shape.wrapped, true, true, false);
  try {
    u.Build();
    return wrap(u.Shape());
  } finally {
    u.delete();
  }
}

/** A flat face with its normal toward +z (faces of opposite sides are not merged). */
const facingUp = (f: Sh): Sh => (describeFace(f).d[2] < 0 ? wrap(f.wrapped.Reversed()) : f);

const area = (s: Sh) => subShapes(s, 'face').reduce((a, f) => a + faceProps(f.wrapped).area, 0);

/** Points along an edge (lines: its ends). */
function edgePoints(e: Sh, n = 24): Vec3[] {
  const d = describeEdge(e);
  if (d.type === 'line') return [d.a, d.b];
  const oc = getOc();
  const ad = new oc.BRepAdaptor_Curve(e.wrapped);
  try {
    const f = ad.FirstParameter(), l = ad.LastParameter();
    const out: Vec3[] = [];
    for (let i = 0; i <= n; i++) { const p = ad.Value(f + ((l - f) * i) / n); out.push(xyz(p)); p.delete(); }
    return out;
  } finally {
    ad.delete();
  }
}

/** Whether a flat point lies inside a flat face (even-odd over its boundary). */
function insideFlat(face: Sh, q: Vec2): boolean {
  let inside = false;
  for (const e of subShapes(face, 'edge')) {
    const pts = edgePoints(e);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < a[0] + ((q[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside;
    }
  }
  return inside;
}

interface Piece { solid: Sh; faces: SmNamedFace[] }

/** A solid made in flat coordinates, placed, with each face named by classify (looking at it in flat coordinates). */
function namedPiece(featId: Id, flat: Sh, xf: Frame, classify: (d: SurfDesc) => string): Piece {
  const faces = subShapes(flat, 'face').map((f) => {
    const name = `${featId}:${classify(describeFace(f))}`;
    const shape = placed(f, xf);
    return { shape, desc: describeFace(shape), name, feature: featId };
  });
  return { solid: placed(flat, xf), faces };
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ---- dispatch ----

export function applySheetMetal(h: SheetHost, f: SheetMetalFeature, st: SmState) {
  switch (f.type) {
    case 'baseFlange': return st.sheet ? applyTab(h, f, st) : applyBaseFlange(h, f, st);
    case 'edgeFlange': return applyEdgeFlange(h, f, st);
    case 'hem': return applyHem(h, f, st);
    case 'sketchedBend': return applySketchedBend(h, f, st);
  }
}

const num = (h: SheetHost, v: unknown, label: string): number => {
  const x = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(x)) throw h.error(`${label} has an invalid value`);
  return x;
};

function sheetOf(h: SheetHost, st: SmState, what: string): SheetModel {
  if (!st.sheet || !st.body) throw h.error(`${what} needs a sheet metal part. Start with a Base Flange.`);
  return st.sheet;
}

// ---- base flange ----

function applyBaseFlange(h: SheetHost, f: BaseFlangeFeature, st: SmState) {
  const p: SheetParams = {
    thickness: num(h, f.sm.thickness, 'Thickness'), radius: num(h, f.sm.radius, 'Bend radius'), allowance: f.sm.allowance,
    kFactor: num(h, f.sm.kFactor, 'K-factor'), allowanceValue: num(h, f.sm.allowanceValue, 'Bend allowance'), relief: f.sm.relief,
    reliefRatio: num(h, f.sm.reliefRatio, 'Relief ratio'),
  };
  const bad = sheetParamsError(p);
  if (bad) throw h.error(bad);
  if (p.relief !== 'none' && !(p.reliefRatio > 0)) throw h.error('The relief ratio must be greater than zero');
  const sketch = st.sketches.get(f.sketch);
  const frame = st.frames.get(f.sketch);
  if (!sketch || !frame) throw h.missing(f.sketch, 'profile sketch');
  const T = p.thickness;
  if (buildProfiles(sketch.entities).regions.length) {
    // Closed profile: a flat plate.
    const { regions } = h.sketchRegions(f.sketch, st);
    if (regions.length !== 1) throw h.error('A base flange needs one closed profile (it may have holes)');
    // Thickness along the sketch normal (or against it), its frame kept right-handed.
    const at: Frame = f.flip ? { o: frame.o, x: frame.x, y: scale(frame.y, -1), n: scale(frame.n, -1) } : { ...frame };
    const xf: Frame = f.mid ? { ...at, o: sub(at.o, scale(at.n, T / 2)) } : at;
    const flatFace = placed(h.regionFace(regions[0], frame) as Sh, xfInverse(at));
    const piece = namedPiece(f.id, extrudeZ(flatFace, 0, T), xf, (d) => {
      if (d.type === 'plane' && Math.abs(d.d[2]) > 1 - 1e-6) return d.center[2] < T / 2 ? 'cap0' : 'cap1';
      return 'side:' + h.nearestSrc(regions, toLocal(frame, xfApply(at, [d.center[0], d.center[1], 0])));
    });
    h.applyTool(f.id, st, piece.solid, piece.faces, false);
    st.sheet = { owner: f.id, p, panels: [{ id: `${f.id}:p0`, face: flatFace, xf }], bends: [] };
    return;
  }
  // Open profile: thickened along the chain and extruded, with bends at the corners.
  const chain = openChain(sketch.entities);
  if ('error' in chain) throw h.error(chain.error === 'The profile is closed' ? 'The sketch has no closed or open profile' : chain.error);
  const zl = f.mid ? T / 2 : f.flip ? T : 0;
  const lay = layoutOpenProfile(chain.segs, p, zl);
  if ('error' in lay) throw h.error(lay.error);
  const D = num(h, f.depth, 'Depth');
  if (!(D > 0)) throw h.error('Depth must be greater than zero');
  // Flat y runs against the sketch normal, so a blind depth along the normal is y in [-D, 0].
  const [y0, y1] = f.depthEnd === 'midPlane' ? [-D / 2, D / 2] : f.depthFlip ? [0, D] : [-D, 0];
  const r0 = lay.runs[0];
  const d0 = normalize(sub(toWorld3(frame, add2(r0.a, r0.d)), toWorld3(frame, r0.a)));
  const nL = cross(frame.n, d0);
  let xf: Frame = { o: sub(toWorld3(frame, r0.a), add(scale(nL, zl), scale(d0, r0.x0))), x: d0, y: scale(frame.n, -1), n: nL };
  const panels: SmPanel[] = [];
  const bends: SmBend[] = [];
  const pieces: Piece[] = [];
  const last = lay.runs.length - 1;
  const capName = (y: number) => (near(y, f.depthEnd === 'midPlane' ? y0 : 0, 1e-6 * D) ? 'cap0' : 'cap1');
  lay.runs.forEach((run, i) => {
    const face = rectFace([run.x0, y0], [1, 0], run.x1 - run.x0, [0, 1], y1 - y0);
    const id = `${f.id}:p${i}`;
    panels.push({ id, face, xf });
    pieces.push(namedPiece(f.id, extrudeZ(face, 0, T), xf, (d) => {
      if (Math.abs(d.d[2]) > 1 - 1e-6) return `${run.src}:${d.center[2] < T / 2 ? 'a' : 'b'}`;
      if (Math.abs(d.d[1]) > 1 - 1e-6) return capName(d.center[1]);
      if (i === 0 && near(d.center[0], run.x0, 1e-6 * D)) return 'end0';
      if (i === last && near(d.center[0], run.x1, 1e-6 * D)) return 'end1';
      return `${run.src}:joint`;
    }));
    if (i === last) return;
    const lb = lay.bends[i];
    const b: SmBend = {
      id: `${f.id}:b${i}`, feature: f.id, fixed: id, moving: `${f.id}:p${i + 1}`, s0: [lb.x, y0], u: [0, 1], w: [1, 0], length: y1 - y0,
      width: lb.width, angle: lb.angle, radius: lb.radius, up: lb.up,
    };
    bends.push(b);
    pieces.push(namedPiece(f.id, bendSolid(b, T), xf, (d) => {
      if (d.type === 'cylinder') return `bend:${lb.src}:${near(d.r, b.radius, 1e-6 * T + 1e-9) ? 'in' : 'out'}`;
      if (d.type === 'plane' && Math.abs(d.d[1]) > 1 - 1e-6) return capName(d.center[1]);
      return `bend:${lb.src}:joint`;
    }));
    xf = xfCompose(xf, bendMotion(b, T));
  });
  const tool = fuseAll(pieces.map((x) => x.solid));
  // The pieces only touch, unless the profile crosses itself or its sides come closer than the thickness.
  const expected = (y1 - y0) * (lay.runs.reduce((s, r) => s + (r.x1 - r.x0) * T, 0)
    + bends.reduce((s, b) => s + ((b.angle * Math.PI) / 180) * T * (b.radius + T / 2), 0));
  if (volumeOf(tool) < expected * (1 - 1e-6)) throw h.error('The profile crosses itself, or its sides come closer than the sheet thickness');
  h.applyTool(f.id, st, tool, pieces.flatMap((x) => x.faces), false);
  st.sheet = { owner: f.id, p, panels, bends };
}

const toWorld3 = (f: Frame, p: Vec2): Vec3 => add(f.o, add(scale(f.x, p[0]), scale(f.y, p[1])));

/** The panel a sketch plane lies on (its plane level with the panel's top or bottom face), with the side. */
function panelOfPlane(sheet: SheetModel, frame: Frame, at?: Vec3): { panel: SmPanel; top: boolean } | null {
  const T = sheet.p.thickness;
  const tol = Math.max(1e-6, T * 1e-5);
  let best: { panel: SmPanel; top: boolean } | null = null;
  for (const panel of sheet.panels) {
    const c = dot(frame.n, panel.xf.n);
    if (Math.abs(c) < 1 - 1e-7) continue;
    const z = xfLocal(panel.xf, frame.o)[2];
    const top = near(z, T, tol) && c > 0;
    if (!top && !(near(z, 0, tol) && c < 0)) continue;
    if (at) {
      const q = xfLocal(panel.xf, at);
      if (!insideFlat(panel.face, [q[0], q[1]])) continue;
    }
    best = { panel, top };
    break;
  }
  return best;
}

function replacePanels(sheet: SheetModel, panels: SmPanel[], bends: SmBend[] = sheet.bends): SheetModel {
  return { ...sheet, panels, bends };
}

// ---- tab ----

function applyTab(h: SheetHost, f: BaseFlangeFeature, st: SmState) {
  const sheet = sheetOf(h, st, 'A tab');
  const sketch = st.sketches.get(f.sketch);
  const frame = st.frames.get(f.sketch);
  if (!sketch || !frame) throw h.missing(f.sketch, 'profile sketch');
  if (!buildProfiles(sketch.entities).regions.length) throw h.error('This part already has a base flange: another one is a tab, which needs a closed profile on a flat face of the sheet');
  const { regions } = h.sketchRegions(f.sketch, st);
  const T = sheet.p.thickness;
  const on = panelOfPlane(sheet, frame);
  if (!on) throw h.error('Sketch the tab on a flat face of the sheet metal part');
  const { panel } = on;
  const toFlat = xfInverse(panel.xf);
  const faces = regions.map((r) => {
    const flat = placed(h.regionFace(r, frame) as Sh, toFlat);
    return on.top ? translated(flat, [0, 0, -T]) : flat;
  });
  const flatFace = faces.length === 1 ? faces[0] : fuseAll(faces);
  const piece = namedPiece(f.id, extrudeZ(flatFace, 0, T), panel.xf, (d) => {
    if (d.type === 'plane' && Math.abs(d.d[2]) > 1 - 1e-6) return d.center[2] < T / 2 ? 'cap0' : 'cap1';
    return 'side:' + h.nearestSrc(regions, toLocal(frame, xfApply(panel.xf, [d.center[0], d.center[1], on.top ? T : 0])));
  });
  const before = st.body ? subShapes(st.body, 'solid').length : 0;
  h.applyTool(f.id, st, piece.solid, piece.faces, false, 'The tab adds no material: it lies on the sheet already.');
  if (st.body && subShapes(st.body, 'solid').length > before) throw h.error('The tab must touch the edge of the face it is sketched on');
  const merged = unified(fuse(panel.face, flatFace));
  const face = subShapes(merged, 'face');
  st.sheet = replacePanels(sheet, sheet.panels.map((x) => (x === panel ? { ...x, face: face.length === 1 ? face[0] : merged } : x)));
}

// ---- edge flanges and hems ----

interface FlangeSpec {
  angle: number;
  radius: number;
  /** How far the panel is cut back from the edge for the bend. */
  trim: number;
  /** Length of the flat part of the flange. */
  straight: number;
  flip: boolean;
  offset1: number;
  offset2: number;
}

/** The panel and boundary of a selected sheet edge. */
function sheetEdge(h: SheetHost, sheet: SheetModel, st: SmState, ref: EdgeRef) {
  const T = sheet.p.thickness;
  const edge = h.edges(st)[h.resolveEdge(ref, st)];
  const d = describeEdge(edge.shape);
  if (d.type !== 'line') throw h.error('Select straight edges of the sheet (an edge along a flat face)');
  const tol = Math.max(1e-6, T * 1e-4);
  let across = false;
  for (const panel of sheet.panels) {
    const a = xfLocal(panel.xf, d.a), b = xfLocal(panel.xf, d.b);
    const onFace = (z: number) => near(z, 0, tol) || near(z, T, tol);
    if (!near(a[2], b[2], tol) || !onFace(a[2])) {
      if (onFace(a[2]) && onFace(b[2]) && near(Math.hypot(a[0] - b[0], a[1] - b[1]), 0, tol)) across = true;
      continue;
    }
    for (const e of subShapes(panel.face, 'edge')) {
      const s = describeEdge(e);
      if (s.type !== 'line') continue;
      const p: Vec2 = [s.a[0], s.a[1]], q: Vec2 = [s.b[0], s.b[1]];
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const u: Vec2 = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
      const off = (pt: Vec3) => Math.abs((pt[0] - p[0]) * u[1] - (pt[1] - p[1]) * u[0]);
      if (off(a) > tol || off(b) > tol) continue;
      const ta = dot2([a[0] - p[0], a[1] - p[1]], u), tb = dot2([b[0] - p[0], b[1] - p[1]], u);
      const t0 = Math.max(0, Math.min(ta, tb)), t1 = Math.min(L, Math.max(ta, tb));
      if (t1 - t0 < tol) continue;
      // Across the edge, out of the panel.
      let w: Vec2 = [u[1], -u[0]];
      const mid = add2(p, u, (t0 + t1) / 2);
      if (insideFlat(panel.face, add2(mid, w, Math.min(T, L) * 1e-3))) w = [-w[0], -w[1]];
      return { panel, p, u, w, L, t0, t1, top: near(a[2], T, tol) };
    }
  }
  if (across) throw h.error('Select an edge along a face of the sheet, not one across its thickness');
  throw h.error('The selected edge is not an outside edge of a flat region of the sheet. Select an edge along the boundary of a flat face.');
}

function addFlange(h: SheetHost, st: SmState, featId: Id, k: number, ref: EdgeRef, spec: FlangeSpec, what: string) {
  const sheet = st.sheet!;
  const T = sheet.p.thickness;
  const { panel, p, u, w, L, t0: e0, t1: e1, top } = sheetEdge(h, sheet, st, ref);
  const t0 = e0 + spec.offset1, t1 = e1 - spec.offset2;
  if (t1 - t0 < 1e-6) throw h.error(`The offsets leave no ${what}`);
  if (!(spec.straight > 1e-6)) throw h.error(`The ${what} is too short for the bend radius and thickness`);
  const up = top !== spec.flip;
  const tag = `e${k}`;
  // Cut the panel back where the bend goes (a strip along the edge), with reliefs where the flange stops short of the panel's edge.
  const s0 = add2(add2(p, u, t0), w, -spec.trim);
  let panelFace = panel.face;
  if (spec.trim > 1e-9) {
    const strip = rectFace(s0, u, t1 - t0, w, spec.trim);
    if (area(common(panel.face, strip)) < (t1 - t0) * spec.trim * (1 - 1e-6)) throw h.error(`The face is too narrow for the ${what} with this position. Use Bend Outside.`);
    const eps = Math.max(T * 0.01, 1e-4);
    const tools: Sh[] = [extrudeZ(rectFace(s0, u, t1 - t0, w, spec.trim + eps), -eps, T + eps)];
    const rw = sheet.p.reliefRatio * T;
    if (sheet.p.relief !== 'none') {
      const ends: number[] = [];
      if (t0 > 1e-6) ends.push(t0 - rw);
      if (t1 < L - 1e-6) ends.push(t1);
      for (const at of ends) {
        const depth = spec.trim + rw;
        const corner = add2(add2(p, u, at), w, -depth);
        if (sheet.p.relief === 'rectangular') tools.push(extrudeZ(rectFace(corner, u, rw, w, depth + eps), -eps, T + eps));
        else {
          tools.push(extrudeZ(rectFace(add2(corner, w, rw / 2), u, rw, w, depth - rw / 2 + eps), -eps, T + eps));
          const c = add2(add2(corner, w, rw / 2), u, rw / 2);
          tools.push(R.makeCylinder(rw / 2, T + 2 * eps, [c[0], c[1], -eps], [0, 0, 1]) as unknown as Sh);
        }
      }
    }
    const cutter = namedPiece(featId, tools.length === 1 ? tools[0] : fuseAll(tools), panel.xf, (d) => (d.type === 'plane' && Math.abs(dot2([d.d[0], d.d[1]], w)) > 1 - 1e-6 ? `${tag}:trim` : `${tag}:relief`));
    h.applyTool(featId, st, cutter.solid, cutter.faces, true);
    panelFace = cut(panel.face, strip);
  }
  const b: SmBend = {
    id: `${featId}:${tag}`, feature: featId, fixed: panel.id, moving: `${featId}:${tag}`, s0, u, w, length: t1 - t0,
    width: bendAllowance(spec.angle, spec.radius, sheet.p), angle: spec.angle, radius: spec.radius, up,
  };
  if (!(b.width > 0)) throw h.error('The bend allowance must be greater than zero');
  const xf = xfCompose(panel.xf, bendMotion(b, T));
  const face = rectFace(add2(s0, w, b.width), u, b.length, w, spec.straight);
  const side = (c: SurfDesc['center']) => (dot2([c[0] - s0[0], c[1] - s0[1]], u) < b.length / 2 ? `${tag}:side0` : `${tag}:side1`);
  const bend = namedPiece(featId, bendSolid(b, T), panel.xf, (d) => {
    if (d.type === 'cylinder') return `${tag}:bend:${near(d.r, b.radius, 1e-6 * T + 1e-9) ? 'in' : 'out'}`;
    if (d.type === 'plane' && Math.abs(dot2([d.d[0], d.d[1]], u)) > 1 - 1e-6) return side(d.center);
    return `${tag}:joint`;
  });
  const flange = namedPiece(featId, extrudeZ(face, 0, T), xf, (d) => {
    if (Math.abs(d.d[2]) > 1 - 1e-6) return `${tag}:flange:${(d.center[2] > T / 2) === up ? 'in' : 'out'}`;
    if (Math.abs(dot2([d.d[0], d.d[1]], u)) > 1 - 1e-6) return side(d.center);
    return dot2([d.center[0] - s0[0], d.center[1] - s0[1]], w) > b.width + spec.straight / 2 ? `${tag}:end` : `${tag}:joint`;
  });
  const tool = fuse(bend.solid, flange.solid);
  // The bend only touches its panel; material inside the new wall is the part it runs into.
  if (volumeOf(common(st.body!, tool)) > 1e-6 * volumeOf(tool)) throw h.error(`The ${what} runs into the part. Shorten it, change its angle or reverse its direction.`);
  h.applyTool(featId, st, tool, [...bend.faces, ...flange.faces], false);
  st.sheet = replacePanels(sheet, [...sheet.panels.map((x) => (x === panel ? { ...x, face: panelFace } : x)), { id: b.moving, face, xf }], [...sheet.bends, b]);
}

function applyEdgeFlange(h: SheetHost, f: EdgeFlangeFeature, st: SmState) {
  const sheet = sheetOf(h, st, 'An edge flange');
  if (!f.edges.length) throw h.error('Select one or more edges of the sheet');
  const T = sheet.p.thickness, R0 = sheet.p.radius;
  const angle = num(h, f.angle, 'Angle');
  if (!(angle > 0 && angle < 180)) throw h.error('The flange angle must be more than 0 and less than 180 degrees');
  const length = num(h, f.length, 'Flange length');
  if (!(length > 0)) throw h.error('The flange length must be greater than zero');
  const trim = f.position === 'materialInside' ? setback(angle, R0 + T) : f.position === 'materialOutside' ? setback(angle, R0) : 0;
  const straight = length - (f.lengthRef === 'outer' ? setback(angle, R0 + T) : f.lengthRef === 'inner' ? setback(angle, R0) : 0);
  const offset1 = num(h, f.offset1, 'Offset 1'), offset2 = num(h, f.offset2, 'Offset 2');
  if (offset1 < 0 || offset2 < 0) throw h.error('Offsets cannot be negative');
  f.edges.forEach((ref, k) => addFlange(h, st, f.id, k, ref, { angle, radius: R0, trim, straight, flip: f.flip, offset1, offset2 }, 'flange'));
}

function applyHem(h: SheetHost, f: HemFeature, st: SmState) {
  const sheet = sheetOf(h, st, 'A hem');
  if (!f.edges.length) throw h.error('Select one or more edges of the sheet');
  const T = sheet.p.thickness;
  const gap = f.kind === 'closed' ? CLOSED_HEM_GAP * T : num(h, f.gap, 'Gap');
  if (!(gap > 0)) throw h.error('The gap of an open hem must be greater than zero');
  const length = num(h, f.length, 'Length');
  if (!(length > 0)) throw h.error('The hem length must be greater than zero');
  const radius = gap / 2;
  const straight = length - (radius + T);
  const trim = f.position === 'materialInside' ? radius + T : 0;
  f.edges.forEach((ref, k) => addFlange(h, st, f.id, k, ref, { angle: 180, radius, trim, straight, flip: f.flip, offset1: 0, offset2: 0 }, 'hem'));
}

// ---- sketched bend ----

function applySketchedBend(h: SheetHost, f: SketchedBendFeature, st: SmState) {
  const sheet = sheetOf(h, st, 'A sketched bend');
  const body = st.body!;
  const sketch = st.sketches.get(f.sketch);
  const frame = st.frames.get(f.sketch);
  if (!sketch || !frame) throw h.missing(f.sketch, 'bend line sketch');
  const lines = sketch.entities.filter((e) => e.t === 'line' && !e.construction);
  const others = sketch.entities.filter((e) => e.t !== 'point' && e.t !== 'line' && !e.construction);
  if (lines.length !== 1 || others.length) throw h.error('Sketch a single line for the bend');
  const line = lines[0] as Extract<typeof lines[number], { t: 'line' }>;
  const pt = (id: Id): Vec2 => { const e = sketch.entities.find((x) => x.id === id); return e && e.t === 'point' ? [e.x, e.y] : [NaN, NaN]; };
  const A = toWorld3(frame, pt(line.a)), B = toWorld3(frame, pt(line.b));
  const T = sheet.p.thickness, Rb = sheet.p.radius;
  const angle = num(h, f.angle, 'Angle');
  if (!(angle > 0 && angle < 180)) throw h.error('The bend angle must be more than 0 and less than 180 degrees');
  const on = panelOfPlane(sheet, frame, scale(add(A, B), 0.5));
  if (!on) throw h.error('Sketch the bend line on a flat face of the sheet metal part');
  const { panel } = on;
  const la = xfLocal(panel.xf, A), lb = xfLocal(panel.xf, B);
  let u: Vec2 = [lb[0] - la[0], lb[1] - la[1]];
  const ul = Math.hypot(u[0], u[1]);
  if (ul < 1e-9) throw h.error('The bend line has no length');
  u = [u[0] / ul, u[1] / ul];
  // The same direction whichever end the line was drawn from; the fixed side is to its left.
  if (u[0] < -1e-9 || (Math.abs(u[0]) <= 1e-9 && u[1] < 0)) u = [-u[0], -u[1]];
  let w: Vec2 = [u[1], -u[0]];
  if (f.flipFixed) w = [-w[0], -w[1]];
  const up = on.top !== f.flip;
  const width = bendAllowance(angle, Rb, sheet.p);
  if (!(width > 0)) throw h.error('The bend allowance must be greater than zero');
  const start = f.position === 'centerline' ? -width / 2 : f.position === 'materialInside' ? -setback(angle, Rb + T) : f.position === 'materialOutside' ? -setback(angle, Rb) : 0;
  // Half-planes of the panel's flat face beside and across the bend strip.
  const box = subShapes(panel.face, 'vertex').length ? flatExtent(panel.face) : 1000;
  const big = box * 4 + width * 4;
  const origin: Vec2 = add2([la[0], la[1]], w, start);
  const half = (from: number, to: number) => rectFace(add2(add2(origin, u, -big), w, from), u, 2 * big, w, to - from);
  const fixedFace = common(panel.face, half(-big, 0));
  const stripFace = common(panel.face, half(0, width));
  const movingFace = common(panel.face, half(width, big));
  if (isEmpty(fixedFace) || isEmpty(movingFace) || isEmpty(stripFace)) throw h.error('The bend line must divide the face in two, with room for the bend on both sides');
  // The bend strip must cross the face straight: a rectangle as wide as the bend allowance.
  const ts = subShapes(stripFace, 'vertex').map((v) => { const q = vertexPoint(v); return dot2([q[0] - origin[0], q[1] - origin[1]], u); });
  const u0 = Math.min(...ts), u1 = Math.max(...ts);
  if (Math.abs(area(stripFace) - width * (u1 - u0)) > 1e-6 * Math.max(1, width * (u1 - u0))) {
    throw h.error('The bend must cross the face where its edges are square to the bend line, without holes or notches in the bend region');
  }
  const b: SmBend = {
    id: `${f.id}:b`, feature: f.id, fixed: panel.id, moving: `${f.id}:p`, s0: add2(origin, u, u0), u, w, length: u1 - u0, width, angle, radius: Rb, up,
  };
  // Bends of the panel go with the side they start from.
  const side = (q: Vec2) => dot2([q[0] - origin[0], q[1] - origin[1]], w);
  const bends = sheet.bends.map((x) => {
    if (x.fixed !== panel.id && x.moving !== panel.id) return x;
    const m = x.fixed === panel.id ? add2(x.s0, x.u, x.length / 2) : add2(add2(x.s0, x.u, x.length / 2), x.w, x.width);
    const s = side(m);
    if (s > -1e-6 && s < width + 1e-6) throw h.error('The bend is too close to another bend');
    if (s < 0) return x;
    return x.fixed === panel.id ? { ...x, fixed: b.moving } : { ...x, moving: b.moving };
  });
  // Everything joined to the moving side moves with it.
  const moving = new Set<string>([b.moving]);
  for (let grew = true; grew;) {
    grew = false;
    for (const x of bends) {
      for (const [p0, p1] of [[x.fixed, x.moving], [x.moving, x.fixed]]) if (moving.has(p0) && !moving.has(p1) && p1 !== panel.id) { moving.add(p1); grew = true; }
    }
  }
  const motion = bendMotion(b, T);
  const G = xfCompose(xfCompose(panel.xf, motion), xfInverse(panel.xf));
  const eps = Math.max(T * 0.01, 1e-4);
  const prism = (face: Sh, xf: Frame) => placed(extrudeZ(face, -eps, T + eps), xf);
  const region: Sh[] = [prism(movingFace, panel.xf)];
  for (const x of sheet.panels) if (x !== panel && moving.has(x.id)) region.push(prism(x.face, x.xf));
  for (const x of bends) {
    if (!moving.has(x.fixed) || !moving.has(x.moving)) continue;
    const xfFixed = x.fixed === b.moving ? panel.xf : sheet.panels.find((q) => q.id === x.fixed)!.xf;
    const eIn = Math.min(eps, x.radius * 0.5);
    region.push(placed(bendSolid(x, T, x.up ? -eps : -eIn, x.up ? T + eIn : T + eps), xfFixed));
  }
  const movingRegion = fuseAll(region);
  const strip = prism(stripFace, panel.xf);
  const moved = common(body, movingRegion);
  if (isEmpty(moved)) throw h.error('There is no material on the side of the bend that moves');
  const kept = cut(body, fuse(movingRegion, strip));
  const stripVolume = volumeOf(common(body, strip));
  if (stripVolume < area(stripFace) * T * (1 - 1e-6)) h.warn('Cuts in the bend region were filled in by the bend');
  const keptNames = new Set(h.nameFaces(f.id, kept, st, []).map((x) => x.name));
  const movedFaces = h.nameFaces(f.id, moved, st, []).map((x) => {
    const shape = placed(x.shape, G);
    return { shape, desc: describeFace(shape), name: keptNames.has(x.name) ? `${f.id}:m:${x.name}` : x.name, feature: x.feature };
  });
  const bendPiece = namedPiece(f.id, bendSolid(b, T), panel.xf, (d) => {
    if (d.type === 'cylinder') return `bend:${near(d.r, b.radius, 1e-6 * T + 1e-9) ? 'in' : 'out'}`;
    return 'bend:side';
  });
  const result = fuseAll([kept, placed(moved, G), bendPiece.solid]);
  st.faces = h.nameFaces(f.id, result, st, [...movedFaces, ...bendPiece.faces]);
  st.body = result;
  st.edges = null;
  const panels: SmPanel[] = [];
  for (const x of sheet.panels) {
    if (x === panel) panels.push({ ...x, face: fixedFace }, { id: b.moving, face: movingFace, xf: xfCompose(panel.xf, motion) });
    else panels.push(moving.has(x.id) ? { ...x, xf: xfCompose(G, x.xf) } : x);
  }
  st.sheet = replacePanels(sheet, panels, [...bends, b]);
}

function flatExtent(face: Sh): number {
  let m = 0;
  for (const v of subShapes(face, 'vertex')) {
    const p = vertexPoint(v);
    m = Math.max(m, Math.abs(p[0]), Math.abs(p[1]));
  }
  return m;
}

// ---- flat pattern ----

const NOT_SHOWN = 'Material the flat pattern cannot show is left out: features that change the bends (such as cuts across a bend) or add material off the sheet.';

/** The flat pattern of the sheet as built, with the solid to show it. */
export function flatPattern(st: SmState): { pattern: FlatPattern; solid: Sh } | { error: string } {
  const sheet = st.sheet;
  if (!sheet) return { error: 'This part has no sheet metal features' };
  const body = st.body;
  if (!body) return { error: 'The sheet metal part failed to build' };
  const T = sheet.p.thickness;
  const notes: string[] = [];
  const pieces: Sh[] = [];
  let expected = 0;
  for (const panel of sheet.panels) {
    const mid = placed(translated(panel.face, [0, 0, T / 2]), panel.xf);
    const sec = common(body, mid);
    if (isEmpty(sec)) continue;
    const flat = translated(placed(sec, xfInverse(panel.xf)), [0, 0, -T / 2]);
    for (const face of subShapes(flat, 'face')) { pieces.push(facingUp(face)); expected += faceProps(face.wrapped).area * T; }
  }
  const bends: FlatBend[] = [];
  for (const b of sheet.bends) {
    pieces.push(facingUp(rectFace(b.s0, b.u, b.length, b.w, b.width)));
    expected += ((b.angle * Math.PI) / 180) * T * (b.radius + T / 2) * b.length;
    const a = add2(b.s0, b.w, b.width / 2);
    bends.push({ a, b: add2(a, b.u, b.length), up: b.up, angle: b.angle, radius: b.radius, allowance: b.width, feature: b.feature });
  }
  if (!pieces.length) return { error: 'The sheet has no material left' };
  const flat = pieces.length === 1 ? pieces[0] : unified(fuseAll(pieces));
  const faces = subShapes(flat, 'face');
  const pieceArea = pieces.reduce((s, x) => s + faceProps(x.wrapped).area, 0);
  const flatArea = faces.reduce((s, x) => s + faceProps(x.wrapped).area, 0);
  if (pieceArea - flatArea > 1e-6 * Math.max(1, flatArea)) notes.push('Some regions of the sheet overlap when it is flattened.');
  const v = volumeOf(body);
  if (Math.abs(v - expected) > 1e-4 * Math.max(1, v)) notes.push(NOT_SHOWN);
  const loops: FlatLoop[] = [];
  const oc = getOc();
  let min: Vec2 = [Infinity, Infinity], max: Vec2 = [-Infinity, -Infinity];
  for (const face of faces) {
    const outer = oc.BRepTools.OuterWire(face.wrapped);
    for (const wire of subShapes(face, 'wire')) {
      const segs: FlatSeg[] = [];
      for (const e of subShapes(wire, 'edge')) {
        const d = describeEdge(e);
        const two = (p: Vec3): Vec2 => [p[0], p[1]];
        if (d.type === 'line') segs.push({ k: 'line', a: two(d.a), b: two(d.b) });
        else if (d.type === 'circle' && d.closed) segs.push({ k: 'circle', c: two(d.center!), r: d.radius! });
        else if (d.type === 'circle') {
          const c = two(d.center!);
          const ang = (p: Vec3) => Math.atan2(p[1] - c[1], p[0] - c[0]);
          const ccw = d.axis![2] > 0;
          segs.push({ k: 'arc', c, r: d.radius!, a0: ang(ccw ? d.a : d.b), a1: ang(ccw ? d.b : d.a) });
        } else {
          const pts = edgePoints(e, 48);
          for (let i = 0; i + 1 < pts.length; i++) segs.push({ k: 'line', a: two(pts[i]), b: two(pts[i + 1]) });
        }
      }
      for (const s of segs) {
        const pts: Vec2[] = s.k === 'line' ? [s.a, s.b] : s.k === 'circle' ? [[s.c[0] - s.r, s.c[1] - s.r], [s.c[0] + s.r, s.c[1] + s.r]] : arcBox(s);
        for (const p of pts) { min = [Math.min(min[0], p[0]), Math.min(min[1], p[1])]; max = [Math.max(max[0], p[0]), Math.max(max[1], p[1])]; }
      }
      loops.push({ outer: wire.wrapped.IsSame(outer), segs });
    }
    outer.delete?.();
  }
  const solid = fuseAll(faces.map((x) => extrudeZ(x, 0, T)));
  const base = sheet.panels[0];
  return { pattern: { loops, bends, thickness: T, min, max, notes, placement: base.xf }, solid: placed(solid, base.xf) };
}

function arcBox(s: Extract<FlatSeg, { k: 'arc' }>): Vec2[] {
  const out: Vec2[] = [];
  let a1 = s.a1;
  while (a1 <= s.a0) a1 += 2 * Math.PI;
  const at = (a: number): Vec2 => [s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)];
  out.push(at(s.a0), at(a1));
  for (let k = Math.ceil(s.a0 / (Math.PI / 2)); k * (Math.PI / 2) < a1; k++) out.push(at(k * (Math.PI / 2)));
  return out;
}
