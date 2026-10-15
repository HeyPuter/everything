// Nearest-point lookup over a fixed point set (uniform grid, expanding ring search).

export class PointGrid {
  private cells = new Map<number, number[]>();
  private min: [number, number, number] = [0, 0, 0];
  private size = 1;
  private dims: [number, number, number] = [1, 1, 1];

  constructor(private pts: ArrayLike<number>) {
    const n = pts.length / 3;
    if (!n) return;
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c], pts[i * 3 + c]);
        hi[c] = Math.max(hi[c], pts[i * 3 + c]);
      }
    const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
    // about two points per cell along the longest axis distribution
    this.size = ext / Math.max(1, Math.cbrt(n) * 1.5);
    this.min = [lo[0], lo[1], lo[2]];
    this.dims = [0, 1, 2].map((c) => Math.max(1, Math.floor((hi[c] - lo[c]) / this.size) + 1)) as [number, number, number];
    for (let i = 0; i < n; i++) {
      const k = this.key(this.cell(pts[i * 3], 0), this.cell(pts[i * 3 + 1], 1), this.cell(pts[i * 3 + 2], 2));
      const list = this.cells.get(k);
      if (list) list.push(i);
      else this.cells.set(k, [i]);
    }
  }

  private cell(v: number, axis: number) {
    return Math.max(0, Math.min(this.dims[axis] - 1, Math.floor((v - this.min[axis]) / this.size)));
  }

  private key(x: number, y: number, z: number) {
    return (z * this.dims[1] + y) * this.dims[0] + x;
  }

  /** Index of the nearest point and its squared distance, or [-1, Infinity] when empty. */
  nearest(x: number, y: number, z: number): [number, number] {
    if (!this.cells.size) return [-1, Infinity];
    const cx = this.cell(x, 0),
      cy = this.cell(y, 1),
      cz = this.cell(z, 2);
    let best = -1,
      bestD = Infinity;
    const maxR = Math.max(...this.dims);
    for (let r = 0; r <= maxR; r++) {
      // once a candidate is found, one more ring guarantees correctness
      for (let dz = -r; dz <= r; dz++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const ix = cx + dx,
              iy = cy + dy,
              iz = cz + dz;
            if (ix < 0 || iy < 0 || iz < 0 || ix >= this.dims[0] || iy >= this.dims[1] || iz >= this.dims[2]) continue;
            const list = this.cells.get(this.key(ix, iy, iz));
            if (!list) continue;
            for (const i of list) {
              const ex = this.pts[i * 3] - x,
                ey = this.pts[i * 3 + 1] - y,
                ez = this.pts[i * 3 + 2] - z;
              const d = ex * ex + ey * ey + ez * ez;
              if (d < bestD) {
                bestD = d;
                best = i;
              }
            }
          }
      if (best >= 0) {
        // points in cells beyond ring r are at least (r * size) away from the query cell boundary
        const reach = r * this.size;
        if (reach * reach >= bestD) break;
      }
    }
    return [best, bestD];
  }
}
