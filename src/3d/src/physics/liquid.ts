// Liquid domains: flows with the Liquid type fill the domain with FLIP particles (liquid-solver.ts);
// the domain object shows the liquid surface built from the particles (or the particles themselves).
import { Matrix4, Vector3 } from 'three';
import type { ObjectData } from '../data/types';
import type { EvalMesh, ModifierContext } from '../eval/types';
import { rand01, frameOf, getCache, outOfTime, type FrameCache, type SimContext } from './common';
import { addParticle, newLiquidGrid, removeParticles, stepLiquid, type LiquidGrid, type LiquidParams } from './liquid-solver';
import { polygonize, type FieldElement } from '../metaball/polygonize';
import { fps } from './meshsim';
import type { FluidModifier, FluidDomainSettings, FluidFlowSettings } from './fluid';

/** Helpers shared with the gas domain (set by fluid.ts to avoid an import cycle). */
export interface FluidShared {
  participants: (doc: SimContext['doc'], kind: 'FLOW' | 'EFFECTOR') => { ob: ObjectData; m: FluidModifier }[];
  voxelize: (ctx: SimContext, ob: ObjectData, frame: number, G: GridFrame, surface: number, volume: number, wantNormals: boolean) => Voxels | null;
  gridFrame: (ctx: SimContext, ob: ObjectData, mesh: EvalMesh, res: number, frame: number) => { G: GridFrame; bmin: [number, number, number]; bmax: [number, number, number] };
  domainHash: (doc: SimContext['doc'], ob: ObjectData, m: FluidModifier, mesh: EvalMesh | null) => string;
  cacheKey: (ob: ObjectData, m: FluidModifier) => string;
  domainDefaults: () => FluidDomainSettings;
  flowDefaults: () => FluidFlowSettings;
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
}

export const fluidShared: { fns: FluidShared | null } = { fns: null };

interface LiquidFrame {
  /** particle positions in grid units */
  particles: Float32Array;
}

interface LiquidLive {
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
  const n = nx * ny * nz;
  // obstacles
  g.solid.fill(0);
  for (const e of F.participants(ctx.doc, 'EFFECTOR')) {
    if (!e.m.effector_settings?.use_effector) continue;
    const vx = F.voxelize(ctx, e.ob, k, L.G, 0.75, 1, false);
    if (vx) for (let o = 0; o < n; o++) if (vx.w[o] > 0.5) g.solid[o] = 1;
  }
  // liquid flows
  const pn = Math.max(1, Math.min(4, Math.round(s.particle_number ?? 2)));
  const jitter = Math.max(0, Math.min(1, s.particle_randomness ?? 0.1));
  let counts: Uint16Array | null = null;
  for (const fl of F.participants(ctx.doc, 'FLOW')) {
    const fs = { ...F.flowDefaults(), ...fl.m.flow_settings };
    if (fs.flow_type !== 'LIQUID' || fs.use_flow === false) continue;
    if (fs.flow_behavior === 'GEOMETRY' && !first) continue;
    const wantNormals = fs.use_initial_velocity && fs.velocity_normal !== 0;
    const vx = F.voxelize(ctx, fl.ob, k, L.G, fs.surface_distance, 1, wantNormals);
    if (!vx) continue;
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
    const vel: [number, number, number] = fs.use_initial_velocity && vx.vel ? [vx.vel[0] * fs.velocity_factor, vx.vel[1] * fs.velocity_factor, vx.vel[2] * fs.velocity_factor] : [0, 0, 0];
    let o = 0;
    for (let kk = 0; kk < nz; kk++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++, o++) {
          if (vx.w[o] <= 0.5 || g.solid[o] || g.count >= MAX_PARTICLES) continue;
          // inflow keeps emitter cells full; geometry fills them once
          if (counts[o] >= (pn * pn * pn) / 2) continue;
          if (wantNormals && vx.nx) {
            // push out along the emitter's surface normal (metres per second → cells per second)
            const cpm = Math.cbrt(Math.abs(L.G.toGrid.determinant()));
            const nf = fs.velocity_normal * cpm;
            fillCell(g, i, j, kk, pn, jitter, k, [vel[0] + vx.nx[o] * nf, vel[1] + vx.ny![o] * nf, vel[2] + vx.nz![o] * nf]);
          } else fillCell(g, i, j, kk, pn, jitter, k, vel);
        }
    counts = null;
  }
  // gravity in grid cells per second²
  const gw = ctx.doc.scene.use_gravity ? new Vector3(...ctx.doc.scene.gravity) : new Vector3(0, 0, 0);
  const lin = L.G.toGrid.clone().setPosition(0, 0, 0);
  const gg = gw.applyMatrix4(lin);
  const f = fps(ctx.doc);
  const dtFrame = (s.time_scale || 0) / f;
  let vmax = 0;
  for (let i = 0; i < g.count * 3; i++) vmax = Math.max(vmax, Math.abs(g.pv[i]));
  vmax += gg.length() * dtFrame;
  const sub = Math.min(8, Math.max(1, Math.ceil((vmax * dtFrame) / 1.5)));
  const P: LiquidParams = {
    dt: dtFrame / sub,
    gravity: [gg.x, gg.y, gg.z],
    flip: Math.max(0, Math.min(1, s.flip_ratio ?? 0.97)),
    pressureIterations: 80,
    open: [!s.use_collision_border_left, !s.use_collision_border_right, !s.use_collision_border_front, !s.use_collision_border_back, !s.use_collision_border_bottom, !s.use_collision_border_top],
  };
  for (let st = 0; st < sub; st++) stepLiquid(g, P);
}

/** Particles of the liquid domain at the context frame (stepping the cache as needed). */
export function evaluateLiquid(ob: ObjectData, m: FluidModifier, mesh: EvalMesh, ctx: ModifierContext): { frame: LiquidFrame; live: LiquidLive } | null {
  const F = fluidShared.fns;
  if (!F) return null;
  const doc = ctx.doc;
  const pc = m.point_cache;
  const cache = getCache<LiquidFrame, LiquidLive>(F.cacheKey(ob, m)) as FrameCache<LiquidFrame, LiquidLive>;
  cache.label = `${ob.name} ▸ ${m.name}`;
  cache.start = pc.frame_start;
  cache.end = pc.frame_end;
  cache.baked = pc.is_baked;
  const hash = F.domainHash(doc, ob, m, mesh);
  const usable = pc.is_baked && cache.frames.size > 0 && !!cache.live && 'grid' in (cache.live as object);
  if (!usable && cache.hash !== hash) cache.reset(hash);
  const f = Math.min(Math.max(frameOf(ctx.graph), pc.frame_start), pc.frame_end);
  const sctx: SimContext = { doc, graph: ctx.graph };
  if (!cache.frames.has(f)) {
    if (!cache.live || cache.last < pc.frame_start || !('grid' in (cache.live as object))) {
      const s = { ...F.domainDefaults(), ...m.domain_settings };
      const { G, bmin, bmax } = F.gridFrame(sctx, ob, mesh, Math.min(128, Math.max(8, s.resolution_max)), pc.frame_start);
      cache.frames.clear();
      cache.live = { grid: newLiquidGrid(G.nx, G.ny, G.nz), G, bmin, bmax };
      cache.frames.set(pc.frame_start, { particles: new Float32Array(0) });
      cache.last = pc.frame_start;
    }
    while (cache.last < f) {
      if (cache.last > pc.frame_start && outOfTime()) break;
      const k = cache.last + 1;
      stepDomain(sctx, ob, m, cache.live!, k, k === pc.frame_start + 1);
      const g = cache.live!.grid;
      cache.frames.set(k, { particles: g.px.slice(0, g.count * 3) });
      cache.last = k;
    }
  }
  const frame = cache.frames.get(f) ?? cache.nearest(f);
  return frame && cache.live ? { frame, live: cache.live } : null;
}

const meshCache = new WeakMap<Float32Array, { key: string; mesh: EvalMesh }>();

/** Liquid surface (or the particles as points) in the domain object's space. */
export function liquidMesh(r: { frame: LiquidFrame; live: LiquidLive }, s: FluidDomainSettings): EvalMesh {
  const P = r.frame.particles;
  const { nx, ny, nz } = r.live.grid;
  const { bmin, bmax } = r.live;
  const sx = (bmax[0] - bmin[0]) / nx,
    sy = (bmax[1] - bmin[1]) / ny,
    sz = (bmax[2] - bmin[2]) / nz;
  const key = `${s.use_mesh !== false}:${s.mesh_particle_radius}:${s.mesh_scale}:${s.particle_number}`;
  const hit = meshCache.get(P);
  if (hit && hit.key === key) return hit.mesh;
  const count = P.length / 3;
  const local = new Float32Array(P.length);
  for (let i = 0; i < count; i++) {
    local[i * 3] = bmin[0] + P[i * 3] * sx;
    local[i * 3 + 1] = bmin[1] + P[i * 3 + 1] * sy;
    local[i * 3 + 2] = bmin[2] + P[i * 3 + 2] * sz;
  }
  let mesh: EvalMesh;
  if (s.use_mesh === false || !count) {
    mesh = { positions: local, offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) };
  } else {
    const h = (sx + sy + sz) / 3;
    const rc = Math.max(0.5, s.mesh_particle_radius ?? 2);
    const r = rc * h;
    const pn = Math.max(1, Math.min(4, Math.round(s.particle_number ?? 2)));
    // the surface lies where the particle field drops to about half of its value inside the liquid
    const threshold = 0.45 * pn * pn * pn * 0.638 * rc * rc * rc;
    const els: FieldElement[] = [];
    for (let i = 0; i < count; i++) {
      const x = local[i * 3],
        y = local[i * 3 + 1],
        z = local[i * 3 + 2];
      els.push({ type: 'BALL', radius: r, stiffness: 1, sx: 0, sy: 0, sz: 0, negative: false, inv: new Float64Array([1, 0, 0, -x, 0, 1, 0, -y, 0, 0, 1, -z]), min: [x - r, y - r, z - r], max: [x + r, y + r, z + r] });
    }
    mesh = polygonize(els, threshold, h / Math.max(1, s.mesh_scale ?? 2)).mesh;
  }
  meshCache.set(P, { key, mesh });
  return mesh;
}
