// Cloth and Soft Body modifiers (category Physics). Settings live on the modifier
// (ClothModifier.settings / collision_settings / point_cache).
import { registerModifier } from '../eval/modifiers';
import { groupWeights } from '../eval/meshbuild';
import type { DocumentData } from '../data/types';
import type { EvalMesh } from '../eval/types';
import { runMeshSim, meshSimSignature, simDeps, fps, gravityOf, type MeshSimSetup } from './meshsim';
import { physicsDoc } from './state';
import {
  defaultClothCollision,
  defaultClothSettings,
  defaultPointCache,
  defaultSoftBodySettings,
  type ClothModifier,
  type SoftBodyModifier,
} from './types';

/** Stiffness (settings units) → XPBD compliance. 0 disables the constraint. */
export const compliance = (k: number, scale = 1000) => (k > 0 ? 1 / (k * scale) : 1e6);

export function clothSetup(m: ClothModifier, mesh: EvalMesh, doc: DocumentData): MeshSimSetup {
  const s = { ...defaultClothSettings(), ...m.settings };
  const c = { ...defaultClothCollision(), ...m.collision_settings };
  const pin = groupWeights(mesh, s.vertex_group_mass);
  const quality = Math.max(1, Math.round(s.quality));
  const n = mesh.positions.length / 3;
  const group = (name: string | undefined) => (name ? groupWeights(mesh, name) : null);
  const structural = group(s.vertex_group_structural_stiffness),
    shear = group(s.vertex_group_shear_stiffness),
    bending = group(s.vertex_group_bending),
    shrink = group(s.vertex_group_shrink);
  const anyWeights = structural || shear || bending || shrink;
  const pressureW = s.use_pressure ? group(s.vertex_group_pressure) : null;
  void n;
  return {
    shear: true,
    bend: true,
    collide: c.use_collision,
    sewing: !!s.use_sewing_springs,
    internal: s.use_internal_springs ? { maxLength: s.internal_spring_max_length ?? 0, maxDiversion: s.internal_spring_max_diversion ?? Math.PI / 4, normalCheck: !!s.internal_spring_normal_check } : null,
    weights: anyWeights
      ? {
          base: [s.tension_stiffness, s.compression_stiffness, s.shear_stiffness, s.bending_stiffness],
          structural: structural ? { w: structural, tensionMax: s.tension_stiffness_max ?? s.tension_stiffness, compressionMax: s.compression_stiffness_max ?? s.compression_stiffness } : undefined,
          shear: shear ? { w: shear, max: s.shear_stiffness_max ?? s.shear_stiffness } : undefined,
          bending: bending ? { w: bending, max: s.bending_stiffness_max ?? s.bending_stiffness } : undefined,
          shrink: shrink ? { w: shrink, min: s.shrink_min, max: s.shrink_max ?? 0 } : undefined,
        }
      : null,
    params: {
      dt: (s.time_scale || 0) / fps(doc),
      substeps: quality,
      iterations: 6,
      gravity: gravityOf(doc, s.effector_weights_gravity * s.effector_weights_all),
      airDamping: s.air_damping,
      compliance: [compliance(s.tension_stiffness), compliance(s.compression_stiffness), compliance(s.shear_stiffness), compliance(s.bending_stiffness)],
      damping: [s.tension_damping, s.compression_damping, s.shear_damping, s.bending_damping],
      mass: Math.max(1e-4, s.mass),
      pin: pin ? Float32Array.from(pin) : null,
      pinStiffness: s.pin_stiffness,
      goal: null,
      shapeMatch: 0,
      fieldWeight: s.effector_weights_all,
      collision: c.use_collision ? { distance: c.distance_min, quality: Math.max(1, Math.round(c.collision_quality)) } : null,
      self: c.use_self_collision ? { distance: c.self_distance_min, friction: c.self_friction } : null,
      restScale: 1 - Math.min(0.99, Math.max(-1, s.shrink_min)),
      internalCompliance: [compliance(s.internal_tension_stiffness ?? 15), compliance(s.internal_compression_stiffness ?? 15)],
      // sewing force 0 = as strong as possible
      sewCompliance: (s.sewing_force_max ?? 0) > 0 ? compliance(s.sewing_force_max!, 10) : 1e-6,
      pressure: s.use_pressure
        ? { uniform: s.uniform_pressure_force ?? 0, factor: s.pressure_factor ?? 1, targetVolume: s.use_pressure_volume ? (s.target_volume ?? 0) : 0, density: s.fluid_density ?? 0, weights: pressureW ? Float32Array.from(pressureW) : null }
        : null,
      fieldTypeWeights: s.effector_weights_types ?? null,
    },
  };
}

export function softBodySetup(m: SoftBodyModifier, mesh: EvalMesh, doc: DocumentData): MeshSimSetup {
  const s = { ...defaultSoftBodySettings(), ...m.settings };
  const n = mesh.positions.length / 3;
  let goal: Float32Array | null = null;
  if (s.use_goal) {
    const gw = groupWeights(mesh, s.vertex_group_goal);
    goal = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const w = gw ? gw[i] : s.goal_default;
      goal[i] = s.goal_min + (s.goal_max - s.goal_min) * Math.min(1, Math.max(0, w));
    }
  }
  const quality = Math.max(1, Math.round(s.quality));
  // goal weight 1 means fully pinned (goal strength max = no dynamics)
  const pin = goal ? goal.map((g) => (g >= 0.999 ? 1 : 0)) : null;
  return {
    shear: s.use_edges,
    bend: s.use_edges && s.bend > 0,
    collide: s.use_collision,
    useRestShape: s.use_shape_match,
    params: {
      dt: (s.speed || 0) / fps(doc),
      substeps: quality,
      iterations: 4,
      gravity: gravityOf(doc, s.effector_weights_gravity * s.effector_weights_all),
      airDamping: s.friction,
      compliance: s.use_edges ? [compliance(s.pull, 200), compliance(s.push, 200), compliance(s.pull, 200), compliance(s.bend, 200)] : [1e6, 1e6, 1e6, 1e6],
      damping: [s.damping * 10, s.damping * 10, s.damping * 10, s.damping * 10],
      mass: Math.max(1e-4, s.mass),
      pin,
      pinStiffness: 1,
      goal: goal ? { weights: goal, spring: s.goal_spring, friction: s.goal_friction } : null,
      shapeMatch: s.use_shape_match ? s.shape_stiffness : 0,
      fieldWeight: s.effector_weights_all,
      collision: s.use_collision ? { distance: s.ball_size, quality: 1 } : null,
      self: null,
      restScale: 1,
      fieldTypeWeights: (s as { effector_weights_types?: Record<string, number> }).effector_weights_types ?? null,
    },
  };
}

registerModifier({
  type: 'CLOTH',
  label: 'Cloth',
  category: 'PHYSICS',
  icon: 'mod_cloth',
  deformOnly: true,
  defaults: () => {
    const sc = physicsDoc()?.scene;
    return { settings: defaultClothSettings(), collision_settings: defaultClothCollision(), point_cache: defaultPointCache(sc?.frame_start ?? 1, sc?.frame_end ?? 250) };
  },
  timeDependent: () => true,
  deps: () => simDeps(physicsDoc()),
  signature: (m, c) => meshSimSignature('CLOTH', m, c),
  apply: (mesh, m, ctx) => runMeshSim('CLOTH', mesh, m, ctx, (me, doc) => clothSetup(m as ClothModifier, me, doc)),
});

registerModifier({
  type: 'SOFT_BODY',
  label: 'Soft Body',
  category: 'PHYSICS',
  icon: 'mod_soft',
  deformOnly: true,
  defaults: () => {
    const sc = physicsDoc()?.scene;
    return { settings: defaultSoftBodySettings(), point_cache: defaultPointCache(sc?.frame_start ?? 1, sc?.frame_end ?? 250) };
  },
  timeDependent: () => true,
  deps: () => simDeps(physicsDoc()),
  signature: (m, c) => meshSimSignature('SOFT_BODY', m, c),
  apply: (mesh, m, ctx) => runMeshSim('SOFT_BODY', mesh, m, ctx, (me, doc) => softBodySetup(m as SoftBodyModifier, me, doc)),
});
