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
  /** collection of the constraint objects that take part (all when unset) */
  constraints?: string | null;
  effector_weights_all?: number;
  effector_weights_types?: Record<string, number>;
  /** effector weight for gravity (effector_weights.gravity) */
  effector_weights_gravity?: number;
  /** resolve overlaps without adding energy */
  use_split_impulse?: boolean;
}

export interface RigidBodyX extends RigidBodyData {
  use_margin?: boolean;
  /** collision collections (20): bodies collide only when they share one */
  collision_collections?: boolean[];
  /** start the simulation asleep (needs deactivation) */
  use_start_deactivated?: boolean;
  /** speeds below which a body goes to sleep */
  deactivate_linear_velocity?: number;
  deactivate_angular_velocity?: number;
  /** mesh the collision shape comes from, and whether it follows the deforming mesh */
  mesh_source?: 'BASE' | 'DEFORM' | 'FINAL';
  use_deform?: boolean;
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
  /** the joint breaks when its bodies receive more than this impulse in one step */
  use_breaking?: boolean;
  breaking_threshold?: number;
  /** solve this constraint with more iterations than the world uses */
  use_override_solver_iterations?: boolean;
  solver_iterations?: number;
  [key: string]: unknown;
}

export interface ForceFieldX extends ForceField {
  /** where distances are measured from */
  shape?: 'POINT' | 'LINE' | 'PLANE' | 'SURFACE' | 'POINTS';
  /** vortex: pull towards the axis */
  inflow?: number;
  /** harmonic: spring rest length and damping */
  rest_length?: number;
  harmonic_damping?: number;
  /** curve guide settings */
  guide_minimum?: number;
  guide_free?: number;
  use_guide_path_add?: boolean;
  use_guide_path_weight?: boolean;
  guide_clump_amount?: number;
  falloff_power?: number;
  use_min_distance?: boolean;
  distance_min?: number;
  /** wind/force: apply to particles/cloth/soft bodies/rigid bodies */
  apply_to_location?: boolean;
  /** only the positive / negative Z side of the field acts */
  z_direction?: 'BOTH' | 'POSITIVE' | 'NEGATIVE';
  /** inverse square falloff (gravitation) */
  use_gravity_falloff?: boolean;
  /** collision objects block the field */
  use_absorption?: boolean;
  /** how much surfaces only catch the part of the force across them */
  wind_factor?: number;
  /** tube / cone falloff across the axis (distance, or angle in degrees for cones) */
  radial_falloff?: number;
  use_radial_min?: boolean;
  radial_min?: number;
  use_radial_max?: boolean;
  radial_max?: number;
  /** turbulence noise fixed in world space */
  use_global_coords?: boolean;
}

export interface CollisionSettingsX extends CollisionSettings {
  thickness_inner?: number;
  damping_factor?: number;
  friction_factor?: number;
  use_particle_kill?: boolean;
  permeability?: number;
  stickiness?: number;
  damping_random?: number;
  friction_random?: number;
  /** cloth and soft bodies are pushed out along the collider's normals */
  use_normal?: boolean;
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
  /** per field type effector weights */
  effector_weights_types?: Record<string, number>;
  // shape
  shrink_max?: number;
  vertex_group_shrink?: string;
  use_sewing_springs?: boolean;
  sewing_force_max?: number;
  // pressure
  use_pressure?: boolean;
  uniform_pressure_force?: number;
  use_pressure_volume?: boolean;
  target_volume?: number;
  pressure_factor?: number;
  fluid_density?: number;
  vertex_group_pressure?: string;
  // internal springs
  use_internal_springs?: boolean;
  internal_spring_max_length?: number;
  internal_spring_max_diversion?: number;
  internal_spring_normal_check?: boolean;
  internal_tension_stiffness?: number;
  internal_compression_stiffness?: number;
  // property weights
  vertex_group_structural_stiffness?: string;
  tension_stiffness_max?: number;
  compression_stiffness_max?: number;
  vertex_group_shear_stiffness?: string;
  shear_stiffness_max?: number;
  vertex_group_bending?: string;
  bending_stiffness_max?: number;
}

export interface ClothCollisionSettings {
  /** only objects in this collection collide with the cloth */
  collection?: string | null;
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
  effector_weights_types?: Record<string, number>;
  /** edges: aerodynamics, plasticity, rest length scale (%) */
  aerodynamics_type?: 'SIMPLE' | 'LIFT_FORCE';
  aero?: number;
  plastic?: number;
  spring_length?: number;
  /** self collision between the soft body's own vertices */
  use_self_collision?: boolean;
  self_ball_size?: number;
  /** only colliders in this collection */
  collision_collection?: string | null;
  /** vertex group scaling the mass of each vertex */
  vertex_group_mass?: string;
  /** vertex group scaling the edge spring stiffness */
  vertex_group_spring?: string;
  /** diagonal springs across quads */
  use_stiff_quads?: boolean;
  shear?: number;
  /** self collision ball size: manual, or from the average / shortest / longest edge */
  collision_type?: 'MANUAL' | 'AVERAGE' | 'MINIMAL' | 'MAXIMAL';
  ball_stiff?: number;
  ball_damp?: number;
  /** solver steps per frame (range, automatic within it) */
  step_min?: number;
  step_max?: number;
  use_auto_step?: boolean;
  /** velocity lost on contact with colliders (%) */
  choke?: number;
}

export interface SoftBodyModifier extends ModifierBase {
  settings: SoftBodySettings;
  point_cache: PointCacheSettings;
}

export interface ParticleSettingsX extends ParticleSettings {
  physics_type?: 'NEWTON' | 'NO' | 'BOIDS' | 'FLUID' | 'KEYED';
  boids?: import('./boids').BoidSettings;
  fluid?: import('./sph').ParticleFluidSettings;
  keyed_targets?: import('./keyed').KeyedTarget[];
  keyed_loops?: number;
  active_keyed_index?: number;
  effector_weights_types?: Record<string, number>;
  /** render as collection */
  instance_collection?: string | null;
  /** use the counts of `instance_weights` to pick collection objects */
  use_collection_count?: boolean;
  instance_weights?: { object: string; name: string; count: number }[];
  active_instanceweight_index?: number;
  use_collection_pick_random?: boolean;
  use_whole_collection?: boolean;
  /** render as lines */
  line_length_tail?: number;
  line_length_head?: number;
  use_velocity_length?: boolean;
  /** rotation */
  rotation_mode?: 'NONE' | 'NOR' | 'VEL' | 'GLOB_X' | 'GLOB_Y' | 'GLOB_Z' | 'OB_X' | 'OB_Y' | 'OB_Z';
  rotation_factor_random?: number;
  phase_factor?: number;
  phase_factor_random?: number;
  angular_velocity_mode?: 'NONE' | 'VELOCITY' | 'HORIZONTAL' | 'VERTICAL' | 'GLOBAL_X' | 'GLOBAL_Y' | 'GLOBAL_Z' | 'RAND';
  /** emitter children (simple): display amount, size and its randomness */
  child_nbr?: number;
  child_size?: number;
  child_size_random?: number;
  /** share of the particles shown in the viewport (%) */
  display_percentage?: number;
  /** velocity along the surface, and its direction around the normal (-1..1 × 180°) */
  tangent_factor?: number;
  tangent_phase?: number;
  /** collisions: particle radius keeps it off surfaces; particles die on hitting a surface */
  use_size_deflect?: boolean;
  use_die_on_collision?: boolean;
  /** render the emitter mesh as well */
  use_render_emitter?: boolean;
  /** only objects in this collection deflect the particles */
  collision_collection?: string | null;
  object_factor?: number;
  display_method?: 'RENDER' | 'DOT' | 'CIRC' | 'CROSS' | 'AXIS' | 'NONE';
  display_size?: number;
  use_dead?: boolean;
  material_slot?: number;
  use_scale_instance?: boolean;
  child_radius?: number;
  timestep_substeps?: number;
  /** seconds of simulation per frame */
  timestep?: number;
  /** how positions and velocities are advanced each step */
  integrator?: 'EULER' | 'VERLET' | 'MIDPOINT' | 'RK4';
  effector_weights_all?: number;
  use_collision?: boolean;
  // --- emission distribution
  distribution?: 'JIT' | 'RAND' | 'GRID';
  use_emit_random?: boolean;
  use_even_distribution?: boolean;
  userjit?: number;
  jitter_factor?: number;
  grid_resolution?: number;
  grid_random?: number;
  hexagonal_grid?: boolean;
  invert_grid?: boolean;
  // --- children
  child_percent?: number;
  child_roundness?: number;
  child_length?: number;
  child_length_threshold?: number;
  child_seed?: number;
  virtual_parents?: number;
  clump_shape?: number;
  use_clump_noise?: boolean;
  clump_noise_size?: number;
  kink?: 'NO' | 'CURL' | 'RADIAL' | 'WAVE' | 'BRAID' | 'SPIRAL';
  kink_amplitude?: number;
  kink_amplitude_clump?: number;
  kink_amplitude_random?: number;
  kink_frequency?: number;
  kink_shape?: number;
  kink_flat?: number;
  kink_axis?: 'X' | 'Y' | 'Z';
  kink_axis_random?: number;
  child_parting_factor?: number;
  child_parting_min?: number;
  child_parting_max?: number;
  roughness_1_size?: number;
  roughness_endpoint?: number;
  roughness_end_shape?: number;
  roughness_2?: number;
  roughness_2_size?: number;
  roughness_2_threshold?: number;
  // --- paths and display
  display_step?: number;
  render_step?: number;
  use_hair_bspline?: boolean;
  color_maximum?: number;
  show_unborn?: boolean;
  use_parent_particles?: boolean;
  use_absolute_path_time?: boolean;
  path_start?: number;
  path_end?: number;
  length_random?: number;
  /** particles act as force fields on other simulations */
  force_field_1?: ForceFieldX | null;
  force_field_2?: ForceFieldX | null;
  use_self_effect?: boolean;
  /** particles that act as fields (0: all) */
  effector_amount?: number;
  /** instances keep their object's world offset / rotation */
  use_global_instance?: boolean;
  use_rotation_instance?: boolean;
  // --- hair shape (strand thickness in renders)
  root_radius?: number;
  tip_radius?: number;
  radius_scale?: number;
  shape?: number;
  use_close_tip?: boolean;
}

/** Hand-edited hair (Particle Edit mode): keys per strand in the emitter's object space. */
export interface EditedHair {
  /** first key of each strand plus the total key count */
  key_offsets: Uint32Array;
  /** key positions xyz */
  co: Float32Array;
  /** per key weight (0..1), e.g. for hair dynamics pinning */
  weight: Float32Array;
  /** per key selection */
  select: Uint8Array;
  /** per strand hidden flag */
  hide: Uint8Array;
}

export interface ParticleSystemX extends ParticleSystem {
  point_cache?: PointCacheSettings;
  /** set once the hair was edited by hand; parents then come from these keys */
  edited_hair?: EditedHair | null;
  /** vertex groups shaping the emission (with invert toggles) */
  vertex_group_density?: string;
  invert_vertex_group_density?: boolean;
  vertex_group_length?: string;
  invert_vertex_group_length?: boolean;
  vertex_group_size?: string;
  invert_vertex_group_size?: boolean;
  vertex_group_velocity?: string;
  invert_vertex_group_velocity?: boolean;
  /** connected edited hair: roots bound to emitter triangles (follows deformation) */
  hair_binding?: import('./hairbind').HairBinding | null;
  /** the hair was disconnected from the emitter on purpose */
  hair_disconnected?: boolean;
  /** keyed targets / boid relations (other particle systems) */
  targets?: import('./keyed').KeyedTarget[];
  active_particle_target_index?: number;
  /** keyed: use the targets' own times and durations */
  use_keyed_timing?: boolean;
  /** hair dynamics: strands simulated like cloth chains */
  use_hair_dynamics?: boolean;
  hair_dynamics?: HairDynamicsSettings;
}

export interface HairDynamicsSettings {
  quality: number;
  pin_stiffness: number;
  mass: number;
  bending_stiffness: number;
  bending_damping: number;
  air_damping: number;
  use_collision: boolean;
  collision_distance: number;
  effector_weights_gravity: number;
  effector_weights_all: number;
  /** random stiffness per strand */
  bending_random?: number;
  /** volume: strands share their motion within cells, and keep a target density */
  internal_friction?: number;
  voxel_cell_size?: number;
  density_target?: number;
  density_strength?: number;
  collision_quality?: number;
  /** most velocity a collision may add in one frame (0: no limit) */
  impulse_clamp?: number;
  collision_collection?: string | null;
}

export function defaultHairDynamics(): HairDynamicsSettings {
  return {
    quality: 5,
    pin_stiffness: 0,
    mass: 0.3,
    bending_stiffness: 0.5,
    bending_damping: 0.5,
    air_damping: 1,
    use_collision: true,
    collision_distance: 0.005,
    effector_weights_gravity: 1,
    effector_weights_all: 1,
    bending_random: 0,
    internal_friction: 0,
    voxel_cell_size: 0.1,
    density_target: 0,
    density_strength: 0,
    collision_quality: 2,
    impulse_clamp: 0,
    collision_collection: null,
  };
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
    deactivate_linear_velocity: 0.4,
    deactivate_angular_velocity: 0.5,
    mesh_source: 'DEFORM',
    use_deform: false,
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
    stickiness: 0,
    damping_random: 0,
    friction_random: 0,
  };
}

/** Force field types offered in menus (value, label, icon). */
export const FIELD_TYPES: [ForceFieldX['type'], string, string][] = [
  ['GUIDE', 'Curve Guide', 'force_curve'],
  ['DRAG', 'Drag', 'force_drag'],
  ['FORCE', 'Force', 'force_force'],
  ['HARMONIC', 'Harmonic', 'force_harmonic'],
  ['LENNARDJ', 'Lennard-Jones', 'force_lennardjones'],
  ['MAGNET', 'Magnetic', 'force_magnetic'],
  ['TURBULENCE', 'Turbulence', 'force_turbulence'],
  ['VORTEX', 'Vortex', 'force_vortex'],
  ['WIND', 'Wind', 'force_wind'],
];

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
    shape: type === 'WIND' ? 'PLANE' : 'POINT',
    inflow: 0,
    rest_length: 0,
    harmonic_damping: 1,
    guide_minimum: 0,
    guide_free: 0.1,
    use_guide_path_add: false,
    guide_clump_amount: 0,
    apply_to_location: true,
    z_direction: 'BOTH',
    use_gravity_falloff: false,
    use_absorption: false,
    wind_factor: 1,
    radial_falloff: 0,
    use_radial_min: false,
    radial_min: 0,
    use_radial_max: false,
    radial_max: 0,
    use_global_coords: false,
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
    effector_weights_types: {},
    shrink_max: 0,
    vertex_group_shrink: '',
    use_sewing_springs: false,
    sewing_force_max: 0,
    use_pressure: false,
    uniform_pressure_force: 0,
    use_pressure_volume: false,
    target_volume: 0,
    pressure_factor: 1,
    fluid_density: 0,
    vertex_group_pressure: '',
    use_internal_springs: false,
    internal_spring_max_length: 0,
    internal_spring_max_diversion: Math.PI / 4,
    internal_spring_normal_check: false,
    internal_tension_stiffness: 15,
    internal_compression_stiffness: 15,
    vertex_group_structural_stiffness: '',
    tension_stiffness_max: 15,
    compression_stiffness_max: 15,
    vertex_group_shear_stiffness: '',
    shear_stiffness_max: 5,
    vertex_group_bending: '',
    bending_stiffness_max: 0.5,
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
    effector_weights_types: {},
    aerodynamics_type: 'SIMPLE',
    aero: 0,
    plastic: 0,
    spring_length: 0,
    use_self_collision: false,
    self_ball_size: 0.1,
    collision_collection: null,
    vertex_group_mass: '',
    vertex_group_spring: '',
    use_stiff_quads: false,
    shear: 1,
    collision_type: 'AVERAGE',
    ball_stiff: 1,
    ball_damp: 0.5,
    step_min: 10,
    step_max: 300,
    use_auto_step: true,
    choke: 3,
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
    timestep: 0.04,
    integrator: 'MIDPOINT',
    use_collision: true,
    users: 1,
    display_percentage: 100,
    tangent_factor: 0,
    tangent_phase: 0,
    use_size_deflect: false,
    use_die_on_collision: false,
    use_render_emitter: true,
    child_nbr: 10,
    child_size: 1,
    child_size_random: 0,
    rotation_mode: 'VEL',
    rotation_factor_random: 0,
    phase_factor: 0,
    phase_factor_random: 0,
    angular_velocity_mode: 'NONE',
    line_length_tail: 0,
    line_length_head: 0.1,
    use_velocity_length: false,
    keyed_loops: 1,
    instance_collection: null,
    use_whole_collection: false,
    use_collection_pick_random: false,
    distribution: 'JIT',
    use_emit_random: true,
    use_even_distribution: true,
    userjit: 0,
    jitter_factor: 1,
    grid_resolution: 10,
    grid_random: 0,
    hexagonal_grid: false,
    invert_grid: false,
    child_percent: 10,
    child_roundness: 0,
    child_length: 1,
    child_length_threshold: 0,
    child_seed: 0,
    virtual_parents: 0,
    clump_shape: 0,
    use_clump_noise: false,
    clump_noise_size: 1,
    kink: 'NO',
    kink_amplitude: 0.2,
    kink_amplitude_clump: 1,
    kink_amplitude_random: 0,
    kink_frequency: 2,
    kink_shape: 0,
    kink_flat: 0,
    kink_axis: 'Z',
    kink_axis_random: 0,
    child_parting_factor: 0,
    child_parting_min: 0,
    child_parting_max: 0,
    roughness_1_size: 1,
    roughness_endpoint: 0,
    roughness_end_shape: 1,
    roughness_2: 0,
    roughness_2_size: 1,
    roughness_2_threshold: 0,
    display_step: 2,
    render_step: 3,
    use_hair_bspline: false,
    display_color: 'MATERIAL',
    color_maximum: 1,
    show_unborn: false,
    use_parent_particles: false,
    use_absolute_path_time: false,
    path_start: 0,
    path_end: 1,
    length_random: 0,
    use_global_instance: false,
    use_rotation_instance: false,
    force_field_1: null,
    force_field_2: null,
    use_self_effect: false,
    effector_amount: 0,
    root_radius: 1,
    tip_radius: 0,
    radius_scale: 0.01,
    shape: 0,
    use_close_tip: true,
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
