/* eslint-disable @typescript-eslint/no-explicit-any */
// Weldment features: structural members swept along sketch segments, with
// corner treatments, trimming and extending, end caps and gussets.
//
// Each member is built as a solid of its own (so members can be trimmed
// against each other and measured), then fused into the part's single body
// like any boss. What the cut list needs (profile, length, end angles,
// volume) is kept per member in the build state, so it does not need
// separate bodies.
//
// A member runs along a line or arc of a sketch. Its frame at a point of the
// path: D along the path, V the sketch plane normal, U = V × D. The placed
// profile (pierce point at the origin) is drawn in (U, V). Each end of a
// member is cut by one or more planes whose normals point out of the member.

import * as R from 'replicad';
import type { Frame, Vec3 } from '../math/vec';
import { add, cross, dist, dot, len, normalize, perpendicular, scale, sub, toWorld } from '../math/vec';
import type {
  EdgeRef, EndCapFeature, FaceRef, GussetFeature, Id, MemberRef, SkEntity, StructuralMemberFeature, TrimExtendFeature, WeldBeadFeature,
} from '../model/types';
import {
  type PSeg, type Placement, type PiercePoint, type ProfileDims, type ProfileShape, PIERCE_POINTS, findProfile, isHollow, outlineMax,
  outlinePoints, placeProfile, piercePointOf, placeWith, profileShape, sectionProps,
} from '../model/weldment-profiles';
import { type WeldMemberInfo, memberKey, memberOfFace, sameMember } from '../model/weldments';
import { SketchIndex } from '../sketch/geom';
import { type EdgeDesc, type Sh, type SurfDesc, getOc, pnt, bbox, compound, cut, fuse, fuseAll, isEmpty, rotated, volumeOf } from './occ';

export interface Plane {
  p: Vec3;
  /** Points out of the member. */
  n: Vec3;
}

export interface MemberEnd {
  planes: Plane[];
  /** Solids cut from the end (a coped end follows the member it meets). */
  copes: Sh[];
}

export type MemberPath =
  | { kind: 'line'; a: Vec3; d: Vec3; len: number; v: Vec3 }
  /** Arc from a, turning about axis (through c) by sweep radians. */
  | { kind: 'arc'; c: Vec3; axis: Vec3; r: number; a: Vec3; sweep: number; v: Vec3 };

export interface WeldMember {
  feature: Id;
  key: string;
  group: number;
  standard: string;
  profile: string;
  size: string;
  desc: string;
  dims: ProfileDims;
  placement: Placement;
  /** The profile as placed on the path (pierce point at the origin). */
  shape: ProfileShape;
  area: number;
  path: MemberPath;
  ends: [MemberEnd, MemberEnd];
  solid: Sh;
  info: WeldMemberInfo;
}

export interface WeldState {
  members: WeldMember[];
  /** End caps and gussets: kept so a trim can put back what it took from them. */
  extras: Sh[];
}

/** What the weldment features need from the model builder. */
export interface WeldCtx {
  st: { body: Sh | null; weld?: WeldState };
  featureId: Id;
  /** A sketch as built (throws the builder's "missing" error). */
  sketch(id: Id): { entities: SkEntity[]; frame: Frame };
  face(ref: FaceRef): { name: string; desc: SurfDesc };
  /** An edge and the faces it separates. */
  edge(ref: EdgeRef): { desc: EdgeDesc; faces: { desc: SurfDesc; shape: Sh }[] };
  /** Names a tool's faces "<prefix>:<classify(k)>". */
  nameTool(prefix: Id, shape: Sh, classify: (k: number) => string): unknown[];
  applyTool(tool: Sh, faces: unknown[], noGain?: string): void;
  /** Replaces the body, naming its faces after the previous body and the given faces. */
  setBody(body: Sh, faces: unknown[]): void;
  /** The body before a feature was built. */
  bodyBefore(id: Id): Sh | null;
  warn(msg: string): void;
  err(msg: string): Error;
  /** A feature's name in a message. */
  name(id: Id): string;
}

// ---------- small vector helpers ----------

function rotateAbout(v: Vec3, axis: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang), s = Math.sin(ang);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}

/** A finite number from a resolved parameter (a damaged file may hold text). */
function value(ctx: WeldCtx, v: unknown, label: string): number {
  const x = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(x)) throw ctx.err(`${label} has an invalid value`);
  return x;
}

// ---------- paths ----------

function pathEnd(p: MemberPath, e: 0 | 1): Vec3 {
  if (p.kind === 'line') return e ? add(p.a, scale(p.d, p.len)) : p.a;
  return e ? add(p.c, rotateAbout(sub(p.a, p.c), p.axis, p.sweep)) : p.a;
}

/** Frame of the path at a parameter (length along a line, angle along an arc). */
function frameAt(p: MemberPath, t: number): { o: Vec3; D: Vec3; U: Vec3; V: Vec3 } {
  if (p.kind === 'line') {
    const U = cross(p.v, p.d);
    return { o: add(p.a, scale(p.d, t)), D: p.d, U, V: p.v };
  }
  const o = add(p.c, rotateAbout(sub(p.a, p.c), p.axis, t));
  const D = normalize(cross(p.axis, sub(o, p.c)));
  return { o, D, U: cross(p.v, D), V: p.v };
}

const pathLength = (p: MemberPath) => (p.kind === 'line' ? p.len : p.sweep);

/** End point, outward direction and cross-section axes at an end. */
function endFrame(p: MemberPath, e: 0 | 1): { P: Vec3; a: Vec3; U: Vec3; V: Vec3 } {
  const f = frameAt(p, e ? pathLength(p) : 0);
  return { P: f.o, a: e ? f.D : scale(f.D, -1), U: f.U, V: f.V };
}

function reversePath(p: MemberPath): MemberPath {
  if (p.kind === 'line') return { ...p, a: pathEnd(p, 1), d: scale(p.d, -1) };
  return { ...p, a: pathEnd(p, 1), axis: scale(p.axis, -1) };
}

/** Closest point of the path to x: its parameter and distance. */
function closestOnPath(p: MemberPath, x: Vec3): { t: number; d: number; q: Vec3 } {
  if (p.kind === 'line') {
    const t = Math.max(0, Math.min(p.len, dot(sub(x, p.a), p.d)));
    const q = add(p.a, scale(p.d, t));
    return { t, d: dist(q, x), q };
  }
  const rel = sub(x, p.c);
  const inPlane = sub(rel, scale(p.axis, dot(rel, p.axis)));
  const r0 = sub(p.a, p.c);
  let ang = Math.atan2(dot(cross(r0, inPlane), p.axis), dot(r0, inPlane));
  if (ang < 0) ang += 2 * Math.PI;
  // Past the end: the nearer end.
  if (ang > p.sweep) ang = ang - p.sweep < 2 * Math.PI - ang ? p.sweep : 0;
  const q = add(p.c, rotateAbout(r0, p.axis, ang));
  return { t: ang, d: dist(q, x), q };
}

/** Linear function of profile coordinates: k + g·(x, y). */
interface Lin { k: number; g: [number, number] }

const linMax = (outer: PSeg[], f: Lin) => f.k + outlineMax(outer, f.g);
const linMin = (outer: PSeg[], f: Lin) => f.k - outlineMax(outer, [-f.g[0], -f.g[1]]);

/**
 * Where profile point (x, y) of an end's cross-section meets a plane, as a
 * distance along the outward direction from the end point.
 */
function reach(fr: { P: Vec3; a: Vec3; U: Vec3; V: Vec3 }, pl: Plane): Lin {
  const an = dot(fr.a, pl.n);
  return { k: dot(sub(pl.p, fr.P), pl.n) / an, g: [-dot(fr.U, pl.n) / an, -dot(fr.V, pl.n) / an] };
}

/** How far past an end point the member reaches (max over its outline; several planes cut in turn). */
function endReach(m: { shape: ProfileShape; path: MemberPath }, e: 0 | 1, planes: Plane[]): number {
  const fr = endFrame(m.path, e);
  const lins = planes.map((pl) => reach(fr, pl));
  if (lins.length === 1) return linMax(m.shape.outer, lins[0]);
  let best = -Infinity;
  for (const q of outlinePoints(m.shape.outer, 2)) best = Math.max(best, Math.min(...lins.map((l) => l.k + l.g[0] * q[0] + l.g[1] * q[1])));
  return best;
}

/** Degrees between an end's direction and its first cutting plane's normal (0: square). */
function endAngle(path: MemberPath, e: 0 | 1, end: MemberEnd): number {
  const pl = end.planes[0];
  if (!pl) return 0;
  const c = Math.min(1, Math.abs(dot(endFrame(path, e).a, pl.n)));
  const deg = (Math.acos(c) * 180) / Math.PI;
  return deg < 1e-7 ? 0 : deg;
}

// ---------- solids ----------

function p3(o: Vec3, U: Vec3, V: Vec3, q: [number, number]): Vec3 {
  return add(o, add(scale(U, q[0]), scale(V, q[1])));
}

function segEdge(s: PSeg, o: Vec3, U: Vec3, V: Vec3, D: Vec3): any {
  if (s.k === 'line') return R.makeLine(p3(o, U, V, s.a), p3(o, U, V, s.b));
  const at = (t: number): [number, number] => [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)];
  if (Math.abs(s.a1 - s.a0) >= 2 * Math.PI - 1e-9) return R.makeCircle(s.r, p3(o, U, V, s.c), s.a1 > s.a0 ? D : scale(D, -1));
  return R.makeThreePointArc(p3(o, U, V, at(s.a0)), p3(o, U, V, at((s.a0 + s.a1) / 2)), p3(o, U, V, at(s.a1)));
}

/** The profile as a face in a cross-section plane. */
function profileFace(shape: ProfileShape, o: Vec3, U: Vec3, V: Vec3, D: Vec3, outerOnly = false): any {
  const wire = (loop: PSeg[]) => R.assembleWire(loop.map((s) => segEdge(s, o, U, V, D)));
  let face = R.makeFace(wire(shape.outer));
  if (!outerOnly && shape.holes.length) face = R.addHolesInFace(face, shape.holes.map(wire));
  return face;
}

/** A large box on the outer side of a plane, around a point of it. */
function halfSpaceBox(pl: Plane, near: Vec3, size: number): Sh {
  const c = sub(near, scale(pl.n, dot(sub(near, pl.p), pl.n)));
  const e1 = perpendicular(pl.n);
  const e2 = cross(pl.n, e1);
  const corner = (i: number, j: number) => add(c, add(scale(e1, i * size), scale(e2, j * size)));
  const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  const face = R.makeFace(R.assembleWire(pts.map((p, i) => R.makeLine(p, pts[(i + 1) % 4]))));
  return R.basicFaceExtrusion(face, new R.Vector(scale(pl.n, size * 2))) as unknown as Sh;
}

/** Largest distance of the profile from its pierce point. */
function profileRadius(shape: ProfileShape): number {
  let r = 0;
  for (const q of outlinePoints(shape.outer, 10)) r = Math.max(r, Math.hypot(q[0], q[1]));
  return r;
}

/**
 * An end cut square by one plane: a straight member is swept exactly to it.
 * An arc member's sweep ends on a plane through its end point only (past the
 * end, a sweep's end face turns about the arc's axis).
 */
const isSquare = (fr: { P: Vec3; a: Vec3 }, end: MemberEnd, tol: number, line: boolean) =>
  end.planes.length === 1 && !end.copes.length && dot(fr.a, end.planes[0].n) > 1 - 1e-12 && (line || Math.abs(dot(sub(end.planes[0].p, fr.P), end.planes[0].n)) < tol);

/** The member's solid: the profile swept along its path past both ends, cut by its end planes. */
function memberSolid(ctx: WeldCtx, m: Pick<WeldMember, 'shape' | 'path' | 'ends' | 'key'>, outerOnly = false): Sh {
  const { path, shape } = m;
  const size = profileRadius(shape);
  const margin = 1 + size * 0.05;
  const cuts: Plane[] = [];
  let solid: Sh;
  // Distance each end reaches past its end point; square ends are swept exactly.
  const ext = ([0, 1] as const).map((e) => {
    const fr = endFrame(path, e);
    const end = m.ends[e];
    for (const pl of end.planes) {
      if (dot(fr.a, pl.n) < 1e-6) throw ctx.err(`An end of a member is cut along its length. Check the trim faces and corner treatment.`);
    }
    if (isSquare(fr, end, 1e-9 * (1 + len(fr.P)), path.kind === 'line')) return dot(sub(end.planes[0].p, fr.P), fr.a);
    cuts.push(...end.planes);
    let far = -Infinity;
    for (const pl of end.planes) far = Math.max(far, linMax(shape.outer, reach(fr, pl)));
    if (end.copes.length) far = Math.max(far, size * 2);
    return far + margin;
  });
  if (path.kind === 'line') {
    const t0 = -ext[0], t1 = path.len + ext[1];
    if (t1 - t0 < 1e-6) throw ctx.err(`A member has no length left after trimming`);
    const f = frameAt(path, t0);
    const face = profileFace(shape, f.o, f.U, f.V, f.D, outerOnly);
    solid = R.basicFaceExtrusion(face, new R.Vector(scale(path.d, t1 - t0))) as unknown as Sh;
  } else {
    // Radii of the profile about the arc's axis: it must stay clear of the axis.
    const f0 = frameAt(path, 0);
    const radial = normalize(sub(f0.o, path.c));
    const s = dot(f0.U, radial);
    const inner = path.r - outlineMax(shape.outer, [-s, 0]);
    if (inner <= 1e-6 * path.r) throw ctx.err(`The profile does not fit inside the arc: make the arc radius larger than the profile`);
    const room = 2 * Math.PI - path.sweep;
    let d0 = Math.max(0, ext[0]) / inner, d1 = Math.max(0, ext[1]) / inner;
    if (ext[0] < 0) d0 = ext[0] / path.r;
    if (ext[1] < 0) d1 = ext[1] / path.r;
    if (d0 + d1 > room - 1e-3) {
      const k = Math.max(0, room - 1e-3) / (d0 + d1);
      if (d0 > 0) d0 *= k;
      if (d1 > 0) d1 *= k;
    }
    const total = path.sweep + d0 + d1;
    if (total <= 1e-6) throw ctx.err(`A member has no length left after trimming`);
    const f = frameAt(path, -d0);
    const face = profileFace(shape, f.o, f.U, f.V, f.D, outerOnly);
    solid = R.revolution(face, path.c, path.axis, (total * 180) / Math.PI) as unknown as Sh;
  }
  const mid = frameAt(path, pathLength(path) / 2).o;
  const big = (size + Math.max(...ext.map(Math.abs)) + (path.kind === 'line' ? path.len : path.r * 2)) * 2 + 10;
  for (const pl of cuts) solid = cut(solid, halfSpaceBox(pl, mid, big));
  for (const e of [0, 1] as const) for (const c of m.ends[e].copes) solid = cut(solid, c);
  if (isEmpty(solid)) throw ctx.err(`A member has no length left after trimming`);
  return solid;
}

/** Overall length of a member along its axis (long point to long point). */
function memberLength(m: Pick<WeldMember, 'shape' | 'path' | 'ends' | 'solid'>): number {
  const coped = m.ends.some((e) => e.copes.length);
  if (m.path.kind === 'line') {
    if (coped) {
      // The cope's surface decides: measure the solid along the member.
      const z: Vec3 = [0, 0, 1];
      const d = m.path.d;
      const ax = cross(d, z);
      const s = len(ax);
      const turned = s < 1e-12 ? (dot(d, z) > 0 ? m.solid : rotated(m.solid, [0, 0, 0], [1, 0, 0], Math.PI)) : rotated(m.solid, [0, 0, 0], scale(ax, 1 / s), Math.atan2(s, dot(d, z)));
      const b = bbox(turned);
      return b ? b.max[2] - b.min[2] : 0;
    }
    return m.path.len + endReach(m, 0, m.ends[0].planes) + endReach(m, 1, m.ends[1].planes);
  }
  // An arc member: along the path of its centroid.
  const path = m.path;
  const c = sectionProps(m.shape).centroid;
  const f0 = frameAt(path, 0);
  const radial = normalize(sub(f0.o, path.c));
  const rc = Math.abs(path.r + c[0] * dot(f0.U, radial));
  let s = rc * path.sweep;
  for (const e of [0, 1] as const) {
    const fr = endFrame(path, e);
    const pl = m.ends[e].planes;
    if (pl.length) s += Math.min(...pl.map((p) => { const l = reach(fr, p); return l.k + l.g[0] * c[0] + l.g[1] * c[1]; })) * (rc / path.r);
  }
  return s;
}

function memberInfo(m: Omit<WeldMember, 'info'>): WeldMemberInfo {
  return {
    feature: m.feature, member: m.key, group: m.group, standard: m.standard, profile: m.profile, size: m.size, desc: m.desc,
    length: memberLength(m), angle1: endAngle(m.path, 0, m.ends[0]), angle2: endAngle(m.path, 1, m.ends[1]),
    volume: volumeOf(m.solid), area: m.area, ...(m.path.kind === 'arc' ? { curved: true } : {}),
  };
}

function finishMember(ctx: WeldCtx, m: Omit<WeldMember, 'info' | 'solid'>): WeldMember {
  const solid = memberSolid(ctx, m);
  const full = { ...m, solid };
  return { ...full, info: memberInfo(full) };
}

// ---------- joints ----------

/** Cross-section frame of a member at the point of its path nearest x. */
function sectionAt(m: { path: MemberPath }, x: Vec3) {
  const c = closestOnPath(m.path, x);
  const f = frameAt(m.path, c.t);
  return { ...f, P: c.q, dist: c.d, t: c.t };
}

/**
 * The plane a member ending at P (outward direction a) is trimmed to where it
 * meets member S: the face of S toward it, set back by the gap. Null when
 * the two run in line.
 */
function trimPlane(S: { shape: ProfileShape; path: MemberPath }, P: Vec3, a: Vec3, gap: number): Plane | null {
  const s = sectionAt(S, P);
  const perp = sub(a, scale(s.D, dot(a, s.D)));
  if (len(perp) < 1e-6) return null;
  const w = normalize(perp);
  const near = linMin(S.shape.outer, { k: 0, g: [dot(s.U, w), dot(s.V, w)] });
  return { p: add(s.P, scale(w, near - gap)), n: w };
}

/** How far a member running through a joint must reach past P to cover the end of the member trimmed to it. */
function throughReach(T: { shape: ProfileShape; path: MemberPath }, te: 0 | 1, tPlane: Plane, P: Vec3, b: Vec3): number {
  const fr = endFrame(T.path, te);
  const a = fr.a, w = tPlane.n;
  const aw = dot(a, w);
  if (Math.abs(aw) < 1e-9) return 0;
  const k = dot(a, b) / aw;
  const base = dot(sub(fr.P, P), b) + dot(sub(tPlane.p, fr.P), w) * k;
  const g: [number, number] = [dot(fr.U, b) - dot(fr.U, w) * k, dot(fr.V, b) - dot(fr.V, w) * k];
  return base + outlineMax(T.shape.outer, g);
}

// ---------- structural member ----------

interface Draft {
  key: string;
  group: number;
  path: MemberPath;
  ends: [MemberEnd, MemberEnd];
  /** Ends joined to another member (they are not cut square). */
  joined: [boolean, boolean];
  /** Free ends reaching past their end point to cover a member trimmed to them. */
  extend: [number, number];
}

const SEGMENT_KINDS: Record<string, string> = { circle: 'circles', spline: 'splines', point: 'points' };

export function applyStructuralMember(ctx: WeldCtx, f: StructuralMemberFeature): void {
  const prof = findProfile(f.standard, f.profile, f.size);
  if (!prof) throw ctx.err('Select a profile standard, type and size from the library');
  const pierce: PiercePoint = PIERCE_POINTS.some((p) => p.value === f.pierce) ? (f.pierce as PiercePoint) : 'centroid';
  const placement: Placement = { pierce, rotation: value(ctx, f.rotation, 'Rotation angle'), mirror: !!f.mirror };
  const raw = profileShape(f.profile, prof.dims);
  const shape = placeProfile(raw, placement);
  const area = sectionProps(raw).area;
  const gap = value(ctx, f.gap, 'Gap');
  const gap2 = f.trimGroups ? value(ctx, f.gap2, 'Gap between groups') : 0;
  if (gap < 0 || gap2 < 0) throw ctx.err('The gap cannot be negative');
  const segs = f.groups.flatMap((g, gi) => g.segments.map((s) => ({ s, gi })));
  if (!segs.length) throw ctx.err('Select sketch lines or arcs for the members');

  // Paths of the segments, in world coordinates.
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  const ixs = new Map<Id, { ix: SketchIndex; frame: Frame }>();
  let size = 1;
  for (const { s, gi } of segs) {
    const key = memberKey(s);
    if (seen.has(key)) throw ctx.err('A sketch segment is selected twice. Each segment makes one member.');
    seen.add(key);
    let sk = ixs.get(s.sketch);
    if (!sk) {
      const got = ctx.sketch(s.sketch);
      sk = { ix: new SketchIndex(got.entities), frame: got.frame };
      ixs.set(s.sketch, sk);
    }
    const e = sk.ix.get(s.entity);
    if (!e) throw ctx.err(`A selected segment is no longer in ${ctx.name(s.sketch)}. Edit the feature and select the segments again.`);
    if (e.t !== 'line' && e.t !== 'arc') throw ctx.err(`Members run along lines and arcs; ${SEGMENT_KINDS[e.t] ?? 'these curves'} cannot be member paths`);
    const fr = sk.frame;
    const w = (id: Id) => toWorld(fr, sk!.ix.pt(id));
    let path: MemberPath;
    if (e.t === 'line') {
      const a = w(e.a), b = w(e.b);
      const l = dist(a, b);
      if (l < 1e-9) throw ctx.err(`A selected line in ${ctx.name(s.sketch)} has no length`);
      path = { kind: 'line', a, d: scale(sub(b, a), 1 / l), len: l, v: fr.n };
    } else {
      const c2 = sk.ix.pt(e.c), a2 = sk.ix.pt(e.a), b2 = sk.ix.pt(e.b);
      const r = Math.hypot(a2[0] - c2[0], a2[1] - c2[1]);
      let sweep = Math.atan2(b2[1] - c2[1], b2[0] - c2[0]) - Math.atan2(a2[1] - c2[1], a2[0] - c2[0]);
      while (sweep <= 1e-12) sweep += 2 * Math.PI;
      if (r < 1e-9) throw ctx.err(`A selected arc in ${ctx.name(s.sketch)} has no radius`);
      path = { kind: 'arc', c: w(e.c), axis: fr.n, r, a: w(e.a), sweep, v: fr.n };
    }
    for (const q of [pathEnd(path, 0), pathEnd(path, 1)]) size = Math.max(size, ...q.map(Math.abs));
    const free = (): MemberEnd => ({ planes: [], copes: [] });
    drafts.push({ key, group: gi, path, ends: [free(), free()], joined: [false, false], extend: [0, 0] });
  }
  const tol = 1e-6 * size * 10;
  const same = (p: Vec3, q: Vec3) => dist(p, q) < tol;
  const shaped = (d: Draft) => ({ shape, path: d.path });

  // Orient each group's chains so members follow each other.
  const groups = f.groups.map((_, gi) => drafts.filter((d) => d.group === gi));
  for (const g of groups) {
    const done = new Set<Draft>();
    for (const first of g) {
      if (done.has(first)) continue;
      done.add(first);
      const queue = [first];
      while (queue.length) {
        const cur = queue.shift()!;
        const a = pathEnd(cur.path, 0), b = pathEnd(cur.path, 1);
        for (const o of g) {
          if (done.has(o)) continue;
          const oa = pathEnd(o.path, 0), ob = pathEnd(o.path, 1);
          let rev: boolean | null = null;
          if (same(oa, b) || same(ob, a)) rev = false;
          else if (same(ob, b) || same(oa, a)) rev = true;
          if (rev === null) continue;
          if (rev) o.path = reversePath(o.path);
          done.add(o);
          queue.push(o);
        }
      }
    }
  }

  // Corners within groups.
  for (const g of groups) {
    const ends = g.flatMap((d) => ([0, 1] as const).map((e) => ({ d, e, p: pathEnd(d.path, e) })));
    const used = new Set<number>();
    for (let i = 0; i < ends.length; i++) {
      if (used.has(i)) continue;
      const at = ends.flatMap((x, j) => (j !== i && !used.has(j) && x.d !== ends[i].d && same(x.p, ends[i].p) ? [j] : []));
      if (!at.length) continue;
      if (at.length > 1) throw ctx.err('Three or more members of a group meet at one point. Put the extra members in another group.');
      used.add(i); used.add(at[0]);
      let A = ends[i], B = ends[at[0]];
      // A arrives at the corner (its end), B leaves it (its start).
      if (A.e === 0 && B.e === 1) [A, B] = [B, A];
      const fa = endFrame(A.d.path, A.e), fb = endFrame(B.d.path, B.e);
      const P = fa.P;
      A.d.joined[A.e] = true;
      B.d.joined[B.e] = true;
      if (f.corner === 'miter') {
        const mv = sub(fa.a, fb.a);
        if (len(mv) < 1e-9) throw ctx.err('Two members of a group fold back on each other at a corner');
        const m = normalize(mv);
        A.d.ends[A.e].planes.push({ p: sub(P, scale(m, gap / 2)), n: m });
        B.d.ends[B.e].planes.push({ p: add(P, scale(m, gap / 2)), n: scale(m, -1) });
        continue;
      }
      // End butt 1: the arriving member runs through and the next one is trimmed to it; butt 2 the other way.
      const [S, se, T, te] = f.corner === 'butt1' ? [A, A.e, B, B.e] : [B, B.e, A, A.e];
      const fs = endFrame(S.d.path, se), ft = endFrame(T.d.path, te);
      const tp = trimPlane(shaped(S.d), P, ft.a, gap);
      if (!tp) {
        // Members in line: a square joint at the point.
        A.d.ends[A.e].planes.push({ p: sub(P, scale(fa.a, gap / 2)), n: fa.a });
        B.d.ends[B.e].planes.push({ p: sub(P, scale(fb.a, gap / 2)), n: fb.a });
        continue;
      }
      T.d.ends[te].planes.push(tp);
      const ext = throughReach(shaped(T.d), te, tp, P, fs.a);
      S.d.ends[se].planes.push({ p: add(P, scale(fs.a, ext)), n: fs.a });
    }
  }

  // Members of later groups trimmed or extended to members of earlier groups.
  if (f.trimGroups) {
    for (let gi = 1; gi < groups.length; gi++) {
      for (const T of groups[gi]) {
        for (const te of [0, 1] as const) {
          if (T.joined[te]) continue;
          const ft = endFrame(T.path, te);
          for (const S of groups.slice(0, gi).flat()) {
            const s = closestOnPath(S.path, ft.P);
            if (s.d > tol) continue;
            const tp = trimPlane(shaped(S), ft.P, ft.a, gap2);
            if (!tp) continue;
            T.ends[te].planes.push(tp);
            // A free end of S at the joint reaches out to cover T.
            for (const se of [0, 1] as const) {
              if (S.joined[se] || !same(pathEnd(S.path, se), ft.P)) continue;
              const fs = endFrame(S.path, se);
              S.extend[se] = Math.max(S.extend[se], throughReach(shaped(T), te, tp, fs.P, fs.a));
            }
          }
          if (T.ends[te].planes.length) T.joined[te] = true;
        }
      }
    }
  }

  // Free ends are cut square at their end points.
  for (const d of drafts) {
    for (const e of [0, 1] as const) {
      if (d.ends[e].planes.length) continue;
      const fr = endFrame(d.path, e);
      d.ends[e].planes.push({ p: add(fr.P, scale(fr.a, d.extend[e])), n: fr.a });
    }
  }

  const members = drafts.map((d) => finishMember(ctx, {
    feature: f.id, key: d.key, group: d.group, standard: f.standard, profile: f.profile, size: f.size, desc: prof.desc,
    dims: prof.dims, placement, shape, area, path: d.path, ends: d.ends,
  }));
  const named = members.flatMap((m) => ctx.nameTool(f.id, m.solid, (k) => `${m.key}:${k}`));
  const tool = members.length === 1 ? members[0].solid : fuseAll(members.map((m) => m.solid));
  ctx.applyTool(tool, named, 'The members add no material: they lie inside the part.');
  const prev = ctx.st.weld;
  ctx.st.weld = { members: [...(prev?.members ?? []), ...members], extras: prev?.extras ?? [] };
}

// ---------- trim / extend ----------

function findMember(ctx: WeldCtx, ref: MemberRef, what: string): WeldMember {
  const m = ctx.st.weld?.members.find((x) => sameMember({ feature: x.feature, member: x.key }, ref));
  if (!m) throw ctx.err(`A ${what} no longer exists. Edit the feature and select it again.`);
  return m;
}

/** Puts a changed member into the body: what the old one alone added is removed, the new one is fused. */
function replaceMember(ctx: WeldCtx, old: WeldMember, next: WeldMember, others: Sh[]): Sh {
  let body = ctx.st.body;
  if (!body) throw ctx.err('There is no body');
  // The part of the old member the new one leaves out, less what other features own there.
  let removed = cut(old.solid, next.solid);
  if (!isEmpty(removed)) {
    const keep = [ctx.bodyBefore(old.feature), ...others].filter((s): s is Sh => !!s && !isEmpty(s));
    if (keep.length) removed = cut(removed, keep.length === 1 ? keep[0] : compound(keep));
    if (!isEmpty(removed) && volumeOf(removed) > 1e-9) body = cut(body, removed);
  }
  return fuse(body, next.solid);
}

export function applyTrimExtend(ctx: WeldCtx, f: TrimExtendFeature): void {
  if (!ctx.st.weld?.members.length) throw ctx.err('There are no structural members to trim. Add a Structural Member first.');
  if (!f.members.length) throw ctx.err('Select the members to trim or extend');
  const targets = f.members.map((r) => findMember(ctx, r, 'member to trim'));
  const gap = value(ctx, f.gap, 'Gap');
  if (gap < 0) throw ctx.err('The gap cannot be negative');
  const planes: Plane[] = [];
  const bounds: WeldMember[] = [];
  if (f.boundary === 'faces') {
    if (!f.faces.length) throw ctx.err('Select the faces to trim to');
    for (const r of f.faces) {
      const fc = ctx.face(r);
      if (fc.desc.type !== 'plane') throw ctx.err('Members can be trimmed to planar faces only');
      planes.push({ p: fc.desc.p, n: fc.desc.d });
    }
  } else {
    if (!f.boundaryMembers.length) throw ctx.err('Select the members to trim to');
    for (const r of f.boundaryMembers) bounds.push(findMember(ctx, r, 'boundary member'));
  }
  let weld = ctx.st.weld;
  const faces: unknown[] = [];
  let short = 0;
  for (const target of targets) {
    const m = weld.members.find((x) => x.feature === target.feature && x.key === target.key)!;
    if (bounds.includes(m) || bounds.some((b) => b.feature === m.feature && b.key === m.key)) throw ctx.err('A member cannot be trimmed to itself');
    // The end nearer the boundary is the one trimmed.
    const dists = ([0, 1] as const).map((e) => {
      const P = pathEnd(m.path, e);
      const ds = [...planes.map((pl) => Math.abs(dot(sub(P, pl.p), pl.n))), ...bounds.map((b) => closestOnPath(b.path, P).d)];
      return Math.min(...ds);
    });
    const e: 0 | 1 = dists[1] < dists[0] ? 1 : 0;
    const fr = endFrame(m.path, e);
    const mid = frameAt(m.path, pathLength(m.path) / 2).o;
    const end: MemberEnd = { planes: [], copes: [] };
    if (planes.length) {
      // The nearest face's plane, facing away from the member.
      let best = planes[0], bd = Infinity;
      for (const pl of planes) { const d = Math.abs(dot(sub(fr.P, pl.p), pl.n)); if (d < bd) { bd = d; best = pl; } }
      const n = dot(sub(mid, best.p), best.n) > 0 ? scale(best.n, -1) : best.n;
      if (Math.abs(dot(fr.a, n)) < 1e-3) throw ctx.err('A member runs along the face it is trimmed to');
      end.planes.push({ p: sub(best.p, scale(n, gap)), n });
    } else {
      let best = bounds[0], bd = Infinity;
      for (const b of bounds) { const d = closestOnPath(b.path, fr.P).d; if (d < bd) { bd = d; best = b; } }
      const tp = trimPlane(best, fr.P, fr.a, gap);
      if (!tp) throw ctx.err('A member runs along the member it is trimmed to');
      if (f.coped) {
        // To the boundary's axis, then the boundary's outline is cut away.
        const s = sectionAt(best, fr.P);
        end.planes.push({ p: sub(s.P, scale(tp.n, gap)), n: tp.n });
        const env = memberSolid(ctx, best, true);
        end.copes.push(env);
      } else end.planes.push(tp);
    }
    // Whether the new end lies past the old one (an extension), measured on the path.
    const axis = (pl: Plane) => dot(sub(pl.p, fr.P), pl.n) / dot(fr.a, pl.n);
    const was = Math.min(...m.ends[e].planes.map(axis));
    const now = Math.min(...end.planes.map(axis));
    if (now > was + 1e-6 * (1 + len(fr.P)) && !f.allowExtension) { short++; continue; }
    const ends: [MemberEnd, MemberEnd] = e ? [m.ends[0], end] : [end, m.ends[1]];
    const next = finishMember(ctx, { ...m, ends });
    const others = [...weld.members.filter((x) => x !== m).map((x) => x.solid), ...weld.extras];
    ctx.st.body = replaceMember(ctx, m, next, others);
    faces.push(...ctx.nameTool(m.feature, next.solid, (k) => `${m.key}:${k}`));
    weld = { ...weld, members: weld.members.map((x) => (x === m ? next : x)) };
  }
  if (short) ctx.warn(short === 1 ? 'A member does not reach the boundary. Turn on Allow extension to extend it.' : `${short} members do not reach the boundary. Turn on Allow extension to extend them.`);
  ctx.setBody(ctx.st.body!, faces);
  ctx.st.weld = weld;
}

// ---------- end cap ----------

/** The member an end face belongs to and which end it is. */
function memberEndOfFace(ctx: WeldCtx, ref: FaceRef): { m: WeldMember; e: 0 | 1; desc: SurfDesc } {
  const fc = ctx.face(ref);
  const id = memberOfFace(fc.name);
  const m = id ? ctx.st.weld?.members.find((x) => x.feature === id.feature && x.key === id.member) : undefined;
  if (!m || fc.desc.type !== 'plane') throw ctx.err('Select the flat end face of a structural member');
  const ds = ([0, 1] as const).map((e) => {
    const fr = endFrame(m.path, e);
    return Math.abs(Math.abs(dot(fc.desc.d, fr.a)) - 1) < 1e-6 ? Math.abs(dot(sub(fc.desc.center, fr.P), fr.a)) + dist(fc.desc.center, fr.P) * 1e-3 : Infinity;
  });
  if (!Number.isFinite(Math.min(...ds))) throw ctx.err('End caps go on square-cut member ends. Select an end face square to the member.');
  return { m, e: ds[1] < ds[0] ? 1 : 0, desc: fc.desc };
}

export function applyEndCap(ctx: WeldCtx, f: EndCapFeature): void {
  if (!f.faces.length) throw ctx.err('Select the end faces of tube or pipe members');
  const t = value(ctx, f.thickness, 'Thickness');
  const off = value(ctx, f.offset, 'Offset');
  if (!(t > 0)) throw ctx.err('Thickness must be greater than zero');
  if (off < 0) throw ctx.err('The offset cannot be negative');
  const solids: Sh[] = [];
  const named: unknown[] = [];
  f.faces.forEach((ref, i) => {
    const { m, e } = memberEndOfFace(ctx, ref);
    if (!isHollow(m.profile)) throw ctx.err('End caps go on tube and pipe members');
    const fr = endFrame(m.path, e);
    if (m.ends[e].planes.length !== 1 || m.ends[e].copes.length || dot(fr.a, m.ends[e].planes[0].n) < 1 - 1e-9) {
      throw ctx.err('End caps go on square-cut member ends. Select an end face square to the member.');
    }
    const d = m.dims, wall = d.t ?? 0;
    const inset = off + (f.inward ? wall : 0);
    let cap: ProfileShape;
    if (m.profile === 'pipe') {
      const r = (d.D ?? 0) / 2 - inset;
      if (r <= 1e-6) throw ctx.err('The offset is too large for this profile');
      cap = { outer: [{ k: 'arc', c: [0, 0], r, a0: 0, a1: 2 * Math.PI }], holes: [] };
    } else {
      const B = (d.B ?? 0) - 2 * inset, H = (d.H ?? 0) - 2 * inset;
      if (B <= 1e-6 || H <= 1e-6) throw ctx.err('The offset is too large for this profile');
      const rr = Math.max(0, (f.inward ? d.ri ?? 0 : d.ro ?? 0) - off);
      cap = profileShape('squareTube', { B, H, t: Math.min(B, H) / 4, ro: rr, ri: 0 });
      cap = { outer: cap.outer, holes: [] };
    }
    // Placed on the member like its profile (the same pierce point, turn and mirror).
    const full = profileShape(m.profile, m.dims);
    const placed = placeWith(cap, piercePointOf(full, m.placement.pierce), m.placement);
    // The end face lies where the end plane crosses the path.
    const pl = m.ends[e].planes[0];
    const o = add(fr.P, scale(fr.a, dot(sub(pl.p, fr.P), pl.n)));
    const start = f.inward ? sub(o, scale(fr.a, t)) : o;
    const face = profileFace(placed, start, fr.U, fr.V, fr.a);
    const solid = R.basicFaceExtrusion(face, new R.Vector(scale(fr.a, t))) as unknown as Sh;
    if (f.inward && memberLength(m) <= t) throw ctx.err('The member is shorter than the cap is thick');
    solids.push(solid);
    named.push(...ctx.nameTool(f.id, solid, (k) => `cap${i}:${k}`));
  });
  const tool = solids.length === 1 ? solids[0] : fuseAll(solids);
  ctx.applyTool(tool, named, f.inward ? 'The end caps add no material: the tube is already closed there.' : undefined);
  const prev = ctx.st.weld;
  ctx.st.weld = { members: prev?.members ?? [], extras: [...(prev?.extras ?? []), ...solids] };
}

// ---------- gusset ----------

export function applyGusset(ctx: WeldCtx, f: GussetFeature): void {
  if (f.faces.length !== 2) throw ctx.err('Select two planar faces that meet at a corner');
  const [f1, f2] = f.faces.map((r) => ctx.face(r));
  if (f1.desc.type !== 'plane' || f2.desc.type !== 'plane') throw ctx.err('Select two planar faces that meet at a corner');
  const n1 = f1.desc.d, n2 = f2.desc.d;
  const L0 = cross(n1, n2);
  if (len(L0) < 0.02) throw ctx.err('The faces are parallel. Select two faces that meet at a corner.');
  const L = normalize(L0);
  const d1 = value(ctx, f.d1, 'Distance 1'), d2 = value(ctx, f.d2, 'Distance 2'), t = value(ctx, f.thickness, 'Thickness');
  const ch = value(ctx, f.chamfer, 'Chamfer distance');
  const d3 = f.shape === 'polygonal' ? value(ctx, f.d3, 'Distance 3') : 0;
  if (!(d1 > 0) || !(d2 > 0)) throw ctx.err('The gusset distances must be greater than zero');
  if (!(t > 0)) throw ctx.err('Thickness must be greater than zero');
  if (ch < 0 || ch >= Math.min(d1, d2)) throw ctx.err('The chamfer must be shorter than the gusset sides');
  if (f.shape === 'polygonal' && (!(d3 > 0) || d3 >= d1 || d3 >= d2)) throw ctx.err('Distance 3 must be greater than zero and shorter than distances 1 and 2');
  // The corner: where the two face planes meet, midway between the faces along that line.
  const k1 = dot(n1, f1.desc.p), k2 = dot(n2, f2.desc.p), k3 = dot(L, scale(add(f1.desc.center, f2.desc.center), 0.5));
  const det = dot(n1, cross(n2, L));
  const C = scale(add(add(scale(cross(n2, L), k1), scale(cross(L, n1), k2)), scale(cross(n1, n2), k3)), 1 / det);
  // Legs along each face, toward the other face's side.
  const e1 = normalize(sub(n2, scale(n1, dot(n1, n2))));
  const e2 = normalize(sub(n1, scale(n2, dot(n1, n2))));
  const at = (s1: number, s2: number) => add(C, add(scale(e1, s1), scale(e2, s2)));
  const pts: Vec3[] = ch > 0 ? [at(ch, 0), at(d1, 0)] : [at(0, 0), at(d1, 0)];
  if (f.shape === 'polygonal') pts.push(at(d1, d3), at(d3, d2));
  pts.push(at(0, d2));
  if (ch > 0) pts.push(at(0, ch));
  const off = f.location === 'center' ? -t / 2 : f.location === 'side1' ? 0 : -t;
  const moved = pts.map((p) => add(p, scale(L, off)));
  const face = R.makeFace(R.assembleWire(moved.map((p, i) => R.makeLine(p, moved[(i + 1) % moved.length]))));
  const solid = R.basicFaceExtrusion(face, new R.Vector(scale(L, t))) as unknown as Sh;
  ctx.applyTool(solid, ctx.nameTool(f.id, solid, (k) => `g${k}`), 'The gusset adds no material: it lies inside the part.');
  const prev = ctx.st.weld;
  ctx.st.weld = { members: prev?.members ?? [], extras: [...(prev?.extras ?? []), solid] };
}

// ---------- fillet weld bead ----------

/** Distance from a point to a shape. */
function pointDistance(shape: Sh, p: Vec3): number {
  const oc = getOc();
  const gp = pnt(p);
  const mv = new oc.BRepBuilderAPI_MakeVertex(gp);
  const ext = new oc.BRepExtrema_DistShapeShape();
  const progress = new oc.Message_ProgressRange();
  try {
    ext.LoadS1(mv.Vertex());
    ext.LoadS2(shape.wrapped);
    ext.Perform(progress);
    return ext.IsDone() && ext.NbSolution() > 0 ? ext.Value() : Infinity;
  } finally {
    ext.delete(); progress.delete(); mv.delete(); gp.delete();
  }
}

export function applyWeldBead(ctx: WeldCtx, f: WeldBeadFeature): void {
  if (!f.edges.length) throw ctx.err('Select the inside corner edges to weld');
  const s = value(ctx, f.size, 'Bead size');
  if (!(s > 0)) throw ctx.err('The bead size must be greater than zero');
  const solids: Sh[] = [];
  for (const ref of f.edges) {
    const e = ctx.edge(ref);
    if (e.desc.type !== 'line') throw ctx.err('Fillet beads follow straight edges');
    if (e.faces.length !== 2 || e.faces.some((x) => x.desc.type !== 'plane')) throw ctx.err('Fillet beads go along edges between two flat faces');
    const [f1, f2] = e.faces.map((x) => x.desc);
    const n1 = f1.d, n2 = f2.d, c = dot(n1, n2);
    if (Math.abs(c) > 0.999) throw ctx.err('The faces at the edge are in line: there is no corner to weld');
    // The legs run along each face, away from the edge.
    const e1 = normalize(sub(n2, scale(n1, c))), e2 = normalize(sub(n1, scale(n2, c)));
    const E = e.desc.a;
    // At an inside corner each face goes on along its leg from the edge.
    const eps = Math.min(s, e.desc.length) * 0.02;
    const on = (k: 0 | 1, dir: Vec3) => pointDistance(e.faces[k].shape, add(e.desc.mid, scale(dir, eps))) < eps * 1e-3;
    if (!on(0, e1) || !on(1, e2)) throw ctx.err('Fillet beads go along inside corners, where two faces meet at less than 180 degrees');
    const pts = [E, add(E, scale(e1, s)), add(E, scale(e2, s))];
    const face = R.makeFace(R.assembleWire(pts.map((p, i) => R.makeLine(p, pts[(i + 1) % 3]))));
    solids.push(R.basicFaceExtrusion(face, new R.Vector(sub(e.desc.b, e.desc.a))) as unknown as Sh);
  }
  const tool = solids.length === 1 ? solids[0] : fuseAll(solids);
  ctx.applyTool(tool, solids.flatMap((x, i) => ctx.nameTool(f.id, x, (k) => `w${i}:${k}`)), 'The bead adds no material: the corner is already filled.');
  const prev = ctx.st.weld;
  ctx.st.weld = { members: prev?.members ?? [], extras: [...(prev?.extras ?? []), ...solids] };
}
