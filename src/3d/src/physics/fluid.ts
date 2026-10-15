// Fluid modifier (gas only): Domain / Flow / Effector objects. The domain runs the
// coarse smoke & fire solver (smoke-solver.ts) frame by frame into a frame cache;
// the viewport ray-marches the cached density/flame grids (draw.ts).
import { Matrix4, Vector3 } from 'three';
import type { DocumentData, ModifierBase, ObjectData } from '../data/types';
import type { EvalMesh, ModifierContext } from '../eval/types';
import type { Depsgraph } from '../eval/depsgraph';
import { meshSignature, baseEvalMesh } from '../eval/depsgraph';
import { registerModifier } from '../eval/modifiers';
import { arrayChecksum, rand01, frameOf, getCache, motionKey, outOfTime, strHash, worldAt, type FrameCache, type SimContext } from './common';
import { triangulate, closestOnTri } from './colliders';
import { collectEffectors, effectorForce, fieldsKey } from './fields';
import { newGrid, stepGas, type GasGrid, type GasParams } from './smoke-solver';
import { physicsDoc } from './state';
import { fps } from './meshsim';
import { defaultPointCache, type PointCacheSettings } from './types';
import { evaluateLiquid, fluidShared, liquidMesh } from './liquid';

export interface FluidDomainSettings {
  domain_type: 'GAS' | 'LIQUID';
  /** liquid: FLIP/PIC blend, particles per cell axis and their jitter, surface meshing */
  flip_ratio?: number;
  particle_number?: number;
  particle_randomness?: number;
  use_mesh?: boolean;
  mesh_particle_radius?: number;
  mesh_scale?: number;
  resolution_max: number;
  time_scale: number;
  alpha: number;
  beta: number;
  vorticity: number;
  use_dissolve_smoke: boolean;
  dissolve_speed: number;
  burning_rate: number;
  flame_smoke: number;
  flame_vorticity: number;
  flame_max_temp: number;
  display_thickness: number;
  /** field weights (gravity, all fields, and per field type) */
  effector_weights_gravity?: number;
  effector_weights_all?: number;
  effector_weights_types?: Record<string, number>;
  use_collision_border_front: boolean;
  use_collision_border_back: boolean;
  use_collision_border_right: boolean;
  use_collision_border_left: boolean;
  use_collision_border_top: boolean;
  use_collision_border_bottom: boolean;
}

export interface FluidFlowSettings {
  flow_type: 'SMOKE' | 'BOTH' | 'FIRE' | 'LIQUID';
  flow_behavior: 'INFLOW' | 'GEOMETRY' | 'OUTFLOW';
  use_flow: boolean;
  smoke_color: [number, number, number];
  fuel_amount: number;
  temperature: number;
  density: number;
  surface_distance: number;
  volume_density: number;
  use_initial_velocity: boolean;
  velocity_factor: number;
  velocity_normal: number;
}

export interface FluidEffectorSettings {
  effector_type: 'COLLISION';
  use_effector: boolean;
}

export interface FluidModifier extends ModifierBase {
  fluid_type: 'NONE' | 'DOMAIN' | 'FLOW' | 'EFFECTOR';
  domain_settings: FluidDomainSettings;
  flow_settings: FluidFlowSettings;
  effector_settings: FluidEffectorSettings;
  point_cache: PointCacheSettings;
}

export function defaultDomainSettings(): FluidDomainSettings {
  return {
    domain_type: 'GAS',
    flip_ratio: 0.97,
    particle_number: 2,
    particle_randomness: 0.1,
    use_mesh: true,
    mesh_particle_radius: 2,
    mesh_scale: 2,
    resolution_max: 32,
    time_scale: 1,
    alpha: 1,
    beta: 1,
    vorticity: 0,
    use_dissolve_smoke: false,
    dissolve_speed: 5,
    burning_rate: 0.75,
    flame_smoke: 1,
    flame_vorticity: 0.5,
    flame_max_temp: 3,
    display_thickness: 1,
    effector_weights_gravity: 1,
    effector_weights_all: 1,
    effector_weights_types: {},
    use_collision_border_front: false,
    use_collision_border_back: false,
    use_collision_border_right: false,
    use_collision_border_left: false,
    use_collision_border_top: false,
    use_collision_border_bottom: false,
  };
}

export function defaultFlowSettings(): FluidFlowSettings {
  return {
    flow_type: 'SMOKE',
    flow_behavior: 'INFLOW',
    use_flow: true,
    smoke_color: [0.7, 0.7, 0.7],
    fuel_amount: 1,
    temperature: 1,
    density: 1,
    surface_distance: 1.5,
    volume_density: 0,
    use_initial_velocity: false,
    velocity_factor: 1,
    velocity_normal: 0,
  };
}

export interface SmokeDraw {
  objectId: string;
  nx: number;
  ny: number;
  nz: number;
  /** RG8 interleaved: density, flame */
  data: Uint8Array;
  bmin: [number, number, number];
  bmax: [number, number, number];
  color: [number, number, number];
  thickness: number;
  fire: boolean;
}

/** Latest evaluated smoke grids per `${object id}:${modifier id}` (viewport evaluation only). */
export const smokeDraw = new Map<string, SmokeDraw>();

const fluidOf = (ob: ObjectData) => ob.modifiers.find((m) => m.type === 'FLUID') as FluidModifier | undefined;

function participants(doc: DocumentData, kind: 'FLOW' | 'EFFECTOR'): { ob: ObjectData; m: FluidModifier }[] {
  const out: { ob: ObjectData; m: FluidModifier }[] = [];
  for (const id of doc.object_order) {
    const ob = doc.objects[id];
    const m = ob ? fluidOf(ob) : undefined;
    if (ob && m && m.fluid_type === kind && m.show_viewport && ob.type === 'MESH' && !ob.hide_viewport) out.push({ ob, m });
  }
  return out;
}

function domainHash(doc: DocumentData, ob: ObjectData, m: FluidModifier, mesh: EvalMesh | null): string {
  const pc = m.point_cache;
  const parts = [
    JSON.stringify({ ...m.domain_settings, display_thickness: 0 }),
    pc.frame_start,
    pc.frame_end,
    mesh ? `${arrayChecksum(mesh.positions)}` : '',
    motionKey(doc, ob, pc.frame_start),
    doc.scene.gravity.join(','),
    doc.scene.use_gravity,
    fps(doc),
    fieldsKey(doc, pc.frame_start),
  ];
  for (const kind of ['FLOW', 'EFFECTOR'] as const)
    for (const p of participants(doc, kind)) {
      const me = p.ob.data ? doc.meshes[p.ob.data] : undefined;
      parts.push(`${kind}:${p.ob.id}:${JSON.stringify(kind === 'FLOW' ? p.m.flow_settings : p.m.effector_settings)}:${me ? meshSignature(me) : ''}:${JSON.stringify(p.ob.modifiers.filter((x) => x !== p.m))}:${motionKey(doc, p.ob, pc.frame_start)}`);
    }
  return strHash(parts.join('#'));
}

// ---------------------------------------------------------------------------
// Voxelization of flow / effector meshes into the domain grid

interface Voxels {
  /** emission weight per cell (0..1) */
  w: Float32Array;
  /** surface normal (grid axes) for surface cells */
  nx: Float32Array | null;
  ny: Float32Array | null;
  nz: Float32Array | null;
  /** object velocity per cell (cells/s) */
  vel: [number, number, number] | null;
}

interface GridFrame {
  toGrid: Matrix4; // world → grid coordinates
  nx: number;
  ny: number;
  nz: number;
}

function meshOf(ctx: SimContext, ob: ObjectData): EvalMesh | null {
  const ev = ctx.graph?.get(ob.id);
  if (ev?.mesh) return ev.mesh;
  const me = ob.data ? ctx.doc.meshes[ob.data] : undefined;
  return me ? baseEvalMesh(me) : null;
}

const triCache = new WeakMap<Uint32Array, Uint32Array>();
const _w = [0, 0, 0];

function voxelize(ctx: SimContext, ob: ObjectData, frame: number, G: GridFrame, surface: number, volume: number, wantNormals: boolean): Voxels | null {
  const mesh = meshOf(ctx, ob);
  if (!mesh) return null;
  let tris = triCache.get(mesh.indices);
  if (!tris) {
    tris = triangulate(mesh.positions, mesh.offsets, mesh.indices);
    triCache.set(mesh.indices, tris);
  }
  const M = new Matrix4().multiplyMatrices(G.toGrid, worldAt(ctx, ob, frame));
  const e = M.elements;
  const P = mesh.positions;
  const gp = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i],
      y = P[i + 1],
      z = P[i + 2];
    gp[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    gp[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    gp[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  const { nx, ny, nz } = G;
  const n = nx * ny * nz;
  const w = new Float32Array(n);
  const dist = wantNormals ? new Float32Array(n).fill(Infinity) : null;
  const vnx = wantNormals ? new Float32Array(n) : null,
    vny = wantNormals ? new Float32Array(n) : null,
    vnz = wantNormals ? new Float32Array(n) : null;
  // surface emission: cells within `surface` cells of a triangle
  if (surface > 0)
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3,
        b = tris[t + 1] * 3,
        c = tris[t + 2] * 3;
      const x0 = Math.max(0, Math.floor(Math.min(gp[a], gp[b], gp[c]) - surface)),
        x1 = Math.min(nx - 1, Math.ceil(Math.max(gp[a], gp[b], gp[c]) + surface));
      const y0 = Math.max(0, Math.floor(Math.min(gp[a + 1], gp[b + 1], gp[c + 1]) - surface)),
        y1 = Math.min(ny - 1, Math.ceil(Math.max(gp[a + 1], gp[b + 1], gp[c + 1]) + surface));
      const z0 = Math.max(0, Math.floor(Math.min(gp[a + 2], gp[b + 2], gp[c + 2]) - surface)),
        z1 = Math.min(nz - 1, Math.ceil(Math.max(gp[a + 2], gp[b + 2], gp[c + 2]) + surface));
      if (x0 > x1 || y0 > y1 || z0 > z1) continue;
      let tnx = 0,
        tny = 0,
        tnz = 0;
      if (wantNormals) {
        const e1x = gp[b] - gp[a],
          e1y = gp[b + 1] - gp[a + 1],
          e1z = gp[b + 2] - gp[a + 2];
        const e2x = gp[c] - gp[a],
          e2y = gp[c + 1] - gp[a + 1],
          e2z = gp[c + 2] - gp[a + 2];
        tnx = e1y * e2z - e1z * e2y;
        tny = e1z * e2x - e1x * e2z;
        tnz = e1x * e2y - e1y * e2x;
        const l = Math.hypot(tnx, tny, tnz) || 1;
        tnx /= l;
        tny /= l;
        tnz /= l;
      }
      for (let k = z0; k <= z1; k++)
        for (let j = y0; j <= y1; j++)
          for (let i = x0; i <= x1; i++) {
            const px = i + 0.5,
              py = j + 0.5,
              pz = k + 0.5;
            closestOnTri(px, py, pz, gp, a, b, c, _w);
            const qx = gp[a] * _w[0] + gp[b] * _w[1] + gp[c] * _w[2],
              qy = gp[a + 1] * _w[0] + gp[b + 1] * _w[1] + gp[c + 1] * _w[2],
              qz = gp[a + 2] * _w[0] + gp[b + 2] * _w[1] + gp[c + 2] * _w[2];
            const d = Math.hypot(px - qx, py - qy, pz - qz);
            if (d > surface) continue;
            const o = i + j * nx + k * nx * ny;
            const wt = Math.min(1, 1 - d / surface + 0.25);
            if (wt > w[o]) w[o] = wt;
            if (dist && d < dist[o]) {
              dist[o] = d;
              vnx![o] = tnx;
              vny![o] = tny;
              vnz![o] = tnz;
            }
          }
    }
  // volume: parity fill along x rows
  if (volume > 0) {
    const rows = new Map<number, number[]>();
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3,
        b = tris[t + 1] * 3,
        c = tris[t + 2] * 3;
      const y0 = Math.max(0, Math.ceil(Math.min(gp[a + 1], gp[b + 1], gp[c + 1]) - 0.5)),
        y1 = Math.min(ny - 1, Math.floor(Math.max(gp[a + 1], gp[b + 1], gp[c + 1]) - 0.5));
      const z0 = Math.max(0, Math.ceil(Math.min(gp[a + 2], gp[b + 2], gp[c + 2]) - 0.5)),
        z1 = Math.min(nz - 1, Math.floor(Math.max(gp[a + 2], gp[b + 2], gp[c + 2]) - 0.5));
      for (let k = z0; k <= z1; k++)
        for (let j = y0; j <= y1; j++) {
          const key = j + k * ny;
          let l = rows.get(key);
          if (!l) rows.set(key, (l = []));
          l.push(t);
        }
    }
    for (const [key, list] of rows) {
      const j = key % ny,
        k = (key - j) / ny;
      const y = j + 0.5,
        z = k + 0.5;
      const xs: number[] = [];
      for (const t of list) {
        const a = tris[t] * 3,
          b = tris[t + 1] * 3,
          c = tris[t + 2] * 3;
        const ay = gp[a + 1] - y,
          az = gp[a + 2] - z,
          by = gp[b + 1] - y,
          bz = gp[b + 2] - z,
          cy = gp[c + 1] - y,
          cz = gp[c + 2] - z;
        const d1 = ay * bz - az * by,
          d2 = by * cz - bz * cy,
          d3 = cy * az - cz * ay;
        if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;
        const s = d1 + d2 + d3;
        if (Math.abs(s) < 1e-12) continue;
        xs.push((gp[a] * d2 + gp[b] * d3 + gp[c] * d1) / s);
      }
      xs.sort((p, q) => p - q);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil(xs[q] - 0.5)),
          i1 = Math.min(nx - 1, Math.floor(xs[q + 1] - 0.5));
        for (let i = i0; i <= i1; i++) {
          const o = i + j * nx + k * nx * ny;
          if (volume > w[o]) w[o] = volume;
        }
      }
    }
  }
  // object velocity (grid cells per second) from the motion over the last frame
  let vel: [number, number, number] | null = null;
  const prev = new Matrix4().multiplyMatrices(G.toGrid, worldAt(ctx, ob, frame - 1));
  const c0 = new Vector3().setFromMatrixPosition(prev),
    c1 = new Vector3().setFromMatrixPosition(M);
  const f = fps(ctx.doc);
  if (c0.distanceToSquared(c1) > 1e-12) vel = [(c1.x - c0.x) * f, (c1.y - c0.y) * f, (c1.z - c0.z) * f];
  return { w, nx: vnx, ny: vny, nz: vnz, vel };
}

// ---------------------------------------------------------------------------
// Domain simulation

interface FluidFrame {
  data: Uint8Array;
}

interface FluidLive {
  grid: GasGrid;
  G: GridFrame;
  bmin: [number, number, number];
  bmax: [number, number, number];
  color: [number, number, number];
  fire: boolean;
}

export function fluidCacheKey(ob: ObjectData, m: ModifierBase) {
  return `FLUID:${ob.id}:${m.id}`;
}

function gridFrame(ctx: SimContext, ob: ObjectData, mesh: EvalMesh, res: number, frame: number): { G: GridFrame; bmin: [number, number, number]; bmax: [number, number, number] } {
  const P = mesh.positions;
  const bmin: [number, number, number] = [Infinity, Infinity, Infinity],
    bmax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let c = 0; c < 3; c++) {
      bmin[c] = Math.min(bmin[c], P[i + c]);
      bmax[c] = Math.max(bmax[c], P[i + c]);
    }
  for (let c = 0; c < 3; c++)
    if (!(bmax[c] > bmin[c])) {
      bmin[c] = -1;
      bmax[c] = 1;
    }
  const W = worldAt(ctx, ob, frame);
  const sc = new Vector3().setFromMatrixScale(W);
  const ws = [(bmax[0] - bmin[0]) * sc.x, (bmax[1] - bmin[1]) * sc.y, (bmax[2] - bmin[2]) * sc.z];
  const h = Math.max(...ws) / Math.max(4, Math.round(res));
  const nx = Math.max(2, Math.round(ws[0] / h)),
    ny = Math.max(2, Math.round(ws[1] / h)),
    nz = Math.max(2, Math.round(ws[2] / h));
  // world → local → grid
  const toGrid = new Matrix4()
    .makeScale(nx / (bmax[0] - bmin[0]), ny / (bmax[1] - bmin[1]), nz / (bmax[2] - bmin[2]))
    .multiply(new Matrix4().makeTranslation(-bmin[0], -bmin[1], -bmin[2]))
    .multiply(W.clone().invert());
  return { G: { toGrid, nx, ny, nz }, bmin, bmax };
}

function quantize(g: GasGrid): Uint8Array {
  const n = g.nx * g.ny * g.nz;
  const out = new Uint8Array(n * 2);
  for (let o = 0; o < n; o++) {
    out[o * 2] = Math.min(255, Math.round(Math.min(1, g.density[o]) * 255));
    out[o * 2 + 1] = Math.min(255, Math.round(Math.min(1, g.flame[o]) * 255));
  }
  return out;
}

function stepDomain(ctx: SimContext, ob: ObjectData, m: FluidModifier, L: FluidLive, k: number) {
  const s = { ...defaultDomainSettings(), ...m.domain_settings };
  const g = L.grid;
  const n = g.nx * g.ny * g.nz;
  const f = fps(ctx.doc);
  const dtFrame = (s.time_scale || 0) / f;
  const flows = participants(ctx.doc, 'FLOW');
  const effectors = participants(ctx.doc, 'EFFECTOR');
  // obstacles
  g.solid.fill(0);
  for (const e of effectors) {
    if (!e.m.effector_settings?.use_effector) continue;
    const vx = voxelize(ctx, e.ob, k, L.G, 0.75, 1, false);
    if (vx) for (let o = 0; o < n; o++) if (vx.w[o] > 0.5) g.solid[o] = 1;
  }
  // emitters (voxelized once per frame)
  const emit = flows
    .filter((fl) => fl.m.flow_settings?.use_flow !== false && fl.m.flow_settings?.flow_type !== 'LIQUID')
    .map((fl) => {
      const fs = { ...defaultFlowSettings(), ...fl.m.flow_settings };
      if (fs.flow_behavior === 'GEOMETRY' && k - 1 !== m.point_cache.frame_start) return null;
      const vx = voxelize(ctx, fl.ob, k, L.G, fs.surface_distance, fs.volume_density, fs.use_initial_velocity && fs.velocity_normal !== 0);
      return vx ? { fs, vx } : null;
    })
    .filter((x): x is { fs: FluidFlowSettings; vx: Voxels } => !!x);
  // colour of the smoke: emission-weighted average of the flows
  let cr = 0,
    cg = 0,
    cb = 0,
    cw = 0;
  for (const e of emit)
    if (e.fs.flow_type !== 'FIRE') {
      cr += e.fs.smoke_color[0];
      cg += e.fs.smoke_color[1];
      cb += e.fs.smoke_color[2];
      cw++;
    }
  if (cw) L.color = [cr / cw, cg / cw, cb / cw];
  if (emit.some((e) => e.fs.flow_type !== 'SMOKE')) L.fire = true;
  // CFL-limited substeps
  let vmax = 0;
  for (let o = 0; o < n; o++) vmax = Math.max(vmax, Math.abs(g.u[o]), Math.abs(g.v[o]), Math.abs(g.w[o]));
  const sub = Math.min(6, Math.max(1, Math.ceil((vmax * dtFrame) / 2.5)));
  const dt = dtFrame / sub;
  // gravity in grid axes, in cells/s²
  const gw = ctx.doc.scene.use_gravity ? new Vector3(...ctx.doc.scene.gravity) : new Vector3(0, 0, -9.81);
  const gmag = gw.length() || 9.81;
  const gridScale = new Vector3(L.G.nx, L.G.ny, L.G.nz).length() / new Vector3(...L.bmax).sub(new Vector3(...L.bmin)).length();
  const up = gw.clone().normalize().negate().transformDirection(L.G.toGrid);
  const sc = new Vector3().setFromMatrixScale(L.G.toGrid);
  const P: GasParams = {
    dt,
    up: [up.x, up.y, up.z],
    gravity: gmag * ((sc.x + sc.y + sc.z) / 3 || gridScale) * (s.effector_weights_gravity ?? 1),
    alpha: s.alpha,
    beta: s.beta,
    vorticity: s.vorticity * 4,
    flameVorticity: L.fire ? s.flame_vorticity * 4 : 0,
    burningRate: L.fire ? s.burning_rate : 0,
    flameSmoke: s.flame_smoke,
    flameMaxTemp: s.flame_max_temp,
    dissolve: s.use_dissolve_smoke ? f / Math.max(1, s.dissolve_speed) : 0,
    heatDecay: 0.5,
    pressureIterations: 30,
    closed: [s.use_collision_border_left, s.use_collision_border_right, s.use_collision_border_front, s.use_collision_border_back, s.use_collision_border_bottom, s.use_collision_border_top],
  };
  // force fields push the air: acceleration per cell (grid units), evaluated once per frame
  const fieldAcc = fieldAccelerations(ctx, L.G, k, s.effector_weights_all ?? 1, s.effector_weights_types ?? null, g.u, g.v, g.w);
  for (let st = 0; st < sub; st++) {
    if (fieldAcc)
      for (let o = 0; o < n; o++) {
        g.u[o] += fieldAcc[o * 3] * dt;
        g.v[o] += fieldAcc[o * 3 + 1] * dt;
        g.w[o] += fieldAcc[o * 3 + 2] * dt;
      }
    for (const { fs, vx } of emit) {
      const w = vx.w;
      for (let o = 0; o < n; o++) {
        const a = w[o];
        if (a <= 0 || g.solid[o]) continue;
        if (fs.flow_behavior === 'OUTFLOW') {
          g.density[o] = g.fuel[o] = g.flame[o] = g.heat[o] = 0;
          continue;
        }
        if (fs.flow_type !== 'FIRE') g.density[o] = Math.max(g.density[o], fs.density * a);
        if (fs.flow_type !== 'SMOKE') g.fuel[o] = Math.max(g.fuel[o], fs.fuel_amount * a);
        // small deterministic jitter breaks the symmetry of the plume (turbulent look)
        const jit = 0.75 + 0.5 * rand01(o, k, st, 77);
        g.heat[o] = Math.max(g.heat[o], fs.temperature * a * jit);
        if (fs.use_initial_velocity) {
          if (vx.vel) {
            g.u[o] = vx.vel[0] * fs.velocity_factor;
            g.v[o] = vx.vel[1] * fs.velocity_factor;
            g.w[o] = vx.vel[2] * fs.velocity_factor;
          }
          if (vx.nx && fs.velocity_normal) {
            const nf = fs.velocity_normal * gmag;
            g.u[o] += vx.nx[o] * nf;
            g.v[o] += vx.ny![o] * nf;
            g.w[o] += vx.nz![o] * nf;
          }
        }
      }
    }
    stepGas(g, P);
  }
}

/**
 * Accelerations (grid cells per second², grid axes) the force fields give each cell of a domain grid,
 * or null without fields. `u v w` are the current cell velocities (grid units per second).
 */
export function fieldAccelerations(ctx: SimContext, G: GridFrame, frame: number, weight: number, types: Record<string, number> | null, u?: Float32Array, v?: Float32Array, w?: Float32Array): Float32Array | null {
  const effs = collectEffectors(ctx, frame - 1);
  if (!effs.length || weight === 0) return null;
  const { nx, ny, nz } = G;
  const toWorld = G.toGrid.clone().invert();
  const lin = G.toGrid.clone().setPosition(0, 0, 0);
  const linInv = toWorld.clone().setPosition(0, 0, 0);
  const out = new Float32Array(nx * ny * nz * 3);
  const p = new Vector3(),
    vel = new Vector3(),
    f = [0, 0, 0];
  const fpsv = fps(ctx.doc);
  let o = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        p.set(i + 0.5, j + 0.5, k + 0.5).applyMatrix4(toWorld);
        vel.set(u ? u[o] : 0, v ? v[o] : 0, w ? w[o] : 0).applyMatrix4(linInv);
        f[0] = f[1] = f[2] = 0;
        effectorForce(effs, p.x, p.y, p.z, vel.x, vel.y, vel.z, frame, f, weight, null, types);
        vel.set(f[0], f[1], f[2]).applyMatrix4(lin);
        out[o * 3] = vel.x;
        out[o * 3 + 1] = vel.y;
        out[o * 3 + 2] = vel.z;
      }
  void fpsv;
  return out;
}

export function evaluateDomain(ob: ObjectData, m: FluidModifier, mesh: EvalMesh, ctx: ModifierContext): { frame: FluidFrame; live: FluidLive } | null {
  const doc = ctx.doc;
  const pc = m.point_cache;
  const cache = getCache<FluidFrame, FluidLive>(fluidCacheKey(ob, m)) as FrameCache<FluidFrame, FluidLive>;
  cache.label = `${ob.name} ▸ ${m.name}`;
  cache.start = pc.frame_start;
  cache.end = pc.frame_end;
  cache.baked = pc.is_baked;
  const hash = domainHash(doc, ob, m, mesh);
  const usable = pc.is_baked && cache.frames.size > 0 && !!cache.live;
  if (!usable && cache.hash !== hash) cache.reset(hash);
  const f = Math.min(Math.max(frameOf(ctx.graph), pc.frame_start), pc.frame_end);
  const sctx: SimContext = { doc, graph: ctx.graph };
  if (!cache.frames.has(f)) {
    if (!cache.live || cache.last < pc.frame_start) {
      const s = { ...defaultDomainSettings(), ...m.domain_settings };
      const { G, bmin, bmax } = gridFrame(sctx, ob, mesh, Math.min(256, Math.max(8, s.resolution_max)), pc.frame_start);
      cache.frames.clear();
      cache.live = { grid: newGrid(G.nx, G.ny, G.nz), G, bmin, bmax, color: [0.7, 0.7, 0.7], fire: false };
      cache.frames.set(pc.frame_start, { data: quantize(cache.live.grid) });
      cache.last = pc.frame_start;
    }
    while (cache.last < f) {
      if (cache.last > pc.frame_start && outOfTime()) break;
      const k = cache.last + 1;
      stepDomain(sctx, ob, m, cache.live!, k);
      cache.frames.set(k, { data: quantize(cache.live!.grid) });
      cache.last = k;
    }
  }
  const frame = cache.frames.get(f) ?? cache.nearest(f);
  return frame && cache.live ? { frame, live: cache.live } : null;
}

function fluidApply(mesh: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const m = mod as FluidModifier;
  const key = `${ctx.ob.id}:${m.id}`;
  if (m.fluid_type !== 'DOMAIN' || ctx.editMode) {
    if (!ctx.render) smokeDraw.delete(key);
    return mesh;
  }
  if (m.domain_settings?.domain_type === 'LIQUID') {
    if (!ctx.render) smokeDraw.delete(key);
    const lr = evaluateLiquid(ctx.ob, m, mesh, ctx);
    return lr ? liquidMesh(lr, { ...defaultDomainSettings(), ...m.domain_settings }) : mesh;
  }
  const r = evaluateDomain(ctx.ob, m, mesh, ctx);
  if (!ctx.render) {
    if (r)
      smokeDraw.set(key, {
        objectId: ctx.ob.id,
        nx: r.live.grid.nx,
        ny: r.live.grid.ny,
        nz: r.live.grid.nz,
        data: r.frame.data,
        bmin: r.live.bmin,
        bmax: r.live.bmax,
        color: r.live.color,
        thickness: m.domain_settings?.display_thickness ?? 1,
        fire: r.live.fire,
      });
    else smokeDraw.delete(key);
  }
  return mesh;
}

registerModifier({
  type: 'FLUID',
  label: 'Fluid',
  category: 'PHYSICS',
  icon: 'mod_fluid',
  deformOnly: true,
  defaults: () => {
    const sc = physicsDoc()?.scene;
    return {
      fluid_type: 'NONE',
      domain_settings: defaultDomainSettings(),
      flow_settings: defaultFlowSettings(),
      effector_settings: { effector_type: 'COLLISION', use_effector: true },
      point_cache: defaultPointCache(sc?.frame_start ?? 1, sc?.frame_end ?? 250),
    };
  },
  timeDependent: (m) => (m as FluidModifier).fluid_type === 'DOMAIN',
  deps: (m) => {
    const doc = physicsDoc();
    if (!doc || (m as FluidModifier).fluid_type !== 'DOMAIN') return [];
    return [...participants(doc, 'FLOW'), ...participants(doc, 'EFFECTOR')].map((p) => p.ob.id);
  },
  signature: (mod, c) => {
    const m = mod as FluidModifier;
    if (m.fluid_type !== 'DOMAIN') return '';
    const cache = getCache<FluidFrame, FluidLive>(fluidCacheKey(c.ob, m));
    const pc = m.point_cache;
    const f = Math.min(Math.max(frameOf(c.graph as Depsgraph), pc.frame_start), pc.frame_end);
    return `${domainHash(c.doc, c.ob, m, null)}:${cache.frames.has(f) ? 'hit' : 'miss' + cache.last}:${cache.frames.size}`;
  },
  apply: fluidApply,
});

fluidShared.fns = {
  participants,
  voxelize,
  gridFrame,
  domainHash,
  cacheKey: fluidCacheKey,
  fieldAccelerations,
  domainDefaults: defaultDomainSettings,
  flowDefaults: defaultFlowSettings,
};
