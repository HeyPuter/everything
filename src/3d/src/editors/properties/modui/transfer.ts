// Panel of the Data Transfer modifier, plus "Generate Data Layers" for it.
import { h, type Child } from '../../../ui/h';
import { num, enumProp, splitRow } from '../../../ui/props';
import { app, onAppReady, operators, registerOperator, type Operator } from '../../../app/app';
import type { MeshData, ModifierBase, ObjectData } from '../../../data/types';
import { modifierFields, modifierExtraUI } from '../stack';
import { vgroupRow, sub, objRow, flagToggles, headerCheck, toggleIcon, wideButton, numField } from './kit';
import { transferLayout } from '../../../object/transfer';
import { findModifier } from '../../../object/modifierops';

type Rec = Record<string, unknown>;

const LAYER_SRC: [string, string][] = [
  ['ACTIVE', 'Active Layer'],
  ['ALL', 'All Layers'],
];
const LAYER_DST: [string, string][] = [
  ['ACTIVE', 'Active Layer'],
  ['NAME', 'By Name'],
  ['INDEX', 'By Order'],
];

function layerRows(r: Rec, srcKey: string, dstKey: string): Child[] {
  return [enumProp(r, srcKey, 'Layer Selection', LAYER_SRC), enumProp(r, dstKey, 'Layer Mapping', LAYER_DST)];
}

modifierFields.DATA_TRANSFER = [];
modifierExtraUI.DATA_TRANSFER = (ob, m) => {
  const r = m as Rec;
  const types = (k: string) => (r[k] as string[] | undefined) ?? [];
  return [
    splitRow('Source', h('div', { class: 'row-aligned' }, objRow(r, 'object', '', (o) => o.id !== ob.id && o.type === 'MESH'), toggleIcon(r, 'use_object_transform', 'orientation_global', 'Object Transform'))),
    h('div', { class: 'ui-sep' }),
    enumProp(r, 'mix_mode', 'Mix Mode', [
      ['REPLACE', 'Replace'],
      ['ABOVE_THRESHOLD', 'Above Threshold'],
      ['BELOW_THRESHOLD', 'Below Threshold'],
      ['MIX', 'Mix'],
      ['ADD', 'Add'],
      ['SUB', 'Subtract'],
      ['MUL', 'Multiply'],
    ]),
    num(r, 'mix_factor', 'Mix Factor', { min: 0, max: 1, slider: true }),
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
    wideButton(`${m.id}.genlayers`, 'Generate Data Layers', () => app.run('object.datalayout_transfer', { modifier: m.id }), { tip: 'Create the vertex groups and color attributes the transfer writes to', disabled: !r.object }),
    sub(
      m,
      'verts',
      'Vertex Data',
      () => [
        flagToggles(r, 'data_types_verts', 'Types', [
          ['VGROUP_WEIGHTS', 'Vertex Groups'],
          ['COLOR_VERTEX', 'Color'],
        ]),
        enumProp(r, 'vert_mapping', 'Mapping', [
          ['TOPOLOGY', 'Topology'],
          ['NEAREST', 'Nearest'],
          ['EDGE_NEAREST', 'Nearest Edge Vertex'],
          ['EDGEINTERP_NEAREST', 'Nearest Edge Interpolated'],
          ['POLY_NEAREST', 'Nearest Face Vertex'],
          ['POLYINTERP_NEAREST', 'Nearest Face Interpolated'],
          ['POLYINTERP_VNORPROJ', 'Projected Face Interpolated'],
        ]),
        types('data_types_verts').includes('VGROUP_WEIGHTS') ? [h('div', { class: 'sub-label' }, 'Vertex Groups'), ...layerRows(r, 'layers_vgroup_select_src', 'layers_vgroup_select_dst')] : null,
        types('data_types_verts').includes('COLOR_VERTEX') ? [h('div', { class: 'sub-label' }, 'Colors'), ...layerRows(r, 'layers_vcol_vert_select_src', 'layers_vcol_vert_select_dst')] : null,
      ],
      { header: headerCheck(m, 'use_vert_data', 'Vertex Data') },
    ),
    sub(
      m,
      'edges',
      'Edge Data',
      () => [
        flagToggles(r, 'data_types_edges', 'Types', [
          ['SHARP_EDGE', 'Sharp'],
          ['SEAM', 'UV Seam'],
          ['CREASE', 'Subdivision Crease'],
        ]),
        enumProp(r, 'edge_mapping', 'Mapping', [
          ['TOPOLOGY', 'Topology'],
          ['VERT_NEAREST', 'Nearest Vertices'],
          ['NEAREST', 'Nearest Edge'],
          ['POLY_NEAREST', 'Nearest Face Edge'],
        ]),
      ],
      { header: headerCheck(m, 'use_edge_data', 'Edge Data') },
    ),
    sub(
      m,
      'loops',
      'Face Corner Data',
      () => [
        flagToggles(r, 'data_types_loops', 'Types', [
          ['CUSTOM_NORMAL', 'Custom Normals'],
          ['COLOR_CORNER', 'Color'],
          ['UV', 'UVs'],
        ]),
        enumProp(r, 'loop_mapping', 'Mapping', [
          ['TOPOLOGY', 'Topology'],
          ['NEAREST_NORMAL', 'Nearest Corner and Best Matching Normal'],
          ['NEAREST_POLYNOR', 'Nearest Corner and Best Matching Face Normal'],
          ['NEAREST_POLY', 'Nearest Corner of Nearest Face'],
          ['POLYINTERP_NEAREST', 'Nearest Face Interpolated'],
          ['POLYINTERP_LNORPROJ', 'Projected Face Interpolated'],
        ]),
        types('data_types_loops').includes('COLOR_CORNER') ? [h('div', { class: 'sub-label' }, 'Colors'), ...layerRows(r, 'layers_vcol_loop_select_src', 'layers_vcol_loop_select_dst')] : null,
      ],
      { header: headerCheck(m, 'use_loop_data', 'Face Corner Data') },
    ),
    sub(
      m,
      'polys',
      'Face Data',
      () => [
        flagToggles(r, 'data_types_polys', 'Types', [['SMOOTH', 'Smooth']]),
        enumProp(r, 'poly_mapping', 'Mapping', [
          ['TOPOLOGY', 'Topology'],
          ['NEAREST', 'Nearest Face'],
          ['NORMAL', 'Best Normal-Matching'],
          ['POLYINTERP_PNORPROJ', 'Projected Face Interpolated'],
        ]),
      ],
      { header: headerCheck(m, 'use_poly_data', 'Face Data') },
    ),
    sub(m, 'topology', 'Topology Mapping', () => [
      splitRow('Max Distance', h('div', { class: 'row-aligned' }, toggleIcon(r, 'use_max_distance', 'checkbox_hlt', 'Only Neighbor Geometry'), numField(m, 'max_distance', { unit: 'distance', min: 0, disabled: !r.use_max_distance }))),
      num(r, 'ray_radius', 'Ray Radius', { unit: 'distance', min: 0 }),
    ]),
  ];
};

/** Create on the object's mesh the vertex groups / color attributes a Data Transfer modifier needs. */
export function generateLayers(ob: ObjectData, m: ModifierBase): number {
  const doc = app.doc;
  const src = typeof m.object === 'string' ? doc.objects[m.object] : undefined;
  const S = src?.type === 'MESH' && src.data ? doc.meshes[src.data] : undefined;
  const D = ob.type === 'MESH' && ob.data ? doc.meshes[ob.data] : undefined;
  if (!S || !D || S === D) return 0;
  let n = 0;
  const verts = m.use_vert_data ? ((m.data_types_verts as string[]) ?? []) : [];
  const loops = m.use_loop_data ? ((m.data_types_loops as string[]) ?? []) : [];
  if (verts.includes('VGROUP_WEIGHTS')) {
    if (m.layers_vgroup_select_src === 'ACTIVE') {
      const g = S.vertex_groups[src!.vertex_group_active_index ?? 0];
      if (g && !D.vertex_groups.some((x) => x.name === g.name)) n += transferLayout({ ...S, vertex_groups: [g] } as MeshData, D, 'VGROUP_WEIGHTS', false);
    } else n += transferLayout(S, D, 'VGROUP_WEIGHTS', false);
  }
  if (verts.includes('COLOR_VERTEX')) n += transferLayout(S, D, 'COLOR_VERTEX', false);
  if (loops.includes('COLOR_CORNER')) n += transferLayout(S, D, 'COLOR_CORNER', false);
  return n;
}

onAppReady(() => {
  const prev = operators.get('object.datalayout_transfer');
  const op: Operator = {
    idname: 'object.datalayout_transfer',
    label: prev?.label ?? 'Transfer Mesh Data Layout',
    description: prev?.description,
    props: [...(prev?.props ?? []), { id: 'modifier', label: 'Modifier', type: 'string', default: '' }],
    poll: (ctx) => (prev?.poll?.(ctx) ?? false) || !!app.activeObject?.modifiers.some((x) => x.type === 'DATA_TRANSFER'),
    exec: (ctx, p) => {
      if (p.modifier) {
        const ob = app.activeObject;
        const m = findModifier(ob, p.modifier);
        if (!ob || !m || m.type !== 'DATA_TRANSFER') return 'CANCELLED';
        const n = generateLayers(ob, m);
        if (!n) app.report('INFO', 'All data layers already exist');
        return;
      }
      return prev?.exec?.(ctx, p);
    },
  };
  if (prev?.invoke) op.invoke = (ctx, p) => (p.modifier ? op.exec!(ctx, p) : prev.invoke!(ctx, p));
  registerOperator(op);
});
