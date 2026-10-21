# Probe file for deriving how Grease Pencil layer and material settings are stored in DNA: one
# layer / material per changed property (each enum item, both boolean states, a distinctive
# number), plus untouched ones, and <out>.json describing them. Diffing them with this package's
# reader (tests/unit/r4-io-modprops.gen.test.ts) produced their rules in src/io/blend/modprops.gen.ts.
# Usage: <bpy host> -b --factory-startup --python make_gp_props.py -- <out.blend>
import bpy, sys, json

out = sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
records = {}
count = 0
SKIP = {'name', 'rna_type', 'info', 'is_ruler', 'frames', 'mask_layers', 'parent', 'parent_bone', 'matrix_local', 'matrix_parent_inverse', 'channel_color', 'is_grease_pencil', 'stroke_image', 'fill_image', 'pixel_size', 'is_stroke_visible', 'is_fill_visible'}

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
        return [tuple(round(0.11 * (k + 1) + 0.013 * i, 4) for k in range(p.array_length))]
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
    name = f'G{count}'
    records[name] = {'kind': kind, 'rna': rna, 'prop': prop, 'type': ptype, 'value': list(value) if isinstance(value, tuple) else value, 'default': None}
    return name

# ---- layers
gp = bpy.data.grease_pencils.new('Probe')
gp.use_fake_user = True
probe = gp.layers.new('probe')
props = [p for p in probe.bl_rna.properties if p.identifier not in SKIP and not p.is_readonly and p.type not in ('POINTER', 'COLLECTION')]
gp.layers.remove(probe)
gp.layers.new(rec('GPLAYER', 'GreasePencilLayer', None, None, None))
for i, p in enumerate(props):
    t = gp.layers.new('t')
    vals = values(t, p, i)
    gp.layers.remove(t)
    for v in vals:
        layer = gp.layers.new(f'G{count + 1}')
        if ok(layer, p, v):
            rec('GPLAYER', 'GreasePencilLayer', p.identifier, p.type + ('_ARRAY' if p.type == 'FLOAT' and p.array_length else ''), v)
        else:
            gp.layers.remove(layer)

# ---- materials
def gpmat(name):
    m = bpy.data.materials.new(name)
    bpy.data.materials.create_gpencil_data(m)
    m.use_fake_user = True
    return m
probe = gpmat('probe').grease_pencil
props = [p for p in probe.bl_rna.properties if p.identifier not in SKIP and not p.is_readonly and p.type not in ('POINTER', 'COLLECTION')]
gpmat(rec('GPMAT', 'MaterialGPencilStyle', None, None, None))
for i, p in enumerate(props):
    vals = values(probe, p, i)
    for v in vals:
        m = gpmat(f'G{count + 1}')
        if ok(m.grease_pencil, p, v):
            rec('GPMAT', 'MaterialGPencilStyle', p.identifier, p.type + ('_ARRAY' if p.type == 'FLOAT' and p.array_length else ''), v)
        else:
            bpy.data.materials.remove(m)

with open(out + '.json', 'w') as f:
    json.dump(records, f)
bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
print('records', count)
