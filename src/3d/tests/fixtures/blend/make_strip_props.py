# Probe file for deriving how Video Sequencer strip settings are stored in DNA: for every strip
# type that needs no media file, one untouched strip and one strip per changed property (each enum
# item, both boolean states, a distinctive number, string or colour), including the transform and
# crop settings, plus <out>.json describing them. Diffing them with this package's reader
# (tests/unit/r4-io-modprops.gen.test.ts) produced the strip rules in src/io/blend/modprops.gen.ts.
# Usage: <bpy host> -b --factory-startup --python make_strip_props.py -- <out.blend>
import bpy, sys, json

out = sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.name = 'Probe'
other = bpy.data.scenes.new('Other')
ed = sc.sequence_editor_create()
records = {}
count = 0
frame = 1
SKIP = {'name', 'rna_type', 'type', 'select', 'select_left_handle', 'select_right_handle', 'frame_start', 'frame_final_start', 'frame_final_end', 'frame_final_duration', 'frame_duration', 'channel', 'show_expanded', 'is_active', 'input_1', 'input_2', 'scene', 'scene_camera', 'mask', 'clip', 'sound', 'font', 'strips', 'modifiers', 'elements', 'proxy', 'colorspace_settings', 'stereo_3d_format', 'retiming_keys', 'connected_strips', 'parent_meta', 'input_count', 'text_ptr', 'selection_range', 'cursor_offset', 'active_modifier'}

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
    if p.type == 'STRING':
        return [f'S{i}x']
    return []

def ok(owner, attr, v):
    try:
        setattr(owner, attr, v)
        got = getattr(owner, attr)
        return got == v or (isinstance(v, float) and abs(got - v) < 1e-4) or (isinstance(v, tuple) and all(abs(a - b) < 1e-4 for a, b in zip(got, v)))
    except Exception:
        return False

def make(kind, name):
    """A new strip of a type (effects get colour strips as inputs)."""
    global frame
    f = frame
    frame += 20
    if kind == 'COLOR':
        return ed.strips.new_effect(name, 'COLOR', 1, f, length=10)
    if kind == 'TEXT':
        return ed.strips.new_effect(name, 'TEXT', 1, f, length=10)
    if kind == 'ADJUSTMENT':
        return ed.strips.new_effect(name, 'ADJUSTMENT', 1, f, length=10)
    if kind == 'SCENE':
        return ed.strips.new_scene(name, other, 1, f)
    a = ed.strips.new_effect(name + '_a', 'COLOR', 2, f, length=10)
    if kind in ('GAUSSIAN_BLUR', 'GLOW', 'SPEED', 'MULTICAM', 'TRANSFORM'):
        return ed.strips.new_effect(name, kind, 1, f, length=10, input1=a)
    b = ed.strips.new_effect(name + '_b', 'COLOR', 3, f, length=10)
    return ed.strips.new_effect(name, kind, 1, f, length=10, input1=a, input2=b)

def rec(kind, prop, ptype, value):
    global count
    count += 1
    name = f'S{count}'
    records[name] = {'kind': 'STRIP', 'rna': kind, 'prop': prop, 'type': ptype, 'value': list(value) if isinstance(value, tuple) else value, 'default': None}
    return name

KINDS = ['COLOR', 'TEXT', 'ADJUSTMENT', 'SCENE', 'CROSS', 'ADD', 'SUBTRACT', 'MULTIPLY', 'ALPHA_OVER', 'ALPHA_UNDER', 'GAMMA_CROSS', 'COLORMIX', 'WIPE', 'GLOW', 'SPEED', 'MULTICAM', 'GAUSSIAN_BLUR']
for kind in KINDS:
    try:
        probe = make(kind, 'probe')
    except Exception as e:
        print('skip', kind, e)
        continue
    props = [(probe, p.identifier, p) for p in probe.bl_rna.properties if p.identifier not in SKIP and not p.is_readonly and p.type not in ('POINTER', 'COLLECTION')]
    nested = []
    for sub in ('transform', 'crop'):
        o = getattr(probe, sub, None)
        if o is not None:
            nested += [(sub, p.identifier, p) for p in o.bl_rna.properties if p.identifier not in SKIP and not p.is_readonly and p.type not in ('POINTER', 'COLLECTION')]
    probe_vals = {}
    for i, (owner, ident, p) in enumerate(props):
        probe_vals[ident] = values(owner, p, i)
    for i, (sub, ident, p) in enumerate(nested):
        probe_vals[f'{sub}.{ident}'] = values(getattr(probe, sub), p, i + 50)
    make(kind, rec(kind, None, None, None))
    for key, vals in probe_vals.items():
        ptype = None
        if '.' in key:
            sub, ident = key.split('.')
            p = next(x for s, i2, x in nested if s == sub and i2 == ident)
        else:
            sub, ident = None, key
            p = next(x for o2, i2, x in props if i2 == ident)
        ptype = p.type + ('_ARRAY' if p.type == 'FLOAT' and p.array_length else '')
        for v in vals:
            name = f'S{count + 1}'
            s = make(kind, name)
            owner = getattr(s, sub) if sub else s
            if ok(owner, ident, v):
                rec(kind, key, ptype, v)
            else:
                ed.strips.remove(s)

with open(out + '.json', 'w') as f:
    json.dump(records, f)
bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
print('records', count)
