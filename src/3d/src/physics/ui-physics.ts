// Physics properties tab: enable buttons and panels for Force Field, Collision,
// Cloth, Soft Body, Rigid Body and Rigid Body Constraint.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, checkbox, button } from '../ui/widgets';
import { num, bool, enumProp } from '../ui/props';
import type { FluidModifier } from './fluid';
import { fluidPanels } from './ui-fluid';
import { icon } from '../ui/icons';
import { modifierExtraUI } from '../editors/properties/stack';
import type { ModifierBase, ObjectData } from '../data/types';
import { insertTabAfter, changed, note, subHeading, vgroupRow, objectRow, cachePanel, fieldWeightsPanel, collectionRow } from './ui-common';
import { meshSimKey } from './meshsim';
import { RB_CACHE, rapierLoaded } from './rigidbody';
import { RBC_TYPES } from './rbjoints';
import { rbcTypePanels } from './ui-rbc';
import { dynamicPaintPanels } from './ui-dynpaint';
import { dpOf } from './dpops';
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
    const dp = dpOf(ob);
    btns.push(toggleButton('Dynamic Paint', 'mod_dynamicpaint', !!dp, () => app.run('object.modifier_add', { type: 'DYNAMIC_PAINT' }), () => app.run('object.modifier_remove', { modifier: dp!.id })));
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
  // options shared by the pushing fields
  const pushing = t === 'FORCE' || t === 'WIND' || t === 'VORTEX' || t === 'TURBULENCE' || t === 'MAGNET' || t === 'HARMONIC' || t === 'LENNARDJ';
  const extras: Child[] = pushing
    ? [
        bool(f as never, 'apply_to_location', 'Affect Location', { tip: 'The field pushes objects and particles' }),
        t === 'FORCE' ? bool(f as never, 'use_gravity_falloff', 'Gravitation', { tip: 'Fall off with the square of the distance' }) : null,
        t === 'TURBULENCE' ? bool(f as never, 'use_global_coords', 'Global', { tip: 'Keep the noise pattern fixed in the world (else it moves with the field object)' }) : null,
        bool(f as never, 'use_absorption', 'Absorption', { tip: 'Collision objects between the field and a point block the field' }),
        num(f as never, 'wind_factor', 'Wind Factor', { min: 0, max: 1, slider: true, tip: 'Surfaces (cloth, soft bodies) only catch the part of the force across them' }),
      ]
    : [];
  return [
    panel('ph-field', 'Force Fields', () => [
      enumProp(f, 'type', 'Type', FIELD_TYPES.map(([v, l]) => [v, l] as [string, string])),
      t !== 'GUIDE' ? enumProp(f, 'shape', 'Shape', shapes) : null,
      t === 'GUIDE' && ob.type !== 'CURVE' ? note('Curve guides follow the object\'s curve: use a curve object', 'error') : null,
      subHeading('Settings'),
      settings,
      extras,
    ]),
    panel('ph-field-falloff', 'Falloff', () => [
      enumProp(f, 'falloff_type', 'Shape', [['SPHERE', 'Sphere'], ['TUBE', 'Tube'], ['CONE', 'Cone']]),
      enumProp(f as never, 'z_direction', 'Z Direction', [['BOTH', 'Both Z'], ['POSITIVE', '+Z'], ['NEGATIVE', '-Z']]),
      num(f, 'falloff_power', 'Power', { min: 0, max: 10, disabled: !!f.use_gravity_falloff }),
      h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, 'Min Distance'), h('div', { class: 'sr-value row-aligned' }, headerCheck(`ff-min-${ob.id}`, f as never, 'use_min_distance', 'Min Distance')), h('span', { class: 'decorator-space' })),
      f.use_min_distance ? num(f, 'distance_min', 'Distance', { min: 0, unit: 'distance' }) : null,
      h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, 'Max Distance'), h('div', { class: 'sr-value row-aligned' }, headerCheck(`ff-max-${ob.id}`, f as never, 'use_max_distance', 'Max Distance')), h('span', { class: 'decorator-space' })),
      f.use_max_distance ? num(f, 'distance_max', 'Distance', { min: 0, unit: 'distance' }) : null,
      f.falloff_type === 'TUBE' || f.falloff_type === 'CONE'
        ? panel(f.falloff_type === 'TUBE' ? 'ph-field-radial' : 'ph-field-angular', f.falloff_type === 'TUBE' ? 'Radial' : 'Angular', () => {
            const cone = f.falloff_type === 'CONE';
            return [
              num(f as never, 'radial_falloff', 'Power', { min: 0, max: 10 }),
              bool(f as never, 'use_radial_min', cone ? 'Use Min Angle' : 'Use Minimum'),
              f.use_radial_min ? num(f as never, 'radial_min', cone ? 'Min Angle' : 'Min Distance', cone ? { min: 0, max: 180 } : { min: 0, unit: 'distance' }) : null,
              bool(f as never, 'use_radial_max', cone ? 'Use Max Angle' : 'Use Maximum'),
              f.use_radial_max ? num(f as never, 'radial_max', cone ? 'Max Angle' : 'Max Distance', cone ? { min: 0, max: 180 } : { min: 0, unit: 'distance' }) : null,
            ];
          }, { sub: true })
        : null,
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
        num(c, 'stickiness', 'Stickiness', { min: 0, max: 1, slider: true }),
        bool(c, 'use_particle_kill', 'Kill Particles'),
        num(c, 'damping_factor', 'Damping', { min: 0, max: 1, slider: true }),
        num(c, 'damping_random', 'Randomize', { min: 0, max: 1, slider: true }),
        num(c, 'friction_factor', 'Friction', { min: 0, max: 1, slider: true }),
        num(c, 'friction_random', 'Randomize', { min: 0, max: 1, slider: true }),
      ], { sub: true }),
      panel('ph-col-cloth', 'Softbody & Cloth', () => [
        num(c, 'damping', 'Damping', { min: 0, max: 1, slider: true }),
        num(c, 'thickness_outer', 'Thickness Outer', { min: 0.001, max: 1, unit: 'distance' }),
        num(c, 'thickness_inner', 'Inner', { min: 0.001, max: 1, unit: 'distance', tip: 'How far behind a single sided surface points are still pushed out' }),
        num(c, 'cloth_friction', 'Friction', { min: 0, max: 80 }),
        bool(c, 'use_culling', 'Single Sided'),
        bool(c as never, 'use_normal', 'Override Normals', { tip: 'Push cloth and soft bodies out along the surface normals' }),
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
      panel('ph-cloth-phys', 'Physical Properties', () => [
        num(s, 'mass', 'Vertex Mass', { min: 0.001, max: 100, disabled: d }),
        num(s, 'air_damping', 'Air Viscosity', { min: 0, max: 10, disabled: d }),
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
        panel('ph-cloth-intern', 'Internal Springs', () => [
          num(s, 'internal_spring_max_length', 'Max Spring Creation Length', { min: 0, max: 1000, unit: 'distance', disabled: d || !s.use_internal_springs, tip: '0 means no limit' }),
          num(s, 'internal_spring_max_diversion', 'Max Creation Diversion', { min: 0, max: Math.PI / 2, unit: 'angle', disabled: d || !s.use_internal_springs }),
          bool(s, 'internal_spring_normal_check', 'Check Surface Normals', { disabled: d || !s.use_internal_springs }),
          num(s, 'internal_tension_stiffness', 'Tension', { min: 0, max: 10000, softMax: 100, disabled: d || !s.use_internal_springs }),
          num(s, 'internal_compression_stiffness', 'Compression', { min: 0, max: 10000, softMax: 100, disabled: d || !s.use_internal_springs }),
        ], { sub: true, closed: true, header: headerCheck(`cl-is-${m.id}`, s as never, 'use_internal_springs', 'Internal Springs', d) }),
        panel('ph-cloth-press', 'Pressure', () => [
          num(s, 'uniform_pressure_force', 'Pressure', { min: -10000, max: 10000, softMin: -100, softMax: 100, disabled: d || !s.use_pressure }),
          bool(s, 'use_pressure_volume', 'Custom Volume', { disabled: d || !s.use_pressure }),
          s.use_pressure_volume ? num(s, 'target_volume', 'Target Volume', { min: 0, max: 10000, disabled: d || !s.use_pressure }) : null,
          num(s, 'pressure_factor', 'Pressure Scale', { min: 0, max: 10000, softMax: 10, disabled: d || !s.use_pressure }),
          num(s, 'fluid_density', 'Fluid Density', { min: -1000, max: 1000, softMin: -100, softMax: 100, disabled: d || !s.use_pressure }),
          vgroupRow(ob, s as never, 'vertex_group_pressure', 'Vertex Group', d || !s.use_pressure),
        ], { sub: true, closed: true, header: headerCheck(`cl-pr-${m.id}`, s as never, 'use_pressure', 'Pressure', d) }),
      ], { sub: true }),
    ]),
    panel('ph-cloth-shape', 'Shape', () => [
      vgroupRow(ob, s as never, 'vertex_group_mass', 'Pin Group', d),
      num(s, 'pin_stiffness', 'Pin Stiffness', { min: 0, max: 1, slider: true, disabled: d }),
      bool(s, 'use_sewing_springs', 'Sewing', { disabled: d, tip: 'Loose edges pull their two vertices together' }),
      s.use_sewing_springs ? num(s, 'sewing_force_max', 'Max Sewing Force', { min: 0, max: 10000, disabled: d, tip: '0 pulls as hard as possible' }) : null,
      vgroupRow(ob, s as never, 'vertex_group_shrink', 'Shrinking Group', d),
      num(s, 'shrink_min', 'Shrinking Factor', { min: -1, max: 0.99, disabled: d }),
      s.vertex_group_shrink ? num(s, 'shrink_max', 'Max Shrinking', { min: -1, max: 0.99, disabled: d }) : null,
      bool(s as never, 'use_dynamic_mesh', 'Dynamic Mesh', { disabled: d, tip: 'The rest shape follows the animated mesh' }),
    ]),
    panel('ph-cloth-col', 'Collisions', () => [
      num(c, 'collision_quality', 'Quality', { int: true, min: 1, max: 20, disabled: d }),
      panel('ph-cloth-objcol', 'Object Collisions', () => [
        num(c, 'distance_min', 'Distance', { min: 0.001, max: 1, unit: 'distance', disabled: d || !c.use_collision }),
        num(c as never, 'impulse_clamp', 'Impulse Clamping', { min: 0, max: 100, disabled: d || !c.use_collision, tip: 'Most speed a collision may give a vertex (0: no limit)' }),
        vgroupRow(ob, c as never, 'vertex_group_object_collisions', 'Vertex Group', d || !c.use_collision),
        collectionRow(`cl-coll-${m.id}`, c as never, 'collection', 'Collision Collection', 'All colliders', d || !c.use_collision),
      ], { sub: true, header: headerCheck(`cl-oc-${m.id}`, c as never, 'use_collision', 'Object Collisions', d) }),
      panel('ph-cloth-selfcol', 'Self Collisions', () => [
        num(c, 'self_friction', 'Friction', { min: 0, max: 80, disabled: d || !c.use_self_collision }),
        num(c, 'self_distance_min', 'Distance', { min: 0.001, max: 0.5, unit: 'distance', disabled: d || !c.use_self_collision }),
        num(c as never, 'self_impulse_clamp', 'Impulse Clamping', { min: 0, max: 100, disabled: d || !c.use_self_collision }),
        vgroupRow(ob, c as never, 'vertex_group_self_collisions', 'Vertex Group', d || !c.use_self_collision),
      ], { sub: true, header: headerCheck(`cl-sc-${m.id}`, c as never, 'use_self_collision', 'Self Collisions', d) }),
    ], { closed: true }),
    panel('ph-cloth-pw', 'Property Weights', () => [
      vgroupRow(ob, s as never, 'vertex_group_structural_stiffness', 'Structural Group', d),
      num(s, 'tension_stiffness_max', 'Max Tension', { min: 0, max: 10000, softMax: 100, disabled: d || !s.vertex_group_structural_stiffness }),
      num(s, 'compression_stiffness_max', 'Max Compression', { min: 0, max: 10000, softMax: 100, disabled: d || !s.vertex_group_structural_stiffness }),
      vgroupRow(ob, s as never, 'vertex_group_shear_stiffness', 'Shear Group', d),
      num(s, 'shear_stiffness_max', 'Max Shearing', { min: 0, max: 10000, softMax: 100, disabled: d || !s.vertex_group_shear_stiffness }),
      vgroupRow(ob, s as never, 'vertex_group_bending', 'Bending Group', d),
      num(s, 'bending_stiffness_max', 'Max Bending', { min: 0, max: 10000, softMax: 50, disabled: d || !s.vertex_group_bending }),
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
      collectionRow(`sb-coll-${m.id}`, s as never, 'collision_collection', 'Collision Collection', 'All colliders', d),
      subHeading('Object'),
      num(s, 'friction', 'Friction', { min: 0, max: 50, disabled: d }),
      num(s, 'mass', 'Mass', { min: 0.001, max: 50000, unit: 'none', disabled: d }),
      vgroupRow(ob, s as never, 'vertex_group_mass', 'Control Point', d),
      subHeading('Simulation'),
      num(s, 'speed', 'Speed', { min: 0.01, max: 100, disabled: d }),
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
      vgroupRow(ob, s as never, 'vertex_group_spring', 'Springs', d || !s.use_edges),
      num(s, 'pull', 'Pull', { min: 0, max: 0.999, slider: true, disabled: d || !s.use_edges }),
      num(s, 'push', 'Push', { min: 0, max: 0.999, slider: true, disabled: d || !s.use_edges }),
      num(s, 'damping', 'Damp', { min: 0, max: 50, disabled: d || !s.use_edges }),
      num(s, 'plastic', 'Plasticity', { min: 0, max: 100, disabled: d || !s.use_edges }),
      num(s, 'bend', 'Bending', { min: 0, max: 10, disabled: d || !s.use_edges }),
      num(s, 'spring_length', 'Length', { min: 0, max: 200, disabled: d || !s.use_edges, tip: 'Spring rest length in percent (0 keeps the modelled length)' }),
      panel('ph-soft-aero', 'Aerodynamics', () => [
        enumProp(s, 'aerodynamics_type', 'Type', [['SIMPLE', 'Simple'], ['LIFT_FORCE', 'Lift Force']], { disabled: d || !s.use_edges }),
        num(s, 'aero', 'Factor', { min: 0, max: 30000, softMax: 100, disabled: d || !s.use_edges }),
      ], { sub: true, closed: true }),
      panel('ph-soft-stiff', 'Stiffness', () => [num(s as never, 'shear', 'Shear', { min: 0, max: 1, slider: true, disabled: d || !s.use_edges || !s.use_stiff_quads, tip: 'Stiffness of the diagonal springs across quads' })], {
        sub: true,
        closed: true,
        header: headerCheck(`sb-quads-${m.id}`, s as never, 'use_stiff_quads', 'Stiff Quads', d || !s.use_edges),
      }),
    ], { header: headerCheck(`sb-edges-${m.id}`, s as never, 'use_edges', 'Edges', d) }),
    panel('ph-soft-self', 'Self Collision', () => [
      enumProp(s as never, 'collision_type', 'Calculation Type', [['MANUAL', 'Manual'], ['AVERAGE', 'Average'], ['MINIMAL', 'Minimal'], ['MAXIMAL', 'Maximal']], { disabled: d || !s.use_self_collision, tip: 'Ball size: fixed, or a factor of the average / shortest / longest edge' }),
      num(s, 'self_ball_size', 'Ball Size', { min: 0.001, max: 10, unit: (s.collision_type ?? 'AVERAGE') === 'MANUAL' ? 'distance' : 'none', disabled: d || !s.use_self_collision }),
      num(s as never, 'ball_stiff', 'Stiffness', { min: 0.001, max: 1, slider: true, disabled: d || !s.use_self_collision }),
      num(s as never, 'ball_damp', 'Dampening', { min: 0.001, max: 1, slider: true, disabled: d || !s.use_self_collision }),
    ], {
      header: headerCheck(`sb-self-${m.id}`, s as never, 'use_self_collision', 'Self Collision', d),
      closed: true,
    }),
    panel('ph-soft-shape', 'Shape Matching', () => [num(s, 'shape_stiffness', 'Stiffness', { min: 0, max: 1, slider: true, disabled: d || !s.use_shape_match }), note('Pulls the mesh back towards its rest shape (keeps volume).')], {
      header: headerCheck(`sb-shape-${m.id}`, s as never, 'use_shape_match', 'Shape Matching', d),
      closed: true,
    }),
    panel('ph-soft-col', 'Collisions', () => [num(s, 'ball_size', 'Ball Size', { min: 0.001, max: 10, unit: 'distance', disabled: d || !s.use_collision })], {
      header: headerCheck(`sb-col-${m.id}`, s as never, 'use_collision', 'Collisions', d),
      closed: true,
    }),
    panel('ph-soft-solver', 'Solver', () => [
      num(s, 'quality', 'Steps', { int: true, min: 1, max: 50, disabled: d || s.use_auto_step === false, tip: 'Solver steps per frame' }),
      bool(s as never, 'use_auto_step', 'Auto-Step', { disabled: d, tip: 'Use the quality steps (else a fixed number from the minimum step size)' }),
      num(s as never, 'step_min', 'Step Size Min', { int: true, min: 0, max: 30000, disabled: d || s.use_auto_step !== false }),
      panel('ph-soft-helpers', 'Helpers', () => [num(s as never, 'choke', 'Choke', { int: true, min: 0, max: 100, disabled: d, tip: 'Velocity lost (in %) by vertices touching a collider' })], { sub: true, closed: true }),
    ], { closed: true }),
    fieldWeightsPanel('ph-soft-fw', s, d),
    cachePanel('ph-soft-cache', meshSimKey('SOFT_BODY', ob, m), pc),
  ];
}

const fluidOf = (o: ObjectData) => o.modifiers.find((m) => m.type === 'FLUID') as FluidModifier | undefined;

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
        rb.collision_shape === 'MESH' || rb.collision_shape === 'CONVEX_HULL'
          ? [
              enumProp(rb as never, 'mesh_source', 'Source', [['BASE', 'Base'], ['DEFORM', 'Deform'], ['FINAL', 'Final']], { disabled: d, tip: 'The mesh the shape is made from: without modifiers, after deforming modifiers, or fully evaluated' }),
              (rb.mesh_source ?? 'DEFORM') !== 'BASE' ? bool(rb as never, 'use_deform', 'Deforming', { disabled: d, tip: 'The shape follows the mesh as it deforms during the simulation' }) : null,
            ]
          : null,
        subHeading('Surface Response'),
        num(rb, 'friction', 'Friction', { min: 0, max: 1, slider: true, disabled: d }),
        num(rb, 'restitution', 'Bounciness', { min: 0, max: 1, slider: true, disabled: d }),
        subHeading('Sensitivity'),
        h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, 'Margin'), h('div', { class: 'sr-value row-aligned' }, headerCheck(`rb-margin-${ob.id}`, rb as never, 'use_margin', 'Collision Margin', d)), h('span', { class: 'decorator-space' })),
        rb.use_margin ? num(rb, 'collision_margin', 'Margin', { min: 0, max: 1, unit: 'distance', disabled: d }) : null,
        panel('ph-rb-colls', 'Collections', () => {
          const cc = (rb.collision_collections ??= Array.from({ length: 20 }, (_, i) => i === 0));
          const btn = (i: number) =>
            h('button', { key: i, class: { tbtn: true, on: !!cc[i] }, disabled: d, 'data-tip': `Collision collection ${i + 1}`, style: { minWidth: '0', padding: '0' }, onclick: () => ((cc[i] = !cc[i]), changed('Collision Collection')) }, String(i + 1));
          return [0, 10].map((o) => h('div', { key: o, class: 'row-aligned', style: { padding: '1px 0' } }, Array.from({ length: 10 }, (_, k) => btn(o + k))));
        }, { sub: true, closed: true }),
      ], { sub: true }),
      rb.type === 'ACTIVE'
        ? panel('ph-rb-dyn', 'Dynamics', () => [
            subHeading('Damping'),
            num(rb, 'linear_damping', 'Translation', { min: 0, max: 1, slider: true, disabled: d }),
            num(rb, 'angular_damping', 'Rotation', { min: 0, max: 1, slider: true, disabled: d }),
            panel('ph-rb-deact', 'Deactivation', () => [
              bool(rb as never, 'use_start_deactivated', 'Start Deactivated', { disabled: d || !rb.use_deactivation, tip: 'Asleep until something touches it' }),
              num(rb as never, 'deactivate_linear_velocity', 'Velocity Linear', { min: 0, max: 1000, softMax: 10, disabled: d || !rb.use_deactivation, tip: 'Bodies moving slower than this go to sleep' }),
              num(rb as never, 'deactivate_angular_velocity', 'Angular', { min: 0, max: 1000, softMax: 10, disabled: d || !rb.use_deactivation, tip: 'Bodies turning slower than this (radians per second) go to sleep' }),
            ], { sub: true, header: headerCheck(`rb-deact-${ob.id}`, rb as never, 'use_deactivation', 'Deactivation', d) }),
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
      panel('ph-rbc-settings', 'Settings', () => [
        bool(c, 'enabled', 'Enabled'),
        bool(c, 'disable_collisions', 'Disable Collisions'),
        bool(c as never, 'use_breaking', 'Breakable'),
        c.use_breaking ? num(c as never, 'breaking_threshold', 'Threshold', { min: 0, max: 1000, softMax: 100, tip: 'Impulse (in one step) that breaks the constraint' }) : null,
      ], { sub: true }),
      panel('ph-rbc-iter', 'Override Iterations', () => [num(c as never, 'solver_iterations', 'Iterations', { int: true, min: 1, max: 1000, disabled: !c.use_override_solver_iterations, tip: 'Solver iterations for this constraint (more: stiffer)' })], {
        sub: true,
        closed: true,
        header: headerCheck(`rbc-iter-${ob.id}`, c as never, 'use_override_solver_iterations', 'Override Iterations'),
      }),
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
    const dp = isGeom(ob) ? dpOf(ob) : undefined;
    if (dp) out.push(...dynamicPaintPanels(ob, dp));
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
modifierExtraUI.DYNAMIC_PAINT = gotoTab('PHYSICS', 'Settings are inside the Physics tab.');
modifierExtraUI.PARTICLE_SYSTEM = gotoTab('PARTICLES', 'Settings are inside the Particles tab.');
