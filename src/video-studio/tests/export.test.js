import { describe, it, expect, vi, afterEach } from 'vitest';
import { US } from '../src/lib/time.js';
import {
  outputSize, videoBitrate, frameCount, frameTime, estimateSize, reconcile, audioCodecFor, safeFileName, formatBytes,
  describeError, CONTAINERS, DEFAULT_SETTINGS, encoderDelay,
} from '../src/engine/exporter.js';

describe('output size', () => {
  it('keeps the project aspect with the short side at the resolution', () => {
    expect(outputSize(1920, 1080, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(1920, 1080, 720)).toEqual({ width: 1280, height: 720 });
    expect(outputSize(1080, 1920, 2160)).toEqual({ width: 2160, height: 3840 });
    expect(outputSize(1080, 1080, 480)).toEqual({ width: 480, height: 480 });
    expect(outputSize(2560, 1080, 1440)).toEqual({ width: 3414, height: 1440 });
  });

  it('always produces even dimensions', () => {
    const { width, height } = outputSize(1080, 1350, 481);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
  });
});

describe('bitrate presets', () => {
  const base = { width: 1920, height: 1080, fps: 30, codec: 'avc' };
  it('lands near 10 Mbps for 1080p30 H.264 Balanced', () => {
    const r = videoBitrate(base);
    expect(r).toBeGreaterThan(8e6);
    expect(r).toBeLessThan(12e6);
  });
  it('orders levels and scales with pixels, frame rate and codec', () => {
    expect(videoBitrate({ ...base, level: 'small' })).toBeLessThan(videoBitrate(base));
    expect(videoBitrate({ ...base, level: 'high' })).toBeGreaterThan(videoBitrate(base));
    expect(videoBitrate({ ...base, width: 3840, height: 2160 })).toBeCloseTo(videoBitrate(base) * 4, -4);
    expect(videoBitrate({ ...base, fps: 60 })).toBeGreaterThan(videoBitrate(base));
    expect(videoBitrate({ ...base, fps: 60 })).toBeLessThan(videoBitrate(base) * 2);
    expect(videoBitrate({ ...base, codec: 'hevc' })).toBeLessThan(videoBitrate(base));
    expect(videoBitrate({ ...base, codec: 'av1' })).toBeLessThan(videoBitrate({ ...base, codec: 'hevc' }));
  });
  it('uses the custom value in Mbps', () => {
    expect(videoBitrate({ ...base, level: 'custom', customMbps: 25 })).toBe(25_000_000);
  });
});

describe('frame timing', () => {
  it('counts frames, including a trailing partial frame', () => {
    expect(frameCount(10 * US, 30)).toBe(300);
    expect(frameCount(10 * US + 1, 30)).toBe(301);
    expect(frameCount(US / 3, 30)).toBe(10);
    expect(frameCount(0, 30)).toBe(0);
    expect(frameCount(1, 60)).toBe(1);
  });
  it('generates integer microsecond times without drift', () => {
    expect(frameTime(0, 30)).toBe(0);
    expect(frameTime(1, 30)).toBe(33333);
    expect(frameTime(2, 30)).toBe(66667);
    expect(frameTime(30, 30)).toBe(US);
    expect(frameTime(3000, 24)).toBe(125 * US);
    expect(frameTime(5, 25, 1000)).toBe(201000);
    const times = Array.from({ length: 600 }, (_, i) => frameTime(i, 60));
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(16666);
    expect(Number.isInteger(times[599])).toBe(true);
  });
});

describe('codec and container matching', () => {
  const all = { video: ['avc', 'hevc', 'vp9', 'av1'], audio: ['aac', 'opus'], audioFormats: ['wav', 'm4a', 'ogg'] };
  it('switches the format when a codec is picked that it cannot carry', () => {
    expect(reconcile({ ...DEFAULT_SETTINGS, codec: 'vp9', format: 'mp4' }, all, 'codec')).toMatchObject({ codec: 'vp9', format: 'webm' });
    expect(reconcile({ ...DEFAULT_SETTINGS, codec: 'hevc', format: 'webm' }, all, 'codec')).toMatchObject({ codec: 'hevc', format: 'mp4' });
    expect(reconcile({ ...DEFAULT_SETTINGS, codec: 'av1', format: 'webm' }, all, 'codec')).toMatchObject({ codec: 'av1', format: 'webm' });
  });
  it('switches the codec when a format is picked that cannot carry it', () => {
    expect(reconcile({ ...DEFAULT_SETTINGS, codec: 'avc', format: 'webm' }, all, 'format')).toMatchObject({ codec: 'vp9', format: 'webm' });
    expect(reconcile({ ...DEFAULT_SETTINGS, codec: 'av1', format: 'mov' }, all, 'format')).toMatchObject({ codec: 'avc', format: 'mov' });
  });
  it('only uses encodable codecs', () => {
    const noHevc = { ...all, video: ['avc', 'vp9'] };
    expect(reconcile({ ...DEFAULT_SETTINGS, codec: 'hevc', format: 'mp4' }, noHevc, 'codec')).toMatchObject({ codec: 'avc', format: 'mp4' });
    const vp9Only = { ...all, video: ['vp9'] };
    expect(reconcile({ ...DEFAULT_SETTINGS, codec: 'avc', format: 'mov' }, vp9Only, 'format')).toMatchObject({ codec: 'vp9', format: 'webm' });
  });
  it('falls back to WAV when the audio format cannot be encoded', () => {
    expect(reconcile({ ...DEFAULT_SETTINGS, audioFormat: 'flac' }, all).audioFormat).toBe('wav');
  });
  it('keeps every container codec list consistent', () => {
    for (const info of Object.values(CONTAINERS)) {
      expect(info.video.length).toBeGreaterThan(0);
      expect(info.audio.length).toBeGreaterThan(0);
    }
    expect(audioCodecFor('mp4')).toBe('aac');
    expect(audioCodecFor('webm')).toBe('opus');
    expect(audioCodecFor('mp4', ['opus'])).toBe('opus');
    expect(audioCodecFor('mov', ['opus'])).toBe(null);
  });
});

describe('size estimate and names', () => {
  it('estimates from bitrate and duration', () => {
    const s = { ...DEFAULT_SETTINGS, video: true, includeAudio: true, audio: false };
    const bytes = estimateSize(s, 60 * US);
    // About 10 Mbps video + 192 kbps audio for a minute: 70 to 80 MB.
    expect(bytes).toBeGreaterThan(70e6);
    expect(bytes).toBeLessThan(80e6);
    expect(estimateSize({ ...s, video: false, audio: true, audioFormat: 'wav' }, 10 * US)).toBe(44 + 480000 * 4);
    expect(estimateSize({ ...s, includeAudio: false }, 60 * US)).toBeLessThan(bytes);
  });
  it('makes safe file names', () => {
    expect(safeFileName('My: video / cut?')).toBe('My- video - cut-');
    expect(safeFileName('   ')).toBe('Untitled');
    expect(safeFileName('..hidden')).toBe('hidden');
  });
  it('formats sizes', () => {
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
    expect(formatBytes(300 * 1024 * 1024)).toBe('300 MB');
  });
  it('explains errors', () => {
    expect(describeError(new DOMException('x', 'AbortError'))).toMatch(/canceled/);
    expect(describeError(new RangeError('Array buffer allocation failed'))).toMatch(/memory/);
    expect(describeError(new Error('Encoder configuration not supported'), { codec: 'hevc' })).toMatch(/HEVC/);
  });
});

describe('encoder delay', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** WebCodecs stand-ins: an encoder that puts `priming` samples of silence first and a decoder that plays chunks back. */
  function fakeCodecs(priming) {
    vi.stubGlobal('AudioData', class {
      constructor({ numberOfFrames, data }) {
        this.numberOfFrames = numberOfFrames;
        this.plane = data.subarray(0, numberOfFrames);
      }
      copyTo(dest) { dest.set(this.plane); }
      close() {}
    });
    vi.stubGlobal('AudioEncoder', class {
      constructor({ output }) { this.output = output; }
      configure(config) { this.config = config; }
      encode(d) {
        const all = new Float32Array(priming + d.numberOfFrames);
        all.set(d.plane, priming);
        for (let i = 0; i < all.length; i += 1024) this.output({ samples: all.subarray(i, i + 1024) }, i ? undefined : { decoderConfig: { codec: this.config.codec } });
      }
      async flush() {}
      close() {}
    });
    vi.stubGlobal('AudioDecoder', class {
      constructor({ output }) { this.output = output; }
      configure() {}
      decode(chunk) { this.output({ numberOfFrames: chunk.samples.length, copyTo: (dest) => dest.set(chunk.samples), close() {} }); }
      async flush() {}
      close() {}
    });
  }

  it('measures the AAC priming so the sound can be stamped that much earlier', async () => {
    fakeCodecs(2112);
    expect(await encoderDelay('aac', { sampleRate: 48000, numberOfChannels: 2 })).toBeCloseTo(2112 / 48000, 9);
  });

  it('leaves Opus and other codecs alone', async () => {
    fakeCodecs(312);
    expect(await encoderDelay('opus')).toBe(0);
    expect(await encoderDelay('flac')).toBe(0);
  });

  it('falls back to no shift when the measurement fails', async () => {
    fakeCodecs(0);
    vi.stubGlobal('AudioEncoder', class {
      configure() { throw new Error('unsupported'); }
    });
    expect(await encoderDelay('aac', { sampleRate: 44100, numberOfChannels: 1 })).toBe(0);
  });
});
