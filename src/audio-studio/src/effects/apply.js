// Destructive effect processing for audio files: renders an effect (or a
// chain of slot specs) over a range and returns the new file state. Realtime
// effects render through the offline Worker with the same WASM code as
// playback (applyChain); offline-only effects run their definition's
// `process`. Reverb and delay tails render past the selection and are mixed
// into the audio that follows it.

import { Channel } from '../audio/channel.js';
import { lengthOf, replaceRange } from '../model/edits.js';
import { slotSpec } from './registry.js';
import { normalizeValues } from './params.js';
import { routeInputs, routeOutputs, routeMask } from './routing.js';
import { createMarker, sortMarkers, nextMarkerName } from '../model/markers.js';
import { UserError } from '../lib/errors.js';

/** The offline renderer, loaded on first use (it spawns a Worker). Tests pass their own. */
export async function lazyApplyChain(...args) {
  const { applyChain } = await import('../engine/offline.js');
  return applyChain(...args);
}

export function isRealtime(def) {
  return def.kind != null && def.realtime !== false;
}

/** Tail frames an effect needs after the selection (reverb, echo). */
export function tailFrames(def, values, rate) {
  if (!def.tail) return 0;
  const n = Math.round(Number(def.tail(values, rate)) || 0);
  return Math.max(0, Math.min(n, rate * 60));
}

/** Processing delay (lookahead, STFT) in frames that renders must compensate. */
export function latencyFrames(def, values, rate) {
  if (!def.latency) return 0;
  return Math.max(0, Math.round(Number(def.latency(values, rate)) || 0));
}

/** Adds markers returned by an offline process (relative to `start`) to a state. */
export function addMarkers(state, start, markers) {
  if (!markers?.length) return state;
  const list = state.markers.slice();
  for (const m of markers) list.push(createMarker({ ...m, start: start + (m.start || 0), name: m.name || nextMarkerName(list) }));
  return { ...state, markers: sortMarkers(list) };
}

/**
 * Writes processed audio back into a state.
 *  outs[i]   samples for channel i (fewer outputs repeat the last one)
 *  mask      channels to write (null = all)
 *  tail      frames past (end - start) in outs that are added to the audio after `end`
 * When an offline effect changes the length (stretch) and every channel is
 * written, the range is replaced and markers shift; with a partial channel
 * mask the result is fitted to the original length so channels stay in sync.
 */
export function writeResult(state, start, end, outs, mask, { tail = 0 } = {}) {
  const len = lengthOf(state);
  const n = end - start;
  const all = !mask || mask.every(Boolean);
  const pick = (i) => outs[Math.min(i, outs.length - 1)];
  const bodyLen = outs[0].length - tail;
  if (bodyLen !== n && all) {
    const clip = { channels: state.channels.map((_, i) => Channel.fromSamples(pick(i).slice(0, bodyLen))) };
    return replaceRange(state, start, end, clip, null);
  }
  const room = Math.max(0, Math.min(tail, len - end));
  return {
    ...state,
    channels: state.channels.map((c, i) => {
      if (mask && !mask[i]) return c;
      const out = pick(i);
      const body = new Float32Array(n);
      body.set(out.subarray(0, Math.min(n, bodyLen)));
      let next = c.write(start, body);
      if (room > 0 && tail > 0) {
        const mixed = c.toArray(end, end + room);
        for (let k = 0; k < room; k++) mixed[k] += out[bodyLen + k];
        next = next.write(end, mixed);
      }
      return next;
    }),
  };
}

/**
 * Renders one effect over [start, end) of `state` and returns
 * { state, length } where length is the processed range's new length.
 */
export async function renderEffect({ def, values, state, start, end, mask = null, route = null, signal, onProgress, doc, app, applyChain = lazyApplyChain }) {
  values = normalizeValues(def, values);
  // A channel route (the dialog's channel map) decides which channels are written.
  if (route) mask = routeMask(route, state.channels.length, mask);
  const rate = state.sampleRate;
  if (end <= start) throw new UserError('There is no audio to process.');
  if (def.process) {
    const dry = state.channels.map((c) => c.toArray(start, end));
    const channels = routeInputs(dry, route);
    const result = await def.process({ channels, rate, values, signal, onProgress, doc, app, mask, start, end });
    if (signal?.aborted) throw abortError();
    let outs = Array.isArray(result) ? result : result?.channels;
    if (!Array.isArray(outs) || !outs.length) throw new Error(`${def.name} did not return audio.`);
    if (route && outs[0].length === end - start) outs = routeOutputs(outs, dry, route);
    let next = writeResult(state, start, end, outs, mask);
    if (!Array.isArray(result)) next = addMarkers(next, start, result.markers);
    return { state: next, length: outs[0].length };
  }
  if (!isRealtime(def)) throw new UserError(`${def.name} cannot be applied yet.`);
  const tail = tailFrames(def, values, rate);
  const latency = latencyFrames(def, values, rate);
  const channels = state.channels.length;
  const routed = channels === 2 ? route : null;
  const spec = slotSpec(def, values, { key: 'apply', doc, rate, route: routed, channels });
  const outs = await applyChain(state.channels, rate, [spec], { start, end, tail, latency, onProgress, signal });
  if (signal?.aborted) throw abortError();
  return { state: writeResult(state, start, end, outs, mask, { tail }), length: end - start };
}

export function abortError() {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

export function isAbort(err) {
  return err?.name === 'AbortError' || err?.message === 'Cancelled';
}
