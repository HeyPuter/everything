// `mathutils.kdtree`: a balanced 3D k-d tree for nearest-point queries from scripts.
// Points are stored in an implicit tree over one permutation array: the node for the
// range [lo, hi) sits at its median, split on the axis of largest extent.
import { Vector, toArray, mathError, type VecLike } from './mathutils';

type Filter = ((index: number) => unknown) | null | undefined;
export type KDHit = [Vector, number, number];

export class KDTree {
  readonly __type = 'KDTree';
  private cap: number;
  private count = 0;
  private co: Float64Array;
  private ids: Int32Array;
  private perm = new Int32Array(0);
  private axis = new Uint8Array(0);
  private balanced = false;

  constructor(size: number) {
    const n = Math.floor(Number(size));
    if (!(n >= 0)) throw mathError('ValueError', 'KDTree(size): size must be a non-negative integer');
    this.cap = n;
    this.co = new Float64Array(n * 3);
    this.ids = new Int32Array(n);
  }

  insert(co: VecLike, index: number) {
    if (this.count >= this.cap) throw mathError('RuntimeError', 'Trying to insert more items than KDTree has room for');
    const a = toArray(co);
    if (a.length < 2 || a.length > 4) throw mathError('ValueError', 'KDTree.insert(): expected a 3D vector');
    const k = this.count++;
    this.co[k * 3] = a[0];
    this.co[k * 3 + 1] = a[1];
    this.co[k * 3 + 2] = a[2] ?? 0;
    this.ids[k] = Number(index);
    this.balanced = false;
  }

  /** Insert many points at once: flat xyz coordinates and their indices (used by the Python module). */
  _insertFlat(flat: ArrayLike<number>, indices: ArrayLike<number>) {
    const n = indices.length;
    if (this.count + n > this.cap) throw mathError('RuntimeError', 'Trying to insert more items than KDTree has room for');
    for (let i = 0; i < n; i++) {
      const k = this.count++;
      this.co[k * 3] = flat[i * 3];
      this.co[k * 3 + 1] = flat[i * 3 + 1];
      this.co[k * 3 + 2] = flat[i * 3 + 2];
      this.ids[k] = indices[i];
    }
    this.balanced = false;
  }

  /** Build the tree; required after inserting and before searching. */
  balance() {
    const n = this.count;
    const perm = new Int32Array(n);
    for (let i = 0; i < n; i++) perm[i] = i;
    const axis = new Uint8Array(n);
    const co = this.co;
    const select = (lo: number, hi: number, k: number, ax: number) => {
      // quickselect: perm[k] becomes the k-th smallest along `ax` within [lo, hi)
      hi--;
      while (hi > lo) {
        const mid = (lo + hi) >> 1;
        const pv = co[perm[mid] * 3 + ax];
        let i = lo,
          j = hi;
        while (i <= j) {
          while (co[perm[i] * 3 + ax] < pv) i++;
          while (co[perm[j] * 3 + ax] > pv) j--;
          if (i <= j) {
            const t = perm[i];
            perm[i] = perm[j];
            perm[j] = t;
            i++;
            j--;
          }
        }
        if (k <= j) hi = j;
        else if (k >= i) lo = i;
        else return;
      }
    };
    const build = (lo: number, hi: number) => {
      if (hi - lo <= 1) return;
      let ax = 0,
        best = -1;
      for (let a = 0; a < 3; a++) {
        let mn = Infinity,
          mx = -Infinity;
        for (let i = lo; i < hi; i++) {
          const v = co[perm[i] * 3 + a];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        if (mx - mn > best) [best, ax] = [mx - mn, a];
      }
      const mid = (lo + hi) >> 1;
      select(lo, hi, mid, ax);
      axis[mid] = ax;
      build(lo, mid);
      build(mid + 1, hi);
    };
    build(0, n);
    this.perm = perm;
    this.axis = axis;
    this.balanced = true;
  }

  private check(what: string) {
    if (!this.balanced) throw mathError('RuntimeError', `KDTree must be balanced before calling ${what}()`);
  }
  private hit(p: number, d2: number): KDHit {
    return [new Vector([this.co[p * 3], this.co[p * 3 + 1], this.co[p * 3 + 2]]), this.ids[p], Math.sqrt(d2)];
  }
  private query(co: VecLike): [number, number, number] {
    const a = toArray(co);
    return [a[0], a[1], a[2] ?? 0];
  }

  /** Nearest point to `co` (optionally only points whose index passes `filter`): [co, index, distance] or [null, null, null]. */
  find(co: VecLike, filter?: Filter): KDHit | [null, null, null] {
    this.check('find');
    const [x, y, z] = this.query(co);
    const r = this.nearest(x, y, z, filter);
    return r < 0 ? [null, null, null] : this.hit(r, this.lastD2);
  }

  private lastD2 = 0;
  private nearest(x: number, y: number, z: number, filter: Filter): number {
    const { co, perm, axis, ids } = this;
    let best = -1,
      bestD = Infinity;
    const q = [x, y, z];
    const visit = (lo: number, hi: number) => {
      if (lo >= hi) return;
      const mid = (lo + hi) >> 1;
      const p = perm[mid];
      const dx = co[p * 3] - x,
        dy = co[p * 3 + 1] - y,
        dz = co[p * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD && (!filter || filter(ids[p]))) {
        bestD = d;
        best = p;
      }
      if (hi - lo === 1) return;
      const ax = axis[mid];
      const diff = q[ax] - co[p * 3 + ax];
      if (diff < 0) {
        visit(lo, mid);
        if (diff * diff < bestD) visit(mid + 1, hi);
      } else {
        visit(mid + 1, hi);
        if (diff * diff < bestD) visit(lo, mid);
      }
    };
    visit(0, this.count);
    this.lastD2 = bestD;
    return best;
  }

  /** The `n` nearest points, closest first. */
  find_n(co: VecLike, n: number): KDHit[] {
    this.check('find_n');
    const [x, y, z] = this.query(co);
    return this.nearestN(x, y, z, Math.floor(n)).map(([p, d]) => this.hit(p, d));
  }

  private nearestN(x: number, y: number, z: number, n: number): [number, number][] {
    if (n <= 0) return [];
    const { co, perm, axis } = this;
    const found: [number, number][] = []; // sorted by distance, at most n
    const q = [x, y, z];
    const worst = () => (found.length < n ? Infinity : found[found.length - 1][1]);
    const visit = (lo: number, hi: number) => {
      if (lo >= hi) return;
      const mid = (lo + hi) >> 1;
      const p = perm[mid];
      const dx = co[p * 3] - x,
        dy = co[p * 3 + 1] - y,
        dz = co[p * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < worst()) {
        let i = found.length;
        while (i > 0 && found[i - 1][1] > d) i--;
        found.splice(i, 0, [p, d]);
        if (found.length > n) found.pop();
      }
      if (hi - lo === 1) return;
      const ax = axis[mid];
      const diff = q[ax] - co[p * 3 + ax];
      if (diff < 0) {
        visit(lo, mid);
        if (diff * diff < worst()) visit(mid + 1, hi);
      } else {
        visit(mid + 1, hi);
        if (diff * diff < worst()) visit(lo, mid);
      }
    };
    visit(0, this.count);
    return found;
  }

  /** All points within `radius` of `co`, closest first. */
  find_range(co: VecLike, radius: number): KDHit[] {
    this.check('find_range');
    const [x, y, z] = this.query(co);
    return this.inRange(x, y, z, radius).map(([p, d]) => this.hit(p, d));
  }

  private inRange(x: number, y: number, z: number, radius: number): [number, number][] {
    const { co, perm, axis } = this;
    const r2 = radius * radius;
    const found: [number, number][] = [];
    const q = [x, y, z];
    const visit = (lo: number, hi: number) => {
      if (lo >= hi) return;
      const mid = (lo + hi) >> 1;
      const p = perm[mid];
      const dx = co[p * 3] - x,
        dy = co[p * 3 + 1] - y,
        dz = co[p * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d <= r2) found.push([p, d]);
      if (hi - lo === 1) return;
      const diff = q[axis[mid]] - co[p * 3 + axis[mid]];
      if (diff <= 0 || diff * diff <= r2) visit(lo, mid);
      if (diff >= 0 || diff * diff <= r2) visit(mid + 1, hi);
    };
    if (radius >= 0) visit(0, this.count);
    return found.sort((a, b) => a[1] - b[1] || this.ids[a[0]] - this.ids[b[0]]);
  }

  // Flat results for the Python module: [x, y, z, index, distance] per hit.
  private flat(hits: [number, number][]) {
    const out: number[] = [];
    for (const [p, d] of hits) out.push(this.co[p * 3], this.co[p * 3 + 1], this.co[p * 3 + 2], this.ids[p], Math.sqrt(d));
    return out;
  }
  _findFlat(x: number, y: number, z: number, filter?: Filter) {
    this.check('find');
    const r = this.nearest(x, y, z, filter);
    return r < 0 ? [] : this.flat([[r, this.lastD2]]);
  }
  _findNFlat(x: number, y: number, z: number, n: number) {
    this.check('find_n');
    return this.flat(this.nearestN(x, y, z, Math.floor(n)));
  }
  _findRangeFlat(x: number, y: number, z: number, radius: number) {
    this.check('find_range');
    return this.flat(this.inRange(x, y, z, radius));
  }

  toString() {
    return `<KDTree object (${this.count} points)>`;
  }
  repr() {
    return this.toString();
  }
}

export const kdtree = { KDTree };
