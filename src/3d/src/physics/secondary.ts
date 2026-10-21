// Secondary liquid particles: spray, foam and bubbles generated from the liquid particles.
// Each liquid particle near the surface gets potentials for breaking wave crests and trapped air
// (scaled by its kinetic energy); they decide how many new particles it sheds per frame. The new
// particles are classified every frame by how much liquid surrounds them: little liquid → spray
// (falls ballistically), at the surface → foam (rides on the liquid, ages and disappears), inside →
// bubbles (rise against gravity with drag towards the liquid's motion). Grid units throughout.
import { rand01 } from './common';

export const SPRAY = 0,
  FOAM = 1,
  BUBBLE = 2;

export interface SecondaryState {
  count: number;
  pos: Float32Array;
  vel: Float32Array;
  /** frames left to live */
  life: Float32Array;
  kind: Uint8Array;
}

export interface SecondaryParams {
  spray: boolean;
  foam: boolean;
  bubbles: boolean;
  wcMin: number;
  wcMax: number;
  taMin: number;
  taMax: number;
  keMin: number;
  keMax: number;
  potentialRadius: number;
  updateRadius: number;
  samplingWc: number;
  samplingTa: number;
  lifeMin: number;
  lifeMax: number;
  buoyancy: number;
  drag: number;
  pushOut: boolean;
  /** spawn multiplier (upres factor) */
  scale: number;
  fps: number;
  /** gravity in cells / s² */
  gravity: [number, number, number];
  /** cap on the number of secondary particles */
  max?: number;
}

export interface LiquidSample {
  nx: number;
  ny: number;
  nz: number;
  /** liquid particle positions and velocities (cells, cells/s) */
  particles: Float32Array;
  vel: Float32Array;
  solid: Uint8Array | null;
}

export function newSecondary(): SecondaryState {
  return { count: 0, pos: new Float32Array(3 * 256), vel: new Float32Array(3 * 256), life: new Float32Array(256), kind: new Uint8Array(256) };
}

function push(s: SecondaryState, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, kind: number) {
  if (s.count >= s.life.length) {
    const cap = s.life.length * 2;
    const grow = <T extends Float32Array | Uint8Array>(a: T, n: number): T => {
      const b = new (a.constructor as new (n: number) => T)(n);
      b.set(a);
      return b;
    };
    s.pos = grow(s.pos, cap * 3);
    s.vel = grow(s.vel, cap * 3);
    s.life = grow(s.life, cap);
    s.kind = grow(s.kind, cap);
  }
  const i = s.count++;
  s.pos[i * 3] = x;
  s.pos[i * 3 + 1] = y;
  s.pos[i * 3 + 2] = z;
  s.vel[i * 3] = vx;
  s.vel[i * 3 + 1] = vy;
  s.vel[i * 3 + 2] = vz;
  s.life[i] = life;
  s.kind[i] = kind;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ramp = (v: number, lo: number, hi: number) => clamp01((v - lo) / Math.max(1e-6, hi - lo));

/** Per cell liquid particle counts and mean velocities. */
function cellFields(L: LiquidSample) {
  const { nx, ny, nz } = L;
  const n = nx * ny * nz;
  const count = new Uint16Array(n);
  const vel = new Float32Array(n * 3);
  const P = L.particles;
  for (let p = 0; p < P.length / 3; p++) {
    const i = Math.floor(P[p * 3]),
      j = Math.floor(P[p * 3 + 1]),
      k = Math.floor(P[p * 3 + 2]);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
    const o = i + j * nx + k * nx * ny;
    if (count[o] < 65535) count[o]++;
    vel[o * 3] += L.vel[p * 3];
    vel[o * 3 + 1] += L.vel[p * 3 + 1];
    vel[o * 3 + 2] += L.vel[p * 3 + 2];
  }
  for (let o = 0; o < n; o++)
    if (count[o]) {
      vel[o * 3] /= count[o];
      vel[o * 3 + 1] /= count[o];
      vel[o * 3 + 2] /= count[o];
    }
  return { count, vel };
}

/** Advance the secondary particles by one frame using the liquid of that frame. */
export function stepSecondary(s: SecondaryState, L: LiquidSample, P: SecondaryParams, frame: number) {
  const { nx, ny, nz } = L;
  const { count, vel } = cellFields(L);
  const at = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? -1 : i + j * nx + k * nx * ny);
  const dt = 1 / Math.max(1, P.fps);
  const max = P.max ?? 200_000;
  // --- generation from liquid particles at the surface
  const R = Math.max(1, Math.round(P.potentialRadius));
  const parts = L.particles;
  const nP = parts.length / 3;
  const wantAny = P.spray || P.foam || P.bubbles;
  if (wantAny)
    for (let p = 0; p < nP && s.count < max; p++) {
      const x = parts[p * 3],
        y = parts[p * 3 + 1],
        z = parts[p * 3 + 2];
      const ci = Math.floor(x),
        cj = Math.floor(y),
        ck = Math.floor(z);
      const co = at(ci, cj, ck);
      if (co < 0) continue;
      // outward normal from the liquid occupancy and the share of empty cells around
      let gx = 0,
        gy = 0,
        gz = 0,
        empty = 0,
        total = 0,
        dv = 0,
        dvn = 0;
      const pvx = L.vel[p * 3],
        pvy = L.vel[p * 3 + 1],
        pvz = L.vel[p * 3 + 2];
      for (let dk = -R; dk <= R; dk++)
        for (let dj = -R; dj <= R; dj++)
          for (let di = -R; di <= R; di++) {
            if (!di && !dj && !dk) continue;
            const q = at(ci + di, cj + dj, ck + dk);
            if (q < 0 || (L.solid && L.solid[q])) continue;
            total++;
            if (!count[q]) {
              empty++;
              gx += di;
              gy += dj;
              gz += dk;
            } else {
              // velocity difference to neighbours moving towards the particle (air gets trapped)
              const rx = vel[q * 3] - pvx,
                ry = vel[q * 3 + 1] - pvy,
                rz = vel[q * 3 + 2] - pvz;
              const d = Math.hypot(di, dj, dk);
              const toward = -(rx * di + ry * dj + rz * dk) / d;
              if (toward > 0) dv += toward;
              dvn++;
            }
          }
      if (!total || !empty) continue;
      const gl = Math.hypot(gx, gy, gz) || 1;
      const speed = Math.hypot(pvx, pvy, pvz);
      const along = speed > 1e-6 ? (pvx * gx + pvy * gy + pvz * gz) / (gl * speed) : 0;
      // potentials (comparable to the default ranges): crest grows with exposure and outward motion
      const curvature = (empty / total) * 16;
      const wc = along > 0.6 ? curvature * along : 0;
      const ta = dvn ? (dv / dvn) * dt * 8 : 0;
      const spf = speed * dt;
      const ke = 0.5 * spf * spf * 4;
      const Ike = ramp(ke, P.keMin, P.keMax);
      if (Ike <= 0) continue;
      const nNew = P.scale * Ike * (P.samplingWc * ramp(wc, P.wcMin, P.wcMax) + P.samplingTa * ramp(ta, P.taMin, P.taMax)) * dt;
      let spawn = Math.floor(nNew);
      if (rand01(p, frame, 3, 11) < nNew - spawn) spawn++;
      for (let q = 0; q < spawn && s.count < max; q++) {
        const r = (c: number) => rand01(p, frame, q, c);
        const life = P.lifeMin + (P.lifeMax - P.lifeMin) * r(4);
        // start inside the particle's neighbourhood, moving with it plus a little scatter
        const jx = (r(1) - 0.5) * 0.8,
          jy = (r(2) - 0.5) * 0.8,
          jz = (r(3) - 0.5) * 0.8;
        const sc = 0.15 * speed;
        push(s, x + jx, y + jy, z + jz, pvx + (r(5) - 0.5) * sc, pvy + (r(6) - 0.5) * sc, pvz + (r(7) - 0.5) * sc, life, SPRAY);
      }
    }
  // --- classify, move and age
  const U = Math.max(1, Math.round(P.updateRadius));
  const [gX, gY, gZ] = P.gravity;
  const gl = Math.hypot(gX, gY, gZ) || 1;
  let w = 0;
  for (let i = 0; i < s.count; i++) {
    let x = s.pos[i * 3],
      y = s.pos[i * 3 + 1],
      z = s.pos[i * 3 + 2];
    const ci = Math.floor(x),
      cj = Math.floor(y),
      ck = Math.floor(z);
    let filled = 0,
      cells = 0,
      ux = 0,
      uy = 0,
      uz = 0,
      un = 0;
    for (let dk = -U; dk <= U; dk++)
      for (let dj = -U; dj <= U; dj++)
        for (let di = -U; di <= U; di++) {
          const q = at(ci + di, cj + dj, ck + dk);
          if (q < 0) continue;
          cells++;
          if (count[q]) {
            filled++;
            ux += vel[q * 3];
            uy += vel[q * 3 + 1];
            uz += vel[q * 3 + 2];
            un++;
          }
        }
    const share = cells ? filled / cells : 0;
    const kind = share < 0.12 ? SPRAY : share > 0.85 ? BUBBLE : FOAM;
    if (un) {
      ux /= un;
      uy /= un;
      uz /= un;
    }
    let vx = s.vel[i * 3],
      vy = s.vel[i * 3 + 1],
      vz = s.vel[i * 3 + 2];
    if (kind === SPRAY) {
      vx += gX * dt;
      vy += gY * dt;
      vz += gZ * dt;
    } else if (kind === FOAM) {
      vx = ux;
      vy = uy;
      vz = uz;
    } else {
      // buoyancy against gravity, drag towards the liquid's motion
      const b = P.buoyancy * gl * dt;
      vx += (-gX / gl) * b + (ux - vx) * Math.min(1, P.drag);
      vy += (-gY / gl) * b + (uy - vy) * Math.min(1, P.drag);
      vz += (-gZ / gl) * b + (uz - vz) * Math.min(1, P.drag);
    }
    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    let life = s.life[i] - (kind === FOAM ? 1 : 0.25);
    const outside = x < 0 || y < 0 || z < 0 || x > nx || y > ny || z > nz;
    if (outside) {
      if (!P.pushOut) life = -1;
      else {
        x = Math.min(nx - 0.01, Math.max(0.01, x));
        y = Math.min(ny - 0.01, Math.max(0.01, y));
        z = Math.min(nz - 0.01, Math.max(0.01, z));
      }
    }
    const so = at(Math.floor(x), Math.floor(y), Math.floor(z));
    if (so >= 0 && L.solid && L.solid[so]) {
      if (!P.pushOut) life = -1;
      else {
        x = s.pos[i * 3];
        y = s.pos[i * 3 + 1];
        z = s.pos[i * 3 + 2];
        vx = vy = vz = 0;
      }
    }
    const enabled = kind === SPRAY ? P.spray : kind === FOAM ? P.foam : P.bubbles;
    // a disabled kind is not kept, except spray that may still turn into foam or bubbles
    if (life <= 0 || (!enabled && !(kind === SPRAY && (P.foam || P.bubbles)))) continue;
    s.pos[w * 3] = x;
    s.pos[w * 3 + 1] = y;
    s.pos[w * 3 + 2] = z;
    s.vel[w * 3] = vx;
    s.vel[w * 3 + 1] = vy;
    s.vel[w * 3 + 2] = vz;
    s.life[w] = life;
    s.kind[w] = kind;
    w++;
  }
  s.count = w;
}

/** Positions per kind (grid units), only the enabled kinds. */
export function secondaryPositions(s: SecondaryState, P?: Pick<SecondaryParams, 'spray' | 'foam' | 'bubbles'>): { spray: Float32Array; foam: Float32Array; bubbles: Float32Array } {
  const n = [0, 0, 0];
  for (let i = 0; i < s.count; i++) n[s.kind[i]]++;
  const out = [new Float32Array(n[0] * 3), new Float32Array(n[1] * 3), new Float32Array(n[2] * 3)];
  const w = [0, 0, 0];
  for (let i = 0; i < s.count; i++) {
    const k = s.kind[i];
    out[k][w[k]++] = s.pos[i * 3];
    out[k][w[k]++] = s.pos[i * 3 + 1];
    out[k][w[k]++] = s.pos[i * 3 + 2];
  }
  return { spray: P && !P.spray ? new Float32Array(0) : out[0], foam: P && !P.foam ? new Float32Array(0) : out[1], bubbles: P && !P.bubbles ? new Float32Array(0) : out[2] };
}

/** Parameters from the domain settings. */
export function secondaryParams(s: Record<string, unknown>, fps: number, gravity: [number, number, number]): SecondaryParams {
  const n = (k: string, d: number) => (typeof s[k] === 'number' ? (s[k] as number) : d);
  return {
    spray: !!s.use_spray_particles,
    foam: !!s.use_foam_particles,
    bubbles: !!s.use_bubble_particles,
    wcMin: n('sndparticle_potential_min_wavecrest', 2),
    wcMax: n('sndparticle_potential_max_wavecrest', 8),
    taMin: n('sndparticle_potential_min_trappedair', 5),
    taMax: n('sndparticle_potential_max_trappedair', 20),
    keMin: n('sndparticle_potential_min_energy', 1),
    keMax: n('sndparticle_potential_max_energy', 5),
    potentialRadius: n('sndparticle_potential_radius', 2),
    updateRadius: n('sndparticle_update_radius', 2),
    samplingWc: n('sndparticle_sampling_wavecrest', 200),
    samplingTa: n('sndparticle_sampling_trappedair', 40),
    lifeMin: n('sndparticle_life_min', 10),
    lifeMax: n('sndparticle_life_max', 25),
    buoyancy: n('sndparticle_bubble_buoyancy', 0.5),
    drag: n('sndparticle_bubble_drag', 0.6),
    pushOut: s.sndparticle_boundary === 'PUSHOUT',
    scale: Math.max(1, n('particle_scale', 1)),
    fps,
    gravity,
  };
}
