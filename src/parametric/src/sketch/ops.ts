// Pure sketch editing operations (no DOM): id allocation, deletion with
// dependent cleanup, relation availability, trim, extend, sketch fillet,
// offset, mirror and measurement of dimensions.

import type {
  DimensionType, Id, RelationType, SkArc, SkCircle, SkConstraint, SkCurve, SkDimension, SkEntity, SkLine, SkPoint,
  SketchFeature,
} from '../model/types';
import { isDimension } from '../model/types';
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
  const ent = sk.entities.find((e) => e.id === ids[n - 1]);
  const lastIsCenterline = ent?.t === 'line';
  if (n === 1) {
    if (lines === 1) out.push('horizontal', 'vertical');
    if (ids[0] !== ORIGIN_ID) out.push('fix');
    return out;
  }
  if (lines === n) {
    out.push('horizontal', 'vertical', 'parallel', 'equal');
    if (n === 2) out.push('perpendicular', 'collinear');
    if (n === 3 && lastIsCenterline) out.push('symmetric');
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
  else if (n === 3 && pts === 2 && lines === 1 && kinds[2] === 'line') out.push('symmetric');
  else if (n === 3 && circs === 2 && lines === 1 && kinds[2] === 'line') out.push('symmetric');
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

/** Drops dimensions of a line's own length, which no longer apply once it is trimmed or extended. */
function dropLengthDimensions(sk: SketchFeature, lineId: Id) {
  sk.constraints = sk.constraints.filter((k) => !(isDimension(k) && k.refs.length === 1 && k.refs[0] === lineId && (k.type === 'distance' || k.type === 'hdistance' || k.type === 'vdistance')));
}

/**
 * Removes the portion of a curve around `at` bounded by its nearest
 * intersections with other curves. Returns false if nothing changed.
 */
export function trimAt(sk: SketchFeature, curveId: Id, at: Vec2, newId: (p: string) => Id): boolean {
  const ix = new SketchIndex(sk.entities);
  const found = ix.get(curveId);
  if (!found || found.t === 'point') return false;
  const e: SkCurve = found;
  const cuts = cutPoints(sk, e).map((c) => ({ ...c, t: curveParam(ix, e, c.p) }));
  const tc = curveParam(ix, e, at);
  if (e.t === 'line' || e.t === 'arc' || e.t === 'spline') {
    const inner = cuts.filter((c) => c.t > 1e-6 && c.t < 1 - 1e-6);
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
    if (cuts.length < 2) { deleteItems(sk, [curveId]); return true; }
    const sorted = [...cuts].sort((a, b) => a.t - b.t);
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
function moveConstraintsOnPoint(_sk: SketchFeature, _pointId: Id, _newCurve: Id, _oldCurve: Id) {
  // End point ids are shared, so point relations need no change. Curve-level
  // relations (horizontal, parallel...) stay on the original piece.
}

/**
 * Extends the end of a line nearest `at` to the closest intersection. With
 * `newId`, the new end is kept on the curve it reached (as trim does).
 */
export function extendAt(sk: SketchFeature, lineId: Id, at: Vec2, newId?: (p: string) => Id): boolean {
  const ix = new SketchIndex(sk.entities);
  const l = ix.get(lineId);
  if (!l || l.t !== 'line') return false;
  const a = ix.pt(l.a), b = ix.pt(l.b);
  const fromB = dist2(at, b) < dist2(at, a);
  const start = fromB ? a : b, end = fromB ? b : a;
  const dir = norm2(sub2(end, start));
  const far: Vec2 = [end[0] + dir[0] * 1e6, end[1] + dir[1] * 1e6];
  let best: Vec2 | null = null, bestD = Infinity, by: SkEntity | null = null;
  for (const o of sk.entities) {
    if (o.t === 'point' || o.id === lineId) continue;
    for (const q of primsOf(ix, o as SkCurve)) {
      for (const p of intersectPrims({ kind: 'seg', a: end, b: far }, q)) {
        const d = dist2(p, end);
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
  const lines = sk.entities.filter((e): e is SkLine => e.t === 'line' && (e.a === pointId || e.b === pointId));
  if (lines.length !== 2) return 'Select a corner where exactly two lines meet';
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
  lines.forEach((l, i) => {
    const farId = l.a === (i === 0 ? p1 : p2) ? l.b : l.a;
    for (const k of sk.constraints) {
      if (isDimension(k) && k.refs.length === 1 && k.refs[0] === l.id && (k.type === 'distance' || k.type === 'hdistance' || k.type === 'vdistance')) k.refs = [farId, pointId];
    }
  });
  // Counter-clockwise from the start tangent point to the end one.
  const ccw = cross2(sub2(t1, c), sub2(t2, c)) > 0;
  const arcId = newId('a');
  sk.entities.push({ id: arcId, t: 'arc', c: pc, a: ccw ? p1 : p2, b: ccw ? p2 : p1 });
  // The old corner point keeps its relations (e.g. dimensions) as a virtual sharp.
  const cornerUsed = usedPoints(sk.entities).has(pointId);
  if (!cornerUsed) {
    const keep = sk.constraints.some((k) => k.refs.includes(pointId));
    if (!keep) sk.entities = sk.entities.filter((e) => e.id !== pointId);
    else {
      sk.entities.find((e) => e.id === pointId)!.construction = true;
      // Keep the virtual sharp on both lines.
      sk.constraints.push({ id: newId('r'), type: 'coincident', refs: [pointId, lines[0].id] }, { id: newId('r'), type: 'coincident', refs: [pointId, lines[1].id] });
    }
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
  const curves = ids.map((id) => ix.get(id)).filter((e): e is SkCurve => !!e && e.t !== 'point');
  for (const c of curves) {
    if (c.t !== 'circle') continue;
    const r = c.r + distance;
    if (r <= 0) continue;
    const id = newId('c');
    sk.entities.push({ id, t: 'circle', c: pt(ix.pt(c.c)), r });
    sk.constraints.push({ id: newId('r'), type: 'concentric', refs: [c.id, id] });
    created.push(id);
  }
  const chainable = curves.filter((c): c is SkLine | SkArc => c.t === 'line' || c.t === 'arc');
  for (const chain of orderChains(ix, chainable)) {
    // Offset to the left of travel by `s`.
    let s = distance;
    if (chain.closed) {
      let area = 0;
      for (const it of chain.items) {
        const poly = tessellate(ix, it.c, 0.05);
        if (!it.fwd) poly.reverse();
        for (let i = 0; i + 1 < poly.length; i++) area += cross2(poly[i], poly[i + 1]);
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
    const join = (x: Off, y: Off) => {
      if (dist2(x.b, y.a) < 1e-9) { y.a = x.b; return; }
      let p: Vec2 | null = null;
      if (x.kind === 'line' && y.kind === 'line') p = lineIntersection(x.a, x.b, y.a, y.b);
      else {
        const prims = (o: Off) => (o.kind === 'line' ? { kind: 'seg' as const, a: o.a, b: o.b } : { kind: 'circ' as const, c: o.c, r: o.r });
        const far = (o: Off) => (o.kind === 'line' ? { ...prims(o), a: [o.a[0] - (o.b[0] - o.a[0]) * 1e3, o.a[1] - (o.b[1] - o.a[1]) * 1e3] as Vec2, b: [o.b[0] + (o.b[0] - o.a[0]) * 1e3, o.b[1] + (o.b[1] - o.a[1]) * 1e3] as Vec2 } : prims(o));
        const pts = intersectPrims(far(x), far(y));
        const mid: Vec2 = [(x.b[0] + y.a[0]) / 2, (x.b[1] + y.a[1]) / 2];
        p = pts.sort((u, v) => dist2(u, mid) - dist2(v, mid))[0] ?? null;
      }
      if (p) { x.b = p; y.a = p; }
    };
    for (let i = 0; i + 1 < offs.length; i++) join(offs[i], offs[i + 1]);
    if (chain.closed) join(offs[offs.length - 1], offs[0]);
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
      return Math.abs(sweep(o.a, o.b) - sweep(p, q)) > Math.PI;
    });
    if (turned) continue;
    const ptIds = new Map<string, Id>();
    const pointFor = (p: Vec2) => {
      const k = `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
      let id = ptIds.get(k);
      if (!id) { id = pt(p); ptIds.set(k, id); }
      return id;
    };
    for (const o of offs) {
      if (o.kind === 'line') {
        const id = newId('l');
        sk.entities.push({ id, t: 'line', a: pointFor(o.a), b: pointFor(o.b) });
        sk.constraints.push({ id: newId('r'), type: 'parallel', refs: [o.src.id, id] });
        created.push(id);
      } else {
        const id = newId('a');
        const a = pointFor(o.a), b = pointFor(o.b);
        // Keep the arc counter-clockwise from its start to its end.
        sk.entities.push(o.fwd ? { id, t: 'arc', c: pt(o.c), a, b } : { id, t: 'arc', c: pt(o.c), a: b, b: a });
        sk.constraints.push({ id: newId('r'), type: 'concentric', refs: [o.src.id, id] });
        created.push(id);
      }
    }
  }
  return created;
}

// ---------- mirror ----------

/** Mirrors entities about a line, adding symmetric relations for points. */
export function mirrorEntities(sk: SketchFeature, ids: Id[], axisId: Id, newId: (p: string) => Id): Id[] {
  const ix = new SketchIndex(sk.entities);
  const axis = ix.get(axisId);
  if (!axis || axis.t !== 'line') return [];
  const a = ix.pt(axis.a), b = ix.pt(axis.b);
  const u = norm2(sub2(b, a));
  const reflect = (p: Vec2): Vec2 => {
    const v = sub2(p, a);
    const t = dot2(v, u);
    const proj: Vec2 = [a[0] + u[0] * t, a[1] + u[1] * t];
    return [2 * proj[0] - p[0], 2 * proj[1] - p[1]];
  };
  const map = new Map<Id, Id>();
  const created: Id[] = [];
  const mapPoint = (pid: Id): Id => {
    const existing = map.get(pid);
    if (existing) return existing;
    const p = ix.pt(pid);
    // Points on the axis are shared rather than duplicated.
    if (Math.abs(cross2(u, sub2(p, a))) < 1e-9) { map.set(pid, pid); return pid; }
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
    if (e.t === 'circle' || e.t === 'arc') sk.constraints.push({ id: newId('r'), type: 'equal', refs: [e.id, nid] });
    created.push(nid);
  }
  return created;
}

/** Angle of a sketch line in degrees (0..360). */
export function lineAngle(sk: SketchFeature, id: Id): number {
  const ix = new SketchIndex(sk.entities);
  const l = ix.get(id) as SkLine;
  return (wrap2Pi(angle2(sub2(ix.pt(l.b), ix.pt(l.a)))) * 180) / Math.PI;
}
