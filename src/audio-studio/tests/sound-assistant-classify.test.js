// Sound Assistant type suggestion: synthesized speech-like, music-like,
// ambience-like and effect-like sounds are told apart.
import { describe, it, expect, vi } from 'vitest';
import { audioFeatures, suggestType, classifyAudio } from '../src/sound-assistant/classify.js';

const R = 8000;
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const gen = (sec, fn) => Float32Array.from({ length: Math.round(sec * R) }, (_, i) => fn(i / R));

function speechLike() {
  seed = 7;
  const syls = [];
  let t = 0;
  while (t < 8) {
    const word = 2 + Math.floor(((rnd() + 1) / 2) * 4);
    for (let i = 0; i < word; i++) {
      const d = 0.12 + ((rnd() + 1) / 2) * 0.23;
      syls.push([t, t + d, 0.5 + (rnd() + 1) / 4]);
      t += d + 0.03;
    }
    t += 0.15 + ((rnd() + 1) / 2) * 0.5;
  }
  return gen(8, (t) => {
    const s = syls.find(([a, b]) => t >= a && t < b);
    if (!s) return 0.001 * rnd();
    const env = Math.sin((Math.PI * (t - s[0])) / (s[1] - s[0])) * s[2];
    const f0 = 110 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    let v = 0;
    for (let h = 1; h < 20; h++) v += (Math.sin(2 * Math.PI * f0 * h * t) / h) * (h > 3 && h < 8 ? 2 : 1);
    return env * (0.3 * v + 0.05 * rnd());
  });
}
const notes = [261.6, 329.6, 392, 293.7, 349.2, 440, 246.9, 311.1];
const musicLike = () => gen(8, (t) => {
  const k = Math.floor(t / 0.5) % 4;
  let v = 0;
  for (let j = 0; j < 3; j++) v += Math.sin(2 * Math.PI * notes[(k + j * 2) % 8] * t);
  return 0.2 * v * (0.8 + 0.2 * Math.exp(-((t % 0.5) * 6)));
});
function ambienceLike() {
  seed = 3;
  let lp = 0;
  return gen(8, (t) => {
    lp = 0.9 * lp + 0.1 * rnd();
    return (0.3 + 0.05 * Math.sin(t)) * (lp * 3 + 0.2 * rnd());
  });
}
function sfxLike() {
  seed = 5;
  return gen(1.5, (t) => (t < 1 ? Math.exp(-t * 8) * (rnd() * 0.6 + 0.4 * Math.sin(2 * Math.PI * 80 * t)) : 0.0005 * rnd()));
}

describe('suggestType', () => {
  it.each([
    ['dialogue', speechLike],
    ['music', musicLike],
    ['ambience', ambienceLike],
    ['sfx', sfxLike],
  ])('suggests %s', (type, make) => {
    const r = suggestType(audioFeatures([make()], R));
    expect(r.type).toBe(type);
    expect(r.confidence).toBeGreaterThan(0.1);
  });

  it('has no suggestion for silence or nothing', () => {
    expect(suggestType(audioFeatures([new Float32Array(R * 2)], R)).type).toBe(null);
    expect(suggestType(audioFeatures([new Float32Array(10)], R)).type).toBe(null);
  });

  it('reads Channel-like inputs over a range', () => {
    const x = musicLike();
    const ch = { length: x.length, toArray: (a, b) => x.slice(a, b) };
    expect(classifyAudio([ch], R, 0, x.length).type).toBe('music');
  });
});

describe('Sound Assistant suggestion', () => {
  it('marks the suggested type in the assign view', async () => {
    await import('./fx-wasm.js');
    await import('../src/effects/index.js');
    const { fakeApp } = await import('./fx-helpers.js');
    const { Channel } = await import('../src/audio/channel.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { soundAssistantPanel } = await import('../src/sound-assistant/panel.js');
    const doc = new AudioFile({ name: 'talk.wav', sampleRate: R, channels: [Channel.fromSamples(speechLike())] });
    const app = fakeApp();
    app.formatTime = (f) => String(f);
    app.documents = [doc];
    app.active = doc;
    const panel = soundAssistantPanel(app);
    document.body.append(panel.el);
    await vi.waitFor(() => expect(panel.el.querySelector('.sa-suggest').hidden).toBe(false));
    expect(panel.el.querySelector('.sa-type-btn.suggested').dataset.type).toBe('dialogue');
    expect(panel.el.querySelector('.sa-suggest').textContent).toMatch(/Dialogue/);
    panel.el.querySelector('.sa-suggest button').click();
    expect(panel.el.querySelector('.sa-type-name').textContent).toBe('Dialogue');
    panel.el.remove();
  });
});
