# Probe file for deriving how modifier and constraint settings are stored in DNA: one object per
# changed property (each enum item, both boolean states, a distinctive number, string or object
# pointer), plus one untouched object per type, and <out>.json describing every object. Reading
# the file back with src/io/blend/reader.ts and diffing the data structs against the untouched one
# produced src/io/blend/modprops.gen.ts (tests/unit/r4-io-modprops.gen.test.ts, run manually).
# Usage: <bpy host> -b --factory-startup --python make_modifier_props.py -- <out.blend>
import bpy, sys, json

out = sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
records = {}
count = 0

# pointer targets: one per ID type, with distinctive names
targets = {}
def target(kind):
    if kind in targets:
        return targets[kind]
    if kind == 'OBJECT':
        t = bpy.data.objects.new('PTR_Object', None)
    elif kind == 'MESH_OBJECT':
        t = bpy.data.objects.new('PTR_MeshObject', bpy.data.meshes.new('PTR_Mesh'))
    elif kind == 'CURVE_OBJECT':
        cu = bpy.data.curves.new('PTR_Curve', 'CURVE')
        t = bpy.data.objects.new('PTR_CurveObject', cu)
    elif kind == 'ARMATURE_OBJECT':
        t = bpy.data.objects.new('PTR_ArmatureObject', bpy.data.armatures.new('PTR_Armature'))
    elif kind == 'LATTICE_OBJECT':
        t = bpy.data.objects.new('PTR_LatticeObject', bpy.data.lattices.new('PTR_Lattice'))
    elif kind == 'COLLECTION':
        t = bpy.data.collections.new('PTR_Collection')
        return targets.setdefault(kind, t)
    elif kind == 'TEXTURE':
        t = bpy.data.textures.new('PTR_Texture', 'CLOUDS')
        return targets.setdefault(kind, t)
    elif kind == 'IMAGE':
        t = bpy.data.images.new('PTR_Image', 4, 4)
        return targets.setdefault(kind, t)
    else:
        return None
    sc.collection.objects.link(t)
    targets[kind] = t
    return t

def pointer_for(owner, p):
    ft = p.fixed_type.identifier if p.fixed_type else ''
    if ft == 'Object':
        for k in ('MESH_OBJECT', 'OBJECT', 'CURVE_OBJECT', 'ARMATURE_OBJECT', 'LATTICE_OBJECT'):
            t = target(k)
            try:
                setattr(owner, p.identifier, t)
                if getattr(owner, p.identifier) == t:
                    return t.name
            except Exception:
                pass
        return None
    kind = {'Collection': 'COLLECTION', 'Texture': 'TEXTURE', 'Image': 'IMAGE'}.get(ft)
    if not kind:
        return None
    t = target(kind)
    try:
        setattr(owner, p.identifier, t)
        return t.name if getattr(owner, p.identifier) == t else None
    except Exception:
        return None

SKIP = {'name', 'show_viewport', 'show_render', 'show_in_editmode', 'show_on_cage', 'show_expanded', 'is_active', 'use_pin_to_last', 'is_override_data_editable', 'persistent_uid', 'use_apply_on_spline', 'execution_time', 'type', 'mute', 'active', 'enabled', 'is_valid', 'show_expanded_header', 'error_location', 'error_rotation', 'is_proxy_local', 'is_override_data_editable', 'use_bbone_shape'}

def probe_values(owner, p, i):
    """Values to try for property p (distinctive, valid)."""
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
    if p.type == 'STRING':
        return [f'S{i}x']
    return []

def add_record(kind, rna_type, prop, ptype, value, default):
    global count
    count += 1
    name = f'O{count}'
    records[name] = {'kind': kind, 'rna': rna_type, 'prop': prop, 'type': ptype, 'value': value, 'default': default}
    return name

GP_HOLDER = set()

def new_holder(name, gp=False):
    if gp:
        data = bpy.data.grease_pencils.new(name)
        ob = bpy.data.objects.new(name, data)
        ob.vertex_groups.new(name='S0x')
        sc.collection.objects.link(ob)
        return ob
    me = bpy.data.meshes.new(name)
    me.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [(0, 1, 2)])
    me.vertex_colors.new() if hasattr(me, 'vertex_colors') else None
    ob = bpy.data.objects.new(name, me)
    ob.vertex_groups.new(name='S0x')
    sc.collection.objects.link(ob)
    return ob

# ---- modifiers
mod_types = [i.identifier for i in bpy.types.Modifier.bl_rna.properties['type'].enum_items]
for t in mod_types:
    m = None
    for gp in (False, True):
        probe_ob = new_holder('probe', gp)
        try:
            m = probe_ob.modifiers.new('m', t)
        except Exception:
            m = None
        if m is not None:
            if gp:
                GP_HOLDER.add(t)
            break
        bpy.data.objects.remove(probe_ob)
    if m is None:
        continue
    props = [p for p in m.bl_rna.properties if p.identifier not in SKIP and not p.is_readonly]
    defaults = {}
    for p in props:
        try:
            v = getattr(m, p.identifier)
            defaults[p.identifier] = v if isinstance(v, (int, float, str, bool)) else (list(v) if hasattr(v, '__len__') and not isinstance(v, str) and p.type != 'POINTER' else None)
        except Exception:
            pass
    bpy.data.objects.remove(probe_ob)
    # untouched instance
    gp = t in GP_HOLDER
    name = add_record('MOD', t, None, None, None, None)
    ob = new_holder(name, gp)
    ob.modifiers.new('m', t)
    for i, p in enumerate(props):
        if p.type == 'POINTER':
            name = f'O{count + 1}'
            ob = new_holder(name, gp)
            mm = ob.modifiers.new('m', t)
            v = pointer_for(mm, p)
            if v is None:
                bpy.data.objects.remove(ob)
                continue
            add_record('MOD', t, p.identifier, 'POINTER', v, None)
            continue
        tmp = new_holder('tmp', gp)
        tm = tmp.modifiers.new('m', t)
        holder_vals = probe_values(tm, p, i)
        bpy.data.objects.remove(tmp)
        for v in holder_vals:
            name = f'O{count + 1}'
            ob = new_holder(name, gp)
            mm = ob.modifiers.new('m', t)
            try:
                setattr(mm, p.identifier, v)
                got = getattr(mm, p.identifier)
                ok = got == v or (isinstance(v, float) and abs(got - v) < 1e-4) or (isinstance(v, tuple) and all(abs(a - b) < 1e-4 for a, b in zip(got, v)))
            except Exception:
                ok = False
            if not ok:
                bpy.data.objects.remove(ob)
                continue
            add_record('MOD', t, p.identifier, p.type + ('_ARRAY' if p.type == 'FLOAT' and p.array_length else ''), list(v) if isinstance(v, tuple) else v, defaults.get(p.identifier))

# ---- constraints
con_types = [i.identifier for i in bpy.types.Constraint.bl_rna.properties['type'].enum_items]
for t in con_types:
    tmp = bpy.data.objects.new('tmp', None)
    sc.collection.objects.link(tmp)
    try:
        c = tmp.constraints.new(t)
    except Exception:
        bpy.data.objects.remove(tmp)
        continue
    props = [p for p in c.bl_rna.properties if p.identifier not in SKIP and not p.is_readonly]
    defaults = {}
    for p in props:
        try:
            v = getattr(c, p.identifier)
            defaults[p.identifier] = v if isinstance(v, (int, float, str, bool)) else None
        except Exception:
            pass
    bpy.data.objects.remove(tmp)
    name = add_record('CON', t, None, None, None, None)
    ob = bpy.data.objects.new(name, None)
    sc.collection.objects.link(ob)
    ob.constraints.new(t)
    for i, p in enumerate(props):
        if p.type == 'POINTER':
            name = f'O{count + 1}'
            ob = bpy.data.objects.new(name, None)
            sc.collection.objects.link(ob)
            cc = ob.constraints.new(t)
            v = pointer_for(cc, p)
            if v is None:
                bpy.data.objects.remove(ob)
                continue
            add_record('CON', t, p.identifier, 'POINTER', v, None)
            continue
        tmp = bpy.data.objects.new('tmp', None)
        sc.collection.objects.link(tmp)
        tc = tmp.constraints.new(t)
        vals = probe_values(tc, p, i)
        bpy.data.objects.remove(tmp)
        for v in vals:
            name = f'O{count + 1}'
            ob = bpy.data.objects.new(name, None)
            sc.collection.objects.link(ob)
            cc = ob.constraints.new(t)
            try:
                setattr(cc, p.identifier, v)
                got = getattr(cc, p.identifier)
                ok = got == v or (isinstance(v, float) and abs(got - v) < 1e-4) or (isinstance(v, tuple) and all(abs(a - b) < 1e-4 for a, b in zip(got, v)))
            except Exception:
                ok = False
            if not ok:
                bpy.data.objects.remove(ob)
                continue
            add_record('CON', t, p.identifier, p.type + ('_ARRAY' if p.type == 'FLOAT' and p.array_length else ''), list(v) if isinstance(v, tuple) else v, defaults.get(p.identifier))

with open(out + '.json', 'w') as f:
    json.dump(records, f)
bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
print('records', count)
