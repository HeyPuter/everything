// Particles properties tab: particle system list, settings data-block and panels.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, enumMenu, opButton, checkbox, textField } from '../ui/widgets';
import { num, bool, enumProp, splitRow, vecProp } from '../ui/props';
import { uiList } from '../editors/properties/uilist';
import { insertTabAfter, changed, note, subHeading, objectRow, cachePanel, fieldWeightsPanel } from './ui-common';
import { particleCacheKey } from './particles';
import { defaultParticleSettings, defaultPointCache, type ObjectPhysics, type ParticleSettingsX, type ParticleSystemX } from './types';

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
    panel('pa-rot', 'Rotation', () => [note('Instanced objects align their X axis with the particle velocity.')], { header: checkbox(`pa-rot-${s.id}`, '', !!s.use_rotations, (v) => ((s.use_rotations = v), changed('Toggle Rotation'))), closed: true }),
    panel('pa-phys', 'Physics', () => [
      enumProp(s, 'physics_type', 'Physics Type', [['NEWTON', 'Newtonian'], ['NO', 'None']], { disabled: d }),
      s.physics_type === 'NEWTON'
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
    fieldWeightsPanel('pa-fw', s, d),
    cachePanel('pa-cache', key, pc),
  ];
}

function renderPanel(ob: ObjectPhysics, s: ParticleSettingsX): Child {
  const hair = s.type === 'HAIR';
  const types: [string, string][] = hair ? [['NONE', 'None'], ['PATH', 'Path'], ['OBJECT', 'Object']] : [['NONE', 'None'], ['HALO', 'Halo'], ['OBJECT', 'Object']];
  return panel('pa-render', 'Render', () => [
    enumProp(s, 'render_type', 'Render As', types),
    num(s, 'material_slot', 'Material', { int: true, min: 1, max: 32767, tip: 'Material slot used for the display color' }),
    !hair || s.render_type === 'OBJECT' ? num(s, 'particle_size', 'Scale', { min: 0.001, max: 100000, softMax: 10, unit: 'distance' }) : null,
    !hair || s.render_type === 'OBJECT' ? num(s, 'size_random', 'Scale Randomness', { min: 0, max: 1, slider: true }) : null,
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

function hairPanels(ob: ObjectPhysics, ps: ParticleSystemX, s: ParticleSettingsX): Child[] {
  const edited = !!ps.edited_hair;
  return [
    h(
      'div',
      { class: 'row-aligned', style: { padding: '2px 8px 6px', gap: '4px' } },
      edited ? opButton('particle.edited_clear', 'Free Edit', {}, { tip: 'The hair was edited by hand: drop the edits and grow it from the settings again' }) : null,
      opButton('curves.convert_from_particle_system', 'Convert to Curves', {}, { tip: 'Add a hair curves object made from this hair' }),
    ),
    panel('pa-emit', 'Emission', () => [
      edited ? note('The hair was edited in Particle Edit mode, so its number and length come from the edits') : null,
      num(s, 'count', 'Number', { int: true, min: 0, max: 1000000, softMax: 100000, disabled: edited }),
      num(ps, 'seed', 'Seed', { int: true, min: 0 }),
      num(s, 'hair_length', 'Hair Length', { min: 0, max: 1000, unit: 'distance', disabled: edited }),
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
    if (m) out.push(...(s.type === 'HAIR' ? hairPanels(ob, ps, s) : emitterPanels(ob, ps, s, particleCacheKey(ob, m))));
    return out;
  },
});
