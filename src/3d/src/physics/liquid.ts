// Liquid domains: flows with the Liquid type fill the domain with FLIP particles (liquid-solver.ts);
// the domain object shows the liquid surface built from the particles (or the particles themselves).
import { Matrix4, Vector3 } from 'three';
import type { ObjectData } from '../data/types';
import type { EvalMesh, ModifierContext } from '../eval/types';
import { rand01, frameOf, getCache, outOfTime, type FrameCache, type SimContext } from './common';
import { addParticle, newLiquidGrid, removeParticles, stepLiquid, type LiquidGrid, type LiquidParams } from './liquid-solver';
import { polygonize, type FieldElement } from '../metaball/polygonize';
import { fps } from './meshsim';
import { cacheType, fluidLayers, layerBaked, mayStepData, peekFluidLayers, type FluidLayers } from './fluidcache';
import { newSecondary, secondaryParams, secondaryPositions, stepSecondary, type SecondaryState } from './secondary';
import type { FluidModifier, FluidDomainSettings, FluidFlowSettings } from './fluid';

/** Helpers shared with the gas domain (set by fluid.ts to avoid an import cycle). */
export interface FluidShared {
  participants: (doc: SimContext['doc'], kind: 'FLOW' | 'EFFECTOR', domain?: FluidModifier) => { ob: ObjectData; m: FluidModifier }[];
  voxelize: (ctx: SimContext, ob: ObjectData, frame: number, G: GridFrame, surface: number, volume: number, wantNormals: boolean) => Voxels | null;
  markObstacles: (ctx: SimContext, effectors: { ob: ObjectData; m: FluidModifier }[], G: GridFrame, k: number, solid: Uint8Array) => void;
  flowEmission: (ctx: SimContext, fl: { ob: ObjectData; m: FluidModifier }, k: number, G: GridFrame, gas: boolean) => { fs: FluidFlowSettings; vx: Voxels; coord: [number, number, number] | null } | null;
  timeSteps: (s: FluidDomainSettings, vmax: number, dtFrame: number) => number;
  guideFieldFor: (ctx: SimContext, ob: ObjectData, m: FluidModifier, G: GridFrame, k: number, cacheKey: string) => Float32Array | null;
  gridFrame: (ctx: SimContext, ob: ObjectData, mesh: EvalMesh, res: number, frame: number) => { G: GridFrame; bmin: [number, number, number]; bmax: [number, number, number] };
  domainHash: (doc: SimContext['doc'], ob: ObjectData, m: FluidModifier, mesh: EvalMesh | null) => string;
  cacheKey: (ob: ObjectData, m: FluidModifier) => string;
  fieldAccelerations: (ctx: SimContext, G: GridFrame, frame: number, weight: number, types: Record<string, number> | null, u?: Float32Array, v?: Float32Array, w?: Float32Array) => Float32Array | null;
  domainDefaults: () => FluidDomainSettings;
  flowDefaults: () => FluidFlowSettings;
  syncLayers: (key: string, hash: string) => FluidLayers;
  frameAt: (m: FluidModifier, graphFrame: number) => number;
  fps: () => number;
  /** scene gravity in grid cells / s² of a domain grid */
  gravityCells: (G: GridFrame) => [number, number, number];
}
export interface GridFrame {
  toGrid: Matrix4;
  nx: number;
  ny: number;
  nz: number;
}
export interface Voxels {
  w: Float32Array;
  nx: Float32Array | null;
  ny: Float32Array | null;
  nz: Float32Array | null;
  vel: [number, number, number] | null;
  coords?: Float32Array | null;
}

export const fluidShared: { fns: FluidShared | null } = { fns: null };

export interface LiquidFrame {
  /** particle positions in grid units */
  particles: Float32Array;
  /** particle velocities (cells / s) */
  vel?: Float32Array;
  /** obstacle cells */
  solid?: Uint8Array;
}

export interface LiquidLive {
  grid: LiquidGrid;
  G: GridFrame;
  bmin: [number, number, number];
  bmax: [number, number, number];
}

/** Fill a cell with evenly spread (slightly jittered) particles. */
function fillCell(g: LiquidGrid, i: number, j: number, k: number, pn: number, jitter: number, seed: number, vel: [number, number, number]) {
  const o = i + j * g.nx + k * g.nx * g.ny;
  for (let c = 0; c < pn * pn * pn; c++) {
    const a = c % pn,
      b = Math.floor(c / pn) % pn,
      d = Math.floor(c / (pn * pn));
    const r = (ch: number) => (rand01(o, c, seed, ch) - 0.5) * jitter;
    addParticle(g, i + (a + 0.5 + r(1)) / pn, j + (b + 0.5 + r(2)) / pn, k + (d + 0.5 + r(3)) / pn, vel[0], vel[1], vel[2]);
  }
}

function cellCounts(g: LiquidGrid): Uint16Array {
  const { nx, ny, nz } = g;
  const counts = new Uint16Array(nx * ny * nz);
  for (let p = 0; p < g.count; p++) {
    const i = Math.floor(g.px[p * 3]),
      j = Math.floor(g.px[p * 3 + 1]),
      k = Math.floor(g.px[p * 3 + 2]);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
    const o = i + j * nx + k * nx * ny;
    if (counts[o] < 65535) counts[o]++;
  }
  return counts;
}

const MAX_PARTICLES = 400_000;

function stepDomain(ctx: SimContext, ob: ObjectData, m: FluidModifier, L: LiquidLive, k: number, first: boolean) {
  const F = fluidShared.fns!;
  const s = { ...F.domainDefaults(), ...m.domain_settings };
  const g = L.grid;
  const { nx, ny, nz } = g;
  const cap = s.sys_particle_maximum && s.sys_particle_maximum > 0 ? Math.min(MAX_PARTICLES, s.sys_particle_maximum) : MAX_PARTICLES;
  // obstacles
  F.markObstacles(ctx, F.participants(ctx.doc, 'EFFECTOR', m), L.G, k, g.solid);
  const inSolid = (x: number, y: number, z: number) => {
    const i = Math.floor(x),
      j = Math.floor(y),
      kk = Math.floor(z);
    return i >= 0 && j >= 0 && kk >= 0 && i < nx && j < ny && kk < nz && !!g.solid[i + j * nx + kk * nx * ny];
  };
  if (s.delete_in_obstacle) removeParticles(g, inSolid);
  // liquid flows
  const pn = Math.max(1, Math.min(5, Math.round(s.particle_number ?? 2)));
  const jitter = Math.max(0, Math.min(1, s.particle_randomness ?? 0.1));
  let counts: Uint16Array | null = null;
  for (const fl of F.participants(ctx.doc, 'FLOW', m)) {
    const fs0 = { ...F.flowDefaults(), ...fl.m.flow_settings };
    if (fs0.flow_type !== 'LIQUID' || fs0.use_flow === false) continue;
    if (fs0.flow_behavior === 'GEOMETRY' && !first) continue;
    const em = F.flowEmission(ctx, fl, k, L.G, false);
    if (!em) continue;
    const { fs, vx, coord } = em;
    const wantNormals = fs.use_initial_velocity && fs.velocity_normal !== 0;
    if (fs.flow_behavior === 'OUTFLOW') {
      removeParticles(g, (x, y, z) => {
        const i = Math.floor(x),
          j = Math.floor(y),
          kk = Math.floor(z);
        return i >= 0 && j >= 0 && kk >= 0 && i < nx && j < ny && kk < nz && vx.w[i + j * nx + kk * nx * ny] > 0.5;
      });
      counts = null;
      continue;
    }
    counts ??= cellCounts(g);
    const base: [number, number, number] = fs.use_initial_velocity && vx.vel ? [vx.vel[0] * fs.velocity_factor, vx.vel[1] * fs.velocity_factor, vx.vel[2] * fs.velocity_factor] : [0, 0, 0];
    if (fs.use_initial_velocity && coord) for (let c = 0; c < 3; c++) base[c] += coord[c];
    const cpm = Math.cbrt(Math.abs(L.G.toGrid.determinant()));
    let o = 0;
    for (let kk = 0; kk < nz; kk++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++, o++) {
          if (vx.w[o] <= 0.5 || g.solid[o] || g.count >= cap) continue;
          // inflow keeps emitter cells full; geometry fills them once
          if (counts[o] >= (pn * pn * pn) / 2) continue;
          const vel: [number, number, number] = [base[0], base[1], base[2]];
          if (wantNormals && vx.nx) {
            // push out along the emitter's surface normal (metres per second → cells per second)
            const nf = fs.velocity_normal * cpm;
            vel[0] += vx.nx[o] * nf;
            vel[1] += vx.ny![o] * nf;
            vel[2] += vx.nz![o] * nf;
          }
          if (fs.use_initial_velocity && fs.velocity_random) {
            const rr = fs.velocity_random * cpm;
            vel[0] += (rand01(o, k, 1, 91) - 0.5) * rr;
            vel[1] += (rand01(o, k, 1, 92) - 0.5) * rr;
            vel[2] += (rand01(o, k, 1, 93) - 0.5) * rr;
          }
          fillCell(g, i, j, kk, pn, jitter, k, vel);
        }
    counts = null;
  }
  if (g.count > cap) g.count = cap;
  reseed(g, s.particle_min ?? 0, s.particle_max ?? 0, pn, jitter, k, cap);
  // gravity in grid cells per second²
  const gw = ctx.doc.scene.use_gravity ? new Vector3(...ctx.doc.scene.gravity) : new Vector3(0, 0, 0);
  const lin = L.G.toGrid.clone().setPosition(0, 0, 0);
  const gg = gw.applyMatrix4(lin).multiplyScalar(s.effector_weights_gravity ?? 1);
  const f = fps(ctx.doc);
  const dtFrame = (s.time_scale || 0) / f;
  let vmax = 0;
  for (let i = 0; i < g.count * 3; i++) vmax = Math.max(vmax, Math.abs(g.pv[i]));
  vmax += gg.length() * dtFrame;
  const sub = F.timeSteps(s, vmax, dtFrame);
  const P: LiquidParams = {
    dt: dtFrame / sub,
    gravity: [gg.x, gg.y, gg.z],
    flip: s.simulation_method === 'APIC' ? 0 : Math.max(0, Math.min(1, s.flip_ratio ?? 0.97)),
    apic: s.simulation_method === 'APIC',
    pressureIterations: 80,
    open: [!s.use_collision_border_left, !s.use_collision_border_right, !s.use_collision_border_front, !s.use_collision_border_back, !s.use_collision_border_bottom, !s.use_collision_border_top],
  };
  const cpm = Math.cbrt(Math.abs(L.G.toGrid.determinant()));
  let visc = 0;
  // m²/s → cells²/s
  if (s.use_diffusion) visc += (s.viscosity_base ?? 1) * Math.pow(10, -(s.viscosity_exponent ?? 6)) * cpm * cpm;
  // the high viscosity solver makes thick liquids (honey, lava): strength in cells² per second
  if (s.use_diffusion && s.use_viscosity) visc += Math.max(0, s.viscosity_value ?? 0.05) * 40;
  if (visc > 0) P.viscosity = visc;
  P.accel = F.fieldAccelerations(ctx, L.G, k, s.effector_weights_all ?? 1, s.effector_weights_types ?? null);
  const guide = F.guideFieldFor(ctx, ob, m, L.G, k, F.cacheKey(ob, m));
  if (guide) P.guide = { field: guide, weight: s.guide_alpha ?? 2, factor: s.guide_vel_factor ?? 2 };
  for (let st = 0; st < sub; st++) stepLiquid(g, P);
  if (s.delete_in_obstacle) removeParticles(g, inSolid);
}

/** Keep the particle count of cells inside the liquid between `min` and `max` (0 = no limit). */
function reseed(g: LiquidGrid, min: number, max: number, pn: number, jitter: number, seed: number, cap: number) {
  if (min <= 0 && max <= 0) return;
  const { nx, ny, nz } = g;
  const counts = cellCounts(g);
  // crowded cells push their particles towards emptier neighbours (no liquid is lost)
  if (max > 0) {
    const cnt = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 65535 : g.solid[i + j * nx + k * nx * ny] ? 65535 : counts[i + j * nx + k * nx * ny]);
    for (let p = 0; p < g.count; p++) {
      const i = Math.floor(g.px[p * 3]),
        j = Math.floor(g.px[p * 3 + 1]),
        k = Math.floor(g.px[p * 3 + 2]);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
      const c = counts[i + j * nx + k * nx * ny];
      if (c <= max) continue;
      // direction of decreasing particle count
      const dx = Math.min(c, cnt(i - 1, j, k)) - Math.min(c, cnt(i + 1, j, k)),
        dy = Math.min(c, cnt(i, j - 1, k)) - Math.min(c, cnt(i, j + 1, k)),
        dz = Math.min(c, cnt(i, j, k - 1)) - Math.min(c, cnt(i, j, k + 1));
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-6) continue;
      const step = Math.min(0.35, (0.15 * (c - max)) / max);
      g.px[p * 3] = Math.min(nx - 0.01, Math.max(0.01, g.px[p * 3] + (dx / l) * step));
      g.px[p * 3 + 1] = Math.min(ny - 0.01, Math.max(0.01, g.px[p * 3 + 1] + (dy / l) * step));
      g.px[p * 3 + 2] = Math.min(nz - 0.01, Math.max(0.01, g.px[p * 3 + 2] + (dz / l) * step));
    }
  }
  if (min <= 0) return;
  // refill sparse cells that are surrounded by liquid (not the surface)
  const sum = new Float32Array(counts.length * 3);
  for (let p = 0; p < g.count; p++) {
    const i = Math.floor(g.px[p * 3]),
      j = Math.floor(g.px[p * 3 + 1]),
      k = Math.floor(g.px[p * 3 + 2]);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
    const o = i + j * nx + k * nx * ny;
    sum[o * 3] += g.pv[p * 3];
    sum[o * 3 + 1] += g.pv[p * 3 + 1];
    sum[o * 3 + 2] += g.pv[p * 3 + 2];
  }
  const need = Math.min(min, pn * pn * pn);
  let o = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        const c = counts[o];
        if (c || g.solid[o] || g.count >= cap) continue;
        // a hole: an empty cell whose neighbours are all well filled with liquid (or walls)
        const inside = (a: number, b: number, d: number) => a < 0 || b < 0 || d < 0 || a >= nx || b >= ny || d >= nz || counts[a + b * nx + d * nx * ny] >= need / 2 || !!g.solid[a + b * nx + d * nx * ny];
        if (!(inside(i - 1, j, k) && inside(i + 1, j, k) && inside(i, j - 1, k) && inside(i, j + 1, k) && inside(i, j, k - 1) && inside(i, j, k + 1))) continue;
        // velocity of the surrounding liquid
        const v: [number, number, number] = [0, 0, 0];
        let vc = 0;
        for (const q of [o - 1, o + 1, o - nx, o + nx, o - nx * ny, o + nx * ny])
          if (q >= 0 && q < counts.length && counts[q]) {
            v[0] += sum[q * 3] / counts[q];
            v[1] += sum[q * 3 + 1] / counts[q];
            v[2] += sum[q * 3 + 2] / counts[q];
            vc++;
          }
        if (vc) for (let a = 0; a < 3; a++) v[a] /= vc;
        for (let q = 0; q < need; q++) {
          const r = (ch: number) => rand01(o, q, seed, ch);
          addParticle(g, i + 0.1 + 0.8 * r(1), j + 0.1 + 0.8 * r(2), k + 0.1 + 0.8 * r(3), v[0], v[1], v[2]);
        }
      }
}

/** Particles of the liquid domain at the context frame (stepping the cache as needed). */
export function evaluateLiquid(ob: ObjectData, m: FluidModifier, mesh: EvalMesh, ctx: ModifierContext): { frame: LiquidFrame; live: LiquidLive; f: number } | null {
  const F = fluidShared.fns;
  if (!F) return null;
  const doc = ctx.doc;
  const pc = m.point_cache;
  const key = F.cacheKey(ob, m);
  const cache = getCache<LiquidFrame, LiquidLive>(key) as FrameCache<LiquidFrame, LiquidLive>;
  cache.label = `${ob.name} ▸ ${m.name}`;
  cache.start = pc.frame_start;
  cache.end = pc.frame_end;
  cache.baked = pc.is_baked;
  const hash = F.domainHash(doc, ob, m, mesh);
  const usable = pc.is_baked && cache.frames.size > 0 && !!cache.live && 'grid' in (cache.live as object);
  if (!usable && cache.hash !== hash) cache.reset(hash);
  const layers = F.syncLayers(key, cache.hash);
  const f = F.frameAt(m, frameOf(ctx.graph));
  const sctx: SimContext = { doc, graph: ctx.graph };
  const replay = cacheType(m.domain_settings) === 'REPLAY';
  if (!cache.frames.has(f) && mayStepData(key, m) && !(pc.is_baked && !replay)) {
    if (!cache.live || cache.last < pc.frame_start || !('grid' in (cache.live as object))) {
      const s = { ...F.domainDefaults(), ...m.domain_settings };
      const { G, bmin, bmax } = F.gridFrame(sctx, ob, mesh, Math.min(128, Math.max(8, s.resolution_max)), pc.frame_start);
      cache.frames.clear();
      cache.live = { grid: newLiquidGrid(G.nx, G.ny, G.nz), G, bmin, bmax };
      cache.frames.set(pc.frame_start, { particles: new Float32Array(0), vel: new Float32Array(0) });
      cache.last = pc.frame_start;
    }
    while (cache.last < f) {
      if (cache.last > pc.frame_start && outOfTime()) break;
      const k = cache.last + 1;
      stepDomain(sctx, ob, m, cache.live!, k, k === pc.frame_start + 1);
      const g = cache.live!.grid;
      const fr: LiquidFrame = { particles: g.px.slice(0, g.count * 3), vel: g.pv.slice(0, g.count * 3), solid: g.solid.slice() };
      cache.frames.set(k, fr);
      cache.last = k;
      // Replay caches advance the secondary particles together with the liquid
      if (replay && secondaryEnabled(m.domain_settings)) stepSecondaryLayer(layers, m.domain_settings, cache, k);
    }
  }
  const frame = replay ? (cache.frames.get(f) ?? cache.nearest(f)) : cache.frames.get(f);
  return frame && cache.live ? { frame, live: cache.live, f } : null;
}

export const secondaryEnabled = (s: Partial<FluidDomainSettings> | undefined) => !!s && (!!s.use_spray_particles || !!s.use_foam_particles || !!s.use_bubble_particles);

/** Secondary particle settings that, when changed, invalidate the computed spray / foam / bubbles. */
export function secondaryKey(s: FluidDomainSettings): string {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(s).sort()) if (/^(sndparticle_|use_spray|use_foam|use_bubble|particle_scale)/.test(k)) o[k] = (s as unknown as Record<string, unknown>)[k];
  return JSON.stringify(o);
}

/**
 * Advance the secondary particles to frame k (from frame k-1, or from the cache start). Returns
 * false when the frames before k are missing.
 */
export function stepSecondaryLayer(L: FluidLayers, ds: FluidDomainSettings, cache: FrameCache<LiquidFrame, LiquidLive>, k: number): boolean {
  const s = { ...fluidShared.fns!.domainDefaults(), ...ds };
  const sk = secondaryKey(s);
  if (L.keys.particles !== sk && !layerBaked(s, 'particles')) {
    L.particles.clear();
    L.secondaryLive = null;
    L.keys.particles = sk;
  }
  if (L.particles.has(k)) return true;
  const live = cache.live;
  const fr = cache.frames.get(k);
  if (!live || !fr) return false;
  let st = L.secondaryLive;
  if (!st || st.frame !== k - 1) {
    if (k - 1 > cache.start && !L.particles.has(k - 1)) return false;
    st = { frame: k - 1, state: newSecondary() };
  }
  const state = st.state as SecondaryState;
  const fpsv = fluidShared.fns!.fps();
  const gg = fluidShared.fns!.gravityCells(live.G);
  stepSecondary(state, { nx: live.grid.nx, ny: live.grid.ny, nz: live.grid.nz, particles: fr.particles, vel: fr.vel ?? new Float32Array(fr.particles.length), solid: fr.solid ?? null }, secondaryParams(s, fpsv, gg), k);
  L.secondaryLive = { frame: k, state };
  const toLocal = (P: Float32Array) => {
    const out = new Float32Array(P.length);
    const { bmin, bmax } = live;
    const sx = (bmax[0] - bmin[0]) / live.grid.nx,
      sy = (bmax[1] - bmin[1]) / live.grid.ny,
      sz = (bmax[2] - bmin[2]) / live.grid.nz;
    for (let i = 0; i < P.length; i += 3) {
      out[i] = bmin[0] + P[i] * sx;
      out[i + 1] = bmin[1] + P[i + 1] * sy;
      out[i + 2] = bmin[2] + P[i + 2] * sz;
    }
    return out;
  };
  const kinds = secondaryPositions(state);
  L.particles.set(k, { spray: toLocal(kinds.spray), foam: toLocal(kinds.foam), bubbles: toLocal(kinds.bubbles) });
  return true;
}

/** Settings the surface mesh depends on. */
export function meshKey(s: FluidDomainSettings): string {
  return [s.mesh_particle_radius, s.mesh_scale, s.particle_number, s.mesh_generator, s.mesh_smoothen_pos, s.mesh_smoothen_neg].join(',');
}

/** Domain-local positions of grid-unit particle positions. */
function toDomain(P: Float32Array, live: LiquidLive): Float32Array {
  const { nx, ny, nz } = live.grid;
  const { bmin, bmax } = live;
  const sx = (bmax[0] - bmin[0]) / nx,
    sy = (bmax[1] - bmin[1]) / ny,
    sz = (bmax[2] - bmin[2]) / nz;
  const out = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    out[i] = bmin[0] + P[i] * sx;
    out[i + 1] = bmin[1] + P[i + 1] * sy;
    out[i + 2] = bmin[2] + P[i + 2] * sz;
  }
  return out;
}

/**
 * Surface of the liquid particles in the domain object's space. The preview generator is the plain
 * union of the particle spheres; the final one is smoothed (positive steps flatten bumps, negative
 * steps fill dents).
 */
export function buildLiquidSurface(r: { frame: LiquidFrame; live: LiquidLive }, s: FluidDomainSettings): EvalMesh {
  const P = r.frame.particles;
  const { nx, ny, nz } = r.live.grid;
  const { bmin, bmax } = r.live;
  const sx = (bmax[0] - bmin[0]) / nx,
    sy = (bmax[1] - bmin[1]) / ny,
    sz = (bmax[2] - bmin[2]) / nz;
  const count = P.length / 3;
  if (!count) return { positions: new Float32Array(0), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) };
  const local = toDomain(P, r.live);
  const h = (sx + sy + sz) / 3;
  const rc = Math.max(0.5, s.mesh_particle_radius ?? 2);
  const rad = rc * h;
  const pn = Math.max(1, Math.min(5, Math.round(s.particle_number ?? 2)));
  // the surface lies where the particle field drops to about half of its value inside the liquid
  const threshold = 0.45 * pn * pn * pn * 0.638 * rc * rc * rc;
  const els: FieldElement[] = [];
  for (let i = 0; i < count; i++) {
    const x = local[i * 3],
      y = local[i * 3 + 1],
      z = local[i * 3 + 2];
    els.push({ type: 'BALL', radius: rad, stiffness: 1, sx: 0, sy: 0, sz: 0, negative: false, inv: new Float64Array([1, 0, 0, -x, 0, 1, 0, -y, 0, 0, 1, -z]), min: [x - rad, y - rad, z - rad], max: [x + rad, y + rad, z + rad] });
  }
  const mesh = polygonize(els, threshold, h / Math.max(1, s.mesh_scale ?? 2)).mesh;
  if ((s.mesh_generator ?? 'IMPROVED') === 'IMPROVED') smoothSurface(mesh, Math.round(s.mesh_smoothen_pos ?? 1), Math.round(s.mesh_smoothen_neg ?? 1));
  return mesh;
}

/** Laplacian smoothing that moves vertices only outwards (negative) or only inwards (positive). */
export function smoothSurface(mesh: EvalMesh, pos: number, neg: number) {
  const n = mesh.positions.length / 3;
  if (!n || (pos <= 0 && neg <= 0)) return;
  const nb: number[][] = Array.from({ length: n }, () => []);
  for (let f = 0; f < mesh.offsets.length - 1; f++) {
    const a = mesh.offsets[f],
      b = mesh.offsets[f + 1];
    for (let c = a; c < b; c++) {
      const v = mesh.indices[c],
        w = mesh.indices[c + 1 < b ? c + 1 : a];
      if (!nb[v].includes(w)) nb[v].push(w);
      if (!nb[w].includes(v)) nb[w].push(v);
    }
  }
  const P = mesh.positions;
  const normals = vertexNormalsOf(mesh);
  const run = (steps: number, sign: 1 | -1) => {
    for (let s = 0; s < steps; s++) {
      const next = P.slice();
      for (let v = 0; v < n; v++) {
        const l = nb[v];
        if (!l.length) continue;
        let cx = 0,
          cy = 0,
          cz = 0;
        for (const w of l) {
          cx += P[w * 3];
          cy += P[w * 3 + 1];
          cz += P[w * 3 + 2];
        }
        const dx = cx / l.length - P[v * 3],
          dy = cy / l.length - P[v * 3 + 1],
          dz = cz / l.length - P[v * 3 + 2];
        // positive steps flatten bumps (move inwards), negative steps fill dents (move outwards)
        const along = dx * normals[v * 3] + dy * normals[v * 3 + 1] + dz * normals[v * 3 + 2];
        if (sign > 0 ? along > 0 : along < 0) continue;
        next[v * 3] += dx * 0.5;
        next[v * 3 + 1] += dy * 0.5;
        next[v * 3 + 2] += dz * 0.5;
      }
      P.set(next);
    }
  };
  run(Math.max(0, pos), 1);
  run(Math.max(0, neg), -1);
}

function vertexNormalsOf(mesh: EvalMesh): Float32Array {
  const P = mesh.positions;
  const out = new Float32Array(P.length);
  for (let f = 0; f < mesh.offsets.length - 1; f++) {
    const a = mesh.offsets[f],
      b = mesh.offsets[f + 1];
    if (b - a < 3) continue;
    const i0 = mesh.indices[a] * 3,
      i1 = mesh.indices[a + 1] * 3,
      i2 = mesh.indices[a + 2] * 3;
    const ux = P[i1] - P[i0],
      uy = P[i1 + 1] - P[i0 + 1],
      uz = P[i1 + 2] - P[i0 + 2];
    const vx = P[i2] - P[i0],
      vy = P[i2 + 1] - P[i0 + 1],
      vz = P[i2 + 2] - P[i0 + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (let c = a; c < b; c++) {
      const v = mesh.indices[c] * 3;
      out[v] += nx;
      out[v + 1] += ny;
      out[v + 2] += nz;
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l;
    out[i + 1] /= l;
    out[i + 2] /= l;
  }
  return out;
}

/** The liquid surface of a frame: baked, or built now (and kept) for Replay caches. */
export function liquidSurface(key: string, r: { frame: LiquidFrame; live: LiquidLive; f: number }, s: FluidDomainSettings): EvalMesh | null {
  const L = fluidLayers(key);
  const mk = meshKey(s);
  if (L.keys.mesh !== mk && !layerBaked(s, 'mesh')) {
    L.mesh.clear();
    L.keys.mesh = mk;
  }
  const hit = L.mesh.get(r.f) as EvalMesh | undefined;
  if (hit || cacheType(s) !== 'REPLAY') return hit ?? null;
  const m = buildLiquidSurface(r, s);
  L.mesh.set(r.f, m);
  // keep memory bounded for long replays: forget surfaces far from the current frame
  if (L.mesh.size > 400) for (const k of [...L.mesh.keys()].slice(0, 100)) L.mesh.delete(k);
  return m;
}

const flipPoints = new WeakMap<Float32Array, Float32Array>();

/** Points shown for the liquid's FLIP particles and its secondary particles (domain-local). */
export function liquidPointSets(key: string, r: { frame: LiquidFrame; live: LiquidLive; f: number }, s: FluidDomainSettings): { kind: 'flip' | 'spray' | 'foam' | 'bubbles'; points: Float32Array }[] {
  const out: { kind: 'flip' | 'spray' | 'foam' | 'bubbles'; points: Float32Array }[] = [];
  if (s.use_flip_particles) {
    let pts = flipPoints.get(r.frame.particles);
    if (!pts) flipPoints.set(r.frame.particles, (pts = toDomain(r.frame.particles, r.live)));
    out.push({ kind: 'flip', points: pts });
  }
  const sec = peekFluidLayers(key)?.particles.get(r.f);
  if (sec) {
    if (s.use_spray_particles) out.push({ kind: 'spray', points: sec.spray });
    if (s.use_foam_particles) out.push({ kind: 'foam', points: sec.foam });
    if (s.use_bubble_particles) out.push({ kind: 'bubbles', points: sec.bubbles });
  }
  return out;
}
