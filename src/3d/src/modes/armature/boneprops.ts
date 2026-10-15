// Properties editor: Bone tab (active bone name, transform, relations, deform, display).
import { h } from '../../ui/h';
import { app } from '../../app/app';
import { propertiesTabs, type PropertiesTab } from '../../editors/properties/properties';
import { panel, textField, checkbox } from '../../ui/widgets';
import { assignBone, unassignBone } from './armkernels';
import { num, bool, enumProp, vecProp } from '../../ui/props';
import { activeArmature, renameBone } from './armature';

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
    return [
      h(
        'div',
        { class: 'prop-datablock' },
        textField(`bone-name.${bone.name}`, bone.name, (v) => {
          if (!v || v === bone.name) return;
          renameBone(ob, arm, bone.name, v);
          app.pushUndo('Rename Bone');
          app.changed('doc');
        }),
      ),
      panel('bone-transform', 'Transform', () =>
        editing
          ? [vecProp(bone, 'head', 'Head', { unit: 'distance' }), vecProp(bone, 'tail', 'Tail', { unit: 'distance' }), num(bone, 'roll', 'Roll', { unit: 'angle' })]
          : pb
            ? [
                vecProp(pb, 'location', 'Location', { unit: 'distance', anim: { ob, path: path('location') } }),
                pb.rotation_mode === 'QUATERNION'
                  ? vecProp(pb, 'rotation_quaternion', 'Rotation', { names: ['W', 'X', 'Y', 'Z'], anim: { ob, path: path('rotation_quaternion') } })
                  : pb.rotation_mode === 'AXIS_ANGLE'
                    ? vecProp(pb, 'rotation_axis_angle', 'Rotation', { names: ['W', 'X', 'Y', 'Z'], anim: { ob, path: path('rotation_axis_angle') } })
                    : vecProp(pb, 'rotation_euler', 'Rotation', { unit: 'angle', anim: { ob, path: path('rotation_euler') } }),
                enumProp(pb, 'rotation_mode', 'Mode', ROT_MODES),
                vecProp(pb, 'scale', 'Scale', { anim: { ob, path: path('scale') } }),
              ]
            : h('div', { class: 'prop-note' }, 'No pose data'),
      ),
      panel('bone-relations', 'Relations', () => [
        enumProp(bone, 'parent', 'Parent', [['', '—'], ...parents]),
        bone.parent ? bool(bone, 'use_connect', 'Connected') : null,
        bool(bone, 'use_inherit_rotation', 'Inherit Rotation'),
        enumProp(bone, 'inherit_scale', 'Inherit Scale', [['FULL', 'Full'], ['NONE', 'None']]),
        arm.collections?.length
          ? [
              h('div', { class: 'sub-label' }, 'Bone Collections'),
              ...arm.collections.map((c) =>
                checkbox(`bone-coll.${c.name}`, c.name, !!bone.collections?.includes(c.name), (on) => {
                  if (on) assignBone(bone, c.name);
                  else unassignBone(bone, c.name);
                  app.pushUndo(on ? 'Assign to Bone Collection' : 'Remove from Bone Collection');
                  app.changed('doc');
                }),
              ),
            ]
          : null,
      ]),
      panel('bone-deform', 'Deform', () => [bool(bone, 'use_deform', 'Deform'), num(bone, 'envelope_distance', 'Envelope Distance', { unit: 'distance', min: 0 }), num(bone, 'head_radius', 'Radius Head', { unit: 'distance', min: 0 }), num(bone, 'tail_radius', 'Tail', { unit: 'distance', min: 0 })], { closed: true }),
      panel(
        'bone-display',
        'Viewport Display',
        () => {
          const len = Math.hypot(bone.tail[0] - bone.head[0], bone.tail[1] - bone.head[1], bone.tail[2] - bone.head[2]);
          bone.bbone_x ??= 0.1 * len;
          bone.bbone_z ??= 0.1 * len;
          return [
            bool(bone, 'hide', 'Hide'),
            bool(bone as never, 'show_wire' as never, 'Display as Wireframe'),
            arm.display_type === 'BBONE' ? [num(bone as never, 'bbone_x' as never, 'B-Bone Size X', { unit: 'distance', min: 0 }), num(bone as never, 'bbone_z' as never, 'Z', { unit: 'distance', min: 0 }), num(bone, 'bbone_segments', 'Segments', { int: true, min: 1, max: 32 })] : null,
          ];
        },
        { closed: true },
      ),
    ];
  },
};

// Tab order: … Object Data, Bone, Bone Constraints, Material …
const at = propertiesTabs.findIndex((t) => t.id === 'DATA');
propertiesTabs.splice(at >= 0 ? at + 1 : propertiesTabs.length, 0, tab);
