# Probe file for deriving how shader-node enum/boolean settings are stored in DNA: one node
# per enum item / boolean state, plus <out>.json describing each node. Reading it back with
# src/io/blend/reader.ts and diffing the node fields produced src/io/blend/nodeprops.gen.ts.
# Usage: <bpy host> -b --factory-startup --python make_node_enums.py -- <out.blend>
import bpy, sys, json
out = sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
mat = bpy.data.materials.new('Enums')
nt = mat.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)
records = {}
idnames = sorted(n for n in dir(bpy.types) if n.startswith('ShaderNode'))
skip_props = {'bl_idname', 'type', 'location', 'width', 'height', 'name', 'label', 'select', 'show_options', 'show_preview', 'hide', 'mute', 'show_texture', 'bl_static_type', 'bl_icon', 'bl_label', 'bl_description', 'warning_propagation', 'color_tag', 'location_absolute', 'bl_width_default', 'bl_width_min', 'bl_width_max', 'bl_height_default', 'bl_height_min', 'bl_height_max', 'use_custom_color', 'color', 'internal_links', 'is_active_output'}
count = 0
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
                props.append((p.identifier, 'ENUM', items, getattr(probe, p.identifier)))
        elif p.type == 'BOOLEAN' and not getattr(p, 'is_array', False) and p.array_length == 0:
            props.append((p.identifier, 'BOOLEAN', [False, True], getattr(probe, p.identifier)))
    nt.nodes.remove(probe)
    for pid, ptype, items, default in props:
        for v in items:
            try:
                n = nt.nodes.new(idn)
                setattr(n, pid, v)
                if getattr(n, pid) != v:
                    nt.nodes.remove(n)
                    continue
            except Exception:
                try:
                    nt.nodes.remove(n)
                except Exception:
                    pass
                continue
            count += 1
            n.name = f'N{count}'
            records[n.name] = {'idname': idn, 'prop': pid, 'type': ptype, 'value': v, 'default': default}
    # one default node per type
    n = nt.nodes.new(idn)
    count += 1
    n.name = f'N{count}'
    records[n.name] = {'idname': idn, 'prop': None, 'type': None, 'value': None, 'default': None}
with open(out + '.json', 'w') as f:
    json.dump(records, f)
bpy.data.libraries.write(out, {mat}, compress=True)
print('nodes', count)
