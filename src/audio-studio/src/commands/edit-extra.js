// Edit menu extras for the Waveform editor: zero-crossing selection
// adjustment, Rename, Extract Channels to Mono Files and the Frequency Band
// Splitter.

import { AudioFile } from '../model/audio-file.js';
import { channelLabel } from '../model/edits.js';
import { Channel } from '../audio/channel.js';
import { biquadCoefficients } from '../effects/biquad.js';
import { baseName } from '../audio/decode.js';
import { promptDialog } from '../ui/dialog.js';
import { createMarker, nextMarkerName, sortMarkers } from '../model/markers.js';
import { bandSplitterDialog } from './band-splitter.js';

const audio = (app) => (app.active?.kind === 'audio' ? app.active : null);
const hasAudio = (app) => Boolean(audio(app));
const hasSel = (app) => Boolean(audio(app)?.hasSelection);

// ------------------------------------------------------------ zero crossings

/** How far (in frames) to look for a zero crossing before giving up. */
const ZERO_SEARCH = 1 << 16;

/**
 * Nearest zero crossing of the enabled channels, searching from `frame` in
 * `dir` (-1 left, +1 right). A crossing at i means samples i-1 and i differ in
 * sign (or i is exactly zero); with several channels the sum of the enabled
 * channels is used, so the cut lands where the mix is quiet. Returns `frame`
 * when no crossing is found within ZERO_SEARCH frames.
 */
export function findZeroCrossing(state, frame, dir, mask = null) {
  const chans = state.channels.filter((_, i) => !mask || mask[i]);
  const len = chans[0]?.length ?? 0;
  if (!len) return frame;
  const a = dir < 0 ? Math.max(0, frame - ZERO_SEARCH) : Math.max(0, frame - 1);
  const b = dir < 0 ? Math.min(len, frame + 1) : Math.min(len, frame + ZERO_SEARCH);
  if (b - a < 2) return frame;
  const sum = new Float32Array(b - a);
  for (const c of chans) {
    const s = c.toArray(a, b);
    for (let i = 0; i < s.length; i++) sum[i] += s[i];
  }
  const crosses = (i) => sum[i] === 0 || (sum[i - 1] < 0 && sum[i] >= 0) || (sum[i - 1] > 0 && sum[i] <= 0);
  const at = frame - a;
  if (dir < 0) {
    for (let i = Math.min(at, sum.length - 1); i >= 1; i--) if (crosses(i)) return a + i;
  } else {
    for (let i = Math.max(1, at); i < sum.length; i++) if (crosses(i)) return a + i;
  }
  return frame;
}

const ZERO_COMMANDS = [
  ['inward', 'Adjust Selection Inward', (s, f) => [f(s.start, 1), f(s.end, -1)]],
  ['outward', 'Adjust Selection Outward', (s, f) => [f(s.start, -1), f(s.end, 1)]],
  ['leftToLeft', 'Adjust Left Side to Left', (s, f) => [f(s.start, -1), s.end]],
  ['leftToRight', 'Adjust Left Side to Right', (s, f) => [f(s.start, 1), s.end]],
  ['rightToLeft', 'Adjust Right Side to Left', (s, f) => [s.start, f(s.end, -1)]],
  ['rightToRight', 'Adjust Right Side to Right', (s, f) => [s.start, f(s.end, 1)]],
];

// --------------------------------------------------------- band splitting

/** Crossover steepness choices: Linkwitz-Riley 4th order (24 dB/oct) or 8th order (48 dB/oct). */
export const CROSSOVER_SLOPES = [
  { id: 24, label: '24 dB/octave' },
  { id: 48, label: '48 dB/octave (steeper)' },
];

/**
 * Linkwitz-Riley section: a Butterworth filter applied twice. 24 dB/oct
 * squares a 2nd-order Butterworth; 48 dB/oct a 4th-order one.
 */
function lr4(type, freq, rate, slope = 24) {
  if (slope === 48) {
    const a = biquadCoefficients(type, freq, 0, 0.5411961, rate);
    const b = biquadCoefficients(type, freq, 0, 1.3065630, rate);
    return [a, b, a, b];
  }
  const c = biquadCoefficients(type, freq, 0, Math.SQRT1_2, rate);
  return [c, c];
}

function runBiquads(sections, x) {
  const y = new Float32Array(x.length);
  y.set(x);
  for (const c of sections) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      const out = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = out;
      y[i] = out;
    }
  }
  return y;
}

/**
 * Splits `x` into crossovers.length + 1 bands with Linkwitz-Riley crossovers.
 * Each lower band also passes through the allpass of every higher crossover
 * (the sum of that crossover's low and high outputs), so all bands share the
 * same phase response and add back up to an allpassed copy of the input with
 * a flat magnitude.
 */
export function splitBands(x, crossovers, rate, slope = 24) {
  const freqs = crossovers.slice().sort((p, q) => p - q);
  const bands = [];
  let rest = x;
  for (let i = 0; i < freqs.length; i++) {
    const low = runBiquads(lr4('lowpass', freqs[i], rate, slope), rest);
    rest = runBiquads(lr4('highpass', freqs[i], rate, slope), rest);
    bands.push(low);
  }
  bands.push(rest);
  // Phase-align lower bands to the higher crossovers they skipped.
  for (let i = 0; i < freqs.length; i++) {
    for (let j = i + 1; j < freqs.length; j++) {
      const lo = runBiquads(lr4('lowpass', freqs[j], rate, slope), bands[i]);
      const hi = runBiquads(lr4('highpass', freqs[j], rate, slope), bands[i]);
      for (let k = 0; k < lo.length; k++) lo[k] += hi[k];
      bands[i] = lo;
    }
  }
  return bands;
}

/** Default crossover frequencies (Hz) for 2..8 bands: interior points of a log scale from 60 Hz to 12 kHz. */
export function defaultCrossovers(bandCount, rate) {
  const lo = 60;
  const hi = Math.min(12000, rate * 0.45);
  const n = bandCount - 1;
  if (n === 1) return [1000];
  const round = (f) => (f >= 1000 ? Math.round(f / 100) * 100 : Math.round(f / 10) * 10);
  return Array.from({ length: n }, (_, i) => round(lo * Math.pow(hi / lo, (i + 1) / (n + 1))));
}

/** Validation message for a crossover list, or '' when it is usable. */
export function crossoverProblem(crossovers, rate) {
  const sorted = crossovers.slice().sort((a, b) => a - b);
  if (sorted.some((f) => !Number.isFinite(f) || f < 20 || f >= rate / 2)) return `Crossovers must be between 20 Hz and ${Math.floor(rate / 2) - 1} Hz.`;
  if (sorted.some((f, i) => i && f <= sorted[i - 1] * 1.05)) return 'Crossovers must be at least 5% apart.';
  return '';
}

async function bandSplitter(app) {
  const doc = audio(app);
  const r = await bandSplitterDialog(app, doc);
  if (!r) return;
  const rate = doc.sampleRate;
  const freqs = r.crossovers.slice().sort((a, b) => a - b);
  const [a, b] = doc.editRange();
  const perChannel = doc.state.channels.map((c) => splitBands(c.toArray(a, b), freqs, rate, r.slope));
  const edges = [0, ...freqs, Math.round(rate / 2)];
  const fmt = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(1)} kHz` : `${f} Hz`);
  const base = baseName(doc.name);
  for (let band = 0; band <= freqs.length; band++) {
    const name = app.uniqueName(`${base} ${fmt(edges[band])}-${fmt(edges[band + 1])}`);
    const out = new AudioFile({ name, sampleRate: rate, channels: perChannel.map((bands) => Channel.fromSamples(bands[band])), info: { ...doc.info } });
    app.addDocument(out, { activate: band === 0 });
  }
  app.setStatus(`Split into ${freqs.length + 1} band files`);
}

// ------------------------------------------------------------ typed markers

/**
 * Adds a subclip or cart timer marker. Subclips always span the selection;
 * cart timers mark the selection when there is one, else the playhead.
 */
function addTypedMarker(app, type) {
  const doc = audio(app);
  const sel = doc.selection;
  const range = sel.end > sel.start;
  const start = range ? sel.start : app.engine.playing && app.active === doc ? Math.round(app.playhead) : doc.cursor;
  const prefix = type === 'subclip' ? 'Subclip' : 'Cart';
  const m = createMarker({ start, duration: range ? sel.end - sel.start : 0, type, name: nextMarkerName(doc.state.markers, prefix) });
  doc.apply(type === 'subclip' ? 'Add Subclip Marker' : 'Add Cart Timer Marker', { ...doc.state, markers: sortMarkers([...doc.state.markers, m]) });
  app.currentView?.()?.selectMarker?.(m.id);
  return m;
}

// ------------------------------------------------------------ registration

export function installEditExtraCommands(app) {
  app.commands.register([
    ...ZERO_COMMANDS.map(([id, label, fn]) => ({
      id: `zero.${id}`,
      label,
      enabled: hasSel,
      run: () => {
        const doc = audio(app);
        const find = (f, dir) => findZeroCrossing(doc.state, f, dir, doc.channelMask);
        let [start, end] = fn(doc.selection, find);
        // Inward adjustment of a selection with no crossing inside keeps it as is.
        if (end <= start) [start, end] = [doc.selection.start, doc.selection.end];
        doc.setSelection(start, end);
      },
    })),
    {
      id: 'edit.rename',
      label: 'Rename...',
      enabled: (a) => Boolean(a.active),
      run: async () => {
        const doc = app.active;
        // In a session the selected clip is what gets renamed, as elsewhere in the Clip menu.
        if (doc.kind === 'session' && app.commands.isEnabled('clip.rename')) return app.commands.run('clip.rename');
        const name = await promptDialog({ title: 'Rename', label: 'Name:', value: doc.name, validate: (v) => (v.trim() ? '' : 'Enter a name.') });
        if (!name || name.trim() === doc.name) return;
        doc.rename(name.trim());
      },
    },
    {
      id: 'edit.extractChannels',
      label: 'Extract Channels to Mono Files',
      enabled: (a) => (audio(a)?.channelCount || 0) > 1,
      run: () => {
        const doc = audio(app);
        const [a, b] = doc.hasSelection ? [doc.selection.start, doc.selection.end] : [0, doc.length];
        const base = baseName(doc.name);
        doc.state.channels.forEach((c, i) => {
          if (doc.selection.channels[i] === false) return;
          const out = new AudioFile({ name: app.uniqueName(`${base} ${channelLabel(i, doc.channelCount)}`), sampleRate: doc.sampleRate, channels: [c.slice(a, b)], info: { ...doc.info } });
          app.addDocument(out, { activate: false });
        });
        app.setStatus(`Extracted ${doc.state.channels.filter((_, i) => doc.selection.channels[i] !== false).length} mono files`);
      },
    },
    { id: 'marker.addSubclip', label: 'Add Subclip Marker', enabled: hasSel, run: () => addTypedMarker(app, 'subclip') },
    { id: 'marker.addCart', label: 'Add Cart Timer Marker', enabled: hasAudio, run: () => addTypedMarker(app, 'cart') },
    { id: 'edit.bandSplitter', label: 'Frequency Band Splitter...', enabled: hasAudio, run: () => bandSplitter(app) },
  ]);
}
