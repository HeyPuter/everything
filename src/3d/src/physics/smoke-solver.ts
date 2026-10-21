// Coarse gas solver for smoke and fire: a uniform 3D grid with semi-Lagrangian
// advection, buoyancy, vorticity confinement, a Jacobi pressure projection, fuel
// burning and dissipation (stable-fluids style). Grid units: velocities are in
// cells per second.

export interface GasGrid {
  nx: number;
  ny: number;
  nz: number;
  density: Float32Array;
  fuel: Float32Array;
  flame: Float32Array;
  heat: Float32Array;
  u: Float32Array;
  v: Float32Array;
  w: Float32Array;
  /** 1 = solid (effector) */
  solid: Uint8Array;
  // scratch
  tmp: Float32Array;
  tmp2: Float32Array;
  tmp3: Float32Array;
  p: Float32Array;
  div: Float32Array;
}

export interface GasParams {
  dt: number;
  /** buoyancy acceleration direction (unit, grid axes) and magnitude (cells/s² per unit) */
  up: [number, number, number];
  gravity: number;
  alpha: number;
  beta: number;
  vorticity: number;
  flameVorticity: number;
  burningRate: number;
  flameSmoke: number;
  flameMaxTemp: number;
  /** lowest temperature of burning fuel (flames heat between this and the maximum) */
  flameIgnition?: number;
  /** dissolve rate per second; linear dissolving removes a fixed amount instead of a fraction */
  dissolve: number;
  dissolveLinear?: boolean;
  heatDecay: number;
  pressureIterations: number;
  /** closed borders: -x +x -y +y -z +z */
  closed: [boolean, boolean, boolean, boolean, boolean, boolean];
}

export function newGrid(nx: number, ny: number, nz: number): GasGrid {
  const n = nx * ny * nz;
  const f = () => new Float32Array(n);
  return { nx, ny, nz, density: f(), fuel: f(), flame: f(), heat: f(), u: f(), v: f(), w: f(), solid: new Uint8Array(n), tmp: f(), tmp2: f(), tmp3: f(), p: f(), div: f() };
}

/** Trilinear sample with zero outside the grid (open borders) or clamped (closed). */
function sample(a: Float32Array, g: GasGrid, x: number, y: number, z: number, clampEdge: boolean): number {
  const { nx, ny, nz } = g;
  x -= 0.5;
  y -= 0.5;
  z -= 0.5;
  if (!clampEdge && (x < -1 || y < -1 || z < -1 || x > nx || y > ny || z > nz)) return 0;
  x = Math.min(nx - 1.001, Math.max(0, x));
  y = Math.min(ny - 1.001, Math.max(0, y));
  z = Math.min(nz - 1.001, Math.max(0, z));
  const i = Math.floor(x),
    j = Math.floor(y),
    k = Math.floor(z);
  const fx = x - i,
    fy = y - j,
    fz = z - k;
  const sx = 1,
    sy = nx,
    sz = nx * ny;
  const o = i + j * sy + k * sz;
  const i1 = i + 1 < nx ? sx : 0,
    j1 = j + 1 < ny ? sy : 0,
    k1 = k + 1 < nz ? sz : 0;
  const c00 = a[o] * (1 - fx) + a[o + i1] * fx;
  const c10 = a[o + j1] * (1 - fx) + a[o + j1 + i1] * fx;
  const c01 = a[o + k1] * (1 - fx) + a[o + k1 + i1] * fx;
  const c11 = a[o + k1 + j1] * (1 - fx) + a[o + k1 + j1 + i1] * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}

function advect(g: GasGrid, src: Float32Array, dst: Float32Array, dt: number, clampEdge: boolean) {
  const { nx, ny, nz, u, v, w } = g;
  let o = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        if (g.solid[o]) {
          dst[o] = 0;
          continue;
        }
        // backtrace (midpoint / RK2)
        const x = i + 0.5,
          y = j + 0.5,
          z = k + 0.5;
        const mx = x - 0.5 * dt * u[o],
          my = y - 0.5 * dt * v[o],
          mz = z - 0.5 * dt * w[o];
        const um = sample(u, g, mx, my, mz, true),
          vm = sample(v, g, mx, my, mz, true),
          wm = sample(w, g, mx, my, mz, true);
        dst[o] = sample(src, g, x - dt * um, y - dt * vm, z - dt * wm, clampEdge);
      }
}

function swap(g: GasGrid, key: 'density' | 'fuel' | 'flame' | 'heat' | 'u' | 'v' | 'w', which: 'tmp' | 'tmp2' | 'tmp3') {
  const a = g[key];
  g[key] = g[which];
  g[which] = a;
}

function vorticityConfinement(g: GasGrid, P: GasParams) {
  const { nx, ny, nz, u, v, w } = g;
  const sy = nx,
    sz = nx * ny;
  const n = nx * ny * nz;
  const ox = g.tmp,
    oy = g.tmp2,
    oz = g.tmp3,
    mag = g.div;
  const eps = P.vorticity;
  const feps = P.flameVorticity;
  if (eps <= 0 && feps <= 0) return;
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const o = i + j * sy + k * sz;
        const wy = (w[o + sy] - w[o - sy]) * 0.5,
          vz = (v[o + sz] - v[o - sz]) * 0.5;
        const uz = (u[o + sz] - u[o - sz]) * 0.5,
          wx = (w[o + 1] - w[o - 1]) * 0.5;
        const vx = (v[o + 1] - v[o - 1]) * 0.5,
          uy = (u[o + sy] - u[o - sy]) * 0.5;
        ox[o] = wy - vz;
        oy[o] = uz - wx;
        oz[o] = vx - uy;
        mag[o] = Math.hypot(ox[o], oy[o], oz[o]);
      }
  for (let k = 2; k < nz - 2; k++)
    for (let j = 2; j < ny - 2; j++)
      for (let i = 2; i < nx - 2; i++) {
        const o = i + j * sy + k * sz;
        let gx = (mag[o + 1] - mag[o - 1]) * 0.5,
          gy = (mag[o + sy] - mag[o - sy]) * 0.5,
          gz = (mag[o + sz] - mag[o - sz]) * 0.5;
        const l = Math.hypot(gx, gy, gz);
        if (l < 1e-6) continue;
        gx /= l;
        gy /= l;
        gz /= l;
        const e = (eps + feps * Math.min(1, g.flame[o])) * P.dt;
        u[o] += e * (gy * oz[o] - gz * oy[o]);
        v[o] += e * (gz * ox[o] - gx * oz[o]);
        w[o] += e * (gx * oy[o] - gy * ox[o]);
      }
  void n;
}

function project(g: GasGrid, P: GasParams) {
  const { nx, ny, nz, u, v, w, p, div, solid } = g;
  const sy = nx,
    sz = nx * ny;
  const [cxm, cxp, cym, cyp, czm, czp] = P.closed;
  // velocity at a neighbour (solid / closed wall → 0)
  let o = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        if (solid[o]) {
          div[o] = 0;
          continue;
        }
        const ue = i + 1 < nx ? (solid[o + 1] ? 0 : u[o + 1]) : cxp ? -u[o] : u[o];
        const uw = i > 0 ? (solid[o - 1] ? 0 : u[o - 1]) : cxm ? -u[o] : u[o];
        const vn = j + 1 < ny ? (solid[o + sy] ? 0 : v[o + sy]) : cyp ? -v[o] : v[o];
        const vs = j > 0 ? (solid[o - sy] ? 0 : v[o - sy]) : cym ? -v[o] : v[o];
        const wt = k + 1 < nz ? (solid[o + sz] ? 0 : w[o + sz]) : czp ? -w[o] : w[o];
        const wb = k > 0 ? (solid[o - sz] ? 0 : w[o - sz]) : czm ? -w[o] : w[o];
        div[o] = -0.5 * (ue - uw + vn - vs + wt - wb);
      }
  p.fill(0);
  const q = g.tmp;
  for (let it = 0; it < P.pressureIterations; it++) {
    o = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++, o++) {
          if (solid[o]) {
            q[o] = 0;
            continue;
          }
          const pc = p[o];
          // closed wall / solid: Neumann (copy centre); open wall: Dirichlet p = 0
          const pe = i + 1 < nx ? (solid[o + 1] ? pc : p[o + 1]) : cxp ? pc : 0;
          const pw = i > 0 ? (solid[o - 1] ? pc : p[o - 1]) : cxm ? pc : 0;
          const pn = j + 1 < ny ? (solid[o + sy] ? pc : p[o + sy]) : cyp ? pc : 0;
          const ps = j > 0 ? (solid[o - sy] ? pc : p[o - sy]) : cym ? pc : 0;
          const pt = k + 1 < nz ? (solid[o + sz] ? pc : p[o + sz]) : czp ? pc : 0;
          const pb = k > 0 ? (solid[o - sz] ? pc : p[o - sz]) : czm ? pc : 0;
          q[o] = (div[o] + pe + pw + pn + ps + pt + pb) / 6;
        }
    p.set(q);
  }
  o = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        if (solid[o]) {
          u[o] = v[o] = w[o] = 0;
          continue;
        }
        const pc = p[o];
        const pe = i + 1 < nx ? (solid[o + 1] ? pc : p[o + 1]) : cxp ? pc : 0;
        const pw = i > 0 ? (solid[o - 1] ? pc : p[o - 1]) : cxm ? pc : 0;
        const pn = j + 1 < ny ? (solid[o + sy] ? pc : p[o + sy]) : cyp ? pc : 0;
        const ps = j > 0 ? (solid[o - sy] ? pc : p[o - sy]) : cym ? pc : 0;
        const pt = k + 1 < nz ? (solid[o + sz] ? pc : p[o + sz]) : czp ? pc : 0;
        const pb = k > 0 ? (solid[o - sz] ? pc : p[o - sz]) : czm ? pc : 0;
        u[o] -= 0.5 * (pe - pw);
        v[o] -= 0.5 * (pn - ps);
        w[o] -= 0.5 * (pt - pb);
        // closed walls: no flow through them
        if ((i === 0 && cxm && u[o] < 0) || (i === nx - 1 && cxp && u[o] > 0)) u[o] = 0;
        if ((j === 0 && cym && v[o] < 0) || (j === ny - 1 && cyp && v[o] > 0)) v[o] = 0;
        if ((k === 0 && czm && w[o] < 0) || (k === nz - 1 && czp && w[o] > 0)) w[o] = 0;
      }
}

/** Advance the gas by one time step (emission must already be applied). */
export function stepGas(g: GasGrid, P: GasParams) {
  const n = g.nx * g.ny * g.nz;
  const dt = P.dt;
  // fire: burn fuel → heat, flame, smoke
  if (P.burningRate > 0) {
    const rate = Math.min(1, P.burningRate * dt * 8);
    for (let o = 0; o < n; o++) {
      const f = g.fuel[o];
      if (f <= 1e-4) {
        g.flame[o] *= 0.5;
        if (f > 0) g.fuel[o] = 0;
        continue;
      }
      const burn = f * rate;
      g.fuel[o] = f - burn;
      g.flame[o] = Math.min(1, Math.max(g.flame[o] * 0.5, f));
      const ign = Math.min(P.flameMaxTemp, P.flameIgnition ?? 0);
      g.heat[o] = Math.max(g.heat[o], ign + (P.flameMaxTemp - ign) * Math.min(1, g.flame[o]), Math.min(P.flameMaxTemp, g.heat[o] + burn * P.flameMaxTemp * 4));
      g.density[o] += burn * P.flameSmoke;
    }
  }
  // buoyancy (hot gas rises, dense smoke sinks)
  const [ux, uy, uz] = P.up;
  for (let o = 0; o < n; o++) {
    const b = (P.beta * g.heat[o] * 0.4 - P.alpha * g.density[o] * 0.1) * P.gravity * dt;
    if (b === 0) continue;
    g.u[o] += ux * b;
    g.v[o] += uy * b;
    g.w[o] += uz * b;
  }
  vorticityConfinement(g, P);
  project(g, P);
  // advect velocity
  advect(g, g.u, g.tmp, dt, true);
  advect(g, g.v, g.tmp2, dt, true);
  advect(g, g.w, g.tmp3, dt, true);
  swap(g, 'u', 'tmp');
  swap(g, 'v', 'tmp2');
  swap(g, 'w', 'tmp3');
  project(g, P);
  // advect scalars (open borders let smoke leave)
  const openAll = !P.closed.every(Boolean);
  advect(g, g.density, g.tmp, dt, !openAll);
  swap(g, 'density', 'tmp');
  advect(g, g.heat, g.tmp, dt, !openAll);
  swap(g, 'heat', 'tmp');
  if (P.burningRate > 0) {
    advect(g, g.fuel, g.tmp, dt, !openAll);
    swap(g, 'fuel', 'tmp');
    advect(g, g.flame, g.tmp, dt, !openAll);
    swap(g, 'flame', 'tmp');
  }
  // dissipation
  const keep = P.dissolveLinear ? 1 : Math.max(0, 1 - P.dissolve * dt);
  const sub = P.dissolveLinear ? P.dissolve * dt : 0;
  const cool = Math.max(0, 1 - P.heatDecay * dt);
  for (let o = 0; o < n; o++) {
    if (keep < 1) g.density[o] *= keep;
    if (sub > 0) g.density[o] = Math.max(0, g.density[o] - sub);
    g.heat[o] *= cool;
    if (g.density[o] < 1e-5) g.density[o] = 0;
  }
}
