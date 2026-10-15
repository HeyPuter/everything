// Sculpt / paint mode UI: toolbar tools, tool header settings, sidebar Tool tab panels, header
// menus, keymaps and the viewport input hooks (strokes, cursor, context menu).
import { app, registerOperators } from '../app/app';
import { activeTools } from '../app/prefs';
import { addKeys, keyName, keymaps, keyLabel, type KeyItem } from '../app/keymap';
import { h, type Child, type VNode } from '../ui/h';
import { icon } from '../ui/icons';
import { checkbox, colorSwatch, enumMenu, numberField, panel, button, opButton, row } from '../ui/widgets';
import { openMenu, openPie, openPopover, type MenuItem } from '../ui/menu';
import { editModeHooks, viewportExtensions } from '../editors/view3d/hooks';
import { extraToolLists, toolSettingsRenderers, setActiveTool, type ToolDef } from '../editors/view3d/toolbar';
import { sidebarTabs } from '../editors/view3d/sidebar';
import { modeMenus } from '../editors/view3d/modemenus';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { activeBrush, brushById, BRUSH_LISTS, brushInfo, isBrushMode, type BrushMode, type PaintBrush } from './brushes';
import { startGesture } from './gesture';
import { startGradient } from './paintops';
import { faceSetStroke } from './facesetbrush';
import { automaskButton, automaskSettings } from './sculptmenus';
import { faceMaskOn, isSelectTool, PAINT_SELECT_TOOLS, vertMaskOn } from './selmask';
import { cursorState, updateCursor } from './cursor';
import { sculptStroke } from './sculpt';
import { gestureToolPointer, gestureTools, registerToolSettings, sculptToolHooks, sculptToolSlots } from './sculpttools';
import { operators } from '../app/app';
import { vertexPaintStroke, sampleVertexColor } from './vpaint';
import { weightPaintStroke, sampleWeight, ensureActiveGroup } from './wpaint';
import { texturePaintStroke, sampleImageColor, paintImage, meshHasUVs } from './tpaint';
import { strokeActive } from './stroke';
import { activeMeshData } from './session';
import { invalidatePaintAttributes } from './display';
import { falloff as falloffFn } from './math';

// ---------------------------------------------------------------------------
// toolbar

const EXTRA_TOOLS: Record<BrushMode, ToolDef[]> = {
  SCULPT: [],
  VERTEX_PAINT: [],
  WEIGHT_PAINT: [
    {
      id: 'builtin.sample_weight',
      label: 'Sample Weight',
      icon: 'eyedropper',
      shortcut: 'Shift X',
      description: 'Use the weight under the cursor as the brush weight',
    },
    {
      id: 'builtin.sample_vertex_group',
      label: 'Sample Vertex Group',
      icon: 'sample_group',
      shortcut: 'Shift Ctrl X',
      description: 'Pick the active vertex group from the vertex under the cursor',
    },
    {
      id: 'builtin.gradient',
      label: 'Gradient',
      icon: 'weight_gradient',
      shortcut: 'Shift A',
      description: 'Drag to fill the active group with a gradient',
    },
  ],
  TEXTURE_PAINT: [],
};

for (const mode of Object.keys(BRUSH_LISTS) as BrushMode[]) {
  extraToolLists[mode] = () => {
    const out: (ToolDef | null)[] = BRUSH_LISTS[mode].map((b) =>
      b
        ? {
            id: b.id,
            label: b.name,
            icon: b.icon,
            shortcut: b.shortcut,
            description: b.description,
          }
        : null,
    );
    if (EXTRA_TOOLS[mode].length) out.push(null, ...EXTRA_TOOLS[mode]);
    if (mode === 'SCULPT') {
      out.push(null, ...sculptToolSlots((op) => operators.has(op)));
      registerToolSettings(toolSettingsRenderers);
    }
    // selection masking: select tools in front of the brushes
    if (mode !== 'SCULPT' && (faceMaskOn() || vertMaskOn())) out.unshift({ ...PAINT_SELECT_TOOLS[1], alternates: PAINT_SELECT_TOOLS }, null);
    return out;
  };
  for (const b of BRUSH_LISTS[mode]) if (b) toolSettingsRenderers[b.id] = () => toolHeaderSettings(mode);
}
toolSettingsRenderers['builtin.sample_weight'] = () => [h('span', { class: 'th-label' }, 'Click on the mesh to sample the weight'), weightField('th-sw')];
toolSettingsRenderers['builtin.sample_vertex_group'] = () => h('span', { class: 'th-label' }, 'Click on the mesh to pick one of its vertex groups');
const gradientTool = { type: 'LINEAR' };
toolSettingsRenderers['builtin.gradient'] = () => {
  const b = activeBrush('WEIGHT_PAINT');
  return [
    field(110, enumMenu('th-grad', [{ value: 'LINEAR', label: 'Linear' }, { value: 'RADIAL', label: 'Radial' }], gradientTool.type, (x) => ((gradientTool.type = x), changed()), { tip: 'Gradient type' })),
    field(140, weightField('th-gw')),
    b ? field(140, strengthField(b, 'th-gs')) : null,
    h('span', { class: 'th-label' }, 'Drag from full weight to zero'),
  ];
};

// ---------------------------------------------------------------------------
// shared brush widgets

const DIRECTIONAL = new Set(['DRAW', 'DRAW_SHARP', 'CLAY', 'CLAY_STRIPS', 'LAYER', 'INFLATE', 'BLOB', 'CREASE', 'FLATTEN', 'FILL', 'SCRAPE', 'PINCH', 'MASK']);
const PLANE_TOOLS = new Set(['CLAY', 'CLAY_STRIPS', 'FLATTEN', 'FILL', 'SCRAPE']);
const FALLOFFS: [string, string][] = [
  ['SMOOTH', 'Smooth'],
  ['SPHERE', 'Sphere'],
  ['ROOT', 'Root'],
  ['SHARP', 'Sharp'],
  ['LINEAR', 'Linear'],
  ['CONSTANT', 'Constant'],
  ['INVERSE_SQUARE', 'Inverse Square'],
];
const BLENDS: [string, string][] = [
  ['MIX', 'Mix'],
  ['ADD', 'Add'],
  ['SUB', 'Subtract'],
  ['MUL', 'Multiply'],
  ['LIGHTEN', 'Lighten'],
  ['DARKEN', 'Darken'],
];
const TEX_BLENDS: [string, string][] = [...BLENDS, ['ERASE_ALPHA', 'Erase Alpha']];
const DIR_LABELS: Record<string, [string, string]> = {
  FLATTEN: ['Flatten', 'Contrast'],
  FILL: ['Fill', 'Deepen'],
  SCRAPE: ['Scrape', 'Peaks'],
  PINCH: ['Pinch', 'Magnify'],
  INFLATE: ['Inflate', 'Deflate'],
};

function changed() {
  app.changed('ui');
  const v = activeView3D();
  if (v) v.drawSvg();
}

function radiusField(b: PaintBrush, id: string, label = 'Radius') {
  return numberField({
    id,
    label,
    value: b.radius,
    min: 1,
    max: 2000,
    int: true,
    unit: 'none',
    tip: 'Radius of the brush in pixels (F)',
    set: (x) => ((b.radius = Math.round(x)), changed()),
  });
}
function strengthField(b: PaintBrush, id: string) {
  return numberField({
    id,
    label: 'Strength',
    value: b.strength,
    min: 0,
    max: app.doc.mode === 'SCULPT' ? 10 : 1,
    softMax: 1,
    slider: true,
    precision: 3,
    tip: 'How powerful the effect of the brush is when applied (Shift F)',
    set: (x) => ((b.strength = x), changed()),
  });
}
function weightField(id: string) {
  const up = app.doc.scene.tool_settings.unified_paint;
  return numberField({
    id,
    label: 'Weight',
    value: up.weight,
    min: 0,
    max: 1,
    slider: true,
    precision: 3,
    tip: 'Weight to paint (Ctrl F)',
    set: (x) => ((up.weight = x), changed()),
  });
}
function directionToggle(b: PaintBrush): VNode | null {
  if (!DIRECTIONAL.has(b.sculpt_tool)) return null;
  const labels = DIR_LABELS[b.sculpt_tool];
  return h(
    'div',
    { key: 'dir', class: 'enum-row' },
    (['ADD', 'SUBTRACT'] as const).map((d) =>
      h(
        'button',
        {
          key: d,
          class: { on: b.direction === d },
          'data-tip': labels ? labels[d === 'ADD' ? 0 : 1] : d === 'ADD' ? 'Add effect of brush' : 'Subtract effect of brush',
          onclick: () => ((b.direction = d), changed()),
        },
        d === 'ADD' ? icon('add') : icon('remove'),
      ),
    ),
  );
}
function falloffMenu(b: PaintBrush, id: string) {
  return enumMenu(
    id,
    FALLOFFS.map(([value, label]) => ({ value, label })),
    b.falloff,
    (x) => ((b.falloff = x as PaintBrush['falloff']), changed()),
    { tip: 'Falloff curve preset' },
  );
}
function colorFields(id: string) {
  const up = app.doc.scene.tool_settings.unified_paint;
  return h(
    'div',
    { key: id, style: { display: 'flex', gap: '2px', alignItems: 'center' } },
    h(
      'div',
      { style: { width: '44px' } },
      colorSwatch(`${id}-c`, up.color, (c) => ((up.color = [c[0], c[1], c[2]]), changed())),
    ),
    h(
      'div',
      { style: { width: '44px' } },
      colorSwatch(`${id}-c2`, up.secondary_color, (c) => ((up.secondary_color = [c[0], c[1], c[2]]), changed())),
    ),
    h(
      'button',
      {
        class: 'hdr-toggle',
        'data-tip': 'Swap Colors (X)',
        onclick: () => app.run('paint.brush_colors_flip'),
      },
      icon('sort'),
    ),
  );
}
function blendMenu(b: PaintBrush, id: string, items: [string, string][]) {
  return enumMenu(
    id,
    items.map(([value, label]) => ({ value, label })),
    b.blend ?? 'MIX',
    (x) => ((b.blend = x as PaintBrush['blend']), changed()),
    { tip: 'Blending mode' },
  );
}
function symmetryToggles(prefix: string) {
  const s = app.doc.scene.tool_settings.sculpt;
  const keys = ['use_symmetry_x', 'use_symmetry_y', 'use_symmetry_z'] as const;
  return h(
    'div',
    {
      key: `${prefix}-sym`,
      style: { display: 'flex', alignItems: 'center', gap: '2px' },
    },
    h('span', { class: 'th-label', 'data-tip': 'Mirror' }, icon('mirror_sym')),
    h(
      'div',
      { class: 'enum-row' },
      keys.map((k, i) =>
        h(
          'button',
          {
            key: k,
            class: { on: s[k] },
            'data-tip': `Mirror brush across the ${'XYZ'[i]} axis`,
            onclick: () => ((s[k] = !s[k]), changed()),
          },
          'XYZ'[i],
        ),
      ),
    ),
  );
}
const field = (w: number, c: Child) => h('div', { style: { width: `${w}px`, flex: 'none' } }, c);

const SYM_DIRS: [string, string][] = [
  ['NEGATIVE_X', '-X to +X'],
  ['POSITIVE_X', '+X to -X'],
  ['NEGATIVE_Y', '-Y to +Y'],
  ['POSITIVE_Y', '+Y to -Y'],
  ['NEGATIVE_Z', '-Z to +Z'],
  ['POSITIVE_Z', '+Z to -Z'],
];
const symState = { direction: 'NEGATIVE_X' };

function toolHeaderSettings(mode: BrushMode): Child {
  const b = activeBrush(mode);
  if (!b) return null;
  const parts: Child[] = [];
  if (mode === 'VERTEX_PAINT' || mode === 'TEXTURE_PAINT') {
    if (b.sculpt_tool === 'DRAW' || b.sculpt_tool === 'TEXDRAW' || b.sculpt_tool === 'FILL') {
      parts.push(colorFields('th-col'));
      parts.push(field(110, blendMenu(b, 'th-blend', mode === 'TEXTURE_PAINT' ? TEX_BLENDS : BLENDS)));
    }
  }
  if (mode === 'WEIGHT_PAINT') {
    if (b.sculpt_tool === 'DRAW') parts.push(field(140, weightField('th-w')));
  }
  if (!(mode === 'TEXTURE_PAINT' && b.sculpt_tool === 'FILL')) parts.push(field(140, radiusField(b, 'th-r')));
  parts.push(field(140, strengthField(b, 'th-s')));
  if (mode === 'WEIGHT_PAINT' && b.sculpt_tool === 'DRAW') parts.push(field(100, blendMenu(b, 'th-wblend', BLENDS)));
  if (mode === 'SCULPT') parts.push(directionToggle(b));
  parts.push(field(100, falloffMenu(b, 'th-falloff')));
  parts.push(h('div', { style: { flex: '1' } }));
  if (mode === 'WEIGHT_PAINT')
    parts.push(
      checkbox('th-autonorm', 'Auto Normalize', !!app.doc.scene.tool_settings.use_auto_normalize, (x) => ((app.doc.scene.tool_settings.use_auto_normalize = x), changed()), {
        tip: 'Keep the sum of deform weights at 1 while painting',
      }),
    );
  if (mode === 'SCULPT') parts.push(automaskButton());
  parts.push(symmetryToggles('th'));
  return parts;
}

// ---------------------------------------------------------------------------
// sidebar (Tool tab)

function falloffPreview(b: PaintBrush): VNode {
  const W = 180,
    H = 50;
  let d = '';
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const y = falloffFn(b.falloff, t, b.hardness ?? 0);
    d += `${i ? 'L' : 'M'}${(t * W).toFixed(1)} ${(H - 2 - y * (H - 6)).toFixed(1)}`;
  }
  return h(
    'div',
    { class: 'paint-falloff', style: { padding: '4px 0' } },
    h(
      'svg',
      {
        viewBox: `0 0 ${W} ${H}`,
        width: '100%',
        height: H,
        style: { background: 'rgba(0,0,0,0.25)', borderRadius: '3px' },
      },
      h('path', {
        d: `${d}L${W} ${H}L0 ${H}Z`,
        fill: 'rgba(255,255,255,0.12)',
      }),
      h('path', { d, fill: 'none', stroke: '#ddd', 'stroke-width': 1.5 }),
    ),
  );
}

function brushPanels(mode: BrushMode): Child[] {
  const b = activeBrush(mode);
  const ts = app.doc.scene.tool_settings;
  const out: Child[] = [];
  const tool = activeTools[mode];
  out.push(
    panel(`pt-brushes-${mode}`, 'Brushes', () => [
      enumMenu(
        'pt-brush',
        BRUSH_LISTS[mode].filter((x): x is NonNullable<typeof x> => !!x).map((x) => ({ value: x.id, label: x.name, icon: x.icon })),
        b?.id ?? '',
        (id) => (setActiveTool(id), changed()),
        { tip: 'Active brush' },
      ),
    ]),
  );
  if (gestureTools[tool] || tool?.startsWith('builtin.') || !b) {
    if (tool === 'builtin.sample_weight') out.push(panel('pt-sw', 'Sample Weight', () => [weightField('pt-sw-w')]));
  } else {
    out.push(
      panel(`pt-brush-${mode}`, 'Brush Settings', () => {
        const rows: Child[] = [];
        if (mode === 'VERTEX_PAINT' || mode === 'TEXTURE_PAINT') {
          if (b.sculpt_tool === 'DRAW' || b.sculpt_tool === 'TEXDRAW' || b.sculpt_tool === 'FILL') {
            rows.push(row('Color', colorFields('pt-col')));
            rows.push(row('Blend', blendMenu(b, 'pt-blend', mode === 'TEXTURE_PAINT' ? TEX_BLENDS : BLENDS)));
          }
        }
        if (mode === 'WEIGHT_PAINT') {
          rows.push(weightField('pt-w'));
          if (b.sculpt_tool === 'DRAW') rows.push(row('Blend', blendMenu(b, 'pt-wblend', BLENDS)));
        }
        rows.push(radiusField(b, 'pt-r'), strengthField(b, 'pt-s'));
        if (mode === 'SCULPT') {
          const dt = directionToggle(b);
          if (dt) rows.push(row('Direction', dt));
          if (b.sculpt_tool === 'MASK')
            rows.push(
              row(
                'Mask Tool',
                enumMenu(
                  'pt-masktool',
                  [
                    { value: 'DRAW', label: 'Draw' },
                    { value: 'SMOOTH', label: 'Smooth' },
                  ],
                  b.mask_tool ?? 'DRAW',
                  (x) => ((b.mask_tool = x as 'DRAW'), changed()),
                ),
              ),
            );
          rows.push(
            numberField({
              id: 'pt-nr',
              label: 'Normal Radius',
              value: b.normal_radius_factor ?? 0.5,
              min: 0,
              max: 2,
              slider: true,
              tip: 'Ratio between the brush radius and the radius used to sample the area normal',
              set: (x) => ((b.normal_radius_factor = x), changed()),
            }),
          );
          rows.push(
            numberField({
              id: 'pt-hard',
              label: 'Hardness',
              value: b.hardness ?? 0,
              min: 0,
              max: 1,
              slider: true,
              tip: 'How close the brush falloff starts from the edge',
              set: (x) => ((b.hardness = x), changed()),
            }),
          );
          if (b.sculpt_tool !== 'SMOOTH' && b.sculpt_tool !== 'MASK')
            rows.push(
              numberField({
                id: 'pt-as',
                label: 'Auto-Smooth',
                value: b.auto_smooth_factor ?? 0,
                min: 0,
                max: 1,
                slider: true,
                tip: 'Smooth the surface after each dab',
                set: (x) => ((b.auto_smooth_factor = x), changed()),
              }),
            );
          if (PLANE_TOOLS.has(b.sculpt_tool))
            rows.push(
              numberField({
                id: 'pt-po',
                label: 'Plane Offset',
                value: b.plane_offset ?? 0,
                min: -2,
                max: 2,
                softMin: -0.5,
                softMax: 0.5,
                slider: true,
                tip: 'Offset of the brush plane from the surface',
                set: (x) => ((b.plane_offset = x), changed()),
              }),
            );
          if (b.sculpt_tool === 'CREASE')
            rows.push(
              numberField({
                id: 'pt-pinch',
                label: 'Pinch',
                value: b.crease_pinch_factor ?? 0.5,
                min: 0,
                max: 1,
                slider: true,
                set: (x) => ((b.crease_pinch_factor = x), changed()),
              }),
            );
        }
        rows.push(checkbox('pt-ff', 'Front Faces Only', !!b.use_frontface, (x) => ((b.use_frontface = x), changed()), { tip: 'Brush only affects vertices facing the viewer' }));
        if (mode === 'TEXTURE_PAINT') {
          rows.push(checkbox('pt-occ', 'Occlude', b.use_occlude !== false, (x) => ((b.use_occlude = x), changed()), { tip: 'Only paint onto the faces directly under the brush' }));
          rows.push(checkbox('pt-bfc', 'Backface Culling', b.use_backface_culling !== false, (x) => ((b.use_backface_culling = x), changed()), { tip: 'Ignore faces pointing away from the view' }));
        }
        return rows;
      }),
    );
    out.push(
      panel(`pt-stroke-${mode}`, 'Stroke', () => [
        row('Stroke Method', enumMenu('pt-sm', strokeMethods(mode).map(([value, label]) => ({ value, label })), b.stroke_method ?? 'SPACE', (x) => ((b.stroke_method = x as PaintBrush['stroke_method']), changed()), { tip: 'How dabs are placed along the stroke (Alt E)' })),
        (b.stroke_method ?? 'SPACE') === 'SPACE' || b.stroke_method === 'LINE' || b.stroke_method === 'AIRBRUSH'
          ? numberField({
              id: 'pt-sp',
              label: 'Spacing',
              value: b.spacing ?? 10,
              min: 1,
              max: 1000,
              int: true,
              unit: 'percentage',
              tip: 'Spacing between dabs as a percentage of the brush radius',
              set: (x) => ((b.spacing = Math.round(x)), changed()),
            })
          : null,
        b.stroke_method === 'AIRBRUSH'
          ? numberField({ id: 'pt-rate', label: 'Rate', value: b.rate ?? 0.1, min: 0.0001, max: 10, precision: 3, unit: 'time', tip: 'Interval between airbrush dabs (seconds)', set: (x) => ((b.rate = x), changed()) })
          : null,
        b.stroke_method !== 'LINE' && b.stroke_method !== 'ANCHORED'
          ? checkbox('pt-stab', 'Stabilize Stroke', !!b.use_smooth_stroke, (x) => ((b.use_smooth_stroke = x), changed()), { tip: 'Let the brush trail behind the pointer for smoother lines (Shift S)' })
          : null,
        b.use_smooth_stroke && b.stroke_method !== 'LINE' && b.stroke_method !== 'ANCHORED'
          ? [
              numberField({ id: 'pt-stab-r', label: 'Radius', value: b.smooth_stroke_radius ?? 75, min: 10, max: 200, int: true, unit: 'pixel', tip: 'Distance the brush trails behind the pointer', set: (x) => ((b.smooth_stroke_radius = Math.round(x)), changed()) }),
              numberField({ id: 'pt-stab-f', label: 'Factor', value: b.smooth_stroke_factor ?? 0.9, min: 0.5, max: 0.99, slider: true, tip: 'How smoothly the brush follows', set: (x) => ((b.smooth_stroke_factor = x), changed()) }),
            ]
          : null,
        mode !== 'SCULPT'
          ? checkbox('pt-acc', 'Accumulate', !!b.use_accumulate, (x) => ((b.use_accumulate = x), changed()), {
              tip: 'Keep adding within a stroke instead of limiting it to the brush strength',
            })
          : null,
      ]),
    );
    out.push(
      panel(`pt-falloff-${mode}`, 'Falloff', () => [
        row('Preset', falloffMenu(b, 'pt-fo')),
        falloffPreview(b),
        mode !== 'TEXTURE_PAINT'
          ? row(
              'Shape',
              enumMenu(
                'pt-fshape',
                [
                  { value: 'SPHERE', label: 'Sphere' },
                  { value: 'PROJECTED', label: 'Projected' },
                ],
                b.falloff_shape ?? 'SPHERE',
                (x) => ((b.falloff_shape = x as 'SPHERE'), changed()),
                { tip: 'Sphere: 3D distance. Projected: screen-space circle' },
              ),
            )
          : null,
      ]),
    );
  }
  if (mode === 'WEIGHT_PAINT') {
    const am = activeMeshData();
    out.push(
      panel('pt-wp-opts', 'Options', () => [
        checkbox('pt-an', 'Auto Normalize', !!ts.use_auto_normalize, (x) => ((ts.use_auto_normalize = x), changed()), { tip: 'Ensure all deform vertex groups sum to 1 while painting' }),
        am
          ? row(
              'Group',
              enumMenu(
                'pt-vg',
                am.me.vertex_groups.map((g, i) => ({
                  value: String(i),
                  label: g.name,
                  icon: 'group_vertex',
                })),
                String(am.ob.vertex_group_active_index ?? 0),
                (x) => ((am.ob.vertex_group_active_index = Number(x)), invalidatePaintAttributes(), app.changed('doc')),
                { tip: 'Active vertex group' },
              ),
              button(
                'pt-vg-add',
                icon('add'),
                () => {
                  app.run('object.vertex_group_add');
                  invalidatePaintAttributes();
                },
                { tip: 'Add vertex group' },
              ),
            )
          : null,
      ]),
    );
  }
  if (mode === 'VERTEX_PAINT') {
    const am = activeMeshData();
    if (am)
      out.push(
        panel('pt-vp-attr', 'Color Attribute', () => [
          enumMenu(
            'pt-ca',
            am.me.color_attributes.map((c, i) => ({
              value: String(i),
              label: `${c.name} (${c.domain === 'POINT' ? 'Vertex' : 'Face Corner'})`,
              icon: 'group_vcol',
            })),
            String(am.me.active_color_index),
            (x) => ((am.me.active_color_index = Number(x)), app.pushUndo('Active Color Attribute'), app.changed('doc')),
          ),
        ]),
      );
  }
  if (mode === 'TEXTURE_PAINT') {
    const am = activeMeshData();
    const img = paintImage();
    out.push(
      panel('pt-slots', 'Texture Slots', () => [
        img ? h('div', { class: 'sb-label' }, icon('texture'), ` ${img.name} (${img.width}×${img.height})`) : h('div', { class: 'sb-label' }, 'Missing texture'),
        am && !meshHasUVs(am.me) ? [h('div', { class: 'sb-label', style: { color: '#e66' } }, 'Missing UVs'), opButton('paint.add_simple_uvs', 'Add Simple UVs')] : null,
        opButton('paint.add_texture_paint_slot', 'New Base Color Texture', {}, { icon: 'add' }),
      ]),
    );
  }
  if (mode === 'SCULPT') {
    const am = activeMeshData();
    if (am)
      out.push(
        panel('pt-remesh', 'Remesh', () => [
          numberField({
            id: 'pt-voxel',
            label: 'Voxel Size',
            value: am.me.remesh_voxel_size ?? 0.1,
            min: 0.0001,
            max: 10,
            unit: 'distance',
            precision: 4,
            tip: 'Size of the voxel used for volume evaluation (smaller = more detail)',
            set: (x, final) => ((am.me.remesh_voxel_size = x), app.changed('ui'), final && app.pushUndo('Voxel Size')),
          }),
          opButton('object.voxel_remesh', 'Voxel Remesh'),
        ]),
      );
  }
  if (mode === 'SCULPT') out.push(panel('pt-automask', 'Auto-Masking', () => automaskSettings('pt-am')));
  out.push(
    panel(`pt-sym-${mode}`, 'Symmetry', () => [
      row('Mirror', symmetryToggles('pt')),
      mode === 'SCULPT'
        ? [
            row('Direction', enumMenu('pt-symdir', SYM_DIRS.map(([value, label]) => ({ value, label })), symState.direction, (x) => ((symState.direction = x), changed()), { tip: 'Which half is copied over the other' })),
            opButton('sculpt.symmetrize', 'Symmetrize', { direction: symState.direction }),
          ]
        : null,
    ]),
  );
  return out;
}

const toolTab = sidebarTabs.find((t) => t.id === 'Tool');
if (toolTab) {
  const orig = toolTab.draw;
  toolTab.draw = (v: View3D) => {
    const mode = app.doc.mode;
    if (!isBrushMode(mode)) return orig(v);
    return [...brushPanels(mode), panel('sb-workspace', 'Workspace', () => [h('div', { class: 'sb-label' }, `Mode: ${mode[0] + mode.slice(1).toLowerCase().replace('_', ' ')}`)])];
  };
}

// ---------------------------------------------------------------------------
// header menus

const sc = (km: string, op: string, props?: Record<string, unknown>) => {
  const k = (keymaps[km] ?? []).find((x) => x.op === op && (!props || Object.entries(props).every(([p, v]) => x.props?.[p] === v)));
  return k ? keyLabel(k) : undefined;
};

const vpMenu = (): MenuItem[] => [
  { label: 'Smooth Vertex Colors', op: 'paint.vertex_color_smooth' },
  { label: 'Dirty Vertex Colors', op: 'paint.vertex_color_dirt' },
  { label: 'Vertex Color from Weight', op: 'paint.vertex_color_from_weight' },
  { separator: true },
  { label: 'Invert', op: 'paint.vertex_color_invert' },
  { label: 'Levels', op: 'paint.vertex_color_levels' },
  { label: 'Hue/Saturation/Value', op: 'paint.vertex_color_hsv' },
  { label: 'Brightness/Contrast', op: 'paint.vertex_color_brightness_contrast' },
  { separator: true },
  { label: 'Set Color Attribute', op: 'paint.vertex_color_set', shortcut: 'Ctrl X' },
  { label: 'Sample Color', op: 'paint.sample_color', shortcut: 'Shift X' },
  { label: 'Swap Colors', op: 'paint.brush_colors_flip', shortcut: 'X' },
];

modeMenus.VERTEX_PAINT = {
  ...modeMenus.VERTEX_PAINT,
  header: () => [['Paint', vpMenu]],
  context: vpMenu,
};

export const lockMenu = (): MenuItem[] => {
  const l = (label: string, action: string, mask: string): MenuItem => ({ label, op: 'object.vertex_group_lock', props: { action, mask } });
  return [
    l('Lock All', 'LOCK', 'ALL'),
    l('Lock Selected', 'LOCK', 'SELECTED'),
    l('Lock Unselected', 'LOCK', 'UNSELECTED'),
    l('Lock Only Selected', 'LOCK', 'INVERT_UNSELECTED'),
    l('Lock Only Unselected', 'UNLOCK', 'INVERT_UNSELECTED'),
    { separator: true },
    l('Unlock All', 'UNLOCK', 'ALL'),
    l('Unlock Selected', 'UNLOCK', 'SELECTED'),
    l('Unlock Unselected', 'UNLOCK', 'UNSELECTED'),
    { separator: true },
    l('Invert Locks', 'INVERT', 'ALL'),
  ];
};

const wpMenu = (): MenuItem[] => [
  { label: 'Assign Automatic from Bones', op: 'paint.weight_from_bones', props: { type: 'AUTOMATIC' } },
  { label: 'Assign from Bone Envelopes', op: 'paint.weight_from_bones', props: { type: 'ENVELOPES' } },
  { separator: true },
  { label: 'Normalize All', op: 'object.vertex_group_normalize_all' },
  { label: 'Normalize', op: 'object.vertex_group_normalize' },
  { separator: true },
  { label: 'Mirror', op: 'object.vertex_group_mirror' },
  { label: 'Invert', op: 'object.vertex_group_invert' },
  { label: 'Clean', op: 'object.vertex_group_clean' },
  { separator: true },
  { label: 'Quantize', op: 'object.vertex_group_quantize' },
  { label: 'Levels', op: 'object.vertex_group_levels' },
  { label: 'Smooth', op: 'object.vertex_group_smooth' },
  { label: 'Limit Total', op: 'object.vertex_group_limit_total' },
  { separator: true },
  { label: 'Set Weight', op: 'paint.weight_set', shortcut: 'Ctrl X' },
  { label: 'Sample Weight', op: 'paint.weight_sample', shortcut: 'Shift X' },
  { label: 'Sample Group', op: 'paint.weight_sample_group', shortcut: 'Shift Ctrl X' },
  { separator: true },
  { label: 'Gradient (Linear)', op: 'paint.weight_gradient', props: { type: 'LINEAR' }, shortcut: 'Shift A' },
  { label: 'Gradient (Radial)', op: 'paint.weight_gradient', props: { type: 'RADIAL' }, shortcut: 'Shift Alt A' },
  { separator: true },
  { label: 'Locks', submenu: lockMenu },
];

modeMenus.WEIGHT_PAINT = {
  ...modeMenus.WEIGHT_PAINT,
  header: () => [['Weights', wpMenu]],
};

modeMenus.TEXTURE_PAINT = {
  ...modeMenus.TEXTURE_PAINT,
  header: () => [
    [
      'Paint',
      () => [
        { label: 'Add Texture Paint Slot', op: 'paint.add_texture_paint_slot' },
        { label: 'Add Simple UVs', op: 'paint.add_simple_uvs' },
        { separator: true },
        {
          label: 'Sample Color',
          op: 'paint.sample_color',
          shortcut: 'Shift X',
        },
        { label: 'Swap Colors', op: 'paint.brush_colors_flip', shortcut: 'X' },
      ],
    ],
  ],
};

// ---------------------------------------------------------------------------
// operators used by keys / menus

function pointerIn(v: View3D, ev?: { x: number; y: number }) {
  const r = v.el.getBoundingClientRect();
  const x = (ev?.x ?? app.pointer.x) - r.left,
    y = (ev?.y ?? app.pointer.y) - r.top;
  return { x, y };
}

let previousBrush: Record<string, string> = {};

registerOperators([
  {
    idname: 'paint.brush_select',
    label: 'Select Brush',
    props: [
      { id: 'brush', label: 'Brush', type: 'string', default: '' },
      { id: 'toggle', label: 'Toggle', type: 'bool', default: false },
    ],
    undo: false,
    internal: true,
    poll: () => isBrushMode(app.doc.mode),
    exec: (_ctx, p) => {
      const mode = app.doc.mode;
      const id = p.brush as string;
      if (!app.doc.brushes[id] && !id.startsWith('builtin.')) return 'CANCELLED';
      const cur = activeTools[mode];
      if (p.toggle && cur === id && previousBrush[mode]) setActiveTool(previousBrush[mode]);
      else {
        if (cur !== id) previousBrush[mode] = cur;
        setActiveTool(id);
      }
      changed();
    },
  },
  {
    idname: 'paint.brush_colors_flip',
    label: 'Swap Colors',
    description: 'Swap primary and secondary brush colors',
    undo: false,
    poll: () => app.doc.mode === 'VERTEX_PAINT' || app.doc.mode === 'TEXTURE_PAINT',
    exec: () => {
      const up = app.doc.scene.tool_settings.unified_paint;
      const c = up.color;
      up.color = up.secondary_color;
      up.secondary_color = c;
      changed();
    },
  },
  {
    idname: 'paint.sample_color',
    label: 'Sample Color',
    description: 'Use the color under the cursor as the brush color',
    undo: false,
    poll: () => (app.doc.mode === 'TEXTURE_PAINT' || app.doc.mode === 'VERTEX_PAINT') && !!activeView3D(),
    exec: (ctx) => {
      const v = activeView3D()!;
      const p = pointerIn(v, ctx.event);
      const ok = app.doc.mode === 'VERTEX_PAINT' ? sampleVertexColor(v, p.x, p.y) : sampleImageColor(v, p.x, p.y);
      if (!ok) return 'CANCELLED';
      changed();
    },
  },
  {
    idname: 'paint.weight_sample',
    label: 'Sample Weight',
    description: 'Use the weight of the active group under the cursor as the brush weight',
    undo: false,
    poll: () => app.doc.mode === 'WEIGHT_PAINT' && !!activeView3D(),
    exec: (ctx) => {
      const v = activeView3D()!;
      const p = pointerIn(v, ctx.event);
      const w = sampleWeight(v, p.x, p.y);
      if (w === null) return 'CANCELLED';
      app.doc.scene.tool_settings.unified_paint.weight = w;
      app.report('INFO', `Weight: ${w.toFixed(3)}`);
      changed();
    },
  },
]);

// ---------------------------------------------------------------------------
// keymaps (dispatched from the viewport before the generic 3D View keys)

const sculptMode = () => app.doc.mode === 'SCULPT';
const brushKey = (key: string, brush: string, mods: Partial<KeyItem> = {}): KeyItem => ({
  key,
  op: 'paint.brush_select',
  props: { brush, ...(brush === 'brush_mask' ? { toggle: true } : {}) },
  ...mods,
});
const common = (extra: KeyItem[] = []): KeyItem[] => [
  { key: 'F', op: 'wm.radial_control', props: { data: 'size' } },
  {
    key: 'F',
    shift: true,
    op: 'wm.radial_control',
    props: { data: 'strength' },
  },
  { key: 'LEFT_BRACKET', op: 'brush.scale_size', props: { scalar: 0.9 } },
  { key: 'RIGHT_BRACKET', op: 'brush.scale_size', props: { scalar: 1 / 0.9 } },
  ...extra,
];

addKeys('Sculpt', [
  ...common([
    brushKey('V', 'brush_draw'),
    brushKey('S', 'brush_smooth'),
    brushKey('P', 'brush_pinch'),
    brushKey('I', 'brush_inflate'),
    brushKey('G', 'brush_grab'),
    brushKey('T', 'brush_scrape', { shift: true }),
    brushKey('C', 'brush_clay_strips'),
    brushKey('C', 'brush_crease', { shift: true }),
    brushKey('K', 'brush_snake_hook'),
    brushKey('M', 'brush_mask'),
    {
      key: 'M',
      alt: true,
      op: 'paint.mask_flood_fill',
      props: { mode: 'VALUE', value: 0 },
    },
    {
      key: 'I',
      ctrl: true,
      op: 'paint.mask_flood_fill',
      props: { mode: 'INVERT' },
    },
    { key: 'B', op: 'paint.mask_box_gesture' },
    { key: 'R', ctrl: true, op: 'object.voxel_remesh' },
    { key: 'A', menu: () => maskPieAsMenu(), menuTitle: 'Mask Edit' },
  ]).map((k) => ({ ...k, when: sculptMode })),
]);
addKeys('Vertex Paint', [
  ...common([
    { key: 'X', op: 'paint.brush_colors_flip' },
    { key: 'X', shift: true, op: 'paint.sample_color' },
    { key: 'X', ctrl: true, op: 'paint.vertex_color_set' },
  ]),
]);
addKeys('Weight Paint', [
  ...common([
    { key: 'X', shift: true, ctrl: true, op: 'paint.weight_sample_group' },
    { key: 'A', shift: true, op: 'paint.weight_gradient', props: { type: 'LINEAR' } },
    { key: 'A', shift: true, alt: true, op: 'paint.weight_gradient', props: { type: 'RADIAL' } },
    { key: 'K', menu: () => lockPie(), menuTitle: 'Vertex Group Locks' },
    {
      key: 'F',
      ctrl: true,
      op: 'wm.radial_control',
      props: { data: 'weight' },
    },
    { key: 'X', shift: true, op: 'paint.weight_sample' },
    { key: 'X', ctrl: true, op: 'paint.weight_set' },
  ]),
]);
addKeys('Image Paint', [
  ...common([
    { key: 'X', op: 'paint.brush_colors_flip' },
    { key: 'X', shift: true, op: 'paint.sample_color' },
  ]),
]);

/** Mask pie (A): shown as a pie around the pointer. */
function maskPieAsMenu(): MenuItem[] {
  openPie(
    'Mask Edit',
    [
      {
        label: 'Invert Mask',
        op: 'paint.mask_flood_fill',
        props: { mode: 'INVERT' },
      },
      {
        label: 'Clear Mask',
        op: 'paint.mask_flood_fill',
        props: { mode: 'VALUE', value: 0 },
      },
      {
        label: 'Smooth Mask',
        op: 'sculpt.mask_filter',
        props: { filter_type: 'SMOOTH' },
      },
      {
        label: 'Sharpen Mask',
        op: 'sculpt.mask_filter',
        props: { filter_type: 'SHARPEN' },
      },
      {
        label: 'Grow Mask',
        op: 'sculpt.mask_filter',
        props: { filter_type: 'GROW' },
      },
      {
        label: 'Shrink Mask',
        op: 'sculpt.mask_filter',
        props: { filter_type: 'SHRINK' },
      },
      {
        label: 'Increase Contrast',
        op: 'sculpt.mask_filter',
        props: { filter_type: 'CONTRAST_INCREASE' },
      },
      {
        label: 'Decrease Contrast',
        op: 'sculpt.mask_filter',
        props: { filter_type: 'CONTRAST_DECREASE' },
      },
    ],
    app.pointer.x,
    app.pointer.y,
    'A',
  );
  return [];
}

const KEYMAP_OF: Record<BrushMode, string> = {
  SCULPT: 'Sculpt',
  VERTEX_PAINT: 'Vertex Paint',
  WEIGHT_PAINT: 'Weight Paint',
  TEXTURE_PAINT: 'Image Paint',
};
/** Generic 3D View keys that act on objects and must not fire in paint modes. */
const BLOCKED = new Set(['G', 'R', 'S', 'B', 'C', 'W', 'A', 'I', 'K', 'M', 'H', 'X', 'DEL']);

function matchKey(k: KeyItem, name: string, e: KeyboardEvent) {
  if (k.key !== name) return false;
  const ctrl = e.ctrlKey || e.metaKey;
  return !!k.shift === e.shiftKey && !!k.ctrl === ctrl && !!k.alt === e.altKey;
}

function paintKey(v: View3D, e: KeyboardEvent): boolean {
  const mode = app.doc.mode;
  if (!isBrushMode(mode)) return false;
  const name = keyName(e);
  if (e.repeat && name !== 'LEFT_BRACKET' && name !== 'RIGHT_BRACKET') return BLOCKED.has(name);
  for (const k of keymaps[KEYMAP_OF[mode]] ?? []) {
    if (!matchKey(k, name, e)) continue;
    if (k.when && !k.when()) continue;
    if (k.menu) {
      // pies open themselves and return no items; plain menus open at the pointer
      const items = k.menu();
      if (items.length) openMenu(items, { x: app.pointer.x, y: app.pointer.y }, { title: k.menuTitle });
      return true;
    }
    if (!k.op || !app.poll(k.op, v.area as never)) continue;
    app.run(k.op, k.props ?? {}, {
      event: { x: app.pointer.x, y: app.pointer.y },
    });
    return true;
  }
  // swallow plain object-mode keys (transform, select tools) that would act on the object
  return !e.ctrlKey && !e.metaKey && !e.altKey && BLOCKED.has(name);
}

// ---------------------------------------------------------------------------
// viewport hooks

editModeHooks.pointer.push((v, e) => {
  const mode = app.doc.mode;
  if (!isBrushMode(mode)) return false;
  const ob = app.activeObject;
  if (!ob || ob.type !== 'MESH') return false;
  const tool = activeTools[mode];
  if (mode !== 'SCULPT' && isSelectTool(tool)) {
    // select tools pick faces / vertices while a selection mask is on (handled by the viewport)
    if (faceMaskOn() || vertMaskOn()) return false;
    setActiveTool(BRUSH_LISTS[mode].find((b) => !!b)!.id);
  }
  if (mode === 'SCULPT' && tool?.startsWith('builtin.') && !gestureTools[tool]) sculptToolSlots((op) => operators.has(op));
  if (mode === 'SCULPT' && gestureTools[tool]) return gestureToolPointer(v, e, tool);
  if (mode === 'SCULPT' && sculptToolHooks.pointer.some((f) => f(v, e, tool))) return true;
  if (mode === 'WEIGHT_PAINT' && tool === 'builtin.sample_weight') {
    app.run('paint.weight_sample', {}, { event: { x: e.clientX, y: e.clientY } });
    return true;
  }
  if (mode === 'WEIGHT_PAINT' && tool === 'builtin.sample_vertex_group') {
    app.run('paint.weight_sample_group', {}, { event: { x: e.clientX, y: e.clientY } });
    return true;
  }
  if (mode === 'WEIGHT_PAINT' && tool === 'builtin.gradient') {
    const am = activeMeshData();
    if (am && !am.me.vertex_groups.length) ensureActiveGroup(am.ob, am.me);
    startGradient(v, { type: gradientTool.type }, e);
    return true;
  }
  if (mode === 'SCULPT' && e.shiftKey && (e.ctrlKey || e.metaKey) && operators.has('paint.mask_lasso_gesture')) {
    // Shift+Ctrl+drag: lasso mask (with Alt: unmask)
    return startGesture(v, { op: 'paint.mask_lasso_gesture', kind: 'LASSO', props: { value: e.altKey ? 0 : 1 }, label: 'Lasso Mask' }, e);
  }
  if (mode === 'SCULPT' && e.altKey) {
    // Alt: temporary Mask brush (keeps the current radius); Ctrl+Alt removes mask
    const mb = brushById('brush_mask');
    const cur = activeBrush('SCULPT');
    if (mb) {
      sculptStroke(v, e, { ...mb, radius: cur?.radius ?? mb.radius, mask_tool: 'DRAW' });
      return true;
    }
  }
  if (mode === 'SCULPT' && activeBrush('SCULPT')?.sculpt_tool === 'DRAW_FACE_SETS') faceSetStroke(v, e, activeBrush('SCULPT')!);
  else if (mode === 'SCULPT') sculptStroke(v, e);
  else if (mode === 'VERTEX_PAINT') vertexPaintStroke(v, e);
  else if (mode === 'WEIGHT_PAINT') {
    const am = activeMeshData();
    if (am && !am.me.vertex_groups.length) {
      ensureActiveGroup(am.ob, am.me);
      invalidatePaintAttributes();
    }
    weightPaintStroke(v, e);
  } else texturePaintStroke(v, e);
  return true;
});

editModeHooks.hover.push((v, e) => {
  if (!isBrushMode(app.doc.mode)) {
    if (v.el.style.cursor === 'crosshair') v.el.style.cursor = '';
    if (cursorState.inside) {
      cursorState.inside = false;
      cursorState.hit = null;
    }
    return;
  }
  v.el.style.cursor = 'crosshair';
  if (strokeActive()) return;
  const p = v.local(e);
  if ((e.target as HTMLElement).closest?.('.v3d-ui')) {
    if (cursorState.inside) {
      cursorState.inside = false;
      v.drawSvg();
    }
    return;
  }
  updateCursor(v, p.x, p.y);
});

/** Brush settings popover (right-click / W). */
function brushPopover(x: number, y: number) {
  const mode = app.doc.mode as BrushMode;
  openPopover({ x, y }, () => h('div', { class: 'pop-panel' }, h('div', { class: 'pop-title' }, brushInfo(activeBrush(mode)?.id ?? '')?.name ?? 'Brush'), toolHeaderSettingsColumn(mode)), { width: 240 });
}

editModeHooks.context.push((v, e) => {
  if (!isBrushMode(app.doc.mode)) return false;
  brushPopover(e.clientX, e.clientY);
  void v;
  return true;
});

for (const km of ['Sculpt', 'Vertex Paint', 'Weight Paint', 'Image Paint'])
  addKeys(km, [
    {
      key: 'W',
      menu: () => {
        brushPopover(app.pointer.x, app.pointer.y);
        return [];
      },
      when: () => isBrushMode(app.doc.mode),
    },
  ]);

function toolHeaderSettingsColumn(mode: BrushMode): Child {
  const b = activeBrush(mode);
  if (!b) return null;
  return [
    mode === 'VERTEX_PAINT' || mode === 'TEXTURE_PAINT' ? colorFields('ctx-col') : null,
    mode === 'WEIGHT_PAINT' ? weightField('ctx-w') : null,
    radiusField(b, 'ctx-r'),
    strengthField(b, 'ctx-s'),
    mode === 'SCULPT' ? directionToggle(b) : null,
  ];
}

viewportExtensions.push((v) => {
  const orig = v.onKey.bind(v);
  v.onKey = (e: KeyboardEvent) => paintKey(v, e) || orig(e);
  const leave = () => {
    if (cursorState.view === v && cursorState.inside) {
      cursorState.inside = false;
      v.drawSvg();
    }
  };
  v.el.addEventListener('pointerleave', leave);
  return () => {
    v.el.removeEventListener('pointerleave', leave);
    v.onKey = orig;
  };
});

function lockPie(): MenuItem[] {
  const l = (label: string, action: string, mask: string) => ({ label, op: 'object.vertex_group_lock', props: { action, mask } });
  openPie(
    'Vertex Group Locks',
    [l('Lock All', 'LOCK', 'ALL'), l('Unlock All', 'UNLOCK', 'ALL'), l('Unlock Selected', 'UNLOCK', 'SELECTED'), l('Lock Selected', 'LOCK', 'SELECTED'), l('Lock Unselected', 'LOCK', 'UNSELECTED'), l('Lock Only Selected', 'LOCK', 'INVERT_UNSELECTED'), l('Lock Only Unselected', 'UNLOCK', 'INVERT_UNSELECTED'), l('Invert Locks', 'INVERT', 'ALL')],
    app.pointer.x,
    app.pointer.y,
    'K',
  );
  return [];
}

/** Stroke methods offered per mode (anchored / drag dot need a mode that can undo dabs). */
export function strokeMethods(mode: BrushMode): [string, string][] {
  const all: [string, string][] = [
    ['DOTS', 'Dots'],
    ['DRAG_DOT', 'Drag Dot'],
    ['SPACE', 'Space'],
    ['AIRBRUSH', 'Airbrush'],
    ['ANCHORED', 'Anchored'],
    ['LINE', 'Line'],
  ];
  return mode === 'SCULPT' ? all : all.filter(([m]) => m !== 'ANCHORED' && m !== 'DRAG_DOT');
}

registerOperators([
  {
    idname: 'paint.brush_stroke_method_set',
    label: 'Set Stroke Method',
    description: 'Choose how the dabs of the active brush are placed along the stroke',
    props: [{ id: 'method', label: 'Stroke Method', type: 'enum', default: 'SPACE', items: [['DOTS', 'Dots'], ['DRAG_DOT', 'Drag Dot'], ['SPACE', 'Space'], ['AIRBRUSH', 'Airbrush'], ['ANCHORED', 'Anchored'], ['LINE', 'Line']] }],
    undo: false,
    poll: () => isBrushMode(app.doc.mode) && !!activeBrush(app.doc.mode as BrushMode),
    exec: (_c, p) => {
      const mode = app.doc.mode as BrushMode;
      if (!strokeMethods(mode).some(([m]) => m === p.method)) return 'CANCELLED';
      activeBrush(mode)!.stroke_method = p.method as PaintBrush['stroke_method'];
      changed();
    },
  },
  {
    idname: 'paint.brush_smooth_stroke_toggle',
    label: 'Toggle Stabilize Stroke',
    description: 'Let the brush trail behind the pointer for smoother lines',
    undo: false,
    poll: () => isBrushMode(app.doc.mode) && !!activeBrush(app.doc.mode as BrushMode),
    exec: () => {
      const b = activeBrush(app.doc.mode as BrushMode)!;
      b.use_smooth_stroke = !b.use_smooth_stroke;
      app.report('INFO', `Stabilize Stroke ${b.use_smooth_stroke ? 'on' : 'off'}`);
      changed();
    },
  },
]);

function strokeMethodMenu(): MenuItem[] {
  const mode = app.doc.mode as BrushMode;
  const cur = activeBrush(mode)?.stroke_method ?? 'SPACE';
  return strokeMethods(mode).map(([m, label]) => ({ label, active: cur === m, op: 'paint.brush_stroke_method_set', props: { method: m } }));
}
for (const km of ['Sculpt', 'Vertex Paint', 'Weight Paint', 'Image Paint'])
  addKeys(km, [
    { key: 'E', alt: true, menu: strokeMethodMenu, menuTitle: 'Stroke Method', when: () => isBrushMode(app.doc.mode) },
    { key: 'S', shift: true, op: 'paint.brush_smooth_stroke_toggle', when: () => isBrushMode(app.doc.mode) },
  ]);
