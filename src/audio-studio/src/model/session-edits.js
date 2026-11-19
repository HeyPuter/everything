// Pure edit operations on multitrack session states. Every function returns a
// new state (or the input unchanged) and never mutates its arguments.
//
// State shape (times in frames at the session rate):
//   { sampleRate, bitDepth, tempo, beatsPerBar, metronome, metronomeSound?, metronomePattern?
//     (per beat 'down'|'up'|'sub'|'none', see session-graph metronomeBar), autoCrossfade,
//     tracks: Track[],          audio and bus tracks in display order
//     master: Track,            the master (mix) track
//     clips: Clip[],            flat list; clip.trackId says where it lives
//     markers: Marker[] }
// Track: { id, type: 'audio'|'bus'|'master', name, color, channels, volume (dB),
//   pan (-100..100), mute, solo, arm, monitor, input, output ('master' or a bus
//   id), fx: Effects Rack slots { id, effect, values, enabled } (nulls allowed), fxPower,
//   fxIn/fxOut (rack input/output gain, dB), fxMix (rack dry/wet, 0..1), invert
//   (polarity), mode ('off'|'read'|'write'|'latch'|'touch'),
//   automation: { volume: [{t, v dB}], pan: [{t, v}], mute: [{t, v 0|1}] } (a point with
//   `hold` keeps its value until the next point), showAutomation, lanes (parameters shown
//   as automation lanes, in order), laneHeight, autoParam (the first lane), height,
//   minimized, hidden }
// Clip: { id, trackId, sourceId, name, color, start, offset, length, gain (dB),
//   fadeIn/out: { length, curve, xf?, duration?, offset? } (see clip-fades.js), crossfade
//   ('symmetric'|'asymmetric'), volumeEnv: [{t, v dB}], panEnv: [{t, v}], volumeSpline,
//   panSpline (smooth curves through the envelope keyframes), fxEnv (clip effect setting
//   envelopes by fx.<slot>.<param>, clip-relative), channelMap ([l, r] source
//   channel indices the clip plays, or null),
//   mute, locked, loop, groupId, z, fx: clip effect slots { id, effect, values,
//   enabled } (Sound Assistant chains), soundAssistant: Sound Assistant settings or null,
//   stretch: time stretch and pitch settings or null (see clip-stretch.js),
//   remix: remix settings and segments or null (see clip-remix.js),
//   mergeLayout?: baked overlap geometry (see merge-layout.js) }
// Envelope times are relative to the clip start; fade curves follow
// mixcore.fadeShape (0 linear, > 0 logarithmic, < 0 exponential, 2 cosine).
// A fade's optional `xf` overrides automatic crossfading at that end (see
// overlapCrossfades).

import { copyMergeLayout, mergeScene, relocateMergeLayouts, splitMergeLayout, retargetSplitLayouts } from './merge-layout.js';
import { sliceFade, restartFade } from './clip-fades.js';
import { shiftMarkersForDelete } from './markers.js';

let counter = 0;
/** Unique id with a prefix; unique across sessions in this page. */
export function uid(prefix) {
  counter += 1;
  return `${prefix}${counter.toString(36)}${Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')}`;
}

/** Original track color palette (hex), cycled for new tracks. */
export const TRACK_COLORS = ['#3fb68b', '#4a90d9', '#d9a23f', '#c4584f', '#9a6fd1', '#3fb2c4', '#d16fa8', '#8bbf4a', '#d97a3f', '#6f7fd1', '#b5b54a', '#7a8a99'];

export const AUTOMATION_MODES = [
  { id: 'off', label: 'Off' },
  { id: 'read', label: 'Read' },
  { id: 'write', label: 'Write' },
  { id: 'latch', label: 'Latch' },
  { id: 'touch', label: 'Touch' },
];

/** dB value used for "silent" in envelopes and faders (JSON has no -Infinity). */
export const SILENT_DB = -96;
export const MAX_DB = 15;

export const FADE_CURVES = { linear: 0, log: 0.5, cosine: 2 };

/** Track parameters that can be automated, in menu order. */
export const AUTOMATION_PARAMS = [
  { id: 'volume', label: 'Volume' },
  { id: 'mute', label: 'Mute' },
  { id: 'pan', label: 'Pan' },
];

/** Default height of one automation lane (CSS px). */
export const LANE_HEIGHT = 46;

function copyFxEnv(e) {
  const out = {};
  for (const [k, v] of Object.entries(e || {})) if (fxParamRef(k) && Array.isArray(v) && v.length) out[k] = v.slice();
  return out;
}

/** A clip with `fn(points)` applied to each of its effect envelopes. */
export function mapFxEnv(c, fn) {
  if (!c.fxEnv || !Object.keys(c.fxEnv).length) return c.fxEnv || {};
  return Object.fromEntries(Object.entries(c.fxEnv).map(([k, v]) => [k, fn(v)]));
}

function copyLanes(a) {
  const out = {};
  for (const [k, v] of Object.entries(a || {})) if ((sendIndexOf(k) >= 0 || fxParamRef(k)) && Array.isArray(v)) out[k] = v.slice();
  return out;
}

/** Automation parameter of send `i` (0-based): its level, in dB. */
export const sendParam = (i) => `send${i + 1}`;

/** The send index (0-based) a parameter automates, or -1. */
export function sendIndexOf(param) {
  const m = /^send([1-8])$/.exec(param || '');
  return m ? Number(m[1]) - 1 : -1;
}

/**
 * Parameters a track can automate: volume, mute and pan (the master has no pan), and the level
 * of each routed send. `t` is a track, or just its type (then without sends).
 */
export function automationParams(t) {
  const type = typeof t === 'string' ? t : t.type;
  const base = AUTOMATION_PARAMS.filter((p) => type !== 'master' || p.id !== 'pan').map((p) => p.id);
  const sends = typeof t === 'string' ? [] : (t.sends || []).map((x, i) => (x?.target ? sendParam(i) : null)).filter(Boolean);
  return [...base, ...sends];
}

/** Automation parameter of an effect setting: `fx.<slot id>.<param id>` (the track's rack; slot `eq` is the track EQ). */
export const fxParam = (slotId, paramId) => `fx.${slotId}.${paramId}`;

/** { slotId, paramId } of an effect automation parameter, or null. */
export function fxParamRef(param) {
  const m = /^fx\.([^.]+)\.(.+)$/.exec(param || '');
  return m ? { slotId: m[1], paramId: m[2] } : null;
}

/** A parameter's own (unautomated) value: the switch, knob, send level or effect setting (undefined: its default). */
export function staticValue(t, param) {
  const ref = fxParamRef(param);
  if (ref) return (ref.slotId === 'eq' ? t.eq : t.fx?.find((x) => x?.id === ref.slotId))?.values?.[ref.paramId];
  const i = sendIndexOf(param);
  if (i >= 0) return t.sends?.[i]?.level ?? 0;
  return param === 'mute' ? Number(t.mute) : t[param];
}

function cleanLanes(type, lanes, first) {
  const ok = (p) => automationParams(type).includes(p) || (type !== 'master' && sendIndexOf(p) >= 0) || Boolean(fxParamRef(p));
  const list = (Array.isArray(lanes) && lanes.length ? lanes : [first || 'volume']).filter((p, i, a) => ok(p) && a.indexOf(p) === i);
  return list.length ? list : ['volume'];
}

/** Automation lanes shown under a track (none while its lanes are closed); lanes of removed sends drop out. */
export function trackLanes(t) {
  if (!t.showAutomation) return [];
  const has = (p) => {
    const ref = fxParamRef(p);
    if (ref) return ref.slotId === 'eq' || t.fx?.some((x) => x?.id === ref.slotId);
    return sendIndexOf(p) < 0 || Boolean(t.sends?.[sendIndexOf(p)]);
  };
  const list = (t.lanes || [t.type === 'master' ? 'volume' : t.autoParam || 'volume']).filter(has);
  return list.length ? list : ['volume'];
}

/** Sets the parameters shown as lanes (first one also becomes autoParam). */
export function setTrackLanes(state, trackId, lanes) {
  return updateTrack(state, trackId, (t) => {
    const list = cleanLanes(t.type, lanes, t.autoParam);
    return { lanes: list, autoParam: list[0] };
  });
}

/**
 * A smooth curve through envelope keyframes as dense breakpoints (monotone cubic, so it never
 * overshoots the keyframe values); segments after a hold point stay flat.
 */
export function splineEnvelope(points, steps = 16) {
  if (!points || points.length < 3) return points;
  const n = points.length;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((points[i + 1].v - points[i].v) / (points[i + 1].t - points[i].t || 1));
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const sq = a * a + b * b;
    if (sq > 9) {
      const tau = 3 / Math.sqrt(sq);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p = points[i];
    const q = points[i + 1];
    out.push(p);
    const h = q.t - p.t;
    if (p.hold || h < steps) continue;
    for (let k = 1; k < steps; k++) {
      const s = k / steps;
      const s2 = s * s;
      const s3 = s2 * s;
      const v = (2 * s3 - 3 * s2 + 1) * p.v + (s3 - 2 * s2 + s) * h * m[i] + (-2 * s3 + 3 * s2) * q.v + (s3 - s2) * h * m[i + 1];
      out.push({ t: Math.round(p.t + s * h), v });
    }
  }
  out.push(points[n - 1]);
  return out;
}

/** The shape a clip envelope plays: its keyframes, or the smooth curve through them. */
export function clipEnvelope(c, param) {
  return param === 'pan' ? (c.panSpline ? splineEnvelope(c.panEnv) : c.panEnv) : c.volumeSpline ? splineEnvelope(c.volumeEnv) : c.volumeEnv;
}

/** Mute automation always steps: every point holds until the next. */
export function muteSteps(points) {
  return points?.length && !points.every((p) => p.hold) ? points.map((p) => (p.hold ? p : { ...p, hold: true })) : points;
}

/**
 * Envelope points with every hold point turned into a step (an extra point just
 * before the next one), for consumers that only interpolate linearly.
 */
export function expandHolds(points) {
  if (!points?.some((p) => p.hold)) return points;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const next = points[i + 1];
    out.push(p.hold ? { t: p.t, v: p.v } : p);
    if (p.hold && next && next.t - 1 > p.t) out.push({ t: next.t - 1, v: p.v });
  }
  return out;
}

export function createTrack(o = {}) {
  const type = o.type || 'audio';
  return {
    id: o.id || uid(type === 'master' ? 'm' : 't'),
    type,
    name: o.name || (type === 'master' ? 'Mix' : type === 'bus' ? 'Bus' : 'Track'),
    color: o.color || TRACK_COLORS[0],
    channels: o.channels || 2,
    volume: o.volume ?? 0,
    pan: o.pan ?? 0,
    mute: Boolean(o.mute),
    solo: Boolean(o.solo),
    arm: Boolean(o.arm),
    monitor: Boolean(o.monitor),
    input: o.input || 'none',
    output: type === 'master' ? null : o.output || 'master',
    fx: o.fx ? o.fx.map((s) => (s ? { ...s, values: { ...(s.values || {}) } } : null)) : [],
    fxPower: o.fxPower ?? true,
    // Effects after the track volume and pan (post-fader) instead of before.
    fxPost: Boolean(o.fxPost),
    // Frozen: the clips and effects play from a pre-render (see multitrack/freeze.js).
    freeze: Boolean(o.freeze),
    fxIn: o.fxIn ?? 0,
    fxOut: o.fxOut ?? 0,
    fxMix: o.fxMix ?? 1,
    invert: Boolean(o.invert),
    mode: o.mode || 'read',
    // Send level lanes (send1..send8) and effect setting lanes (fx.<slot>.<param>) are kept too.
    automation: { ...copyLanes(o.automation), volume: (o.automation?.volume || []).slice(), pan: (o.automation?.pan || []).slice(), mute: (o.automation?.mute || []).slice() },
    showAutomation: Boolean(o.showAutomation),
    autoParam: o.autoParam || 'volume',
    lanes: cleanLanes(type, o.lanes, o.autoParam),
    laneHeight: o.laneHeight || LANE_HEIGHT,
    height: o.height || 124,
    minimized: Boolean(o.minimized),
    hidden: Boolean(o.hidden),
    // Empty entries (from sessions saved with gaps between sends) become unrouted sends.
    sends: type === 'master' ? [] : Array.from(o.sends || [], (x) => createSend(x || {})),
    eq: { on: Boolean(o.eq?.on), values: { ...(o.eq?.values || {}) } },
    // Surround panner settings for 5.1 sessions (see engine/surround.js); null = defaults.
    surround: o.surround ? { ...o.surround } : null,
  };
}

/** Most sends a track can have. */
export const MAX_SENDS = 8;

/**
 * A send feeds a copy of the track to a bus: `level` (dB), `pan` (-100..100),
 * taken before the track fader and pan (`pre`) or after them.
 */
export function createSend(o = {}) {
  return { id: o.id || uid('s'), target: o.target || null, level: o.level ?? 0, pan: o.pan ?? 0, pre: Boolean(o.pre), on: o.on ?? true };
}

export function createClip(o = {}) {
  return {
    id: o.id || uid('c'),
    trackId: o.trackId,
    sourceId: o.sourceId,
    name: o.name || 'Clip',
    color: o.color || null,
    start: Math.max(0, Math.round(o.start || 0)),
    offset: Math.max(0, Math.round(o.offset || 0)),
    length: Math.max(1, Math.round(o.length || 1)),
    gain: o.gain ?? 0,
    fadeIn: { length: 0, curve: 0, ...(o.fadeIn || {}) },
    fadeOut: { length: 0, curve: 0, ...(o.fadeOut || {}) },
    crossfade: o.crossfade || 'symmetric',
    volumeEnv: (o.volumeEnv || []).slice(),
    panEnv: (o.panEnv || []).slice(),
    // Clip effect envelopes: { 'fx.<slot id>.<param>': [{ t, v }] } for the clip's effect chain.
    fxEnv: copyFxEnv(o.fxEnv),
    // Envelopes drawn as smooth curves through their keyframes (see splineEnvelope).
    volumeSpline: Boolean(o.volumeSpline),
    panSpline: Boolean(o.panSpline),
    // Source channel routing: the source channel each clip channel plays (null = as recorded).
    channelMap: Array.isArray(o.channelMap) && o.channelMap.length === 2 ? o.channelMap.map((i) => Math.max(0, Math.round(Number(i) || 0))) : null,
    mute: Boolean(o.mute),
    locked: Boolean(o.locked),
    loop: Boolean(o.loop),
    groupId: o.groupId || null,
    // Loop-recorded takes of one pass share a take group (see selectTake).
    takeGroup: o.takeGroup || null,
    z: o.z || 0,
    ...(o.mergeLayout ? { mergeLayout: copyMergeLayout(o.mergeLayout) } : {}),
    fx: Array.isArray(o.fx) ? o.fx.filter(Boolean).map((x) => ({ ...x, values: { ...(x.values || {}) } })) : [],
    // `essential` is the name used by earlier versions.
    soundAssistant: structuredClone(o.soundAssistant || o.essential || null),
    // Time stretch and pitch (see clip-stretch.js); sourceId then names the original media.
    stretch: o.stretch ? { ...o.stretch } : null,
    // Remix (see clip-remix.js); sourceId then names the remixed media. A clip is never both.
    remix: o.remix?.segments?.length ? { ...o.remix, segments: o.remix.segments.map(([a, b]) => [a, b]) } : null,
  };
}

/**
 * A clip's frame positions and lengths at another sample rate (`r` = new rate / old rate): start,
 * offset and length, fades, envelopes (volume, pan, effects) and remix segments. Baked overlap
 * geometry is dropped (the destination works it out again).
 */
export function conformClip(c, r) {
  if (r === 1) return c;
  const f = (n) => Math.round(n * r);
  const fade = (x) => ({ ...x, length: f(x.length), ...(x.duration != null ? { duration: f(x.duration) } : {}), ...(x.offset != null ? { offset: f(x.offset) } : {}) });
  const env = (pts) => (pts || []).map((p) => ({ ...p, t: f(p.t) }));
  const { mergeLayout, ...rest } = c;
  return {
    ...rest,
    start: f(c.start),
    offset: f(c.offset),
    length: Math.max(1, f(c.length)),
    fadeIn: fade(c.fadeIn),
    fadeOut: fade(c.fadeOut),
    volumeEnv: env(c.volumeEnv),
    panEnv: env(c.panEnv),
    fxEnv: Object.fromEntries(Object.entries(c.fxEnv || {}).map(([k, v]) => [k, env(v)])),
    remix: c.remix ? { ...c.remix, target: c.remix.target != null ? f(c.remix.target) : c.remix.target, ...(c.remix.offset != null ? { offset: f(c.remix.offset) } : {}), ...(c.remix.length != null ? { length: f(c.remix.length) } : {}), segments: c.remix.segments.map(([a, b]) => [f(a), f(b)]) } : c.remix,
    soundAssistant: c.soundAssistant?.duration?.orig ? { ...c.soundAssistant, duration: { ...c.soundAssistant.duration, orig: { ...c.soundAssistant.duration.orig, offset: f(c.soundAssistant.duration.orig.offset || 0), length: f(c.soundAssistant.duration.orig.length || 0) } } } : c.soundAssistant,
  };
}

/** Remaps every audio reference when a clip moves between independent source pools. */
export function remapClipSources(c, ids) {
  const sourceId = (id) => id ? ids.get(id) : id;
  return {
    ...c,
    sourceId: sourceId(c.sourceId),
    stretch: c.stretch ? { ...c.stretch, sourceId: sourceId(c.stretch.sourceId) } : c.stretch,
    remix: c.remix ? { ...c.remix, sourceId: sourceId(c.remix.sourceId) } : c.remix,
    soundAssistant: c.soundAssistant?.duration?.orig ? {
      ...c.soundAssistant,
      duration: { ...c.soundAssistant.duration, orig: { ...c.soundAssistant.duration.orig, sourceId: sourceId(c.soundAssistant.duration.orig.sourceId) } },
    } : c.soundAssistant,
  };
}

/** A new session state with `tracks` stereo audio tracks and a stereo (or mono) master. */
export function createSessionState({ sampleRate = 48000, bitDepth = 32, tracks = 6, template, autoCrossfade = true, masterChannels = 2 } = {}) {
  let list;
  if (Array.isArray(template)) list = template.map((t, i) => createTrack({ color: TRACK_COLORS[i % TRACK_COLORS.length], ...t }));
  else list = Array.from({ length: tracks }, (_, i) => createTrack({ name: `Track ${i + 1}`, color: TRACK_COLORS[i % TRACK_COLORS.length] }));
  // Template tracks may name a bus by its name for their output and sends; saved templates also
  // give its position among the tracks (outputIndex, targetIndex), which tells same-named buses apart.
  const busId = (name) => list.find((b) => b.type === 'bus' && b.name === name)?.id;
  const busAt = (i, self) => (Number.isInteger(i) && list[i]?.type === 'bus' && list[i] !== self ? list[i].id : undefined);
  list.forEach((t, i) => {
    const raw = Array.isArray(template) ? template[i] : null;
    if (t.output !== 'master' && !list.some((b) => b.id === t.output)) t.output = busAt(raw?.outputIndex, t) || busId(t.output) || 'master';
    t.sends.forEach((x, k) => {
      if (x.target && !list.some((b) => b.id === x.target)) x.target = busAt(raw?.sends?.[k]?.targetIndex, t) || busId(x.target) || null;
    });
  });
  return {
    sampleRate,
    bitDepth,
    tempo: 120,
    beatsPerBar: 4,
    metronome: false,
    autoCrossfade,
    tracks: list,
    master: createTrack({ type: 'master', name: 'Mix', color: '#7a8a99', channels: masterChannels === 1 ? 1 : masterChannels === 6 ? 6 : 2 }),
    clips: [],
    markers: [],
  };
}

// ----------------------------------------------------------------- queries

export const clipEnd = (c) => c.start + c.length;

/** Timeline frame where the last clip (or range marker) ends. */
export function sessionLength(state) {
  let end = 0;
  for (const c of state.clips) end = Math.max(end, clipEnd(c));
  for (const m of state.markers || []) end = Math.max(end, m.start + m.duration);
  return end;
}

export function findTrack(state, id) {
  if (state.master && state.master.id === id) return state.master;
  return state.tracks.find((t) => t.id === id) || null;
}

export function findClip(state, id) {
  return state.clips.find((c) => c.id === id) || null;
}

export function clipsOnTrack(state, trackId) {
  return state.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
}

/** Every track in display order, master last. */
export function allTracks(state) {
  return [...state.tracks, state.master];
}

/** Ids of clips in the same groups as `ids` (clicking one grouped clip selects the group). */
export function expandGroups(state, ids) {
  const set = new Set(ids);
  const groups = new Set(state.clips.filter((c) => set.has(c.id) && c.groupId).map((c) => c.groupId));
  if (!groups.size) return [...set];
  for (const c of state.clips) if (c.groupId && groups.has(c.groupId)) set.add(c.id);
  return [...set];
}

/** Clips whose time range intersects [a, b), optionally only on some tracks. */
export function clipsInRange(state, a, b, trackIds = null) {
  const tracks = trackIds ? new Set(trackIds) : null;
  return state.clips.filter((c) => (!tracks || tracks.has(c.trackId)) && c.start < b && clipEnd(c) > a);
}

/**
 * Clips (all tracks, or one) on one side of frame `at`, in timeline order:
 * 'start' takes clips that begin before it, 'end' clips that end after it.
 */
export function clipsFrom(state, at, dir, trackId = null) {
  return state.clips
    .filter((c) => (!trackId || c.trackId === trackId) && (dir === 'start' ? c.start < at : clipEnd(c) > at))
    .sort((a, b) => a.start - b.start);
}

/** True when routing `trackId` to `output` would make a loop through buses. */
export function wouldCycle(state, trackId, output) {
  // Follow outputs and sends from the new destination; reaching the track is a loop.
  const stack = [output];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || cur === 'master' || seen.has(cur)) continue;
    if (cur === trackId) return true;
    seen.add(cur);
    const t = state.tracks.find((x) => x.id === cur);
    if (!t) continue;
    stack.push(t.output);
    for (const snd of t.sends || []) stack.push(snd?.target);
  }
  return false;
}

/** Replaces one send of a track (or adds it when `index` is past the end). */
export function setSend(state, trackId, index, patch) {
  return updateTrack(state, trackId, (t) => {
    // Sends before `index` that do not exist yet are added unrouted, so the list has no gaps.
    const sends = Array.from({ length: Math.max(index + 1, t.sends?.length || 0) }, (_, i) => t.sends?.[i] || createSend());
    sends[index] = createSend({ ...sends[index], ...patch });
    return { sends: sends.slice(0, MAX_SENDS) };
  });
}

export function removeSend(state, trackId, index) {
  return updateTrack(state, trackId, (t) => {
    // Later sends move up one place, and their automation lanes with them.
    const automation = {};
    for (const [k, v] of Object.entries(t.automation)) {
      const i = sendIndexOf(k);
      if (i < 0) automation[k] = v;
      else if (i > index) automation[sendParam(i - 1)] = v;
      else if (i < index) automation[k] = v;
    }
    const lanes = (t.lanes || []).flatMap((p) => {
      const i = sendIndexOf(p);
      return i < 0 || i < index ? [p] : i > index ? [sendParam(i - 1)] : [];
    });
    return { sends: (t.sends || []).filter((_, i) => i !== index), automation, lanes: lanes.length ? lanes : ['volume'] };
  });
}

// ------------------------------------------------------------------ tracks

export function addTrack(state, track, index = state.tracks.length) {
  const tracks = state.tracks.slice();
  tracks.splice(Math.max(0, Math.min(tracks.length, index)), 0, track);
  return { ...state, tracks };
}

export function updateTrack(state, id, patch) {
  const apply = (t) => ({ ...t, ...(typeof patch === 'function' ? patch(t) : patch) });
  if (state.master.id === id) return { ...state, master: apply(state.master) };
  if (!state.tracks.some((t) => t.id === id)) return state;
  return { ...state, tracks: state.tracks.map((t) => (t.id === id ? apply(t) : t)) };
}

export function removeTracks(state, ids) {
  const gone = new Set(ids);
  gone.delete(state.master.id);
  if (!gone.size) return state;
  const tracks = state.tracks
    .filter((t) => !gone.has(t.id))
    .map((t) => (gone.has(t.output) ? { ...t, output: 'master' } : t))
    // Sends to a removed bus go nowhere until pointed at another one.
    .map((t) => (t.sends?.some((x) => gone.has(x.target)) ? { ...t, sends: t.sends.map((x) => (gone.has(x.target) ? { ...x, target: null } : x)) } : t));
  return { ...state, tracks, clips: state.clips.filter((c) => !gone.has(c.trackId)) };
}

export function moveTrack(state, id, delta) {
  const i = state.tracks.findIndex((t) => t.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.tracks.length) return state;
  const tracks = state.tracks.slice();
  const [t] = tracks.splice(i, 1);
  tracks.splice(j, 0, t);
  return { ...state, tracks };
}

/** Moves a track to a new index (drag reordering). */
export function reorderTrack(state, id, index) {
  const i = state.tracks.findIndex((t) => t.id === id);
  if (i < 0) return state;
  return moveTrack(state, id, Math.max(0, Math.min(state.tracks.length - 1, index)) - i);
}

export function duplicateTrack(state, id) {
  const i = state.tracks.findIndex((t) => t.id === id);
  if (i < 0) return state;
  const src = state.tracks[i];
  const copy = createTrack({ ...src, id: undefined, name: `${src.name} Copy` });
  const original = state.clips.filter((c) => c.trackId === id);
  const clips = relocateMergeLayouts(original, original.map((c) => ({ ...c, id: uid('c'), trackId: copy.id, groupId: null })));
  const tracks = state.tracks.slice();
  tracks.splice(i + 1, 0, copy);
  return { ...state, tracks, clips: [...state.clips, ...clips] };
}

/** Audio tracks with no clips (bus and master tracks are kept). */
export function removeEmptyTracks(state) {
  const used = new Set(state.clips.map((c) => c.trackId));
  return removeTracks(state, state.tracks.filter((t) => t.type === 'audio' && !used.has(t.id)).map((t) => t.id));
}

// ------------------------------------------------------------------- clips

export function addClips(state, clips) {
  if (!clips.length) return state;
  return { ...state, clips: [...state.clips, ...clips] };
}

/**
 * Adds clips in front of the clips already there (keeping their order among
 * themselves), so audio just recorded, pasted or inserted over other clips is heard.
 */
export function addClipsOnTop(state, clips) {
  if (!clips.length) return state;
  const top = Math.max(0, ...state.clips.map((c) => c.z)) + 1;
  const low = Math.min(...clips.map((c) => c.z || 0));
  return addClips(state, relocateMergeLayouts(clips, clips.map((c) => ({ ...c, z: top + (c.z || 0) - low }))));
}

export function removeClips(state, ids) {
  const gone = new Set(ids);
  const clips = state.clips.filter((c) => !gone.has(c.id));
  return clips.length === state.clips.length ? state : { ...state, clips };
}

/** Patches clips (object or fn(clip) => patch). */
export function updateClips(state, ids, patch) {
  const set = new Set(ids);
  let changed = false;
  const clips = state.clips.map((c) => {
    if (!set.has(c.id)) return c;
    changed = true;
    return { ...c, ...(typeof patch === 'function' ? patch(c) : patch) };
  });
  return changed ? { ...state, clips } : state;
}

/** Audio tracks only (clips cannot live on buses or the master). */
export function audioTracks(state) {
  return state.tracks.filter((t) => t.type === 'audio');
}

/**
 * Moves clips by `dt` frames and `dTrack` positions among the shown (not
 * hidden) audio tracks. Locked clips stay, and clips on hidden tracks only move
 * in time. The move is clamped so no clip starts before 0 or leaves the shown audio tracks.
 */
export function moveClips(state, ids, dt, dTrack = 0, { copy = false } = {}) {
  const set = new Set(ids);
  const moving = state.clips.filter((c) => set.has(c.id) && !c.locked);
  if (!moving.length || (!dt && !dTrack && !copy)) return state;
  // Clips never land on hidden tracks, where they could not be seen.
  const audio = audioTracks(state).filter((t) => !t.hidden);
  const index = new Map(audio.map((t, i) => [t.id, i]));
  const minStart = Math.min(...moving.map((c) => c.start));
  dt = Math.max(-minStart, Math.round(dt));
  const idx = moving.filter((c) => index.has(c.trackId)).map((c) => index.get(c.trackId));
  dTrack = idx.length ? Math.max(-Math.min(...idx), Math.min(audio.length - 1 - Math.max(...idx), dTrack)) : 0;
  // Already at the start or at the top or bottom track: nothing moves.
  if (!dt && !dTrack && !copy) return state;
  // Moved and copied clips come to the front, as the clip you just placed should.
  const z = Math.max(0, ...state.clips.map((c) => c.z)) + 1;
  const moved = new Map();
  for (const c of moving) {
    const i = index.get(c.trackId);
    moved.set(c.id, { start: c.start + dt, trackId: i === undefined ? c.trackId : audio[i + dTrack].id, z });
  }
  if (copy) {
    // Copies keep their group relations among themselves.
    const groupMap = new Map();
    const copies = moving.map((c) => {
      let groupId = null;
      if (c.groupId) {
        if (!groupMap.has(c.groupId)) groupMap.set(c.groupId, uid('g'));
        groupId = groupMap.get(c.groupId);
      }
      return { ...c, ...moved.get(c.id), id: uid('c'), groupId };
    });
    return { ...state, clips: [...state.clips, ...relocateMergeLayouts(moving, copies)] };
  }
  if (!moving.some((c) => c.mergeLayout)) return { ...state, clips: state.clips.map((c) => (moved.has(c.id) ? { ...c, ...moved.get(c.id) } : c)) };
  const relocated = relocateMergeLayouts(moving, moving.map((c) => ({ ...c, ...moved.get(c.id) })));
  const byId = new Map(relocated.map((c) => [c.id, c]));
  return { ...state, clips: state.clips.map((c) => byId.get(c.id) || c) };
}

/** Splits an envelope at clip-relative frame `at` into [left, right(shifted)]. */
export function splitEnvelope(points, at, fallback) {
  if (!points || !points.length) return [[], []];
  const v = envelopeValue(points, at, fallback);
  const left = points.filter((p) => p.t < at);
  const right = points.filter((p) => p.t > at).map((p) => ({ ...p, t: p.t - at }));
  // Inside a held step the right part starts held too.
  const held = left.length && left[left.length - 1].hold ? { hold: true } : {};
  return [[...left, { t: at, v }], [{ t: 0, v, ...held }, ...right]];
}

/** Evaluates a breakpoint envelope (linear between points, flat after a hold point) at t. */
export function envelopeValue(points, t, fallback = 0) {
  if (!points || !points.length) return fallback;
  if (t <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  if (a.hold) return a.v;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t || 1);
}

/** Splits one clip at timeline frame `at`; returns [left, right] or null when `at` is not inside. */
export function splitClip(c, at) {
  at = Math.round(at);
  if (at <= c.start || at >= clipEnd(c)) return null;
  const cut = at - c.start;
  const [lv, rv] = splitEnvelope(c.volumeEnv, cut, 0);
  const [lp, rp] = splitEnvelope(c.panEnv, cut, 0);
  const fxParts = mapFxEnv(c, (pts) => splitEnvelope(pts, cut, pts[0]?.v ?? 0));
  const fxSide = (i) => Object.fromEntries(Object.entries(fxParts).map(([k, v]) => [k, v[i]]));
  const left = { ...c, length: cut, fadeOut: sliceFade(c.fadeOut, c.length - cut, c.length), fadeIn: sliceFade(c.fadeIn, 0, cut), volumeEnv: lv, panEnv: lp, fxEnv: fxSide(0) };
  const right = {
    ...c,
    id: uid('c'),
    start: at,
    offset: c.offset + cut,
    length: c.length - cut,
    fadeIn: sliceFade(c.fadeIn, cut, c.length),
    fadeOut: sliceFade(c.fadeOut, 0, c.length - cut),
    volumeEnv: rv,
    panEnv: rp,
    fxEnv: fxSide(1),
  };
  return splitMergeLayout(c, [left, right]);
}

/** Splits the given clips (or all clips when ids is null) at `at`. Locked clips are split too, as in most editors. */
export function splitClips(state, ids, at) {
  const set = ids ? new Set(ids) : null;
  let changed = false;
  const clips = [];
  const splits = new Map();
  for (const c of state.clips) {
    const parts = (!set || set.has(c.id)) && splitClip(c, at);
    if (parts) {
      clips.push(...parts);
      splits.set(c.id, { original: c, pieces: parts });
      changed = true;
    } else clips.push(c);
  }
  return changed ? { ...state, clips: retargetSplitLayouts(clips, splits) } : state;
}

/** Shifts envelope points by -d (the clip start moved right by d) and drops points before 0. */
function shiftEnvelope(points, d, length, fallback) {
  if (!points.length) return points;
  const v0 = envelopeValue(points, d, fallback);
  const v1 = envelopeValue(points, d + length, fallback);
  const inner = points.filter((p) => p.t > d && p.t < d + length).map((p) => ({ ...p, t: p.t - d }));
  const before = points.filter((p) => p.t <= d);
  const held = before.length && before[before.length - 1].hold ? { hold: true } : {};
  return [{ t: 0, v: v0, ...held }, ...inner, { t: length, v: v1 }];
}

/**
 * Trims one clip edge to timeline frame `frame`. `sourceLength` is the source
 * length in frames (looped clips may extend past it).
 */
export function trimClip(state, id, edge, frame, sourceLength = Infinity) {
  const c = findClip(state, id);
  const next = c && trimmedClip(c, edge, frame, sourceLength);
  if (!next || next === c) return state;
  return { ...state, clips: state.clips.map((x) => (x.id === id ? next : x)) };
}

/** A clip with one edge trimmed to timeline frame `frame` (see trimClip); the same clip when nothing changes. */
export function trimmedClip(c, edge, frame, sourceLength = Infinity) {
  if (c.locked) return c;
  frame = Math.round(frame);
  let next;
  if (edge === 'in') {
    const minStart = c.loop ? 0 : c.start - c.offset;
    const s = Math.max(Math.max(0, minStart), Math.min(clipEnd(c) - 1, frame));
    const d = s - c.start;
    if (!d) return c;
    let offset = c.offset + d;
    if (c.loop && offset < 0 && Number.isFinite(sourceLength)) offset = ((offset % sourceLength) + sourceLength) % sourceLength;
    const length = c.length - d;
    next = {
      ...c,
      start: s,
      offset: Math.max(0, offset),
      length,
      fadeIn: { ...c.fadeIn, length: Math.min(c.fadeIn.length, length) },
      fadeOut: { ...c.fadeOut, length: Math.min(c.fadeOut.length, length) },
      volumeEnv: d > 0 ? shiftEnvelope(c.volumeEnv, d, length, 0) : c.volumeEnv.map((p) => ({ ...p, t: p.t - d })),
      panEnv: d > 0 ? shiftEnvelope(c.panEnv, d, length, 0) : c.panEnv.map((p) => ({ ...p, t: p.t - d })),
      fxEnv: mapFxEnv(c, (pts) => (d > 0 ? shiftEnvelope(pts, d, length, pts[0]?.v ?? 0) : pts.map((p) => ({ ...p, t: p.t - d })))),
    };
  } else {
    const maxEnd = c.loop ? Infinity : c.start + Math.max(1, sourceLength - c.offset);
    const e = Math.max(c.start + 1, Math.min(maxEnd, frame));
    if (e === clipEnd(c)) return c;
    const length = e - c.start;
    next = {
      ...c,
      length,
      fadeIn: { ...c.fadeIn, length: Math.min(c.fadeIn.length, length) },
      fadeOut: { ...c.fadeOut, length: Math.min(c.fadeOut.length, length) },
      volumeEnv: length < c.length ? shiftEnvelope(c.volumeEnv, 0, length, 0) : c.volumeEnv,
      panEnv: length < c.length ? shiftEnvelope(c.panEnv, 0, length, 0) : c.panEnv,
      fxEnv: length < c.length ? mapFxEnv(c, (pts) => shiftEnvelope(pts, 0, length, pts[0]?.v ?? 0)) : c.fxEnv,
    };
  }
  return next;
}

/** Trims one edge of several clips to timeline frame `frame` (`sourceLength(sourceId)` as in trimClip). */
export function trimClipsAt(state, ids, edge, frame, sourceLength = () => Infinity) {
  const set = new Set(ids);
  let changed = false;
  const clips = state.clips.map((c) => {
    if (!set.has(c.id)) return c;
    const next = trimmedClip(c, edge, frame, sourceLength(c.sourceId));
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...state, clips } : state;
}

/**
 * Turns looping on or off. A clip that stops looping starts where its loop was
 * at its start (a looped clip's offset may lie past the source end, e.g. the
 * right part of a split loop) and ends where its source does.
 */
export function setClipsLoop(state, ids, loop, sourceLength = () => Infinity) {
  return updateClips(state, ids, (c) => {
    const n = sourceLength(c.sourceId);
    if (loop || !c.loop || !(n > 0) || !Number.isFinite(n)) return { loop };
    const next = trimmedClip({ ...c, loop: false, locked: false, offset: c.offset % n }, 'out', clipEnd(c), n);
    return { ...next, locked: c.locked };
  });
}

/** Slips the audio inside a clip by `delta` frames (positive moves the audio right). */
export function slipClip(state, id, delta, sourceLength = Infinity) {
  const c = findClip(state, id);
  if (!c || c.locked) return state;
  let offset = c.offset - Math.round(delta);
  if (c.loop && Number.isFinite(sourceLength) && sourceLength > 0) offset = ((offset % sourceLength) + sourceLength) % sourceLength;
  else offset = Math.max(0, Math.min(Math.max(0, sourceLength - c.length), offset));
  if (offset === c.offset) return state;
  return { ...state, clips: state.clips.map((x) => (x.id === id ? { ...x, offset } : x)) };
}

/** Trims clips to [a, b) (clips outside the range are left alone). */
export function trimClipsToRange(state, ids, a, b, sourceLength = () => Infinity) {
  const set = new Set(ids);
  let changed = false;
  const clips = state.clips.map((c) => {
    if (!set.has(c.id) || c.locked || clipEnd(c) <= a || c.start >= b) return c;
    let next = c.start < a ? trimmedClip(c, 'in', a, sourceLength(c.sourceId)) : c;
    if (clipEnd(next) > b) next = trimmedClip(next, 'out', b, sourceLength(next.sourceId));
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...state, clips } : state;
}

/**
 * Removes [a, b) from clips (by id, or every clip on `trackIds`, or all), without
 * moving anything else: clips are split and the inside parts dropped.
 */
export function removeTimeFromClips(state, a, b, { ids = null, trackIds = null } = {}) {
  if (b <= a) return state;
  const idSet = ids ? new Set(ids) : null;
  const trackSet = trackIds ? new Set(trackIds) : null;
  const out = [];
  let changed = false;
  for (const c of state.clips) {
    const hit = (!idSet || idSet.has(c.id)) && (!trackSet || trackSet.has(c.trackId)) && c.start < b && clipEnd(c) > a;
    if (!hit) {
      out.push(c);
      continue;
    }
    changed = true;
    let left = null;
    let right = null;
    if (c.start < a) left = splitClip(c, a)[0];
    if (clipEnd(c) > b) {
      const parts = splitClip(c, b);
      right = parts ? parts[1] : null;
    }
    if (left) out.push(left);
    if (right) out.push(left ? right : { ...right, id: c.id });
  }
  return changed ? { ...state, clips: out } : state;
}

/**
 * A track automation lane with timeline range [a, b) removed: later points move
 * left by b - a, and the lane keeps its values on both sides of the cut.
 */
export function removeTimeFromLane(points, a, b) {
  if (!points?.length || b <= a || points[points.length - 1].t < a) return points;
  const cut = b - a;
  const out = points.filter((p) => p.t < a);
  // The value just before the cut, then the value from b on (where later audio now plays).
  if (a > 0 && (!out.length || out[out.length - 1].t < a - 1)) out.push({ t: a - 1, v: envelopeValue(points, a - 1) });
  const after = points.filter((p) => p.t >= b).map((p) => ({ ...p, t: p.t - cut }));
  if (!after.length || after[0].t > a) out.push({ t: a, v: envelopeValue(points, b) });
  return [...out, ...after];
}

/** Track automation lanes with [a, b) removed on the tracks for which `hit(track)` is true. */
function rippleAutomation(state, a, b, hit) {
  const shift = (t) => {
    if (!hit(t)) return t;
    let automation = t.automation;
    for (const [param, points] of Object.entries(t.automation)) {
      const next = removeTimeFromLane(points, a, b);
      if (next !== points) automation = { ...automation, [param]: next };
    }
    return automation === t.automation ? t : { ...t, automation };
  };
  return { ...state, tracks: state.tracks.map(shift), master: shift(state.master) };
}

/**
 * Ripple delete of time [a, b): removes the range from clips on the tracks
 * (all tracks when trackIds is null, or only clips in `ids`) and pulls later
 * material on those tracks left. Markers shift when every track ripples. Track
 * automation follows on the tracks that ripple (not when only clips do).
 */
export function rippleDeleteTime(state, a, b, { trackIds = null, ids = null } = {}) {
  a = Math.round(a);
  b = Math.round(b);
  if (b <= a) return state;
  const cut = b - a;
  let s = removeTimeFromClips(state, a, b, { ids, trackIds });
  const chosen = ids ? new Set(ids) : null;
  const trackSet = trackIds ? new Set(trackIds) : ids ? new Set(state.clips.filter((c) => chosen.has(c.id)).map((c) => c.trackId)) : null;
  // The chosen clips and the parts split from them (new ids).
  const before = ids ? new Set(state.clips.map((c) => c.id)) : null;
  const idSet = ids ? new Set(s.clips.filter((c) => chosen.has(c.id) || !before.has(c.id)).map((c) => c.id)) : null;
  s = {
    ...s,
    clips: s.clips.map((c) => {
      if (trackSet && !trackSet.has(c.trackId)) return c;
      if (idSet && !idSet.has(c.id)) return c;
      return c.start >= b ? { ...c, start: c.start - cut } : c;
    }),
  };
  if (!trackIds && !ids) s = { ...s, markers: shiftMarkersForDelete(s.markers, a, b) };
  if (!ids) s = rippleAutomation(s, a, b, (t) => !trackSet || trackSet.has(t.id));
  return s;
}

/** Removes clips and closes the gaps they leave on their tracks. */
export function rippleDeleteClips(state, ids) {
  const set = new Set(ids);
  const gone = state.clips.filter((c) => set.has(c.id)).sort((x, y) => x.start - y.start);
  if (!gone.length) return state;
  // The time each track loses: the removed clips merged, so overlapping ones close their gap once.
  const cuts = new Map();
  for (const g of gone) {
    const list = cuts.get(g.trackId) || [];
    const last = list[list.length - 1];
    if (last && g.start <= last[1]) last[1] = Math.max(last[1], clipEnd(g));
    else list.push([g.start, clipEnd(g)]);
    cuts.set(g.trackId, list);
  }
  const clips = state.clips
    .filter((c) => !set.has(c.id))
    .map((c) => {
      if (c.locked || !cuts.has(c.trackId)) return c;
      // Only material that starts at or after a removed range's end moves.
      let shift = 0;
      for (const [a, b] of cuts.get(c.trackId)) if (c.start >= b) shift += b - a;
      return shift ? { ...c, start: c.start - shift } : c;
    });
  // Each track's automation closes the same gaps (latest first, so earlier ranges keep their place).
  let next = { ...state, clips };
  for (const [trackId, ranges] of cuts) {
    for (const [a, b] of ranges.slice().reverse()) next = rippleAutomation(next, a, b, (t) => t.id === trackId);
  }
  return next;
}

/** The empty gap on a track around frame `at`: [start, end) or null. */
export function gapAt(state, trackId, at) {
  const clips = clipsOnTrack(state, trackId);
  let start = 0;
  for (const c of clips) {
    if (at >= c.start && at < clipEnd(c)) return null;
    if (clipEnd(c) <= at) start = Math.max(start, clipEnd(c));
  }
  const next = clips.find((c) => c.start > at);
  if (!next) return null;
  return [start, next.start];
}

export function rippleDeleteGap(state, trackId, at) {
  const gap = gapAt(state, trackId, at);
  if (!gap) return state;
  const [a, b] = gap;
  const s = { ...state, clips: state.clips.map((c) => (c.trackId === trackId && c.start >= b ? { ...c, start: c.start - (b - a) } : c)) };
  return rippleAutomation(s, a, b, (t) => t.id === trackId);
}

// ------------------------------------------------------------- fades, env

export function setFade(state, ids, dir, patch) {
  const key = dir === 'in' ? 'fadeIn' : 'fadeOut';
  return updateClips(state, ids, (c) => {
    const f = { ...restartFade(c[key]), ...patch };
    f.length = Math.max(0, Math.min(c.length, Math.round(f.length)));
    return { [key]: f };
  });
}

/** Default fade length when a shape is chosen for a clip without a fade. */
export function defaultFadeLength(clip, rate) {
  return Math.round(Math.min(rate * 0.5, clip.length / 4));
}

/** Sorted, de-duplicated copy of envelope points clamped to [0, length]. */
export function normalizeEnvelope(points, length) {
  const out = points
    .map((p) => ({ t: Math.max(0, Math.min(length, Math.round(p.t))), v: p.v, ...(p.hold ? { hold: true } : {}) }))
    .sort((a, b) => a.t - b.t);
  return out.filter((p, i) => i === 0 || p.t !== out[i - 1].t || i === out.length - 1);
}

export function setClipEnvelope(state, id, param, points) {
  if (fxParamRef(param)) {
    // An emptied effect envelope goes away (the effect keeps its own setting).
    return updateClips(state, [id], (c) => {
      const fxEnv = { ...(c.fxEnv || {}) };
      if (points.length) fxEnv[param] = normalizeEnvelope(points, c.length);
      else delete fxEnv[param];
      return { fxEnv };
    });
  }
  const key = param === 'pan' ? 'panEnv' : 'volumeEnv';
  return updateClips(state, [id], (c) => ({ [key]: normalizeEnvelope(points, c.length) }));
}

/** A clip envelope's points by parameter: volume, pan or an effect setting. */
export function clipEnvPoints(c, param) {
  if (param === 'pan') return c.panEnv;
  if (param === 'volume') return c.volumeEnv;
  return c.fxEnv?.[param] || [];
}

/**
 * Adds a keyframe to an envelope. An empty envelope first gets implicit end
 * points at its default value so the new point bends it instead of moving it.
 * Returns { points, index } of the new point.
 */
export function insertEnvelopePoint(points, t, v, length, fallback) {
  let list = points.slice();
  if (!list.length && length != null) list = [{ t: 0, v: fallback }, { t: length, v: fallback }];
  list.push({ t: Math.round(t), v });
  list.sort((a, b) => a.t - b.t);
  return { points: list, index: list.findIndex((p) => p.t === Math.round(t) && p.v === v) };
}

/**
 * Fewer keyframes for the same shape: drops points that lie within `tol` (in value units) of the
 * straight line between the points kept around them (Douglas-Peucker on the value). The first
 * and last points and hold points always stay.
 */
export function thinEnvelope(points, tol) {
  if (!points || points.length < 3 || !(tol > 0)) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  points.forEach((p, i) => p.hold && (keep[i] = 1));
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const pa = points[a];
    const pb = points[b];
    let worst = -1;
    let far = tol;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const line = pb.t === pa.t ? pa.v : pa.v + ((pb.v - pa.v) * (p.t - pa.t)) / (pb.t - pa.t);
      const d = Math.abs(p.v - line);
      if (d > far) {
        far = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Track automation under moved clips (from `before` to `after`) moves with them: the keyframes over
 * each clip's old span (with its edge values) are shifted by the clip's move, replacing what was at
 * the destination. A clip moved to another track takes them to that track's matching lanes (the
 * same parameter: volume, pan, mute, a routed send of the same number, the same effect slot);
 * lanes the destination does not have stay where they were.
 */
export function carryAutomation(before, after, ids) {
  let state = after;
  for (const id of ids) {
    const a = findClip(before, id);
    const b = findClip(after, id);
    if (!a || !b || (b.start === a.start && b.trackId === a.trackId)) continue;
    const from = findTrack(state, a.trackId);
    const to = findTrack(state, b.trackId);
    if (!from || !to) continue;
    const span = { a: a.start, b: clipEnd(a), dt: b.start - a.start };
    const fromLanes = { ...from.automation };
    const toLanes = from.id === to.id ? fromLanes : { ...to.automation };
    for (const [param, pts] of Object.entries(from.automation)) {
      if (!pts?.length || !hasLane(to, param)) continue;
      const own = staticValue(from, param);
      const edge = (at) => ({ t: at, v: envelopeValue(pts, at, own), ...(pts.filter((p) => p.t <= at).pop()?.hold ? { hold: true } : {}) });
      const moved = [edge(span.a), ...pts.filter((p) => p.t > span.a && p.t < span.b), edge(span.b)].map((p) => ({ ...p, t: p.t + span.dt }));
      const to0 = span.a + span.dt;
      const to1 = span.b + span.dt;
      // The vacated span keeps the values around it; the destination takes the moved shape.
      fromLanes[param] = pts.filter((p) => p.t < span.a || p.t > span.b);
      const dest = toLanes[param] || [];
      toLanes[param] = [...dest.filter((p) => p.t < to0 || p.t > to1), ...moved].sort((x, y) => x.t - y.t);
      if (from.id === to.id) fromLanes[param] = toLanes[param];
    }
    state = updateTrack(state, from.id, { automation: fromLanes });
    if (from.id !== to.id) state = updateTrack(state, to.id, { automation: toLanes });
  }
  return state;
}

/** Whether a track has a lane for `param` (a routed send of that number, or that effect slot). */
function hasLane(t, param) {
  const ref = fxParamRef(param);
  if (ref) return ref.slotId === 'eq' ? Boolean(t.eq) : Boolean(t.fx?.some((x) => x?.id === ref.slotId));
  const i = sendIndexOf(param);
  if (i >= 0) return Boolean(t.sends?.[i]?.target);
  return ['volume', 'pan', 'mute'].includes(param) && (t.type !== 'master' || param !== 'pan');
}

/** Writes recorded automation: replaces points in [t0, t1] with `recorded`. */
export function writeEnvelopeRange(points, t0, t1, recorded) {
  const keep = points.filter((p) => p.t < t0 || p.t > t1);
  return [...keep, ...recorded].sort((a, b) => a.t - b.t);
}

export function setAutomation(state, trackId, param, points) {
  return updateTrack(state, trackId, (t) => ({ automation: { ...t.automation, [param]: points.slice().sort((a, b) => a.t - b.t) } }));
}

// ------------------------------------------------------------- crossfades

const overlapScene = (state) => state.clips.some((c) => c.mergeLayout) ? mergeScene(state.clips) : null;

/**
 * Overlaps between clips on the same track. Each entry is
 * { trackId, out: clipId fading out, in: clipId fading in, start, end }.
 * Only partial overlaps crossfade; a clip wholly inside another does not.
 */
export function crossfades(state, scene = overlapScene(state)) {
  const out = [];
  const byTrack = new Map();
  for (const c of scene?.list || state.clips) {
    if (c.mute) continue;
    if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
    byTrack.get(c.trackId).push(c);
  }
  for (const [trackId, clips] of byTrack) {
    clips.sort((a, b) => a.start - b.start || clipEnd(a) - clipEnd(b));
    for (let i = 0; i < clips.length; i++) {
      for (let j = i + 1; j < clips.length; j++) {
        const a = clips[i];
        const b = clips[j];
        if (b.start >= clipEnd(a)) break;
        if (clipEnd(b) <= clipEnd(a) || b.start === a.start) continue; // containment
        if (scene && !scene.interacts(a, b)) continue;
        out.push({ trackId, out: a.id, in: b.id, start: b.start, end: clipEnd(a) });
      }
    }
  }
  return out;
}

/**
 * Whether an overlap between `outClip` (fading out) and `inClip` crossfades.
 * A fade end may say so explicitly with `xf`: false ("No Fade" / plain fade:
 * the front clip hides the rear one) wins over true ("Crossfade"), and
 * either wins over the session's automatic crossfade setting.
 */
export function overlapCrossfades(state, outClip, inClip) {
  const a = outClip?.fadeOut?.xf;
  const b = inClip?.fadeIn?.xf;
  if (a === false || b === false) return false;
  if (a === true || b === true) return true;
  return state.autoCrossfade !== false;
}

/** Overlaps that are heard as crossfades (see crossfades and overlapCrossfades). */
export function activeCrossfades(state, scene = overlapScene(state)) {
  const byId = new Map((scene?.list || state.clips).map((c) => [c.id, c]));
  return crossfades(state, scene).filter((x) => overlapCrossfades(state, byId.get(x.out), byId.get(x.in)));
}

/** How a clip end sounds: 'crossfade' (with an overlapping clip), 'fade' or 'none'. */
export function fadeMode(state, clip, dir, active = activeCrossfades(state)) {
  if (active.some((x) => (dir === 'in' ? x.in : x.out) === clip.id)) return 'crossfade';
  return (dir === 'in' ? clip.fadeIn : clip.fadeOut).length > 0 ? 'fade' : 'none';
}

/**
 * Sets one end of clips to 'none' (no fade), 'fade' (a plain fade of the
 * current or default length) or 'crossfade' (with the clips overlapping that
 * end, which are marked to crossfade too). Clips without an overlap on that
 * end are left alone by 'crossfade'.
 */
export function setFadeMode(state, ids, dir, mode) {
  const key = dir === 'in' ? 'fadeIn' : 'fadeOut';
  const other = dir === 'in' ? 'fadeOut' : 'fadeIn';
  const scene = overlapScene(state);
  const byId = new Map((scene?.list || state.clips).map((c) => [c.id, c]));
  // Overlaps at that end of each clip.
  const overlaps = new Map();
  for (const x of crossfades(state, scene)) {
    const id = dir === 'in' ? x.in : x.out;
    if (!overlaps.has(id)) overlaps.set(id, []);
    overlaps.get(id).push(x);
  }
  const patches = new Map();
  const patch = (id, k, f) => patches.set(id, { ...patches.get(id), [k]: f });
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) continue;
    const mine = overlaps.get(id) || [];
    const f = restartFade(c[key]);
    if (mode === 'crossfade') {
      if (!mine.length) continue;
      f.xf = true;
      patch(id, key, f);
      for (const x of mine) {
        const n = dir === 'in' ? x.out : x.in;
        patch(n, other, { ...restartFade(patches.get(n)?.[other] || byId.get(n)[other]), xf: true });
      }
      continue;
    }
    if (mode === 'none') f.length = 0;
    else if (!f.length) f.length = defaultFadeLength(c, state.sampleRate);
    // Only an overlapping end needs to say "no crossfade"; elsewhere the session setting applies later.
    if (mine.length) f.xf = false;
    else delete f.xf;
    patch(id, key, f);
  }
  // A baked partner has geometry but no separate audio clip. Its fade mode
  // still controls the live neighbor, so keep edits in that owner's layout.
  for (const [id, patch] of [...patches]) {
    const ghost = scene?.ghosts.get(id);
    if (!ghost) continue;
    const owner = byId.get(ghost.owner);
    const layout = patches.get(owner.id)?.mergeLayout || owner.mergeLayout;
    const layers = layout.layers.map((layer, index) => index === ghost.index ? { ...layer, ...patch } : layer);
    patches.set(owner.id, { ...patches.get(owner.id), mergeLayout: { ...layout, layers } });
    patches.delete(id);
  }
  return patches.size ? updateClips(state, [...patches.keys()], (c) => patches.get(c.id)) : state;
}

/** Front-to-back order of clips on a track: higher z first, then later in the list. */
export function frontOrder(state) {
  const order = new Map();
  state.clips.forEach((c, i) => order.set(c.id, c.z * 1e6 + i));
  return order;
}

export function bringToFront(state, ids) {
  const z = Math.max(0, ...state.clips.map((c) => c.z)) + 1;
  return updateClips(state, ids, { z });
}

export function sendToBack(state, ids) {
  const z = Math.min(0, ...state.clips.map((c) => c.z)) - 1;
  return updateClips(state, ids, { z });
}

/** The clips of a take group, oldest take first. */
export function takeClips(state, group) {
  return group ? state.clips.filter((c) => c.takeGroup === group) : [];
}

/** Plays take `id` of its group: it is unmuted and brought to the front, the other takes muted. */
export function selectTake(state, id) {
  const c = findClip(state, id);
  if (!c?.takeGroup) return state;
  const others = takeClips(state, c.takeGroup).filter((x) => x.id !== id).map((x) => x.id);
  return bringToFront(updateClips(updateClips(state, others, { mute: true }), [id], { mute: false }), [id]);
}

export function groupClips(state, ids) {
  if (ids.length < 2) return state;
  const g = uid('g');
  return updateClips(state, ids, { groupId: g });
}

export function ungroupClips(state, ids) {
  const set = new Set(ids);
  const groups = new Set(state.clips.filter((c) => set.has(c.id) && c.groupId).map((c) => c.groupId));
  return updateClips(
    state,
    state.clips.filter((c) => groups.has(c.groupId)).map((c) => c.id),
    { groupId: null },
  );
}

/** Takes one clip out of its group; a group left with a single clip dissolves. */
export function removeFromGroup(state, id) {
  const c = findClip(state, id);
  if (!c?.groupId) return state;
  const rest = state.clips.filter((x) => x.groupId === c.groupId && x.id !== id);
  return updateClips(state, rest.length < 2 ? [id, ...rest.map((x) => x.id)] : [id], { groupId: null });
}

/**
 * Silences timeline range [a, b) inside clips with their volume envelopes,
 * without splitting them: the envelope drops to silence over `ramp` frames at
 * each edge (so there is no click) and keeps its shape outside the range.
 */
export function silenceClipsRange(state, ids, a, b, ramp = 0) {
  a = Math.round(a);
  b = Math.round(b);
  // At least one frame so the edge of the silence is a ramp, not two points at one time.
  ramp = Math.max(1, Math.round(ramp));
  if (b <= a) return state;
  const set = new Set(ids);
  let changed = false;
  const clips = state.clips.map((c) => {
    if (!set.has(c.id) || c.start >= b || clipEnd(c) <= a) return c;
    changed = true;
    const env = c.volumeEnv;
    const la = Math.max(0, a - c.start);
    const lb = Math.min(c.length, b - c.start);
    const r0 = Math.max(0, la - ramp);
    const r1 = Math.min(c.length, lb + ramp);
    const keep = env.filter((p) => p.t < r0 || p.t > r1);
    const pts = [...keep];
    if (la > 0) pts.push({ t: r0, v: envelopeValue(env, r0, 0) });
    pts.push({ t: la, v: SILENT_DB }, { t: lb, v: SILENT_DB });
    if (lb < c.length) pts.push({ t: r1, v: envelopeValue(env, r1, 0) });
    return { ...c, volumeEnv: normalizeEnvelope(pts, c.length) };
  });
  return changed ? { ...state, clips } : state;
}

/**
 * Shortens clips that now run past the end of their source (for example after
 * the source file was trimmed in the Waveform editor). Looped clips repeat the
 * source and are left alone. Returns the same state when nothing changes.
 */
export function fitClipsToSource(state, sourceId, sourceLength) {
  let changed = false;
  const clips = state.clips.map((c) => {
    if (c.sourceId !== sourceId || c.loop || c.offset + c.length <= sourceLength) return c;
    changed = true;
    const offset = Math.min(c.offset, Math.max(0, sourceLength - 1));
    const length = Math.max(1, Math.min(c.length, sourceLength - offset));
    return {
      ...c,
      offset,
      length,
      fadeIn: { ...c.fadeIn, length: Math.min(c.fadeIn.length, length) },
      fadeOut: { ...c.fadeOut, length: Math.min(c.fadeOut.length, length) },
    };
  });
  return changed ? { ...state, clips } : state;
}
