// Animation conversion: actions (legacy F-curve lists and 4.4+/5.x layered, slotted
// actions whose keys live in channelbags), NLA tracks and drivers.
import { compileExpr } from '../../anim/driverexpr';
import type { ActionData, AnimData, Driver, DriverVariable, FCurve, FModifier, Interpolation, Keyframe, KeyHandleType, NlaStrip, NlaTrack } from '../../data/types';
import { uid } from '../../data/defaults';
import type { BStruct } from './reader';
import type { Ctx } from './context';

const IPO: Interpolation[] = ['CONSTANT', 'LINEAR', 'BEZIER', 'BACK', 'BOUNCE', 'CIRC', 'CUBIC', 'ELASTIC', 'EXPO', 'QUAD', 'QUART', 'QUINT', 'SINE'];
const HANDLE: KeyHandleType[] = ['FREE', 'AUTO', 'VECTOR', 'ALIGNED', 'AUTO_CLAMPED'];
const EASING: Keyframe['easing'][] = ['AUTO', 'EASE_IN', 'EASE_OUT', 'EASE_IN_OUT'];
const KEYTYPE: Keyframe['type'][] = ['KEYFRAME', 'EXTREME', 'BREAKDOWN', 'JITTER', 'MOVING_HOLD', 'GENERATED'];
const CYCLE_MODE: FModifier['mode_before'][] = ['NONE', 'REPEAT', 'REPEAT_OFFSET', 'MIRROR'];
const BLEND: NlaStrip['blend_type'][] = ['REPLACE', 'ADD', 'SUBTRACT', 'MULTIPLY', 'COMBINE'];
const EXTEND: NlaStrip['extrapolation'][] = ['HOLD', 'HOLD_FORWARD', 'NOTHING'];

const FCURVE_MUTED = 16;

function convertFModifiers(fc: BStruct, ctx: Ctx, path: string): FModifier[] {
  const out: FModifier[] = [];
  for (const m of fc.list('modifiers', 100)) {
    const data = m.ref('data');
    const mute = (m.num('flag') & 8) !== 0;
    switch (data?.type) {
      case 'FMod_Cycles':
        out.push({ type: 'CYCLES', mute, mode_before: CYCLE_MODE[data.num('before_mode')] ?? 'REPEAT', mode_after: CYCLE_MODE[data.num('after_mode')] ?? 'REPEAT' });
        break;
      case 'FMod_Noise':
        out.push({ type: 'NOISE', mute, scale: data.num('size'), strength: data.num('strength'), phase: data.num('phase'), offset: data.num('offset'), depth: data.num('depth') });
        break;
      case 'FMod_Stepped':
        out.push({ type: 'STEPPED', mute, frame_step: data.num('step_size'), frame_offset: data.num('offset') });
        break;
      case 'FMod_Generator': {
        const n = data.num('arraysize');
        const co = ctx.f.float32(data.ptr('coefficients'), Math.max(0, Math.min(64, n)), data.block);
        if (data.num('mode') === 0 && co) out.push({ type: 'GENERATOR', mute, coefficients: Array.from(co) });
        else ctx.warn.add('F-curve modifiers not supported', `${path} (factorised generator)`);
        break;
      }
      case 'FMod_Limits': {
        const rect = data.sub('rect');
        const flag = data.num('flag');
        out.push({ type: 'LIMITS', mute, use_min_y: (flag & 4) !== 0, use_max_y: (flag & 8) !== 0, min_y: rect?.num('ymin') ?? 0, max_y: rect?.num('ymax') ?? 0 });
        break;
      }
      default:
        ctx.warn.add('F-curve modifiers not supported', `${path} (${data?.type ?? 'unknown'})`);
    }
  }
  return out;
}

export function convertFCurve(fc: BStruct, ctx: Ctx, prefix: string, groupName?: string): FCurve | null {
  const rna = fc.cstr('rna_path');
  if (!rna) return null;
  const path = prefix + rna;
  const n = Math.max(0, Math.min(1_000_000, fc.num('totvert')));
  const keys: Keyframe[] = [];
  const bezts = ctx.f.structsAt(fc.ptr('bezt'), 'BezTriple', n, fc.block);
  for (const b of bezts) {
    const v = b.nums('vec', 9);
    const f1 = b.num('f1'),
      f2 = b.num('f2'),
      f3 = b.num('f3');
    const k: Keyframe = {
      co: [v[3], v[4]],
      handle_left: [v[0], v[1]],
      handle_right: [v[6], v[7]],
      handle_left_type: HANDLE[b.num('h1')] ?? 'AUTO_CLAMPED',
      handle_right_type: HANDLE[b.num('h2')] ?? 'AUTO_CLAMPED',
      interpolation: IPO[b.num('ipo')] ?? 'BEZIER',
      easing: EASING[b.num('easing')] ?? 'AUTO',
      type: KEYTYPE[b.num('hide')] ?? 'KEYFRAME',
      back: b.num('back'),
      amplitude: b.num('amplitude'),
      period: b.num('period'),
    };
    if (f2 & 1) k.select_control_point = true;
    if (f1 & 1) k.select_left_handle = true;
    if (f3 & 1) k.select_right_handle = true;
    if (k.co.every(Number.isFinite)) keys.push(k);
  }
  if (!bezts.length && fc.ptr('fpt') !== 0) {
    // baked samples: FPoint { float vec[2]; int flag; }
    const pts = ctx.f.structsAt(fc.ptr('fpt'), 'FPoint', n, fc.block);
    for (const p of pts) {
      const [x, y] = p.nums('vec', 2);
      keys.push({ co: [x, y], handle_left: [x, y], handle_right: [x, y], handle_left_type: 'VECTOR', handle_right_type: 'VECTOR', interpolation: 'LINEAR', easing: 'AUTO', type: 'KEYFRAME' });
    }
  }
  const out: FCurve = {
    data_path: path,
    array_index: fc.num('array_index'),
    keyframe_points: keys,
    extrapolation: fc.num('extend') === 1 ? 'LINEAR' : 'CONSTANT',
    modifiers: convertFModifiers(fc, ctx, path),
  };
  const flag = fc.num('flag');
  if (flag & FCURVE_MUTED) out.mute = true;
  if (flag & 2) out.select = true;
  const grp = groupName ?? fc.ref('grp')?.str('name');
  if (grp) out.group = grp;
  return out;
}

/** F-curves of an action for the given slot (layered actions) or all curves (legacy actions). */
function actionCurves(act: BStruct, slotHandle: number, ctx: Ctx): { curves: BStruct[]; groups: Map<number, string>; slotName?: string } {
  const groups = new Map<number, string>();
  const layered = act.num('layer_array_num') > 0 || act.num('slot_array_num') > 0;
  if (!layered) {
    return { curves: act.list('curves', 100_000), groups };
  }
  const slots = act.refs('slot_array', act.num('slot_array_num'));
  let slot = slots.find((s) => s.num('handle') === slotHandle);
  if (!slot && slots.length === 1) slot = slots[0];
  if (!slot) return { curves: [], groups };
  const handle = slot.num('handle');
  const curves: BStruct[] = [];
  const kfData = act.refs('strip_keyframe_data_array', act.num('strip_keyframe_data_array_num'));
  const layers = act.refs('layer_array', act.num('layer_array_num'));
  if (layers.length > 1) ctx.warn.add('Action layers beyond the first ignored', act.idName);
  for (const layer of layers.slice(0, 1)) {
    const strips = layer.refs('strip_array', layer.num('strip_array_num'));
    if (strips.length > 1) ctx.warn.add('Action strips beyond the first ignored', act.idName);
    for (const strip of strips.slice(0, 1)) {
      if (strip.num('strip_type') !== 0) continue;
      const kd = kfData[strip.num('data_index')];
      if (!kd) continue;
      for (const cb of kd.refs('channelbag_array', kd.num('channelbag_array_num'))) {
        if (cb.num('slot_handle') !== handle) continue;
        for (const g of cb.refs('group_array', cb.num('group_array_num'))) groups.set(g.offset, g.str('name'));
        curves.push(...cb.refs('fcurve_array', cb.num('fcurve_array_num')));
      }
    }
  }
  return { curves, groups, slotName: slot.str('name') };
}

/** Convert (action, slot) to an ActionData, cached per pair. */
export function convertAction(act: BStruct, slotHandle: number, ctx: Ctx, prefix = '', cache = new Map<string, string>()): string | null {
  const key = `${act.offset}:${slotHandle}:${prefix}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { curves, groups } = actionCurves(act, slotHandle, ctx);
  const action: ActionData = { id: uid('ac'), name: act.idName, fcurves: [] };
  for (const c of curves) {
    const grpAddr = c.ptr('grp');
    let gname: string | undefined;
    if (grpAddr !== 0) {
      const g = c.ref('grp');
      gname = g ? groups.get(g.offset) ?? g.str('name') : undefined;
    }
    const fc = convertFCurve(c, ctx, prefix, gname);
    if (fc) action.fcurves.push(fc);
  }
  const fs = act.num('frame_start'),
    fe = act.num('frame_end');
  if (act.num('flag') & (1 << 12) && fe > fs) action.frame_range = [fs, fe];
  // de-duplicate names when one stored action becomes several (slots / prefixes)
  const taken = new Set(Object.values(ctx.doc.actions).map((a) => a.name));
  if (taken.has(action.name)) {
    let i = 1;
    while (taken.has(`${act.idName}.${String(i).padStart(3, '0')}`)) i++;
    action.name = `${act.idName}.${String(i).padStart(3, '0')}`;
  }
  ctx.doc.actions[action.id] = action;
  cache.set(key, action.id);
  return action.id;
}

function convertDrivers(adt: BStruct, ctx: Ctx, prefix: string): Driver[] {
  const out: Driver[] = [];
  for (const fc of adt.list('drivers', 10_000)) {
    const drv = fc.ref('driver');
    const rna = fc.cstr('rna_path');
    if (!drv || !rna) continue;
    const type = (['AVERAGE', 'SCRIPTED', 'SUM', 'MIN', 'MAX'] as const)[drv.num('type')] ?? 'AVERAGE';
    const vars: DriverVariable[] = [];
    for (const v of drv.list('variables', 100)) {
      const vt = (['SINGLE_PROP', 'ROTATION_DIFF', 'LOC_DIFF', 'TRANSFORMS', 'CONTEXT_PROP'] as const)[v.num('type')];
      if (!vt) {
        ctx.warn.add('Driver variables of unsupported type skipped', v.str('name'));
        continue;
      }
      const targets: DriverVariable['targets'] = [];
      const nt = Math.max(0, Math.min(8, v.num('num_targets')));
      const TRANS = ['LOC_X', 'LOC_Y', 'LOC_Z', 'ROT_X', 'ROT_Y', 'ROT_Z', 'SCALE_X', 'SCALE_Y', 'SCALE_Z', 'SCALE_AVG', 'ROT_W'];
      const ROT_MODES = ['AUTO', 'XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX', 'QUATERNION', 'SWING_TWIST_X', 'SWING_TWIST_Y', 'SWING_TWIST_Z'];
      for (let i = 0; i < nt; i++) {
        const t = v.sub('targets', i);
        if (!t) continue;
        const id = t.ref('id');
        const code = id?.sub('id')?.str('name').slice(0, 2) ?? '';
        const isOb = code === 'OB';
        const tgt: DriverVariable['targets'][number] = { id: isOb ? ctx.objectRef(id) : code === 'SC' ? 'scene' : null, data_path: t.cstr('rna_path') };
        if (code === 'SC') tgt.id_type = 'SCENE';
        if (vt === 'TRANSFORMS') tgt.transform_type = TRANS[t.num('transChan')] ?? 'LOC_X';
        const bone = t.str('pchan_name');
        if (bone) tgt.bone_target = bone;
        const flag = t.num('flag');
        // target flags: (1 << 2) local, with (1 << 3) the raw channels without constraints
        tgt.transform_space = flag & 4 ? (flag & 8 ? 'LOCAL_SPACE' : 'TRANSFORM_SPACE') : 'WORLD_SPACE';
        tgt.rotation_mode = ROT_MODES[t.num('rotation_mode')] ?? 'AUTO';
        if (vt === 'CONTEXT_PROP') tgt.context_property = t.num('context_property') === 1 ? 'ACTIVE_VIEW_LAYER' : 'ACTIVE_SCENE';
        if (t.has('fallback_value')) {
          tgt.fallback_value = t.num('fallback_value');
          if (flag & (1 << 5)) tgt.use_fallback_value = true;
        }
        if (id && !isOb && code !== 'SC') ctx.warn.add('Driver targets on non-object data-blocks not supported', `${rna} → ${id.idName}`);
        targets.push(tgt);
      }
      vars.push({ name: v.str('name'), type: vt, targets });
    }
    const d: Driver = { data_path: prefix + rna, array_index: fc.num('array_index'), type, expression: drv.str('expression'), variables: vars };
    // the driver's own F-Curve maps its value (keys and modifiers)
    const curve = convertFCurve(fc, ctx, prefix);
    if (curve) d.fcurve = { ...curve, select: false };
    if (drv.num('flag') & (1 << 3)) d.use_self = true;
    if (type === 'SCRIPTED') {
      // the expression evaluator covers the usual Python math subset; flag what it can't parse
      try {
        compileExpr(d.expression);
      } catch {
        ctx.warn.add('Driver expressions that could not be read (check them)', `${d.data_path}: ${d.expression}`);
      }
    }
    out.push(d);
  }
  return out;
}

/** Convert an AnimData block. `prefix` maps data-level paths onto the owning object. */
export function convertAnimData(adt: BStruct | null, ctx: Ctx, prefix: string, cache: Map<string, string>): AnimData | null {
  if (!adt) return null;
  const act = adt.ref('action');
  const ad: AnimData = { action: null, nla_tracks: [], drivers: [] };
  if (act) ad.action = convertAction(act, adt.num('slot_handle'), ctx, prefix, cache);
  const bm = adt.num('act_blendmode');
  if (bm) ad.action_blend_type = BLEND[bm] ?? 'REPLACE';
  const inf = adt.num('act_influence');
  if (adt.num('flag') & (1 << 10) && inf !== 1) ad.action_influence = inf;
  for (const tr of adt.list('nla_tracks', 1000)) {
    const tf = tr.num('flag');
    const track: NlaTrack = { name: tr.str('name'), strips: [], mute: (tf & 4) !== 0, is_solo: (tf & 8) !== 0 };
    for (const s of tr.list('strips', 10_000)) {
      const sa = s.ref('act');
      if (!sa) {
        ctx.warn.add('NLA meta/transition strips skipped', s.str('name'));
        continue;
      }
      const acId = convertAction(sa, s.num('action_slot_handle'), ctx, prefix, cache);
      if (!acId) continue;
      track.strips.push({
        name: s.str('name'),
        action: acId,
        frame_start: s.num('start'),
        frame_end: s.num('end'),
        action_frame_start: s.num('actstart'),
        action_frame_end: s.num('actend'),
        scale: s.num('scale') || 1,
        repeat: s.num('repeat') || 1,
        blend_type: BLEND[s.num('blendmode')] ?? 'REPLACE',
        blend_in: s.num('blendin'),
        blend_out: s.num('blendout'),
        mute: (s.num('flag') & 4096) !== 0,
        extrapolation: EXTEND[s.num('extendmode')] ?? 'HOLD',
      });
    }
    ad.nla_tracks.push(track);
  }
  ad.drivers = convertDrivers(adt, ctx, prefix);
  if (!ad.action && !ad.nla_tracks.length && !ad.drivers.length) return null;
  return ad;
}

/** Merge animation of object data (shape keys, light, camera …) into the object's AnimData. */
export function mergeAnimData(ctx: Ctx, base: AnimData | null, extra: AnimData | null, obName: string): AnimData | null {
  if (!extra) return base;
  if (!base) return extra;
  if (extra.action) {
    if (!base.action) base.action = extra.action;
    else {
      // combine into a new action so both sets of channels play
      const a = ctx.doc.actions[base.action],
        b = ctx.doc.actions[extra.action];
      const merged: ActionData = { id: uid('ac'), name: `${obName}Action`, fcurves: [...a.fcurves.map((f) => ({ ...f })), ...b.fcurves.map((f) => ({ ...f }))] };
      ctx.doc.actions[merged.id] = merged;
      base.action = merged.id;
    }
  }
  base.nla_tracks.push(...extra.nla_tracks);
  base.drivers.push(...extra.drivers);
  return base;
}
