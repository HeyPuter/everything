// Practice audio for the tutorials, synthesized when a tutorial starts (nothing is
// bundled or downloaded): a voice-like recording with room noise and hum, a chord with
// clicks and mains hum, and a short music loop.

import { AudioFile } from '../model/audio-file.js';
import { Channel } from '../audio/channel.js';

/** Small deterministic noise source, so every run sounds the same. */
function noise(seed = 7) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

/** Two-pole resonator: one vowel formant. */
function resonate(x, rate, f, bw) {
  const r = Math.exp((-Math.PI * bw) / rate);
  const a1 = -2 * r * Math.cos((2 * Math.PI * f) / rate);
  const a2 = r * r;
  const g = 1 - r;
  const y = new Float32Array(x.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = g * x[i] - a1 * y1 - a2 * y2;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

const VOWELS = [
  [730, 1090, 2440],
  [270, 2290, 3010],
  [300, 870, 2240],
  [530, 1840, 2480],
  [570, 840, 2410],
];

/**
 * Speech-like phrases (pulse trains through vowel formants, with "s" sounds) after 1.5 s
 * of room tone, all over a noise floor and 60 Hz hum. Mono.
 */
export function voiceSamples(rate = 48000, seconds = 16) {
  const n = Math.round(rate * seconds);
  const x = new Float32Array(n);
  const rnd = noise(11);
  let t = Math.round(1.5 * rate);
  let phase = 0;
  for (let p = 0; t < n - rate; p++) {
    const syllables = 4 + (p % 3);
    for (let s = 0; s < syllables && t < n - rate; s++) {
      const len = Math.round(rate * (0.16 + 0.08 * ((s * 7 + p) % 3)));
      const src = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        phase += (110 + 40 * Math.sin(((t + i) / rate) * 3.1) + 15 * (p % 2)) / rate;
        if (phase >= 1) {
          phase -= 1;
          src[i] = 1;
        }
      }
      const y = new Float32Array(len);
      VOWELS[(s + p) % VOWELS.length].forEach((f, k) => {
        const r = resonate(src, rate, f, 80 + 40 * k);
        for (let i = 0; i < len; i++) y[i] += r[i] * [1, 0.6, 0.3][k];
      });
      for (let i = 0; i < len && t + i < n; i++) x[t + i] += y[i] * Math.sin((Math.PI * i) / len) ** 0.6 * 0.9;
      t += len;
      if ((s + p) % 3 === 0) {
        const sl = Math.round(rate * 0.1);
        let last = 0;
        for (let i = 0; i < sl && t + i < n; i++) {
          const w = rnd();
          x[t + i] += (w - last) * 0.3 * Math.sin((Math.PI * i) / sl);
          last = w;
        }
        t += sl;
      }
      t += Math.round(rate * 0.03);
    }
    t += Math.round(rate * (0.7 + 0.3 * (p % 2)));
  }
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd();
    lp = lp * 0.97 + w * 0.03;
    x[i] = (x[i] / (peak || 1)) * 0.2 + lp * 0.02 + w * 0.0025 + 0.004 * Math.sin((2 * Math.PI * 60 * i) / rate);
  }
  return x;
}

/** A sustained chord with mains hum (50 Hz and harmonics) and sharp clicks. Stereo. */
export function clicksSamples(rate = 44100, seconds = 8) {
  const n = Math.round(rate * seconds);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const chord = [261.6, 329.6, 392].reduce((s, f, k) => s + Math.sin(2 * Math.PI * f * t + k) * 0.12, 0) * (0.6 + 0.4 * Math.sin(t * 1.3));
    const hum = [50, 100, 150, 200].reduce((s, f, k) => s + (Math.sin(2 * Math.PI * f * t) * 0.03) / (k + 1), 0);
    L[i] = chord + hum;
    R[i] = chord * 0.9 + hum;
  }
  for (let k = 0; (0.3 + k * 0.37) * rate < n - 8; k++) {
    const at = Math.floor((0.3 + k * 0.37) * rate);
    for (let j = 0; j < 6; j++) {
      const v = (j % 2 ? -0.8 : 0.9) * (1 - j / 6);
      L[at + j] += v;
      if (k % 2) R[at + j] += v;
    }
  }
  return [L, R];
}

/** First click time of clicksSamples, in seconds. */
export const FIRST_CLICK = 0.3;

/** A quiet four-bar loop: pad chords, bass, kick and hats. Stereo. */
export function musicSamples(rate = 44100, seconds = 16) {
  const n = Math.round(rate * seconds);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const rnd = noise(3);
  const beat = 60 / 110;
  const chords = [
    [220, 277, 330],
    [196, 247, 294],
    [175, 220, 262],
    [165, 208, 247],
  ];
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const b = t / beat;
    const c = chords[Math.floor(b / 4) % 4];
    const ph = b % 1;
    const pad = c.reduce((s, f, k) => s + Math.sin(2 * Math.PI * f * t + k * 0.7) * 0.08, 0);
    const bass = Math.sin(2 * Math.PI * (c[0] / 2) * t) * 0.18 * Math.exp(-ph * 2);
    const kick = Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-ph * 30)) * ph * beat) * 0.5 * Math.exp(-ph * 8);
    const hp = (b * 2) % 1;
    const hat = hp < 0.08 ? rnd() * 0.06 * (1 - hp / 0.08) : 0;
    L[i] = (pad + bass + kick + hat * 0.7) * 0.5;
    R[i] = (pad * 0.9 + bass + kick + hat) * 0.5;
  }
  return [L, R];
}

/**
 * The practice file `name`: the open one if it is still open, else a new one built by
 * `make()` -> { rate, channels: Float32Array[] } and added to the app.
 */
export function practiceFile(app, name, make) {
  const open = app.documents?.find((d) => d.kind === 'audio' && d.name === name);
  if (open) {
    app.activate?.(open);
    return open;
  }
  const { rate, channels } = make();
  const doc = new AudioFile({ name, sampleRate: rate, channels: channels.map((c) => Channel.fromSamples(c)) });
  // Practice material: closes without a save prompt and is left out of autosave, until
  // Save As keeps a copy.
  doc.practice = true;
  const off = doc.on('change', (e) => {
    if (e.kind === 'saved' || doc.source?.type === 'puter' || doc.source?.type === 'download') {
      doc.practice = false;
      off();
    }
  });
  app.addDocument(doc);
  return doc;
}
