// Properties ▸ Modifiers panels for the grease pencil modifiers (fields, Influence sub-panel,
// Dot Dash segments) and Apply for grease pencil objects.
import { app, onAppReady, operators } from '../app/app';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { panel, enumMenu } from '../ui/widgets';
import { num, bool, enumProp, colorProp, vecProp, objectProp, splitRow } from '../ui/props';
import { modifierExtraUI } from '../editors/properties/stack';
import type { ModifierBase, ObjectData } from '../data/types';
import { gpOf, toStrokes, fromStrokes, normalizeDrawing } from './data';
import { layerMatrix } from './render';
import { GP_MODIFIERS, evaluateDrawing, activeModifiers, isGPModifier } from './modifiers';
import { Matrix4 } from 'three';

type M = ModifierBase & Record<string, unknown>;
const E = (...items: [string, string][]) => items;

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

function layerPicker(ob: ObjectData, m: M, key: string, label: string): Child {
  const gp = gpOf(app.doc, ob);
  const items = [{ value: '', label: '—' }, ...(gp?.layers ?? []).map((l) => ({ value: l.name, label: l.name, icon: 'outliner_data_gp_layer' })).reverse()];
  return splitRow(label, enumMenu(`${m.id}.${key}`, items, String(m[key] ?? ''), (v) => ((m[key] = v), changed(`Set ${label}`))));
}

function materialPicker(ob: ObjectData, m: M, key: string, label: string): Child {
  const gp = gpOf(app.doc, ob);
  const items = [{ value: '', label: '—' }, ...(gp?.materials ?? []).filter((x): x is string => !!x).map((id) => ({ value: id, label: app.doc.materials[id]?.name ?? id, icon: 'material' }))];
  return splitRow(label, enumMenu(`${m.id}.${key}`, items, String(m[key] ?? ''), (v) => ((m[key] = v || null), changed(`Set ${label}`))));
}

const invert = (m: M, key: string): Child =>
  h(
    'button',
    {
      class: { 'hdr-toggle': true, on: !!m[key] },
      'data-tip': 'Invert\nUse everything except this',
      onclick: () => ((m[key] = !m[key]), changed('Invert Filter')),
    },
    icon('gp_invert'),
  );

function influence(ob: ObjectData, m: M, withMaterial = true): Child {
  return panel(
    `gpmod-infl-${m.id}`,
    'Influence',
    () => [
      h('div', { class: 'gpm-filter' }, layerPicker(ob, m, 'layer_filter', 'Layer'), invert(m, 'invert_layer_filter')),
      h('div', { class: 'gpm-filter' }, bool(m, 'use_layer_pass_filter', 'Layer Pass'), m.use_layer_pass_filter ? num(m, 'layer_pass_filter', 'Pass', { int: true, min: 0, max: 100 }) : null, m.use_layer_pass_filter ? invert(m, 'invert_layer_pass_filter') : null),
      withMaterial ? h('div', { class: 'gpm-filter' }, materialPicker(ob, m, 'material_filter', 'Material'), invert(m, 'invert_material_filter')) : null,
      withMaterial
        ? h('div', { class: 'gpm-filter' }, bool(m, 'use_material_pass_filter', 'Material Pass'), m.use_material_pass_filter ? num(m, 'material_pass_filter', 'Pass', { int: true, min: 0, max: 100 }) : null, m.use_material_pass_filter ? invert(m, 'invert_material_pass_filter') : null)
        : null,
    ],
    { sub: true, closed: true },
  );
}

const COLOR_MODES = E(['BOTH', 'Stroke & Fill'], ['STROKE', 'Stroke'], ['FILL', 'Fill']);
const otherObject = (ob: ObjectData, type?: string) => (o: ObjectData) => o.id !== ob.id && (!type || o.type === type);

function dashSegments(m: M): Child {
  const segs = (m.segments as Record<string, unknown>[]) ?? [];
  const active = Math.min(segs.length - 1, Math.max(0, (m.segment_active_index as number) ?? 0));
  const seg = segs[active];
  return [
    h(
      'div',
      { class: 'gpm-seglist' },
      segs.map((g, i) =>
        h(
          'div',
          {
            class: { 'gpm-seg': true, on: i === active },
            onclick: () => ((m.segment_active_index = i), app.changed('ui')),
          },
          String(g.name ?? 'Segment'),
        ),
      ),
      h(
        'div',
        { class: 'gpm-seg-btns' },
        h('button', { class: 'btn', 'data-tip': 'Add a dash segment', onclick: () => (segs.push({ name: `Segment.${String(segs.length).padStart(3, '0')}`, dash: 2, gap: 1, radius: 1, opacity: 1, material_index: -1, use_cyclic: false }), (m.segment_active_index = segs.length - 1), changed('Add Segment')) }, icon('add')),
        h('button', { class: 'btn', 'data-tip': 'Remove the active segment', disabled: segs.length <= 1, onclick: () => segs.length > 1 && (segs.splice(active, 1), (m.segment_active_index = Math.max(0, active - 1)), changed('Remove Segment')) }, icon('remove')),
      ),
    ),
    seg
      ? [
          num(seg, 'dash', 'Dash', { int: true, min: 1, max: 1000 }),
          num(seg, 'gap', 'Gap', { int: true, min: 0, max: 1000 }),
          num(seg, 'radius', 'Radius', { min: 0, max: 10 }),
          num(seg, 'opacity', 'Opacity', { min: 0, max: 1, slider: true }),
          num(seg, 'material_index', 'Material Index', { int: true, min: -1, max: 255 }),
          bool(seg, 'use_cyclic', 'Use Cyclic'),
        ]
      : null,
  ];
}

const UI: Record<string, (ob: ObjectData, m: M) => Child> = {
  GREASE_PENCIL_TIME: (ob, m) => [
    enumProp(m, 'mode', 'Mode', E(['NORMAL', 'Regular'], ['REVERSE', 'Reverse'], ['FIX', 'Fixed Frame'], ['PINGPONG', 'Ping Pong'])),
    num(m, 'offset', m.mode === 'FIX' ? 'Frame' : 'Frame Offset', { int: true }),
    m.mode !== 'FIX' ? num(m, 'frame_scale', 'Scale', { min: 0.001, max: 100 }) : null,
    m.mode !== 'FIX' ? bool(m, 'use_keep_loop', 'Keep Loop') : null,
    m.mode !== 'FIX'
      ? panel(
          `gpmod-range-${m.id}`,
          'Custom Range',
          () => [num(m, 'frame_start', 'Frame Start', { int: true }), num(m, 'frame_end', 'End', { int: true })],
          { sub: true, closed: !m.use_custom_frame_range, header: h('input', { type: 'checkbox', checked: !!m.use_custom_frame_range, onchange: (e: Event) => ((m.use_custom_frame_range = (e.target as HTMLInputElement).checked), changed('Custom Range')) }) },
        )
      : null,
    influence(ob, m, false),
  ],
  GREASE_PENCIL_ARRAY: (ob, m) => [
    num(m, 'count', 'Count', { int: true, min: 1, max: 1000 }),
    num(m, 'replace_material', 'Material Override', { int: true, min: 0, max: 255, tip: 'Slot number (from 1) the copies use; 0 keeps their materials' }),
    panel(`gpmod-rel-${m.id}`, 'Relative Offset', () => [vecProp(m, 'relative_offset', 'Factor')], { sub: true, header: h('input', { type: 'checkbox', checked: !!m.use_relative_offset, onchange: (e: Event) => ((m.use_relative_offset = (e.target as HTMLInputElement).checked), changed('Relative Offset')) }) }),
    panel(`gpmod-con-${m.id}`, 'Constant Offset', () => [vecProp(m, 'constant_offset', 'Distance', { unit: 'distance' })], { sub: true, closed: true, header: h('input', { type: 'checkbox', checked: !!m.use_constant_offset, onchange: (e: Event) => ((m.use_constant_offset = (e.target as HTMLInputElement).checked), changed('Constant Offset')) }) }),
    panel(`gpmod-obj-${m.id}`, 'Object Offset', () => [objectProp(m, 'offset_object', 'Object', { filter: otherObject(ob) })], { sub: true, closed: true, header: h('input', { type: 'checkbox', checked: !!m.use_object_offset, onchange: (e: Event) => ((m.use_object_offset = (e.target as HTMLInputElement).checked), changed('Object Offset')) }) }),
    panel(
      `gpmod-rnd-${m.id}`,
      'Randomize',
      () => [vecProp(m, 'random_offset', 'Offset', { unit: 'distance' }), vecProp(m, 'random_rotation', 'Rotation', { unit: 'angle' }), vecProp(m, 'random_scale', 'Scale'), bool(m, 'use_uniform_random_scale', 'Uniform Scale'), num(m, 'seed', 'Seed', { int: true, min: 0 })],
      { sub: true, closed: true },
    ),
    influence(ob, m),
  ],
  GREASE_PENCIL_BUILD: (ob, m) => [
    enumProp(m, 'mode', 'Mode', E(['SEQUENTIAL', 'Sequential'], ['CONCURRENT', 'Concurrent'], ['ADDITIVE', 'Additive'])),
    enumProp(m, 'transition', 'Transition', E(['GROW', 'Grow'], ['SHRINK', 'Shrink'], ['FADE', 'Vanish'])),
    enumProp(m, 'time_mode', 'Timing', E(['FRAMES', 'Frames'], ['PERCENTAGE', 'Percentage'])),
    m.time_mode === 'PERCENTAGE'
      ? num(m, 'percentage_factor', 'Factor', { min: 0, max: 1, slider: true })
      : [num(m, 'start_delay', 'Delay', { min: 0 }), num(m, 'length', 'Frames', { min: 1 })],
    m.mode === 'CONCURRENT' ? enumProp(m, 'concurrent_time_alignment', 'Time Alignment', E(['START', 'Align Start'], ['END', 'Align End'])) : null,
    panel(
      `gpmod-range-${m.id}`,
      'Effective Range',
      () => [num(m, 'frame_start', 'Start', { min: 0 }), num(m, 'frame_end', 'End', { min: 0 })],
      { sub: true, closed: !m.use_restrict_frame_range, header: h('input', { type: 'checkbox', checked: !!m.use_restrict_frame_range, onchange: (e: Event) => ((m.use_restrict_frame_range = (e.target as HTMLInputElement).checked), changed('Effective Range')) }) },
    ),
    influence(ob, m),
  ],
  GREASE_PENCIL_DASH: (ob, m) => [num(m, 'dash_offset', 'Offset', { int: true }), dashSegments(m), influence(ob, m)],
  GREASE_PENCIL_LENGTH: (ob, m) => [
    enumProp(m, 'mode', 'Mode', E(['RELATIVE', 'Relative'], ['ABSOLUTE', 'Absolute'])),
    m.mode === 'ABSOLUTE' ? [num(m, 'start_length', 'Start', { unit: 'distance' }), num(m, 'end_length', 'End', { unit: 'distance' })] : [num(m, 'start_factor', 'Start', { min: -10, max: 10 }), num(m, 'end_factor', 'End', { min: -10, max: 10 })],
    panel(
      `gpmod-lrnd-${m.id}`,
      'Random',
      () => [num(m, 'random_start_factor', 'Random Start', { min: -10, max: 10 }), num(m, 'random_end_factor', 'End', { min: -10, max: 10 }), num(m, 'seed', 'Seed', { int: true, min: 0 })],
      { sub: true, closed: !m.use_random, header: h('input', { type: 'checkbox', checked: !!m.use_random, onchange: (e: Event) => ((m.use_random = (e.target as HTMLInputElement).checked), changed('Random')) }) },
    ),
    influence(ob, m),
  ],
  GREASE_PENCIL_MIRROR: (ob, m) => [mirrorAxes(m), objectProp(m, 'object', 'Object', { filter: otherObject(ob) }), influence(ob, m)],
  GREASE_PENCIL_MULTIPLY: (ob, m) => [
    num(m, 'duplicates', 'Duplicates', { int: true, min: 0, max: 50 }),
    num(m, 'distance', 'Distance', { unit: 'distance' }),
    num(m, 'offset', 'Offset', { min: -1, max: 1, slider: true }),
    panel(
      `gpmod-fade-${m.id}`,
      'Fade',
      () => [num(m, 'fading_center', 'Center', { min: 0, max: 1, slider: true }), num(m, 'fading_thickness', 'Thickness', { min: 0, max: 1, slider: true }), num(m, 'fading_opacity', 'Opacity', { min: 0, max: 1, slider: true })],
      { sub: true, closed: !m.use_fade, header: h('input', { type: 'checkbox', checked: !!m.use_fade, onchange: (e: Event) => ((m.use_fade = (e.target as HTMLInputElement).checked), changed('Fade')) }) },
    ),
    influence(ob, m),
  ],
  GREASE_PENCIL_OUTLINE: (ob, m) => [num(m, 'thickness', 'Thickness', { int: true, min: 1, max: 1000 }), num(m, 'subdivision', 'Subdivisions', { int: true, min: 0, max: 10 }), materialPicker(ob, m, 'outline_material', 'Outline Material'), influence(ob, m)],
  GREASE_PENCIL_SIMPLIFY: (ob, m) => [
    enumProp(m, 'mode', 'Mode', E(['FIXED', 'Fixed'], ['ADAPTIVE', 'Adaptive'], ['SAMPLE', 'Sample'], ['MERGE', 'Merge'])),
    m.mode === 'FIXED' ? num(m, 'step', 'Iterations', { int: true, min: 0, max: 50 }) : m.mode === 'ADAPTIVE' ? num(m, 'factor', 'Factor', { min: 0, max: 100 }) : m.mode === 'SAMPLE' ? num(m, 'length', 'Length', { unit: 'distance', min: 0.001 }) : num(m, 'distance', 'Distance', { unit: 'distance', min: 0 }),
    influence(ob, m),
  ],
  GREASE_PENCIL_SUBDIV: (ob, m) => [enumProp(m, 'subdivision_type', 'Type', E(['CATMULL_CLARK', 'Catmull-Clark'], ['SIMPLE', 'Simple'])), num(m, 'level', 'Subdivisions', { int: true, min: 0, max: 5 }), influence(ob, m)],
  GREASE_PENCIL_LATTICE: (ob, m) => [objectProp(m, 'object', 'Object', { filter: otherObject(ob, 'LATTICE') }), num(m, 'strength', 'Strength', { min: 0, max: 1, slider: true }), influence(ob, m)],
  GREASE_PENCIL_NOISE: (ob, m) => [
    num(m, 'factor', 'Position', { min: 0, max: 100 }),
    num(m, 'factor_strength', 'Strength', { min: 0, max: 100 }),
    num(m, 'factor_thickness', 'Thickness', { min: 0, max: 100 }),
    num(m, 'noise_scale', 'Noise Scale', { min: 0, max: 100 }),
    num(m, 'noise_offset', 'Noise Offset'),
    num(m, 'seed', 'Seed', { int: true, min: 0 }),
    panel(
      `gpmod-nrnd-${m.id}`,
      'Random',
      () => [enumProp(m, 'random_mode', 'Mode', E(['STEP', 'Steps'], ['KEYFRAME', 'Keyframes'])), m.random_mode !== 'KEYFRAME' ? num(m, 'step', 'Step', { int: true, min: 1, max: 100 }) : null],
      { sub: true, closed: !m.use_random, header: h('input', { type: 'checkbox', checked: m.use_random !== false, onchange: (e: Event) => ((m.use_random = (e.target as HTMLInputElement).checked), changed('Random')) }) },
    ),
    influence(ob, m),
  ],
  GREASE_PENCIL_OFFSET: (ob, m) => [
    panel(`gpmod-gen-${m.id}`, 'General', () => [vecProp(m, 'location', 'Location', { unit: 'distance' }), vecProp(m, 'rotation', 'Rotation', { unit: 'angle' }), vecProp(m, 'scale', 'Scale')], { sub: true }),
    panel(
      `gpmod-adv-${m.id}`,
      'Advanced',
      () => [
        enumProp(m, 'offset_mode', 'Mode', E(['RANDOM', 'Random'], ['LAYER', 'Layer'], ['STROKE', 'Stroke'], ['MATERIAL', 'Material'])),
        vecProp(m, 'stroke_location', 'Offset', { unit: 'distance' }),
        vecProp(m, 'stroke_rotation', 'Rotation', { unit: 'angle' }),
        vecProp(m, 'stroke_scale', 'Scale'),
        m.offset_mode === 'RANDOM' ? [bool(m, 'use_uniform_random_scale', 'Uniform Scale'), num(m, 'seed', 'Seed', { int: true, min: 0 })] : null,
        m.offset_mode === 'STROKE' ? [num(m, 'stroke_step', 'Stroke Step', { int: true, min: 1 }), num(m, 'stroke_start_offset', 'Offset', { int: true })] : null,
      ],
      { sub: true, closed: true },
    ),
    influence(ob, m),
  ],
  GREASE_PENCIL_SHRINKWRAP: (ob, m) => [
    enumProp(m, 'wrap_method', 'Wrap Method', E(['NEAREST_SURFACEPOINT', 'Nearest Surface Point'], ['PROJECT', 'Project'], ['NEAREST_VERTEX', 'Nearest Vertex'])),
    objectProp(m, 'target', 'Target', { filter: otherObject(ob, 'MESH') }),
    num(m, 'offset', 'Offset', { unit: 'distance' }),
    influence(ob, m),
  ],
  GREASE_PENCIL_SMOOTH: (ob, m) => [
    num(m, 'factor', 'Factor', { min: 0, max: 1, slider: true }),
    num(m, 'step', 'Repeat', { int: true, min: 1, max: 1000 }),
    h('div', { class: 'gpm-row' }, bool(m, 'use_edit_position', 'Position'), bool(m, 'use_edit_strength', 'Strength'), bool(m, 'use_edit_thickness', 'Thickness')),
    bool(m, 'use_keep_shape', 'Keep Shape'),
    bool(m, 'use_smooth_ends', 'Smooth Ends'),
    influence(ob, m),
  ],
  GREASE_PENCIL_THICKNESS: (ob, m) => [bool(m, 'use_uniform_thickness', 'Uniform Thickness'), m.use_uniform_thickness ? num(m, 'thickness', 'Thickness', { unit: 'distance', min: 0 }) : num(m, 'thickness_factor', 'Factor', { min: 0, max: 100 }), influence(ob, m)],
  GREASE_PENCIL_COLOR: (ob, m) => [enumProp(m, 'color_mode', 'Mode', COLOR_MODES), num(m, 'hue', 'Hue', { min: 0, max: 1, slider: true }), num(m, 'saturation', 'Saturation', { min: 0, max: 2, slider: true }), num(m, 'value', 'Value', { min: 0, max: 2, slider: true }), influence(ob, m)],
  GREASE_PENCIL_OPACITY: (ob, m) => [enumProp(m, 'color_mode', 'Mode', COLOR_MODES), bool(m, 'use_uniform_opacity', 'Uniform Opacity'), num(m, 'color_factor', 'Opacity Factor', { min: 0, max: 2, slider: true }), influence(ob, m)],
  GREASE_PENCIL_TINT: (ob, m) => [enumProp(m, 'color_mode', 'Mode', COLOR_MODES), num(m, 'factor', 'Factor', { min: 0, max: 1, slider: true }), colorProp(m, 'color', 'Color'), influence(ob, m)],
};

function mirrorAxes(m: M): Child {
  const keys = ['use_axis_x', 'use_axis_y', 'use_axis_z'];
  return splitRow(
    'Axis',
    h(
      'div',
      { class: 'row-aligned' },
      keys.map((k, i) => h('button', { key: k, class: { tbtn: true, on: !!m[k] }, onclick: () => ((m[k] = !m[k]), changed('Change Axis')) }, 'XYZ'[i])),
    ),
  );
}

for (const d of GP_MODIFIERS) modifierExtraUI[d.type] = (ob, m) => UI[d.type]?.(ob, m as M) ?? null;

// ---------------------------------------------------------------------------
// Apply: bake the modifier into every keyframe drawing

onAppReady(() => {
  const op = operators.get('object.modifier_apply');
  if (!op) return;
  const basePoll = op.poll,
    baseExec = op.exec;
  const isGPMod = (p: Record<string, unknown>) => {
    const ob = app.activeObject;
    return !!ob && ob.type === 'GREASEPENCIL' && !!ob.modifiers.find((m) => m.id === p.modifier && isGPModifier(m.type));
  };
  op.poll = (ctx) => (app.activeObject?.type === 'GREASEPENCIL' ? ctx.doc.mode === 'OBJECT' : !basePoll || basePoll(ctx));
  op.exec = (ctx, p) => {
    if (!isGPMod(p)) return baseExec?.(ctx, p);
    const ob = app.activeObject!;
    const gp = gpOf(ctx.doc, ob)!;
    const idx = ob.modifiers.findIndex((m) => m.id === p.modifier);
    if (idx > 0) app.report('WARNING', 'Applied modifier was not first, result may not be as expected');
    const m = ob.modifiers[idx];
    const users = Object.values(ctx.doc.objects).filter((o) => o.data === ob.data).length;
    if (users > 1) {
      app.report('ERROR', 'Modifiers cannot be applied to multi-user data');
      return 'CANCELLED';
    }
    const mods = activeModifiers(ob).filter((x) => x.id === m.id);
    if (m.type === 'GREASE_PENCIL_TIME' || !mods.length) {
      app.report('ERROR', `${m.name} cannot be applied`);
      return 'CANCELLED';
    }
    const obWorld = app.graph.get(ob.id)?.world ?? new Matrix4();
    const done = new Set<number>();
    gp.layers.forEach((layer, li) =>
      layer.frames.forEach((f, k) => {
        if (done.has(f.drawing) || !gp.drawings[f.drawing]) return;
        done.add(f.drawing);
        const prev = k > 0 ? gp.drawings[layer.frames[k - 1].drawing] : undefined;
        const ev = evaluateDrawing(normalizeDrawing(gp.drawings[f.drawing]), { doc: ctx.doc, ob, gp, layer, layerIndex: li, frame: f.frame_number, keyFrame: f.frame_number, nextKeyFrame: layer.frames[k + 1]?.frame_number ?? null, prevStrokeCount: prev ? prev.offsets.length - 1 : 0, world: obWorld.clone().multiply(layerMatrix(layer)) }, mods);
        gp.drawings[f.drawing] = fromStrokes(toStrokes(ev));
      }),
    );
    ob.modifiers.splice(idx, 1);
  };
});
