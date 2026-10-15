// Panel of the Normal Edit modifier.
import { num, bool, enumProp, vecProp, splitRow } from '../../../ui/props';
import { enumRow } from '../../../ui/widgets';
import { modifierFields, modifierExtraUI } from '../stack';
import { vgroupRow, sub, objRow, touch } from './kit';

type Rec = Record<string, unknown>;

modifierFields.NORMAL_EDIT = [];
modifierExtraUI.NORMAL_EDIT = (ob, m) => {
  const r = m as Rec;
  return [
    splitRow(
      'Mode',
      enumRow(
        `${m.id}.mode`,
        [
          { value: 'RADIAL', label: 'Radial' },
          { value: 'DIRECTIONAL', label: 'Directional' },
        ],
        String(r.mode ?? 'RADIAL'),
        (v) => ((r.mode = v), touch('Change Mode')),
      ),
    ),
    objRow(r, 'target', 'Target', (o) => o.id !== ob.id),
    r.mode === 'DIRECTIONAL' ? bool(r, 'use_direction_parallel', 'Parallel Normals', { disabled: !r.target }) : null,
    sub(
      m,
      'mix',
      'Mix',
      () => [
        enumProp(r, 'mix_mode', 'Mix Mode', [
          ['COPY', 'Copy'],
          ['ADD', 'Add'],
          ['SUB', 'Subtract'],
          ['MUL', 'Multiply'],
        ]),
        vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
        num(r, 'mix_factor', 'Mix Factor', { min: 0, max: 1, slider: true }),
        num(r, 'mix_limit', 'Max Angle', { unit: 'angle', min: 0, max: Math.PI }),
        bool(r, 'no_polynors_fix', 'Lock Polygon Normals'),
      ],
      { closed: false },
    ),
    sub(m, 'offset', 'Offset', () => [vecProp(r, 'offset', 'Offset', { unit: 'distance', disabled: !!r.target && r.mode === 'RADIAL' })]),
  ];
};
