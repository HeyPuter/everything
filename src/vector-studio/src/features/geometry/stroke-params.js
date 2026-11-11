/**
 * Geometry engine params for stroking a node (Outline Stroke, the Outline
 * Stroke effect, Flatten Transparency, Interlace).
 */

export const JOIN = { miter: 0, round: 1, bevel: 2 };
export const CAP = { butt: 0, round: 1, square: 2 };
export const ALIGN = { center: 0, inside: 1, outside: 2 };

/** Length given to zero-length dashes (dots) so the stroker draws their caps. */
const DOT_DASH = 1e-4;

/**
 * Most dashes the engine is asked to outline on one stroke. The stroker's
 * cost grows faster than the dash count (overlapping caps are united), so a
 * tiny dash on a long path (0.0001 pt dashes on a 100 pt line: 500,000
 * dashes) would freeze the tab; a denser pattern is outlined coarser, with
 * the same dash-to-gap proportions.
 */
export const MAX_DASHES = 5000;

/** Upper bound of the length of subpaths (their control polygons). */
function lengthBound(subpaths) {
  let len = 0;
  for (const sp of subpaths) {
    const a = sp.anchors;
    const n = a.length;
    for (let i = 0; i < (sp.closed ? n : n - 1); i++) {
      const p = a[i];
      const q = a[(i + 1) % n];
      len += Math.hypot(p.ox - p.x, p.oy - p.y) + Math.hypot(q.ix - p.ox, q.iy - p.oy) + Math.hypot(q.x - q.ix, q.y - q.iy);
    }
  }
  return len;
}

/**
 * Engine params for a node's stroke. `pattern` ({ dash, offset }) is the
 * dash actually drawn (corner-aligned dashes adjust the node's own).
 * With the stroked `subpaths`, a pattern that would make more than
 * MAX_DASHES dashes is scaled up to make that many.
 */
export function strokeParams(node, pattern = null, subpaths = null) {
  let dash = pattern ? pattern.dash || [] : node.dash && node.dash.length ? node.dash : [];
  let offset = pattern ? pattern.offset || 0 : node.dashOffset || 0;
  if (subpaths && dash.length) {
    const period = dash.reduce((s, d) => s + d, 0);
    const count = period > 0 ? (lengthBound(subpaths) * dash.length) / 2 / period : 0;
    if (count > MAX_DASHES) {
      const k = count / MAX_DASHES;
      dash = dash.map((d) => d * k);
      offset *= k;
    }
  }
  const cap = CAP[node.strokeCap] ?? 0;
  // Zero-length dashes with round or square caps draw as dots, but the
  // engine's stroker emits nothing for a zero-length segment: give them a
  // negligible length so each dot gets its caps.
  if (cap && dash.some((d) => d === 0) && dash.some((d) => d > 0)) dash = dash.map((d) => (d === 0 ? DOT_DASH : d));
  return [node.strokeWidth || 0, JOIN[node.strokeJoin] ?? 0, cap, node.miterLimit || 10, ALIGN[node.strokeAlign] ?? 0, offset, ...dash];
}
