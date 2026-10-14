// Scales and chords for the piano roll: the scale highlight, the chord stamp
// and "chordize", and the riff generator all read these tables. Pure data and
// functions (no DOM), so they run in tests as-is.

/** Pitch-class names for scale roots (sharps, matching keyName in lib/util.js). */
export const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Scale types: semitone offsets from the root. */
export const SCALES = [
  { id: 'major', label: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', label: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'harmonicMinor', label: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodicMinor', label: 'Melodic minor', steps: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'dorian', label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', label: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', label: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', label: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'locrian', label: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'majorPentatonic', label: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  { id: 'minorPentatonic', label: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  { id: 'blues', label: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  { id: 'wholeTone', label: 'Whole tone', steps: [0, 2, 4, 6, 8, 10] },
  { id: 'chromatic', label: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

export function scaleById(id) {
  return SCALES.find((s) => s.id === id) || null;
}

/** A 12-entry lookup: mask[pitchClass] is true when the pitch class is in the scale. */
export function scaleMask(root, scaleId) {
  const s = scaleById(scaleId);
  const mask = new Array(12).fill(!s);
  if (s) for (const st of s.steps) mask[(root + st) % 12] = true;
  return mask;
}

export function inScale(key, root, scaleId) {
  const s = scaleById(scaleId);
  if (!s) return true;
  return s.steps.includes((((key - root) % 12) + 12) % 12);
}

/** Every key in [lo, hi] that belongs to the scale, ascending. */
export function scaleKeys(root, scaleId, lo = 0, hi = 127) {
  const out = [];
  for (let k = Math.max(0, lo); k <= Math.min(127, hi); k++) if (inScale(k, root, scaleId)) out.push(k);
  return out;
}

/** The nearest in-scale key at or below `key` (or above when nothing is below). */
export function snapToScale(key, root, scaleId) {
  for (let d = 0; d < 12; d++) {
    if (key - d >= 0 && inScale(key - d, root, scaleId)) return key - d;
  }
  for (let d = 1; d < 12; d++) if (key + d <= 127 && inScale(key + d, root, scaleId)) return key + d;
  return key;
}

/** "C minor", "F# dorian". */
export function scaleLabel(root, scaleId) {
  const s = scaleById(scaleId);
  return s ? `${ROOT_NAMES[((root % 12) + 12) % 12]} ${s.label.toLowerCase()}` : 'No scale';
}

// ------------------------------------------------------------------ chords

/** Chord shapes: semitones above the root. `scale` shapes stack thirds inside the highlighted scale. */
export const CHORDS = [
  { id: 'major', label: 'Major', steps: [0, 4, 7] },
  { id: 'minor', label: 'Minor', steps: [0, 3, 7] },
  { id: 'dim', label: 'Diminished', steps: [0, 3, 6] },
  { id: 'aug', label: 'Augmented', steps: [0, 4, 8] },
  { id: 'sus2', label: 'Suspended 2nd', steps: [0, 2, 7] },
  { id: 'sus4', label: 'Suspended 4th', steps: [0, 5, 7] },
  { id: 'power', label: 'Power (root, 5th, octave)', steps: [0, 7, 12] },
  { id: 'six', label: 'Major 6th', steps: [0, 4, 7, 9] },
  { id: 'min6', label: 'Minor 6th', steps: [0, 3, 7, 9] },
  { id: 'maj7', label: 'Major 7th', steps: [0, 4, 7, 11] },
  { id: 'min7', label: 'Minor 7th', steps: [0, 3, 7, 10] },
  { id: 'dom7', label: 'Dominant 7th', steps: [0, 4, 7, 10] },
  { id: 'm7b5', label: 'Half-diminished 7th', steps: [0, 3, 6, 10] },
  { id: 'dim7', label: 'Diminished 7th', steps: [0, 3, 6, 9] },
  { id: 'add9', label: 'Add 9', steps: [0, 4, 7, 14] },
  { id: 'maj9', label: 'Major 9th', steps: [0, 4, 7, 11, 14] },
  { id: 'min9', label: 'Minor 9th', steps: [0, 3, 7, 10, 14] },
  { id: 'scaleTriad', label: 'Triad in scale', scale: 3 },
  { id: 'scaleSeventh', label: 'Seventh in scale', scale: 4 },
];

export function chordById(id) {
  return CHORDS.find((c) => c.id === id) || null;
}

/**
 * Keys of a chord built on `root` (a MIDI key). Scale chords stack every
 * other degree of the scale (root snapped into it first); without a scale
 * they fall back to major/major 7th. `inversion` moves the lowest notes up an
 * octave that many times. Keys outside 0..127 are dropped.
 */
export function chordKeys(root, chordId, { inversion = 0, scaleRoot = 0, scaleId = null } = {}) {
  const c = chordById(chordId) || CHORDS[0];
  let keys;
  if (c.scale) {
    const s = scaleById(scaleId);
    if (!s || s.id === 'chromatic') {
      keys = (c.scale === 3 ? [0, 4, 7] : [0, 4, 7, 11]).map((st) => root + st);
    } else {
      const base = snapToScale(root, scaleRoot, scaleId);
      const ladder = scaleKeys(scaleRoot, scaleId, base, base + 36);
      keys = [];
      for (let i = 0; i < c.scale; i++) if (ladder[i * 2] !== undefined) keys.push(ladder[i * 2]);
    }
  } else keys = c.steps.map((st) => root + st);
  keys.sort((a, b) => a - b);
  const inv = Math.max(0, Math.min(inversion, keys.length - 1));
  for (let i = 0; i < inv; i++) keys.push(keys.shift() + 12);
  return keys.filter((k) => k >= 0 && k <= 127);
}

/**
 * Guesses the key of a set of notes: the major or minor scale that holds the
 * most note time, preferring a root that the notes start or end on.
 * Returns { root, scale } or null when there are no notes.
 */
export function detectScale(notes) {
  if (!notes.length) return null;
  const weight = new Array(12).fill(0);
  for (const n of notes) weight[n.key % 12] += Math.max(1, n.len);
  const sorted = notes.slice().sort((a, b) => a.pos - b.pos || a.key - b.key);
  const firstPc = sorted[0].key % 12;
  const lastPc = sorted[sorted.length - 1].key % 12;
  const lowestPc = notes.reduce((m, n) => (n.key < m.key ? n : m), notes[0]).key % 12;
  let best = null;
  for (const id of ['major', 'minor']) {
    for (let root = 0; root < 12; root++) {
      const mask = scaleMask(root, id);
      let score = 0;
      for (let pc = 0; pc < 12; pc++) score += mask[pc] ? weight[pc] : -weight[pc] * 2;
      const total = weight.reduce((a, b) => a + b, 0) || 1;
      score += total * (0.06 * (root === firstPc) + 0.08 * (root === lastPc) + 0.05 * (root === lowestPc) + 0.04 * (weight[root] / total));
      if (!best || score > best.score) best = { root, scale: id, score };
    }
  }
  return { root: best.root, scale: best.scale };
}
