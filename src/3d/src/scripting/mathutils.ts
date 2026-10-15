// Independent implementation of a small vector-math library whose public names follow
// the documented `mathutils` module (Vector, Matrix, Euler, Quaternion, Color) so scripts
// written against that API run here. JavaScript has no operator overloading, so the
// arithmetic operators are exposed as methods (`add`, `sub`, `mul`, `matmul`, ...).
// Matrices are row-major (m[row][col]) and act on column vectors.

export type VecLike = ArrayLike<number> | VecBase;
export type EulerOrder = 'XYZ' | 'XZY' | 'YXZ' | 'YZX' | 'ZXY' | 'ZYX';

const EPS = 1e-12;

function toArray(v: VecLike | Iterable<number>): number[] {
  if (v instanceof VecBase) return v.toArray();
  if (v instanceof Matrix) throw new TypeError('expected a vector, got a Matrix');
  if (typeof (v as ArrayLike<number>).length === 'number') return Array.from(v as ArrayLike<number>, Number);
  return Array.from(v as Iterable<number>, Number);
}

const fmt = (n: number) => {
  const s = Number(n.toFixed(4)).toString();
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

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
    if (i < 0 || i >= this._n) throw new RangeError('vector index out of range');
    return this.getc(i);
  }
  set(i: number, v: number) {
    if (i < 0) i += this._n;
    if (i < 0 || i >= this._n) throw new RangeError('vector index out of range');
    this.setc(i, Number(v));
  }
  toArray(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this._n; i++) out.push(this.getc(i));
    return out;
  }
  to_tuple(precision?: number): number[] {
    return precision === undefined ? this.toArray() : this.toArray().map((v) => Number(v.toFixed(precision)));
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

/** N-dimensional vector (2–4 components in practice). Components are numeric own properties. */
export class Vector extends VecBase {
  constructor(values: VecLike | Iterable<number> = [0, 0, 0]) {
    super(values);
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
  get xy() {
    return new Vector([this.x, this.y]);
  }
  get xyz() {
    return new Vector([this.x, this.y, this.z]);
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
    return new Vector(a.map((v, i) => v + (b[i] ?? 0)));
  }
  sub(o: VecLike) {
    const a = this.toArray(),
      b = toArray(o);
    return new Vector(a.map((v, i) => v - (b[i] ?? 0)));
  }
  /** Scalar multiply, or element-wise when given a vector. */
  mul(o: number | VecLike) {
    if (typeof o === 'number') return new Vector(this.toArray().map((v) => v * o));
    const b = toArray(o);
    return new Vector(this.toArray().map((v, i) => v * (b[i] ?? 0)));
  }
  div(s: number) {
    if (s === 0) throw new RangeError('division by zero');
    return new Vector(this.toArray().map((v) => v / s));
  }
  negate() {
    for (let i = 0; i < this._n; i++) this.setc(i, -this.getc(i));
    return this;
  }
  neg() {
    return new Vector(this.toArray().map((v) => -v));
  }
  dot(o: VecLike) {
    const a = this.toArray(),
      b = toArray(o);
    return a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
  }
  cross(o: VecLike) {
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
  angle(o: VecLike, fallback?: number) {
    const b = new Vector(toArray(o));
    const l = this.magnitude * b.magnitude;
    if (l < EPS) {
      if (fallback !== undefined) return fallback;
      throw new RangeError('angle() zero-length vector');
    }
    return Math.acos(Math.max(-1, Math.min(1, this.dot(b) / l)));
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
  to_2d() {
    return new Vector([this.get(0), this.get(1)]);
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
  freeze() {
    return this;
  }
  toString() {
    return `<Vector (${this.toArray().map((v) => v.toFixed(4)).join(', ')})>`;
  }
  repr() {
    return `Vector((${this.toArray().map(fmt).join(', ')}))`;
  }
}

// ---------------------------------------------------------------------------
// Color

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
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

function mul3(a: number[][], b: number[][]) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return out;
}

export class Euler extends Vector {
  override readonly __kind: string = 'euler';
  order: EulerOrder;
  constructor(angles: VecLike | Iterable<number> = [0, 0, 0], order: EulerOrder = 'XYZ') {
    super(angles);
    this.order = order;
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
  make_compatible(ref: VecLike) {
    const r = toArray(ref);
    for (let i = 0; i < 3; i++) {
      let v = this.get(i);
      while (v - r[i] > Math.PI) v -= 2 * Math.PI;
      while (r[i] - v > Math.PI) v += 2 * Math.PI;
      this.set(i, v);
    }
    return this;
  }
  rotate_axis(axis: 'X' | 'Y' | 'Z', angle: number) {
    const m = new Matrix(axisMatrix(axis, angle)).matmul(this.to_matrix()) as Matrix;
    this.assign(m.to_euler(this.order));
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

export class Quaternion extends VecBase {
  override readonly __kind: string = 'quaternion';
  /** Quaternion([w, x, y, z]) or Quaternion(axis, angle). */
  constructor(values: VecLike | Iterable<number> = [1, 0, 0, 0], angle?: number) {
    if (angle !== undefined) {
      const ax = new Vector(toArray(values as VecLike)).normalized();
      const s = Math.sin(angle / 2);
      super([Math.cos(angle / 2), ax.x * s, ax.y * s, ax.z * s]);
    } else super(values);
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
    return 2 * Math.acos(Math.max(-1, Math.min(1, this.normalized().get(0))));
  }
  get axis() {
    const s = Math.sqrt(Math.max(0, 1 - this.normalized().get(0) ** 2));
    const n = this.normalized();
    return s < EPS ? new Vector([1, 0, 0]) : new Vector([n.get(1) / s, n.get(2) / s, n.get(3) / s]);
  }
  copy() {
    return new Quaternion(this.toArray());
  }
  normalized() {
    const l = this.magnitude;
    return l < EPS ? new Quaternion() : new Quaternion(this.toArray().map((v) => v / l));
  }
  conjugated() {
    return new Quaternion([this.w, -this.x, -this.y, -this.z]);
  }
  inverted() {
    const l = this.length_squared;
    return new Quaternion([this.w / l, -this.x / l, -this.y / l, -this.z / l]);
  }
  /** Hamilton product (q @ r), or rotate a vector (q @ v). */
  matmul(o: Quaternion | VecLike): Quaternion | Vector {
    if (o instanceof Quaternion) {
      const [aw, ax, ay, az] = this.toArray(),
        [bw, bx, by, bz] = o.toArray();
      return new Quaternion([aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw]);
    }
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
  to_euler(order: EulerOrder = 'XYZ'): Euler {
    return this.to_matrix().to_euler(order);
  }
  to_axis_angle(): [Vector, number] {
    return [this.axis, this.angle];
  }
  slerp(o: Quaternion, t: number): Quaternion {
    const a = this.normalized().toArray();
    let b = o.normalized().toArray();
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
  rotation_difference(o: Quaternion) {
    return this.inverted().matmul(o) as Quaternion;
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

export class Matrix {
  readonly __kind = 'matrix';
  rows: number[][];

  constructor(rows?: ArrayLike<ArrayLike<number> | VecLike>) {
    if (!rows) this.rows = Matrix.identityRows(4);
    else this.rows = Array.from(rows as ArrayLike<VecLike>, (r) => toArray(r));
  }

  static identityRows(n: number) {
    return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  }
  static Identity(n = 4) {
    return new Matrix(Matrix.identityRows(n));
  }
  static Translation(v: VecLike) {
    const [x, y, z] = toArray(v);
    const m = Matrix.Identity(4);
    m.rows[0][3] = x;
    m.rows[1][3] = y;
    m.rows[2][3] = z ?? 0;
    return m;
  }
  /** Rotation(angle, size, axis) where axis is 'X' | 'Y' | 'Z' or a vector. */
  static Rotation(angle: number, size = 4, axis: 'X' | 'Y' | 'Z' | VecLike = 'Z') {
    let r: number[][];
    if (typeof axis === 'string') r = axisMatrix(axis, angle);
    else r = new Quaternion(axis, angle).to_matrix().rows;
    if (size === 2) return new Matrix([[Math.cos(angle), -Math.sin(angle)], [Math.sin(angle), Math.cos(angle)]]);
    const m = new Matrix(r);
    return size === 4 ? m.to_4x4() : m;
  }
  /** Scale(factor, size, axis?) — uniform when no axis is given. */
  static Scale(factor: number, size = 4, axis?: VecLike) {
    const m = Matrix.Identity(size);
    if (!axis) {
      for (let i = 0; i < Math.min(size, 3); i++) m.rows[i][i] = factor;
      return m;
    }
    const n = new Vector(toArray(axis)).normalized().toArray();
    for (let i = 0; i < Math.min(size, 3); i++) for (let j = 0; j < Math.min(size, 3); j++) m.rows[i][j] += (factor - 1) * n[i] * n[j];
    return m;
  }
  static Diagonal(v: VecLike) {
    const a = toArray(v);
    const m = Matrix.Identity(a.length);
    a.forEach((x, i) => (m.rows[i][i] = x));
    return m;
  }
  static LocRotScale(loc: VecLike | null, rot: Quaternion | Euler | Matrix | null, scale: VecLike | null) {
    const r = rot instanceof Matrix ? rot.to_3x3() : rot instanceof Quaternion || rot instanceof Euler ? rot.to_matrix() : Matrix.Identity(3);
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
  row(i: number) {
    return new Vector(this.rows[i]);
  }
  col(j: number) {
    return new Vector(this.rows.map((r) => r[j]));
  }
  get translation() {
    return new Vector([this.rows[0][3] ?? 0, this.rows[1][3] ?? 0, this.rows[2][3] ?? 0]);
  }
  set translation(v: VecLike) {
    const a = toArray(v);
    for (let i = 0; i < 3; i++) this.rows[i][3] = a[i];
  }
  copy() {
    return new Matrix(this.rows.map((r) => [...r]));
  }
  identity() {
    this.rows = Matrix.identityRows(this.size);
    return this;
  }
  transposed() {
    return new Matrix(this.rows[0].map((_, j) => this.rows.map((r) => r[j])));
  }
  transpose() {
    this.rows = this.transposed().rows;
    return this;
  }
  to_3x3() {
    return new Matrix([0, 1, 2].map((i) => [0, 1, 2].map((j) => this.rows[i]?.[j] ?? (i === j ? 1 : 0))));
  }
  to_4x4() {
    if (this.size === 4) return this.copy();
    const m = Matrix.Identity(4);
    for (let i = 0; i < this.size; i++) for (let j = 0; j < this.size; j++) m.rows[i][j] = this.rows[i][j];
    return m;
  }
  determinant(): number {
    const det = (m: number[][]): number => {
      if (m.length === 1) return m[0][0];
      if (m.length === 2) return m[0][0] * m[1][1] - m[0][1] * m[1][0];
      let d = 0;
      for (let j = 0; j < m.length; j++) d += (j % 2 ? -1 : 1) * m[0][j] * det(m.slice(1).map((r) => r.filter((_, k) => k !== j)));
      return d;
    };
    return det(this.rows);
  }
  inverted(fallback?: Matrix): Matrix {
    const n = this.size;
    const a = this.rows.map((r, i) => [...r, ...Matrix.identityRows(n)[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      if (Math.abs(a[p][c]) < 1e-14) {
        if (fallback) return fallback;
        throw new RangeError('Matrix.inverted(): matrix does not have an inverse');
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
  invert() {
    this.rows = this.inverted().rows;
    return this;
  }
  /** Matrix product (M @ N), or transform a vector (M @ v, homogeneous for 3D vectors with 4x4). */
  matmul(o: Matrix | VecLike): Matrix | Vector {
    if (o instanceof Matrix) {
      const n = this.size;
      return new Matrix(Array.from({ length: n }, (_, i) => Array.from({ length: o.rows[0].length }, (_, j) => this.rows[i].reduce((s, v, k) => s + v * (o.rows[k]?.[j] ?? 0), 0))));
    }
    const v = toArray(o);
    if (this.size === 4 && v.length === 3) {
      const r = this.rows;
      const x = v[0],
        y = v[1],
        z = v[2];
      const w = r[3][0] * x + r[3][1] * y + r[3][2] * z + r[3][3] || 1;
      return new Vector([0, 1, 2].map((i) => (r[i][0] * x + r[i][1] * y + r[i][2] * z + r[i][3]) / w));
    }
    return new Vector(this.rows.map((r) => r.reduce((s, m, k) => s + m * (v[k] ?? 0), 0)));
  }
  mul(s: number) {
    return new Matrix(this.rows.map((r) => r.map((v) => v * s)));
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
    return new Vector([this.rows[0][3] ?? 0, this.rows[1][3] ?? 0, this.rows[2][3] ?? 0]);
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
  normalized() {
    const m = this.to_3x3();
    const s = m.to_scale().toArray();
    const out = this.copy();
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out.rows[i][j] = Math.abs(s[j]) < EPS ? 0 : m.rows[i][j] / Math.abs(s[j]);
    return out;
  }
  lerp(o: Matrix, t: number) {
    return new Matrix(this.rows.map((r, i) => r.map((v, j) => v + (o.rows[i][j] - v) * t)));
  }
  equals(o: Matrix, eps = 1e-6) {
    return o.size === this.size && this.rows.every((r, i) => r.every((v, j) => Math.abs(v - o.rows[i][j]) <= eps));
  }
  [Symbol.iterator]() {
    return this.rows.map((r) => new Vector(r))[Symbol.iterator]();
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

/** Geometry helpers commonly used from scripts (subset). */
export const geometry = {
  intersect_line_plane(a: VecLike, b: VecLike, planeCo: VecLike, planeNo: VecLike): Vector | null {
    const A = new Vector(toArray(a)),
      B = new Vector(toArray(b)),
      P = new Vector(toArray(planeCo)),
      N = new Vector(toArray(planeNo));
    const d = B.sub(A);
    const den = N.dot(d);
    if (Math.abs(den) < EPS) return null;
    const t = N.dot(P.sub(A)) / den;
    return A.add(d.mul(t));
  },
  normal(...pts: VecLike[]): Vector {
    const p = pts.map((v) => new Vector(toArray(v)));
    const n = new Vector([0, 0, 0]);
    for (let i = 0; i < p.length; i++) {
      const a = p[i],
        b = p[(i + 1) % p.length];
      n.x += (a.y - b.y) * (a.z + b.z);
      n.y += (a.z - b.z) * (a.x + b.x);
      n.z += (a.x - b.x) * (a.y + b.y);
    }
    return n.normalized();
  },
  area_tri(a: VecLike, b: VecLike, c: VecLike): number {
    const A = new Vector(toArray(a));
    const cr = new Vector(toArray(b)).sub(A).cross(new Vector(toArray(c)).sub(A));
    return typeof cr === 'number' ? Math.abs(cr) / 2 : cr.magnitude / 2;
  },
};

export const mathutils = { Vector, Matrix, Euler, Quaternion, Color, geometry };
