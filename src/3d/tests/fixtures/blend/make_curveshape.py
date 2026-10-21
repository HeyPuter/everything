# Builds bevelled Bézier curves with different fill modes, bevel factors (and mappings), twist modes and
# a taper object for the .blend importer / curve geometry test (tests/unit/r4-model-curveshape.test.ts);
# saves curveshape.blend (copied here as curveshape_zstd.blend) and curveshape.json with each curve's
# evaluated vertex count and bounds.
# Usage: <bpy host> -b --factory-startup --python tests/fixtures/blend/make_curveshape.py -- <outdir>
import bpy, sys, os, json

outdir = sys.argv[sys.argv.index('--') + 1]
os.makedirs(outdir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.curve.primitive_bezier_curve_add(location=(0, 5, 0))
taper = bpy.context.active_object
taper.name = 'Taper'
cases = [
    ('Full', {}),
    ('Back', {'fill_mode': 'BACK'}),
    ('Front', {'fill_mode': 'FRONT'}),
    ('Half', {'fill_mode': 'HALF'}),
    ('FacRes', {'bevel_factor_start': 0.2, 'bevel_factor_end': 0.7}),
    ('FacSpline', {'bevel_factor_start': 0.2, 'bevel_factor_end': 0.7, 'bevel_factor_mapping_start': 'SPLINE', 'bevel_factor_mapping_end': 'SPLINE'}),
    ('FacSeg', {'bevel_factor_start': 0.1, 'bevel_factor_end': 0.6, 'bevel_factor_mapping_start': 'SEGMENTS', 'bevel_factor_mapping_end': 'SEGMENTS'}),
    ('TaperOverride', {'taper_object': 'T', 'taper_radius_mode': 'OVERRIDE'}),
    ('TaperAdd', {'taper_object': 'T', 'taper_radius_mode': 'ADD'}),
]
out = {}
for i, (name, props) in enumerate(cases):
    bpy.ops.curve.primitive_bezier_curve_add(location=(0, i * 0.0, 0))
    ob = bpy.context.active_object
    ob.name = name
    cu = ob.data
    cu.bevel_depth = 0.2
    cu.bevel_resolution = 2
    cu.splines[0].bezier_points[1].radius = 1.5
    for k, v in props.items():
        setattr(cu, k, taper if v == 'T' else v)
    dg = bpy.context.evaluated_depsgraph_get()
    me = ob.evaluated_get(dg).to_mesh()
    co = [v.co for v in me.vertices]
    out[name] = {'nv': len(co), 'nf': len(me.polygons), 'min': [round(min(c[k] for c in co), 4) for k in range(3)], 'max': [round(max(c[k] for c in co), 4) for k in range(3)]}
    ob.evaluated_get(dg).to_mesh_clear()
json.dump(out, open(os.path.join(outdir, 'curveshape.json'), 'w'), indent=0)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'curveshape.blend'), compress=True)
