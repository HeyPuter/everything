// Grease Pencil viewport UI: toolbars, tool header settings, header menus, sidebar Tool tab,
// keymaps and the radial size / strength control.
import { app, registerOperators } from '../app/app';
import { activeTools } from '../app/prefs';
import { addKeys } from '../app/keymap';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { numberField, enumMenu, colorSwatch, panel, checkbox, row } from '../ui/widgets';
import { openMenu, type MenuItem } from '../ui/menu';
import { extraToolLists, toolSettingsRenderers, toolsByMode, COMMON_TOOLS, setActiveTool, type ToolDef } from '../editors/view3d/toolbar';
import { modeMenus } from '../editors/view3d/modemenus';
import { sidebarTabs } from '../editors/view3d/sidebar';
import { propertiesTabs } from '../editors/properties/properties';
import { editModeHooks, viewportExtensions } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { gpTS, gpBrush, gpOf, DRAW_PRESETS, slotStyle } from './data';
import { drawMenu, sculptMenu } from './menus';
import { guideButton } from './guides';
import { cursorRadius } from './paint';
import type { GPBrush, GPToolSettings } from './types';

// ---------------------------------------------------------------------------
// toolbars

export const DRAW_TOOLS: (ToolDef | null)[] = [
  { id: 'builtin.brush.Draw', label: 'Draw', icon: 'gp_draw', description: 'Draw free-hand strokes (Ctrl: erase, Shift: smooth)' },
  { id: 'builtin.brush.Fill', label: 'Fill', icon: 'gp_fill', description: 'Fill a closed area with the active material' },
  { id: 'builtin.brush.Erase', label: 'Erase', icon: 'gp_erase', description: 'Erase points or whole strokes' },
  { id: 'builtin.brush.Tint', label: 'Tint', icon: 'gp_tint', description: 'Tint the color of strokes and fills' },
  null,
  { id: 'builtin.trim', label: 'Trim', icon: 'gp_trim', description: 'Cut away the parts of strokes inside a lasso, up to where they cross other strokes' },
  null,
  { id: 'builtin.eyedropper', label: 'Eyedropper', icon: 'eyedropper', description: 'Sample a color from the viewport into a material or the brush' },
  null,
  { id: 'builtin.line', label: 'Line', icon: 'gp_line', description: 'Create a line stroke' },
  { id: 'builtin.polyline', label: 'Polyline', icon: 'gp_polyline', description: 'Create a stroke of straight segments' },
  { id: 'builtin.arc', label: 'Arc', icon: 'gp_arc', description: 'Create an arc stroke' },
  { id: 'builtin.curve', label: 'Curve', icon: 'gp_curve', description: 'Create a curved stroke with editable handles' },
  { id: 'builtin.box', label: 'Box', icon: 'gp_box', description: 'Create a rectangle stroke' },
  { id: 'builtin.circle', label: 'Circle', icon: 'gp_circle', description: 'Create a circle stroke' },
  null,
  { id: 'builtin.interpolate', label: 'Interpolate', icon: 'gp_interpolate', description: 'Drag to create an in-between breakdown from the keys around the current frame' },
];

export const SCULPT_TOOLS: ToolDef[] = [
  {
    id: 'builtin.brush.Smooth',
    label: 'Smooth',
    icon: 'gp_sculpt_smooth',
    description: 'Smooth stroke points',
  },
  {
    id: 'builtin.brush.Thickness',
    label: 'Thickness',
    icon: 'gp_sculpt_thickness',
    description: 'Increase or decrease the stroke thickness (Ctrl: invert)',
  },
  {
    id: 'builtin.brush.Strength',
    label: 'Strength',
    icon: 'gp_sculpt_strength',
    description: 'Increase or decrease the stroke opacity (Ctrl: invert)',
  },
  {
    id: 'builtin.brush.Randomize',
    label: 'Randomize',
    icon: 'gp_sculpt_randomize',
    description: 'Introduce jitter to the stroke points',
  },
  {
    id: 'builtin.brush.Grab',
    label: 'Grab',
    icon: 'gp_sculpt_grab',
    description: 'Drag points around',
  },
  {
    id: 'builtin.brush.Push',
    label: 'Push',
    icon: 'gp_sculpt_push',
    description: 'Push points in the direction of the stroke',
  },
  {
    id: 'builtin.brush.Twist',
    label: 'Twist',
    icon: 'gp_sculpt_twist',
    description: 'Rotate points around the brush center (Ctrl: invert)',
  },
  {
    id: 'builtin.brush.Pinch',
    label: 'Pinch',
    icon: 'gp_sculpt_pinch',
    description: 'Pull points toward the brush center (Ctrl: invert)',
  },
  {
    id: 'builtin.brush.Clone',
    label: 'Clone',
    icon: 'gp_sculpt_clone',
    description: 'Paste the copied strokes under the brush (drag to place them)',
  },
];

extraToolLists.PAINT_GREASE_PENCIL = () => DRAW_TOOLS;
extraToolLists.SCULPT_GREASE_PENCIL = () => SCULPT_TOOLS;
toolsByMode.EDIT_GREASEPENCIL = [...COMMON_TOOLS];

// ---------------------------------------------------------------------------
// tool header

function refresh() {
  app.changed('ui');
  activeView3D()?.drawSvg();
}

const field = (w: number, c: Child) => h('div', { style: { width: `${w}px`, flex: 'none' } }, c);

function pressureToggle(b: GPBrush, key: 'use_pressure_size' | 'use_pressure_strength', id: string) {
  return h(
    'button',
    {
      key: id,
      class: { 'hdr-toggle': true, on: !!b[key] },
      'data-tip': key === 'use_pressure_size' ? 'Use Pressure for Size\nThe stylus pressure changes the stroke radius' : 'Use Pressure for Strength\nThe stylus pressure changes the stroke opacity',
      onclick: () => ((b[key] = !b[key]), refresh()),
    },
    icon('gp_pressure'),
  );
}

export function sizeField(b: GPBrush, id: string, label = 'Size') {
  return numberField({
    id,
    label,
    value: b.size,
    min: 1,
    max: 2000,
    softMax: 500,
    int: true,
    tip: 'Brush diameter in pixels (F)',
    set: (x) => ((b.size = Math.round(x)), refresh()),
  });
}
export function strengthField(b: GPBrush, id: string) {
  return numberField({
    id,
    label: 'Strength',
    value: b.strength,
    min: 0,
    max: 1,
    slider: true,
    precision: 3,
    tip: 'Brush strength (Shift F)',
    set: (x) => ((b.strength = x), refresh()),
  });
}

function materialMenu(id: string): Child {
  const ob = app.activeObject;
  const gp = gpOf(app.doc, ob);
  if (!ob || !gp) return null;
  const items = gp.materials.map((mid, i) => ({
    value: String(i),
    label: (mid && app.doc.materials[mid]?.name) || '(empty)',
    icon: 'material',
  }));
  if (!items.length) return h('span', { class: 'th-label' }, 'No material');
  return field(
    140,
    enumMenu(id, items, String(ob.active_material_index), (v) => app.run('grease_pencil.set_active_material', { slot: Number(v) }), { tip: 'Active material: new strokes use it' }),
  );
}

function materialSwatch(): Child {
  const ob = app.activeObject;
  const gp = gpOf(app.doc, ob);
  if (!ob || !gp) return null;
  const st = slotStyle(app.doc, gp, ob.active_material_index);
  if (!st) return null;
  const c = st.show_stroke ? st.color : st.fill_color;
  return h('span', {
    class: 'gp-swatch',
    style: {
      display: 'inline-block',
      width: '14px',
      height: '14px',
      borderRadius: '3px',
      border: '1px solid #000000',
      background: `rgb(${c
        .slice(0, 3)
        .map((x) => Math.round(Math.pow(Math.max(0, Math.min(1, x)), 1 / 2.2) * 255))
        .join(',')})`,
    },
  });
}

function colorModeRow(b: GPBrush, id: string): Child[] {
  return [
    h(
      'div',
      {
        key: `${id}-cm`,
        class: 'btn-row',
        style: { display: 'flex', gap: '1px', flexShrink: '0', flexWrap: 'nowrap' },
      },
      h(
        'button',
        {
          class: { 'hdr-toggle': true, on: b.color_mode !== 'VERTEXCOLOR' },
          'data-tip': 'Material\nPaint with the material color',
          onclick: () => ((b.color_mode = 'MATERIAL'), refresh()),
        },
        icon('material'),
      ),
      h(
        'button',
        {
          class: { 'hdr-toggle': true, on: b.color_mode === 'VERTEXCOLOR' },
          'data-tip': 'Color Attribute\nPaint with the brush color (vertex color)',
          onclick: () => ((b.color_mode = 'VERTEXCOLOR'), refresh()),
        },
        icon('group_vcol'),
      ),
    ),
    b.color_mode === 'VERTEXCOLOR'
      ? field(
          44,
          colorSwatch(`${id}-col`, b.color ?? [0.5, 0.5, 0.5], (c) => ((b.color = [c[0], c[1], c[2]]), refresh())),
        )
      : null,
  ];
}

function drawHeader(): Child {
  const doc = app.doc;
  const ts = gpTS(doc);
  const b = gpBrush(doc, 'builtin.brush.Draw');
  const preset = DRAW_PRESETS.find((p) => p.id === ts.gpencil_draw_brush);
  return [
    field(
      110,
      enumMenu(
        'gp-brush',
        DRAW_PRESETS.map((p) => ({
          value: p.id,
          label: p.name,
          icon: 'gp_draw',
        })),
        preset?.id ?? '',
        (id) => {
          const p = DRAW_PRESETS.find((x) => x.id === id)!;
          ts.gpencil_draw_brush = id;
          Object.assign(b, {
            size: p.size,
            strength: p.strength,
            use_pressure_size: p.use_pressure_size,
            use_pressure_strength: p.use_pressure_strength,
            pen_smooth_factor: p.smooth,
          });
          refresh();
        },
        { tip: 'Brush preset' },
      ),
    ),
    materialSwatch(),
    materialMenu('gp-mat'),
    ...colorModeRow(b, 'gp-draw'),
    field(120, sizeField(b, 'gp-size')),
    pressureToggle(b, 'use_pressure_size', 'gp-ps'),
    field(120, strengthField(b, 'gp-str')),
    pressureToggle(b, 'use_pressure_strength', 'gp-pst'),
  ];
}

const ERASE_MODES = [
  {
    value: 'SOFT',
    label: 'Dissolve',
    description: 'Erase strokes, fading their points strength and thickness',
  },
  {
    value: 'HARD',
    label: 'Point',
    description: 'Erase stroke points (cuts strokes at the eraser edge)',
  },
  { value: 'STROKE', label: 'Stroke', description: 'Erase entire strokes' },
];

toolSettingsRenderers['builtin.brush.Draw'] = drawHeader;
toolSettingsRenderers['builtin.brush.Erase'] = () => {
  const b = gpBrush(app.doc, 'builtin.brush.Erase');
  return [
    field(
      110,
      enumMenu('gp-er-mode', ERASE_MODES, b.eraser_mode ?? 'HARD', (v) => ((b.eraser_mode = v as GPBrush['eraser_mode']), refresh()), { tip: 'Eraser mode' }),
    ),
    field(120, sizeField(b, 'gp-er-size')),
    field(120, strengthField(b, 'gp-er-str')),
    pressureToggle(b, 'use_pressure_strength', 'gp-er-pst'),
  ];
};
toolSettingsRenderers['builtin.brush.Tint'] = () => {
  const b = gpBrush(app.doc, 'builtin.brush.Tint');
  return [
    field(
      44,
      colorSwatch('gp-tint-col', b.color ?? [1, 0, 0], (c) => ((b.color = [c[0], c[1], c[2]]), refresh())),
    ),
    field(120, sizeField(b, 'gp-tint-size')),
    field(120, strengthField(b, 'gp-tint-str')),
    pressureToggle(b, 'use_pressure_strength', 'gp-tint-pst'),
    field(
      90,
      enumMenu(
        'gp-tint-mode',
        [
          { value: 'STROKE', label: 'Stroke' },
          { value: 'FILL', label: 'Fill' },
          { value: 'BOTH', label: 'Stroke & Fill' },
        ],
        b.vertex_mode ?? 'BOTH',
        (v) => ((b.vertex_mode = v as GPBrush['vertex_mode']), refresh()),
        { tip: 'Mode\nTint strokes, fills or both' },
      ),
    ),
  ];
};
toolSettingsRenderers['builtin.brush.Fill'] = () => {
  const b = gpBrush(app.doc, 'builtin.brush.Fill');
  return [
    materialSwatch(),
    materialMenu('gp-fill-mat'),
    ...colorModeRow(b, 'gp-fill'),
    field(
      120,
      enumMenu(
        'gp-fill-layers',
        [
          { value: 'VISIBLE', label: 'All Visible Layers' },
          { value: 'ACTIVE', label: 'Active Layer' },
          { value: 'ABOVE', label: 'Layer Above' },
          { value: 'BELOW', label: 'Layer Below' },
          { value: 'ALL_ABOVE', label: 'All Above' },
          { value: 'ALL_BELOW', label: 'All Below' },
        ],
        b.fill_layer_mode ?? 'VISIBLE',
        (v) => ((b.fill_layer_mode = v as GPBrush['fill_layer_mode']), refresh()),
        { tip: 'Layers\nLayers used as fill boundaries' },
      ),
    ),
    field(
      100,
      numberField({
        id: 'gp-fill-dilate',
        label: 'Dilate',
        value: b.dilate ?? 1,
        min: 0,
        max: 20,
        int: true,
        tip: 'Grow the fill under the boundary lines (pixels)',
        set: (x) => ((b.dilate = Math.round(x)), refresh()),
      }),
    ),
    h(
      'div',
      { class: 'btn-row', key: 'gp-fill-dir', style: { display: 'flex', gap: '1px', flexShrink: '0', flexWrap: 'nowrap' } },
      (
        [
          ['NORMAL', 'gp_fill_normal', 'Normal\nFill the area under the pointer'],
          ['INVERT', 'gp_fill_invert', 'Inverted (Ctrl)\nFill the closed areas next to the one under the pointer'],
        ] as const
      ).map(([d, ic, tip]) =>
        h(
          'button',
          {
            class: { 'hdr-toggle': true, on: (b.fill_direction ?? 'NORMAL') === d },
            'data-tip': tip,
            onclick: () => ((b.fill_direction = d), refresh()),
          },
          icon(ic),
        ),
      ),
    ),
    field(100, sizeField(b, 'gp-fill-size', 'Line')),
    field(
      120,
      numberField({
        id: 'gp-fill-ext',
        label: 'Gap Closure',
        value: b.fill_extend ?? 0,
        min: 0,
        max: 10,
        precision: 3,
        unit: 'distance',
        tip: 'Size of the gaps that are closed: stroke ends are extended (Page Up / Page Down)',
        set: (x) => ((b.fill_extend = Math.max(0, x)), refresh()),
      }),
    ),
    field(
      84,
      enumMenu(
        'gp-fill-extmode',
        [
          { value: 'EXTEND', label: 'Extend', description: 'Continue the stroke ends in their direction' },
          { value: 'RADIUS', label: 'Radius', description: 'Join stroke ends that are close to each other' },
        ],
        b.fill_extend_mode ?? 'EXTEND',
        (v) => ((b.fill_extend_mode = v as GPBrush['fill_extend_mode']), refresh()),
        { tip: 'Gap closure mode (S)' },
      ),
    ),
    h(
      'button',
      {
        key: 'gp-fill-collide',
        class: { 'hdr-toggle': true, on: !!b.use_collide_strokes },
        'data-tip': 'Stroke Collision (D)\nExtension lines stop at the strokes they reach',
        onclick: () => ((b.use_collide_strokes = !b.use_collide_strokes), refresh()),
      },
      icon('gp_trim'),
    ),
    h(
      'button',
      {
        key: 'gp-fill-show',
        class: { 'hdr-toggle': true, on: b.show_fill_extend !== false },
        'data-tip': 'Visual Aids\nShow the gap closure lines while hovering',
        onclick: () => ((b.show_fill_extend = b.show_fill_extend === false), refresh()),
      },
      icon('hide_off'),
    ),
  ];
};
for (const t of ['builtin.line', 'builtin.polyline', 'builtin.arc', 'builtin.curve', 'builtin.box', 'builtin.circle'])
  toolSettingsRenderers[t] = () => {
    const b = gpBrush(app.doc, t);
    return [
      materialSwatch(),
      materialMenu(`gp-prim-mat`),
      field(120, sizeField(b, `gp-prim-size`)),
      field(120, strengthField(b, `gp-prim-str`)),
      field(
        120,
        numberField({
          id: 'gp-prim-sub',
          label: 'Subdivisions',
          value: b.subdivision ?? 6,
          min: 0,
          max: 128,
          int: true,
          tip: 'Number of points per segment',
          set: (x) => ((b.subdivision = Math.round(x)), refresh()),
        }),
      ),
    ];
  };
for (const t of SCULPT_TOOLS)
  toolSettingsRenderers[t.id] = () => {
    const b = gpBrush(app.doc, t.id);
    const dir = ['builtin.brush.Thickness', 'builtin.brush.Strength', 'builtin.brush.Twist', 'builtin.brush.Pinch'].includes(t.id);
    return [
      field(120, sizeField(b, 'gp-sc-size')),
      field(120, strengthField(b, 'gp-sc-str')),
      pressureToggle(b, 'use_pressure_strength', 'gp-sc-pst'),
      dir
        ? h(
            'div',
            { key: 'gp-sc-dir', style: { display: 'flex', gap: '1px', flexShrink: '0', flexWrap: 'nowrap' } },
            h(
              'button',
              {
                class: { 'hdr-toggle': true, on: b.direction !== 'SUBTRACT' },
                'data-tip': 'Add',
                onclick: () => ((b.direction = 'ADD'), refresh()),
              },
              icon('add'),
            ),
            h(
              'button',
              {
                class: { 'hdr-toggle': true, on: b.direction === 'SUBTRACT' },
                'data-tip': 'Subtract',
                onclick: () => ((b.direction = 'SUBTRACT'), refresh()),
              },
              icon('remove'),
            ),
          )
        : null,
    ];
  };

cursorRadius.fn = (tool) => {
  if (tool.startsWith('builtin.brush.') && tool !== 'builtin.brush.Fill') return gpBrush(app.doc, tool).size / 2;
  return null;
};

// ---------------------------------------------------------------------------
// header: placement / drawing plane / onion skins

const PLACEMENTS: {
  value: GPToolSettings['gpencil_stroke_placement_view3d'];
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    value: 'ORIGIN',
    label: 'Origin',
    icon: 'object_datamode',
    description: 'Draw stroke at Object origin',
  },
  {
    value: 'CURSOR',
    label: '3D Cursor',
    icon: 'pivot_cursor',
    description: 'Draw stroke at 3D cursor location',
  },
  {
    value: 'SURFACE',
    label: 'Surface',
    icon: 'snap_face',
    description: 'Stick stroke to surfaces',
  },
  {
    value: 'STROKE',
    label: 'Stroke',
    icon: 'gp_select_strokes',
    description: 'Stick stroke to other strokes',
  },
];
const PLANES: {
  value: GPToolSettings['gpencil_lock_axis'];
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    value: 'VIEW',
    label: 'View',
    icon: 'orientation_view',
    description: 'Align strokes to current view plane',
  },
  {
    value: 'AXIS_Y',
    label: 'Front (X-Z)',
    icon: 'orientation_global',
    description: 'Project strokes to plane locked to Y',
  },
  {
    value: 'AXIS_X',
    label: 'Side (Y-Z)',
    icon: 'orientation_global',
    description: 'Project strokes to plane locked to X',
  },
  {
    value: 'AXIS_Z',
    label: 'Top (X-Y)',
    icon: 'orientation_global',
    description: 'Project strokes to plane locked to Z',
  },
  {
    value: 'CURSOR',
    label: 'Cursor',
    icon: 'orientation_cursor',
    description: 'Align strokes to current 3D cursor orientation',
  },
];

function layerDropdown(): Child {
  const gp = gpOf(app.doc, app.activeObject);
  if (!gp || !gp.layers.length) return null;
  const items = gp.layers.map((l, i) => ({ value: String(i), label: l.name, icon: 'outliner_data_gp_layer' })).reverse();
  return field(110, enumMenu('gp-layer', items, String(gp.active_layer_index), (v) => app.run('grease_pencil.layer_active', { layer: Number(v) }), { tip: 'Active Layer' }));
}

export function placementControls(): Child {
  const ts = gpTS(app.doc);
  const v = activeView3D();
  const onion = v ? ((v.overlay as { use_gpencil_onion_skin?: boolean }).use_gpencil_onion_skin ?? true) : true;
  return h(
    'div',
    {
      key: 'gp-hdr',
      class: 'hdr-group',
      style: { display: 'flex', gap: '4px', alignItems: 'center' },
    },
    field(
      108,
      enumMenu('gp-place', PLACEMENTS, ts.gpencil_stroke_placement_view3d, (x) => ((ts.gpencil_stroke_placement_view3d = x as typeof ts.gpencil_stroke_placement_view3d), refresh()), {
        tip: 'Stroke Placement',
      }),
    ),
    field(
      118,
      enumMenu('gp-plane', PLANES, ts.gpencil_lock_axis, (x) => ((ts.gpencil_lock_axis = x as typeof ts.gpencil_lock_axis), refresh()), { tip: 'Drawing Plane' }),
    ),
    layerDropdown(),
    app.doc.mode === 'PAINT_GREASE_PENCIL' ? guideButton() : null,
    app.doc.mode === 'PAINT_GREASE_PENCIL'
      ? h(
          'button',
          {
            key: 'gp-add',
            class: { 'hdr-toggle': true, on: ts.use_gpencil_draw_additive },
            'data-tip': 'Additive Drawing\nWhen creating new frames, the strokes from the previous/active frame are included as the basis for the new one',
            onclick: () => ((ts.use_gpencil_draw_additive = !ts.use_gpencil_draw_additive), refresh()),
          },
          icon('add'),
        )
      : null,
    app.doc.mode === 'EDIT'
      ? h(
          'button',
          {
            key: 'gp-mf',
            class: {
              'hdr-toggle': true,
              on: ts.use_grease_pencil_multi_frame_editing,
            },
            'data-tip': 'Multi-frame Editing\nEdit strokes of the selected keyframes of all layers',
            onclick: () => ((ts.use_grease_pencil_multi_frame_editing = !ts.use_grease_pencil_multi_frame_editing), app.changed('doc')),
          },
          icon('gp_multiframe'),
        )
      : null,
    v
      ? h(
          'button',
          {
            key: 'gp-onion',
            class: { 'hdr-toggle': true, on: onion },
            'data-tip': 'Onion Skins\nShow ghosts of the keyframes before and after the current frame',
            onclick: () => {
              (v.overlay as { use_gpencil_onion_skin?: boolean }).use_gpencil_onion_skin = !onion;
              refresh();
            },
          },
          icon(onion ? 'onionskin_on' : 'onionskin_off'),
        )
      : null,
  );
}

// ---------------------------------------------------------------------------
// header menus

export { animationMenu, layerMenu } from './menus';

modeMenus.PAINT_GREASE_PENCIL = {
  header: () => [['Draw', drawMenu]],
  select: () => [],
  headerExtra: placementControls,
};
modeMenus.SCULPT_GREASE_PENCIL = {
  header: () => [['Sculpt', sculptMenu]],
  select: () => [],
  headerExtra: placementControls,
};

// ---------------------------------------------------------------------------
// sidebar Tool tab

const GP_BRUSH_MODES: string[] = ['PAINT_GREASE_PENCIL', 'SCULPT_GREASE_PENCIL', 'VERTEX_GREASE_PENCIL', 'WEIGHT_GREASE_PENCIL'];

const num = (b: GPBrush, key: keyof GPBrush, id: string, label: string, o: { min: number; max: number; int?: boolean; slider?: boolean; tip?: string; unit?: string; def: number }) =>
  row(
    '',
    numberField({
      id,
      label,
      value: (b[key] as number | undefined) ?? o.def,
      min: o.min,
      max: o.max,
      int: o.int,
      slider: o.slider,
      precision: o.int ? 0 : 3,
      tip: o.tip,
      set: (x) => (((b as unknown as Record<string, number>)[key] = o.int ? Math.round(x) : x), refresh()),
    }),
  );

const headerCheck = (id: string, on: boolean, set: (v: boolean) => void, tip: string) => checkbox(id, '', on, set, { tip });

/** Draw brush ▸ Stroke: stabilizer, post-processing and randomness. */
function drawStrokePanels(b: GPBrush): Child {
  return panel(
    'gp-sb-stroke',
    'Stroke',
    () => [
      panel(
        'gp-sb-stab',
        'Stabilize Stroke',
        () => [
          num(b, 'smooth_stroke_radius', 'gp-sb-stab-r', 'Radius', { min: 10, max: 200, int: true, def: 75, tip: 'How far the drawing point trails the pointer (pixels)' }),
          num(b, 'smooth_stroke_factor', 'gp-sb-stab-f', 'Factor', { min: 0.5, max: 0.99, slider: true, def: 0.9, tip: 'How slowly the drawing point follows the pointer' }),
        ],
        { sub: true, closed: true, header: headerCheck('gp-sb-stab-on', !!b.use_smooth_stroke, (x) => ((b.use_smooth_stroke = x), refresh()), 'Stabilize the stroke with a lagging drawing point') },
      ),
      panel(
        'gp-sb-post',
        'Post-Processing',
        () => [
          num(b, 'pen_smooth_factor', 'gp-sb-smooth', 'Smooth', { min: 0, max: 2, slider: true, def: 0, tip: 'Amount of smoothing applied after finishing the stroke' }),
          num(b, 'pen_smooth_steps', 'gp-sb-steps', 'Iterations', { min: 0, max: 100, int: true, def: 1, tip: 'Number of smoothing passes' }),
          num(b, 'pen_subdivision_steps', 'gp-sb-subd', 'Subdivisions', { min: 0, max: 3, int: true, def: 0, tip: 'Times each segment is split in two after drawing' }),
          num(b, 'simplify_factor', 'gp-sb-simp', 'Simplify', { min: 0, max: 1, slider: true, def: 0, tip: 'Remove points that hardly change the shape' }),
          checkbox('gp-sb-trim', 'Trim Stroke Ends', !!b.use_trim, (x) => ((b.use_trim = x), refresh()), { tip: 'Cut the loose ends that overshoot where the stroke crosses itself' }),
        ],
        { sub: true, closed: true, header: headerCheck('gp-sb-post-on', b.use_settings_postprocess !== false, (x) => ((b.use_settings_postprocess = x), refresh()), 'Process the stroke after drawing') },
      ),
      panel(
        'gp-sb-rand',
        'Randomize',
        () => [
          num(b, 'random_pressure', 'gp-sb-rr', 'Radius', { min: 0, max: 1, slider: true, def: 0, tip: 'Random variation of the point radius' }),
          num(b, 'random_strength', 'gp-sb-rs', 'Strength', { min: 0, max: 1, slider: true, def: 0, tip: 'Random variation of the point opacity' }),
          num(b, 'pen_jitter', 'gp-sb-rj', 'Jitter', { min: 0, max: 1, slider: true, def: 0, tip: 'Random offset of the points across the stroke' }),
        ],
        { sub: true, closed: true, header: headerCheck('gp-sb-rand-on', !!b.use_settings_random, (x) => ((b.use_settings_random = x), refresh()), 'Add randomness to the stroke') },
      ),
    ],
    { sub: true, closed: true },
  );
}

/** Brush / placement panels for the active Draw or Sculpt tool (viewport sidebar and Properties ▸ Tool). */
export function gpToolPanels(): Child {
  const mode = app.doc.mode;
  const tool = activeTools[mode] ?? '';
  const b = gpBrush(app.doc, tool);
  const ts = gpTS(app.doc);
  const list = (extraToolLists[mode]?.() ?? []).filter((t): t is ToolDef => !!t);
  const brushLike = tool.startsWith('builtin.brush.') || ['builtin.line', 'builtin.polyline', 'builtin.arc', 'builtin.curve', 'builtin.box', 'builtin.circle'].includes(tool);
  return [
    panel('gp-sb-tool', 'Active Tool', () => [
      enumMenu(
        'gp-sb-tools',
        list.map((t) => ({ value: t.id, label: t.label, icon: t.icon })),
        tool,
        (id) => setActiveTool(id),
      ),
    ]),
    !brushLike ? null : panel('gp-sb-brush', 'Brush Settings', () => [
      row('', sizeField(b, 'gp-sb-size')),
      row('', strengthField(b, 'gp-sb-str')),
      checkbox('gp-sb-ps', 'Use Pressure for Size', !!b.use_pressure_size, (x) => ((b.use_pressure_size = x), refresh())),
      checkbox('gp-sb-pst', 'Use Pressure for Strength', !!b.use_pressure_strength, (x) => ((b.use_pressure_strength = x), refresh())),
      tool === 'builtin.brush.Draw' ? drawStrokePanels(b) : null,
      tool === 'builtin.brush.Erase'
        ? row(
            'Mode',
            enumMenu('gp-sb-er', ERASE_MODES, b.eraser_mode ?? 'HARD', (x) => ((b.eraser_mode = x as GPBrush['eraser_mode']), refresh())),
          )
        : null,
    ]),
    mode === 'PAINT_GREASE_PENCIL'
      ? panel('gp-sb-place', 'Stroke Placement', () => [
          row(
            'Placement',
            enumMenu('gp-sb-pl', PLACEMENTS, ts.gpencil_stroke_placement_view3d, (x) => ((ts.gpencil_stroke_placement_view3d = x as typeof ts.gpencil_stroke_placement_view3d), refresh())),
          ),
          ts.gpencil_stroke_placement_view3d === 'SURFACE'
            ? row(
                '',
                numberField({
                  id: 'gp-sb-off',
                  label: 'Offset',
                  value: ts.gpencil_surface_offset,
                  min: 0,
                  max: 10,
                  precision: 3,
                  set: (x) => ((ts.gpencil_surface_offset = x), refresh()),
                }),
              )
            : null,
          row(
            'Drawing Plane',
            enumMenu('gp-sb-plane', PLANES, ts.gpencil_lock_axis, (x) => ((ts.gpencil_lock_axis = x as typeof ts.gpencil_lock_axis), refresh())),
          ),
          checkbox('gp-sb-onback', 'Draw on Back', ts.use_gpencil_draw_onback, (x) => ((ts.use_gpencil_draw_onback = x), refresh())),
          checkbox('gp-sb-additive', 'Additive Drawing', ts.use_gpencil_draw_additive, (x) => ((ts.use_gpencil_draw_additive = x), refresh())),
          checkbox('gp-sb-autokey', 'Auto Keying', app.doc.scene.tool_settings.use_keyframe_insert_auto, (x) => ((app.doc.scene.tool_settings.use_keyframe_insert_auto = x), refresh())),
        ])
      : null,
  ];
}

const toolTab = sidebarTabs.find((t) => t.id === 'Tool');
if (toolTab) {
  const orig = toolTab.draw;
  toolTab.draw = (v: View3D) => (GP_BRUSH_MODES.includes(app.doc.mode) ? gpToolPanels() : orig(v));
}
const propsToolTab = propertiesTabs.find((t) => t.id === 'TOOL');
if (propsToolTab) {
  const orig = propsToolTab.draw;
  propsToolTab.draw = (p) => (GP_BRUSH_MODES.includes(app.doc.mode) ? gpToolPanels() : orig(p));
}

// ---------------------------------------------------------------------------
// radial control (F / Shift F)

const radial: {
  cx: number;
  cy: number;
  value: number;
  data: 'size' | 'strength' | 'weight';
  view: View3D | null;
} = { cx: 0, cy: 0, value: 0, data: 'size', view: null };
let radialActive = false;
const FULL = 200;

registerOperators([
  {
    idname: 'grease_pencil.radial_control',
    label: 'Radial Control',
    description: 'Set the brush size, strength or weight interactively',
    props: [
      {
        id: 'data',
        label: 'Data',
        type: 'enum',
        default: 'size',
        items: [
          ['size', 'Size'],
          ['strength', 'Strength'],
          ['weight', 'Weight'],
        ],
      },
    ],
    poll: () => ['PAINT_GREASE_PENCIL', 'SCULPT_GREASE_PENCIL', 'VERTEX_GREASE_PENCIL', 'WEIGHT_GREASE_PENCIL'].includes(app.doc.mode),
    undo: false,
    invoke: (ctx, p) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      const tool = activeTools[app.doc.mode] ?? '';
      const b = gpBrush(app.doc, tool) as ReturnType<typeof gpBrush> & { weight?: number };
      const data = p.data as 'size' | 'strength' | 'weight';
      const start = data === 'size' ? b.size : data === 'weight' ? (b.weight ?? 1) : b.strength;
      const m = v.local({
        clientX: ctx.event?.x ?? app.pointer.x,
        clientY: ctx.event?.y ?? app.pointer.y,
      });
      const scale = data === 'size' ? 0.5 : 1;
      radial.data = data;
      radial.view = v;
      radial.value = data === 'size' ? start * scale : start;
      radial.cx = m.x - (data === 'size' ? start * scale : start * FULL);
      radial.cy = m.y;
      radialActive = true;
      v.drawSvg();
      const apply = (val: number) => {
        if (data === 'size') b.size = Math.max(1, Math.round(val / scale));
        else if (data === 'weight') b.weight = Math.max(0, Math.min(1, val));
        else b.strength = Math.max(0, Math.min(1, val));
      };
      app.startModal({
        label: 'Radial Control',
        onPointerMove: (e) => {
          const q = v.local(e);
          const d = Math.hypot(q.x - radial.cx, q.y - radial.cy);
          radial.value = data === 'size' ? Math.max(1, d) : Math.min(1, d / FULL);
          apply(radial.value);
          v.drawSvg();
          app.changed('ui');
        },
        onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : 'FINISHED'),
        onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Escape' ? 'CANCELLED' : e.key === 'Enter' ? 'FINISHED' : true),
        cancel: () => {
          apply(data === 'size' ? start * scale : start);
          radialActive = false;
          v.drawSvg();
        },
        finish: () => {
          radialActive = false;
          v.drawSvg();
        },
      });
      return 'RUNNING_MODAL';
    },
  },
]);

editModeHooks.svg.push((v) => {
  if (!radialActive || radial.view !== v) return null;
  const r = radial.data === 'size' ? radial.value : FULL;
  return h(
    'g',
    { key: 'gp-radial', 'pointer-events': 'none' },
    h('circle', {
      cx: radial.cx,
      cy: radial.cy,
      r: Math.max(1, r),
      fill: 'rgba(255, 255, 255,0.06)',
      stroke: '#ffffff',
      'stroke-width': 1.5,
    }),
    radial.data !== 'size'
      ? h('circle', {
          cx: radial.cx,
          cy: radial.cy,
          r: Math.max(0.5, radial.value * FULL),
          fill: 'rgba(255, 255, 255,0.18)',
          stroke: '#ffffff',
          'stroke-width': 1,
        })
      : null,
    h(
      'text',
      {
        x: radial.cx,
        y: radial.cy + 4,
        'text-anchor': 'middle',
        fill: '#ffffff',
        'font-size': 12,
        style: 'paint-order:stroke;stroke:#000000;stroke-width:3px',
      },
      radial.data === 'size' ? `${Math.round(radial.value)} px` : radial.value.toFixed(3),
    ),
  );
});

// ---------------------------------------------------------------------------
// keymap (highest priority in the 3D view while a grease pencil mode is active)

const paintOrSculpt = () => app.doc.mode === 'PAINT_GREASE_PENCIL' || app.doc.mode === 'SCULPT_GREASE_PENCIL';

const fillTool = () => app.doc.mode === 'PAINT_GREASE_PENCIL' && activeTools.PAINT_GREASE_PENCIL === 'builtin.brush.Fill';
const fillBrush = () => gpBrush(app.doc, 'builtin.brush.Fill');
addKeys('Grease Pencil', [
  { key: 'S', when: fillTool, action: () => ((fillBrush().fill_extend_mode = fillBrush().fill_extend_mode === 'RADIUS' ? 'EXTEND' : 'RADIUS'), refresh()) },
  { key: 'D', when: fillTool, action: () => ((fillBrush().use_collide_strokes = !fillBrush().use_collide_strokes), refresh()) },
  { key: 'PAGE_UP', when: fillTool, action: () => ((fillBrush().fill_extend = Math.round(((fillBrush().fill_extend ?? 0) + 0.01) * 1000) / 1000), refresh()) },
  { key: 'PAGE_DOWN', when: fillTool, action: () => ((fillBrush().fill_extend = Math.max(0, Math.round(((fillBrush().fill_extend ?? 0) - 0.01) * 1000) / 1000)), refresh()) },
  { key: 'F', op: 'grease_pencil.radial_control', props: { data: 'size' }, when: paintOrSculpt },
  { key: 'F', shift: true, op: 'grease_pencil.radial_control', props: { data: 'strength' }, when: paintOrSculpt },
]);

viewportExtensions.push((v) => {
  if (!v.keymaps.includes('Grease Pencil')) v.keymaps.unshift('Grease Pencil');
});

void openMenu;
