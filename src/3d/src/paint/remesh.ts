// Voxel remesh: signed distance field of the mesh on a regular grid (narrow band from the
// triangles, inside/outside by flood fill from the grid border), then a quad surface extracted
// with surface nets (one vertex per cell crossing the surface, one quad per crossing grid edge).

export interface RemeshResult {
  positions: Float32Array;
  /** quad vertex indices, 4 per face */
  quads: Uint32Array;
}

/** Closest point on triangle abc to p (Ericson's region method); writes into out. */
export function closestPointTriangle(p: number[], a: number[], b: number[], c: number[], out: number[]): void {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
    ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const set = (x: number[], u: number[] | null, s: number, w: number[] | null, t: number) => {
    out[0] = x[0] + (u ? u[0] * s : 0) + (w ? w[0] * t : 0);
    out[1] = x[1] + (u ? u[1] * s : 0) + (w ? w[1] * t : 0);
    out[2] = x[2] + (u ? u[2] * s : 0) + (w ? w[2] * t : 0);
  };
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return set(a, null, 0, null, 0);
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return set(b, null, 0, null, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return set(a, ab, d1 / (d1 - d3), null, 0);
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return set(c, null, 0, null, 0);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return set(a, null, 0, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const bc = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    return set(b, bc, w, null, 0);
  }
  const den = 1 / (va + vb + vc);
  return set(a, ab, vb * den, ac, vc * den);
}

export function voxelRemesh(pos: Float32Array, tris: Uint32Array, voxel: number, maxPoints = 24e6): RemeshResult {
  if (!(voxel > 0) || !Number.isFinite(voxel)) throw new Error('Voxel size must be greater than zero');
  const h = voxel;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    minX = Math.min(minX, pos[i]);
    minY = Math.min(minY, pos[i + 1]);
    minZ = Math.min(minZ, pos[i + 2]);
    maxX = Math.max(maxX, pos[i]);
    maxY = Math.max(maxY, pos[i + 1]);
    maxZ = Math.max(maxZ, pos[i + 2]);
  }
  const pad = 2 * h;
  const ox = minX - pad,
    oy = minY - pad,
    oz = minZ - pad;
  const nx = Math.ceil((maxX - minX + 2 * pad) / h) + 1,
    ny = Math.ceil((maxY - minY + 2 * pad) / h) + 1,
    nz = Math.ceil((maxZ - minZ + 2 * pad) / h) + 1;
  const N = nx * ny * nz;
  if (!isFinite(N) || N > maxPoints) throw new Error(`Voxel size too small for this mesh (${nx}×${ny}×${nz} voxels)`);
  const dist = new Float32Array(N).fill(Infinity);
  const sign = new Int8Array(N); // +1 outside, -1 inside (band); 0 unknown
  const best = new Float32Array(N);
  const band = 1.5 * h;
  const a = [0, 0, 0],
    b = [0, 0, 0],
    c = [0, 0, 0],
    p = [0, 0, 0],
    q = [0, 0, 0];
  const ntri = tris.length / 3;
  for (let t = 0; t < ntri; t++) {
    const ia = tris[t * 3] * 3,
      ib = tris[t * 3 + 1] * 3,
      ic = tris[t * 3 + 2] * 3;
    a[0] = pos[ia];
    a[1] = pos[ia + 1];
    a[2] = pos[ia + 2];
    b[0] = pos[ib];
    b[1] = pos[ib + 1];
    b[2] = pos[ib + 2];
    c[0] = pos[ic];
    c[1] = pos[ic + 1];
    c[2] = pos[ic + 2];
    // face normal (for the local inside/outside test)
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    const fnx = uy * vz - uz * vy,
      fny = uz * vx - ux * vz,
      fnz = ux * vy - uy * vx;
    const fl = Math.hypot(fnx, fny, fnz);
    if (fl === 0) continue;
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - band - ox) / h)),
      i1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], b[0], c[0]) + band - ox) / h)),
      j0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - band - oy) / h)),
      j1 = Math.min(ny - 1, Math.ceil((Math.max(a[1], b[1], c[1]) + band - oy) / h)),
      k0 = Math.max(0, Math.floor((Math.min(a[2], b[2], c[2]) - band - oz) / h)),
      k1 = Math.min(nz - 1, Math.ceil((Math.max(a[2], b[2], c[2]) + band - oz) / h));
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          p[0] = ox + i * h;
          p[1] = oy + j * h;
          p[2] = oz + k * h;
          closestPointTriangle(p, a, b, c, q);
          const dx = p[0] - q[0],
            dy = p[1] - q[1],
            dz = p[2] - q[2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d > band) continue;
          const idx = i + nx * (j + ny * k);
          const s = dx * fnx + dy * fny + dz * fnz;
          const align = d > 0 ? Math.abs(s) / (d * fl) : 1;
          // ties (closest point on a shared edge/vertex): the face that faces the point most directly decides the sign
          if (d < dist[idx] - 1e-6 * h || (d <= dist[idx] + 1e-6 * h && align > best[idx])) {
            dist[idx] = Math.min(d, dist[idx]);
            best[idx] = align;
            sign[idx] = s >= 0 ? 1 : -1;
          }
        }
  }
  // flood fill the outside through grid points outside the band
  const outside = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qh = 0,
    qt = 0;
  const push = (idx: number) => {
    if (outside[idx] || dist[idx] !== Infinity) return;
    outside[idx] = 1;
    queue[qt++] = idx;
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push(i + nx * (j + ny * k));
  while (qh < qt) {
    const idx = queue[qh++];
    const i = idx % nx,
      j = Math.floor(idx / nx) % ny,
      k = Math.floor(idx / (nx * ny));
    if (i > 0) push(idx - 1);
    if (i < nx - 1) push(idx + 1);
    if (j > 0) push(idx - nx);
    if (j < ny - 1) push(idx + nx);
    if (k > 0) push(idx - nx * ny);
    if (k < nz - 1) push(idx + nx * ny);
  }
  const phi = new Float32Array(N);
  for (let idx = 0; idx < N; idx++) {
    if (dist[idx] !== Infinity) phi[idx] = sign[idx] * dist[idx];
    else phi[idx] = outside[idx] ? band * 2 : -band * 2;
  }
  // surface nets: one vertex per cell with a sign change
  const cnx = nx - 1,
    cny = ny - 1,
    cnz = nz - 1;
  const cellVert = new Int32Array(cnx * cny * cnz).fill(-1);
  const verts: number[] = [];
  const corner = new Float32Array(8);
  const EDGES = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  for (let k = 0; k < cnz; k++)
    for (let j = 0; j < cny; j++)
      for (let i = 0; i < cnx; i++) {
        let neg = 0;
        for (let m = 0; m < 8; m++) {
          const di = m & 1,
            dj = (m >> 1) & 1,
            dk = (m >> 2) & 1;
          const v = phi[i + di + nx * (j + dj + ny * (k + dk))];
          corner[m] = v;
          if (v < 0) neg++;
        }
        if (neg === 0 || neg === 8) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          cnt = 0;
        for (const [e0, e1] of EDGES) {
          const v0 = corner[e0],
            v1 = corner[e1];
          if (v0 < 0 === v1 < 0) continue;
          const t = v0 / (v0 - v1);
          const x0 = e0 & 1,
            y0 = (e0 >> 1) & 1,
            z0 = (e0 >> 2) & 1,
            x1 = e1 & 1,
            y1 = (e1 >> 1) & 1,
            z1 = (e1 >> 2) & 1;
          sx += x0 + (x1 - x0) * t;
          sy += y0 + (y1 - y0) * t;
          sz += z0 + (z1 - z0) * t;
          cnt++;
        }
        cellVert[i + cnx * (j + cny * k)] = verts.length / 3;
        verts.push(ox + (i + sx / cnt) * h, oy + (j + sy / cnt) * h, oz + (k + sz / cnt) * h);
      }
  // quads: every grid edge with a sign change is surrounded by four cells
  const quads: number[] = [];
  const cell = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= cnx || j >= cny || k >= cnz ? -1 : cellVert[i + cnx * (j + cny * k)]);
  const emit = (q0: number, q1: number, q2: number, q3: number, flip: boolean) => {
    if (q0 < 0 || q1 < 0 || q2 < 0 || q3 < 0) return;
    if (!flip) quads.push(q0, q3, q2, q1);
    else quads.push(q0, q1, q2, q3);
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const v0 = phi[i + nx * (j + ny * k)];
        // x edge
        if (i < nx - 1 && j > 0 && k > 0) {
          const v1 = phi[i + 1 + nx * (j + ny * k)];
          if (v0 < 0 !== v1 < 0) emit(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), v0 < 0);
        }
        // y edge
        if (j < ny - 1 && i > 0 && k > 0) {
          const v1 = phi[i + nx * (j + 1 + ny * k)];
          if (v0 < 0 !== v1 < 0) emit(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), v0 < 0);
        }
        // z edge
        if (k < nz - 1 && i > 0 && j > 0) {
          const v1 = phi[i + nx * (j + ny * (k + 1))];
          if (v0 < 0 !== v1 < 0) emit(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), v0 < 0);
        }
      }
  return { positions: new Float32Array(verts), quads: new Uint32Array(quads) };
}
