// Nearest-point distances through a balanced 3D k-d tree (implicit: the node for the range
// [lo, hi) of one permutation array sits at its median, split on the axis of largest extent).

/**
 * For every query point, the distance to the nearest of `points` when it is below `maxDist`,
 * else Infinity. Points and queries are flat xyz arrays. O((n + q) log n) instead of the
 * O(n × q) of comparing every pair.
 */
export function nearestDistances(points: ArrayLike<number>, queries: ArrayLike<number>, maxDist = Infinity): Float64Array {
  const n = Math.floor(points.length / 3);
  const nq = Math.floor(queries.length / 3);
  const out = new Float64Array(nq).fill(Infinity);
  if (!n) return out;
  const co = Float64Array.from(points);
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  const axis = new Uint8Array(n);
  const select = (lo: number, hi: number, k: number, ax: number) => {
    // quickselect: perm[k] becomes the k-th smallest along `ax` within [lo, hi)
    hi--;
    while (hi > lo) {
      const pv = co[perm[(lo + hi) >> 1] * 3 + ax];
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
  const stack: number[] = [0, n];
  while (stack.length) {
    const hi = stack.pop()!,
      lo = stack.pop()!;
    if (hi - lo <= 1) continue;
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
      if (mx - mn > best) {
        best = mx - mn;
        ax = a;
      }
    }
    const mid = (lo + hi) >> 1;
    select(lo, hi, mid, ax);
    axis[mid] = ax;
    stack.push(lo, mid, mid + 1, hi);
  }
  const limit = maxDist * maxDist;
  const q = [0, 0, 0];
  let bestD = 0;
  const visit = (lo: number, hi: number) => {
    if (lo >= hi) return;
    const mid = (lo + hi) >> 1;
    const p = perm[mid];
    const dx = co[p * 3] - q[0],
      dy = co[p * 3 + 1] - q[1],
      dz = co[p * 3 + 2] - q[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) bestD = d;
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
  for (let i = 0; i < nq; i++) {
    q[0] = queries[i * 3];
    q[1] = queries[i * 3 + 1];
    q[2] = queries[i * 3 + 2];
    bestD = limit;
    visit(0, n);
    if (bestD < limit) out[i] = Math.sqrt(bestD);
  }
  return out;
}
