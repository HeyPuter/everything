// Particles properties tab: particle system list, settings data-block and panels.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, enumMenu, opButton, checkbox, textField } from '../ui/widgets';
import { num, bool, enumProp, splitRow, vecProp } from '../ui/props';
import { uiList } from '../editors/properties/uilist';
import { insertTabAfter, changed, note, subHeading, objectRow, cachePanel, fieldWeightsPanel, collectionRow } from './ui-common';
import { particleCacheKey } from './particles';
import { defaultHairDynamics, defaultParticleSettings, defaultPointCache, type ObjectPhysics, type ParticleSettingsX, type ParticleSystemX } from './types';
import { hairDynKey } from './hairdyn';
import type { ModifierBase } from '../data/types';
import { BOID_RULES, defaultBoidSettings, ensureBoidStates } from './boids';
import { defaultParticleFluid } from './sph';
import { openMenu } from '../ui/menu';

function fillDefaults<T extends object>(target: T, defaults: T): T {
  const t = target as Record<string, unknown>;
  for (const [k, v] of Object.entries(defaults)) if (t[k] === undefined) t[k] = v;
  return target;
}

function settingsSelector(ps: ParticleSystemX): Child {
  const items = Object.values(app.doc.particles).map((p) => ({ value: p.id, label: p.name, icon: 'particles' }));
  const cur = app.doc.particles[ps.settings];
  const users = cur ? Object.values(app.doc.objects).reduce((n, o) => n + o.particle_systems.filter((p) => p.settings === cur.id).length, 0) : 0;
  return h(
    'div',
    { class: 'row-aligned', style: { padding: '4px 8px' } },
    enumMenu(`psys-set-${ps.settings}`, items, ps.settings, (v) => {
      ps.settings = v;
      changed('Change Particle Settings');
    }, { iconOnly: true, tip: 'Browse particle settings to be linked' }),
    cur ? textField(`psys-name-${cur.id}`, cur.name, (v) => ((cur.name = v || cur.name), changed('Rename Particle Settings'))) : null,
    users > 1 ? h('span', { class: 'prop-note', 'data-tip': 'Number of users' }, String(users)) : null,
    opButton('particle.new', '', {}, { icon: 'duplicate', tip: 'New particle settings (copy)' }),
  );
}

function emitterPanels(ob: ObjectPhysics, ps: ParticleSystemX, s: ParticleSettingsX, key: string): Child[] {
  const pc = (ps.point_cache ??= defaultPointCache(app.doc.scene.frame_start, app.doc.scene.frame_end));
  const d = pc.is_baked;
  return [
    panel('pa-emit', 'Emission', () => [
      d ? note('Particles are baked: delete the bake to change simulation settings') : null,
      num(s, 'count', 'Number', { int: true, min: 0, max: 1000000, softMax: 100000, disabled: d }),
      num(ps, 'seed', 'Seed', { int: true, min: 0, disabled: d }),
      num(s, 'frame_start', 'Frame Start', { min: -100000, max: 100000, disabled: d }),
      num(s, 'frame_end', 'End', { min: -100000, max: 100000, disabled: d }),
      num(s, 'lifetime', 'Lifetime', { min: 1, max: 100000, disabled: d }),
      num(s, 'lifetime_random', 'Lifetime Randomness', { min: 0, max: 1, slider: true, disabled: d }),
      sourcePanel(s, d),
    ]),
    panel('pa-vel', 'Velocity', () => [
      num(s, 'normal_factor', 'Normal', { min: -1000, max: 1000, softMin: -10, softMax: 10, disabled: d }),
      num(s, 'tangent_factor', 'Tangent', { min: -1000, max: 1000, softMin: -10, softMax: 10, disabled: d }),
      num(s, 'tangent_phase', 'Tangent Phase', { min: -1, max: 1, slider: true, disabled: d }),
      vecProp(s, 'object_align_factor', 'Object Aligned', { disabled: d, softMin: -10, softMax: 10 }),
      num(s, 'object_factor', 'Object Velocity', { min: -200, max: 200, softMin: -1, softMax: 1, disabled: d }),
      num(s, 'factor_random', 'Randomize', { min: 0, max: 200, softMax: 10, disabled: d }),
    ]),
    rotationPanel(s),
    panel('pa-phys', 'Physics', () => [
      enumProp(s, 'physics_type', 'Physics Type', [['NO', 'None'], ['NEWTON', 'Newtonian'], ['KEYED', 'Keyed'], ['BOIDS', 'Boids'], ['FLUID', 'Fluid']], { disabled: d }),
      s.physics_type === 'BOIDS' ? boidPanels(s, d) : null,
      s.physics_type === 'FLUID' ? fluidPanels(s, d) : null,
      s.physics_type === 'KEYED' || s.physics_type === 'BOIDS' ? relationsPanel(ob, ps, s, d) : null,
      s.physics_type === 'NEWTON' || s.physics_type === 'BOIDS' || s.physics_type === 'FLUID'
        ? [
            subHeading('Properties'),
            num(s, 'mass', 'Mass', { min: 0.001, max: 100000, disabled: d }),
            subHeading('Forces'),
            num(s, 'brownian_factor', 'Brownian', { min: 0, max: 200, softMax: 20, disabled: d }),
            num(s, 'drag_factor', 'Drag', { min: 0, max: 1, slider: true, disabled: d }),
            num(s, 'damping', 'Damp', { min: 0, max: 1, slider: true, disabled: d }),
            subHeading('Integration'),
            enumProp(s, 'integrator', 'Integrator', [['EULER', 'Euler'], ['VERLET', 'Verlet'], ['MIDPOINT', 'Midpoint'], ['RK4', 'RK4']], { disabled: d, tip: 'How motion is advanced each step: Euler is the simplest, RK4 the most accurate under changing forces' }),
            num(s, 'timestep', 'Timestep', { min: 0.0001, max: 100, softMax: 1, precision: 3, disabled: d, tip: 'Seconds of simulation per frame' }),
            num(s, 'timestep_substeps', 'Substeps', { int: true, min: 1, max: 20, disabled: d }),
            bool(s, 'use_collision', 'Collide with Collision Objects', { disabled: d }),
            subHeading('Deflection'),
            bool(s, 'use_size_deflect', 'Size Deflect', { disabled: d || s.use_collision === false }),
            bool(s, 'use_die_on_collision', 'Die on Hit', { disabled: d || s.use_collision === false }),
            collectionRow(`pa-coll-${s.id}`, s as never, 'collision_collection', 'Collision Collection', 'All colliders', d || s.use_collision === false),
          ]
        : null,
    ]),
    renderPanel(ob, s),
    displayPanel(s),
    childrenPanel(s, false),
    vertexGroupsPanel(ob, ps, false),
    fieldWeightsPanel('pa-fw', s, d),
    cachePanel('pa-cache', key, pc),
  ];
}

function renderPanel(ob: ObjectPhysics, s: ParticleSettingsX): Child {
  const hair = s.type === 'HAIR';
  const types: [string, string][] = hair ? [['NONE', 'None'], ['PATH', 'Path'], ['OBJECT', 'Object'], ['COLLECTION', 'Collection']] : [['NONE', 'None'], ['HALO', 'Halo'], ['LINE', 'Line'], ['OBJECT', 'Object'], ['COLLECTION', 'Collection']];
  return panel('pa-render', 'Render', () => [
    enumProp(s, 'render_type', 'Render As', types),
    num(s, 'material_slot', 'Material', { int: true, min: 1, max: 32767, tip: 'Material slot used for the display color' }),
    !hair || s.render_type === 'OBJECT' || s.render_type === 'COLLECTION' ? num(s, 'particle_size', 'Scale', { min: 0.001, max: 100000, softMax: 10, unit: 'distance' }) : null,
    !hair || s.render_type === 'OBJECT' || s.render_type === 'COLLECTION' ? num(s, 'size_random', 'Scale Randomness', { min: 0, max: 1, slider: true }) : null,
    s.render_type === 'LINE'
      ? panel('pa-render-line', 'Line', () => [num(s, 'line_length_tail', 'Back', { min: 0, max: 100000, softMax: 10, unit: 'distance' }), num(s, 'line_length_head', 'Front', { min: 0, max: 100000, softMax: 10, unit: 'distance' }), bool(s, 'use_velocity_length', 'Length by Speed')], { sub: true })
      : null,
    s.render_type === 'COLLECTION'
      ? panel('pa-render-coll', 'Collection', () => [
          splitRow(
            'Instance Collection',
            enumMenu(`pa-coll-${s.id}`, [{ value: '', label: '—' }, ...Object.values(app.doc.collections).filter((c) => c.id !== app.doc.scene.collection).map((c) => ({ value: c.id, label: c.name, icon: 'collection' }))], s.instance_collection ?? '', (v) => ((s.instance_collection = v || null), changed('Set Instance Collection'))),
          ),
          bool(s, 'use_whole_collection', 'Whole Collection'),
          !s.use_whole_collection ? bool(s, 'use_collection_pick_random', 'Pick Random') : null,
          bool(s, 'use_global_instance', 'Global Coordinates', { tip: "Keep the objects' offsets from the world origin" }),
          bool(s, 'use_rotation_instance', 'Object Rotation', { tip: "Keep the objects' rotations" }),
          bool(s, 'use_scale_instance', 'Object Scale'),
          !s.use_whole_collection ? useCountPanel(s) : null,
        ], { sub: true })
      : null,
    renderExtra(s),
    hair && s.render_type === 'PATH' ? renderTiming(s) : null,
    bool(s, 'use_render_emitter', 'Show Emitter', { tip: 'Render the emitter object itself (it always shows in the viewport)' }),
    s.render_type === 'OBJECT'
      ? panel('pa-render-obj', 'Object', () => [
          objectRow(`pa-inst-${s.id}`, s as never, 'instance_object', 'Instance Object', (o) => o.id !== ob.id && (o.type === 'MESH' || o.type === 'CURVE' || o.type === 'FONT')),
          bool(s, 'use_global_instance', 'Global Coordinates', { tip: "Keep the instance object's offset from the world origin" }),
          bool(s, 'use_rotation_instance', 'Object Rotation', { tip: "Keep the instance object's rotation" }),
          bool(s, 'use_scale_instance', 'Object Scale'),
        ], { sub: true })
      : null,
  ]);
}

/** Use Count: how many times each collection object appears among the instances. */
function useCountPanel(s: ParticleSettingsX): Child {
  const ws = s.instance_weights ?? [];
  const ai = Math.max(0, Math.min(s.active_instanceweight_index ?? 0, ws.length - 1));
  const w = ws[ai];
  const on = !!s.use_collection_count;
  return panel('pa-render-count', 'Use Count', () => [
    h(
      'div',
      { style: { padding: '4px 0' } },
      uiList(
        `pa-weights-${s.id}`,
        ws.map((x, i) => ({ key: `${i}`, label: `${app.doc.objects[x.object]?.name ?? x.name}: ${x.count}`, icon: 'object' })),
        ai,
        (i) => ((s.active_instanceweight_index = i), app.changed('ui')),
        {
          remove: () => app.run('particle.dupliob_remove'),
          up: () => app.run('particle.dupliob_move_up'),
          down: () => app.run('particle.dupliob_move_down'),
          extra: h('div', { class: 'row-aligned', style: { gap: '2px' } }, opButton('particle.dupliob_copy', '', {}, { icon: 'duplicate', tip: 'Copy the entry' }), opButton('particle.dupliob_refresh', '', {}, { icon: 'file_refresh', tip: 'Refresh the list from the collection' })),
        },
      ),
    ),
    w ? num(w, 'count', 'Count', { int: true, min: 0, max: 32767, disabled: !on }) : note('Refresh the list to fill it from the collection'),
  ], { sub: true, closed: true, header: checkbox(`pa-cnt-${s.id}`, '', on, (v) => ((s.use_collection_count = v), v && !ws.length && app.run('particle.dupliob_refresh'), changed('Toggle Use Count'))) });
}

function displayPanel(s: ParticleSettingsX): Child {
  const hair = s.type === 'HAIR';
  const marker = s.display_method === 'DOT' || s.display_method === 'CIRC' || s.display_method === 'CROSS' || s.display_method === 'AXIS';
  return panel('pa-display', 'Viewport Display', () => [
    enumProp(s, 'display_method', 'Display As', hair ? [['RENDER', 'Rendered'], ['DOT', 'Point'], ['NONE', 'None']] : [['RENDER', 'Rendered'], ['DOT', 'Point'], ['CIRC', 'Circle'], ['CROSS', 'Cross'], ['AXIS', 'Axis'], ['NONE', 'None']]),
    !hair ? enumProp(s, 'display_color', 'Color', [['NONE', 'None'], ['MATERIAL', 'Material'], ['VELOCITY', 'Velocity'], ['ACCELERATION', 'Acceleration']]) : null,
    !hair && (s.display_color === 'VELOCITY' || s.display_color === 'ACCELERATION') ? num(s, 'color_maximum', 'Max', { min: 0.01, max: 100, tip: 'Speed (or acceleration) shown in full red, in tens of metres per second' }) : null,
    num(s, 'display_percentage', 'Amount', { int: true, min: 0, max: 100, slider: true, tip: 'Percentage of the particles shown in the viewport' }),
    marker && !hair ? num(s, 'display_size', 'Size', { min: 0.001, max: 10, unit: 'distance' }) : null,
  ], { closed: true });
}

/** Render ▸ Extra: parents, unborn and dead particles. */
function renderExtra(s: ParticleSettingsX): Child {
  const hair = s.type === 'HAIR';
  return panel('pa-render-extra', 'Extra', () => [
    hair ? bool(s, 'use_parent_particles', 'Parent Particles', { tip: 'Render the parent strands along with their children', disabled: (s.child_type ?? 'NONE') === 'NONE' }) : null,
    !hair ? bool(s, 'show_unborn', 'Unborn', { tip: 'Show particles before they are born (at their emission point)' }) : null,
    !hair ? bool(s, 'use_dead', 'Dead', { tip: 'Show particles after they die' }) : null,
  ], { sub: true, closed: true });
}

/** Render ▸ Timing (hair paths): show part of every strand. */
function renderTiming(s: ParticleSettingsX): Child {
  const abs = !!s.use_absolute_path_time;
  return panel('pa-render-timing', 'Timing', () => [
    bool(s, 'use_absolute_path_time', 'Absolute Path Time', { tip: 'Start and end are frames (else shares of the strand length)' }),
    num(s, 'path_start', 'Start', abs ? { min: -100000, max: 100000 } : { min: 0, max: 1, slider: true }),
    num(s, 'path_end', 'End', abs ? { min: -100000, max: 100000 } : { min: 0, max: 1, slider: true }),
    num(s, 'length_random', 'Random', { min: 0, max: 1, slider: true, tip: 'Shorten strands at random' }),
  ], { sub: true, closed: true });
}

function hairPanels(ob: ObjectPhysics, ps: ParticleSystemX, s: ParticleSettingsX, m?: ModifierBase): Child[] {
  const edited = !!ps.edited_hair;
  return [
    h(
      'div',
      { class: 'row-aligned', style: { padding: '2px 8px 6px', gap: '4px' } },
      edited ? opButton('particle.edited_clear', 'Free Edit', {}, { tip: 'The hair was edited by hand: drop the edits and grow it from the settings again' }) : null,
      opButton('curves.convert_from_particle_system', 'Convert to Curves', {}, { tip: 'Add a hair curves object made from this hair' }),
    ),
    h(
      'div',
      { class: 'row-aligned', style: { padding: '0 8px 6px', gap: '4px' } },
      ps.hair_binding ? note('Connected: the hair follows the emitter surface') : edited ? note(ps.hair_disconnected ? 'Disconnected from the emitter' : 'Edited hair stays where it was combed') : null,
      opButton('particle.connect_hair', 'Connect', {}, { tip: 'Attach the hair to the emitter surface so it follows deformations' }),
      opButton('particle.disconnect_hair', 'Disconnect', {}, { tip: 'Detach the hair from the emitter surface' }),
    ),
    panel('pa-emit', 'Emission', () => [
      edited ? note('The hair was edited in Particle Edit mode, so its number and length come from the edits') : null,
      num(s, 'count', 'Number', { int: true, min: 0, max: 1000000, softMax: 100000, disabled: edited }),
      num(ps, 'seed', 'Seed', { int: true, min: 0 }),
      num(s, 'hair_length', 'Hair Length', { min: 0, max: 1000, unit: 'distance', disabled: edited }),
      num(s, 'hair_step', 'Segments', { int: true, min: 1, max: 50 }),
      sourcePanel(s, edited),
    ]),
    panel('pa-vel', 'Velocity', () => [
      note('Hair grows along the emission velocity direction.'),
      num(s, 'normal_factor', 'Normal', { min: -1000, max: 1000, softMin: -10, softMax: 10 }),
      vecProp(s, 'object_align_factor', 'Object Aligned', { softMin: -10, softMax: 10 }),
      num(s, 'factor_random', 'Randomize', { min: 0, max: 200, softMax: 10 }),
    ], { closed: true }),
    panel('pa-rot', 'Rotation', () => [note('Instanced objects align their X axis with the hair direction.')], { header: checkbox(`pa-rot-${s.id}`, '', !!s.use_rotations, (v) => ((s.use_rotations = v), changed('Toggle Rotation'))), closed: true }),
    renderPanel(ob, s),
    displayPanel(s),
    vertexGroupsPanel(ob, ps, true),
    hairDynamicsPanel(ob, ps, m),
    childrenPanel(s, true),
    pathPanel(s),
    hairShapePanel(s),
  ];
}

function hairDynamicsPanel(ob: ObjectPhysics, ps: ParticleSystemX, m: ModifierBase | undefined): Child {
  const dyn = (ps.hair_dynamics ??= defaultHairDynamics());
  for (const [k, v] of Object.entries(defaultHairDynamics())) if ((dyn as unknown as Record<string, unknown>)[k] === undefined) (dyn as unknown as Record<string, unknown>)[k] = v;
  const pc = (ps.point_cache ??= defaultPointCache(app.doc.scene.frame_start, app.doc.scene.frame_end));
  const on = !!ps.use_hair_dynamics;
  const d = pc.is_baked || !on;
  return panel('pa-hairdyn', 'Hair Dynamics', () => [
    num(dyn, 'quality', 'Quality Steps', { int: true, min: 1, max: 50, disabled: d }),
    num(dyn, 'pin_stiffness', 'Pin Goal Strength', { min: 0, max: 0.999, slider: true, disabled: d }),
    panel('pa-hairdyn-struct', 'Structure', () => [
      num(dyn, 'mass', 'Vertex Mass', { min: 0.001, max: 10, disabled: d }),
      num(dyn, 'bending_stiffness', 'Stiffness', { min: 0, max: 10000, softMax: 50, disabled: d }),
      num(dyn, 'bending_damping', 'Damping', { min: 0, max: 50, disabled: d }),
    ], { sub: true }),
    panel('pa-hairdyn-vol', 'Volume', () => [num(dyn, 'air_damping', 'Air Drag', { min: 0, max: 10, disabled: d })], { sub: true }),
    panel('pa-hairdyn-col', 'Collisions', () => [num(dyn, 'collision_distance', 'Distance', { min: 0.001, max: 1, unit: 'distance', disabled: d || !dyn.use_collision })], {
      sub: true,
      header: checkbox(`pa-hd-col-${ob.id}`, '', !!dyn.use_collision, (v) => ((dyn.use_collision = v), changed('Toggle Hair Collisions'))),
    }),
    m ? cachePanel('pa-hairdyn-cache', hairDynKey(ob, m), pc) : null,
  ], { header: checkbox(`pa-hd-${ob.id}`, '', on, (v) => ((ps.use_hair_dynamics = v), changed('Toggle Hair Dynamics'))), closed: !on });
}

/** Vertex groups shaping the particle system (density, hair length, size, velocity). */
function vertexGroupsPanel(ob: ObjectPhysics, ps: ParticleSystemX, hair: boolean): Child {
  const me = ob.data ? app.doc.meshes[ob.data] : undefined;
  const groups = [{ value: '', label: '—' }, ...(me?.vertex_groups ?? []).map((g) => ({ value: g.name, label: g.name, icon: 'group_vertex' }))];
  const row = (kind: 'density' | 'length' | 'size' | 'velocity', label: string) => {
    const key = `vertex_group_${kind}` as const,
      inv = `invert_vertex_group_${kind}` as const;
    return splitRow(
      label,
      h(
        'div',
        { style: { display: 'flex', gap: '4px', alignItems: 'center', minWidth: '0' } },
        h('div', { style: { flex: '1', minWidth: '0', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } }, enumMenu(`psvg-${kind}-${ob.id}`, groups, ps[key] ?? '', (v) => ((ps[key] = v), changed(`Set ${label} Group`)))),
        h('button', { class: { tbtn: true, on: !!ps[inv] }, 'data-tip': 'Invert the weights', onclick: () => ((ps[inv] = !ps[inv]), changed(`Invert ${label} Group`)) }, '⇄'),
      ),
    );
  };
  return panel('pa-vgroups', 'Vertex Groups', () => [row('density', 'Density'), hair ? row('length', 'Length') : null, !hair ? row('size', 'Size') : null, !hair ? row('velocity', 'Velocity') : null], { closed: true });
}

function rotationPanel(s: ParticleSettingsX): Child {
  const on = !!s.use_rotations;
  return panel('pa-rot', 'Rotation', () => [
    enumProp(s, 'rotation_mode', 'Orientation Axis', [['NONE', 'None'], ['NOR', 'Normal'], ['VEL', 'Velocity / Hair'], ['GLOB_X', 'Global X'], ['GLOB_Y', 'Global Y'], ['GLOB_Z', 'Global Z'], ['OB_X', 'Object X'], ['OB_Y', 'Object Y'], ['OB_Z', 'Object Z']], { disabled: !on }),
    num(s, 'rotation_factor_random', 'Randomize', { min: 0, max: 1, slider: true, disabled: !on }),
    num(s, 'phase_factor', 'Phase', { min: -1, max: 1, slider: true, disabled: !on }),
    num(s, 'phase_factor_random', 'Randomize Phase', { min: 0, max: 2, slider: true, disabled: !on }),
    panel('pa-rot-av', 'Angular Velocity', () => [
      enumProp(s, 'angular_velocity_mode', 'Axis', [['NONE', 'None'], ['VELOCITY', 'Velocity'], ['HORIZONTAL', 'Horizontal'], ['VERTICAL', 'Vertical'], ['GLOBAL_X', 'Global X'], ['GLOBAL_Y', 'Global Y'], ['GLOBAL_Z', 'Global Z'], ['RAND', 'Random']], { disabled: !on }),
      num(s, 'angular_velocity_factor', 'Amount', { min: -200, max: 200, softMin: -10, softMax: 10, disabled: !on || (s.angular_velocity_mode ?? 'NONE') === 'NONE' }),
    ], { sub: true }),
  ], { header: checkbox(`pa-rot-${s.id}`, '', on, (v) => ((s.use_rotations = v), changed('Toggle Rotation'))), closed: true });
}

function boidPanels(s: ParticleSettingsX, d: boolean): Child {
  const b = (s.boids ??= defaultBoidSettings());
  for (const [k, v] of Object.entries(defaultBoidSettings())) if ((b as unknown as Record<string, unknown>)[k] === undefined) (b as unknown as Record<string, unknown>)[k] = v;
  const states = ensureBoidStates(b);
  const si = Math.max(0, Math.min(b.active_boid_state_index ?? 0, states.length - 1));
  const st = states[si];
  const ai = Math.max(0, Math.min(st.active_boid_rule_index, st.rules.length - 1));
  const rule = st.rules[ai];
  const ruleObject = (label: string) =>
    splitRow(label, enumMenu(`boid-ob-${s.id}-${si}-${ai}`, [{ value: '', label: '—' }, ...Object.values(app.doc.objects).map((o) => ({ value: o.id, label: o.name, icon: 'object' }))], rule?.object ?? '', (v) => ((rule!.object = v || null), changed('Set Rule Object'))));
  const flight = b.use_flight !== false,
    land = !!b.use_land;
  const toggle = (key: 'use_flight' | 'use_land' | 'use_climb', label: string, dis = false) =>
    h('button', { key, class: { tbtn: true, on: key === 'use_flight' ? flight : !!b[key] }, disabled: d || dis, style: { flex: '1' }, onclick: () => ((b[key] = !(key === 'use_flight' ? flight : !!b[key])), changed(`Toggle ${label}`)) }, label);
  return [
    panel('pa-boid-move', 'Movement', () => [
      h('div', { class: 'row-aligned', style: { padding: '2px 8px', gap: '2px' } }, toggle('use_flight', 'Allow Flight'), toggle('use_land', 'Allow Land'), toggle('use_climb', 'Allow Climbing', !land)),
      subHeading('Air'),
      num(b, 'air_speed_max', 'Max Speed', { min: 0, max: 100, unit: 'distance', disabled: d || !flight }),
      num(b, 'air_speed_min', 'Min Speed', { min: 0, max: 1, slider: true, disabled: d || !flight, tip: 'Lowest flying speed, as a share of the max speed' }),
      num(b, 'air_acc_max', 'Max Acceleration', { min: 0, max: 1, slider: true, disabled: d || !flight }),
      num(b, 'air_ave_max', 'Max Angular Velocity', { min: 0, max: 1, slider: true, disabled: d || !flight }),
      num(b, 'air_personal_space', 'Personal Space', { min: 0, max: 10, unit: 'distance', disabled: d || !flight }),
      subHeading('Land'),
      num(b, 'land_speed_max', 'Max Speed', { min: 0, max: 100, unit: 'distance', disabled: d || !land }),
      num(b, 'land_jump_speed', 'Jump Speed', { min: 0, max: 100, disabled: d || !land, tip: 'Upward speed of a jump when the rules pull upwards (0: no jumping)' }),
      num(b, 'land_acc_max', 'Max Acceleration', { min: 0, max: 1, slider: true, disabled: d || !land }),
      num(b, 'land_ave_max', 'Max Angular Velocity', { min: 0, max: 1, slider: true, disabled: d || !land }),
      num(b, 'land_personal_space', 'Personal Space', { min: 0, max: 10, unit: 'distance', disabled: d || !land }),
      num(b, 'land_stick_force', 'Stick Force', { min: 0, max: 1000, softMax: 10, disabled: d || !land || !b.use_climb, tip: 'How strongly climbing boids hold on to their surface' }),
      subHeading('Neighbors'),
      num(b, 'range', 'Neighbor Range', { min: 0.01, max: 100, unit: 'distance', disabled: d, tip: 'Other boids further than this are ignored (also the attack range)' }),
    ], { sub: true }),
    panel('pa-boid-battle', 'Battle', () => [
      num(b, 'health', 'Health', { min: 0, max: 100, disabled: d, tip: 'Damage a boid takes before it dies' }),
      num(b, 'strength', 'Attack Strength', { min: 0, max: 100, disabled: d, tip: 'Damage per second dealt to enemies within the neighbor range' }),
      num(b, 'aggression', 'Aggression', { min: 0, max: 100, disabled: d, tip: 'Fight even when outnumbered this many times' }),
      num(b, 'accuracy', 'Accuracy', { min: 0, max: 1, slider: true, disabled: d }),
      note('Enemies are the boids of target systems set to Enemy (Relations).'),
    ], { sub: true, closed: true }),
    panel('pa-boid-brain', 'Boid Brain', () => [
      h(
            'div',
            { style: { padding: '4px 0' } },
            uiList(
              `boid-states-${s.id}`,
              states.map((x, i) => ({ key: `${i}`, label: x.name, icon: si === i ? 'checkbox_hlt' : 'checkbox_dehlt' })),
              si,
              (i) => ((b.active_boid_state_index = i), changed('Set Boid State')),
              {
                add: () => app.run('boid.state_add'),
                remove: () => app.run('boid.state_del'),
                up: () => app.run('boid.state_move_up'),
                down: () => app.run('boid.state_move_down'),
                rename: (i, name) => ((states[i].name = name || states[i].name), changed('Rename Boid State')),
                rows: 2,
              },
            ),
          ),
      h(
        'div',
        { style: { padding: '4px 0' } },
        uiList(
          `boid-rules-${s.id}-${si}`,
          st.rules.map((r, i) => ({ key: `${i}`, label: r.name, icon: 'particles' })),
          ai,
          (i) => ((st.active_boid_rule_index = i), app.changed('ui')),
          {
            add: () => {
              const btn = document.activeElement as HTMLElement | null;
              openMenu(
                BOID_RULES.map(([t, l]) => ({ label: l, op: 'boid.rule_add', props: { type: t } })),
                btn ?? { x: app.pointer.x, y: app.pointer.y },
              );
            },
            remove: () => app.run('boid.rule_del'),
            up: () => app.run('boid.rule_move_up'),
            down: () => app.run('boid.rule_move_down'),
            rename: (i, name) => ((st.rules[i].name = name || st.rules[i].name), changed('Rename Boid Rule')),
          },
        ),
      ),
      enumProp(st, 'ruleset_type', 'Rule Evaluation', [['FUZZY', 'Fuzzy'], ['RANDOM', 'Random'], ['AVERAGE', 'Average']], { disabled: d }),
      st.ruleset_type === 'FUZZY' ? num(st, 'rule_fuzzy', 'Rule Fuzziness', { min: 0, max: 1, slider: true, disabled: d }) : null,
      rule
        ? [
            subHeading(BOID_RULES.find(([t]) => t === rule.type)?.[1] ?? rule.type),
            bool(rule, 'use_in_air', 'In Air', { disabled: d }),
            bool(rule, 'use_on_land', 'On Land', { disabled: d }),
            rule.type === 'GOAL' || rule.type === 'AVOID' || (rule.type === 'FOLLOW_LEADER' && !rule.use_line) ? ruleObject('Object') : null,
            rule.type === 'GOAL' || rule.type === 'AVOID' ? bool(rule, 'use_predict', 'Predict', { disabled: d }) : null,
            (rule.type === 'GOAL' || rule.type === 'AVOID') && !rule.object ? note(rule.type === 'GOAL' ? 'Without an object the boids chase enemy boids' : 'Without an object the boids flee from enemy boids') : null,
            rule.type === 'AVOID' ? num(rule, 'fear_factor', 'Fear Factor', { min: 0, max: 100, disabled: d }) : null,
            rule.type === 'AVOID_COLLISION' ? [bool(rule, 'use_avoid', 'Boids', { disabled: d }), bool(rule, 'use_avoid_collision', 'Deflectors', { disabled: d }), num(rule, 'look_ahead', 'Look Ahead', { min: 0, max: 100, disabled: d, tip: 'Seconds ahead to look for collisions' })] : null,
            rule.type === 'FOLLOW_LEADER' ? [num(rule, 'distance', 'Distance', { min: 0, max: 100, unit: 'distance', disabled: d }), bool(rule, 'use_line', 'Line', { disabled: d, tip: 'Follow the previous boid instead of the leader object' }), rule.use_line ? num(rule, 'queue_count', 'Queue Size', { int: true, min: 0, max: 100, disabled: d, tip: 'Boids per line (0: one line)' }) : null] : null,
            rule.type === 'AVERAGE_SPEED' ? [num(rule, 'speed', 'Speed', { min: 0, max: 1, slider: true, disabled: d }), num(rule, 'wander', 'Wander', { min: 0, max: 1, slider: true, disabled: d }), num(rule, 'level', 'Level', { min: 0, max: 1, slider: true, disabled: d })] : null,
            rule.type === 'FIGHT' ? [num(rule, 'distance', 'Fight Distance', { min: 0, max: 100, unit: 'distance', disabled: d }), num(rule, 'flee_distance', 'Flee Distance', { min: 0, max: 100, unit: 'distance', disabled: d })] : null,
          ]
        : null,
    ], { sub: true }),
    panel('pa-boid-misc', 'Misc', () => [
      num(b, 'bank', 'Banking', { min: 0, max: 2, slider: true, tip: 'Instanced boids roll into their turns' }),
      num(b, 'pitch', 'Pitch', { min: 0, max: 2, slider: true, tip: 'Instanced boids tilt up and down with their flight path' }),
      num(b, 'height', 'Height', { min: 0, max: 2, slider: true, tip: 'Walking boids are lifted by this share of their size' }),
    ], { sub: true, closed: true }),
  ];
}

function fluidPanels(s: ParticleSettingsX, d: boolean): Child {
  const f = (s.fluid ??= defaultParticleFluid());
  for (const [k, v] of Object.entries(defaultParticleFluid())) if ((f as unknown as Record<string, unknown>)[k] === undefined) (f as unknown as Record<string, unknown>)[k] = v;
  return panel('pa-fluid', 'Fluid Interaction', () => [
    num(f, 'fluid_radius', 'Interaction Radius', { min: 0.001, max: 10, unit: 'distance', disabled: d }),
    num(f, 'stiffness', 'Stiffness', { min: 0, max: 1000, softMax: 10, disabled: d }),
    num(f, 'stiffness_near', 'Repulsion Factor', { min: 0, max: 100, softMax: 10, disabled: d }),
    num(f, 'rest_density', 'Rest Density', { min: 0, max: 10000, softMax: 10, disabled: d }),
    num(f, 'linear_viscosity', 'Viscosity', { min: 0, max: 100, softMax: 10, disabled: d }),
    num(f, 'square_viscosity', 'Quadratic Viscosity', { min: 0, max: 100, softMax: 10, disabled: d }),
  ], { sub: true });
}

/** Targets of the particle system: keyed path keys or boid relations (friends / enemies). */
function relationsPanel(ob: ObjectPhysics, ps: ParticleSystemX, s: ParticleSettingsX, d: boolean): Child {
  // older files kept keyed targets on the settings
  if (!ps.targets) ps.targets = (s.keyed_targets ?? []).map((t) => ({ ...t }));
  const ts = ps.targets;
  const ai = Math.max(0, Math.min(ps.active_particle_target_index ?? 0, ts.length - 1));
  const t = ts[ai];
  const tob = t?.object ? app.doc.objects[t.object] : undefined;
  const keyed = s.physics_type === 'KEYED';
  const label = (x: (typeof ts)[number]) => {
    const o = x.object ? app.doc.objects[x.object] : undefined;
    const sys = o?.particle_systems[(x.system || 1) - 1];
    return o && sys ? `${o.name}: ${sys.name}` : x.object ? 'Invalid target!' : `${ob.name}: (choose a target)`;
  };
  return panel('pa-relations', 'Relations', () => [
    keyed ? num(s, 'keyed_loops', 'Loops', { int: true, min: 1, max: 10000, disabled: d || !!ps.use_keyed_timing }) : null,
    h(
      'div',
      { style: { padding: '4px 0' } },
      uiList(
        `targets-${ob.id}-${ps.name}`,
        ts.map((x, i) => ({ key: `${i}`, label: label(x), icon: 'particles', right: !keyed ? h('span', { class: 'prop-note' }, (x.alliance ?? 'NEUTRAL').toLowerCase()) : null })),
        ai,
        (i) => ((ps.active_particle_target_index = i), app.changed('ui')),
        { add: () => app.run('particle.new_target'), remove: () => app.run('particle.target_remove'), up: () => app.run('particle.target_move_up'), down: () => app.run('particle.target_move_down') },
      ),
    ),
    t
      ? [
          splitRow('Object', enumMenu(`target-ob-${ob.id}-${ai}`, [{ value: '', label: '—' }, ...Object.values(app.doc.objects).filter((o) => o.particle_systems.length).map((o) => ({ value: o.id, label: o.name, icon: 'object' }))], t.object ?? '', (v) => ((t.object = v || null), changed('Set Target Object')))),
          tob ? num(t, 'system', 'System', { int: true, min: 1, max: Math.max(1, tob.particle_systems.length), disabled: d }) : null,
          !keyed ? enumProp(t, 'alliance', 'Mode', [['FRIEND', 'Friend'], ['NEUTRAL', 'Neutral'], ['ENEMY', 'Enemy']], { disabled: d }) : null,
          keyed && ps.use_keyed_timing ? [num(t, 'time', 'Time', { min: 0, max: 1048574, disabled: d, tip: 'Frames after birth when the particle reaches this target' }), num(t, 'duration', 'Duration', { min: 0, max: 1048574, disabled: d, tip: 'Frames the particle stays at this target' })] : null,
        ]
      : null,
    keyed ? bool(ps, 'use_keyed_timing', 'Use Timing', { disabled: d, tip: 'Use the times and durations of the targets instead of spreading them over the lifetime' }) : null,
  ], { sub: true });
}


/** Source sub panel: where the particles start and how they spread over the emitter. */
function sourcePanel(s: ParticleSettingsX, d: boolean): Child {
  const faces = s.emit_from !== 'VERT';
  const dist = s.distribution ?? 'JIT';
  return panel('pa-source', 'Source', () => [
    enumProp(s, 'emit_from', 'Emit From', [['VERT', 'Vertices'], ['FACE', 'Faces'], ['VOLUME', 'Volume']], { disabled: d }),
    faces ? enumProp(s, 'distribution', 'Distribution', [['JIT', 'Jittered'], ['RAND', 'Random'], ['GRID', 'Grid']], { disabled: d }) : null,
    dist !== 'GRID' || !faces ? bool(s, 'use_emit_random', 'Random Order', { disabled: d, tip: 'Emit in random order (else face by face)' }) : null,
    faces && dist !== 'GRID' ? bool(s, 'use_even_distribution', 'Even Distribution', { disabled: d, tip: 'Spread by face area (else every face gets the same share)' }) : null,
    faces && dist === 'JIT' ? [num(s, 'userjit', 'Particles/Face', { int: true, min: 0, max: 1000, disabled: d, tip: 'Places in the jitter pattern per face (0: automatic)' }), num(s, 'jitter_factor', 'Jittering Amount', { min: 0, max: 2, slider: true, disabled: d })] : null,
    faces && dist === 'GRID'
      ? [
          num(s, 'grid_resolution', 'Resolution', { int: true, min: 1, max: 250, disabled: d, tip: 'Grid cells along the longest side (sets the number of particles)' }),
          num(s, 'grid_random', 'Random', { min: 0, max: 1, slider: true, disabled: d }),
          bool(s, 'hexagonal_grid', 'Hexagonal', { disabled: d }),
          s.emit_from === 'VOLUME' ? bool(s, 'invert_grid', 'Invert Grid', { disabled: d, tip: 'Fill the outside of the volume instead' }) : null,
        ]
      : null,
  ], { sub: true });
}

/** Children panel (simple for emitters; simple or interpolated with clumping, kink, parting and roughness for hair). */
function childrenPanel(s: ParticleSettingsX, hair: boolean): Child {
  const types: ('NONE' | 'SIMPLE' | 'INTERPOLATED')[] = hair ? ['NONE', 'SIMPLE', 'INTERPOLATED'] : ['NONE', 'SIMPLE'];
  const t = s.child_type ?? 'NONE';
  const kink = s.kink ?? 'NO';
  return panel('pa-children', 'Children', () => [
    h('div', { class: 'enum-row', style: { margin: '2px 8px' } }, types.map((x) => h('button', { key: x, class: { on: t === x }, onclick: () => ((s.child_type = x), changed('Child Type')) }, x === 'NONE' ? 'None' : x === 'SIMPLE' ? 'Simple' : 'Interpolated'))),
    t === 'NONE'
      ? null
      : [
          num(s, (hair ? 'child_percent' : 'child_nbr') as never, 'Display Amount', { int: true, min: 0, max: 100000, softMax: 100, tip: 'Children per parent in the viewport' }),
          num(s, 'rendered_child_count', 'Render Amount', { int: true, min: 0, max: 100000, softMax: 1000, tip: 'Children per parent in renders' }),
          !hair
            ? [num(s, 'child_radius', 'Radius', { min: 0, max: 100000, softMax: 10, unit: 'distance' }), num(s, 'child_size', 'Size', { min: 0.01, max: 100000, softMax: 10 }), num(s, 'child_size_random', 'Randomize Size', { min: 0, max: 1, slider: true })]
            : [
                num(s, 'child_length', 'Length', { min: 0, max: 1, slider: true, tip: 'Length of the shortened children' }),
                num(s, 'child_length_threshold', 'Threshold', { min: 0, max: 1, slider: true, tip: 'Share of the children that keep their full length' }),
                num(s, 'child_seed', 'Seed', { int: true, min: 0 }),
                t === 'SIMPLE' ? [num(s, 'child_radius', 'Radius', { min: 0, max: 100000, softMax: 10, unit: 'distance' }), num(s, 'child_roundness', 'Roundness', { min: 0, max: 1, slider: true, tip: 'Spread children into a ball around the parent instead of a disc' })] : null,
                t === 'INTERPOLATED' ? num(s, 'virtual_parents', 'Virtual Parents', { min: 0, max: 1, slider: true, tip: 'Share of the children others clump to' }) : null,
                panel('pa-ch-clump', 'Clumping', () => [
                  num(s, 'clump_factor', 'Clump', { min: -1, max: 1, slider: true, tip: 'Pull the children to their parent (negative: spread them out)' }),
                  num(s, 'clump_shape', 'Shape', { min: -0.999, max: 0.999, slider: true }),
                  bool(s, 'use_clump_noise', 'Clump Noise'),
                  s.use_clump_noise ? num(s, 'clump_noise_size', 'Clump Noise Size', { min: 0.00001, max: 100000, softMax: 10 }) : null,
                ], { sub: true }),
                panel('pa-ch-kink', 'Kink', () => [
                  enumProp(s, 'kink', 'Kink Type', [['NO', 'Nothing'], ['CURL', 'Curl'], ['RADIAL', 'Radial'], ['WAVE', 'Wave'], ['BRAID', 'Braid'], ['SPIRAL', 'Spiral']]),
                  kink !== 'NO'
                    ? [
                        num(s, 'kink_amplitude', 'Amplitude', { min: -100000, max: 100000, softMin: -1, softMax: 1, unit: 'distance' }),
                        num(s, 'kink_amplitude_clump', 'Clump', { min: 0, max: 1, slider: true, tip: 'How much clumping reduces the amplitude' }),
                        num(s, 'kink_flat', 'Flatness', { min: 0, max: 1, slider: true }),
                        num(s, 'kink_frequency', 'Frequency', { min: -100000, max: 100000, softMin: -10, softMax: 10, tip: 'Kinks along the hair' }),
                        num(s, 'kink_shape', 'Shape', { min: -0.999, max: 0.999, slider: true }),
                        num(s, 'kink_amplitude_random', 'Amplitude Random', { min: 0, max: 1, slider: true }),
                        kink === 'WAVE' ? [enumProp(s, 'kink_axis', 'Axis', [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']]), num(s, 'kink_axis_random', 'Axis Random', { min: 0, max: 1, slider: true })] : null,
                      ]
                    : null,
                ], { sub: true, closed: true }),
                t === 'INTERPOLATED'
                  ? panel('pa-ch-part', 'Parting', () => [
                      num(s, 'child_parting_factor', 'Parting', { min: 0, max: 1, slider: true, tip: 'Children keep to one parent where parents point different ways' }),
                      num(s, 'child_parting_min', 'Min', { min: 0, max: 180, tip: 'Angle between parents (degrees) where parting starts' }),
                      num(s, 'child_parting_max', 'Max', { min: 0, max: 180, tip: 'Angle where parting is complete' }),
                    ], { sub: true, closed: true })
                  : null,
                panel('pa-ch-rough', 'Roughness', () => [
                  num(s, 'roughness_1', 'Uniform', { min: 0, max: 100000, softMax: 1 }),
                  num(s, 'roughness_1_size', 'Size', { min: 0.01, max: 100000, softMax: 10 }),
                  num(s, 'roughness_endpoint', 'Endpoint', { min: 0, max: 100000, softMax: 1 }),
                  num(s, 'roughness_end_shape', 'Shape', { min: 0, max: 10 }),
                  num(s, 'roughness_2', 'Random', { min: 0, max: 100000, softMax: 1 }),
                  num(s, 'roughness_2_size', 'Size', { min: 0.01, max: 100000, softMax: 10 }),
                  num(s, 'roughness_2_threshold', 'Threshold', { min: 0, max: 1, slider: true, tip: 'Share of the children without random roughness' }),
                ], { sub: true, closed: true }),
              ],
        ],
  ], { closed: t === 'NONE' });
}

/** Path panel (hair): smoothing and subdivision of the displayed and rendered strands. */
function pathPanel(s: ParticleSettingsX): Child {
  return panel('pa-path', 'Path', () => [
    bool(s, 'use_hair_bspline', 'B-Spline', { tip: 'Smooth the strands between their keys' }),
    num(s, 'display_step', 'Steps', { int: true, min: 0, max: 10, tip: 'Viewport subdivisions per segment (2^steps)' }),
    num(s, 'render_step', 'Render Steps', { int: true, min: 0, max: 20, tip: 'Subdivisions per segment in renders (2^steps)' }),
  ], { closed: true });
}

/** Hair Shape panel: thickness of the rendered strands. */
function hairShapePanel(s: ParticleSettingsX): Child {
  return panel('pa-hairshape', 'Hair Shape', () => [
    num(s, 'shape', 'Strand Shape', { min: -1, max: 1, slider: true, tip: 'How the thickness changes from root to tip' }),
    num(s, 'root_radius', 'Diameter Root', { min: 0, max: 1000, softMax: 10 }),
    num(s, 'tip_radius', 'Tip', { min: 0, max: 1000, softMax: 10 }),
    num(s, 'radius_scale', 'Scaling', { min: 0, max: 1000, softMax: 1, unit: 'distance', tip: 'Diameters are multiplied by this' }),
    bool(s, 'use_close_tip', 'Close Tip'),
  ], { closed: true });
}

insertTabAfter('CONSTRAINT', {
  id: 'PARTICLES',
  label: 'Particles',
  icon: 'particles',
  group: 3,
  poll: () => app.activeObject?.type === 'MESH',
  draw: () => {
    const ob = app.activeObject as ObjectPhysics;
    const systems = ob.particle_systems as ParticleSystemX[];
    const ai = Math.min(Math.max(0, ob.active_particle_system_index ?? 0), Math.max(0, systems.length - 1));
    const out: Child[] = [
      h(
        'div',
        { style: { padding: '4px 8px' } },
        uiList(
          `psys-${ob.id}`,
          systems.map((p, i) => ({ key: `${i}`, label: p.name, icon: 'particles' })),
          ai,
          (i) => {
            ob.active_particle_system_index = i;
            app.changed('ui');
          },
          {
            add: () => app.run('object.particle_system_add'),
            remove: () => app.run('object.particle_system_remove'),
            specials: () => [
              { label: 'Copy Active to Selected Objects', op: 'particle.copy_particle_systems', props: { use_active: true } },
              { label: 'Copy All to Selected Objects', op: 'particle.copy_particle_systems', props: { use_active: false } },
              { separator: true },
              { label: 'Duplicate Particle System', op: 'particle.duplicate_particle_system' },
              { label: 'Remove All Particle Systems', op: 'particle.particle_system_remove_all' },
            ],
            rename: (i, name) => {
              const p = systems[i];
              const m = ob.modifiers.find((x) => x.type === 'PARTICLE_SYSTEM' && x.particle_system === (p as { id?: string }).id);
              p.name = name;
              if (m) m.name = name;
              changed('Rename Particle System');
            },
          },
        ),
      ),
    ];
    const ps = systems[ai];
    if (!ps) return out;
    out.push(settingsSelector(ps));
    const raw = app.doc.particles[ps.settings] as ParticleSettingsX | undefined;
    if (!raw) {
      out.push(note('This particle system has no settings', 'error'), h('div', { style: { padding: '4px 8px' } }, opButton('particle.new', 'New')));
      return out;
    }
    const s = fillDefaults(raw, defaultParticleSettings(raw.id, raw.name));
    const m = ob.modifiers.find((x) => x.type === 'PARTICLE_SYSTEM' && x.particle_system === (ps as { id?: string }).id);
    if (!m) out.push(note('The particle system modifier was removed', 'error'), h('div', { style: { padding: '0 8px 6px' } }, opButton('object.particle_system_modifier_restore', 'Restore Modifier')));
    out.push(
      splitRow(
        'Type',
        h(
          'div',
          { class: 'enum-row' },
          (['EMITTER', 'HAIR'] as const).map((t) =>
            h(
              'button',
              {
                key: t,
                class: { on: s.type === t },
                onclick: () => {
                  if (s.type === t) return;
                  s.type = t;
                  if (t === 'HAIR' && s.render_type === 'HALO') s.render_type = 'PATH';
                  if (t === 'EMITTER' && s.render_type === 'PATH') s.render_type = 'HALO';
                  if (t === 'HAIR' && s.count > 5000) s.count = 1000;
                  changed('Particle Type');
                },
              },
              t === 'EMITTER' ? 'Emitter' : 'Hair',
            ),
          ),
        ),
      ),
    );
    if (m) out.push(...(s.type === 'HAIR' ? hairPanels(ob, ps, s, m) : emitterPanels(ob, ps, s, particleCacheKey(ob, m))));
    return out;
  },
});
