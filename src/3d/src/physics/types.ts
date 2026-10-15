// Physics data: extensions of the core document types (stored on the same JSON
// objects, so they persist in files and undo snapshots) plus their defaults.
import type { CollisionSettings, ForceField, ParticleSettings, ParticleSystem, RigidBodyData, RigidBodyWorld, ModifierBase, ObjectData, ID } from '../data/types';

/** Point cache settings (frame range + bake state). Baked data itself lives in memory. */
export interface PointCacheSettings {
  frame_start: number;
  frame_end: number;
  is_baked: boolean;
}

export interface RigidBodyWorldX extends RigidBodyWorld {
  is_baked?: boolean;
  /** effector weight for gravity (effector_weights.gravity) */
  effector_weights_gravity?: number;
}

export interface RigidBodyX extends RigidBodyData {
  use_margin?: boolean;
}

export interface RigidBodyConstraintData {
  type: 'FIXED' | 'POINT' | 'HINGE' | 'SLIDER' | 'PISTON' | 'GENERIC' | 'GENERIC_SPRING' | 'MOTOR';
  enabled: boolean;
  disable_collisions: boolean;
  object1: ID | null;
  object2: ID | null;
  /** limits (use_limit_lin_x, limit_lin_x_lower/upper, use_limit_ang_z, …), springs
   *  (use_spring_x, spring_stiffness_x, spring_damping_ang_y, …) and motor settings */
  use_motor_lin?: boolean;
  use_motor_ang?: boolean;
  motor_lin_target_velocity?: number;
  motor_ang_target_velocity?: number;
  motor_lin_max_impulse?: number;
  motor_ang_max_impulse?: number;
  spring_type?: 'SPRING1' | 'SPRING2';
  [key: string]: unknown;
}

export interface ForceFieldX extends ForceField {
  falloff_power?: number;
  use_min_distance?: boolean;
  distance_min?: number;
  /** wind/force: apply to particles/cloth/soft bodies/rigid bodies */
  apply_to_location?: boolean;
}

export interface CollisionSettingsX extends CollisionSettings {
  thickness_inner?: number;
  damping_factor?: number;
  friction_factor?: number;
  use_particle_kill?: boolean;
  permeability?: number;
}

export interface ClothSettings {
  quality: number;
  time_scale: number;
  mass: number;
  air_damping: number;
  tension_stiffness: number;
  compression_stiffness: number;
  shear_stiffness: number;
  bending_stiffness: number;
  tension_damping: number;
  compression_damping: number;
  shear_damping: number;
  bending_damping: number;
  vertex_group_mass: string;
  pin_stiffness: number;
  shrink_min: number;
  effector_weights_gravity: number;
  effector_weights_all: number;
}

export interface ClothCollisionSettings {
  collision_quality: number;
  use_collision: boolean;
  distance_min: number;
  use_self_collision: boolean;
  self_distance_min: number;
  self_friction: number;
}

export interface ClothModifier extends ModifierBase {
  settings: ClothSettings;
  collision_settings: ClothCollisionSettings;
  point_cache: PointCacheSettings;
}

export interface SoftBodySettings {
  mass: number;
  friction: number;
  speed: number;
  quality: number;
  use_goal: boolean;
  vertex_group_goal: string;
  goal_spring: number;
  goal_friction: number;
  goal_default: number;
  goal_min: number;
  goal_max: number;
  use_edges: boolean;
  pull: number;
  push: number;
  damping: number;
  bend: number;
  use_shape_match: boolean;
  shape_stiffness: number;
  use_collision: boolean;
  ball_size: number;
  effector_weights_gravity: number;
  effector_weights_all: number;
}

export interface SoftBodyModifier extends ModifierBase {
  settings: SoftBodySettings;
  point_cache: PointCacheSettings;
}

export interface ParticleSettingsX extends ParticleSettings {
  physics_type?: 'NEWTON' | 'NO';
  object_factor?: number;
  display_method?: 'RENDER' | 'DOT' | 'NONE';
  display_size?: number;
  use_dead?: boolean;
  material_slot?: number;
  use_scale_instance?: boolean;
  child_radius?: number;
  timestep_substeps?: number;
  effector_weights_all?: number;
  use_collision?: boolean;
}

export interface ParticleSystemX extends ParticleSystem {
  point_cache?: PointCacheSettings;
}

export interface ObjectPhysics extends ObjectData {
  rigid_body_constraint?: RigidBodyConstraintData | null;
  active_particle_system_index?: number;
}

export const asX = <T>(v: unknown) => v as T;

export function defaultPointCache(start = 1, end = 250): PointCacheSettings {
  return { frame_start: start, frame_end: end, is_baked: false };
}

export function defaultRigidBody(type: 'ACTIVE' | 'PASSIVE'): RigidBodyX {
  return {
    type,
    enabled: true,
    kinematic: false,
    mass: 1,
    friction: 0.5,
    restitution: 0,
    collision_shape: type === 'PASSIVE' ? 'MESH' : 'CONVEX_HULL',
    collision_margin: 0.04,
    use_margin: false,
    linear_damping: 0.04,
    angular_damping: 0.1,
    use_deactivation: false,
  };
}

export function defaultRigidBodyWorld(frameStart: number, frameEnd: number): RigidBodyWorldX {
  return {
    enabled: true,
    collection: null,
    substeps_per_frame: 10,
    solver_iterations: 10,
    time_scale: 1,
    frame_start: frameStart,
    frame_end: frameEnd,
    is_baked: false,
    effector_weights_gravity: 1,
  };
}

export function defaultCollision(): CollisionSettingsX {
  return {
    use: true,
    thickness_outer: 0.02,
    thickness_inner: 0.2,
    cloth_friction: 5,
    damping: 0.1,
    use_culling: false,
    damping_factor: 0,
    friction_factor: 0,
    use_particle_kill: false,
    permeability: 0,
  };
}

export function defaultField(type: ForceFieldX['type']): ForceFieldX {
  return {
    type,
    strength: type === 'DRAG' ? 0 : type === 'TURBULENCE' ? 1 : 1,
    flow: 0,
    noise: 0,
    seed: 1,
    size: 1,
    falloff_type: 'SPHERE',
    falloff_power: 0,
    use_max_distance: false,
    distance_max: 0,
    use_min_distance: false,
    distance_min: 0,
  };
}

export function defaultClothSettings(): ClothSettings {
  return {
    quality: 5,
    time_scale: 1,
    mass: 0.3,
    air_damping: 1,
    tension_stiffness: 15,
    compression_stiffness: 15,
    shear_stiffness: 5,
    bending_stiffness: 0.5,
    tension_damping: 5,
    compression_damping: 5,
    shear_damping: 5,
    bending_damping: 0.5,
    vertex_group_mass: '',
    pin_stiffness: 1,
    shrink_min: 0,
    effector_weights_gravity: 1,
    effector_weights_all: 1,
  };
}

export function defaultClothCollision(): ClothCollisionSettings {
  return { collision_quality: 2, use_collision: true, distance_min: 0.015, use_self_collision: false, self_distance_min: 0.015, self_friction: 5 };
}

export function defaultSoftBodySettings(): SoftBodySettings {
  return {
    mass: 1,
    friction: 0.5,
    speed: 1,
    quality: 5,
    use_goal: true,
    vertex_group_goal: '',
    goal_spring: 0.5,
    goal_friction: 0,
    goal_default: 0.7,
    goal_min: 0,
    goal_max: 1,
    use_edges: true,
    pull: 0.5,
    push: 0.5,
    damping: 0.5,
    bend: 0.5,
    use_shape_match: false,
    shape_stiffness: 0.5,
    use_collision: true,
    ball_size: 0.05,
    effector_weights_gravity: 1,
    effector_weights_all: 1,
  };
}

export function defaultParticleSettings(id: string, name: string): ParticleSettingsX {
  return {
    id,
    name,
    type: 'EMITTER',
    count: 1000,
    frame_start: 1,
    frame_end: 200,
    lifetime: 50,
    lifetime_random: 0,
    emit_from: 'FACE',
    normal_factor: 1,
    object_align_factor: [0, 0, 0],
    factor_random: 0,
    object_factor: 0,
    mass: 1,
    particle_size: 0.05,
    size_random: 0,
    render_type: 'HALO',
    instance_object: null,
    use_scale_instance: true,
    hair_length: 0.2,
    hair_step: 5,
    effector_weights_gravity: 1,
    effector_weights_all: 1,
    drag_factor: 0,
    brownian_factor: 0,
    damping: 0,
    use_rotations: false,
    angular_velocity_factor: 0,
    seed: 0,
    display_color: [0.9, 0.9, 0.9],
    display_method: 'RENDER',
    display_size: 0.05,
    use_dead: false,
    material_slot: 1,
    child_type: 'NONE',
    rendered_child_count: 10,
    child_radius: 0.2,
    clump_factor: 0,
    roughness_1: 0,
    physics_type: 'NEWTON',
    timestep_substeps: 2,
    use_collision: true,
    users: 1,
  };
}

/** Fill in fields missing from older documents (in place). */
export function ensureParticleDefaults(ps: ParticleSettingsX) {
  const d = defaultParticleSettings(ps.id, ps.name) as unknown as Record<string, unknown>;
  const o = ps as unknown as Record<string, unknown>;
  for (const k of Object.keys(d)) if (o[k] === undefined) o[k] = d[k];
  return ps;
}

export type { CollisionSettings, ForceField, ParticleSettings, ParticleSystem };
