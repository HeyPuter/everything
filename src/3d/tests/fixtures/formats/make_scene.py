"""Build a small rich test scene with bpy and export it in several formats.
usage: <bpy host> -b --factory-startup --python make_scene.py -- OUTDIR
"""
import bpy, sys, os, math, json
out = sys.argv[sys.argv.index('--') + 1]
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
scn.frame_start, scn.frame_end = 1, 24

# --- image (4x4)
img = bpy.data.images.new('checker', 4, 4)
px = []
for y in range(4):
    for x in range(4):
        c = 1.0 if (x + y) % 2 else 0.1
        px += [c, 0.5, 1 - c, 1]
img.pixels = px
img.filepath_raw = os.path.join(out, 'checker.png')
img.file_format = 'PNG'
img.save()
img.pack()

def mat(name, color, metal=0.0, rough=0.5, tex=None):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = color
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if tex:
        t = m.node_tree.nodes.new('ShaderNodeTexImage')
        t.image = tex
        m.node_tree.links.new(t.outputs['Color'], b.inputs['Base Color'])
    return m

red = mat('Red', (0.8, 0.05, 0.05, 1), 0.3, 0.6)
blue = mat('Blue', (0.05, 0.1, 0.8, 1), 0.0, 0.2)
textured = mat('Textured', (1, 1, 1, 1), 0.0, 0.5, img)

# --- cube with two materials, child sphere
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
cube = bpy.context.object
cube.name = 'Cube'
cube.data.materials.append(red)
cube.data.materials.append(blue)
for i, p in enumerate(cube.data.polygons):
    p.material_index = 1 if i % 2 else 0
cube.location = (0, 0, 1)
cube.keyframe_insert('location', frame=1)
cube.location = (0, 3, 1)
cube.keyframe_insert('location', frame=24)

bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=0.5, location=(2, 0, 1))
sph = bpy.context.object
sph.name = 'Sphere'
bpy.ops.object.shade_smooth()
sph.parent = cube
sph.matrix_parent_inverse = cube.matrix_world.inverted()
sph.rotation_euler = (0.3, 0.2, 0.1)

# --- textured plane (quad, UVs)
bpy.ops.mesh.primitive_plane_add(size=2, location=(-3, 0, 0))
pl = bpy.context.object
pl.name = 'Plane'
pl.data.materials.append(textured)
sk = pl.shape_key_add(name='Basis')
k1 = pl.shape_key_add(name='Lift')
for v in k1.data:
    v.co.z += 0.5
k1.value = 0.0
k1.keyframe_insert('value', frame=1)
k1.value = 1.0
k1.keyframe_insert('value', frame=24)

# --- n-gon object
import bmesh
me = bpy.data.meshes.new('Ngon')
bm = bmesh.new()
vs = [bm.verts.new((math.cos(a) , math.sin(a), 0)) for a in [i * 2 * math.pi / 6 for i in range(6)]]
bm.faces.new(vs)
bm.to_mesh(me)
ng = bpy.data.objects.new('Ngon', me)
scn.collection.objects.link(ng)
ng.location = (0, -3, 0)

# --- armature with skinned mesh
arm = bpy.data.armatures.new('Rig')
ao = bpy.data.objects.new('Rig', arm)
scn.collection.objects.link(ao)
ao.location = (4, 0, 0)
bpy.context.view_layer.objects.active = ao
bpy.ops.object.mode_set(mode='EDIT')
b1 = arm.edit_bones.new('Root'); b1.head = (0, 0, 0); b1.tail = (0, 0, 1)
b2 = arm.edit_bones.new('Mid'); b2.head = (0, 0, 1); b2.tail = (0, 0, 2); b2.parent = b1; b2.use_connect = True
b3 = arm.edit_bones.new('Tip'); b3.head = (0, 0, 2); b3.tail = (0, 0.2, 2.8); b3.parent = b2; b3.use_connect = True
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.3, depth=2.8, location=(4, 0, 1.4))
cyl = bpy.context.object
cyl.name = 'Skinned'
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.loopcut_slice(MESH_OT_loopcut={"number_cuts": 4, "edge_index": 1}) if False else None
bpy.ops.object.mode_set(mode='OBJECT')
cyl.parent = ao
cyl.matrix_parent_inverse = ao.matrix_world.inverted()
mod = cyl.modifiers.new('Armature', 'ARMATURE')
mod.object = ao
for b in ('Root', 'Mid', 'Tip'):
    cyl.vertex_groups.new(name=b)
for v in cyl.data.vertices:
    z = (cyl.matrix_world @ v.co).z
    g = 'Root' if z < 1 else ('Mid' if z < 2 else 'Tip')
    cyl.vertex_groups[g].add([v.index], 1.0, 'REPLACE')
ao.pose.bones['Mid'].rotation_mode = 'QUATERNION'
ao.pose.bones['Mid'].rotation_quaternion = (1, 0, 0, 0)
ao.pose.bones['Mid'].keyframe_insert('rotation_quaternion', frame=1)
ao.pose.bones['Mid'].rotation_quaternion = (0.9238795, 0.3826834, 0, 0)
ao.pose.bones['Mid'].keyframe_insert('rotation_quaternion', frame=24)

# --- lights + camera
for t, e, loc in (('POINT', 500, (0, 0, 5)), ('SUN', 2.5, (0, 0, 8)), ('SPOT', 800, (3, -3, 4))):
    ld = bpy.data.lights.new(t.title(), t)
    ld.energy = e
    ld.color = (1, 0.9, 0.8)
    o = bpy.data.objects.new(t.title(), ld)
    scn.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (0.5, 0.2, 0.3)
cd = bpy.data.cameras.new('Cam')
cd.lens = 35
co = bpy.data.objects.new('Cam', cd)
scn.collection.objects.link(co)
co.location = (7, -7, 5)
co.rotation_euler = (1.1, 0, 0.8)
scn.camera = co

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, 'scene.blend'))

stats = {}
for o in scn.objects:
    d = {'type': o.type, 'parent': o.parent.name if o.parent else None, 'loc': [round(x, 4) for x in o.matrix_world.translation]}
    if o.type == 'MESH':
        d['verts'] = len(o.data.vertices); d['faces'] = len(o.data.polygons); d['mats'] = len(o.data.materials)
    stats[o.name] = d
json.dump(stats, open(os.path.join(out, 'scene_stats.json'), 'w'), indent=1)
bpy.ops.export_scene.gltf(filepath=os.path.join(out, 'scene.glb'), export_format='GLB', export_lights=True, export_cameras=True, export_apply=False)
bpy.ops.export_scene.gltf(filepath=os.path.join(out, 'scene.gltf'), export_format='GLTF_SEPARATE', export_lights=True, export_cameras=True)
bpy.ops.export_scene.fbx(filepath=os.path.join(out, 'scene.fbx'), bake_anim=True, bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False, path_mode='COPY', embed_textures=True)
bpy.ops.wm.obj_export(filepath=os.path.join(out, 'scene.obj'), export_materials=True, path_mode='COPY')
bpy.ops.wm.usd_export(filepath=os.path.join(out, 'scene.usda'), export_animation=True)
bpy.ops.wm.usd_export(filepath=os.path.join(out, 'scene.usdc'), export_animation=True)
bpy.ops.wm.usd_export(filepath=os.path.join(out, 'scene.usdz'), export_animation=True)
bpy.ops.wm.stl_export(filepath=os.path.join(out, 'scene.stl'))
bpy.ops.wm.ply_export(filepath=os.path.join(out, 'scene.ply'))
print('DONE')
