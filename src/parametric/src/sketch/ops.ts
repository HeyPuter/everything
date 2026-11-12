// Pure sketch editing operations (no DOM): id allocation, deletion with
// dependent cleanup, relation availability, trim, extend, sketch fillet,
// offset, mirror and measurement of dimensions.

import type {
  DimensionType, Id, RelationType, SkArc, SkCircle, SkConstraint, SkCurve, SkDimension, SkEntity, SkLine, SkPoint,
  SketchFeature,
} from '../model/types';
import { isDimension } from '../model/types';
import { SketchSystem } from './solver';
import { type Vec2, angle2, cross2, dist2, dot2, norm2, sub2, wrap2Pi } from '../math/vec';
import {
  ORIGIN_ID, SketchIndex, arcAngles, arcRadius, closestOnSegment, curveParam, intersectPrims, pointIdsOf, primsOf, tessellate,
} from './geom';

export class IdGen {
  constructor(private sk: SketchFeature) {}
  next(prefix: string): Id {
    const used = new Set<string>([...this.sk.entities.map((e) => e.id), ...this.sk.constraints.map((c) => c.id)]);
    let n = used.size + 1;
    while (used.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }
}

/** Unique id helper bound to a sketch that also tracks ids handed out in this batch. */
export function idFactory(sk: SketchFeature): (prefix: string) => Id {
  const used = new Set<string>([...sk.entities.map((e) => e.id), ...sk.constraints.map((c) => c.id)]);
  let n = 0;
  return (prefix: string) => {
    let id: string;
    do id = `${prefix}${++n}`; while (used.has(id));
    used.add(id);
    return id;
  };
}

export function nextDimName(sk: SketchFeature): string {
  const used = new Set(sk.constraints.filter(isDimension).map((d) => d.name));
  let n = 1;
  while (used.has(`D${n}`)) n++;
  return `D${n}`;
}

/** Points referenced by any curve. */
export function usedPoints(entities: SkEntity[]): Set<Id> {
  const s = new Set<Id>();
  for (const e of entities) if (e.t !== 'point') for (const p of pointIdsOf(e)) s.add(p);
  return s;
}

/**
 * Deletes entities and constraints. Curves drop their now-unused end points;
 * constraints that reference anything deleted are removed too.
 */
export function deleteItems(sk: SketchFeature, ids: Iterable<Id>) {
  const del = new Set(ids);
  // Deleting a point that a curve uses deletes the curve.
  for (const e of sk.entities) if (e.t !== 'point' && pointIdsOf(e).some((p) => del.has(p))) del.add(e.id);
  const before = usedPoints(sk.entities.filter((e) => !del.has(e.id)));
  const removedCurves = sk.entities.filter((e) => del.has(e.id) && e.t !== 'point');
  for (const c of removedCurves) for (const p of pointIdsOf(c)) if (!before.has(p)) del.add(p);
  sk.entities = sk.entities.filter((e) => !del.has(e.id));
  sk.constraints = sk.constraints.filter((c) => !del.has(c.id) && !c.refs.some((r) => del.has(r)));
  cleanupConstraints(sk);
}

/** Removes constraints whose references no longer exist. */
export function cleanupConstraints(sk: SketchFeature) {
  const ids = new Set(sk.entities.map((e) => e.id));
  ids.add(ORIGIN_ID);
  sk.constraints = sk.constraints.filter((c) => c.refs.every((r) => ids.has(r)));
}

/** Why trim, extend and sketch fillet leave projected geometry alone. */
export const PROJECTED_LOCKED = 'Projected geometry follows its model edge, so it cannot be trimmed, extended or filleted. Unlink it in the PropertyManager first.';

// ---------- relations ----------

export type EntityKind = 'point' | 'line' | 'circle' | 'arc' | 'spline';

export function kindOf(sk: SketchFeature, id: Id): EntityKind | undefined {
  if (id === ORIGIN_ID) return 'point';
  return sk.entities.find((e) => e.id === id)?.t;
}

/** Relations that can be added to the current selection (in display order). */
export function availableRelations(sk: SketchFeature, ids: Id[]): RelationType[] {
  const kinds = ids.map((id) => kindOf(sk, id));
  if (kinds.some((k) => !k)) return [];
  const count = (k: EntityKind) => kinds.filter((x) => x === k).length;
  const n = ids.length;
  const lines = count('line'), pts = count('point'), circs = count('circle') + count('arc');
  const out: RelationType[] = [];
  if (n === 1) {
    if (lines === 1) out.push('horizontal', 'vertical');
    if (ids[0] !== ORIGIN_ID) out.push('fix');
    return out;
  }
  if (lines === n) {
    out.push('horizontal', 'vertical', 'parallel', 'equal');
    if (n === 2) out.push('perpendicular', 'collinear');
    if (n === 3) out.push('symmetric');
  } else if (pts === n) {
    out.push('horizontal', 'vertical');
    if (n === 2) out.push('coincident');
  } else if (circs === n) {
    out.push('equal');
    if (n === 2) out.push('concentric', 'tangent');
  } else if (n === 2 && lines === 1 && circs === 1) out.push('tangent');
  else if (n === 2 && pts === 1 && lines === 1) out.push('coincident', 'midpoint');
  else if (n === 2 && pts === 1 && circs === 1) out.push('coincident', 'concentric');
  else if (n === 2 && pts === 1 && count('spline') === 1) {
    // A spline already passes through its own points.
    const sp = sk.entities.find((e) => e.t === 'spline' && ids.includes(e.id));
    if (sp?.t === 'spline' && !ids.some((id) => sp.pts.includes(id))) out.push('coincident');
  }
  else if (n === 3 && pts === 2 && lines === 1) out.push('symmetric');
  else if (n === 3 && circs === 2 && lines === 1) out.push('symmetric');
  if (!ids.includes(ORIGIN_ID)) out.push('fix');
  return out;
}

export const RELATION_LABELS: Record<RelationType, string> = {
  coincident: 'Coincident',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  tangent: 'Tangent',
  equal: 'Equal',
  concentric: 'Concentric',
  midpoint: 'Midpoint',
  collinear: 'Collinear',
  fix: 'Fix',
  symmetric: 'Symmetric',
};

/**
 * Builds the constraint records for a relation applied to a selection.
 * Horizontal/vertical on several lines or point pairs become one relation
 * each; fix applies to every entity.
 */
export function makeRelations(sk: SketchFeature, type: RelationType, ids: Id[], newId: (p: string) => Id): SkConstraint[] {
  const ix = new SketchIndex(sk.entities);
  const kinds = ids.map((id) => kindOf(sk, id));
  if ((type === 'horizontal' || type === 'vertical') && kinds.every((k) => k === 'line')) {
    return ids.map((id) => ({ id: newId('r'), type, refs: [id] }));
  }
  if ((type === 'horizontal' || type === 'vertical') && kinds.every((k) => k === 'point') && ids.length > 2) {
    return ids.slice(1).map((id) => ({ id: newId('r'), type, refs: [ids[0], id] }));
  }
  if (type === 'fix') return ids.filter((id) => id !== ORIGIN_ID).map((id) => ({ id: newId('r'), type, refs: [id] }));
  if (type === 'symmetric' && ids.length === 3) {
    // The symmetry line goes last, wherever it was picked: a centerline if
    // one was selected, else the only line, else the last line.
    const lines = ids.filter((_, i) => kinds[i] === 'line');
    const axis = [...lines].reverse().find((id) => (ix.get(id) as SkLine).construction) ?? lines[lines.length - 1];
    if (axis) return [{ id: newId('r'), type, refs: [...ids.filter((id) => id !== axis), axis] }];
  }
  if (type === 'tangent') {
    const circs = ids.filter((id) => ['circle', 'arc'].includes(kindOf(sk, id)!));
    let internal = false;
    if (circs.length === 2) {
      const a = sk.entities.find((e) => e.id === circs[0]) as SkCircle | SkArc;
      const b = sk.entities.find((e) => e.id === circs[1]) as SkCircle | SkArc;
      const ra = a.t === 'circle' ? a.r : arcRadius(ix, a);
      const rb = b.t === 'circle' ? b.r : arcRadius(ix, b);
      const d = dist2(ix.pt(a.c), ix.pt(b.c));
      internal = Math.abs(d - Math.abs(ra - rb)) < Math.abs(d - (ra + rb));
    }
    return [{ id: newId('r'), type, refs: ids, internal }];
  }
  return [{ id: newId('r'), type, refs: ids }];
}

/**
 * Whether relation `a` already holds everything relation `b` asks for, so
 * keeping both would count the same equation twice and over-define the
 * sketch: an identical relation, a midpoint over the point lying on that
 * line, collinear over parallel for the same lines, and coincident points
 * over a horizontal or vertical between them.
 */
export function relationIncludes(sk: SketchFeature, a: SkConstraint, b: SkConstraint): boolean {
  if (isDimension(a) || isDimension(b)) return false;
  const same = (x: Id[], y: Id[]) => x.length === y.length && [...x].sort().join('\u0000') === [...y].sort().join('\u0000');
  if (a.type === b.type) {
    if (a.type === 'symmetric') return a.refs.join('\u0000') === b.refs.join('\u0000');
    if (a.type === 'tangent' && !!a.internal !== !!b.internal) return false;
    return same(a.refs, b.refs);
  }
  if (!same(a.refs, b.refs) || a.refs.length !== 2) return false;
  const kinds = a.refs.map((id) => kindOf(sk, id));
  if (a.type === 'midpoint' && b.type === 'coincident') return kinds.includes('point') && kinds.includes('line');
  if (a.type === 'collinear' && b.type === 'parallel') return kinds.every((k) => k === 'line');
  if (a.type === 'coincident' && (b.type === 'horizontal' || b.type === 'vertical')) return kinds.every((k) => k === 'point');
  return false;
}

export interface AddedRelations {
  /** The relations added. */
  added: SkConstraint[];
  /** New relations left out because an existing one already holds them. */
  skipped: { c: SkConstraint; by: SkConstraint }[];
  /** Existing relations removed because a new one includes them. */
  replaced: { c: SkConstraint; by: SkConstraint }[];
}

/**
 * Adds relations to a sketch without doubling up on ones already there: a
 * relation an existing one already holds is left out, and an existing one a
 * new relation includes is replaced by it.
 */
export function addRelations(sk: SketchFeature, list: SkConstraint[]): AddedRelations {
  const out: AddedRelations = { added: [], skipped: [], replaced: [] };
  for (const c of list) {
    const by = sk.constraints.find((e) => relationIncludes(sk, e, c));
    if (by) { out.skipped.push({ c, by }); continue; }
    sk.constraints = sk.constraints.filter((e) => {
      if (!relationIncludes(sk, c, e)) return true;
      out.replaced.push({ c: e, by: c });
      return false;
    });
    sk.constraints.push(c);
    out.added.push(c);
  }
  return out;
}

/** Relations on a sketch that involve any of the ids. */
export function relationsOf(sk: SketchFeature, ids: Id[]): SkConstraint[] {
  const set = new Set(ids);
  // A curve's relations include those on its end points.
  for (const e of sk.entities) if (set.has(e.id) && e.t !== 'point') for (const p of pointIdsOf(e)) set.add(p);
  return sk.constraints.filter((c) => c.refs.some((r) => set.has(r)));
}

// ---------- measurement ----------

export interface DimSpec {
  type: DimensionType;
  refs: Id[];
  value: number;
  sector?: number;
}

/** Current value of a dimension as the geometry stands (mm or degrees). */
export function measureDimension(sk: SketchFeature, d: Pick<SkDimension, 'type' | 'refs' | 'sector'>, ix = new SketchIndex(sk.entities)): number {
  const ent = (id: Id) => (id === ORIGIN_ID ? undefined : ix.get(id));
  const centerOrPt = (id: Id): Vec2 => {
    const e = ent(id);
    if (e && (e.t === 'circle' || e.t === 'arc')) return ix.pt(e.c);
    return ix.pt(id);
  };
  const [a, b] = d.refs;
  switch (d.type) {
    case 'radius':
    case 'diameter': {
      const e = ent(a) as SkCircle | SkArc;
      const r = e.t === 'circle' ? e.r : arcRadius(ix, e);
      return d.type === 'diameter' ? 2 * r : r;
    }
    case 'angle': {
      const l1 = ent(a) as SkLine;
      const da = sub2(ix.pt(l1.b), ix.pt(l1.a));
      let db: Vec2 = [1, 0];
      if (b) { const l2 = ent(b) as SkLine; db = sub2(ix.pt(l2.b), ix.pt(l2.a)); }
      const s = d.sector ?? 0;
      const s1 = s & 1 ? -1 : 1, s2 = s & 2 ? -1 : 1;
      const ang = Math.atan2(cross2([da[0] * s1, da[1] * s1], [db[0] * s2, db[1] * s2]), dot2([da[0] * s1, da[1] * s1], [db[0] * s2, db[1] * s2]));
      return (Math.abs(ang) * 180) / Math.PI;
    }
    case 'hdistance':
    case 'vdistance': {
      const axis = d.type === 'hdistance' ? 0 : 1;
      let p: Vec2, q: Vec2;
      if (d.refs.length === 1) { const l = ent(a) as SkLine; p = ix.pt(l.a); q = ix.pt(l.b); }
      else { p = centerOrPt(a); q = centerOrPt(b); }
      return Math.abs(q[axis] - p[axis]);
    }
    case 'distance': {
      if (d.refs.length === 1) {
        const l = ent(a) as SkLine;
        return dist2(ix.pt(l.a), ix.pt(l.b));
      }
      const ea = ent(a), eb = ent(b);
      if (ea?.t === 'line' || eb?.t === 'line') {
        const line = (ea?.t === 'line' ? ea : eb) as SkLine;
        const other = line === ea ? b : a;
        const oe = ent(other);
        const la = ix.pt(line.a), lb = ix.pt(line.b);
        let p: Vec2;
        if (oe?.t === 'line') { const q1 = ix.pt(oe.a), q2 = ix.pt(oe.b); p = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2]; }
        else p = centerOrPt(other);
        const dir = norm2(sub2(lb, la));
        return Math.abs(cross2(dir, sub2(p, la)));
      }
      return dist2(centerOrPt(a), centerOrPt(b));
    }
  }
}

/**
 * Chooses the dimension type for a selection and label position, the way
 * a "smart" dimension tool does.
 */
export function smartDimension(sk: SketchFeature, ids: Id[], at: Vec2): DimSpec | null {
  const ix = new SketchIndex(sk.entities);
  const k = ids.map((id) => kindOf(sk, id));
  // Spline points can be dimensioned, but the curve itself has no dimension reference.
  if (k.includes('spline')) return null;
  const center = (id: Id): Vec2 => {
    const e = id === ORIGIN_ID ? undefined : ix.get(id);
    return e && (e.t === 'circle' || e.t === 'arc') ? ix.pt(e.c) : ix.pt(id);
  };
  const byPlacement = (p: Vec2, q: Vec2, refs: Id[]): DimSpec => {
    const minX = Math.min(p[0], q[0]), maxX = Math.max(p[0], q[0]);
    const minY = Math.min(p[1], q[1]), maxY = Math.max(p[1], q[1]);
    const inX = at[0] >= minX && at[0] <= maxX;
    const inY = at[1] >= minY && at[1] <= maxY;
    let type: DimensionType = 'distance';
    if (inX && !inY && maxX - minX > 1e-9) type = 'hdistance';
    else if (inY && !inX && maxY - minY > 1e-9) type = 'vdistance';
    else if (Math.abs(p[1] - q[1]) < 1e-9) type = 'hdistance';
    else if (Math.abs(p[0] - q[0]) < 1e-9) type = 'vdistance';
    const spec: DimSpec = { type, refs, value: 0 };
    spec.value = measureDimension(sk, spec);
    return spec;
  };
  if (ids.length === 1) {
    if (k[0] === 'line') {
      const l = ix.get(ids[0]) as SkLine;
      return byPlacement(ix.pt(l.a), ix.pt(l.b), ids);
    }
    if (k[0] === 'circle') return { type: 'diameter', refs: ids, value: measureDimension(sk, { type: 'diameter', refs: ids }) };
    if (k[0] === 'arc') return { type: 'radius', refs: ids, value: measureDimension(sk, { type: 'radius', refs: ids }) };
    return null;
  }
  if (ids.length !== 2) return null;
  const [a, b] = ids;
  if (k[0] === 'line' && k[1] === 'line') {
    const l1 = ix.get(a) as SkLine, l2 = ix.get(b) as SkLine;
    const d1 = norm2(sub2(ix.pt(l1.b), ix.pt(l1.a))), d2 = norm2(sub2(ix.pt(l2.b), ix.pt(l2.a)));
    if (Math.abs(cross2(d1, d2)) < 0.017) {
      const spec: DimSpec = { type: 'distance', refs: [a, b], value: 0 };
      spec.value = measureDimension(sk, spec);
      return spec;
    }
    // Angle: choose the sector containing the label position.
    const p = lineIntersection(ix.pt(l1.a), ix.pt(l1.b), ix.pt(l2.a), ix.pt(l2.b)) ?? ix.pt(l1.a);
    const v = norm2(sub2(at, p));
    let best = 0, bestScore = -Infinity;
    for (let s = 0; s < 4; s++) {
      const u1: Vec2 = s & 1 ? [-d1[0], -d1[1]] : d1;
      const u2: Vec2 = s & 2 ? [-d2[0], -d2[1]] : d2;
      const bis = norm2([u1[0] + u2[0], u1[1] + u2[1]]);
      const score = dot2(bis, v);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    const spec: DimSpec = { type: 'angle', refs: [a, b], value: 0, sector: best };
    spec.value = measureDimension(sk, spec);
    return spec;
  }
  if (k.includes('line')) {
    const li = k.indexOf('line');
    const other = ids[1 - li];
    const spec: DimSpec = { type: 'distance', refs: [ids[li], other], value: 0 };
    spec.value = measureDimension(sk, spec);
    return spec;
  }
  return byPlacement(center(a), center(b), [a, b]);
}

/**
 * Why a dimension measuring zero cannot be added (dimensions must be greater
 * than zero, and a zero distance is a relation, not a size), or null.
 */
export function zeroDimensionReason(sk: SketchFeature, spec: DimSpec): string | null {
  if (spec.type === 'angle' || spec.value > 1e-9) return null;
  const k = spec.refs.map((id) => kindOf(sk, id));
  const lines = k.filter((x) => x === 'line').length;
  if (lines === 2) return 'These lines are in line with each other, so there is no distance to dimension. Use a Collinear constraint to keep them that way.';
  if (lines === 1) {
    const l = sk.entities.find((e) => e.id === spec.refs[k.indexOf('line')]) as SkLine;
    if (spec.refs.length === 2 && (spec.refs.includes(l.a) || spec.refs.includes(l.b))) return 'That point is an end of the line, so its distance to the line is always zero. Pick another point or line to dimension to.';
    return 'That point lies on the line, so there is no distance to dimension. Use a Coincident constraint to keep it on the line.';
  }
  if (k.some((x) => x === 'circle' || x === 'arc')) return 'These centres are at the same place, so there is no distance to dimension. Use a Concentric or Coincident constraint to keep them together.';
  return 'These points are at the same place, so there is no distance to dimension. Use a Coincident constraint to keep them together.';
}

export function lineIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub2(b, a), s = sub2(d, c);
  const den = cross2(r, s);
  if (Math.abs(den) < 1e-14) return null;
  const t = cross2(sub2(c, a), s) / den;
  return [a[0] + r[0] * t, a[1] + r[1] * t];
}

// ---------- trim / extend ----------

/** All cut points on curve `e` from other non-construction... curves. */
function cutPoints(sk: SketchFeature, e: SkCurve): { p: Vec2; by?: Id }[] {
  const ix = new SketchIndex(sk.entities);
  const mine = primsOf(ix, e);
  const pts: { p: Vec2; by?: Id }[] = [];
  for (const o of sk.entities) {
    if (o.t === 'point' || o.id === e.id) continue;
    // `by`: the cutting curve, which the new end point is kept on.
    const by = o.id;
    for (const p of mine) for (const q of primsOf(ix, o as SkCurve)) for (const x of intersectPrims(p, q)) pts.push({ p: x, by });
  }
  // Points lying on the curve (e.g. end points of other curves) also cut.
  for (const o of sk.entities) {
    if (o.t !== 'point') continue;
    if (pointIdsOf(e).includes(o.id)) continue;
    const p: Vec2 = [o.x, o.y];
    for (const prim of mine) {
      if (prim.kind === 'seg' && closestOnSegment(p, prim.a!, prim.b!).d < 1e-7) pts.push({ p });
    }
  }
  return pts;
}

/** New end point at a cut, kept on the curve that made the cut. */
function cutEnd(sk: SketchFeature, cut: { p: Vec2; by?: Id }, newId: (p: string) => Id): Id {
  const id = newId('p');
  sk.entities.push({ id, t: 'point', x: cut.p[0], y: cut.p[1] });
  if (cut.by) sk.constraints.push({ id: newId('r'), type: 'coincident', refs: [id, cut.by] });
  return id;
}

/**
 * Drops what measures a line's length or ends, which no longer applies once
 * it is trimmed or extended: its own length dimensions, and its place in
 * equal-length, midpoint and symmetric relations (an equal polygon side would
 * otherwise pull every other side to its new length).
 */
function dropLengthDimensions(sk: SketchFeature, lineId: Id) {
  sk.constraints = sk.constraints.flatMap((k): SkConstraint[] => {
    if (isDimension(k)) return k.refs.length === 1 && k.refs[0] === lineId && (k.type === 'distance' || k.type === 'hdistance' || k.type === 'vdistance') ? [] : [k];
    if (k.type === 'equal' && k.refs.includes(lineId)) {
      const refs = k.refs.filter((r) => r !== lineId);
      return refs.length >= 2 ? [{ ...k, refs }] : [];
    }
    if (k.type === 'midpoint' && k.refs.includes(lineId)) return [];
    if (k.type === 'symmetric' && k.refs.slice(0, -1).includes(lineId)) return [];
    return [k];
  });
}

/**
 * Removes the portion of a curve around `at` bounded by its nearest
 * intersections with other curves. Returns false if nothing changed.
 */
export function trimAt(sk: SketchFeature, curveId: Id, at: Vec2, newId: (p: string) => Id): boolean {
  const ix = new SketchIndex(sk.entities);
  const found = ix.get(curveId);
  // Projected geometry is where its model edge is: trimming it would not last.
  if (!found || found.t === 'point' || found.ext) return false;
  const e: SkCurve = found;
  const cuts = cutPoints(sk, e).map((c) => ({ ...c, t: curveParam(ix, e, c.p) }));
  const tc = curveParam(ix, e, at);
  if (e.t === 'line' || e.t === 'arc' || e.t === 'spline') {
    const start = ix.pt(e.t === 'spline' ? e.pts[0] : e.a);
    const end = ix.pt(e.t === 'spline' ? e.pts[e.pts.length - 1] : e.b);
    // An endpoint hit must be close in both parameter and physical distance.
    // Parameter alone discards real cuts on long curves; distance alone loses
    // valid cuts on tiny curves. Keep out-of-range intersections excluded.
    const inner = cuts.filter((c) => c.t > 0 && c.t < 1
      && (c.t > 1e-6 || dist2(c.p, start) > 1e-7)
      && (c.t < 1 - 1e-6 || dist2(c.p, end) > 1e-7));
    // A cut itself does not identify either adjacent portion. Ignoring it
    // would let one click remove both sides (or the entire curve).
    if (inner.some((c) => c.t === tc)) return false;
    const before = inner.filter((c) => c.t < tc).sort((a, b) => b.t - a.t)[0];
    const after = inner.filter((c) => c.t > tc).sort((a, b) => a.t - b.t)[0];
    if (!before && !after) { deleteItems(sk, [curveId]); return true; }
    if (e.t === 'spline') return false;
    const startId = e.a, endId = e.b;
    if (e.t === 'line') dropLengthDimensions(sk, e.id);
    if (before && after) {
      // Split: keep [start, before] on this entity and add [after, end].
      const p1 = cutEnd(sk, before, newId), p2 = cutEnd(sk, after, newId);
      const copy = { ...e, id: newId(e.t === 'line' ? 'l' : 'a'), a: p2, b: endId } as SkLine | SkArc;
      e.b = p1;
      sk.entities.push(copy);
      // The two pieces stay one curve: the far piece would otherwise lose the
      // original's relations (horizontal, tangent...) and swing free. Arcs
      // already share their centre point, so equal radii keep them coradial.
      sk.constraints.push({ id: newId('r'), type: e.t === 'line' ? 'collinear' : 'equal', refs: [e.id, copy.id] });
      moveConstraintsOnPoint(sk, endId, copy.id, e.id);
      return true;
    }
    if (before) {
      e.b = cutEnd(sk, before, newId);
      dropOrphan(sk, endId);
    } else if (after) {
      e.a = cutEnd(sk, after, newId);
      dropOrphan(sk, startId);
    }
    cleanupConstraints(sk);
    return true;
  }
  // Circle: needs two cuts and becomes an arc covering the rest.
  if (e.t === 'circle') {
    // Several cutting curves can report the same point. Count locations,
    // including across the angle seam, rather than producing a full-circle
    // arc from two coincident ends. Bound merging in both angle and length.
    const tolerance = Math.min(1e-9, 1e-7 / e.r);
    const sorted: typeof cuts = [];
    for (const cut of cuts.sort((a, b) => a.t - b.t)) {
      if (!sorted.length || cut.t - sorted[sorted.length - 1].t > tolerance) sorted.push(cut);
    }
    if (sorted.length > 1 && 2 * Math.PI - sorted[sorted.length - 1].t + sorted[0].t <= tolerance) sorted.pop();
    if (sorted.length < 2) { deleteItems(sk, [curveId]); return true; }
    if (cuts.some((c) => c.t === tc)) return false;
    let lo = sorted[sorted.length - 1], hi = sorted[0];
    for (let i = 0; i + 1 < sorted.length; i++) if (tc >= sorted[i].t && tc <= sorted[i + 1].t) { lo = sorted[i]; hi = sorted[i + 1]; }
    const c = ix.pt(e.c);
    const on = (cut: typeof lo): typeof lo => ({ ...cut, p: [c[0] + e.r * Math.cos(cut.t), c[1] + e.r * Math.sin(cut.t)] });
    const ia = cutEnd(sk, on(hi), newId), ib = cutEnd(sk, on(lo), newId);
    const idx = sk.entities.indexOf(e);
    const arc: SkArc = { id: e.id, t: 'arc', c: e.c, a: ia, b: ib, construction: e.construction };
    sk.entities[idx] = arc;
    // Radius-based constraints still apply to the arc; nothing else to fix.
    return true;
  }
  return false;
}

function dropOrphan(sk: SketchFeature, pid: Id) {
  if (!usedPoints(sk.entities).has(pid)) {
    sk.entities = sk.entities.filter((x) => x.id !== pid);
    cleanupConstraints(sk);
  }
}

/** After a split, relations on the far end point follow the new piece. */
function moveConstraintsOnPoint(sk: SketchFeature, pointId: Id, newCurve: Id, oldCurve: Id) {
  // End point ids are shared, so point relations need no change. Curve-level
  // relations (horizontal, parallel...) stay on the original piece, except a
  // tangency with a curve that meets the far end point: it belongs to the new
  // piece there. Left on the original piece, it made that piece's extension
  // tangent at a point the new piece also passes through, which pins the
  // same point twice (over defined) and lets the new piece leave tangency.
  const ix = new SketchIndex(sk.entities);
  const old = ix.get(oldCurve);
  if (old?.t !== 'line' && old?.t !== 'arc') return;
  const meets = (id: Id, p: Id) => { const o = ix.get(id); return (o?.t === 'line' || o?.t === 'arc') && (o.a === p || o.b === p); };
  for (const k of sk.constraints) {
    if (k.type !== 'tangent' || !k.refs.includes(oldCurve)) continue;
    const others = k.refs.filter((r) => r !== oldCurve);
    if (others.some((r) => meets(r, pointId)) && !others.some((r) => meets(r, old.a))) {
      k.refs = k.refs.map((r) => (r === oldCurve ? newCurve : r));
    }
  }
}

/**
 * Extends the end of a line nearest `at` to the closest intersection. With
 * `newId`, the new end is kept on the curve it reached (as trim does).
 */
export function extendAt(sk: SketchFeature, lineId: Id, at: Vec2, newId?: (p: string) => Id): boolean {
  const ix = new SketchIndex(sk.entities);
  const l = ix.get(lineId);
  if (!l || l.t !== 'line' || l.ext) return false;
  const a = ix.pt(l.a), b = ix.pt(l.b);
  const fromB = dist2(at, b) < dist2(at, a);
  const start = fromB ? a : b, end = fromB ? b : a;
  const dir = norm2(sub2(end, start));
  let best: Vec2 | null = null, bestD = Infinity, by: SkEntity | null = null;
  for (const o of sk.entities) {
    if (o.t === 'point' || o.id === lineId) continue;
    for (const q of primsOf(ix, o as SkCurve)) {
      // Extend the supporting line, then keep only forward intersections.
      // A finite proxy both limits reach and admits backward hits within its
      // segment tolerance, which could make Extend shorten the selected line.
      for (const p of intersectPrims({ kind: 'seg', a: start, b: end }, q, true)) {
        const d = dot2(sub2(p, end), dir);
        if (d > 1e-7 && d < bestD) { bestD = d; best = p; by = o; }
      }
    }
  }
  if (!best) return false;
  const pid = fromB ? l.b : l.a;
  const pt = sk.entities.find((e) => e.id === pid) as SkPoint;
  pt.x = best[0];
  pt.y = best[1];
  dropLengthDimensions(sk, lineId);
  if (newId && by) sk.constraints.push({ id: newId('r'), type: 'coincident', refs: [pid, by.id] });
  return true;
}

// ---------- fillet ----------

/** Rounds the corner at a point shared by two lines. */
export function filletCorner(sk: SketchFeature, pointId: Id, radius: number, newId: (p: string) => Id): string | null {
  const ix = new SketchIndex(sk.entities);
  let lines = sk.entities.filter((e): e is SkLine => e.t === 'line' && (e.a === pointId || e.b === pointId));
  // Construction lines ending at the corner (a center rectangle's diagonals,
  // the full length an earlier fillet keeps) stay on the virtual sharp.
  if (lines.length > 2 && lines.filter((l) => !l.construction).length === 2) lines = lines.filter((l) => !l.construction);
  if (lines.length !== 2) return 'Select a corner where exactly two lines meet';
  if (lines.some((l) => l.ext)) return PROJECTED_LOCKED;
  const corner = ix.pt(pointId);
  const far = lines.map((l) => ix.pt(l.a === pointId ? l.b : l.a));
  const u1 = norm2(sub2(far[0], corner)), u2 = norm2(sub2(far[1], corner));
  const cos = Math.max(-1, Math.min(1, dot2(u1, u2)));
  const theta = Math.acos(cos);
  if (theta < 1e-3 || Math.PI - theta < 1e-3) return 'The lines are parallel';
  const t = radius / Math.tan(theta / 2);
  if (t >= dist2(far[0], corner) - 1e-9 || t >= dist2(far[1], corner) - 1e-9) return 'The fillet radius is too large for these lines';
  const t1: Vec2 = [corner[0] + u1[0] * t, corner[1] + u1[1] * t];
  const t2: Vec2 = [corner[0] + u2[0] * t, corner[1] + u2[1] * t];
  const bis = norm2([u1[0] + u2[0], u1[1] + u2[1]]);
  const cd = radius / Math.sin(theta / 2);
  const c: Vec2 = [corner[0] + bis[0] * cd, corner[1] + bis[1] * cd];
  const p1 = newId('p'), p2 = newId('p'), pc = newId('p');
  sk.entities.push({ id: p1, t: 'point', x: t1[0], y: t1[1] }, { id: p2, t: 'point', x: t2[0], y: t2[1] }, { id: pc, t: 'point', x: c[0], y: c[1] });
  lines[0][lines[0].a === pointId ? 'a' : 'b'] = p1;
  lines[1][lines[1].a === pointId ? 'a' : 'b'] = p2;
  // The lines no longer reach the corner, so their length dimensions would
  // pull them back over the fillet. They measure to the virtual sharp instead.
  // Relations that use a line's ends (equal lengths, a midpoint, a symmetric
  // pair) would likewise shrink the rest of the sketch to match - one fillet
  // on a polygon distorted it - so they move to a construction line that
  // keeps the full length up to the virtual sharp.
  const usesEnds = (k: SkConstraint, id: Id) => !isDimension(k)
    && (k.type === 'equal' || k.type === 'midpoint' ? k.refs.includes(id) : k.type === 'symmetric' && k.refs.slice(0, -1).includes(id));
  lines.forEach((l, i) => {
    const farId = l.a === (i === 0 ? p1 : p2) ? l.b : l.a;
    for (const k of sk.constraints) {
      if (isDimension(k) && k.refs.length === 1 && k.refs[0] === l.id && (k.type === 'distance' || k.type === 'hdistance' || k.type === 'vdistance')) k.refs = [farId, pointId];
    }
    if (!sk.constraints.some((k) => usesEnds(k, l.id))) return;
    const full = newId('l');
    const fromFar = l.a === farId;
    sk.entities.push({ id: full, t: 'line', a: fromFar ? farId : pointId, b: fromFar ? pointId : farId, construction: true });
    for (const k of sk.constraints) if (usesEnds(k, l.id)) k.refs = k.refs.map((r, j) => (r === l.id && !(k.type === 'symmetric' && j === k.refs.length - 1) ? full : r));
  });
  // Counter-clockwise from the start tangent point to the end one.
  const ccw = cross2(sub2(t1, c), sub2(t2, c)) > 0;
  const arcId = newId('a');
  sk.entities.push({ id: arcId, t: 'arc', c: pc, a: ccw ? p1 : p2, b: ccw ? p2 : p1, construction: lines.every((l) => l.construction) || undefined });
  // The old corner point keeps its relations (e.g. dimensions) as a virtual sharp.
  const cornerUsed = usedPoints(sk.entities).has(pointId);
  const keepCorner = cornerUsed || sk.constraints.some((k) => k.refs.includes(pointId));
  if (!keepCorner) sk.entities = sk.entities.filter((e) => e.id !== pointId);
  else {
    if (!cornerUsed) sk.entities.find((e) => e.id === pointId)!.construction = true;
    // Keep the virtual sharp on both lines, including when another curve
    // still uses it as a center or endpoint instead of an explicit relation.
    sk.constraints.push({ id: newId('r'), type: 'coincident', refs: [pointId, lines[0].id] }, { id: newId('r'), type: 'coincident', refs: [pointId, lines[1].id] });
  }
  sk.constraints.push(
    { id: newId('r'), type: 'tangent', refs: [lines[0].id, arcId] },
    { id: newId('r'), type: 'tangent', refs: [lines[1].id, arcId] },
  );
  return null;
}

// ---------- offset ----------

interface ChainItem {
  c: SkLine | SkArc;
  /** Traversed from a to b (true) or b to a. */
  fwd: boolean;
}

/** Orders connected lines/arcs into chains (open or closed). */
export function orderChains(ix: SketchIndex, curves: (SkLine | SkArc)[]): { items: ChainItem[]; closed: boolean }[] {
  const ends = (c: SkLine | SkArc): [Id, Id] => [c.a, c.b];
  const key = (id: Id) => { const p = ix.pt(id); return `${p[0].toFixed(7)},${p[1].toFixed(7)}`; };
  const byPoint = new Map<string, (SkLine | SkArc)[]>();
  for (const c of curves) for (const p of ends(c)) {
    const k = key(p);
    const l = byPoint.get(k);
    if (l) l.push(c); else byPoint.set(k, [c]);
  }
  const used = new Set<Id>();
  const chains: { items: ChainItem[]; closed: boolean }[] = [];
  // Start open chains at a dangling end so they are walked in one piece.
  const order = [...curves].sort((p, q) => {
    const dp = ends(p).some((e) => (byPoint.get(key(e))?.length ?? 0) < 2) ? 0 : 1;
    const dq = ends(q).some((e) => (byPoint.get(key(e))?.length ?? 0) < 2) ? 0 : 1;
    return dp - dq;
  });
  for (const start of order) {
    if (used.has(start.id)) continue;
    used.add(start.id);
    // Walk forward from the free end if there is one.
    const startFree = (byPoint.get(key(start.a))?.length ?? 0) < 2;
    const items: ChainItem[] = [{ c: start, fwd: startFree || (byPoint.get(key(start.b))?.length ?? 0) >= 2 }];
    if (!startFree && (byPoint.get(key(start.b))?.length ?? 0) < 2) items[0].fwd = false;
    let tail = items[0].fwd ? start.b : start.a;
    for (;;) {
      const next = (byPoint.get(key(tail)) ?? []).find((c) => !used.has(c.id));
      if (!next) break;
      used.add(next.id);
      const fwd = key(next.a) === key(tail);
      items.push({ c: next, fwd });
      tail = fwd ? next.b : next.a;
    }
    const head = items[0].fwd ? items[0].c.a : items[0].c.b;
    chains.push({ items, closed: items.length > 1 && key(head) === key(tail) });
  }
  return chains;
}

/**
 * Offsets curves by a distance. Connected lines and arcs are treated as
 * chains: closed chains grow outward for positive distances (shrink for
 * negative); open chains move to the left of their walking direction.
 * Circles grow in radius. Corners are re-joined.
 */
export function offsetCurves(sk: SketchFeature, ids: Id[], distance: number, newId: (p: string) => Id): Id[] {
  const ix = new SketchIndex(sk.entities);
  const created: Id[] = [];
  const pt = (p: Vec2) => {
    const id = newId('p');
    sk.entities.push({ id, t: 'point', x: p[0], y: p[1] });
    return id;
  };
  const picked = ids.map((id) => ix.get(id)).filter((e): e is SkCurve => !!e && e.t !== 'point');
  // A box around a shape also picks its construction lines (a center
  // rectangle's diagonals, a fillet's virtual sharp): offset the outline, not
  // those, which would join the chains and come out as solid lines.
  const solid = picked.filter((c) => !c.construction);
  const curves = solid.length ? solid : picked;
  for (const c of curves) {
    if (c.t !== 'circle') continue;
    const r = c.r + distance;
    if (r <= 0) continue;
    const id = newId('c');
    sk.entities.push({ id, t: 'circle', c: pt(ix.pt(c.c)), r, construction: c.construction || undefined });
    sk.constraints.push({ id: newId('r'), type: 'concentric', refs: [c.id, id] });
    created.push(id);
  }
  const chainable = curves.filter((c): c is SkLine | SkArc => c.t === 'line' || c.t === 'arc');
  for (const chain of orderChains(ix, chainable)) {
    // Offset to the left of travel by `s`.
    let s = distance;
    if (chain.closed) {
      let area = 0;
      // Measure area near the profile, avoiding cancellation of large world-coordinate products.
      const origin = ix.pt(chain.items[0].c.a);
      for (const it of chain.items) {
        const poly = tessellate(ix, it.c, 0.05);
        if (!it.fwd) poly.reverse();
        for (let i = 0; i + 1 < poly.length; i++) {
          const p = poly[i], q = poly[i + 1];
          area += (p[0] - origin[0]) * (q[1] - origin[1]) - (q[0] - origin[0]) * (p[1] - origin[1]);
        }
      }
      // Counter-clockwise loops have their inside on the left: outward is right.
      s = area > 0 ? -distance : distance;
    }
    type Off = { kind: 'line'; a: Vec2; b: Vec2; src: SkLine } | { kind: 'arc'; c: Vec2; r: number; a: Vec2; b: Vec2; src: SkArc; fwd: boolean };
    const offs: Off[] = [];
    let failed = false;
    for (const it of chain.items) {
      if (it.c.t === 'line') {
        const p = ix.pt(it.fwd ? it.c.a : it.c.b), q = ix.pt(it.fwd ? it.c.b : it.c.a);
        const n = norm2([-(q[1] - p[1]), q[0] - p[0]]);
        offs.push({ kind: 'line', a: [p[0] + n[0] * s, p[1] + n[1] * s], b: [q[0] + n[0] * s, q[1] + n[1] * s], src: it.c });
      } else {
        const { c, r } = arcAngles(ix, it.c);
        // Travelling counter-clockwise (forward) keeps the centre on the left.
        const nr = it.fwd ? r - s : r + s;
        if (nr <= 1e-9) { failed = true; break; }
        const p = ix.pt(it.fwd ? it.c.a : it.c.b), q = ix.pt(it.fwd ? it.c.b : it.c.a);
        const at = (v: Vec2): Vec2 => { const u = norm2(sub2(v, c)); return [c[0] + u[0] * nr, c[1] + u[1] * nr]; };
        offs.push({ kind: 'arc', c, r: nr, a: at(p), b: at(q), src: it.c, fwd: it.fwd });
      }
    }
    if (failed || !offs.length) continue;
    // Join neighbours: coincident ends stay, lines meet at their intersection,
    // otherwise the nearer intersection with the arc's circle is used.
    const join = (x: Off, y: Off): boolean => {
      if (dist2(x.b, y.a) < 1e-9) { y.a = x.b; return true; }
      let p: Vec2 | null = null;
      if (x.kind === 'line' && y.kind === 'line') p = lineIntersection(x.a, x.b, y.a, y.b);
      else {
        const prims = (o: Off) => (o.kind === 'line' ? { kind: 'seg' as const, a: o.a, b: o.b } : { kind: 'circ' as const, c: o.c, r: o.r });
        // Joins use supporting lines, with no arbitrary extension-distance cap.
        const px = prims(x), py = prims(y);
        const pts = x.kind === 'line' ? intersectPrims(px, py, true)
          : y.kind === 'line' ? intersectPrims(py, px, true) : intersectPrims(px, py);
        const mid: Vec2 = [(x.b[0] + y.a[0]) / 2, (x.b[1] + y.a[1]) / 2];
        p = pts.sort((u, v) => dist2(u, mid) - dist2(v, mid))[0] ?? null;
      }
      if (!p) return false;
      x.b = p; y.a = p;
      return true;
    };
    for (let i = 0; i + 1 < offs.length; i++) {
      if (!join(offs[i], offs[i + 1])) { failed = true; break; }
    }
    // Reject the whole chain before writing any geometry if a corner cannot join.
    if (failed || (chain.closed && !join(offs[offs.length - 1], offs[0]))) continue;
    // An offset past the far side of the shape turns pieces around (a line
    // runs backwards, an arc wraps the other way): that is no offset at all.
    const turned = offs.some((o, i) => {
      const it = chain.items[i];
      const p = ix.pt(it.fwd ? it.c.a : it.c.b), q = ix.pt(it.fwd ? it.c.b : it.c.a);
      if (o.kind === 'line') return dot2(sub2(o.b, o.a), sub2(q, p)) <= 0;
      const sweep = (u: Vec2, v: Vec2) => {
        const s0 = wrap2Pi(angle2(sub2(v, o.c)) - angle2(sub2(u, o.c)));
        return o.fwd ? s0 : wrap2Pi(-s0);
      };
      const before = sweep(p, q), after = sweep(o.a, o.b);
      // A collapsed partial arc would be interpreted as a full circle.
      return (after < 1e-9 && before >= 1e-9) || Math.abs(after - before) > Math.PI;
    });
    if (turned) continue;
    const ptIds = new Map<string, Id>();
    const pointFor = (p: Vec2) => {
      const k = `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
      let id = ptIds.get(k);
      if (!id) { id = pt(p); ptIds.set(k, id); }
      return id;
    };
    const made: Id[] = [];
    const concentric: SkConstraint[] = [], tangent: SkConstraint[] = [], parallel: SkConstraint[] = [];
    for (const o of offs) {
      if (o.kind === 'line') {
        const id = newId('l');
        sk.entities.push({ id, t: 'line', a: pointFor(o.a), b: pointFor(o.b), construction: o.src.construction || undefined });
        parallel.push({ id: newId('r'), type: 'parallel', refs: [o.src.id, id] });
        made.push(id);
      } else {
        const id = newId('a');
        const a = pointFor(o.a), b = pointFor(o.b);
        // Keep the arc counter-clockwise from its start to its end.
        const construction = o.src.construction || undefined;
        sk.entities.push(o.fwd ? { id, t: 'arc', c: pt(o.c), a, b, construction } : { id, t: 'arc', c: pt(o.c), a: b, b: a, construction });
        concentric.push({ id: newId('r'), type: 'concentric', refs: [o.src.id, id] });
        made.push(id);
      }
    }
    // Pieces that met tangentially still do: an offset fillet stays a fillet.
    const travel = (it: ChainItem, atEnd: boolean): Vec2 => {
      const c = it.c;
      const v = ix.pt(atEnd === it.fwd ? c.b : c.a);
      if (c.t === 'line') { const d = norm2(sub2(ix.pt(c.b), ix.pt(c.a))); return it.fwd ? d : [-d[0], -d[1]]; }
      const r = norm2(sub2(v, ix.pt(c.c)));
      return it.fwd ? [-r[1], r[0]] : [r[1], -r[0]];
    };
    const n = chain.items.length;
    for (let i = 0; i < (chain.closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      if (chain.items[i].c.t === 'line' && chain.items[j].c.t === 'line') continue;
      const t1 = travel(chain.items[i], true), t2 = travel(chain.items[j], false);
      if (Math.abs(cross2(t1, t2)) < 1e-6 && dot2(t1, t2) > 0) tangent.push({ id: newId('r'), type: 'tangent', refs: [made[i], made[j]] });
    }
    // Around a closed loop the last of these relations can follow from the
    // others (parallel sides tangent to concentric arcs): keep only those
    // that add something, so the offset never over-defines the sketch.
    const added = [...concentric, ...tangent, ...parallel];
    // Analyze the current geometry only; no solve or coordinate write-back.
    const analysis = new SketchSystem(sk.entities, [...sk.constraints, ...added], { value: (d) => measureDimension(sk, d), maxIterations: 0 }).run();
    sk.constraints.push(...added.filter((c) => !analysis.badConstraints.has(c.id)));
    created.push(...made);
  }
  return created;
}

// ---------- mirror ----------

/** A mirror needs a resolvable line direction; collapsed axes have none. */
export function mirrorAxisDirection(ix: SketchIndex, axisId: Id): Vec2 | null {
  const axis = ix.get(axisId);
  if (axis?.t !== 'line') return null;
  const u = norm2(sub2(ix.pt(axis.b), ix.pt(axis.a)));
  return u.every(Number.isFinite) && (u[0] !== 0 || u[1] !== 0) ? u : null;
}

/**
 * The line a selection is mirrored about: its centerline, or else its last
 * line. With several centerlines, construction lines that end on other selected
 * curves (a center rectangle's diagonals, the full length a fillet keeps) are
 * part of the shape, not the axis; if that still leaves no single centerline
 * the choice is ambiguous and an error message is returned instead.
 */
export function pickMirrorAxis(sk: SketchFeature, ids: Id[]): { axis: Id } | { error: string } | null {
  const ix = new SketchIndex(sk.entities);
  const lines = ids.map((id) => ix.get(id)).filter((e): e is SkLine => e?.t === 'line');
  const centerlines = lines.filter((l) => l.construction);
  if (!centerlines.length) return lines.length ? { axis: lines[lines.length - 1].id } : null;
  if (centerlines.length === 1) return { axis: centerlines[0].id };
  const curvePoints = (e: SkEntity): Id[] => e.t === 'line' || e.t === 'arc' ? [e.a, e.b, ...(e.t === 'arc' ? [e.c] : [])]
    : e.t === 'circle' ? [e.c] : e.t === 'spline' ? e.pts : [];
  const free = centerlines.filter((l) => !ids.some((id) => {
    const e = id === l.id ? undefined : ix.get(id);
    return !!e && curvePoints(e).some((p) => p === l.a || p === l.b);
  }));
  if (free.length === 1) return { axis: free[0].id };
  return { error: 'Several centerlines are selected. Deselect all but the one to mirror about.' };
}

/** Mirrors entities about a line, adding symmetric relations for points. */
export function mirrorEntities(sk: SketchFeature, ids: Id[], axisId: Id, newId: (p: string) => Id): Id[] {
  const ix = new SketchIndex(sk.entities);
  const axis = ix.get(axisId);
  if (!axis || axis.t !== 'line') return [];
  const u = mirrorAxisDirection(ix, axisId);
  if (!u) return [];
  const a = ix.pt(axis.a);
  const reflect = (p: Vec2): Vec2 => {
    const v = sub2(p, a);
    const t = dot2(v, u);
    const proj: Vec2 = [a[0] + u[0] * t, a[1] + u[1] * t];
    return [2 * proj[0] - p[0], 2 * proj[1] - p[1]];
  };
  const map = new Map<Id, Id>();
  const created: Id[] = [];
  const onAxis: SkConstraint[] = [];
  const mapPoint = (pid: Id): Id => {
    const existing = map.get(pid);
    if (existing) return existing;
    const p = ix.pt(pid);
    // Points on the axis are shared rather than duplicated.
    if (Math.abs(cross2(u, sub2(p, a))) < 1e-9) {
      map.set(pid, pid);
      if (pid !== axis.a && pid !== axis.b) onAxis.push({ id: newId('r'), type: 'coincident', refs: [pid, axisId] });
      return pid;
    }
    const r = reflect(p);
    const id = newId('p');
    sk.entities.push({ id, t: 'point', x: r[0], y: r[1] });
    sk.constraints.push({ id: newId('r'), type: 'symmetric', refs: [pid, id, axisId] });
    map.set(pid, id);
    return id;
  };
  for (const id of ids) {
    const e = ix.get(id);
    if (!e || id === axisId) continue;
    if (e.t === 'point') { created.push(mapPoint(e.id)); continue; }
    const nid = newId(e.t[0]);
    if (e.t === 'line') sk.entities.push({ id: nid, t: 'line', a: mapPoint(e.a), b: mapPoint(e.b), construction: e.construction });
    else if (e.t === 'circle') sk.entities.push({ id: nid, t: 'circle', c: mapPoint(e.c), r: e.r, construction: e.construction });
    else if (e.t === 'arc') sk.entities.push({ id: nid, t: 'arc', c: mapPoint(e.c), a: mapPoint(e.b), b: mapPoint(e.a), construction: e.construction });
    else if (e.t === 'spline') sk.entities.push({ id: nid, t: 'spline', pts: e.pts.map(mapPoint), construction: e.construction });
    // A mirrored arc's radius already follows from its symmetric points.
    if (e.t === 'circle') sk.constraints.push({ id: newId('r'), type: 'equal', refs: [e.id, nid] });
    created.push(nid);
  }
  if (onAxis.length) {
    // Keep shared points on the moving axis without duplicating a relation
    // already implied by dimensions, midpoint, coincidence chains, etc.
    // Analyze the current geometry only; no solve or coordinate write-back.
    const analysis = new SketchSystem(sk.entities, [...sk.constraints, ...onAxis], {
      value: (d) => measureDimension(sk, d, ix), maxIterations: 0,
    }).run();
    sk.constraints.push(...onAxis.filter((c) => !analysis.badConstraints.has(c.id)));
  }
  return created;
}

/** Angle of a sketch line in degrees (0..360). */
export function lineAngle(sk: SketchFeature, id: Id): number {
  const ix = new SketchIndex(sk.entities);
  const l = ix.get(id) as SkLine;
  return (wrap2Pi(angle2(sub2(ix.pt(l.b), ix.pt(l.a)))) * 180) / Math.PI;
}
