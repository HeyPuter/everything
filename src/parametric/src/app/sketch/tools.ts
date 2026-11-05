// Sketch drawing and editing tools. Each tool is a small state machine fed
// with snapped cursor positions by the sketch editor.

import type { Id, SkArc, SkLine, SketchFeature } from '../../model/types';
import { type Vec2, angle2, cross2, dist2, norm2, sub2 } from '../../math/vec';
import { ORIGIN_ID, SketchIndex, splineBeziers, bezierPoint } from '../../sketch/geom';
import { extendAt, filletCorner, smartDimension, trimAt } from '../../sketch/ops';
import { h } from '../../ui/dom';
import { toast } from '../../ui/overlay';
import { numberField } from '../pm';
import type { VPEvent } from '../viewport';
import type { SketchEditor, SkTool } from './editor';
import type { Snap } from './inference';
import { dimGraphics } from './dimgfx';

const circlePts = (c: Vec2, r: number, n = 64): Vec2[] => {
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) out.push([c[0] + r * Math.cos((i / n) * 2 * Math.PI), c[1] + r * Math.sin((i / n) * 2 * Math.PI)]);
  return out;
};

const arcPts = (c: Vec2, r: number, a0: number, sweep: number, n = 48): Vec2[] => {
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return out;
};

/** Adds horizontal/vertical relations implied by a direction snap. */
function directionRelation(sk: SketchFeature, lineId: Id, s: Snap, newId: (p: string) => Id) {
  if (s.kind === 'h') sk.constraints.push({ id: newId('r'), type: 'horizontal', refs: [lineId] });
  else if (s.kind === 'v') sk.constraints.push({ id: newId('r'), type: 'vertical', refs: [lineId] });
}

// ---------- Line / centerline ----------

export function lineTool(ed: SketchEditor, construction = false): SkTool {
  let start: { s: Snap; id: Id | null; p: Vec2 } | null = null;
  let downAt: { x: number; y: number } | null = null;
  let chain = 0;
  const commitSegment = (end: Snap) => {
    if (!start || dist2(start.p, end.p) < ed.px * 2) return;
    let endId: Id = '';
    ed.edit(construction ? 'Add centerline' : 'Add line', (sk, newId) => {
      const a = start!.id ?? ed.commitPoint(sk, start!.s, newId);
      const b = ed.commitPoint(sk, end, newId);
      const lid = newId('l');
      sk.entities.push({ id: lid, t: 'line', a, b, construction: construction || undefined });
      directionRelation(sk, lid, end, newId);
      endId = b;
    });
    chain++;
    // Chain from the new end point (it now exists, so it is reused).
    start = { s: { ...end, kind: 'point', pointId: endId }, id: endId, p: end.p };
  };
  return {
    id: construction ? 'centerline' : 'line',
    label: construction ? 'Centerline' : 'Line',
    hint: 'Click to start a line, click again to add segments. Double-click or press Esc to finish.',
    from: () => start?.p ?? null,
    exclude: () => new Set<Id>(),
    down(s, e) {
      downAt = { x: e.x, y: e.y };
      if (!start) { start = { s, id: null, p: s.p }; chain = 0; }
      return true;
    },
    move(s, _e, dragging) {
      void dragging;
      if (start) ed.setPreview([[start.p, s.p]], [start.p]);
    },
    up(s, e) {
      // Click-drag-release draws a single line.
      if (downAt && Math.hypot(e.x - downAt.x, e.y - downAt.y) > 6 && start && dist2(start.p, s.p) > ed.px * 3) {
        commitSegment(s);
        start = null;
        ed.setPreview([]);
      }
      downAt = null;
    },
    click(s) {
      if (!start) { start = { s, id: null, p: s.p }; return true; }
      if (dist2(start.p, s.p) < ed.px * 2) return true;
      const closing = s.kind === 'point' && chain > 0 && s.pointId && s.pointId !== start.id;
      commitSegment(s);
      // Closing onto an existing point ends the chain.
      if (closing) { start = null; ed.setPreview([]); }
      return true;
    },
    dbl() {
      start = null;
      ed.setPreview([]);
      return true;
    },
    enter() {
      if (!start) return false;
      start = null;
      ed.setPreview([]);
      return true;
    },
    cancel() {
      const was = !!start;
      start = null;
      ed.setPreview([]);
      return was;
    },
  };
}

// ---------- Rectangle ----------

export function rectangleTool(ed: SketchEditor, centered = false): SkTool {
  let first: Snap | null = null;
  const corners = (a: Vec2, b: Vec2): Vec2[] => {
    if (centered) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      return [[a[0] - dx, a[1] - dy], [a[0] + dx, a[1] - dy], [a[0] + dx, a[1] + dy], [a[0] - dx, a[1] + dy]];
    }
    return [a, [b[0], a[1]], b, [a[0], b[1]]];
  };
  const commit = (second: Snap) => {
    const a = first!.p;
    if (Math.abs(second.p[0] - a[0]) < ed.px * 2 || Math.abs(second.p[1] - a[1]) < ed.px * 2) return;
    const cs = corners(a, second.p);
    ed.edit(centered ? 'Add center rectangle' : 'Add rectangle', (sk, newId) => {
      const ids: Id[] = cs.map((p, i) => {
        if (!centered && i === 0) return ed.commitPoint(sk, first!, newId);
        if (!centered && i === 2) return ed.commitPoint(sk, second, newId);
        const id = newId('p');
        sk.entities.push({ id, t: 'point', x: p[0], y: p[1] });
        return id;
      });
      const lines = ids.map((id, i) => {
        const lid = newId('l');
        sk.entities.push({ id: lid, t: 'line', a: id, b: ids[(i + 1) % 4] });
        return lid;
      });
      sk.constraints.push(
        { id: newId('r'), type: 'horizontal', refs: [lines[0]] },
        { id: newId('r'), type: 'horizontal', refs: [lines[2]] },
        { id: newId('r'), type: 'vertical', refs: [lines[1]] },
        { id: newId('r'), type: 'vertical', refs: [lines[3]] },
      );
      if (centered) {
        // Construction diagonals meeting at the centre point.
        const c = ed.commitPoint(sk, first!, newId);
        const d1 = newId('l'), d2 = newId('l');
        sk.entities.push({ id: d1, t: 'line', a: ids[0], b: ids[2], construction: true }, { id: d2, t: 'line', a: ids[1], b: ids[3], construction: true });
        sk.constraints.push({ id: newId('r'), type: 'midpoint', refs: [c, d1] }, { id: newId('r'), type: 'midpoint', refs: [c, d2] });
      }
    });
    first = null;
    ed.setPreview([]);
  };
  let downAt: { x: number; y: number } | null = null;
  return {
    id: centered ? 'centerRectangle' : 'rectangle',
    label: centered ? 'Center Rectangle' : 'Corner Rectangle',
    hint: centered ? 'Click the centre, then a corner.' : 'Click one corner, then the opposite corner.',
    from: () => null,
    down(s, e) {
      downAt = { x: e.x, y: e.y };
      if (!first) first = s;
      return true;
    },
    move(s) {
      if (!first) return;
      const cs = corners(first.p, s.p);
      ed.setPreview([[...cs, cs[0]]], [first.p]);
    },
    up(s, e) {
      if (downAt && first && Math.hypot(e.x - downAt.x, e.y - downAt.y) > 6) commit(s);
      downAt = null;
    },
    click(s) {
      if (!first) { first = s; return true; }
      commit(s);
      return true;
    },
    cancel() {
      const was = !!first;
      first = null;
      ed.setPreview([]);
      return was;
    },
  };
}

// ---------- Circle ----------

export function circleTool(ed: SketchEditor): SkTool {
  let center: Snap | null = null;
  let downAt: { x: number; y: number } | null = null;
  const commit = (s: Snap) => {
    const r = dist2(center!.p, s.p);
    if (r < ed.px * 2) return;
    ed.edit('Add circle', (sk, newId) => {
      const c = ed.commitPoint(sk, center!, newId);
      const id = newId('c');
      sk.entities.push({ id, t: 'circle', c, r });
      if (s.kind === 'point' && s.pointId) sk.constraints.push({ id: newId('r'), type: 'coincident', refs: [s.pointId, id] });
    });
    center = null;
    ed.setPreview([]);
  };
  return {
    id: 'circle',
    label: 'Circle',
    hint: 'Click the centre, then a point on the circle.',
    down(s, e) { downAt = { x: e.x, y: e.y }; if (!center) center = s; return true; },
    move(s) { if (center) ed.setPreview([circlePts(center.p, dist2(center.p, s.p)), [center.p, s.p]], [center.p]); },
    up(s, e) { if (downAt && center && Math.hypot(e.x - downAt.x, e.y - downAt.y) > 6) commit(s); downAt = null; },
    click(s) { if (!center) { center = s; return true; } commit(s); return true; },
    cancel() { const was = !!center; center = null; ed.setPreview([]); return was; },
  };
}

/** Circle through three points. */
export function perimeterCircleTool(ed: SketchEditor): SkTool {
  const pts: Snap[] = [];
  const circ = (a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null => {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
    const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
    const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    return { c: [ux, uy], r: dist2([ux, uy], a) };
  };
  return {
    id: 'perimeterCircle',
    label: 'Perimeter Circle',
    hint: 'Click three points on the circle.',
    move(s) {
      if (pts.length === 1) ed.setPreview([[pts[0].p, s.p]], [pts[0].p]);
      if (pts.length === 2) {
        const c = circ(pts[0].p, pts[1].p, s.p);
        ed.setPreview(c ? [circlePts(c.c, c.r)] : [], pts.map((p) => p.p));
      }
    },
    click(s) {
      // A repeated click (e.g. a double-click) does not count as another point.
      if (pts.some((q) => dist2(q.p, s.p) < ed.px * 2)) return true;
      pts.push(s);
      if (pts.length < 3) return true;
      const c = circ(pts[0].p, pts[1].p, pts[2].p);
      const sel = [...pts];
      pts.length = 0;
      ed.setPreview([]);
      if (!c) return true;
      ed.edit('Add circle', (sk, newId) => {
        const cid = newId('p');
        sk.entities.push({ id: cid, t: 'point', x: c.c[0], y: c.c[1] });
        const id = newId('c');
        sk.entities.push({ id, t: 'circle', c: cid, r: c.r });
        for (const p of sel) if ((p.kind === 'point' || p.kind === 'origin') && p.pointId) sk.constraints.push({ id: newId('r'), type: 'coincident', refs: [p.pointId, id] });
      });
      return true;
    },
    cancel() { const was = pts.length > 0; pts.length = 0; ed.setPreview([]); return was; },
  };
}

// ---------- Arcs ----------

/** Centre point arc: centre, start, end (counter-clockwise by cursor side). */
export function centerArcTool(ed: SketchEditor): SkTool {
  let c: Snap | null = null, a: Snap | null = null;
  let sweepSign = 1;
  let lastAngle = 0;
  let acc = 0;
  return {
    id: 'centerArc',
    label: 'Centerpoint Arc',
    hint: 'Click the centre, then the start point, then the end point.',
    from: () => null,
    move(s) {
      if (c && !a) ed.setPreview([[c.p, s.p], circlePts(c.p, dist2(c.p, s.p))], [c.p]);
      if (c && a) {
        const r = dist2(c.p, a.p);
        const a0 = angle2(sub2(a.p, c.p));
        const ang = angle2(sub2(s.p, c.p));
        let d = ang - lastAngle;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        acc += d;
        lastAngle = ang;
        sweepSign = acc >= 0 ? 1 : -1;
        let sweep = ang - a0;
        if (sweepSign > 0) { while (sweep <= 0) sweep += 2 * Math.PI; } else { while (sweep >= 0) sweep -= 2 * Math.PI; }
        ed.setPreview([arcPts(c.p, r, a0, sweep), [c.p, a.p]], [c.p, a.p]);
      }
    },
    click(s) {
      if (!c) { c = s; return true; }
      // Clicks on the centre or back on the start point (e.g. double-clicks)
      // would make a zero-radius arc or one closed on itself.
      if (!a) {
        if (dist2(c.p, s.p) < ed.px * 2) return true;
        a = s; lastAngle = angle2(sub2(s.p, c.p)); acc = 0; return true;
      }
      const r = dist2(c.p, a.p);
      const ang = angle2(sub2(s.p, c.p));
      const end: Vec2 = [c.p[0] + r * Math.cos(ang), c.p[1] + r * Math.sin(ang)];
      if (dist2(end, a.p) < ed.px * 2 || (s.kind === 'point' && s.pointId && s.pointId === a.pointId)) return true;
      const cc = c, aa = a;
      ed.edit('Add arc', (sk, newId) => {
        const cid = ed.commitPoint(sk, cc, newId);
        const pa = ed.commitPoint(sk, aa, newId);
        const pb = s.kind === 'point' && s.pointId ? s.pointId : ed.commitPoint(sk, { ...s, p: end }, newId);
        const id = newId('a');
        sk.entities.push(sweepSign > 0 ? { id, t: 'arc', c: cid, a: pa, b: pb } : { id, t: 'arc', c: cid, a: pb, b: pa });
      });
      c = a = null;
      ed.setPreview([]);
      return true;
    },
    cancel() { const was = !!c; c = a = null; ed.setPreview([]); return was; },
  };
}

/** Arc through start, end and a point on the arc. */
export function threePointArcTool(ed: SketchEditor): SkTool {
  let p1: Snap | null = null, p2: Snap | null = null;
  const solve = (a: Vec2, b: Vec2, m: Vec2) => {
    const d = 2 * (a[0] * (b[1] - m[1]) + b[0] * (m[1] - a[1]) + m[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, m2 = m[0] ** 2 + m[1] ** 2;
    const c: Vec2 = [(a2 * (b[1] - m[1]) + b2 * (m[1] - a[1]) + m2 * (a[1] - b[1])) / d, (a2 * (m[0] - b[0]) + b2 * (a[0] - m[0]) + m2 * (b[0] - a[0])) / d];
    const ccw = cross2(sub2(m, a), sub2(b, m)) > 0;
    return { c, r: dist2(c, a), ccw };
  };
  return {
    id: 'arc3',
    label: '3 Point Arc',
    hint: 'Click the start and end points, then a point on the arc.',
    from: () => (p1 && !p2 ? p1.p : null),
    move(s) {
      if (p1 && !p2) ed.setPreview([[p1.p, s.p]], [p1.p]);
      if (p1 && p2) {
        const g = solve(p1.p, p2.p, s.p);
        if (!g) { ed.setPreview([[p1.p, p2.p]]); return; }
        const a0 = angle2(sub2(g.ccw ? p1.p : p2.p, g.c));
        let sw = angle2(sub2(g.ccw ? p2.p : p1.p, g.c)) - a0;
        while (sw <= 0) sw += 2 * Math.PI;
        ed.setPreview([arcPts(g.c, g.r, a0, sw)], [p1.p, p2.p]);
      }
    },
    click(s) {
      if (!p1) { p1 = s; return true; }
      // A repeated click (e.g. a double-click) or a point in line with the
      // ends makes no arc: keep waiting for a usable point.
      if (!p2) { if (dist2(p1.p, s.p) >= ed.px * 2) p2 = s; return true; }
      const g = solve(p1.p, p2.p, s.p);
      if (!g || dist2(p1.p, s.p) < ed.px * 2 || dist2(p2.p, s.p) < ed.px * 2) return true;
      const a = p1, b = p2;
      p1 = p2 = null;
      ed.setPreview([]);
      ed.edit('Add arc', (sk, newId) => {
        const ia = ed.commitPoint(sk, a, newId);
        const ib = ed.commitPoint(sk, b, newId);
        const ic = newId('p');
        sk.entities.push({ id: ic, t: 'point', x: g.c[0], y: g.c[1] });
        const id = newId('a');
        sk.entities.push(g.ccw ? { id, t: 'arc', c: ic, a: ia, b: ib } : { id, t: 'arc', c: ic, a: ib, b: ia });
      });
      return true;
    },
    cancel() { const was = !!p1; p1 = p2 = null; ed.setPreview([]); return was; },
  };
}

/** Arc tangent to the line or arc ending at the start point. */
export function tangentArcTool(ed: SketchEditor): SkTool {
  let start: { id: Id; p: Vec2; t: Vec2; curve: Id } | null = null;
  const geometry = (p: Vec2, t: Vec2, q: Vec2) => {
    // Centre lies on the normal at p and is equidistant to p and q.
    const n: Vec2 = [-t[1], t[0]];
    const d = sub2(q, p);
    const den = 2 * (d[0] * n[0] + d[1] * n[1]);
    if (Math.abs(den) < 1e-12) return null;
    const s = (d[0] * d[0] + d[1] * d[1]) / den;
    const c: Vec2 = [p[0] + n[0] * s, p[1] + n[1] * s];
    const ccw = s > 0;
    return { c, r: Math.abs(s), ccw };
  };
  return {
    id: 'tangentArc',
    label: 'Tangent Arc',
    hint: 'Click the end point of a line or arc, then where the arc should end.',
    from: () => null,
    move(s) {
      if (!start) return;
      const g = geometry(start.p, start.t, s.p);
      if (!g) { ed.setPreview([[start.p, s.p]]); return; }
      const a0 = angle2(sub2(g.ccw ? start.p : s.p, g.c));
      let sw = angle2(sub2(g.ccw ? s.p : start.p, g.c)) - a0;
      while (sw <= 0) sw += 2 * Math.PI;
      ed.setPreview([arcPts(g.c, g.r, a0, sw)], [start.p]);
    },
    click(s) {
      const sk = ed.sketch;
      if (!start) {
        if (s.kind !== 'point' || !s.pointId) { ed.app.setStatus('Start the tangent arc on the end point of a line or arc.'); return true; }
        const ix = new SketchIndex(sk.entities);
        const owner = sk.entities.find((e) => (e.t === 'line' || e.t === 'arc') && (e.a === s.pointId || e.b === s.pointId)) as SkLine | SkArc | undefined;
        if (!owner) { ed.app.setStatus('Start the tangent arc on the end point of a line or arc.'); return true; }
        let t: Vec2;
        if (owner.t === 'line') {
          const other = owner.a === s.pointId ? owner.b : owner.a;
          t = norm2(sub2(ix.pt(s.pointId), ix.pt(other)));
        } else {
          const c = ix.pt(owner.c);
          const r = sub2(ix.pt(s.pointId), c);
          // Leaving the arc's end continues counter-clockwise; leaving its start goes clockwise.
          t = owner.b === s.pointId ? norm2([-r[1], r[0]]) : norm2([r[1], -r[0]]);
        }
        start = { id: s.pointId, p: s.p, t, curve: owner.id };
        return true;
      }
      const g = geometry(start.p, start.t, s.p);
      // Back on the start point (a double-click) or straight along the
      // tangent: no arc yet, keep waiting for the end point.
      if (!g || dist2(start.p, s.p) < ed.px * 2) return true;
      const st = start;
      start = null;
      ed.setPreview([]);
      ed.edit('Add tangent arc', (sk2, newId) => {
        const end = ed.commitPoint(sk2, s, newId);
        const ic = newId('p');
        sk2.entities.push({ id: ic, t: 'point', x: g.c[0], y: g.c[1] });
        const id = newId('a');
        sk2.entities.push(g.ccw ? { id, t: 'arc', c: ic, a: st.id, b: end } : { id, t: 'arc', c: ic, a: end, b: st.id });
        sk2.constraints.push({ id: newId('r'), type: 'tangent', refs: [st.curve, id] });
      });
      return true;
    },
    cancel() { const was = !!start; start = null; ed.setPreview([]); return was; },
  };
}

// ---------- Polygon ----------

export function polygonTool(ed: SketchEditor): SkTool {
  let center: Snap | null = null;
  let sides = 6;
  const verts = (c: Vec2, p: Vec2): Vec2[] => {
    const r = dist2(c, p), a0 = angle2(sub2(p, c));
    return Array.from({ length: sides }, (_, i) => [c[0] + r * Math.cos(a0 + (i * 2 * Math.PI) / sides), c[1] + r * Math.sin(a0 + (i * 2 * Math.PI) / sides)] as Vec2);
  };
  return {
    id: 'polygon',
    label: 'Polygon',
    hint: 'Click the centre, then a vertex. Set the number of sides in the panel.',
    move(s) {
      if (!center) return;
      const v = verts(center.p, s.p);
      ed.setPreview([[...v, v[0]]], [center.p], [circlePts(center.p, dist2(center.p, s.p))]);
    },
    click(s) {
      if (!center) { center = s; return true; }
      // A repeated click on the centre (a double-click) keeps waiting for the vertex.
      if (dist2(center.p, s.p) < ed.px * 2) return true;
      const c = center;
      const v = verts(c.p, s.p);
      center = null;
      ed.setPreview([]);
      ed.edit('Add polygon', (sk, newId) => {
        const cid = ed.commitPoint(sk, c, newId);
        const ids = v.map((p) => { const id = newId('p'); sk.entities.push({ id, t: 'point', x: p[0], y: p[1] }); return id; });
        const circ = newId('c');
        sk.entities.push({ id: circ, t: 'circle', c: cid, r: dist2(c.p, s.p), construction: true });
        const lines = ids.map((id, i) => { const lid = newId('l'); sk.entities.push({ id: lid, t: 'line', a: id, b: ids[(i + 1) % ids.length] }); return lid; });
        for (const id of ids) sk.constraints.push({ id: newId('r'), type: 'coincident', refs: [id, circ] });
        sk.constraints.push({ id: newId('r'), type: 'equal', refs: lines });
      });
      return true;
    },
    cancel() { const was = !!center; center = null; ed.setPreview([]); return was; },
    options() {
      return [numberField({
        label: 'Number of sides', value: sides, kind: 'count', ctx: ed.app.unitContext(), min: 3, allowExpr: false,
        onChange: (v) => { sides = Math.max(3, Math.min(64, Number(v))); },
      })];
    },
  };
}

// ---------- Slot ----------

export function slotTool(ed: SketchEditor): SkTool {
  let a: Snap | null = null, b: Snap | null = null;
  const shape = (p: Vec2, q: Vec2, w: number) => {
    const u = norm2(sub2(q, p));
    const n: Vec2 = [-u[1], u[0]];
    const r = w / 2;
    const p1: Vec2 = [p[0] + n[0] * r, p[1] + n[1] * r], p2: Vec2 = [p[0] - n[0] * r, p[1] - n[1] * r];
    const q1: Vec2 = [q[0] + n[0] * r, q[1] + n[1] * r], q2: Vec2 = [q[0] - n[0] * r, q[1] - n[1] * r];
    return { p1, p2, q1, q2, r, a0: angle2(n) };
  };
  return {
    id: 'slot',
    label: 'Straight Slot',
    hint: 'Click the two arc centres, then set the width.',
    from: () => (a && !b ? a.p : null),
    move(s) {
      if (a && !b) ed.setPreview([[a.p, s.p]], [a.p]);
      if (a && b) {
        const u = norm2(sub2(b.p, a.p));
        const w = 2 * Math.abs(cross2(u, sub2(s.p, a.p)));
        const g = shape(a.p, b.p, Math.max(w, ed.px * 4));
        ed.setPreview([[g.p1, g.q1], [g.p2, g.q2], arcPts(b.p, g.r, g.a0 - Math.PI, Math.PI), arcPts(a.p, g.r, g.a0, Math.PI)], [a.p, b.p]);
      }
    },
    click(s) {
      if (!a) { a = s; return true; }
      if (!b) { if (dist2(a.p, s.p) > ed.px * 3) b = s; return true; }
      const u = norm2(sub2(b.p, a.p));
      const w = 2 * Math.abs(cross2(u, sub2(s.p, a.p)));
      // Too narrow (e.g. a double-click on the second centre): keep waiting for the width.
      if (w < ed.px * 2) return true;
      const A = a, B = b;
      a = b = null;
      ed.setPreview([]);
      const g = shape(A.p, B.p, w);
      ed.edit('Add slot', (sk, newId) => {
        const ca = ed.commitPoint(sk, A, newId), cb = ed.commitPoint(sk, B, newId);
        const pt = (p: Vec2) => { const id = newId('p'); sk.entities.push({ id, t: 'point', x: p[0], y: p[1] }); return id; };
        const p1 = pt(g.p1), p2 = pt(g.p2), q1 = pt(g.q1), q2 = pt(g.q2);
        const l1 = newId('l'), l2 = newId('l'), arcA = newId('a'), arcB = newId('a'), axis = newId('l');
        sk.entities.push(
          { id: l1, t: 'line', a: p1, b: q1 }, { id: l2, t: 'line', a: q2, b: p2 },
          { id: arcB, t: 'arc', c: cb, a: q2, b: q1 }, { id: arcA, t: 'arc', c: ca, a: p1, b: p2 },
          { id: axis, t: 'line', a: ca, b: cb, construction: true },
        );
        sk.constraints.push(
          { id: newId('r'), type: 'tangent', refs: [l1, arcA] }, { id: newId('r'), type: 'tangent', refs: [l1, arcB] },
          { id: newId('r'), type: 'tangent', refs: [l2, arcA] }, { id: newId('r'), type: 'tangent', refs: [l2, arcB] },
          { id: newId('r'), type: 'equal', refs: [arcA, arcB] },
        );
        if (Math.abs(u[1]) < 1e-9) sk.constraints.push({ id: newId('r'), type: 'horizontal', refs: [axis] });
        else if (Math.abs(u[0]) < 1e-9) sk.constraints.push({ id: newId('r'), type: 'vertical', refs: [axis] });
      });
      return true;
    },
    cancel() { const was = !!a; a = b = null; ed.setPreview([]); return was; },
  };
}

// ---------- Spline ----------

export function splineTool(ed: SketchEditor): SkTool {
  const pts: Snap[] = [];
  const finish = () => {
    if (pts.length >= 2) {
      const list = [...pts];
      ed.edit('Add spline', (sk, newId) => {
        const ids = list.map((s) => ed.commitPoint(sk, s, newId));
        sk.entities.push({ id: newId('s'), t: 'spline', pts: ids });
      });
    }
    pts.length = 0;
    ed.setPreview([]);
  };
  const curve = (list: Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const b of splineBeziers(list)) for (let i = 0; i <= 16; i++) out.push(bezierPoint(b, i / 16));
    return out;
  };
  return {
    id: 'spline',
    label: 'Spline',
    hint: 'Click points along the curve. Double-click or press Enter to finish.',
    from: () => null,
    move(s) {
      if (!pts.length) return;
      ed.setPreview([curve([...pts.map((p) => p.p), s.p])], pts.map((p) => p.p));
    },
    click(s) {
      if (pts.length && dist2(pts[pts.length - 1].p, s.p) < ed.px * 2) return true;
      pts.push(s);
      return true;
    },
    dbl() { finish(); return true; },
    enter() {
      if (!pts.length) return false;
      finish();
      return true;
    },
    cancel() {
      const was = pts.length > 0;
      if (pts.length >= 2) finish();
      pts.length = 0;
      ed.setPreview([]);
      return was;
    },
    abort() {
      pts.length = 0;
      ed.setPreview([]);
    },
  };
}

// ---------- Point ----------

export function pointTool(ed: SketchEditor): SkTool {
  return {
    id: 'point',
    label: 'Point',
    hint: 'Click to place sketch points (used to position holes).',
    click(s) {
      ed.edit('Add point', (sk, newId) => {
        const id = newId('p');
        sk.entities.push({ id, t: 'point', x: s.p[0], y: s.p[1] });
        if (s.kind === 'origin') sk.constraints.push({ id: newId('r'), type: 'coincident', refs: [id, ORIGIN_ID] });
        else if ((s.kind === 'point' || s.kind === 'center') && s.pointId) sk.constraints.push({ id: newId('r'), type: 'coincident', refs: [id, s.pointId] });
        else if (s.kind === 'on' && s.curveId) sk.constraints.push({ id: newId('r'), type: 'coincident', refs: [id, s.curveId] });
        else if (s.kind === 'mid' && s.curveId) sk.constraints.push({ id: newId('r'), type: 'midpoint', refs: [id, s.curveId] });
      });
      return true;
    },
    cancel: () => false,
  };
}

// ---------- Fillet, trim, extend ----------

export function sketchFilletTool(ed: SketchEditor): SkTool {
  let radius = 5 * (ed.app.store.unitScale >= 10 ? ed.app.store.unitScale / 5 : 1);
  return {
    id: 'sketchFillet',
    label: 'Sketch Fillet',
    hint: 'Click a corner where two lines meet to round it.',
    picks: true,
    click(s) {
      const hit = ed.pickAt(s.p, 9);
      if (!hit || hit.kind !== 'point') { ed.app.setStatus('Click the corner point shared by two lines.'); return true; }
      let err: string | null = null;
      ed.edit('Sketch fillet', (sk, newId) => { err = filletCorner(sk, hit.id, radius, newId); });
      if (err) toast({ kind: 'warning', message: err });
      return true;
    },
    cancel: () => false,
    options() {
      return [numberField({ label: 'Fillet radius', value: radius, kind: 'length', ctx: ed.app.unitContext(), min: 1e-6, allowExpr: false, onChange: (v) => { radius = Number(v); } })];
    },
  };
}

export function trimTool(ed: SketchEditor): SkTool {
  return {
    id: 'trim',
    label: 'Trim Entities',
    hint: 'Click the part of a curve to remove (up to its nearest intersections).',
    picks: true,
    move(s) {
      const hit = ed.pickAt(s.p, 8);
      ed.hovered = hit && hit.kind === 'curve' ? hit : null;
      ed.queueRender();
    },
    click(s) {
      const hit = ed.pickAt(s.p, 8);
      if (!hit || hit.kind !== 'curve') return true;
      ed.edit('Trim', (sk, newId) => { trimAt(sk, hit.id, s.p, newId); });
      return true;
    },
    cancel: () => false,
  };
}

export function extendTool(ed: SketchEditor): SkTool {
  return {
    id: 'extend',
    label: 'Extend Entities',
    hint: 'Click near the end of a line to extend it to the next curve.',
    picks: true,
    move(s) {
      const hit = ed.pickAt(s.p, 8);
      ed.hovered = hit && hit.kind === 'curve' ? hit : null;
      ed.queueRender();
    },
    click(s) {
      const hit = ed.pickAt(s.p, 8);
      if (!hit || hit.kind !== 'curve') return true;
      let ok = false;
      ed.edit('Extend', (sk, newId) => { ok = extendAt(sk, hit.id, s.p, newId); });
      if (!ok) ed.app.setStatus('Nothing to extend to in that direction.');
      return true;
    },
    cancel: () => false,
  };
}

// ---------- Smart dimension ----------

export function dimensionTool(ed: SketchEditor): SkTool {
  let picked: Id[] = [];
  const preview = (at: Vec2) => {
    const spec = smartDimension(ed.sketch, picked, at);
    if (!spec) { ed.setPreview([]); return; }
    // Live preview of the dimension that a click here would place.
    const g = dimGraphics(ed.sketch, { type: spec.type, refs: spec.refs, at, sector: spec.sector }, ed.px);
    ed.setPreview(g ? g.lines : [], [at]);
  };
  return {
    id: 'smartDimension',
    label: 'Smart Dimension',
    hint: 'Click one or two entities, then click where to place the dimension.',
    picks: true,
    move(s) {
      if (picked.length) preview(s.p);
      else {
        const hit = ed.pickAt(s.p, 8);
        ed.hovered = hit;
        ed.queueRender();
      }
    },
    click(s, e: VPEvent) {
      void e;
      const hit = ed.pickAt(s.p, 8);
      if (hit && !(picked.length === 1 && picked[0] === hit.id) && picked.length < 2) {
        // A second pick that is a point on the first line is still a pick.
        picked.push(hit.id);
        ed.app.selection.set(picked.map((id) => ({ kind: 'sk', id })));
        const k = ed.sketch.entities.find((x) => x.id === hit.id)?.t;
        // Circles and arcs need no second entity unless the user adds one.
        if (picked.length === 1 && (k === 'circle' || k === 'arc')) return true;
        if (picked.length === 1 && k === 'line') return true;
        if (picked.length === 2) return true;
        return true;
      }
      if (!picked.length) return true;
      const spec = smartDimension(ed.sketch, picked, s.p);
      if (!spec) {
        toast({ kind: 'warning', message: 'These entities cannot be dimensioned together. Select one or two lines, points, circles or arcs.' });
        picked = [];
        ed.app.selection.clear();
        return true;
      }
      const ids = picked;
      picked = [];
      ed.setPreview([]);
      ed.app.selection.clear();
      ed.addDimension(spec, s.p);
      void ids;
      return true;
    },
    cancel() {
      const was = picked.length > 0;
      picked = [];
      ed.setPreview([]);
      ed.app.selection.clear();
      return was;
    },
    options() {
      return [h('p', { class: 'field-label' }, 'Lines: drag the label sideways for horizontal or vertical distance. Two lines give an angle, parallel lines a distance. Circles are dimensioned by diameter, arcs by radius. Type "=" followed by a variable name to link a value.')];
    },
  };
}
