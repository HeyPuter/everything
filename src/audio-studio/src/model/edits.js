// Pure edit operations on audio file states. A state is
//   { sampleRate, channels: Channel[], markers: Marker[] }
// and every function returns a new state without touching its input.
// `mask` is an array of booleans: which channels the edit applies to. When an
// edit that changes length targets only some channels, the others would drift
// out of sync, so such edits overwrite with silence instead.

import { Channel } from '../audio/channel.js';
import { shiftMarkersForDelete, shiftMarkersForInsert } from './markers.js';

export function lengthOf(state) {
  return state.channels.length ? state.channels[0].length : 0;
}

export function allChannels(state) {
  return state.channels.map(() => true);
}

function isAll(state, mask) {
  return !mask || mask.every(Boolean);
}

function clampRange(state, start, end) {
  const len = lengthOf(state);
  start = Math.max(0, Math.min(len, Math.round(start)));
  end = Math.max(start, Math.min(len, Math.round(end)));
  return [start, end];
}

/** Clip data: { sampleRate, channels: Channel[] } copied out of a range. */
export function copyRange(state, start, end, mask) {
  [start, end] = clampRange(state, start, end);
  const channels = state.channels.filter((_, i) => !mask || mask[i]).map((c) => c.slice(start, end));
  return { sampleRate: state.sampleRate, channels };
}

/**
 * Removes [start, end). With `smooth` (frames), the audio on either side of
 * the splice is crossfaded over that many frames centred on the join, so the
 * cut does not click; the result is just as long as a plain delete.
 */
export function deleteRange(state, start, end, mask, { smooth = 0 } = {}) {
  [start, end] = clampRange(state, start, end);
  if (end <= start) return state;
  if (!isAll(state, mask)) return silenceRange(state, start, end, mask);
  const len = lengthOf(state);
  const half = Math.min(Math.floor(Math.max(0, smooth) / 2), start, len - end, end - start);
  return {
    ...state,
    channels: state.channels.map((c) => {
      const out = c.splice(start, end);
      if (half < 1) return out;
      const n = half * 2;
      const before = c.toArray(start - half, start + half);
      const after = c.toArray(end - half, end + half);
      const join = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const w = (i + 0.5) / n;
        join[i] = before[i] * (1 - w) + after[i] * w;
      }
      return out.write(start - half, join);
    }),
    markers: shiftMarkersForDelete(state.markers, start, end, len - (end - start)),
  };
}

/**
 * Crossfades the edges of a processed range back into the original audio:
 * `before` and `after` are states of equal length that differ inside
 * [start, end). The first and last `frames` of the range blend from the
 * original to the processed audio, so effect edges do not click. Edges at the
 * file start or end are left as they are.
 */
export function smoothBoundaries(before, after, start, end, frames, mask) {
  const len = lengthOf(after);
  if (!(frames >= 1) || lengthOf(before) !== len || before.channels.length !== after.channels.length) return after;
  [start, end] = clampRange(after, start, end);
  const n = Math.min(Math.round(frames), Math.floor((end - start) / 2));
  if (n < 1) return after;
  return {
    ...after,
    channels: after.channels.map((c, ch) => {
      if ((mask && !mask[ch]) || c === before.channels[ch]) return c;
      const orig = before.channels[ch];
      let out = c;
      if (start > 0) {
        const a = orig.toArray(start, start + n);
        const b = c.toArray(start, start + n);
        for (let i = 0; i < n; i++) {
          const w = (i + 0.5) / n;
          b[i] = a[i] * (1 - w) + b[i] * w;
        }
        out = out.write(start, b);
      }
      if (end < len) {
        const a = orig.toArray(end - n, end);
        const b = c.toArray(end - n, end);
        for (let i = 0; i < n; i++) {
          const w = (i + 0.5) / n;
          b[i] = b[i] * (1 - w) + a[i] * w;
        }
        out = out.write(end - n, b);
      }
      return out;
    }),
  };
}

/** Markers inside [start, end), relative to start (for the clipboard). Ranges are clipped to it. */
export function markersInRange(markers = [], start, end) {
  const out = [];
  for (const m of markers) {
    const s = Math.max(start, m.start);
    const e = m.duration ? Math.min(end, m.start + m.duration) : m.start;
    if (m.duration ? e > s : m.start >= start && m.start < end) out.push({ ...m, start: s - start, duration: m.duration ? e - s : 0 });
  }
  return out;
}

export function cropRange(state, start, end) {
  [start, end] = clampRange(state, start, end);
  const len = lengthOf(state);
  let s = deleteRange(state, end, len);
  s = deleteRange(s, 0, start);
  return s;
}

export function silenceRange(state, start, end, mask) {
  [start, end] = clampRange(state, start, end);
  if (end <= start) return state;
  return {
    ...state,
    channels: state.channels.map((c, i) => (mask && !mask[i] ? c : c.splice(start, end, Channel.silence(end - start)))),
  };
}

/**
 * Maps clip channels onto `count` destination channels: mono spreads, extra
 * channels drop, and destination channels a multichannel clip does not have
 * (the centre and surrounds of a 5.1 file under a stereo clip) are silent.
 * With `reuse`, those channels take the clip's last channel instead (pasting
 * into channels the user picked).
 */
export function conformChannels(clip, count, { reuse = false } = {}) {
  const src = clip.channels;
  if (!src.length) return Array.from({ length: count }, () => Channel.empty());
  if (src.length === 1 || reuse) return Array.from({ length: count }, (_, i) => src[Math.min(i, src.length - 1)]);
  return Array.from({ length: count }, (_, i) => src[i] ?? Channel.silence(src[0].length));
}

/**
 * Inserts `clip` at `at`. With a partial mask, the clip overwrites the masked
 * channels starting at `at` (lengths stay equal) instead of inserting; a clip
 * running past the end grows the file, with silence in the other channels.
 */
export function insertClip(state, at, clip, mask) {
  const len = lengthOf(state);
  at = Math.max(0, Math.min(len, Math.round(at)));
  const channels = conformChannels(clip, state.channels.length, { reuse: !isAll(state, mask) });
  const n = channels[0]?.length ?? 0;
  if (!n) return state;
  if (!isAll(state, mask)) {
    const grown = at + n > len ? insertSilence(state, len, at + n - len) : state;
    return {
      ...grown,
      channels: grown.channels.map((c, i) => (mask[i] ? c.splice(at, at + n, channels[i]) : c)),
    };
  }
  return {
    ...state,
    channels: state.channels.map((c, i) => c.splice(at, at, channels[i])),
    markers: shiftMarkersForInsert(state.markers, at, n),
  };
}

/** Replaces [start, end) with clip (paste over a selection). */
export function replaceRange(state, start, end, clip, mask) {
  return insertClip(deleteRange(state, start, end, mask), start, clip, mask);
}

export function insertSilence(state, at, frames) {
  const clip = { channels: state.channels.map(() => Channel.silence(frames)) };
  return insertClip(state, at, clip);
}

/**
 * Mixes clip into the state at `at` without changing length beyond the end,
 * which grows the file when the clip runs past it. Gains are linear.
 */
export function mixPaste(state, at, clip, { existing = 1, pasted = 1, mask } = {}) {
  const len = lengthOf(state);
  at = Math.max(0, Math.round(at));
  const src = conformChannels(clip, state.channels.length);
  const n = src[0]?.length ?? 0;
  if (!n) return state;
  const end = at + n;
  let s = state;
  if (end > len) s = insertSilence(s, len, end - len);
  return {
    ...s,
    channels: s.channels.map((c, i) => {
      if (mask && !mask[i]) return c;
      const out = c.toArray(at, end);
      const add = src[i].toArray(0, n);
      for (let k = 0; k < n; k++) out[k] = out[k] * existing + add[k] * pasted;
      return c.write(at, out);
    }),
  };
}

/**
 * Runs `fn(samples, channelIndex)` over [start, end) of each masked channel,
 * where fn returns new samples of the same length (or mutates and returns the input copy).
 */
export function mapRange(state, start, end, mask, fn) {
  [start, end] = clampRange(state, start, end);
  if (end <= start) return state;
  return {
    ...state,
    channels: state.channels.map((c, i) => {
      if (mask && !mask[i]) return c;
      const out = fn(c.toArray(start, end), i);
      return c.write(start, out);
    }),
  };
}

/** Linear gain over a range. */
export function gainRange(state, start, end, gain, mask) {
  return mapRange(state, start, end, mask, (a) => {
    for (let i = 0; i < a.length; i++) a[i] *= gain;
    return a;
  });
}

export function reverseRange(state, start, end, mask) {
  return mapRange(state, start, end, mask, (a) => a.reverse());
}

export function invertRange(state, start, end, mask) {
  return gainRange(state, start, end, -1, mask);
}

/** Fade shapes: 0 linear, positive values bend logarithmic, negative exponential, 2 cosine (S-curve). */
export function fadeCurve(t, curve = 0) {
  if (curve === 0) return t;
  if (curve === 2) return 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t)));
  if (curve > 0) return Math.pow(t, 1 / (1 + curve * 3));
  return Math.pow(t, 1 - curve * 3);
}

export function fadeRange(state, start, end, direction, curve = 0, mask) {
  return mapRange(state, start, end, mask, (a) => {
    const n = a.length;
    for (let i = 0; i < n; i++) {
      const t = n <= 1 ? 1 : i / (n - 1);
      a[i] *= fadeCurve(direction === 'in' ? t : 1 - t, curve);
    }
    return a;
  });
}

/** Converts channel layout: 1 = mono (average), 2 = stereo (duplicate or keep first two). */
export function convertChannels(state, count) {
  const src = state.channels;
  if (src.length === count) return state;
  if (count === 1) {
    const len = lengthOf(state);
    const out = new Float32Array(len);
    for (const c of src) {
      c.forEachRun(0, len, (run, at) => {
        for (let i = 0; i < run.length; i++) out[at + i] += run[i] / src.length;
      });
    }
    return { ...state, channels: [Channel.fromSamples(out)] };
  }
  return { ...state, channels: Array.from({ length: count }, (_, i) => src[Math.min(i, src.length - 1)]) };
}
