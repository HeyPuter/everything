/**
 * Object snapping in plan views: endpoints, midpoints, intersections,
 * centers, perpendicular and nearest points on element edges, plus angle
 * tracking and length rounding from the previous point, and alignment
 * with nearby points.
 */
import { add, sub, scale, dot, dist, norm, closestOnSegment, lineIntersect, len, angleOf, mid } from '../core/geom.js';
import { wallAxis, rampOutline } from '../core/model.js';
import { columnOutline } from '../core/plan.js';
import { buildFamily } from '../core/families.js';
import { Frame } from '../core/mesh.js';
import { snapIncrement } from '../core/units.js';
import { sectionFrame } from '../core/plan.js';

export const SNAP_KINDS = {
  endpoint: { label: 'Endpoint', rank: 0 },
  intersection: { label: 'Intersection', rank: 0 },
  center: { label: 'Center', rank: 1 },
  midpoint: { label: 'Midpoint', rank: 1 },
  perpendicular: { label: 'Perpendicular', rank: 2 },
  nearest: { label: 'Nearest', rank: 3 },
  grid: { label: 'Grid', rank: 2 },
};

/** Snap features of an element in plan: { points: [{p, kind}], lines: [{a, b, ref}] }. */
export function snapFeatures(scene, el) {
  const doc = scene.doc;
  const points = [];
  const lines = [];
  const P = (p, kind = 'endpoint') => p && points.push({ p, kind, id: el.id });
  const Lg = (a, b, ref) => lines.push({ a, b, id: el.id, ref });
  switch (el.kind) {
    case 'wall': {
      const g = scene.walls.wall(el.id);
      P(el.a);
      P(el.b);
      P(mid(el.a, el.b), 'midpoint');
      Lg(el.a, el.b, 'center');
      if (g) {
        for (const c of [g.L0, g.L1, g.R0, g.R1]) P(c);
        Lg(g.L0, g.L1, 'left');
        Lg(g.R0, g.R1, 'right');
      } else {
        const ax = wallAxis(doc, el);
        Lg(ax.a, ax.b, 'center');
      }
      break;
    }
    case 'ramp': {
      const o = rampOutline(doc, el);
      o.forEach((p) => P(p));
      for (let i = 0; i < o.length; i++) Lg(o[i], o[(i + 1) % o.length], 'edge');
      P(el.a, 'midpoint');
      break;
    }
    case 'grid':
    case 'detailLine':
    case 'roomSeparator':
    case 'beam':
    case 'detailArc': {
      P(el.c, 'center');
      const full = Math.abs((el.a1 ?? Math.PI * 2) - (el.a0 ?? 0)) >= Math.PI * 2 - 1e-6;
      if (!full) for (const a of [el.a0, el.a1]) P([el.c[0] + Math.cos(a) * el.r, el.c[1] + Math.sin(a) * el.r]);
      break;
    }
    case 'refPlane':
    case 'modelLine':
    case 'areaBoundary':
    case 'insulation':
      P(el.a);
      P(el.b);
      P(mid(el.a, el.b), 'midpoint');
      Lg(el.a, el.b, 'center');
      break;
    case 'column': {
      P(el.at, 'center');
      const o = columnOutline(doc, el);
      if (o.length <= 8) o.forEach((p) => P(p));
      for (let i = 0; i < o.length; i++) Lg(o[i], o[(i + 1) % o.length], 'edge');
      break;
    }
    case 'component': {
      P(el.at, 'center');
      const type = doc.get(el.typeId);
      if (type) {
        const fr = new Frame(el.at, ((+el.rotation || 0) * Math.PI) / 180);
        const sym = buildFamily(type, fr, null, () => null);
        const o = sym.outline.map((p) => fr.apply(p));
        if (o.length <= 8) o.forEach((p) => P(p));
        for (let i = 0; i < o.length; i++) Lg(o[i], o[(i + 1) % o.length], 'edge');
      }
      break;
    }
    case 'floor':
    case 'ceiling':
    case 'roof': {
      const b = el.boundary || [];
      b.forEach((p) => P(p));
      for (let i = 0; i < b.length; i++) {
        Lg(b[i], b[(i + 1) % b.length], 'edge');
        P(mid(b[i], b[(i + 1) % b.length]), 'midpoint');
      }
      break;
    }
    case 'railing': {
      const pth = el.path || [];
      pth.forEach((p) => P(p));
      for (let i = 0; i + 1 < pth.length; i++) Lg(pth[i], pth[i + 1], 'edge');
      break;
    }
    case 'stair':
      P(el.a);
      P(el.b);
      break;
    case 'room':
      P(el.at, 'center');
      break;
    case 'door':
    case 'window': {
      const host = doc.get(el.hostId);
      if (host) {
        const ax = wallAxis(doc, host);
        P(add(ax.a, scale(ax.dir, el.t)), 'midpoint');
      }
      break;
    }
    case 'section': {
      P(el.a);
      P(el.b);
      Lg(el.a, el.b, 'center');
      void sectionFrame;
      break;
    }
    default:
      break;
  }
  return { points, lines };
}

/**
 * Snap a model point. ctx: { vc (view controller), from, exclude: Set,
 * settings, units }. Returns { point, kind, label, ref, guides: [[a, b]] }.
 */
export function snapPoint(ctx, p) {
  const { vc, from, exclude, settings = {} } = ctx;
  const tolPx = settings.tolPx ?? 12;
  const mmPerPx = vc.mmPerPx();
  const tol = tolPx * mmPerPx;
  const feats = vc.snapFeaturesNear(p, tol * 3, exclude);
  let best = null;
  const consider = (q, kind, ref, extra) => {
    const d = dist(p, q);
    if (d > tol) return;
    const rank = SNAP_KINDS[kind]?.rank ?? 3;
    // Prefer higher-ranked snaps unless a lower one is much closer.
    const score = d / mmPerPx + rank * 6;
    if (!best || score < best.score) best = { point: q, kind, label: SNAP_KINDS[kind]?.label || kind, ref, score, ...extra };
  };
  if (settings.enabled !== false) {
    for (const f of feats) {
      for (const pt of f.points) {
        if (pt.kind === 'midpoint' && settings.midpoints === false) continue;
        if (pt.kind === 'endpoint' && settings.endpoints === false) continue;
        consider(pt.p, pt.kind, { id: pt.id });
      }
    }
    // Intersections of nearby lines.
    if (settings.intersections !== false) {
      const near = [];
      for (const f of feats) for (const l of f.lines) if (closestOnSegment(p, l.a, l.b) && dist(p, closestOnSegment(p, l.a, l.b).point) < tol * 2) near.push(l);
      for (let i = 0; i < near.length && i < 40; i++)
        for (let j = i + 1; j < near.length && j < 40; j++) {
          const A = near[i];
          const B = near[j];
          if (A.id === B.id) continue;
          const hit = lineIntersect(A.a, sub(A.b, A.a), B.a, sub(B.b, B.a));
          if (!hit || hit.t < -0.001 || hit.t > 1.001 || hit.u < -0.001 || hit.u > 1.001) continue;
          consider(hit.point, 'intersection', { id: A.id });
        }
    }
    if (!best || best.kind === 'nearest') {
      for (const f of feats)
        for (const l of f.lines) {
          if (from && settings.perpendicular !== false) {
            const d = norm(sub(l.b, l.a));
            const q = add(l.a, scale(d, dot(sub(from, l.a), d)));
            const t = dot(sub(q, l.a), d);
            if (t >= 0 && t <= len(sub(l.b, l.a))) consider(q, 'perpendicular', { id: l.id, ref: l.ref, line: l });
          }
          if (settings.nearest !== false) {
            const c = closestOnSegment(p, l.a, l.b);
            consider(c.point, 'nearest', { id: l.id, ref: l.ref, line: l }, { line: l });
          }
        }
    }
  }
  if (best) return { ...best, guides: [] };

  // Tracking from the previous point: angles and lengths.
  let q = p;
  const guides = [];
  let kind = null;
  if (from && settings.angles !== false) {
    const v = sub(p, from);
    const L = len(v);
    if (L > mmPerPx * 4) {
      const a = angleOf(v);
      const step = Math.PI / 12;
      const snapped = Math.round(a / step) * step;
      const offPx = Math.abs(Math.sin(a - snapped)) * L / mmPerPx;
      if (offPx < 10) {
        const dir = [Math.cos(snapped), Math.sin(snapped)];
        let l2 = dot(v, dir);
        if (settings.lengths !== false) {
          const inc = snapIncrement(mmPerPx, ctx.units);
          l2 = Math.round(l2 / inc) * inc;
        }
        q = add(from, scale(dir, l2));
        guides.push([from, add(from, scale(dir, Math.max(l2, L) + 40 * mmPerPx))]);
        kind = 'tracking';
      }
    }
  }
  // Alignment with nearby points (horizontal and vertical).
  if (!kind && settings.alignment !== false) {
    let ax = null;
    let ay = null;
    for (const f of feats)
      for (const pt of f.points) {
        if (pt.kind !== 'endpoint' && pt.kind !== 'center') continue;
        const dx = Math.abs(pt.p[0] - p[0]);
        const dy = Math.abs(pt.p[1] - p[1]);
        if (dx < tol * 0.6 && (!ax || dx < Math.abs(ax[0] - p[0]))) ax = pt.p;
        if (dy < tol * 0.6 && (!ay || dy < Math.abs(ay[1] - p[1]))) ay = pt.p;
      }
    if (ax || ay) {
      q = [ax ? ax[0] : p[0], ay ? ay[1] : p[1]];
      if (ax) guides.push([ax, q]);
      if (ay) guides.push([ay, q]);
      kind = 'alignment';
    }
  }
  return { point: q, kind, label: kind === 'tracking' ? '' : kind === 'alignment' ? 'Alignment' : '', ref: null, guides };
}
