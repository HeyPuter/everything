# Probe file for deriving how geometry / function node enum and boolean settings are stored in
# DNA: one node per enum item / boolean state (and per menu socket item), plus <out>.json
# describing each node. Reading it back with src/io/blend/reader.ts and diffing the node fields
# produced src/io/blend/nodeprops_geo.gen.ts.
# Usage: <bpy host> -b --factory-startup --python make_gn_enums.py -- <out.blend>
import bpy, sys, json
out = sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
nt = bpy.data.node_groups.new('Enums', 'GeometryNodeTree')
nt.use_fake_user = True
records = {}
idnames = sorted(n for n in dir(bpy.types) if n.startswith('GeometryNode') or n.startswith('FunctionNode'))
skip_props = {'bl_idname', 'type', 'location', 'width', 'height', 'name', 'label', 'select', 'show_options', 'show_preview', 'hide', 'mute', 'show_texture', 'bl_static_type', 'bl_icon', 'bl_label', 'bl_description', 'warning_propagation', 'color_tag', 'location_absolute', 'bl_width_default', 'bl_width_min', 'bl_width_max', 'bl_height_default', 'bl_height_min', 'bl_height_max', 'use_custom_color', 'color', 'internal_links', 'is_active_output'}
count = 0
def add(idn, rec, setup):
    global count
    try:
        n = nt.nodes.new(idn)
        if not setup(n):
            nt.nodes.remove(n)
            return
    except Exception:
        return
    count += 1
    n.name = f'N{count}'
    records[n.name] = dict(idname=idn, **rec)
for idn in idnames:
    try:
        probe = nt.nodes.new(idn)
    except Exception:
        continue
    props = []
    for p in probe.bl_rna.properties:
        if p.identifier in skip_props or p.is_readonly:
            continue
        if p.type == 'ENUM' and not p.is_enum_flag:
            items = [i.identifier for i in p.enum_items]
            if 1 < len(items) <= 64:
                props.append((p.identifier, 'ENUM', items))
        elif p.type == 'BOOLEAN' and p.array_length == 0:
            props.append((p.identifier, 'BOOLEAN', [False, True]))
    menus = []
    for s in probe.inputs:
        if s.type == 'MENU':
            try:
                s.default_value = 'zzz'
            except Exception as e:
                msg = str(e)
                if '(' in msg:
                    items = [x.strip().strip("'") for x in msg[msg.rindex('(') + 1:msg.rindex(')')].split(',') if x.strip()]
                    menus.append((s.identifier, items))
    nt.nodes.remove(probe)
    for pid, ptype, items in props:
        for v in items:
            def setup(n, pid=pid, v=v):
                setattr(n, pid, v)
                return getattr(n, pid) == v
            add(idn, {'prop': pid, 'type': ptype, 'value': v}, setup)
    for sid, items in menus:
        for v in items:
            def setup(n, sid=sid, v=v):
                s = [x for x in n.inputs if x.identifier == sid][0]
                s.default_value = v
                return s.default_value == v
            add(idn, {'prop': sid, 'type': 'MENU', 'value': v}, setup)
    add(idn, {'prop': None, 'type': None, 'value': None}, lambda n: True)
with open(out + '.json', 'w') as f:
    json.dump(records, f)
bpy.data.libraries.write(out, {nt}, compress=True)
print('nodes', count)
