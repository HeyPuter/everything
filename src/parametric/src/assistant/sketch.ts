// Sketch editing for the assistant: shapes at exact coordinates, relations,
// dimensions and sketch operations, applied to a copy of the sketch, solved,
// and described back (entities with coordinates, definition status, closed
// profiles). Coordinates in arguments are display units: [x, y] in the
// sketch plane, or [x, y, z] in world space projected onto the plane.

import type { EdgeInfo } from '../kernel/protocol';
import { type Frame, type Vec2, type Vec3, cross2, dist2, dot, norm2, sub, sub2, toLocal } from '../math/vec';
import type { DocStore } from '../model/document';
import type { DimensionType, Id, RelationType, SkArc, SkConstraint, SkDimension, SkEntity, SkLine, SketchFeature } from '../model/types';
import { isDimension } from '../model/types';
import { convertEdges } from '../sketch/convert';
import { ORIGIN_ID, SketchIndex, arcAngles, arcRadius } from '../sketch/geom';
import {
  RELATION_LABELS, availableRelations, cleanupConstraints, deleteItems, filletCorner, idFactory, kindOf, makeRelations, measureDimension,
  mirrorEntities, nextDimName, offsetCurves, usedPoints,
} from '../sketch/ops';
import { buildProfiles, sketchPoints } from '../sketch/profiles';
import { type SolveResult, solveSketch } from '../sketch/solver';
import { ToolError, type Units, num } from './units';

type Obj = Record<string, unknown>;

const RELATIONS: RelationType[] = ['coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent', 'equal', 'concentric', 'midpoint', 'collinear', 'fix', 'symmetric'];
const DIMENSIONS: DimensionType[] = ['distance', 'hdistance', 'vdistance', 'radius', 'diameter', 'angle'];
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** Works on a copy of one sketch; nothing reaches the document until commit. */
export class SketchEdit {
  readonly sk: SketchFeature;
  private ix!: SketchIndex;
  private used: Set<string>;
  private gen: (p: string) => Id;
  /** Messages for the model (projections, merged points, skipped items). */
  readonly notes: string[] = [];
  /** Ids created by this edit, in order. */
  readonly created: Id[] = [];
  autoRelations = true;

  constructor(sketch: SketchFeature, readonly frame: Frame, private units: Units, private store: DocStore) {
    units.onUnlinked = (what, expr, mm) => this.notes.push(`${what}: "${expr}" was used as its value now, ${units.len(mm, true)}; sketch coordinates and shape sizes do not follow variables. To keep it linked, add a dimension with value "${expr}".`);
    this.sk = structuredClone(sketch);
    this.used = new Set([...this.sk.entities.map((e) => e.id), ...this.sk.constraints.map((c) => c.id), ORIGIN_ID]);
    const raw = idFactory(this.sk);
    this.gen = (p) => {
      let id: Id;
      do id = raw(p); while (this.used.has(id));
      this.used.add(id);
      return id;
    };
  }

  private index() {
    this.ix = new SketchIndex(this.sk.entities);
    return this.ix;
  }

  /** A model-chosen id (checked) or a generated one. */
  private claim(v: unknown, prefix: string): Id {
    if (v == null || v === '') return this.gen(prefix);
    const id = str(v);
    if (!ID_RE.test(id)) throw new ToolError(`id "${id}": use a letter followed by letters, digits, _ or - (at most 40 characters)`);
    if (this.used.has(id)) throw new ToolError(`id "${id}" is already used in ${this.sk.id}`);
    this.used.add(id);
    return id;
  }

  private sub(base: Id, part: string): Id {
    const id = `${base}_${part}`;
    if (this.used.has(id)) return this.gen(`${base}_${part}_`);
    this.used.add(id);
    return id;
  }

  /** Sketch coordinates (mm) for a point argument. */
  pt(v: unknown, what: string): Vec2 {
    const p = this.units.point(v, what);
    if (p.length === 2) return [p[0], p[1]];
    const w = p as Vec3;
    const off = dot(sub(w, this.frame.o), this.frame.n);
    const local = toLocal(this.frame, w);
    if (Math.abs(off) > 1e-6) this.notes.push(`${what} ${this.units.pt(w)} is ${this.units.len(Math.abs(off), true)} off the sketch plane; projected to sketch ${this.units.pt(local)}`);
    return local;
  }

  private constraint(c: SkConstraint) {
    this.sk.constraints.push(c);
  }

  private relation(type: RelationType, refs: Id[]) {
    this.constraint({ id: this.gen('r'), type, refs });
  }

  /** A point entity; reuses an existing curve end point at the same place. */
  private point(p: Vec2, id: Id, opts: { merge?: boolean; construction?: boolean } = {}): Id {
    if (opts.merge) {
      const ends = usedPoints(this.sk.entities.filter((e) => e.t === 'line' || e.t === 'arc' || e.t === 'spline'));
      const hit = this.sk.entities.find((e) => e.t === 'point' && ends.has(e.id) && Math.hypot(e.x - p[0], e.y - p[1]) < 1e-6);
      if (hit) { this.used.delete(id); return hit.id; }
    }
    this.sk.entities.push({ id, t: 'point', x: p[0], y: p[1], ...(opts.construction ? { construction: true } : {}) });
    if (this.autoRelations && Math.hypot(p[0], p[1]) < 1e-9) this.relation('coincident', [id, ORIGIN_ID]);
    return id;
  }

  private line(id: Id, a: Id, b: Id, construction = false): Id {
    this.sk.entities.push({ id, t: 'line', a, b, ...(construction ? { construction: true } : {}) });
    this.created.push(id);
    if (this.autoRelations) {
      const ix = this.index();
      const pa = ix.pt(a), pb = ix.pt(b);
      if (Math.abs(pa[1] - pb[1]) < 1e-9) this.relation('horizontal', [id]);
      else if (Math.abs(pa[0] - pb[0]) < 1e-9) this.relation('vertical', [id]);
    }
    return id;
  }

  // ---------- shapes ----------

  addShape(s: unknown, i: number) {
    if (!isObj(s)) throw new ToolError(`shapes[${i}]: expected an object with a "type"`);
    const type = str(s.type).toLowerCase();
    const w = `shapes[${i}] (${type || '?'})`;
    const constr = s.construction === true;
    switch (type) {
      case 'point': {
        const id = this.claim(s.id, 'pt');
        this.point(this.pt(s.at ?? s.point ?? s.position, `${w}.at`), id, { construction: constr });
        this.created.push(id);
        return;
      }
      case 'line':
      case 'centerline': {
        const id = this.claim(s.id, type === 'line' ? 'line' : 'cl');
        const a = this.point(this.pt(s.from ?? s.start, `${w}.from`), this.sub(id, 'a'), { merge: true });
        const b = this.point(this.pt(s.to ?? s.end, `${w}.to`), this.sub(id, 'b'), { merge: true });
        if (dist2(this.index().pt(a), this.ix.pt(b)) < 1e-9) throw new ToolError(`${w}: the line has zero length`);
        this.line(id, a, b, constr || type === 'centerline');
        return;
      }
      case 'polyline':
      case 'polygon_points': {
        const id = this.claim(s.id, 'poly');
        const pts = list(s.points).map((p, k) => this.pt(p, `${w}.points[${k}]`));
        const closed = s.closed === true;
        if (closed && pts.length > 2 && dist2(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
        if (pts.length < 2 || (closed && pts.length < 3)) throw new ToolError(`${w}: needs at least ${closed ? 3 : 2} distinct points`);
        const ids = pts.map((p, k) => this.point(p, this.sub(id, `p${k}`), { merge: true }));
        const n = closed ? ids.length : ids.length - 1;
        for (let k = 0; k < n; k++) {
          if (dist2(pts[k], pts[(k + 1) % pts.length]) < 1e-9) throw new ToolError(`${w}: points ${k} and ${(k + 1) % pts.length} are the same`);
          this.line(this.sub(id, `l${k}`), ids[k], ids[(k + 1) % ids.length], constr);
        }
        return;
      }
      case 'rectangle':
      case 'center_rectangle': {
        const id = this.claim(s.id, 'rect');
        let x0: number, y0: number, x1: number, y1: number;
        let center: Vec2 | null = null;
        if (s.center != null) {
          center = this.pt(s.center, `${w}.center`);
          const wd = this.units.size(s.width, `${w}.width`), ht = this.units.size(s.height, `${w}.height`);
          [x0, y0, x1, y1] = [center[0] - wd / 2, center[1] - ht / 2, center[0] + wd / 2, center[1] + ht / 2];
        } else {
          const a = this.pt(s.corner1 ?? s.from, `${w}.corner1`), b = this.pt(s.corner2 ?? s.to, `${w}.corner2`);
          [x0, y0, x1, y1] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
          if (x1 - x0 < 1e-9 || y1 - y0 < 1e-9) throw new ToolError(`${w}: the corners must differ in both x and y`);
        }
        const corners: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        const ids = corners.map((p, k) => this.point(p, this.sub(id, `p${k}`), { merge: true }));
        const auto = this.autoRelations;
        this.autoRelations = false;
        const lines = ids.map((p, k) => this.line(this.sub(id, `l${k}`), p, ids[(k + 1) % 4], constr));
        this.autoRelations = auto;
        this.relation('horizontal', [lines[0]]);
        this.relation('horizontal', [lines[2]]);
        this.relation('vertical', [lines[1]]);
        this.relation('vertical', [lines[3]]);
        if (center && (type === 'center_rectangle' || s.center_point !== false)) {
          const c = this.point(center, this.sub(id, 'c'), { construction: true });
          const d0 = this.sub(id, 'd0'), d1 = this.sub(id, 'd1');
          this.sk.entities.push({ id: d0, t: 'line', a: ids[0], b: ids[2], construction: true }, { id: d1, t: 'line', a: ids[1], b: ids[3], construction: true });
          // One midpoint relation fixes the centre; the other diagonal passes through it anyway.
          this.relation('midpoint', [c, d0]);
        }
        return;
      }
      case 'circle': {
        const id = this.claim(s.id, 'circle');
        const c = this.pt(s.center, `${w}.center`);
        const r = s.diameter != null ? this.units.size(s.diameter, `${w}.diameter`) / 2 : this.units.size(s.radius, `${w}.radius`);
        const cid = this.point(c, this.sub(id, 'c'));
        this.sk.entities.push({ id, t: 'circle', c: cid, r, ...(constr ? { construction: true } : {}) });
        this.created.push(id);
        return;
      }
      case 'arc': {
        const id = this.claim(s.id, 'arc');
        let c: Vec2, a: Vec2, b: Vec2;
        if (s.through != null) {
          a = this.pt(s.start ?? s.from, `${w}.start`);
          b = this.pt(s.end ?? s.to, `${w}.end`);
          const m = this.pt(s.through, `${w}.through`);
          const cc = circumcenter(a, m, b);
          if (!cc) throw new ToolError(`${w}: the three points are on one line`);
          c = cc;
          // Counter-clockwise from a to b must pass through m; else swap.
          if (!ccwContains(c, a, b, m)) [a, b] = [b, a];
        } else {
          c = this.pt(s.center, `${w}.center`);
          if (s.start_angle != null || s.end_angle != null) {
            const r = this.units.size(s.radius, `${w}.radius`);
            const a0 = (num_(s.start_angle, `${w}.start_angle`) * Math.PI) / 180, a1 = (num_(s.end_angle, `${w}.end_angle`) * Math.PI) / 180;
            a = [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)];
            b = [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)];
          } else {
            a = this.pt(s.start ?? s.from, `${w}.start`);
            const e = this.pt(s.end ?? s.to, `${w}.end`);
            const r = dist2(a, c);
            const d = norm2(sub2(e, c));
            b = [c[0] + d[0] * r, c[1] + d[1] * r];
            if (Math.abs(dist2(e, c) - r) > 1e-6) this.notes.push(`${w}: end point moved onto the arc's radius ${this.units.len(r, true)}`);
          }
        }
        if (dist2(a, b) < 1e-9) throw new ToolError(`${w}: start and end are the same point (use a circle for a full circle)`);
        const cid = this.point(c, this.sub(id, 'c'));
        const aid = this.point(a, this.sub(id, 'a'), { merge: true });
        const bid = this.point(b, this.sub(id, 'b'), { merge: true });
        this.sk.entities.push({ id, t: 'arc', c: cid, a: aid, b: bid, ...(constr ? { construction: true } : {}) });
        this.created.push(id);
        return;
      }
      case 'polygon': {
        const id = this.claim(s.id, 'polygon');
        const c = this.pt(s.center, `${w}.center`);
        const n = Math.round(num_(s.sides, `${w}.sides`));
        if (n < 3 || n > 64) throw new ToolError(`${w}.sides: 3 to 64`);
        let r = this.units.size(s.radius, `${w}.radius`);
        if (s.inscribed === false) r /= Math.cos(Math.PI / n);
        const a0 = s.angle != null ? (num_(s.angle, `${w}.angle`) * Math.PI) / 180 : Math.PI / 2;
        const cid = this.point(c, this.sub(id, 'c'));
        const circ = this.sub(id, 'circle');
        this.sk.entities.push({ id: circ, t: 'circle', c: cid, r, construction: true });
        const ids = Array.from({ length: n }, (_, k) => this.point([c[0] + r * Math.cos(a0 + (k * 2 * Math.PI) / n), c[1] + r * Math.sin(a0 + (k * 2 * Math.PI) / n)], this.sub(id, `p${k}`)));
        const auto = this.autoRelations;
        this.autoRelations = false;
        const lines = ids.map((p, k) => this.line(this.sub(id, `l${k}`), p, ids[(k + 1) % n], constr));
        this.autoRelations = auto;
        for (const p of ids) this.relation('coincident', [p, circ]);
        this.relation('equal', lines);
        return;
      }
      case 'slot': {
        const id = this.claim(s.id, 'slot');
        let p: Vec2, q: Vec2;
        if (s.center1 != null) {
          p = this.pt(s.center1, `${w}.center1`);
          q = this.pt(s.center2, `${w}.center2`);
        } else {
          const c = this.pt(s.center, `${w}.center`);
          const L = this.units.size(s.length, `${w}.length`);
          const ang = s.angle != null ? (num_(s.angle, `${w}.angle`) * Math.PI) / 180 : 0;
          p = [c[0] - (Math.cos(ang) * L) / 2, c[1] - (Math.sin(ang) * L) / 2];
          q = [c[0] + (Math.cos(ang) * L) / 2, c[1] + (Math.sin(ang) * L) / 2];
        }
        if (dist2(p, q) < 1e-9) throw new ToolError(`${w}: the two arc centres are the same`);
        const r = this.units.size(s.width, `${w}.width`) / 2;
        const u = norm2(sub2(q, p));
        const nrm: Vec2 = [-u[1], u[0]];
        const off = (o: Vec2, k: number): Vec2 => [o[0] + nrm[0] * r * k, o[1] + nrm[1] * r * k];
        const ca = this.point(p, this.sub(id, 'c0')), cb = this.point(q, this.sub(id, 'c1'));
        const p1 = this.point(off(p, 1), this.sub(id, 'p0')), p2 = this.point(off(p, -1), this.sub(id, 'p1'));
        const q1 = this.point(off(q, 1), this.sub(id, 'p2')), q2 = this.point(off(q, -1), this.sub(id, 'p3'));
        const l1 = this.sub(id, 'l0'), l2 = this.sub(id, 'l1'), arcA = this.sub(id, 'a0'), arcB = this.sub(id, 'a1'), axis = this.sub(id, 'axis');
        this.sk.entities.push(
          { id: l1, t: 'line', a: p1, b: q1 }, { id: l2, t: 'line', a: q2, b: p2 },
          { id: arcB, t: 'arc', c: cb, a: q2, b: q1 }, { id: arcA, t: 'arc', c: ca, a: p1, b: p2 },
          { id: axis, t: 'line', a: ca, b: cb, construction: true },
        );
        this.created.push(l1, l2, arcA, arcB, axis);
        for (const [l, a] of [[l1, arcA], [l1, arcB], [l2, arcA], [l2, arcB]]) this.relation('tangent', [l, a]);
        this.relation('equal', [arcA, arcB]);
        if (Math.abs(u[1]) < 1e-9) this.relation('horizontal', [axis]);
        else if (Math.abs(u[0]) < 1e-9) this.relation('vertical', [axis]);
        return;
      }
      case 'spline': {
        const id = this.claim(s.id, 'spline');
        const pts = list(s.points).map((p, k) => this.pt(p, `${w}.points[${k}]`));
        if (pts.length < 2) throw new ToolError(`${w}: needs at least 2 points`);
        const ids = pts.map((p, k) => this.point(p, this.sub(id, `p${k}`), { merge: k === 0 || k === pts.length - 1 }));
        this.sk.entities.push({ id, t: 'spline', pts: ids, ...(constr ? { construction: true } : {}) });
        this.created.push(id);
        return;
      }
      default:
        throw new ToolError(`${w}: unknown shape type. Use point, line, centerline, polyline, rectangle, center_rectangle, circle, arc, polygon, slot or spline`);
    }
  }

  // ---------- relations and dimensions ----------

  private refIds(v: unknown, what: string): Id[] {
    const ids = list(v).map(str);
    for (const id of ids) {
      if (id !== ORIGIN_ID && !this.sk.entities.some((e) => e.id === id)) throw new ToolError(`${what}: ${this.sk.id} has no entity "${id}"`);
    }
    return ids;
  }

  addRelation(r: unknown, i: number) {
    if (!isObj(r)) throw new ToolError(`relations[${i}]: expected { type, refs }`);
    const type = str(r.type).toLowerCase() as RelationType;
    if (!RELATIONS.includes(type)) throw new ToolError(`relations[${i}].type: one of ${RELATIONS.join(', ')}`);
    const refs = this.refIds(r.refs ?? r.entities, `relations[${i}].refs`);
    if (!refs.length) throw new ToolError(`relations[${i}].refs: give the entity ids it relates`);
    const ok = availableRelations(this.sk, refs);
    if (!ok.includes(type)) {
      const kinds = refs.map((id) => `${id} (${id === ORIGIN_ID ? 'origin' : kindOf(this.sk, id)})`).join(', ');
      throw new ToolError(`relations[${i}]: ${type} cannot apply to ${kinds}. Relations that can: ${ok.join(', ') || 'none'}. Symmetric takes two points (or two lines, or two circles) then the symmetry line last.`);
    }
    const key = (c: SkConstraint) => `${c.type}:${[...c.refs].sort().join(',')}`;
    const existing = new Set(this.sk.constraints.filter((c) => !isDimension(c)).map(key));
    for (const c of makeRelations(this.sk, type, refs, this.gen)) {
      if (existing.has(key(c))) { this.notes.push(`${type} on ${c.refs.join(', ')} already exists`); continue; }
      this.constraint(c);
      this.created.push(c.id);
    }
  }

  private dimValue(v: unknown, type: DimensionType, what: string): number | string {
    return this.units.parseParam(v, type === 'angle' ? 'angle' : 'length', what);
  }

  addDimension(d: unknown, i: number) {
    if (!isObj(d)) throw new ToolError(`dimensions[${i}]: expected { refs, type?, value? }`);
    const w = `dimensions[${i}]`;
    const refs = this.refIds(d.refs ?? d.entities, `${w}.refs`);
    if (!refs.length || refs.length > 2) throw new ToolError(`${w}.refs: one or two entity ids`);
    const kinds = refs.map((id) => kindOf(this.sk, id));
    let type = str(d.type).toLowerCase() as DimensionType;
    this.index();
    if (!type) {
      if (refs.length === 1) type = kinds[0] === 'circle' ? 'diameter' : kinds[0] === 'arc' ? 'radius' : 'distance';
      else if (kinds[0] === 'line' && kinds[1] === 'line') {
        const [l1, l2] = refs.map((id) => this.ix.get(id) as SkLine);
        const d1 = norm2(sub2(this.ix.pt(l1.b), this.ix.pt(l1.a))), d2 = norm2(sub2(this.ix.pt(l2.b), this.ix.pt(l2.a)));
        type = Math.abs(cross2(d1, d2)) < 0.017 ? 'distance' : 'angle';
      } else type = 'distance';
    }
    if (!DIMENSIONS.includes(type)) throw new ToolError(`${w}.type: one of ${DIMENSIONS.join(', ')}`);
    const bad = (msg: string) => new ToolError(`${w}: ${type} ${msg} (got ${refs.map((id, k) => `${id} ${id === ORIGIN_ID ? 'origin' : kinds[k]}`).join(', ')})`);
    const ptLike = (k: number) => kinds[k] === 'point' || kinds[k] === 'circle' || kinds[k] === 'arc';
    if (type === 'radius' || type === 'diameter') {
      if (refs.length !== 1 || (kinds[0] !== 'circle' && kinds[0] !== 'arc')) throw bad('takes one circle or arc');
    } else if (type === 'angle') {
      if (kinds.some((k) => k !== 'line')) throw bad('takes one line (angle from horizontal) or two lines');
    } else if (refs.length === 1) {
      if (kinds[0] !== 'line') throw bad('of one entity takes a line (its length)');
    } else if (type === 'distance') {
      if (kinds.includes('spline')) throw bad('cannot measure a spline');
    } else if (!ptLike(0) || !ptLike(1)) throw bad('takes a line or two points (circle and arc centres count as points)');
    const spec: Pick<SkDimension, 'type' | 'refs' | 'sector'> = { type, refs };
    let value: number | string;
    if (d.value == null || d.value === '') value = measureDimension(this.sk, spec);
    else value = this.dimValue(d.value, type, `${w}.value`);
    if (type === 'angle' && refs.length === 2) {
      // The sector whose current angle is nearest the wanted one, so the solver does not flip lines.
      const want = typeof value === 'number' ? value : this.store.evalParam(value, 'angle');
      let best = 0, bd = Infinity;
      for (let s = 0; s < 4; s++) {
        const m = measureDimension(this.sk, { type, refs, sector: s });
        if (Math.abs(m - want) < bd) { bd = Math.abs(m - want); best = s; }
      }
      spec.sector = best;
    }
    const name = d.name != null ? str(d.name) : nextDimName(this.sk);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name)) throw new ToolError(`${w}.name: letters, digits and _ (start with a letter)`);
    if (this.sk.constraints.some((c) => isDimension(c) && c.name === name)) throw new ToolError(`${w}.name: ${name} is already used in ${this.sk.id}`);
    const id = this.claim(d.id, 'd');
    const dim: SkDimension = { id, type, refs, value, at: this.labelAt(spec), name, ...(spec.sector != null ? { sector: spec.sector } : {}), ...(d.driven === true ? { driven: true } : {}) };
    this.constraint(dim);
    this.created.push(id);
  }

  /** A label position near what a dimension measures, outside the sketch's middle. */
  private labelAt(d: Pick<SkDimension, 'type' | 'refs'>): Vec2 {
    const ix = this.index();
    const all = this.sk.entities.filter((e) => e.t === 'point') as { x: number; y: number }[];
    const cx = all.length ? all.reduce((s, p) => s + p.x, 0) / all.length : 0, cy = all.length ? all.reduce((s, p) => s + p.y, 0) / all.length : 0;
    const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
    const size = Math.max(10, xs.length ? Math.max(...xs) - Math.min(...xs) : 0, ys.length ? Math.max(...ys) - Math.min(...ys) : 0);
    const gap = size * 0.12;
    const at = (id: Id): Vec2 => {
      const e = id === ORIGIN_ID ? undefined : ix.get(id);
      if (e?.t === 'line') { const a = ix.pt(e.a), b = ix.pt(e.b); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
      if (e && (e.t === 'circle' || e.t === 'arc')) return ix.pt(e.c);
      return ix.pt(id);
    };
    if (d.type === 'radius' || d.type === 'diameter') {
      const e = ix.get(d.refs[0])!;
      const r = e.t === 'circle' ? e.r : arcRadius(ix, e as SkArc);
      const c = at(d.refs[0]);
      return [c[0] + r * 0.9 + gap * 0.4, c[1] + r * 0.9 + gap * 0.4];
    }
    const pts = d.refs.map(at);
    const m: Vec2 = pts.length === 1 ? pts[0] : [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    if (d.type === 'hdistance') return [m[0], (pts.length ? Math.min(...pts.map((p) => p[1])) : m[1]) - gap];
    if (d.type === 'vdistance') return [(pts.length ? Math.max(...pts.map((p) => p[0])) : m[0]) + gap, m[1]];
    const away = norm2([m[0] - cx, m[1] - cy]);
    const dir: Vec2 = Math.hypot(away[0], away[1]) > 0.5 ? away : [0, -1];
    return [m[0] + dir[0] * gap, m[1] + dir[1] * gap];
  }

  setDimension(v: unknown, i: number) {
    if (!isObj(v)) throw new ToolError(`set_dimensions[${i}]: expected { dimension, value }`);
    const key = str(v.dimension ?? v.id ?? v.name);
    const d = this.sk.constraints.find((c): c is SkDimension => isDimension(c) && (c.id === key || c.name === key));
    if (!d) throw new ToolError(`set_dimensions[${i}]: ${this.sk.id} has no dimension "${key}". Dimensions: ${this.sk.constraints.filter(isDimension).map((c) => `${c.id} (${c.name})`).join(', ') || 'none'}`);
    if (v.value != null) d.value = this.dimValue(v.value, d.type, `set_dimensions[${i}].value`);
    if (typeof v.driven === 'boolean') d.driven = v.driven || undefined;
  }

  // ---------- other operations ----------

  delete(v: unknown) {
    const ids = list(v).map(str).filter(Boolean);
    const known = new Set([...this.sk.entities.map((e) => e.id), ...this.sk.constraints.map((c) => c.id)]);
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) throw new ToolError(`delete: ${this.sk.id} has no ${missing.join(', ')}`);
    deleteItems(this.sk, ids);
  }

  movePoint(v: unknown, i: number) {
    if (!isObj(v)) throw new ToolError(`move_points[${i}]: expected { point, to }`);
    const id = str(v.point ?? v.id);
    const p = this.sk.entities.find((e) => e.id === id);
    if (!p || p.t !== 'point') throw new ToolError(`move_points[${i}]: ${this.sk.id} has no point "${id}"`);
    const to = this.pt(v.to ?? v.at, `move_points[${i}].to`);
    p.x = to[0];
    p.y = to[1];
  }

  setRadius(v: unknown, i: number) {
    if (!isObj(v)) throw new ToolError(`set_radius[${i}]: expected { circle, radius }`);
    const id = str(v.circle ?? v.id);
    const c = this.sk.entities.find((e) => e.id === id);
    if (!c || c.t !== 'circle') throw new ToolError(`set_radius[${i}]: ${this.sk.id} has no circle "${id}"`);
    c.r = this.units.size(v.radius, `set_radius[${i}].radius`);
  }

  setConstruction(v: unknown, on: boolean) {
    for (const id of list(v).map(str)) {
      const e = this.sk.entities.find((x) => x.id === id);
      if (!e) throw new ToolError(`construction: ${this.sk.id} has no entity "${id}"`);
      if (on) e.construction = true;
      else delete e.construction;
    }
  }

  fillet(v: unknown, i: number) {
    if (!isObj(v)) throw new ToolError(`fillets[${i}]: expected { point, radius }`);
    const r = this.units.size(v.radius, `fillets[${i}].radius`);
    const corners = list(v.point ?? v.points).map(str);
    if (!corners.length) throw new ToolError(`fillets[${i}].point: give the corner point id`);
    for (const id of corners) {
      const before = new Set(this.sk.entities.map((e) => e.id));
      const err = filletCorner(this.sk, id, r, this.gen);
      if (err) throw new ToolError(`fillets[${i}] at ${id}: ${err}`);
      for (const e of this.sk.entities) if (!before.has(e.id) && e.t === 'arc') this.created.push(e.id);
    }
  }

  offset(v: unknown, i: number) {
    if (!isObj(v)) throw new ToolError(`offsets[${i}]: expected { curves, distance }`);
    const ids = this.refIds(v.curves ?? v.entities, `offsets[${i}].curves`);
    const d = this.units.coord(v.distance, `offsets[${i}].distance`);
    const made = offsetCurves(this.sk, ids, d, this.gen);
    if (!made.length) throw new ToolError(`offsets[${i}]: nothing could be offset (lines, arcs and circles only)`);
    this.created.push(...made);
  }

  mirror(v: unknown, i: number) {
    if (!isObj(v)) throw new ToolError(`mirrors[${i}]: expected { entities, axis }`);
    const ids = this.refIds(v.entities, `mirrors[${i}].entities`);
    const [axis] = this.refIds(v.axis, `mirrors[${i}].axis`);
    if (kindOf(this.sk, axis) !== 'line') throw new ToolError(`mirrors[${i}].axis: must be a line`);
    const made = mirrorEntities(this.sk, ids, axis, this.gen);
    if (!made.length) throw new ToolError(`mirrors[${i}]: nothing was mirrored`);
    this.created.push(...made);
  }

  project(edges: EdgeInfo[]) {
    const r = convertEdges(this.sk, this.frame, edges, this.gen);
    this.created.push(...r.ids);
    if (r.skipped) this.notes.push(`${r.skipped} edge(s) could not be projected (only lines, and circles or arcs parallel to the sketch plane)`);
  }

  /** Cleans up and solves; returns the analysis. */
  solve(): SolveResult {
    cleanupConstraints(this.sk);
    const vars = this.store.resolve().variables;
    return solveSketch(this.sk.entities, this.sk.constraints, { value: (d) => this.store.dimensionValue(d, vars) });
  }
}

function num_(v: unknown, what: string): number {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`${what}: expected a number`);
  return n;
}

function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

/** Whether m lies on the counter-clockwise arc around c from a to b. */
function ccwContains(c: Vec2, a: Vec2, b: Vec2, m: Vec2): boolean {
  const ang = (p: Vec2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return norm(ang(m) - ang(a)) < norm(ang(b) - ang(a));
}

// ---------- describing sketches ----------

export function entityLine(sk: SketchFeature, e: SkEntity, u: Units, ix = new SketchIndex(sk.entities)): string {
  const cons = e.construction ? ' [construction]' : '';
  switch (e.t) {
    case 'point': return `${e.id} point ${u.pt([e.x, e.y])}${cons}`;
    case 'line': {
      const a = ix.pt(e.a), b = ix.pt(e.b);
      return `${e.id} line ${e.a}${u.pt(a)} → ${e.b}${u.pt(b)} length ${u.len(dist2(a, b))}${cons}`;
    }
    case 'circle': return `${e.id} circle centre ${e.c}${u.pt(ix.pt(e.c))} radius ${u.len(e.r)}${cons}`;
    case 'arc': {
      const g = arcAngles(ix, e);
      const s = (g.start * 180) / Math.PI, sw = (g.sweep * 180) / Math.PI;
      return `${e.id} arc centre ${e.c}${u.pt(ix.pt(e.c))} radius ${u.len(g.r)} from ${e.a}${u.pt(ix.pt(e.a))} to ${e.b}${u.pt(ix.pt(e.b))} counter-clockwise (start ${num(s, 2)}°, sweep ${num(sw, 2)}°)${cons}`;
    }
    case 'spline': return `${e.id} spline through ${e.pts.map((p) => `${p}${u.pt(ix.pt(p))}`).join(' ')}${cons}`;
  }
}

export function constraintLine(sk: SketchFeature, c: SkConstraint, u: Units, store: DocStore): string {
  if (isDimension(c)) {
    let now = '';
    try { now = c.type === 'angle' ? `${num(measureDimension(sk, c), 3)}°` : u.len(measureDimension(sk, c), true); } catch { now = '?'; }
    const set = typeof c.value === 'string' ? ` = ${c.value}` : '';
    return `${c.id} ${c.name} ${c.type} [${c.refs.join(', ')}] ${now}${set}${c.driven ? ' (driven, reference only)' : ''}`;
  }
  void store;
  return `${c.id} ${RELATION_LABELS[c.type].toLowerCase()} [${c.refs.join(', ')}]`;
}

/** Definition status, problems and closed profiles of a sketch. */
export function sketchReport(sk: SketchFeature, solve: SolveResult | null, u: Units, store: DocStore): string {
  const lines: string[] = [];
  if (solve) {
    const st = solve.status === 'full' ? 'fully defined' : solve.status === 'over' ? 'OVER-DEFINED' : `under-defined, ${solve.dof} degree(s) of freedom left`;
    lines.push(`Status: ${st}${solve.converged ? '' : ' (the solver did not converge)'}.`);
    if (solve.badConstraints.size) {
      const bad = sk.constraints.filter((c) => solve.badConstraints.has(c.id)).map((c) => `${constraintLine(sk, c, u, store)}${solve.conflicting.has(c.id) ? ' (conflicting)' : ' (redundant)'}`);
      lines.push(`Problem constraints:\n${bad.map((b) => `- ${b}`).join('\n')}`);
    }
    if (solve.status === 'under' && solve.freeEntities.size && solve.freeEntities.size <= 30) lines.push(`Entities that can still move: ${[...solve.freeEntities].join(', ')}.`);
  }
  const prof = buildProfiles(sk.entities);
  if (prof.regions.length) {
    lines.push(`Closed profiles: ${prof.regions.length} region(s) to extrude or revolve:`);
    for (const r of prof.regions.slice(0, 12)) {
      const area = Math.abs(r.outer.area) - r.holes.reduce((s, h) => s + Math.abs(h.area), 0);
      const xs = r.outer.poly.map((p) => p[0]), ys = r.outer.poly.map((p) => p[1]);
      lines.push(`- area ${u.area(area)}, x ${u.len(Math.min(...xs))} to ${u.len(Math.max(...xs))}, y ${u.len(Math.min(...ys))} to ${u.len(Math.max(...ys))}${r.holes.length ? `, ${r.holes.length} hole(s)` : ''}, inside point ${u.pt(r.sample)}`);
    }
    if (prof.regions.length > 12) lines.push(`- … ${prof.regions.length - 12} more`);
  } else lines.push('Closed profiles: none.');
  if (prof.openEnds.length) lines.push(`Open contour ends at ${prof.openEnds.slice(0, 10).map((p) => u.pt(p)).join(', ')}${prof.openEnds.length > 10 ? ' …' : ''} (fine for a sweep path; a profile must be closed).`);
  const pts = sketchPoints(sk.entities);
  if (pts.length) lines.push(`Stand-alone points (hole centres): ${pts.slice(0, 40).map((p) => `${p.id}${u.pt([p.x, p.y])}`).join(', ')}${pts.length > 40 ? ' …' : ''}.`);
  return lines.join('\n');
}
