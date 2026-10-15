// Independent implementation of a vector-math library whose public names follow the
// documented `mathutils` module (Vector, Matrix, Euler, Quaternion, Color and the
// geometry / kdtree / bvhtree / noise submodules) so scripts written against that API run
// here. JavaScript has no operator overloading, so the arithmetic operators are exposed as
// methods (`add`, `sub`, `mul`, `div`, `matmul`, `neg`) on every type where they make sense.
// Matrices are row-major (m[row][col]) and act on column vectors.
import { geometry } from './mathutils_geometry';
import { kdtree } from './mathutils_kdtree';
import { bvhtree } from './mathutils_bvhtree';
import { noise } from './mathutils_noise';

export type VecLike = ArrayLike<number> | VecBase;
export type EulerOrder = 'XYZ' | 'XZY' | 'YXZ' | 'YZX' | 'ZXY' | 'ZYX';
const ORDERS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];

const EPS = 1e-12;

/** Errors carry a Python exception name prefix so the Python bridge can re-raise them. */
export function mathError(type: 'TypeError' | 'ValueError' | 'RuntimeError' | 'IndexError' | 'AttributeError', msg: string) {
  const e = new Error(`${type}: ${msg}`);
  e.name = type;
  return e;
}

export function toArray(v: VecLike | Iterable<number>): number[] {
  if (v instanceof VecBase) return v.toArray();
  if (v instanceof Matrix) throw mathError('TypeError', 'expected a vector, got a Matrix');
  if (v === null || v === undefined) throw mathError('TypeError', 'expected a sequence of numbers, got None');
  if (typeof v === 'number') throw mathError('TypeError', 'expected a sequence of numbers, got a number');
  if (typeof (v as ArrayLike<number>).length === 'number') return Array.from(v as ArrayLike<number>, Number);
  return Array.from(v as Iterable<number>, Number);
}

const fmt = (n: number) => {
  const s = Number(n.toFixed(4)).toString();
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};
const clamp1 = (x: number) => Math.max(-1, Math.min(1, x));

/** Shared component storage for Vector / Euler / Color / Quaternion. */
export class VecBase {
  [index: number]: number;
  /** Marks the object kind for the scripting bridge. */
  readonly __kind: string = 'vector';
  protected _n: number;

  constructor(values: VecLike | Iterable<number> = [0, 0, 0]) {
    const a = toArray(values);
    this._n = a.length;
    for (let i = 0; i < a.length; i++) this[i] = a[i];
  }
  get size() {
    return this._n;
  }
  /** Component accessors are overridable so bound vectors can read through to document data. */
  protected getc(i: number): number {
    return this[i];
  }
  protected setc(i: number, v: number) {
    this[i] = v;
  }
  get(i: number) {
    if (i < 0) i += this._n;
    if (i < 0 || i >= this._n) throw mathError('IndexError', 'vector index out of range');
    return this.getc(i);
  }
  set(i: number, v: number) {
    if (i < 0) i += this._n;
    if (i < 0 || i >= this._n) throw mathError('IndexError', 'vector index out of range');
    this.setc(i, Number(v));
  }
  toArray(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this._n; i++) out.push(this.getc(i));
    return out;
  }
  to_tuple(precision?: number): number[] {
    return precision === undefined || precision < 0 ? this.toArray() : this.toArray().map((v) => Number(v.toFixed(precision)));
  }
  to_list(): number[] {
    return this.toArray();
  }
  [Symbol.iterator]() {
    return this.toArray()[Symbol.iterator]();
  }
  /** Assign all components (in place). */
  assign(v: VecLike | VecBase) {
    const a = v instanceof VecBase ? v.toArray() : toArray(v);
    for (let i = 0; i < this._n; i++) this.setc(i, a[i] ?? 0);
    return this;
  }
  get length_squared() {
    return this.toArray().reduce((s, v) => s + v * v, 0);
  }
  get magnitude() {
    return Math.sqrt(this.length_squared);
  }
  /** Bound vectors (live views onto document data) report true. */
  get is_wrapped() {
    return !!(this as unknown as { __bound?: boolean }).__bound;
  }
  get is_frozen() {
    return false;
  }
  freeze() {
    return this;
  }
  equals(o: VecLike | VecBase, eps = 1e-6) {
    const b = o instanceof VecBase ? o.toArray() : toArray(o);
    return b.length === this._n && this.toArray().every((v, i) => Math.abs(v - b[i]) <= eps);
  }
  toJSON() {
    return this.toArray();
  }
}

// ---------------------------------------------------------------------------
// Vector

const AXIS_VEC: Record<string, number[]> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1], '-X': [-1, 0, 0], '-Y': [0, -1, 0], '-Z': [0, 0, -1] };

/** N-dimensional vector (2–4 components in practice). Components are numeric own properties. */
export class Vector extends VecBase {
  constructor(values: VecLike | Iterable<number> = [0, 0, 0]) {
    super(values);
  }

  static Fill(size: number, fill = 0) {
    return new Vector(Array.from({ length: size }, () => fill));
  }
  static Range(start: number, stop?: number, step = 1) {
    if (stop === undefined) [start, stop] = [0, start];
    if (!step) throw mathError('ValueError', 'Vector.Range(): step must not be zero');
    const out: number[] = [];
    for (let v = start; step > 0 ? v < stop : v > stop; v += step) out.push(v);
    return new Vector(out);
  }
  static Linspace(start: number, stop: number, size: number) {
    if (size < 1) throw mathError('ValueError', 'Vector.Linspace(): size must be at least 1');
    if (size === 1) return new Vector([start]);
    return new Vector(Array.from({ length: size }, (_, i) => start + ((stop - start) * i) / (size - 1)));
  }
  static Repeat(v: VecLike, size: number) {
    const a = toArray(v);
    return new Vector(Array.from({ length: size }, (_, i) => a[i % a.length]));
  }

  /** Euclidean length; the component count is `size`. */
  get length() {
    return this.magnitude;
  }
  set length(l: number) {
    const m = this.magnitude;
    if (m > EPS) this.assign(this.mul(l / m));
  }
  get x() {
    return this.get(0);
  }
  set x(v: number) {
    this.set(0, v);
  }
  get y() {
    return this.get(1);
  }
  set y(v: number) {
    this.set(1, v);
  }
  get z() {
    return this.get(2);
  }
  set z(v: number) {
    this.set(2, v);
  }
  get w() {
    return this.get(3);
  }
  set w(v: number) {
    this.set(3, v);
  }
  get xy(): Vector {
    return new Vector([this.x, this.y]);
  }
  set xy(v: VecLike) {
    const a = toArray(v);
    this.x = a[0];
    this.y = a[1];
  }
  get xyz(): Vector {
    return new Vector([this.x, this.y, this.z]);
  }
  set xyz(v: VecLike) {
    const a = toArray(v);
    this.x = a[0];
    this.y = a[1];
    this.z = a[2];
  }

  copy() {
    return new Vector(this.toArray());
  }
  zero() {
    for (let i = 0; i < this._n; i++) this.setc(i, 0);
    return this;
  }

  add(o: VecLike) {
    const a = this.toArray(),
      b = toArray(o);
    if (b.length !== a.length) throw mathError('ValueError', `Vector addition: vectors must have the same dimensions (${a.length} and ${b.length})`);
    return new Vector(a.map((v, i) => v + b[i]));
  }
  sub(o: VecLike) {
    const a = this.toArray(),
      b = toArray(o);
    if (b.length !== a.length) throw mathError('ValueError', `Vector subtraction: vectors must have the same dimensions (${a.length} and ${b.length})`);
    return new Vector(a.map((v, i) => v - b[i]));
  }
  /** Scalar multiply, element-wise with a vector, or M-style transform when given a Matrix (v @ M). */
  mul(o: number | VecLike) {
    if (typeof o === 'number') return new Vector(this.toArray().map((v) => v * o));
    const b = toArray(o);
    return new Vector(this.toArray().map((v, i) => v * (b[i] ?? 0)));
  }
  div(s: number | VecLike) {
    if (typeof s !== 'number') {
      const b = toArray(s);
      return new Vector(this.toArray().map((v, i) => v / b[i]));
    }
    if (s === 0) throw mathError('ValueError', 'Vector division: divide by zero');
    return new Vector(this.toArray().map((v) => v / s));
  }
  /** v @ M (row vector times matrix) or v @ w (dot product). */
  matmul(o: Matrix | VecLike): Vector | number {
    if (o instanceof Matrix) {
      let v = this.toArray();
      const n = o.size,
        cols = o.rows[0].length;
      if (v.length === 3 && n === 4) v = [...v, 1];
      if (v.length !== n) throw mathError('ValueError', `vector @ matrix: vector size ${v.length} does not match matrix rows ${n}`);
      const out = Array.from({ length: cols }, (_, j) => v.reduce((s, x, i) => s + x * o.rows[i][j], 0));
      return new Vector(this.size === 3 && cols === 4 ? out.slice(0, 3) : out);
    }
    return this.dot(o);
  }
  negate() {
    for (let i = 0; i < this._n; i++) this.setc(i, -this.getc(i));
    return this;
  }
  neg() {
    return new Vector(this.toArray().map((v) => -v));
  }
  abs() {
    return new Vector(this.toArray().map((v) => Math.abs(v)));
  }
  dot(o: VecLike) {
    const a = this.toArray(),
      b = toArray(o);
    return a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
  }
  cross(o: VecLike): Vector | number {
    const [ax, ay, az] = this.toArray(),
      [bx, by, bz] = toArray(o);
    if (this._n === 2) return ax * by - ay * bx;
    return new Vector([ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]);
  }
  normalized() {
    const l = this.magnitude;
    return l < EPS ? new Vector(this.toArray().map(() => 0)) : this.div(l);
  }
  normalize() {
    return this.assign(this.normalized());
  }
  lerp(o: VecLike, t: number) {
    const b = toArray(o);
    return new Vector(this.toArray().map((v, i) => v + ((b[i] ?? 0) - v) * t));
  }
  /** Spherical interpolation of the directions (the result is unit length). */
  slerp(o: VecLike, t: number, fallback?: unknown) {
    const a = this.normalized(),
      b = new Vector(toArray(o)).normalized();
    const la = this.magnitude,
      lb = b.magnitude;
    const d = clamp1(a.dot(b));
    if (la < EPS || lb < EPS || d < -1 + 1e-6) {
      if (fallback !== undefined) return fallback;
      throw mathError('ValueError', 'Vector.slerp(): zero length vectors or opposite vectors have no unique interpolation');
    }
    if (d > 1 - 1e-9) return a.lerp(b, t).normalized();
    const th = Math.acos(d),
      s = Math.sin(th);
    return a.mul(Math.sin((1 - t) * th) / s).add(b.mul(Math.sin(t * th) / s));
  }
  angle(o: VecLike, fallback?: unknown) {
    const b = new Vector(toArray(o));
    const l = this.magnitude * b.magnitude;
    if (l < EPS) {
      if (fallback !== undefined) return fallback;
      throw mathError('ValueError', 'Vector.angle(other): zero length vectors have no valid angle');
    }
    return Math.acos(clamp1(this.dot(b) / l));
  }
  /** Signed angle between two 2D vectors (negative when `other` is counter-clockwise). */
  angle_signed(o: VecLike, fallback?: unknown) {
    const b = toArray(o);
    if (this._n !== 2 || b.length !== 2) throw mathError('ValueError', 'Vector.angle_signed(other): only 2D vectors are supported');
    if (this.magnitude < EPS || Math.hypot(b[0], b[1]) < EPS) {
      if (fallback !== undefined) return fallback;
      throw mathError('ValueError', 'Vector.angle_signed(other): zero length vectors have no valid angle');
    }
    const [ax, ay] = this.toArray();
    return -Math.atan2(ax * b[1] - ay * b[0], ax * b[0] + ay * b[1]);
  }
  project(o: VecLike) {
    const b = new Vector(toArray(o));
    const d = b.length_squared;
    return d < EPS ? b.mul(0) : b.mul(this.dot(b) / d);
  }
  reflect(mirror: VecLike) {
    const n = new Vector(toArray(mirror)).normalized();
    return this.sub(n.mul(2 * this.dot(n)));
  }
  /** A vector perpendicular to this one (not normalized). */
  orthogonal() {
    const a = this.toArray();
    if (a.length === 2) return new Vector([-a[1], a[0]]);
    if (a.length !== 3) throw mathError('ValueError', 'Vector.orthogonal(): only 2D and 3D vectors are supported');
    const ab = a.map(Math.abs);
    const k = ab[0] >= ab[1] && ab[0] >= ab[2] ? 0 : ab[1] >= ab[2] ? 1 : 2;
    const i = (k + 1) % 3,
      j = (k + 2) % 3;
    const out = [0, 0, 0];
    out[k] = -a[i] - a[j];
    out[i] = a[k];
    out[j] = a[k];
    return new Vector(out);
  }
  /** Shortest-arc rotation turning this direction into `other`. */
  rotation_difference(o: VecLike): Quaternion {
    const a = new Vector(this.to_3d()).normalized(),
      b = new Vector(toArray(o).slice(0, 3)).normalized();
    const axis = a.cross(b) as Vector;
    const d = clamp1(a.dot(b));
    if (axis.magnitude < 1e-9) {
      if (d > 0) return new Quaternion();
      return new Quaternion(a.orthogonal().normalized(), Math.PI);
    }
    return new Quaternion(axis.normalized(), Math.acos(d));
  }
  /**
   * Rotation pointing the local `track` axis along this vector, with the local `up` axis
   * turned as close as possible to world +Z.
   */
  to_track_quat(track = 'Z', up = 'Y'): Quaternion {
    const t = AXIS_VEC[track],
      u = AXIS_VEC[up];
    if (!t) throw mathError('ValueError', `Vector.to_track_quat(): invalid track axis '${track}'`);
    if (!u || up.startsWith('-')) throw mathError('ValueError', `Vector.to_track_quat(): invalid up axis '${up}'`);
    if (track.replace('-', '') === up) throw mathError('ValueError', 'Vector.to_track_quat(): track and up axis cannot be the same');
    const v = new Vector(this.to_3d());
    const len = v.magnitude;
    if (len < 1e-6) return new Quaternion();
    const d = v.div(len);
    // target for the up axis: world Z made perpendicular to the track direction
    let target = new Vector([0, 0, 1]).sub(d.mul(d.z));
    if (target.magnitude < 1e-6) {
      if (t[2] === 0) target = new Vector(t).mul(-Math.sign(d.z));
      // tracking along world Z: same direction keeps up opposite / along itself, opposite flips to -Y
      else if (t[2] * d.z > 0) target = new Vector(u).mul(d.z > 0 ? -1 : 1);
      else target = new Vector([0, -1, 0]);
    }
    target = target.normalized();
    const third = d.cross(target) as Vector;
    const lt = new Vector(t),
      lu = new Vector(u),
      lw = lt.cross(lu) as Vector;
    // R maps lt -> d, lu -> target, lw -> third
    const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => d.get(i) * lt.get(j) + target.get(i) * lu.get(j) + third.get(i) * lw.get(j)));
    return new Matrix(R).to_quaternion();
  }
  /** Rotate in place by an Euler, Quaternion or Matrix. */
  rotate(rot: Euler | Quaternion | Matrix) {
    const m = rot instanceof Matrix ? rot.to_3x3() : rot.to_matrix();
    const r = m.matmul(this.to_3d()) as Vector;
    for (let i = 0; i < Math.min(3, this._n); i++) this.setc(i, r.get(i));
    return this;
  }
  to_2d() {
    const a = this.toArray();
    return new Vector([a[0] ?? 0, a[1] ?? 0]);
  }
  to_3d() {
    const a = this.toArray();
    return new Vector([a[0] ?? 0, a[1] ?? 0, a[2] ?? 0]);
  }
  to_4d() {
    const a = this.toArray();
    return new Vector([a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 1]);
  }
  resized(n: number) {
    const a = this.toArray();
    return new Vector(Array.from({ length: n }, (_, i) => a[i] ?? 0));
  }
  /** Change the component count in place (not possible for vectors bound to document data). */
  resize(n: number) {
    if (this.is_wrapped) throw mathError('TypeError', 'Vector.resize(): cannot resize a vector that wraps document data');
    const a = this.toArray();
    for (let i = n; i < this._n; i++) delete this[i];
    for (let i = 0; i < n; i++) this[i] = a[i] ?? 0;
    this._n = n;
    return this;
  }
  resize_2d() {
    return this.resize(2);
  }
  resize_3d() {
    return this.resize(3);
  }
  resize_4d() {
    const w = this._n > 3 ? this.get(3) : 1;
    this.resize(4);
    this[3] = w;
    return this;
  }
  toString() {
    return `<Vector (${this.toArray().map((v) => v.toFixed(4)).join(', ')})>`;
  }
  repr() {
    return `Vector((${this.toArray().map(fmt).join(', ')}))`;
  }
}

// Swizzle accessors (v.zyx, v.xxy, v.wzyx, ...) for every 2-4 letter combination.
{
  const letters = 'xyzw';
  const define = (name: string) => {
    if (Object.getOwnPropertyDescriptor(Vector.prototype, name)) return;
    const idx = [...name].map((c) => letters.indexOf(c));
    const unique = new Set(idx).size === idx.length;
    Object.defineProperty(Vector.prototype, name, {
      get(this: Vector) {
        return new Vector(idx.map((i) => this.get(i)));
      },
      set: unique
        ? function (this: Vector, v: VecLike) {
            const a = toArray(v);
            if (a.length !== idx.length) throw mathError('ValueError', `swizzle assignment: expected ${idx.length} values`);
            idx.forEach((i, k) => this.set(i, a[k]));
          }
        : undefined,
      configurable: true,
    });
  };
  const rec = (prefix: string) => {
    if (prefix.length >= 2) define(prefix);
    if (prefix.length < 4) for (const c of letters) rec(prefix + c);
  };
  rec('');
}

// ---------------------------------------------------------------------------
// Color

const SRGB_TO_LINEAR = (c: number) => (c < 0.04045 ? (c < 0 ? 0 : c / 12.92) : Math.pow((c + 0.055) / 1.055, 2.4));
const LINEAR_TO_SRGB = (c: number) => (c < 0.0031308 ? (c < 0 ? 0 : c * 12.92) : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
// linear Rec.709 primaries (the scene linear space) to other spaces; rows map to output channels
const TO_XYZ = [
  [0.412391, 0.357585, 0.180481],
  [0.212639, 0.715169, 0.072193],
  [0.019331, 0.119195, 0.950532],
];
const TO_ACES = [
  [0.439633, 0.382989, 0.177378],
  [0.089776, 0.81344, 0.096784],
  [0.017541, 0.111547, 0.870912],
];
const TO_ACESCG = [
  [0.613097, 0.339522, 0.047379],
  [0.070194, 0.916355, 0.013453],
  [0.020616, 0.10957, 0.869815],
];
const TO_REC2020 = [
  [0.627404, 0.329284, 0.043314],
  [0.069097, 0.919541, 0.011363],
  [0.016391, 0.088013, 0.895595],
];
// inverses are computed on first use (Matrix is defined further down this module)
const inverses = new Map<number[][], number[][]>();
const inv3 = (m: number[][]) => {
  let r = inverses.get(m);
  if (!r) inverses.set(m, (r = new Matrix(m).inverted().rows));
  return r;
};

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, mx > 0 ? d / mx : 0, mx];
}
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = (((h % 1) + 1) % 1) * 6;
  const i = Math.floor(h) % 6,
    f = h - Math.floor(h);
  const p = v * (1 - s),
    q = v * (1 - s * f),
    t = v * (1 - s * (1 - f));
  return ([[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]] as [number, number, number][])[i];
}

export class Color extends Vector {
  override readonly __kind: string = 'color';
  constructor(rgb: VecLike | Iterable<number> = [0, 0, 0]) {
    super(rgb);
  }
  get r() {
    return this.get(0);
  }
  set r(v: number) {
    this.set(0, v);
  }
  get g() {
    return this.get(1);
  }
  set g(v: number) {
    this.set(1, v);
  }
  get b() {
    return this.get(2);
  }
  set b(v: number) {
    this.set(2, v);
  }
  get a() {
    return this._n > 3 ? this.get(3) : 1;
  }
  set a(v: number) {
    if (this._n > 3) this.set(3, v);
  }
  get hsv(): number[] {
    return rgbToHsv(this.r, this.g, this.b);
  }
  set hsv(hsv: VecLike) {
    const [h, s, v] = toArray(hsv);
    const [r, g, b] = hsvToRgb(h, s, v);
    this.r = r;
    this.g = g;
    this.b = b;
  }
  get h() {
    return this.hsv[0];
  }
  set h(x: number) {
    const [, s, v] = this.hsv;
    this.hsv = [x, s, v];
  }
  get s() {
    return this.hsv[1];
  }
  set s(x: number) {
    const [h, , v] = this.hsv;
    this.hsv = [h, x, v];
  }
  get v() {
    return this.hsv[2];
  }
  set v(x: number) {
    const [h, s] = this.hsv;
    this.hsv = [h, s, x];
  }
  private mapped(f: (c: number) => number) {
    const a = this.toArray();
    return new Color(a.map((c, i) => (i < 3 ? f(c) : c)));
  }
  private transformed(m: number[][]) {
    const a = this.toArray();
    const out = [0, 1, 2].map((i) => m[i][0] * a[0] + m[i][1] * a[1] + m[i][2] * a[2]);
    return new Color(a.length > 3 ? [...out, ...a.slice(3)] : out);
  }
  from_scene_linear_to_srgb() {
    return this.mapped(LINEAR_TO_SRGB);
  }
  from_srgb_to_scene_linear() {
    return this.mapped(SRGB_TO_LINEAR);
  }
  from_scene_linear_to_xyz_d65() {
    return this.transformed(TO_XYZ);
  }
  from_xyz_d65_to_scene_linear() {
    return this.transformed(inv3(TO_XYZ));
  }
  from_scene_linear_to_aces() {
    return this.transformed(TO_ACES);
  }
  from_aces_to_scene_linear() {
    return this.transformed(inv3(TO_ACES));
  }
  from_scene_linear_to_acescg() {
    return this.transformed(TO_ACESCG);
  }
  from_acescg_to_scene_linear() {
    return this.transformed(inv3(TO_ACESCG));
  }
  from_scene_linear_to_rec2020_linear() {
    return this.transformed(TO_REC2020);
  }
  from_rec2020_linear_to_scene_linear() {
    return this.transformed(inv3(TO_REC2020));
  }
  from_scene_linear_to_rec709_linear() {
    return this.copy();
  }
  from_rec709_linear_to_scene_linear() {
    return this.copy();
  }
  override add(o: VecLike) {
    return new Color(super.add(o));
  }
  override sub(o: VecLike) {
    return new Color(super.sub(o));
  }
  override mul(o: number | VecLike) {
    return new Color(super.mul(o));
  }
  override div(o: number | VecLike) {
    return new Color(super.div(o));
  }
  override neg() {
    return new Color(super.neg());
  }
  override copy() {
    return new Color(this.toArray());
  }
  override toString() {
    return `<Color (r=${this.r.toFixed(4)}, g=${this.g.toFixed(4)}, b=${this.b.toFixed(4)})>`;
  }
  override repr() {
    return `Color((${this.toArray().map(fmt).join(', ')}))`;
  }
}

// ---------------------------------------------------------------------------
// Euler

function axisMatrix(axis: string, angle: number): number[][] {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  if (axis === 'X') return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === 'Y') return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  if (axis === 'Z') return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
  throw mathError('ValueError', `expected axis 'X', 'Y' or 'Z', not '${axis}'`);
}

function mul3(a: number[][], b: number[][]) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return out;
}

function checkOrder(order: string): EulerOrder {
  if (!ORDERS.includes(order)) throw mathError('ValueError', `Euler(): invalid order '${order}', expected one of ${ORDERS.join(', ')}`);
  return order as EulerOrder;
}

export class Euler extends Vector {
  override readonly __kind: string = 'euler';
  order: EulerOrder;
  constructor(angles: VecLike | Iterable<number> = [0, 0, 0], order: EulerOrder = 'XYZ') {
    super(angles);
    this.order = checkOrder(order);
  }
  /** Rotation matrix: rotations are applied in the listed order (X first for 'XYZ'). */
  to_matrix(): Matrix {
    let m = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const idx: Record<string, number> = { X: 0, Y: 1, Z: 2 };
    for (const ax of this.order) m = mul3(axisMatrix(ax, this.get(idx[ax])), m);
    return new Matrix(m);
  }
  to_quaternion(): Quaternion {
    return this.to_matrix().to_quaternion();
  }
  override copy() {
    return new Euler(this.toArray(), this.order);
  }
  /** Shift each angle by whole turns so it lies within half a turn of the reference. */
  make_compatible(ref: VecLike) {
    const r = toArray(ref);
    for (let i = 0; i < 3; i++) {
      let v = this.get(i);
      const d = v - r[i];
      if (Math.abs(d) > Math.PI) v -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      this.set(i, v);
    }
    return this;
  }
  /** Rotate around one of the rotation's own (local) axes, in place. */
  rotate_axis(axis: 'X' | 'Y' | 'Z', angle: number) {
    const m = this.to_matrix().matmul(new Matrix(axisMatrix(axis, angle))) as Matrix;
    this.assign(m.to_euler(this.order, this));
    return this;
  }
  /** Apply another rotation (Euler, Quaternion or Matrix) after this one (in place). */
  override rotate(rot: Euler | Quaternion | Matrix) {
    const r = rot instanceof Matrix ? rot.to_3x3() : rot.to_matrix();
    this.assign((r.matmul(this.to_matrix()) as Matrix).to_euler(this.order, this));
    return this;
  }
  override toString() {
    return `<Euler (x=${this.x.toFixed(4)}, y=${this.y.toFixed(4)}, z=${this.z.toFixed(4)}), order='${this.order}'>`;
  }
  override repr() {
    return `Euler((${this.toArray().map(fmt).join(', ')}), '${this.order}')`;
  }
}

// ---------------------------------------------------------------------------
// Quaternion (w, x, y, z)

function qmul(a: number[], b: number[]) {
  const [aw, ax, ay, az] = a,
    [bw, bx, by, bz] = b;
  return [aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw];
}

export class Quaternion extends VecBase {
  override readonly __kind: string = 'quaternion';
  /** Quaternion([w, x, y, z]), Quaternion(axis, angle) or Quaternion(exponential_map). */
  constructor(values: VecLike | Iterable<number> = [1, 0, 0, 0], angle?: number) {
    if (angle !== undefined && angle !== null) {
      const ax = new Vector(toArray(values as VecLike)).normalized();
      const s = Math.sin(angle / 2);
      super([Math.cos(angle / 2), ax.x * s, ax.y * s, ax.z * s]);
    } else {
      const a = toArray(values as VecLike);
      if (a.length === 3) {
        const th = Math.hypot(a[0], a[1], a[2]);
        if (th < EPS) super([1, 0, 0, 0]);
        else {
          const s = Math.sin(th / 2) / th;
          const q = [Math.cos(th / 2), a[0] * s, a[1] * s, a[2] * s];
          super(q[0] < 0 ? q.map((v) => -v) : q);
        }
      } else if (a.length !== 4) throw mathError('ValueError', 'Quaternion(): expected 4 values (w, x, y, z) or a 3D exponential map');
      else super(a);
    }
  }
  get w() {
    return this.get(0);
  }
  set w(v: number) {
    this.set(0, v);
  }
  get x() {
    return this.get(1);
  }
  set x(v: number) {
    this.set(1, v);
  }
  get y() {
    return this.get(2);
  }
  set y(v: number) {
    this.set(2, v);
  }
  get z() {
    return this.get(3);
  }
  set z(v: number) {
    this.set(3, v);
  }
  get angle() {
    return 2 * Math.acos(clamp1(this.normalized().get(0)));
  }
  set angle(a: number) {
    const len = this.magnitude || 1;
    const axis = this.axis;
    const s = Math.sin(a / 2);
    this.assign([Math.cos(a / 2) * len, axis.x * s * len, axis.y * s * len, axis.z * s * len]);
  }
  get axis(): Vector {
    const n = this.normalized();
    const s = Math.sqrt(Math.max(0, 1 - n.get(0) ** 2));
    if (s < 1e-9) return new Vector([0, 1, 0]);
    return new Vector([n.get(1) / s, n.get(2) / s, n.get(3) / s]);
  }
  set axis(v: VecLike) {
    const len = this.magnitude || 1;
    const a = this.angle;
    const ax = new Vector(toArray(v)).normalized();
    const s = Math.sin(a / 2);
    this.assign([Math.cos(a / 2) * len, ax.x * s * len, ax.y * s * len, ax.z * s * len]);
  }
  get magnitude() {
    return Math.sqrt(this.length_squared);
  }
  copy() {
    return new Quaternion(this.toArray());
  }
  identity() {
    return this.assign([1, 0, 0, 0]);
  }
  zero() {
    return this.assign([0, 0, 0, 0]);
  }
  normalized() {
    const l = this.magnitude;
    return l < EPS ? new Quaternion() : new Quaternion(this.toArray().map((v) => v / l));
  }
  normalize() {
    return this.assign(this.normalized());
  }
  conjugated() {
    return new Quaternion([this.w, -this.x, -this.y, -this.z]);
  }
  conjugate() {
    return this.assign(this.conjugated());
  }
  inverted() {
    const l = this.length_squared;
    if (l < EPS) throw mathError('ValueError', 'Quaternion.inverted(): zero length quaternion has no inverse');
    return new Quaternion([this.w / l, -this.x / l, -this.y / l, -this.z / l]);
  }
  invert() {
    return this.assign(this.inverted());
  }
  negate() {
    return this.assign(this.toArray().map((v) => -v));
  }
  neg() {
    return new Quaternion(this.toArray().map((v) => -v));
  }
  dot(o: VecLike) {
    const b = toArray(o);
    return this.toArray().reduce((s, v, i) => s + v * b[i], 0);
  }
  /** Quaternion product (same as matmul with a quaternion). */
  cross(o: VecLike) {
    return new Quaternion(qmul(this.toArray(), toArray(o)));
  }
  add(o: VecLike) {
    const b = toArray(o);
    return new Quaternion(this.toArray().map((v, i) => v + b[i]));
  }
  sub(o: VecLike) {
    const b = toArray(o);
    return new Quaternion(this.toArray().map((v, i) => v - b[i]));
  }
  /** Scalar multiply, or component-wise with another quaternion. */
  mul(o: number | VecLike) {
    if (typeof o === 'number') return new Quaternion(this.toArray().map((v) => v * o));
    const b = toArray(o);
    return new Quaternion(this.toArray().map((v, i) => v * b[i]));
  }
  div(s: number) {
    if (s === 0) throw mathError('ValueError', 'Quaternion division: divide by zero');
    return new Quaternion(this.toArray().map((v) => v / s));
  }
  /** Hamilton product (q @ r), or rotate a vector (q @ v). */
  matmul(o: Quaternion | VecLike): Quaternion | Vector {
    if (o instanceof Quaternion) return new Quaternion(qmul(this.toArray(), o.toArray()));
    return this.to_matrix().matmul(o) as Vector;
  }
  to_matrix(): Matrix {
    const [w, x, y, z] = this.normalized().toArray();
    return new Matrix([
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]);
  }
  to_euler(order: EulerOrder = 'XYZ', compatible?: VecLike): Euler {
    return this.to_matrix().to_euler(order, compatible);
  }
  to_axis_angle(): [Vector, number] {
    return [this.axis, this.angle];
  }
  /** Rotation axis scaled by the angle. */
  to_exponential_map(): Vector {
    return this.axis.mul(this.angle);
  }
  /** Split into a swing (Quaternion) and a twist angle around the given axis ('X', 'Y' or 'Z'). */
  to_swing_twist(axis: 'X' | 'Y' | 'Z'): [Quaternion, number] {
    const k = { X: 1, Y: 2, Z: 3 }[axis];
    if (!k) throw mathError('ValueError', `Quaternion.to_swing_twist(): invalid axis '${axis}'`);
    const q = this.normalized().toArray();
    const t = [q[0], 0, 0, 0];
    t[k] = q[k];
    let l = Math.hypot(t[0], t[k]);
    if (l < EPS) {
      t[0] = 1;
      t[k] = 0;
      l = 1;
    }
    for (let i = 0; i < 4; i++) t[i] /= l;
    if (t[0] < 0) for (let i = 0; i < 4; i++) t[i] = -t[i];
    const angle = 2 * Math.atan2(t[k], t[0]);
    const swing = qmul(q, [t[0], -t[1], -t[2], -t[3]]);
    return [new Quaternion(swing), angle];
  }
  slerp(o: VecLike, t: number): Quaternion {
    const a = this.normalized().toArray();
    let b = new Quaternion(toArray(o)).normalized().toArray();
    let d = a.reduce((s, v, i) => s + v * b[i], 0);
    if (d < 0) {
      b = b.map((v) => -v);
      d = -d;
    }
    if (d > 0.9995) return new Quaternion(a.map((v, i) => v + (b[i] - v) * t)).normalized();
    const th = Math.acos(d),
      s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s,
      wb = Math.sin(t * th) / s;
    return new Quaternion(a.map((v, i) => v * wa + b[i] * wb));
  }
  /** The rotation that takes this orientation to `other` (this @ diff == other). */
  rotation_difference(o: VecLike) {
    return new Quaternion(qmul(this.inverted().toArray(), toArray(o)));
  }
  /** Apply another rotation after this one (in place). */
  rotate(rot: Euler | Quaternion | Matrix) {
    const q = rot instanceof Quaternion ? rot : rot.to_quaternion();
    const len = this.magnitude;
    const r = new Quaternion(qmul(q.normalized().toArray(), this.normalized().toArray()));
    return this.assign(r.toArray().map((v) => v * len));
  }
  /** Flip the sign if needed so this lies in the same hemisphere as `other`. */
  make_compatible(o: VecLike) {
    if (this.dot(o) < 0) this.negate();
    return this;
  }
  toString() {
    return `<Quaternion (w=${this.w.toFixed(4)}, x=${this.x.toFixed(4)}, y=${this.y.toFixed(4)}, z=${this.z.toFixed(4)})>`;
  }
  repr() {
    return `Quaternion((${this.toArray().map(fmt).join(', ')}))`;
  }
}

// ---------------------------------------------------------------------------
// Matrix (row-major)

/** A live row view: writing `m[0][3] = 1` changes the matrix. */
function rowView(m: Matrix, i: number): Vector {
  const row = () => m.rows[i];
  const v = new Vector(row());
  const inst = v as unknown as Record<string, unknown>;
  inst.getc = (k: number) => row()[k];
  inst.setc = (k: number, x: number) => {
    row()[k] = Number(x);
  };
  for (let k = 0; k < row().length; k++)
    Object.defineProperty(v, k, {
      get: () => row()[k],
      set: (x: number) => {
        row()[k] = Number(x);
      },
      enumerable: true,
      configurable: true,
    });
  return v;
}

export class Matrix {
  [index: number]: Vector;
  readonly __kind = 'matrix';
  rows: number[][];

  constructor(rows?: ArrayLike<ArrayLike<number> | VecLike> | Matrix) {
    if (!rows) this.rows = Matrix.identityRows(4);
    else if (rows instanceof Matrix) this.rows = rows.rows.map((r) => [...r]);
    else this.rows = Array.from(rows as ArrayLike<VecLike>, (r) => toArray(r));
    const n = this.rows.length;
    if (n < 1 || this.rows.some((r) => r.length !== this.rows[0].length)) throw mathError('ValueError', 'Matrix(): expected rows of equal length');
  }

  static identityRows(n: number) {
    return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  }
  static Identity(n = 4) {
    return new Matrix(Matrix.identityRows(n));
  }
  static Translation(v: VecLike) {
    const a = toArray(v);
    const m = Matrix.Identity(4);
    for (let i = 0; i < Math.min(3, a.length); i++) m.rows[i][3] = a[i];
    return m;
  }
  /** Rotation(angle, size, axis) where axis is 'X' | 'Y' | 'Z' or a vector (ignored for 2x2). */
  static Rotation(angle: number, size = 4, axis: 'X' | 'Y' | 'Z' | VecLike = 'Z') {
    if (size === 2) return new Matrix([[Math.cos(angle), -Math.sin(angle)], [Math.sin(angle), Math.cos(angle)]]);
    if (size !== 3 && size !== 4) throw mathError('ValueError', 'Matrix.Rotation(): size must be 2, 3 or 4');
    const r = typeof axis === 'string' ? axisMatrix(axis, angle) : new Quaternion(axis, angle).to_matrix().rows;
    const m = new Matrix(r);
    return size === 4 ? m.to_4x4() : m;
  }
  /** Scale(factor, size, axis?) — uniform when no axis is given, along `axis` otherwise. */
  static Scale(factor: number, size = 4, axis?: VecLike | null) {
    const m = Matrix.Identity(size);
    const k = Math.min(size, 3);
    if (!axis) {
      for (let i = 0; i < k; i++) m.rows[i][i] = factor;
      return m;
    }
    const n = new Vector(toArray(axis)).normalized().toArray();
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) m.rows[i][j] += (factor - 1) * (n[i] ?? 0) * (n[j] ?? 0);
    return m;
  }
  /** Shear(plane, size, factor): plane 'X' / 'Y' for 2x2 (factor a number), 'XY' / 'XZ' / 'YZ' otherwise (two factors). */
  static Shear(plane: string, size: number, factor: number | VecLike) {
    const m = Matrix.Identity(size);
    if (size === 2) {
      const f = typeof factor === 'number' ? factor : toArray(factor)[0];
      if (plane === 'X') m.rows[0][1] = f;
      else if (plane === 'Y') m.rows[1][0] = f;
      else throw mathError('ValueError', `Matrix.Shear(): expected plane 'X' or 'Y' for a 2x2 matrix, not '${plane}'`);
      return m;
    }
    const [a, b] = typeof factor === 'number' ? [factor, factor] : toArray(factor);
    if (plane === 'XY') [m.rows[0][2], m.rows[1][2]] = [a, b];
    else if (plane === 'XZ') [m.rows[0][1], m.rows[2][1]] = [a, b];
    else if (plane === 'YZ') [m.rows[1][0], m.rows[2][0]] = [a, b];
    else throw mathError('ValueError', `Matrix.Shear(): expected plane 'XY', 'XZ' or 'YZ', not '${plane}'`);
    return m;
  }
  /** Projection onto an axis (2x2: 'X' / 'Y'), a plane ('XY', 'XZ', 'YZ') or the plane perpendicular to a vector. */
  static OrthoProjection(axis: string | VecLike, size = 4) {
    const m = Matrix.Identity(size);
    if (typeof axis === 'string') {
      const zero: Record<string, number> = size === 2 ? { X: 1, Y: 0 } : { XY: 2, XZ: 1, YZ: 0 };
      if (!(axis in zero)) throw mathError('ValueError', `Matrix.OrthoProjection(): unknown plane '${axis}'`);
      m.rows[zero[axis]][zero[axis]] = 0;
      return m;
    }
    const k = Math.min(size, 3);
    const n = new Vector(toArray(axis).slice(0, k)).normalized().toArray();
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) m.rows[i][j] -= (n[i] ?? 0) * (n[j] ?? 0);
    return m;
  }
  static Diagonal(v: VecLike) {
    const a = toArray(v);
    const m = Matrix.Identity(a.length);
    a.forEach((x, i) => (m.rows[i][i] = x));
    return m;
  }
  static LocRotScale(loc: VecLike | null, rot: Quaternion | Euler | Matrix | null, scale: VecLike | null) {
    const r = rot instanceof Matrix ? rot.to_3x3() : rot instanceof Quaternion || rot instanceof Euler ? rot.to_matrix() : rot ? new Quaternion(toArray(rot)).to_matrix() : Matrix.Identity(3);
    const s = scale ? toArray(scale) : [1, 1, 1];
    const m = Matrix.Identity(4);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m.rows[i][j] = r.rows[i][j] * s[j];
    const l = loc ? toArray(loc) : [0, 0, 0];
    for (let i = 0; i < 3; i++) m.rows[i][3] = l[i];
    return m;
  }
  /** From a column-major 16-element array (three.js / document storage). */
  static fromColumnMajor(e: ArrayLike<number>) {
    return new Matrix([
      [e[0], e[4], e[8], e[12]],
      [e[1], e[5], e[9], e[13]],
      [e[2], e[6], e[10], e[14]],
      [e[3], e[7], e[11], e[15]],
    ]);
  }
  toColumnMajor(): number[] {
    const m = this.to_4x4().rows;
    const out: number[] = [];
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out.push(m[r][c]);
    return out;
  }

  get size() {
    return this.rows.length;
  }
  get length() {
    return this.rows.length;
  }
  get col_count() {
    return this.rows[0].length;
  }
  row(i: number) {
    return rowView(this, i < 0 ? i + this.size : i);
  }
  col(j: number) {
    return new Vector(this.rows.map((r) => r[j < 0 ? j + r.length : j]));
  }
  /** Element access m.getItem(i) (row view) / m.getItem([i, j]) (number). */
  getItem(i: number | [number, number]) {
    if (Array.isArray(i)) return this.rows[i[0]][i[1]];
    if (i < 0) i += this.size;
    if (i < 0 || i >= this.size) throw mathError('IndexError', 'matrix row index out of range');
    return rowView(this, i);
  }
  setItem(i: number | [number, number], v: number | VecLike) {
    if (Array.isArray(i)) this.rows[i[0]][i[1]] = Number(v);
    else this.rows[i < 0 ? i + this.size : i] = toArray(v as VecLike);
  }
  get translation(): Vector {
    return new Vector([this.rows[0][3] ?? 0, this.rows[1][3] ?? 0, this.rows[2]?.[3] ?? 0]);
  }
  set translation(v: VecLike) {
    const a = toArray(v);
    for (let i = 0; i < 3; i++) this.rows[i][3] = a[i];
  }
  get is_negative() {
    return this.to_3x3().determinant() < 0;
  }
  /** True when the rows (and columns) are orthonormal. */
  get is_orthogonal() {
    const m = this.size === 2 ? this : this.to_3x3();
    return (m.matmul(m.transposed()) as Matrix).equals(Matrix.Identity(m.size), 1e-6);
  }
  /** True when the axis vectors (columns) are perpendicular to each other. */
  get is_orthogonal_axis_vectors() {
    const k = Math.min(this.size, 3);
    const cols = Array.from({ length: k }, (_, j) => Array.from({ length: k }, (_, i) => this.rows[i][j]));
    for (let a = 0; a < k; a++)
      for (let b = a + 1; b < k; b++) {
        const d = cols[a].reduce((s, v, i) => s + v * cols[b][i], 0);
        const l = Math.hypot(...cols[a]) * Math.hypot(...cols[b]);
        if (Math.abs(d) > 1e-6 * Math.max(l, 1e-12)) return false;
      }
    return true;
  }
  get is_identity() {
    return this.equals(Matrix.Identity(this.size), 1e-6);
  }
  get is_frozen() {
    return false;
  }
  get is_wrapped() {
    return false;
  }
  /** Average scale: the length of a unit diagonal vector after transformation. */
  get median_scale() {
    const m = this.to_3x3().rows;
    const u = 1 / Math.sqrt(3);
    return Math.hypot(...m.map((r) => (r[0] + r[1] + r[2]) * u));
  }
  freeze() {
    return this;
  }
  copy() {
    return new Matrix(this.rows.map((r) => [...r]));
  }
  identity() {
    this.rows = Matrix.identityRows(this.size);
    return this;
  }
  zero() {
    this.rows = this.rows.map((r) => r.map(() => 0));
    return this;
  }
  transposed() {
    return new Matrix(this.rows[0].map((_, j) => this.rows.map((r) => r[j])));
  }
  transpose() {
    this.rows = this.transposed().rows;
    return this;
  }
  private resizedTo(n: number) {
    return new Matrix(Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => this.rows[i]?.[j] ?? (i === j ? 1 : 0))));
  }
  to_2x2() {
    return this.resizedTo(2);
  }
  to_3x3() {
    return this.resizedTo(3);
  }
  to_4x4() {
    return this.resizedTo(4);
  }
  determinant(): number {
    const det = (m: number[][]): number => {
      if (m.length === 1) return m[0][0];
      if (m.length === 2) return m[0][0] * m[1][1] - m[0][1] * m[1][0];
      let d = 0;
      for (let j = 0; j < m.length; j++) if (m[0][j]) d += (j % 2 ? -1 : 1) * m[0][j] * det(m.slice(1).map((r) => r.filter((_, k) => k !== j)));
      return d;
    };
    if (this.rows.length !== this.rows[0].length) throw mathError('ValueError', 'Matrix.determinant(): only square matrices are supported');
    return det(this.rows);
  }
  /** Transposed cofactor matrix. */
  adjugated() {
    const n = this.size;
    if (n === 1) return new Matrix([[1]]);
    const minor = (i: number, j: number) => new Matrix(this.rows.filter((_, r) => r !== i).map((r) => r.filter((_, c) => c !== j))).determinant();
    return new Matrix(Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => ((i + j) % 2 ? -1 : 1) * minor(j, i))));
  }
  adjugate() {
    this.rows = this.adjugated().rows;
    return this;
  }
  inverted(fallback?: Matrix): Matrix {
    const n = this.size;
    const a = this.rows.map((r, i) => [...r, ...Matrix.identityRows(n)[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      if (Math.abs(a[p][c]) < 1e-14) {
        if (fallback !== undefined && fallback !== null) return fallback;
        throw mathError('ValueError', 'Matrix.invert(ed): matrix does not have an inverse');
      }
      [a[c], a[p]] = [a[p], a[c]];
      const d = a[c][c];
      for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = a[r][c];
        if (f) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
      }
    }
    return new Matrix(a.map((r) => r.slice(n)));
  }
  invert(fallback?: Matrix) {
    this.rows = this.inverted(fallback).rows;
    return this;
  }
  /** Inverse that never fails: singular matrices are nudged by a tiny diagonal offset first. */
  inverted_safe(): Matrix {
    try {
      return this.inverted();
    } catch {
      const m = this.copy();
      for (let i = 0; i < m.size; i++) m.rows[i][i] += 1e-8;
      return m.inverted(Matrix.Identity(this.size));
    }
  }
  invert_safe() {
    this.rows = this.inverted_safe().rows;
    return this;
  }
  /**
   * Matrix product (M @ N), transform a vector (M @ v; a 3D vector is extended with w = 1
   * for a 4x4 matrix and the result truncated back to 3D), or rotate a quaternion.
   */
  matmul(o: Matrix | Quaternion | VecLike): Matrix | Vector | Quaternion {
    if (o instanceof Matrix) {
      const n = this.size,
        inner = this.rows[0].length;
      if (inner !== o.size) throw mathError('ValueError', `matrix multiplication: ${n}x${inner} @ ${o.size}x${o.rows[0].length} sizes do not match`);
      return new Matrix(Array.from({ length: n }, (_, i) => Array.from({ length: o.rows[0].length }, (_, j) => this.rows[i].reduce((s, v, k) => s + v * o.rows[k][j], 0))));
    }
    if (o instanceof Quaternion) return (this.to_3x3().matmul(o.to_matrix()) as Matrix).to_quaternion();
    const v = toArray(o);
    const r = this.rows;
    if (r[0].length === 4 && v.length === 3) {
      const x = v[0],
        y = v[1],
        z = v[2];
      return new Vector([0, 1, 2].map((i) => r[i][0] * x + r[i][1] * y + r[i][2] * z + r[i][3]));
    }
    if (r[0].length === 3 && v.length === 4) v.length = 3;
    if (r[0].length !== v.length) throw mathError('ValueError', `matrix @ vector: ${r.length}x${r[0].length} matrix and ${v.length}D vector sizes do not match`);
    return new Vector(r.map((row) => row.reduce((s, m, k) => s + m * v[k], 0)));
  }
  /** Scalar multiply, or element-wise with another matrix. */
  mul(s: number | Matrix) {
    if (s instanceof Matrix) return new Matrix(this.rows.map((r, i) => r.map((v, j) => v * s.rows[i][j])));
    return new Matrix(this.rows.map((r) => r.map((v) => v * s)));
  }
  div(s: number) {
    if (s === 0) throw mathError('ValueError', 'Matrix division: divide by zero');
    return this.mul(1 / s);
  }
  neg() {
    return this.mul(-1);
  }
  add(o: Matrix) {
    return new Matrix(this.rows.map((r, i) => r.map((v, j) => v + o.rows[i][j])));
  }
  sub(o: Matrix) {
    return new Matrix(this.rows.map((r, i) => r.map((v, j) => v - o.rows[i][j])));
  }
  to_scale() {
    const m = this.to_3x3().rows;
    const s = [0, 1, 2].map((j) => Math.hypot(m[0][j], m[1][j], m[2][j]));
    if (this.to_3x3().determinant() < 0) s[0] = -s[0];
    return new Vector(s);
  }
  to_translation(): Vector {
    return this.translation;
  }
  /** Normalized 3x3 rotation part (scale removed). */
  private rotationPart() {
    const m = this.to_3x3().rows;
    const s = this.to_scale().toArray();
    return [0, 1, 2].map((i) => [0, 1, 2].map((j) => (Math.abs(s[j]) < EPS ? 0 : m[i][j] / s[j])));
  }
  to_quaternion(): Quaternion {
    const m = this.rotationPart();
    const tr = m[0][0] + m[1][1] + m[2][2];
    let w: number, x: number, y: number, z: number;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      w = 0.25 * s;
      x = (m[2][1] - m[1][2]) / s;
      y = (m[0][2] - m[2][0]) / s;
      z = (m[1][0] - m[0][1]) / s;
    } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
      const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
      w = (m[2][1] - m[1][2]) / s;
      x = 0.25 * s;
      y = (m[0][1] + m[1][0]) / s;
      z = (m[0][2] + m[2][0]) / s;
    } else if (m[1][1] > m[2][2]) {
      const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
      w = (m[0][2] - m[2][0]) / s;
      x = (m[0][1] + m[1][0]) / s;
      y = 0.25 * s;
      z = (m[1][2] + m[2][1]) / s;
    } else {
      const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
      w = (m[1][0] - m[0][1]) / s;
      x = (m[0][2] + m[2][0]) / s;
      y = (m[1][2] + m[2][1]) / s;
      z = 0.25 * s;
    }
    const q = new Quaternion([w, x, y, z]).normalized();
    return q.w < 0 ? new Quaternion(q.toArray().map((v) => -v)) : q;
  }
  /** Decompose the rotation into Euler angles for the given order (X applied first for 'XYZ'). */
  to_euler(order: EulerOrder = 'XYZ', compatible?: VecLike): Euler {
    const m = this.rotationPart();
    const idx: Record<string, number> = { X: 0, Y: 1, Z: 2 };
    checkOrder(order);
    // R = R_k * R_j * R_i for order "ijk"; generic Tait–Bryan extraction.
    const i = idx[order[0]],
      j = idx[order[1]],
      k = idx[order[2]];
    const parity = (j - i + 3) % 3 === 1 ? 1 : -1;
    const a = [0, 0, 0];
    const sy = -parity * m[k][i];
    const cy = Math.hypot(m[k][j], m[k][k]);
    if (cy > 1e-9) {
      a[i] = Math.atan2(parity * m[k][j], m[k][k]);
      a[j] = Math.atan2(sy, cy);
      a[k] = Math.atan2(parity * m[j][i], m[i][i]);
    } else {
      a[i] = Math.atan2(-parity * m[j][k], m[j][j]);
      a[j] = Math.atan2(sy, cy);
      a[k] = 0;
    }
    const e = new Euler(a, order);
    if (compatible) e.make_compatible(compatible);
    return e;
  }
  decompose(): [Vector, Quaternion, Vector] {
    return [this.to_translation(), this.to_quaternion(), this.to_scale()];
  }
  /** Copy with each axis (column of the 3x3 part) scaled to unit length. */
  normalized() {
    const out = this.copy();
    const k = Math.min(this.size, 3);
    for (let j = 0; j < k; j++) {
      let l = 0;
      for (let i = 0; i < k; i++) l += out.rows[i][j] ** 2;
      l = Math.sqrt(l);
      if (l > EPS) for (let i = 0; i < k; i++) out.rows[i][j] /= l;
    }
    return out;
  }
  normalize() {
    this.rows = this.normalized().rows;
    return this;
  }
  lerp(o: Matrix, t: number) {
    return new Matrix(this.rows.map((r, i) => r.map((v, j) => v + (o.rows[i][j] - v) * t)));
  }
  equals(o: Matrix, eps = 1e-6) {
    return o.size === this.size && this.rows.every((r, i) => r.length === o.rows[i].length && r.every((v, j) => Math.abs(v - o.rows[i][j]) <= eps));
  }
  [Symbol.iterator]() {
    return this.rows.map((_, i) => rowView(this, i))[Symbol.iterator]();
  }
  toString() {
    return `<Matrix ${this.size}x${this.rows[0]?.length ?? 0} ${this.rows.map((r) => `(${r.map((v) => v.toFixed(4)).join(', ')})`).join(' ')}>`;
  }
  repr() {
    return `Matrix((${this.rows.map((r) => `(${r.map(fmt).join(', ')})`).join(', ')}))`;
  }
  toJSON() {
    return this.rows;
  }
}

// m[0], m[1], ... are live row views
for (let i = 0; i < 4; i++)
  Object.defineProperty(Matrix.prototype, i, {
    get(this: Matrix) {
      return i < this.rows.length ? rowView(this, i) : undefined;
    },
    configurable: true,
  });

export { geometry, kdtree, bvhtree, noise };

/** The `mathutils` module object scripts receive (submodules resolve lazily to keep imports acyclic-safe). */
export const mathutils = { Vector, Matrix, Euler, Quaternion, Color } as {
  Vector: typeof Vector;
  Matrix: typeof Matrix;
  Euler: typeof Euler;
  Quaternion: typeof Quaternion;
  Color: typeof Color;
  geometry: typeof geometry;
  kdtree: typeof kdtree;
  bvhtree: typeof bvhtree;
  noise: typeof noise;
};
Object.defineProperties(mathutils, {
  geometry: { get: () => geometry, enumerable: true },
  kdtree: { get: () => kdtree, enumerable: true },
  bvhtree: { get: () => bvhtree, enumerable: true },
  noise: { get: () => noise, enumerable: true },
});
