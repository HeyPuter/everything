// Modifiers driven by particle systems: Explode (faces fly with the particles emitted from them)
// and Particle Instance (copies of the mesh at the particles of another object).
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ModifierBase, ObjectData } from '../../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from '../types';
import { registerModifier } from '../modifiers';
import { MeshBuilder, weightsOf, groupWeights } from '../meshbuild';
import { bool, num, objId, str } from './common';
import { PointQuery } from './spatial';
import { evaluateEmitter, particleCacheKey, settingsOf, systemOf } from '../../physics/particles';
import { MeshSampler, newSample } from '../../physics/sampling';
import { frameOf, getCache, rand01 } from '../../physics/common';
import type { ParticleSettingsX, ParticleSystemX } from '../../physics/types';

const hashSeed = (a: number, b: number) => (Math.imul(a | 0, 2654435761) ^ (b | 0)) >>> 0;

export interface ParticleState {
  /** world positions */
  pos: Float32Array;
  /** 0 unborn, 1 alive, 2 dead */
  state: Uint8Array;
  prev?: Float32Array;
  sizes: Float32Array;
}

function sizesOf(s: ParticleSettingsX, psys: ParticleSystemX, n: number): Float32Array {
  const seed = hashSeed(psys.seed, s.seed ?? 0);
  return Float32Array.from({ length: n }, (_, i) => s.particle_size * (1 - s.size_random * rand01(seed, i, 2)));
}

// ---------------------------------------------------------------------------
// Explode

export interface ExplodeOptions {
  unborn: boolean;
  alive: boolean;
  dead: boolean;
  useSize: boolean;
  /** faces whose average weight is below this stay in place (with `weights`) */
  protect: number;
  weights: Float32Array | null;
}

/**
 * Split every face off and move it with its particle: `emit` holds the particles' emission points
 * (object space) and `pos` their current positions (object space).
 */
export function explodeFaces(m: EvalMesh, emit: Float32Array, pos: Float32Array, state: Uint8Array, sizes: Float32Array, o: ExplodeOptions): EvalMesh {
  const nf = m.offsets.length - 1;
  const n = state.length;
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const q = n ? new PointQuery(emit) : null;
  const P = m.positions;
  const c = new Vector3();
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    c.set(0, 0, 0);
    let w = 0;
    for (let k = s; k < e; k++) {
      c.x += P[m.indices[k] * 3];
      c.y += P[m.indices[k] * 3 + 1];
      c.z += P[m.indices[k] * 3 + 2];
      if (o.weights) w += o.weights[m.indices[k]];
    }
    c.multiplyScalar(1 / (e - s));
    if (o.weights) w /= e - s;
    let dx = 0,
      dy = 0,
      dz = 0,
      scale = 1;
    const fixed = !!o.weights && w < o.protect;
    const hit = !fixed && q ? q.nearest(c) : null;
    if (hit) {
      const i = hit.index;
      const st = state[i];
      if ((st === 0 && !o.unborn) || (st === 1 && !o.alive) || (st === 2 && !o.dead)) continue;
      if (st !== 0) {
        dx = pos[i * 3] - emit[i * 3];
        dy = pos[i * 3 + 1] - emit[i * 3 + 1];
        dz = pos[i * 3 + 2] - emit[i * 3 + 2];
        if (o.useSize) scale = sizes[i];
      }
    }
    const verts: number[] = [];
    for (let k = s; k < e; k++) {
      const v = m.indices[k];
      const x = c.x + (P[v * 3] - c.x) * scale + dx,
        y = c.y + (P[v * 3 + 1] - c.y) * scale + dy,
        z = c.z + (P[v * 3 + 2] - c.z) * scale + dz;
      verts.push(b.addVert(x, y, z, m.origIndex?.[v] ?? v, weightsOf(m, v)));
    }
    b.addFace(verts, Array.from(m.uvs.subarray(s * 2, e * 2)), m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0, {
      colors: m.colors ? Array.from(m.colors.subarray(s * 4, e * 4)) : undefined,
      seams: m.seams ? Array.from(m.seams.subarray(s, e)) : undefined,
      sharp: m.sharp ? Array.from(m.sharp.subarray(s, e)) : undefined,
    });
  }
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle, instances: m.instances });
}

function explodeMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const ob = ctx.ob;
  const idx = ob.modifiers.findIndex((x) => x.id === mod.id);
  const pm = ob.modifiers.slice(0, idx < 0 ? ob.modifiers.length : idx).find((x) => x.type === 'PARTICLE_SYSTEM');
  if (!pm) return m;
  const psys = systemOf(ob, pm);
  const s = psys ? settingsOf(ctx.doc, psys) : null;
  if (!psys || !s || s.type === 'HAIR') return m;
  const res = evaluateEmitter(ob, pm, psys, s, m, ctx);
  if (!res) return m;
  const n = res.frame.state.length;
  // emission points, as the emitter samples them
  const seed = hashSeed(psys.seed, s.seed ?? 0);
  const sampler = new MeshSampler(m);
  const emit = new Float32Array(n * 3);
  const sm = newSample();
  for (let i = 0; i < n; i++) {
    if (!sampler.sample(s.emit_from, seed, i, sm)) sm.px = sm.py = sm.pz = 0;
    emit[i * 3] = sm.px;
    emit[i * 3 + 1] = sm.py;
    emit[i * 3 + 2] = sm.pz;
  }
  const inv = (ctx.graph.get(ob.id)?.world ?? new Matrix4()).clone().invert();
  const pos = new Float32Array(n * 3);
  const v = new Vector3();
  for (let i = 0; i < n; i++) {
    v.fromArray(res.frame.pos, i * 3).applyMatrix4(inv);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  let weights = groupWeights(m, str(mod, 'vertex_group'));
  if (weights && bool(mod, 'invert_vertex_group')) weights = Float32Array.from(weights, (x) => 1 - x);
  return explodeFaces(m, emit, pos, res.frame.state, sizesOf(s, psys, n), {
    unborn: bool(mod, 'show_unborn', true),
    alive: bool(mod, 'show_alive', true),
    dead: bool(mod, 'show_dead', true),
    useSize: bool(mod, 'use_size'),
    protect: num(mod, 'protect', 0),
    weights,
  });
}

// ---------------------------------------------------------------------------
// Particle Instance

/** Current particles of another object's particle system (from its simulation cache). */
export function particlesOf(ctx: ModifierContext, src: ObjectData, index: number): ParticleState | null {
  const mods = src.modifiers.filter((x) => x.type === 'PARTICLE_SYSTEM');
  const pm = mods[index];
  if (!pm) return null;
  const psys = systemOf(src, pm);
  const s = psys ? settingsOf(ctx.doc, psys) : null;
  if (!psys || !s || s.type === 'HAIR') return null;
  const cache = getCache<{ pos: Float32Array; state: Uint8Array }, unknown>(particleCacheKey(src, pm));
  const f = Math.min(Math.max(frameOf(ctx.graph), cache.start), cache.end);
  const fr = cache.frames.get(f) ?? cache.nearest(f);
  if (!fr) return null;
  return { pos: fr.pos, state: fr.state, prev: cache.frames.get(f - 1)?.pos, sizes: sizesOf(s, psys, fr.state.length) };
}

export interface InstanceOptions {
  unborn: boolean;
  alive: boolean;
  dead: boolean;
  useSize: boolean;
  amount: number;
  offset: number;
  axis: number;
  rotation: number;
  randomRotation: number;
  /** particle space (world) → this object's space */
  toLocal: Matrix4;
}

/** One copy of the mesh per selected particle. */
export function instanceOnParticles(m: EvalMesh, p: ParticleState, o: InstanceOptions): EvalMesh {
  const n = p.state.length;
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const P = m.positions,
    nv = P.length / 3;
  const ax = new Vector3(o.axis === 0 ? 1 : 0, o.axis === 1 ? 1 : 0, o.axis === 2 ? 1 : 0);
  const mat = new Matrix4(),
    q = new Quaternion(),
    v = new Vector3(),
    at = new Vector3();
  const lo = o.offset,
    hi = o.offset + o.amount;
  for (let i = 0; i < n; i++) {
    const st = p.state[i];
    if ((st === 0 && !o.unborn) || (st === 1 && !o.alive) || (st === 2 && !o.dead)) continue;
    // amount / offset pick a contiguous (wrapping) share of the particles
    const t = n ? i / n : 0;
    if (!(o.amount >= 1 || (t >= lo && t < hi) || (t + 1 >= lo && t + 1 < hi))) continue;
    at.fromArray(p.pos, i * 3).applyMatrix4(o.toLocal);
    const angle = 2 * Math.PI * (o.rotation + o.randomRotation * rand01(i, 7));
    q.setFromAxisAngle(ax, angle);
    const sc = o.useSize ? p.sizes[i] : 1;
    mat.compose(at, q, new Vector3(sc, sc, sc));
    const map = new Int32Array(nv);
    for (let k = 0; k < nv; k++) {
      v.fromArray(P, k * 3).applyMatrix4(mat);
      map[k] = b.addVert(v.x, v.y, v.z, -1, weightsOf(m, k));
    }
    for (let f = 0; f < m.offsets.length - 1; f++) {
      const s = m.offsets[f],
        e = m.offsets[f + 1];
      b.addFace(Array.from(m.indices.subarray(s, e), (x) => map[x]), Array.from(m.uvs.subarray(s * 2, e * 2)), m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0, { colors: m.colors ? Array.from(m.colors.subarray(s * 4, e * 4)) : undefined });
    }
  }
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle });
}

function particleInstanceMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const sid = objId(mod, 'object');
  const src = sid ? ctx.doc.objects[sid] : undefined;
  if (!src) return m;
  const p = particlesOf(ctx, src, Math.max(0, Math.round(num(mod, 'particle_system_index', 1)) - 1));
  if (!p) return m;
  const own = ctx.graph.get(ctx.ob.id)?.world ?? new Matrix4();
  const srcWorld = ctx.graph.get(src.id)?.world ?? new Matrix4();
  // world: particles where they are; local: particles relative to their emitter, placed in this object
  const toLocal = str(mod, 'space', 'WORLD') === 'WORLD' ? own.clone().invert() : srcWorld.clone().invert();
  if (!bool(mod, 'use_normal', true)) return { ...m, positions: new Float32Array(0), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) };
  return instanceOnParticles(m, p, {
    unborn: bool(mod, 'show_unborn', true),
    alive: bool(mod, 'show_alive', true),
    dead: bool(mod, 'show_dead', true),
    useSize: bool(mod, 'use_size'),
    amount: num(mod, 'particle_amount', 1),
    offset: num(mod, 'particle_offset', 0),
    axis: ['X', 'Y', 'Z'].indexOf(str(mod, 'axis', 'Z')),
    rotation: num(mod, 'rotation', 0),
    randomRotation: num(mod, 'random_rotation', 0),
    toLocal,
  });
}

export const particleModifiers: ModifierType[] = [
  {
    type: 'EXPLODE',
    label: 'Explode',
    category: 'PHYSICS',
    icon: 'mod_explode',
    defaults: () => ({ vertex_group: '', invert_vertex_group: false, protect: 0, use_edge_cut: false, show_unborn: true, show_alive: true, show_dead: true, use_size: false, particle_uv: '' }),
    timeDependent: () => true,
    apply: explodeMod,
  },
  {
    type: 'PARTICLE_INSTANCE',
    label: 'Particle Instance',
    category: 'PHYSICS',
    icon: 'mod_particle_instance',
    defaults: () => ({ object: null, particle_system_index: 1, use_normal: true, use_children: false, show_unborn: true, show_alive: true, show_dead: true, use_size: false, space: 'WORLD', axis: 'Z', rotation: 0, random_rotation: 0, particle_amount: 1, particle_offset: 0 }),
    deps: (m) => [m.object as string],
    timeDependent: () => true,
    apply: particleInstanceMod,
  },
];

for (const t of particleModifiers) registerModifier(t);
