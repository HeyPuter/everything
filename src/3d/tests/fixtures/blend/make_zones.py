# Builds a scene with geometry node zones (repeat, simulation, for-each element and a bake node)
# for the .blend importer tests (tests/unit/gn-zones-blend.test.ts) and saves it as zones.blend (copied here as zones_zstd.blend).
# Usage: <bpy host> -b --factory-startup --python tests/fixtures/blend/make_zones.py -- <outdir>
import bpy, sys, os

outdir = sys.argv[sys.argv.index('--') + 1]
os.makedirs(outdir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)

me = bpy.data.meshes.new('Base')
me.from_pydata([(0, 0, 0)], [], [])
ob = bpy.data.objects.new('Zoned', me)
bpy.context.scene.collection.objects.link(ob)

ng = bpy.data.node_groups.new('Zones', 'GeometryNodeTree')
ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
vec = ng.interface.new_socket('Offset', in_out='INPUT', socket_type='NodeSocketVector')
num = ng.interface.new_socket('Scale', in_out='INPUT', socket_type='NodeSocketFloat')
gi = ng.nodes.new('NodeGroupInput')
go = ng.nodes.new('NodeGroupOutput')
L = ng.links.new

# repeat: three steps of +1 on z and an accumulated value
ri = ng.nodes.new('GeometryNodeRepeatInput')
ro = ng.nodes.new('GeometryNodeRepeatOutput')
ri.pair_with_output(ro)
ro.repeat_items.new('FLOAT', 'Total')
ri.inputs['Iterations'].default_value = 3
ri.inputs['Total'].default_value = 1.5
sp = ng.nodes.new('GeometryNodeSetPosition')
sp.inputs['Offset'].default_value = (0, 0, 1)
add = ng.nodes.new('ShaderNodeMath')
add.inputs[1].default_value = 2
L(gi.outputs[0], ri.inputs['Geometry'])
L(ri.outputs['Geometry'], sp.inputs['Geometry'])
L(sp.outputs['Geometry'], ro.inputs['Geometry'])
L(ri.outputs['Total'], add.inputs[0])
L(add.outputs[0], ro.inputs['Total'])

# for each point: a main value from the index
fi = ng.nodes.new('GeometryNodeForeachGeometryElementInput')
fo = ng.nodes.new('GeometryNodeForeachGeometryElementOutput')
fi.pair_with_output(fo)
fo.domain = 'POINT'
fo.input_items.new('FLOAT', 'Weight')
fo.main_items.new('INT', 'Twice')
mul = ng.nodes.new('ShaderNodeMath')
mul.operation = 'MULTIPLY'
mul.inputs[1].default_value = 2
L(ro.outputs['Geometry'], fi.inputs['Geometry'])
L(fi.outputs['Index'], mul.inputs[0])
L(mul.outputs[0], fo.inputs['Twice'])

# simulation and bake nodes (paired / with items)
si = ng.nodes.new('GeometryNodeSimulationInput')
so = ng.nodes.new('GeometryNodeSimulationOutput')
si.pair_with_output(so)
so.state_items.new('VECTOR', 'Velocity')
bk = ng.nodes.new('GeometryNodeBake')
bk.bake_items.new('GEOMETRY', 'Geometry')
L(fo.outputs['Geometry'], bk.inputs['Geometry'])
L(bk.outputs['Geometry'], go.inputs[0])

# settings stored in node fields and menu sockets (not connected)
mbd = ng.nodes.new('GeometryNodeMergeByDistance')
mbd.inputs['Mode'].default_value = 'Connected'
boo = ng.nodes.new('GeometryNodeMeshBoolean')
boo.operation = 'UNION'
boo.solver = 'EXACT'
line = ng.nodes.new('GeometryNodeMeshLine')
line.mode = 'END_POINTS'

mod = ob.modifiers.new('GN', 'NODES')
mod.node_group = ng
getattr(mod.properties.inputs, vec.identifier).value = (1.0, 2.0, 3.0)
getattr(mod.properties.inputs, num.identifier).value = 0.5
print('IDS', vec.identifier, num.identifier)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(outdir, 'zones.blend'), compress=True)
dg = bpy.context.evaluated_depsgraph_get()
e = ob.evaluated_get(dg).data
print('RESULT', [tuple(round(c, 4) for c in v.co) for v in e.vertices])
