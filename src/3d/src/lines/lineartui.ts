// Properties panels for line art: the Line Art modifier, and the Line Art usage panels of
// objects, collections and materials.
import { app } from '../app/app';
import { h, type Child } from '../ui/h';
import { panel, enumMenu, opButton, checkbox, textField } from '../ui/widgets';
import { icon } from '../ui/icons';
import { num, bool, enumProp, objectProp, splitRow } from '../ui/props';
import { modifierExtraUI } from '../editors/properties/stack';
import { objectExtraPanels, collectionExtraPanels, materialExtraPanels } from '../editors/properties/tabs';
import type { ModifierBase, ObjectData } from '../data/types';
import { gpOf } from '../greasepencil/data';
import type { LineartUsage } from './types';

type M = ModifierBase & Record<string, unknown>;

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};
const sub = (id: string, title: string, body: () => Child, opts: { closed?: boolean; header?: Child } = {}) => panel(id, title, body, { ...opts, sub: true });

function pick(m: M, key: string, label: string, items: { value: string; label: string; icon?: string }[], none = true): Child {
  return splitRow(label, enumMenu(`${m.id}.${key}`, none ? [{ value: '', label: '—' }, ...items] : items, String(m[key] ?? ''), (v) => ((m[key] = v || null), changed(`Set ${label}`))));
}

/** Eight mask bit toggles. */
function maskBits(owner: Record<string, unknown>, key: string, label: string): Child {
  const bits = ((owner[key] as boolean[] | undefined) ??= [false, false, false, false, false, false, false, false]);
  return splitRow(
    label,
    h(
      'div',
      { class: 'la-bits' },
      bits.map((b, i) =>
        h('button', { key: String(i), class: { btn: true, on: b }, 'data-tip': `Mask bit ${i + 1}`, onclick: () => ((bits[i] = !b), changed('Mask Bit')) }, String(i + 1)),
      ),
    ),
  );
}

function lineArtUI(ob: ObjectData, m0: ModifierBase): Child {
  const m = m0 as M;
  const doc = app.doc;
  const gp = gpOf(doc, ob);
  const cols = Object.values(doc.collections).filter((c) => c.id !== doc.scene.collection);
  const baked = !!m.is_baked;
  return [
    baked ? h('div', { class: 'prop-note' }, 'The strokes are baked into the target layer. Clear the bake to compute them live again.') : null,
    enumProp(m, 'source_type', 'Source', [
      ['SCENE', 'Scene'],
      ['COLLECTION', 'Collection'],
      ['OBJECT', 'Object'],
    ]),
    m.source_type === 'OBJECT' ? objectProp(m, 'source_object', 'Object', { filter: (o) => o.type !== 'GREASEPENCIL' && o.type !== 'CAMERA' && o.type !== 'LIGHT' }) : null,
    m.source_type === 'COLLECTION'
      ? [
          pick(m, 'source_collection', 'Collection', cols.map((c) => ({ value: c.id, label: c.name, icon: 'outliner_collection' }))),
          bool(m, 'use_invert_collection', 'Invert', { tip: 'Draw the objects outside the collection instead' }),
        ]
      : null,
    pick(m, 'target_layer', 'Layer', (gp?.layers ?? []).map((l) => ({ value: l.name, label: l.name, icon: 'outliner_data_gp_layer' })).reverse()),
    pick(m, 'target_material', 'Material', (gp?.materials ?? []).filter((x): x is string => !!x).map((id) => ({ value: id, label: doc.materials[id]?.name ?? id, icon: 'material' }))),
    num(m, 'radius', 'Line Radius', { unit: 'distance', min: 0, softMax: 0.1, precision: 4 }),
    num(m, 'opacity', 'Opacity', { min: 0, max: 1, slider: true }),
    sub(`la-edges-${m.id}`, 'Edge Types', () => [
      bool(m, 'use_contour', 'Contour', { tip: 'Outlines and silhouettes' }),
      h('div', { class: 'la-crease' }, bool(m, 'use_crease', 'Crease'), m.use_crease ? num(m, 'crease_threshold', 'Threshold', { unit: 'angle', min: 0, max: Math.PI, tip: 'Faces meeting at a sharper angle than this draw a crease line' }) : null),
      bool(m, 'use_intersection', 'Intersections', { tip: 'Lines where the surfaces of two objects cut through each other' }),
      bool(m, 'use_material', 'Material Borders', { tip: 'Edges between faces of different materials' }),
      bool(m, 'use_edge_mark', 'Edge Marks', { tip: 'Edges marked with Mark Freestyle Edge' }),
      bool(m, 'use_loose', 'Loose', { tip: 'Edges without faces' }),
    ]),
    sub(`la-occl-${m.id}`, 'Occlusion', () => [
      bool(m, 'use_multiple_levels', 'Range', { tip: 'Draw lines hidden behind a range of surfaces' }),
      num(m, 'level_start', m.use_multiple_levels ? 'Level Start' : 'Level', { int: true, min: 0, max: 128, tip: 'How many surfaces hide the lines (0 = visible lines)' }),
      m.use_multiple_levels ? num(m, 'level_end', 'Level End', { int: true, min: 0, max: 128 }) : null,
      sub(`la-mask-${m.id}`, 'Material Mask', () => [maskBits(m, 'use_material_mask_bits', 'Mask'), bool(m, 'use_material_mask_match', 'Exact Match', { tip: 'Materials must have exactly these bits (otherwise any shared bit)' })], {
        closed: true,
        header: checkbox(`la-mm-on-${m.id}`, '', !!m.use_material_mask, (v) => ((m.use_material_mask = v), changed('Material Mask'))),
      }),
    ], { closed: true }),
    sub(`la-fm-${m.id}`, 'Face Mark Filtering', () => [
      bool(m, 'use_face_mark_invert', 'Invert', { tip: 'Use the unmarked faces instead' }),
      bool(m, 'use_face_mark_boundaries', 'Boundaries', { tip: 'Only the edges where marked and unmarked faces meet' }),
      bool(m, 'use_face_mark_keep_contour', 'Keep Contour', { tip: 'Keep outlines regardless of the marks' }),
    ], { closed: true, header: checkbox(`la-fm-on-${m.id}`, '', !!m.use_face_mark, (v) => ((m.use_face_mark = v), changed('Face Mark Filtering'))) }),
    sub(`la-vw-${m.id}`, 'Vertex Weight Transfer', () => [
      splitRow('Filter Source', h('div', { class: 'la-filter' }, textField(`${m.id}.svg`, String(m.source_vertex_group ?? ''), (v) => ((m.source_vertex_group = v), changed('Filter Source')), { placeholder: 'Group name prefix' }), h('button', { class: { 'fs-x': true, on: !!m.invert_source_vertex_group }, 'data-tip': 'Invert\nUse the groups that do not start with the prefix', onclick: () => ((m.invert_source_vertex_group = !m.invert_source_vertex_group), changed('Invert Filter')) }, icon('gp_invert')))),
      bool(m, 'use_output_vertex_group_match_by_name', 'Match Output', { tip: 'Write each source group to the grease pencil group of the same name' }),
      m.use_output_vertex_group_match_by_name ? null : pick(m, 'vertex_group', 'Target', (gp?.vertex_groups ?? []).map((g) => ({ value: g.name, label: g.name, icon: 'group_vertex' }))),
    ], { closed: true }),
    sub(`la-geo-${m.id}`, 'Geometry Processing', () => [
      bool(m, 'use_custom_camera', 'Custom Camera', { tip: 'See the lines through another camera than the scene camera' }),
      m.use_custom_camera ? objectProp(m, 'source_camera', 'Camera', { filter: (o) => o.type === 'CAMERA' }) : null,
      bool(m, 'use_crease_on_smooth', 'Crease On Smooth', { tip: 'Also draw creases between smooth-shaded faces' }),
      bool(m, 'use_crease_on_sharp', 'Crease On Sharp', { tip: 'Edges marked sharp always draw a crease' }),
      bool(m, 'use_back_face_culling', 'Back Face Culling', { tip: 'Surfaces facing away from the camera hide no lines' }),
    ], { closed: true }),
    sub(`la-chain-${m.id}`, 'Chaining', () => [num(m, 'chaining_image_threshold', 'Image Threshold', { min: 0, max: 0.3, precision: 4, tip: 'Join line ends closer than this (fraction of the image diagonal)' })], { closed: true }),
    sub(`la-comp-${m.id}`, 'Composition', () => [
      num(m, 'overscan', 'Overscan', { min: 0, max: 0.5, slider: true, tip: 'Keep lines this far (fraction of the frame) outside the camera view' }),
      bool(m, 'use_image_boundary_trimming', 'Trim to Image', { tip: 'Cut the lines at the image border' }),
      num(m, 'stroke_depth_offset', 'Depth Offset', { unit: 'distance', min: -0.5, max: 0.5, tip: 'Move the strokes towards the camera so surfaces do not cover them' }),
      m.use_custom_camera ? null : bool(m, 'use_offset_towards_custom_camera', 'Offset Camera', { tip: 'Offset the strokes towards another camera (below) instead of the one they are seen from' }),
      !m.use_custom_camera && m.use_offset_towards_custom_camera ? objectProp(m, 'source_camera', 'Camera', { filter: (o) => o.type === 'CAMERA' }) : null,
    ], { closed: true }),
    sub(`la-bake-${m.id}`, 'Bake', () =>
      h(
        'div',
        { class: 'la-bake' },
        opButton('object.lineart_bake_strokes', 'Bake Line Art'),
        opButton('object.lineart_bake_strokes', 'Bake All', { bake_all: true }),
        opButton('object.lineart_clear', 'Clear Baked'),
        opButton('object.lineart_clear', 'Clear All', { clear_all: true }),
      ),
    ),
  ];
}
modifierExtraUI.LINEART = lineArtUI;

const USAGE: [LineartUsage, string][] = [
  ['INHERIT', 'Inherit'],
  ['INCLUDE', 'Include'],
  ['OCCLUSION_ONLY', 'Occlusion Only'],
  ['EXCLUDE', 'Exclude'],
];

// Object ▸ Line Art: how the object takes part in line art
objectExtraPanels.push((o: ObjectData) => {
  if (o.type !== 'MESH' && o.type !== 'CURVE' && o.type !== 'FONT' && o.type !== 'META') return null;
  return panel(
    'ob-lineart',
    'Line Art',
    () => {
      o.lineart ??= { usage: 'INHERIT', use_crease_override: false, crease_threshold: (140 * Math.PI) / 180 };
      const la = o.lineart;
      return [
        enumProp(la, 'usage', 'Usage', USAGE, { tip: 'Draw lines of this object, only let it hide lines, or leave it out' }),
        h('div', { class: 'la-crease' }, bool(la, 'use_crease_override', 'Override Crease'), la.use_crease_override ? num(la, 'crease_threshold', 'Crease', { unit: 'angle', min: 0, max: Math.PI }) : null),
      ];
    },
    { closed: true },
  );
});

// Collection ▸ Line Art
collectionExtraPanels.push((c) =>
  panel(
    'col-lineart',
    'Line Art',
    () => {
      c.lineart_usage ??= 'INCLUDE';
      return enumProp(c, 'lineart_usage', 'Usage', USAGE.slice(1), { tip: 'How the objects of this collection take part in line art' });
    },
    { closed: true },
  ),
);

// Material ▸ Line Art: mask bits and how much the material hides lines
materialExtraPanels.push((ma) => {
  if (ma.grease_pencil) return null;
  return panel(
    'ma-lineart',
    'Line Art',
    () => {
      ma.lineart ??= { use_material_mask: false, use_material_mask_bits: [false, false, false, false, false, false, false, false], mat_occlusion: 1 };
      const la = ma.lineart;
      return [
        bool(la, 'use_material_mask', 'Material Mask', { tip: 'Line Art modifiers with a material mask draw lines of this material when the bits match' }),
        la.use_material_mask ? maskBits(la as unknown as Record<string, unknown>, 'use_material_mask_bits', 'Bits') : null,
        num(la, 'mat_occlusion', 'Levels', { int: true, min: 0, max: 5, tip: 'How many surfaces a face of this material counts as when it hides lines (0: lines show through)' }),
      ];
    },
    { closed: true },
  );
});
