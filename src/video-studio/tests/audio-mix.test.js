import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { US } from '../src/lib/time.js';
import { createProject, makeTrack, makeClip } from '../src/model/project.js';
import { loadDsp, dspReady } from '../src/media/dsp.js';
import { mixChunks, renderAudio, wavHeader, encodeWav, pcm16, mixClipInto } from '../src/engine/audio-mix.js';
import { integratedLoudness, clipLoudness } from '../src/media/audio-analysis.js';

/** Synthetic decoded source: fn(i) gives sample i, delivered in blocks of 1000 frames. */
function synth(rate, seconds, fn, nch = 1) {
  const n = Math.round(rate * seconds);
  return {
    sampleRate: rate,
    async *read(startSec) {
      const block = 1000;
      let i = Math.max(0, Math.floor((startSec * rate) / block) * block);
      for (; i < n; i += block) {
        const len = Math.min(block, n - i);
        const channels = [];
        for (let c = 0; c < nch; c++) {
          const a = new Float32Array(len);
          for (let k = 0; k < len; k++) a[k] = fn(i + k, c);
          channels.push(a);
        }
        yield { timestamp: i / rate, sampleRate: rate, channels };
      }
    },
    close() {},
  };
}

function project(clips, sources) {
  const p = createProject();
  const audio = makeTrack('audio');
  for (const c of clips) {
    p.assets[c.assetId] ||= { id: c.assetId, kind: 'audio', name: c.assetId, hasAudio: true, duration: 60 * US };
    audio.clips.push(c);
  }
  p.tracks.push(audio);
  return { p, openSource: async (asset) => sources[asset.id] };
}

const SR = 8000;

beforeAll(async () => {
  // Exercise the real WASM kernels when they load under Node; the JS fallbacks otherwise.
  const bytes = readFileSync(resolve(__dirname, '../src/media/dsp.wasm'));
  await loadDsp(bytes);
  expect(dspReady()).toBe(true);
});

describe('audio mix', () => {
  it('places a clip at its timeline position with unity gain', async () => {
    const clip = makeClip('audio', { assetId: 'a', start: US / 2, duration: US, volume: 1 });
    const { p, openSource } = project([clip], { a: synth(SR, 5, () => 0.5) });
    const out = await renderAudio(p, null, { sampleRate: SR, channels: 2, openSource });
    expect(out.channels).toHaveLength(2);
    expect(out.channels[0].length).toBe(Math.round(1.5 * SR));
    expect(out.channels[0][100]).toBe(0); // before the clip
    expect(out.channels[0][SR / 2 + 10]).toBeCloseTo(0.5, 5);
    expect(out.channels[1][SR]).toBeCloseTo(0.5, 5); // mono feeds both sides
  });

  it('applies fades as linear ramps and volume as gain', async () => {
    const clip = makeClip('audio', { assetId: 'a', start: 0, duration: 2 * US, volume: 0.5, fadeIn: US, fadeOut: 0 });
    const { p, openSource } = project([clip], { a: synth(SR, 5, () => 1) });
    const { channels } = await renderAudio(p, null, { sampleRate: SR, channels: 1, openSource });
    const ch = channels[0];
    expect(ch[0]).toBeCloseTo(0, 2);
    expect(ch[SR / 2]).toBeCloseTo(0.25, 2); // half way through the fade at volume 0.5
    expect(ch[Math.round(1.5 * SR)]).toBeCloseTo(0.5, 5);
    // Monotonic fade-in.
    for (let i = 300; i < SR; i += 300) expect(ch[i]).toBeGreaterThanOrEqual(ch[i - 300] - 1e-6);
  });

  it('honors fade out at the clip end', async () => {
    const clip = makeClip('audio', { assetId: 'a', start: 0, duration: US, fadeOut: US / 2 });
    const { p, openSource } = project([clip], { a: synth(SR, 5, () => 0.8) });
    const { channels } = await renderAudio(p, null, { sampleRate: SR, channels: 1, openSource });
    expect(channels[0][SR / 4]).toBeCloseTo(0.8, 4);
    expect(channels[0][Math.round(0.75 * SR)]).toBeCloseTo(0.4, 1);
    expect(channels[0][SR - 1]).toBeLessThan(0.01);
  });

  it('reads the source faster for speed and from the in point', async () => {
    // Source is a ramp: sample value = index / rate (seconds). Pitch follows speed (plain resampling).
    const clip = makeClip('audio', { assetId: 'a', start: 0, duration: US, in: US, speed: 2, keepPitch: false });
    const { p, openSource } = project([clip], { a: synth(SR, 10, (i) => i / SR / 10) });
    const { channels } = await renderAudio(p, null, { sampleRate: SR, channels: 1, openSource });
    // Output time 0.5 s reads source 1 + 0.5 * 2 = 2 s, encoded as 0.2.
    expect(channels[0][SR / 2]).toBeCloseTo(0.2, 3);
    expect(channels[0][SR / 4]).toBeCloseTo(0.15, 3);
  });

  it('resamples to the output rate', async () => {
    const clip = makeClip('audio', { assetId: 'a', start: 0, duration: US });
    const { p, openSource } = project([clip], { a: synth(4000, 5, (i) => i / 4000 / 10) });
    const { channels } = await renderAudio(p, null, { sampleRate: SR, channels: 1, openSource });
    expect(channels[0].length).toBe(SR);
    expect(channels[0][SR / 2]).toBeCloseTo(0.05, 3); // 0.5 s into the source
    expect(channels[0][SR / 2 + 1]).toBeCloseTo(0.05 + 1 / SR / 10, 4); // interpolated between source samples
  });

  it('sums overlapping clips and limits peaks', async () => {
    const a = makeClip('audio', { assetId: 'a', start: 0, duration: US });
    const b = makeClip('audio', { assetId: 'b', start: 0, duration: US });
    const { p, openSource } = project([a, b], { a: synth(SR, 5, () => 0.3), b: synth(SR, 5, () => 0.9) });
    const { channels } = await renderAudio(p, null, { sampleRate: SR, channels: 1, openSource });
    expect(channels[0][100]).toBeGreaterThan(0.9);
    expect(channels[0][100]).toBeLessThanOrEqual(1);
  });

  it('skips muted clips and muted tracks', async () => {
    const a = makeClip('audio', { assetId: 'a', start: 0, duration: US, muted: true });
    const { p, openSource } = project([a], { a: synth(SR, 5, () => 0.5) });
    let r = await renderAudio(p, null, { sampleRate: SR, channels: 1, openSource });
    expect(r.channels[0].some((v) => v !== 0)).toBe(false);
    a.muted = false;
    p.tracks[1].muted = true;
    r = await renderAudio(p, null, { sampleRate: SR, channels: 1, openSource, end: US });
    expect(r.channels[0].some((v) => v !== 0)).toBe(false);
  });

  it('downmixes stereo to mono and yields ~1 s chunks', async () => {
    const clip = makeClip('audio', { assetId: 'a', start: 0, duration: 3 * US });
    const { p, openSource } = project([clip], { a: synth(SR, 5, (i, c) => (c === 0 ? 0.2 : 0.6), 2) });
    const chunks = [];
    for await (const c of mixChunks(p, null, { sampleRate: SR, channels: 1, openSource, end: 2.5 * US })) chunks.push(c);
    expect(chunks.map((c) => c.frames)).toEqual([SR, SR, SR / 2]);
    expect(chunks[1].time).toBe(US);
    expect(chunks[0].channels[0][50]).toBeCloseTo(0.4, 5);
  });

  it('stops when aborted', async () => {
    const clip = makeClip('audio', { assetId: 'a', start: 0, duration: 5 * US });
    const { p, openSource } = project([clip], { a: synth(SR, 5, () => 0.1) });
    const ac = new AbortController();
    ac.abort();
    await expect(renderAudio(p, null, { sampleRate: SR, openSource, signal: ac.signal })).rejects.toThrow(/cancel/i);
  });

  it('mixClipInto leaves samples outside the clip untouched', () => {
    const out = [new Float32Array(100)];
    const win = { started: true, start: 0, length: 1000, rate: 100, channels: [new Float32Array(1000).fill(1)] };
    const clip = makeClip('audio', { start: 0.5 * US, duration: 0.2 * US });
    mixClipInto(out, 0, 100, clip, win);
    expect(out[0][49]).toBe(0);
    expect(out[0][50]).toBe(1);
    expect(out[0][69]).toBe(1);
    expect(out[0][70]).toBe(0);
  });
});

describe('WAV encoding', () => {
  it('writes a canonical 16-bit PCM header', () => {
    const hdr = wavHeader(48000, 2, 48000);
    const v = new DataView(hdr.buffer);
    const text = (o, n) => String.fromCharCode(...hdr.slice(o, o + n));
    expect(hdr.length).toBe(44);
    expect(text(0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 48000 * 4);
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(192000);
    expect(v.getUint16(32, true)).toBe(4);
    expect(v.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(192000);
  });

  it('interleaves and clamps samples', () => {
    const pcm = pcm16([new Float32Array([0, 1, -1, 2]), new Float32Array([0.5, -0.5, -2, 0])]);
    expect(Array.from(pcm)).toEqual([0, 16384, 32767, -16384, -32768, -32768, 32767, 0]);
  });

  it('builds a Blob of header plus data', async () => {
    const blob = encodeWav([new Float32Array(10), new Float32Array(10)], 44100);
    expect(blob.size).toBe(44 + 40);
    expect(blob.type).toBe('audio/wav');
  });
});

describe('loudness normalization', () => {
  it('brings a normalized mono clip to its target in the stereo mix', async () => {
    const sr = 48000;
    const amp = 0.1;
    const tone = (i) => amp * Math.sin((2 * Math.PI * 997 * i) / sr);
    const n = sr * 3;
    const mono = Float32Array.from({ length: n }, (_, i) => tone(i));
    for (const [nch, measured] of [[1, clipLoudness([mono], sr)], [2, clipLoudness([mono, mono], sr)]]) {
      const clip = makeClip('audio', { assetId: 'a', start: 0, duration: 3 * US });
      clip.audioFx = { normalize: { on: true, target: -14, loudness: measured } };
      const { p, openSource } = project([clip], { a: synth(sr, 3, (i) => tone(i), nch) });
      const out = await renderAudio(p, null, { sampleRate: sr, channels: 2, openSource });
      expect(integratedLoudness(out.channels, sr), `${nch} channel source`).toBeCloseTo(-14, 0);
    }
  });
});
