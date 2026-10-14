// Compiles a project into the compact data the audio thread plays (pure, no
// DOM, unit-tested in tests/engine-compile.test.js).
//
//   compileChannel(project, ch, slot, sampleIndex) -> channel config
//   compileMixer(project, { isolate }) -> { count, tracks, order }
//   compileSequence(project, { mode, patternId, slotOf, range }) -> seq
//
// Channel config: { slot, type (instrument index), params (engine order),
//   volume, pan, pitch, mixer, gain (0 when the rack's mute/solo silences
//   it), sample (sample index or -1) }.
// Track config: { volume, pan, width, gain (mute/solo), fx: [{ type (effect
//   index), on, mix, params }], routes: [[dest, gain], ...] }. `order` lists
//   inserts so every track comes after all tracks routed into it (the master
//   is processed last and is not listed).
//
// Mixer solo rule: when any insert is soloed, an insert is audible when it is
// soloed, feeds a soloed insert (directly or through other inserts) or is fed
// by one; the master is always audible. Mute always wins.
//
// Sequence: { mode, bpm, sig, start, end (the loop range in ticks), notes,
//   audio (indices of audio events), auto (automation lanes), tempo (tempo
//   map pieces, engine/tempo.js: song mode follows tempo automation clips,
//   pattern mode always plays at project.bpm) } where notes is
//   a struct of typed arrays sorted by start: start, end (ticks), slot, key,
//   vel, pan, kind (0 note, 1 audio clip), offset (audio: seconds into the
//   sample; under a tempo map, the time from the clip's virtual start
//   (start - offset ticks) to its start). Swing delays odd sixteenths by up to half a step (swing 1) and
//   is applied in pattern time; note ends are warped too so back-to-back
//   steps never overlap. Notes are cut at the end of the loop range so every
//   note gets its note-off before playback wraps.
//
// Automation lane: { target: { kind: 'param'|'strip'|'track'|'fx'|'mix', slot | track,
//   fx (slot index), index (param index) | field }, def ({ min, max, curve, step }),
//   segs: [{ start, end, pts: Float64Array [tick, v, tick, v, ...] }] } with
//   absolute ticks; v is normalized and mapped through the def (lib/params.js
//   fromNorm) on the audio thread. A clip at `start` with `offset` evaluates
//   its points at (tick - start + offset).

import { INSTRUMENT_TYPES, INSTRUMENTS, paramVector } from '../instruments/catalog.js';
import { EFFECT_TYPES, EFFECTS, effectParamVector } from '../effects/catalog.js';
import { channelAudible, patternById, patternLength, songLength } from '../model/project.js';
import { STEP, ticksPerBar, ticksToSeconds } from '../model/time.js';
import { mixerAudible } from '../mixer/routing.js';
import { trackAudible as playlistTrackAudible } from '../playlist/clips.js';
import { TempoMap, tempoPieces } from './tempo.js';

export const NOTE = 0;
export const AUDIO = 1;

/** Value ranges of the non-catalog automation targets. */
export const STRIP_DEFS = {
  volume: { min: 0, max: 1.25 },
  pan: { min: -1, max: 1 },
  pitch: { min: -1200, max: 1200 },
  width: { min: 0, max: 2 },
  mix: { min: 0, max: 1 },
};

export function instrumentIndex(type) {
  return INSTRUMENT_TYPES.indexOf(type);
}

export function effectIndex(type) {
  return EFFECT_TYPES.indexOf(type);
}

// ------------------------------------------------------------------ channels

export function compileChannel(project, ch, slot, sampleIndex = () => -1, { isolate = null, feeds = null } = {}) {
  let gain = channelAudible(project, ch) ? 1 : 0;
  if (isolate !== null && feeds && !feeds.has(clampTrack(project, ch.mixer))) gain = 0;
  return {
    slot,
    type: instrumentIndex(ch.type),
    params: paramVector(ch.type, ch.params),
    volume: num(ch.volume, 0.78),
    pan: num(ch.pan, 0),
    pitch: num(ch.pitch, 0),
    mixer: clampTrack(project, ch.mixer),
    gain,
    sample: ch.sample ? sampleIndex(ch.sample) : -1,
  };
}

function num(v, d) {
  return Number.isFinite(v) ? v : d;
}

function clampTrack(project, i) {
  const n = project.mixer.length;
  return Number.isInteger(i) && i >= 0 && i < n ? i : 0;
}

// ------------------------------------------------------------------ mixer

/** Route list of an insert as [dest, gain] pairs (the master has none). */
export function trackRoutes(project, i, { zero = false } = {}) {
  if (i === 0) return [];
  const t = project.mixer[i];
  const out = [];
  for (const [k, g] of Object.entries(t.routes || {})) {
    const d = Number(k);
    if (Number.isInteger(d) && d >= 0 && d < project.mixer.length && d !== i && (g > 0 || zero)) out.push([d, g]);
  }
  return out;
}

/**
 * Processing order: inserts sorted so each comes after everything routed into
 * it. Cycles (not created by the UI) are broken by dropping the back edge.
 */
export function trackOrder(project) {
  const n = project.mixer.length;
  const state = new Uint8Array(n); // 0 new, 1 visiting, 2 done
  const post = [];
  const visit = (i) => {
    state[i] = 1;
    for (const [d] of trackRoutes(project, i)) if (d !== 0 && state[d] === 0) visit(d);
    state[i] = 2;
    post.push(i);
  };
  for (let i = 1; i < n; i++) if (state[i] === 0) visit(i);
  // Reverse post-order of the route graph is a topological order.
  return post.reverse();
}

/**
 * Inserts upstream (feeding) and downstream (fed by) of `i`, both excluding
 * `i`. With `zero`, routes at zero gain count as connections (the mixer's
 * solo rule, src/mixer/routing.js mixerAudible, treats them that way).
 */
export function upDown(project, i, { zero = false } = {}) {
  const n = project.mixer.length;
  const outs = Array.from({ length: n }, (_, k) => trackRoutes(project, k, { zero }).map(([d]) => d));
  const down = new Set();
  const stack = [...outs[i]];
  while (stack.length) {
    const d = stack.pop();
    if (d === i || down.has(d)) continue;
    down.add(d);
    stack.push(...outs[d]);
  }
  const up = new Set();
  const st = [i];
  while (st.length) {
    const t = st.pop();
    for (let k = 0; k < n; k++) if (!up.has(k) && k !== i && outs[k].includes(t)) {
      up.add(k);
      st.push(k);
    }
  }
  return { up, down };
}

/** Audible gain (0 or 1) per mixer track from mute and solo (the mixer's rule, mixer/routing.js). */
export function mixerGains(project) {
  return project.mixer.map((_, i) => (mixerAudible(project, i) ? 1 : 0));
}

export function compileTrack(project, i, gain = 1, routes = trackRoutes(project, i)) {
  const t = project.mixer[i];
  return {
    volume: num(t.volume, 0.8),
    pan: num(t.pan, 0),
    width: num(t.width, 1),
    gain,
    fx: (t.fx || []).slice(0, 10).map((s) => ({ type: effectIndex(s.type), on: s.on !== false, mix: num(s.mix, 1), params: EFFECTS[s.type] ? effectParamVector(s.type, s.params) : [] })),
    routes,
  };
}

/**
 * The whole mixer. With `isolate` (an insert index), only signal passing
 * through that insert reaches the master: inserts outside its signal path
 * are silenced and routes that bypass it are dropped (used for stems).
 */
export function compileMixer(project, { isolate = null } = {}) {
  const gains = mixerGains(project);
  let routesOf = (i) => trackRoutes(project, i);
  let feeds = null;
  if (isolate !== null && isolate > 0 && isolate < project.mixer.length) {
    const { up, down } = upDown(project, isolate);
    feeds = new Set([...up, isolate]);
    const keep = new Set([...up, isolate, ...down, 0]);
    for (let i = 0; i < gains.length; i++) if (!keep.has(i)) gains[i] = 0;
    routesOf = (i) => trackRoutes(project, i).filter(([d]) => (up.has(i) ? feeds.has(d) : d === 0 || down.has(d)));
  }
  return {
    count: project.mixer.length,
    tracks: project.mixer.map((_, i) => compileTrack(project, i, gains[i], routesOf(i))),
    order: trackOrder(project),
    feeds,
  };
}

// ------------------------------------------------------------------ sequence

/** Swing time warp inside each pair of sixteenths (pattern time). */
export function swingWarp(t, swing) {
  if (!swing) return t;
  const pair = STEP * 2;
  const d = Math.max(0, Math.min(1, swing)) * STEP * 0.5;
  const base = Math.floor(t / pair) * pair;
  const u = t - base;
  return u < STEP ? base + (u * (STEP + d)) / STEP : base + STEP + d + ((u - STEP) * (STEP - d)) / STEP;
}

/** Loop range in ticks for a mode: the pattern, the playlist loop or the song rounded to bars. */
export function playRange(project, mode, patternId) {
  if (mode === 'pattern') {
    const pat = patternById(project, patternId) || project.patterns[0];
    return { start: 0, end: pat ? patternLength(pat, project.sig) : ticksPerBar(project.sig) };
  }
  if (project.loop && project.loop.end > project.loop.start) return { start: project.loop.start, end: project.loop.end };
  const bar = ticksPerBar(project.sig);
  return { start: 0, end: Math.max(bar, Math.ceil(songLength(project) / bar) * bar) };
}

/** Playlist track audibility (playlist/clips.js trackAudible), per track index. */
function trackAudible(project) {
  return project.tracks.map((_, i) => playlistTrackAudible(project, i));
}

/**
 * Compiles notes, audio clips and automation. `slotOf(channelId)` maps rack
 * channels to engine slots (-1 or undefined skips the channel). `range`
 * overrides the loop range (offline renders); `cut` (default true) cuts notes
 * at the range end.
 */
export function compileSequence(project, { mode = 'pattern', patternId = null, slotOf = () => -1, range = null, cut = true } = {}) {
  const r = range || playRange(project, mode, patternId);
  const tempo = compileTempo(project, mode);
  const map = tempo.tick.length > 1 ? new TempoMap(tempo) : null;
  const ev = [];
  const swing = project.swing || 0;
  const chans = new Map(project.channels.map((c) => [c.id, c]));
  const slot = (id) => {
    const s = slotOf(id);
    return Number.isInteger(s) && s >= 0 ? s : -1;
  };
  const pushNote = (start, end, s, n) => {
    if (cut && start < r.end && end > r.end) end = r.end;
    if (end <= start) end = start + 1;
    ev.push({ start, end, slot: s, key: n.key, vel: n.vel, pan: n.pan || 0, kind: NOTE, offset: 0 });
  };

  if (mode === 'pattern') {
    const pat = patternById(project, patternId) || project.patterns[0];
    const len = r.end;
    if (pat) {
      for (const [cid, list] of Object.entries(pat.notes)) {
        const s = slot(cid);
        if (s < 0 || !chans.has(cid)) continue;
        for (const n of list) {
          if (n.pos >= len) continue;
          pushNote(swingWarp(n.pos, swing), swingWarp(n.pos + n.len, swing), s, n);
        }
      }
    }
  } else {
    const audible = trackAudible(project);
    for (const c of project.clips) {
      if (c.mute || audible[c.track] === false) continue;
      const cs = c.start;
      const ce = c.start + c.len;
      if (c.kind === 'pattern') {
        const pat = patternById(project, c.ref);
        if (!pat) continue;
        const off = c.offset || 0;
        for (const [cid, list] of Object.entries(pat.notes)) {
          const s = slot(cid);
          if (s < 0 || !chans.has(cid)) continue;
          for (const n of list) {
            if (n.pos < off || n.pos >= off + c.len) continue;
            const start = cs + swingWarp(n.pos, swing) - off;
            if (start >= ce) continue;
            const end = Math.min(ce, cs + swingWarp(n.pos + n.len, swing) - off);
            pushNote(start, end, s, n);
          }
        }
      } else if (c.kind === 'audio') {
        const s = slot(c.ref);
        if (s < 0) continue;
        let end = ce;
        if (cut && cs < r.end && end > r.end) end = r.end;
        const off = c.offset || 0;
        const offset = map ? map.seconds(cs) - map.seconds(cs - off) : ticksToSeconds(off, project.bpm);
        ev.push({ start: cs, end, slot: s, key: 60, vel: 1, pan: 0, kind: AUDIO, offset });
      }
    }
  }
  ev.sort((a, b) => a.start - b.start || a.kind - b.kind || a.slot - b.slot || a.key - b.key);

  const n = ev.length;
  const notes = {
    count: n,
    start: new Float64Array(n),
    end: new Float64Array(n),
    slot: new Int32Array(n),
    key: new Uint8Array(n),
    vel: new Float32Array(n),
    pan: new Float32Array(n),
    kind: new Uint8Array(n),
    offset: new Float64Array(n),
  };
  const audio = [];
  ev.forEach((e, i) => {
    notes.start[i] = e.start;
    notes.end[i] = e.end;
    notes.slot[i] = e.slot;
    notes.key[i] = e.key;
    notes.vel[i] = e.vel;
    notes.pan[i] = e.pan;
    notes.kind[i] = e.kind;
    notes.offset[i] = e.offset;
    if (e.kind === AUDIO) audio.push(i);
  });

  return {
    mode,
    bpm: project.bpm,
    sig: project.sig,
    start: r.start,
    end: r.end,
    notes,
    audio: Int32Array.from(audio),
    auto: mode === 'song' ? compileAutomation(project, slot) : [],
    tempo,
  };
}

// ------------------------------------------------------------------ tempo

/** Tempo automation clips as tempoPieces() input (audible, unmuted, with points). */
export function tempoClips(project) {
  const audible = trackAudible(project);
  const out = [];
  for (const c of project.clips) {
    if (c.kind !== 'auto' || c.mute || audible[c.track] === false) continue;
    const a = project.automation[c.ref];
    if (!a || a.target?.kind !== 'tempo' || !a.points?.length) continue;
    out.push({ start: c.start, end: c.start + c.len, offset: c.offset || 0, points: a.points });
  }
  return out;
}

/** Tempo map pieces for a play mode: song mode follows tempo clips, pattern mode keeps project.bpm. */
export function compileTempo(project, mode = 'song') {
  return tempoPieces(project.bpm, mode === 'song' ? tempoClips(project) : []);
}

const tempoCache = new WeakMap();

/**
 * The project's TempoMap for a mode (cached per project object, so the UI
 * can call it every frame). Use it for tick <-> time conversions.
 */
export function tempoMap(project, mode = 'song') {
  let e = tempoCache.get(project);
  if (!e) tempoCache.set(project, (e = {}));
  return (e[mode] ||= new TempoMap(compileTempo(project, mode === 'song' ? 'song' : 'pattern')));
}

/** Resolves an automation target to an engine address and value range (null if unsupported). */
export function resolveTarget(project, target, slotOf) {
  if (!target) return null;
  if (target.kind === 'channel') {
    const ch = project.channels.find((c) => c.id === target.id);
    const s = ch ? slotOf(ch.id) : -1;
    if (!ch || s < 0) return null;
    if (target.param === 'volume' || target.param === 'pan' || target.param === 'pitch') return { target: { kind: 'strip', slot: s, field: target.param }, def: STRIP_DEFS[target.param] };
    const list = INSTRUMENTS[ch.type]?.params || [];
    const index = list.findIndex((p) => p.id === target.param);
    if (index < 0) return null;
    return { target: { kind: 'param', slot: s, index }, def: pickDef(list[index]) };
  }
  if (target.kind === 'mixer') {
    if (!(target.track >= 0 && target.track < project.mixer.length)) return null;
    const field = ['volume', 'pan', 'width'].includes(target.param) ? target.param : 'volume';
    return { target: { kind: 'track', track: target.track, field }, def: STRIP_DEFS[field] };
  }
  if (target.kind === 'fx') {
    const t = project.mixer[target.track];
    if (!t) return null;
    const fxi = typeof target.slot === 'number' ? target.slot : t.fx.findIndex((s) => s.id === target.slot);
    const slot = t.fx[fxi];
    if (!slot) return null;
    if (target.param === 'mix') return { target: { kind: 'mix', track: target.track, fx: fxi }, def: STRIP_DEFS.mix };
    const list = EFFECTS[slot.type]?.params || [];
    const index = list.findIndex((p) => p.id === target.param);
    if (index < 0) return null;
    return { target: { kind: 'fx', track: target.track, fx: fxi, index }, def: pickDef(list[index]) };
  }
  return null; // tempo automation drives the tempo map (compileTempo), not a lane
}

function pickDef(p) {
  return { min: p.min, max: p.max, curve: p.curve, step: p.step };
}

function targetKey(t) {
  return `${t.kind}:${t.slot ?? t.track}:${t.fx ?? ''}:${t.index ?? t.field ?? ''}`;
}

export function compileAutomation(project, slotOf) {
  const lanes = new Map();
  const audible = trackAudible(project);
  for (const c of project.clips) {
    if (c.kind !== 'auto' || c.mute || audible[c.track] === false) continue;
    const a = project.automation[c.ref];
    if (!a || !a.points?.length) continue;
    const res = resolveTarget(project, a.target, slotOf);
    if (!res) continue;
    const key = targetKey(res.target);
    let lane = lanes.get(key);
    if (!lane) lanes.set(key, (lane = { target: res.target, def: res.def, segs: [] }));
    const off = c.offset || 0;
    const pts = new Float64Array(a.points.length * 2);
    let cs = null;
    a.points.forEach((p, i) => {
      pts[i * 2] = c.start + p.t - off;
      pts[i * 2 + 1] = p.v;
      if (p.c) (cs ||= new Float64Array(a.points.length))[i] = p.c;
    });
    lane.segs.push({ start: c.start, end: c.start + c.len, pts, cs });
  }
  const out = [...lanes.values()];
  for (const l of out) l.segs.sort((a, b) => a.start - b.start);
  return out;
}
