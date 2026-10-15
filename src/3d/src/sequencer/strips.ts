// Pure strip logic: defaults, timing (handles/trims/content mapping), stacking order, overlap
// resolution, splitting, snapping, meta strips. No DOM access (unit tested).
import type { SceneData } from '../data/types';
import type { BlendType, ColorBalanceData, ModifierType, SeqChannel, SequenceEditor, SequencerToolSettings, Strip, StripModifier, StripType } from './types';
import { MAX_CHANNELS } from './types';
import { hasRetiming, contentLength, mapContent } from './retime';

// ---------------------------------------------------------------------------
// classification

export const EFFECT_INPUTS: Partial<Record<StripType, number>> = {
  CROSS: 2,
  GAMMA_CROSS: 2,
  WIPE: 2,
  ADD: 2,
  SUBTRACT: 2,
  MULTIPLY: 2,
  ALPHA_OVER: 2,
  ALPHA_UNDER: 2,
  COLORMIX: 2,
  TRANSFORM: 1,
  SPEED: 1,
  GLOW: 1,
  GAUSSIAN_BLUR: 1,
};

export const TRANSITIONS: StripType[] = ['CROSS', 'GAMMA_CROSS', 'WIPE'];

export function isEffect(t: StripType) {
  return EFFECT_INPUTS[t] !== undefined;
}
export function inputCount(t: StripType) {
  return EFFECT_INPUTS[t] ?? 0;
}
/** Strips whose content does not change over time (length can be changed freely). */
export function isStill(s: Strip) {
  return s.type === 'COLOR' || s.type === 'TEXT' || s.type === 'ADJUSTMENT' || s.type === 'MULTICAM' || (s.type === 'IMAGE' && (s.elements?.length ?? 0) <= 1);
}
/** Strips that produce pixels (everything but sound). */
export function isVisual(s: Strip) {
  return s.type !== 'SOUND';
}

export const STRIP_LABELS: Record<StripType, string> = {
  IMAGE: 'Image',
  MOVIE: 'Movie',
  SOUND: 'Sound',
  SCENE: 'Scene',
  COLOR: 'Color',
  TEXT: 'Text',
  ADJUSTMENT: 'Adjustment Layer',
  META: 'Meta',
  CROSS: 'Cross',
  GAMMA_CROSS: 'Gamma Cross',
  WIPE: 'Wipe',
  ADD: 'Add',
  SUBTRACT: 'Subtract',
  MULTIPLY: 'Multiply',
  ALPHA_OVER: 'Alpha Over',
  ALPHA_UNDER: 'Alpha Under',
  COLORMIX: 'Color Mix',
  TRANSFORM: 'Transform',
  SPEED: 'Speed',
  GLOW: 'Glow',
  GAUSSIAN_BLUR: 'Gaussian Blur',
  MULTICAM: 'Multicam Selector',
};

export const BLEND_ITEMS: [BlendType, string][] = [
  ['REPLACE', 'Replace'],
  ['CROSS', 'Cross'],
  ['DARKEN', 'Darken'],
  ['MULTIPLY', 'Multiply'],
  ['BURN', 'Color Burn'],
  ['LINEAR_BURN', 'Linear Burn'],
  ['LIGHTEN', 'Lighten'],
  ['SCREEN', 'Screen'],
  ['DODGE', 'Color Dodge'],
  ['ADD', 'Add'],
  ['OVERLAY', 'Overlay'],
  ['SOFT_LIGHT', 'Soft Light'],
  ['HARD_LIGHT', 'Hard Light'],
  ['VIVID_LIGHT', 'Vivid Light'],
  ['LINEAR_LIGHT', 'Linear Light'],
  ['PIN_LIGHT', 'Pin Light'],
  ['DIFFERENCE', 'Difference'],
  ['EXCLUSION', 'Exclusion'],
  ['SUBTRACT', 'Subtract'],
  ['HUE', 'Hue'],
  ['SATURATION', 'Saturation'],
  ['COLOR', 'Color'],
  ['VALUE', 'Value'],
  ['ALPHA_OVER', 'Alpha Over'],
  ['ALPHA_UNDER', 'Alpha Under'],
  ['GAMMA_CROSS', 'Gamma Cross'],
];

// ---------------------------------------------------------------------------
// defaults

export function defaultToolSettings(): SequencerToolSettings {
  return {
    overlap_mode: 'SHUFFLE',
    fit_method: 'FIT',
    snap_to_current_frame: true,
    snap_to_hold_offset: true,
    snap_to_markers: true,
    snap_ignore_muted: false,
    snap_ignore_sound: false,
    snap_distance: 15,
  };
}

export function newChannels(n = MAX_CHANNELS + 1): SeqChannel[] {
  const out: SeqChannel[] = [];
  for (let i = 0; i < n; i++) out.push({ name: `Channel ${i}`, lock: false, mute: false });
  return out;
}

export function newSequenceEditor(): SequenceEditor {
  return { strips: [], channels: newChannels(), active_strip: null, meta_stack: [], overlay_frame: 0, show_overlay_frame: false, proxy_storage: 'PER_STRIP', use_cache_raw: true, use_cache_final: true };
}

/** The scene's sequence editor, created on demand (`sequence_editor_create`). */
export function ensureEditor(scene: SceneData): SequenceEditor {
  if (!scene.sequence_editor) scene.sequence_editor = newSequenceEditor();
  const ed = scene.sequence_editor;
  ed.strips ??= [];
  ed.meta_stack ??= [];
  if (!ed.channels || ed.channels.length < MAX_CHANNELS + 1) ed.channels = [...(ed.channels ?? []), ...newChannels(MAX_CHANNELS + 1).slice(ed.channels?.length ?? 0)];
  return ed;
}

export function newStrip(type: StripType, name: string, channel: number, frame_start: number, frame_duration: number): Strip {
  const s: Strip = {
    name,
    type,
    channel: Math.max(1, Math.min(MAX_CHANNELS, Math.round(channel))),
    frame_start,
    frame_duration: Math.max(1, frame_duration),
    frame_offset_start: 0,
    frame_offset_end: 0,
    animation_offset_start: 0,
    animation_offset_end: 0,
    select: true,
    select_left_handle: false,
    select_right_handle: false,
    mute: false,
    lock: false,
    blend_type: type === 'ADJUSTMENT' ? 'CROSS' : type === 'SOUND' ? 'CROSS' : 'ALPHA_OVER',
    blend_alpha: 1,
    use_default_fade: true,
    effect_fader: 0,
    color_tag: 'NONE',
    modifiers: [],
    transform: { offset_x: 0, offset_y: 0, scale_x: 1, scale_y: 1, rotation: 0, origin: [0.5, 0.5], filter: 'AUTO' },
    crop: { min_x: 0, max_x: 0, min_y: 0, max_y: 0 },
    use_flip_x: false,
    use_flip_y: false,
    use_reverse_frames: false,
    color_saturation: 1,
    color_multiply: 1,
    multiply_alpha: false,
    strobe: 1,
    alpha_mode: 'STRAIGHT',
  };
  switch (type) {
    case 'SOUND':
      Object.assign(s, { volume: 1, pan: 0, show_waveform: true, sound_offset: 0 });
      break;
    case 'COLOR':
      s.color = [0.5, 0.5, 0.5];
      break;
    case 'TEXT':
      Object.assign(s, {
        text: 'Text',
        font_size: 60,
        use_bold: false,
        use_italic: false,
        wrap_width: 1,
        location: [0.5, 0.5],
        anchor_x: 'CENTER',
        anchor_y: 'CENTER',
        alignment_x: 'CENTER',
        color: [1, 1, 1, 1],
        use_shadow: false,
        shadow_color: [0, 0, 0, 0.7],
        shadow_angle: (65 * Math.PI) / 180,
        shadow_offset: 0.04,
        shadow_blur: 0,
        use_outline: false,
        outline_color: [0, 0, 0, 0.7],
        outline_width: 0.05,
        use_box: false,
        box_color: [0.2, 0.2, 0.2, 0.7],
        box_margin: 0.01,
        box_roundness: 0,
      });
      break;
    case 'WIPE':
      Object.assign(s, { transition_type: 'SINGLE', direction: 'OUT', angle: 0, blur_width: 0 });
      break;
    case 'GLOW':
      Object.assign(s, { threshold: 0.25, clamp: 1, boost_factor: 0.5, blur_radius: 3, quality: 3, use_only_boost: false });
      break;
    case 'GAUSSIAN_BLUR':
      Object.assign(s, { size_x: 0, size_y: 0 });
      break;
    case 'SPEED':
      Object.assign(s, { speed_control: 'STRETCH', speed_factor: 1, speed_frame_number: 0, speed_length: 100 });
      break;
    case 'COLORMIX':
      Object.assign(s, { blend_effect: 'OVERLAY', factor: 1 });
      break;
    case 'TRANSFORM':
      Object.assign(s, { translation_unit: 'PIXELS', translate_start_x: 0, translate_start_y: 0, scale_start_x: 1, scale_start_y: 1, use_uniform_scale: false, rotation_start: 0 });
      break;
    case 'SCENE':
      Object.assign(s, { scene_camera: null, volume: 1 });
      break;
    case 'META':
      s.strips = [];
      break;
    case 'MULTICAM':
      s.multicam_source = 1;
      s.blend_type = 'REPLACE';
      break;
  }
  return s;
}

export function newColorBalance(): ColorBalanceData {
  return {
    correction_method: 'LIFT_GAMMA_GAIN',
    lift: [1, 1, 1],
    gamma: [1, 1, 1],
    gain: [1, 1, 1],
    offset: [1, 1, 1],
    power: [1, 1, 1],
    slope: [1, 1, 1],
    invert_lift: false,
    invert_gamma: false,
    invert_gain: false,
    invert_offset: false,
    invert_power: false,
    invert_slope: false,
  };
}

export function newModifier(type: ModifierType, name: string): StripModifier {
  if (type === 'COLOR_BALANCE') return { name, type, mute: false, show_expanded: true, color_balance: newColorBalance(), color_multiply: 1 };
  return { name, type, mute: false, show_expanded: true, bright: 0, contrast: 0 };
}

// ---------------------------------------------------------------------------
// timing

export const finalStart = (s: Strip) => s.frame_start + s.frame_offset_start;
export const finalEnd = (s: Strip) => s.frame_start + s.frame_duration - s.frame_offset_end;
export const finalDuration = (s: Strip) => finalEnd(s) - finalStart(s);
/** Whether the strip shows at `frame` (handles are [start, end)). */
export const activeAt = (s: Strip, frame: number) => frame >= finalStart(s) && frame < finalEnd(s);

/** Set the strip's visible range, keeping content where possible (handles drag / extend). */
export function setLeftHandle(s: Strip, frame: number) {
  frame = Math.round(frame);
  const end = finalEnd(s);
  frame = Math.min(frame, end - 1);
  if (isStill(s)) {
    s.frame_duration = end - frame + s.frame_offset_end;
    s.frame_start = frame;
    s.frame_offset_start = 0;
    return;
  }
  // content strips: trims cannot extend past the content
  s.frame_offset_start = Math.max(0, frame - s.frame_start);
}

export function setRightHandle(s: Strip, frame: number) {
  frame = Math.round(frame);
  const start = finalStart(s);
  frame = Math.max(frame, start + 1);
  if (isStill(s)) {
    s.frame_duration = frame - s.frame_start;
    s.frame_offset_end = 0;
    return;
  }
  s.frame_offset_end = Math.max(0, s.frame_start + s.frame_duration - frame);
}

/** Clamp trims into the content (after slips / duration changes). */
export function clampOffsets(s: Strip) {
  s.frame_offset_start = Math.max(0, Math.min(s.frame_offset_start, s.frame_duration - 1));
  s.frame_offset_end = Math.max(0, Math.min(s.frame_offset_end, s.frame_duration - 1 - s.frame_offset_start));
}

/** Slip the content under fixed handles by `d` frames. */
export function slip(s: Strip, d: number) {
  if (isStill(s) || inputCount(s.type)) return;
  const a = finalStart(s),
    b = finalEnd(s);
  // keep the visible range inside the content
  const lo = b - (s.frame_start + s.frame_duration);
  const hi = a - s.frame_start;
  d = Math.max(lo, Math.min(hi, Math.round(d)));
  s.frame_start += d;
  s.frame_offset_start = a - s.frame_start;
  s.frame_offset_end = s.frame_start + s.frame_duration - b;
}

/**
 * Content frame index (source frame, before the hard trim offset is added back) for a timeline
 * frame: handles reverse playback and strobe. Returns the index into the full source.
 */
export function contentFrame(s: Strip, frame: number): number {
  let local = Math.floor(frame - s.frame_start);
  const n = Math.max(1, s.frame_duration);
  local = Math.max(0, Math.min(n - 1, local));
  if (hasRetiming(s)) {
    // speed changes: the timeline position maps to a content frame through the retiming keys
    if (s.strobe > 1) local = Math.floor(local / s.strobe) * Math.floor(s.strobe);
    const len = Math.max(1, Math.round(contentLength(s)));
    let c = Math.max(0, Math.min(len - 1, Math.floor(mapContent(s, local) + 1e-6)));
    if (s.use_reverse_frames) c = len - 1 - c;
    return c + s.animation_offset_start;
  }
  if (s.use_reverse_frames) local = n - 1 - local;
  if (s.strobe > 1) local = Math.floor(local / s.strobe) * Math.floor(s.strobe);
  return local + s.animation_offset_start;
}

/** Fade factor of transition effects at a frame (0 at the first frame). */
export function effectFac(s: Strip, frame: number) {
  if (!s.use_default_fade) return Math.max(0, Math.min(1, s.effect_fader));
  const len = finalDuration(s);
  if (len <= 0) return 0;
  return Math.max(0, Math.min(1, (frame - finalStart(s)) / len));
}

/** Timeline frame at which the input of a speed effect is evaluated. */
export function speedInputFrame(sp: Strip, input: Strip, frame: number): number {
  const local = frame - finalStart(sp);
  const len = Math.max(1, finalDuration(sp));
  let content: number;
  switch (sp.speed_control) {
    case 'MULTIPLY':
      content = finalStart(input) - input.frame_start + local * (sp.speed_factor ?? 1);
      break;
    case 'FRAME_NUMBER':
      content = sp.speed_frame_number ?? 0;
      break;
    case 'LENGTH':
      content = (local / len) * input.frame_duration * ((sp.speed_length ?? 100) / 100);
      break;
    default:
      // STRETCH: the whole input content plays over the effect's length
      content = (local / len) * input.frame_duration;
  }
  content = Math.max(0, Math.min(input.frame_duration - 1, Math.floor(content)));
  return input.frame_start + content;
}

/** Move a strip in time (meta children follow). */
export function translateStrip(s: Strip, df: number) {
  s.frame_start += df;
  // fade keys travel with the strip
  if (s.keys && df) for (const k of Object.values(s.keys)) for (const p of k ?? []) p[0] += df;
  if (s.strips) for (const c of s.strips) translateStrip(c, df);
}

// ---------------------------------------------------------------------------
// lists & lookup

export function allStrips(list: Strip[], out: Strip[] = []): Strip[] {
  for (const s of list) {
    out.push(s);
    if (s.strips) allStrips(s.strips, out);
  }
  return out;
}

export function findStrip(list: Strip[], name: string | null | undefined): Strip | null {
  if (!name) return null;
  for (const s of list) {
    if (s.name === name) return s;
    if (s.strips) {
      const r = findStrip(s.strips, name);
      if (r) return r;
    }
  }
  return null;
}

/** The list being edited (top level or the innermost meta of the meta stack). */
export function editList(ed: SequenceEditor): Strip[] {
  let list = ed.strips;
  for (const name of ed.meta_stack ?? []) {
    const m = list.find((s) => s.name === name && s.type === 'META');
    if (!m) break;
    list = m.strips ??= [];
  }
  return list;
}

/** Channel settings for the list being edited (metas have their own channels). */
export function editChannels(ed: SequenceEditor): SeqChannel[] {
  const stack = ed.meta_stack ?? [];
  if (!stack.length) return ed.channels;
  let list = ed.strips;
  let meta: Strip | undefined;
  for (const name of stack) {
    meta = list.find((s) => s.name === name && s.type === 'META');
    if (!meta) break;
    list = meta.strips ??= [];
  }
  if (!meta) return ed.channels;
  if (!meta.channels || meta.channels.length < MAX_CHANNELS + 1) meta.channels = newChannels();
  return meta.channels;
}

/** Unique strip name across the editor ("Color", "Color.001", …). */
export function uniqueName(ed: SequenceEditor | { strips: Strip[] }, base: string, taken: Set<string> = new Set(allStrips(ed.strips).map((s) => s.name))): string {
  const root = base.replace(/\.\d{3}$/, '');
  if (!taken.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${root}.${String(i).padStart(3, '0')}`;
    if (!taken.has(n)) return n;
  }
}

export function effectInputs(list: Strip[], s: Strip): Strip[] {
  const out: Strip[] = [];
  for (const n of [s.input_1, s.input_2]) {
    const i = n ? findStrip(list, n) : null;
    if (i) out.push(i);
  }
  return out;
}

/** Effects (directly or transitively) using any of `names` as input. */
export function dependentEffects(list: Strip[], names: Set<string>): Strip[] {
  const all = allStrips(list);
  const out = new Set<Strip>();
  let grew = true;
  const used = new Set(names);
  while (grew) {
    grew = false;
    for (const s of all) {
      if (out.has(s) || !inputCount(s.type)) continue;
      if ((s.input_1 && used.has(s.input_1)) || (s.input_2 && used.has(s.input_2))) {
        out.add(s);
        used.add(s.name);
        grew = true;
      }
    }
  }
  return [...out];
}

/** Effects with inputs span the intersection of their inputs. */
export function updateEffectRanges(list: Strip[]) {
  const all = allStrips(list);
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const s of all) {
      const n = inputCount(s.type);
      if (!n) continue;
      const ins = effectInputs(all, s);
      if (!ins.length) continue;
      const lo = Math.max(...ins.map(finalStart));
      const hi = Math.max(lo + 1, Math.min(...ins.map(finalEnd)));
      if (s.frame_start !== lo || s.frame_duration !== hi - lo || s.frame_offset_start || s.frame_offset_end) {
        s.frame_start = lo;
        s.frame_duration = hi - lo;
        s.frame_offset_start = s.frame_offset_end = 0;
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const s of list) if (s.type === 'META' && s.strips) updateEffectRanges(s.strips);
}

/** Recompute a meta strip's content range from its children (keeps trims inside). */
export function updateMetaBounds(meta: Strip) {
  const ch = meta.strips ?? [];
  if (!ch.length) return;
  const lo = Math.min(...ch.map(finalStart));
  const hi = Math.max(...ch.map(finalEnd));
  const a = finalStart(meta),
    b = finalEnd(meta);
  meta.frame_start = lo;
  meta.frame_duration = Math.max(1, hi - lo);
  meta.frame_offset_start = Math.max(0, Math.min(a - lo, meta.frame_duration - 1));
  meta.frame_offset_end = Math.max(0, Math.min(hi - b, meta.frame_duration - 1 - meta.frame_offset_start));
  if (a <= lo) meta.frame_offset_start = 0;
  if (b >= hi) meta.frame_offset_end = 0;
}

// ---------------------------------------------------------------------------
// stacking

/**
 * Strips that contribute pixels at `frame`, bottom channel first (the compositing order).
 * Muted strips, sound strips and strips in muted channels are skipped.
 */
export function renderStack(list: Strip[], channels: SeqChannel[] | undefined, frame: number): Strip[] {
  return list
    .filter((s) => isVisual(s) && !s.mute && !channels?.[s.channel]?.mute && activeAt(s, frame))
    .sort((a, b) => a.channel - b.channel);
}

export function channelLocked(channels: SeqChannel[] | undefined, s: Strip) {
  return !!channels?.[s.channel]?.lock;
}

// ---------------------------------------------------------------------------
// overlap

export function rangesOverlap(a0: number, a1: number, b0: number, b1: number) {
  return a0 < b1 && b0 < a1;
}

export function overlapsAny(list: Strip[], s: Strip, ignore: Set<Strip> = new Set()) {
  const a = finalStart(s),
    b = finalEnd(s);
  return list.some((o) => o !== s && !ignore.has(o) && o.channel === s.channel && rangesOverlap(a, b, finalStart(o), finalEnd(o)));
}

export function isFree(list: Strip[], channel: number, start: number, end: number, ignore: Set<Strip> = new Set()) {
  return !list.some((o) => !ignore.has(o) && o.channel === channel && rangesOverlap(start, end, finalStart(o), finalEnd(o)));
}

/** First channel ≥ `from` where [start, end) is free. */
export function freeChannel(list: Strip[], start: number, end: number, from = 1, ignore: Set<Strip> = new Set()) {
  for (let c = Math.max(1, from); c <= MAX_CHANNELS; c++) if (isFree(list, c, start, end, ignore)) return c;
  return MAX_CHANNELS;
}

/**
 * Resolve overlaps after transforming `moved` strips (overlap_mode):
 * SHUFFLE moves each overlapping transformed strip in time to the nearest free spot,
 * OVERWRITE trims/removes the strips underneath, EXPAND pushes later strips to the right.
 * Returns strips removed from the list (OVERWRITE).
 */
export function resolveOverlap(list: Strip[], moved: Strip[], mode: SequencerToolSettings['overlap_mode']): Strip[] {
  const set = new Set(moved);
  const removed: Strip[] = [];
  if (mode === 'OVERWRITE') {
    for (const m of moved) {
      const a = finalStart(m),
        b = finalEnd(m);
      for (const o of [...list]) {
        if (set.has(o) || o.channel !== m.channel) continue;
        const oa = finalStart(o),
          ob = finalEnd(o);
        if (!rangesOverlap(a, b, oa, ob)) continue;
        if (oa >= a && ob <= b) {
          list.splice(list.indexOf(o), 1);
          removed.push(o);
        } else if (oa < a && ob > b) {
          // split around the overwriting strip
          const right = cloneStrip(o, o.name + '.R');
          setRightHandle(o, a);
          setLeftHandle(right, b);
          list.push(right);
        } else if (oa < a) setRightHandle(o, a);
        else setLeftHandle(o, b);
      }
    }
    return removed;
  }
  if (mode === 'EXPAND') {
    for (const m of [...moved].sort((x, y) => finalStart(x) - finalStart(y))) {
      const a = finalStart(m),
        b = finalEnd(m);
      const hit = list.filter((o) => !set.has(o) && o.channel === m.channel && rangesOverlap(a, b, finalStart(o), finalEnd(o)));
      if (!hit.length) continue;
      const push = b - Math.min(...hit.map(finalStart));
      const from = Math.min(...hit.map(finalStart));
      for (const o of list) if (!set.has(o) && finalStart(o) >= from) translateStrip(o, push);
    }
    return removed;
  }
  // SHUFFLE (time)
  for (const m of moved) {
    if (!overlapsAny(list, m)) continue;
    const len = finalDuration(m);
    const others = list.filter((o) => o !== m && o.channel === m.channel).map((o) => [finalStart(o), finalEnd(o)] as const);
    const a0 = finalStart(m);
    // candidate positions: right after / right before each obstacle
    const cands = [...others.map(([, e]) => e), ...others.map(([s]) => s - len)];
    let best = Infinity,
      bestPos = a0;
    for (const c of cands) {
      if (others.some(([s, e]) => rangesOverlap(c, c + len, s, e))) continue;
      const d = Math.abs(c - a0);
      if (d < best) {
        best = d;
        bestPos = c;
      }
    }
    translateStrip(m, bestPos - a0);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// split

export function cloneStrip(s: Strip, name: string): Strip {
  const copy = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) return v; // media bytes are shared
    if (Array.isArray(v)) return v.map(copy);
    const o: Record<string, unknown> = {};
    for (const k in v as Record<string, unknown>) o[k] = copy((v as Record<string, unknown>)[k]);
    return o;
  };
  const c = copy(s) as Strip;
  c.name = name;
  return c;
}

/**
 * Split strips at `frame`. Soft split keeps the full content reachable from both halves (handles);
 * hard split cuts the content (animation offsets). Effects whose inputs are split are split too and
 * re-linked to the right halves. Returns the new right-hand strips.
 */
export function splitStrips(ed: { strips: Strip[] }, list: Strip[], targets: Strip[], frame: number, type: 'SOFT' | 'HARD'): Strip[] {
  frame = Math.round(frame);
  const taken = new Set(allStrips(ed.strips).map((s) => s.name));
  const renamed = new Map<string, string>();
  const out: Strip[] = [];
  const cut = targets.filter((s) => !inputCount(s.type) && finalStart(s) < frame && finalEnd(s) > frame);
  for (const s of cut) {
    const name = uniqueName(ed, s.name, taken);
    taken.add(name);
    const r = cloneStrip(s, name);
    // retimed content keeps its full range on both sides (handles), like a soft split
    if (type === 'HARD' && !isStill(s) && !hasRetiming(s)) {
      const leftLen = frame - s.frame_start;
      // left: content ends at the cut
      s.animation_offset_end += s.frame_duration - leftLen;
      s.frame_duration = leftLen;
      s.frame_offset_end = 0;
      // right: content starts at the cut
      r.animation_offset_start += leftLen;
      r.frame_start = frame;
      r.frame_duration -= leftLen;
      r.frame_offset_start = 0;
    } else {
      setRightHandle(s, frame);
      setLeftHandle(r, frame);
    }
    if (r.strips) {
      // meta: children are split as well
      const kids = r.strips;
      r.strips = [];
      const leftKids: Strip[] = [];
      for (const k of kids) {
        if (finalEnd(k) <= frame) leftKids.push(k);
        else if (finalStart(k) >= frame) r.strips.push(k);
        else {
          leftKids.push(k);
          r.strips.push(...splitStrips(ed, kids, [k], frame, type));
        }
      }
      s.strips = leftKids;
      // children of the right copy that were cloned need unique names
      for (const k of r.strips)
        if (leftKids.some((l) => l.name === k.name)) {
          const nn = uniqueName(ed, k.name, taken);
          taken.add(nn);
          k.name = nn;
        }
    }
    list.push(r);
    renamed.set(s.name, name);
    out.push(r);
  }
  // right halves stay connected to the right halves of their partners
  for (const r of out)
    if (r.connections) {
      const next = r.connections.map((n) => renamed.get(n)).filter((n): n is string => !!n);
      if (next.length) r.connections = next;
      else delete r.connections;
    }
  // effects depending on split strips
  for (const e of list) {
    if (!inputCount(e.type) || out.includes(e)) continue;
    const i1 = e.input_1 ? renamed.get(e.input_1) : undefined;
    const i2 = e.input_2 ? renamed.get(e.input_2) : undefined;
    if (!i1 && !i2) continue;
    if (!(finalStart(e) < frame && finalEnd(e) > frame)) {
      // the effect lies entirely on one side: re-link if it is on the right
      if (finalStart(e) >= frame) {
        if (i1) e.input_1 = i1;
        if (i2) e.input_2 = i2;
      }
      continue;
    }
    const name = uniqueName(ed, e.name, taken);
    taken.add(name);
    const r = cloneStrip(e, name);
    if (i1) r.input_1 = i1;
    if (i2) r.input_2 = i2;
    list.push(r);
    out.push(r);
  }
  updateEffectRanges(list);
  return out;
}

// ---------------------------------------------------------------------------
// snapping

/** Snap targets (frames) for a transform: other strips' edges, playhead, markers. */
export function snapTargets(list: Strip[], exclude: Set<Strip>, opts: { current?: number; markers?: number[]; ignoreMuted?: boolean; ignoreSound?: boolean }): number[] {
  const out = new Set<number>();
  for (const s of list) {
    if (exclude.has(s)) continue;
    if (opts.ignoreMuted && s.mute) continue;
    if (opts.ignoreSound && s.type === 'SOUND') continue;
    out.add(finalStart(s));
    out.add(finalEnd(s));
  }
  if (opts.current !== undefined) out.add(opts.current);
  for (const m of opts.markers ?? []) out.add(m);
  return [...out];
}

/** Smallest correction (frames) that brings one of `edges` onto a target within `threshold`. */
export function snapOffset(edges: number[], targets: number[], threshold: number): number | null {
  let best: number | null = null;
  for (const e of edges)
    for (const t of targets) {
      const d = t - e;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  return best;
}

// ---------------------------------------------------------------------------
// gaps

/** The gap at or after `frame`: [gap start, next strip start]. */
export function nextGap(list: Strip[], frame: number): [number, number] | null {
  const iv = list.map((s) => [finalStart(s), finalEnd(s)] as const).sort((a, b) => a[0] - b[0]);
  let prevEnd = -Infinity;
  for (const [a, b] of iv) {
    if (a > frame && a > prevEnd) {
      const gs = Math.max(prevEnd, frame);
      if (a > gs) return [gs, a];
    }
    prevEnd = Math.max(prevEnd, b);
  }
  return null;
}

/** Remove the gap at/after `frame` (or all following gaps) by moving later strips left. */
export function gapRemove(list: Strip[], frame: number, all: boolean): boolean {
  let any = false;
  for (let guard = 0; guard < 10000; guard++) {
    const gap = nextGap(list, frame);
    if (!gap) break;
    const d = gap[1] - gap[0];
    for (const s of list) if (finalStart(s) >= gap[1]) translateStrip(s, -d);
    any = true;
    if (!all) break;
    frame = gap[0];
  }
  return any;
}

export function gapInsert(list: Strip[], frame: number, frames: number) {
  for (const s of list) if (finalStart(s) >= frame) translateStrip(s, frames);
}

// ---------------------------------------------------------------------------
// meta strips

export function makeMeta(ed: SequenceEditor, list: Strip[], members: Strip[]): Strip | null {
  if (!members.length) return null;
  // effects need their inputs inside the meta too
  const names = new Set(members.map((s) => s.name));
  for (const e of dependentEffects(list, names)) if (list.includes(e)) members.push(e);
  const set = new Set(members);
  for (const s of members) for (const i of effectInputs(list, s)) if (!set.has(i) && list.includes(i)) members.push(i), set.add(i);
  const channel = Math.min(...members.map((s) => s.channel));
  const lo = Math.min(...members.map(finalStart));
  const hi = Math.max(...members.map(finalEnd));
  const meta = newStrip('META', uniqueName(ed, 'MetaStrip'), channel, lo, hi - lo);
  meta.strips = members;
  for (const s of members) {
    list.splice(list.indexOf(s), 1);
    s.select = false;
  }
  list.push(meta);
  meta.channel = freeChannel(list, lo, hi, channel, new Set([meta]));
  return meta;
}

/** Move a meta strip's children back into `list` (children outside the meta range are trimmed). */
export function separateMeta(list: Strip[], meta: Strip, overlapMode: SequencerToolSettings['overlap_mode'] = 'SHUFFLE'): Strip[] {
  const kids = meta.strips ?? [];
  list.splice(list.indexOf(meta), 1);
  const a = finalStart(meta),
    b = finalEnd(meta);
  const out: Strip[] = [];
  for (const k of kids) {
    if (finalEnd(k) <= a || finalStart(k) >= b) continue;
    if (!inputCount(k.type)) {
      if (finalStart(k) < a) setLeftHandle(k, a);
      if (finalEnd(k) > b) setRightHandle(k, b);
    }
    k.select = true;
    list.push(k);
    out.push(k);
  }
  updateEffectRanges(list);
  resolveOverlap(list, out, overlapMode);
  return out;
}

// ---------------------------------------------------------------------------
// time display

/** Ruler/time label: frames, or "MM:SS+FF" timecode when showing seconds. */
export function timecode(frame: number, fps: number, seconds: boolean): string {
  if (!seconds) return String(Math.round(frame));
  const f = Math.max(1, Math.round(fps));
  const neg = frame < 0;
  let n = Math.abs(Math.round(frame));
  const ff = n % f;
  n = Math.floor(n / f);
  const ss = n % 60;
  n = Math.floor(n / 60);
  const mm = n % 60;
  const hh = Math.floor(n / 60);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${neg ? '-' : ''}${hh ? `${p(hh)}:` : ''}${p(mm)}:${p(ss)}+${p(ff)}`;
}
