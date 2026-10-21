// Physics tab ▸ Fluid: domain, flow and effector panels (the fluid modifier's settings).
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, checkbox, enumMenu, opButton } from '../ui/widgets';
import { num, bool, enumProp, splitRow, colorProp, vecProp, objectProp } from '../ui/props';
import type { ObjectData, NodeData } from '../data/types';
import { textureRows } from '../editors/properties/modui/kit';
import { drawRamp } from '../nodes/editor/rampui';
import { defaultRamp } from '../nodes/curves';
import { caches } from './common';
import { changed, note, collectionRow, fieldWeightsPanel } from './ui-common';
import { defaultDomainSettings, defaultEffectorSettings, defaultFlowSettings, fluidCacheKey, type FluidDomainSettings, type FluidModifier } from './fluid';
import { anyBaked, cacheType, fluidJob, isBaking, layerBaked, peekFluidLayers, type FluidLayer } from './fluidcache';
import { domainLayers } from './fluidbake';
import { secondaryEnabled } from './liquid';

type Rec = Record<string, unknown>;

function fill<T extends object>(target: T, defaults: T): T {
  const t = target as Rec;
  for (const [k, v] of Object.entries(defaults)) if (t[k] === undefined) t[k] = v;
  return target;
}

function headerCheck(id: string, owner: Rec, key: string, label: string, disabled = false): Child {
  return checkbox(id, '', !!owner[key], (v) => {
    owner[key] = v;
    changed(`Toggle ${label}`);
  }, { disabled });
}

const row = (...c: Child[]) => h('div', { class: 'row-aligned', style: { padding: '2px 8px', gap: '2px' } }, c);

// ---------------------------------------------------------------------------
// Bake buttons for one layer (Modular caches)

const LAYER_OPS: Record<FluidLayer, [string, string, string]> = {
  data: ['fluid.bake_data', 'fluid.free_data', 'Data'],
  noise: ['fluid.bake_noise', 'fluid.free_noise', 'Noise'],
  mesh: ['fluid.bake_mesh', 'fluid.free_mesh', 'Mesh'],
  particles: ['fluid.bake_particles', 'fluid.free_particles', 'Particles'],
  guide: ['fluid.bake_guides', 'fluid.free_guides', 'Guides'],
};

function layerButtons(ob: ObjectData, m: FluidModifier, layer: FluidLayer): Child {
  const s = m.domain_settings;
  const [bake, free, label] = LAYER_OPS[layer];
  const j = fluidJob();
  if (j && j.objectId === ob.id && j.modifierId === m.id && j.layer === layer)
    return row(opButton('fluid.pause_bake', `Baking ${label}: frame ${Math.min(j.frame, j.end)} / ${j.end} — Pause`, {}, { icon: 'pause', className: 'wide' }));
  const paused = (s as unknown as Rec)[`cache_frame_pause_${layer}`] as number;
  const baked = (s as unknown as Rec)[`has_cache_baked_${layer}`] && !paused;
  if (paused)
    return row(
      s.cache_resumable ? opButton(bake, `Resume ${label}`, {}, { tip: `Continue the paused bake from frame ${paused + 1}` }) : null,
      opButton(free, `Free ${label}`),
    );
  return row(baked ? opButton(free, `Free ${label}`) : opButton(bake, `Bake ${label}`));
}

// ---------------------------------------------------------------------------
// Domain

function cacheStatus(ob: ObjectData, m: FluidModifier): string {
  const c = caches.get(fluidCacheKey(ob, m));
  const n = c?.frames.size ?? 0;
  const L = peekFluidLayers(fluidCacheKey(ob, m));
  const parts = [`${n} data frame${n === 1 ? '' : 's'}`];
  if (L?.noise.size) parts.push(`${L.noise.size} noise`);
  if (L?.mesh.size) parts.push(`${L.mesh.size} mesh`);
  if (L?.particles.size) parts.push(`${L.particles.size} particle`);
  if (L?.guide.size) parts.push(`${L.guide.size} guide`);
  return `${parts.join(', ')} in memory`;
}

const VECTOR_FIELDS: [string, string][] = [
  ['FLUID_VELOCITY', 'Fluid Velocity'],
  ['GUIDE_VELOCITY', 'Guide Velocity'],
  ['FORCE', 'Force'],
];

export function colorRampFields(liquid: boolean): [string, string][] {
  return liquid
    ? [
        ['PHI', 'Fluid Level Set'],
        ['VELOCITY_X', 'X Velocity'],
        ['VELOCITY_Y', 'Y Velocity'],
        ['VELOCITY_Z', 'Z Velocity'],
      ]
    : [
        ['DENSITY', 'Density'],
        ['HEAT', 'Heat'],
        ['FLAME', 'Flame'],
        ['VELOCITY_X', 'X Velocity'],
        ['VELOCITY_Y', 'Y Velocity'],
        ['VELOCITY_Z', 'Z Velocity'],
      ];
}

function rampWidget(s: FluidDomainSettings & Rec, key: string): Child {
  if (!s.color_ramp || typeof s.color_ramp !== 'object') {
    // black → white by default (transparent at zero)
    s.color_ramp = { ...defaultRamp(), color_ramp: [0, 0, 0, 0, 0, 1, 1, 1, 1, 1] };
  }
  const props = s.color_ramp as Rec;
  return h(
    'div',
    { class: 'fs-ramp', style: { padding: '2px 8px' } },
    drawRamp({
      node: { id: key, type: 'ShaderNodeValToRGB', props } as unknown as NodeData,
      tree: null as never,
      where: 'properties',
      key,
      changed: (label: string, final = true) => {
        s.color_ramp = { ...props };
        if (final) app.pushUndo(label);
        app.changed('doc');
      },
    }),
  );
}

function domainPanels(ob: ObjectData, m: FluidModifier): Child[] {
  const s = fill(m.domain_settings, defaultDomainSettings()) as FluidDomainSettings & Rec;
  const pc = m.point_cache;
  const type = cacheType(s);
  const modular = type === 'MODULAR';
  const baking = isBaking(ob, m);
  // settings that change the simulation are locked once something is baked (or while baking)
  const d = baking || (type === 'REPLAY' ? pc.is_baked : anyBaked(s));
  const gas = s.domain_type !== 'LIQUID';
  const liquid = !gas;
  const lockNoise = baking || layerBaked(s, 'noise');
  const lockMesh = baking || layerBaked(s, 'mesh');
  const lockParticles = baking || layerBaked(s, 'particles');
  const lockGuide = d || layerBaked(s, 'guide');
  const g = app.doc.scene.gravity as unknown as Rec;
  const out: Child[] = [];
  out.push(
    panel('ph-fl-settings', 'Settings', () => [
      d && !baking ? note('The domain is baked: free the bake to change its settings') : null,
      enumProp(s, 'domain_type', 'Domain Type', [['GAS', 'Gas'], ['LIQUID', 'Liquid']], {
        disabled: d,
        onChange: () => {
          // liquid stays inside the domain (closed borders) and shows its surface instead of a wire box
          const liq = s.domain_type === 'LIQUID';
          for (const k of ['front', 'back', 'right', 'left', 'top', 'bottom'] as const) s[`use_collision_border_${k}`] = liq;
          ob.display_type = liq ? 'TEXTURED' : 'WIRE';
        },
      }),
      num(s, 'resolution_max', 'Resolution Divisions', { int: true, min: 6, max: liquid ? 128 : 256, softMin: 8, disabled: d }),
      num(s, 'time_scale', 'Time Scale', { min: 0.0001, max: 10, disabled: d }),
      bool(s, 'use_adaptive_timesteps', 'Adaptive Time Steps', { disabled: d, tip: 'Take more solver steps per frame when the fluid moves fast' }),
      num(s, 'cfl_condition', 'CFL Number', { min: 0, max: 10, disabled: d || !s.use_adaptive_timesteps, tip: 'Cells the fluid may move in one step before another step is taken' }),
      num(s, 'timesteps_max', 'Timesteps Maximum', { int: true, min: 1, max: 100, disabled: d || !s.use_adaptive_timesteps }),
      num(s, 'timesteps_min', 'Minimum', { int: true, min: 1, max: 100, disabled: d }),
      num(g as never, '0' as never, 'Scene Gravity X', { unit: 'none', disabled: true, tip: 'Gravity comes from the scene settings' }),
      num(g as never, '1' as never, 'Y', { unit: 'none', disabled: true }),
      num(g as never, '2' as never, 'Z', { unit: 'none', disabled: true }),
      gas ? num(s, 'clipping', 'Empty Space', { min: 0, max: 1, precision: 6, disabled: d, tip: 'Density below this value counts as empty and is removed' }) : null,
      bool(s, 'delete_in_obstacle', 'Delete in Obstacle', { disabled: d, tip: 'Remove fluid that ends up inside moving obstacles' }),
      modular && s.use_guide && (s.guide_source ?? 'DOMAIN') === 'EFFECTOR' && !layerBaked(s, 'guide') ? note('Unbaked guides are computed while baking the data (bake them first to reuse them)') : null,
      modular ? layerButtons(ob, m, 'data') : null,
      panel('ph-fl-border', 'Border Collisions', () => (['front', 'back', 'right', 'left', 'top', 'bottom'] as const).map((k) => bool(s, `use_collision_border_${k}`, k[0].toUpperCase() + k.slice(1), { disabled: d })), { sub: true, closed: true }),
    ], { sub: true }),
  );
  if (gas)
    out.push(
      panel('ph-fl-gas', 'Gas', () => [
        num(s, 'alpha', 'Buoyancy Density', { min: -5, max: 5, disabled: d, tip: 'Denser smoke sinks (negative values make it rise)' }),
        num(s, 'beta', 'Heat', { min: -5, max: 5, disabled: d, tip: 'Hot smoke rises' }),
        num(s, 'vorticity', 'Vorticity', { min: 0, max: 4, disabled: d }),
        panel('ph-fl-fire', 'Fire', () => [
          num(s, 'burning_rate', 'Reaction Speed', { min: 0.01, max: 4, softMax: 2, disabled: d }),
          num(s, 'flame_smoke', 'Flame Smoke', { min: 0, max: 8, softMax: 4, disabled: d }),
          num(s, 'flame_vorticity', 'Vorticity', { min: 0, max: 2, softMax: 1, disabled: d }),
          num(s, 'flame_max_temp', 'Temperature Maximum', { min: 1, max: 10, softMax: 5, disabled: d }),
          num(s, 'flame_ignition', 'Minimum', { min: 0.5, max: 5, softMax: 2.5, disabled: d, tip: 'Temperature of the coolest burning fuel' }),
          colorProp(s, 'flame_smoke_color', 'Smoke Color', { disabled: d }),
        ], { sub: true, closed: true }),
        panel('ph-fl-noise', 'Noise', () => [
          num(s, 'noise_scale', 'Upres Factor', { int: true, min: 1, max: 8, disabled: lockNoise || !s.use_noise, tip: 'Finer cells per simulation cell along each axis' }),
          num(s, 'noise_strength', 'Strength', { min: 0, max: 10, disabled: lockNoise || !s.use_noise }),
          num(s, 'noise_pos_scale', 'Scale', { min: 0.0001, max: 10, disabled: lockNoise || !s.use_noise, tip: 'Size of the noise features (larger: finer)' }),
          num(s, 'noise_time_anim', 'Time', { min: 0.0001, max: 10, disabled: lockNoise || !s.use_noise, tip: 'How fast the noise pattern changes' }),
          modular && s.use_noise ? layerButtons(ob, m, 'noise') : null,
        ], { sub: true, closed: true, header: headerCheck(`fl-noise-${m.id}`, s, 'use_noise', 'Noise', lockNoise) }),
        panel('ph-fl-dissolve', 'Dissolve', () => [
          num(s, 'dissolve_speed', 'Time', { int: true, min: 1, max: 10000, disabled: d || !s.use_dissolve_smoke, tip: 'Frames the smoke takes to dissolve' }),
          bool(s, 'use_dissolve_smoke_log', 'Slow', { disabled: d || !s.use_dissolve_smoke, tip: 'Dissolve gradually (a share of the density per frame) instead of at a constant rate' }),
        ], { sub: true, closed: true, header: headerCheck(`fl-dis-${m.id}`, s, 'use_dissolve_smoke', 'Dissolve', d) }),
      ], { sub: true }),
    );
  else
    out.push(
      panel('ph-fl-liquid', 'Liquid', () => [
        enumProp(s, 'simulation_method', 'Simulation Method', [['FLIP', 'FLIP'], ['APIC', 'APIC']], { disabled: d, tip: 'FLIP keeps the motion lively; APIC keeps rotation with less noise' }),
        s.simulation_method !== 'APIC' ? num(s, 'flip_ratio', 'FLIP Ratio', { min: 0, max: 1, slider: true, disabled: d, tip: '1 keeps the motion lively (FLIP), 0 smooths it (PIC)' }) : null,
        num(s, 'sys_particle_maximum', 'System Maximum', { int: true, min: 0, disabled: d, tip: 'Most particles the liquid may hold (0: no limit)' }),
        num(s, 'particle_radius', 'Particle Radius', { min: 0.1, max: 10, disabled: d, tip: 'Size of the displayed liquid particles in cells' }),
        num(s, 'particle_number', 'Sampling', { int: true, min: 1, max: 5, disabled: d, tip: 'Particles along each axis of an emitting cell' }),
        num(s, 'particle_randomness', 'Randomness', { min: 0, max: 1, slider: true, disabled: d }),
        num(s, 'particle_max', 'Particles Maximum', { int: true, min: 0, max: 1000, disabled: d, tip: 'Cells with more particles push them to emptier neighbours (0: off)' }),
        num(s, 'particle_min', 'Minimum', { int: true, min: 0, max: 1000, disabled: d, tip: 'Holes inside the liquid are refilled with this many particles (0: off)' }),
        panel('ph-fl-diff', 'Diffusion', () => [
          num(s, 'viscosity_base', 'Base', { min: 0, max: 10, disabled: d || !s.use_diffusion, tip: 'Viscosity = base × 10^-exponent (m²/s)' }),
          num(s, 'viscosity_exponent', 'Exponent', { int: true, min: 0, max: 10, disabled: d || !s.use_diffusion }),
          panel('ph-fl-visc', 'High Viscosity Solver', () => [num(s, 'viscosity_value', 'Strength', { min: 0, max: 10, softMax: 5, disabled: d || !s.use_diffusion || !s.use_viscosity, tip: 'Thick liquids such as honey' })], {
            sub: true,
            closed: true,
            header: headerCheck(`fl-visc-${m.id}`, s, 'use_viscosity', 'High Viscosity Solver', d || !s.use_diffusion),
          }),
        ], { sub: true, closed: true, header: headerCheck(`fl-diff-${m.id}`, s, 'use_diffusion', 'Diffusion', d) }),
        panel('ph-fl-mesh', 'Mesh', () => [
          num(s, 'mesh_scale', 'Upres Factor', { int: true, min: 1, max: 6, disabled: lockMesh || !s.use_mesh, tip: 'Finer surface cells per simulation cell' }),
          num(s, 'mesh_particle_radius', 'Particle Radius', { min: 0.5, max: 10, disabled: lockMesh || !s.use_mesh, tip: 'Radius of every particle in cells when building the surface' }),
          enumProp(s, 'mesh_generator', 'Mesh Generator', [['IMPROVED', 'Final'], ['UNION', 'Preview']], { disabled: lockMesh || !s.use_mesh }),
          s.mesh_generator !== 'UNION' ? num(s, 'mesh_smoothen_pos', 'Smoothing Positive', { int: true, min: 0, max: 100, softMax: 10, disabled: lockMesh || !s.use_mesh, tip: 'Smoothing steps that flatten bumps' }) : null,
          s.mesh_generator !== 'UNION' ? num(s, 'mesh_smoothen_neg', 'Negative', { int: true, min: 0, max: 100, softMax: 10, disabled: lockMesh || !s.use_mesh, tip: 'Smoothing steps that fill dents' }) : null,
          modular && s.use_mesh ? layerButtons(ob, m, 'mesh') : null,
        ], { sub: true, header: headerCheck(`fl-mesh-${m.id}`, s, 'use_mesh', 'Mesh', lockMesh) }),
        panel('ph-fl-particles', 'Particles', () => {
          const off = lockParticles || !secondaryEnabled(s);
          const toggle = (key: string, label: string) => h('button', { key, class: { tbtn: true, on: !!s[key] }, disabled: lockParticles, style: { flex: '1' }, onclick: () => ((s[key] = !s[key]), changed(`Toggle ${label}`)) }, label);
          return [
            h('div', { class: 'row-aligned', style: { padding: '2px 8px', gap: '2px' } }, toggle('use_spray_particles', 'Spray'), toggle('use_foam_particles', 'Foam'), toggle('use_bubble_particles', 'Bubbles')),
            num(s, 'particle_scale', 'Upres Factor', { int: true, min: 1, max: 10, disabled: off, tip: 'Multiplies the number of particles created' }),
            num(s, 'sndparticle_potential_max_wavecrest', 'Wave Crest Potential Maximum', { min: 0, max: 1000, disabled: off }),
            num(s, 'sndparticle_potential_min_wavecrest', 'Minimum', { min: 0, max: 1000, disabled: off }),
            num(s, 'sndparticle_potential_max_trappedair', 'Trapped Air Potential Maximum', { min: 0, max: 1000, disabled: off }),
            num(s, 'sndparticle_potential_min_trappedair', 'Minimum', { min: 0, max: 1000, disabled: off }),
            num(s, 'sndparticle_potential_max_energy', 'Kinetic Energy Potential Maximum', { min: 0, max: 1000, disabled: off }),
            num(s, 'sndparticle_potential_min_energy', 'Minimum', { min: 0, max: 1000, disabled: off }),
            num(s, 'sndparticle_potential_radius', 'Potential Radius', { int: true, min: 1, max: 4, disabled: off }),
            num(s, 'sndparticle_update_radius', 'Particle Update Radius', { int: true, min: 1, max: 4, disabled: off }),
            num(s, 'sndparticle_sampling_wavecrest', 'Wave Crest Particle Sampling', { int: true, min: 0, max: 10000, disabled: off }),
            num(s, 'sndparticle_sampling_trappedair', 'Trapped Air Particle Sampling', { int: true, min: 0, max: 10000, disabled: off }),
            num(s, 'sndparticle_life_max', 'Particle Life Maximum', { min: 0, max: 10000, disabled: off, tip: 'Frames a foam particle lives at most' }),
            num(s, 'sndparticle_life_min', 'Minimum', { min: 0, max: 10000, disabled: off }),
            num(s, 'sndparticle_bubble_buoyancy', 'Bubble Buoyancy', { min: 0, max: 100, disabled: off }),
            num(s, 'sndparticle_bubble_drag', 'Bubble Drag', { min: 0, max: 100, disabled: off }),
            enumProp(s, 'sndparticle_boundary', 'Particles in Boundary', [['DELETE', 'Delete'], ['PUSHOUT', 'Push Out']], { disabled: off }),
            modular && secondaryEnabled(s) ? layerButtons(ob, m, 'particles') : null,
          ];
        }, { sub: true, closed: true }),
      ], { sub: true, header: headerCheck(`fl-flip-${m.id}`, s, 'use_flip_particles', 'Show Liquid Particles') }),
    );
  out.push(
    panel('ph-fl-guides', 'Guides', () => [
      num(s, 'guide_alpha', 'Weight', { min: 1, max: 100, disabled: lockGuide || !s.use_guide, tip: 'How strongly the flow follows its guides' }),
      num(s, 'guide_beta', 'Size', { int: true, min: 1, max: 50, disabled: lockGuide || !s.use_guide, tip: 'Cells the guiding spreads over' }),
      num(s, 'guide_vel_factor', 'Velocity Factor', { min: 0, max: 100, disabled: lockGuide || !s.use_guide }),
      enumProp(s, 'guide_source', 'Velocity Source', [['DOMAIN', 'Domain'], ['EFFECTOR', 'Effector']], { disabled: lockGuide || !s.use_guide }),
      (s.guide_source ?? 'DOMAIN') === 'DOMAIN' ? objectProp(s, 'guide_parent', 'Guide Parent', { filter: (o) => o.id !== ob.id && !!o.modifiers.some((x) => x.type === 'FLUID' && (x as FluidModifier).fluid_type === 'DOMAIN'), disabled: lockGuide || !s.use_guide }) : null,
      modular && s.use_guide && (s.guide_source ?? 'DOMAIN') === 'EFFECTOR' ? layerButtons(ob, m, 'guide') : null,
    ], { sub: true, closed: true, header: headerCheck(`fl-guide-${m.id}`, s, 'use_guide', 'Guides', lockGuide) }),
    panel('ph-fl-colls', 'Collections', () => [
      collectionRow(`fl-fgrp-${m.id}`, s, 'fluid_group', 'Flow', 'All flows', d),
      collectionRow(`fl-egrp-${m.id}`, s, 'effector_group', 'Effector', 'All effectors', d),
    ], { sub: true, closed: true }),
    panel('ph-fl-cache', 'Cache', () => [
      num(pc, 'frame_start', 'Frame Start', { int: true, disabled: d }),
      num(pc, 'frame_end', 'End', { int: true, min: pc.frame_start, disabled: d }),
      num(s, 'cache_frame_offset', 'Offset', { int: true, min: -1048574, max: 1048574, tip: 'Shift the cached frames along the timeline' }),
      enumProp(s, 'cache_type', 'Type', [['REPLAY', 'Replay'], ['MODULAR', 'Modular'], ['ALL', 'All']], { disabled: baking || anyBaked(s), tip: 'Replay simulates while playing; Modular bakes data, noise, mesh and particles separately; All bakes everything at once' }),
      type !== 'REPLAY' ? bool(s, 'cache_resumable', 'Resumable', { disabled: baking, tip: 'A paused bake can be continued later' }) : null,
      h('div', { class: 'prop-note' }, cacheStatus(ob, m)),
      type === 'ALL'
        ? (() => {
            const j = fluidJob();
            if (j && j.objectId === ob.id && j.modifierId === m.id) return row(opButton('fluid.pause_bake', `Baking ${j.layer}: frame ${Math.min(j.frame, j.end)} / ${j.end} — Pause`, {}, { icon: 'pause' }));
            const paused = s.cache_frame_pause_data || s.cache_frame_pause_noise || s.cache_frame_pause_mesh || s.cache_frame_pause_particles;
            return row(
              !anyBaked(s) ? opButton('fluid.bake_all', 'Bake All', {}, { tip: `Bake ${domainLayers(m).join(', ')}` }) : paused && s.cache_resumable ? opButton('fluid.bake_all', 'Resume') : null,
              anyBaked(s) ? opButton('fluid.free_all', 'Free All') : null,
            );
          })()
        : type === 'REPLAY'
          ? row(opButton('ptcache.free', 'Free Cache', { cache: fluidCacheKey(ob, m) }, { tip: 'Forget the simulated frames so they are computed again' }))
          : null,
    ], { sub: true, closed: true }),
    fieldWeightsPanel('ph-fl-fw', s as never, d, true),
    panel('ph-fl-display', 'Viewport Display', () => [
      gas ? num(s, 'display_thickness', 'Thickness', { min: 0.001, max: 1000, softMin: 0.1, softMax: 100 }) : null,
      enumProp(s, 'display_interpolation', 'Interpolation', [['LINEAR', 'Linear'], ['CUBIC', 'Cubic'], ['CLOSEST', 'Closest']]),
      gas ? num(s, 'slice_per_voxel', 'Slice Per Voxel', { min: 0, max: 100, softMax: 5, disabled: !!s.use_slice, tip: 'Samples per cell when drawing the volume' }) : null,
      panel('ph-fl-slice', 'Slice', () => [
        enumProp(s, 'slice_axis', 'Axis', [['AUTO', 'Auto'], ['X', 'X'], ['Y', 'Y'], ['Z', 'Z']], { disabled: !s.use_slice }),
        num(s, 'slice_depth', 'Position', { min: 0, max: 1, slider: true, disabled: !s.use_slice }),
        bool(s, 'show_gridlines', 'Gridlines', { disabled: !s.use_slice }),
      ], { sub: true, closed: true, header: headerCheck(`fl-slice-${m.id}`, s, 'use_slice', 'Slice') }),
      panel('ph-fl-grid', 'Grid Display', () => [
        enumProp(s, 'color_ramp_field', 'Field', colorRampFields(liquid), { disabled: !s.use_color_ramp }),
        num(s, 'color_ramp_field_scale', 'Scale', { min: 0.001, max: 100000, softMax: 1000, disabled: !s.use_color_ramp, tip: 'Field values are multiplied by this before the color ramp' }),
        s.use_color_ramp ? rampWidget(s, `fl-ramp-${m.id}`) : null,
      ], { sub: true, closed: true, header: headerCheck(`fl-cr-${m.id}`, s, 'use_color_ramp', 'Grid Display') }),
      panel('ph-fl-vec', 'Vector Display', () => [
        enumProp(s, 'vector_display_type', 'Display As', [['NEEDLE', 'Needle'], ['STREAMLINE', 'Streamlines'], ['MAC', 'MAC Grid']], { disabled: !s.show_velocity }),
        s.vector_display_type === 'MAC'
          ? h('div', { class: 'row-aligned', style: { padding: '2px 8px', gap: '2px' } }, (['x', 'y', 'z'] as const).map((a) => h('button', { key: a, class: { tbtn: true, on: !!s[`vector_show_mac_${a}`] }, disabled: !s.show_velocity, style: { flex: '1' }, onclick: () => ((s[`vector_show_mac_${a}`] = !s[`vector_show_mac_${a}`]), changed('Toggle MAC Component')) }, a.toUpperCase())))
          : null,
        bool(s, 'vector_scale_with_magnitude', 'Magnitude', { disabled: !s.show_velocity, tip: 'Longer vectors for faster flow' }),
        enumProp(s, 'vector_field', 'Field', VECTOR_FIELDS, { disabled: !s.show_velocity }),
        num(s, 'vector_scale', 'Scale', { min: 0, max: 1000, softMax: 100, disabled: !s.show_velocity }),
      ], { sub: true, closed: true, header: headerCheck(`fl-vec-${m.id}`, s, 'show_velocity', 'Vector Display') }),
    ], { sub: true, closed: true }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Flow / effector

function flowPanels(ob: ObjectData, m: FluidModifier): Child[] {
  const s = fill(m.flow_settings, defaultFlowSettings()) as typeof m.flow_settings & Rec;
  const liquid = s.flow_type === 'LIQUID';
  const smoke = s.flow_type === 'SMOKE' || s.flow_type === 'BOTH';
  const fire = s.flow_type === 'FIRE' || s.flow_type === 'BOTH';
  const me = ob.data ? app.doc.meshes[ob.data] : undefined;
  const psys = ob.particle_systems.map((p) => ({ value: p.name, label: p.name, icon: 'particles' }));
  return [
    panel('ph-fl-flow', 'Settings', () => [
      enumProp(s, 'flow_type', 'Flow Type', [['SMOKE', 'Smoke'], ['BOTH', 'Fire + Smoke'], ['FIRE', 'Fire'], ['LIQUID', 'Liquid']]),
      enumProp(s, 'flow_behavior', 'Flow Behavior', [['INFLOW', 'Inflow'], ['OUTFLOW', 'Outflow'], ['GEOMETRY', 'Geometry']]),
      s.flow_behavior !== 'GEOMETRY' ? bool(s, 'use_flow', 'Use Flow', { tip: 'Emit (or remove) fluid now; animate it to start and stop the flow' }) : null,
      num(s, 'subframes', 'Sampling Substeps', { int: true, min: 0, max: 200, softMax: 10, tip: 'Extra emission samples between frames for fast moving flows' }),
      smoke ? colorProp(s, 'smoke_color', 'Smoke Color') : null,
      !liquid ? bool(s, 'use_absolute', 'Absolute Density', { tip: 'Set the density of emitting cells instead of adding to it' }) : null,
      !liquid ? num(s, 'temperature', 'Initial Temperature', { min: -10, max: 10 }) : null,
      smoke ? num(s, 'density', 'Density', { min: 0, max: 10, softMax: 1, slider: true }) : null,
      fire ? num(s, 'fuel_amount', 'Fuel', { min: 0, max: 10, softMax: 5 }) : null,
      !liquid && s.flow_source !== 'PARTICLES'
        ? splitRow('Vertex Group', enumMenu(`fl-vg-${m.id}`, [{ value: '', label: '—' }, ...(me?.vertex_groups ?? []).map((g) => ({ value: g.name, label: g.name, icon: 'group_vertex' }))], s.density_vertex_group ?? '', (v) => ((s.density_vertex_group = v), changed('Set Vertex Group'))))
        : null,
    ], { sub: true }),
    panel('ph-fl-vel', 'Initial Velocity', () => [
      num(s, 'velocity_factor', 'Source', { min: -100, max: 100, softMin: -2, softMax: 2, disabled: !s.use_initial_velocity, tip: 'Multiplier of the flow object velocity' }),
      s.flow_source !== 'PARTICLES' ? num(s, 'velocity_normal', 'Normal', { min: -100, max: 100, softMin: -2, softMax: 2, disabled: !s.use_initial_velocity }) : null,
      num(s, 'velocity_random', 'Random', { min: 0, max: 10, softMax: 2, disabled: !s.use_initial_velocity }),
      vecProp(s, 'velocity_coord', 'Initial', { names: ['X', 'Y', 'Z'], disabled: !s.use_initial_velocity, unit: 'none' }),
    ], { sub: true, header: headerCheck(`fl-iv-${m.id}`, s, 'use_initial_velocity', 'Initial Velocity'), closed: true }),
    panel('ph-fl-source', 'Flow Source', () => [
      enumProp(s, 'flow_source', 'Flow Source', [['MESH', 'Mesh'], ['PARTICLES', 'Particle System']]),
      s.flow_source === 'PARTICLES'
        ? [
            psys.length ? splitRow('Particle System', enumMenu(`fl-ps-${m.id}`, psys, s.particle_system ?? psys[0].value, (v) => ((s.particle_system = v), changed('Set Particle System')))) : note('The object has no particle system', 'error'),
            bool(s, 'use_particle_size', 'Set Size', { tip: 'Use the size below (in cells) instead of the particle size' }),
            num(s, 'particle_size', 'Size', { min: 0.1, softMax: 5, disabled: !s.use_particle_size }),
          ]
        : [
            bool(s, 'use_plane_init', 'Is Planar', { tip: 'Treat the mesh as an open surface without inside' }),
            num(s, 'surface_distance', 'Surface Emission', { min: 0, max: 10, tip: 'Emission distance from the mesh surface (in cells)' }),
            !liquid && !s.use_plane_init ? num(s, 'volume_density', 'Volume Emission', { min: 0, max: 1, slider: true }) : null,
          ],
    ], { sub: true }),
    !liquid
      ? panel('ph-fl-tex', 'Texture', () => [
          ...textureRows(s as never, 'noise_texture'),
          enumProp(s, 'texture_map_type', 'Mapping', [['AUTO', 'Generated'], ['UV', 'UV']], { disabled: !s.use_texture }),
          num(s, 'texture_size', 'Size', { min: 0.01, max: 10, disabled: !s.use_texture }),
          num(s, 'texture_offset', 'Offset', { min: 0, max: 200, disabled: !s.use_texture, tip: 'Moves the texture along Z (animate it to make the emission flicker)' }),
        ], { sub: true, header: headerCheck(`fl-tex-${m.id}`, s, 'use_texture', 'Texture'), closed: true })
      : null,
  ];
}

function effectorPanels(m: FluidModifier): Child[] {
  const s = fill(m.effector_settings, defaultEffectorSettings()) as typeof m.effector_settings & Rec;
  const guide = s.effector_type === 'GUIDE';
  return [
    panel('ph-fl-eff', 'Settings', () => [
      enumProp(s, 'effector_type', 'Effector Type', [['COLLISION', 'Collision'], ['GUIDE', 'Guide']]),
      num(s, 'subframes', 'Sampling Substeps', { int: true, min: 0, max: 200, softMax: 10, tip: 'Extra samples between frames for fast moving effectors' }),
      num(s, 'surface_distance', 'Surface Thickness', { min: 0, max: 10, tip: 'Extra thickness around the surface (in cells)' }),
      bool(s, 'use_effector', 'Use Effector'),
      bool(s, 'use_plane_init', 'Is Planar', { tip: 'Treat the mesh as an open surface without inside' }),
      guide ? num(s, 'velocity_factor', 'Velocity Factor', { min: -100, max: 100, tip: 'Multiplier of the guide object velocity' }) : null,
      guide ? enumProp(s, 'guide_mode', 'Guide Mode', [['MAXIMUM', 'Maximize'], ['MINIMUM', 'Minimize'], ['OVERRIDE', 'Override'], ['AVERAGED', 'Averaged']], { tip: 'How the velocities of overlapping guides combine' }) : null,
    ], { sub: true }),
  ];
}

/** Fluid panels of the Physics tab (the Type selector plus the type's sub panels). */
export function fluidPanels(ob: ObjectData, m: FluidModifier): Child[] {
  const baking = isBaking(ob, m);
  return [
    panel('ph-fluid', 'Fluid', () => [
      splitRow(
        'Type',
        enumMenu(`fluid-type-${m.id}`, [{ value: 'NONE', label: 'None' }, { value: 'DOMAIN', label: 'Domain' }, { value: 'FLOW', label: 'Flow' }, { value: 'EFFECTOR', label: 'Effector' }], m.fluid_type, (v) => {
          m.fluid_type = v as FluidModifier['fluid_type'];
          // the domain box is shown as a wireframe so the smoke inside stays visible
          if (v === 'DOMAIN') ob.display_type = m.domain_settings?.domain_type === 'LIQUID' ? 'TEXTURED' : 'WIRE';
          else if (ob.display_type === 'WIRE') ob.display_type = 'TEXTURED';
          changed('Fluid Type');
        }, { disabled: baking || (m.fluid_type === 'DOMAIN' && anyBaked(m.domain_settings ?? {})) }),
      ),
      m.fluid_type === 'DOMAIN' ? domainPanels(ob, m) : m.fluid_type === 'FLOW' ? flowPanels(ob, m) : m.fluid_type === 'EFFECTOR' ? effectorPanels(m) : null,
    ]),
  ];
}

