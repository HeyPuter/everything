# Builds a small file with asset-marked data-blocks for tests/unit/assets_blend.test.ts.
# Usage: <bpy host> -b --factory-startup --python tests/fixtures/blend/make_assets.py -- <outdir>
# then copy <outdir>/assets_zstd.blend here.
import bpy, sys, os

argv = sys.argv[sys.argv.index('--') + 1:]
outdir = argv[0]
os.makedirs(outdir, exist_ok=True)

cube = bpy.data.objects['Cube']
cube.asset_mark()
cube.asset_data.description = 'A test box'
cube.asset_data.author = 'Tester'
cube.asset_data.license = 'CC0'
cube.asset_data.copyright = 'none'
cube.asset_data.tags.new('box')
cube.asset_data.tags.new('test')
cube.asset_data.catalog_id = '12345678-1234-4234-8234-123456789abc'

red = bpy.data.materials.new('Lonely Red')
red.diffuse_color = (0.8, 0.05, 0.05, 1)
red.asset_mark()
red.asset_data.description = 'Unused red'

ng = bpy.data.node_groups.new('My GN', 'GeometryNodeTree')
ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
i = ng.nodes.new('NodeGroupInput')
o = ng.nodes.new('NodeGroupOutput')
ng.links.new(i.outputs[0], o.inputs[0])
ng.asset_mark()

w = bpy.data.worlds.new('Asset World')
w.asset_mark()

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'assets_zstd.blend'), compress=True)
