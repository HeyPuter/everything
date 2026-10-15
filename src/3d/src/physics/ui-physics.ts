// Physics properties tab: enable buttons and panels for Force Field, Collision,
// Cloth, Soft Body, Rigid Body and Rigid Body Constraint.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, checkbox, button, enumMenu } from '../ui/widgets';
import { num, bool, enumProp, splitRow, colorProp } from '../ui/props';
import { defaultDomainSettings, defaultFlowSettings, fluidCacheKey, type FluidModifier } from './fluid';
import { icon } from '../ui/icons';
import { modifierExtraUI } from '../editors/properties/stack';
import type { ModifierBase, ObjectData } from '../data/types';
import { insertTabAfter, changed, note, subHeading, vgroupRow, objectRow, cachePanel, fieldWeightsPanel } from './ui-common';
import { meshSimKey } from './meshsim';
import { RB_CACHE, rapierLoaded } from './rigidbody';
import { RBC_TYPES } from './rbjoints';
import { rbcTypePanels } from './ui-rbc';
import {
  defaultClothCollision,
  defaultClothSettings,
  defaultCollision,
  defaultField,
  defaultSoftBodySettings,
  FIELD_TYPES,
  type ClothModifier,
  type CollisionSettingsX,
  type ForceFieldX,
  type ObjectPhysics,
  type RigidBodyWorldX,
  type RigidBodyX,
  type SoftBodyModifier,
} from './types';

/** Add settings missing from older files in place (keeps object identity for widgets). */
function fillDefaults<T extends object>(target: T, defaults: T): T {
  const t = target as Record<string, unknown>;
  for (const [k, v] of Object.entries(defaults)) if (t[k] === undefined) t[k] = v;
  return target;
}

const isGeom = (o: ObjectData) => o.type === 'MESH';
const isCollider = (o: ObjectData) => o.type === 'MESH' || o.type === 'CURVE' || o.type === 'FONT';
const clothOf = (o: ObjectData) => o.modifiers.find((m) => m.type === 'CLOTH') as ClothModifier | undefined;
const softOf = (o: ObjectData) => o.modifiers.find((m) => m.type === 'SOFT_BODY') as SoftBodyModifier | undefined;

function headerCheck(id: string, owner: Record<string, unknown>, key: string, label: string, disabled = false): Child {
  return checkbox(id, '', !!owner[key], (v) => {
    owner[key] = v;
    changed(`Toggle ${label}`);
  }, { disabled });
}

function toggleButton(label: string, ic: string, on: boolean, add: () => void, remove: () => void): Child {
  return h(
    'button',
    { key: `phys-${label}`, class: { btn: true, 'phys-toggle': true, on }, 'data-tip': on ? `Remove ${label}` : `Enable ${label}`, onclick: () => (on ? remove() : add()), style: { justifyContent: 'flex-start', gap: '6px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: '0' } },
    icon(on ? 'x' : ic),
    label,
  );
}

function enableGrid(ob: ObjectPhysics): Child {
  const btns: Child[] = [];
  btns.push(toggleButton('Force Field', 'force_force', !!ob.field && ob.field.type !== 'NONE', () => app.run('object.forcefield_toggle'), () => app.run('object.forcefield_toggle')));
  if (isCollider(ob)) btns.push(toggleButton('Collision', 'mod_physics', !!ob.collision?.use, () => app.run('object.collision_toggle'), () => app.run('object.collision_toggle')));
  if (isGeom(ob)) {
    const cl = clothOf(ob),
      sb = softOf(ob);
    btns.push(toggleButton('Cloth', 'mod_cloth', !!cl, () => app.run('object.modifier_add', { type: 'CLOTH' }), () => app.run('object.modifier_remove', { modifier: cl!.id })));
    btns.push(toggleButton('Soft Body', 'mod_soft', !!sb, () => app.run('object.modifier_add', { type: 'SOFT_BODY' }), () => app.run('object.modifier_remove', { modifier: sb!.id })));
    const fl = fluidOf(ob);
    btns.push(toggleButton('Fluid', 'mod_fluid', !!fl, () => app.run('object.modifier_add', { type: 'FLUID' }), () => app.run('object.modifier_remove', { modifier: fl!.id })));
    btns.push(toggleButton('Rigid Body', 'physics', !!ob.rigid_body, () => app.run('rigidbody.object_add', { type: 'ACTIVE' }), () => app.run('rigidbody.object_remove')));
  }
  btns.push(toggleButton('Rigid Body Constraint', 'constraint', !!ob.rigid_body_constraint, () => app.run('rigidbody.constraint_add', { type: 'FIXED' }), () => app.run('rigidbody.constraint_remove')));
  return h('div', { class: 'phys-enable' }, h('div', { class: 'sub-label' }, 'Enable physics for:'), h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '2px', padding: '2px 8px 8px' } }, btns));
}

// ---------------------------------------------------------------------------
// Force field

const SHAPES_ALL: [string, string][] = [
  ['POINT', 'Point'],
  ['LINE', 'Line'],
  ['PLANE', 'Plane'],
  ['SURFACE', 'Surface'],
  ['POINTS', 'Every Point'],
];

function fieldPanels(ob: ObjectPhysics): Child[] {
  const f = fillDefaults(ob.field as ForceFieldX, defaultField(ob.field!.type));
  const t = f.type;
  // surface shapes need mesh geometry on the field object
  const shapes = ob.type === 'MESH' ? SHAPES_ALL : SHAPES_ALL.slice(0, 3);
  const noiseSeed = [num(f, 'noise', 'Noise Amount', { min: 0, max: 10 }), num(f, 'seed', 'Seed', { int: true, min: 1, max: 128 })];
  let settings: Child[];
  if (t === 'DRAG') settings = [num(f, 'strength', 'Linear', { min: 0, max: 1000, softMax: 2 }), num(f, 'flow', 'Quadratic', { min: 0, max: 1000, softMax: 2 })];
  else if (t === 'GUIDE')
    settings = [
      num(f, 'strength', 'Influence', { min: 0, max: 1, slider: true }),
      num(f, 'guide_free', 'Free', { min: 0, max: 0.99, slider: true, tip: 'Last part of the particle lifetime in which particles move freely' }),
      num(f, 'guide_minimum', 'Minimum Distance', { min: 0, max: 1000, unit: 'distance', tip: 'Particles further than this from the curve start are guided less (see Falloff Power)' }),
      num(f, 'guide_clump_amount', 'Clump', { min: -1, max: 1, slider: true }),
      bool(f, 'use_guide_path_add', 'Additive'),
    ];
  else if (t === 'HARMONIC') settings = [num(f, 'strength', 'Strength', { min: -1000, max: 1000, softMin: -10, softMax: 10 }), num(f, 'harmonic_damping', 'Damping', { min: 0, max: 10 }), num(f, 'rest_length', 'Rest Length', { min: 0, max: 1000, unit: 'distance' }), ...noiseSeed];
  else if (t === 'LENNARDJ') settings = [num(f, 'strength', 'Strength', { min: -1000, max: 1000, softMin: -10, softMax: 10 }), num(f, 'size', 'Size', { min: 0.001, max: 1000, softMax: 10, unit: 'distance' }), ...noiseSeed];
  else if (t === 'TURBULENCE') settings = [num(f, 'strength', 'Strength', { min: -1000, max: 1000, softMin: -10, softMax: 10 }), num(f, 'size', 'Size', { min: 0, max: 1000, softMax: 10, unit: 'distance' }), num(f, 'seed', 'Seed', { int: true, min: 1, max: 128 })];
  else
    settings = [
      num(f, 'strength', 'Strength', { min: -1000, max: 1000, softMin: -10, softMax: 10 }),
      t === 'VORTEX' ? num(f, 'inflow', 'Inflow', { min: -10, max: 10 }) : null,
      t !== 'MAGNET' ? num(f, 'flow', 'Flow', { min: 0, max: 10 }) : null,
      ...noiseSeed,
    ];
  return [
    panel('ph-field', 'Force Fields', () => [
      enumProp(f, 'type', 'Type', FIELD_TYPES.map(([v, l]) => [v, l] as [string, string])),
      t !== 'GUIDE' && t !== 'WIND' ? enumProp(f, 'shape', 'Shape', shapes) : null,
      t === 'GUIDE' && ob.type !== 'CURVE' ? note('Curve guides follow the object\'s curve: use a curve object', 'error') : null,
      subHeading('Settings'),
      settings,
    ]),
    panel('ph-field-falloff', 'Falloff', () => [
      enumProp(f, 'falloff_type', 'Shape', [['SPHERE', 'Sphere'], ['TUBE', 'Tube'], ['CONE', 'Cone']]),
      num(f, 'falloff_power', 'Power', { min: 0, max: 10 }),
      h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, 'Min Distance'), h('div', { class: 'sr-value row-aligned' }, headerCheck(`ff-min-${ob.id}`, f as never, 'use_min_distance', 'Min Distance')), h('span', { class: 'decorator-space' })),
      f.use_min_distance ? num(f, 'distance_min', 'Distance', { min: 0, unit: 'distance' }) : null,
      h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, 'Max Distance'), h('div', { class: 'sr-value row-aligned' }, headerCheck(`ff-max-${ob.id}`, f as never, 'use_max_distance', 'Max Distance')), h('span', { class: 'decorator-space' })),
      f.use_max_distance ? num(f, 'distance_max', 'Distance', { min: 0, unit: 'distance' }) : null,
    ], { closed: true }),
  ];
}

// ---------------------------------------------------------------------------
// Collision

function collisionPanels(ob: ObjectPhysics): Child[] {
  const c = fillDefaults(ob.collision as CollisionSettingsX, defaultCollision());
  return [
    panel('ph-col', 'Collision', () => [
      panel('ph-col-part', 'Particle', () => [
        num(c, 'permeability', 'Permeability', { min: 0, max: 1, slider: true }),
        bool(c, 'use_particle_kill', 'Kill Particles'),
        num(c, 'damping_factor', 'Damping', { min: 0, max: 1, slider: true }),
        num(c, 'friction_factor', 'Friction', { min: 0, max: 1, slider: true }),
      ], { sub: true }),
      panel('ph-col-cloth', 'Softbody & Cloth', () => [
        num(c, 'thickness_outer', 'Thickness Outer', { min: 0.001, max: 1, unit: 'distance' }),
        num(c, 'damping', 'Damping', { min: 0, max: 1, slider: true }),
        num(c, 'cloth_friction', 'Friction', { min: 0, max: 80 }),
        bool(c, 'use_culling', 'Single Sided'),
      ], { sub: true }),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// Cloth

function clothPanels(ob: ObjectPhysics, m: ClothModifier): Child[] {
  const s = fillDefaults(m.settings, defaultClothSettings()),
    c = fillDefaults(m.collision_settings, defaultClothCollision()),
    pc = m.point_cache;
  const d = pc.is_baked;
  return [
    panel('ph-cloth', 'Cloth', () => [
      d ? note('Cloth is baked: delete the bake to change settings') : null,
      num(s, 'quality', 'Quality Steps', { int: true, min: 1, max: 80, disabled: d }),
      num(s, 'time_scale', 'Speed Multiplier', { min: 0, max: 10, disabled: d }),
      panel('ph-cloth-phys', 'Physical Properties', () => [num(s, 'mass', 'Vertex Mass', { min: 0.001, max: 100, disabled: d }), num(s, 'air_damping', 'Air Viscosity', { min: 0, max: 10, disabled: d })], { sub: true }),
      panel('ph-cloth-stiff', 'Stiffness', () => [
        num(s, 'tension_stiffness', 'Tension', { min: 0, max: 10000, softMax: 100, disabled: d }),
        num(s, 'compression_stiffness', 'Compression', { min: 0, max: 10000, softMax: 100, disabled: d }),
        num(s, 'shear_stiffness', 'Shear', { min: 0, max: 10000, softMax: 100, disabled: d }),
        num(s, 'bending_stiffness', 'Bending', { min: 0, max: 10000, softMax: 50, disabled: d }),
      ], { sub: true }),
      panel('ph-cloth-damp', 'Damping', () => [
        num(s, 'tension_damping', 'Tension', { min: 0, max: 50, disabled: d }),
        num(s, 'compression_damping', 'Compression', { min: 0, max: 50, disabled: d }),
        num(s, 'shear_damping', 'Shear', { min: 0, max: 50, disabled: d }),
        num(s, 'bending_damping', 'Bending', { min: 0, max: 50, disabled: d }),
      ], { sub: true, closed: true }),
    ]),
    panel('ph-cloth-shape', 'Shape', () => [
      vgroupRow(ob, s as never, 'vertex_group_mass', 'Pin Group', d),
      num(s, 'pin_stiffness', 'Pin Stiffness', { min: 0, max: 1, slider: true, disabled: d }),
      num(s, 'shrink_min', 'Shrinking Factor', { min: -1, max: 0.99, disabled: d }),
    ]),
    panel('ph-cloth-col', 'Collisions', () => [
      num(c, 'collision_quality', 'Quality', { int: true, min: 1, max: 20, disabled: d }),
      panel('ph-cloth-objcol', 'Object Collisions', () => [num(c, 'distance_min', 'Distance', { min: 0.001, max: 1, unit: 'distance', disabled: d || !c.use_collision })], { sub: true, header: headerCheck(`cl-oc-${m.id}`, c as never, 'use_collision', 'Object Collisions', d) }),
      panel('ph-cloth-selfcol', 'Self Collisions', () => [num(c, 'self_friction', 'Friction', { min: 0, max: 80, disabled: d || !c.use_self_collision }), num(c, 'self_distance_min', 'Distance', { min: 0.001, max: 0.5, unit: 'distance', disabled: d || !c.use_self_collision })], { sub: true, header: headerCheck(`cl-sc-${m.id}`, c as never, 'use_self_collision', 'Self Collisions', d) }),
    ], { closed: true }),
    fieldWeightsPanel('ph-cloth-fw', s, d),
    cachePanel('ph-cloth-cache', meshSimKey('CLOTH', ob, m), pc),
  ];
}

// ---------------------------------------------------------------------------
// Soft body

function softPanels(ob: ObjectPhysics, m: SoftBodyModifier): Child[] {
  const s = fillDefaults(m.settings, defaultSoftBodySettings()),
    pc = m.point_cache,
    d = pc.is_baked;
  return [
    panel('ph-soft', 'Soft Body', () => [
      d ? note('Soft body is baked: delete the bake to change settings') : null,
      subHeading('Object'),
      num(s, 'friction', 'Friction', { min: 0, max: 50, disabled: d }),
      num(s, 'mass', 'Mass', { min: 0.001, max: 50000, unit: 'none', disabled: d }),
      subHeading('Simulation'),
      num(s, 'speed', 'Speed', { min: 0.01, max: 100, disabled: d }),
      num(s, 'quality', 'Steps', { int: true, min: 1, max: 50, disabled: d }),
    ]),
    panel('ph-soft-goal', 'Goal', () => [
      vgroupRow(ob, s as never, 'vertex_group_goal', 'Vertex Group', d || !s.use_goal),
      subHeading('Settings'),
      num(s, 'goal_spring', 'Stiffness', { min: 0, max: 0.999, slider: true, disabled: d || !s.use_goal }),
      num(s, 'goal_friction', 'Damping', { min: 0, max: 50, disabled: d || !s.use_goal }),
      subHeading('Strengths'),
      num(s, 'goal_default', 'Default', { min: 0, max: 1, slider: true, disabled: d || !s.use_goal }),
      num(s, 'goal_min', 'Min', { min: 0, max: 1, slider: true, disabled: d || !s.use_goal }),
      num(s, 'goal_max', 'Max', { min: 0, max: 1, slider: true, disabled: d || !s.use_goal }),
    ], { header: headerCheck(`sb-goal-${m.id}`, s as never, 'use_goal', 'Goal', d) }),
    panel('ph-soft-edges', 'Edges', () => [
      num(s, 'pull', 'Pull', { min: 0, max: 0.999, slider: true, disabled: d || !s.use_edges }),
      num(s, 'push', 'Push', { min: 0, max: 0.999, slider: true, disabled: d || !s.use_edges }),
      num(s, 'damping', 'Damp', { min: 0, max: 50, disabled: d || !s.use_edges }),
      num(s, 'bend', 'Bending', { min: 0, max: 10, disabled: d || !s.use_edges }),
    ], { header: headerCheck(`sb-edges-${m.id}`, s as never, 'use_edges', 'Edges', d) }),
    panel('ph-soft-shape', 'Shape Matching', () => [num(s, 'shape_stiffness', 'Stiffness', { min: 0, max: 1, slider: true, disabled: d || !s.use_shape_match }), note('Pulls the mesh back towards its rest shape (keeps volume).')], {
      header: headerCheck(`sb-shape-${m.id}`, s as never, 'use_shape_match', 'Shape Matching', d),
      closed: true,
    }),
    panel('ph-soft-col', 'Collisions', () => [num(s, 'ball_size', 'Ball Size', { min: 0.001, max: 10, unit: 'distance', disabled: d || !s.use_collision })], {
      header: headerCheck(`sb-col-${m.id}`, s as never, 'use_collision', 'Collisions', d),
      closed: true,
    }),
    fieldWeightsPanel('ph-soft-fw', s, d),
    cachePanel('ph-soft-cache', meshSimKey('SOFT_BODY', ob, m), pc),
  ];
}

// ---------------------------------------------------------------------------
// Fluid (gas)

const fluidOf = (o: ObjectData) => o.modifiers.find((m) => m.type === 'FLUID') as FluidModifier | undefined;

function fluidPanels(ob: ObjectPhysics, m: FluidModifier): Child[] {
  const out: Child[] = [
    panel('ph-fluid', 'Fluid', () => [
      splitRow(
        'Type',
        enumMenu(`fluid-type-${m.id}`, [{ value: 'NONE', label: 'None' }, { value: 'DOMAIN', label: 'Domain' }, { value: 'FLOW', label: 'Flow' }, { value: 'EFFECTOR', label: 'Effector' }], m.fluid_type, (v) => {
          m.fluid_type = v as FluidModifier['fluid_type'];
          // the domain box is shown as a wireframe so the smoke inside stays visible
          if (v === 'DOMAIN') ob.display_type = 'WIRE';
          else if (ob.display_type === 'WIRE') ob.display_type = 'TEXTURED';
          changed('Fluid Type');
        }),
      ),
    ]),
  ];
  if (m.fluid_type === 'DOMAIN') {
    const s = fillDefaults(m.domain_settings, defaultDomainSettings()),
      pc = m.point_cache,
      d = pc.is_baked;
    out.push(
      panel('ph-fl-settings', 'Settings', () => [
        d ? note('Domain is baked: delete the bake to change settings') : null,
        splitRow('Domain Type', h('span', { class: 'prop-note' }, 'Gas (smoke & fire)')),
        num(s, 'resolution_max', 'Resolution Divisions', { int: true, min: 8, max: 128, disabled: d }),
        num(s, 'time_scale', 'Time Scale', { min: 0.01, max: 10, disabled: d }),
        panel('ph-fl-border', 'Border Collisions', () => [
          bool(s, 'use_collision_border_front', 'Front', { disabled: d }),
          bool(s, 'use_collision_border_back', 'Back', { disabled: d }),
          bool(s, 'use_collision_border_right', 'Right', { disabled: d }),
          bool(s, 'use_collision_border_left', 'Left', { disabled: d }),
          bool(s, 'use_collision_border_top', 'Top', { disabled: d }),
          bool(s, 'use_collision_border_bottom', 'Bottom', { disabled: d }),
        ], { sub: true, closed: true }),
        panel('ph-fl-gas', 'Gas', () => [
          num(s, 'alpha', 'Buoyancy Density', { min: -5, max: 5, disabled: d }),
          num(s, 'beta', 'Heat', { min: -5, max: 5, disabled: d }),
          num(s, 'vorticity', 'Vorticity', { min: 0, max: 4, disabled: d }),
        ], { sub: true }),
      ]),
      panel('ph-fl-dissolve', 'Dissolve', () => [num(s, 'dissolve_speed', 'Time', { int: true, min: 1, max: 10000, disabled: d || !s.use_dissolve_smoke })], { header: headerCheck(`fl-dis-${m.id}`, s as never, 'use_dissolve_smoke', 'Dissolve', d), closed: true }),
      panel('ph-fl-fire', 'Fire', () => [
        num(s, 'burning_rate', 'Reaction Speed', { min: 0.01, max: 4, disabled: d }),
        num(s, 'flame_smoke', 'Flame Smoke', { min: 0, max: 8, disabled: d }),
        num(s, 'flame_vorticity', 'Vorticity', { min: 0, max: 2, disabled: d }),
        num(s, 'flame_max_temp', 'Temperature Maximum', { min: 1, max: 10, disabled: d }),
      ], { closed: true }),
      panel('ph-fl-display', 'Viewport Display', () => [num(s, 'display_thickness', 'Thickness', { min: 0.001, max: 1000, softMax: 5 })], { closed: true }),
      cachePanel('ph-fl-cache', fluidCacheKey(ob, m), pc),
    );
  } else if (m.fluid_type === 'FLOW') {
    const s = fillDefaults(m.flow_settings, defaultFlowSettings());
    out.push(
      panel('ph-fl-flow', 'Settings', () => [
        enumProp(s, 'flow_type', 'Flow Type', [['SMOKE', 'Smoke'], ['BOTH', 'Fire + Smoke'], ['FIRE', 'Fire']]),
        enumProp(s, 'flow_behavior', 'Flow Behavior', [['INFLOW', 'Inflow'], ['GEOMETRY', 'Geometry'], ['OUTFLOW', 'Outflow']]),
        bool(s, 'use_flow', 'Use Flow'),
        s.flow_type !== 'FIRE' ? colorProp(s, 'smoke_color', 'Smoke Color') : null,
        s.flow_type !== 'SMOKE' ? num(s, 'fuel_amount', 'Fuel', { min: 0, max: 10 }) : null,
        num(s, 'temperature', 'Temperature Difference', { min: -10, max: 10 }),
        s.flow_type !== 'FIRE' ? num(s, 'density', 'Density', { min: 0, max: 10 }) : null,
      ]),
      panel('ph-fl-source', 'Flow Source', () => [
        num(s, 'surface_distance', 'Surface Emission', { min: 0, max: 10, tip: 'Emission distance from the mesh surface (in grid cells)' }),
        num(s, 'volume_density', 'Volume Emission', { min: 0, max: 1, slider: true }),
      ]),
      panel('ph-fl-vel', 'Initial Velocity', () => [
        num(s, 'velocity_factor', 'Source', { min: -2, max: 2, disabled: !s.use_initial_velocity, tip: 'Multiplier of the flow object velocity' }),
        num(s, 'velocity_normal', 'Normal', { min: -2, max: 2, disabled: !s.use_initial_velocity }),
      ], { header: headerCheck(`fl-iv-${m.id}`, s as never, 'use_initial_velocity', 'Initial Velocity'), closed: true }),
    );
  } else if (m.fluid_type === 'EFFECTOR') {
    const s = m.effector_settings;
    out.push(panel('ph-fl-eff', 'Settings', () => [enumProp(s, 'effector_type', 'Effector Type', [['COLLISION', 'Collision']]), bool(s, 'use_effector', 'Enabled')]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rigid body

const SHAPES: [string, string][] = [
  ['BOX', 'Box'],
  ['SPHERE', 'Sphere'],
  ['CAPSULE', 'Capsule'],
  ['CYLINDER', 'Cylinder'],
  ['CONE', 'Cone'],
  ['CONVEX_HULL', 'Convex Hull'],
  ['MESH', 'Mesh'],
];

function rigidBodyPanels(ob: ObjectPhysics): Child[] {
  const rb = ob.rigid_body as RigidBodyX;
  const w = app.doc.scene.rigidbody_world as RigidBodyWorldX | null;
  const d = !!w?.is_baked;
  return [
    panel('ph-rb', 'Rigid Body', () => [
      !w ? note('No rigid body world: add one in Scene properties', 'error') : w.enabled ? null : note('The rigid body world is disabled', 'error'),
      !rapierLoaded() ? note('Loading physics engine…') : null,
      d ? note('Rigid body world is baked: delete the bake to change settings') : null,
      enumProp(rb, 'type', 'Type', [['ACTIVE', 'Active'], ['PASSIVE', 'Passive']], { disabled: d }),
      panel('ph-rb-settings', 'Settings', () => [
        rb.type === 'ACTIVE' ? num(rb, 'mass', 'Mass', { min: 0.001, max: 100000, disabled: d }) : null,
        rb.type === 'ACTIVE' ? bool(rb, 'enabled', 'Dynamic', { disabled: d, tip: 'Rigid body actively participates in the simulation' }) : null,
        bool(rb, 'kinematic', 'Animated', { disabled: d, tip: 'Allow rigid body to be controlled by its animation' }),
      ], { sub: true }),
      panel('ph-rb-col', 'Collisions', () => [
        enumProp(rb, 'collision_shape', 'Shape', SHAPES, { disabled: d }),
        rb.type === 'ACTIVE' && rb.collision_shape === 'MESH' ? note('Moving mesh shapes collide using their convex hull') : null,
        subHeading('Surface Response'),
        num(rb, 'friction', 'Friction', { min: 0, max: 1, slider: true, disabled: d }),
        num(rb, 'restitution', 'Bounciness', { min: 0, max: 1, slider: true, disabled: d }),
        subHeading('Sensitivity'),
        h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, 'Margin'), h('div', { class: 'sr-value row-aligned' }, headerCheck(`rb-margin-${ob.id}`, rb as never, 'use_margin', 'Collision Margin', d)), h('span', { class: 'decorator-space' })),
        rb.use_margin ? num(rb, 'collision_margin', 'Margin', { min: 0, max: 1, unit: 'distance', disabled: d }) : null,
      ], { sub: true }),
      rb.type === 'ACTIVE'
        ? panel('ph-rb-dyn', 'Dynamics', () => [
            subHeading('Damping'),
            num(rb, 'linear_damping', 'Translation', { min: 0, max: 1, slider: true, disabled: d }),
            num(rb, 'angular_damping', 'Rotation', { min: 0, max: 1, slider: true, disabled: d }),
            bool(rb, 'use_deactivation', 'Deactivation', { disabled: d, tip: 'Let resting bodies go to sleep' }),
          ], { sub: true, closed: true })
        : null,
    ]),
    w ? fieldWeightsPanel('ph-rb-fw', w, d) : null,
    w ? cachePanel('ph-rb-cache', RB_CACHE, w as unknown as { frame_start: number; frame_end: number; is_baked: boolean }) : null,
  ];
}

function rbConstraintPanels(ob: ObjectPhysics): Child[] {
  const c = ob.rigid_body_constraint!;
  return [
    panel('ph-rbc', 'Rigid Body Constraint', () => [
      !app.doc.scene.rigidbody_world ? note('No rigid body world: add one in Scene properties', 'error') : null,
      enumProp(c, 'type', 'Type', RBC_TYPES),
      c.type === 'HINGE' ? note("The hinge turns around this object's local Z axis") : c.type === 'SLIDER' || c.type === 'PISTON' || c.type === 'MOTOR' ? note("The axis is this object's local X axis") : null,
      panel('ph-rbc-settings', 'Settings', () => [bool(c, 'enabled', 'Enabled'), bool(c, 'disable_collisions', 'Disable Collisions')], { sub: true }),
      panel('ph-rbc-objects', 'Objects', () => [
        objectRow(`rbc1-${ob.id}`, c as never, 'object1', 'First', (o) => !!o.rigid_body),
        objectRow(`rbc2-${ob.id}`, c as never, 'object2', 'Second', (o) => !!o.rigid_body),
      ], { sub: true }),
      rbcTypePanels(c, ob.id),
    ]),
  ];
}

insertTabAfter('CONSTRAINT', {
  id: 'PHYSICS',
  label: 'Physics',
  icon: 'physics',
  group: 3,
  poll: () => !!app.activeObject,
  draw: () => {
    const ob = app.activeObject as ObjectPhysics;
    const out: Child[] = [enableGrid(ob)];
    if (ob.field && ob.field.type !== 'NONE') out.push(...fieldPanels(ob));
    if (ob.collision?.use && isCollider(ob)) out.push(...collisionPanels(ob));
    const cl = clothOf(ob);
    if (cl) out.push(...clothPanels(ob, cl));
    const sb = softOf(ob);
    if (sb) out.push(...softPanels(ob, sb));
    const fl = isGeom(ob) ? fluidOf(ob) : undefined;
    if (fl) out.push(...fluidPanels(ob, fl));
    if (ob.rigid_body) out.push(...rigidBodyPanels(ob));
    if (ob.rigid_body_constraint) out.push(...rbConstraintPanels(ob));
    return out;
  },
});

// modifier stack: physics modifiers point to their tab
const gotoTab = (tab: string, text: string) => (_ob: ObjectData, _m: ModifierBase) =>
  h(
    'div',
    { class: 'prop-note' },
    text,
    ' ',
    button(`goto-${tab}`, 'Open', () => {
      (window as unknown as { __propertiesTab?: string }).__propertiesTab = tab;
      app.changed('ui');
    }),
  );
modifierExtraUI.CLOTH = gotoTab('PHYSICS', 'Settings are inside the Physics tab.');
modifierExtraUI.SOFT_BODY = gotoTab('PHYSICS', 'Settings are inside the Physics tab.');
modifierExtraUI.FLUID = gotoTab('PHYSICS', 'Settings are inside the Physics tab.');
modifierExtraUI.PARTICLE_SYSTEM = gotoTab('PARTICLES', 'Settings are inside the Particles tab.');
