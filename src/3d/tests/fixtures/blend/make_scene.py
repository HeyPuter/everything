# Builds a test scene covering the .blend importer's features, saves it (uncompressed,
# zstd-compressed and as a minimal library-write) and dumps the values bpy reports for
# it to scene.json (used by tests/unit/blend.test.ts as the expected values).
# Usage: <bpy host> -b --factory-startup \
#          --python tests/fixtures/blend/make_scene.py -- <outdir>
# then copy <outdir>/scene_zstd.blend, scene_min_zstd.blend and scene.json here.
import bpy, bmesh, sys, json, math, os
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:]
outdir = argv[0]
os.makedirs(outdir, exist_ok=True)

# ---------------------------------------------------------------- reset
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = 'TestScene'
scene.frame_start = 5
scene.frame_end = 120
scene.render.fps = 30
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.resolution_percentage = 50

def link(ob, col=None):
    (col or scene.collection).objects.link(ob)
    return ob

colA = bpy.data.collections.new('Props')
scene.collection.children.link(colA)
colB = bpy.data.collections.new('Nested')
colA.children.link(colB)
colX = bpy.data.collections.new('Excluded')
scene.collection.children.link(colX)
colH = bpy.data.collections.new('HiddenLC')
scene.collection.children.link(colH)
colR = bpy.data.collections.new('NoRender')
colR.hide_render = True
scene.collection.children.link(colR)
colS = bpy.data.collections.new('NoSelect')
colS.hide_select = True
colS.hide_viewport = True
colS.color_tag = 'COLOR_04'
colA.children.link(colS)

# ---------------------------------------------------------------- images
img = bpy.data.images.new('Checker', 4, 4, alpha=True)
px = []
for y in range(4):
    for x in range(4):
        c = 1.0 if (x + y) % 2 else 0.0
        px += [c, 0.5, 1 - c, 1.0]
img.pixels = px
img.pack()
ext_png = os.path.join(outdir, 'external_tex.png')
img2 = bpy.data.images.new('ExtTmp', 2, 2)
img2.filepath_raw = ext_png
img2.file_format = 'PNG'
img2.save()
bpy.data.images.remove(img2)
ext = bpy.data.images.load(ext_png)
ext.name = 'External'
ext.filepath = '//textures/external_tex.png'

# ---------------------------------------------------------------- materials
def principled(mat):
    return next(n for n in mat.node_tree.nodes if n.bl_idname == 'ShaderNodeBsdfPrincipled')

matA = bpy.data.materials.new('Red Metal')
try:
    matA.use_nodes = True
except Exception:
    pass
bs = principled(matA)
bs.inputs['Base Color'].default_value = (0.8, 0.1, 0.05, 1)
bs.inputs['Metallic'].default_value = 0.9
bs.inputs['Roughness'].default_value = 0.25
bs.inputs['Emission Strength'].default_value = 0.0
matA.diffuse_color = (0.7, 0.2, 0.1, 1)
matA.metallic = 0.6
matA.roughness = 0.3
nt = matA.node_tree
tex = nt.nodes.new('ShaderNodeTexImage'); tex.name = 'Tex'; tex.image = img; tex.interpolation = 'Closest'; tex.location = (-400, 300)
mix = nt.nodes.new('ShaderNodeMix'); mix.name = 'MixRGB'; mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'; mix.location = (-200, 300)
mix.inputs['Factor'].default_value = 0.35
math_n = nt.nodes.new('ShaderNodeMath'); math_n.name = 'MathNode'; math_n.operation = 'POWER'; math_n.inputs[1].default_value = 2.5; math_n.location = (-200, 0)
ramp = nt.nodes.new('ShaderNodeValToRGB'); ramp.name = 'Ramp'; ramp.location = (-400, 0)
ramp.color_ramp.elements[0].color = (0.1, 0.2, 0.3, 1)
nt.links.new(tex.outputs['Color'], mix.inputs[6])
nt.links.new(mix.outputs[2], bs.inputs['Base Color'])
nt.links.new(ramp.outputs['Alpha'], math_n.inputs[0])
nt.links.new(math_n.outputs[0], bs.inputs['Roughness'])

matB = bpy.data.materials.new('Glass Blue')
bsB = principled(matB)
bsB.inputs['Base Color'].default_value = (0.1, 0.3, 0.9, 1)
bsB.inputs['Roughness'].default_value = 0.05
bsB.inputs['IOR'].default_value = 1.45
bsB.inputs['Transmission Weight'].default_value = 1.0
bsB.inputs['Alpha'].default_value = 0.5
tex2 = matB.node_tree.nodes.new('ShaderNodeTexImage'); tex2.image = ext

# ---------------------------------------------------------------- mesh: cube with attributes
bpy.ops.mesh.primitive_cube_add(size=2, location=(1, 2, 3))
cube = bpy.context.active_object
cube.name = 'Cube'
cube.data.name = 'CubeMesh'
for o in list(cube.users_collection):
    o.objects.unlink(cube)
colA.objects.link(cube)
me = cube.data
me.materials.append(matA)
me.materials.append(matB)
me.polygons[1].material_index = 1
me.polygons[3].material_index = 1
me.polygons[0].use_smooth = True
me.polygons[2].use_smooth = True
me.edges[0].use_seam = True
me.edges[1].use_seam = True
me.edges[2].use_edge_sharp = True
cr = me.attributes.new('crease_edge', 'FLOAT', 'EDGE')
cr.data[3].value = 0.75
me.uv_layers.new(name='Second')
col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
for i, d in enumerate(col.data):
    d.color = (i / 24, 0.5, 1 - i / 24, 1)
colp = me.color_attributes.new('PointCol', 'BYTE_COLOR', 'POINT')
for i, d in enumerate(colp.data):
    d.color = (i / 8, 0.25, 0.5, 1)
vg = cube.vertex_groups.new(name='Top')
vg.add([0, 2, 4, 6], 0.75, 'REPLACE')
vg2 = cube.vertex_groups.new(name='Bottom')
vg2.add([1, 3], 0.25, 'REPLACE')
cube.shape_key_add(name='Basis')
sk = cube.shape_key_add(name='Stretch')
for i in range(8):
    sk.data[i].co = Vector(sk.data[i].co) * 1.5
sk.value = 0.4
sk.slider_max = 2.0
sk.vertex_group = 'Top'
cube.rotation_euler = (0.1, 0.2, 0.3)
cube.scale = (1, 2, 0.5)
cube.delta_location = (0.5, 0, 0)
cube.delta_scale = (1, 1, 1.5)

def addmod(ob, name, t, **kw):
    m = ob.modifiers.new(name, t)
    for k, v in kw.items():
        setattr(m, k, v)
    return m

addmod(cube, 'Subsurf', 'SUBSURF', levels=2, render_levels=3, quality=4)
addmod(cube, 'Mirror', 'MIRROR', use_axis=(True, False, True), use_bisect_axis=(False, True, False), use_clip=True, merge_threshold=0.002)
addmod(cube, 'Array', 'ARRAY', count=3, relative_offset_displace=(1.5, 0, 0), use_constant_offset=True, constant_offset_displace=(0, 0.25, 0), use_merge_vertices=True)
addmod(cube, 'Solidify', 'SOLIDIFY', thickness=0.05, offset=0.5, use_even_offset=True)
addmod(cube, 'Bevel', 'BEVEL', width=0.1, segments=3)
addmod(cube, 'Displace', 'DISPLACE', strength=0.3, mid_level=0.25, direction='Z', vertex_group='Top')
addmod(cube, 'Smooth', 'SMOOTH', factor=0.8, iterations=4, use_y=False)
addmod(cube, 'Wave', 'WAVE', height=0.7, width=2.0, speed=0.1, use_y=False)
addmod(cube, 'SimpleDeform', 'SIMPLE_DEFORM', deform_method='BEND', angle=0.5, deform_axis='X')
addmod(cube, 'Triangulate', 'TRIANGULATE', quad_method='FIXED', min_vertices=5)
addmod(cube, 'Weld', 'WELD', merge_threshold=0.01, mode='CONNECTED')
addmod(cube, 'EdgeSplit', 'EDGE_SPLIT', split_angle=0.6, use_edge_sharp=False)
addmod(cube, 'Screw', 'SCREW', angle=3.0, steps=8, render_steps=12, screw_offset=0.5, axis='Y')
addmod(cube, 'Build', 'BUILD', frame_start=3, frame_duration=50, use_reverse=True)
addmod(cube, 'Mask', 'MASK', vertex_group='Top', invert_vertex_group=True, threshold=0.1)
addmod(cube, 'Cast', 'CAST', cast_type='CUBOID', factor=0.7, radius=1.5, use_z=False)
m = addmod(cube, 'Hidden', 'SUBSURF', levels=1)
m.show_viewport = False

# ---------------------------------------------------------------- ngon mesh
me2 = bpy.data.meshes.new('NgonMesh')
verts = [(0, 0, 0), (1, 0, 0), (1.5, 1, 0), (0.5, 1.6, 0), (-0.5, 1, 0), (0, 0, 1)]
me2.from_pydata(verts, [], [(0, 1, 2, 3, 4), (0, 1, 5)])
me2.update()
ngon = link(bpy.data.objects.new('Ngon', me2), colB)
ngon.rotation_mode = 'QUATERNION'
ngon.rotation_quaternion = (0.9238795, 0, 0.3826834, 0)
ngon.location = (-3, 0, 0)

# ---------------------------------------------------------------- empties + parenting
parent = link(bpy.data.objects.new('ParentEmpty', None))
parent.empty_display_type = 'CUBE'
parent.empty_display_size = 0.5
parent.location = (0, 0, 2)
parent.rotation_mode = 'ZYX'
parent.rotation_euler = (0.3, 0.0, 0.7)
child = link(bpy.data.objects.new('ChildEmpty', None))
child.location = (1, 1, 1)
child.parent = parent
child.matrix_parent_inverse = parent.matrix_world.inverted()
child.rotation_mode = 'AXIS_ANGLE'
child.rotation_axis_angle = (0.5, 0, 0, 1)
child.hide_render = True
child.hide_select = True
hid = link(bpy.data.objects.new('HiddenEmpty', None))
hid.hide_set(True)
hid.hide_viewport = True
ex = link(bpy.data.objects.new('InExcluded', None), colX)
hl = link(bpy.data.objects.new('InHiddenLC', None), colH)
nr = link(bpy.data.objects.new('InNoRender', None), colR)
bpy.context.view_layer.layer_collection.children['Excluded'].exclude = True
bpy.context.view_layer.layer_collection.children['HiddenLC'].hide_viewport = True

# ---------------------------------------------------------------- lights
def light(name, t, **kw):
    la = bpy.data.lights.new(name, t)
    for k, v in kw.items():
        setattr(la, k, v)
    ob = link(bpy.data.objects.new(name, la))
    return ob
light('PointL', 'POINT', energy=750, color=(1, 0.5, 0.25), shadow_soft_size=0.3)
light('SunL', 'SUN', energy=3.5, angle=0.05)
light('SpotL', 'SPOT', energy=1200, spot_size=0.8, spot_blend=0.3, show_cone=True, shadow_soft_size=0.2)
light('AreaL', 'AREA', energy=400, shape='RECTANGLE', size=2.0, size_y=0.5)
bpy.data.objects['SunL'].data.use_shadow = False

# ---------------------------------------------------------------- cameras
ca = bpy.data.cameras.new('CamData')
ca.lens = 35
ca.sensor_width = 32
ca.sensor_fit = 'HORIZONTAL'
ca.clip_start = 0.05
ca.clip_end = 500
ca.shift_x = 0.1
ca.shift_y = -0.05
ca.dof.use_dof = True
ca.dof.focus_distance = 7.5
ca.dof.aperture_fstop = 1.8
ca.dof.aperture_blades = 6
cam = link(bpy.data.objects.new('MainCam', ca))
cam.location = (7, -6, 5)
cam.rotation_euler = (1.1, 0, 0.8)
ca.dof.focus_object = cube
scene.camera = cam
ca2 = bpy.data.cameras.new('OrthoData')
ca2.type = 'ORTHO'
ca2.ortho_scale = 12
link(bpy.data.objects.new('OrthoCam', ca2))

# ---------------------------------------------------------------- curves
cu = bpy.data.curves.new('BezCurve', 'CURVE')
cu.dimensions = '3D'
cu.resolution_u = 8
cu.bevel_depth = 0.1
cu.extrude = 0.2
sp = cu.splines.new('BEZIER')
sp.bezier_points.add(2)
for i, bp in enumerate(sp.bezier_points):
    bp.co = (i, i * 0.5, 0)
    bp.handle_left = (i - 0.3, i * 0.5, 0.1)
    bp.handle_right = (i + 0.3, i * 0.5, -0.1)
    bp.handle_left_type = 'FREE'
    bp.handle_right_type = 'FREE'
    bp.radius = 1 + i
    bp.tilt = 0.1 * i
sp.use_cyclic_u = True
nu = cu.splines.new('NURBS')
nu.points.add(3)
for i, p in enumerate(nu.points):
    p.co = (i, 0, 1, 1 + i * 0.1)
nu.order_u = 3
nu.use_endpoint_u = True
po = cu.splines.new('POLY')
po.points.add(1)
po.points[1].co = (0, 0, 3, 1)
curve_ob = link(bpy.data.objects.new('Curve', cu))
txt = bpy.data.curves.new('TextData', 'FONT')
txt.body = 'Hello Blend'
txt.size = 1.5
txt.align_x = 'CENTER'
link(bpy.data.objects.new('Text', txt))

# follow-path constraint target
fp = link(bpy.data.objects.new('Follower', None))
c = fp.constraints.new('FOLLOW_PATH'); c.target = curve_ob; c.use_curve_follow = True; c.offset = 5; c.forward_axis = 'FORWARD_X'

# ---------------------------------------------------------------- armature
arm = bpy.data.armatures.new('RigData')
rig = link(bpy.data.objects.new('Rig', arm))
rig.location = (0, -3, 0)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
b1 = arm.edit_bones.new('Root'); b1.head = (0, 0, 0); b1.tail = (0, 0, 1); b1.roll = 0.2
b2 = arm.edit_bones.new('Mid'); b2.head = (0, 0, 1); b2.tail = (0, 0.5, 2); b2.parent = b1; b2.use_connect = True; b2.roll = -0.4
b3 = arm.edit_bones.new('Tip'); b3.head = (0.2, 0.5, 2.1); b3.tail = (1, 0.5, 2.5); b3.parent = b2; b3.use_deform = False
b3.use_inherit_rotation = False; b3.inherit_scale = 'NONE'; b3.roll = 1.0
bpy.ops.object.mode_set(mode='OBJECT')
pb = rig.pose.bones['Mid']
pb.rotation_mode = 'XYZ'
pb.rotation_euler = (0.3, 0, 0.1)
pb.location = (0, 0.1, 0)
pb.scale = (1, 1.2, 1)
rig.pose.bones['Root'].rotation_quaternion = (0.98, 0.0, 0.2, 0.0)
ik = rig.pose.bones['Tip'].constraints.new('IK'); ik.target = parent; ik.chain_count = 2
cl = rig.pose.bones['Mid'].constraints.new('COPY_ROTATION'); cl.target = parent; cl.influence = 0.5
me3 = bpy.data.meshes.new('SkinMesh')
me3.from_pydata([(0, 0, 0), (0, 0, 1), (0, 0.5, 2)], [(0, 1)], [])
skin = link(bpy.data.objects.new('Skin', me3))
skin.parent = rig
g = skin.vertex_groups.new(name='Mid'); g.add([1, 2], 1.0, 'REPLACE')
addmod(skin, 'Armature', 'ARMATURE', object=rig)
addmod(skin, 'Lattice', 'LATTICE', strength=0.5)
addmod(skin, 'Curve', 'CURVE', object=curve_ob, deform_axis='NEG_Y')
addmod(skin, 'Shrinkwrap', 'SHRINKWRAP', target=cube, wrap_method='PROJECT', offset=0.02)
addmod(skin, 'Warp', 'WARP', object_from=parent, object_to=child, strength=0.6, falloff_radius=2)
h = addmod(skin, 'Hook', 'HOOK', object=parent, strength=0.8, falloff_radius=1.2)

# ---------------------------------------------------------------- object constraints
con_ob = link(bpy.data.objects.new('Constrained', None))
c = con_ob.constraints.new('COPY_LOCATION'); c.target = cube; c.use_y = False; c.invert_x = True; c.use_offset = True; c.influence = 0.7
c = con_ob.constraints.new('COPY_ROTATION'); c.target = cam; c.mix_mode = 'ADD'
c = con_ob.constraints.new('COPY_SCALE'); c.target = cube; c.power = 2
c = con_ob.constraints.new('COPY_TRANSFORMS'); c.target = cube; c.mute = True
c = con_ob.constraints.new('LIMIT_LOCATION'); c.use_min_z = True; c.min_z = 0.5; c.use_max_x = True; c.max_x = 3
c = con_ob.constraints.new('LIMIT_ROTATION'); c.use_limit_x = True; c.min_x = -0.5; c.max_x = 0.5
c = con_ob.constraints.new('LIMIT_SCALE'); c.use_max_y = True; c.max_y = 2
c = con_ob.constraints.new('TRACK_TO'); c.target = cube; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
c = con_ob.constraints.new('DAMPED_TRACK'); c.target = cube; c.track_axis = 'TRACK_X'
c = con_ob.constraints.new('CHILD_OF'); c.target = parent; c.use_scale_x = False
c = con_ob.constraints.new('LIMIT_DISTANCE'); c.target = cube; c.distance = 2.5; c.limit_mode = 'LIMITDIST_OUTSIDE'

# ---------------------------------------------------------------- animation
anim = link(bpy.data.objects.new('Animated', None))
anim.location = (0, 0, 0)
anim.keyframe_insert('location', frame=1)
anim.location = (2, 0, 1)
anim.keyframe_insert('location', frame=10)
anim.location = (4, 1, 0)
anim.keyframe_insert('location', frame=20)
anim.rotation_euler = (0, 0, 0)
anim.keyframe_insert('rotation_euler', index=2, frame=1)
anim.rotation_euler = (0, 0, 1.5)
anim.keyframe_insert('rotation_euler', index=2, frame=30)
act = anim.animation_data.action
act.name = 'AnimAction'
from bpy_extras import anim_utils
cb = anim_utils.action_get_channelbag_for_slot(act, anim.animation_data.action_slot)
for fc in cb.fcurves:
    if fc.data_path == 'rotation_euler':
        fc.keyframe_points[0].interpolation = 'LINEAR'
        fc.extrapolation = 'LINEAR'
    if fc.data_path == 'location' and fc.array_index == 1:
        fc.keyframe_points[1].interpolation = 'CONSTANT'
    if fc.data_path == 'location' and fc.array_index == 2:
        fc.keyframe_points[0].interpolation = 'ELASTIC'
        fc.keyframe_points[0].easing = 'EASE_OUT'
# pose bone animation
pb.keyframe_insert('rotation_euler', frame=1)
pb.rotation_euler = (1.0, 0, 0)
pb.keyframe_insert('rotation_euler', frame=15)
rig.animation_data.action.name = 'RigAction'
# shape key animation on the cube
sk.keyframe_insert('value', frame=1)

# NLA
nla_ob = link(bpy.data.objects.new('NlaObj', None))
nla_ob.keyframe_insert('scale', index=0, frame=1)
nla_ob.scale = (3, 1, 1)
nla_ob.keyframe_insert('scale', index=0, frame=11)
nact = nla_ob.animation_data.action
nact.name = 'NlaAction'
tr = nla_ob.animation_data.nla_tracks.new()
tr.name = 'Track1'
stp = tr.strips.new('Strip1', 20, nact)
stp.repeat = 2
stp.blend_type = 'ADD'
nla_ob.animation_data.action = None

# ---------------------------------------------------------------- world
world = bpy.data.worlds.new('TestWorld')
scene.world = world
try:
    world.use_nodes = True
except Exception:
    pass
bg = next(n for n in world.node_tree.nodes if n.bl_idname == 'ShaderNodeBackground')
bg.inputs['Color'].default_value = (0.2, 0.3, 0.4, 1)
bg.inputs['Strength'].default_value = 1.7
world.color = (0.2, 0.3, 0.4)

# ---------------------------------------------------------------- expected values
dg = bpy.context.evaluated_depsgraph_get()
def r(v, n=5):
    if isinstance(v, (int, bool, str)) or v is None: return v
    if isinstance(v, float): return round(v, n)
    return [r(x, n) for x in v]

exp = {'version': bpy.app.version_string, 'scene': {
    'name': scene.name, 'frame_start': scene.frame_start, 'frame_end': scene.frame_end, 'fps': scene.render.fps,
    'resolution': [scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage],
    'camera': scene.camera.name, 'world': [r(list(bg.inputs['Color'].default_value)), r(bg.inputs['Strength'].default_value)]},
    'objects': {}, 'meshes': {}, 'materials': {}, 'lights': {}, 'cameras': {}, 'actions': {}, 'collections': {}}
for ob in bpy.data.objects:
    e = {'type': ob.type, 'data': ob.data.name if ob.data else None, 'parent': ob.parent.name if ob.parent else None,
         'location': r(list(ob.location)), 'rotation_mode': ob.rotation_mode, 'rotation_euler': r(list(ob.rotation_euler)),
         'rotation_quaternion': r(list(ob.rotation_quaternion)), 'rotation_axis_angle': r(list(ob.rotation_axis_angle)),
         'scale': r(list(ob.scale)), 'delta_location': r(list(ob.delta_location)), 'delta_scale': r(list(ob.delta_scale)),
         'matrix_world': r([x for col in ob.matrix_world.transposed() for x in col], 4),
         'matrix_parent_inverse': r([x for col in ob.matrix_parent_inverse.transposed() for x in col], 4),
         'hide_render': ob.hide_render, 'hide_select': ob.hide_select, 'hide_viewport': ob.hide_viewport,
         'collections': [c.name for c in ob.users_collection],
         'modifiers': [{'name': m.name, 'type': m.type, 'show_viewport': m.show_viewport} for m in ob.modifiers],
         'constraints': [{'name': c.name, 'type': c.type, 'influence': r(c.influence), 'mute': c.mute} for c in ob.constraints],
         'action': ob.animation_data.action.name if ob.animation_data and ob.animation_data.action else None,
         'nla': [[t.name, [[st.name, st.action.name, r(st.frame_start), r(st.frame_end), r(st.repeat), st.blend_type] for st in t.strips]] for t in ob.animation_data.nla_tracks] if ob.animation_data else []}
    if ob.type == 'EMPTY':
        e['empty'] = [ob.empty_display_type, r(ob.empty_display_size)]
    if ob.type == 'ARMATURE':
        e['bones'] = {b.name: {'head': r(list(b.head_local)), 'tail': r(list(b.tail_local)), 'parent': b.parent.name if b.parent else None,
                               'use_connect': b.use_connect, 'use_deform': b.use_deform,
                               'matrix_local': r([x for col in b.matrix_local.transposed() for x in col], 4)} for b in ob.data.bones}
        e['pose'] = {p.name: {'location': r(list(p.location)), 'rotation_mode': p.rotation_mode, 'rotation_euler': r(list(p.rotation_euler)),
                              'rotation_quaternion': r(list(p.rotation_quaternion)), 'scale': r(list(p.scale)),
                              'constraints': [c.type for c in p.constraints]} for p in ob.pose.bones}
        e['bone_flags'] = {b.name: [b.use_inherit_rotation, b.inherit_scale] for b in ob.data.bones}
    exp['objects'][ob.name] = e
for me_ in bpy.data.meshes:
    e = {'verts': len(me_.vertices), 'edges': len(me_.edges), 'faces': len(me_.polygons), 'loops': len(me_.loops),
         'positions': r([c for v in me_.vertices for c in v.co]),
         'corner_verts': [l.vertex_index for l in me_.loops],
         'face_sizes': [p.loop_total for p in me_.polygons],
         'smooth': [int(p.use_smooth) for p in me_.polygons],
         'material_index': [p.material_index for p in me_.polygons],
         'materials': [m.name if m else None for m in me_.materials],
         'uv_layers': [u.name for u in me_.uv_layers],
         'uv_active': me_.uv_layers.active.name if me_.uv_layers.active else None,
         'uv0': r([c for d in me_.uv_layers[0].uv for c in d.vector]) if me_.uv_layers else [],
         'seam_edges': [list(ed.vertices) for ed in me_.edges if ed.use_seam],
         'sharp_edges': [list(ed.vertices) for ed in me_.edges if ed.use_edge_sharp],
         'color_attributes': [{'name': c.name, 'domain': c.domain, 'type': c.data_type, 'first': r(list(c.data[1].color)) } for c in me_.color_attributes],
         'attributes': [[a.name, a.domain, a.data_type] for a in me_.attributes],
         'shape_keys': [{'name': k.name, 'value': r(k.value), 'slider_max': r(k.slider_max), 'vertex_group': k.vertex_group,
                         'relative_key': k.relative_key.name, 'co1': r(list(k.data[1].co))} for k in me_.shape_keys.key_blocks] if me_.shape_keys else []}
    crease = me_.attributes.get('crease_edge')
    if crease:
        e['crease_edges'] = [[list(me_.edges[i].vertices), r(d.value)] for i, d in enumerate(crease.data) if d.value]
    exp['meshes'][me_.name] = e
for ob in bpy.data.objects:
    if ob.type == 'MESH' and ob.vertex_groups:
        exp['meshes'][ob.data.name]['vertex_groups'] = [g.name for g in ob.vertex_groups]
        exp['meshes'][ob.data.name]['weights'] = {g.name: {str(v.index): r(gg.weight) for v in ob.data.vertices for gg in v.groups if gg.group == g.index} for g in ob.vertex_groups}
for m in bpy.data.materials:
    nodes = {}
    for n in m.node_tree.nodes:
        nodes[n.name] = {'type': n.bl_idname, 'location': r(list(n.location), 2),
                         'inputs': {s.identifier: r(list(s.default_value)) if hasattr(s, 'default_value') and hasattr(s.default_value, '__len__') else (r(s.default_value) if hasattr(s, 'default_value') else None) for s in n.inputs if s.enabled}}
    exp['materials'][m.name] = {'diffuse_color': r(list(m.diffuse_color)), 'metallic': r(m.metallic), 'roughness': r(m.roughness),
                                'nodes': nodes,
                                'links': [[l.from_node.name, l.from_socket.identifier, l.to_node.name, l.to_socket.identifier] for l in m.node_tree.links]}
for la in bpy.data.lights:
    e = {'type': la.type, 'energy': r(la.energy), 'color': r(list(la.color)), 'shadow_soft_size': r(la.shadow_soft_size), 'use_shadow': la.use_shadow}
    if la.type == 'SPOT': e.update(spot_size=r(la.spot_size), spot_blend=r(la.spot_blend), show_cone=la.show_cone)
    if la.type == 'AREA': e.update(shape=la.shape, size=r(la.size), size_y=r(la.size_y))
    if la.type == 'SUN': e.update(angle=r(la.angle))
    exp['lights'][la.name] = e
for c_ in bpy.data.cameras:
    exp['cameras'][c_.name] = {'type': c_.type, 'lens': r(c_.lens), 'sensor_width': r(c_.sensor_width), 'sensor_fit': c_.sensor_fit,
                               'clip_start': r(c_.clip_start), 'clip_end': r(c_.clip_end), 'shift_x': r(c_.shift_x), 'shift_y': r(c_.shift_y),
                               'ortho_scale': r(c_.ortho_scale), 'dof': [c_.dof.use_dof, r(c_.dof.focus_distance), r(c_.dof.aperture_fstop), c_.dof.aperture_blades,
                               c_.dof.focus_object.name if c_.dof.focus_object else None]}
for a in bpy.data.actions:
    fcs = []
    for slot in a.slots:
        cbag = anim_utils.action_get_channelbag_for_slot(a, slot)
        if not cbag: continue
        for fc in cbag.fcurves:
            fcs.append({'data_path': fc.data_path, 'array_index': fc.array_index, 'extrapolation': fc.extrapolation,
                        'group': fc.group.name if fc.group else None,
                        'keys': [{'co': r(list(k.co)), 'hl': r(list(k.handle_left)), 'hr': r(list(k.handle_right)), 'interpolation': k.interpolation,
                                  'easing': k.easing, 'hlt': k.handle_left_type, 'hrt': k.handle_right_type} for k in fc.keyframe_points]})
    exp['actions'][a.name] = {'slots': [s.identifier for s in a.slots], 'fcurves': fcs}
def walk(c, depth=0):
    exp['collections'][c.name] = {'children': [x.name for x in c.children], 'objects': sorted(o.name for o in c.objects), 'hide_render': c.hide_render,
        'hide_select': c.hide_select, 'hide_viewport': c.hide_viewport, 'color_tag': c.color_tag if hasattr(c, 'color_tag') else None}
    for x in c.children: walk(x)
walk(scene.collection)
lc = bpy.context.view_layer.layer_collection
exp['view_layer'] = {x.name: {'exclude': x.exclude, 'hide_viewport': x.hide_viewport} for x in lc.children}
exp['images'] = {i.name: {'packed': i.packed_file is not None, 'filepath': i.filepath, 'size': list(i.size)} for i in bpy.data.images}

with open(os.path.join(outdir, 'scene.json'), 'w') as f:
    json.dump(exp, f, indent=1, sort_keys=True)

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'scene.blend'), compress=False)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'scene_zstd.blend'), compress=True)
bpy.data.libraries.write(os.path.join(outdir, 'scene_min.blend'), {scene}, compress=False)
bpy.data.libraries.write(os.path.join(outdir, 'scene_min_zstd.blend'), {scene}, compress=True)
print('DONE')
