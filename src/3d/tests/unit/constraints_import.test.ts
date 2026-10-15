import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { readBlend } from '../../src/io/blend/convert';
import type { DocumentData } from '../../src/data/types';

// variants saved by tests/fixtures/blend/make_constraints.py: [object name, constraint type, settings]
const CASES: [string, string, Record<string, unknown>][] = [
  ['CLAMP_TO__0', 'CLAMP_TO', {}],
  ['CLAMP_TO__1', 'CLAMP_TO', {'main_axis': 'CLAMPTO_X'}],
  ['CLAMP_TO__2', 'CLAMP_TO', {'main_axis': 'CLAMPTO_Y'}],
  ['CLAMP_TO__3', 'CLAMP_TO', {'main_axis': 'CLAMPTO_Z'}],
  ['CLAMP_TO__4', 'CLAMP_TO', {'use_cyclic': true}],
  ['ACTION__0', 'ACTION', {}],
  ['ACTION__1', 'ACTION', {'transform_channel': 'ROTATION_Y'}],
  ['ACTION__2', 'ACTION', {'transform_channel': 'SCALE_Z'}],
  ['ACTION__3', 'ACTION', {'use_bone_object_action': true}],
  ['ACTION__4', 'ACTION', {'use_eval_time': true}],
  ['ACTION__5', 'ACTION', {'mix_mode': 'REPLACE'}],
  ['ACTION__6', 'ACTION', {'mix_mode': 'BEFORE_FULL'}],
  ['ACTION__7', 'ACTION', {'mix_mode': 'BEFORE'}],
  ['ACTION__8', 'ACTION', {'mix_mode': 'BEFORE_SPLIT'}],
  ['ACTION__9', 'ACTION', {'mix_mode': 'AFTER_FULL'}],
  ['ACTION__10', 'ACTION', {'mix_mode': 'AFTER_SPLIT'}],
  ['ACTION__11', 'ACTION', {'frame_start': 3, 'frame_end': 9, 'min': -1, 'max': 2, 'eval_time': 0.25}],
  ['ARMATURE__0', 'ARMATURE', {}],
  ['ARMATURE__1', 'ARMATURE', {'use_deform_preserve_volume': true}],
  ['ARMATURE__2', 'ARMATURE', {'use_bone_envelopes': true}],
  ['ARMATURE__3', 'ARMATURE', {'use_current_location': true}],
  ['SPLINE_IK__0', 'SPLINE_IK', {}],
  ['SPLINE_IK__1', 'SPLINE_IK', {'chain_count': 3}],
  ['SPLINE_IK__2', 'SPLINE_IK', {'use_even_divisions': true}],
  ['SPLINE_IK__3', 'SPLINE_IK', {'use_chain_offset': true}],
  ['SPLINE_IK__4', 'SPLINE_IK', {'use_curve_radius': false}],
  ['SPLINE_IK__5', 'SPLINE_IK', {'use_original_scale': false}],
  ['SPLINE_IK__6', 'SPLINE_IK', {'xz_scale_mode': 'BONE_ORIGINAL'}],
  ['SPLINE_IK__7', 'SPLINE_IK', {'xz_scale_mode': 'INVERSE_PRESERVE'}],
  ['SPLINE_IK__8', 'SPLINE_IK', {'xz_scale_mode': 'VOLUME_PRESERVE'}],
  ['SPLINE_IK__9', 'SPLINE_IK', {'y_scale_mode': 'NONE'}],
  ['SPLINE_IK__10', 'SPLINE_IK', {'y_scale_mode': 'BONE_ORIGINAL'}],
  ['SPLINE_IK__11', 'SPLINE_IK', {'use_bulge_min': true}],
  ['SPLINE_IK__12', 'SPLINE_IK', {'use_bulge_max': true}],
  ['GEOMETRY_ATTRIBUTE__0', 'GEOMETRY_ATTRIBUTE', {}],
  ['GEOMETRY_ATTRIBUTE__1', 'GEOMETRY_ATTRIBUTE', {'domain': 'EDGE'}],
  ['GEOMETRY_ATTRIBUTE__2', 'GEOMETRY_ATTRIBUTE', {'domain': 'FACE'}],
  ['GEOMETRY_ATTRIBUTE__3', 'GEOMETRY_ATTRIBUTE', {'domain': 'FACE_CORNER'}],
  ['GEOMETRY_ATTRIBUTE__4', 'GEOMETRY_ATTRIBUTE', {'domain': 'CURVE'}],
  ['GEOMETRY_ATTRIBUTE__5', 'GEOMETRY_ATTRIBUTE', {'domain': 'INSTANCE'}],
  ['GEOMETRY_ATTRIBUTE__6', 'GEOMETRY_ATTRIBUTE', {'data_type': 'QUATERNION'}],
  ['GEOMETRY_ATTRIBUTE__7', 'GEOMETRY_ATTRIBUTE', {'data_type': 'FLOAT4X4'}],
  ['GEOMETRY_ATTRIBUTE__8', 'GEOMETRY_ATTRIBUTE', {'mix_loc': false}],
  ['GEOMETRY_ATTRIBUTE__9', 'GEOMETRY_ATTRIBUTE', {'mix_rot': false}],
  ['GEOMETRY_ATTRIBUTE__10', 'GEOMETRY_ATTRIBUTE', {'mix_scl': false}],
  ['GEOMETRY_ATTRIBUTE__11', 'GEOMETRY_ATTRIBUTE', {'mix_mode': 'BEFORE_FULL'}],
  ['GEOMETRY_ATTRIBUTE__12', 'GEOMETRY_ATTRIBUTE', {'mix_mode': 'BEFORE_SPLIT'}],
  ['GEOMETRY_ATTRIBUTE__13', 'GEOMETRY_ATTRIBUTE', {'mix_mode': 'AFTER_FULL'}],
  ['GEOMETRY_ATTRIBUTE__14', 'GEOMETRY_ATTRIBUTE', {'mix_mode': 'AFTER_SPLIT'}],
  ['GEOMETRY_ATTRIBUTE__15', 'GEOMETRY_ATTRIBUTE', {'apply_target_transform': true, 'sample_index': 7, 'attribute_name': 'foo'}],
  ['TRANSFORM__0', 'TRANSFORM', {}],
  ['TRANSFORM__1', 'TRANSFORM', {'map_from': 'ROTATION'}],
  ['TRANSFORM__2', 'TRANSFORM', {'map_from': 'SCALE'}],
  ['TRANSFORM__3', 'TRANSFORM', {'map_to': 'ROTATION'}],
  ['TRANSFORM__4', 'TRANSFORM', {'map_to': 'SCALE'}],
  ['TRANSFORM__5', 'TRANSFORM', {'map_to_x_from': 'Z'}],
  ['TRANSFORM__6', 'TRANSFORM', {'map_to_y_from': 'X'}],
  ['TRANSFORM__7', 'TRANSFORM', {'map_to_z_from': 'Y'}],
  ['TRANSFORM__8', 'TRANSFORM', {'use_motion_extrapolate': true}],
  ['TRANSFORM__9', 'TRANSFORM', {'from_rotation_mode': 'QUATERNION'}],
  ['TRANSFORM__10', 'TRANSFORM', {'from_rotation_mode': 'SWING_TWIST_Y'}],
  ['TRANSFORM__11', 'TRANSFORM', {'from_rotation_mode': 'ZYX'}],
  ['TRANSFORM__12', 'TRANSFORM', {'to_euler_order': 'YZX'}],
  ['TRANSFORM__13', 'TRANSFORM', {'mix_mode': 'REPLACE'}],
  ['TRANSFORM__14', 'TRANSFORM', {'mix_mode_rot': 'REPLACE'}],
  ['TRANSFORM__15', 'TRANSFORM', {'mix_mode_rot': 'BEFORE'}],
  ['TRANSFORM__16', 'TRANSFORM', {'mix_mode_rot': 'AFTER'}],
  ['TRANSFORM__17', 'TRANSFORM', {'mix_mode_scale': 'MULTIPLY'}],
  ['TRANSFORM__18', 'TRANSFORM', {'from_min_x': 1, 'from_max_y': 2, 'to_min_z': 3, 'from_min_x_rot': 0.5, 'to_max_y_scale': 4}],
  ['COPY_SCALE__0', 'COPY_SCALE', {}],
  ['COPY_SCALE__1', 'COPY_SCALE', {'use_make_uniform': true}],
  ['COPY_SCALE__2', 'COPY_SCALE', {'use_offset': true}],
  ['COPY_SCALE__3', 'COPY_SCALE', {'use_add': true}],
  ['COPY_SCALE__4', 'COPY_SCALE', {'use_x': false}],
  ['STRETCH_TO__0', 'STRETCH_TO', {}],
  ['STRETCH_TO__1', 'STRETCH_TO', {'keep_axis': 'PLANE_X'}],
  ['STRETCH_TO__2', 'STRETCH_TO', {'keep_axis': 'PLANE_Z'}],
  ['STRETCH_TO__3', 'STRETCH_TO', {'use_bulge_min': true}],
  ['STRETCH_TO__4', 'STRETCH_TO', {'use_bulge_max': true}],
  ['STRETCH_TO__5', 'STRETCH_TO', {'bulge_min': 0.5, 'bulge_max': 2, 'bulge_smooth': 0.3}],
  ['PIVOT__0', 'PIVOT', {}],
  ['PIVOT__1', 'PIVOT', {'rotation_range': 'ALWAYS_ACTIVE'}],
  ['PIVOT__2', 'PIVOT', {'rotation_range': 'X'}],
  ['PIVOT__3', 'PIVOT', {'rotation_range': 'NY'}],
  ['PIVOT__4', 'PIVOT', {'use_relative_location': false}],
  ['SHRINKWRAP__0', 'SHRINKWRAP', {}],
  ['SHRINKWRAP__1', 'SHRINKWRAP', {'wrap_mode': 'INSIDE'}],
  ['SHRINKWRAP__2', 'SHRINKWRAP', {'wrap_mode': 'ABOVE_SURFACE'}],
  ['SHRINKWRAP__3', 'SHRINKWRAP', {'project_axis': 'NEG_Y'}],
  ['SHRINKWRAP__4', 'SHRINKWRAP', {'project_axis_space': 'WORLD'}],
  ['SHRINKWRAP__5', 'SHRINKWRAP', {'use_project_opposite': true}],
  ['SHRINKWRAP__6', 'SHRINKWRAP', {'cull_face': 'FRONT'}],
  ['SHRINKWRAP__7', 'SHRINKWRAP', {'use_invert_cull': true}],
  ['SHRINKWRAP__8', 'SHRINKWRAP', {'use_track_normal': true}],
  ['SHRINKWRAP__9', 'SHRINKWRAP', {'track_axis': 'TRACK_NEGATIVE_Z'}],
  ['SHRINKWRAP__10', 'SHRINKWRAP', {'project_limit': 1.5}],
  ['MAINTAIN_VOLUME__0', 'MAINTAIN_VOLUME', {}],
  ['MAINTAIN_VOLUME__1', 'MAINTAIN_VOLUME', {'mode': 'UNIFORM'}],
  ['MAINTAIN_VOLUME__2', 'MAINTAIN_VOLUME', {'mode': 'SINGLE_AXIS'}],
  ['LIMIT_ROTATION__0', 'LIMIT_ROTATION', {}],
  ['LIMIT_ROTATION__1', 'LIMIT_ROTATION', {'euler_order': 'ZXY'}],
  ['LIMIT_ROTATION__2', 'LIMIT_ROTATION', {'use_transform_limit': true}],
  ['LIMIT_ROTATION__3', 'LIMIT_ROTATION', {'use_legacy_behavior': true}],
  ['COPY_TRANSFORMS__0', 'COPY_TRANSFORMS', {}],
  ['COPY_TRANSFORMS__1', 'COPY_TRANSFORMS', {'remove_target_shear': true}],
  ['LIMIT_DISTANCE__0', 'LIMIT_DISTANCE', {}],
  ['LIMIT_DISTANCE__1', 'LIMIT_DISTANCE', {'use_transform_limit': true}],
  ['COPY_ROTATION__0', 'COPY_ROTATION', {}],
  ['COPY_ROTATION__1', 'COPY_ROTATION', {'euler_order': 'YXZ'}],
  ['IK__0', 'IK', {}],
  ['IK__1', 'IK', {'use_location': false}],
  ['IK__2', 'IK', {'use_rotation': true}],
  ['IK__3', 'IK', {'use_stretch': false}],
  ['IK__4', 'IK', {'use_tail': false}],
  ['FLOOR__0', 'FLOOR', {}],
  ['FLOOR__1', 'FLOOR', {'use_rotation': true}],
  ['LIMIT_LOCATION__0', 'LIMIT_LOCATION', {}],
  ['LIMIT_LOCATION__1', 'LIMIT_LOCATION', {'use_transform_limit': true}],
];

let doc: DocumentData;
beforeAll(async () => {
  doc = (await readBlend(new Uint8Array(readFileSync(new URL('../fixtures/blend/constraints_zstd.blend', import.meta.url))))).doc;
});

describe('.blend constraint import', () => {
  it('imports every constraint type with its settings', () => {
    const byName = new Map(Object.values(doc.objects).map((o) => [o.name, o]));
    for (const [name, type, set] of CASES) {
      const ob = byName.get(name);
      expect(ob, name).toBeTruthy();
      const c = ob!.constraints[0];
      expect(c?.type, name).toBe(type);
      for (const [k, v] of Object.entries(set)) {
        if (typeof v === 'number') expect(c[k] as number, `${name}.${k}`).toBeCloseTo(v, 4);
        else expect(c[k], `${name}.${k}`).toEqual(v);
      }
    }
  });

  it('resolves targets, armature bone targets and actions', () => {
    const byName = new Map(Object.values(doc.objects).map((o) => [o.name, o]));
    const arm = byName.get('ARMATURE__0')!.constraints[0];
    expect(arm.targets).toEqual([{ target: byName.get('ARMOB')!.id, subtarget: 'Bone', weight: expect.closeTo(0.3, 5) }]);
    const act = byName.get('ACTION__0')!.constraints[0];
    expect(doc.actions[act.action as string]?.name).toBe('ACT');
    expect(byName.get('CLAMP_TO__0')!.constraints[0].target).toBe(byName.get('CURVE')!.id);
    expect(byName.get('GEOMETRY_ATTRIBUTE__0')!.constraints[0].target).toBe(byName.get('TGT')!.id);
  });
});
