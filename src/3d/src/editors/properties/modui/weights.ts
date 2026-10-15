// Panels of the vertex weight modifiers.
import { h, type Child } from '../../../ui/h';
import { num, bool, enumProp, splitRow } from '../../../ui/props';
import type { ModifierBase, ObjectData } from '../../../data/types';
import { modifierFields, modifierExtraUI } from '../stack';
import { FALLOFF_ITEMS } from '../../../eval/mods/common';
import { vgroupRow, sub, curveWidget, textureRows, textureCoordRows, objRow, flagToggles, toggleIcon, touch } from './kit';
import { enumRow, enumMenu } from '../../../ui/widgets';

type Rec = Record<string, unknown>;

function falloffPanel(m: ModifierBase): Child {
  const r = m as Rec;
  return sub(m, 'falloff', 'Falloff', () => [
    splitRow(
      'Type',
      h(
        'div',
        { class: 'row-aligned' },
        enumMenu(`${m.id}.falloff_type`, FALLOFF_ITEMS.map(([value, label]) => ({ value, label })), String(r.falloff_type ?? 'LINEAR'), (v) => ((r.falloff_type = v), touch('Change Falloff Type'))),
        toggleIcon(r, 'invert_falloff', 'arrow_leftright', 'Invert Falloff'),
      ),
    ),
    r.falloff_type === 'CURVE' ? curveWidget(m, 'map_curve') : null,
  ]);
}

function influencePanel(ob: ObjectData, m: ModifierBase): Child {
  const r = m as Rec;
  return sub(m, 'influence', 'Influence', () => [
    num(r, 'mask_constant', 'Global Influence', { min: -1e9, max: 1e9, softMin: 0, softMax: 1, slider: true }),
    !r.mask_texture ? vgroupRow(ob, m, 'mask_vertex_group', 'Vertex Group', 'invert_mask_vertex_group') : null,
    !r.mask_vertex_group ? textureRows(m, 'mask_texture') : null,
    r.mask_texture && !r.mask_vertex_group ? textureCoordRows(m, 'mask_tex_mapping', 'mask_tex_map_object', ob) : null,
  ]);
}

modifierFields.VERTEX_WEIGHT_EDIT = [];
modifierExtraUI.VERTEX_WEIGHT_EDIT = (ob, m) => {
  const r = m as Rec;
  return [
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group'),
    num(r, 'default_weight', 'Default Weight', { min: 0, max: 1, slider: true }),
    bool(r, 'use_add', 'Group Add'),
    r.use_add ? num(r, 'add_threshold', 'Threshold', { min: -1000, max: 1000, softMin: 0, softMax: 1, precision: 3 }) : null,
    bool(r, 'use_remove', 'Group Remove'),
    r.use_remove ? num(r, 'remove_threshold', 'Threshold', { min: -1000, max: 1000, softMin: 0, softMax: 1, precision: 3 }) : null,
    bool(r, 'normalize', 'Normalize Weights'),
    falloffPanel(m),
    influencePanel(ob, m),
  ];
};

const MIX_SET: [string, string][] = [
  ['ALL', 'All'],
  ['A', 'Vertex Group A'],
  ['B', 'Vertex Group B'],
  ['OR', 'Vertex Group A or B'],
  ['AND', 'Vertex Group A and B'],
];
const MIX_MODE: [string, string][] = [
  ['SET', 'Replace'],
  ['ADD', 'Add'],
  ['SUB', 'Subtract'],
  ['MUL', 'Multiply'],
  ['DIV', 'Divide'],
  ['DIF', 'Difference'],
  ['AVG', 'Average'],
  ['MIN', 'Minimum'],
  ['MAX', 'Maximum'],
];

modifierFields.VERTEX_WEIGHT_MIX = [];
modifierExtraUI.VERTEX_WEIGHT_MIX = (ob, m) => {
  const r = m as Rec;
  return [
    vgroupRow(ob, m, 'vertex_group_a', 'Vertex Group A', 'invert_vertex_group_a'),
    vgroupRow(ob, m, 'vertex_group_b', 'Vertex Group B', 'invert_vertex_group_b'),
    h('div', { class: 'ui-sep' }),
    num(r, 'default_weight_a', 'Default Weight A', { min: 0, max: 1, slider: true }),
    num(r, 'default_weight_b', 'B', { min: 0, max: 1, slider: true }),
    h('div', { class: 'ui-sep' }),
    enumProp(r, 'mix_set', 'Vertex Set', MIX_SET),
    enumProp(r, 'mix_mode', 'Mix Mode', MIX_MODE),
    bool(r, 'normalize', 'Normalize Weights'),
    influencePanel(ob, m),
  ];
};

modifierFields.VERTEX_WEIGHT_PROXIMITY = [];
modifierExtraUI.VERTEX_WEIGHT_PROXIMITY = (ob, m) => {
  const r = m as Rec;
  return [
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group'),
    objRow(r, 'target', 'Target Object', (o) => o.id !== ob.id),
    h('div', { class: 'ui-sep' }),
    splitRow(
      'Proximity Mode',
      enumRow(
        `${m.id}.proximity_mode`,
        [
          { value: 'OBJECT', label: 'Object' },
          { value: 'GEOMETRY', label: 'Geometry' },
        ],
        String(r.proximity_mode ?? 'OBJECT'),
        (v) => {
          r.proximity_mode = v;
          touch('Change Proximity Mode');
        },
      ),
    ),
    r.proximity_mode === 'GEOMETRY'
      ? flagToggles(r, 'proximity_geometry', 'Geometry', [
          ['VERTEX', 'Vertex'],
          ['EDGE', 'Edge'],
          ['FACE', 'Face'],
        ])
      : null,
    h('div', { class: 'ui-sep' }),
    num(r, 'min_dist', 'Lowest', { min: 0, unit: 'distance' }),
    num(r, 'max_dist', 'Highest', { min: 0, unit: 'distance' }),
    bool(r, 'normalize', 'Normalize Weights'),
    falloffPanel(m),
    influencePanel(ob, m),
  ];
};
