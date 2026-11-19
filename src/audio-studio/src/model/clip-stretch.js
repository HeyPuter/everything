// Clip stretching: pure state operations. A clip may carry
//
//   clip.stretch = { mode: 'realtime'|'rendered', ratio, semitones, formants, sourceId }
//
// where `ratio` is the new duration over the original (1.25 = 25% longer),
// `semitones` a pitch shift, `formants` keeps the voice character when the
// pitch moves, and `sourceId` the clip's original (unstretched) media.
//
// A stretched clip plays a derived pool source: its whole original source
// rendered at that ratio and pitch (see multitrack/stretch.js), with an id
// from stretchKey. Its offset and length are in the frames of that derived
// source, so trimming, splitting, slipping, looping and drawing work on a
// stretched clip exactly as on any other. Restretching maps the clip back to
// original frames through the old ratio and out again through the new one.
//
// No stretch (stretch null, or ratio 1 without a pitch shift) plays the
// original source. A clip may keep a mode with ratio 1 so that later stretches
// (Move tool corner handles) use that mode.

export const STRETCH_MODES = [
  { id: 'off', label: 'Off' },
  { id: 'realtime', label: 'Realtime' },
  { id: 'rendered', label: 'Rendered' },
];

/** Stretch ratio limits (10% .. 1000% of the original duration), matching Stretch and Pitch. */
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 10;

export const clampRatio = (r) => Math.max(MIN_RATIO, Math.min(MAX_RATIO, Number(r) || 1));

/** A clip's stretch settings with defaults filled in (mode 'off' when it has none). */
export function stretchOf(clip) {
  const s = clip.stretch;
  return {
    mode: s?.mode === 'realtime' || s?.mode === 'rendered' ? s.mode : 'off',
    ratio: s ? clampRatio(s.ratio) : 1,
    semitones: s ? Math.max(-24, Math.min(24, Math.round(Number(s.semitones) || 0))) : 0,
    formants: Boolean(s?.formants),
    sourceId: s?.sourceId || clip.sourceId,
  };
}

/** True when settings change the audio (a mode, and a ratio or pitch away from the original). */
export function stretchActive(s) {
  return Boolean(s) && s.mode !== 'off' && (Math.abs(s.ratio - 1) > 1e-6 || s.semitones !== 0);
}

/** True when the clip plays stretched (derived) audio. */
export const isStretched = (clip) => stretchActive(stretchOf(clip));

/** Pool id of the derived source for an original source and stretch settings. */
export function stretchKey(sourceId, s) {
  const q = s.mode === 'rendered' ? 'hq' : 'rt';
  return `${sourceId}~x${clampRatio(s.ratio).toFixed(6)}~p${s.semitones || 0}~f${s.formants ? 1 : 0}~${q}`;
}

/** The clip's range in its original source: { sourceId, offset, length } (frames, may be fractional). */
export function originalRange(clip) {
  const s = stretchOf(clip);
  const k = stretchActive(s) ? s.ratio : 1;
  return { sourceId: s.sourceId, offset: clip.offset / k, length: clip.length / k };
}

const scaleEnv = (points, k, length) => {
  if (!points.length || k === 1) return points;
  const out = points.map((p) => ({ ...p, t: Math.max(0, Math.min(length, Math.round(p.t * k))) }));
  return out.filter((p, i) => i === 0 || p.t !== out[i - 1].t || i === out.length - 1);
};

/**
 * The clip with new stretch settings (merged over its current ones). With
 * an active result the clip plays `derivedId`; otherwise its original source.
 * Mode 'off' removes the stretch. Duration, fades and envelopes scale with
 * the ratio; the clip keeps its start unless `patch.start` moves it.
 */
export function restretchClip(clip, patch, derivedId = null) {
  const cur = stretchOf(clip);
  const k0 = stretchActive(cur) ? cur.ratio : 1;
  const next = { ...cur, ...patch, sourceId: cur.sourceId };
  delete next.start;
  next.ratio = clampRatio(next.ratio);
  if (next.mode === 'off') Object.assign(next, { ratio: 1, semitones: 0, formants: false });
  const active = stretchActive(next);
  if (active && !derivedId) throw new Error('A stretched clip needs its derived source id.');
  const k1 = active ? next.ratio : 1;
  const scale = k1 / k0;
  const length = Math.max(1, Math.round((clip.length / k0) * k1));
  const offset = Math.max(0, Math.round((clip.offset / k0) * k1));
  const fade = (f) => ({ ...f, length: Math.min(length, Math.round(f.length * scale)) });
  return {
    ...clip,
    start: patch.start !== undefined ? Math.max(0, Math.round(patch.start)) : clip.start,
    sourceId: active ? derivedId : cur.sourceId,
    offset,
    length,
    fadeIn: fade(clip.fadeIn),
    fadeOut: fade(clip.fadeOut),
    volumeEnv: scaleEnv(clip.volumeEnv, scale, length),
    panEnv: scaleEnv(clip.panEnv, scale, length),
    fxEnv: Object.fromEntries(Object.entries(clip.fxEnv || {}).map(([k, v]) => [k, scaleEnv(v, scale, length)])),
    stretch: next.mode === 'off' ? null : next,
  };
}

/**
 * Applies stretch settings to clips in a state. `derived(sourceId, settings)`
 * returns the derived source id for an active stretch (and may start making
 * it). Locked clips keep their timing and are skipped.
 */
export function stretchClips(state, ids, patch, derived) {
  const set = new Set(ids);
  let changed = false;
  const clips = state.clips.map((c) => {
    if (!set.has(c.id) || (c.locked && (patch.ratio !== undefined || patch.start !== undefined))) return c;
    const p = typeof patch === 'function' ? patch(c) : patch;
    if (!p) return c;
    const cur = stretchOf(c);
    const next = { ...cur, ...p };
    if (next.mode === 'off') next.ratio = 1;
    const id = stretchActive({ ...next, ratio: clampRatio(next.ratio) }) ? derived(cur.sourceId, { ...next, ratio: clampRatio(next.ratio) }) : null;
    const n = restretchClip(c, p, id);
    changed = true;
    return n;
  });
  return changed ? { ...state, clips } : state;
}

/** Ids of original sources that stretched clips in `state` keep for restretching (what saves must keep). */
export function stretchOrigins(state) {
  const out = new Set();
  for (const c of state.clips) if (c.stretch?.sourceId && c.stretch.sourceId !== c.sourceId) out.add(c.stretch.sourceId);
  return out;
}
