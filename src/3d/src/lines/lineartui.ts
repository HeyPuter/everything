// Properties panels for line art: the Line Art modifier, and the Line Art usage panels of
// objects, collections and materials.
import { app } from '../app/app';
import { h, type Child } from '../ui/h';
import { panel, enumMenu, opButton, checkbox } from '../ui/widgets';
import { num, bool, enumProp, objectProp, splitRow } from '../ui/props';
import { modifierExtraUI } from '../editors/properties/stack';
import { objectExtraPanels } from '../editors/properties/tabs';
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
      m.use_crease ? bool(m, 'use_crease_on_smooth', 'Crease On Smooth', { tip: 'Also draw creases between smooth-shaded faces' }) : null,
      bool(m, 'use_material', 'Material Borders', { tip: 'Edges between faces of different materials' }),
      bool(m, 'use_edge_mark', 'Edge Marks', { tip: 'Edges marked with Mark Freestyle Edge' }),
      bool(m, 'use_loose', 'Loose', { tip: 'Edges without faces' }),
    ]),
    sub(`la-occl-${m.id}`, 'Occlusion', () => [
      bool(m, 'use_multiple_levels', 'Range', { tip: 'Draw lines hidden behind a range of surfaces' }),
      num(m, 'level_start', m.use_multiple_levels ? 'Level Start' : 'Level', { int: true, min: 0, max: 128, tip: 'How many surfaces hide the lines (0 = visible lines)' }),
      m.use_multiple_levels ? num(m, 'level_end', 'Level End', { int: true, min: 0, max: 128 }) : null,
    ], { closed: true }),
    sub(`la-fm-${m.id}`, 'Face Mark Filtering', () => [
      bool(m, 'use_face_mark_invert', 'Invert', { tip: 'Use the unmarked faces instead' }),
      bool(m, 'use_face_mark_boundaries', 'Boundaries', { tip: 'Only the edges where marked and unmarked faces meet' }),
      bool(m, 'use_face_mark_keep_contour', 'Keep Contour', { tip: 'Keep outlines regardless of the marks' }),
    ], { closed: true, header: checkbox(`la-fm-on-${m.id}`, '', !!m.use_face_mark, (v) => ((m.use_face_mark = v), changed('Face Mark Filtering'))) }),
    sub(`la-comp-${m.id}`, 'Composition', () => [
      num(m, 'overscan', 'Overscan', { min: 0, max: 0.5, slider: true, tip: 'Keep lines this far (fraction of the frame) outside the camera view' }),
      num(m, 'stroke_depth_offset', 'Depth Offset', { unit: 'distance', min: -0.5, max: 0.5, tip: 'Move the strokes towards the camera so surfaces do not cover them' }),
      bool(m, 'use_custom_camera', 'Use Custom Camera'),
      m.use_custom_camera ? objectProp(m, 'source_camera', 'Camera', { filter: (o) => o.type === 'CAMERA' }) : null,
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
