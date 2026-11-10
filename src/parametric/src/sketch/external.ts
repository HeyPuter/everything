// Geometry projected from the model into a sketch ("external geometry").
// A projected entity keeps a reference to the model edge or vertex it came
// from. Every rebuild moves it back onto that edge, so sketch geometry
// constrained to it follows the model when an earlier feature changes, and
// the solver holds it fixed. No DOM and no geometry kernel: the worker and the
// editor both use it.

import type { EdgeRef, ExtRef, Id, SkEntity, SkPoint, SketchFeature } from '../model/types';
import { type Frame, type Vec2, type Vec3, cross, dist, dist2, len, normalize, toLocal } from '../math/vec';
import { pointIdsOf } from './geom';

/** What projection needs to know about a model edge. EdgeInfo and the kernel's edge descriptions both fit. */
export interface ModelEdge {
  type: string;
  a: Vec3;
  b: Vec3;
  mid: Vec3;
  center?: Vec3;
  axis?: Vec3;
  radius?: number;
}

/** A model edge that can be referenced by name. */
export interface NamedModelEdge extends ModelEdge {
  name: string;
  length: number;
}

export type Projection =
  | { t: 'line'; a: Vec2; b: Vec2 }
  | { t: 'point'; p: Vec2 }
  | { t: 'circle'; c: Vec2; r: number }
  | { t: 'arc'; c: Vec2; a: Vec2; b: Vec2 };

export const edgeRefOf = (e: NamedModelEdge): EdgeRef => ({ name: e.name, sig: { type: e.type, m: e.mid, len: e.length } });

/** Distance under which two model points are the same vertex. */
const vertexTol = (p: Vec3) => 1e-5 * (1 + Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])));

/**
 * The sketch curve a model edge projects to: lines (or a point, seen end-on),
 * and circles and arcs whose plane is parallel to the sketch. Other edges
 * (ellipses, splines, tilted circles) cannot be projected.
 */
export function projectEdge(fr: Frame, e: ModelEdge): Projection | null {
  const a = toLocal(fr, e.a), b = toLocal(fr, e.b);
  if (e.type === 'line') {
    const size = 1 + Math.max(Math.abs(a[0]), Math.abs(a[1]));
    return dist2(a, b) < 1e-9 * size ? { t: 'point', p: a } : { t: 'line', a, b };
  }
  if (e.type === 'circle' && e.center && e.axis && e.radius && len(cross(normalize(e.axis), fr.n)) < 1e-6) {
    const c = toLocal(fr, e.center);
    if (dist2(a, b) < 1e-7 * Math.max(1, e.radius)) return { t: 'circle', c, r: e.radius };
    const m = toLocal(fr, e.mid);
    const ccw = (a[0] - c[0]) * (m[1] - c[1]) - (a[1] - c[1]) * (m[0] - c[0]) > 0;
    return ccw ? { t: 'arc', c, a, b } : { t: 'arc', c, a: b, b: a };
  }
  return null;
}

/** Points of projected curves and projected points: the solver holds them fixed. */
export function externalPointIds(entities: SkEntity[]): Set<Id> {
  const out = new Set<Id>();
  for (const e of entities) if (e.ext) for (const p of pointIdsOf(e)) out.add(p);
  return out;
}

export const hasExternal = (sk: Pick<SketchFeature, 'entities'>) => sk.entities.some((e) => !!e.ext);

/** Whether an entity is projected geometry or a point of projected geometry. */
export function isExternal(sk: Pick<SketchFeature, 'entities'>, id: Id): boolean {
  const e = sk.entities.find((x) => x.id === id);
  if (!e) return false;
  if (e.ext) return true;
  return e.t === 'point' && externalPointIds(sk.entities).has(id);
}

export interface ProjectOptions {
  /** Reference geometry only (left out of profiles). */
  construction?: boolean;
}

/**
 * Projects a model edge into the sketch as linked geometry, or returns the
 * entity that already projects it. Null if the edge cannot be projected.
 */
export function projectEdgeInto(sk: SketchFeature, fr: Frame, edge: NamedModelEdge, newId: (p: string) => Id, opts: ProjectOptions = {}): Id | null {
  const existing = sk.entities.find((e) => e.ext?.kind === 'edge' && e.ext.edge.name === edge.name);
  const pr = projectEdge(fr, edge);
  if (!pr) return null;
  if (existing && existing.t === pr.t) return existing.id;
  const ext: ExtRef = { kind: 'edge', edge: edgeRefOf(edge) };
  const construction = opts.construction || undefined;
  // End points shared by projected curves are one point, so a projected
  // outline is a closed profile. Points the user drew are never taken over.
  const owned = externalPointIds(sk.entities);
  const pointAt = (p: Vec2) => {
    for (const e of sk.entities) if (e.t === 'point' && owned.has(e.id) && Math.hypot(e.x - p[0], e.y - p[1]) < 1e-6) return e.id;
    const id = newId('p');
    sk.entities.push({ id, t: 'point', x: p[0], y: p[1] });
    owned.add(id);
    return id;
  };
  const id = newId(pr.t === 'line' ? 'l' : pr.t === 'circle' ? 'c' : pr.t === 'arc' ? 'a' : 'p');
  switch (pr.t) {
    case 'point':
      sk.entities.push({ id, t: 'point', x: pr.p[0], y: pr.p[1], ext });
      break;
    case 'line':
      sk.entities.push({ id, t: 'line', a: pointAt(pr.a), b: pointAt(pr.b), construction, ext });
      break;
    case 'circle': {
      const c = newId('p');
      sk.entities.push({ id: c, t: 'point', x: pr.c[0], y: pr.c[1] });
      sk.entities.push({ id, t: 'circle', c, r: pr.r, construction, ext });
      break;
    }
    case 'arc':
      sk.entities.push({ id, t: 'arc', c: pointAt(pr.c), a: pointAt(pr.a), b: pointAt(pr.b), construction, ext });
      break;
  }
  return id;
}

/** Model edges with an end at a point, nearest first. */
export function edgesAtVertex<E extends ModelEdge>(edges: E[], p: Vec3): { edge: E; end: Vec3 }[] {
  const tol = Math.max(vertexTol(p), 1e-4);
  const out: { edge: E; end: Vec3; d: number }[] = [];
  for (const e of edges) {
    const da = dist(e.a, p), db = dist(e.b, p);
    const d = Math.min(da, db);
    if (d < tol) out.push({ edge: e, end: da <= db ? e.a : e.b, d });
  }
  return out.sort((x, y) => x.d - y.d);
}

/**
 * Projects a model vertex into the sketch as a linked point, or returns the
 * point that already sits on it (a projected point or a projected curve's
 * end). Null if no edge ends there.
 */
export function projectVertexInto(sk: SketchFeature, fr: Frame, p: Vec3, edges: NamedModelEdge[], newId: (p: string) => Id): Id | null {
  const at = edgesAtVertex(edges, p);
  if (!at.length) return null;
  const q = at[0].end;
  const local = toLocal(fr, q);
  const owned = externalPointIds(sk.entities);
  const size = 1 + Math.max(Math.abs(local[0]), Math.abs(local[1]));
  for (const e of sk.entities) if (e.t === 'point' && owned.has(e.id) && Math.hypot(e.x - local[0], e.y - local[1]) < 1e-7 * size) return e.id;
  const id = newId('p');
  // A few edges are enough to find the vertex again; more only add lookups.
  sk.entities.push({ id, t: 'point', x: local[0], y: local[1], ext: { kind: 'vertex', edges: at.slice(0, 3).map((x) => edgeRefOf(x.edge)), p: q } });
  return id;
}

/** The model point a vertex reference stands for, or null if none of its edges is left. */
function resolveVertex(ref: Extract<ExtRef, { kind: 'vertex' }>, find: (r: EdgeRef) => ModelEdge | null): Vec3 | null {
  const found = ref.edges.map(find).filter((e): e is ModelEdge => !!e);
  if (!found.length) return null;
  // The end the most edges share is the vertex; the one nearest where it was breaks ties.
  let best: Vec3 | null = null, bestScore = -1, bestD = Infinity;
  for (const c of [found[0].a, found[0].b]) {
    const tol = vertexTol(c);
    const score = found.slice(1).filter((e) => dist(e.a, c) < tol || dist(e.b, c) < tol).length;
    const d = dist(c, ref.p);
    if (score > bestScore || (score === bestScore && d < bestD)) { best = c; bestScore = score; bestD = d; }
  }
  return best;
}

export interface ExternalResult {
  /** Whether any projected geometry moved. */
  moved: boolean;
  /** Projected entities whose model edge or vertex is gone (they keep their last position). */
  lost: Id[];
}

/**
 * Moves projected geometry onto its model edges and vertices, in place.
 * `find` returns the model edge a reference stands for now, or null.
 */
export function resolveExternal(sk: SketchFeature, fr: Frame, find: (ref: EdgeRef) => ModelEdge | null): ExternalResult {
  const points = new Map<Id, SkPoint>();
  for (const e of sk.entities) if (e.t === 'point') points.set(e.id, e);
  let moved = false;
  const lost: Id[] = [];
  const set = (id: Id, p: Vec2) => {
    const e = points.get(id);
    if (!e) return;
    if (Math.abs(e.x - p[0]) > 1e-12 * (1 + Math.abs(p[0])) || Math.abs(e.y - p[1]) > 1e-12 * (1 + Math.abs(p[1]))) {
      e.x = p[0];
      e.y = p[1];
      moved = true;
    }
  };
  const pt = (id: Id): Vec2 => { const e = points.get(id); return e ? [e.x, e.y] : [0, 0]; };
  for (const e of sk.entities) {
    const ext = e.ext;
    if (!ext) continue;
    if (ext.kind === 'vertex') {
      const q = e.t === 'point' ? resolveVertex(ext, find) : null;
      if (!q) { lost.push(e.id); continue; }
      set(e.id, toLocal(fr, q));
      continue;
    }
    const m = find(ext.edge);
    const pr = m ? projectEdge(fr, m) : null;
    // An edge that now projects to another kind of curve (a circle tilted out
    // of the sketch plane) cannot drive this entity any more.
    if (!pr || pr.t !== e.t) { lost.push(e.id); continue; }
    if (pr.t === 'point') set(e.id, pr.p);
    else if (pr.t === 'line' && e.t === 'line') {
      // Keep the line's direction: the kernel may list the edge's ends the other way round.
      const A = pt(e.a), B = pt(e.b);
      const swap = dist2(A, pr.b) + dist2(B, pr.a) < dist2(A, pr.a) + dist2(B, pr.b);
      set(e.a, swap ? pr.b : pr.a);
      set(e.b, swap ? pr.a : pr.b);
    } else if (pr.t === 'circle' && e.t === 'circle') {
      set(e.c, pr.c);
      if (Math.abs(e.r - pr.r) > 1e-12 * (1 + pr.r)) { e.r = pr.r; moved = true; }
    } else if (pr.t === 'arc' && e.t === 'arc') {
      set(e.c, pr.c);
      set(e.a, pr.a);
      set(e.b, pr.b);
    }
  }
  return { moved, lost };
}

/**
 * Turns linked geometry into ordinary geometry fixed where it is (the link to
 * the model is dropped).
 */
export function unlinkExternal(sk: SketchFeature, ids: Id[], newId: (p: string) => Id): number {
  const set = new Set(ids);
  let n = 0;
  for (const e of sk.entities) {
    if (!e.ext || !set.has(e.id)) continue;
    delete e.ext;
    sk.constraints.push({ id: newId('r'), type: 'fix', refs: [e.id] });
    n++;
  }
  return n;
}
