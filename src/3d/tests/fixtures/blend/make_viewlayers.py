# Builds a scene with two view layers (the second excludes "Props" and is not rendered), light
# groups and light / shadow linking for the .blend importer tests (tests/unit/scenes_blend.test.ts)
# and saves it as viewlayers.blend (copied here as viewlayers_zstd.blend).
# Usage: <bpy host> -b --factory-startup --python tests/fixtures/blend/make_viewlayers.py -- <outdir>
import bpy, sys, os

outdir = sys.argv[sys.argv.index('--') + 1]
os.makedirs(outdir, exist_ok=True)
sc = bpy.context.scene
props = bpy.data.collections.new('Props')
sc.collection.children.link(props)
bpy.ops.mesh.primitive_uv_sphere_add(location=(3, 0, 0))
sphere = bpy.context.active_object
for c in sphere.users_collection:
    c.objects.unlink(sphere)
props.objects.link(sphere)
light = bpy.data.objects['Light']
cube = bpy.data.objects['Cube']
light.lightgroup = 'key'
sc.world.lightgroup = 'sky'
vl0 = sc.view_layers[0]
vl0.lightgroups.add(name='key')
vl0.layer_collection.children['Props'].holdout = True
vl1 = sc.view_layers.new('Background')
vl1.use = False
vl1.layer_collection.children['Props'].exclude = True
# light linking: the light skips the cube; only the sphere shadows it
recv = bpy.data.collections.new('Light Linking for Light')
recv.objects.link(cube)
light.light_linking.receiver_collection = recv
recv.collection_objects[0].light_linking.link_state = 'EXCLUDE'
block = bpy.data.collections.new('Shadow Linking for Light')
block.objects.link(sphere)
light.light_linking.blocker_collection = block
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'viewlayers.blend'), compress=True)
