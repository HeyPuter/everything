// Fuller panels for long-standing modifiers (sub-panels and options that were missing).
import { num, bool, enumProp, vecProp } from '../../../ui/props';
import { modifierFields, modifierExtraUI } from '../stack';
import { sub, headerCheck, objRow } from './kit';

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
