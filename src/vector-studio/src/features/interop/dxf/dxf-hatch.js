/**
 * DXF hatch patterns as pattern swatches.
 *
 * A HATCH entity stores its pattern as families of parallel lines (already
 * scaled and rotated): an angle, a base point, the offset from one line to
 * the next and an optional dash list (positive dashes, negative gaps, zero
 * for dots). The families repeat on a rectangular tile when a horizontal
 * and a vertical translation map every family (and its dashes) onto
 * itself; the tile's art is the line pieces inside it.
 *
 *   readHatchPattern(pairs, from) -> { name, lines: [{ angle, base, offset, dashes }] } | null
 *   patternTile(lines) -> { w, h, segments: [[x0, y0, x1, y1]] } | null
 */

const EPS = 1e-6;

/** The pattern definition lines of a HATCH entity, read from pairs[from] on. */
export function readHatchPattern(pairs, from = 0) {
  let name = '';
  let i = from;
  for (; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 2 && !name) name = String(v).trim();
    if (c === 78) break;
  }
  // The name comes before the boundaries.
  if (!name) for (const [c, v] of pairs) if (c === 2) name = String(v).trim();
  if (i >= pairs.length) return null;
  const count = Number(pairs[i][1]) || 0;
  i++;
  const lines = [];
  for (let l = 0; l < count && i < pairs.length; l++) {
    const line = { angle: 0, base: [0, 0], offset: [0, 0], dashes: [] };
    let dashCount = 0;
    // 53 angle, 43/44 base, 45/46 offset, 79 dash count, then 49 per dash.
    for (; i < pairs.length; i++) {
      const [c, v] = pairs[i];
      const n = Number(v);
      if (c === 53) line.angle = n;
      else if (c === 43) line.base[0] = n;
      else if (c === 44) line.base[1] = n;
      else if (c === 45) line.offset[0] = n;
      else if (c === 46) line.offset[1] = n;
      else if (c === 79) {
        dashCount = n;
        i++;
        break;
      } else break;
    }
    for (let d = 0; d < dashCount && i < pairs.length && pairs[i][0] === 49; d++, i++) line.dashes.push(Number(pairs[i][1]));
    lines.push(line);
  }
  return lines.length ? { name, lines } : null;
}

/** A family's frame: direction, normal, spacing across lines and shift along them per line, dash period. */
function frame(line) {
  const a = (line.angle * Math.PI) / 180;
  const d = [Math.cos(a), Math.sin(a)];
  const n = [-d[1], d[0]];
  const p = line.offset[0] * n[0] + line.offset[1] * n[1];
  const s = line.offset[0] * d[0] + line.offset[1] * d[1];
  const period = line.dashes.reduce((t, x) => t + Math.abs(x), 0);
  return { d, n, p, s, period, dashed: line.dashes.length > 0 && period > EPS && line.dashes.some((x) => x < 0) };
}

/**
 * Whether translating by (tx, ty) maps the family onto itself: a whole
 * number of line steps across, and whole dash periods along the lines.
 */
function maps(f, tx, ty, tol) {
  if (Math.abs(f.p) < EPS) return false;
  const across = (tx * f.n[0] + ty * f.n[1]) / f.p;
  const k = Math.round(across);
  if (Math.abs(across - k) > tol) return false;
  if (!f.dashed) return true;
  const along = tx * f.d[0] + ty * f.d[1] - k * f.s;
  const r = along / f.period;
  return Math.abs(r - Math.round(r)) <= tol;
}

/** The smallest length L along an axis (x or y) that every family repeats over, or null. */
function period(fams, axis) {
  const cands = [];
  for (const f of fams) {
    // Distance along the axis between neighboring lines of the family.
    const nAxis = axis === 'x' ? f.n[0] : f.n[1];
    if (Math.abs(nAxis) > EPS) cands.push(Math.abs(f.p / nAxis));
    if (f.dashed) {
      const dAxis = axis === 'x' ? f.d[0] : f.d[1];
      if (Math.abs(dAxis) > EPS) cands.push(Math.abs(f.period / dAxis));
    }
  }
  if (!cands.length) return null;
  const base = Math.min(...cands);
  const tol = 1e-4;
  for (let m = 1; m <= 400; m++) {
    for (const c of cands) {
      const L = c * m;
      if (L < base - EPS) continue;
      const ok = fams.every((f) => (axis === 'x' ? maps(f, L, 0, tol) : maps(f, 0, L, tol)));
      if (ok) return L;
    }
  }
  return null;
}

/** Clip the line q + t d to the rectangle [0, w] x [0, h]: [t0, t1] or null. */
function clipLine(q, d, w, h) {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (const [p, dir, lo, hi] of [[q[0], d[0], 0, w], [q[1], d[1], 0, h]]) {
    if (Math.abs(dir) < EPS) {
      if (p < lo - EPS || p > hi + EPS) return null;
      continue;
    }
    let a = (lo - p) / dir;
    let b = (hi - p) / dir;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
  }
  return t1 >= t0 ? [t0, t1] : null;
}

/**
 * The tile of a set of pattern lines: its size (drawing units) and the
 * line pieces inside it ([x0, y0, x1, y1]; equal ends are dots). Null when
 * the families do not repeat on a reasonably small tile.
 */
export function patternTile(lines, { maxSegments = 20000 } = {}) {
  const fams = lines.map((l) => ({ ...frame(l), line: l })).filter((f) => Math.abs(f.p) > EPS);
  if (!fams.length) return null;
  const spacing = Math.min(...fams.map((f) => Math.abs(f.p)));
  // Families parallel to an axis repeat along it at any length: use a multiple of the spacing.
  let w = period(fams, 'x');
  let h = period(fams, 'y');
  if (!w && fams.every((f) => Math.abs(f.n[0]) < EPS && !f.dashed)) w = spacing;
  if (!h && fams.every((f) => Math.abs(f.n[1]) < EPS && !f.dashed)) h = spacing;
  if (!w || !h || w > spacing * 500 || h > spacing * 500) return null;
  const segments = [];
  for (const f of fams) {
    const { d, n, p } = f;
    const b = f.line.base;
    const bn = b[0] * n[0] + b[1] * n[1];
    const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => x * n[0] + y * n[1]);
    const k0 = Math.floor((Math.min(...corners) - bn) / p) - 1;
    const k1 = Math.ceil((Math.max(...corners) - bn) / p) + 1;
    const [klo, khi] = p > 0 ? [k0, k1] : [-k1, -k0];
    for (let k = Math.min(klo, khi); k <= Math.max(klo, khi); k++) {
      const q = [b[0] + k * f.line.offset[0], b[1] + k * f.line.offset[1]];
      const range = clipLine(q, d, w, h);
      if (!range) continue;
      const [t0, t1] = range;
      const at = (t) => [q[0] + d[0] * t, q[1] + d[1] * t];
      if (!f.line.dashes.length || !f.dashed) {
        segments.push([...at(t0), ...at(t1)]);
      } else {
        const P = f.period;
        let t = Math.floor(t0 / P) * P;
        for (; t < t1 && segments.length < maxSegments; ) {
          for (const dash of f.line.dashes) {
            const len = Math.abs(dash);
            if (dash >= 0) {
              const a = Math.max(t, t0);
              const e = Math.min(t + len, t1);
              if (dash === 0 ? t >= t0 - EPS && t <= t1 + EPS : e > a + EPS) segments.push([...at(a), ...at(dash === 0 ? a : e)]);
            }
            t += len;
            if (t >= t1) break;
          }
        }
      }
      if (segments.length >= maxSegments) return null;
    }
  }
  return { w, h, segments };
}
