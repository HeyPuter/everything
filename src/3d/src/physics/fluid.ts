// Fluid modifier (gas only): Domain / Flow / Effector objects. The domain runs the
// coarse smoke & fire solver (smoke-solver.ts) frame by frame into a frame cache;
// the viewport ray-marches the cached density/flame grids (draw.ts).
import { Matrix4, Vector3 } from 'three';
import type { DocumentData, ModifierBase, ObjectData } from '../data/types';
import type { EvalMesh, ModifierContext } from '../eval/types';
import type { Depsgraph } from '../eval/depsgraph';
import { meshSignature, baseEvalMesh } from '../eval/depsgraph';
import { registerModifier } from '../eval/modifiers';
import { arrayChecksum, caches, collectionMembers, rand01, frameOf, getCache, motionKey, outOfTime, strHash, worldAt, type FrameCache, type SimContext } from './common';
import { groupWeights } from '../eval/meshbuild';
import { proceduralTexture } from '../eval/textures';
import { particleCacheKey, systemOf } from './particles';
import { applyGuides, blurGuides, domainGuides, effectorGuides, quantizeVelocity } from './fluidguide';
import { peekFluidLayers, fluidLayers, freeFluidLayers, cacheType, mayStepData, layerBaked, fluidJob, type NoiseFrame } from './fluidcache';
import { upresGas } from './fluidnoise';
import { fluidOverlays } from './fluidoverlay';
import { triangulate, closestOnTri } from './colliders';
import { collectEffectors, effectorForce, fieldsKey } from './fields';
import { newGrid, stepGas, type GasGrid, type GasParams } from './smoke-solver';
import { physicsDoc } from './state';
import { fps } from './meshsim';
import { defaultPointCache, type ParticleSystemX, type PointCacheSettings } from './types';
import { evaluateLiquid, fluidShared, liquidSurface, liquidPointSets } from './liquid';
import { particleDraw } from './particles';

export interface FluidDomainSettings {
  domain_type: 'GAS' | 'LIQUID';
  /** liquid: FLIP/PIC blend, particles per cell axis and their jitter, surface meshing */
  flip_ratio?: number;
  particle_number?: number;
  particle_randomness?: number;
  use_mesh?: boolean;
  mesh_particle_radius?: number;
  mesh_scale?: number;
  /** liquid viscosity = base × 10^-exponent (m²/s) */
  use_diffusion?: boolean;
  viscosity_base?: number;
  viscosity_exponent?: number;
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
  /** flows and effectors are limited to these collections when set */
  fluid_group?: string | null;
  effector_group?: string | null;
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
  // --- time stepping
  use_adaptive_timesteps?: boolean;
  cfl_condition?: number;
  timesteps_max?: number;
  timesteps_min?: number;
  /** remove fluid that ends up inside obstacles */
  delete_in_obstacle?: boolean;
  /** gas: the simulated region follows the smoke (the grid shrinks to the occupied cells plus a margin) */
  use_adaptive_domain?: boolean;
  additional_res?: number;
  adapt_margin?: number;
  adapt_threshold?: number;
  // --- gas extras
  use_dissolve_smoke_log?: boolean;
  flame_ignition?: number;
  flame_smoke_color?: [number, number, number];
  use_noise?: boolean;
  noise_scale?: number;
  noise_strength?: number;
  noise_pos_scale?: number;
  noise_time_anim?: number;
  // --- liquid extras
  simulation_method?: 'FLIP' | 'APIC';
  sys_particle_maximum?: number;
  particle_radius?: number;
  particle_min?: number;
  particle_max?: number;
  particle_band_width?: number;
  use_fractions?: boolean;
  fractions_distance?: number;
  fractions_threshold?: number;
  use_flip_particles?: boolean;
  surface_tension?: number;
  use_viscosity?: boolean;
  viscosity_value?: number;
  mesh_generator?: 'IMPROVED' | 'UNION';
  mesh_smoothen_pos?: number;
  mesh_smoothen_neg?: number;
  mesh_concave_upper?: number;
  mesh_concave_lower?: number;
  use_speed_vectors?: boolean;
  // secondary particles
  use_spray_particles?: boolean;
  use_foam_particles?: boolean;
  use_bubble_particles?: boolean;
  sndparticle_combined_export?: 'OFF' | 'SPRAY_FOAM' | 'SPRAY_BUBBLES' | 'FOAM_BUBBLES' | 'SPRAY_FOAM_BUBBLES';
  particle_scale?: number;
  sndparticle_potential_min_wavecrest?: number;
  sndparticle_potential_max_wavecrest?: number;
  sndparticle_potential_min_trappedair?: number;
  sndparticle_potential_max_trappedair?: number;
  sndparticle_potential_min_energy?: number;
  sndparticle_potential_max_energy?: number;
  sndparticle_potential_radius?: number;
  sndparticle_update_radius?: number;
  sndparticle_sampling_wavecrest?: number;
  sndparticle_sampling_trappedair?: number;
  sndparticle_life_min?: number;
  sndparticle_life_max?: number;
  sndparticle_bubble_buoyancy?: number;
  sndparticle_bubble_drag?: number;
  sndparticle_boundary?: 'DELETE' | 'PUSHOUT';
  // --- guides
  use_guide?: boolean;
  guide_alpha?: number;
  guide_beta?: number;
  guide_vel_factor?: number;
  guide_source?: 'DOMAIN' | 'EFFECTOR';
  guide_parent?: string | null;
  // --- cache
  cache_type?: 'REPLAY' | 'MODULAR' | 'ALL';
  cache_resumable?: boolean;
  cache_frame_offset?: number;
  cache_directory?: string;
  cache_data_format?: 'UNI' | 'OPENVDB' | 'RAW';
  cache_mesh_format?: 'UNI' | 'OPENVDB' | 'RAW';
  cache_particle_format?: 'UNI' | 'OPENVDB' | 'RAW';
  cache_noise_format?: 'UNI' | 'OPENVDB' | 'RAW';
  openvdb_cache_compress_type?: 'ZIP' | 'BLOSC' | 'NONE';
  openvdb_data_depth?: '16' | '32';
  /** which layers are baked (modular / all cache types) */
  has_cache_baked_data?: boolean;
  has_cache_baked_noise?: boolean;
  has_cache_baked_mesh?: boolean;
  has_cache_baked_particles?: boolean;
  has_cache_baked_guide?: boolean;
  /** last frame a paused bake reached (per layer), 0 when not paused */
  cache_frame_pause_data?: number;
  cache_frame_pause_noise?: number;
  cache_frame_pause_mesh?: number;
  cache_frame_pause_particles?: number;
  cache_frame_pause_guide?: number;
  // --- viewport display
  display_interpolation?: 'LINEAR' | 'CUBIC' | 'CLOSEST';
  slice_per_voxel?: number;
  use_slice?: boolean;
  slice_axis?: 'AUTO' | 'X' | 'Y' | 'Z';
  slice_depth?: number;
  show_gridlines?: boolean;
  use_color_ramp?: boolean;
  color_ramp_field?: string;
  color_ramp_field_scale?: number;
  show_velocity?: boolean;
  vector_display_type?: 'NEEDLE' | 'STREAMLINE' | 'MAC';
  vector_field?: 'FLUID_VELOCITY' | 'GUIDE_VELOCITY' | 'FORCE';
  vector_scale_with_magnitude?: boolean;
  vector_show_mac_x?: boolean;
  vector_show_mac_y?: boolean;
  vector_show_mac_z?: boolean;
  vector_scale?: number;
  gridlines_color_field?: 'NONE' | 'FLAGS' | 'RANGE';
  gridlines_lower_bound?: number;
  gridlines_upper_bound?: number;
  gridlines_range_color?: [number, number, number, number];
  gridlines_cell_filter?: 'NONE' | 'FLUID' | 'OBSTACLE' | 'EMPTY' | 'INFLOW' | 'OUTFLOW';
  clipping?: number;
  /** render: motion blur scale of the velocities */
  velocity_scale?: number;
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
  /** emit from the mesh or from the particles of one of its particle systems */
  flow_source?: 'MESH' | 'PARTICLES';
  /** name of the particle system on the flow object (flow source Particles) */
  particle_system?: string | null;
  use_particle_size?: boolean;
  particle_size?: number;
  /** treat the mesh as an open surface (no inside) */
  use_plane_init?: boolean;
  /** extra emission steps between frames for fast moving flows */
  subframes?: number;
  density_vertex_group?: string;
  /** set (instead of add) density in emitting cells */
  use_absolute?: boolean;
  velocity_random?: number;
  /** initial velocity in world space (m/s) */
  velocity_coord?: [number, number, number];
  use_texture?: boolean;
  noise_texture?: string | null;
  texture_map_type?: 'AUTO' | 'UV';
  uv_layer?: string;
  texture_size?: number;
  texture_offset?: number;
}

export interface FluidEffectorSettings {
  effector_type: 'COLLISION' | 'GUIDE';
  use_effector: boolean;
  /** extra thickness around the surface (cells) */
  surface_distance?: number;
  use_plane_init?: boolean;
  /** guide: multiplier of the object's velocity and how it combines with the fluid */
  velocity_factor?: number;
  guide_mode?: 'MAXIMUM' | 'MINIMUM' | 'OVERRIDE' | 'AVERAGED';
  subframes?: number;
}

export function defaultEffectorSettings(): FluidEffectorSettings {
  return { effector_type: 'COLLISION', use_effector: true, surface_distance: 0, use_plane_init: false, velocity_factor: 1, guide_mode: 'OVERRIDE', subframes: 0 };
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
    use_diffusion: false,
    viscosity_base: 1,
    viscosity_exponent: 6,
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
    use_adaptive_timesteps: true,
    cfl_condition: 2,
    timesteps_max: 4,
    timesteps_min: 1,
    delete_in_obstacle: false,
    use_adaptive_domain: false,
    additional_res: 0,
    adapt_margin: 4,
    adapt_threshold: 0.002,
    use_dissolve_smoke_log: true,
    flame_ignition: 1.5,
    flame_smoke_color: [0.7, 0.7, 0.7],
    use_noise: false,
    noise_scale: 2,
    noise_strength: 1,
    noise_pos_scale: 2,
    noise_time_anim: 0.1,
    simulation_method: 'FLIP',
    sys_particle_maximum: 0,
    particle_radius: 1,
    particle_min: 8,
    particle_max: 16,
    particle_band_width: 3,
    use_fractions: false,
    fractions_distance: 0.5,
    fractions_threshold: 0.05,
    use_flip_particles: true,
    surface_tension: 0,
    use_viscosity: false,
    viscosity_value: 0.05,
    mesh_generator: 'IMPROVED',
    mesh_smoothen_pos: 1,
    mesh_smoothen_neg: 1,
    mesh_concave_upper: 3.5,
    mesh_concave_lower: 0.4,
    use_speed_vectors: false,
    use_spray_particles: false,
    use_foam_particles: false,
    use_bubble_particles: false,
    sndparticle_combined_export: 'OFF',
    particle_scale: 1,
    sndparticle_potential_min_wavecrest: 2,
    sndparticle_potential_max_wavecrest: 8,
    sndparticle_potential_min_trappedair: 5,
    sndparticle_potential_max_trappedair: 20,
    sndparticle_potential_min_energy: 1,
    sndparticle_potential_max_energy: 5,
    sndparticle_potential_radius: 2,
    sndparticle_update_radius: 2,
    sndparticle_sampling_wavecrest: 200,
    sndparticle_sampling_trappedair: 40,
    sndparticle_life_min: 10,
    sndparticle_life_max: 25,
    sndparticle_bubble_buoyancy: 0.5,
    sndparticle_bubble_drag: 0.6,
    sndparticle_boundary: 'DELETE',
    use_guide: false,
    guide_alpha: 2,
    guide_beta: 5,
    guide_vel_factor: 2,
    guide_source: 'DOMAIN',
    guide_parent: null,
    cache_type: 'REPLAY',
    cache_resumable: false,
    cache_frame_offset: 0,
    cache_directory: '//cache_fluid',
    cache_data_format: 'OPENVDB',
    cache_mesh_format: 'UNI',
    cache_particle_format: 'OPENVDB',
    cache_noise_format: 'OPENVDB',
    openvdb_cache_compress_type: 'BLOSC',
    openvdb_data_depth: '16',
    has_cache_baked_data: false,
    has_cache_baked_noise: false,
    has_cache_baked_mesh: false,
    has_cache_baked_particles: false,
    has_cache_baked_guide: false,
    cache_frame_pause_data: 0,
    cache_frame_pause_noise: 0,
    cache_frame_pause_mesh: 0,
    cache_frame_pause_particles: 0,
    cache_frame_pause_guide: 0,
    display_interpolation: 'LINEAR',
    slice_per_voxel: 5,
    use_slice: false,
    slice_axis: 'AUTO',
    slice_depth: 0.5,
    show_gridlines: false,
    use_color_ramp: false,
    color_ramp_field: 'DENSITY',
    color_ramp_field_scale: 1,
    show_velocity: false,
    vector_display_type: 'NEEDLE',
    vector_field: 'FLUID_VELOCITY',
    vector_scale_with_magnitude: false,
    vector_show_mac_x: true,
    vector_show_mac_y: true,
    vector_show_mac_z: true,
    vector_scale: 1,
    gridlines_color_field: 'NONE',
    gridlines_lower_bound: 0,
    gridlines_upper_bound: 1,
    gridlines_range_color: [1, 0, 0, 1],
    gridlines_cell_filter: 'NONE',
    clipping: 1e-6,
    velocity_scale: 1,
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
    flow_source: 'MESH',
    particle_system: null,
    use_particle_size: true,
    particle_size: 1,
    use_plane_init: false,
    subframes: 0,
    density_vertex_group: '',
    use_absolute: true,
    velocity_random: 0,
    velocity_coord: [0, 0, 0],
    use_texture: false,
    noise_texture: null,
    texture_map_type: 'AUTO',
    uv_layer: '',
    texture_size: 1,
    texture_offset: 0,
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
  /** viewport display options of the domain */
  interpolation?: 'LINEAR' | 'CUBIC' | 'CLOSEST';
  slicePerVoxel?: number;
  /** the coarse cache frame (heat, velocities, obstacles) and its resolution, for field display */
  frame?: FluidFrame;
  coarse?: [number, number, number];
  settings?: FluidDomainSettings;
  /** adaptive domain region (coarse cells) */
  window?: [number, number, number, number, number, number] | null;
}

/** Latest evaluated smoke grids per `${object id}:${modifier id}` (viewport evaluation only). */
export const smokeDraw = new Map<string, SmokeDraw>();

const fluidOf = (ob: ObjectData) => ob.modifiers.find((m) => m.type === 'FLUID') as FluidModifier | undefined;

function participants(doc: DocumentData, kind: 'FLOW' | 'EFFECTOR', domain?: FluidModifier): { ob: ObjectData; m: FluidModifier }[] {
  const out: { ob: ObjectData; m: FluidModifier }[] = [];
  const only = domain ? collectionMembers(doc, kind === 'FLOW' ? domain.domain_settings?.fluid_group : domain.domain_settings?.effector_group) : null;
  for (const id of doc.object_order) {
    const ob = doc.objects[id];
    const m = ob ? fluidOf(ob) : undefined;
    if (ob && m && m.fluid_type === kind && m.show_viewport && ob.type === 'MESH' && !ob.hide_viewport && (!only || only.has(ob.id))) out.push({ ob, m });
  }
  return out;
}

/** Settings that only change what is shown or derived later (noise, mesh, particles), not the simulation. */
const NOT_SIMULATED = /^(display_|slice_|show_|use_slice|use_color_ramp|color_ramp|vector_|gridlines_|velocity_scale|noise_|use_noise|mesh_|use_mesh|use_speed_vectors|use_flip_particles|use_spray_particles|use_foam_particles|use_bubble_particles|use_tracer_particles|sndparticle_|particle_scale|cache_|has_cache_|openvdb_|clipping_display)/;

/** Key of the domain settings that affect the simulated data. */
export function simulationSettingsKey(s: FluidDomainSettings | undefined): string {
  if (!s) return '';
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(s).sort()) if (!NOT_SIMULATED.test(k)) o[k] = (s as unknown as Record<string, unknown>)[k];
  return JSON.stringify(o);
}

function domainHash(doc: DocumentData, ob: ObjectData, m: FluidModifier, mesh: EvalMesh | null): string {
  const pc = m.point_cache;
  const parts = [
    simulationSettingsKey(m.domain_settings),
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
    for (const p of participants(doc, kind, m)) {
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
  /** texture coordinates per cell (when asked for) */
  coords?: Float32Array | null;
}

const cornerCache = new WeakMap<Uint32Array, Int32Array>();
/** One face corner per vertex (for looking up texture coordinates by vertex). */
function cornerOfVertex(mesh: EvalMesh): Int32Array {
  let c = cornerCache.get(mesh.indices);
  if (!c) {
    c = new Int32Array(mesh.positions.length / 3);
    for (let i = mesh.indices.length - 1; i >= 0; i--) c[mesh.indices[i]] = i;
    cornerCache.set(mesh.indices, c);
  }
  return c;
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

export interface VoxelizeOptions {
  /** per vertex weights scaling the surface emission (vertex group) */
  weights?: Float32Array | null;
  /** texture coordinates per cell: 'UV' from the closest surface point, 'AUTO' from the object's bounds */
  coords?: 'UV' | 'AUTO' | null;
}

function voxelize(ctx: SimContext, ob: ObjectData, frame: number, G: GridFrame, surface: number, volume: number, wantNormals: boolean, opts: VoxelizeOptions = {}): Voxels | null {
  const mesh = meshOf(ctx, ob);
  if (!mesh) return null;
  const vw = opts.weights && opts.weights.length * 3 >= mesh.positions.length ? opts.weights : null;
  const uvMode = opts.coords === 'UV' && mesh.uvs.length ? 'UV' : opts.coords ? 'AUTO' : null;
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
  // texture coordinates (u, v, w) per cell; generated ones come from the object's local bounds
  const tc = uvMode ? new Float32Array(n * 3) : null;
  const tcDist = uvMode === 'UV' ? new Float32Array(n).fill(Infinity) : null;
  let lmin: number[] = [0, 0, 0],
    lsize: number[] = [1, 1, 1];
  const toLocal = uvMode ? M.clone().invert().elements : null;
  if (uvMode) {
    const Pm = mesh.positions;
    const mn = [Infinity, Infinity, Infinity],
      mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < Pm.length; i += 3)
      for (let c = 0; c < 3; c++) {
        mn[c] = Math.min(mn[c], Pm[i + c]);
        mx[c] = Math.max(mx[c], Pm[i + c]);
      }
    lmin = mn;
    lsize = mx.map((x, c) => Math.max(1e-6, x - mn[c]));
  }
  const corner = uvMode === 'UV' ? cornerOfVertex(mesh) : null;
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
            let wt = Math.min(1, 1 - d / surface + 0.25);
            if (vw) wt *= Math.max(0, vw[a / 3] * _w[0] + vw[b / 3] * _w[1] + vw[c / 3] * _w[2]);
            if (wt > w[o]) w[o] = wt;
            if (tcDist && corner && d < tcDist[o]) {
              tcDist[o] = d;
              const U = mesh.uvs;
              const ca = corner[a / 3] * 2,
                cb = corner[b / 3] * 2,
                cc = corner[c / 3] * 2;
              tc![o * 3] = U[ca] * _w[0] + U[cb] * _w[1] + U[cc] * _w[2];
              tc![o * 3 + 1] = U[ca + 1] * _w[0] + U[cb + 1] * _w[1] + U[cc + 1] * _w[2];
              tc![o * 3 + 2] = 0;
            }
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
  if (tc && toLocal) {
    // generated coordinates (-1..1 over the object's bounds) for cells without surface coordinates
    const L = toLocal;
    for (let k = 0, o = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++, o++) {
          if (w[o] <= 0 || (tcDist && tcDist[o] < Infinity)) continue;
          const px = i + 0.5,
            py = j + 0.5,
            pz = k + 0.5;
          const lx = L[0] * px + L[4] * py + L[8] * pz + L[12],
            ly = L[1] * px + L[5] * py + L[9] * pz + L[13],
            lz = L[2] * px + L[6] * py + L[10] * pz + L[14];
          tc[o * 3] = ((lx - lmin[0]) / lsize[0]) * 2 - 1;
          tc[o * 3 + 1] = ((ly - lmin[1]) / lsize[1]) * 2 - 1;
          tc[o * 3 + 2] = ((lz - lmin[2]) / lsize[2]) * 2 - 1;
        }
  }
  // object velocity (grid cells per second) from the motion over the last frame
  let vel: [number, number, number] | null = null;
  const prev = new Matrix4().multiplyMatrices(G.toGrid, worldAt(ctx, ob, frame - 1));
  const c0 = new Vector3().setFromMatrixPosition(prev),
    c1 = new Vector3().setFromMatrixPosition(M);
  const f = fps(ctx.doc);
  if (c0.distanceToSquared(c1) > 1e-12) vel = [(c1.x - c0.x) * f, (c1.y - c0.y) * f, (c1.z - c0.z) * f];
  return { w, nx: vnx, ny: vny, nz: vnz, vel, coords: tc };
}

// ---------------------------------------------------------------------------
// Domain simulation

export interface FluidFrame {
  /** RG8: density, flame */
  data: Uint8Array;
  /** heat per cell (0..255 ≙ 0..4) */
  heat?: Uint8Array;
  /** velocities (grid cells / s) quantized to signed bytes, xyz per cell, with their scale */
  vel?: Int8Array;
  velScale?: number;
  /** obstacle cells */
  solid?: Uint8Array;
  /** adaptive domain region of this frame (cells) */
  window?: [number, number, number, number, number, number] | null;
}

export interface FluidLive {
  /** adaptive domain: the simulated region (cells, inclusive min / exclusive max) */
  window?: [number, number, number, number, number, number] | null;
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

/** Shared obstacle / emission helpers for gas and liquid domains. */

/** Mark obstacle cells of the collision effectors (thickness and planar options apply). */
export function markObstacles(ctx: SimContext, effectors: { ob: ObjectData; m: FluidModifier }[], G: GridFrame, k: number, solid: Uint8Array) {
  solid.fill(0);
  const n = solid.length;
  for (const e of effectors) {
    const es = { ...defaultEffectorSettings(), ...e.m.effector_settings };
    if (!es.use_effector || es.effector_type === 'GUIDE') continue;
    const subs = Math.max(0, Math.round(es.subframes ?? 0));
    for (let sf = subs; sf >= 0; sf--) {
      const fr = k - sf / (subs + 1);
      const vx = voxelize(ctx, e.ob, fr, G, 0.75 + (es.surface_distance ?? 0), es.use_plane_init ? 0 : 1, false);
      if (vx) for (let o = 0; o < n; o++) if (vx.w[o] > 0.5) solid[o] = 1;
    }
  }
}

/** World positions of the alive particles of a flow object's particle system at a frame. */
function flowParticles(doc: DocumentData, ob: ObjectData, name: string | null | undefined, frame: number): { pos: Float32Array; size: number } | null {
  const ps = (name ? ob.particle_systems.find((p) => p.name === name) : ob.particle_systems[0]) as ParticleSystemX | undefined;
  if (!ps) return null;
  const m = ob.modifiers.find((x) => x.type === 'PARTICLE_SYSTEM' && systemOf(ob, x) === ps);
  if (!m) return null;
  const c = caches.get(particleCacheKey(ob, m)) as FrameCache<{ pos: Float32Array; state: Uint8Array }> | undefined;
  const fr = c?.frames.get(Math.round(frame)) ?? c?.nearest(Math.round(frame));
  if (!fr) return null;
  let cnt = 0;
  for (let i = 0; i < fr.state.length; i++) if (fr.state[i] === 1) cnt++;
  const pos = new Float32Array(cnt * 3);
  for (let i = 0, w = 0; i < fr.state.length; i++)
    if (fr.state[i] === 1) {
      pos[w++] = fr.pos[i * 3];
      pos[w++] = fr.pos[i * 3 + 1];
      pos[w++] = fr.pos[i * 3 + 2];
    }
  const s = doc.particles[ps.settings];
  return { pos, size: s?.particle_size ?? 0.05 };
}

/** Emission cells of particles: a ball per particle (radius in cells). */
function particleVoxels(pos: Float32Array, G: GridFrame, radius: number): Voxels {
  const { nx, ny, nz } = G;
  const w = new Float32Array(nx * ny * nz);
  const e = G.toGrid.elements;
  const r = Math.max(0.5, radius);
  for (let p = 0; p < pos.length; p += 3) {
    const x = pos[p],
      y = pos[p + 1],
      z = pos[p + 2];
    const gx = e[0] * x + e[4] * y + e[8] * z + e[12],
      gy = e[1] * x + e[5] * y + e[9] * z + e[13],
      gz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const i0 = Math.max(0, Math.floor(gx - r)),
      i1 = Math.min(nx - 1, Math.floor(gx + r)),
      j0 = Math.max(0, Math.floor(gy - r)),
      j1 = Math.min(ny - 1, Math.floor(gy + r)),
      k0 = Math.max(0, Math.floor(gz - r)),
      k1 = Math.min(nz - 1, Math.floor(gz + r));
    for (let kk = k0; kk <= k1; kk++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(i + 0.5 - gx, j + 0.5 - gy, kk + 0.5 - gz);
          if (d > r) continue;
          const o = i + j * nx + kk * nx * ny;
          const wt = Math.min(1, 1.25 - d / r);
          if (wt > w[o]) w[o] = wt;
        }
  }
  return { w, nx: null, ny: null, nz: null, vel: null };
}

export interface FlowEmission {
  fs: FluidFlowSettings;
  vx: Voxels;
  /** world initial velocity in grid units per second (velocity_coord) */
  coord: [number, number, number] | null;
}

/**
 * Cells a flow emits into at frame k: its mesh surface / volume (or its particles), unioned over the
 * sampling substeps, scaled by its vertex group and texture.
 */
export function flowEmission(ctx: SimContext, fl: { ob: ObjectData; m: FluidModifier }, k: number, G: GridFrame, gas: boolean): FlowEmission | null {
  const fs = { ...defaultFlowSettings(), ...fl.m.flow_settings };
  const subs = Math.max(0, Math.round(fs.subframes ?? 0));
  let vx: Voxels | null = null;
  if (fs.flow_source === 'PARTICLES') {
    const pp = flowParticles(ctx.doc, fl.ob, fs.particle_system, k);
    if (!pp) return null;
    const cpm = Math.cbrt(Math.abs(G.toGrid.determinant()));
    const radius = fs.use_particle_size ? (fs.particle_size ?? 1) : pp.size * cpm;
    vx = particleVoxels(pp.pos, G, radius);
  } else {
    const mesh = meshOf(ctx, fl.ob);
    const weights = mesh && fs.density_vertex_group ? groupWeights(mesh, fs.density_vertex_group) : null;
    const wantNormals = fs.use_initial_velocity && fs.velocity_normal !== 0;
    const volume = fs.use_plane_init ? 0 : gas ? fs.volume_density : 1;
    const coords = fs.use_texture && fs.noise_texture ? (fs.texture_map_type === 'UV' ? 'UV' : 'AUTO') : null;
    for (let sf = subs; sf >= 0; sf--) {
      const fr = k - sf / (subs + 1);
      const v = voxelize(ctx, fl.ob, fr, G, fs.surface_distance, volume, wantNormals, { weights, coords });
      if (!v) continue;
      if (!vx) vx = v;
      else for (let o = 0; o < v.w.length; o++) if (v.w[o] > vx.w[o]) vx.w[o] = v.w[o];
    }
  }
  if (!vx) return null;
  // procedural texture scales the emission
  const tex = fs.use_texture ? (fs.noise_texture as unknown as Record<string, unknown> | null) : null;
  if (tex && typeof tex === 'object' && tex.type && vx.coords) {
    const C = vx.coords;
    const sz = Math.max(1e-3, fs.texture_size ?? 1),
      off = fs.texture_offset ?? 0;
    for (let o = 0; o < vx.w.length; o++) {
      if (vx.w[o] <= 0) continue;
      vx.w[o] *= Math.max(0, Math.min(1, proceduralTexture(tex, C[o * 3] / sz, C[o * 3 + 1] / sz, C[o * 3 + 2] / sz + off)));
    }
  }
  let coord: [number, number, number] | null = null;
  if (fs.use_initial_velocity && fs.velocity_coord && fs.velocity_coord.some((x) => x !== 0)) {
    const v = new Vector3(...fs.velocity_coord).applyMatrix4(G.toGrid.clone().setPosition(0, 0, 0));
    coord = [v.x, v.y, v.z];
  }
  return { fs, vx, coord };
}

/** Cells holding gas (or being emitted into), grown by the margin: [i0, j0, k0, i1, j1, k1), or null when empty. */
export function activeBox(g: GasGrid, emitters: Float32Array[], threshold: number, margin: number): [number, number, number, number, number, number] | null {
  const { nx, ny, nz } = g;
  let i0 = nx,
    j0 = ny,
    k0 = nz,
    i1 = -1,
    j1 = -1,
    k1 = -1;
  for (let k = 0, o = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        const on = g.density[o] > threshold || g.heat[o] > threshold || g.fuel[o] > threshold || g.flame[o] > threshold || emitters.some((w) => w[o] > 0);
        if (!on) continue;
        if (i < i0) i0 = i;
        if (j < j0) j0 = j;
        if (k < k0) k0 = k;
        if (i > i1) i1 = i;
        if (j > j1) j1 = j;
        if (k > k1) k1 = k;
      }
  if (i1 < 0) return null;
  return [Math.max(0, i0 - margin), Math.max(0, j0 - margin), Math.max(0, k0 - margin), Math.min(nx, i1 + 1 + margin), Math.min(ny, j1 + 1 + margin), Math.min(nz, k1 + 1 + margin)];
}

const windowGrids = new WeakMap<GasGrid, GasGrid>();
const FIELDS = ['density', 'fuel', 'flame', 'heat', 'u', 'v', 'w'] as const;

/** Step only a box of the grid: copied into a smaller grid, solved, copied back (outside stays still). */
function stepWindow(g: GasGrid, P: GasParams, b: [number, number, number, number, number, number]) {
  const [i0, j0, k0, i1, j1, k1] = b;
  const wx = i1 - i0,
    wy = j1 - j0,
    wz = k1 - k0;
  let sub = windowGrids.get(g);
  if (!sub || sub.nx !== wx || sub.ny !== wy || sub.nz !== wz) {
    sub = newGrid(wx, wy, wz);
    windowGrids.set(g, sub);
  }
  const copy = (back: boolean) => {
    for (let k = 0; k < wz; k++)
      for (let j = 0; j < wy; j++) {
        const so = j * wx + k * wx * wy,
          go = i0 + (j + j0) * g.nx + (k + k0) * g.nx * g.ny;
        for (const f of FIELDS) {
          if (back) g[f].set(sub![f].subarray(so, so + wx), go);
          else sub![f].set(g[f].subarray(go, go + wx), so);
        }
        if (!back) sub!.solid.set(g.solid.subarray(go, go + wx), so);
      }
  };
  copy(false);
  // borders of the box that lie on the domain border keep their collision setting; inner ones are open
  const c = P.closed;
  stepGas(sub, { ...P, closed: [i0 === 0 && c[0], i1 === g.nx && c[1], j0 === 0 && c[2], j1 === g.ny && c[3], k0 === 0 && c[4], k1 === g.nz && c[5]] });
  copy(true);
}

/** Number of solver steps for a frame from the CFL condition (cells moved per step). */
export function timeSteps(s: FluidDomainSettings, vmax: number, dtFrame: number): number {
  const lo = Math.max(1, Math.round(s.timesteps_min ?? 1)),
    hi = Math.max(lo, Math.round(s.timesteps_max ?? 4));
  if (s.use_adaptive_timesteps === false) return lo;
  const cfl = Math.max(0.1, s.cfl_condition ?? 2);
  return Math.min(hi, Math.max(lo, Math.ceil((vmax * dtFrame) / cfl)));
}

/** Guide velocities for a domain at frame k (null when guiding is off or nothing guides). */
export function guideFieldFor(ctx: SimContext, ob: ObjectData, m: FluidModifier, G: GridFrame, k: number, cacheKey: string): Float32Array | null {
  const s = m.domain_settings;
  if (!s.use_guide) return null;
  const baked = peekFluidLayers(cacheKey)?.guide.get(k);
  if (baked) return baked;
  let field: Float32Array | null = null;
  if ((s.guide_source ?? 'DOMAIN') === 'EFFECTOR') {
    const guides = participants(ctx.doc, 'EFFECTOR', m).filter((p) => p.m.effector_settings?.effector_type === 'GUIDE');
    field = effectorGuides(ctx, guides, G, k, voxelize);
  } else {
    const par = s.guide_parent ? ctx.doc.objects[s.guide_parent] : undefined;
    const pm = par ? fluidOf(par) : undefined;
    if (par && pm && pm.fluid_type === 'DOMAIN' && par !== ob) {
      const c = caches.get(fluidCacheKey(par, pm)) as FrameCache<FluidFrame, FluidLive> | undefined;
      const fr = c?.frames.get(k) ?? c?.nearest(k);
      if (fr?.vel && c?.live) field = domainGuides({ G: c.live.G, vel: fr.vel, scale: fr.velScale ?? 1 }, worldAt(ctx, par, k), G, worldAt(ctx, ob, k));
    }
  }
  return field ? blurGuides(field, G, s.guide_beta ?? 5) : null;
}

function stepDomain(ctx: SimContext, ob: ObjectData, m: FluidModifier, L: FluidLive, k: number) {
  const s = { ...defaultDomainSettings(), ...m.domain_settings };
  const g = L.grid;
  const n = g.nx * g.ny * g.nz;
  const f = fps(ctx.doc);
  const dtFrame = (s.time_scale || 0) / f;
  const flows = participants(ctx.doc, 'FLOW', m);
  const effectors = participants(ctx.doc, 'EFFECTOR', m);
  markObstacles(ctx, effectors, L.G, k, g.solid);
  if (s.delete_in_obstacle)
    for (let o = 0; o < n; o++) if (g.solid[o]) g.density[o] = g.fuel[o] = g.flame[o] = g.heat[o] = 0;
  // emitters (voxelized once per frame)
  const first = k - 1 === m.point_cache.frame_start;
  const emit = flows
    .filter((fl) => fl.m.flow_settings?.use_flow !== false && fl.m.flow_settings?.flow_type !== 'LIQUID')
    .filter((fl) => (fl.m.flow_settings?.flow_behavior ?? 'INFLOW') !== 'GEOMETRY' || first)
    .map((fl) => flowEmission(ctx, fl, k, L.G, true))
    .filter((x): x is FlowEmission => !!x);
  // colour of the smoke: average of the flows (fire-only flows make smoke of the fire's colour)
  let cr = 0,
    cg = 0,
    cb = 0,
    cw = 0;
  for (const e of emit) {
    const c = e.fs.flow_type === 'FIRE' ? (s.flame_smoke_color ?? [0.7, 0.7, 0.7]) : e.fs.smoke_color;
    if (e.fs.flow_type === 'FIRE' && !(s.flame_smoke > 0)) continue;
    cr += c[0];
    cg += c[1];
    cb += c[2];
    cw++;
  }
  if (cw) L.color = [cr / cw, cg / cw, cb / cw];
  if (emit.some((e) => e.fs.flow_type !== 'SMOKE')) L.fire = true;
  let vmax = 0;
  for (let o = 0; o < n; o++) vmax = Math.max(vmax, Math.abs(g.u[o]), Math.abs(g.v[o]), Math.abs(g.w[o]));
  const sub = timeSteps(s, vmax, dtFrame);
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
    flameIgnition: s.flame_ignition ?? 1.5,
    dissolve: s.use_dissolve_smoke ? f / Math.max(1, s.dissolve_speed) : 0,
    dissolveLinear: s.use_dissolve_smoke && s.use_dissolve_smoke_log === false,
    heatDecay: 0.5,
    pressureIterations: 30,
    closed: [s.use_collision_border_left, s.use_collision_border_right, s.use_collision_border_front, s.use_collision_border_back, s.use_collision_border_bottom, s.use_collision_border_top],
  };
  // force fields push the air: acceleration per cell (grid units), evaluated once per frame
  const fieldAcc = fieldAccelerations(ctx, L.G, k, s.effector_weights_all ?? 1, s.effector_weights_types ?? null, g.u, g.v, g.w);
  const guide = guideFieldFor(ctx, ob, m, L.G, k, fluidCacheKey(ob, m));
  for (let st = 0; st < sub; st++) {
    if (fieldAcc)
      for (let o = 0; o < n; o++) {
        g.u[o] += fieldAcc[o * 3] * dt;
        g.v[o] += fieldAcc[o * 3 + 1] * dt;
        g.w[o] += fieldAcc[o * 3 + 2] * dt;
      }
    for (const { fs, vx, coord } of emit) {
      const w = vx.w;
      const absolute = fs.use_absolute !== false;
      for (let o = 0; o < n; o++) {
        const a = w[o];
        if (a <= 0 || g.solid[o]) continue;
        if (fs.flow_behavior === 'OUTFLOW') {
          g.density[o] = g.fuel[o] = g.flame[o] = g.heat[o] = 0;
          continue;
        }
        if (fs.flow_type !== 'FIRE') g.density[o] = absolute ? Math.max(g.density[o], fs.density * a) : g.density[o] + fs.density * a * dt * f;
        if (fs.flow_type !== 'SMOKE') g.fuel[o] = absolute ? Math.max(g.fuel[o], fs.fuel_amount * a) : g.fuel[o] + fs.fuel_amount * a * dt * f;
        // small deterministic jitter breaks the symmetry of the plume (turbulent look)
        const jit = 0.75 + 0.5 * rand01(o, k, st, 77);
        g.heat[o] = Math.max(g.heat[o], fs.temperature * a * jit);
        if (fs.use_initial_velocity) {
          if (vx.vel) {
            g.u[o] = vx.vel[0] * fs.velocity_factor;
            g.v[o] = vx.vel[1] * fs.velocity_factor;
            g.w[o] = vx.vel[2] * fs.velocity_factor;
          }
          if (coord) {
            g.u[o] += coord[0];
            g.v[o] += coord[1];
            g.w[o] += coord[2];
          }
          if (vx.nx && fs.velocity_normal) {
            const nf = fs.velocity_normal * gmag;
            g.u[o] += vx.nx[o] * nf;
            g.v[o] += vx.ny![o] * nf;
            g.w[o] += vx.nz![o] * nf;
          }
          if (fs.velocity_random) {
            const rr = fs.velocity_random * gmag;
            g.u[o] += (rand01(o, k, st, 91) - 0.5) * rr;
            g.v[o] += (rand01(o, k, st, 92) - 0.5) * rr;
            g.w[o] += (rand01(o, k, st, 93) - 0.5) * rr;
          }
        }
      }
    }
    if (guide) applyGuides(g.u, g.v, g.w, guide, s.guide_alpha ?? 2, s.guide_vel_factor ?? 2, dt);
    if (s.use_adaptive_domain) {
      // adaptive domain: only the region holding gas (plus a margin) is simulated
      const box = activeBox(g, emit.map((e) => e.vx.w), Math.max(0, s.adapt_threshold ?? 0.002), Math.max(2, Math.round(s.adapt_margin ?? 4)));
      L.window = box;
      if (box) stepWindow(g, P, box);
    } else {
      L.window = null;
      stepGas(g, P);
    }
  }
  // smoke inside obstacles (moving effectors) is removed when asked
  if (s.delete_in_obstacle)
    for (let o = 0; o < n; o++) if (g.solid[o]) g.density[o] = g.fuel[o] = g.flame[o] = 0;
  if (s.clipping && s.clipping > 0) for (let o = 0; o < n; o++) if (g.density[o] < s.clipping) g.density[o] = 0;
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

/** Snapshot of the gas state stored per frame. */
function gasFrame(g: GasGrid): FluidFrame {
  const n = g.nx * g.ny * g.nz;
  const heat = new Uint8Array(n);
  for (let o = 0; o < n; o++) heat[o] = Math.min(255, Math.max(0, Math.round((g.heat[o] / 4) * 255)));
  const q = quantizeVelocity(g.u, g.v, g.w);
  return { data: quantize(g), heat, vel: q.vel, velScale: q.scale, solid: g.solid.slice() };
}

/** The cache frame shown at the context frame (after the cache offset), clamped to the cache range. */
export function fluidFrameAt(m: FluidModifier, graphFrame: number): number {
  const pc = m.point_cache;
  return Math.min(Math.max(graphFrame - Math.round(m.domain_settings?.cache_frame_offset ?? 0), pc.frame_start), pc.frame_end);
}

/** Bring the derived layers in line with the data cache (dropped when the data was re-simulated). */
export function syncLayers(key: string, hash: string) {
  const l = fluidLayers(key);
  if (l.hash !== hash) {
    freeFluidLayers(key);
    l.hash = hash;
  }
  return l;
}

export function evaluateDomain(ob: ObjectData, m: FluidModifier, mesh: EvalMesh, ctx: ModifierContext): { frame: FluidFrame; live: FluidLive; f: number } | null {
  const doc = ctx.doc;
  const pc = m.point_cache;
  const key = fluidCacheKey(ob, m);
  const cache = getCache<FluidFrame, FluidLive>(key) as FrameCache<FluidFrame, FluidLive>;
  cache.label = `${ob.name} ▸ ${m.name}`;
  cache.start = pc.frame_start;
  cache.end = pc.frame_end;
  cache.baked = pc.is_baked;
  const hash = domainHash(doc, ob, m, mesh);
  const usable = pc.is_baked && cache.frames.size > 0 && !!cache.live;
  if (!usable && cache.hash !== hash) cache.reset(hash);
  syncLayers(key, cache.hash);
  const f = fluidFrameAt(m, frameOf(ctx.graph));
  const sctx: SimContext = { doc, graph: ctx.graph };
  const replay = cacheType(m.domain_settings) === 'REPLAY';
  if (!cache.frames.has(f) && mayStepData(key, m) && !(pc.is_baked && !replay)) {
    if (!cache.live || cache.last < pc.frame_start) {
      const s = { ...defaultDomainSettings(), ...m.domain_settings };
      // adaptive domains can afford extra resolution (only the gas region is simulated)
      const res = s.resolution_max + (s.use_adaptive_domain ? Math.max(0, s.additional_res ?? 0) : 0);
      const { G, bmin, bmax } = gridFrame(sctx, ob, mesh, Math.min(256, Math.max(8, res)), pc.frame_start);
      cache.frames.clear();
      cache.live = { grid: newGrid(G.nx, G.ny, G.nz), G, bmin, bmax, color: [0.7, 0.7, 0.7], fire: false };
      cache.frames.set(pc.frame_start, gasFrame(cache.live.grid));
      cache.last = pc.frame_start;
    }
    while (cache.last < f) {
      if (cache.last > pc.frame_start && outOfTime()) break;
      const k = cache.last + 1;
      stepDomain(sctx, ob, m, cache.live!, k);
      cache.frames.set(k, { ...gasFrame(cache.live!.grid), window: cache.live!.window ?? null });
      cache.last = k;
    }
  }
  const frame = replay ? (cache.frames.get(f) ?? cache.nearest(f)) : cache.frames.get(f);
  return frame && cache.live ? { frame, live: cache.live, f } : null;
}

function fluidApply(mesh: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const m = mod as FluidModifier;
  const key = `${ctx.ob.id}:${m.id}`;
  if (m.fluid_type !== 'DOMAIN' || ctx.editMode) {
    if (!ctx.render) {
      smokeDraw.delete(key);
      fluidOverlays.delete(key);
      for (const k of [...particleDraw.keys()]) if (k.startsWith(`${key}:`)) particleDraw.delete(k);
    }
    return mesh;
  }
  if (m.domain_settings?.domain_type === 'LIQUID') {
    if (!ctx.render) smokeDraw.delete(key);
    const s = { ...defaultDomainSettings(), ...m.domain_settings };
    const lr = evaluateLiquid(ctx.ob, m, mesh, ctx);
    if (!ctx.render) {
      syncLiquidPoints(ctx.ob, m, lr, s);
      const pn = Math.max(1, Math.min(5, Math.round(s.particle_number ?? 2)));
      const cells = lr && (s.use_slice || s.use_color_ramp || s.show_velocity) ? liquidCells(lr.frame.particles, lr.frame.vel, lr.live.grid.nx, lr.live.grid.ny, lr.live.grid.nz, pn) : null;
      syncOverlay(ctx, m, key, s, lr && cells ? { nx: lr.live.grid.nx, ny: lr.live.grid.ny, nz: lr.live.grid.nz, bmin: lr.live.bmin, bmax: lr.live.bmax, G: lr.live.G, f: lr.f, color: [0.3, 0.6, 1], vel: cells.vel, velScale: cells.velScale, phi: cells.phi } : null);
    }
    if (!lr) return mesh;
    const ck = fluidCacheKey(ctx.ob, m);
    // the surface replaces the domain box; without a surface the box stays (shown as wire)
    const surf = s.use_mesh !== false ? liquidSurface(ck, lr, s) : null;
    return surf ?? mesh;
  }
  const r = evaluateDomain(ctx.ob, m, mesh, ctx);
  if (!ctx.render) {
    const s = { ...defaultDomainSettings(), ...m.domain_settings };
    if (r) {
      const fine = s.use_noise ? noiseFrameFor(ctx.ob, m, r.frame, r.live, r.f) : null;
      smokeDraw.set(key, {
        objectId: ctx.ob.id,
        nx: fine?.nx ?? r.live.grid.nx,
        ny: fine?.ny ?? r.live.grid.ny,
        nz: fine?.nz ?? r.live.grid.nz,
        data: fine?.data ?? r.frame.data,
        bmin: r.live.bmin,
        bmax: r.live.bmax,
        color: r.live.color,
        thickness: s.display_thickness ?? 1,
        fire: r.live.fire,
        interpolation: s.display_interpolation,
        slicePerVoxel: s.slice_per_voxel,
        frame: r.frame,
        coarse: [r.live.grid.nx, r.live.grid.ny, r.live.grid.nz],
        settings: s,
        window: s.use_adaptive_domain ? (r.frame.window ?? null) : null,
      });
    } else smokeDraw.delete(key);
    syncOverlay(ctx, m, key, s, r ? { nx: r.live.grid.nx, ny: r.live.grid.ny, nz: r.live.grid.nz, bmin: r.live.bmin, bmax: r.live.bmax, G: r.live.G, f: r.f, color: r.live.color, density: r.frame.data, heat: r.frame.heat, vel: r.frame.vel, velScale: r.frame.velScale } : null);
  }
  return mesh;
}

interface OverlaySource {
  nx: number;
  ny: number;
  nz: number;
  bmin: [number, number, number];
  bmax: [number, number, number];
  G: GridFrame;
  f: number;
  color: [number, number, number];
  density?: Uint8Array;
  heat?: Uint8Array;
  vel?: Int8Array;
  velScale?: number;
  phi?: Float32Array;
}

const forceMemo = new WeakMap<object, { key: string; force: Float32Array | null }>();

/** Slice / grid display / vector display data of a domain (only while one of them is on). */
function syncOverlay(ctx: ModifierContext, m: FluidModifier, key: string, s: FluidDomainSettings, src: OverlaySource | null) {
  if (!src || !(s.use_slice || s.use_color_ramp || s.show_velocity)) {
    fluidOverlays.delete(key);
    return;
  }
  let force: Float32Array | null = null;
  if (s.show_velocity && s.vector_field === 'FORCE') {
    const memoKey = `${src.f}:${fieldsKey(ctx.doc, src.f)}`;
    const hit = forceMemo.get(src.vel ?? src);
    if (hit && hit.key === memoKey) force = hit.force;
    else {
      const n = src.nx * src.ny * src.nz;
      const vs = (src.velScale ?? 0) / 127;
      const u = new Float32Array(n),
        v = new Float32Array(n),
        w = new Float32Array(n);
      if (src.vel)
        for (let o = 0; o < n; o++) {
          u[o] = src.vel[o * 3] * vs;
          v[o] = src.vel[o * 3 + 1] * vs;
          w[o] = src.vel[o * 3 + 2] * vs;
        }
      force = fieldAccelerations({ doc: ctx.doc, graph: ctx.graph }, src.G, src.f, s.effector_weights_all ?? 1, s.effector_weights_types ?? null, u, v, w);
      forceMemo.set(src.vel ?? src, { key: memoKey, force });
    }
  }
  const guide = s.show_velocity && s.vector_field === 'GUIDE_VELOCITY' ? (peekFluidLayers(fluidCacheKey(ctx.ob, m))?.guide.get(src.f) ?? (s.use_guide ? guideFieldFor({ doc: ctx.doc, graph: ctx.graph }, ctx.ob, m, src.G, src.f, '') : null)) : null;
  fluidOverlays.set(key, { objectId: ctx.ob.id, nx: src.nx, ny: src.ny, nz: src.nz, bmin: src.bmin, bmax: src.bmax, liquid: s.domain_type === 'LIQUID', density: src.density, heat: src.heat, vel: src.vel, velScale: src.velScale, guide, force, phi: src.phi, settings: s, color: src.color });
}

const liquidOverlayMemo = new WeakMap<Float32Array, { phi: Float32Array; vel: Int8Array; velScale: number }>();

/** Per cell particle density and mean velocity of a liquid frame (for the display options). */
function liquidCells(P: Float32Array, V: Float32Array | undefined, nx: number, ny: number, nz: number, pn: number) {
  const hit = liquidOverlayMemo.get(P);
  if (hit) return hit;
  const n = nx * ny * nz;
  const cnt = new Float32Array(n);
  const u = new Float32Array(n),
    v = new Float32Array(n),
    w = new Float32Array(n);
  for (let p = 0; p < P.length / 3; p++) {
    const i = Math.floor(P[p * 3]),
      j = Math.floor(P[p * 3 + 1]),
      k = Math.floor(P[p * 3 + 2]);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
    const o = i + j * nx + k * nx * ny;
    cnt[o]++;
    if (V) {
      u[o] += V[p * 3];
      v[o] += V[p * 3 + 1];
      w[o] += V[p * 3 + 2];
    }
  }
  const full = Math.max(1, pn * pn * pn);
  const phi = new Float32Array(n);
  for (let o = 0; o < n; o++) {
    if (cnt[o]) {
      u[o] /= cnt[o];
      v[o] /= cnt[o];
      w[o] /= cnt[o];
    }
    phi[o] = Math.min(1, cnt[o] / full);
  }
  const q = quantizeVelocity(u, v, w);
  const out = { phi, vel: q.vel, velScale: q.scale };
  liquidOverlayMemo.set(P, out);
  return out;
}

const POINT_COLORS: Record<string, [number, number, number]> = { flip: [0.25, 0.55, 1], spray: [0.95, 0.95, 1], foam: [0.8, 0.9, 0.95], bubbles: [0.55, 0.85, 1] };

/** Viewport points of the liquid particles (FLIP, spray, foam, bubbles), drawn by the particle overlay. */
function syncLiquidPoints(ob: ObjectData, m: FluidModifier, lr: { frame: import('./liquid').LiquidFrame; live: import('./liquid').LiquidLive; f: number } | null, s: FluidDomainSettings) {
  const base = `${ob.id}:${m.id}:`;
  const sets = lr ? liquidPointSets(fluidCacheKey(ob, m), lr, s) : [];
  const keep = new Set(sets.map((x) => base + x.kind));
  for (const k of [...particleDraw.keys()]) if (k.startsWith(base) && !keep.has(k)) particleDraw.delete(k);
  if (!lr) return;
  const cell = ((lr.live.bmax[0] - lr.live.bmin[0]) / lr.live.grid.nx + (lr.live.bmax[1] - lr.live.bmin[1]) / lr.live.grid.ny + (lr.live.bmax[2] - lr.live.bmin[2]) / lr.live.grid.nz) / 3;
  for (const { kind, points } of sets) {
    const size = kind === 'flip' ? cell * 0.5 * Math.max(0.1, s.particle_radius ?? 1) : cell * 0.25;
    const prev = particleDraw.get(base + kind);
    if (prev && prev.points === points) continue;
    particleDraw.set(base + kind, { objectId: ob.id, space: 'LOCAL', points, sizes: new Float32Array(points.length / 3).fill(size), lines: null, color: POINT_COLORS[kind], count: points.length / 3 });
  }
}

/** Noise (fine) smoke for a frame: baked noise, or computed now for Replay caches. */
function noiseFrameFor(ob: ObjectData, m: FluidModifier, frame: FluidFrame, live: FluidLive, f: number): NoiseFrame | null {
  const s = { ...defaultDomainSettings(), ...m.domain_settings };
  const key = fluidCacheKey(ob, m);
  const L = fluidLayers(key);
  const nk = noiseKey(s);
  const baked = layerBaked(s, 'noise');
  if (L.keys.noise !== nk && !baked) {
    L.noise.clear();
    L.keys.noise = nk;
  }
  const hit = L.noise.get(f);
  if (hit || cacheType(s) !== 'REPLAY') return hit ?? null;
  const fine = computeNoise(frame, live, s, f);
  L.noise.set(f, fine);
  return fine;
}

export function noiseKey(s: FluidDomainSettings): string {
  return [s.noise_scale, s.noise_strength, s.noise_pos_scale, s.noise_time_anim].join(',');
}

export function computeNoise(frame: FluidFrame, live: FluidLive, s: FluidDomainSettings, f: number): NoiseFrame {
  return upresGas(
    { nx: live.grid.nx, ny: live.grid.ny, nz: live.grid.nz, data: frame.data, vel: frame.vel, velScale: frame.velScale },
    { scale: s.noise_scale ?? 2, strength: s.noise_strength ?? 1, posScale: s.noise_pos_scale ?? 2, timeAnim: s.noise_time_anim ?? 0.1, frame: f },
  );
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
      effector_settings: defaultEffectorSettings(),
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
    const key = fluidCacheKey(c.ob, m);
    const cache = getCache<FluidFrame, FluidLive>(key);
    const f = fluidFrameAt(m, frameOf(c.graph as Depsgraph));
    const L = peekFluidLayers(key);
    const layers = L ? `${L.noise.has(f) ? 'n' : ''}${L.mesh.has(f) ? 'm' : ''}${L.particles.has(f) ? 'p' : ''}${L.noise.size}:${L.mesh.size}:${L.particles.size}` : '';
    const ds = m.domain_settings ?? {};
    const view = [ds.use_noise, ds.use_mesh, ds.use_flip_particles, ds.use_spray_particles, ds.use_foam_particles, ds.use_bubble_particles, ds.display_interpolation, ds.slice_per_voxel, ds.cache_type, ds.cache_frame_offset, ds.mesh_generator, ds.mesh_smoothen_pos, ds.mesh_smoothen_neg, ds.use_speed_vectors, ds.particle_scale, ds.display_thickness].join(',');
    return `${domainHash(c.doc, c.ob, m, null)}:${cache.frames.has(f) ? 'hit' : 'miss' + cache.last}:${cache.frames.size}:${layers}:${view}:${fluidJob()?.frame ?? ''}`;
  },
  apply: fluidApply,
});

fluidShared.fns = {
  participants,
  voxelize,
  markObstacles,
  flowEmission,
  timeSteps,
  guideFieldFor,
  gridFrame,
  domainHash,
  cacheKey: fluidCacheKey,
  fieldAccelerations,
  domainDefaults: defaultDomainSettings,
  flowDefaults: defaultFlowSettings,
  syncLayers,
  frameAt: fluidFrameAt,
  fps: () => {
    const d = physicsDoc();
    return d ? fps(d) : 24;
  },
  gravityCells: (G) => {
    const d = physicsDoc();
    const gw = d && d.scene.use_gravity ? new Vector3(...d.scene.gravity) : new Vector3(0, 0, 0);
    gw.applyMatrix4(G.toGrid.clone().setPosition(0, 0, 0));
    return [gw.x, gw.y, gw.z];
  },
};
