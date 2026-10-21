# Builds NURBS surfaces (a sphere with edited points and a patch with changed orders / flags) for the
# .blend importer test (tests/unit/r4-model-surface-blend.test.ts); saves surface.blend (copied here as
# surface_zstd.blend) and surface.json with each object's evaluated vertex positions.
# Usage: <bpy host> -b --factory-startup --python tests/fixtures/blend/make_surface.py -- <outdir>
import bpy, sys, os, json

outdir = sys.argv[sys.argv.index('--') + 1]
os.makedirs(outdir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.surface.primitive_nurbs_surface_sphere_add(radius=2, location=(0, 0, 0))
sph = bpy.context.active_object
sph.name = 'Sphere'
sph.data.splines[0].points[7].co = (-1.5, -2.5, 0.3, 0.6)
bpy.ops.surface.primitive_nurbs_surface_surface_add(location=(4, 0, 0))
pat = bpy.context.active_object
pat.name = 'Patch'
s = pat.data.splines[0]
s.order_u = 3
s.use_endpoint_v = True
s.resolution_u = 3
pat.data.resolution_v = 5
out = {}
dg = bpy.context.evaluated_depsgraph_get()
for ob in (sph, pat):
    me = ob.evaluated_get(dg).to_mesh()
    out[ob.name] = {'nv': len(me.vertices), 'nf': len(me.polygons), 'co': [[round(c, 5) for c in v.co] for v in me.vertices][::7]}
    ob.evaluated_get(dg).to_mesh_clear()
json.dump(out, open(os.path.join(outdir, 'surface.json'), 'w'), separators=(',', ':'))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'surface.blend'), compress=True)
