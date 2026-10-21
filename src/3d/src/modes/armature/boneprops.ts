// Properties editor: Bone tab (active bone name, transform, bendy bones, relations, deform,
// viewport display with bone colours and custom shapes, custom properties).
import { h } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { propertiesTabs, type PropertiesTab } from '../../editors/properties/properties';
import { panel, textField, checkbox } from '../../ui/widgets';
import { assignBone, unassignBone } from './armkernels';
import { num, bool, enumProp, vecProp, objectProp, splitRow } from '../../ui/props';
import { customPropsPanelBody } from '../../ui/customprops';
import type { Bone, PoseBone } from '../../data/types';
import { activeArmature, renameBone } from './armature';
import { boneColorPanel } from './bonecolors';
import './bbonedisplay';

const ROT_MODES: [string, string][] = [
  ['QUATERNION', 'Quaternion (WXYZ)'],
  ['XYZ', 'XYZ Euler'],
  ['XZY', 'XZY Euler'],
  ['YXZ', 'YXZ Euler'],
  ['YZX', 'YZX Euler'],
  ['ZXY', 'ZXY Euler'],
  ['ZYX', 'ZYX Euler'],
  ['AXIS_ANGLE', 'Axis Angle'],
];

const INHERIT_SCALE: [string, string][] = [
  ['FULL', 'Full'],
  ['FIX_SHEAR', 'Fix Shear'],
  ['ALIGNED', 'Aligned'],
  ['AVERAGE', 'Average'],
  ['NONE', 'None'],
  ['NONE_LEGACY', 'None (Legacy)'],
];

const HANDLE_TYPES: [string, string][] = [
  ['AUTO', 'Automatic'],
  ['ABSOLUTE', 'Absolute'],
  ['RELATIVE', 'Relative'],
  ['TANGENT', 'Tangent'],
];

/** Fill in the B-Bone shape defaults on a bone or pose bone (0 offsets, unit scale and ease). */
function bboneDefaults(o: Bone | PoseBone, rest: boolean) {
  for (const k of ['bbone_curveinx', 'bbone_curveinz', 'bbone_curveoutx', 'bbone_curveoutz', 'bbone_rollin', 'bbone_rollout'] as const) o[k] ??= 0;
  o.bbone_scalein ??= [1, 1, 1];
  o.bbone_scaleout ??= [1, 1, 1];
  o.bbone_easein ??= rest ? 1 : 0;
  o.bbone_easeout ??= rest ? 1 : 0;
}

const tab: PropertiesTab = {
  id: 'BONE',
  label: 'Bone',
  icon: 'bone_data',
  group: 3,
  poll: () => {
    const a = activeArmature();
    return !!a && !!a.arm.active_bone && a.arm.bones.some((b) => b.name === a.arm.active_bone);
  },
  draw: () => {
    const { ob, arm } = activeArmature()!;
    const bone = arm.bones.find((b) => b.name === arm.active_bone)!;
    const pb = ob.pose?.[bone.name];
    const editing = app.doc.mode === 'EDIT';
    const path = (p: string) => `pose.bones["${bone.name}"].${p}`;
    const parents = arm.bones.filter((b) => b !== bone).map((b) => [b.name, b.name] as [string, string]);
    const len = Math.hypot(bone.tail[0] - bone.head[0], bone.tail[1] - bone.head[1], bone.tail[2] - bone.head[2]);
    if (pb) {
      pb.lock_location ??= [false, false, false];
      pb.lock_rotation ??= [false, false, false];
      pb.lock_scale ??= [false, false, false];
    }
    // B-Bone shape: the rest values while editing, the pose values (added to them) while posing
    bone.use_local_location ??= true;
    bone.envelope_weight ??= 1;
    const shape: Bone | PoseBone = editing || !pb ? bone : pb;
    bboneDefaults(shape, shape === bone);
    const sanim = (p: string) => (shape === pb ? { anim: { ob, path: path(p) } } : {});
    return [
      h(
        'div',
        { class: 'id-row' },
        icon('bone_data'),
        textField(`bone-name.${bone.name}`, bone.name, (v) => {
          if (!v || v === bone.name) return;
          renameBone(ob, arm, bone.name, v);
          app.pushUndo('Rename Bone');
          app.changed('doc');
        }),
      ),
      panel('bone-transform', 'Transform', () =>
        editing
          ? [vecProp(bone, 'head', 'Head', { unit: 'distance' }), vecProp(bone, 'tail', 'Tail', { unit: 'distance' }), num(bone, 'roll', 'Roll', { unit: 'angle' }), splitRow('Length', h('span', { class: 'sr-text' }, `${len.toFixed(3)} m`))]
          : pb
            ? [
                vecProp(pb, 'location', 'Location', { unit: 'distance', anim: { ob, path: path('location') }, lock: { owner: pb, key: 'lock_location' } }),
                pb.rotation_mode === 'QUATERNION'
                  ? vecProp(pb, 'rotation_quaternion', 'Rotation', { names: ['W', 'X', 'Y', 'Z'], anim: { ob, path: path('rotation_quaternion') }, lock: { owner: pb, key: 'lock_rotation', offset: 1 } })
                  : pb.rotation_mode === 'AXIS_ANGLE'
                    ? vecProp(pb, 'rotation_axis_angle', 'Rotation', { names: ['W', 'X', 'Y', 'Z'], anim: { ob, path: path('rotation_axis_angle') }, lock: { owner: pb, key: 'lock_rotation', offset: 1 } })
                    : vecProp(pb, 'rotation_euler', 'Rotation', { unit: 'angle', anim: { ob, path: path('rotation_euler') }, lock: { owner: pb, key: 'lock_rotation' } }),
                enumProp(pb, 'rotation_mode', 'Mode', ROT_MODES),
                vecProp(pb, 'scale', 'Scale', { anim: { ob, path: path('scale') }, lock: { owner: pb, key: 'lock_scale' } }),
              ]
            : h('div', { class: 'prop-note' }, 'No pose data'),
      ),
      panel(
        'bone-bbone',
        'Bendy Bones',
        () => [
          num(bone, 'bbone_segments', 'Segments', { int: true, min: 1, max: 32 }),
          num(bone as never, 'bbone_x' as never, 'Display Size X', { unit: 'distance', min: 0 }),
          num(bone as never, 'bbone_z' as never, 'Z', { unit: 'distance', min: 0 }),
          enumProp(bone as never, 'bbone_mapping_mode' as never, 'Vertex Mapping', [
            ['STRAIGHT', 'Straight'],
            ['CURVED', 'Curved'],
          ]),
          h('div', { class: 'anim-sb-gap' }),
          num(shape as never, 'bbone_curveinx' as never, 'Curve In X', { unit: 'distance', ...sanim('bbone_curveinx') }),
          num(shape as never, 'bbone_curveinz' as never, 'Z', { unit: 'distance', ...sanim('bbone_curveinz') }),
          num(shape as never, 'bbone_curveoutx' as never, 'Curve Out X', { unit: 'distance', ...sanim('bbone_curveoutx') }),
          num(shape as never, 'bbone_curveoutz' as never, 'Z', { unit: 'distance', ...sanim('bbone_curveoutz') }),
          num(shape as never, 'bbone_rollin' as never, 'Roll In', { unit: 'angle', ...sanim('bbone_rollin') }),
          num(shape as never, 'bbone_rollout' as never, 'Out', { unit: 'angle', ...sanim('bbone_rollout') }),
          editing || !pb ? bool(bone as never, 'use_endroll_as_inroll' as never, 'Inherit End Roll') : null,
          vecProp(shape as never, 'bbone_scalein' as never, 'Scale In', { ...sanim('bbone_scalein') }),
          vecProp(shape as never, 'bbone_scaleout' as never, 'Scale Out', { ...sanim('bbone_scaleout') }),
          num(shape as never, 'bbone_easein' as never, 'Ease In', { ...sanim('bbone_easein') }),
          num(shape as never, 'bbone_easeout' as never, 'Out', { ...sanim('bbone_easeout') }),
          bool(bone as never, 'use_scale_easing' as never, 'Scale Easing'),
          h('div', { class: 'anim-sb-gap' }),
          enumProp(bone as never, 'bbone_handle_type_start' as never, 'Start Handle', HANDLE_TYPES),
          (bone.bbone_handle_type_start ?? 'AUTO') !== 'AUTO' ? enumProp(bone as never, 'bbone_custom_handle_start' as never, 'Custom', [['', '—'], ...parents]) : null,
          enumProp(bone as never, 'bbone_handle_type_end' as never, 'End Handle', HANDLE_TYPES),
          (bone.bbone_handle_type_end ?? 'AUTO') !== 'AUTO' ? enumProp(bone as never, 'bbone_custom_handle_end' as never, 'Custom', [['', '—'], ...parents]) : null,
        ],
        { closed: true },
      ),
      panel('bone-relations', 'Relations', () => [
        enumProp(bone as never, 'parent' as never, 'Parent', [['', '—'], ...parents]),
        bone.parent ? bool(bone, 'use_connect', 'Connected') : null,
        h('div', { class: 'anim-sb-gap' }),
        bool(bone as never, 'use_local_location' as never, 'Local Location'),
        bool(bone, 'use_inherit_rotation', 'Inherit Rotation'),
        enumProp(bone, 'inherit_scale', 'Inherit Scale', INHERIT_SCALE),
        panel(
          'bone-collections',
          'Bone Collections',
          () =>
            arm.collections?.length
              ? arm.collections.map((c) =>
                  checkbox(`bone-coll.${c.name}`, c.name, !!bone.collections?.includes(c.name), (on) => {
                    if (on) assignBone(bone, c.name);
                    else unassignBone(bone, c.name);
                    app.pushUndo(on ? 'Assign to Bone Collection' : 'Remove from Bone Collection');
                    app.changed('doc');
                  }),
                )
              : h('div', { class: 'prop-note' }, 'The armature has no bone collections'),
          { sub: true },
        ),
      ]),
      panel(
        'bone-deform',
        'Deform',
        () => [
          num(bone, 'envelope_distance', 'Envelope Distance', { unit: 'distance', min: 0, disabled: !bone.use_deform }),
          num(bone as never, 'envelope_weight' as never, 'Envelope Weight', { min: 0, max: 1000, disabled: !bone.use_deform }),
          bool(bone as never, 'use_envelope_multiply' as never, 'Envelope Multiply', { disabled: !bone.use_deform }),
          num(bone, 'head_radius', 'Radius Head', { unit: 'distance', min: 0, disabled: !bone.use_deform }),
          num(bone, 'tail_radius', 'Tail', { unit: 'distance', min: 0, disabled: !bone.use_deform }),
        ],
        {
          closed: true,
          header: checkbox(`bone-deform-on.${bone.name}`, '', bone.use_deform, (v) => ((bone.use_deform = v), app.pushUndo('Toggle Deform'), app.changed('doc')), { tip: 'Bone does deformation' }),
        },
      ),
      panel(
        'bone-display',
        'Viewport Display',
        () => {
          bone.bbone_x ??= 0.1 * len;
          bone.bbone_z ??= 0.1 * len;
          return [
            bool(bone, 'show_wire', 'Display as Wireframe'),
            bool(bone, 'hide', 'Hide'),
            boneColorPanel(bone, pb, editing),
            pb && !editing
              ? panel(
                  'bone-custom-shape',
                  'Custom Shape',
                  () => {
                    pb.custom_shape_translation ??= [0, 0, 0];
                    pb.custom_shape_rotation_euler ??= [0, 0, 0];
                    pb.custom_shape_scale_xyz ??= [1, 1, 1];
                    pb.use_custom_shape_bone_size ??= true;
                    pb.custom_shape_wire_width ??= 1;
                    return [
                      objectProp(pb as never, 'custom_shape' as never, 'Custom Object', { filter: (o) => o.id !== ob.id && (o.type === 'MESH' || o.type === 'EMPTY' || o.type === 'CURVE') }),
                      vecProp(pb as never, 'custom_shape_translation' as never, 'Translation', { unit: 'distance' }),
                      vecProp(pb as never, 'custom_shape_rotation_euler' as never, 'Rotation', { unit: 'angle' }),
                      vecProp(pb as never, 'custom_shape_scale_xyz' as never, 'Scale'),
                      enumProp(pb as never, 'custom_shape_transform' as never, 'Override Transform', [['', '—'], ...arm.bones.filter((b) => b.name !== bone.name).map((b): [string, string] => [b.name, b.name])]),
                      bool(pb as never, 'use_custom_shape_bone_size' as never, 'Scale to Bone Length'),
                      num(pb as never, 'custom_shape_wire_width' as never, 'Wireframe Width', { min: 1, max: 16 }),
                    ];
                  },
                  { sub: true },
                )
              : null,
          ];
        },
        { closed: true },
      ),
      panel('bone-custom-props', 'Custom Properties', () => customPropsPanelBody((editing || !pb ? bone : pb) as never, editing || !pb ? 'active_bone' : 'active_pose_bone'), { closed: true }),
    ];
  },
};

// tab order: … Object Data, Bone, Bone Constraints, Material …
const at = propertiesTabs.findIndex((t) => t.id === 'DATA');
propertiesTabs.splice(at >= 0 ? at + 1 : propertiesTabs.length, 0, tab);
