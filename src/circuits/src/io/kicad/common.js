// Shared helpers for the KiCad importer.

import { find } from './sexpr.js';

/** Millimetres to integer nanometres. */
export const nm = (v) => Math.round((Number(v) || 0) * 1e6);

export const norm360 = (a) => ((a % 360) + 360) % 360;

/** Board layer names to Circuits layer ids. */
export const LAYER_MAP = {
  'F.Cu': 'top', 'B.Cu': 'bottom', 'In1.Cu': 'in1', 'In2.Cu': 'in2', 'In3.Cu': 'in3', 'In4.Cu': 'in4',
  'F.SilkS': 'topOverlay', 'B.SilkS': 'bottomOverlay', 'F.Silkscreen': 'topOverlay', 'B.Silkscreen': 'bottomOverlay',
  'F.Mask': 'topSolder', 'B.Mask': 'bottomSolder', 'F.Paste': 'topPaste', 'B.Paste': 'bottomPaste',
  'F.Fab': 'mech1', 'B.Fab': 'mech1', 'Dwgs.User': 'mech2', 'Cmts.User': 'mech2', 'User.Drawings': 'mech2', 'User.Comments': 'mech2',
  'F.CrtYd': 'courtyard', 'B.CrtYd': 'courtyard', 'F.Courtyard': 'courtyard', 'B.Courtyard': 'courtyard',
};

/** Swaps front and back layer names (used to normalize bottom-side footprints). */
export function flipName(name) {
  if (typeof name !== 'string') return name;
  if (name.startsWith('F.')) return `B.${name.slice(2)}`;
  if (name.startsWith('B.')) return `F.${name.slice(2)}`;
  return name;
}

/** Id-safe slug. */
export const slug = (s) => String(s || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'x';

/**
 * Arc through three points (any y orientation the caller already chose).
 * Returns { cx, cy, r, a0, sweep } with a counter-clockwise sweep, or null
 * when the points are collinear.
 */
export function arcFrom3(p1, p2, p3) {
  const [ax, ay] = p1, [bx, by] = p2, [cx, cy] = p3;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const ang = (x, y) => (Math.atan2(y - uy, x - ux) * 180) / Math.PI;
  const t1 = ang(ax, ay), t2 = ang(bx, by), t3 = ang(cx, cy);
  const s13 = norm360(t3 - t1), s12 = norm360(t2 - t1);
  if (s12 <= s13) return { cx: ux, cy: uy, r, a0: norm360(t1), sweep: s13 || 360 };
  return { cx: ux, cy: uy, r, a0: norm360(t3), sweep: 360 - s13 };
}

/**
 * Start, mid and end points of an arc item in file coordinates, or null.
 * KiCad 6+ writes (start) (mid) (end). KiCad 5 wrote (start) as the centre,
 * (end) as the arc's first point and (angle) in degrees, clockwise on screen
 * (y down), which is a standard rotation in file coordinates.
 */
export function arcPoints(item) {
  const s = find(item, 'start'), m = find(item, 'mid'), e = find(item, 'end');
  if (!s || !e) return null;
  const xy = (l) => [Number(l[1]) || 0, Number(l[2]) || 0];
  if (m) return [xy(s), xy(m), xy(e)];
  const angle = Number(find(item, 'angle')?.[1]);
  if (!angle) return null;
  const [cx, cy] = xy(s), [px, py] = xy(e);
  const at = (deg) => {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
    return [cx + (px - cx) * c - (py - cy) * sn, cy + (px - cx) * sn + (py - cy) * c];
  };
  return [[px, py], at(angle / 2), at(angle)];
}

/** Collects warnings without duplicates. */
export class Warnings {
  constructor() { this.list = []; this.seen = new Set(); }
  add(msg) {
    if (this.seen.has(msg)) return;
    this.seen.add(msg);
    if (this.list.length < 200) this.list.push(msg);
  }
}

/** Text height in mm from an (effects (font (size h w))) child, or fallback. */
export function fontSize(list, fallback = 1.27) {
  const eff = find(list, 'effects');
  const size = find(find(eff, 'font'), 'size');
  return size ? Number(size[1]) || fallback : fallback;
}

/** Stroke width in mm from (stroke (width w)) or (width w). */
export function strokeWidth(list) {
  const s = find(list, 'stroke');
  const w = s ? find(s, 'width') : find(list, 'width');
  return w ? Number(w[1]) || 0 : 0;
}
