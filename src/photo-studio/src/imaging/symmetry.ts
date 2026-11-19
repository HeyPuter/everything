// Paint symmetry: every brush dab is repeated through a set of mirror and
// rotation transforms about a center, so one stroke paints a symmetric
// pattern. Transforms are plain numbers so stroke options stay serializable.

export type SymmetryKind =
  'off' | 'vertical' | 'horizontal' | 'dual' | 'diagonal' | 'radial' | 'mandala';
export const SYMMETRY_KINDS: [SymmetryKind, string][] = [
  ['off', 'Off'],
  ['vertical', 'Vertical'],
  ['horizontal', 'Horizontal'],
  ['dual', 'Dual Axis'],
  ['diagonal', 'Diagonal'],
  ['radial', 'Radial'],
  ['mandala', 'Mandala'],
];
/** x' = a·x + c·y + e, y' = b·x + d·y + f (canvas coordinates, y down). */
export type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];

export const isSymmetryKind = (v: unknown): v is SymmetryKind =>
  SYMMETRY_KINDS.some(([k]) => k === v);
export const usesSegments = (kind: SymmetryKind) => kind === 'radial' || kind === 'mandala';
export const clampSegments = (n: unknown) => Math.max(2, Math.min(12, Math.round(Number(n) || 6)));

/** Linear part about the origin, then moved to turn about (cx, cy). */
function about(cx: number, cy: number, a: number, b: number, c: number, d: number): Affine {
  return [a, b, c, d, cx - a * cx - c * cy, cy - b * cx - d * cy];
}
const rotation = (cx: number, cy: number, t: number) =>
  about(cx, cy, Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t));
/** Reflection across the line through (cx, cy) at angle t (radians, from the x axis). */
const reflection = (cx: number, cy: number, t: number) =>
  about(cx, cy, Math.cos(2 * t), Math.sin(2 * t), Math.sin(2 * t), -Math.cos(2 * t));

/** All placements of a dab, the original (identity) first. */
export function symmetryTransforms(
  kind: SymmetryKind,
  segments: number,
  cx: number,
  cy: number,
): Affine[] {
  const id: Affine = [1, 0, 0, 1, 0, 0];
  const n = clampSegments(segments);
  switch (kind) {
    case 'vertical':
      return [id, reflection(cx, cy, Math.PI / 2)];
    case 'horizontal':
      return [id, reflection(cx, cy, 0)];
    case 'dual':
      return [
        id,
        reflection(cx, cy, Math.PI / 2),
        reflection(cx, cy, 0),
        rotation(cx, cy, Math.PI),
      ];
    case 'diagonal':
      return [id, reflection(cx, cy, Math.PI / 4)];
    case 'radial':
      return [
        id,
        ...Array.from({ length: n - 1 }, (_, i) => rotation(cx, cy, ((i + 1) * 2 * Math.PI) / n)),
      ];
    case 'mandala': {
      const out: Affine[] = [id];
      for (let i = 1; i < n; i++) out.push(rotation(cx, cy, (i * 2 * Math.PI) / n));
      for (let i = 0; i < n; i++) out.push(reflection(cx, cy, (i * Math.PI) / n));
      return out;
    }
    default:
      return [id];
  }
}

/** A dab placed through a transform: its center and tip angle (degrees; the
 * tip's long axis points along (cos, sin) in canvas coordinates, y down). */
export function transformDab(
  t: Affine,
  x: number,
  y: number,
  angle: number,
): [number, number, number] {
  const [a, b, c, d, e, f] = t;
  const r = (angle * Math.PI) / 180;
  const vx = Math.cos(r),
    vy = Math.sin(r);
  const wx = a * vx + c * vy,
    wy = b * vx + d * vy;
  return [a * x + c * y + e, b * x + d * y + f, (Math.atan2(wy, wx) * 180) / Math.PI];
}

/** Axis lines to draw over the canvas, as [x1, y1, x2, y2] reaching `radius` from the center. */
export function symmetryAxes(
  kind: SymmetryKind,
  segments: number,
  cx: number,
  cy: number,
  radius: number,
): [number, number, number, number][] {
  const line = (t: number, both = true): [number, number, number, number] => [
    both ? cx - Math.cos(t) * radius : cx,
    both ? cy - Math.sin(t) * radius : cy,
    cx + Math.cos(t) * radius,
    cy + Math.sin(t) * radius,
  ];
  const n = clampSegments(segments);
  switch (kind) {
    case 'vertical':
      return [line(Math.PI / 2)];
    case 'horizontal':
      return [line(0)];
    case 'dual':
      return [line(Math.PI / 2), line(0)];
    case 'diagonal':
      return [line(Math.PI / 4)];
    case 'radial':
    case 'mandala':
      return Array.from({ length: n }, (_, i) => line(-Math.PI / 2 + (i * 2 * Math.PI) / n, false));
    default:
      return [];
  }
}
