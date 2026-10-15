// Fuller panels for long-standing modifiers (sub-panels and options that were missing).
import { h } from '../../../ui/h';
import { num, bool, enumProp, vecProp, splitRow } from '../../../ui/props';
import { enumRow, enumMenu } from '../../../ui/widgets';
import { app } from '../../../app/app';
import { modifierFields, modifierExtraUI } from '../stack';
import { sub, headerCheck, objRow, vgroupRow, touch, textureRows } from './kit';

type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Array

modifierFields.ARRAY = [];
modifierExtraUI.ARRAY = (ob, m) => {
  const r = m as Rec;
  const fit = String(r.fit_type ?? 'FIXED_COUNT');
  return [
    enumProp(r, 'fit_type', 'Fit Type', [
      ['FIXED_COUNT', 'Fixed Count'],
      ['FIT_LENGTH', 'Fit Length'],
      ['FIT_CURVE', 'Fit Curve'],
    ]),
    fit === 'FIXED_COUNT' ? num(r, 'count', 'Count', { int: true, min: 1, max: 100000, softMax: 1000 }) : null,
    fit === 'FIT_LENGTH' ? num(r, 'fit_length', 'Length', { unit: 'distance', min: 0 }) : null,
    fit === 'FIT_CURVE' ? objRow(r, 'curve', 'Curve', (o) => o.type === 'CURVE' && o.id !== ob.id) : null,
    sub(m, 'relative', 'Relative Offset', () => [vecProp(r, 'relative_offset_displace', 'Factor', { disabled: !r.use_relative_offset })], { closed: false, header: headerCheck(m, 'use_relative_offset', 'Relative Offset') }),
    sub(m, 'constant', 'Constant Offset', () => [vecProp(r, 'constant_offset_displace', 'Distance', { unit: 'distance', disabled: !r.use_constant_offset })], { header: headerCheck(m, 'use_constant_offset', 'Constant Offset') }),
    sub(m, 'object', 'Object Offset', () => [objRow(r, 'offset_object', 'Object', (o) => o.id !== ob.id)], { header: headerCheck(m, 'use_object_offset', 'Object Offset') }),
    sub(m, 'merge', 'Merge', () => [num(r, 'merge_threshold', 'Distance', { unit: 'distance', min: 0, disabled: !r.use_merge_vertices }), bool(r, 'use_merge_vertices_cap', 'First and Last Copies', { disabled: !r.use_merge_vertices })], { header: headerCheck(m, 'use_merge_vertices', 'Merge') }),
    sub(m, 'uv', 'UVs', () => [num(r, 'offset_u', 'Offset U', { min: -1, max: 1, slider: true }), num(r, 'offset_v', 'V', { min: -1, max: 1, slider: true })]),
    sub(m, 'caps', 'Caps', () => [objRow(r, 'start_cap', 'Cap Start', (o) => o.type === 'MESH' && o.id !== ob.id), objRow(r, 'end_cap', 'End', (o) => o.type === 'MESH' && o.id !== ob.id)]),
  ];
};

// ---------------------------------------------------------------------------
// Bevel

modifierFields.BEVEL = [];
modifierExtraUI.BEVEL = (ob, m) => {
  const r = m as Rec;
  const pct = r.offset_type === 'PERCENT';
  return [
    splitRow(
      'Affect',
      enumRow(
        `${m.id}.affect`,
        [
          { value: 'VERTICES', label: 'Vertices' },
          { value: 'EDGES', label: 'Edges' },
        ],
        String(r.affect ?? 'EDGES'),
        (v) => ((r.affect = v), touch('Change Affect')),
      ),
    ),
    enumProp(r, 'offset_type', 'Width Type', [
      ['OFFSET', 'Offset'],
      ['WIDTH', 'Width'],
      ['DEPTH', 'Depth'],
      ['PERCENT', 'Percent'],
      ['ABSOLUTE', 'Absolute'],
    ]),
    pct ? num(r, 'width_pct', 'Amount', { min: 0, softMax: 100 }) : num(r, 'width', 'Amount', { unit: 'distance', min: 0 }),
    num(r, 'segments', 'Segments', { int: true, min: 1, max: 1000, softMax: 100 }),
    enumProp(r, 'limit_method', 'Limit Method', [
      ['NONE', 'None'],
      ['ANGLE', 'Angle'],
      ['VGROUP', 'Vertex Group'],
    ]),
    r.limit_method === 'ANGLE' ? num(r, 'angle_limit', 'Angle', { unit: 'angle', min: 0, max: Math.PI }) : null,
    r.limit_method === 'VGROUP' ? vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group') : null,
    sub(m, 'profile', 'Profile', () => [num(r, 'profile', 'Shape', { min: 0, max: 1, slider: true })]),
    sub(m, 'geometry', 'Geometry', () => [bool(r, 'use_clamp_overlap', 'Clamp Overlap')]),
    sub(m, 'shading', 'Shading', () => [
      bool(r, 'harden_normals', 'Harden Normals', { disabled: r.affect === 'VERTICES' }),
      h('div', { class: 'sub-label' }, 'Mark'),
      bool(r, 'mark_seam', 'Seam', { disabled: r.affect === 'VERTICES' }),
      bool(r, 'mark_sharp', 'Sharp', { disabled: r.affect === 'VERTICES' }),
      num(r, 'material', 'Material Index', { int: true, min: -1 }),
    ]),
  ];
};

// ---------------------------------------------------------------------------
// Boolean

modifierFields.BOOLEAN = [];
modifierExtraUI.BOOLEAN = (ob, m) => {
  const r = m as Rec;
  const cols = Object.values(app.doc.collections)
    .filter((c) => c.id !== app.doc.scene.collection)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    splitRow(
      'Operation',
      enumRow(
        `${m.id}.operation`,
        [
          { value: 'INTERSECT', label: 'Intersect' },
          { value: 'UNION', label: 'Union' },
          { value: 'DIFFERENCE', label: 'Difference' },
        ],
        String(r.operation ?? 'DIFFERENCE'),
        (v) => ((r.operation = v), touch('Change Operation')),
      ),
    ),
    enumProp(r, 'operand_type', 'Operand Type', [
      ['OBJECT', 'Object'],
      ['COLLECTION', 'Collection'],
    ]),
    r.operand_type === 'COLLECTION'
      ? splitRow('Collection', enumMenu(`${m.id}.collection`, [{ value: '', label: '—' }, ...cols.map((c) => ({ value: c.id, label: c.name, icon: 'collection' }))], String(r.collection ?? ''), (v) => ((r.collection = v || null), touch('Set Collection'))))
      : objRow(r, 'object', 'Object', (o) => o.id !== ob.id && o.type === 'MESH'),
  ];
};

// ---------------------------------------------------------------------------
// Subdivision Surface

modifierFields.SUBSURF = [];
modifierExtraUI.SUBSURF = (_ob, m) => {
  const r = m as Rec;
  const simple = r.subdivision_type === 'SIMPLE';
  return [
    splitRow(
      'Type',
      enumRow(
        `${m.id}.subdivision_type`,
        [
          { value: 'CATMULL_CLARK', label: 'Catmull-Clark' },
          { value: 'SIMPLE', label: 'Simple' },
        ],
        String(r.subdivision_type ?? 'CATMULL_CLARK'),
        (v) => ((r.subdivision_type = v), touch('Change Subdivision Type')),
      ),
    ),
    num(r, 'levels', 'Levels Viewport', { int: true, min: 0, max: 6 }),
    num(r, 'render_levels', 'Render', { int: true, min: 0, max: 6 }),
    sub(m, 'advanced', 'Advanced', () => [
      bool(r, 'use_limit_surface', 'Use Limit Surface', { disabled: simple }),
      enumProp(
        r,
        'uv_smooth',
        'UV Smooth',
        [
          ['NONE', 'None'],
          ['PRESERVE_CORNERS', 'Keep Corners'],
          ['PRESERVE_BOUNDARIES', 'Keep Boundaries'],
          ['SMOOTH_ALL', 'All'],
        ],
        { disabled: simple },
      ),
      enumProp(
        r,
        'boundary_smooth',
        'Boundary Smooth',
        [
          ['PRESERVE_CORNERS', 'Keep Corners'],
          ['ALL', 'All'],
        ],
        { disabled: simple },
      ),
      bool(r, 'use_creases', 'Use Creases', { disabled: simple }),
    ]),
  ];
};

// ---------------------------------------------------------------------------
// Solidify

modifierFields.SOLIDIFY = [];
modifierExtraUI.SOLIDIFY = (ob, m) => {
  const r = m as Rec;
  return [
    num(r, 'thickness', 'Thickness', { unit: 'distance' }),
    num(r, 'offset', 'Offset', { min: -1, max: 1, slider: true }),
    bool(r, 'use_even_offset', 'Even Thickness'),
    h('div', { class: 'sub-label' }, 'Rim'),
    bool(r, 'use_rim', 'Fill'),
    bool(r, 'use_rim_only', 'Only Rim', { disabled: !r.use_rim }),
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
    r.vertex_group ? num(r, 'thickness_vertex_group', 'Factor', { min: 0, max: 1, slider: true }) : null,
    sub(m, 'normals', 'Normals', () => [bool(r, 'use_flip_normals', 'Flip')]),
    sub(m, 'materials', 'Materials', () => [num(r, 'material_offset', 'Material Offset', { int: true }), num(r, 'material_offset_rim', 'Rim', { int: true })]),
    sub(m, 'edges', 'Edge Data', () => [
      num(r, 'edge_crease_inner', 'Crease Inner', { min: 0, max: 1, slider: true }),
      num(r, 'edge_crease_outer', 'Outer', { min: 0, max: 1, slider: true }),
      num(r, 'edge_crease_rim', 'Rim', { min: 0, max: 1, slider: true }),
    ]),
    sub(m, 'clamp', 'Thickness Clamp', () => [num(r, 'thickness_clamp', 'Clamp', { min: 0, max: 100, softMax: 2, slider: true })]),
    sub(m, 'vgroups', 'Output Vertex Groups', () => [vgroupRow(ob, m, 'shell_vertex_group', 'Shell'), vgroupRow(ob, m, 'rim_vertex_group', 'Rim')]),
  ];
};

// ---------------------------------------------------------------------------
// Displace

modifierFields.DISPLACE = [];
modifierExtraUI.DISPLACE = (ob, m) => {
  const r = m as Rec;
  const axis = r.direction === 'X' || r.direction === 'Y' || r.direction === 'Z';
  return [
    textureRows(m, 'texture'),
    r.texture
      ? [
          enumProp(r, 'texture_coords', 'Coordinates', [
            ['LOCAL', 'Local'],
            ['GLOBAL', 'Global'],
            ['OBJECT', 'Object'],
            ['UV', 'UV'],
          ]),
          r.texture_coords === 'OBJECT' ? objRow(r, 'texture_coords_object', 'Object', (o) => o.id !== ob.id) : null,
        ]
      : null,
    enumProp(r, 'direction', 'Direction', [
      ['X', 'X'],
      ['Y', 'Y'],
      ['Z', 'Z'],
      ['NORMAL', 'Normal'],
      ['CUSTOM_NORMAL', 'Custom Normal'],
    ]),
    axis
      ? splitRow(
          'Space',
          enumRow(
            `${m.id}.space`,
            [
              { value: 'LOCAL', label: 'Local' },
              { value: 'GLOBAL', label: 'Global' },
            ],
            String(r.space ?? 'LOCAL'),
            (v) => ((r.space = v), touch('Change Space')),
          ),
        )
      : null,
    num(r, 'strength', 'Strength', { softMin: -100, softMax: 100, anim: { ob, path: `modifiers["${m.name}"].strength` } }),
    num(r, 'mid_level', 'Midlevel', { softMin: 0, softMax: 1, slider: true }),
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
  ];
};

// ---------------------------------------------------------------------------
// Wireframe

modifierFields.WIREFRAME = [];
modifierExtraUI.WIREFRAME = (ob, m) => {
  const r = m as Rec;
  return [
    num(r, 'thickness', 'Thickness', { unit: 'distance' }),
    num(r, 'offset', 'Offset', { min: -1, max: 1, slider: true }),
    bool(r, 'use_boundary', 'Boundary'),
    bool(r, 'use_replace', 'Replace Original'),
    h('div', { class: 'sub-label' }, 'Thickness'),
    bool(r, 'use_even_offset', 'Even'),
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
    r.vertex_group ? num(r, 'thickness_vertex_group', 'Factor', { min: 0, max: 1, slider: true }) : null,
    num(r, 'material_offset', 'Material Offset', { int: true }),
  ];
};

// ---------------------------------------------------------------------------
// Simple Deform

modifierFields.SIMPLE_DEFORM = [];
modifierExtraUI.SIMPLE_DEFORM = (ob, m) => {
  const r = m as Rec;
  const method = String(r.deform_method ?? 'TWIST');
  const angled = method === 'TWIST' || method === 'BEND';
  const axis = String(r.deform_axis ?? 'Z');
  // the two axes a taper or stretch scales
  const lockable = ['X', 'Y', 'Z'].filter((a) => a !== axis);
  return [
    splitRow(
      'Method',
      enumRow(
        `${m.id}.deform_method`,
        [
          { value: 'TWIST', label: 'Twist' },
          { value: 'BEND', label: 'Bend' },
          { value: 'TAPER', label: 'Taper' },
          { value: 'STRETCH', label: 'Stretch' },
        ],
        method,
        (v) => ((r.deform_method = v), touch('Change Method')),
      ),
    ),
    angled ? num(r, 'angle', 'Angle', { unit: 'angle', anim: { ob, path: `modifiers["${m.name}"].angle` } }) : num(r, 'factor', 'Factor', { softMin: -10, softMax: 10, anim: { ob, path: `modifiers["${m.name}"].factor` } }),
    objRow(r, 'origin', 'Origin', (o) => o.id !== ob.id),
    splitRow(
      'Axis',
      enumRow(
        `${m.id}.deform_axis`,
        ['X', 'Y', 'Z'].map((a) => ({ value: a, label: a })),
        axis,
        (v) => ((r.deform_axis = v), touch('Change Axis')),
      ),
    ),
    sub(m, 'restrictions', 'Restrictions', () => [
      vecProp(r, 'limits', 'Limits', { names: ['Min', 'Max'], min: 0, max: 1 }),
      !angled ? h('div', { class: 'sub-label' }, 'Lock') : null,
      !angled ? lockable.map((a) => bool(r, `lock_${a.toLowerCase()}`, a)) : null,
      vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
    ]),
  ];
};
