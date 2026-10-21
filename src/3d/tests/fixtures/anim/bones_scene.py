# Bone scenarios: an armature built through edit bones, posed, with bone constraints; prints the
# pose bones' armature-space matrices. Runs unchanged in both apps.
import bpy, math, json

def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)

out = {}

def build(name, chain):
    arm = bpy.data.armatures.new(name)
    ob = bpy.data.objects.new(name, arm)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    prev = None
    for bn, head, tail, connect in chain:
        b = arm.edit_bones.new(bn)
        b.head = head
        b.tail = tail
        if prev is not None:
            b.parent = arm.edit_bones[prev]
            b.use_connect = connect
        prev = bn
    bpy.ops.object.mode_set(mode='POSE')
    return ob

def dump(key, ob):
    bpy.context.view_layer.update()
    res = {}
    for pb in ob.pose.bones:
        m = pb.matrix
        res[pb.name] = [[round(m[r][c], 4) for c in range(4)] for r in range(3)]
    out[key] = res

# 1. two-bone IK reaching a target, with a pole
clear()
tgt = bpy.data.objects.new('Target', None); bpy.context.scene.collection.objects.link(tgt); tgt.location = (0.8, 0.3, 1.2)
pole = bpy.data.objects.new('Pole', None); bpy.context.scene.collection.objects.link(pole); pole.location = (0, -2, 1)
ob = build('IKArm', [('A', (0, 0, 0), (0, 0, 1), False), ('B', (0, 0, 1), (0, 0.1, 2), True)])
c = ob.pose.bones['B'].constraints.new('IK'); c.target = tgt; c.chain_count = 2
dump('ik', ob)
c.pole_target = pole; c.pole_angle = 0.0
dump('ik_pole', ob)

# 2. Copy Rotation from another bone in local space, Damped Track to a bone, Stretch To
clear()
ob = build('Rig', [('Root', (0, 0, 0), (0, 0, 1), False), ('Mid', (0, 0, 1), (0, 0.2, 2), True), ('Tip', (0, 0.2, 2), (0.3, 0.2, 2.6), True)])
pr = ob.pose.bones['Root']; pr.rotation_mode = 'XYZ'; pr.rotation_euler = (0.3, 0.1, -0.2)
pt = ob.pose.bones['Tip']; pt.rotation_mode = 'XYZ'; pt.rotation_euler = (0.0, 0.4, 0.2)
c = ob.pose.bones['Mid'].constraints.new('COPY_ROTATION'); c.target = ob; c.subtarget = 'Tip'
c.target_space = 'LOCAL'; c.owner_space = 'LOCAL'
dump('copyrot_local', ob)
c.mix_mode = 'ADD'
dump('copyrot_add', ob)
ob.pose.bones['Mid'].constraints.remove(c)
c = ob.pose.bones['Mid'].constraints.new('DAMPED_TRACK'); c.target = ob; c.subtarget = 'Root'; c.head_tail = 1.0
dump('damped', ob)
print('JSON' + json.dumps(out))
