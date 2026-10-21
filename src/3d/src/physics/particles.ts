// Particle systems: Newtonian emitter particles (frame cached, deterministic per seed)
// and static hair strands with simple children. Evaluated by the Particle System
// modifier; points/strands are drawn by the viewport overlay (draw.ts), objects are
// instanced through EvalMesh.instances.
import { Matrix4, Quaternion, Vector3, Vector3 as V3 } from 'three';
import type { DocumentData, ObjectData, ModifierBase } from '../data/types';
import type { EvalMesh, GeometryInstance, ModifierContext } from '../eval/types';
import type { Depsgraph } from '../eval/depsgraph';
import { meshSignature } from '../eval/depsgraph';
import { registerModifier } from '../eval/modifiers';
import { arrayChecksum, frameOf, getCache, motionKey, outOfTime, rand01, strHash, worldAt, type FrameCache, type SimContext } from './common';
import { applyGuides, guidesOf, newGuideState, type GuideState } from './guides';
import { activeBoidState, boidAccelerations, boidDamage, defaultBoidSettings, ruleObjects, type BoidOthers, type BoidSettings } from './boids';
import { defaultParticleFluid, relaxFluid, type ParticleFluidSettings } from './sph';
import { keyedPosition, keyedPositionTimed, keyedTargetPositions, psysTargets, targetParticles } from './keyed';
import { collectEffectors, effectorForce, fieldsKey } from './fields';
import { buildColliders, collidersKey, segmentHit, newHit } from './colliders';
import { MeshSampler, distributionKey, newSample, planSamples, valueAt, type Sample } from './sampling';
import { groupWeights } from '../eval/meshbuild';
import { hairDynKey, hairWithDynamics } from './hairdyn';
import { physicsDoc } from './state';
import { localMatrix as localMatrixOf } from '../eval/transform';
import { fps, gravityOf, simDeps } from './meshsim';
import { defaultParticleSettings, defaultPointCache, type CollisionSettingsX, type ParticleSettingsX, type ParticleSystemX } from './types';
import { simplifyChildParticles } from '../eval/simplify';
import { boundKeys } from './hairbind';
import { smoothStrands } from './hairpaths';
import { childSettings, childStrands, describeChildren, type ChildDesc, type ChildSettings } from './children';

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
  /** per point (or line vertex) colours, rgb */
  colors?: Float32Array | null;
  /** point shape */
  shape?: 'DISC' | 'CIRCLE' | 'CROSS';
}

/** Latest evaluated draw data per `${object id}:${modifier id}` (viewport evaluation only). */
export const particleDraw = new Map<string, ParticleDraw>();

/** Hair paths for the render engines per `${object id}:${modifier id}` (latest evaluation). */
export const hairRenderData = new Map<string, { objectId: string; points: Float32Array; per: number; first: number; settings: ParticleSettingsX; materialSlot: number }>();

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
  'timestep',
  'integrator',
  'use_collision',
  'seed',
  'boids',
  'fluid',
  'keyed_targets',
  'keyed_loops',
  'effector_weights_types',
  'tangent_factor',
  'tangent_phase',
  'use_size_deflect',
  'use_die_on_collision',
  'collision_collection',
  'distribution',
  'use_emit_random',
  'use_even_distribution',
  'userjit',
  'jitter_factor',
  'grid_resolution',
  'grid_random',
  'hexagonal_grid',
  'invert_grid',
];

/** Weights of one of the particle system's vertex groups (inverted when asked), or null. */
export function psysGroup(mesh: EvalMesh, psys: ParticleSystemX, kind: 'density' | 'length' | 'size' | 'velocity'): Float32Array | null {
  const name = psys[`vertex_group_${kind}`];
  if (!name) return null;
  const w = groupWeights(mesh, name);
  if (!w) return null;
  const out = Float32Array.from(w);
  if (psys[`invert_vertex_group_${kind}`]) for (let i = 0; i < out.length; i++) out[i] = 1 - out[i];
  return out;
}

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
    JSON.stringify([psys.vertex_group_density, psys.invert_vertex_group_density, psys.vertex_group_size, psys.invert_vertex_group_size, psys.vertex_group_velocity, psys.invert_vertex_group_velocity]),
    pc.frame_start,
    pc.frame_end,
    JSON.stringify(before),
    source ? meshSignature(source) : '',
    mesh ? `${mesh.positions.length}:${arrayChecksum(mesh.indices)}` : '',
    doc.scene.use_gravity,
    doc.scene.gravity.join(','),
    fps(doc),
    motionKey(doc, ob, pc.frame_start),
    s.use_collision ? collidersKey(doc, pc.frame_start, ob.id, s.collision_collection ?? null) : '',
    fieldsKey(doc, pc.frame_start),
    // the size only matters to the motion with size deflection
    s.use_size_deflect ? JSON.stringify([s.particle_size, s.size_random]) : '',
  ];
  // keyed targets and boid rule objects take part in the motion
  const targets = psysTargets(psys, s);
  parts.push(JSON.stringify(targets), String(!!psys.use_keyed_timing));
  if (s.physics_type === 'KEYED' || s.physics_type === 'BOIDS')
    for (const t of targets) {
      const o = t.object ? doc.objects[t.object] : undefined;
      if (o) parts.push(`${o.id}:${JSON.stringify(o.particle_systems)}:${JSON.stringify(o.particle_systems.map((p) => doc.particles[p.settings]))}:${motionKey(doc, o, pc.frame_start)}`);
    }
  if (s.physics_type === 'BOIDS')
    for (const r of s.boids ? activeBoidState(s.boids).rules : []) {
      const o = r.object ? doc.objects[r.object] : undefined;
      if (o) parts.push(`${o.id}:${motionKey(doc, o, pc.frame_start)}`);
    }
  return strHash(parts.join('#'));
}

// ---------------------------------------------------------------------------
// Emitter simulation

interface PFrame {
  pos: Float32Array;
  /** 0 unborn, 1 alive, 2 dead (killed or expired) */
  state: Uint8Array;
  /** boids walking on the ground */
  land?: Uint8Array;
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
  guides: GuideState;
  /** per particle size and velocity factors from vertex groups */
  sizeMul: Float32Array | null;
  velMul: Float32Array | null;
  /** boids: health left and whether each walks on the ground (allocated on first use) */
  health?: Float32Array;
  land?: Uint8Array;
  /** surface normal under walking boids */
  landNormal?: Float32Array;
}

export interface EmitterResult {
  frame: PFrame;
  birth: Float32Array;
  life: Float32Array;
  prev: PFrame | undefined;
  /** the frame before `prev` (boid banking) */
  prev2?: PFrame | undefined;
  /** emission samples (object space) */
  samples: Sample[] | null;
  /** frame of `frame` */
  at: number;
  /** per particle size factors (size vertex group) */
  sizeMul: Float32Array | null;
}

/** Number of particles: the count, or the grid's points for grid distributions. */
export function particleCount(s: ParticleSettingsX, mesh: EvalMesh, psys: ParticleSystemX | undefined, seed: number): number {
  if (s.distribution !== 'GRID' || s.emit_from === 'VERT') return Math.max(0, Math.floor(s.count));
  const key = `${distributionKey(s as never)}:${mesh.positions.length}:${arrayChecksum(mesh.positions)}`;
  const hit = gridCounts.get(mesh.positions);
  if (hit && hit.key === key) return hit.n;
  const n = planSamples(new MeshSampler(mesh, psys ? psysGroup(mesh, psys, 'density') : null), s as never, seed, 0).length;
  gridCounts.set(mesh.positions, { key, n });
  return n;
}
const gridCounts = new WeakMap<Float32Array, { key: string; n: number }>();

function initLive(s: ParticleSettingsX, seed: number, mesh: EvalMesh, psys?: ParticleSystemX): PLive {
  const n = particleCount(s, mesh, psys, seed);
  const birth = new Float32Array(n),
    life = new Float32Array(n);
  const span = s.frame_end - s.frame_start;
  const density = psys ? psysGroup(mesh, psys, 'density') : null;
  const sizeW = psys ? psysGroup(mesh, psys, 'size') : null;
  const velW = psys ? psysGroup(mesh, psys, 'velocity') : null;
  const sampler = new MeshSampler(mesh, density);
  const samples: Sample[] = [];
  const sizeMul = sizeW ? new Float32Array(n) : null,
    velMul = velW ? new Float32Array(n) : null;
  const plan = planSamples(sampler, s as never, seed, n);
  for (let i = 0; i < n; i++) {
    birth[i] = s.frame_start + (n > 0 ? (span * i) / n : 0);
    life[i] = Math.max(1, s.lifetime * (1 - s.lifetime_random * rand01(seed, i, 1)));
    const sm = plan[i] ?? newSample();
    if (!plan[i] || Number.isNaN(sm.px)) {
      // nothing to emit from (e.g. a density group without weights): never born
      sm.px = sm.py = sm.pz = 0;
      birth[i] = Infinity;
    }
    if (sizeMul) sizeMul[i] = valueAt(sampler, sizeW!, sm);
    if (velMul) velMul[i] = valueAt(sampler, velW!, sm);
    samples.push(sm);
  }
  return { pos: new Float32Array(n * 3), vel: new Float32Array(n * 3), state: new Uint8Array(n), birth, life, samples, sampler, step: 0, guides: newGuideState(), sizeMul, velMul };
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
  if (s.tangent_factor) {
    // along the surface: perpendicular to the normal, turned around it by the phase
    const nrm = new Vector3(sm.nx, sm.ny, sm.nz).transformDirection(M);
    const ref = Math.abs(nrm.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
    const tan = new Vector3().crossVectors(nrm, ref).normalize();
    tan.applyAxisAngle(nrm, (s.tangent_phase ?? 0) * Math.PI);
    _n.addScaledVector(tan, s.tangent_factor);
  }
  _a.set(s.object_align_factor[0], s.object_align_factor[1], s.object_align_factor[2]).transformDirection(M).multiplyScalar(Math.hypot(...s.object_align_factor));
  _n.add(_a);
  if (s.factor_random) _n.add(_a.set(rand01(seed, i, 30) * 2 - 1, rand01(seed, i, 31) * 2 - 1, rand01(seed, i, 32) * 2 - 1).multiplyScalar(s.factor_random));
  if (s.object_factor) {
    const p0 = new Vector3(sm.px, sm.py, sm.pz).applyMatrix4(A),
      p1 = new Vector3(sm.px, sm.py, sm.pz).applyMatrix4(B);
    _n.add(p1.sub(p0).multiplyScalar(fpsv * (s.object_factor ?? 0)));
  }
  if (L.velMul) _n.multiplyScalar(L.velMul[i]);
  L.vel[i * 3] = _n.x;
  L.vel[i * 3 + 1] = _n.y;
  L.vel[i * 3 + 2] = _n.z;
}

/** Advance the emitter from frame k-1 to k. */
export function stepParticles(L: PLive, s: ParticleSettingsX, seed: number, k: number, A: Matrix4, B: Matrix4, ctx: SimContext, ob: ObjectData, timeScale = 1, psys?: ParticleSystemX) {
  const n = L.state.length;
  // particle time runs at `timestep` seconds per frame (independent of the frame rate)
  const fpsv = s.timestep && s.timestep > 0 ? 1 / s.timestep : fps(ctx.doc);
  const sub = Math.max(1, Math.round(s.timestep_substeps ?? 1));
  const dtf = 1 / sub; // frames per substep
  const dt = (dtf / fpsv) * timeScale;
  const g = gravityOf(ctx.doc, (s.effector_weights_gravity ?? 1) * (s.effector_weights_all ?? 1));
  const effs = collectEffectors(ctx, k - 1, ob.id);
  const cols = s.use_collision !== false && s.physics_type !== 'NO' ? buildColliders(ctx, k, ob.id, 0.05, s.collision_collection ?? null) : [];
  const invMass = 1 / Math.max(1e-4, s.mass);
  const integrator = s.integrator ?? 'MIDPOINT';
  const fTypes = (s as { effector_weights_types?: Record<string, number> }).effector_weights_types ?? null;
  const fa = [0, 0, 0];
  /** position / velocity dependent accelerations: force fields and air drag */
  const accelAt = (x: number, y: number, z: number, u: number, v: number, w: number, t: number) => {
    fa[0] = fa[1] = fa[2] = 0;
    if (effs.length) effectorForce(effs, x, y, z, u, v, w, t, fa, s.effector_weights_all ?? 1, null, fTypes);
    const out = [fa[0] * invMass, fa[1] * invMass, fa[2] * invMass];
    if (s.drag_factor) {
      const sp = Math.hypot(u, v, w);
      out[0] -= u * sp * s.drag_factor;
      out[1] -= v * sp * s.drag_factor;
      out[2] -= w * sp * s.drag_factor;
    }
    return out;
  };
  const f = [0, 0, 0];
  const damp = Math.pow(1 - Math.min(1, Math.max(0, s.damping ?? 0)), dtf);
  const boids = s.physics_type === 'BOIDS' ? ({ ...defaultBoidSettings(), ...(s.boids ?? {}) } as BoidSettings) : null;
  const fluid = s.physics_type === 'FLUID' ? ({ ...defaultParticleFluid(), ...(s.fluid ?? {}) } as ParticleFluidSettings) : null;
  const targets = psysTargets(psys, s);
  const keyed = s.physics_type === 'KEYED' ? keyedTargetPositions(ctx.doc, targets, k) : null;
  const keyedTimes = keyed && psys?.use_keyed_timing ? targets.filter((_, q) => keyed[q]).map((t) => [t.time ?? 0, t.duration ?? 0] as [number, number]) : null;
  const boidAcc = boids ? new Float32Array(n * 3) : null;
  // boids: other systems' boids (friends / enemies), health and walking on the ground
  const others: BoidOthers[] = [];
  if (boids) {
    for (const t of targets) {
      if ((t.alliance ?? 'NEUTRAL') === 'NEUTRAL') continue;
      const tp = targetParticles(ctx.doc, t, k - 1);
      if (!tp) continue;
      const tb = (tp.settings?.boids ?? null) as BoidSettings | null;
      others.push({ pos: tp.pos, alive: tp.alive, alliance: t.alliance!, strength: tb?.strength ?? 0.1, accuracy: tb?.accuracy ?? 1 });
    }
    if (!L.health || L.health.length !== n) L.health = new Float32Array(n).fill(Math.max(1e-6, boids.health ?? 1));
    if (!L.land || L.land.length !== n) L.land = new Uint8Array(n);
    // boids that cannot fly start on the ground
    if (boids.use_flight === false && boids.use_land) L.land.fill(1);
  }
  const contact = boids && boids.use_land ? new Uint8Array(n) : null;
  const prevPos = fluid ? new Float32Array(n * 3) : null;
  const alive = (i: number) => L.state[i] === 1;
  const objects = boids ? ruleObjects(ctx.doc, boids, (id, fr) => {
    const o = ctx.doc.objects[id];
    return o ? new V3().setFromMatrixPosition(worldAt(ctx, o, fr)) : null;
  }, k, fpsv) : null;
  for (let ss = 0; ss < sub; ss++) {
    const t0 = k - 1 + ss * dtf,
      t1 = t0 + dtf;
    for (const c of cols) c.setTime((ss + 1) / sub);
    L.step++;
    if (boids && boidAcc) boidAccelerations(boids, L.pos, L.vel, alive, n, objects!, cols, (i, ch) => rand01(seed, i, L.step, 60 + ch), boidAcc, { land: boids.use_land ? L.land : null, others, health: L.health });
    if (contact) contact.fill(0);
    if (prevPos) prevPos.set(L.pos);
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
      if (keyed) {
        // keyed particles follow their path from the emission point through the targets
        if (ss === sub - 1) {
          const sm = L.samples[i];
          const start = new V3(sm.px, sm.py, sm.pz).applyMatrix4(B);
          const out = [0, 0, 0];
          if (keyedTimes) {
            const pts: [number, number, number][] = [[start.x, start.y, start.z]];
            for (const T of keyed) if (T && T.length) pts.push([T[(i % (T.length / 3)) * 3], T[(i % (T.length / 3)) * 3 + 1], T[(i % (T.length / 3)) * 3 + 2]]);
            keyedPositionTimed(pts, [0, ...keyedTimes.map((x) => x[0])], [0, ...keyedTimes.map((x) => x[1])], t1 - b, out);
          } else keyedPosition([start.x, start.y, start.z], keyed, i, (t1 - b) / Math.max(1e-6, L.life[i]), s.keyed_loops ?? 1, out);
          const j = i * 3;
          L.vel[j] = (out[0] - L.pos[j]) * fpsv;
          L.vel[j + 1] = (out[1] - L.pos[j + 1]) * fpsv;
          L.vel[j + 2] = (out[2] - L.pos[j + 2]) * fpsv;
          L.pos[j] = out[0];
          L.pos[j + 1] = out[1];
          L.pos[j + 2] = out[2];
        }
        continue;
      }
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
      if (effs.length) effectorForce(effs, px, py, pz, vx, vy, vz, t1, f, s.effector_weights_all ?? 1, null, (s as { effector_weights_types?: Record<string, number> }).effector_weights_types ?? null);
      // flying boids steer by their rules instead of falling
      // walking boids keep feeling gravity (climbing ones are held to their surface instead)
      const walking = !!boids && !!L.land?.[i];
      const grav = walking && !boids!.use_climb ? 1 : 0;
      let ax = (boidAcc ? boidAcc[i * 3] + g[0] * grav : g[0]) + f[0] * invMass,
        ay = (boidAcc ? boidAcc[i * 3 + 1] + g[1] * grav : g[1]) + f[1] * invMass,
        az = (boidAcc ? boidAcc[i * 3 + 2] + g[2] * grav : g[2]) + f[2] * invMass;
      if (walking && boidAcc) {
        const gl = Math.hypot(g[0], g[1], g[2]) || 1;
        const up = -(boidAcc[i * 3] * g[0] + boidAcc[i * 3 + 1] * g[1] + boidAcc[i * 3 + 2] * g[2]) / gl;
        const want = Math.max(1e-3, (boids!.land_acc_max ?? 0.5) * (boids!.land_speed_max ?? 5) * 4);
        if (boids!.use_flight !== false && up > want * 0.5) {
          // take off when the rules pull strongly upwards
          L.land![i] = 0;
        } else if ((boids!.land_jump_speed ?? 0) > 0 && up > want * 0.5 && contact?.[i] !== 0) {
          vx -= (g[0] / gl) * boids!.land_jump_speed!;
          vy -= (g[1] / gl) * boids!.land_jump_speed!;
          vz -= (g[2] / gl) * boids!.land_jump_speed!;
        }
        if (boids!.use_climb && L.landNormal) {
          // stick to the surface being climbed
          const sf = boids!.land_stick_force ?? 1;
          ax -= L.landNormal[j] * sf * gl;
          ay -= L.landNormal[j + 1] * sf * gl;
          az -= L.landNormal[j + 2] * sf * gl;
        }
      }
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
      const v0x = vx,
        v0y = vy,
        v0z = vz;
      // the position change over the step, by integrator
      let dpx: number, dpy: number, dpz: number;
      if (integrator === 'RK4' && !boids && (effs.length || s.drag_factor)) {
        // fourth order: forces sampled at the start, twice in the middle and at the end of the step
        const a0 = accelAt(px, py, pz, v0x, v0y, v0z, t1);
        // the part of the acceleration that does not depend on position or velocity
        const constA = [ax - a0[0], ay - a0[1], az - a0[2]];
        const acc = (x: number, y: number, z: number, u: number, v: number, w: number) => {
          const a = accelAt(x, y, z, u, v, w, t1);
          return [a[0] + constA[0], a[1] + constA[1], a[2] + constA[2]];
        };
        const k1v = [ax, ay, az],
          k1x = [v0x, v0y, v0z];
        const k2x = [v0x + (k1v[0] * h) / 2, v0y + (k1v[1] * h) / 2, v0z + (k1v[2] * h) / 2];
        const k2v = acc(px + (k1x[0] * h) / 2, py + (k1x[1] * h) / 2, pz + (k1x[2] * h) / 2, k2x[0], k2x[1], k2x[2]);
        const k3x = [v0x + (k2v[0] * h) / 2, v0y + (k2v[1] * h) / 2, v0z + (k2v[2] * h) / 2];
        const k3v = acc(px + (k2x[0] * h) / 2, py + (k2x[1] * h) / 2, pz + (k2x[2] * h) / 2, k3x[0], k3x[1], k3x[2]);
        const k4x = [v0x + k3v[0] * h, v0y + k3v[1] * h, v0z + k3v[2] * h];
        const k4v = acc(px + k3x[0] * h, py + k3x[1] * h, pz + k3x[2] * h, k4x[0], k4x[1], k4x[2]);
        vx = (v0x + ((k1v[0] + 2 * k2v[0] + 2 * k3v[0] + k4v[0]) * h) / 6) * damp;
        vy = (v0y + ((k1v[1] + 2 * k2v[1] + 2 * k3v[1] + k4v[1]) * h) / 6) * damp;
        vz = (v0z + ((k1v[2] + 2 * k2v[2] + 2 * k3v[2] + k4v[2]) * h) / 6) * damp;
        dpx = ((k1x[0] + 2 * k2x[0] + 2 * k3x[0] + k4x[0]) * h) / 6;
        dpy = ((k1x[1] + 2 * k2x[1] + 2 * k3x[1] + k4x[1]) * h) / 6;
        dpz = ((k1x[2] + 2 * k2x[2] + 2 * k3x[2] + k4x[2]) * h) / 6;
      } else {
        vx = (vx + ax * h) * damp;
        vy = (vy + ay * h) * damp;
        vz = (vz + az * h) * damp;
        // Euler moves with the old velocity, Midpoint (and RK4 under constant forces) with the
        // average, Verlet with the new one
        const wOld = integrator === 'EULER' ? 1 : integrator === 'VERLET' ? 0 : 0.5;
        dpx = (v0x * wOld + vx * (1 - wOld)) * h;
        dpy = (v0y * wOld + vy * (1 - wOld)) * h;
        dpz = (v0z * wOld + vz * (1 - wOld)) * h;
      }
      if (boids) {
        const sp = Math.hypot(vx, vy, vz);
        const onLand = !!L.land?.[i];
        const max = onLand ? (boids.land_speed_max ?? 5) : boids.air_speed_max;
        // the minimum flying speed is a share of the maximum
        const min = onLand ? 0 : boids.air_speed_min * boids.air_speed_max;
        const t = sp > max && !(onLand && vz < -max) ? max / sp : sp > 1e-9 && sp < min ? min / sp : 1;
        vx *= t;
        vy *= t;
        vz *= t;
      }
      let nx = px + (boids ? vx * h : dpx),
        ny = py + (boids ? vy * h : dpy),
        nz = pz + (boids ? vz * h : dpz);
      // collisions: bounce off the first surface crossed during the step
      for (let bounce = 0; bounce < 2 && cols.length; bounce++) {
        // size deflection: the particle's radius keeps it off the surface
        const radius = s.use_size_deflect ? s.particle_size * (1 - s.size_random * rand01(seed, i, 2)) * (L.sizeMul ? L.sizeMul[i] : 1) : 0;
        if (!segmentHit(cols, L.pos[j], L.pos[j + 1], L.pos[j + 2], nx, ny, nz, hit, radius)) break;
        const cs = hit.collider!.settings as CollisionSettingsX;
        if ((cs.permeability ?? 0) > 0 && rand01(seed, i, L.step, 50) < (cs.permeability ?? 0)) break;
        if (cs.use_particle_kill || s.use_die_on_collision) {
          L.state[i] = 2;
          break;
        }
        if (contact && boids) {
          // boids touching a surface walk on it
          contact[i] = 1;
          L.land![i] = 1;
          L.landNormal ??= new Float32Array(n * 3);
          const sd = (L.pos[j] - hit.cx) * hit.nx + (L.pos[j + 1] - hit.cy) * hit.ny + (L.pos[j + 2] - hit.cz) * hit.nz >= 0 ? 1 : -1;
          L.landNormal[j] = hit.nx * sd;
          L.landNormal[j + 1] = hit.ny * sd;
          L.landNormal[j + 2] = hit.nz * sd;
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
        // per-collision random variation of damping and friction
        const dmp = (cs.damping_factor ?? 0) + ((cs.damping_random ?? 0) ? (rand01(seed, i, L.step, 51) - 0.5) * (cs.damping_random ?? 0) : 0);
        const frc = (cs.friction_factor ?? 0) + ((cs.friction_random ?? 0) ? (rand01(seed, i, L.step, 52) - 0.5) * (cs.friction_random ?? 0) : 0);
        const stick = Math.min(1, Math.max(0, cs.stickiness ?? 0));
        const restitution = (1 - Math.min(1, Math.max(0, dmp))) * (1 - stick);
        const keepT = (1 - Math.min(1, Math.max(0, frc))) * (1 - stick);
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
    if (fluid && prevPos) relaxFluid(fluid, L.pos, L.vel, prevPos, alive, n, dt);
    if (boids && L.health && others.length) {
      boidDamage(boids, L.pos, alive, n, others, dt, L.health);
      for (let i = 0; i < n; i++) if (L.state[i] === 1 && L.health[i] <= 0) L.state[i] = 2;
    }
    // boids that walked off their surface fall (and fly again when they may)
    if (contact && L.land && boids && boids.use_flight !== false) for (let i = 0; i < n; i++) if (L.land[i] && !contact[i] && ss === sub - 1) L.land[i] = 0;
  }
  // curve guides lead particles along their curves
  if (s.physics_type !== 'NO') {
    const guides = guidesOf(ctx.doc, effs);
    if (guides.length) applyGuides(guides, L.guides, L.pos, L.vel, L.state, L.birth, L.life, k, k - 1, (1 / fpsv) * timeScale);
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
  const count = particleCount(s, mesh, psys, seed);
  const usable = pc.is_baked && cache.frames.size > 0 && cache.frames.values().next().value?.state.length === count;
  if (!usable && cache.hash !== hash) cache.reset(hash);
  const f = Math.min(Math.max(frameOf(ctx.graph), pc.frame_start), pc.frame_end);
  const sctx: SimContext = { doc, graph: ctx.graph };
  if (!cache.frames.has(f)) {
    if (!cache.live || cache.last < pc.frame_start) {
      cache.frames.clear();
      cache.live = initLive(s, seed, mesh, psys);
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
      stepParticles(L, s, seed, k, worldAt(sctx, ob, k - 1), worldAt(sctx, ob, k), sctx, ob, 1, psys);
      cache.frames.set(k, { pos: L.pos.slice(), state: L.state.slice(), land: L.land ? L.land.slice() : undefined });
      cache.last = k;
    }
  }
  const frame = cache.frames.get(f) ?? cache.nearest(f);
  if (!frame) return null;
  const birth = cache.live?.birth ?? initLive(s, seed, mesh, psys).birth;
  const life = cache.live?.life ?? new Float32Array(count).fill(s.lifetime);
  return { frame, birth, life, prev: cache.frames.get(f - 1), prev2: cache.frames.get(f - 2), samples: cache.live?.samples ?? null, at: f, sizeMul: cache.live?.sizeMul ?? null };
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
  /** how the children are made (to rebuild them around moved parents) */
  childDesc?: ChildDesc;
  childSettings?: ChildSettings;
}

/** Settings the child strands depend on. */
const CHILD_KEYS = ['child_type', 'child_nbr', 'child_percent', 'rendered_child_count', 'child_radius', 'child_roundness', 'child_length', 'child_length_threshold', 'child_seed', 'virtual_parents', 'clump_factor', 'clump_shape', 'use_clump_noise', 'clump_noise_size', 'kink', 'kink_amplitude', 'kink_amplitude_clump', 'kink_amplitude_random', 'kink_frequency', 'kink_shape', 'kink_flat', 'kink_axis', 'kink_axis_random', 'child_parting_factor', 'child_parting_min', 'child_parting_max', 'roughness_1', 'roughness_1_size', 'roughness_endpoint', 'roughness_end_shape', 'roughness_2', 'roughness_2_size', 'roughness_2_threshold'];

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
  // end tangents are extrapolated so straight keys stay straight and evenly spaced
  const P = (i: number, j: number): number => (i < 0 ? 2 * P(0, j) - P(1, j) : i > k - 1 ? 2 * P(k - 1, j) - P(k - 2, j) : co[(a + i) * 3 + j]);
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

/**
 * Hair strands: parents come from the hand-edited keys when the system was edited in Particle
 * Edit mode, otherwise they are generated on the mesh (density / length vertex groups apply).
 * Children follow their parent's path.
 */
export function evaluateHair(ob: ObjectData, m: ModifierBase, psys: ParticleSystemX, s: ParticleSettingsX, mesh: EvalMesh, childFactor = 1, render = false): HairResult {
  const key = particleCacheKey(ob, m);
  const ed = psys.edited_hair ?? null;
  const hash = strHash(
    [
      JSON.stringify([s.count, s.emit_from, s.normal_factor, s.object_align_factor, s.factor_random, s.hair_length, s.hair_step, s.seed, childFactor, render, CHILD_KEYS.map((k) => (s as unknown as Record<string, unknown>)[k])]),
      distributionKey(s),
      psys.seed,
      ed
        ? `E${ed.key_offsets.length}:${arrayChecksum(ed.co)}:${arrayChecksum(ed.hide)}:${psys.hair_binding ? `B${psys.hair_binding.tri.length}:${arrayChecksum(mesh.positions)}` : ''}`
        : [JSON.stringify([psys.vertex_group_density, psys.invert_vertex_group_density, psys.vertex_group_length, psys.invert_vertex_group_length]), mesh.weights ? mesh.weights.map((w) => arrayChecksum(w)).join(',') : '', mesh.positions.length, arrayChecksum(mesh.positions), arrayChecksum(mesh.indices)].join('#'),
    ].join('#'),
  );
  const hit0 = hairCache.get(key);
  if (hit0 && hit0.hash === hash) return hit0.result;
  const seed = hashSeed(psys.seed, s.seed ?? 0);
  const seg = Math.max(1, Math.round(s.hair_step ?? 5));
  const per = seg + 1;
  // children per parent: the display amount in the viewport, the render amount in renders
  const perParent = render ? (s.rendered_child_count ?? 100) : ((s as { child_percent?: number }).child_percent ?? s.child_nbr ?? 10);
  const children = s.child_type === 'SIMPLE' || s.child_type === 'INTERPOLATED' ? Math.max(0, Math.round(perParent * childFactor)) : 0;
  const parentPts: number[] = [];
  let parents = 0;
  if (ed) {
    const tmp = new Float32Array(per * 3);
    const nk = ed.key_offsets.length - 1;
    // connected hair moves with the emitter surface
    const keys = (psys.hair_binding && boundKeys(ed, psys.hair_binding, mesh.positions)) || ed.co;
    for (let i = 0; i < nk; i++) {
      if (ed.hide[i]) continue;
      resampleKeys(keys, ed.key_offsets[i], ed.key_offsets[i + 1], per, tmp, 0);
      for (let k = 0; k < tmp.length; k++) parentPts.push(tmp[k]);
      parents++;
    }
  } else {
    const sampler = new MeshSampler(mesh, psysGroup(mesh, psys, 'density'));
    const n = particleCount(s, mesh, psys, seed);
    const plan = planSamples(sampler, s as never, seed, n);
    const lengthW = psysGroup(mesh, psys, 'length');
    const dir = new Vector3();
    for (let i = 0; i < plan.length; i++) {
      const sm = plan[i];
      if (Number.isNaN(sm.px)) continue;
      dir.set(sm.nx, sm.ny, sm.nz).multiplyScalar(s.normal_factor);
      dir.add(new Vector3(...s.object_align_factor));
      if (s.factor_random) dir.add(new Vector3(rand01(seed, i, 30) * 2 - 1, rand01(seed, i, 31) * 2 - 1, rand01(seed, i, 32) * 2 - 1).multiplyScalar(s.factor_random));
      if (dir.lengthSq() < 1e-12) dir.set(sm.nx, sm.ny, sm.nz);
      dir.normalize();
      const len = s.hair_length * (lengthW ? valueAt(sampler, lengthW, sm) : 1);
      for (let k = 0; k <= seg; k++) {
        const t = (k / seg) * len;
        parentPts.push(sm.px + dir.x * t, sm.py + dir.y * t, sm.pz + dir.z * t);
      }
      parents++;
    }
  }
  const parentArr = Float32Array.from(parentPts);
  let childPts: Float32Array | null = null;
  let childDesc: ChildDesc | undefined;
  let childCfg: ChildSettings | undefined;
  if (children && parents) {
    childCfg = childSettings(s as unknown as Record<string, unknown>, children);
    childDesc = describeChildren(parentArr, per, parents, childCfg, seed, childCfg.type === 'INTERPOLATED' ? new MeshSampler(mesh, psysGroup(mesh, psys, 'density')) : null);
    childPts = childStrands(parentArr, per, childDesc, childCfg);
  }
  const pts = new Float32Array(parentArr.length + (childPts?.length ?? 0));
  pts.set(parentArr);
  if (childPts) pts.set(childPts, parentArr.length);
  const w = pts.length;
  const result: HairResult = { points: pts, segments: seg, strands: w / 3 / per, parents, childDesc, childSettings: childCfg };
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

function instanceMatrix(owner: Matrix4, pos: Vector3, rot: Quaternion, size: number, inst: ObjectData | undefined, useScale: boolean, opts: { global?: boolean; rotation?: boolean; world?: Matrix4 | null } = {}) {
  const sc = new Vector3(size, size, size);
  if (inst && useScale) sc.multiply(new Vector3(...inst.scale));
  let q = rot;
  let p = pos;
  if (inst && opts.world && (opts.rotation || opts.global)) {
    const wp = new Vector3(),
      wq = new Quaternion(),
      ws = new Vector3();
    opts.world.decompose(wp, wq, ws);
    // keep the instance object's own rotation (on top of the particle's)
    if (opts.rotation) q = rot.clone().multiply(wq);
    // keep its offset from the world origin
    if (opts.global) p = pos.clone().add(wp);
  }
  return new Matrix4().copy(owner).invert().multiply(new Matrix4().compose(p, q, sc)).toArray();
}

const X = new Vector3(1, 0, 0);

/** Orientation of an emitted particle (Rotation panel settings). */
function particleRotation(s: ParticleSettingsX, seed: number, i: number, vel: Vector3 | null, normal: Vector3 | null, owner: Matrix4, ageSec: number): Quaternion {
  const q = new Quaternion();
  if (!s.use_rotations) return q;
  const mode = s.rotation_mode ?? 'VEL';
  let dir: Vector3 | null = null;
  if (mode === 'VEL') dir = vel && vel.lengthSq() > 1e-12 ? vel.clone().normalize() : null;
  else if (mode === 'NOR') dir = normal;
  else if (mode.startsWith('GLOB_')) dir = new Vector3(mode === 'GLOB_X' ? 1 : 0, mode === 'GLOB_Y' ? 1 : 0, mode === 'GLOB_Z' ? 1 : 0);
  else if (mode.startsWith('OB_')) dir = new Vector3(mode === 'OB_X' ? 1 : 0, mode === 'OB_Y' ? 1 : 0, mode === 'OB_Z' ? 1 : 0).transformDirection(owner);
  if (dir) q.setFromUnitVectors(X, dir);
  const rnd = s.rotation_factor_random ?? 0;
  if (rnd > 0) {
    // a random orientation per particle, mixed in by the randomness
    const u1 = rand01(seed, i, 70),
      u2 = rand01(seed, i, 71),
      u3 = rand01(seed, i, 72);
    const r = new Quaternion(Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2), Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2), Math.sqrt(u1) * Math.sin(2 * Math.PI * u3), Math.sqrt(u1) * Math.cos(2 * Math.PI * u3));
    q.slerp(r, Math.min(1, rnd));
  }
  const phase = ((s.phase_factor ?? 0) + (s.phase_factor_random ?? 0) * rand01(seed, i, 73)) * Math.PI;
  if (phase) q.multiply(new Quaternion().setFromAxisAngle(X, phase));
  const av = s.angular_velocity_mode ?? 'NONE';
  const speed = s.angular_velocity_factor ?? 0;
  if (av !== 'NONE' && speed) {
    let axis: Vector3;
    if (av === 'GLOBAL_X') axis = new Vector3(1, 0, 0);
    else if (av === 'GLOBAL_Y') axis = new Vector3(0, 1, 0);
    else if (av === 'GLOBAL_Z') axis = new Vector3(0, 0, 1);
    else if (av === 'RAND') axis = new Vector3(rand01(seed, i, 74) - 0.5, rand01(seed, i, 75) - 0.5, rand01(seed, i, 76) - 0.5).normalize();
    else if (av === 'VELOCITY') axis = vel && vel.lengthSq() > 1e-12 ? vel.clone().normalize() : new Vector3(1, 0, 0);
    else {
      // horizontal / vertical spin relative to the direction of travel
      const d = vel && vel.lengthSq() > 1e-12 ? vel.clone().normalize() : new Vector3(1, 0, 0);
      const side = new Vector3().crossVectors(d, new Vector3(0, 0, 1));
      axis = av === 'VERTICAL' ? (side.lengthSq() > 1e-9 ? side.normalize() : new Vector3(0, 1, 0)) : new Vector3(0, 0, 1);
    }
    q.premultiply(new Quaternion().setFromAxisAngle(axis, speed * ageSec));
  }
  return q;
}

/**
 * Orientation of a boid: X along its flight direction (pitch scales how far it tilts up / down)
 * and rolled into turns by the sideways acceleration times the banking factor.
 */
function boidOrientation(b: BoidSettings, i: number, f: PFrame, f1: PFrame | undefined, f2: PFrame | undefined, g: [number, number, number]): Quaternion {
  const q = new Quaternion();
  if (!f1) return q;
  const v = new Vector3(f.pos[i * 3] - f1.pos[i * 3], f.pos[i * 3 + 1] - f1.pos[i * 3 + 1], f.pos[i * 3 + 2] - f1.pos[i * 3 + 2]);
  if (v.lengthSq() < 1e-14) return q;
  const up = new Vector3(-g[0], -g[1], -g[2]);
  if (up.lengthSq() < 1e-12) up.set(0, 0, 1);
  up.normalize();
  // pitch: keep this share of the vertical part of the direction
  const vert = up.clone().multiplyScalar(v.dot(up));
  const dir = v.clone().sub(vert).add(vert.multiplyScalar(Math.max(0, Math.min(2, b.pitch ?? 1)))).normalize();
  q.setFromUnitVectors(X, dir);
  if (f2 && (b.bank ?? 0) > 0) {
    const v0 = new Vector3(f1.pos[i * 3] - f2.pos[i * 3], f1.pos[i * 3 + 1] - f2.pos[i * 3 + 1], f1.pos[i * 3 + 2] - f2.pos[i * 3 + 2]);
    const acc = v.clone().sub(v0);
    const side = new Vector3().crossVectors(up, dir).normalize();
    // roll angle from the sideways acceleration relative to the speed
    const lateral = acc.dot(side) / Math.max(1e-6, v.length());
    const roll = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, -lateral * (b.bank ?? 1) * 4));
    q.multiply(new Quaternion().setFromAxisAngle(X, roll));
  }
  return q;
}

/**
 * Keep the [start, end] part of every strand (shares of its length, or frames of a hair 'growing'
 * over the frame range with absolute path time), shortened at random by the random length.
 */
function trimStrands(pts: Float32Array, per: number, s: ParticleSettingsX, seed: number) {
  const n = pts.length / (per * 3);
  const span = Math.max(1, (s.frame_end ?? 200) - (s.frame_start ?? 1));
  let a = s.path_start ?? 0,
    b = s.path_end ?? 1;
  if (s.use_absolute_path_time) {
    a = (a - (s.frame_start ?? 1)) / span;
    b = (b - (s.frame_start ?? 1)) / span;
  }
  a = Math.max(0, Math.min(1, a));
  b = Math.max(a, Math.min(1, b));
  const src = new Float32Array(per * 3);
  const cum = new Float32Array(per);
  for (let i = 0; i < n; i++) {
    const o = i * per * 3;
    src.set(pts.subarray(o, o + per * 3));
    cum[0] = 0;
    for (let k = 1; k < per; k++) cum[k] = cum[k - 1] + Math.hypot(src[k * 3] - src[k * 3 - 3], src[k * 3 + 1] - src[k * 3 - 2], src[k * 3 + 2] - src[k * 3 - 1]);
    const L = cum[per - 1];
    const bb = b * (1 - (s.length_random ?? 0) * rand01(seed, i, 95));
    const t0 = Math.min(a, bb) * L,
      t1 = bb * L;
    let j = 0;
    for (let k = 0; k < per; k++) {
      const t = t0 + ((t1 - t0) * k) / Math.max(1, per - 1);
      while (j < per - 2 && cum[j + 1] < t) j++;
      const q = Math.max(0, Math.min(1, (t - cum[j]) / (cum[j + 1] - cum[j] || 1)));
      for (let c = 0; c < 3; c++) pts[o + k * 3 + c] = src[j * 3 + c] + (src[(j + 1) * 3 + c] - src[j * 3 + c]) * q;
    }
  }
}

/** Objects of a collection (recursively, by name) for collection instancing. */
function collectionObjects(doc: DocumentData, cid: string | null | undefined, depth = 0): ObjectData[] {
  const c = cid ? doc.collections[cid] : undefined;
  if (!c || depth > 16) return [];
  const out = c.objects.map((id) => doc.objects[id]).filter((o): o is ObjectData => !!o);
  for (const ch of c.children) out.push(...collectionObjects(doc, ch, depth + 1));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function particleModifierApply(mesh: EvalMesh, m: ModifierBase, ctx: ModifierContext): EvalMesh {
  const ob = ctx.ob,
    doc = ctx.doc;
  const psys = systemOf(ob, m);
  const key = `${ob.id}:${m.id}`;
  const s = psys ? settingsOf(doc, psys) : null;
  if (!psys || !s || ctx.editMode) {
    if (!ctx.render) particleDraw.delete(key);
    hairRenderData.delete(key);
    return mesh;
  }
  if (s.type !== 'HAIR') hairRenderData.delete(key);
  const owner = (ctx.graph as Depsgraph).get(ob.id)?.world ?? new Matrix4();
  const show = ctx.render ? 'RENDER' : s.display_method ?? 'RENDER';
  const color = materialColor(doc, ob, s.material_slot ?? 1) ?? [0.9, 0.9, 0.9];
  const inst = s.render_type === 'OBJECT' && s.instance_object ? doc.objects[s.instance_object] : undefined;
  const coll = s.render_type === 'COLLECTION' ? collectionObjects(doc, s.instance_collection).filter((o) => o.id !== ob.id) : [];
  const wantInstances = show === 'RENDER' && ((!!inst && inst.id !== ob.id) || coll.length > 0);
  const instWorld = inst && (s.use_global_instance || s.use_rotation_instance) ? ((ctx.graph as Depsgraph).get(inst.id)?.world ?? null) : null;
  // Use Count: each listed collection object appears `count` times in the picking order
  const picks: ObjectData[] = [];
  if (s.use_collection_count && !s.use_whole_collection)
    for (const w of s.instance_weights ?? []) {
      const o = coll.find((x) => x.id === w.object);
      if (o) for (let c = 0; c < Math.max(0, Math.round(w.count)); c++) picks.push(o);
    }
  const wantPoints = show === 'DOT' || show === 'CIRC' || show === 'CROSS' || (show === 'RENDER' && s.render_type === 'HALO');
  const wantLines = show === 'RENDER' && s.render_type === 'LINE';
  /** instance(s) of one particle: the object, a picked collection object, or the whole collection */
  const pushInstances = (out: GeometryInstance[], ow: Matrix4, pos: Vector3, rot: Quaternion, size: number, i: number, seed: number) => {
    if (inst) {
      out.push({ objectId: inst.id, matrix: instanceMatrix(ow, pos, rot, size, inst, s.use_scale_instance !== false, { global: !!s.use_global_instance, rotation: !!s.use_rotation_instance, world: instWorld }) });
      return;
    }
    if (!coll.length) return;
    if (s.use_whole_collection) {
      const base = new Matrix4().compose(pos, rot, new Vector3(size, size, size));
      const offset = s.instance_collection ? doc.collections[s.instance_collection]?.instance_offset ?? [0, 0, 0] : [0, 0, 0];
      for (const o of coll) {
        const local = new Matrix4().makeTranslation(-offset[0], -offset[1], -offset[2]).multiply(localMatrixOf(o));
        out.push({ objectId: o.id, matrix: new Matrix4().copy(ow).invert().multiply(base).multiply(local).toArray() });
      }
      return;
    }
    const list = picks.length ? picks : coll;
    const o = s.use_collection_pick_random ? list[Math.floor(rand01(seed, i, 80) * list.length) % list.length] : list[i % list.length];
    out.push({ objectId: o.id, matrix: instanceMatrix(ow, pos, rot, size, o, s.use_scale_instance !== false, { global: !!s.use_global_instance, rotation: !!s.use_rotation_instance, world: s.use_global_instance || s.use_rotation_instance ? ((ctx.graph as Depsgraph).get(o.id)?.world ?? null) : null }) });
  };
  const instances: GeometryInstance[] = [];
  let draw: ParticleDraw | null = null;
  if (s.type === 'HAIR') {
    let hair = evaluateHair(ob, m, psys, s, mesh, simplifyChildParticles(doc, ctx.render), ctx.render);
    if (psys.use_hair_dynamics) hair = hairWithDynamics(ob, m, psys, s, hair, ctx) ?? hair;
    const per = hair.segments + 1;
    const hpct = ctx.render ? 100 : (s.display_percentage ?? 100);
    const hvis = (i: number) => hpct >= 100 || rand01(psys.seed, i, 90) * 100 < hpct;
    // paths: subdivided (and smoothed with B-Spline) by the display / render steps
    const path = smoothStrands(hair.points, per, ctx.render ? (s.render_step ?? 3) : (s.display_step ?? 2), !!s.use_hair_bspline);
    // Timing: show only part of each strand (start / end, random shortening)
    if ((s.path_start ?? 0) > 0 || (s.path_end ?? 1) < 1 || (s.length_random ?? 0) > 0) {
      if (path.points === hair.points) path.points = path.points.slice();
      trimStrands(path.points, path.per, s, psys.seed);
    }
    const pper = path.per,
      pseg = pper - 1;
    if (s.render_type === 'PATH') {
      // strands for the render engines (tubes); parents are left out when children show
      const first = hair.childDesc && !s.use_parent_particles ? hair.parents : 0;
      hairRenderData.set(key, { objectId: ob.id, points: path.points, per: pper, first, settings: s, materialSlot: s.material_slot ?? 1 });
    } else hairRenderData.delete(key);
    if (show !== 'NONE' && (s.render_type === 'PATH' || show === 'DOT' || !wantInstances)) {
      let shown = 0;
      for (let i = 0; i < hair.strands; i++) if (hvis(i)) shown++;
      const lines = new Float32Array(shown * pseg * 6);
      let w = 0;
      for (let i = 0; i < hair.strands; i++) {
        if (!hvis(i)) continue;
        for (let k = 0; k < pseg; k++) {
          const a = (i * pper + k) * 3;
          lines.set(path.points.subarray(a, a + 6), w);
          w += 6;
        }
      }
      draw = { objectId: ob.id, space: 'LOCAL', points: null, sizes: null, lines, color, count: shown };
    }
    if (wantInstances) {
      const ow = owner;
      for (let i = 0; i < hair.strands; i++) {
        if (!hvis(i)) continue;
        const a = i * per * 3,
          b = (i * per + hair.segments) * 3;
        const root = new Vector3(hair.points[a], hair.points[a + 1], hair.points[a + 2]).applyMatrix4(ow);
        const tip = new Vector3(hair.points[b], hair.points[b + 1], hair.points[b + 2]).applyMatrix4(ow);
        const rot = s.use_rotations ? new Quaternion().setFromUnitVectors(X, tip.clone().sub(root).normalize()) : new Quaternion();
        const size = s.particle_size * (1 - s.size_random * rand01(psys.seed, i, 2));
        pushInstances(instances, ow, root, rot, size, i, psys.seed);
      }
    }
  } else {
    const res = evaluateEmitter(ob, m, psys, s, mesh, ctx);
    if (res) {
      const { frame } = res;
      const n = frame.state.length;
      const showDead = !!s.use_dead;
      const seed = hashSeed(psys.seed, s.seed ?? 0);
      // the viewport may show only a share of the particles
      const pct = ctx.render ? 100 : (s.display_percentage ?? 100);
      const showUnborn = !!s.show_unborn;
      const vis = (i: number) => (frame.state[i] === 1 || (showDead && frame.state[i] === 2) || (showUnborn && frame.state[i] === 0 && Number.isFinite(res.birth[i]))) && (pct >= 100 || rand01(seed, i, 90) * 100 < pct);
      // unborn particles wait at their emission point
      const unbornAt = (i: number, out: Float32Array | Vector3, o = 0) => {
        const sm = res.samples?.[i];
        const v = new Vector3(sm?.px ?? 0, sm?.py ?? 0, sm?.pz ?? 0).applyMatrix4(owner);
        if (out instanceof Vector3) out.copy(v);
        else {
          out[o] = v.x;
          out[o + 1] = v.y;
          out[o + 2] = v.z;
        }
      };
      const posOf = (i: number, out: Float32Array, o: number) => {
        if (frame.state[i] === 0) unbornAt(i, out, o);
        else out.set(frame.pos.subarray(i * 3, i * 3 + 3), o);
      };
      // viewport colours by speed or acceleration (blue → red up to the colour maximum)
      const colorMode = ctx.render ? 'MATERIAL' : (s.display_color ?? 'MATERIAL');
      const fpsC = s.timestep && s.timestep > 0 ? 1 / s.timestep : fps(doc);
      const ramp = (t: number, out: Float32Array, o: number) => {
        const x = Math.max(0, Math.min(1, t));
        out[o] = Math.min(1, x * 2);
        out[o + 1] = 1 - Math.abs(x - 0.5) * 2;
        out[o + 2] = Math.min(1, (1 - x) * 2);
      };
      const colorOf = (i: number, out: Float32Array, o: number) => {
        const cmax = Math.max(0.01, s.color_maximum ?? 1);
        if (colorMode === 'VELOCITY' && res.prev) {
          const v = Math.hypot(frame.pos[i * 3] - res.prev.pos[i * 3], frame.pos[i * 3 + 1] - res.prev.pos[i * 3 + 1], frame.pos[i * 3 + 2] - res.prev.pos[i * 3 + 2]) * fpsC;
          ramp(v / (cmax * 10), out, o);
        } else if (colorMode === 'ACCELERATION' && res.prev && res.prev2) {
          let a = 0;
          for (let c = 0; c < 3; c++) a += (frame.pos[i * 3 + c] - 2 * res.prev.pos[i * 3 + c] + res.prev2.pos[i * 3 + c]) ** 2;
          ramp((Math.sqrt(a) * fpsC * fpsC) / (cmax * 10), out, o);
        } else if (colorMode === 'NONE') out.set([1, 1, 1], o);
        else out.set(color, o);
      };
      let count = 0;
      for (let i = 0; i < n; i++) if (vis(i)) count++;
      // simple children: copies of every parent at fixed random offsets within the child radius
      const nChild = s.child_type === 'SIMPLE' ? Math.max(0, Math.round(ctx.render ? (s.rendered_child_count ?? 0) : (s.child_nbr ?? 10))) : 0;
      const childOffset = (i: number, c: number, out: Vector3) => {
        const r = (s.child_radius ?? 0.2) * Math.cbrt(rand01(seed, i, c, 100));
        const u = rand01(seed, i, c, 101) * 2 - 1,
          t = rand01(seed, i, c, 102) * Math.PI * 2;
        const q = Math.sqrt(1 - u * u);
        return out.set(Math.cos(t) * q * r, Math.sin(t) * q * r, u * r);
      };
      const childSize = (i: number, c: number) => (s.child_size ?? 1) * (1 - (s.child_size_random ?? 0) * rand01(seed, i, c, 103));
      if (wantPoints) {
        const total = count * (1 + nChild);
        const pts = new Float32Array(total * 3),
          sizes = new Float32Array(total);
        const cols = colorMode !== 'MATERIAL' ? new Float32Array(total * 3) : null;
        const off = new Vector3();
        let w = 0;
        for (let i = 0; i < n; i++) {
          if (!vis(i)) continue;
          const size = show !== 'RENDER' ? s.display_size ?? 0.05 : s.particle_size * (1 - s.size_random * rand01(seed, i, 2)) * (res.sizeMul ? res.sizeMul[i] : 1);
          posOf(i, pts, w * 3);
          if (cols) colorOf(i, cols, w * 3);
          const px = pts[w * 3],
            py = pts[w * 3 + 1],
            pz = pts[w * 3 + 2];
          sizes[w++] = size;
          for (let c = 0; c < nChild; c++) {
            childOffset(i, c, off);
            pts[w * 3] = px + off.x;
            pts[w * 3 + 1] = py + off.y;
            pts[w * 3 + 2] = pz + off.z;
            if (cols) colorOf(i, cols, w * 3);
            sizes[w++] = show !== 'RENDER' ? size : size * childSize(i, c);
          }
        }
        draw = { objectId: ob.id, space: 'WORLD', points: pts, sizes, lines: null, color, count: total, colors: cols, shape: show === 'CIRC' ? 'CIRCLE' : show === 'CROSS' ? 'CROSS' : 'DISC' };
      }
      if (show === 'AXIS') {
        // three short axis lines per particle, oriented like the particle
        const lines = new Float32Array(count * 18),
          cols = new Float32Array(count * 18);
        const ax = [new Vector3(), new Vector3(), new Vector3()];
        const pv = new Float32Array(3);
        let w = 0;
        const fpsv = fps(doc);
        for (let i = 0; i < n; i++) {
          if (!vis(i)) continue;
          posOf(i, pv, 0);
          let vel: Vector3 | null = null;
          if (res.prev && frame.state[i] === 1) vel = new Vector3(frame.pos[i * 3] - res.prev.pos[i * 3], frame.pos[i * 3 + 1] - res.prev.pos[i * 3 + 1], frame.pos[i * 3 + 2] - res.prev.pos[i * 3 + 2]);
          const q = particleRotation({ ...s, use_rotations: true }, seed, i, vel, null, owner, Math.max(0, (res.at - res.birth[i]) / fpsv));
          const L = s.display_size ?? 0.05;
          ax[0].set(L, 0, 0).applyQuaternion(q);
          ax[1].set(0, L, 0).applyQuaternion(q);
          ax[2].set(0, 0, L).applyQuaternion(q);
          for (let a = 0; a < 3; a++) {
            lines.set([pv[0], pv[1], pv[2], pv[0] + ax[a].x, pv[1] + ax[a].y, pv[2] + ax[a].z], w);
            const c = a === 0 ? [1, 0.2, 0.2] : a === 1 ? [0.3, 1, 0.3] : [0.3, 0.5, 1];
            cols.set([...c, ...c], w);
            w += 6;
          }
        }
        draw = { objectId: ob.id, space: 'WORLD', points: null, sizes: null, lines, color, count, colors: cols };
      }
      if (wantLines) {
        // a line per particle along its direction of travel
        const lines = new Float32Array(count * 6);
        let w = 0;
        const fpsv = fps(doc);
        for (let i = 0; i < n; i++) {
          if (!vis(i)) continue;
          const px = frame.pos[i * 3],
            py = frame.pos[i * 3 + 1],
            pz = frame.pos[i * 3 + 2];
          let dx = 0,
            dy = 0,
            dz = 1;
          if (res.prev) {
            dx = px - res.prev.pos[i * 3];
            dy = py - res.prev.pos[i * 3 + 1];
            dz = pz - res.prev.pos[i * 3 + 2];
          }
          const len = Math.hypot(dx, dy, dz);
          const scale = s.use_velocity_length ? len * fpsv : 1;
          if (len > 1e-9) {
            dx /= len;
            dy /= len;
            dz /= len;
          }
          const tail = (s.line_length_tail ?? 0) * scale,
            head = (s.line_length_head ?? 0.1) * scale;
          lines.set([px - dx * tail, py - dy * tail, pz - dz * tail, px + dx * head, py + dy * head, pz + dz * head], w);
          w += 6;
        }
        draw = { objectId: ob.id, space: 'WORLD', points: null, sizes: null, lines, color, count };
      }
      if (wantInstances) {
        const p = new Vector3(),
          d = new Vector3(),
          nrm = new Vector3();
        const fpsv = fps(doc);
        for (let i = 0; i < n; i++) {
          if (!vis(i)) continue;
          if (frame.state[i] === 0) unbornAt(i, p);
          else p.set(frame.pos[i * 3], frame.pos[i * 3 + 1], frame.pos[i * 3 + 2]);
          let vel: Vector3 | null = null;
          if (res.prev && frame.state[i] !== 0) {
            d.set(p.x - res.prev.pos[i * 3], p.y - res.prev.pos[i * 3 + 1], p.z - res.prev.pos[i * 3 + 2]);
            vel = d;
          }
          const sm = res.samples?.[i];
          const normal = sm ? nrm.set(sm.nx, sm.ny, sm.nz).transformDirection(owner) : null;
          const size = s.particle_size * (1 - s.size_random * rand01(seed, i, 2)) * (res.sizeMul ? res.sizeMul[i] : 1);
          let q: Quaternion;
          if (s.physics_type === 'BOIDS' && s.boids) {
            q = boidOrientation(s.boids, i, frame, res.prev, res.prev2, gravityOf(doc, 1));
            // walking boids stand on the ground instead of sinking into it
            if (frame.land?.[i] && s.boids.height) p.z += size * s.boids.height * 0.5;
          } else q = particleRotation(s, seed, i, vel, normal, owner, Math.max(0, (res.at - res.birth[i]) / fpsv));
          pushInstances(instances, owner, p, q, size, i, seed);
          for (let c = 0; c < nChild; c++) {
            const cp = childOffset(i, c, new Vector3()).add(p);
            pushInstances(instances, owner, cp, q, size * childSize(i, c), i * 131 + c + 1, seed);
          }
        }
      }
    }
  }
  if (!ctx.render) {
    if (draw) particleDraw.set(key, draw);
    else particleDraw.delete(key);
  }
  // the emitter itself can be left out of renders
  const out = ctx.render && s.use_render_emitter === false ? { ...mesh, offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0), positions: new Float32Array(0), looseEdges: undefined } : mesh;
  if (!instances.length) return out;
  return { ...out, instances: [...(mesh.instances ?? []), ...instances] };
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
      return !s || s.type !== 'HAIR' || !!ps?.use_hair_dynamics;
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
        if (s && (s.type !== 'HAIR' || (systemOf(ob, m) as ParticleSystemX | undefined)?.use_hair_dynamics)) out.push(...simDeps(doc, ob.id));
        const sx = s as ParticleSettingsX | undefined;
        for (const t of sx?.keyed_targets ?? []) if (t.object && t.object !== ob.id) out.push(t.object);
        for (const r of sx?.boids?.rules ?? []) if (r.object && r.object !== ob.id) out.push(r.object);
        if (sx?.render_type === 'COLLECTION') for (const o of collectionObjects(doc, sx.instance_collection)) if (o.id !== ob.id) out.push(o.id);
      }
    return out;
  },
  signature: (m, c) => {
    const ps = systemOf(c.ob, m);
    const s = ps ? c.doc.particles[ps.settings] : undefined;
    if (!ps || !s) return 'none';
    const base = `${JSON.stringify(s)}:${psysKey(ps)}:${c.doc.materials ? JSON.stringify(materialColor(c.doc, c.ob, (s as ParticleSettingsX).material_slot ?? 1)) : ''}`;
    if (s.type === 'HAIR') {
      if (!ps.use_hair_dynamics) return strHash(base);
      // simulated hair changes with the frame and the dynamics cache
      const hc = getCache<Float32Array, unknown>(hairDynKey(c.ob, m));
      const pc = ps.point_cache ?? defaultPointCache();
      const f = Math.min(frameOf(c.graph), pc.frame_end);
      return `${strHash(base + JSON.stringify(ps.hair_dynamics ?? {}))}:${f <= pc.frame_start ? 'rest' : f}:${hc.hash}:${hc.frames.has(f) ? 'hit' : 'miss' + hc.last}:${hc.frames.size}`;
    }
    const cache = getCache<PFrame, PLive>(particleCacheKey(c.ob, m));
    const pc = ps.point_cache ?? defaultPointCache();
    const f = Math.min(Math.max(frameOf(c.graph), pc.frame_start), pc.frame_end);
    const full = { ...defaultParticleSettings(s.id, s.name), ...s } as ParticleSettingsX;
    return `${strHash(base)}:${simHash(c.doc, c.ob, m, ps, full, null, null)}:${cache.frames.has(f) ? 'hit' : 'miss' + cache.last}:${cache.frames.size}`;
  },
  apply: particleModifierApply,
});
