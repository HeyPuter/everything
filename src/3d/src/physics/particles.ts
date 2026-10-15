// Particle systems: Newtonian emitter particles (frame cached, deterministic per seed)
// and static hair strands with simple children. Evaluated by the Particle System
// modifier; points/strands are drawn by the viewport overlay (draw.ts), objects are
// instanced through EvalMesh.instances.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { DocumentData, ObjectData, ModifierBase } from '../data/types';
import type { EvalMesh, GeometryInstance, ModifierContext } from '../eval/types';
import type { Depsgraph } from '../eval/depsgraph';
import { meshSignature } from '../eval/depsgraph';
import { registerModifier } from '../eval/modifiers';
import { arrayChecksum, frameOf, getCache, motionKey, outOfTime, rand01, strHash, worldAt, type FrameCache, type SimContext } from './common';
import { collectEffectors, effectorForce, fieldsKey, valueNoise } from './fields';
import { buildColliders, collidersKey, segmentHit, newHit } from './colliders';
import { MeshSampler, newSample, type Sample } from './sampling';
import { physicsDoc } from './state';
import { fps, gravityOf, simDeps } from './meshsim';
import { defaultParticleSettings, defaultPointCache, type CollisionSettingsX, type ParticleSettingsX, type ParticleSystemX } from './types';
import { simplifyChildParticles } from '../eval/simplify';

export interface ParticleDraw {
  objectId: string;
  /** points (world space when space = 'WORLD', else object space) */
  space: 'WORLD' | 'LOCAL';
  points: Float32Array | null;
  sizes: Float32Array | null;
  /** line segments (pairs of points) */
  lines: Float32Array | null;
  color: [number, number, number];
  count: number;
}

/** Latest evaluated draw data per `${object id}:${modifier id}` (viewport evaluation only). */
export const particleDraw = new Map<string, ParticleDraw>();

export function settingsOf(doc: DocumentData, psys: ParticleSystemX): ParticleSettingsX | null {
  const s = doc.particles[psys.settings] as ParticleSettingsX | undefined;
  return s ? ({ ...defaultParticleSettings(s.id, s.name), ...s } as ParticleSettingsX) : null;
}

export function systemOf(ob: ObjectData, m: ModifierBase): ParticleSystemX | undefined {
  const id = m.particle_system as string | undefined;
  return (ob.particle_systems as ParticleSystemX[]).find((p) => (p as { id?: string }).id === id);
}

const SIM_KEYS: (keyof ParticleSettingsX)[] = [
  'type',
  'count',
  'frame_start',
  'frame_end',
  'lifetime',
  'lifetime_random',
  'emit_from',
  'normal_factor',
  'object_align_factor',
  'factor_random',
  'object_factor',
  'mass',
  'effector_weights_gravity',
  'effector_weights_all',
  'drag_factor',
  'brownian_factor',
  'damping',
  'physics_type',
  'timestep_substeps',
  'use_collision',
  'seed',
];

export function particleCacheKey(ob: ObjectData, m: ModifierBase) {
  return `PARTICLES:${ob.id}:${m.id}`;
}

function simHash(doc: DocumentData, ob: ObjectData, m: ModifierBase, psys: ParticleSystemX, s: ParticleSettingsX, mesh: EvalMesh | null, source: ModifierContext['source']): string {
  const pc = psys.point_cache ?? defaultPointCache();
  const before: unknown[] = [];
  for (const x of ob.modifiers) {
    if (x === m) break;
    before.push(x);
  }
  const parts = [
    SIM_KEYS.map((k) => JSON.stringify(s[k])).join(','),
    psys.seed,
    pc.frame_start,
    pc.frame_end,
    JSON.stringify(before),
    source ? meshSignature(source) : '',
    mesh ? `${mesh.positions.length}:${arrayChecksum(mesh.indices)}` : '',
    doc.scene.use_gravity,
    doc.scene.gravity.join(','),
    fps(doc),
    motionKey(doc, ob, pc.frame_start),
    s.use_collision ? collidersKey(doc, pc.frame_start, ob.id) : '',
    fieldsKey(doc, pc.frame_start),
  ];
  return strHash(parts.join('#'));
}

// ---------------------------------------------------------------------------
// Emitter simulation

interface PFrame {
  pos: Float32Array;
  /** 0 unborn, 1 alive, 2 dead (killed or expired) */
  state: Uint8Array;
}

interface PLive {
  pos: Float32Array;
  vel: Float32Array;
  state: Uint8Array;
  birth: Float32Array;
  life: Float32Array;
  samples: Sample[];
  sampler: MeshSampler;
  step: number;
}

export interface EmitterResult {
  frame: PFrame;
  birth: Float32Array;
  life: Float32Array;
  prev: PFrame | undefined;
}

function initLive(s: ParticleSettingsX, seed: number, mesh: EvalMesh): PLive {
  const n = Math.max(0, Math.floor(s.count));
  const birth = new Float32Array(n),
    life = new Float32Array(n);
  const span = s.frame_end - s.frame_start;
  const sampler = new MeshSampler(mesh);
  const samples: Sample[] = [];
  for (let i = 0; i < n; i++) {
    birth[i] = s.frame_start + (n > 0 ? (span * i) / n : 0);
    life[i] = Math.max(1, s.lifetime * (1 - s.lifetime_random * rand01(seed, i, 1)));
    const sm = newSample();
    if (!sampler.sample(s.emit_from, seed, i, sm)) sm.px = sm.py = sm.pz = 0;
    samples.push(sm);
  }
  return { pos: new Float32Array(n * 3), vel: new Float32Array(n * 3), state: new Uint8Array(n), birth, life, samples, sampler, step: 0 };
}

const _v = new Vector3(),
  _n = new Vector3(),
  _a = new Vector3();
const hit = newHit();

function lerpMatrix(a: Matrix4, b: Matrix4, t: number, out: Matrix4) {
  for (let i = 0; i < 16; i++) out.elements[i] = a.elements[i] + (b.elements[i] - a.elements[i]) * t;
  return out;
}

/** Spawn particle i at frame time tb (between frame k-1 matrix A and frame k matrix B). */
function spawn(L: PLive, s: ParticleSettingsX, seed: number, i: number, A: Matrix4, B: Matrix4, k: number, fpsv: number) {
  const tb = L.birth[i];
  const frac = Math.min(1, Math.max(0, tb - (k - 1)));
  const M = lerpMatrix(A, B, frac, new Matrix4());
  const sm = L.samples[i];
  _v.set(sm.px, sm.py, sm.pz).applyMatrix4(M);
  L.pos[i * 3] = _v.x;
  L.pos[i * 3 + 1] = _v.y;
  L.pos[i * 3 + 2] = _v.z;
  if (s.physics_type === 'NO') return;
  // initial velocity: normal + object aligned + random + emitter motion
  _n.set(sm.nx, sm.ny, sm.nz).transformDirection(M).multiplyScalar(s.normal_factor);
  _a.set(s.object_align_factor[0], s.object_align_factor[1], s.object_align_factor[2]).transformDirection(M).multiplyScalar(Math.hypot(...s.object_align_factor));
  _n.add(_a);
  if (s.factor_random) _n.add(_a.set(rand01(seed, i, 30) * 2 - 1, rand01(seed, i, 31) * 2 - 1, rand01(seed, i, 32) * 2 - 1).multiplyScalar(s.factor_random));
  if (s.object_factor) {
    const p0 = new Vector3(sm.px, sm.py, sm.pz).applyMatrix4(A),
      p1 = new Vector3(sm.px, sm.py, sm.pz).applyMatrix4(B);
    _n.add(p1.sub(p0).multiplyScalar(fpsv * (s.object_factor ?? 0)));
  }
  L.vel[i * 3] = _n.x;
  L.vel[i * 3 + 1] = _n.y;
  L.vel[i * 3 + 2] = _n.z;
}

/** Advance the emitter from frame k-1 to k. */
export function stepParticles(L: PLive, s: ParticleSettingsX, seed: number, k: number, A: Matrix4, B: Matrix4, ctx: SimContext, ob: ObjectData, timeScale = 1) {
  const n = L.state.length;
  const fpsv = fps(ctx.doc);
  const sub = Math.max(1, Math.round(s.timestep_substeps ?? 1));
  const dtf = 1 / sub; // frames per substep
  const dt = (dtf / fpsv) * timeScale;
  const g = gravityOf(ctx.doc, (s.effector_weights_gravity ?? 1) * (s.effector_weights_all ?? 1));
  const effs = collectEffectors(ctx, k - 1, ob.id);
  const cols = s.use_collision !== false && s.physics_type !== 'NO' ? buildColliders(ctx, k, ob.id, 0.05) : [];
  const invMass = 1 / Math.max(1e-4, s.mass);
  const f = [0, 0, 0];
  const damp = Math.pow(1 - Math.min(1, Math.max(0, s.damping ?? 0)), dtf);
  for (let ss = 0; ss < sub; ss++) {
    const t0 = k - 1 + ss * dtf,
      t1 = t0 + dtf;
    for (const c of cols) c.setTime((ss + 1) / sub);
    L.step++;
    for (let i = 0; i < n; i++) {
      let st = L.state[i];
      if (st === 2) continue;
      const b = L.birth[i];
      if (st === 0) {
        if (b > t1) continue;
        spawn(L, s, seed, i, A, B, k, fpsv);
        L.state[i] = st = 1;
      }
      if (t1 > b + L.life[i]) {
        L.state[i] = 2;
        continue;
      }
      if (s.physics_type === 'NO') continue;
      // time of this particle inside the substep (newborns integrate the remainder only)
      const h = b > t0 ? (dt * (t1 - b)) / dtf : dt;
      if (h <= 0) continue;
      const j = i * 3;
      const px = L.pos[j],
        py = L.pos[j + 1],
        pz = L.pos[j + 2];
      let vx = L.vel[j],
        vy = L.vel[j + 1],
        vz = L.vel[j + 2];
      f[0] = f[1] = f[2] = 0;
      if (effs.length) effectorForce(effs, px, py, pz, vx, vy, vz, t1, f, s.effector_weights_all ?? 1);
      let ax = g[0] + f[0] * invMass,
        ay = g[1] + f[1] * invMass,
        az = g[2] + f[2] * invMass;
      if (s.drag_factor) {
        const sp = Math.hypot(vx, vy, vz);
        ax -= vx * sp * s.drag_factor;
        ay -= vy * sp * s.drag_factor;
        az -= vz * sp * s.drag_factor;
      }
      if (s.brownian_factor) {
        const bf = s.brownian_factor * 10;
        ax += (rand01(seed, i, L.step, 40) * 2 - 1) * bf;
        ay += (rand01(seed, i, L.step, 41) * 2 - 1) * bf;
        az += (rand01(seed, i, L.step, 42) * 2 - 1) * bf;
      }
      vx = (vx + ax * h) * damp;
      vy = (vy + ay * h) * damp;
      vz = (vz + az * h) * damp;
      let nx = px + vx * h,
        ny = py + vy * h,
        nz = pz + vz * h;
      // collisions: bounce off the first surface crossed during the step
      for (let bounce = 0; bounce < 2 && cols.length; bounce++) {
        if (!segmentHit(cols, L.pos[j], L.pos[j + 1], L.pos[j + 2], nx, ny, nz, hit)) break;
        const cs = hit.collider!.settings as CollisionSettingsX;
        if ((cs.permeability ?? 0) > 0 && rand01(seed, i, L.step, 50) < (cs.permeability ?? 0)) break;
        if (cs.use_particle_kill) {
          L.state[i] = 2;
          break;
        }
        const side = (L.pos[j] - hit.cx) * hit.nx + (L.pos[j + 1] - hit.cy) * hit.ny + (L.pos[j + 2] - hit.cz) * hit.nz >= 0 ? 1 : -1;
        const nnx = hit.nx * side,
          nny = hit.ny * side,
          nnz = hit.nz * side;
        // velocity relative to the moving surface
        const svx = (hit.vx * fpsv) / timeScale,
          svy = (hit.vy * fpsv) / timeScale,
          svz = (hit.vz * fpsv) / timeScale;
        const rx = vx - svx,
          ry = vy - svy,
          rz = vz - svz;
        const vn = rx * nnx + ry * nny + rz * nnz;
        const restitution = 1 - Math.min(1, Math.max(0, cs.damping_factor ?? 0));
        const keepT = 1 - Math.min(1, Math.max(0, cs.friction_factor ?? 0));
        const tx = rx - nnx * vn,
          ty = ry - nny * vn,
          tz = rz - nnz * vn;
        vx = svx + tx * keepT - nnx * vn * restitution;
        vy = svy + ty * keepT - nny * vn * restitution;
        vz = svz + tz * keepT - nnz * vn * restitution;
        const eps = 1e-4;
        L.pos[j] = hit.cx + nnx * eps;
        L.pos[j + 1] = hit.cy + nny * eps;
        L.pos[j + 2] = hit.cz + nnz * eps;
        const rem = h * (1 - hit.dist);
        nx = L.pos[j] + vx * rem;
        ny = L.pos[j + 1] + vy * rem;
        nz = L.pos[j + 2] + vz * rem;
      }
      if (L.state[i] === 2) continue;
      L.pos[j] = nx;
      L.pos[j + 1] = ny;
      L.pos[j + 2] = nz;
      L.vel[j] = vx;
      L.vel[j + 1] = vy;
      L.vel[j + 2] = vz;
    }
  }
}

/** Evaluate the emitter at frame f (stepping the cache from its start frame). */
export function evaluateEmitter(ob: ObjectData, m: ModifierBase, psys: ParticleSystemX, s: ParticleSettingsX, mesh: EvalMesh, ctx: ModifierContext): EmitterResult | null {
  const doc = ctx.doc;
  const pc = psys.point_cache ?? defaultPointCache();
  const cache = getCache<PFrame, PLive>(particleCacheKey(ob, m)) as FrameCache<PFrame, PLive>;
  cache.label = `${ob.name} ▸ ${psys.name}`;
  cache.start = pc.frame_start;
  cache.end = pc.frame_end;
  cache.baked = pc.is_baked;
  const seed = hashSeed(psys.seed, s.seed ?? 0);
  const hash = simHash(doc, ob, m, psys, s, mesh, ctx.source);
  const count = Math.max(0, Math.floor(s.count));
  const usable = pc.is_baked && cache.frames.size > 0 && cache.frames.values().next().value?.state.length === count;
  if (!usable && cache.hash !== hash) cache.reset(hash);
  const f = Math.min(Math.max(frameOf(ctx.graph), pc.frame_start), pc.frame_end);
  const sctx: SimContext = { doc, graph: ctx.graph };
  if (!cache.frames.has(f)) {
    if (!cache.live || cache.last < pc.frame_start) {
      cache.frames.clear();
      cache.live = initLive(s, seed, mesh);
      const M = worldAt(sctx, ob, pc.frame_start);
      // particles born at or before the start frame appear at their emission points
      const L = cache.live;
      for (let i = 0; i < count; i++)
        if (L.birth[i] <= pc.frame_start) {
          spawn(L, s, seed, i, M, M, pc.frame_start, fps(doc));
          L.state[i] = pc.frame_start > L.birth[i] + L.life[i] ? 2 : 1;
        }
      cache.frames.set(pc.frame_start, { pos: L.pos.slice(), state: L.state.slice() });
      cache.last = pc.frame_start;
    }
    const L = cache.live!;
    while (cache.last < f) {
      if (cache.last > pc.frame_start && outOfTime()) break;
      const k = cache.last + 1;
      stepParticles(L, s, seed, k, worldAt(sctx, ob, k - 1), worldAt(sctx, ob, k), sctx, ob);
      cache.frames.set(k, { pos: L.pos.slice(), state: L.state.slice() });
      cache.last = k;
    }
  }
  const frame = cache.frames.get(f) ?? cache.nearest(f);
  if (!frame) return null;
  const birth = cache.live?.birth ?? initLive(s, seed, mesh).birth;
  const life = cache.live?.life ?? new Float32Array(count).fill(s.lifetime);
  return { frame, birth, life, prev: cache.frames.get(f - 1) };
}

const hashSeed = (a: number, b: number) => (Math.imul(a | 0, 2654435761) ^ (b | 0)) >>> 0;

// ---------------------------------------------------------------------------
// Hair

export interface HairResult {
  /** strand points (object space), `segments + 1` per strand */
  points: Float32Array;
  segments: number;
  strands: number;
  parents: number;
}

const hairCache = new Map<string, { hash: string; result: HairResult }>();

/** Strand points resampled to `n` points (smooth through the keys). */
export function resampleKeys(co: ArrayLike<number>, a: number, b: number, n: number, out: Float32Array, o: number) {
  const k = b - a;
  if (k <= 0) return;
  if (k === 1) {
    for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) out[(o + i) * 3 + j] = co[a * 3 + j];
    return;
  }
  // cumulative lengths along the keys, then Catmull-Rom between the keys
  const cum = new Float64Array(k);
  for (let i = 1; i < k; i++) cum[i] = cum[i - 1] + Math.hypot(co[(a + i) * 3] - co[(a + i - 1) * 3], co[(a + i) * 3 + 1] - co[(a + i - 1) * 3 + 1], co[(a + i) * 3 + 2] - co[(a + i - 1) * 3 + 2]);
  const total = cum[k - 1];
  let seg = 1;
  const P = (i: number, j: number) => co[(a + Math.max(0, Math.min(k - 1, i))) * 3 + j];
  for (let s = 0; s < n; s++) {
    const t = n > 1 ? (s / (n - 1)) * total : 0;
    while (seg < k - 1 && cum[seg] < t) seg++;
    const l = cum[seg] - cum[seg - 1];
    const f = l > 0 ? Math.min(1, Math.max(0, (t - cum[seg - 1]) / l)) : 0;
    const f2 = f * f,
      f3 = f2 * f;
    for (let j = 0; j < 3; j++) {
      const p0 = P(seg - 2, j),
        p1 = P(seg - 1, j),
        p2 = P(seg, j),
        p3 = P(seg + 1, j);
      out[(o + s) * 3 + j] = 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
    }
  }
}

export function evaluateHair(ob: ObjectData, m: ModifierBase, psys: ParticleSystemX, s: ParticleSettingsX, mesh: EvalMesh, childFactor = 1): HairResult {
  const key = particleCacheKey(ob, m);
  const ed = psys.edited_hair ?? null;
  const hash = strHash(
    [
      JSON.stringify([s.count, s.emit_from, s.normal_factor, s.object_align_factor, s.factor_random, s.hair_length, s.hair_step, s.child_type, s.rendered_child_count, s.child_radius, s.clump_factor, s.roughness_1, s.seed, childFactor]),
      psys.seed,
      ed ? `E${ed.key_offsets.length}:${arrayChecksum(ed.co)}:${arrayChecksum(ed.hide)}` : `${mesh.positions.length}:${arrayChecksum(mesh.positions)}:${arrayChecksum(mesh.indices)}`,
    ].join('#'),
  );
  const hit0 = hairCache.get(key);
  if (hit0 && hit0.hash === hash) return hit0.result;
  const seed = hashSeed(psys.seed, s.seed ?? 0);
  const seg = Math.max(1, Math.round(s.hair_step ?? 5));
  const per = seg + 1;
  const children = s.child_type === 'SIMPLE' ? Math.max(0, Math.round((s.rendered_child_count ?? 0) * childFactor)) : 0;
  // parents: generated straight strands, or the edited keys
  const parentPts: number[] = [];
  let parents = 0;
  const tmp = new Float32Array(per * 3);
  if (ed) {
    const nk = ed.key_offsets.length - 1;
    for (let i = 0; i < nk; i++) {
      if (ed.hide[i]) continue;
      resampleKeys(ed.co, ed.key_offsets[i], ed.key_offsets[i + 1], per, tmp, 0);
      for (let k = 0; k < tmp.length; k++) parentPts.push(tmp[k]);
      parents++;
    }
  } else {
    const n = Math.max(0, Math.floor(s.count));
    const sampler = new MeshSampler(mesh);
    const sm = newSample();
    const dir = new Vector3();
    for (let i = 0; i < n; i++) {
      if (!sampler.sample(s.emit_from, seed, i, sm)) continue;
      dir.set(sm.nx, sm.ny, sm.nz).multiplyScalar(s.normal_factor);
      dir.add(new Vector3(...s.object_align_factor));
      if (s.factor_random) dir.add(new Vector3(rand01(seed, i, 30) * 2 - 1, rand01(seed, i, 31) * 2 - 1, rand01(seed, i, 32) * 2 - 1).multiplyScalar(s.factor_random));
      if (dir.lengthSq() < 1e-12) dir.set(sm.nx, sm.ny, sm.nz);
      dir.normalize();
      for (let k = 0; k <= seg; k++) {
        const t = (k / seg) * s.hair_length;
        parentPts.push(sm.px + dir.x * t, sm.py + dir.y * t, sm.pz + dir.z * t);
      }
      parents++;
    }
  }
  const total = parents * (1 + children);
  const pts = new Float32Array(total * per * 3);
  pts.set(parentPts);
  let w = parentPts.length;
  const d = new Vector3(),
    tan = new Vector3(),
    bit = new Vector3(),
    up = new Vector3();
  for (let i = 0; i < parents && children; i++) {
    const b = i * per * 3;
    d.set(pts[b + 3] - pts[b], pts[b + 4] - pts[b + 1], pts[b + 5] - pts[b + 2]);
    if (d.lengthSq() < 1e-16) d.set(0, 0, 1);
    d.normalize();
    // strand length (children grow as long as their parent)
    let len = 0;
    for (let k = 1; k <= seg; k++) len += Math.hypot(pts[b + k * 3] - pts[b + k * 3 - 3], pts[b + k * 3 + 1] - pts[b + k * 3 - 2], pts[b + k * 3 + 2] - pts[b + k * 3 - 1]);
    up.set(Math.abs(d.z) < 0.9 ? 0 : 1, 0, Math.abs(d.z) < 0.9 ? 1 : 0);
    tan.crossVectors(d, up).normalize();
    bit.crossVectors(d, tan).normalize();
    for (let c = 0; c < children; c++) {
      const ang = rand01(seed, i, c, 60) * Math.PI * 2;
      const rad = Math.sqrt(rand01(seed, i, c, 61)) * (s.child_radius ?? 0.2);
      const ox = tan.x * Math.cos(ang) * rad + bit.x * Math.sin(ang) * rad;
      const oy = tan.y * Math.cos(ang) * rad + bit.y * Math.sin(ang) * rad;
      const oz = tan.z * Math.cos(ang) * rad + bit.z * Math.sin(ang) * rad;
      for (let k = 0; k <= seg; k++) {
        const u = k / seg;
        const clump = 1 - (s.clump_factor ?? 0) * u;
        let x = pts[b + k * 3] + ox * clump,
          y = pts[b + k * 3 + 1] + oy * clump,
          z = pts[b + k * 3 + 2] + oz * clump;
        const r = (s.roughness_1 ?? 0) * u * len;
        if (r) {
          x += valueNoise(x * 4, y * 4, z * 4, seed + c, 0) * r;
          y += valueNoise(x * 4, y * 4, z * 4, seed + c, 1) * r;
          z += valueNoise(x * 4, y * 4, z * 4, seed + c, 2) * r;
        }
        pts[w++] = x;
        pts[w++] = y;
        pts[w++] = z;
      }
    }
  }
  const result: HairResult = { points: w === pts.length ? pts : pts.slice(0, w), segments: seg, strands: w / 3 / per, parents };
  hairCache.set(key, { hash, result });
  return result;
}

/** Signature-friendly JSON of a particle system (typed arrays of edited hair by checksum). */
export function psysKey(ps: ParticleSystemX): string {
  return JSON.stringify(ps, (_k, v) => (ArrayBuffer.isView(v) ? `#${(v as Float32Array).length}:${arrayChecksum(v as Float32Array)}` : v));
}

// ---------------------------------------------------------------------------
// Modifier

function materialColor(doc: DocumentData, ob: ObjectData, slot: number): [number, number, number] | null {
  const me = ob.data ? doc.meshes[ob.data] : undefined;
  const id = me?.materials[slot - 1];
  const ma = id ? doc.materials[id] : undefined;
  return ma ? [ma.diffuse_color[0], ma.diffuse_color[1], ma.diffuse_color[2]] : null;
}

function instanceMatrix(owner: Matrix4, pos: Vector3, rot: Quaternion, size: number, inst: ObjectData | undefined, useScale: boolean) {
  const sc = new Vector3(size, size, size);
  if (inst && useScale) sc.multiply(new Vector3(...inst.scale));
  return new Matrix4().copy(owner).invert().multiply(new Matrix4().compose(pos, rot, sc)).toArray();
}

const X = new Vector3(1, 0, 0);

export function particleModifierApply(mesh: EvalMesh, m: ModifierBase, ctx: ModifierContext): EvalMesh {
  const ob = ctx.ob,
    doc = ctx.doc;
  const psys = systemOf(ob, m);
  const key = `${ob.id}:${m.id}`;
  const s = psys ? settingsOf(doc, psys) : null;
  if (!psys || !s || ctx.editMode) {
    if (!ctx.render) particleDraw.delete(key);
    return mesh;
  }
  const owner = (ctx.graph as Depsgraph).get(ob.id)?.world ?? new Matrix4();
  const show = ctx.render ? 'RENDER' : s.display_method ?? 'RENDER';
  const color = materialColor(doc, ob, s.material_slot ?? 1) ?? [0.9, 0.9, 0.9];
  const inst = s.render_type === 'OBJECT' && s.instance_object ? doc.objects[s.instance_object] : undefined;
  const wantInstances = show === 'RENDER' && !!inst && inst.id !== ob.id;
  const wantPoints = show === 'DOT' || (show === 'RENDER' && s.render_type === 'HALO');
  const instances: GeometryInstance[] = [];
  let draw: ParticleDraw | null = null;
  if (s.type === 'HAIR') {
    const hair = evaluateHair(ob, m, psys, s, mesh, simplifyChildParticles(doc, ctx.render));
    const per = hair.segments + 1;
    if (show !== 'NONE' && (s.render_type === 'PATH' || show === 'DOT' || !wantInstances)) {
      const lines = new Float32Array(hair.strands * hair.segments * 6);
      let w = 0;
      for (let i = 0; i < hair.strands; i++)
        for (let k = 0; k < hair.segments; k++) {
          const a = (i * per + k) * 3;
          lines.set(hair.points.subarray(a, a + 6), w);
          w += 6;
        }
      draw = { objectId: ob.id, space: 'LOCAL', points: null, sizes: null, lines, color, count: hair.strands };
    }
    if (wantInstances) {
      const ow = owner;
      for (let i = 0; i < hair.strands; i++) {
        const a = i * per * 3,
          b = (i * per + hair.segments) * 3;
        const root = new Vector3(hair.points[a], hair.points[a + 1], hair.points[a + 2]).applyMatrix4(ow);
        const tip = new Vector3(hair.points[b], hair.points[b + 1], hair.points[b + 2]).applyMatrix4(ow);
        const rot = s.use_rotations ? new Quaternion().setFromUnitVectors(X, tip.clone().sub(root).normalize()) : new Quaternion();
        const size = s.particle_size * (1 - s.size_random * rand01(psys.seed, i, 2));
        instances.push({ objectId: inst!.id, matrix: instanceMatrix(ow, root, rot, size, inst, s.use_scale_instance !== false) });
      }
    }
  } else {
    const res = evaluateEmitter(ob, m, psys, s, mesh, ctx);
    if (res) {
      const { frame } = res;
      const n = frame.state.length;
      const showDead = !!s.use_dead;
      let count = 0;
      for (let i = 0; i < n; i++) if (frame.state[i] === 1 || (showDead && frame.state[i] === 2)) count++;
      const seed = hashSeed(psys.seed, s.seed ?? 0);
      if (wantPoints) {
        const pts = new Float32Array(count * 3),
          sizes = new Float32Array(count);
        let w = 0;
        for (let i = 0; i < n; i++) {
          if (!(frame.state[i] === 1 || (showDead && frame.state[i] === 2))) continue;
          pts.set(frame.pos.subarray(i * 3, i * 3 + 3), w * 3);
          sizes[w++] = show === 'DOT' ? s.display_size ?? 0.05 : s.particle_size * (1 - s.size_random * rand01(seed, i, 2));
        }
        draw = { objectId: ob.id, space: 'WORLD', points: pts, sizes, lines: null, color, count };
      }
      if (wantInstances) {
        const p = new Vector3(),
          q = new Quaternion(),
          d = new Vector3();
        for (let i = 0; i < n; i++) {
          if (!(frame.state[i] === 1 || (showDead && frame.state[i] === 2))) continue;
          p.set(frame.pos[i * 3], frame.pos[i * 3 + 1], frame.pos[i * 3 + 2]);
          q.identity();
          if (s.use_rotations && res.prev) {
            d.set(p.x - res.prev.pos[i * 3], p.y - res.prev.pos[i * 3 + 1], p.z - res.prev.pos[i * 3 + 2]);
            if (d.lengthSq() > 1e-12) q.setFromUnitVectors(X, d.normalize());
          }
          const size = s.particle_size * (1 - s.size_random * rand01(seed, i, 2));
          instances.push({ objectId: inst!.id, matrix: instanceMatrix(owner, p, q, size, inst, s.use_scale_instance !== false) });
        }
      }
    }
  }
  if (!ctx.render) {
    if (draw) particleDraw.set(key, draw);
    else particleDraw.delete(key);
  }
  if (!instances.length) return mesh;
  return { ...mesh, instances: [...(mesh.instances ?? []), ...instances] };
}

registerModifier({
  type: 'PARTICLE_SYSTEM',
  label: 'Particle System',
  category: 'PHYSICS',
  icon: 'mod_particles',
  deformOnly: false,
  defaults: () => ({ particle_system: '' }),
  timeDependent: (m) => {
    const doc = physicsDoc();
    if (!doc) return true;
    for (const ob of Object.values(doc.objects)) if (ob.modifiers.includes(m)) {
      const ps = systemOf(ob, m);
      const s = ps ? doc.particles[ps.settings] : undefined;
      return !s || s.type !== 'HAIR';
    }
    return true;
  },
  deps: (m) => {
    const doc = physicsDoc();
    if (!doc) return [];
    const out: string[] = [];
    for (const ob of Object.values(doc.objects))
      if (ob.modifiers.includes(m)) {
        const ps = systemOf(ob, m);
        const s = ps ? doc.particles[ps.settings] : undefined;
        if (s?.instance_object) out.push(s.instance_object);
        if (s && s.type !== 'HAIR') out.push(...simDeps(doc, ob.id));
      }
    return out;
  },
  signature: (m, c) => {
    const ps = systemOf(c.ob, m);
    const s = ps ? c.doc.particles[ps.settings] : undefined;
    if (!ps || !s) return 'none';
    const base = `${JSON.stringify(s)}:${psysKey(ps)}:${c.doc.materials ? JSON.stringify(materialColor(c.doc, c.ob, (s as ParticleSettingsX).material_slot ?? 1)) : ''}`;
    if (s.type === 'HAIR') return strHash(base);
    const cache = getCache<PFrame, PLive>(particleCacheKey(c.ob, m));
    const pc = ps.point_cache ?? defaultPointCache();
    const f = Math.min(Math.max(frameOf(c.graph), pc.frame_start), pc.frame_end);
    const full = { ...defaultParticleSettings(s.id, s.name), ...s } as ParticleSettingsX;
    return `${strHash(base)}:${simHash(c.doc, c.ob, m, ps, full, null, null)}:${cache.frames.has(f) ? 'hit' : 'miss' + cache.last}:${cache.frames.size}`;
  },
  apply: particleModifierApply,
});
