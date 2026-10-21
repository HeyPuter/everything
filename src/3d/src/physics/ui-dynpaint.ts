// Physics tab: Dynamic Paint canvas (surfaces) and brush panels.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, checkbox, opButton, enumRow, enumMenu } from '../ui/widgets';
import { num, bool, enumProp, splitRow, colorProp, textProp } from '../ui/props';
import { uiList } from '../editors/properties/uilist';
import type { ObjectData } from '../data/types';
import { changed, note, subHeading, cachePanel } from './ui-common';
import { defaultBrush, defaultSurface, dpCacheKey, type DPBrush, type DPSurface, type DynamicPaintModifier } from './dynpaint';
import { surfaceOutputs } from './dpimage';

function fill<T extends object>(target: T, defaults: T): T {
  const t = target as Record<string, unknown>;
  for (const [k, v] of Object.entries(defaults)) if (t[k] === undefined) t[k] = v;
  return target;
}

const headerCheck = (id: string, owner: Record<string, unknown>, key: string, label: string) =>
  checkbox(id, '', !!owner[key], (v) => {
    owner[key] = v;
    changed(`Toggle ${label}`);
  });

function surfacePanels(ob: ObjectData, m: DynamicPaintModifier): Child[] {
  const cs = m.canvas_settings!;
  const list = cs.canvas_surfaces;
  const ai = Math.max(0, Math.min(cs.active_index ?? 0, list.length - 1));
  const out: Child[] = [
    h(
      'div',
      { style: { padding: '4px 8px' } },
      uiList(
        `dps-${ob.id}`,
        list.map((s, i) => ({ key: s.id ?? String(i), label: s.name, icon: 'mod_dynamicpaint' })),
        ai,
        (i) => {
          cs.active_index = i;
          app.changed('ui');
        },
        {
          add: () => app.run('dpaint.surface_slot_add'),
          remove: () => app.run('dpaint.surface_slot_remove'),
          rename: (i, name) => {
            list[i].name = name || list[i].name;
            changed('Rename Surface');
          },
        },
      ),
    ),
  ];
  const sf0 = list[ai];
  if (!sf0) return out;
  const sf = fill(sf0, defaultSurface(sf0.surface_type ?? 'PAINT'));
  const d = sf.point_cache.is_baked;
  const T = sf.surface_type;
  const me = ob.data ? app.doc.meshes[ob.data] : undefined;
  out.push(
    panel('dp-surface', 'Surface', () => [
      d ? note('The surface is baked: delete the bake to change settings') : null,
      bool(sf as never, 'is_active', 'Active', { tip: 'Enable this surface' }),
      enumProp(sf, 'surface_format', 'Format', [['VERTEX', 'Vertex'], ['IMAGE', 'Image Sequence']], { disabled: d, tip: 'Paint per vertex, or per texel of the UV map into images' }),
      sf.surface_format === 'IMAGE' ? num(sf, 'image_resolution', 'Resolution', { int: true, min: 16, max: 4096, softMax: 2048, disabled: d, tip: 'Pixels per side of the output images' }) : null,
      sf.surface_format === 'IMAGE' && !me?.uvs.length ? note('Image sequences need a UV map on the canvas mesh', 'error') : null,
      enumProp(sf, 'surface_type', 'Type', [['PAINT', 'Paint'], ['DISPLACE', 'Displace'], ['WAVE', 'Waves'], ['WEIGHT', 'Weight']], {
        disabled: d,
        onChange: () => {
          if (sf.surface_type === 'WEIGHT' && sf.output_name_a === 'dp_paintmap') sf.output_name_a = 'dp_weight';
          if (sf.surface_type === 'PAINT' && sf.output_name_a === 'dp_weight') sf.output_name_a = 'dp_paintmap';
        },
      }),
      num(sf.point_cache, 'frame_start', 'Frame Start', { int: true, disabled: d }),
      num(sf.point_cache, 'frame_end', 'End', { int: true, min: sf.point_cache.frame_start, disabled: d }),
      num(sf, 'frame_substeps', 'Substeps', { int: true, min: 0, max: 20, disabled: d }),
      subHeading('Brushes'),
      splitRow(
        'Collection',
        enumMenu(`dp-coll-${sf.id}`, [{ value: '', label: 'All brushes' }, ...Object.values(app.doc.collections).filter((c) => c.id !== app.doc.scene.collection).map((c) => ({ value: c.id, label: c.name, icon: 'collection' }))], sf.brush_collection ?? '', (v) => ((sf.brush_collection = v || null), changed('Set Brush Collection'))),
      ),
      num(sf, 'brush_influence_scale', 'Influence Scale', { min: 0, max: 1, slider: true, disabled: d }),
      num(sf, 'brush_radius_scale', 'Radius Scale', { min: 0, max: 10, disabled: d }),
      T === 'PAINT'
        ? [
            panel('dp-dry', 'Dry', () => [num(sf, 'dry_speed', 'Time', { int: true, min: 1, max: 10000, disabled: d || !sf.use_drying }), num(sf, 'color_dry_threshold', 'Color Dry Threshold', { min: 0, max: 1, slider: true, disabled: d || !sf.use_drying })], {
              sub: true,
              header: headerCheck(`dp-dry-${sf.id}`, sf as never, 'use_drying', 'Dry'),
            }),
          ]
        : null,
      T !== 'WAVE'
        ? panel('dp-dissolve', 'Dissolve', () => [num(sf, 'dissolve_speed', 'Time', { int: true, min: 1, max: 10000, disabled: d || !sf.use_dissolve }), bool(sf, 'use_dissolve_log', 'Slow', { disabled: d || !sf.use_dissolve })], {
            sub: true,
            header: headerCheck(`dp-dis-${sf.id}`, sf as never, 'use_dissolve', 'Dissolve'),
          })
        : null,
      T === 'DISPLACE' ? [num(sf, 'displace_factor', 'Displace Factor', { min: -100, max: 100, softMin: -2, softMax: 2, disabled: d }), num(sf, 'depth_clamp', 'Max Displace', { min: 0, max: 50, unit: 'distance', disabled: d }), bool(sf, 'use_incremental_displace', 'Incremental', { disabled: d })] : null,
      T === 'WAVE'
        ? [
            bool(sf, 'use_wave_open_border', 'Open Borders', { disabled: d }),
            num(sf, 'wave_timescale', 'Timescale', { min: 0.01, max: 3, disabled: d }),
            num(sf, 'wave_speed', 'Speed', { min: 0.01, max: 5, disabled: d }),
            num(sf, 'wave_damping', 'Damping', { min: 0, max: 1, slider: true, disabled: d }),
            num(sf, 'wave_spring', 'Spring', { min: 0, max: 1, slider: true, disabled: d }),
            num(sf, 'wave_smoothness', 'Smoothness', { min: 0, max: 10, disabled: d }),
          ]
        : null,
    ]),
  );
  if (T === 'PAINT') {
    out.push(
      panel('dp-init', 'Initial Color', () => [
        enumProp(sf, 'init_color_type', 'Type', [['NONE', 'None'], ['COLOR', 'Color'], ['VERTEX_COLOR', 'Color Attribute']], { disabled: d }),
        sf.init_color_type === 'COLOR' ? colorProp(sf as never, 'init_color', 'Color', { alpha: true }) : null,
        sf.init_color_type === 'VERTEX_COLOR'
          ? splitRow('Color Attribute', enumMenu(`dp-initl-${sf.id}`, [{ value: '', label: 'Active' }, ...(me?.color_attributes ?? []).map((c) => ({ value: c.name, label: c.name, icon: 'group_vcol' }))], sf.init_layername, (v) => ((sf.init_layername = v), changed('Set Color Attribute'))))
          : null,
      ], { closed: true }),
      panel('dp-effects', 'Effects', () => [
        panel('dp-spread', 'Spread', () => [num(sf, 'spread_speed', 'Speed', { min: 0.001, max: 10, disabled: d || !sf.use_spread }), num(sf, 'color_spread_speed', 'Color', { min: 0, max: 2, disabled: d || !sf.use_spread })], { sub: true, header: headerCheck(`dp-spr-${sf.id}`, sf as never, 'use_spread', 'Spread'), closed: !sf.use_spread }),
        panel('dp-drip', 'Drip', () => [num(sf, 'drip_velocity', 'Velocity', { min: -200, max: 200, softMin: -5, softMax: 5, disabled: d || !sf.use_drip }), num(sf, 'drip_acceleration', 'Acceleration', { min: -200, max: 200, softMin: -5, softMax: 5, disabled: d || !sf.use_drip })], { sub: true, header: headerCheck(`dp-drip-${sf.id}`, sf as never, 'use_drip', 'Drip'), closed: !sf.use_drip }),
        panel('dp-shrink', 'Shrink', () => [num(sf, 'shrink_speed', 'Speed', { min: 0.001, max: 10, disabled: d || !sf.use_shrink })], { sub: true, header: headerCheck(`dp-shr-${sf.id}`, sf as never, 'use_shrink', 'Shrink'), closed: !sf.use_shrink }),
      ], { closed: true }),
    );
  }
  if (sf.surface_format === 'IMAGE') {
    out.push(
      panel('dp-output', 'Output', () => {
        const outs = surfaceOutputs(sf);
        const row = (key: 'output_name_a' | 'output_name_b', use: 'use_output_a' | 'use_output_b', label: string) => [
          T === 'PAINT' ? h('div', { class: 'split-row check' }, h('div', { class: 'sr-label' }), h('div', { class: 'sr-value' }, checkbox(`dp-${use}-${sf.id}`, label, sf[use] !== false, (v) => ((sf[use] = v), changed(`Toggle ${label}`)))), h('span', { class: 'decorator-space' })) : null,
          textProp(sf as never, key, T === 'PAINT' ? 'Image Name' : label, { disabled: T === 'PAINT' && sf[use] === false }),
        ];
        return [
          note('Baking writes the maps to images of these names; they then follow the current frame'),
          T === 'PAINT' ? [row('output_name_a', 'use_output_a', 'Paintmaps'), row('output_name_b', 'use_output_b', 'Wetmaps')] : row('output_name_a', 'use_output_a', T === 'DISPLACE' ? 'Displacement Image' : T === 'WAVE' ? 'Waves Image' : 'Weight Image'),
          h('div', { class: 'prop-note' }, `Images: ${outs.map((o) => o.name).join(', ') || '—'}`),
          h('div', { class: 'row-aligned', style: { padding: '2px 8px' } }, opButton('dpaint.bake', 'Bake Image Sequence', {}, { tip: 'Simulate the whole frame range and write the images' })),
        ];
      }),
    );
  } else if (T === 'PAINT' || T === 'WEIGHT') {
    const layerRow = (key: 'output_name_a' | 'output_name_b', use: 'use_output_a' | 'use_output_b', label: string, output: 'A' | 'B') => {
      const name = sf[key];
      const exists = T === 'WEIGHT' ? !!me?.vertex_groups.some((g) => g.name === name) : !!me?.color_attributes.some((c) => c.name === name);
      return [
        h('div', { class: 'split-row check' }, h('div', { class: 'sr-label' }), h('div', { class: 'sr-value' }, checkbox(`dp-${use}-${sf.id}`, label, !!sf[use], (v) => ((sf[use] = v), changed(`Toggle ${label}`)))), h('span', { class: 'decorator-space' })),
        textProp(sf as never, key, 'Layer Name', { disabled: !sf[use] }),
        h('div', { class: 'row-aligned', style: { padding: '0 0 4px' } }, opButton('dpaint.output_toggle', exists ? 'Remove Layer' : 'Add Layer', { output }, { icon: exists ? 'remove' : 'add' })),
      ];
    };
    out.push(
      panel('dp-output', 'Output', () => [
        T === 'PAINT' ? note('The paint shows in the active color attribute when it is the paintmap layer (or the mesh has none); the wetmap when its layer is active') : note('Weights are written to the vertex group of this name'),
        layerRow('output_name_a', 'use_output_a', T === 'PAINT' ? 'Paintmap Layer' : 'Vertex Group', 'A'),
        T === 'PAINT' ? layerRow('output_name_b', 'use_output_b', 'Wetmap Layer', 'B') : null,
      ]),
    );
  }
  out.push(cachePanel('dp-cache', dpCacheKey(ob, m, sf), sf.point_cache));
  return out;
}

function brushPanels(ob: ObjectData, m: DynamicPaintModifier): Child[] {
  const b = fill(m.brush_settings as DPBrush, defaultBrush());
  const systems = ob.particle_systems;
  return [
    panel('dp-brush', 'Settings', () => [
      bool(b, 'use_absolute_alpha', 'Absolute Alpha'),
      bool(b, 'use_paint_erase', 'Erase Paint'),
      num(b, 'paint_wetness', 'Wetness', { min: 0, max: 1, slider: true }),
      colorProp(b as never, 'paint_color', 'Paint Color'),
      num(b, 'paint_alpha', 'Alpha', { min: 0, max: 1, slider: true }),
    ]),
    panel('dp-brush-source', 'Source', () => [
      enumProp(b, 'paint_source', 'Paint', [['PSYS', 'Particle System'], ['POINT', 'Object Center'], ['DISTANCE', 'Proximity'], ['VOLUME_DISTANCE', 'Mesh Volume + Proximity'], ['VOLUME', 'Mesh Volume']]),
      b.paint_source === 'PSYS'
        ? [
            splitRow('Particle System', enumMenu(`dp-psys-${ob.id}`, [{ value: '', label: 'First' }, ...systems.map((p) => ({ value: (p as { id?: string }).id ?? p.name, label: p.name, icon: 'particles' }))], b.particle_system, (v) => ((b.particle_system = v), changed('Set Particle System')))),
            num(b, 'solid_radius', 'Solid Radius', { min: 0.01, max: 10, unit: 'distance' }),
            num(b, 'smooth_radius', 'Smooth Radius', { min: 0, max: 10, unit: 'distance' }),
          ]
        : null,
      b.paint_source !== 'VOLUME' && b.paint_source !== 'PSYS'
        ? [
            num(b, 'paint_distance', 'Distance', { min: 0, max: 500, softMax: 5, unit: 'distance' }),
            splitRow('Falloff', enumRow(`dp-fall-${ob.id}`, [{ value: 'SMOOTH', label: 'Smooth' }, { value: 'CONSTANT', label: 'Constant' }], b.proximity_falloff, (v) => ((b.proximity_falloff = v as DPBrush['proximity_falloff']), changed('Change Falloff')))),
            bool(b, 'invert_proximity', 'Inner Proximity'),
          ]
        : null,
    ]),
    panel('dp-brush-vel', 'Velocity', () => [bool(b, 'use_velocity_alpha', 'Multiply Alpha'), bool(b, 'use_velocity_depth', 'Multiply Depth'), num(b, 'velocity_max', 'Max Velocity', { min: 0.0001, max: 10, unit: 'distance' })], { closed: true }),
    panel('dp-brush-wave', 'Waves', () => [
      enumProp(b, 'wave_type', 'Wave Type', [['CHANGE', 'Depth Change'], ['DEPTH', 'Obstacle'], ['FORCE', 'Force'], ['REFLECT', 'Reflect Only']]),
      b.wave_type !== 'REFLECT' ? [num(b, 'wave_factor', 'Factor', { min: -2, max: 2 }), num(b, 'wave_clamp', 'Clamp Waves', { min: 0, max: 50, unit: 'distance' })] : null,
    ], { closed: true }),
  ];
}

/** Dynamic Paint panels of the Physics tab. */
export function dynamicPaintPanels(ob: ObjectData, m: DynamicPaintModifier): Child[] {
  const out: Child[] = [
    panel('dp', 'Dynamic Paint', () => [
      splitRow(
        'Type',
        enumRow(`dp-type-${ob.id}`, [{ value: 'CANVAS', label: 'Canvas' }, { value: 'BRUSH', label: 'Brush' }], m.ui_type, (v) => ((m.ui_type = v as 'CANVAS' | 'BRUSH'), changed('Dynamic Paint Type'))),
      ),
      m.ui_type === 'CANVAS'
        ? h('div', { class: 'row-aligned', style: { padding: '2px 0' } }, opButton('dpaint.type_toggle', m.canvas_settings ? 'Remove Canvas' : 'Add Canvas', { type: 'CANVAS' }, { icon: m.canvas_settings ? 'x' : 'add' }))
        : h('div', { class: 'row-aligned', style: { padding: '2px 0' } }, opButton('dpaint.type_toggle', m.brush_settings ? 'Remove Brush' : 'Add Brush', { type: 'BRUSH' }, { icon: m.brush_settings ? 'x' : 'add' })),
    ]),
  ];
  if (m.ui_type === 'CANVAS' && m.canvas_settings) out.push(...surfacePanels(ob, m));
  if (m.ui_type === 'BRUSH' && m.brush_settings) out.push(...brushPanels(ob, m));
  return out;
}

/** Fill settings from older files (surfaces keep identity). */
export function ensureSurfaceDefaults(s: DPSurface) {
  return fill(s, defaultSurface(s.surface_type));
}
