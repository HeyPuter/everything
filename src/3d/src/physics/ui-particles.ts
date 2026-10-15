// Particles properties tab: particle system list, settings data-block and panels.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, enumMenu, opButton, checkbox, textField } from '../ui/widgets';
import { num, bool, enumProp, splitRow, vecProp } from '../ui/props';
import { uiList } from '../editors/properties/uilist';
import { insertTabAfter, changed, note, subHeading, objectRow, cachePanel, fieldWeightsPanel } from './ui-common';
import { particleCacheKey } from './particles';
import { defaultHairDynamics, defaultParticleSettings, defaultPointCache, type ObjectPhysics, type ParticleSettingsX, type ParticleSystemX } from './types';
import { hairDynKey } from './hairdyn';
import type { ModifierBase } from '../data/types';
import { BOID_RULES, defaultBoidSettings, newBoidRule } from './boids';
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
      panel('pa-source', 'Source', () => [enumProp(s, 'emit_from', 'Emit From', [['VERT', 'Verts'], ['FACE', 'Faces'], ['VOLUME', 'Volume']], { disabled: d })], { sub: true }),
    ]),
    panel('pa-vel', 'Velocity', () => [
      num(s, 'normal_factor', 'Normal', { min: -1000, max: 1000, softMin: -10, softMax: 10, disabled: d }),
      vecProp(s, 'object_align_factor', 'Object Aligned', { disabled: d, softMin: -10, softMax: 10 }),
      num(s, 'object_factor', 'Object Velocity', { min: -200, max: 200, softMin: -1, softMax: 1, disabled: d }),
      num(s, 'factor_random', 'Randomize', { min: 0, max: 200, softMax: 10, disabled: d }),
    ]),
    rotationPanel(s),
    panel('pa-phys', 'Physics', () => [
      enumProp(s, 'physics_type', 'Physics Type', [['NO', 'None'], ['NEWTON', 'Newtonian'], ['KEYED', 'Keyed'], ['BOIDS', 'Boids'], ['FLUID', 'Fluid']], { disabled: d }),
      s.physics_type === 'BOIDS' ? boidPanels(s, d) : null,
      s.physics_type === 'FLUID' ? fluidPanels(s, d) : null,
      s.physics_type === 'KEYED' ? keyedPanels(ob, s, d) : null,
      s.physics_type === 'NEWTON' || s.physics_type === 'BOIDS' || s.physics_type === 'FLUID'
        ? [
            subHeading('Properties'),
            num(s, 'mass', 'Mass', { min: 0.001, max: 100000, disabled: d }),
            subHeading('Forces'),
            num(s, 'brownian_factor', 'Brownian', { min: 0, max: 200, softMax: 20, disabled: d }),
            num(s, 'drag_factor', 'Drag', { min: 0, max: 1, slider: true, disabled: d }),
            num(s, 'damping', 'Damp', { min: 0, max: 1, slider: true, disabled: d }),
            subHeading('Integration'),
            num(s, 'timestep_substeps', 'Substeps', { int: true, min: 1, max: 20, disabled: d }),
            bool(s, 'use_collision', 'Collide with Collision Objects', { disabled: d }),
          ]
        : null,
    ]),
    renderPanel(ob, s),
    displayPanel(s),
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
          bool(s, 'use_scale_instance', 'Object Scale'),
        ], { sub: true })
      : null,
    !hair ? bool(s, 'use_dead', 'Show Dead') : null,
    s.render_type === 'OBJECT'
      ? panel('pa-render-obj', 'Object', () => [
          objectRow(`pa-inst-${s.id}`, s as never, 'instance_object', 'Instance Object', (o) => o.id !== ob.id && (o.type === 'MESH' || o.type === 'CURVE' || o.type === 'FONT')),
          bool(s, 'use_scale_instance', 'Scale'),
        ], { sub: true })
      : null,
  ]);
}

function displayPanel(s: ParticleSettingsX): Child {
  return panel('pa-display', 'Viewport Display', () => [
    enumProp(s, 'display_method', 'Display As', [['RENDER', 'Rendered'], ['DOT', 'Point'], ['NONE', 'None']]),
    s.display_method === 'DOT' && s.type !== 'HAIR' ? num(s, 'display_size', 'Size', { min: 0.001, max: 10, unit: 'distance' }) : null,
  ], { closed: true });
}

function hairPanels(ob: ObjectPhysics, ps: ParticleSystemX, s: ParticleSettingsX, m?: ModifierBase): Child[] {
  return [
    panel('pa-emit', 'Emission', () => [
      num(s, 'count', 'Number', { int: true, min: 0, max: 1000000, softMax: 100000 }),
      num(ps, 'seed', 'Seed', { int: true, min: 0 }),
      num(s, 'hair_length', 'Hair Length', { min: 0, max: 1000, unit: 'distance' }),
      num(s, 'hair_step', 'Segments', { int: true, min: 1, max: 50 }),
      panel('pa-source', 'Source', () => [enumProp(s, 'emit_from', 'Emit From', [['VERT', 'Verts'], ['FACE', 'Faces'], ['VOLUME', 'Volume']])], { sub: true }),
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
    panel('pa-children', 'Children', () => [
      h('div', { class: 'enum-row', style: { margin: '2px 8px' } },
        (['NONE', 'SIMPLE'] as const).map((t) => h('button', { key: t, class: { on: (s.child_type ?? 'NONE') === t }, onclick: () => ((s.child_type = t), changed('Child Type')) }, t === 'NONE' ? 'None' : 'Simple')),
      ),
      s.child_type === 'SIMPLE'
        ? [
            num(s, 'rendered_child_count', 'Display Amount', { int: true, min: 0, max: 1000 }),
            num(s, 'child_radius', 'Radius', { min: 0, max: 10, unit: 'distance' }),
            subHeading('Clumping'),
            num(s, 'clump_factor', 'Clump', { min: -1, max: 1, slider: true }),
            subHeading('Roughness'),
            num(s, 'roughness_1', 'Uniform', { min: 0, max: 100000, softMax: 1 }),
          ]
        : null,
    ]),
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
  const ai = Math.max(0, Math.min(b.active_rule_index, b.rules.length - 1));
  const rule = b.rules[ai];
  const ruleObject = (label: string) =>
    splitRow(label, enumMenu(`boid-ob-${s.id}-${ai}`, [{ value: '', label: '—' }, ...Object.values(app.doc.objects).map((o) => ({ value: o.id, label: o.name, icon: 'object' }))], rule?.object ?? '', (v) => ((rule!.object = v || null), changed('Set Rule Object'))));
  return [
    panel('pa-boid-move', 'Movement', () => [
      num(b, 'air_speed_max', 'Max Air Speed', { min: 0, max: 100, unit: 'distance', disabled: d }),
      num(b, 'air_speed_min', 'Min Air Speed', { min: 0, max: 10, unit: 'distance', disabled: d }),
      num(b, 'air_acc_max', 'Max Acceleration', { min: 0, max: 1, slider: true, disabled: d }),
      num(b, 'air_personal_space', 'Personal Space', { min: 0, max: 10, unit: 'distance', disabled: d }),
      num(b, 'range', 'Neighbor Range', { min: 0.01, max: 100, unit: 'distance', disabled: d }),
    ], { sub: true }),
    panel('pa-boid-brain', 'Boid Brain', () => [
      h(
        'div',
        { style: { padding: '4px 0' } },
        uiList(
          `boid-rules-${s.id}`,
          b.rules.map((r, i) => ({ key: `${i}`, label: r.name, icon: 'particles' })),
          ai,
          (i) => ((b.active_rule_index = i), app.changed('ui')),
          {
            add: () => {
              const btn = document.activeElement as HTMLElement | null;
              openMenu(
                BOID_RULES.map(([t, l]) => ({ label: l, action: () => ((b.rules = [...b.rules, newBoidRule(t)]), (b.active_rule_index = b.rules.length - 1), changed('Add Boid Rule')) })),
                btn ?? { x: app.pointer.x, y: app.pointer.y },
              );
            },
            remove: () => {
              if (!b.rules.length) return;
              b.rules = b.rules.filter((_, i) => i !== ai);
              b.active_rule_index = Math.max(0, ai - 1);
              changed('Remove Boid Rule');
            },
            up: () => {
              if (ai <= 0) return;
              const r = b.rules.slice();
              [r[ai - 1], r[ai]] = [r[ai], r[ai - 1]];
              b.rules = r;
              b.active_rule_index = ai - 1;
              changed('Move Boid Rule');
            },
            down: () => {
              if (ai >= b.rules.length - 1) return;
              const r = b.rules.slice();
              [r[ai + 1], r[ai]] = [r[ai], r[ai + 1]];
              b.rules = r;
              b.active_rule_index = ai + 1;
              changed('Move Boid Rule');
            },
            rename: (i, name) => ((b.rules[i].name = name || b.rules[i].name), changed('Rename Boid Rule')),
          },
        ),
      ),
      enumProp(b, 'ruleset_type', 'Rule Evaluation', [['FUZZY', 'Fuzzy'], ['RANDOM', 'Random'], ['AVERAGE', 'Average']], { disabled: d }),
      b.ruleset_type === 'FUZZY' ? num(b, 'rule_fuzzy', 'Fuzziness', { min: 0, max: 1, slider: true, disabled: d }) : null,
      rule
        ? [
            subHeading(BOID_RULES.find(([t]) => t === rule.type)?.[1] ?? rule.type),
            bool(rule, 'use_in_air', 'In Air'),
            rule.type === 'GOAL' || rule.type === 'AVOID' || rule.type === 'FOLLOW_LEADER' ? ruleObject('Object') : null,
            rule.type === 'GOAL' || rule.type === 'AVOID' ? bool(rule, 'use_predict', 'Predict') : null,
            rule.type === 'AVOID' ? num(rule, 'fear_factor', 'Fear Factor', { min: 0, max: 100 }) : null,
            rule.type === 'AVOID_COLLISION' ? num(rule, 'look_ahead', 'Look Ahead', { min: 0, max: 100 }) : null,
            rule.type === 'FOLLOW_LEADER' ? num(rule, 'distance', 'Distance', { min: 0, max: 100, unit: 'distance' }) : null,
            rule.type === 'AVERAGE_SPEED' ? [num(rule, 'speed', 'Speed', { min: 0, max: 1, slider: true }), num(rule, 'wander', 'Wander', { min: 0, max: 1, slider: true }), num(rule, 'level', 'Level', { min: 0, max: 1, slider: true })] : null,
          ]
        : null,
    ], { sub: true }),
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

function keyedPanels(ob: ObjectPhysics, s: ParticleSettingsX, d: boolean): Child {
  const ts = (s.keyed_targets ??= []);
  const ai = Math.max(0, Math.min(s.active_keyed_index ?? 0, ts.length - 1));
  const t = ts[ai];
  const tob = t?.object ? app.doc.objects[t.object] : undefined;
  return panel('pa-keyed', 'Relations', () => [
    num(s, 'keyed_loops', 'Loops', { int: true, min: 1, max: 10000, disabled: d }),
    h(
      'div',
      { style: { padding: '4px 0' } },
      uiList(
        `keyed-${s.id}`,
        ts.map((x, i) => {
          const o = x.object ? app.doc.objects[x.object] : undefined;
          return { key: `${i}`, label: o ? `${o.name}: ${o.particle_systems[(x.system || 1) - 1]?.name ?? 'Invalid target!'}` : 'Invalid target!', icon: 'particles' };
        }),
        ai,
        (i) => ((s.active_keyed_index = i), app.changed('ui')),
        {
          add: () => ((s.keyed_targets = [...ts, { object: null, system: 1 }]), (s.active_keyed_index = ts.length), changed('Add Keyed Target')),
          remove: () => ((s.keyed_targets = ts.filter((_, i) => i !== ai)), (s.active_keyed_index = Math.max(0, ai - 1)), changed('Remove Keyed Target')),
        },
      ),
    ),
    t
      ? [
          splitRow('Object', enumMenu(`keyed-ob-${s.id}-${ai}`, [{ value: '', label: '—' }, ...Object.values(app.doc.objects).filter((o) => o.particle_systems.length && o.id !== ob.id).map((o) => ({ value: o.id, label: o.name, icon: 'object' }))], t.object ?? '', (v) => ((t.object = v || null), changed('Set Keyed Target')))),
          tob ? num(t, 'system', 'System', { int: true, min: 1, max: Math.max(1, tob.particle_systems.length) }) : null,
        ]
      : null,
  ], { sub: true });
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
