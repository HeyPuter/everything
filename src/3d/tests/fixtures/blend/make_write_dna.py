# Probe file for the .blend writer: one freshly created data-block of every kind the writer stores
# (with the values a new data-block gets), saved uncompressed by a 4.2 LTS host. Reading it back
# with tests/unit/blend-write-dna.gen.test.ts produces src/io/blend/write/dna.gen.ts: the struct
# layouts (names and types of the fields) and the non-zero default values the writer starts from.
# Usage: <bpy 4.2 host> -b --factory-startup --python make_write_dna.py -- <out.blend>
import bpy, sys

out = sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.name = 'PROBE_Scene'

col = bpy.data.collections.new('PROBE_Collection')
sc.collection.children.link(col)

me = bpy.data.meshes.new('PROBE_Mesh')
me.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
me.uv_layers.new(name='UVMap')
me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
me.attributes.new('weight', 'FLOAT', 'POINT')
ob_mesh = bpy.data.objects.new('PROBE_MeshObject', me)
ob_mesh.vertex_groups.new(name='Group').add([0, 1], 0.5, 'REPLACE')
ob_empty = bpy.data.objects.new('PROBE_Empty', None)
ob_cam = bpy.data.objects.new('PROBE_CameraObject', bpy.data.cameras.new('PROBE_Camera'))
ob_light = bpy.data.objects.new('PROBE_LightObject', bpy.data.lights.new('PROBE_Light', 'POINT'))
for ob in (ob_mesh, ob_empty, ob_cam, ob_light):
    col.objects.link(ob)
ob_empty.parent = ob_mesh
sc.camera = ob_cam

import os, tempfile
gen = bpy.data.images.new('PROBE_Generated', 4, 4)
png = os.path.join(tempfile.mkdtemp(), 'probe.png')
gen.filepath_raw = png
gen.file_format = 'PNG'
gen.save()
img = bpy.data.images.load(png)
img.name = 'PROBE_Image'
img.pack()
bpy.data.images.remove(gen)

mat = bpy.data.materials.new('PROBE_Material')
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes['Principled BSDF']
tex = nt.nodes.new('ShaderNodeTexImage')
tex.image = img
nmap = nt.nodes.new('ShaderNodeNormalMap')
nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
nt.links.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])
me.materials.append(mat)

world = bpy.data.worlds.new('PROBE_World')
world.use_nodes = True
sc.world = world

ob_empty.location = (1, 2, 3)
ob_empty.keyframe_insert('location', frame=1, group='Object Transforms')

# every shader node type, as a new node of its kind: its legacy type number, storage struct and
# sockets (identifier, name, socket type) are read back from the file
probe_mat = bpy.data.materials.new('PROBE_ShaderNodes')
probe_mat.use_nodes = True
probe_world = bpy.data.worlds.new('PROBE_WorldNodes')
probe_world.use_nodes = True
trees = [probe_mat.node_tree, probe_world.node_tree]
for t in trees:
    t.nodes.clear()
idnames = sorted({n for n in dir(bpy.types) if n.startswith('ShaderNode') and n not in ('ShaderNodeTree', 'ShaderNodeCustomGroup')} | {'NodeReroute', 'NodeFrame', 'NodeGroupInput', 'NodeGroupOutput'})
for idn in idnames:
    for t in trees:
        try:
            n = t.nodes.new(idn)
        except Exception:
            continue
        n.name = 'PROBE:' + idn
        break
    else:
        print('PROBE_SKIP', idn)
probe_mat.use_fake_user = True
probe_world.use_fake_user = True

bpy.data.libraries.write(out, {sc, probe_mat, probe_world}, compress=False)
