# Builds a cube with generic attributes on every domain (and edge / vertex weights) for the .blend
# importer test (tests/unit/r4-model-attributes.test.ts); saves attributes.blend (copied here as
# attributes_zstd.blend) and attributes.json with the values per element.
# Usage: <bpy host> -b --factory-startup --python tests/fixtures/blend/make_attributes.py -- <outdir>
import bpy, sys, os, json

outdir = sys.argv[sys.argv.index('--') + 1]
os.makedirs(outdir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
ob = bpy.context.active_object
me = ob.data
out = {'edges': [list(e.vertices) for e in me.edges]}
specs = [('heat', 'POINT', 'FLOAT', lambda i: [i * 0.5]), ('flag', 'FACE', 'BOOLEAN', lambda i: [i % 2 == 0]), ('tag', 'EDGE', 'INT', lambda i: [i * 3]), ('dir', 'CORNER', 'FLOAT2', lambda i: [i * 0.1, -i]), ('vec', 'POINT', 'FLOAT_VECTOR', lambda i: [i, i * 2, i * 3])]
for name, dom, typ, fn in specs:
    a = me.attributes.new(name, typ, dom)
    vals = []
    for i, d in enumerate(a.data):
        v = fn(i)
        if typ == 'FLOAT2' or typ == 'FLOAT_VECTOR': d.vector = v
        else: d.value = v[0]
        vals.append([float(x) for x in v])
    out[name] = {'domain': dom, 'type': typ, 'values': vals}
bw = me.attributes.new('bevel_weight_edge', 'FLOAT', 'EDGE')
bw.data[2].value = 0.75
cv = me.attributes.new('crease_vert', 'FLOAT', 'POINT')
cv.data[5].value = 0.5
json.dump(out, open(os.path.join(outdir, 'attributes.json'), 'w'), separators=(',', ':'))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'attributes.blend'), compress=True)
