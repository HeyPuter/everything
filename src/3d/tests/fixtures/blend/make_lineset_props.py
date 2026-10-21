# Probe file for deriving how line rendering settings are stored in DNA: one line set / line style /
# view layer per changed property (each enum item, both boolean states, a distinctive number), plus
# untouched ones, and <out>.json describing them. Diffing them with this package's reader
# (tests/unit/r4-io-modprops.gen.test.ts) produced the line rendering rules of src/io/blend/modprops.gen.ts.
# Usage: <bpy host> -b --factory-startup --python make_lineset_props.py -- <out.blend>
import bpy, sys, json

out = sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.use_freestyle = True
records = {}
count = 0
SKIP = {'name', 'rna_type', 'show_expanded', 'use_fake_user', 'use_extra_user', 'is_evaluated', 'is_embedded_data', 'tag', 'is_runtime_data', 'is_missing', 'library_weak_reference', 'asset_data', 'override_library', 'preview', 'is_editmode', 'users', 'session_uid', 'name_full', 'is_library_indirect', 'library', 'original', 'texture_spacing', 'active_texture', 'active_texture_index', 'node_tree', 'use_nodes', 'panel', 'linestyle', 'collection', 'texture_slots', 'id_type', 'use_texture', 'texture'}

def values(owner, p, i):
    if p.type == 'ENUM' and not p.is_enum_flag:
        return [it.identifier for it in p.enum_items]
    if p.type == 'BOOLEAN' and p.array_length == 0:
        return [False, True]
    if p.type in ('INT', 'FLOAT') and p.array_length == 0:
        lo, hi = p.soft_min, p.soft_max
        if p.type == 'INT':
            v = int(min(max(lo, 3 + (i % 5)), hi)) if hi > lo else int(lo)
            if v == getattr(owner, p.identifier):
                v = int(min(max(lo, v + 1), hi))
            return [v]
        v = lo + (hi - lo) * (0.37 + 0.01 * (i % 7)) if hi > lo else lo
        if abs(hi - lo) > 1000:
            v = 0.123 + i * 0.01
        return [round(v, 4)]
    if p.type == 'FLOAT' and p.array_length in (2, 3, 4):
        return [tuple(0.11 * (k + 1) + 0.013 * i for k in range(p.array_length))]
    return []

def ok(owner, p, v):
    try:
        setattr(owner, p.identifier, v)
        got = getattr(owner, p.identifier)
        return got == v or (isinstance(v, float) and abs(got - v) < 1e-4) or (isinstance(v, tuple) and all(abs(a - b) < 1e-4 for a, b in zip(got, v)))
    except Exception:
        return False

def rec(kind, rna, prop, ptype, value):
    global count
    count += 1
    name = f'P{count}'
    records[name] = {'kind': kind, 'rna': rna, 'prop': prop, 'type': ptype, 'value': list(value) if isinstance(value, tuple) else value, 'default': None}
    return name

vl = bpy.context.view_layer
fs = vl.freestyle_settings
# ---- line sets (in the first view layer)
probe = fs.linesets.new('probe')
props = [p for p in probe.bl_rna.properties if p.identifier not in SKIP and not p.is_readonly]
fs.linesets.remove(probe)
probe_vals = {}
for i, p in enumerate(props):
    t = fs.linesets.new('t')
    probe_vals[p.identifier] = values(t, p, i)
    fs.linesets.remove(t)
base = fs.linesets.new(rec('LINESET', 'FreestyleLineSet', None, None, None))
for i, p in enumerate(props):
    for v in probe_vals[p.identifier]:
        name = f'P{count + 1}'
        ls = fs.linesets.new(name)
        if ok(ls, p, v):
            rec('LINESET', 'FreestyleLineSet', p.identifier, p.type + ('_ARRAY' if p.type == 'FLOAT' and p.array_length else ''), v)
        else:
            fs.linesets.remove(ls)

# ---- line styles
probe = bpy.data.linestyles.new('probe')
props = [p for p in probe.bl_rna.properties if p.identifier not in SKIP and not p.is_readonly and p.type != 'POINTER' and p.type != 'COLLECTION']
bpy.data.linestyles.remove(probe)
bpy.data.linestyles.new(rec('LINESTYLE', 'FreestyleLineStyle', None, None, None)).use_fake_user = True
for i, p in enumerate(props):
    t = bpy.data.linestyles.new('t')
    vals = values(t, p, i)
    bpy.data.linestyles.remove(t)
    for v in vals:
        name = f'P{count + 1}'
        st = bpy.data.linestyles.new(name)
        st.use_fake_user = True  # unused data-blocks are not saved otherwise
        if ok(st, p, v):
            rec('LINESTYLE', 'FreestyleLineStyle', p.identifier, p.type + ('_ARRAY' if p.type == 'FLOAT' and p.array_length else ''), v)
        else:
            bpy.data.linestyles.remove(st)

# ---- view layer settings (one view layer per value)
props = [p for p in fs.bl_rna.properties if p.identifier not in SKIP and not p.is_readonly and p.type not in ('POINTER', 'COLLECTION')]
sc.view_layers.new(rec('FREESTYLE', 'FreestyleSettings', None, None, None))
for i, p in enumerate(props):
    vals = values(fs, p, i)
    for v in vals:
        name = f'P{count + 1}'
        layer = sc.view_layers.new(name)
        if ok(layer.freestyle_settings, p, v):
            rec('FREESTYLE', 'FreestyleSettings', p.identifier, p.type, v)
        else:
            sc.view_layers.remove(layer)
for p in [x for x in vl.bl_rna.properties if x.identifier in ('use_freestyle',)]:
    for v in (False, True):
        name = f'P{count + 1}'
        layer = sc.view_layers.new(name)
        if ok(layer, p, v):
            rec('VIEWLAYER', 'ViewLayer', p.identifier, 'BOOLEAN', v)
sc.view_layers.new(rec('VIEWLAYER', 'ViewLayer', None, None, None))

with open(out + '.json', 'w') as f:
    json.dump(records, f)
bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
print('records', count)
