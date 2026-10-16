// Properties panels for line rendering: Render ▸ Freestyle, View Layer ▸ Freestyle / Line Set /
// Line Style (strokes, colour, alpha, thickness, geometry) and Material ▸ Freestyle Line.
import { app } from '../app/app';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { panel, enumRow, enumMenu, checkbox, textField } from '../ui/widgets';
import { num, bool, enumProp, colorProp, splitRow, objectProp } from '../ui/props';
import { openMenu } from '../ui/menu';
import { uiList } from '../editors/properties/uilist';
import { dataBlockSelector, materialExtraPanels } from '../editors/properties/tabs';
import { viewLayerPanels } from '../render/final/props/viewlayer';
import { renderExtraPanels } from '../render/final/props/render';
import { drawRamp, drawCurves } from '../nodes/editor/rampui';
import type { NodeData } from '../data/types';
import type { RenderSettings, MaterialData } from '../data/types';
import { activeLineSet, freestyleSettings, lineStyleOf, modifierList, MODIFIER_TYPES, COLOR_BLEND, VALUE_BLEND, MATERIAL_ATTRIBUTES, type ModifierKind } from './defaults';
import { EDGE_TYPES, linestyleTable, type LineSet, type LineStyleData, type LineStyleModifier } from './types';

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

const sub = (id: string, title: string, body: () => Child, opts: { closed?: boolean; header?: Child } = {}) => panel(id, title, body, { ...opts, sub: true });

const toggle = <T extends object>(owner: T, key: keyof T & string, label: string, tip?: string): Child =>
  h(
    'button',
    {
      class: { btn: true, on: !!owner[key] },
      'data-tip': tip ?? label,
      onclick: () => {
        (owner as Record<string, unknown>)[key] = !owner[key];
        changed(label);
      },
    },
    label,
  );

const headerCheck = <T extends object>(owner: T, key: keyof T & string, label: string): Child =>
  checkbox(`hdr-fs-${key}`, '', !!owner[key], (v) => {
    (owner as Record<string, unknown>)[key] = v;
    changed(label);
  });

const items = (pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

/** Expanded enum as a row of buttons, data-bound. */
function enumButtons<T extends object>(owner: T, key: keyof T & string, label: string, pairs: [string, string][]): Child {
  return splitRow(
    label,
    enumRow(`fs-${key}`, items(pairs), String(owner[key]), (v) => {
      (owner as Record<string, unknown>)[key] = v;
      changed(`Change ${label}`);
    }),
  );
}

// ---------------------------------------------------------------------------
// Render ▸ Freestyle

renderExtraPanels.push((r: RenderSettings) =>
  panel(
    'rs-freestyle',
    'Freestyle',
    () => [
      enumButtons(r, 'line_thickness_mode', 'Line Thickness Mode', [
        ['ABSOLUTE', 'Absolute'],
        ['RELATIVE', 'Relative'],
      ]),
      (r.line_thickness_mode ?? 'ABSOLUTE') === 'ABSOLUTE'
        ? num(r, 'line_thickness', 'Line Thickness', { unit: 'pixel', min: 0, max: 10000, softMax: 10, tip: 'Scale of line widths in pixels' })
        : h('div', { class: 'prop-note' }, 'Line widths scale with the output height (sizes are for 480 px).'),
      h('div', { class: 'prop-note' }, 'Lines are set up in View Layer ▸ Freestyle.'),
    ],
    {
      closed: true,
      header: checkbox('hdr-use_freestyle', '', !!r.use_freestyle, (v) => {
        r.use_freestyle = v;
        if (v) freestyleSettings(app.doc);
        changed('Freestyle');
      }),
    },
  ),
);

// ---------------------------------------------------------------------------
// View Layer ▸ Freestyle

function settingsPanel(): Child {
  const r = app.doc.scene.render;
  const fs = freestyleSettings(app.doc);
  return panel(
    'vl-freestyle',
    'Freestyle',
    () => [
      r.use_freestyle
        ? null
        : h(
            'div',
            { class: 'prop-note fs-off' },
            'Line drawing is off for renders. ',
            h('button', { class: 'btn', onclick: () => ((r.use_freestyle = true), changed('Freestyle')) }, 'Enable'),
          ),
      bool(fs, 'as_render_pass', 'As Render Pass', { tip: 'Keep the lines in a separate Freestyle pass instead of drawing them over the image' }),
      sub('vl-fs-edges', 'Edge Detection', () => [
        num(fs, 'crease_angle', 'Crease Angle', { unit: 'angle', min: 0, max: Math.PI, tip: 'Edges whose faces meet at an angle sharper than this are creases' }),
        bool(fs, 'use_culling', 'Culling', { tip: 'Ignore edges outside the camera view (faster for large scenes)' }),
        bool(fs, 'use_smoothness', 'Face Smoothness', { tip: 'Draw silhouettes of smooth-shaded faces through the faces instead of along polygon edges' }),
        sub('vl-fs-advanced', 'Advanced', () => [
          num(fs, 'sphere_radius', 'Sphere Radius', { min: 0, max: 1000, tip: 'Size of the neighbourhood for curvature (Suggestive Contours, Ridges & Valleys)' }),
          num(fs, 'kr_derivative_epsilon', 'Kr Derivative Epsilon', { min: -1000, max: 1000, tip: 'Minimum change of curvature for Suggestive Contours (higher gives fewer lines)' }),
        ], { closed: true }),
      ]),
    ],
    { header: headerCheck(fs, 'use_freestyle', 'Freestyle'), className: r.use_freestyle ? '' : 'fs-inactive' },
  );
}

function edgeTypeGrid(set: LineSet): Child {
  return h(
    'div',
    { class: 'fs-edge-grid' },
    EDGE_TYPES.map(([k, label]) => {
      const sk = `select_${k}` as const,
        xk = `exclude_${k}` as const;
      return h(
        'div',
        { key: k, class: 'fs-edge-type' },
        checkbox(`fs-et-${k}`, label, !!set[sk], (v) => ((set[sk] = v), changed(`Select ${label}`))),
        h(
          'button',
          {
            class: { 'hdr-toggle': true, on: !!set[xk] },
            disabled: !set[sk],
            'data-tip': `Exclude ${label}\nSelect edges that are not of this type`,
            onclick: () => ((set[xk] = !set[xk]), changed(`Exclude ${label}`)),
          },
          icon('x'),
        ),
      );
    }),
  );
}

function collectionPicker(set: LineSet): Child {
  const cols = Object.values(app.doc.collections).filter((c) => c.id !== app.doc.scene.collection);
  return splitRow(
    'Line Set Collection',
    enumMenu('fs-ls-col', [{ value: '', label: '—' }, ...cols.map((c) => ({ value: c.id, label: c.name, icon: 'outliner_collection' }))], set.collection ?? '', (v) => ((set.collection = v || null), changed('Line Set Collection'))),
  );
}

function lineSetPanel(): Child {
  const fs = freestyleSettings(app.doc);
  const set = activeLineSet(app.doc);
  return panel('vl-fs-lineset', 'Freestyle Line Set', () => [
    uiList(
      'fs-linesets',
      fs.linesets.map((s, i) => ({
        key: `${s.name}`,
        label: s.name,
        icon: 'line_data',
        rightSize: 'compact' as const,
        right: checkbox(`fs-ls-show-${i}`, '', s.show_render, (v) => ((s.show_render = v), changed('Line Set Render'))),
      })),
      fs.active_lineset_index,
      (i) => ((fs.active_lineset_index = i), app.changed('doc')),
      {
        add: () => app.run('scene.freestyle_lineset_add'),
        remove: () => app.run('scene.freestyle_lineset_remove'),
        rename: (i, name) => ((fs.linesets[i].name = name), changed('Rename Line Set')),
        specials: () => [
          { label: 'Copy Line Set', op: 'scene.freestyle_lineset_copy', icon: 'copydown' },
          { label: 'Paste Line Set', op: 'scene.freestyle_lineset_paste', icon: 'pastedown' },
        ],
        up: fs.linesets.length > 1 ? () => app.run('scene.freestyle_lineset_move', { direction: 'UP' }) : undefined,
        down: fs.linesets.length > 1 ? () => app.run('scene.freestyle_lineset_move', { direction: 'DOWN' }) : undefined,
      },
    ),
    set
      ? [
          splitRow(
            'Selection By',
            h(
              'div',
              { class: 'fs-sel-by' },
              toggle(set, 'select_by_visibility', 'Visibility', 'Select lines by how far they are hidden'),
              toggle(set, 'select_by_edge_types', 'Edge Types', 'Select lines by the kind of edge'),
              toggle(set, 'select_by_face_marks', 'Face Marks', 'Select lines next to marked faces'),
              toggle(set, 'select_by_collection', 'Collection', 'Select lines of the objects in a collection'),
              toggle(set, 'select_by_image_border', 'Image Border', 'Select only lines inside the image'),
            ),
          ),
          set.select_by_visibility
            ? sub('vl-fs-ls-vis', 'Visibility', () => [
                enumButtons(set, 'visibility', 'Type', [
                  ['VISIBLE', 'Visible'],
                  ['HIDDEN', 'Hidden'],
                  ['RANGE', 'QI Range'],
                ]),
                set.visibility === 'RANGE'
                  ? [num(set, 'qi_start', 'Start', { int: true, min: 0, tip: 'Fewest surfaces in front of a selected line' }), num(set, 'qi_end', 'End', { int: true, min: 0, tip: 'Most surfaces in front of a selected line' })]
                  : null,
              ])
            : null,
          set.select_by_edge_types
            ? sub('vl-fs-ls-et', 'Edge Types', () => [
                enumButtons(set, 'edge_type_negation', 'Negation', [
                  ['INCLUSIVE', 'Inclusive'],
                  ['EXCLUSIVE', 'Exclusive'],
                ]),
                enumButtons(set, 'edge_type_combination', 'Combination', [
                  ['OR', 'Logical OR'],
                  ['AND', 'Logical AND'],
                ]),
                edgeTypeGrid(set),
              ])
            : null,
          set.select_by_face_marks
            ? sub('vl-fs-ls-fm', 'Face Marks', () => [
                enumButtons(set, 'face_mark_negation', 'Negation', [
                  ['INCLUSIVE', 'Inclusive'],
                  ['EXCLUSIVE', 'Exclusive'],
                ]),
                enumButtons(set, 'face_mark_condition', 'Condition', [
                  ['ONE', 'One Face'],
                  ['BOTH', 'Both Faces'],
                ]),
              ])
            : null,
          set.select_by_collection
            ? sub('vl-fs-ls-col', 'Collection', () => [
                collectionPicker(set),
                enumButtons(set, 'collection_negation', 'Negation', [
                  ['INCLUSIVE', 'Inclusive'],
                  ['EXCLUSIVE', 'Exclusive'],
                ]),
              ])
            : null,
        ]
      : h('div', { class: 'prop-note' }, 'Add a line set to draw lines.'),
  ]);
}

// ---------------------------------------------------------------------------
// line style

function lineStyleSelector(set: LineSet): Child {
  const t = linestyleTable(app.doc);
  const users = set.linestyle ? freestyleSettings(app.doc).linesets.filter((s) => s.linestyle === set.linestyle).length : 0;
  return dataBlockSelector(
    'fs-linestyle',
    'line_data',
    Object.values(t),
    set.linestyle,
    (id) => ((set.linestyle = id), changed('Assign Line Style')),
    () => app.run('scene.freestyle_linestyle_new'),
    { users, duplicate: () => app.run('scene.freestyle_linestyle_new') },
  );
}

function rampCtx(m: LineStyleModifier, key: string) {
  return {
    node: { id: key, type: 'ShaderNodeFloatCurve', props: m } as unknown as NodeData,
    tree: null as never,
    where: 'properties' as const,
    key,
    changed: (label: string, final = true) => {
      if (final) app.pushUndo(label);
      app.changed('doc');
    },
  };
}

function mappingRows(m: LineStyleModifier, key: string): Child {
  return [
    enumButtons(m, 'mapping', 'Mapping', [
      ['LINEAR', 'Linear'],
      ['CURVE', 'Curve'],
    ]),
    bool(m, 'invert', 'Invert', { tip: 'Reverse the mapped value' }),
    m.mapping === 'CURVE' ? h('div', { class: 'fs-curve' }, drawCurves(rampCtx(m, key))) : null,
  ];
}

/** Type-specific rows of a colour / alpha / thickness modifier. */
function valueRows(kind: ModifierKind, m: LineStyleModifier, key: string): Child {
  const M = m as LineStyleModifier & Record<string, number>;
  const ramp = kind === 'color' ? h('div', { class: 'fs-ramp' }, drawRamp(rampCtx(m, key))) : null;
  const mapping = kind !== 'color' ? mappingRows(m, key) : null;
  const thickRange = (a: string, b: string, l1 = 'Min Thickness', l2 = 'Max Thickness') => (kind === 'thickness' ? [num(M, a, l1, { min: 0, softMax: 100 }), num(M, b, l2, { min: 0, softMax: 100 })] : null);
  switch (m.type) {
    case 'ALONG_STROKE':
      return [ramp, mapping, thickRange('value_min', 'value_max', 'Min Thickness', 'Max Thickness')];
    case 'CREASE_ANGLE':
      return [num(M, 'angle_min', 'Min Angle', { unit: 'angle', min: 0, max: Math.PI }), num(M, 'angle_max', 'Max Angle', { unit: 'angle', min: 0, max: Math.PI }), ramp, mapping, thickRange('thickness_min', 'thickness_max')];
    case 'CURVATURE_3D':
      return [num(M, 'curvature_min', 'Min Curvature', { min: 0, softMax: 10 }), num(M, 'curvature_max', 'Max Curvature', { min: 0, softMax: 10 }), ramp, mapping, thickRange('thickness_min', 'thickness_max')];
    case 'DISTANCE_FROM_CAMERA':
    case 'DISTANCE_FROM_OBJECT':
      return [
        m.type === 'DISTANCE_FROM_OBJECT' ? objectProp(m, 'target' as never, 'Target', { filter: (o) => o.type !== 'GREASEPENCIL' }) : null,
        num(M, 'range_min', 'Range Min', { unit: 'distance', min: 0 }),
        num(M, 'range_max', 'Range Max', { unit: 'distance', min: 0 }),
        h(
          'button',
          {
            class: 'btn fs-fill-range',
            'data-tip': 'Set the range to the distances of the selected objects',
            onclick: () => app.run('scene.freestyle_fill_range_by_selection', { type: kind.toUpperCase(), name: m.name }),
          },
          icon('eyedropper'),
          'Fill Range by Selection',
        ),
        ramp,
        mapping,
        thickRange('value_min', 'value_max'),
      ];
    case 'MATERIAL':
      return [
        enumProp(m, 'material_attribute' as never, 'Material Attribute', MATERIAL_ATTRIBUTES),
        kind === 'color' ? bool(m, 'use_ramp' as never, 'Ramp', { tip: 'Map the attribute through the colour ramp' }) : null,
        kind === 'color' && m.use_ramp ? ramp : null,
        mapping,
        thickRange('value_min', 'value_max'),
      ];
    case 'NOISE':
      return [
        num(M, 'amplitude', 'Amplitude', { min: 0, softMax: 100 }),
        num(M, 'period', 'Period', { min: 0.001, softMax: 100 }),
        num(M, 'seed', 'Seed', { int: true, min: 0 }),
        kind === 'thickness' ? bool(m, 'use_asymmetric' as never, 'Asymmetric', { tip: 'Vary the two sides of the line independently' }) : null,
        ramp,
        kind === 'alpha' ? mapping : null,
      ];
    case 'TANGENT':
      return [ramp, mapping, thickRange('thickness_min', 'thickness_max')];
    case 'CALLIGRAPHY':
      return [num(M, 'orientation', 'Orientation', { unit: 'angle' }), num(M, 'thickness_min', 'Min Thickness', { min: 0, softMax: 100 }), num(M, 'thickness_max', 'Max Thickness', { min: 0, softMax: 100 })];
  }
  return null;
}

function geometryRows(m: LineStyleModifier): Child {
  const M = m as LineStyleModifier & Record<string, number>;
  switch (m.type) {
    case 'SAMPLING':
      return num(M, 'sampling', 'Sampling', { unit: 'pixel', min: 0.1, softMax: 100, tip: 'Distance between the points of the resampled strokes' });
    case 'BEZIER_CURVE':
      return num(M, 'error', 'Error', { min: 0, softMax: 100, tip: 'How far the smooth curve may stray from the stroke' });
    case 'SINUS_DISPLACEMENT':
      return [num(M, 'wavelength', 'Wavelength', { min: 0.001, softMax: 100 }), num(M, 'amplitude', 'Amplitude', { softMin: -100, softMax: 100 }), num(M, 'phase', 'Phase', { softMin: -10, softMax: 10 })];
    case 'SPATIAL_NOISE':
      return [
        num(M, 'amplitude', 'Amplitude', { softMin: -100, softMax: 100 }),
        num(M, 'scale', 'Scale', { min: 0.001, softMax: 100 }),
        num(M, 'octaves', 'Octaves', { int: true, min: 0, max: 8 }),
        bool(m, 'smooth' as never, 'Smooth'),
        bool(m, 'use_pure_random' as never, 'Pure Random', { tip: 'Different noise on every stroke (otherwise the same position always moves the same)' }),
      ];
    case 'PERLIN_NOISE_1D':
    case 'PERLIN_NOISE_2D':
      return [
        num(M, 'frequency', 'Frequency', { min: 0.001, softMax: 100 }),
        num(M, 'amplitude', 'Amplitude', { softMin: -100, softMax: 100 }),
        num(M, 'octaves', 'Octaves', { int: true, min: 0, max: 8 }),
        num(M, 'angle', 'Angle', { unit: 'angle' }),
        num(M, 'seed', 'Seed', { int: true, min: 0 }),
      ];
    case 'BACKBONE_STRETCHER':
      return num(M, 'backbone_length', 'Backbone Length', { unit: 'pixel', min: 0, softMax: 100 });
    case 'TIP_REMOVER':
      return num(M, 'tip_length', 'Tip Length', { unit: 'pixel', min: 0, softMax: 100 });
    case 'POLYGONIZATION':
      return num(M, 'error', 'Error', { unit: 'pixel', min: 0, softMax: 100, tip: 'How far the straight segments may stray from the stroke' });
    case 'GUIDING_LINES':
      return num(M, 'offset', 'Offset', { unit: 'pixel', softMin: -100, softMax: 100 });
    case 'BLUEPRINT':
      return [
        enumButtons(m, 'shape', 'Shape', [
          ['CIRCLES', 'Circles'],
          ['ELLIPSES', 'Ellipses'],
          ['SQUARES', 'Squares'],
        ]),
        num(M, 'rounds', 'Rounds', { int: true, min: 1, max: 1000 }),
        m.shape === 'SQUARES' ? num(M, 'backbone_length', 'Backbone Length', { min: 0, softMax: 100 }) : null,
        m.shape === 'SQUARES' ? num(M, 'random_backbone', 'Random Backbone', { int: true, min: 0 }) : num(M, 'random_radius', 'Random Radius', { int: true, min: 0 }),
        num(M, 'random_center', 'Random Center', { int: true, min: 0 }),
      ];
    case '2D_OFFSET':
      return [num(M, 'start', 'Start', { unit: 'pixel' }), num(M, 'end', 'End', { unit: 'pixel' }), num(M, 'x', 'X', { unit: 'pixel' }), num(M, 'y', 'Y', { unit: 'pixel' })];
    case '2D_TRANSFORM':
      return [
        enumProp(m, 'pivot' as never, 'Pivot', [
          ['CENTER', 'Stroke Center'],
          ['START', 'Stroke Start'],
          ['END', 'Stroke End'],
          ['PARAM', 'Stroke Point Parameter'],
          ['ABSOLUTE', 'Absolute 2D Point'],
        ]),
        m.pivot === 'PARAM' ? num(M, 'pivot_u', 'Stroke Point Parameter', { min: 0, max: 1, slider: true }) : null,
        m.pivot === 'ABSOLUTE' ? [num(M, 'pivot_x', 'Pivot X', { unit: 'pixel' }), num(M, 'pivot_y', 'Pivot Y', { unit: 'pixel' })] : null,
        num(M, 'scale_x', 'Scale X'),
        num(M, 'scale_y', 'Scale Y'),
        num(M, 'angle', 'Rotation Angle', { unit: 'angle' }),
      ];
    case 'SIMPLIFICATION':
      return num(M, 'tolerance', 'Tolerance', { unit: 'pixel', min: 0, softMax: 10 });
  }
  return null;
}

const KIND_OP: Record<ModifierKind, string> = { color: 'scene.freestyle_color_modifier_add', alpha: 'scene.freestyle_alpha_modifier_add', thickness: 'scene.freestyle_thickness_modifier_add', geometry: 'scene.freestyle_geometry_modifier_add' };

function modifierBox(kind: ModifierKind, m: LineStyleModifier, i: number, count: number): Child {
  const key = `fs-mod-${kind}-${i}`;
  const target = { modifier_type: kind.toUpperCase(), index: i };
  const typeLabel = MODIFIER_TYPES[kind].find((t) => t[0] === m.type)?.[1] ?? m.type;
  return h(
    'section',
    { key: `${key}-${m.name}`, class: { panel: true, modifier: true, 'fs-modifier': true, open: m.expanded, disabled: !m.use } },
    h(
      'header',
      {
        class: 'panel-header mod-header',
        onpointerdown: (e: PointerEvent) => {
          if ((e.target as HTMLElement).closest('button, input, label')) return;
          m.expanded = !m.expanded;
          app.changed('doc');
        },
      },
      h('span', { class: 'ph-arrow' }, icon(m.expanded ? 'disclosure_tri_down' : 'disclosure_tri_right')),
      textField(`${key}-name`, m.name, (v) => ((m.name = v), changed('Rename Modifier')), { className: 'mod-name' }),
      h('span', { class: 'fs-mod-type' }, typeLabel),
      h('button', { class: { 'mod-toggle': true, on: m.use }, 'data-tip': 'Use\nEnable or disable this modifier', onclick: () => ((m.use = !m.use), changed('Toggle Modifier')) }, icon(m.use ? 'restrict_render_off' : 'restrict_render_on')),
      h(
        'button',
        {
          class: 'mod-menu',
          'data-tip': 'Modifier options',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu(
              [
                { label: 'Duplicate', icon: 'duplicate', op: 'scene.freestyle_modifier_copy', props: target },
                { separator: true },
                { label: 'Move Up', icon: 'triangle_up', op: 'scene.freestyle_modifier_move', props: { ...target, direction: 'UP' }, disabled: i === 0 },
                { label: 'Move Down', icon: 'triangle_down', op: 'scene.freestyle_modifier_move', props: { ...target, direction: 'DOWN' }, disabled: i === count - 1 },
              ],
              e.currentTarget as HTMLElement,
            );
          },
        },
        icon('down_arrow_hlt'),
      ),
      h('button', { class: 'mod-x', 'data-tip': 'Remove modifier', onclick: () => app.run('scene.freestyle_modifier_remove', target) }, icon('x')),
    ),
    m.expanded
      ? h(
          'div',
          { class: 'panel-body' },
          kind !== 'geometry'
            ? [enumProp(m, 'blend' as never, 'Blend', kind === 'color' ? COLOR_BLEND : VALUE_BLEND), num(m as LineStyleModifier & Record<string, number>, 'influence', 'Influence', { min: 0, max: 1, slider: true })]
            : null,
          kind === 'geometry' ? geometryRows(m) : valueRows(kind, m, key),
        )
      : null,
  );
}

function modifierStack(ls: LineStyleData, kind: ModifierKind): Child {
  const list = modifierList(ls, kind);
  return [
    h(
      'button',
      {
        class: 'btn fs-add-mod',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          openMenu(
            MODIFIER_TYPES[kind].map(([value, label]) => ({ label, op: KIND_OP[kind], props: { type: value } })),
            e.currentTarget as HTMLElement,
          );
        },
      },
      icon('add'),
      'Add Modifier',
      icon('down_arrow_hlt', 'tiny'),
    ),
    list.map((m, i) => modifierBox(kind, m, i, list.length)),
  ];
}

function strokesPanel(ls: LineStyleData): Child {
  const L = ls as unknown as LineStyleData & Record<string, number>;
  const pair = (a: string, b: string, la: string, lb: string) => h('div', { class: 'fs-pair' }, num(L, a, la, { int: true, min: 0, max: 65535, unit: 'pixel' }), num(L, b, lb, { int: true, min: 0, max: 65535, unit: 'pixel' }));
  return panel('vl-fs-strokes', 'Freestyle Strokes', () => [
    sub('vl-fs-chain', 'Chaining', () => [
      enumButtons(ls, 'chaining', 'Method', [
        ['PLAIN', 'Plain'],
        ['SKETCHY', 'Sketchy'],
      ]),
      ls.chaining === 'SKETCHY' ? num(ls, 'rounds', 'Rounds', { int: true, min: 1, max: 1000, tip: 'How many times each chain is traced (rough, overlapping strokes)' }) : null,
      bool(ls, 'use_same_object', 'Same Object', { tip: 'Only join lines of the same object' }),
    ], { header: headerCheck(ls, 'use_chaining', 'Chaining') }),
    sub('vl-fs-split', 'Splitting', () => [
      h('div', { class: 'fs-pair' }, bool(ls, 'use_angle_min', 'Min 2D Angle'), num(ls, 'angle_min', 'Min 2D Angle', { unit: 'angle', min: 0, max: Math.PI, disabled: !ls.use_angle_min })),
      h('div', { class: 'fs-pair' }, bool(ls, 'use_angle_max', 'Max 2D Angle'), num(ls, 'angle_max', 'Max 2D Angle', { unit: 'angle', min: 0, max: Math.PI, disabled: !ls.use_angle_max })),
      h('div', { class: 'fs-pair' }, bool(ls, 'use_split_length', '2D Length'), num(ls, 'split_length', '2D Length', { unit: 'pixel', min: 0, max: 10000, disabled: !ls.use_split_length })),
      bool(ls, 'material_boundary', 'Material Boundary', { tip: 'Split strokes where the material changes' }),
      sub('vl-fs-splitpat', 'Split Pattern', () => [pair('split_dash1', 'split_gap1', 'Dash 1', 'Gap 1'), pair('split_dash2', 'split_gap2', 'Dash 2', 'Gap 2'), pair('split_dash3', 'split_gap3', 'Dash 3', 'Gap 3')], {
        closed: true,
        header: headerCheck(ls, 'use_split_pattern', 'Split Pattern'),
      }),
    ], { closed: true }),
    sub('vl-fs-sort', 'Sorting', () => [
      enumProp(ls, 'sort_key', 'Sort Key', [
        ['DISTANCE_FROM_CAMERA', 'Distance from Camera'],
        ['2D_LENGTH', '2D Length'],
        ['PROJECTED_X', 'Projected X'],
        ['PROJECTED_Y', 'Projected Y'],
      ]),
      ls.sort_key !== '2D_LENGTH'
        ? enumProp(ls, 'integration_type', 'Integration Type', [
            ['MEAN', 'Mean'],
            ['MIN', 'Min'],
            ['MAX', 'Max'],
            ['FIRST', 'First'],
            ['LAST', 'Last'],
          ])
        : null,
      enumButtons(ls, 'sort_order', 'Sort Order', [
        ['DEFAULT', 'Default'],
        ['REVERSE', 'Reverse'],
      ]),
    ], { closed: true, header: headerCheck(ls, 'use_sorting', 'Sorting') }),
    sub('vl-fs-select', 'Selection', () => [
      h('div', { class: 'fs-pair' }, bool(ls, 'use_length_min', 'Min 2D Length'), num(ls, 'length_min', 'Min 2D Length', { unit: 'pixel', min: 0, disabled: !ls.use_length_min })),
      h('div', { class: 'fs-pair' }, bool(ls, 'use_length_max', 'Max 2D Length'), num(ls, 'length_max', 'Max 2D Length', { unit: 'pixel', min: 0, disabled: !ls.use_length_max })),
      h('div', { class: 'fs-pair' }, bool(ls, 'use_chain_count', 'Max Chain Count'), num(ls, 'chain_count', 'Max Chain Count', { int: true, min: 0, disabled: !ls.use_chain_count })),
    ], { closed: true }),
    sub('vl-fs-caps', 'Caps', () => [
      enumButtons(ls, 'caps', 'Caps', [
        ['BUTT', 'Butt'],
        ['ROUND', 'Round'],
        ['SQUARE', 'Square'],
      ]),
    ], { closed: true }),
    sub('vl-fs-dash', 'Dashed Line', () => [pair('dash1', 'gap1', 'Dash 1', 'Gap 1'), pair('dash2', 'gap2', 'Dash 2', 'Gap 2'), pair('dash3', 'gap3', 'Dash 3', 'Gap 3')], {
      closed: true,
      header: headerCheck(ls, 'use_dashed_line', 'Dashed Line'),
    }),
  ], { closed: true });
}

function lineStylePanels(): Child {
  const set = activeLineSet(app.doc);
  if (!set) return null;
  const ls = lineStyleOf(app.doc, set);
  return [
    panel('vl-fs-linestyle', 'Freestyle Line Style', () => [lineStyleSelector(set), ls ? null : h('div', { class: 'prop-note' }, 'The line set draws nothing without a line style.')]),
    ls
      ? [
          strokesPanel(ls),
          panel('vl-fs-color', 'Freestyle Color', () => [colorProp(ls, 'color', 'Base Color'), modifierStack(ls, 'color')], { closed: true }),
          panel('vl-fs-alpha', 'Freestyle Alpha', () => [num(ls, 'alpha', 'Base Transparency', { min: 0, max: 1, slider: true }), modifierStack(ls, 'alpha')], { closed: true }),
          panel(
            'vl-fs-thickness',
            'Freestyle Thickness',
            () => [
              num(ls, 'thickness', 'Base Thickness', { unit: 'pixel', min: 0, max: 10000, softMax: 100 }),
              enumButtons(ls, 'thickness_position', 'Position', [
                ['CENTER', 'Center'],
                ['INSIDE', 'Inside'],
                ['OUTSIDE', 'Outside'],
                ['RELATIVE', 'Relative'],
              ]),
              ls.thickness_position === 'RELATIVE' ? num(ls, 'thickness_ratio', 'Ratio', { min: 0, max: 1, slider: true, tip: 'Share of the thickness on the inner side' }) : null,
              modifierStack(ls, 'thickness'),
            ],
            { closed: true },
          ),
          panel('vl-fs-geometry', 'Freestyle Geometry', () => modifierStack(ls, 'geometry'), { closed: true }),
        ]
      : null,
  ];
}

viewLayerPanels.push(() => {
  const r = app.doc.scene.render;
  if (!r.use_freestyle && !r.freestyle_settings) return panel('vl-freestyle', 'Freestyle', () => h('div', { class: 'prop-note' }, 'Enable Freestyle in Render properties to draw lines over renders.', ' ', h('button', { class: 'btn', onclick: () => ((r.use_freestyle = true), freestyleSettings(app.doc), changed('Freestyle')) }, 'Enable')), { closed: true });
  const fs = freestyleSettings(app.doc);
  return [settingsPanel(), fs.use_freestyle ? [lineSetPanel(), lineStylePanels()] : null];
});

// ---------------------------------------------------------------------------
// Material ▸ Freestyle Line

materialExtraPanels.push((ma: MaterialData) => {
  if (!app.doc.scene.render.use_freestyle) return null;
  ma.line_color ??= [0, 0, 0, 0];
  ma.line_priority ??= 0;
  return panel(
    'ma-freestyle',
    'Freestyle Line',
    () => [
      colorProp(ma, 'line_color', 'Line Color', { alpha: true, tip: 'Colour read by line style Material modifiers (Line Color attribute)' }),
      num(ma, 'line_priority', 'Priority', { int: true, min: 0, max: 32767, tip: 'Which material wins where lines of two materials meet' }),
    ],
    { closed: true },
  );
});
