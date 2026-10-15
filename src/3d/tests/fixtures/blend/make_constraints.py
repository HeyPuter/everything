# Builds a scene with one empty per constraint setting variant (named <TYPE>__<n>, the
# settings are listed in `variants` below) and saves it zstd-compressed, for the constraint
# import tests in tests/unit/constraints_import.test.ts.
# Usage: <bpy host> -b --factory-startup \
#          --python tests/fixtures/blend/make_constraints.py -- <outdir>
# then copy <outdir>/constraints_zstd.blend here.
import bpy, sys, os

argv = sys.argv[sys.argv.index('--') + 1:]
outdir = argv[0]
os.makedirs(outdir, exist_ok=True)
for o in list(bpy.data.objects): bpy.data.objects.remove(o)
sc=bpy.context.scene
tgt=bpy.data.objects.new('TGT',None); sc.collection.objects.link(tgt)
cu=bpy.data.curves.new('CU','CURVE'); cob=bpy.data.objects.new('CURVE',cu); sc.collection.objects.link(cob)
arm=bpy.data.armatures.new('ARM'); aob=bpy.data.objects.new('ARMOB',arm); sc.collection.objects.link(aob)
act=bpy.data.actions.new('ACT')
variants = {
 'CLAMP_TO': [{}, {'main_axis':'CLAMPTO_X'}, {'main_axis':'CLAMPTO_Y'}, {'main_axis':'CLAMPTO_Z'}, {'use_cyclic':True}],
 'ACTION': [{}, {'transform_channel':'ROTATION_Y'}, {'transform_channel':'SCALE_Z'}, {'use_bone_object_action':True}, {'use_eval_time':True}, {'mix_mode':'REPLACE'}, {'mix_mode':'BEFORE_FULL'}, {'mix_mode':'BEFORE'}, {'mix_mode':'BEFORE_SPLIT'}, {'mix_mode':'AFTER_FULL'}, {'mix_mode':'AFTER_SPLIT'}, {'frame_start':3,'frame_end':9,'min':-1,'max':2,'eval_time':0.25}],
 'ARMATURE': [{}, {'use_deform_preserve_volume':True}, {'use_bone_envelopes':True}, {'use_current_location':True}],
 'SPLINE_IK': [{}, {'chain_count':3}, {'use_even_divisions':True}, {'use_chain_offset':True}, {'use_curve_radius':False}, {'use_original_scale':False}, {'xz_scale_mode':'BONE_ORIGINAL'}, {'xz_scale_mode':'INVERSE_PRESERVE'}, {'xz_scale_mode':'VOLUME_PRESERVE'}, {'y_scale_mode':'NONE'}, {'y_scale_mode':'BONE_ORIGINAL'}, {'use_bulge_min':True}, {'use_bulge_max':True}],
 'GEOMETRY_ATTRIBUTE': [{}, {'domain':'EDGE'}, {'domain':'FACE'}, {'domain':'FACE_CORNER'}, {'domain':'CURVE'}, {'domain':'INSTANCE'}, {'data_type':'QUATERNION'}, {'data_type':'FLOAT4X4'}, {'mix_loc':False}, {'mix_rot':False}, {'mix_scl':False}, {'mix_mode':'BEFORE_FULL'}, {'mix_mode':'BEFORE_SPLIT'}, {'mix_mode':'AFTER_FULL'}, {'mix_mode':'AFTER_SPLIT'}, {'apply_target_transform':True, 'sample_index':7, 'attribute_name':'foo'}],
 'TRANSFORM': [{}, {'map_from':'ROTATION'}, {'map_from':'SCALE'}, {'map_to':'ROTATION'}, {'map_to':'SCALE'}, {'map_to_x_from':'Z'}, {'map_to_y_from':'X'}, {'map_to_z_from':'Y'}, {'use_motion_extrapolate':True}, {'from_rotation_mode':'QUATERNION'}, {'from_rotation_mode':'SWING_TWIST_Y'}, {'from_rotation_mode':'ZYX'}, {'to_euler_order':'YZX'}, {'mix_mode':'REPLACE'}, {'mix_mode_rot':'REPLACE'}, {'mix_mode_rot':'BEFORE'}, {'mix_mode_rot':'AFTER'}, {'mix_mode_scale':'MULTIPLY'}, {'from_min_x':1,'from_max_y':2,'to_min_z':3,'from_min_x_rot':0.5,'to_max_y_scale':4}],
 'COPY_SCALE': [{}, {'use_make_uniform':True}, {'use_offset':True}, {'use_add':True}, {'use_x':False}],
 'STRETCH_TO': [{}, {'keep_axis':'PLANE_X'}, {'keep_axis':'PLANE_Z'}, {'use_bulge_min':True}, {'use_bulge_max':True}, {'bulge_min':0.5,'bulge_max':2,'bulge_smooth':0.3}],
 'PIVOT': [{}, {'rotation_range':'ALWAYS_ACTIVE'}, {'rotation_range':'X'}, {'rotation_range':'NY'}, {'use_relative_location':False}],
 'SHRINKWRAP': [{}, {'wrap_mode':'INSIDE'}, {'wrap_mode':'ABOVE_SURFACE'}, {'project_axis':'NEG_Y'}, {'project_axis_space':'WORLD'}, {'use_project_opposite':True}, {'cull_face':'FRONT'}, {'use_invert_cull':True}, {'use_track_normal':True}, {'track_axis':'TRACK_NEGATIVE_Z'}, {'project_limit':1.5}],
 'MAINTAIN_VOLUME': [{}, {'mode':'UNIFORM'}, {'mode':'SINGLE_AXIS'}],
 'LIMIT_ROTATION': [{}, {'euler_order':'ZXY'}, {'use_transform_limit':True}, {'use_legacy_behavior':True}],
 'COPY_TRANSFORMS': [{}, {'remove_target_shear':True}],
 'LIMIT_DISTANCE': [{}, {'use_transform_limit':True}],
 'COPY_ROTATION': [{}, {'euler_order':'YXZ'}],
 'IK': [{}, {'use_location':False}, {'use_rotation':True}, {'use_stretch':False}, {'use_tail':False}],
 'FLOOR': [{}, {'use_rotation':True}],
 'LIMIT_LOCATION': [{}, {'use_transform_limit':True}],
}
for t, vs in variants.items():
    for i, v in enumerate(vs):
        o = bpy.data.objects.new(f'{t}__{i}', None)
        sc.collection.objects.link(o)
        c = o.constraints.new(t)
        if hasattr(c, 'target'):
            c.target = cob if t in ('CLAMP_TO', 'SPLINE_IK') else tgt
        if t == 'ACTION':
            c.action = act
        if t == 'ARMATURE':
            tt = c.targets.new()
            tt.target = aob
            tt.subtarget = 'Bone'
            tt.weight = 0.3
        for k, val in v.items():
            setattr(c, k, val)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'constraints_zstd.blend'), compress=True)
