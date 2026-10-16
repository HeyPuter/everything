# Builds an object with custom properties of each simple kind (and one group, which is not
# imported) for the .blend importer test (tests/unit/wm_context.test.ts) and saves it as
# idprops.blend (copied here as idprops_zstd.blend).
# Usage: <bpy host> -b --factory-startup --python tests/fixtures/blend/make_idprops.py -- <outdir>
import bpy, sys, os

outdir = sys.argv[sys.argv.index('--') + 1]
os.makedirs(outdir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
ob = bpy.data.objects.new('Holder', None)
sc.collection.objects.link(ob)
ob['weight'] = 0.25
ob['count'] = 7
ob['flag'] = True
ob['label'] = 'hello'
ob['vec'] = (1.0, 2.0, 3.0)
ob['ints'] = [4, 5]
ob['group'] = {'a': 1}
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'idprops.blend'), compress=True)
