/**
 * Dimension and leader geometry. Pure functions that turn a 'dimension' or
 * 'leader' entity plus its dimension style into drawing primitives:
 *
 *   {
 *     lines: Array<{ pts: number[] flat world points, closed: boolean }>,
 *     fills: Array<rings[]>   solid arrowheads; rings as in display.js
 *     text:  { x, y, h, rot, value, halign, valign } | null
 *            a 'text'-entity-shaped record for layoutText (value may hold
 *            the diameter and degree signs)
 *   }
 *
 * Style sizes are multiplied by style.scale. Text height comes from the
 * style (textHeight); the font from style.font when present, else 'sans'.
 */
import { defaultDimStyle } from './styles.js';
import { formatAngle, formatLinear } from './units.js';
import { measureText, textBounds } from './text/layout.js';

export const DIAMETER_SIGN = '⌀';

const DEFAULTS = defaultDimStyle();
const TWO_PI = Math.PI * 2;
const EPS = 1e-12;

/**
 * The dimension style an entity draws with (named, else 'Standard', else the
 * defaults), carrying the font of its text style so text is measured with the
 * font it is drawn in.
 */
export function dimStyleOf(drawing, name) {
  const ds = drawing.dimStyles.get(name) ?? drawing.dimStyles.get('Standard') ?? DEFAULTS;
  const font = drawing.textStyles?.get(ds.textStyle)?.font;
  return font && font !== ds.font ? { ...ds, font } : ds;
}

function styleOf(style) {
  return style ? { ...DEFAULTS, ...style } : DEFAULTS;
}

function sizes(st) {
  const k = st.scale > 0 ? st.scale : 1;
  return {
    asz: st.arrowSize * k,
    gap: st.textGap * k,
    th: st.textHeight * k,
    off: st.extOffset * k,
    ext: st.extExtend * k,
    cm: st.centerMark * k,
    font: st.font ?? 'sans',
  };
}

function norm2pi(a) {
  a %= TWO_PI;
  return a < 0 ? a + TWO_PI : a;
}

/** Rotation in (-PI/2, PI/2] so text along a line reads left to right or bottom to top. */
function readable(a) {
  a = norm2pi(a);
  if (a > Math.PI) a -= TWO_PI;
  if (a > Math.PI / 2 + 1e-9) a -= Math.PI;
  else if (a <= -Math.PI / 2 + 1e-9) a += Math.PI;
  return a;
}

/**
 * Arc of an angular dimension as { start, sweep } (radians, counter-clockwise):
 * the sector between the two rays that contains the location point (lx, ly).
 */
export function angularSector(ent) {
  const vx = ent.x3 ?? 0,
    vy = ent.y3 ?? 0;
  const a1 = Math.atan2(ent.y1 - vy, ent.x1 - vx);
  const a2 = Math.atan2(ent.y2 - vy, ent.x2 - vx);
  const s = norm2pi(a2 - a1);
  const lx = ent.lx ?? vx,
    ly = ent.ly ?? vy;
  if (Math.hypot(lx - vx, ly - vy) > EPS) {
    if (norm2pi(Math.atan2(ly - vy, lx - vx) - a1) > s) return { start: a2, sweep: TWO_PI - s };
  } else if (s > Math.PI) return { start: a2, sweep: TWO_PI - s };
  return { start: a1, sweep: s };
}

/**
 * Measured value: length for linear (projected on the dimension line angle
 * `rot`), aligned and ordinate (distance from the datum axis), radius or
 * diameter, and the swept angle in radians for angular.
 */
export function measureDimension(ent) {
  const dx = ent.x2 - ent.x1,
    dy = ent.y2 - ent.y1;
  switch (ent.dimType) {
    case 'aligned':
      return Math.hypot(dx, dy);
    case 'angular':
      return angularSector(ent).sweep;
    case 'radius':
      return Math.hypot(dx, dy);
    case 'diameter':
      return 2 * Math.hypot(dx, dy);
    case 'ordinate':
      return Math.abs(ent.ordAxis === 'y' ? ent.y1 : ent.x1);
    default: {
      const r = ent.rot || 0;
      return Math.abs(dx * Math.cos(r) + dy * Math.sin(r));
    }
  }
}

/**
 * Displayed text. The measured value is formatted with the header's linear
 * or angular format at the style's precision (trailing zeros per
 * style.trailingZeros), decorated as prefix + symbol + value + suffix where
 * the symbol is 'R' for radius and the diameter sign for diameter. Angles
 * in degrees get the degree sign. ent.text '' shows that string; otherwise
 * every '<>' in ent.text is replaced by it, and text without '<>' is shown as is.
 */
export function dimensionText(ent, style, header) {
  const st = styleOf(style);
  const m = measureDimension(ent);
  const trimZeros = !st.trailingZeros;
  let num;
  if (ent.dimType === 'angular') {
    num = formatAngle(
      m,
      { angularFormat: header?.angularFormat ?? 'deg', angularPrecision: st.precision },
      { symbol: true, trimZeros },
    );
  } else {
    num = formatLinear(m, { format: header?.linearFormat ?? 'decimal', precision: st.precision, trimZeros });
  }
  const sym = ent.dimType === 'radius' ? 'R' : ent.dimType === 'diameter' ? DIAMETER_SIGN : '';
  const full = `${st.prefix ?? ''}${sym}${num}${st.suffix ?? ''}`;
  const t = ent.text ?? '';
  if (t === '') return full;
  return t.indexOf('<>') >= 0 ? t.split('<>').join(full) : t;
}

// ---------------------------------------------------------------------------
// Primitives.

function seg(out, x0, y0, x1, y1) {
  out.lines.push({ pts: [x0, y0, x1, y1], closed: false });
}

/** Arrowhead with its tip at (x, y) pointing along unit vector (dx, dy). */
function arrow(out, type, x, y, dx, dy, size) {
  if (!(size > 0) || type === 'none') return;
  const px = -dy,
    py = dx;
  if (type === 'tick') {
    const k = size * 0.5 * Math.SQRT1_2;
    const hx = (dx + px) * k,
      hy = (dy + py) * k;
    seg(out, x - hx, y - hy, x + hx, y + hy);
    return;
  }
  if (type === 'dot') {
    const r = size * 0.25;
    const ring = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TWO_PI;
      ring.push(x + r * Math.cos(a), y + r * Math.sin(a));
    }
    out.fills.push([ring]);
    return;
  }
  const w = size / 6;
  const bx = x - dx * size,
    by = y - dy * size;
  if (type === 'open') {
    out.lines.push({ pts: [bx + px * w, by + py * w, x, y, bx - px * w, by - py * w], closed: false });
  } else {
    out.fills.push([[x, y, bx + px * w, by + py * w, bx - px * w, by - py * w]]);
  }
}

/** Extension line from near (px, py) to just past (qx, qy). */
function extension(out, px, py, qx, qy, sz) {
  const dx = qx - px,
    dy = qy - py;
  const l = Math.hypot(dx, dy);
  if (l <= sz.off || l < EPS) return;
  const ex = dx / l,
    ey = dy / l;
  seg(out, px + ex * sz.off, py + ey * sz.off, qx + ex * sz.ext, qy + ey * sz.ext);
}

/** Polyline points of a circular arc from a0 to a1 (radians). */
function arcPts(cx, cy, r, a0, a1) {
  const sw = a1 - a0;
  const n = Math.max(2, Math.ceil((Math.abs(sw) * 48) / Math.PI));
  const pts = new Array((n + 1) * 2);
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sw * i) / n;
    pts[i * 2] = cx + r * Math.cos(a);
    pts[i * 2 + 1] = cy + r * Math.sin(a);
  }
  return pts;
}

/**
 * Text record centred on (px, py) for a line with unit direction (tx, ty).
 * The normal (nx, ny) points to the side text goes on: the preferred
 * direction (rx, ry) when given, else the text's upper side (ties go left).
 * along / across are the half extents of the text box along the line and
 * along that normal.
 */
function textOnLine(value, px, py, tx, ty, sz, st, rx, ry) {
  const w = measureText(value, sz.th, 1, sz.font);
  const rot = st.textAlign === 'horizontal' ? 0 : readable(Math.atan2(ty, tx));
  const c = Math.cos(rot),
    s = Math.sin(rot);
  let nx = -ty,
    ny = tx;
  const dp = nx * (rx ?? -s) + ny * (ry ?? c);
  if (dp < -1e-9 || (Math.abs(dp) <= 1e-9 && nx > 0)) {
    nx = -nx;
    ny = -ny;
  }
  const hw = w / 2,
    hh = sz.th / 2;
  return {
    rec: { x: px, y: py, h: sz.th, rot, value, halign: 'center', valign: 'middle' },
    along: Math.abs(hw * (c * tx + s * ty)) + Math.abs(hh * (c * ty - s * tx)),
    across: Math.abs(hw * (c * nx + s * ny)) + Math.abs(hh * (c * ny - s * nx)),
    nx,
    ny,
  };
}

/** Move a text record to the normal side of its line, clear of it by the text gap. */
function lift(t, gap) {
  t.rec.x += t.nx * (gap + t.across);
  t.rec.y += t.ny * (gap + t.across);
}

// ---------------------------------------------------------------------------
// Dimension types.

/** Dimension line from A to B with arrows and text; (fx, fy) is the direction when A = B. */
function dimLine(out, ax, ay, bx, by, fx, fy, value, st, sz) {
  const len = Math.hypot(bx - ax, by - ay);
  const tx = len > EPS ? (bx - ax) / len : fx,
    ty = len > EPS ? (by - ay) / len : fy;
  const { asz, gap } = sz;
  const centered = st.textPlacement === 'centered';
  const mx = (ax + bx) / 2,
    my = (ay + by) / 2;
  const t = value ? textOnLine(value, mx, my, tx, ty, sz, st) : null;
  const along = t ? t.along : 0;
  const need = t ? 2 * along + 2 * asz + 2 * gap : 2 * asz;
  if (len >= need - 1e-9) {
    if (centered && t) {
      const d = along + gap;
      seg(out, ax, ay, mx - tx * d, my - ty * d);
      seg(out, mx + tx * d, my + ty * d, bx, by);
    } else seg(out, ax, ay, bx, by);
    arrow(out, st.arrowType, ax, ay, -tx, -ty, asz);
    arrow(out, st.arrowType, bx, by, tx, ty, asz);
    if (t) {
      if (!centered) lift(t, gap);
      out.text = t.rec;
    }
    return;
  }
  // Too tight: arrows outside pointing in, short tails, text past B.
  const tail = 2 * asz;
  let endB = tail;
  if (t) {
    const d = tail + gap + along;
    t.rec.x = bx + tx * d;
    t.rec.y = by + ty * d;
    if (!centered) {
      lift(t, gap);
      endB = tail + gap + 2 * along;
    }
    out.text = t.rec;
  }
  seg(out, ax - tx * tail, ay - ty * tail, bx + tx * endB, by + ty * endB);
  arrow(out, st.arrowType, ax, ay, tx, ty, asz);
  arrow(out, st.arrowType, bx, by, -tx, -ty, asz);
}

function buildLinear(ent, st, sz, value, out) {
  const x1 = ent.x1,
    y1 = ent.y1,
    x2 = ent.x2,
    y2 = ent.y2;
  let ux, uy;
  if (ent.dimType === 'aligned') {
    const l = Math.hypot(x2 - x1, y2 - y1);
    ux = l > EPS ? (x2 - x1) / l : 1;
    uy = l > EPS ? (y2 - y1) / l : 0;
  } else {
    ux = Math.cos(ent.rot || 0);
    uy = Math.sin(ent.rot || 0);
  }
  const lx = ent.lx ?? x2,
    ly = ent.ly ?? y2;
  const t1 = (x1 - lx) * ux + (y1 - ly) * uy,
    t2 = (x2 - lx) * ux + (y2 - ly) * uy;
  const ax = lx + ux * t1,
    ay = ly + uy * t1,
    bx = lx + ux * t2,
    by = ly + uy * t2;
  extension(out, x1, y1, ax, ay, sz);
  extension(out, x2, y2, bx, by, sz);
  dimLine(out, ax, ay, bx, by, ux, uy, value, st, sz);
}

/** Arrow at an arc end, its body following the chord back along the arc. */
function arcArrow(out, st, vx, vy, r, tipA, backA, size) {
  const x = vx + r * Math.cos(tipA),
    y = vy + r * Math.sin(tipA);
  let dx = x - (vx + r * Math.cos(backA)),
    dy = y - (vy + r * Math.sin(backA));
  const l = Math.hypot(dx, dy);
  if (l < EPS) return;
  dx /= l;
  dy /= l;
  arrow(out, st.arrowType, x, y, dx, dy, size);
}

function buildAngular(ent, st, sz, value, out) {
  const vx = ent.x3 ?? 0,
    vy = ent.y3 ?? 0;
  const { start, sweep } = angularSector(ent);
  const end = start + sweep;
  let r = Math.hypot((ent.lx ?? ent.x1) - vx, (ent.ly ?? ent.y1) - vy);
  if (!(r > EPS)) r = Math.max(Math.hypot(ent.x1 - vx, ent.y1 - vy), Math.hypot(ent.x2 - vx, ent.y2 - vy)) || 1;
  for (const [px, py] of [
    [ent.x1, ent.y1],
    [ent.x2, ent.y2],
  ]) {
    const d = Math.hypot(px - vx, py - vy);
    if (d > EPS && r > d) extension(out, px, py, vx + ((px - vx) / d) * r, vy + ((py - vy) / d) * r, sz);
  }
  const { asz, gap } = sz;
  const centered = st.textPlacement === 'centered';
  const am = start + sweep / 2;
  const t = value
    ? textOnLine(value, vx + r * Math.cos(am), vy + r * Math.sin(am), -Math.sin(am), Math.cos(am), sz, st, Math.cos(am), Math.sin(am))
    : null;
  const along = t ? t.along : 0;
  const need = t ? 2 * along + 2 * asz + 2 * gap : 2 * asz;
  if (r * sweep >= need - 1e-9) {
    if (centered && t) {
      const da = (along + gap) / r;
      out.lines.push({ pts: arcPts(vx, vy, r, start, am - da), closed: false });
      out.lines.push({ pts: arcPts(vx, vy, r, am + da, end), closed: false });
    } else out.lines.push({ pts: arcPts(vx, vy, r, start, end), closed: false });
    const da = Math.min(asz / r, sweep / 2);
    arcArrow(out, st, vx, vy, r, start, start + da, asz);
    arcArrow(out, st, vx, vy, r, end, end - da, asz);
    if (t) {
      if (!centered) lift(t, gap);
      out.text = t.rec;
    }
    return;
  }
  // Too tight: arrows outside on tangent tails, text past the end of the arc
  // nearer the location (the counter-clockwise end on a tie), so that a
  // mirrored dimension draws the mirror image.
  out.lines.push({ pts: arcPts(vx, vy, r, start, end), closed: false });
  const tail = 2 * asz;
  const lu = (ent.lx ?? vx) - vx,
    lv = (ent.ly ?? vy) - vy;
  const off = norm2pi(Math.atan2(lv, lu) - start);
  const k = Math.hypot(lu, lv) > EPS && off < sweep / 2 - 1e-9 ? 0 : 1;
  // Each end: its point and the tangent pointing away from the arc.
  const ends = [start, end].map((a, i) => {
    const sg = i ? 1 : -1;
    const x = vx + r * Math.cos(a),
      y = vy + r * Math.sin(a);
    return { a, x, y, tx: -Math.sin(a) * sg, ty: Math.cos(a) * sg, tail };
  });
  if (value) {
    const e = ends[k];
    const d = tail + gap;
    const t2 = textOnLine(value, e.x, e.y, e.tx, e.ty, sz, st, Math.cos(e.a), Math.sin(e.a));
    t2.rec.x += e.tx * (d + t2.along);
    t2.rec.y += e.ty * (d + t2.along);
    if (!centered) {
      lift(t2, gap);
      e.tail = d + 2 * t2.along;
    }
    out.text = t2.rec;
  }
  for (const e of ends) seg(out, e.x, e.y, e.x + e.tx * e.tail, e.y + e.ty * e.tail);
  for (const e of ends) arrow(out, st.arrowType, e.x, e.y, -e.tx, -e.ty, asz);
}

function buildRadial(ent, st, sz, value, diameter, out) {
  const cx = ent.x1,
    cy = ent.y1;
  const r = Math.hypot(ent.x2 - cx, ent.y2 - cy);
  const lx = ent.lx ?? ent.x2,
    ly = ent.ly ?? ent.y2;
  let dx = lx - cx,
    dy = ly - cy;
  let dl = Math.hypot(dx, dy);
  if (dl < EPS) {
    dx = ent.x2 - cx;
    dy = ent.y2 - cy;
    dl = r;
  }
  if (dl < EPS) {
    dx = 1;
    dy = 0;
    dl = 1;
  }
  const ux = dx / dl,
    uy = dy / dl;
  if (sz.cm > 0) {
    seg(out, cx - sz.cm, cy, cx + sz.cm, cy);
    seg(out, cx, cy - sz.cm, cx, cy + sz.cm);
  }
  const qx = cx + ux * r,
    qy = cy + uy * r;
  const outside = Math.hypot(lx - cx, ly - cy) > r + 1e-9;
  const sx = diameter ? cx - ux * r : cx,
    sy = diameter ? cy - uy * r : cy;
  seg(out, sx, sy, outside ? lx : qx, outside ? ly : qy);
  arrow(out, st.arrowType, qx, qy, ux, uy, sz.asz);
  if (diameter) arrow(out, st.arrowType, sx, sy, -ux, -uy, sz.asz);
  if (!value) return;
  const t = textOnLine(value, lx, ly, ux, uy, sz, st);
  if (outside) {
    t.rec.x += ux * (sz.gap + t.along);
    t.rec.y += uy * (sz.gap + t.along);
  } else lift(t, sz.gap);
  out.text = t.rec;
}

function buildOrdinate(ent, st, sz, value, out) {
  const fx = ent.x1,
    fy = ent.y1,
    ex = ent.x2,
    ey = ent.y2;
  const alongY = ent.ordAxis !== 'y';
  // Work in (a, b) where a runs along the leader and b across it.
  const fa = alongY ? fy : fx,
    fb = alongY ? fx : fy,
    ea = alongY ? ey : ex,
    eb = alongY ? ex : ey;
  const d = ea - fa;
  const sg = d >= 0 ? 1 : -1;
  const pt = (a, b) => (alongY ? [b, a] : [a, b]);
  const pts = [...pt(fa + sg * sz.off, fb)];
  if (Math.abs(eb - fb) > 1e-9) {
    let j1 = ea - sg * 2 * sz.asz,
      j2 = ea - sg * sz.asz;
    if (sg * (j1 - (fa + sg * sz.off)) < 0) {
      j1 = fa + d * 0.4;
      j2 = fa + d * 0.6;
    }
    pts.push(...pt(j1, fb), ...pt(j2, eb));
  }
  pts.push(...pt(ea, eb));
  out.lines.push({ pts, closed: false });
  if (!value) return;
  const [tx, ty] = pt(sg, 0);
  const t = textOnLine(value, ex, ey, tx, ty, sz, st);
  t.rec.x += tx * (sz.gap + t.along);
  t.rec.y += ty * (sz.gap + t.along);
  out.text = t.rec;
}

/**
 * Geometry of a dimension entity: { lines, fills, text } (see the module
 * comment). `style` is a dimension style (defaults fill missing fields).
 */
export function buildDimension(ent, style, header) {
  const st = styleOf(style);
  const sz = sizes(st);
  const out = { lines: [], fills: [], text: null };
  const value = dimensionText(ent, st, header);
  switch (ent.dimType) {
    case 'angular':
      buildAngular(ent, st, sz, value, out);
      break;
    case 'radius':
      buildRadial(ent, st, sz, value, false, out);
      break;
    case 'diameter':
      buildRadial(ent, st, sz, value, true, out);
      break;
    case 'ordinate':
      buildOrdinate(ent, st, sz, value, out);
      break;
    default:
      buildLinear(ent, st, sz, value, out);
  }
  return out;
}

/**
 * Geometry of a leader: the polyline through pts, an arrowhead at the first
 * point along the first segment and, when there is text, a short landing at
 * the last point with the text beyond it, left-justified when the last
 * segment runs rightwards and right-justified otherwise. Text height is
 * ent.h, or the style text height when ent.h is 0.
 */
export function buildLeader(ent, style) {
  const st = styleOf(style);
  const sz = sizes(st);
  const out = { lines: [], fills: [], text: null };
  const p = ent.pts ?? [];
  const n = p.length >> 1;
  if (n < 2) return out;
  out.lines.push({ pts: p.slice(0, n * 2), closed: false });
  const dx = p[0] - p[2],
    dy = p[1] - p[3];
  const l = Math.hypot(dx, dy);
  if (l > EPS) arrow(out, st.arrowType, p[0], p[1], dx / l, dy / l, Math.min(sz.asz, l));
  if (ent.text) {
    const lx = p[n * 2 - 2],
      ly = p[n * 2 - 1];
    const dir = lx >= p[n * 2 - 4] ? 1 : -1;
    const land = sz.asz;
    seg(out, lx, ly, lx + dir * land, ly);
    out.text = {
      x: lx + dir * (land + sz.gap),
      y: ly,
      h: ent.h > 0 ? ent.h : sz.th,
      rot: 0,
      value: ent.text,
      halign: dir > 0 ? 'left' : 'right',
      valign: 'middle',
    };
  }
  return out;
}

/**
 * Bounds [minX, minY, maxX, maxY] of a dimension or leader entity including
 * its text, or null when it draws nothing.
 */
export function dimensionBounds(ent, style, header) {
  const g = ent.type === 'leader' ? buildLeader(ent, style) : buildDimension(ent, style, header);
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (pts) => {
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < b[0]) b[0] = pts[i];
      if (pts[i] > b[2]) b[2] = pts[i];
      if (pts[i + 1] < b[1]) b[1] = pts[i + 1];
      if (pts[i + 1] > b[3]) b[3] = pts[i + 1];
    }
  };
  for (const l of g.lines) grow(l.pts);
  for (const f of g.fills) for (const r of f) grow(r);
  if (g.text) grow(textBounds({ type: 'text', ...g.text }, style?.font ?? 'sans'));
  return b[0] === Infinity ? null : b;
}
