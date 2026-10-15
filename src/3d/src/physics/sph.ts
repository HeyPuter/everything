// Fluid particles: after the usual integration, particles closer than the interaction radius are
// pushed apart or pulled together towards a rest density (with a near-density term against
// clumping) and their relative velocities are damped by viscosity (double density relaxation).
import { NeighbourGrid } from './boids';

export interface ParticleFluidSettings {
  /** interaction radius (metres) */
  fluid_radius: number;
  stiffness: number;
  stiffness_near: number;
  rest_density: number;
  linear_viscosity: number;
  square_viscosity: number;
}

export function defaultParticleFluid(): ParticleFluidSettings {
  return { fluid_radius: 0.3, stiffness: 1, stiffness_near: 1, rest_density: 1, linear_viscosity: 0.2, square_viscosity: 0 };
}

/**
 * Relax positions of alive particles (in place) after an integration step of `h` seconds from
 * `prev`; velocities are recomputed from the displacement.
 */
export function relaxFluid(f: ParticleFluidSettings, pos: Float32Array, vel: Float32Array, prev: Float32Array, alive: (i: number) => boolean, n: number, h: number) {
  const r = Math.max(1e-3, f.fluid_radius);
  const grid = new NeighbourGrid(pos, r, alive, n);
  // viscosity impulses on velocities (pairs approaching each other)
  const lin = Math.max(0, f.linear_viscosity),
    sq = Math.max(0, f.square_viscosity);
  if (lin || sq)
    for (let i = 0; i < n; i++) {
      if (!alive(i)) continue;
      grid.each(i, r, (j, dx, dy, dz, d) => {
        if (j < i || d < 1e-9) return;
        const nx = dx / d,
          ny = dy / d,
          nz = dz / d;
        const u = (vel[i * 3] - vel[j * 3]) * nx + (vel[i * 3 + 1] - vel[j * 3 + 1]) * ny + (vel[i * 3 + 2] - vel[j * 3 + 2]) * nz;
        if (u <= 0) return;
        const q = 1 - d / r;
        const I = Math.min(u * 0.5, h * q * (lin * u + sq * u * u) * 0.5);
        // the impulse changes the velocities and the positions they were integrated to
        for (const [a, sgn] of [
          [i, -1],
          [j, 1],
        ] as const) {
          vel[a * 3] += sgn * I * nx;
          vel[a * 3 + 1] += sgn * I * ny;
          vel[a * 3 + 2] += sgn * I * nz;
          pos[a * 3] += sgn * I * nx * h;
          pos[a * 3 + 1] += sgn * I * ny * h;
          pos[a * 3 + 2] += sgn * I * nz * h;
        }
      });
    }
  // double density relaxation
  const k = Math.max(0, f.stiffness) * 0.5,
    kn = Math.max(0, f.stiffness_near) * 0.5;
  const rho0 = Math.max(0.01, f.rest_density);
  const disp = new Float32Array(pos.length);
  for (let i = 0; i < n; i++) {
    if (!alive(i)) continue;
    let rho = 0,
      rhoN = 0;
    grid.each(i, r, (_j, _dx, _dy, _dz, d) => {
      const q = 1 - d / r;
      rho += q * q;
      rhoN += q * q * q;
    });
    const P = k * (rho - rho0),
      PN = kn * rhoN;
    grid.each(i, r, (j, dx, dy, dz, d) => {
      if (d < 1e-9) return;
      const q = 1 - d / r;
      const D = (P * q + PN * q * q) * r * 0.25;
      const ux = (dx / d) * D,
        uy = (dy / d) * D,
        uz = (dz / d) * D;
      disp[j * 3] += ux * 0.5;
      disp[j * 3 + 1] += uy * 0.5;
      disp[j * 3 + 2] += uz * 0.5;
      disp[i * 3] -= ux * 0.5;
      disp[i * 3 + 1] -= uy * 0.5;
      disp[i * 3 + 2] -= uz * 0.5;
    });
  }
  for (let i = 0; i < n; i++) {
    if (!alive(i)) continue;
    for (let c = 0; c < 3; c++) {
      const a = i * 3 + c;
      // limit the correction per step so dense starts do not explode
      const dd = Math.max(-r * 0.5, Math.min(r * 0.5, disp[a]));
      pos[a] += dd;
      if (h > 0) vel[a] = (pos[a] - prev[a]) / h;
    }
  }
}
