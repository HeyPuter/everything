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
 * Engine params for a node's stroke. `pattern` ({ dash, offset }) is the
 * dash actually drawn (corner-aligned dashes adjust the node's own).
 */
export function strokeParams(node, pattern = null) {
  let dash = pattern ? pattern.dash || [] : node.dash && node.dash.length ? node.dash : [];
  const offset = pattern ? pattern.offset || 0 : node.dashOffset || 0;
  const cap = CAP[node.strokeCap] ?? 0;
  // Zero-length dashes with round or square caps draw as dots, but the
  // engine's stroker emits nothing for a zero-length segment: give them a
  // negligible length so each dot gets its caps.
  if (cap && dash.some((d) => d === 0) && dash.some((d) => d > 0)) dash = dash.map((d) => (d === 0 ? DOT_DASH : d));
  return [node.strokeWidth || 0, JOIN[node.strokeJoin] ?? 0, cap, node.miterLimit || 10, ALIGN[node.strokeAlign] ?? 0, offset, ...dash];
}
