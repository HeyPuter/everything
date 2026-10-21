# Constraint scenarios: each builds objects with constraints and prints the owner's world matrix.
# Runs unchanged in both apps (a reference run records the expected values).
import bpy, math, json

def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)

def empty(name, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    o = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = rot
    o.scale = scale
    return o

def mat(o):
    bpy.context.view_layer.update()
    m = o.matrix_world
    return [[round(m[r][c], 4) for c in range(4)] for r in range(3)]

out = {}
cases = [
    ('COPY_ROTATION', {}, {}),
    ('COPY_ROTATION', {'mix_mode': 'ADD'}, {}),
    ('COPY_LOCATION', {'use_offset': True}, {}),
    ('COPY_SCALE', {}, {}),
    ('COPY_TRANSFORMS', {}, {}),
    ('DAMPED_TRACK', {'track_axis': 'TRACK_Y'}, {}),
    ('TRACK_TO', {'track_axis': 'TRACK_NEGATIVE_Z', 'up_axis': 'UP_Y'}, {}),
    ('LOCKED_TRACK', {'track_axis': 'TRACK_Y', 'lock_axis': 'LOCK_Z'}, {}),
    ('LIMIT_ROTATION', {'use_limit_x': True, 'min_x': -0.2, 'max_x': 0.2, 'use_limit_z': True, 'min_z': 0.0, 'max_z': 0.5}, {'notarget': True}),
    ('LIMIT_LOCATION', {'use_min_x': True, 'min_x': 0.5, 'use_max_z': True, 'max_z': 0.25}, {'notarget': True}),
    ('LIMIT_DISTANCE', {'distance': 1.0}, {}),
    ('STRETCH_TO', {}, {}),
    ('CHILD_OF', {}, {}),
    ('FLOOR', {'floor_location': 'FLOOR_Z'}, {}),
    ('MAINTAIN_VOLUME', {}, {'notarget': True}),
    ('TRANSFORM', {'map_from': 'LOCATION', 'map_to': 'ROTATION', 'from_max_x': 2.0, 'to_max_z_rot': 1.0}, {}),
]
for i, (ctype, props, opts) in enumerate(cases):
    clear()
    tgt = empty('T', (1.5, -0.5, 2.0), (0.3, -0.4, 0.8), (1.5, 0.75, 1.25))
    own = empty('O', (0.25, 0.5, -0.3), (0.1, 0.2, -0.3), (1.2, 1.0, 0.8))
    c = own.constraints.new(ctype)
    if not opts.get('notarget'):
        c.target = tgt
    for k, v in props.items():
        setattr(c, k, v)
    out['%d_%s' % (i, ctype)] = mat(own)
print('JSON' + json.dumps(out))
