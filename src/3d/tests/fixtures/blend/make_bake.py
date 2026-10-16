# Builds a scene with non-default texture baking settings for the .blend importer test
# (tests/unit/bake.test.ts) and saves it as bake.blend (copied here as bake_zstd.blend).
# Usage: <bpy host> -b --factory-startup --python tests/fixtures/blend/make_bake.py -- <outdir>
import bpy, sys, os

outdir = sys.argv[sys.argv.index('--') + 1]
os.makedirs(outdir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
cage = bpy.data.objects.new('Cage', None)
sc.collection.objects.link(cage)
b = sc.render.bake
b.margin = 7
b.margin_type = 'EXTEND'
b.normal_space = 'OBJECT'
b.normal_r, b.normal_g, b.normal_b = 'NEG_X', 'NEG_Y', 'POS_Y'
b.use_selected_to_active = True
b.use_cage = True
b.cage_object = cage
b.use_clear = False
b.cage_extrusion = 0.25
b.max_ray_distance = 0.5
b.target = 'VERTEX_COLORS'
b.use_pass_direct = False
b.use_pass_color = False
b.type = 'DISPLACEMENT'
sc.cycles.bake_type = 'AO'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'bake.blend'), compress=True)
