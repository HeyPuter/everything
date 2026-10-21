# Builds a plane with absolute shape keys (non-uniform frames, B-spline interpolation, an evaluation
# time) for the .blend importer test (tests/unit/r4-model-shapekeys.test.ts); saves shapekeys.blend
# (copied here as shapekeys_zstd.blend) and shapekeys.json with the evaluated heights.
# Usage: <bpy host> -b --factory-startup --python tests/fixtures/blend/make_shapekeys.py -- <outdir>
import bpy, sys, os, json

outdir = sys.argv[sys.argv.index('--') + 1]
os.makedirs(outdir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_plane_add()
ob = bpy.context.active_object
ob.shape_key_add(name='Basis')
for i in range(1, 4):
    k = ob.shape_key_add(name='K%d' % i)
    for v in k.data:
        v.co.z = i * 1.0 + (0.5 if i == 2 else 0)
key = ob.data.shape_keys
key.use_relative = False
for k in key.key_blocks:
    k.interpolation = 'KEY_BSPLINE'
key.key_blocks['K3'].interpolation = 'KEY_LINEAR'
key.eval_time = 17
out = {'frames': [k.frame for k in key.key_blocks], 'eval_time': key.eval_time, 'z': {}}
for t in (0, 4, 12, 17, 25, 33):
    key.eval_time = t
    dg = bpy.context.evaluated_depsgraph_get()
    e = ob.evaluated_get(dg).to_mesh()
    out['z'][str(t)] = round(e.vertices[0].co.z, 5)
    ob.evaluated_get(dg).to_mesh_clear()
key.eval_time = 17
json.dump(out, open(os.path.join(outdir, 'shapekeys.json'), 'w'))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'shapekeys.blend'), compress=True)
