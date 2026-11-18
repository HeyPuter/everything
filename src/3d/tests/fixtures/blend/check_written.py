# Checks .blend files written by this app in a .blend host: opens the file, prints what it holds
# (scene, collections and view layer, objects, meshes with validation, cameras, lights, material
# node trees, worlds) and saves it again. The files come from tests/unit/blend-write.test.ts:
#   BLEND_WRITE_OUT=<dir> npx vitest run tests/unit/blend-write.test.ts
#   <bpy host> -b --factory-startup --python check_written.py -- <dir>/rich.blend
# Checked with 4.2 LTS and 5.2 LTS hosts: every line starts with CHECK, then 'CHECK resaved ok'.
import bpy, sys, functools
print = functools.partial(print, flush=True)
path = sys.argv[sys.argv.index('--')+1]
bpy.ops.wm.open_mainfile(filepath=path)
sc = bpy.context.scene
r = lambda v: tuple(round(x,3) for x in v)
print('CHECK scene', sc.name, sc.frame_start, sc.frame_end, sc.frame_current, sc.render.fps, sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage, sc.render.engine, sc.view_settings.view_transform, sc.render.film_transparent, r(sc.cursor.location), sc.world.name)
vl = bpy.context.view_layer
def lc(l, d=0):
    for c in l.children:
        print('CHECK layer', '  '*d + c.name, 'exclude', c.exclude, 'hide', c.hide_viewport, 'col hide_render', c.collection.hide_render, 'hide_select', c.collection.hide_select, 'tag', c.collection.color_tag, [o.name for o in c.collection.objects])
        lc(c, d+1)
lc(vl.layer_collection)
print('CHECK active', vl.objects.active and vl.objects.active.name)
for ob in sorted(bpy.data.objects, key=lambda o: o.name):
    print('CHECK ob', ob.name, ob.type, r(ob.location), ob.rotation_mode, r(ob.rotation_euler), r(ob.rotation_quaternion), r(ob.scale), r(ob.delta_location), 'parent', ob.parent and ob.parent.name, r(ob.matrix_parent_inverse.translation), 'locks', tuple(ob.lock_location), tuple(ob.lock_scale), 'wire', ob.show_wire, 'front', ob.show_in_front, 'hide_render', ob.hide_render, 'sel', ob.select_get(), 'hidden', ob.hide_get(), 'col', r(ob.color), 'slots', [(s.link, s.material and s.material.name) for s in ob.material_slots], 'empty', ob.empty_display_type, ob.empty_display_size, 'data', ob.data and ob.data.name)
for me in bpy.data.meshes:
    print('CHECK mesh', me.name, len(me.vertices), len(me.edges), len(me.polygons), 'uv', [u.name for u in me.uv_layers], 'active', me.uv_layers.active and me.uv_layers.active.name, 'render', [u.name for u in me.uv_layers if u.active_render], 'smooth', sum(p.use_smooth for p in me.polygons), 'mats', [p.material_index for p in me.polygons], 'colors', [(c.name, c.domain, c.data_type) for c in me.color_attributes], 'active_color', me.color_attributes.active_color_name, 'groups?', 'invalid', me.validate(verbose=True))
    print('CHECK attrs', me.name, sorted((a.name, a.domain, a.data_type) for a in me.attributes if not a.name.startswith('.')))
    if 'crease_edge' in me.attributes: print('CHECK crease', [round(v.value,3) for v in me.attributes['crease_edge'].data if v.value])
    if 'sharp_edge' in me.attributes: print('CHECK sharp', sum(v.value for v in me.attributes['sharp_edge'].data), 'seam', sum(e.use_seam for e in me.edges))
for ob in bpy.data.objects:
    if ob.type == 'MESH' and ob.vertex_groups:
        print('CHECK vgroups', ob.name, [g.name for g in ob.vertex_groups], [[round(g.weight,2) for g in v.groups] for v in ob.data.vertices][:6])
for ca in bpy.data.cameras: print('CHECK camera', ca.name, ca.type, ca.ortho_scale, round(ca.shift_x,3), ca.clip_start, ca.clip_end, ca.dof.use_dof, ca.dof.focus_object and ca.dof.focus_object.name, ca.dof.focus_distance)
for la in bpy.data.lights: print('CHECK light', la.name, la.type, la.energy, r(la.color), getattr(la,'spot_size',None) and round(la.spot_size,3), getattr(la,'shape',None), getattr(la,'size',None), getattr(la,'size_y',None), getattr(la,'angle',None) and round(la.angle,3))
for ma in bpy.data.materials:
    nt = ma.node_tree
    print('CHECK material', ma.name, r(ma.diffuse_color), ma.use_backface_culling, [(n.bl_idname, n.name, n.mute, n.hide, n.parent and n.parent.name) for n in nt.nodes])
    print('CHECK links', ma.name, [(l.from_node.name, l.from_socket.identifier, l.to_node.name, l.to_socket.identifier, l.is_valid, l.is_muted) for l in nt.links])
    for n in nt.nodes:
        if n.bl_idname == 'ShaderNodeMath': print('CHECK math', n.operation, [round(i.default_value,3) for i in n.inputs])
        if n.bl_idname == 'ShaderNodeValToRGB': print('CHECK ramp', n.color_ramp.interpolation, [(round(e.position,3), r(e.color)) for e in n.color_ramp.elements])
        if n.bl_idname == 'ShaderNodeRGBCurve': print('CHECK curves', [[r(p.location) for p in c.points] for c in n.mapping.curves])
        if n.bl_idname == 'ShaderNodeValue': print('CHECK value', round(n.outputs[0].default_value,3))
        if n.bl_idname == 'ShaderNodeTexImage': print('CHECK teximage', n.image and n.image.name, n.image and n.image.packed_file and n.image.packed_file.size, n.image and n.image.colorspace_settings.name, n.image and tuple(n.image.size))
        if n.bl_idname == 'ShaderNodeBsdfPrincipled': print('CHECK bsdf', r(n.inputs['Base Color'].default_value), round(n.inputs['Metallic'].default_value,3), round(n.inputs['Roughness'].default_value,3))
for wo in bpy.data.worlds:
    bgn = [n for n in wo.node_tree.nodes if n.bl_idname == 'ShaderNodeBackground']
    print('CHECK world', wo.name, bgn and r(bgn[0].inputs['Color'].default_value), bgn and bgn[0].inputs['Strength'].default_value)
bpy.ops.wm.save_as_mainfile(filepath=path.replace('.blend','.resaved.blend'), compress=False)
print('CHECK resaved ok')
