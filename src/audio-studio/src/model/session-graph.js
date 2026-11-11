// Builds the mixcore playback/render graph (see engine/mixcore.js) from a
// session state and its media pool. Pure apart from sourceKey, which assigns
// stable ids to Channel objects.
//
// Handles: bus routing and sends, track EQ, solo/mute, track volume/pan automation (Off/Read and
// the recording modes), clip gain, fades, crossfades on overlaps (or the
// front clip hiding the rear one when automatic crossfades are off), clip
// volume/pan envelopes, looped clips, polarity inversion, effect chains
// (track and master racks with input/output gain and dry/wet mix, and
// per-clip Sound Assistant chains in clip.fx), the metronome and 5.1
// sessions (a 5.1 master makes a surround graph: 5.1 tracks and buses carry
// six channels and the others are placed by their surround panner).

import { sourceKey } from '../engine/engine.js';
import { activeCrossfades, clipEnd, SILENT_DB } from './session-edits.js';
import { slotSpecs, rackTiming, gainSpec } from '../effects/rack.js';
import { clickSound, DEFAULT_METRONOME_SOUND } from '../multitrack/metronome-sounds.js';

export const dbToGain = (db) => (db <= SILENT_DB ? 0 : Math.pow(10, db / 20));

/**
 * A track's effects rack for the graph: { fx } plus, with a dry/wet mix
 * below 100%, { fxMix, fxWet, fxDry } (see mixcore runChain). Input and
 * output gain only apply while the rack has effects to run.
 */
export function trackRackSpecs(t, rateDoc, channels = 2) {
  if (!t.fxPower) return { fx: [] };
  const slots = slotSpecs(t.fx, `trk:${t.id}`, rateDoc, channels);
  if (!slots.length) return { fx: [] };
  const inGain = t.fxIn ? gainSpec(`trk:${t.id}:in`, t.fxIn) : null;
  const wet = inGain ? [inGain, ...slots] : slots;
  const out = t.fxOut ? gainSpec(`trk:${t.id}:out`, t.fxOut) : null;
  const r = { fx: out ? [...wet, out] : wet };
  const mix = Math.max(0, Math.min(1, t.fxMix ?? 1));
  if (mix < 1) Object.assign(r, { fxMix: mix, fxWet: wet.length, fxDry: dbToGain(t.fxIn || 0) });
  return r;
}

/**
 * Converts a dB envelope to linear breakpoints, subdividing large steps so
 * linear interpolation of gain approximates the dB ramp the user drew.
 */
export function dbEnvelopeToGain(points, offset = 0) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const q = points[i - 1];
      const diff = Math.abs(p.v - q.v);
      if (diff > 3 && p.t > q.t) {
        const steps = Math.min(16, Math.ceil(diff / 3));
        for (let k = 1; k < steps; k++) {
          const f = k / steps;
          out.push({ t: q.t + (p.t - q.t) * f + offset, v: dbToGain(q.v + (p.v - q.v) * f) });
        }
      }
    }
    out.push({ t: p.t + offset, v: dbToGain(p.v) });
  }
  return out;
}

const panEnvelope = (points, offset = 0) => points.map((p) => ({ t: p.t + offset, v: p.v / 100 }));

/** Subtracts intervals `cut` (sorted or not) from [a, b). */
function subtract(a, b, cuts) {
  let parts = [[a, b]];
  for (const [x, y] of cuts) {
    const next = [];
    for (const [p, q] of parts) {
      if (y <= p || x >= q) next.push([p, q]);
      else {
        if (x > p) next.push([p, x]);
        if (y < q) next.push([y, q]);
      }
    }
    parts = next;
  }
  return parts.filter(([p, q]) => q > p);
}

const plans = new WeakMap();

/**
 * Audible intervals of each clip plus its effective fades. Returns
 * Map(clipId -> { parts: [[start, end)], fadeIn, fadeOut }) (shared: do not modify).
 * Cached per clip list, so redraws and graph rebuilds that leave the clips alone reuse it.
 */
export function clipPlan(state) {
  const auto = state.autoCrossfade !== false;
  const hit = plans.get(state.clips);
  if (hit && hit.auto === auto) return hit.plan;
  const plan = computeClipPlan(state);
  plans.set(state.clips, { auto, plan });
  return plan;
}

// The last plan of each track (by id): a drag or edit that leaves a track's clips alone reuses it.
const trackPlans = new Map();

function computeClipPlan(state) {
  const auto = state.autoCrossfade !== false;
  // Muted clips are silent and neither hide nor crossfade with others; clips only meet on their track.
  const byTrack = new Map();
  for (const c of state.clips) {
    if (c.mute) continue;
    if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
    byTrack.get(c.trackId).push(c);
  }
  const plan = new Map();
  for (const [trackId, list] of byTrack) {
    const hit = trackPlans.get(trackId);
    let entries;
    if (hit && hit.auto === auto && hit.list.length === list.length && hit.list.every((c, i) => c === list[i])) entries = hit.entries;
    else {
      entries = planTrack(list, auto);
      trackPlans.set(trackId, { list, auto, entries });
    }
    for (const [id, v] of entries) plan.set(id, v);
  }
  if (trackPlans.size > byTrack.size + 256) for (const id of trackPlans.keys()) if (!byTrack.has(id)) trackPlans.delete(id);
  return plan;
}

/** The plan entries ([clipId, { parts, fadeIn, fadeOut }]) of the unmuted clips of one track, in state order. */
function planTrack(list, auto) {
  const xf = activeCrossfades({ clips: list, autoCrossfade: auto });
  const pairs = new Map(); // "a|b" -> [start, end) shared by a crossfading pair
  const fades = new Map();
  for (const c of list) fades.set(c.id, { fadeIn: { ...c.fadeIn }, fadeOut: { ...c.fadeOut } });
  const byId = new Map(list.map((c) => [c.id, c]));
  for (const x of xf) {
    const a = byId.get(x.out);
    const b = byId.get(x.in);
    const len = x.end - x.start;
    const sym = b.crossfade !== 'asymmetric';
    fades.get(b.id).fadeIn = { length: len, curve: b.fadeIn.curve };
    fades.get(a.id).fadeOut = { length: len, curve: sym ? b.fadeIn.curve : a.fadeOut.curve };
    pairs.set(`${a.id}|${b.id}`, [x.start, x.end]);
    pairs.set(`${b.id}|${a.id}`, [x.start, x.end]);
  }
  // Front-to-back order as in frontOrder: z, then later in the list.
  const order = new Map(list.map((c, i) => [c.id, c.z * 1e6 + i]));
  // Clips in start order: only those starting less than the longest clip before a clip's start can reach it.
  const clips = list.slice().sort((a, b) => a.start - b.start);
  const z = clips.map((c) => order.get(c.id));
  let maxLen = 0;
  for (const c of clips) maxLen = Math.max(maxLen, c.length);
  const out = new Map();
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const end = clipEnd(c);
    const cuts = [];
    let lo = 0;
    let hi = clips.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (clips[mid].start <= c.start - maxLen) lo = mid + 1;
      else hi = mid;
    }
    for (let j = lo; j < clips.length && clips[j].start < end; j++) {
      const o = clips[j];
      if (j === i || z[j] < z[i] || clipEnd(o) <= c.start) continue;
      // A crossfade overlap stays audible on both clips; otherwise the front clip hides this one.
      const zone = pairs.get(`${c.id}|${o.id}`);
      if (zone) cuts.push(...subtract(o.start, clipEnd(o), [zone]));
      else cuts.push([o.start, clipEnd(o)]);
    }
    out.set(c.id, { parts: subtract(c.start, end, cuts), ...fades.get(c.id) });
  }
  return list.map((c) => [c.id, out.get(c.id)]);
}

/** Splits a (possibly looped) clip interval into contiguous source reads. */
function sourceSegments(clip, a, b, srcLen) {
  const segs = [];
  if (!clip.loop || !(srcLen > 0)) {
    const end = Math.min(b, clip.start + Math.max(0, srcLen - clip.offset));
    if (end > a) segs.push({ start: a, offset: clip.offset + (a - clip.start), length: end - a });
    return segs;
  }
  let t = a;
  while (t < b) {
    const pos = (clip.offset + (t - clip.start)) % srcLen;
    const n = Math.min(b - t, srcLen - pos);
    segs.push({ start: t, offset: pos, length: n });
    t += n;
  }
  return segs;
}

/**
 * @param {object} state session state
 * @param {Map<string, {channels: Channel[]}>} pool media pool by source id
 * @param {object} [o]
 * @param {Set<string>} [o.clipIds] render only these clips
 * @param {object} [o.overrides] { [trackId]: { volume?, pan? } } live values while writing automation
 * @param {Channel[]|null} [o.metronome] one bar of clicks to loop when state.metronome is on
 * @param {number} [o.metronomeEnd] last frame to place clicks before
 * @param {object} [o.panLaw] { mode: 'balance' | 'equalPower', centerDb } (see engine/mixcore.js)
 * @returns {{ graph, sources: Map<string, Channel[]> }}
 */
export function buildSessionGraph(state, pool, { clipIds = null, overrides = {}, metronome = null, metronomeEnd = 0, panLaw = null } = {}) {
  const sources = new Map();
  const keyOf = new Map();
  for (const [id, src] of pool) {
    if (!src.channels?.length || !src.channels[0].length) continue;
    const key = sourceKey(src.channels);
    keyOf.set(id, key);
    sources.set(key, src.channels);
  }
  const plan = clipPlan(state);
  const rateDoc = { sampleRate: state.sampleRate };
  const busIds = new Set(state.tracks.filter((t) => t.type === 'bus').map((t) => t.id));
  const surround = state.master.channels === 6;
  const tracks = [];
  for (const t of state.tracks) {
    const o = overrides[t.id] || {};
    const auto = t.mode !== 'off';
    const volPts = auto && o.volume === undefined ? t.automation.volume : [];
    const panPts = auto && o.pan === undefined ? t.automation.pan : [];
    const gt = {
      id: t.id,
      gain: volPts.length ? 1 : dbToGain(o.volume ?? t.volume),
      pan: panPts.length ? 0 : (o.pan ?? t.pan) / 100,
      mute: t.mute,
      solo: t.solo,
      ...trackRackSpecs(t, rateDoc, surround && t.channels === 6 ? 6 : 2),
      clips: [],
    };
    if (t.invert) gt.invert = true;
    if (surround) {
      if (t.channels === 6) gt.six = true;
      else {
        gt.surround = { ...(t.surround || {}) };
        if (t.channels === 1) gt.monoIn = true;
      }
    }
    if (volPts.length) gt.volumeEnv = dbEnvelopeToGain(volPts);
    if (panPts.length) gt.panEnv = panEnvelope(panPts);
    if (t.type === 'bus') {
      gt.bus = true;
      if (t.channels === 1) gt.mono = true;
    }
    if (t.output && t.output !== 'master' && busIds.has(t.output) && t.output !== t.id) gt.output = t.output;
    // Track EQ runs after the effects chain, whatever the chain's power state.
    if (t.eq?.on) gt.fx = [...gt.fx, ...slotSpecs([{ id: 'eq', effect: 'parametricEq', values: t.eq.values, enabled: true }], `eq:${t.id}`, rateDoc)];
    const sends = (t.sends || []).filter((x) => x.on && x.target !== t.id && busIds.has(x.target));
    if (sends.length) gt.sends = sends.map((x) => ({ target: x.target, gain: dbToGain(x.level), pan: x.pan / 100, pre: x.pre }));
    if (t.type === 'audio') {
      for (const c of state.clips) {
        if (c.trackId !== t.id || c.mute) continue;
        if (clipIds && !clipIds.has(c.id)) continue;
        const key = keyOf.get(c.sourceId);
        const p = plan.get(c.id);
        if (!key || !p) continue;
        const src = pool.get(c.sourceId);
        const srcLen = src.channels[0].length;
        const clipFx = c.fx?.length ? slotSpecs(c.fx, `clip:${c.id}`, rateDoc) : null;
        const timing = clipFx?.length ? rackTiming({ slots: c.fx }, state.sampleRate) : null;
        for (const [a, b] of p.parts) {
          for (const seg of sourceSegments(c, a, b, srcLen)) {
            // A clip chain with latency (spectral repair, lookahead) reads its
            // audio that much earlier so the processed clip lines up in time.
            const lat = timing?.latency || 0;
            const cut = Math.max(0, lat - seg.start);
            if (cut >= seg.length) continue;
            const gc = {
              id: c.id,
              source: key,
              channels: src.channels.length,
              start: seg.start - lat + cut,
              offset: seg.offset + cut,
              length: seg.length - cut,
              gain: dbToGain(c.gain),
              fadeIn: p.fadeIn.length,
              fadeInCurve: p.fadeIn.curve,
              fadeOut: p.fadeOut.length,
              fadeOutCurve: p.fadeOut.curve,
              base: seg.start - c.start + cut,
              full: c.length,
            };
            if (t.channels === 1 && src.channels.length > 1) gc.mono = true;
            if (c.volumeEnv.length) gc.gainEnv = dbEnvelopeToGain(c.volumeEnv);
            if (c.panEnv.length) gc.panEnv = panEnvelope(c.panEnv);
            if (clipFx?.length) {
              gc.fx = clipFx;
              gc.fxTail = timing.tail + lat;
            }
            gt.clips.push(gc);
          }
        }
      }
    }
    tracks.push(gt);
  }
  if (metronome && state.metronome && metronome[0]?.length) {
    const key = sourceKey(metronome);
    sources.set(key, metronome);
    const bar = metronome[0].length;
    const clips = [];
    for (let at = 0, i = 0; at < metronomeEnd && i < 20000; at += bar, i++) {
      clips.push({ id: `click${i}`, source: key, channels: metronome.length, start: at, offset: 0, length: bar, gain: 1, fadeIn: 0, fadeOut: 0 });
    }
    tracks.push({ id: '__metronome', gain: 1, pan: 0, mute: false, solo: false, soloSafe: true, fx: [], clips });
  }
  const m = state.master;
  const mo = overrides[m.id] || {};
  const master = { gain: dbToGain(mo.volume ?? m.volume), ...trackRackSpecs(m, rateDoc, surround ? 6 : 2) };
  if (m.invert) master.invert = true;
  if (m.eq?.on) master.fx = [...master.fx, ...slotSpecs([{ id: 'eq', effect: 'parametricEq', values: m.eq.values, enabled: true }], `eq:${m.id}`, rateDoc)];
  if (m.mode !== 'off' && mo.volume === undefined && m.automation.volume.length) {
    master.gain = 1;
    master.volumeEnv = dbEnvelopeToGain(m.automation.volume);
  }
  // A mono master folds the mix to mono (both outputs carry it).
  if (m.channels === 1) master.mono = true;
  const graph = { rate: state.sampleRate, tracks, master };
  if (surround) graph.surround = true;
  if (panLaw && panLaw.mode === 'equalPower') graph.panLaw = { mode: 'equalPower', centerDb: panLaw.centerDb };
  return { graph, sources };
}

/** One bar of metronome clicks (accented downbeat) at the session tempo, in a sound set from metronome-sounds.js. */
export function metronomeBar(Channel, { sampleRate, tempo = 120, beatsPerBar = 4, sound = DEFAULT_METRONOME_SOUND }) {
  const beat = Math.round((60 / tempo) * sampleRate);
  const n = beat * beatsPerBar;
  const out = new Float32Array(n);
  const accent = clickSound(sound, sampleRate, true);
  const normal = clickSound(sound, sampleRate, false);
  for (let b = 0; b < beatsPerBar; b++) {
    const click = b === 0 ? accent : normal;
    const at = b * beat;
    out.set(click.subarray(0, Math.min(click.length, n - at)), at);
  }
  return [Channel.fromSamples(out)];
}
