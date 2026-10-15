// Pure math for the interactive transform tools (no app state): proportional falloff, shear,
// bend, warp, to-sphere, seeded randomness and numeric input parsing with units.
import { Matrix3, Matrix4, Vector3 } from 'three';
import { parseExpression, evalExpression } from '../anim/drivers';

export type Falloff = 'SMOOTH' | 'SPHERE' | 'ROOT' | 'INVERSE_SQUARE' | 'SHARP' | 'LINEAR' | 'CONSTANT' | 'RANDOM';

/** Proportional influence for a normalized distance `t` (0 at the selection, 1 at the radius). */
export function falloffWeight(type: Falloff | string, t: number, rand: () => number = Math.random): number {
  if (t >= 1) return 0;
  const x = Math.max(0, Math.min(1, 1 - t));
  switch (type) {
    case 'SPHERE':
      return Math.sqrt(1 - (1 - x) * (1 - x));
    case 'ROOT':
      return Math.sqrt(x);
    case 'INVERSE_SQUARE':
      return x * (2 - x);
    case 'SHARP':
      return x * x;
    case 'LINEAR':
      return x;
    case 'CONSTANT':
      return 1;
    case 'RANDOM':
      return x * rand();
    default:
      return x * x * (3 - 2 * x);
  }
}

/** Column `i` of a basis matrix as a unit vector. */
export function basisAxis(b: Matrix3, i: number): Vector3 {
  const e = b.elements;
  return new Vector3(e[i * 3], e[i * 3 + 1], e[i * 3 + 2]).normalize();
}

/** Matrix that applies `m` around `center`. */
export function around(center: Vector3, m: Matrix4): Matrix4 {
  return new Matrix4().makeTranslation(center.x, center.y, center.z).multiply(m).multiply(new Matrix4().makeTranslation(-center.x, -center.y, -center.z));
}

/**
 * Shear: points are displaced along `along` by tan(angle) times their offset from `center`
 * measured along `measure`.
 */
export function shearMatrix(center: Vector3, along: Vector3, measure: Vector3, angle: number): Matrix4 {
  const k = Math.tan(Math.max(-1.55, Math.min(1.55, angle)));
  const a = along,
    m = measure;
  const s = new Matrix4().set(
    1 + k * a.x * m.x, k * a.x * m.y, k * a.x * m.z, 0,
    k * a.y * m.x, 1 + k * a.y * m.y, k * a.y * m.z, 0,
    k * a.z * m.x, k * a.z * m.y, 1 + k * a.z * m.z, 0,
    0, 0, 0, 1,
  );
  return around(center, s);
}

export interface BendFrame {
  /** start of the bent region (usually the 3D cursor) */
  origin: Vector3;
  /** unit direction along which the bend progresses */
  dir: Vector3;
  /** unit direction (perpendicular to dir) towards the centre of curvature */
  side: Vector3;
  /** length of the bent region; points further along keep the full rotation */
  length: number;
}

/**
 * Bend: the region between `origin` and `origin + dir * length` is rolled onto an arc that turns
 * by `angle` in total. Points before the origin are unchanged, points past the end follow the
 * tangent of the arc rigidly. Returns the rigid matrix that moves a point at `p` (and the frame
 * around it) to its bent position.
 */
export function bendMatrix(f: BendFrame, angle: number, p: Vector3): Matrix4 {
  if (Math.abs(angle) < 1e-7 || f.length < 1e-9) return new Matrix4();
  const s = p.clone().sub(f.origin).dot(f.dir);
  if (s <= 0) return new Matrix4();
  const R = f.length / angle;
  const centre = f.origin.clone().addScaledVector(f.side, R);
  const axis = new Vector3().crossVectors(f.dir, f.side).normalize();
  const t = Math.min(s, f.length);
  const phi = (angle * t) / f.length;
  // slide back to the start of the arc, then roll around the centre of curvature
  const back = new Matrix4().makeTranslation(-f.dir.x * t, -f.dir.y * t, -f.dir.z * t);
  // rotation sense: positive angles curl the progress direction towards `side`
  const rot = around(centre, new Matrix4().makeRotationAxis(axis, phi));
  return rot.multiply(back);
}

/**
 * Warp: positions are mapped around `center` so that their coordinate along the view's right axis
 * (between `min` and `max`) becomes an angle (offset .. offset + warpAngle) about the view axis.
 * `view` columns are right, up and towards-viewer.
 */
export function warpPoint(p: Vector3, center: Vector3, view: Matrix3, warpAngle: number, offsetAngle: number, min: number, max: number): Vector3 {
  const right = basisAxis(view, 0),
    up = basisAxis(view, 1),
    back = basisAxis(view, 2);
  const d = p.clone().sub(center);
  const x = d.dot(right),
    y = d.dot(up),
    z = d.dot(back);
  const span = Math.abs(max - min) < 1e-9 ? 1 : max - min;
  const a = offsetAngle + (warpAngle * (x - min)) / span;
  // `y` becomes the radius; angle 0 points along `up`, increasing towards `right`
  return center.clone().addScaledVector(up, Math.cos(a) * y).addScaledVector(right, Math.sin(a) * y).addScaledVector(back, z);
}

/** Move `p` towards the sphere of `radius` around `center` by `factor` (0..1). */
export function toSpherePoint(p: Vector3, center: Vector3, radius: number, factor: number): Vector3 {
  const d = p.clone().sub(center);
  const len = d.length();
  if (len < 1e-9) return p.clone();
  return p.clone().addScaledVector(d, ((radius - len) / len) * factor);
}

/** Small deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = (seed | 0) + 0x6d2b79f5 * 7919;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random displacement for Randomize Vertices: a random direction scaled by `offset`, plus a
 * uniform per-point jitter (`uniform`, fraction of the offset) and a push along the normal.
 */
export function randomOffset(rand: () => number, offset: number, uniform: number, normalAmount: number, normal: Vector3 | null): Vector3 {
  // uniformly distributed direction
  const z = rand() * 2 - 1;
  const t = rand() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const dir = new Vector3(r * Math.cos(t), r * Math.sin(t), z);
  const len = offset * (1 - uniform * rand());
  const out = dir.multiplyScalar(len);
  if (normal && normalAmount) out.addScaledVector(normal, offset * normalAmount * (rand() * 2 - 1));
  return out;
}

const LENGTH_UNITS: [string, number][] = [
  ['km', 1000],
  ['cm', 0.01],
  ['mm', 0.001],
  ['um', 1e-6],
  ['µm', 1e-6],
  ['mi', 1609.344],
  ['ft', 0.3048],
  ['in', 0.0254],
  ["'", 0.3048],
  ['"', 0.0254],
  ['m', 1],
];

/**
 * Evaluate typed numeric input. Accepts arithmetic expressions (`2*3`, `pi/2`), length units for
 * distances (`5cm`, `2ft`) and `°`/`d`/`r` suffixes for angles (`kind === 'angle'` returns degrees).
 * Returns null when the text is empty or cannot be evaluated.
 */
export function evalNumeric(text: string, kind: 'distance' | 'angle' | 'none' = 'none'): number | null {
  let s = text.trim();
  if (!s || s === '-') return s === '-' ? -1 : null;
  // a trailing operator while typing is ignored
  s = s.replace(/[-+*/(]+$/, '');
  if (!s) return null;
  const num = '(\\d+\\.?\\d*|\\.\\d+)';
  if (kind === 'angle') {
    s = s.replace(new RegExp(`${num}\\s*(°|deg|d)(?![a-z])`, 'g'), '($1)');
    s = s.replace(new RegExp(`${num}\\s*r(?![a-z])`, 'g'), '($1*180/pi)');
  } else if (kind === 'distance') {
    for (const [u, f] of LENGTH_UNITS) {
      const esc = u.replace(/[.*+?^${}()|[\]\\"']/g, '\\$&');
      s = s.replace(new RegExp(`${num}\\s*${esc}(?![a-z])`, 'g'), `($1*${f})`);
    }
  }
  // balance parentheses the user has not closed yet
  const open = (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length;
  if (open > 0) s += ')'.repeat(open);
  try {
    const v = evalExpression(parseExpression(s), {});
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
