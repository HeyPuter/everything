// Spectral editing on audio file states. A spectral selection (mask.js) is
// rasterised onto an STFT grid and processed in Rust; only the samples under
// masked analysis frames change, and they are written back as new blocks
// covering just the affected range.

import { rasterize, selectionBounds } from './mask.js';
import { maskBlend, healDelta } from '../analysis/dsp-ext.js';
import { lengthOf } from '../model/edits.js';

/** STFT size and hop for spectral processing at a sample rate. */
export function processingGrid(rate) {
  const n = rate > 64000 ? 4096 : 2048;
  return { n, hop: n / 4 };
}

/**
 * The analysis frame grid around a selection: a buffer of channel frames
 * [start, start + length) with columns centred at buffer index first + c * hop.
 */
export function selectionGrid(selection, rate) {
  const b = selectionBounds(selection);
  if (!b) return null;
  const { n, hop } = processingGrid(rate);
  // Pad by two windows so feathered columns and their windows fit inside.
  const start = Math.floor(b.t0) - 2 * n;
  const end = Math.ceil(b.t1) + 2 * n;
  const cols = Math.floor((end - start - n) / hop) + 1;
  const first = n / 2;
  return { start, length: (cols - 1) * hop + n, cols, first, n, hop };
}

/** Writes `delta` (added to `orig`) into channel at `start`, touching only changed frames. */
function writeDelta(channel, start, orig, delta) {
  let a = 0;
  let b = delta.length;
  while (a < b && delta[a] === 0) a++;
  while (b > a && delta[b - 1] === 0) b--;
  // Keep inside the channel.
  a = Math.max(a, -start);
  b = Math.min(b, channel.length - start);
  if (b <= a) return channel;
  const out = new Float32Array(b - a);
  for (let i = a; i < b; i++) out[i - a] = orig[i] + delta[i];
  return channel.write(start + a, out);
}

/**
 * Analysis columns processed per pass. The mask raster holds about two
 * values per sample, so a long selection (a hum band across an hour of
 * audio) is processed in segments of time to keep memory bounded.
 */
export const SEGMENT_COLS = 2048;

/**
 * Applies `fn` only inside a spectral selection: for each selected channel,
 * fn(samples, channelIndex, startFrame) returns processed samples (same
 * length; it may modify and return its input), and the result keeps the
 * original everywhere except the masked time-frequency region, with smooth
 * edges. `fn` may also be a number: a linear gain (0 removes the region).
 * Long selections call `fn` once per segment of time, with that segment's
 * samples and start frame. Returns a new state (the input state when
 * nothing changes).
 */
export function applySpectralMask(state, selection, fn, d, { segment = SEGMENT_COLS } = {}) {
  const rate = state.sampleRate;
  const grid = selectionGrid(selection, rate);
  if (!grid || !lengthOf(state)) return state;
  const process = typeof fn === 'number' ? gainFn(fn) : fn;
  const { n, hop, first } = grid;
  // Columns whose windows overlap a column's window: each pass analyses this
  // many more on both sides, so its mask edges (feathering reaches two
  // columns) and overlap-add normalisation match a single pass exactly.
  const margin = Math.ceil(n / hop);
  const channels = state.channels.slice();
  let changed = false;
  for (let c0 = 0; c0 < grid.cols; c0 += segment) {
    const c1 = Math.min(grid.cols, c0 + segment);
    const a = Math.max(0, c0 - margin);
    const b = Math.min(grid.cols, c1 + margin);
    const cols = b - a;
    const start = grid.start + a * hop;
    const length = (cols - 1) * hop + n;
    const mask = rasterize(selection, { first: start + first, cols, hop, n, rate });
    // Only this pass's own columns; the margins belong to the neighbouring passes.
    const bins = n / 2 + 1;
    mask.fill(0, 0, (c0 - a) * bins);
    mask.fill(0, (c1 - a) * bins);
    if (!mask.some((w) => w > 0)) continue;
    state.channels.forEach((ch, i) => {
      if (selection.channels && selection.channels[i] === false) return;
      const orig = ch.read(start, new Float32Array(length));
      const processed = process(orig.slice(), i, start);
      const diff = new Float32Array(length);
      let any = false;
      for (let k = 0; k < length; k++) {
        diff[k] = processed[k] - orig[k];
        if (diff[k] !== 0) any = true;
      }
      if (!any) return;
      const delta = maskBlend(d, diff, mask, cols, n, hop, first);
      // Passes overlap by a window: add to what earlier passes wrote.
      const cur = channels[i] === ch ? orig : channels[i].read(start, new Float32Array(length));
      const next = writeDelta(channels[i], start, cur, delta);
      if (next !== channels[i]) changed = true;
      channels[i] = next;
    });
  }
  return changed ? { ...state, channels } : state;
}

/** Spot healing: rebuilds the selected region from the spectrum around it in time. */
export function healSpectral(state, selection, d) {
  const rate = state.sampleRate;
  const grid = selectionGrid(selection, rate);
  if (!grid || !lengthOf(state)) return state;
  const mask = rasterize(selection, { first: grid.start + grid.first, cols: grid.cols, hop: grid.hop, n: grid.n, rate, growBins: 1, growCols: 1 });
  let changed = false;
  const channels = state.channels.map((ch, i) => {
    if (selection.channels && selection.channels[i] === false) return ch;
    const orig = ch.read(grid.start, new Float32Array(grid.length));
    const delta = healDelta(d, orig, mask, grid.cols, grid.n, grid.hop, grid.first);
    const next = writeDelta(ch, grid.start, orig, delta);
    if (next !== ch) changed = true;
    return next;
  });
  return changed ? { ...state, channels } : state;
}

function gainFn(g) {
  return (a) => {
    for (let i = 0; i < a.length; i++) a[i] *= g;
    return a;
  };
}

/**
 * Restricts an already computed edit to the selection: takes the samples of
 * `next` (same length as `prev`) inside the mask and `prev` elsewhere. Used to
 * make any effect respect a spectral selection.
 */
export function restrictEdit(prev, next, selection, d) {
  if (lengthOf(prev) !== lengthOf(next) || prev.channels.length !== next.channels.length) return next;
  if (next.channels.every((c, i) => c === prev.channels[i])) return next;
  const restricted = applySpectralMask(prev, selection, (samples, i, start) => next.channels[i].read(start, new Float32Array(samples.length)), d);
  return { ...next, channels: restricted.channels };
}
