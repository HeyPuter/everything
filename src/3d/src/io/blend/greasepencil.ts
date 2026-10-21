// Grease Pencil (curves based, 4.3+ files): drawings (point / curve attributes), the layer tree
// with groups, keyframes, layer settings and masks, onion skinning and materials' stroke / fill
// settings. Layer and material settings are read through the measured DNA rules.
import type { MaterialData } from '../../data/types';
import { defaultGPStyle, newGreasePencil, newLayer } from '../../greasepencil/data';
import type { GPDrawing, GPFrame, GPKeyframeType, GPLayer, GreasePencilData, MaterialGPencilStyle } from '../../greasepencil/types';
import type { BStruct } from './reader';
import type { Ctx } from './context';
import { DNA_PROP_RULES } from './modprops.gen';
import { readRule } from './modifiers';
import { geometryAttributes } from './geometry';

const KEY_TYPES: GPKeyframeType[] = ['KEYFRAME', 'EXTREME', 'BREAKDOWN', 'JITTER', 'MOVING_HOLD', 'GENERATED'];

function applyRules(d: BStruct, ctx: Ctx, target: Record<string, unknown>) {
  const rules = DNA_PROP_RULES[d.type];
  if (!rules) return;
  for (const [k, r] of Object.entries(rules.props)) {
    if (!(k in target) || r.ptr) continue;
    const v = readRule(d, r, ctx, (s) => ctx.objectRef(s));
    if (v !== undefined) target[k] = v;
  }
}

/** Stroke / fill settings of a material's Grease Pencil style block. */
export function convertGPStyle(ma: BStruct, ctx: Ctx, target: MaterialData) {
  const st = ma.ref('gp_style');
  if (!st) return;
  const gs: MaterialGPencilStyle = defaultGPStyle({ mix_color: [1, 1, 1, 1], mix_factor: 0, flip: false, texture_offset: [0, 0], texture_angle: 0, texture_scale: [1, 1], use_stroke_holdout: false, use_fill_holdout: false, gradient_type: 'LINEAR' });
  applyRules(st, ctx, gs as unknown as Record<string, unknown>);
  if ((gs.fill_style as string) === 'TEXTURE') {
    ctx.warn.add('Grease Pencil texture fills drawn as solid fills', ma.idName);
    gs.fill_style = 'SOLID';
  }
  if ((gs.stroke_style as string) === 'TEXTURE') gs.stroke_style = 'SOLID';
  target.grease_pencil = gs;
}

function emptyDrawing(): GPDrawing {
  const z = () => new Float32Array(0);
  return { position: z(), radius: z(), opacity: z(), vertex_color: z(), offsets: new Uint32Array([0]), cyclic: new Uint8Array(0), material_index: new Uint16Array(0), start_cap: new Uint8Array(0), end_cap: new Uint8Array(0), fill_color: z(), fill_opacity: z(), fill_id: new Int32Array(0) };
}

function convertDrawing(d: BStruct, ctx: Ctx, owner: string): GPDrawing {
  const g = d.sub('geometry');
  if (!g) return emptyDrawing();
  const np = Math.max(0, g.has('point_num') ? g.num('point_num') : g.num('point_size'));
  const nc = Math.max(0, g.has('curve_num') ? g.num('curve_num') : g.num('curve_size'));
  const offs = nc > 0 ? ctx.f.array(g.ptr('curve_offsets'), 'i32', nc + 1, g.block) : [0];
  const { attrs, reader } = geometryAttributes(
    g,
    ctx,
    { POINT: np, CURVE: nc },
    [
      ['point_data', 'POINT'],
      ['curve_data', 'CURVE'],
    ],
    owner,
  );
  const read = (name: string, domain: string) => {
    const a = attrs.find((x) => x.name === name && x.domain === domain);
    return a ? reader.read(a) : null;
  };
  const f32 = (v: Float64Array | null, n: number, fill = 0) => (v ? Float32Array.from(v) : new Float32Array(n).fill(fill));
  const out: GPDrawing = {
    position: f32(read('position', 'POINT'), np * 3),
    radius: f32(read('radius', 'POINT'), np, 0.01),
    opacity: f32(read('opacity', 'POINT'), np, 1),
    vertex_color: f32(read('vertex_color', 'POINT'), np * 4),
    offsets: Uint32Array.from(offs ?? Array.from({ length: nc + 1 }, () => 0)),
    cyclic: Uint8Array.from(read('cyclic', 'CURVE') ?? new Float64Array(nc)),
    material_index: Uint16Array.from(read('material_index', 'CURVE') ?? new Float64Array(nc)),
    start_cap: Uint8Array.from(read('start_cap', 'CURVE') ?? new Float64Array(nc)),
    end_cap: Uint8Array.from(read('end_cap', 'CURVE') ?? new Float64Array(nc)),
    fill_color: f32(read('fill_color', 'CURVE'), nc * 4),
    fill_opacity: f32(read('fill_opacity', 'CURVE'), nc, 1),
    fill_id: Int32Array.from(read('fill_id', 'CURVE') ?? new Float64Array(nc)),
  };
  // curve types: 0 Catmull-Rom, 1 poly, 2 Bézier, 3 NURBS
  if (read('curve_type', 'CURVE')?.some((t) => t === 2 || t === 3)) ctx.warn.add('Grease Pencil Bézier / NURBS strokes imported as their control points', owner);
  return out;
}

export function convertGreasePencil(gp: BStruct, ctx: Ctx): GreasePencilData {
  const f = ctx.f;
  const data = newGreasePencil(gp.idName);
  // drawings (reference drawings instance another data-block: not supported)
  const ptrs = gp.ptrArray('drawing_array', Math.max(0, gp.num('drawing_array_size')));
  data.drawings = ptrs.map((a) => {
    const d = gp.at(a);
    if (!d || d.type !== 'GreasePencilDrawing') {
      if (d) ctx.warn.add('Grease Pencil drawing references not imported (left empty)', gp.idName);
      return emptyDrawing();
    }
    return convertDrawing(d, ctx, gp.idName);
  });
  // layer tree: layers in drawing order (first = bottom), groups by name
  const layers: { s: BStruct; layer: GPLayer }[] = [];
  const groups: { name: string; expanded?: boolean; color_tag?: string }[] = [];
  const nameOf = (node: BStruct) => {
    const b = node.sub('base');
    return b ? (f.cstringAt(b.ptr('name'), 1024, b.block) ?? '') : '';
  };
  const walk = (g: BStruct, group: string | null, depth: number) => {
    for (const c of g.list('children', 100_000)) {
      if (c.type === 'GreasePencilLayerTreeGroup') {
        const name = nameOf(c);
        groups.push({ name, expanded: ((c.sub('base')?.num('flag') ?? 0) & 4) !== 0 });
        if (depth < 64) walk(c, name, depth + 1);
        continue;
      }
      if (c.type !== 'GreasePencilLayer') continue;
      const layer = newLayer(nameOf(c) || 'Layer');
      applyRules(c, ctx, layer as unknown as Record<string, unknown>);
      if (group) layer.parent_group = group;
      // keyframes
      const fs = c.sub('frames_storage');
      const n = fs ? Math.max(0, fs.has('size') ? fs.num('size') : fs.num('num')) : 0;
      if (fs && n) {
        const keys = f.array(fs.ptr('keys'), 'i32', n, fs.block) ?? [];
        const vals = f.structsAt(fs.ptr('values'), 'GreasePencilFrame', n, fs.block);
        const frames: GPFrame[] = [];
        keys.forEach((k, i) => {
          const v = vals[i];
          const di = v ? v.num('drawing_index') : -1;
          // a negative index ends the previous keyframe's exposure: no drawing here
          if (di >= 0 && di < data.drawings.length) frames.push({ frame_number: k, drawing: di, keyframe_type: KEY_TYPES[v.num('type')] ?? 'KEYFRAME' });
        });
        layer.frames = frames.sort((a, b) => a.frame_number - b.frame_number);
      }
      // masks
      const masks = c.list('masks', 1000).map((m) => ({ name: m.has('layer_name') ? (f.cstringAt(m.ptr('layer_name'), 1024, m.block) ?? '') : '', hide: (m.num('flag') & 1) !== 0, invert: (m.num('flag') & 2) !== 0 }));
      if (masks.length) layer.mask_layers = masks.filter((m) => m.name);
      // parenting
      const par = c.ref('parent');
      if (par) {
        layer.parent = ctx.objectRef(par);
        const bone = f.cstringAt(c.ptr('parsubstr'), 256, c.block) ?? '';
        if (bone) {
          layer.parent_type = 'BONE';
          layer.parent_bone = bone;
        } else layer.parent_type = 'OBJECT';
        const inv = c.nums('parentinv', 16);
        if (inv.length === 16) layer.parent_inverse = inv;
      }
      layers.push({ s: c, layer });
    }
  };
  const root = gp.ref('root_group_ptr');
  if (root) walk(root, null, 0);
  data.layers = layers.map((l) => l.layer);
  if (groups.length) data.layer_groups = groups;
  const act = gp.ptr('active_node');
  const ai = layers.findIndex((l) => l.s.offset === gp.at(act)?.offset);
  data.active_layer_index = Math.max(0, ai >= 0 ? ai : data.layers.length - 1);
  // per-layer attributes (tint, radius offset, pass index), in layer order
  const { attrs, reader } = geometryAttributes(gp, ctx, { LAYER: layers.length }, [['layers_data', 'LAYER']], gp.idName);
  const layerAttr = (name: string) => {
    const a = attrs.find((x) => x.name === name && x.domain === 'LAYER');
    return a ? reader.read(a) : null;
  };
  const tint = layerAttr('tint_color'),
    radius = layerAttr('radius_offset'),
    pass = layerAttr('pass_index');
  data.layers.forEach((l, i) => {
    if (tint) {
      l.tint_color = [tint[i * 4], tint[i * 4 + 1], tint[i * 4 + 2]];
      l.tint_factor = tint[i * 4 + 3];
    }
    if (radius) l.radius_offset = radius[i];
    if (pass) l.pass_index = pass[i];
  });
  // onion skinning
  const on = gp.sub('onion_skinning_settings');
  if (on) {
    data.onion_factor = on.num('opacity') || data.onion_factor;
    data.ghost_before_range = on.num('num_frames_before');
    data.ghost_after_range = on.num('num_frames_after');
    data.onion_mode = (['ABSOLUTE', 'RELATIVE', 'SELECTED'] as const)[on.num('mode')] ?? 'RELATIVE';
    const cb = on.nums('color_before', 3),
      ca = on.nums('color_after', 3);
    if (cb.length === 3) data.before_color = [cb[0], cb[1], cb[2]];
    if (ca.length === 3) data.after_color = [ca[0], ca[1], ca[2]];
  }
  data.materials = gp.ptrArray('material_array', Math.max(0, gp.num('material_array_size'))).map((a) => (a === 0 ? null : ctx.material(gp.at(a))));
  return data;
}
