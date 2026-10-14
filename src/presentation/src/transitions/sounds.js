// Transition sounds. The built-in sounds are synthesized here (no recordings
// are shipped) and written into the deck as ordinary WAV media, so they play
// in any reader; playback uses Web Audio.

const RATE = 22050;

// A tiny deterministic noise source, so a sound is the same every time.
function noise(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}
const envelope = (t, attack, decay) =>
  t < attack ? t / attack : Math.exp(-(t - attack) / decay);

const SYNTHS = {
  chime(t) {
    const e = envelope(t, 0.004, 0.45);
    return (
      e *
      (0.5 * Math.sin(2 * Math.PI * 880 * t) +
        0.3 * Math.sin(2 * Math.PI * 1318.5 * t) * Math.exp(-t * 2) +
        0.2 * Math.sin(2 * Math.PI * 1760 * t) * Math.exp(-t * 4))
    );
  },
  click: () => {
    const n = noise(7);
    return (t) =>
      Math.exp(-t / 0.006) *
      (0.6 * n() + 0.5 * Math.sin(2 * Math.PI * 2200 * t));
  },
  whoosh: () => {
    const n = noise(3);
    let low = 0;
    return (t, length) => {
      const p = t / length;
      // Noise through a low-pass whose cutoff sweeps up and back down.
      const cutoff = 0.02 + 0.25 * Math.sin(Math.PI * p);
      low += (n() - low) * cutoff;
      return low * Math.sin(Math.PI * p) * 2.4;
    };
  },
  pop(t) {
    const f = 140 + 520 * Math.exp(-t / 0.025);
    return envelope(t, 0.002, 0.05) * Math.sin(2 * Math.PI * f * t);
  },
  shimmer(t) {
    const notes = [1568, 2093, 2637, 3136];
    let v = 0;
    notes.forEach((f, i) => {
      const at = t - i * 0.07;
      if (at > 0)
        v += envelope(at, 0.003, 0.18) * Math.sin(2 * Math.PI * f * at);
    });
    return v * 0.35;
  },
  drum(t) {
    const f = 90 + 60 * Math.exp(-t / 0.04);
    return envelope(t, 0.002, 0.16) * Math.sin(2 * Math.PI * f * t) * 0.9;
  },
};

// Synths that keep state between samples are made afresh for each sound.
const STATEFUL = new Set(["click", "whoosh"]);

/** Built-in sounds, in menu order: id, label, length in seconds. */
export const BUILT_IN_SOUNDS = [
  { id: "chime", label: "Chime", length: 1.4 },
  { id: "click", label: "Click", length: 0.08 },
  { id: "whoosh", label: "Whoosh", length: 0.8 },
  { id: "pop", label: "Pop", length: 0.25 },
  { id: "rise", label: "Rise", length: 0.7 },
  { id: "shimmer", label: "Shimmer", length: 0.9 },
  { id: "drum", label: "Drum", length: 0.6 },
];

/** The file name a built-in sound is stored under. */
export const soundFileName = (sound) => `${sound.label}.wav`;
/** The built-in sound stored under `name`, if any. */
export const builtInSoundNamed = (name) =>
  BUILT_IN_SOUNDS.find(
    (sound) =>
      soundFileName(sound).toLowerCase() === String(name).toLowerCase(),
  ) || null;

/** Synthesizes a built-in sound as 16-bit mono WAV bytes. */
export function synthesizeSound(id) {
  const sound = BUILT_IN_SOUNDS.find((s) => s.id === id);
  if (!sound) throw new Error(`Unknown sound ${id}`);
  const synth =
    id === "rise"
      ? (() => {
          // A rising sweep: integrate the frequency for a clean tone.
          let phase = 0;
          return (t, length) => {
            const p = t / length;
            phase += (2 * Math.PI * 320 * Math.pow(4, p)) / RATE;
            return Math.sin(Math.PI * p) * 0.7 * Math.sin(phase);
          };
        })()
      : STATEFUL.has(id)
        ? SYNTHS[id]()
        : SYNTHS[id];
  const count = Math.round(sound.length * RATE);
  const samples = new Int16Array(count);
  let peak = 0;
  const raw = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    raw[i] = synth(i / RATE, sound.length);
    peak = Math.max(peak, Math.abs(raw[i]));
  }
  const gain = peak > 0 ? 0.8 / peak : 0;
  const fade = Math.min(count, Math.round(RATE * 0.01));
  for (let i = 0; i < count; i++) {
    const edge = Math.min(1, (count - i) / fade);
    samples[i] = Math.round(raw[i] * gain * edge * 32767);
  }
  return wav(samples, RATE);
}

function wav(samples, rate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, s) =>
    [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++)
    view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}

let context = null;
let playing = null;
function audio() {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Context) return null;
  context ??= new Context();
  if (context.state === "suspended") context.resume().catch(() => {});
  return context;
}

/** Stops the transition sound that is playing, if any. */
export function stopSound() {
  try {
    playing?.stop();
  } catch {
    // Already stopped.
  }
  playing = null;
}

/** Plays audio bytes, replacing any transition sound already playing. */
export async function playSound(bytes, { loop = false } = {}) {
  const ctx = audio();
  if (!ctx || !bytes?.length) return;
  stopSound();
  const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = loop;
  source.connect(ctx.destination);
  source.start();
  playing = source;
  source.onended = () => {
    if (playing === source) playing = null;
  };
}

// Effect sounds (animations) play alongside each other and the transition
// sound; they stop together when the slide's player goes away.
const effectSources = new Set();

/** Plays audio bytes for an animation effect. */
export async function playEffectSound(bytes) {
  const ctx = audio();
  if (!ctx || !bytes?.length) return;
  try {
    const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
    effectSources.add(source);
    source.onended = () => effectSources.delete(source);
  } catch {
    // Audio the browser cannot decode stays silent.
  }
}

/** Stops every animation effect sound that is playing. */
export function stopEffectSounds() {
  for (const source of effectSources)
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
  effectSources.clear();
}
