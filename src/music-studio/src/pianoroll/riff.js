// Riff generator: melodies, arpeggios, basslines and chord progressions in a
// scale, written into the piano roll by the 'tools.riff' command. Every
// random choice goes through a seeded generator, so a seed always gives the
// same riff (the dialog shows the seed and can roll a new one).
//
// The music: a short chord progression in the scale (one chord per bar)
// drives every style. Melodies build a one or two bar motif and repeat it
// over the progression with small variations, landing on a chord tone at the
// end; arpeggios walk the chord tones; basslines play the chord roots with
// octave and fifth movement.

import { clamp, uid } from '../lib/util.js';
import { scaleById, scaleKeys } from './scales.js';
import { STEP, ticksPerBar, ticksPerBeat } from '../model/time.js';

/** Small fast seeded PRNG (mulberry32). Returns a function giving 0..1. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const RIFF_STYLES = [
  { id: 'melody', label: 'Melody' },
  { id: 'arpUp', label: 'Arpeggio up' },
  { id: 'arpDown', label: 'Arpeggio down' },
  { id: 'arpUpDown', label: 'Arpeggio up and down' },
  { id: 'bass', label: 'Bassline' },
  { id: 'chords', label: 'Chord progression' },
];

// Progressions as scale degrees (0 = the root chord), chosen by the seed.
const PROGRESSIONS = [
  [0, 5, 3, 4],
  [0, 3, 4, 0],
  [0, 4, 5, 3],
  [5, 3, 0, 4],
  [0, 6, 5, 6],
  [0, 3, 0, 4],
  [0, 2, 3, 4],
];

const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

/** Weighted choice: `weights` are relative; returns the index. */
function weighted(rng, weights) {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * Rhythm for one beat as a list of [offsetUnits, lengthUnits] (a missing
 * slot is a rest). Busier cells get likelier as density rises.
 */
function beatRhythm(rng, units, density) {
  if (units <= 1) return rng() < 0.35 + density * 0.6 ? [[0, 1]] : [];
  const half = Math.max(1, Math.floor(units / 2));
  const cells = [
    { w: 1.2 - density, r: [[0, units]] },
    { w: 0.4 + density * 0.4, r: [[0, half], [half, units - half]] },
    { w: 0.25 + density * 0.3, r: [[0, units - 1], [units - 1, 1]] },
    { w: density * 0.9, r: Array.from({ length: units }, (_, i) => [i, 1]) },
    { w: density * 0.5, r: [[0, 1], [1, 1], [2, units - 2]].filter((c) => c[1] > 0 && c[0] < units) },
    { w: 0.35 * (1 - density), r: [[half, units - half]] },
    { w: 0.15 * (1 - density), r: [] },
  ];
  return cells[weighted(rng, cells.map((c) => Math.max(0.01, c.w)))].r;
}

/**
 * Generates riff notes (sorted, with ids).
 * opts: { seed, style, root (pitch class), scale (scale id), low (lowest key),
 *   range (octaves), bars, density (0..1), unit (ticks per rhythm unit),
 *   sig, start (tick offset) }
 */
export function generateRiff(opts) {
  const {
    seed = 1,
    style = 'melody',
    root = 0,
    scale = 'minor',
    low = 60,
    range = 1,
    bars = 2,
    density = 0.5,
    unit = STEP,
    sig = [4, 4],
    start = 0,
  } = opts;
  const rng = mulberry32(seed);
  const sc = scaleById(scale) || scaleById('minor');
  const lo = clamp(low, 0, 120);
  const hi = clamp(lo + 12 * clamp(range, 1, 4), lo + 1, 127);
  const ladder = scaleKeys(root, sc.id, lo - 12, hi + 12); // includes a margin for chord stacks
  const firstRoot = ladder.findIndex((k) => k >= lo && (((k - root) % 12) + 12) % 12 === 0);
  const base = firstRoot >= 0 ? firstRoot : ladder.findIndex((k) => k >= lo);
  const deg = sc.steps.length;
  const prog = pick(rng, PROGRESSIONS).map((d) => d % deg);
  const bar = ticksPerBar(sig);
  const beat = ticksPerBeat(sig);
  const u = Math.max(1, Math.round(unit));
  const unitsPerBeat = Math.max(1, Math.round(beat / u));
  const notes = [];
  const add = (key, pos, len, vel) => {
    if (key < 0 || key > 127 || len <= 0) return;
    notes.push({ id: uid(6), key, pos: start + pos, len, vel: Math.round(clamp(vel, 0.05, 1) * 1000) / 1000, pan: 0 });
  };
  const chordTones = (barIndex, count = 3) => {
    const d = prog[barIndex % prog.length];
    const out = [];
    for (let i = 0; i < count; i++) {
      const k = ladder[base + d + i * 2];
      if (k !== undefined) out.push(k);
    }
    return out;
  };
  const accent = (posInBar) => (posInBar % bar === 0 ? 0.88 : posInBar % beat === 0 ? 0.78 : 0.66) + (rng() - 0.5) * 0.08;
  const inRange = (k) => k >= lo && k <= hi;

  if (style === 'chords') {
    for (let b = 0; b < bars; b++) {
      const tones = chordTones(b, density > 0.6 ? 4 : 3);
      const hits = density < 0.35 ? [[0, bar]] : density < 0.7 ? [[0, bar / 2], [bar / 2, bar / 2]] : [[0, beat * 1.5], [beat * 1.5, beat * 1.5], [beat * 3, bar - beat * 3]];
      for (const [p, l] of hits) for (const k of tones) add(k, b * bar + Math.round(p), Math.round(l), 0.62 + (rng() - 0.5) * 0.06);
    }
  } else if (style === 'bass') {
    const shapes = [
      [[0, 2], [3, 1], [6, 2], [10, 2], [14, 2]],
      [[0, 3], [4, 2], [8, 3], [12, 2]],
      [[0, 1], [2, 1], [4, 1], [6, 1], [8, 1], [10, 1], [12, 1], [14, 1]],
      [[0, 4], [6, 2], [8, 4], [14, 2]],
    ];
    const shape = shapes[Math.min(shapes.length - 1, Math.floor(density * shapes.length * 0.999 + rng() * 0.5))];
    for (let b = 0; b < bars; b++) {
      const rootKey = chordTones(b, 1)[0] ?? ladder[base];
      for (let i = 0; i < shape.length; i++) {
        const [s, l] = shape[i];
        const p = s * STEP;
        if (p >= bar) continue;
        let k = rootKey;
        const r = rng();
        if (i > 0 && r < 0.18 + density * 0.12) k = rootKey + 12;
        else if (i > 0 && r < 0.3 + density * 0.15) k = rootKey + 7;
        while (k > hi && k - 12 >= 0) k -= 12;
        add(k, b * bar + p, Math.min(Math.round(l * STEP * 0.9), bar - p), accent(p));
      }
    }
  } else if (style.startsWith('arp')) {
    const every = density < 0.35 ? 2 : 1;
    const stepTicks = u * every;
    const gate = 0.85;
    for (let b = 0; b < bars; b++) {
      const tones = chordTones(b, 3);
      const run = [];
      for (let o = 0; o < 4; o++) for (const t of tones) if (inRange(t + o * 12)) run.push(t + o * 12);
      run.sort((x, y) => x - y);
      if (!run.length) continue;
      let seqKeys = run;
      if (style === 'arpDown') seqKeys = run.slice().reverse();
      else if (style === 'arpUpDown') seqKeys = run.length > 2 ? [...run, ...run.slice(1, -1).reverse()] : run;
      let i = 0;
      for (let p = 0; p < bar; p += stepTicks) {
        add(seqKeys[i % seqKeys.length], b * bar + p, Math.max(1, Math.round(stepTicks * gate)), accent(p));
        i++;
      }
    }
  } else {
    // Melody: a motif over the first bars, repeated over the progression.
    const motifBars = bars >= 4 ? 2 : 1;
    const motif = [];
    let idx = base + Math.floor(rng() * 3) * 2;
    for (let b = 0; b < motifBars; b++) {
      for (let bt = 0; bt < sig[0]; bt++) {
        for (const [o, l] of beatRhythm(rng, unitsPerBeat, density)) {
          const pos = b * bar + bt * beat + o * u;
          const strong = (bt * beat + o * u) % beat === 0;
          const move = [0, 1, -1, 2, -2, 3, -3, 4, -4][weighted(rng, [0.14, 0.27, 0.27, 0.11, 0.11, 0.04, 0.04, 0.01, 0.01])];
          idx += move;
          // Strong beats prefer chord tones (even ladder distance from the chord root).
          const chordRoot = base + prog[b % prog.length];
          if (strong && (idx - chordRoot) % 2 !== 0) idx += rng() < 0.5 ? 1 : -1;
          while (ladder[idx] !== undefined && ladder[idx] > hi) idx -= 2;
          while (ladder[idx] !== undefined && ladder[idx] < lo) idx += 2;
          idx = clamp(idx, 0, ladder.length - 1);
          motif.push({ idx, pos, len: Math.max(1, l * u - (l > 1 ? Math.round(u * 0.1) : 0)), strong });
        }
      }
    }
    const motifLen = motifBars * bar;
    const reps = Math.ceil(bars / motifBars);
    for (let r = 0; r < reps; r++) {
      for (let m = 0; m < motif.length; m++) {
        const n = motif[m];
        const pos = r * motifLen + n.pos;
        if (pos >= bars * bar) continue;
        const b = Math.floor(pos / bar);
        // Follow the chord: shift by the progression's degree change.
        let i = n.idx + (prog[b % prog.length] - prog[Math.floor(n.pos / bar) % prog.length]);
        if (r > 0 && rng() < 0.18) i += rng() < 0.5 ? 1 : -1; // small variations on repeats
        let k = ladder[clamp(i, 0, ladder.length - 1)];
        while (k > hi) k -= 12;
        while (k < lo) k += 12;
        add(k, pos, n.len, accent(pos % bar));
      }
    }
    // End on a chord tone of the last bar.
    const last = notes.at(-1);
    if (last) {
      const tones = chordTones(bars - 1, 3).flatMap((t) => [t - 12, t, t + 12]).filter(inRange);
      if (tones.length && !tones.includes(last.key)) last.key = tones.reduce((a, t) => (Math.abs(t - last.key) < Math.abs(a - last.key) ? t : a), tones[0]);
    }
  }
  notes.sort((a, b) => a.pos - b.pos || a.key - b.key);
  return notes;
}
