// Liquid solver: FLIP particles on a uniform grid (cell size 1, velocities in cells per second).
// Each step transfers particle velocities to the grid, applies gravity, makes the velocity field
// divergence free inside the liquid (pressure is zero in air, walls and solids are closed),
// transfers the change back to the particles (FLIP blended with PIC) and moves the particles.
// Everything is deterministic for the same inputs.

export interface LiquidGrid {
  nx: number;
  ny: number;
  nz: number;
  /** particles: positions (grid units) and velocities (cells/s) */
  px: Float32Array;
  pv: Float32Array;
  count: number;
  /** 1 = solid cell (effector) */
  solid: Uint8Array;
  // grid fields (cell centred)
  u: Float32Array;
  v: Float32Array;
  w: Float32Array;
  uOld: Float32Array;
  vOld: Float32Array;
  wOld: Float32Array;
  weight: Float32Array;
  liquid: Uint8Array;
  p: Float32Array;
  div: Float32Array;
}

export interface LiquidParams {
  dt: number;
  /** gravity in cells/s² (grid axes) */
  gravity: [number, number, number];
  flip: number;
  pressureIterations: number;
  /** open borders (liquid leaves the domain): -x +x -y +y -z +z */
  open: [boolean, boolean, boolean, boolean, boolean, boolean];
  /** extra acceleration per cell (force fields), grid units */
  accel?: Float32Array | null;
}

export function newLiquidGrid(nx: number, ny: number, nz: number, capacity = 1024): LiquidGrid {
  const n = nx * ny * nz;
  const f = () => new Float32Array(n);
  return { nx, ny, nz, px: new Float32Array(capacity * 3), pv: new Float32Array(capacity * 3), count: 0, solid: new Uint8Array(n), u: f(), v: f(), w: f(), uOld: f(), vOld: f(), wOld: f(), weight: f(), liquid: new Uint8Array(n), p: f(), div: f() };
}

export function addParticle(g: LiquidGrid, x: number, y: number, z: number, vx: number, vy: number, vz: number) {
  if (g.count * 3 >= g.px.length) {
    const cap = Math.max(1024, g.px.length * 2);
    const npx = new Float32Array(cap),
      npv = new Float32Array(cap);
    npx.set(g.px);
    npv.set(g.pv);
    g.px = npx;
    g.pv = npv;
  }
  const i = g.count * 3;
  g.px[i] = x;
  g.px[i + 1] = y;
  g.px[i + 2] = z;
  g.pv[i] = vx;
  g.pv[i + 1] = vy;
  g.pv[i + 2] = vz;
  g.count++;
}

/** Remove particles for which `drop(index)` is true (keeps order). */
export function removeParticles(g: LiquidGrid, drop: (x: number, y: number, z: number) => boolean) {
  let o = 0;
  for (let i = 0; i < g.count; i++) {
    const a = i * 3;
    if (drop(g.px[a], g.px[a + 1], g.px[a + 2])) continue;
    if (o !== i) {
      g.px.copyWithin(o * 3, a, a + 3);
      g.pv.copyWithin(o * 3, a, a + 3);
    }
    o++;
  }
  g.count = o;
}

const clampi = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);

/** Trilinear sample of a cell-centred field at a grid position. */
export function sampleField(a: Float32Array, g: LiquidGrid, x: number, y: number, z: number): number {
  const { nx, ny, nz } = g;
  x = Math.min(nx - 1.0001, Math.max(0, x - 0.5));
  y = Math.min(ny - 1.0001, Math.max(0, y - 0.5));
  z = Math.min(nz - 1.0001, Math.max(0, z - 0.5));
  const i = Math.floor(x),
    j = Math.floor(y),
    k = Math.floor(z);
  const fx = x - i,
    fy = y - j,
    fz = z - k;
  const i1 = Math.min(i + 1, nx - 1),
    j1 = Math.min(j + 1, ny - 1),
    k1 = Math.min(k + 1, nz - 1);
  const at = (a0: number, b0: number, c0: number) => a[a0 + b0 * nx + c0 * nx * ny];
  const c00 = at(i, j, k) * (1 - fx) + at(i1, j, k) * fx;
  const c10 = at(i, j1, k) * (1 - fx) + at(i1, j1, k) * fx;
  const c01 = at(i, j, k1) * (1 - fx) + at(i1, j, k1) * fx;
  const c11 = at(i, j1, k1) * (1 - fx) + at(i1, j1, k1) * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}

function particlesToGrid(g: LiquidGrid) {
  const { nx, ny, nz, u, v, w, weight, liquid } = g;
  u.fill(0);
  v.fill(0);
  w.fill(0);
  weight.fill(0);
  liquid.fill(0);
  for (let p = 0; p < g.count; p++) {
    const a = p * 3;
    const x = g.px[a] - 0.5,
      y = g.px[a + 1] - 0.5,
      z = g.px[a + 2] - 0.5;
    const i0 = Math.floor(x),
      j0 = Math.floor(y),
      k0 = Math.floor(z);
    const fx = x - i0,
      fy = y - j0,
      fz = z - k0;
    for (let c = 0; c < 8; c++) {
      const i = i0 + (c & 1),
        j = j0 + ((c >> 1) & 1),
        k = k0 + ((c >> 2) & 1);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
      const wt = (c & 1 ? fx : 1 - fx) * ((c >> 1) & 1 ? fy : 1 - fy) * ((c >> 2) & 1 ? fz : 1 - fz);
      const o = i + j * nx + k * nx * ny;
      u[o] += g.pv[a] * wt;
      v[o] += g.pv[a + 1] * wt;
      w[o] += g.pv[a + 2] * wt;
      weight[o] += wt;
    }
    const ci = clampi(Math.floor(g.px[a]), nx),
      cj = clampi(Math.floor(g.px[a + 1]), ny),
      ck = clampi(Math.floor(g.px[a + 2]), nz);
    liquid[ci + cj * nx + ck * nx * ny] = 1;
  }
  const n = nx * ny * nz;
  for (let o = 0; o < n; o++)
    if (weight[o] > 1e-6) {
      u[o] /= weight[o];
      v[o] /= weight[o];
      w[o] /= weight[o];
    }
}

/** Velocity pointing into a wall or a solid cell is removed. */
function enforceBoundaries(g: LiquidGrid, P: LiquidParams) {
  const { nx, ny, nz, u, v, w, solid } = g;
  let o = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        if (solid[o]) {
          u[o] = v[o] = w[o] = 0;
          continue;
        }
        if ((i === 0 && !P.open[0] && u[o] < 0) || (i > 0 && solid[o - 1] && u[o] < 0)) u[o] = 0;
        if ((i === nx - 1 && !P.open[1] && u[o] > 0) || (i < nx - 1 && solid[o + 1] && u[o] > 0)) u[o] = 0;
        if ((j === 0 && !P.open[2] && v[o] < 0) || (j > 0 && solid[o - nx] && v[o] < 0)) v[o] = 0;
        if ((j === ny - 1 && !P.open[3] && v[o] > 0) || (j < ny - 1 && solid[o + nx] && v[o] > 0)) v[o] = 0;
        if ((k === 0 && !P.open[4] && w[o] < 0) || (k > 0 && solid[o - nx * ny] && w[o] < 0)) w[o] = 0;
        if ((k === nz - 1 && !P.open[5] && w[o] > 0) || (k < nz - 1 && solid[o + nx * ny] && w[o] > 0)) w[o] = 0;
      }
}

/** Pressure projection over liquid cells (air cells have zero pressure, walls and solids are closed). */
function project(g: LiquidGrid, P: LiquidParams) {
  const { nx, ny, nz, u, v, w, liquid, solid, p, div } = g;
  const sy = nx,
    sz = nx * ny;
  const n = nx * ny * nz;
  // divergence (central differences of the cell-centred velocities)
  let o = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        if (!liquid[o] || solid[o]) {
          div[o] = 0;
          continue;
        }
        const ux1 = i < nx - 1 ? u[o + 1] : P.open[1] ? u[o] : -u[o],
          ux0 = i > 0 ? u[o - 1] : P.open[0] ? u[o] : -u[o];
        const vy1 = j < ny - 1 ? v[o + sy] : P.open[3] ? v[o] : -v[o],
          vy0 = j > 0 ? v[o - sy] : P.open[2] ? v[o] : -v[o];
        const wz1 = k < nz - 1 ? w[o + sz] : P.open[5] ? w[o] : -w[o],
          wz0 = k > 0 ? w[o - sz] : P.open[4] ? w[o] : -w[o];
        div[o] = 0.5 * (ux1 - ux0 + vy1 - vy0 + wz1 - wz0);
      }
  // conjugate gradient on the liquid cells: d·p_o − Σ p_liquid-neighbours = −div, where d counts the
  // neighbours that are not solid (air and open borders are zero pressure, solids and walls are closed)
  p.fill(0);
  const cells: number[] = [];
  const diag = new Float32Array(n);
  o = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        if (!liquid[o] || solid[o]) continue;
        let d = 0;
        const side = (inside: boolean, q: number, openSide: boolean) => {
          if (!inside) d += openSide ? 1 : 0;
          else if (!solid[q]) d++;
        };
        side(i > 0, o - 1, P.open[0]);
        side(i < nx - 1, o + 1, P.open[1]);
        side(j > 0, o - sy, P.open[2]);
        side(j < ny - 1, o + sy, P.open[3]);
        side(k > 0, o - sz, P.open[4]);
        side(k < nz - 1, o + sz, P.open[5]);
        diag[o] = d;
        if (d > 0) cells.push(o);
      }
  const m = cells.length;
  if (m) {
    const idx = new Int32Array(n).fill(-1);
    cells.forEach((c, q) => (idx[c] = q));
    // liquid neighbours of every unknown (-1: none)
    const nbIdx = new Int32Array(m * 6).fill(-1);
    for (let q = 0; q < m; q++) {
      const c = cells[q];
      const ci = c % nx,
        cj = Math.floor(c / nx) % ny,
        ck = Math.floor(c / sz);
      if (ci > 0) nbIdx[q * 6] = idx[c - 1];
      if (ci < nx - 1) nbIdx[q * 6 + 1] = idx[c + 1];
      if (cj > 0) nbIdx[q * 6 + 2] = idx[c - sy];
      if (cj < ny - 1) nbIdx[q * 6 + 3] = idx[c + sy];
      if (ck > 0) nbIdx[q * 6 + 4] = idx[c - sz];
      if (ck < nz - 1) nbIdx[q * 6 + 5] = idx[c + sz];
    }
    const xv = new Float64Array(m),
      r = new Float64Array(m),
      dv = new Float64Array(m),
      Ad = new Float64Array(m);
    for (let q = 0; q < m; q++) r[q] = -div[cells[q]];
    dv.set(r);
    let rr = 0;
    for (let q = 0; q < m; q++) rr += r[q] * r[q];
    const tol = 1e-8 * Math.max(1, rr);
    for (let it = 0; it < P.pressureIterations && rr > tol; it++) {
      for (let q = 0; q < m; q++) {
        let a = diag[cells[q]] * dv[q];
        for (let t = q * 6; t < q * 6 + 6; t++) {
          const qq = nbIdx[t];
          if (qq >= 0) a -= dv[qq];
        }
        Ad[q] = a;
      }
      let dAd = 0;
      for (let q = 0; q < m; q++) dAd += dv[q] * Ad[q];
      if (Math.abs(dAd) < 1e-30) break;
      const alpha = rr / dAd;
      let rr2 = 0;
      for (let q = 0; q < m; q++) {
        xv[q] += alpha * dv[q];
        r[q] -= alpha * Ad[q];
        rr2 += r[q] * r[q];
      }
      const beta = rr2 / rr;
      rr = rr2;
      for (let q = 0; q < m; q++) dv[q] = r[q] + beta * dv[q];
    }
    for (let q = 0; q < m; q++) p[cells[q]] = xv[q];
  }
  // subtract the pressure gradient
  const pAt = (q: number, valid: boolean, self: number) => (!valid ? self : solid[q] ? self : liquid[q] ? p[q] : 0);
  o = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        if (!liquid[o] || solid[o]) continue;
        const po = p[o];
        u[o] -= 0.5 * (pAt(o + 1, i < nx - 1, P.open[1] ? 0 : po) - pAt(o - 1, i > 0, P.open[0] ? 0 : po));
        v[o] -= 0.5 * (pAt(o + sy, j < ny - 1, P.open[3] ? 0 : po) - pAt(o - sy, j > 0, P.open[2] ? 0 : po));
        w[o] -= 0.5 * (pAt(o + sz, k < nz - 1, P.open[5] ? 0 : po) - pAt(o - sz, k > 0, P.open[4] ? 0 : po));
      }
}

/** One time step of the liquid. */
export function stepLiquid(g: LiquidGrid, P: LiquidParams) {
  if (!g.count) return;
  particlesToGrid(g);
  const n = g.nx * g.ny * g.nz;
  // grow the velocity field one cell into the air so particles near the surface sample sensible values
  extrapolate(g);
  g.uOld.set(g.u);
  g.vOld.set(g.v);
  g.wOld.set(g.w);
  const A = P.accel;
  for (let o = 0; o < n; o++) {
    g.u[o] += (P.gravity[0] + (A ? A[o * 3] : 0)) * P.dt;
    g.v[o] += (P.gravity[1] + (A ? A[o * 3 + 1] : 0)) * P.dt;
    g.w[o] += (P.gravity[2] + (A ? A[o * 3 + 2] : 0)) * P.dt;
  }
  enforceBoundaries(g, P);
  project(g, P);
  enforceBoundaries(g, P);
  extrapolate(g);
  // grid → particles (FLIP / PIC blend)
  for (let p = 0; p < g.count; p++) {
    const a = p * 3;
    const x = g.px[a],
      y = g.px[a + 1],
      z = g.px[a + 2];
    const nu = sampleField(g.u, g, x, y, z),
      nv = sampleField(g.v, g, x, y, z),
      nw = sampleField(g.w, g, x, y, z);
    const du = nu - sampleField(g.uOld, g, x, y, z),
      dv = nv - sampleField(g.vOld, g, x, y, z),
      dw = nw - sampleField(g.wOld, g, x, y, z);
    g.pv[a] = P.flip * (g.pv[a] + du) + (1 - P.flip) * nu;
    g.pv[a + 1] = P.flip * (g.pv[a + 1] + dv) + (1 - P.flip) * nv;
    g.pv[a + 2] = P.flip * (g.pv[a + 2] + dw) + (1 - P.flip) * nw;
  }
  // move particles (midpoint), keep them out of solids and inside closed walls
  const { nx, ny, nz } = g;
  for (let p = 0; p < g.count; p++) {
    const a = p * 3;
    const x = g.px[a],
      y = g.px[a + 1],
      z = g.px[a + 2];
    const mx = x + 0.5 * P.dt * sampleField(g.u, g, x, y, z),
      my = y + 0.5 * P.dt * sampleField(g.v, g, x, y, z),
      mz = z + 0.5 * P.dt * sampleField(g.w, g, x, y, z);
    let nx2 = x + P.dt * sampleField(g.u, g, mx, my, mz),
      ny2 = y + P.dt * sampleField(g.v, g, mx, my, mz),
      nz2 = z + P.dt * sampleField(g.w, g, mx, my, mz);
    const lo = 0.01;
    if (!P.open[0] && nx2 < lo) (nx2 = lo), (g.pv[a] = Math.max(0, g.pv[a]));
    if (!P.open[1] && nx2 > nx - lo) (nx2 = nx - lo), (g.pv[a] = Math.min(0, g.pv[a]));
    if (!P.open[2] && ny2 < lo) (ny2 = lo), (g.pv[a + 1] = Math.max(0, g.pv[a + 1]));
    if (!P.open[3] && ny2 > ny - lo) (ny2 = ny - lo), (g.pv[a + 1] = Math.min(0, g.pv[a + 1]));
    if (!P.open[4] && nz2 < lo) (nz2 = lo), (g.pv[a + 2] = Math.max(0, g.pv[a + 2]));
    if (!P.open[5] && nz2 > nz - lo) (nz2 = nz - lo), (g.pv[a + 2] = Math.min(0, g.pv[a + 2]));
    // entering a solid cell: stay where it was
    const ci = Math.floor(nx2),
      cj = Math.floor(ny2),
      ck = Math.floor(nz2);
    if (ci >= 0 && cj >= 0 && ck >= 0 && ci < nx && cj < ny && ck < nz && g.solid[ci + cj * nx + ck * nx * ny]) {
      g.pv[a] = g.pv[a + 1] = g.pv[a + 2] = 0;
      continue;
    }
    g.px[a] = nx2;
    g.px[a + 1] = ny2;
    g.px[a + 2] = nz2;
  }
  // particles that left through open borders are removed
  if (P.open.some(Boolean)) removeParticles(g, (x, y, z) => x < 0 || y < 0 || z < 0 || x > nx || y > ny || z > nz);
}

/** Copy velocities from liquid cells into neighbouring air cells (two layers). */
function extrapolate(g: LiquidGrid) {
  const { nx, ny, nz, u, v, w } = g;
  const n = nx * ny * nz;
  const known = new Uint8Array(n);
  for (let o = 0; o < n; o++) known[o] = g.liquid[o] && !g.solid[o] ? 1 : 0;
  for (let layer = 0; layer < 2; layer++) {
    const add: number[] = [];
    let o = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++, o++) {
          if (known[o] || g.solid[o]) continue;
          let su = 0,
            sv = 0,
            sw = 0,
            c = 0;
          const take = (q: number) => {
            if (!known[q]) return;
            su += u[q];
            sv += v[q];
            sw += w[q];
            c++;
          };
          if (i > 0) take(o - 1);
          if (i < nx - 1) take(o + 1);
          if (j > 0) take(o - nx);
          if (j < ny - 1) take(o + nx);
          if (k > 0) take(o - nx * ny);
          if (k < nz - 1) take(o + nx * ny);
          if (c) {
            u[o] = su / c;
            v[o] = sv / c;
            w[o] = sw / c;
            add.push(o);
          }
        }
    for (const q of add) known[q] = 1;
  }
}
