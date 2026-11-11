// Pure edit operations on multitrack session states. Every function returns a
// new state (or the input unchanged) and never mutates its arguments.
//
// State shape (times in frames at the session rate):
//   { sampleRate, bitDepth, tempo, beatsPerBar, metronome, metronomeSound?, autoCrossfade,
//     tracks: Track[],          audio and bus tracks in display order
//     master: Track,            the master (mix) track
//     clips: Clip[],            flat list; clip.trackId says where it lives
//     markers: Marker[] }
// Track: { id, type: 'audio'|'bus'|'master', name, color, channels, volume (dB),
//   pan (-100..100), mute, solo, arm, monitor, input, output ('master' or a bus
//   id), fx: Effects Rack slots { id, effect, values, enabled } (nulls allowed), fxPower,
//   fxIn/fxOut (rack input/output gain, dB), fxMix (rack dry/wet, 0..1), invert
//   (polarity), mode ('off'|'read'|'write'|'latch'|'touch'),
//   automation: { volume: [{t, v dB}], pan: [{t, v}] }, showAutomation,
//   autoParam, height, minimized, hidden }
// Clip: { id, trackId, sourceId, name, color, start, offset, length, gain (dB),
//   fadeIn: { length, curve, xf? }, fadeOut: { length, curve, xf? }, crossfade
//   ('symmetric'|'asymmetric'), volumeEnv: [{t, v dB}], panEnv: [{t, v}],
//   mute, locked, loop, groupId, z, fx: clip effect slots { id, effect, values,
//   enabled } (Sound Assistant chains), soundAssistant: Sound Assistant settings or null,
//   stretch: time stretch and pitch settings or null (see clip-stretch.js),
//   remix: remix settings and segments or null (see clip-remix.js) }
// Envelope times are relative to the clip start; fade curves follow
// mixcore.fadeShape (0 linear, > 0 logarithmic, < 0 exponential, 2 cosine).
// A fade's optional `xf` overrides automatic crossfading at that end (see
// overlapCrossfades).

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
    fxIn: o.fxIn ?? 0,
    fxOut: o.fxOut ?? 0,
    fxMix: o.fxMix ?? 1,
    invert: Boolean(o.invert),
    mode: o.mode || 'read',
    automation: { volume: (o.automation?.volume || []).slice(), pan: (o.automation?.pan || []).slice() },
    showAutomation: Boolean(o.showAutomation),
    autoParam: o.autoParam || 'volume',
    height: o.height || 124,
    minimized: Boolean(o.minimized),
    hidden: Boolean(o.hidden),
    sends: type === 'master' ? [] : (o.sends || []).map(createSend),
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
    mute: Boolean(o.mute),
    locked: Boolean(o.locked),
    loop: Boolean(o.loop),
    groupId: o.groupId || null,
    z: o.z || 0,
    fx: Array.isArray(o.fx) ? o.fx.filter(Boolean).map((x) => ({ ...x, values: { ...(x.values || {}) } })) : [],
    // `essential` is the name used by earlier versions.
    soundAssistant: structuredClone(o.soundAssistant || o.essential || null),
    // Time stretch and pitch (see clip-stretch.js); sourceId then names the original media.
    stretch: o.stretch ? { ...o.stretch } : null,
    // Remix (see clip-remix.js); sourceId then names the remixed media. A clip is never both.
    remix: o.remix?.segments?.length ? { ...o.remix, segments: o.remix.segments.map(([a, b]) => [a, b]) } : null,
  };
}

/** A new session state with `tracks` stereo audio tracks and a stereo (or mono) master. */
export function createSessionState({ sampleRate = 48000, bitDepth = 32, tracks = 6, template, autoCrossfade = true, masterChannels = 2 } = {}) {
  let list;
  if (Array.isArray(template)) list = template.map((t, i) => createTrack({ color: TRACK_COLORS[i % TRACK_COLORS.length], ...t }));
  else list = Array.from({ length: tracks }, (_, i) => createTrack({ name: `Track ${i + 1}`, color: TRACK_COLORS[i % TRACK_COLORS.length] }));
  // Template tracks may name a bus by its name for their output and sends.
  const busId = (name) => list.find((b) => b.type === 'bus' && b.name === name)?.id;
  for (const t of list) {
    if (t.output !== 'master' && !list.some((b) => b.id === t.output)) t.output = busId(t.output) || 'master';
    for (const x of t.sends) if (x.target && !list.some((b) => b.id === x.target)) x.target = busId(x.target) || null;
  }
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
    for (const snd of t.sends || []) stack.push(snd.target);
  }
  return false;
}

/** Replaces one send of a track (or adds it when `index` is past the end). */
export function setSend(state, trackId, index, patch) {
  return updateTrack(state, trackId, (t) => {
    const sends = (t.sends || []).slice();
    sends[index] = createSend({ ...(sends[index] || {}), ...patch });
    return { sends: sends.slice(0, MAX_SENDS) };
  });
}

export function removeSend(state, trackId, index) {
  return updateTrack(state, trackId, (t) => ({ sends: (t.sends || []).filter((_, i) => i !== index) }));
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
  const clips = state.clips.filter((c) => c.trackId === id).map((c) => ({ ...c, id: uid('c'), trackId: copy.id, groupId: null }));
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
  return addClips(state, clips.map((c) => ({ ...c, z: top + (c.z || 0) - low })));
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
 * Moves clips by `dt` frames and `dTrack` audio-track positions. Locked clips
 * stay. The move is clamped so no clip starts before 0 or leaves the audio tracks.
 */
export function moveClips(state, ids, dt, dTrack = 0, { copy = false } = {}) {
  const set = new Set(ids);
  const moving = state.clips.filter((c) => set.has(c.id) && !c.locked);
  if (!moving.length || (!dt && !dTrack && !copy)) return state;
  const audio = audioTracks(state);
  const index = new Map(audio.map((t, i) => [t.id, i]));
  const minStart = Math.min(...moving.map((c) => c.start));
  dt = Math.max(-minStart, Math.round(dt));
  const idx = moving.map((c) => index.get(c.trackId) ?? 0);
  dTrack = Math.max(-Math.min(...idx), Math.min(audio.length - 1 - Math.max(...idx), dTrack));
  // Moved and copied clips come to the front, as the clip you just placed should.
  const z = Math.max(0, ...state.clips.map((c) => c.z)) + 1;
  const moved = new Map();
  for (const c of moving) {
    const ti = (index.get(c.trackId) ?? 0) + dTrack;
    moved.set(c.id, { start: c.start + dt, trackId: audio[ti]?.id ?? c.trackId, z });
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
    return { ...state, clips: [...state.clips, ...copies] };
  }
  return { ...state, clips: state.clips.map((c) => (moved.has(c.id) ? { ...c, ...moved.get(c.id) } : c)) };
}

/** Splits an envelope at clip-relative frame `at` into [left, right(shifted)]. */
export function splitEnvelope(points, at, fallback) {
  if (!points || !points.length) return [[], []];
  const v = envelopeValue(points, at, fallback);
  const left = points.filter((p) => p.t < at);
  const right = points.filter((p) => p.t > at).map((p) => ({ ...p, t: p.t - at }));
  return [[...left, { t: at, v }], [{ t: 0, v }, ...right]];
}

/** Evaluates a breakpoint envelope (linear between points) at t. */
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
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t || 1);
}

/** Splits one clip at timeline frame `at`; returns [left, right] or null when `at` is not inside. */
export function splitClip(c, at) {
  at = Math.round(at);
  if (at <= c.start || at >= clipEnd(c)) return null;
  const cut = at - c.start;
  const [lv, rv] = splitEnvelope(c.volumeEnv, cut, 0);
  const [lp, rp] = splitEnvelope(c.panEnv, cut, 0);
  const left = { ...c, length: cut, fadeOut: { length: 0, curve: c.fadeOut.curve }, fadeIn: { ...c.fadeIn, length: Math.min(c.fadeIn.length, cut) }, volumeEnv: lv, panEnv: lp };
  const right = {
    ...c,
    id: uid('c'),
    start: at,
    offset: c.offset + cut,
    length: c.length - cut,
    fadeIn: { length: 0, curve: c.fadeIn.curve },
    fadeOut: { ...c.fadeOut, length: Math.min(c.fadeOut.length, c.length - cut) },
    volumeEnv: rv,
    panEnv: rp,
  };
  return [left, right];
}

/** Splits the given clips (or all clips when ids is null) at `at`. Locked clips are split too, as in most editors. */
export function splitClips(state, ids, at) {
  const set = ids ? new Set(ids) : null;
  let changed = false;
  const clips = [];
  for (const c of state.clips) {
    const parts = (!set || set.has(c.id)) && splitClip(c, at);
    if (parts) {
      clips.push(...parts);
      changed = true;
    } else clips.push(c);
  }
  return changed ? { ...state, clips } : state;
}

/** Shifts envelope points by -d (the clip start moved right by d) and drops points before 0. */
function shiftEnvelope(points, d, length, fallback) {
  if (!points.length) return points;
  const v0 = envelopeValue(points, d, fallback);
  const v1 = envelopeValue(points, d + length, fallback);
  const inner = points.filter((p) => p.t > d && p.t < d + length).map((p) => ({ ...p, t: p.t - d }));
  return [{ t: 0, v: v0 }, ...inner, { t: length, v: v1 }];
}

/**
 * Trims one clip edge to timeline frame `frame`. `sourceLength` is the source
 * length in frames (looped clips may extend past it).
 */
export function trimClip(state, id, edge, frame, sourceLength = Infinity) {
  const c = findClip(state, id);
  if (!c || c.locked) return state;
  frame = Math.round(frame);
  let next;
  if (edge === 'in') {
    const minStart = c.loop ? 0 : c.start - c.offset;
    const s = Math.max(Math.max(0, minStart), Math.min(clipEnd(c) - 1, frame));
    const d = s - c.start;
    if (!d) return state;
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
    };
  } else {
    const maxEnd = c.loop ? Infinity : c.start + Math.max(1, sourceLength - c.offset);
    const e = Math.max(c.start + 1, Math.min(maxEnd, frame));
    if (e === clipEnd(c)) return state;
    const length = e - c.start;
    next = {
      ...c,
      length,
      fadeIn: { ...c.fadeIn, length: Math.min(c.fadeIn.length, length) },
      fadeOut: { ...c.fadeOut, length: Math.min(c.fadeOut.length, length) },
      volumeEnv: length < c.length ? shiftEnvelope(c.volumeEnv, 0, length, 0) : c.volumeEnv,
      panEnv: length < c.length ? shiftEnvelope(c.panEnv, 0, length, 0) : c.panEnv,
    };
  }
  return { ...state, clips: state.clips.map((x) => (x.id === id ? next : x)) };
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
  let s = state;
  for (const id of ids) {
    const c = findClip(s, id);
    if (!c || c.locked || clipEnd(c) <= a || c.start >= b) continue;
    if (c.start < a) s = trimClip(s, id, 'in', a, sourceLength(c.sourceId));
    const c2 = findClip(s, id);
    if (clipEnd(c2) > b) s = trimClip(s, id, 'out', b, sourceLength(c2.sourceId));
  }
  return s;
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
 * Ripple delete of time [a, b): removes the range from clips on the tracks
 * (all tracks when trackIds is null, or only clips in `ids`) and pulls later
 * material on those tracks left. Markers shift when every track ripples.
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
  return { ...state, clips };
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
  return { ...state, clips: state.clips.map((c) => (c.trackId === trackId && c.start >= b ? { ...c, start: c.start - (b - a) } : c)) };
}

// ------------------------------------------------------------- fades, env

export function setFade(state, ids, dir, patch) {
  const key = dir === 'in' ? 'fadeIn' : 'fadeOut';
  return updateClips(state, ids, (c) => {
    const f = { ...c[key], ...patch };
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
    .map((p) => ({ t: Math.max(0, Math.min(length, Math.round(p.t))), v: p.v }))
    .sort((a, b) => a.t - b.t);
  return out.filter((p, i) => i === 0 || p.t !== out[i - 1].t || i === out.length - 1);
}

export function setClipEnvelope(state, id, param, points) {
  const key = param === 'pan' ? 'panEnv' : 'volumeEnv';
  return updateClips(state, [id], (c) => ({ [key]: normalizeEnvelope(points, c.length) }));
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

/** Writes recorded automation: replaces points in [t0, t1] with `recorded`. */
export function writeEnvelopeRange(points, t0, t1, recorded) {
  const keep = points.filter((p) => p.t < t0 || p.t > t1);
  return [...keep, ...recorded].sort((a, b) => a.t - b.t);
}

export function setAutomation(state, trackId, param, points) {
  return updateTrack(state, trackId, (t) => ({ automation: { ...t.automation, [param]: points.slice().sort((a, b) => a.t - b.t) } }));
}

// ------------------------------------------------------------- crossfades

/**
 * Overlaps between clips on the same track. Each entry is
 * { trackId, out: clipId fading out, in: clipId fading in, start, end }.
 * Only partial overlaps crossfade; a clip wholly inside another does not.
 */
export function crossfades(state) {
  const out = [];
  const byTrack = new Map();
  for (const c of state.clips) {
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
export function activeCrossfades(state) {
  const byId = new Map(state.clips.map((c) => [c.id, c]));
  return crossfades(state).filter((x) => overlapCrossfades(state, byId.get(x.out), byId.get(x.in)));
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
  const overlaps = crossfades(state);
  let next = state;
  for (const id of ids) {
    const c = findClip(next, id);
    if (!c) continue;
    const mine = overlaps.filter((x) => (dir === 'in' ? x.in : x.out) === id);
    const f = { ...c[key] };
    if (mode === 'crossfade') {
      if (!mine.length) continue;
      f.xf = true;
      next = updateClips(next, [id], { [key]: f });
      next = updateClips(next, mine.map((x) => (dir === 'in' ? x.out : x.in)), (n) => ({ [other]: { ...n[other], xf: true } }));
      continue;
    }
    if (mode === 'none') f.length = 0;
    else if (!f.length) f.length = defaultFadeLength(c, state.sampleRate);
    // Only an overlapping end needs to say "no crossfade"; elsewhere the session setting applies later.
    if (mine.length) f.xf = false;
    else delete f.xf;
    next = updateClips(next, [id], { [key]: f });
  }
  return next;
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

export function groupClips(state, ids) {
  if (ids.length < 2) return state;
  const g = uid('g');
  return updateClips(state, ids, { groupId: g });
}

export function ungroupClips(state, ids) {
  const groups = new Set(state.clips.filter((c) => ids.includes(c.id) && c.groupId).map((c) => c.groupId));
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
