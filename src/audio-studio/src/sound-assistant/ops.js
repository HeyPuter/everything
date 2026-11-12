// Sound Assistant operations on documents.
//
// Sessions: settings live on each clip (clip.soundAssistant) and their effect
// chain in clip.fx, which the session graph renders per clip in realtime
// (engine/mixcore.js), so playback, mixdown and export all hear it. Clip
// Volume is the clip's own gain and mute. Duration renders the clip's
// source range through Stretch and Pitch into a new pool source (the
// original is kept so turning Duration off restores it). Ducking writes
// keyframes into the clip's volume envelope.
//
// Waveform editor: settings are kept per file (not undoable, like the Effects
// Rack). Preview routes playback through the chain (app.previewFx); Apply
// renders chain, loudness match, volume and duration as one undo step.

import { Channel } from '../audio/channel.js';
import * as S from '../model/session-edits.js';
import * as E from '../model/edits.js';
import { getEffect, slotSpec, chainTiming } from '../effects/index.js';
import { normalizeValues } from '../effects/params.js';
import { lazyApplyChain, writeResult, renderEffect } from '../effects/apply.js';
import { measureLoudness } from '../analysis/loudness.js';
import { defaultSettings, normalizeSettings, chainSlots, assistantChain, setPath, loudnessGain, durationStretch, duckingKeyframes, duckTriggers } from './model.js';

// ---------------------------------------------------------------- shared

/** Registry entries for a chain: [{ def, values, key }]. Unknown effects are skipped. */
export function resolveChain(chain) {
  return chain
    .map((e) => {
      const def = getEffect(e.effect);
      return def ? { def, values: normalizeValues(def, e.values), key: e.id } : null;
    })
    .filter(Boolean);
}

/** Slot specs (mix graph) for a chain; `prefix` keeps keys unique. */
export function chainSpecs(chain, prefix, rate, doc = null) {
  return resolveChain(chain).map((e) => slotSpec(e.def, e.values, { key: `${prefix}:${e.key}`, doc, rate }));
}

/**
 * Renders a chain over Channel[] frames [start, end) in the offline worker.
 * Returns Float32Array[] (end - start + tail frames) and the tail length.
 */
export async function renderChain(channels, rate, chain, { start = 0, end = channels[0].length, signal, onProgress, applyChain = lazyApplyChain } = {}) {
  const entries = resolveChain(chain);
  if (!entries.length) return { outs: channels.map((c) => c.toArray(start, end)), tail: 0 };
  const { latency, tail } = chainTiming(entries, rate);
  const specs = entries.map((e) => slotSpec(e.def, e.values, { key: `sa:${e.key}`, rate }));
  const outs = await applyChain(channels, rate, specs, { start, end, tail, latency, signal, onProgress });
  return { outs, tail };
}

/** Integrated loudness (LUFS) of Float32Array channels. */
export async function loudnessOf(outs, rate, measure = measureLoudness) {
  const r = await measure({ channels: outs.map((o) => Channel.fromSamples(o)), sampleRate: rate });
  return Number.isFinite(r.integrated) ? r.integrated : null;
}

// --------------------------------------------------------------- sessions

/**
 * Normalized settings of a clip, or null when it has no audio type. Clip
 * Volume always reflects the clip's own gain and mute (the Properties panel
 * and the clip handles edit those too).
 */
export function clipSettings(clip) {
  if (!clip?.soundAssistant) return null;
  const s = normalizeSettings(clip.soundAssistant);
  return s ? { ...s, volume: { level: clip.gain, mute: clip.mute } } : null;
}

/** The clip patch that stores `settings` (chain in fx; volume in gain and mute). */
export function clipPatch(clip, settings) {
  if (!settings) return { soundAssistant: null, fx: [] };
  return { soundAssistant: settings, fx: chainSlots(settings), gain: settings.volume.level, mute: settings.volume.mute };
}

/** Regenerates ducking keyframes for every clip with Ducking on (and clears ones turned off). */
export function regenerateDucking(state) {
  const rate = state.sampleRate;
  let next = state;
  for (const c of state.clips) {
    const s = c.soundAssistant;
    const d = s?.ducking;
    if (d?.on) {
      const env = duckingKeyframes({ clip: c, triggers: duckTriggers(state.clips, d.against, c.id), sensitivity: d.sensitivity, reduce: d.reduce, fade: d.fade, rate });
      if (JSON.stringify(env) !== JSON.stringify(c.volumeEnv) || !d.generated) {
        next = S.updateClips(next, [c.id], { volumeEnv: env, soundAssistant: { ...s, ducking: { ...d, generated: true } } });
      }
    } else if (d?.generated) {
      next = S.updateClips(next, [c.id], { volumeEnv: [], soundAssistant: { ...s, ducking: { ...d, generated: false } } });
    }
  }
  return next;
}

/** Assigns an audio type to clips (keeps settings when a clip already has that type). */
export function assignType(state, ids, type) {
  let next = state;
  for (const id of ids) {
    const c = S.findClip(next, id);
    if (!c) continue;
    if (c.soundAssistant?.type === type) continue;
    const s = setPath(defaultSettings(type), ['volume'], { level: c.gain, mute: c.mute });
    next = S.updateClips(next, [id], clipPatch(c, s));
  }
  return regenerateDucking(next);
}

/** Removes the audio type (and its chain) from clips; a stretched clip returns to its original audio. */
export function clearType(state, ids) {
  let next = state;
  for (const id of ids) {
    const c = S.findClip(next, id);
    if (!c?.soundAssistant) continue;
    const orig = c.soundAssistant.duration?.orig;
    const patch = { soundAssistant: null, fx: [] };
    if (c.soundAssistant.ducking?.generated) patch.volumeEnv = [];
    if (orig) Object.assign(patch, { sourceId: orig.sourceId, offset: orig.offset, length: orig.length, volumeEnv: patch.volumeEnv ?? scaleEnvelope(c.volumeEnv, orig.length / c.length), panEnv: scaleEnvelope(c.panEnv, orig.length / c.length) });
    next = S.updateClips(next, [id], patch);
  }
  return regenerateDucking(next);
}

/**
 * Sets one setting on every clip in `ids` that has `type`. Per-clip values
 * (measured loudness, stretch origin) are left alone unless they are the path.
 */
export function editClips(state, ids, type, path, value) {
  let next = state;
  for (const id of ids) {
    const c = S.findClip(next, id);
    const s = clipSettings(c);
    if (!s || s.type !== type) continue;
    let updated = setPath(s, path, value);
    if (path[0] !== 'volume') updated = { ...updated, preset: '' };
    next = S.updateClips(next, [id], clipPatch(c, updated));
  }
  return path[0] === 'ducking' || path[0] === 'volume' ? regenerateDucking(next) : next;
}

/** Replaces whole settings (a preset) on clips of the same type, keeping each clip's per-clip fields. */
export function setClipSettings(state, ids, fn) {
  let next = state;
  for (const id of ids) {
    const c = S.findClip(next, id);
    const s = clipSettings(c);
    if (!s) continue;
    let updated = normalizeSettings(fn(s, c));
    // Keep track of envelopes ducking wrote so turning it off clears them.
    if (s.ducking?.generated && updated?.ducking) updated = setPath(updated, ['ducking', 'generated'], true);
    next = S.updateClips(next, [id], clipPatch(c, updated));
  }
  return regenerateDucking(next);
}

function scaleEnvelope(points, k) {
  return (points || []).map((p) => ({ ...p, t: Math.round(p.t * k) }));
}

/**
 * Measures each clip's loudness through its chain (without the loudness gain)
 * and stores it, so the chain's gain meets the target. Returns the new state.
 */
export async function autoMatchClips(session, ids, { signal, onProgress, applyChain = lazyApplyChain, measure = measureLoudness } = {}) {
  const rate = session.sampleRate;
  const results = [];
  for (let i = 0; i < ids.length; i++) {
    const c = S.findClip(session.state, ids[i]);
    const s = clipSettings(c);
    const src = c && session.pool.get(c.sourceId);
    if (!s || !src?.channels?.length) continue;
    const srcLen = src.channels[0].length;
    const start = Math.min(c.offset, srcLen);
    const end = Math.min(srcLen, c.offset + c.length);
    if (end <= start) continue;
    const { outs } = await renderChain(src.channels, rate, assistantChain(s, { loudness: false }), { start, end, signal, applyChain, onProgress: (f) => onProgress?.((i + f * 0.8) / ids.length) });
    const lufs = await loudnessOf(outs.map((o) => o.subarray(0, end - start)), rate, measure);
    results.push({ id: c.id, lufs });
  }
  let next = session.state;
  for (const r of results) {
    const c = S.findClip(next, r.id);
    const s = clipSettings(c);
    if (!s) continue;
    next = S.updateClips(next, [r.id], clipPatch(c, setPath(setPath(s, ['loudness', 'measured'], r.lufs), ['loudness', 'on'], true)));
  }
  return { state: next, results };
}

/**
 * Stretches clips to their Duration targets (or restores the original when
 * Duration is off). New audio goes into the session pool. Returns the new state.
 */
export async function applyDurationClips(session, ids, { signal, onProgress } = {}) {
  const rate = session.sampleRate;
  const def = getEffect('stretchPitch');
  let next = session.state;
  for (let i = 0; i < ids.length; i++) {
    const c = S.findClip(next, ids[i]);
    const s = clipSettings(c);
    if (!s?.duration) continue;
    const orig = s.duration.orig || { sourceId: c.sourceId, offset: c.offset, length: c.length };
    if (!s.duration.on) {
      if (s.duration.orig) next = S.updateClips(next, [c.id], { ...clipPatch(c, setPath(s, ['duration', 'orig'], null)), sourceId: orig.sourceId, offset: orig.offset, length: orig.length, volumeEnv: scaleEnvelope(c.volumeEnv, orig.length / c.length), panEnv: scaleEnvelope(c.panEnv, orig.length / c.length) });
      continue;
    }
    const src = session.pool.get(orig.sourceId);
    if (!src?.channels?.length) continue;
    const stretch = durationStretch(s, orig.length, rate);
    if (stretch == null) continue;
    const srcLen = src.channels[0].length;
    const a = Math.min(orig.offset, srcLen);
    const b = Math.min(srcLen, orig.offset + orig.length);
    const channels = src.channels.map((ch) => ch.toArray(a, b));
    const outs = await def.process({ channels, rate, values: normalizeValues(def, { algorithm: 0, stretch }), signal, onProgress: (f) => onProgress?.((i + f) / ids.length) });
    const list = Array.isArray(outs) ? outs : outs.channels;
    const sourceId = session.addSource({ name: `${src.name} (${Math.round(s.duration.seconds * 10) / 10} s)`, channels: list.map((o) => Channel.fromSamples(o)) });
    const length = list[0].length;
    const k = length / c.length;
    next = S.updateClips(next, [c.id], {
      ...clipPatch(c, setPath(s, ['duration', 'orig'], orig)),
      sourceId,
      offset: 0,
      length,
      loop: false,
      fadeIn: { ...c.fadeIn, length: Math.min(length, c.fadeIn.length) },
      fadeOut: { ...c.fadeOut, length: Math.min(length, c.fadeOut.length) },
      volumeEnv: scaleEnvelope(c.volumeEnv, k),
      panEnv: scaleEnvelope(c.panEnv, k),
    });
  }
  return regenerateDucking(next);
}

// ---------------------------------------------------------- waveform files

const fileSettings = new WeakMap();

export function getFileSettings(doc) {
  return fileSettings.get(doc) || null;
}

export function setFileSettings(doc, settings) {
  if (settings) fileSettings.set(doc, normalizeSettings(settings));
  else fileSettings.delete(doc);
}

/** Preview chain (slot specs) for a file: everything Apply renders except Duration. */
export function filePreviewSpecs(settings, rate) {
  return chainSpecs(assistantChain(settings, { loudness: true, volume: true }), 'assistant', rate);
}

/**
 * Renders a file's settings over [start, end) and returns { state, length }.
 * Order: chain, loudness match (measured on the processed audio), clip
 * volume, then Duration (stretch).
 */
export async function renderFile({ settings, state, start, end, mask = null, signal, onProgress, applyChain = lazyApplyChain, measure = measureLoudness }) {
  const s = normalizeSettings(settings);
  const rate = state.sampleRate;
  const chain = assistantChain(s, { loudness: false, volume: false });
  let next = state;
  let length = end - start;
  const step = (a, b) => (f) => onProgress?.(a + (b - a) * f);
  let rendered = null;
  if (chain.length) {
    rendered = await renderChain(state.channels, rate, chain, { start, end, signal, applyChain, onProgress: step(0, 0.6) });
    next = writeResult(next, start, end, rendered.outs, mask, { tail: rendered.tail });
  }
  let gainDb = s.volume?.level || 0;
  if (s.loudness?.on) {
    const outs = next.channels.map((c) => c.toArray(start, end));
    const lufs = await loudnessOf(outs, rate, measure);
    if (lufs != null) gainDb += Math.max(-40, Math.min(30, s.loudness.target - lufs));
  }
  onProgress?.(0.7);
  if (Math.abs(gainDb) > 0.001) {
    const g = Math.pow(10, gainDb / 20);
    next = E.gainRange(next, start, end, g, mask);
    // An effect tail mixed in past the range (reverb) belongs to the processed audio: same gain.
    if (rendered?.tail) next = addTail(next, start, end, rendered, g - 1, mask);
  }
  const stretch = durationStretch(s, end - start, rate);
  if (stretch != null) {
    const def = getEffect('stretchPitch');
    const r = await renderEffect({ def, values: { algorithm: 0, stretch }, state: next, start, end, mask, signal, onProgress: step(0.7, 1) });
    next = r.state;
    length = r.length;
  }
  onProgress?.(1);
  return { state: next, length };
}

/** Adds k times the effect tail that writeResult mixed in after `end` (the same frames it wrote). */
function addTail(state, start, end, { outs, tail }, k, mask) {
  const body = outs[0].length - tail;
  // writeResult replaces the range without its tail when the length changed.
  if (body !== end - start && (!mask || mask.every(Boolean))) return state;
  const room = Math.max(0, Math.min(tail, E.lengthOf(state) - end));
  if (!room) return state;
  return {
    ...state,
    channels: state.channels.map((c, i) => {
      if (mask && !mask[i]) return c;
      const out = outs[Math.min(i, outs.length - 1)];
      const mixed = c.toArray(end, end + room);
      for (let j = 0; j < room; j++) mixed[j] += k * out[body + j];
      return c.write(end, mixed);
    }),
  };
}

/** Loudness of a file range through its chain (for Auto-Match before Apply). */
export async function measureFile(settings, state, start, end, { signal, onProgress, applyChain = lazyApplyChain, measure = measureLoudness } = {}) {
  const { outs } = await renderChain(state.channels, state.sampleRate, assistantChain(settings, { loudness: false }), { start, end, signal, applyChain, onProgress });
  return loudnessOf(outs.map((o) => o.subarray(0, end - start)), state.sampleRate, measure);
}

export { loudnessGain };
