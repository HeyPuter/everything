// Object Constraints and Bone Constraints tabs of the Properties editor: the constraint stack with a
// panel per constraint (type-specific settings, owner/target spaces, influence).
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { registerTab } from '../editors/properties/properties';
import { panel, enumMenu, enumRow, textField, isPanelOpen, setPanelOpen, opButton, numberField, decorator, type EnumItem } from '../ui/widgets';
import { keyProperty, keyState } from '../anim/keyframes';
import { num, bool, enumProp, splitRow, vecProp, objectProp, textProp, type PropOpts } from '../ui/props';
import { openMenu, type MenuItem } from '../ui/menu';
import { availableConstraintTypes, constraintTypes } from '../eval/constraints';
import type { ArmatureTarget } from '../eval/constraints_more';
import type { Constraint, ObjectData } from '../data/types';
import { constraintPath } from './ops';

/** Extra panel content for constraint types registered by feature modules (e.g. Follow Track). */
export const constraintExtraUI: Record<string, (ob: ObjectData, c: Constraint) => Child> = {};

type C = Record<string, unknown> & Constraint;

const commit = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

const E = (pairs: [string, string][]): EnumItem[] => pairs.map(([value, label]) => ({ value, label }));
const AXES6: [string, string][] = [
  ['TRACK_X', 'X'],
  ['TRACK_Y', 'Y'],
  ['TRACK_Z', 'Z'],
  ['TRACK_NEGATIVE_X', '-X'],
  ['TRACK_NEGATIVE_Y', '-Y'],
  ['TRACK_NEGATIVE_Z', '-Z'],
];
const EULER_ORDERS: [string, string][] = [
  ['AUTO', 'Default'],
  ['XYZ', 'XYZ Euler'],
  ['XZY', 'XZY Euler'],
  ['YXZ', 'YXZ Euler'],
  ['YZX', 'YZX Euler'],
  ['ZXY', 'ZXY Euler'],
  ['ZYX', 'ZYX Euler'],
];
const COPY_MIX: [string, string][] = [
  ['REPLACE', 'Replace'],
  ['BEFORE_FULL', 'Before Original (Full)'],
  ['BEFORE', 'Before Original (Aligned)'],
  ['BEFORE_SPLIT', 'Before Original (Split Channels)'],
  ['AFTER_FULL', 'After Original (Full)'],
  ['AFTER', 'After Original (Aligned)'],
  ['AFTER_SPLIT', 'After Original (Split Channels)'],
];

/** Animation path of a constraint property (keyframe decorators). */
const anim = (ob: ObjectData, c: Constraint, bone: string | undefined, key: string, index?: number): PropOpts['anim'] => ({ ob, path: `${constraintPath(c, bone)}.${key}`, index });

/** Expanded enum row bound to c[key]. */
function expanded(c: C, key: string, label: string, items: [string, string][]): Child {
  return splitRow(label, enumRow(`${c.id}.${key}`, E(items), String(c[key] ?? ''), (v) => ((c[key] = v), commit(`Change ${label}`))));
}

/** Row of toggle buttons for boolean keys. */
function toggles(c: C, label: string, keys: [string, string][], disabled = false): Child {
  return splitRow(
    label,
    h(
      'div',
      { class: 'row-aligned' },
      keys.map(([k, l]) =>
        h(
          'button',
          {
            key: k,
            class: { tbtn: true, on: c[k] !== false && !!c[k] },
            disabled,
            'data-tip': l,
            onclick: () => ((c[k] = !c[k]), commit(`Change ${label}`)),
          },
          l,
        ),
      ),
    ),
  );
}

/** Small icon button running an operator. */
function iconOp(ic: string, op: string, props: Record<string, unknown>, tip: string): Child {
  return h('button', { class: 'mod-x con-icon-op', 'data-op': op, 'data-tip': tip, disabled: !app.poll(op), onclick: (e: MouseEvent) => (e.stopPropagation(), app.run(op, props)) }, icon(ic));
}

/** A value widget with a small fixed-size widget (button, checkbox) beside it. */
function withSide(main: Child, side: Child, sideFirst = false): Child {
  const m = h('div', { style: { flex: '1', minWidth: '0', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } }, main);
  const sd = h('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center' } }, side);
  return h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center', minWidth: '0' } }, sideFirst ? [sd, m] : [m, sd]);
}

/** Checkbox in the label column with a value next to it (e.g. "Minimum X  [x] 0 m"). */
function checkValue(c: C, check: string, key: string, label: string, opts: PropOpts = {}): Child {
  return splitRow(
    label,
    withSide(
      numberField({ id: `${c.id}.${key}`, value: (c[key] as number) ?? 0, unit: opts.unit, min: opts.min, max: opts.max, disabled: !c[check], set: (v, final) => ((c[key] = v), app.changed('doc'), final && app.pushUndo(`Change ${label}`)) }),
      h('input', { type: 'checkbox', class: 'cv-check', checked: !!c[check], 'data-tip': label, onchange: (e: Event) => ((c[check] = (e.target as HTMLInputElement).checked), commit(`Change ${label}`)) }),
      true,
    ),
  );
}

function boneItems(id: string | null | undefined): EnumItem[] | null {
  const t = id ? app.doc.objects[id] : undefined;
  const arm = t?.type === 'ARMATURE' && t.data ? app.doc.armatures[t.data] : undefined;
  return arm ? [{ value: '', label: '—' }, ...arm.bones.map((b) => ({ value: b.name, label: b.name, icon: 'bone_data' }))] : null;
}

/** Target object (+ bone and head/tail for armature targets). */
function targetRows(ob: ObjectData, c: C, bone: string | undefined, o: { headTail?: boolean; filter?: (t: ObjectData) => boolean; key?: string; subKey?: string; label?: string } = {}): Child {
  const key = o.key ?? 'target',
    sub = o.subKey ?? 'subtarget';
  // an armature may target its own bones, other objects may not target themselves
  const filter = (t: ObjectData) => (t.id !== ob.id || (!!bone && t.type === 'ARMATURE')) && (!o.filter || o.filter(t));
  const bones = boneItems(c[key] as string);
  const rows: Child[] = [objectProp(c, key, o.label ?? 'Target', { filter, undo: `Set ${o.label ?? 'Target'}` })];
  if (bones) {
    rows.push(splitRow('Bone', enumMenu(`${c.id}.${sub}`, bones, String(c[sub] ?? ''), (v) => ((c[sub] = v), commit('Set Bone')))));
    if (o.headTail && c[sub]) rows.push(num(c, 'head_tail', 'Head/Tail', { min: 0, max: 1, slider: true }));
  }
  return rows;
}

const OBJECT_SPACES: [string, string][] = [
  ['WORLD', 'World Space'],
  ['CUSTOM', 'Custom Space'],
  ['LOCAL', 'Local Space'],
];
const BONE_SPACES: [string, string][] = [
  ['WORLD', 'World Space'],
  ['CUSTOM', 'Custom Space'],
  ['POSE', 'Pose Space'],
  ['LOCAL_WITH_PARENT', 'Local With Parent'],
  ['LOCAL', 'Local Space'],
];

/** Target/owner space menus (and the custom space object). */
function spaceRows(ob: ObjectData, c: C, bone: string | undefined): Child {
  const t = constraintTypes[c.type];
  if (!t?.spaces) return null;
  const rows: Child[] = [];
  const targetIsBone = !!boneItems(c.target as string) && !!c.subtarget;
  if (t.spaces.target && t.usesTarget && c.target) {
    const items = targetIsBone ? [...BONE_SPACES, ['LOCAL_OWNER_ORIENT', 'Local Space (Owner Orientation)'] as [string, string]].filter(([v]) => v !== 'LOCAL_OWNER_ORIENT' || !!bone) : OBJECT_SPACES;
    rows.push(enumProp(c, 'target_space', 'Target', items));
  }
  if (t.spaces.owner && c.type !== 'ACTION') rows.push(enumProp(c, 'owner_space', 'Owner', bone ? BONE_SPACES : OBJECT_SPACES));
  if (c.owner_space === 'CUSTOM' || c.target_space === 'CUSTOM') rows.push(targetRows(ob, c, bone, { key: 'space_object', subKey: 'space_subtarget', label: 'Custom Space' }));
  return rows;
}

const curveFilter = (o: ObjectData) => o.type === 'CURVE';
const meshFilter = (o: ObjectData) => o.type === 'MESH';

/** Type-specific settings. */
const drawers: Record<string, (ob: ObjectData, c: C, bone?: string) => Child> = {
  COPY_LOCATION: (ob, c, bone) => [
    targetRows(ob, c, bone, { headTail: true }),
    toggles(c, 'Axis', [
      ['use_x', 'X'],
      ['use_y', 'Y'],
      ['use_z', 'Z'],
    ]),
    toggles(c, 'Invert', [
      ['invert_x', 'X'],
      ['invert_y', 'Y'],
      ['invert_z', 'Z'],
    ]),
    bool(c, 'use_offset', 'Offset'),
  ],
  COPY_ROTATION: (ob, c, bone) => [
    targetRows(ob, c, bone),
    enumProp(c, 'euler_order', 'Order', EULER_ORDERS),
    toggles(c, 'Axis', [
      ['use_x', 'X'],
      ['use_y', 'Y'],
      ['use_z', 'Z'],
    ]),
    toggles(c, 'Invert', [
      ['invert_x', 'X'],
      ['invert_y', 'Y'],
      ['invert_z', 'Z'],
    ]),
    enumProp(c, 'mix_mode', 'Mix', [
      ['REPLACE', 'Replace'],
      ['ADD', 'Add'],
      ['BEFORE', 'Before Original'],
      ['AFTER', 'After Original'],
      ['OFFSET', 'Offset (Legacy)'],
    ]),
  ],
  COPY_SCALE: (ob, c, bone) => [
    targetRows(ob, c, bone),
    toggles(c, 'Axis', [
      ['use_x', 'X'],
      ['use_y', 'Y'],
      ['use_z', 'Z'],
    ]),
    num(c, 'power', 'Power', { softMin: -4, softMax: 4 }),
    bool(c, 'use_make_uniform', 'Make Uniform'),
    bool(c, 'use_offset', 'Offset'),
    c.use_offset ? bool(c, 'use_add', 'Additive') : null,
  ],
  COPY_TRANSFORMS: (ob, c, bone) => [targetRows(ob, c, bone, { headTail: true }), bool(c, 'remove_target_shear', 'Remove Target Shear'), enumProp(c, 'mix_mode', 'Mix', COPY_MIX)],
  LIMIT_DISTANCE: (ob, c, bone) => [
    targetRows(ob, c, bone, { headTail: true }),
    splitRow(
      'Distance',
      withSide(
        numberField({ id: `${c.id}.distance`, value: (c.distance as number) ?? 0, unit: 'distance', min: 0, set: (v, final) => ((c.distance = v), app.changed('doc'), final && app.pushUndo('Change Distance')) }),
        iconOp('undo', 'constraint.limitdistance_reset', { constraint: c.name, owner: bone ? 'BONE' : 'OBJECT' }, 'Measure the distance again'),
      ),
    ),
    enumProp(c, 'limit_mode', 'Clamp Region', [
      ['LIMITDIST_INSIDE', 'Inside'],
      ['LIMITDIST_OUTSIDE', 'Outside'],
      ['LIMITDIST_ONSURFACE', 'On Surface'],
    ]),
    affect(c, bone),
  ],
  LIMIT_LOCATION: (_ob, c, bone) => [
    ...(['x', 'y', 'z'] as const).map((a) => checkValue(c, `use_min_${a}`, `min_${a}`, `Minimum ${a.toUpperCase()}`, { unit: 'distance' })),
    ...(['x', 'y', 'z'] as const).map((a) => checkValue(c, `use_max_${a}`, `max_${a}`, `Maximum ${a.toUpperCase()}`, { unit: 'distance' })),
    affect(c, bone),
  ],
  LIMIT_ROTATION: (_ob, c, bone) => [
    ...(['x', 'y', 'z'] as const).flatMap((a) => [
      bool(c, `use_limit_${a}`, `Limit ${a.toUpperCase()}`),
      c[`use_limit_${a}`] ? [num(c, `min_${a}`, 'Min', { unit: 'angle' }), num(c, `max_${a}`, 'Max', { unit: 'angle' })] : null,
    ]),
    enumProp(c, 'euler_order', 'Order', EULER_ORDERS),
    bool(c, 'use_legacy_behavior', 'Legacy Behavior'),
    affect(c, bone),
  ],
  LIMIT_SCALE: (_ob, c, bone) => [
    ...(['x', 'y', 'z'] as const).map((a) => checkValue(c, `use_min_${a}`, `min_${a}`, `Minimum ${a.toUpperCase()}`)),
    ...(['x', 'y', 'z'] as const).map((a) => checkValue(c, `use_max_${a}`, `max_${a}`, `Maximum ${a.toUpperCase()}`)),
    affect(c, bone),
  ],
  MAINTAIN_VOLUME: (_ob, c) => [
    enumProp(c, 'mode', 'Mode', [
      ['STRICT', 'Strict'],
      ['UNIFORM', 'Uniform'],
      ['SINGLE_AXIS', 'Single Axis'],
    ]),
    expanded(c, 'free_axis', 'Free Axis', [
      ['SAMEVOL_X', 'X'],
      ['SAMEVOL_Y', 'Y'],
      ['SAMEVOL_Z', 'Z'],
    ]),
    num(c, 'volume', 'Volume', { min: 0.001, max: 100 }),
  ],
  TRANSFORM: (ob, c, bone) => {
    const from = (c.map_from as string) ?? 'LOCATION',
      to = (c.map_to as string) ?? 'LOCATION';
    const fsuf = from === 'ROTATION' ? '_rot' : from === 'SCALE' ? '_scale' : '';
    const tsuf = to === 'ROTATION' ? '_rot' : to === 'SCALE' ? '_scale' : '';
    const unit = (m: string) => (m === 'ROTATION' ? 'angle' : m === 'LOCATION' ? 'distance' : 'none') as PropOpts['unit'];
    const mapItems: [string, string][] = [
      ['LOCATION', 'Location'],
      ['ROTATION', 'Rotation'],
      ['SCALE', 'Scale'],
    ];
    return [
      targetRows(ob, c, bone),
      bool(c, 'use_motion_extrapolate', 'Extrapolate'),
      panel(`con-${c.id}-from`, 'Map From', () => [
        expanded(c, 'map_from', 'Map From', mapItems),
        from === 'ROTATION'
          ? enumProp(c, 'from_rotation_mode', 'Mode', [...EULER_ORDERS.map(([v, l]) => [v, v === 'AUTO' ? 'Auto Euler' : l] as [string, string]), ['QUATERNION', 'Quaternion'], ['SWING_TWIST_X', 'Swing and X Twist'], ['SWING_TWIST_Y', 'Swing and Y Twist'], ['SWING_TWIST_Z', 'Swing and Z Twist']])
          : null,
        ...(['x', 'y', 'z'] as const).flatMap((a) => [num(c, `from_min_${a}${fsuf}`, `${a.toUpperCase()} Min`, { unit: unit(from) }), num(c, `from_max_${a}${fsuf}`, 'Max', { unit: unit(from) })]),
      ], { sub: true }),
      panel(`con-${c.id}-to`, 'Map To', () => [
        expanded(c, 'map_to', 'Map To', mapItems),
        to === 'ROTATION' ? enumProp(c, 'to_euler_order', 'Order', EULER_ORDERS) : null,
        ...(['x', 'y', 'z'] as const).flatMap((a) => [
          expanded(c, `map_to_${a}_from`, `${a.toUpperCase()} ← Source`, [
            ['X', 'X'],
            ['Y', 'Y'],
            ['Z', 'Z'],
          ]),
          num(c, `to_min_${a}${tsuf}`, 'Min', { unit: unit(to) }),
          num(c, `to_max_${a}${tsuf}`, 'Max', { unit: unit(to) }),
        ]),
        to === 'LOCATION'
          ? enumProp(c, 'mix_mode', 'Mix', [
              ['ADD', 'Add'],
              ['REPLACE', 'Replace'],
            ])
          : to === 'ROTATION'
            ? enumProp(c, 'mix_mode_rot', 'Mix', [
                ['ADD', 'Add'],
                ['REPLACE', 'Replace'],
                ['BEFORE', 'Before Original'],
                ['AFTER', 'After Original'],
              ])
            : enumProp(c, 'mix_mode_scale', 'Mix', [
                ['REPLACE', 'Replace'],
                ['MULTIPLY', 'Multiply'],
              ]),
      ], { sub: true }),
    ];
  },
  CLAMP_TO: (ob, c) => [
    targetRows(ob, c, undefined, { filter: curveFilter }),
    expanded(c, 'main_axis', 'Main Axis', [
      ['CLAMPTO_AUTO', 'Auto'],
      ['CLAMPTO_X', 'X'],
      ['CLAMPTO_Y', 'Y'],
      ['CLAMPTO_Z', 'Z'],
    ]),
    bool(c, 'use_cyclic', 'Cyclic'),
  ],
  DAMPED_TRACK: (ob, c, bone) => [targetRows(ob, c, bone, { headTail: true }), expanded(c, 'track_axis', 'Track Axis', AXES6)],
  IK: (ob, c, bone) => [
    targetRows(ob, c, bone),
    targetRows(ob, c, bone, { key: 'pole_target', subKey: 'pole_subtarget', label: 'Pole Target' }),
    c.pole_target ? num(c, 'pole_angle', 'Pole Angle', { unit: 'angle', min: -Math.PI, max: Math.PI, anim: anim(ob, c, bone, 'pole_angle') }) : null,
    num(c, 'iterations', 'Iterations', { int: true, min: 0, max: 10000 }),
    num(c, 'chain_count', 'Chain Length', { int: true, min: 0, max: 255 }),
    bool(c, 'use_tail', 'Use Tail'),
    bool(c, 'use_stretch', 'Stretch'),
    h('div', { class: 'sub-label' }, 'Weight'),
    checkValue(c, 'use_location', 'weight', 'Position', { min: 0.01, max: 1 }),
    checkValue(c, 'use_rotation', 'orient_weight', 'Rotation', { min: 0.01, max: 1 }),
  ],
  LOCKED_TRACK: (ob, c, bone) => [
    targetRows(ob, c, bone, { headTail: true }),
    expanded(c, 'track_axis', 'Track Axis', AXES6),
    expanded(c, 'lock_axis', 'Lock', [
      ['LOCK_X', 'X'],
      ['LOCK_Y', 'Y'],
      ['LOCK_Z', 'Z'],
    ]),
  ],
  SPLINE_IK: (ob, c) => [
    targetRows(ob, c, undefined, { filter: curveFilter }),
    num(c, 'chain_count', 'Chain Length', { int: true, min: 1, max: 255 }),
    panel(`con-${c.id}-fit`, 'Fitting', () => [bool(c, 'use_even_divisions', 'Even Divisions'), bool(c, 'use_chain_offset', 'Chain Offset'), bool(c, 'use_curve_radius', 'Use Curve Radius')], { sub: true }),
    panel(`con-${c.id}-scale`, 'Chain Scaling', () => [
      enumProp(c, 'y_scale_mode', 'Y Scale Mode', [
        ['NONE', 'None'],
        ['FIT_CURVE', 'Fit Curve'],
        ['BONE_ORIGINAL', 'Bone Original'],
      ]),
      enumProp(c, 'xz_scale_mode', 'XZ Scale Mode', [
        ['NONE', 'None'],
        ['BONE_ORIGINAL', 'Bone Original'],
        ['INVERSE_PRESERVE', 'Inverse Scale'],
        ['VOLUME_PRESERVE', 'Volume Preservation'],
      ]),
      c.xz_scale_mode === 'VOLUME_PRESERVE' ? [bool(c, 'use_original_scale', 'Use Original Scale'), bulgeRows(c)] : null,
    ], { sub: true }),
  ],
  STRETCH_TO: (ob, c, bone) => [
    targetRows(ob, c, bone, { headTail: true }),
    splitRow(
      'Original Length',
      withSide(
        numberField({ id: `${c.id}.rest_length`, value: (c.rest_length as number) ?? 0, unit: 'distance', min: 0, set: (v, final) => ((c.rest_length = v), app.changed('doc'), final && app.pushUndo('Change Original Length')) }),
        iconOp('undo', 'constraint.stretchto_reset', { constraint: c.name, owner: bone ? 'BONE' : 'OBJECT' }, 'Measure the length again'),
      ),
    ),
    bulgeRows(c),
    expanded(c, 'volume', 'Volume', [
      ['VOLUME_XZX', 'XZ'],
      ['VOLUME_X', 'X'],
      ['VOLUME_Z', 'Z'],
      ['NO_VOLUME', 'None'],
    ]),
    expanded(c, 'keep_axis', 'Rotation', [
      ['PLANE_X', 'Keep X'],
      ['PLANE_Z', 'Keep Z'],
      ['SWING_Y', 'Swing'],
    ]),
  ],
  TRACK_TO: (ob, c, bone) => [
    targetRows(ob, c, bone, { headTail: true }),
    expanded(c, 'track_axis', 'Track Axis', AXES6),
    expanded(c, 'up_axis', 'Up', [
      ['UP_X', 'X'],
      ['UP_Y', 'Y'],
      ['UP_Z', 'Z'],
    ]),
    bool(c, 'use_target_z', 'Target Z'),
  ],
  ACTION: (ob, c, bone) => [
    targetRows(ob, c, bone),
    bool(c, 'use_eval_time', 'Evaluation Time'),
    enumProp(c, 'mix_mode', 'Mix', COPY_MIX),
    panel(`con-${c.id}-act-target`, c.use_eval_time ? 'Evaluation' : 'Target', () =>
      c.use_eval_time
        ? [num(c, 'eval_time', 'Evaluation Time', { min: 0, max: 1, slider: true, anim: anim(ob, c, bone, 'eval_time') })]
        : [
            enumProp(c, 'transform_channel', 'Channel', [
              ['LOCATION_X', 'X Location'],
              ['LOCATION_Y', 'Y Location'],
              ['LOCATION_Z', 'Z Location'],
              ['ROTATION_X', 'X Rotation'],
              ['ROTATION_Y', 'Y Rotation'],
              ['ROTATION_Z', 'Z Rotation'],
              ['SCALE_X', 'X Scale'],
              ['SCALE_Y', 'Y Scale'],
              ['SCALE_Z', 'Z Scale'],
            ]),
            // rotation channels are given in degrees
            num(c, 'min', 'Range Min', { min: -1000, max: 1000 }),
            num(c, 'max', 'Max', { min: -1000, max: 1000 }),
          ], { sub: true }),
    panel(`con-${c.id}-act-action`, 'Action', () => [
      splitRow(
        'Action',
        enumMenu(`${c.id}.action`, [{ value: '', label: '—' }, ...Object.values(app.doc.actions).map((a) => ({ value: a.id, label: a.name, icon: 'action' }))], String(c.action ?? ''), (v) => ((c.action = v || null), commit('Set Action'))),
      ),
      bone ? bool(c, 'use_bone_object_action', 'Object Action') : null,
      num(c, 'frame_start', 'Frame Start', { int: true }),
      num(c, 'frame_end', 'End', { int: true }),
    ], { sub: true }),
  ],
  ARMATURE: (ob, c, bone) => {
    const owner = bone ? 'BONE' : 'OBJECT';
    const ts = (c.targets as ArmatureTarget[]) ?? [];
    const total = ts.reduce((a, t) => a + t.weight, 0);
    return [
      bool(c, 'use_deform_preserve_volume', 'Preserve Volume'),
      bool(c, 'use_bone_envelopes', 'Use Envelopes'),
      bone ? bool(c, 'use_current_location', 'Use Current Location') : null,
      h('div', { class: 'btn-row', style: { display: 'flex', gap: '4px', padding: '2px 0' } }, opButton('constraint.normalize_target_weights', 'Normalize Weights', { constraint: c.name, owner }), opButton('constraint.add_target', 'Add Target Bone', { constraint: c.name, owner }, { icon: 'add' })),
      ts.length && Math.abs(total - 1) > 1e-3 ? h('div', { class: 'prop-note' }, `Weights add up to ${total.toFixed(3)}`) : null,
      panel(`con-${c.id}-bones`, 'Bones', () =>
        ts.map((t, i) =>
          h(
            'div',
            { key: i, class: 'con-arm-target', style: { borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '2px' } },
            objectProp(t as unknown as Record<string, unknown>, 'target', 'Armature', { filter: (o) => o.type === 'ARMATURE', undo: 'Set Target' }),
            boneItems(t.target) ? splitRow('Bone', enumMenu(`${c.id}.t${i}.bone`, boneItems(t.target)!, t.subtarget ?? '', (v) => ((t.subtarget = v), commit('Set Bone')))) : null,
            splitRow(
              'Weight',
              withSide(
                numberField({ id: `${c.id}.t${i}.w`, value: t.weight, min: 0, max: 1, slider: true, set: (v, final) => ((t.weight = v), app.changed('doc'), final && app.pushUndo('Change Weight')) }),
                iconOp('x', 'constraint.remove_target', { constraint: c.name, owner, index: i }, 'Remove this target'),
              ),
            ),
          ),
        ), { sub: true }),
    ];
  },
  CHILD_OF: (ob, c, bone) => [
    targetRows(ob, c, bone),
    toggles(c, 'Location', [
      ['use_location_x', 'X'],
      ['use_location_y', 'Y'],
      ['use_location_z', 'Z'],
    ]),
    toggles(c, 'Rotation', [
      ['use_rotation_x', 'X'],
      ['use_rotation_y', 'Y'],
      ['use_rotation_z', 'Z'],
    ]),
    toggles(c, 'Scale', [
      ['use_scale_x', 'X'],
      ['use_scale_y', 'Y'],
      ['use_scale_z', 'Z'],
    ]),
    bool(c, 'set_inverse_pending', 'Set Inverse Pending'),
    h(
      'div',
      { class: 'btn-row', style: { display: 'flex', gap: '4px', padding: '2px 0' } },
      opButton('constraint.childof_set_inverse', 'Set Inverse', { constraint: c.name, owner: bone ? 'BONE' : 'OBJECT' }),
      opButton('constraint.childof_clear_inverse', 'Clear Inverse', { constraint: c.name, owner: bone ? 'BONE' : 'OBJECT' }),
    ),
  ],
  FLOOR: (ob, c, bone) => [
    targetRows(ob, c, bone),
    num(c, 'offset', 'Offset', { unit: 'distance' }),
    expanded(c, 'floor_location', 'Min/Max', [
      ['FLOOR_X', 'X'],
      ['FLOOR_Y', 'Y'],
      ['FLOOR_Z', 'Z'],
      ['FLOOR_NEGATIVE_X', '-X'],
      ['FLOOR_NEGATIVE_Y', '-Y'],
      ['FLOOR_NEGATIVE_Z', '-Z'],
    ]),
    bool(c, 'use_rotation', 'Use Rotation'),
  ],
  FOLLOW_PATH: (ob, c, bone) => [
    targetRows(ob, c, undefined, { filter: curveFilter }),
    c.use_fixed_location ? num(c, 'offset_factor', 'Offset Factor', { min: 0, max: 1, slider: true, anim: anim(ob, c, bone, 'offset_factor') }) : num(c, 'offset', 'Offset', { anim: anim(ob, c, bone, 'offset') }),
    bool(c, 'use_fixed_location', 'Fixed Position'),
    bool(c, 'use_curve_radius', 'Curve Radius'),
    bool(c, 'use_curve_follow', 'Follow Curve'),
    c.use_curve_follow
      ? [
          expanded(c, 'forward_axis', 'Forward Axis', [
            ['FORWARD_X', 'X'],
            ['FORWARD_Y', 'Y'],
            ['FORWARD_Z', 'Z'],
            ['TRACK_NEGATIVE_X', '-X'],
            ['TRACK_NEGATIVE_Y', '-Y'],
            ['TRACK_NEGATIVE_Z', '-Z'],
          ]),
          expanded(c, 'up_axis', 'Up', [
            ['UP_X', 'X'],
            ['UP_Y', 'Y'],
            ['UP_Z', 'Z'],
          ]),
        ]
      : null,
    h('div', { class: 'btn-col' }, opButton('constraint.followpath_path_animate', 'Animate Path', { constraint: c.name, owner: bone ? 'BONE' : 'OBJECT' }, { icon: 'action' })),
  ],
  GEOMETRY_ATTRIBUTE: (ob, c) => [
    targetRows(ob, c, undefined, { filter: (o) => o.type === 'MESH' || o.type === 'CURVE' || o.type === 'POINTCLOUD' || o.type === 'EMPTY' }),
    textProp(c, 'attribute_name', 'Attribute Name'),
    enumProp(c, 'data_type', 'Data Type', [
      ['VECTOR', 'Vector'],
      ['QUATERNION', 'Quaternion'],
      ['FLOAT4X4', '4x4 Matrix'],
    ]),
    enumProp(c, 'domain', 'Domain', [
      ['POINT', 'Point'],
      ['EDGE', 'Edge'],
      ['FACE', 'Face'],
      ['FACE_CORNER', 'Face Corner'],
      ['CURVE', 'Spline'],
      ['INSTANCE', 'Instance'],
    ]),
    num(c, 'sample_index', 'Sample Index', { int: true, min: 0 }),
    bool(c, 'apply_target_transform', 'Target Transform'),
    toggles(c, 'Enabled', [
      ['mix_loc', 'Location'],
      ['mix_rot', 'Rotation'],
      ['mix_scl', 'Scale'],
    ]),
    enumProp(c, 'mix_mode', 'Mix', [
      ['REPLACE', 'Replace'],
      ['BEFORE_FULL', 'Before Original (Full)'],
      ['BEFORE_SPLIT', 'Before Original (Split Channels)'],
      ['AFTER_FULL', 'After Original (Full)'],
      ['AFTER_SPLIT', 'After Original (Split Channels)'],
    ]),
  ],
  PIVOT: (ob, c, bone) => [
    targetRows(ob, c, bone, { headTail: true }),
    c.target ? null : bool(c, 'use_relative_location', 'Relative'),
    vecProp(c, 'offset', 'Pivot Offset', { unit: 'distance' }),
    enumProp(c, 'rotation_range', 'Rotation Range', [
      ['ALWAYS_ACTIVE', 'Always'],
      ['NX', '-X Rotation'],
      ['NY', '-Y Rotation'],
      ['NZ', '-Z Rotation'],
      ['X', 'X Rotation'],
      ['Y', 'Y Rotation'],
      ['Z', 'Z Rotation'],
    ]),
  ],
  SHRINKWRAP: (ob, c) => {
    const type = (c.shrinkwrap_type as string) ?? 'NEAREST_SURFACE';
    return [
      targetRows(ob, c, undefined, { filter: meshFilter }),
      num(c, 'distance', 'Distance', { unit: 'distance', min: 0 }),
      enumProp(c, 'shrinkwrap_type', 'Mode', [
        ['NEAREST_SURFACE', 'Nearest Surface Point'],
        ['PROJECT', 'Project'],
        ['NEAREST_VERTEX', 'Nearest Vertex'],
        ['TARGET_PROJECT', 'Target Normal Project'],
      ]),
      type === 'PROJECT'
        ? [
            expanded(c, 'project_axis', 'Project Axis', [
              ['POS_X', 'X'],
              ['POS_Y', 'Y'],
              ['POS_Z', 'Z'],
              ['NEG_X', '-X'],
              ['NEG_Y', '-Y'],
              ['NEG_Z', '-Z'],
            ]),
            enumProp(c, 'project_axis_space', 'Space', [
              ['WORLD', 'World Space'],
              ['LOCAL', 'Local Space'],
            ]),
            num(c, 'project_limit', 'Distance', { unit: 'distance', min: 0 }),
            bool(c, 'use_project_opposite', 'Project Opposite'),
            expanded(c, 'cull_face', 'Face Cull', [
              ['OFF', 'Off'],
              ['FRONT', 'Front'],
              ['BACK', 'Back'],
            ]),
            c.use_project_opposite && c.cull_face !== 'OFF' ? bool(c, 'use_invert_cull', 'Invert Cull') : null,
          ]
        : null,
      type !== 'NEAREST_VERTEX'
        ? enumProp(c, 'wrap_mode', 'Snap Mode', [
            ['ON_SURFACE', 'On Surface'],
            ['INSIDE', 'Inside'],
            ['OUTSIDE', 'Outside'],
            ['OUTSIDE_SURFACE', 'Outside Surface'],
            ['ABOVE_SURFACE', 'Above Surface'],
          ])
        : null,
      bool(c, 'use_track_normal', 'Align to Normal'),
      c.use_track_normal ? expanded(c, 'track_axis', 'Align Axis', AXES6) : null,
    ];
  },
};

/** "Affect Transform" (object owners only: interactive transforms are limited too). */
function affect(c: C, bone?: string): Child {
  if (bone) return null;
  return bool(c, 'use_transform_limit', 'Affect Transform', { tip: 'Moving, rotating or scaling the object is held within the limits as well' });
}

/** Volume variation rows shared by Stretch To and Spline IK. */
function bulgeRows(c: C): Child {
  return [
    num(c, 'bulge', 'Volume Variation', { min: 0, max: 100, softMax: 4 }),
    checkValue(c, 'use_bulge_min', 'bulge_min', 'Volume Min', { min: 0, max: 1 }),
    checkValue(c, 'use_bulge_max', 'bulge_max', 'Volume Max', { min: 1, max: 100 }),
    c.use_bulge_min || c.use_bulge_max ? num(c, 'bulge_smooth', 'Smooth', { min: 0, max: 1, slider: true }) : null,
  ];
}

/** Whether a constraint can work with its current settings (shown red otherwise). */
export function constraintIsValid(ob: ObjectData, c: Constraint, bone?: string): boolean {
  const t = constraintTypes[c.type];
  if (!t) return false;
  if (t.isValid) return t.isValid(c, { doc: app.doc, ob, bone });
  if (t.usesTarget) {
    const tg = c.target ? app.doc.objects[c.target as string] : undefined;
    if (!tg) return c.type === 'PIVOT';
    if (tg.id === ob.id && !(bone && c.subtarget && c.subtarget !== bone)) return false;
    if (tg.type === 'ARMATURE' && c.subtarget && !boneItems(tg.id)?.some((b) => b.value === c.subtarget)) return false;
  }
  return true;
}

/** Keyframe state of a constraint's influence (field colouring). */
function influenceState(ob: ObjectData, c: Constraint, bone?: string) {
  const st = keyState(app.doc, ob, `${constraintPath(c, bone)}.influence`);
  return st === 'none' ? null : st;
}

/** Keyframe decorator for the influence. */
function influenceDecorator(ob: ObjectData, c: Constraint, bone?: string): Child {
  const path = `${constraintPath(c, bone)}.influence`;
  return decorator(keyState(app.doc, ob, path), () => {
    keyProperty(app.doc, ob, path);
    app.pushUndo('Insert Keyframe');
    app.changed('doc');
  });
}

/** Header menu of a constraint panel. */
function panelMenu(list: Constraint[], c: Constraint, bone?: string): MenuItem[] {
  const owner = bone ? 'BONE' : 'OBJECT';
  const props = { constraint: c.name, owner };
  const i = list.indexOf(c);
  return [
    { label: 'Apply', shortcut: 'Ctrl A', op: 'constraint.apply', props: { ...props, report: true }, disabled: !!constraintTypes[c.type]?.boneOnly },
    { label: 'Duplicate', shortcut: 'Shift D', op: 'constraint.copy', props },
    { label: 'Copy to Selected', op: 'constraint.copy_to_selected', props },
    { separator: true },
    { label: 'Move to First', op: 'constraint.move_to_index', props: { ...props, index: 0 }, disabled: i === 0 },
    { label: 'Move to Last', op: 'constraint.move_to_index', props: { ...props, index: list.length - 1 }, disabled: i === list.length - 1 },
  ];
}

function constraintPanel(ob: ObjectData, list: Constraint[], c: Constraint, bone?: string): Child {
  const id = `con-${c.id}`;
  const open = isPanelOpen(id, c.show_expanded);
  const valid = constraintIsValid(ob, c, bone);
  const owner = bone ? 'BONE' : 'OBJECT';
  const cc = c as C;
  const draw = drawers[c.type];
  return h(
    'section',
    { key: c.id, class: { panel: true, modifier: true, constraint: true, open, disabled: c.mute, invalid: !valid }, 'data-con': c.name, 'data-con-owner': owner },
    h(
      'header',
      {
        class: 'panel-header mod-header',
        style: valid ? {} : { background: 'rgba(153, 22, 22, 0.55)' },
        'data-tip': valid ? '' : 'This constraint is missing a valid target or has conflicting settings',
        onpointerdown: (e: PointerEvent) => {
          if ((e.target as HTMLElement).closest('button, input, label, .ph-grip')) return;
          setPanelOpen(id, !open);
          c.show_expanded = !open;
          app.changed('ui');
        },
      },
      h('span', { class: 'ph-arrow' }, icon(open ? 'disclosure_tri_down' : 'disclosure_tri_right')),
      icon(bone ? 'constraint_bone' : 'constraint'),
      textField(`con-name-${c.id}`, c.name, (v) => {
        const name = v.trim() || c.name;
        if (list.some((x) => x !== c && x.name === name)) return app.report('WARNING', `A constraint named "${name}" already exists`);
        c.name = name;
        commit('Rename Constraint');
      }, { className: 'mod-name' }),
      h('button', { class: { 'mod-toggle': true, on: !c.mute }, 'data-tip': 'Enable or disable the constraint', onclick: (e: MouseEvent) => (e.stopPropagation(), (c.mute = !c.mute), commit('Toggle Constraint')) }, icon(c.mute ? 'hide_on' : 'hide_off')),
      h(
        'button',
        {
          class: 'mod-menu',
          'data-tip': 'Constraint options',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu(panelMenu(list, c, bone), e.currentTarget as HTMLElement);
          },
        },
        icon('down_arrow_hlt'),
      ),
      h('button', { class: 'mod-x', 'data-tip': 'Delete constraint', onclick: (e: MouseEvent) => (e.stopPropagation(), app.run('constraint.delete', { constraint: c.name, owner, report: true })) }, icon('x')),
      h('span', { class: 'ph-grip', draggable: 'true', 'data-tip': 'Drag to reorder', ondragstart: (e: DragEvent) => e.dataTransfer?.setData('text/constraint', c.name) }, '⠿'),
    ),
    open
      ? h(
          'div',
          {
            class: 'panel-body',
            ondragover: (e: DragEvent) => e.preventDefault(),
            ondrop: (e: DragEvent) => {
              const from = e.dataTransfer?.getData('text/constraint');
              if (from && from !== c.name) app.run('constraint.move_to_index', { constraint: from, owner, index: list.indexOf(c) });
            },
          },
          draw ? draw(ob, cc, bone) : constraintTypes[c.type]?.usesTarget ? targetRows(ob, cc, bone) : null,
          constraintExtraUI[c.type]?.(ob, c) ?? null,
          spaceRows(ob, cc, bone),
          splitRow(
            'Influence',
            withSide(
              numberField({ id: `${c.id}.influence`, value: c.influence, min: 0, max: 1, slider: true, anim: influenceState(ob, c, bone), set: (v, final) => ((c.influence = v), app.changed('doc'), final && app.pushUndo('Change Influence')) }),
              iconOp('panel_close', 'constraint.disable_keep_transform', { constraint: c.name, owner }, 'Disable and Keep Transform: turn the influence off while keeping the owner where it is'),
            ),
            influenceDecorator(ob, c, bone),
          ),
        )
      : null,
  );
}

/** Add Constraint menu, grouped by category in the usual order. */
export function addConstraintMenu(bone?: string): MenuItem[] {
  const types = availableConstraintTypes(!!bone);
  const cats: [string, string][] = [
    ['MOTION_TRACKING', 'Motion Tracking'],
    ['TRANSFORM', 'Transform'],
    ['TRACKING', 'Tracking'],
    ['RELATIONSHIP', 'Relationship'],
  ];
  const op = bone ? 'pose.constraint_add' : 'object.constraint_add';
  return cats
    .filter(([cat]) => types.some((t) => t.category === cat))
    .map(([cat, label]) => ({
      label,
      submenu: () => types.filter((t) => t.category === cat).map((t) => ({ label: t.label, op, props: { type: t.type } })),
    }));
}

function stack(ob: ObjectData, list: Constraint[], bone?: string): Child {
  return [
    h(
      'div',
      { class: 'stack-toolbar' },
      h(
        'button',
        { class: 'btn add-mod', 'data-tip': 'Add a constraint (Shift A)', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(addConstraintMenu(bone), e.currentTarget as HTMLElement)) },
        icon('add'),
        bone ? 'Add Bone Constraint' : 'Add Object Constraint',
        icon('down_arrow_hlt', 'tiny'),
      ),
    ),
    list.map((c) => constraintPanel(ob, list, c, bone)),
  ];
}

registerTab({
  id: 'CONSTRAINT',
  label: 'Object Constraints',
  icon: 'constraint',
  group: 3,
  poll: () => !!app.activeObject,
  draw: () => stack(app.activeObject!, app.activeObject!.constraints),
});

registerTab({
  id: 'BONE_CONSTRAINT',
  label: 'Bone Constraints',
  icon: 'constraint_bone',
  group: 3,
  poll: () => {
    const o = app.activeObject;
    return o?.type === 'ARMATURE' && !!o.pose && !!(o.data && app.doc.armatures[o.data]?.active_bone);
  },
  draw: () => {
    const o = app.activeObject!;
    const arm = app.doc.armatures[o.data!];
    const pb = o.pose![arm.active_bone!];
    if (!pb) return h('div', { class: 'prop-note' }, 'The active bone has no pose channel yet');
    return stack(o, pb.constraints, arm.active_bone!);
  },
});
