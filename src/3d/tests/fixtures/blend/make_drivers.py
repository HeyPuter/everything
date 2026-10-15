# Builds a scene with drivers (every variable type, bone targets, spaces, rotation modes and
# driver F-curves with keys and modifiers) for the .blend importer tests
# (tests/unit/drivers-blend.test.ts) and saves it as drivers.blend (copied here as drivers_zstd.blend).
# Prints the driven values the host computes, which the test compares against.
# Usage: <bpy host> -b --factory-startup --python tests/fixtures/blend/make_drivers.py -- <outdir>
import bpy, sys, os, json

outdir = sys.argv[sys.argv.index('--') + 1]
os.makedirs(outdir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.frame_end = 120

src = bpy.data.objects.new('Source', None)
sc.collection.objects.link(src)
src.location = (1.5, -2.0, 0.5)
src.rotation_euler = (0.2, 0.4, 3.5)

arm_data = bpy.data.armatures.new('Rig')
arm = bpy.data.objects.new('Rig', arm_data)
sc.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
b = arm_data.edit_bones.new('Bone')
b.head = (0, 0, 0)
b.tail = (0, 1, 0)
bpy.ops.object.mode_set(mode='POSE')
pb = arm.pose.bones['Bone']
pb.rotation_mode = 'XYZ'
pb.rotation_euler = (0.0, 0.6, 0.0)
pb.location = (0.25, 0, 0)
bpy.ops.object.mode_set(mode='OBJECT')

me = bpy.data.meshes.new('Box')
me.from_pydata([(0, 0, 0)], [], [])
tgt = bpy.data.objects.new('Driven', me)
sc.collection.objects.link(tgt)


def driver(path, index, kind, expression=''):
    fc = tgt.driver_add(path, index)
    while len(fc.keyframe_points):
        fc.keyframe_points.remove(fc.keyframe_points[0])
    fc.driver.type = kind
    if expression:
        fc.driver.expression = expression
    return fc


# scripted: transform channel in world space, plus the frame
fc = driver('location', 2, 'SCRIPTED', 'var * 2 + frame')
v = fc.driver.variables.new()
v.type = 'TRANSFORMS'
v.targets[0].id = src
v.targets[0].transform_type = 'LOC_X'
v.targets[0].transform_space = 'WORLD_SPACE'

# average of a single property
fc = driver('scale', 0, 'AVERAGE')
v = fc.driver.variables.new()
v.targets[0].id = src
v.targets[0].data_path = 'location[1]'

# bone transform channel, quaternion mode, transform space; a Generator maps it (1 + 3x)
fc = driver('rotation_euler', 2, 'SUM')
v = fc.driver.variables.new()
v.type = 'TRANSFORMS'
v.targets[0].id = arm
v.targets[0].bone_target = 'Bone'
v.targets[0].transform_type = 'ROT_Y'
v.targets[0].rotation_mode = 'QUATERNION'
v.targets[0].transform_space = 'TRANSFORM_SPACE'
gen = fc.modifiers.new('GENERATOR')
gen.coefficients = (1.0, 3.0)

# context property with a keyed mapping curve
fc = driver('location', 0, 'SCRIPTED', 'end / 100')
v = fc.driver.variables.new()
v.name = 'end'
v.type = 'CONTEXT_PROP'
v.targets[0].context_property = 'ACTIVE_SCENE'
v.targets[0].data_path = 'frame_end'
for x, y in ((0.0, 0.0), (2.0, 10.0)):
    k = fc.keyframe_points.insert(x, y)
    k.interpolation = 'LINEAR'

# distance between an object and a bone in world space
fc = driver('location', 1, 'MAX')
v = fc.driver.variables.new()
v.type = 'LOC_DIFF'
v.targets[0].id = src
v.targets[1].id = arm
v.targets[1].bone_target = 'Bone'

# W rotation and average scale channels, a fallback value and Use Self
src.scale = (1.0, 2.0, 4.0)
fc = driver('scale', 1, 'SCRIPTED', 'w + avg + fb')
fc.driver.use_self = True
for name, chan in (('w', 'ROT_W'), ('avg', 'SCALE_AVG')):
    v = fc.driver.variables.new()
    v.name = name
    v.type = 'TRANSFORMS'
    v.targets[0].id = src
    v.targets[0].transform_type = chan
    v.targets[0].rotation_mode = 'QUATERNION'
v = fc.driver.variables.new()
v.name = 'fb'
v.targets[0].transform_space = 'LOCAL_SPACE'  # stored, though a property target doesn't use it
v.targets[0].id = src
v.targets[0].data_path = 'not_a_property'
v.targets[0].use_fallback_value = True
v.targets[0].fallback_value = 0.25

sc.frame_set(3)
bpy.context.view_layer.update()
expected = {
    'location': list(tgt.location),
    'scale_x': tgt.scale[0],
    'scale_y': tgt.scale[1],
    'rotation_z': tgt.rotation_euler[2],
}
print('EXPECTED ' + json.dumps(expected))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'drivers.blend'), compress=True)
