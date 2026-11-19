// Builds the mixcore playback/render graph (see engine/mixcore.js) from a
// session state and its media pool. Pure apart from sourceKey, which assigns
// stable ids to Channel objects.
//
// Handles: bus routing and sends (with send level automation), track EQ, solo/mute, track
// volume/pan/mute automation (Off/Read and
// the recording modes), clip gain, fades, crossfades on overlaps (or the
// front clip hiding the rear one when automatic crossfades are off), clip
// volume/pan envelopes, looped clips, polarity inversion, effect chains
// (track and master racks with input/output gain and dry/wet mix, and
// per-clip Sound Assistant chains in clip.fx), the metronome and 5.1
// sessions (a 5.1 master makes a surround graph: 5.1 tracks and buses carry
// six channels and the others are placed by their surround panner).

import { mergeScene } from './merge-layout.js';
import { sourceKey } from '../engine/engine.js';
import { activeCrossfades, clipEnd, SILENT_DB, expandHolds, envelopeValue, clipEnvelope, sendParam, fxParamRef, muteSteps } from './session-edits.js';
import { slotSpecs, rackTiming, gainSpec } from '../effects/rack.js';
import { compensateLatency } from '../engine/mixcore.js';
import { getEffect } from '../effects/registry.js';
import { clickSound, DEFAULT_METRONOME_SOUND } from '../multitrack/metronome-sounds.js';

export const dbToGain = (db) => (db <= SILENT_DB ? 0 : Math.pow(10, db / 20));

/**
 * A track's effects rack for the graph: { fx } plus, with a dry/wet mix
 * below 100%, { fxMix, fxWet, fxDry, fxLatency } (see mixcore runChain). Input and
 * output gain only apply while the rack has effects to run.
 */
/** The source audio a clip plays: { channels, rate, range } (its offset over its length). */
export function clipAudio(c, src, rate) {
  return { channels: src.channels, rate: src.channelRate || rate, range: [c.offset, c.offset + c.length] };
}

/** The audio a track's clips play, longest clips first (at most four), for chains that analyse it. */
export function trackAudio(state, t, pool) {
  return state.clips
    .filter((c) => c.trackId === t.id && !c.mute && pool.get(c.sourceId)?.channels?.length)
    .sort((a, b) => b.length - a.length)
    .slice(0, 4)
    .map((c) => clipAudio(c, pool.get(c.sourceId), state.sampleRate));
}

export function trackRackSpecs(t, rateDoc, channels = 2, sources = null) {
  if (!t.fxPower) return { fx: [] };
  const slots = slotSpecs(t.fx, `trk:${t.id}`, rateDoc, channels, sources);
  if (!slots.length) return { fx: [] };
  automateSlots(t, slots, `trk:${t.id}`);
  const inGain = t.fxIn ? gainSpec(`trk:${t.id}:in`, t.fxIn) : null;
  const wet = inGain ? [inGain, ...slots] : slots;
  const out = t.fxOut ? gainSpec(`trk:${t.id}:out`, t.fxOut) : null;
  const r = { fx: out ? [...wet, out] : wet };
  const mix = Math.max(0, Math.min(1, t.fxMix ?? 1));
  if (mix < 1) {
    // The dry part is delayed by the wet slots' latency (runChain), so the blend lines up.
    // On six channels only the surround-capable slots run.
    const run = channels === 6 ? t.fx.filter((s) => getEffect(s?.effect)?.surround) : t.fx;
    const fxLatency = rackTiming({ slots: run }, rateDoc?.sampleRate || 48000).latency;
    Object.assign(r, { fxMix: mix, fxWet: wet.length, fxDry: dbToGain(t.fxIn || 0), fxLatency });
  }
  return r;
}

/**
 * Effect setting automation: each automated setting of a rack slot becomes a `paramEnv`
 * entry ({ index into the slot's params, points }) the effect host applies every block.
 * Lanes are read in every mode but Off.
 */
function automateSlots(t, specs, prefix, slots = t.fx, lanes = t.automation, offset = 0) {
  if (t.mode === 'off' || !lanes) return;
  for (const [param, pts] of Object.entries(lanes)) {
    const ref = pts?.length ? fxParamRef(param) : null;
    if (!ref) continue;
    const spec = specs.find((sp) => sp.key === `${prefix}:${ref.slotId}`);
    const def = getEffect(slots.find((x) => x?.id === ref.slotId)?.effect);
    const index = def ? def.params.findIndex((p) => p.id === ref.paramId) : -1;
    if (!spec || index < 0) continue;
    // Switches and choices step between keyframes.
    const type = def.params[index].type;
    const keys = type === 'bool' || type === 'choice' ? muteSteps(pts) : pts;
    (spec.paramEnv ||= []).push({ index, points: expandHolds(keys).map((p) => ({ t: p.t + offset, v: p.v })) });
  }
}

/** The track EQ as a chain slot, with its automated settings (lanes `fx.eq.<param>`). */
function eqSpecs(t, rateDoc) {
  const slot = { id: 'eq', effect: 'parametricEq', values: t.eq.values, enabled: true };
  const specs = slotSpecs([slot], `eq:${t.id}`, rateDoc);
  automateSlots(t, specs, `eq:${t.id}`, [slot]);
  return specs;
}

/** Processing delay (frames) of a track's or the master's rack: its switched-on slots, in series. */
export function rackLatency(t, rate, channels = 2) {
  if (!t.fxPower) return 0;
  const run = channels === 6 ? (t.fx || []).filter((s) => getEffect(s?.effect)?.surround) : t.fx;
  return rackTiming({ slots: run }, rate).latency;
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

/**
 * The channels a clip plays from its source: `clip.channelMap` picks a source channel for each
 * of its two channels (e.g. [0, 0] plays the left channel on both sides). Unrouted clips, mono
 * sources and maps that do not fit the source play the source as it is.
 */
export function routedChannels(clip, channels) {
  const map = clip.channelMap;
  if (!Array.isArray(map) || map.length !== 2 || channels.length < 2) return channels;
  if (!map.every((i) => Number.isInteger(i) && i >= 0 && i < channels.length)) return channels;
  if (map[0] === 0 && map[1] === 1) return channels;
  return map.map((i) => channels[i]);
}

/** Ramp at each step of mute automation (frames at 48 kHz scale with the rate): avoids clicks. */
const MUTE_RAMP_SECONDS = 0.003;

/**
 * Linear gain breakpoints for mute automation (points { t, v: 1 muted | 0 audible }, each
 * holding until the next): 0 or 1 with a short ramp at every change.
 */
export function muteEnvelope(points, rate) {
  const ramp = Math.max(1, Math.round(rate * MUTE_RAMP_SECONDS));
  const gainOf = (p) => (p.v >= 0.5 ? 0 : 1);
  const out = [{ t: points[0].t, v: gainOf(points[0]) }];
  for (let i = 1; i < points.length; i++) {
    const g = gainOf(points[i]);
    const prev = out[out.length - 1].v;
    if (g === prev) continue;
    const at = points[i].t;
    out.push({ t: Math.max(out[out.length - 1].t, at - ramp), v: prev }, { t: at, v: g });
  }
  return out;
}

/** Product of two linear breakpoint envelopes (breakpoints at the union of their times). */
export function multiplyEnvelopes(a, b) {
  const times = [...new Set([...a.map((p) => p.t), ...b.map((p) => p.t)])].sort((x, y) => x - y);
  return times.map((t) => ({ t, v: envelopeValue(a, t, 1) * envelopeValue(b, t, 1) }));
}

/** A track's gain envelope with its mute automation applied (or null when it has none). */
function withMuteAutomation(gainEnv, gain, mutePts, rate) {
  if (!mutePts.length) return gainEnv;
  const mute = muteEnvelope(mutePts, rate);
  if (gainEnv) return multiplyEnvelopes(gainEnv, mute);
  return mute.map((p) => ({ t: p.t, v: p.v * gain }));
}

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
function planTrack(real, auto) {
  const scene = real.some((c) => c.mergeLayout) ? mergeScene(real) : null;
  const list = scene?.list || real;
  const byId = new Map(list.map((c) => [c.id, c]));
  const xf = activeCrossfades({ clips: real, autoCrossfade: auto }, scene);
  const pairs = new Map(); // "a|b" -> [start, end) shared by a crossfading pair
  const fades = new Map();
  for (const c of list) fades.set(c.id, { fadeIn: { ...c.fadeIn }, fadeOut: { ...c.fadeOut } });
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
      if (j === i || clipEnd(o) <= c.start) continue;
      if (scene ? !scene.interacts(c, o) || !scene.inFront(o, c) : z[j] < z[i]) continue;
      // A crossfade overlap stays audible on both clips; otherwise the front clip hides this one.
      const zone = pairs.get(`${c.id}|${o.id}`);
      const [start, end] = scene?.ghosts.has(o.id) ? o.bounds : [o.start, clipEnd(o)];
      if (zone) cuts.push(...subtract(start, end, [zone]));
      else cuts.push([start, end]);
    }
    out.set(c.id, { parts: subtract(c.start, end, cuts), ...fades.get(c.id) });
  }
  return real.map((c) => [c.id, out.get(c.id)]);
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
 * @param {boolean} [o.compensate] false leaves latency compensation (compensateLatency) to a
 *   caller that changes the routing first (bounces render without the master or the track's output)
 * @returns {{ graph, sources: Map<string, Channel[]> }}
 */
/**
 * What a frozen track's pre-rendered audio depends on: its clips (and their media), effects,
 * EQ, polarity and effect automation. A changed key means the render is out of date.
 */
export function freezeKey(state, t, pool) {
  const clips = state.clips.filter((c) => c.trackId === t.id);
  const media = clips.map((c) => {
    const src = pool.get(c.sourceId);
    return src?.channels?.length ? sourceKey(src.channels) : '';
  });
  const fxLanes = Object.entries(t.automation || {}).filter(([k]) => fxParamRef(k));
  // Post-fader effects take the volume and pan into the render.
  const fader = t.fxPost ? [t.volume, t.pan, t.mode === 'off' ? [] : [t.automation.volume, t.automation.pan]] : null;
  return JSON.stringify([clips, media, t.fx, t.fxPower, t.fxIn, t.fxOut, t.fxMix, t.eq, t.invert, t.channels, t.mode === 'off' ? [] : fxLanes, state.sampleRate, state.autoCrossfade, fader]);
}

/** True when a track plays its pre-rendered audio: frozen, rendered for its current state, pre-fader. */
export function frozenAudio(state, t, pool, frozen) {
  if (!t.freeze || t.type !== 'audio') return null;
  // Post-fader renders hold the volume and pan: pre-fader sends would lose their dry signal.
  if (t.fxPost && (t.sends || []).some((x) => x.pre && x.on && x.target)) return null;
  const f = frozen?.get(t.id);
  return f && f.key === freezeKey(state, t, pool) ? f : null;
}

export function buildSessionGraph(state, pool, { clipIds = null, overrides = {}, metronome = null, metronomeEnd = 0, panLaw = null, compensate = true, frozen = null } = {}) {
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
    const volPts = auto && o.volume === undefined ? expandHolds(t.automation.volume) : [];
    const panPts = auto && o.pan === undefined ? expandHolds(t.automation.pan) : [];
    const mutePts = auto && o.mute === undefined ? t.automation.mute || [] : [];
    const gt = {
      id: t.id,
      gain: volPts.length ? 1 : dbToGain(o.volume ?? t.volume),
      pan: panPts.length ? 0 : (o.pan ?? t.pan) / 100,
      // Mute automation (or a live override while it is written) replaces the mute switch.
      mute: o.mute !== undefined ? o.mute >= 0.5 : mutePts.length ? false : t.mute,
      solo: t.solo,
      ...trackRackSpecs(t, rateDoc, surround && t.channels === 6 ? 6 : 2, () => trackAudio(state, t, pool)),
      clips: [],
    };
    const lat = rackLatency(t, state.sampleRate, surround && t.channels === 6 ? 6 : 2);
    if (lat) gt.latency = lat;
    if (t.invert) gt.invert = true;
    if (surround) {
      if (t.channels === 6) gt.six = true;
      else {
        gt.surround = { ...(t.surround || {}) };
        if (t.channels === 1) gt.monoIn = true;
      }
    }
    const volumeEnv = withMuteAutomation(volPts.length ? dbEnvelopeToGain(volPts) : null, gt.gain, mutePts, state.sampleRate);
    if (volumeEnv) {
      gt.volumeEnv = volumeEnv;
      gt.gain = 1;
    }
    if (panPts.length) gt.panEnv = panEnvelope(panPts);
    if (t.type === 'bus') {
      gt.bus = true;
      if (t.channels === 1) gt.mono = true;
    }
    if (t.output && t.output !== 'master' && busIds.has(t.output) && t.output !== t.id) gt.output = t.output;
    // Track EQ runs after the effects chain, whatever the chain's power state.
    if (t.eq?.on) gt.fx = [...gt.fx, ...eqSpecs(t, rateDoc)];
    // Post-fader: the effects (and the EQ after them) follow the volume and pan.
    if (t.fxPost && gt.fx.length && !gt.six) gt.fxPost = true;
    const sends = (t.sends || []).map((x, i) => [x, sendParam(i)]).filter(([x]) => x.on && x.target !== t.id && busIds.has(x.target));
    if (sends.length) {
      gt.sends = sends.map(([x, param]) => {
        // Send level automation (or a live value while it is written).
        const pts = auto && o[param] === undefined ? expandHolds(t.automation[param] || []) : [];
        const snd = { target: x.target, gain: pts.length ? 1 : dbToGain(o[param] ?? x.level), pan: x.pan / 100, pre: x.pre };
        if (pts.length) snd.gainEnv = dbEnvelopeToGain(pts);
        return snd;
      });
    }
    // A frozen track plays its pre-rendered clips and effects (volume, pan and sends still apply).
    const ice = !clipIds && surround !== true ? frozenAudio(state, t, pool, frozen) : null;
    if (ice) {
      const key = sourceKey(ice.channels);
      sources.set(key, ice.channels);
      gt.fx = [];
      delete gt.latency;
      delete gt.invert;
      delete gt.fxPost;
      gt.clips.push({ id: `frozen:${t.id}`, source: key, channels: ice.channels.length, start: 0, offset: 0, length: ice.length, gain: 1, fadeIn: 0, fadeOut: 0 });
      if (t.fxPost) {
        // Post-fader: the volume and pan are in the render; mute (automation) stays live.
        gt.gain = 1;
        gt.pan = 0;
        delete gt.panEnv;
        const mute = mutePts.length ? withMuteAutomation(null, 1, mutePts, state.sampleRate) : null;
        if (mute) gt.volumeEnv = mute;
        else delete gt.volumeEnv;
      }
    } else if (t.type === 'audio') {
      for (const c of state.clips) {
        if (c.trackId !== t.id || c.mute) continue;
        if (clipIds && !clipIds.has(c.id)) continue;
        let key = keyOf.get(c.sourceId);
        const p = plan.get(c.id);
        if (!key || !p) continue;
        let src = pool.get(c.sourceId);
        // Source channel routing: the clip plays the source channels it picks, as a source of their own.
        const routed = routedChannels(c, src.channels);
        if (routed !== src.channels) {
          key = sourceKey(routed);
          sources.set(key, routed);
          src = { ...src, channels: routed };
        }
        const srcLen = src.channels[0].length;
        // 5.1 tracks in a 5.1 mix play their clips without clip chains (the mix core runs those on
        // stereo tracks only), so they must not read ahead for the chain's latency either.
        const clipFx = c.fx?.length && !gt.six ? slotSpecs(c.fx, `clip:${c.id}`, rateDoc, 2, () => [clipAudio(c, pool.get(c.sourceId), state.sampleRate)]) : null;
        const timing = clipFx?.length ? rackTiming({ slots: c.fx }, state.sampleRate) : null;
        // Clip effect envelopes, on the timeline (the chain runs `latency` early, as the clip reads).
        if (clipFx?.length && c.fxEnv && Object.keys(c.fxEnv).length) automateSlots({ mode: 'read' }, clipFx, `clip:${c.id}`, c.fx, c.fxEnv, c.start - (timing?.latency || 0));
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
              fadeIn: p.fadeIn.duration ?? p.fadeIn.length,
              fadeInCurve: p.fadeIn.curve,
              fadeOut: p.fadeOut.duration ?? p.fadeOut.length,
              fadeOutCurve: p.fadeOut.curve,
              base: seg.start - c.start + cut,
              full: c.length,
            };
            if (p.fadeIn.offset) gc.fadeInOffset = p.fadeIn.offset;
            if (p.fadeOut.offset) gc.fadeOutOffset = p.fadeOut.offset;
            if (t.channels === 1 && src.channels.length > 1) gc.mono = true;
            if (c.volumeEnv.length) gc.gainEnv = dbEnvelopeToGain(expandHolds(clipEnvelope(c, 'volume')));
            if (c.panEnv.length) gc.panEnv = panEnvelope(expandHolds(clipEnvelope(c, 'pan')));
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
  const masterLat = rackLatency(m, state.sampleRate, surround ? 6 : 2);
  if (masterLat) master.latency = masterLat;
  if (m.invert) master.invert = true;
  if (m.eq?.on) master.fx = [...master.fx, ...eqSpecs(m, rateDoc)];
  const masterVol = m.mode !== 'off' && mo.volume === undefined && m.automation.volume.length ? dbEnvelopeToGain(expandHolds(m.automation.volume)) : null;
  const masterMute = m.mode !== 'off' && mo.mute === undefined ? m.automation.mute || [] : [];
  const masterEnv = withMuteAutomation(masterVol, master.gain, masterMute, state.sampleRate);
  if (masterEnv) {
    master.gain = 1;
    master.volumeEnv = masterEnv;
  }
  // Muting the master silences the mix (after its effects, so they keep their state).
  if (mo.mute !== undefined ? mo.mute >= 0.5 : !masterMute.length && m.mute) {
    master.gain = 0;
    delete master.volumeEnv;
  }
  // A mono master folds the mix to mono (both outputs carry it).
  if (m.channels === 1) master.mono = true;
  const graph = { rate: state.sampleRate, tracks, master };
  if (surround) graph.surround = true;
  if (panLaw && panLaw.mode === 'equalPower') graph.panLaw = { mode: 'equalPower', centerDb: panLaw.centerDb };
  // Tracks and buses with latent effects (lookahead, FFT) line up with the rest.
  if (compensate) compensateLatency(graph);
  return { graph, sources };
}

/** Kinds of metronome beat: accented, plain, soft, silent. */
export const BEAT_KINDS = ['down', 'up', 'sub', 'none'];

/** The accent pattern for a bar of `beatsPerBar` beats: a stored one fitted to length, or an accented first beat. */
export function metronomePattern(pattern, beatsPerBar = 4) {
  return Array.from({ length: beatsPerBar }, (_, i) => (BEAT_KINDS.includes(pattern?.[i]) ? pattern[i] : i === 0 ? 'down' : 'up'));
}

/**
 * One bar of metronome clicks at the session tempo, in a sound set from metronome-sounds.js. Each beat
 * follows the accent pattern: 'down' accented, 'up' plain, 'sub' a softer plain click, 'none' silent.
 */
export function metronomeBar(Channel, { sampleRate, tempo = 120, beatsPerBar = 4, beatNote = 4, sound = DEFAULT_METRONOME_SOUND, metronomePattern: pattern }) {
  // Tempo counts quarter notes; the beat note sets the length of a beat (as the bars-and-beats grid does).
  const beat = Math.round((60 / tempo) * (4 / (beatNote || 4)) * sampleRate);
  const n = beat * beatsPerBar;
  const out = new Float32Array(n);
  const accent = clickSound(sound, sampleRate, true);
  const normal = clickSound(sound, sampleRate, false);
  const kinds = metronomePattern(pattern, beatsPerBar);
  for (let b = 0; b < beatsPerBar; b++) {
    const kind = kinds[b];
    if (kind === 'none') continue;
    const click = kind === 'down' ? accent : normal;
    const at = b * beat;
    const part = click.subarray(0, Math.min(click.length, n - at));
    if (kind === 'sub') for (let i = 0; i < part.length; i++) out[at + i] = part[i] * 0.45;
    else out.set(part, at);
  }
  return [Channel.fromSamples(out)];
}
