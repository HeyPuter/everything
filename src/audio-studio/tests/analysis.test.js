import { describe, it, expect } from 'vitest';
import { testDsp } from './wasm-helper.js';
import { loudnessMeter, limiter, bitDepth, windowRms, averageSpectrum, pitchTrack, maskBlend } from '../src/analysis/dsp-ext.js';
import { planMatch, matchOutcome, MATCH_DEFAULTS, LOUDNESS_PRESETS } from '../src/analysis/loudness.js';
import { statsRows } from '../src/analysis/amplitude.js';
import { correlation } from '../src/analysis/phase.js';
import { fmtDb, gainToDb } from '../src/analysis/common.js';
import { liveWindow } from '../src/analysis/frequency.js';

const sine = (f, a, n, rate = 48000, ph = 0) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / rate + ph));

describe('WASM analysis wrappers', () => {
  const d = testDsp();

  it('measures BS.1770 loudness and true peak through the streaming meter', () => {
    const m = loudnessMeter(d, 48000, 2);
    const x = sine(1000, Math.pow(10, -23 / 20), 48000 * 10);
    for (let at = 0; at < x.length; at += 30000) m.push([x.subarray(at, at + 30000), x.subarray(at, at + 30000)]);
    const r = m.result();
    m.free();
    expect(r.integrated).toBeCloseTo(-23, 1);
    expect(r.momentary).toBeCloseTo(-23, 1);
    expect(r.range).toBeLessThan(0.5);
    expect(gainToDb(r.truePeak[0])).toBeCloseTo(-23, 1);
    const silent = loudnessMeter(d, 48000, 1);
    silent.push([new Float32Array(48000)]);
    expect(silent.result().integrated).toBe(-Infinity);
    silent.free();
  });

  it('limits peaks with a delay of `latency` frames', () => {
    const lim = limiter(d, 48000, 1, { ceiling: 0.5, lookMs: 2, releaseMs: 50, gain: 2 });
    const x = sine(500, 0.4, 48000);
    const buf = [new Float32Array(x.length + lim.latency)];
    buf[0].set(x);
    lim.process(buf);
    lim.free();
    const y = buf[0].subarray(lim.latency);
    let peak = 0;
    for (const v of y) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(0.505);
    expect(peak).toBeGreaterThan(0.45);
  });

  it('reports bit depth and windowed RMS', () => {
    expect(bitDepth(d, Float32Array.from([0.5, -0.5, 0]))).toBe(2);
    expect(bitDepth(d, Float32Array.from([1 / 32768]))).toBe(16);
    expect(bitDepth(d, Float32Array.from([0.1]))).toBe(32);
    const x = new Float32Array(300);
    x.fill(0.5, 0, 100);
    x.fill(0.25, 100, 200);
    const [lo, hi, sum, count] = windowRms(d, x, 100);
    expect(count).toBe(3);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(0.5);
    expect(sum).toBeCloseTo(0.75);
  });

  it('averages spectra and tracks pitch', () => {
    const size = 4096;
    const frames = 4;
    const x = sine(3000, 1, size * frames);
    const db = averageSpectrum(d, x, size, 0, size, frames);
    const k = Math.round((3000 * size) / 48000);
    let best = 0;
    for (let i = 0; i < db.length; i++) if (db[i] > db[best]) best = i;
    expect(Math.abs(best - k)).toBeLessThanOrEqual(1);
    expect(db[best]).toBeGreaterThan(-3);
    const f0 = pitchTrack(d, sine(330, 0.5, 48000), 48000, { n: 2048, hop: 4096, frames: 8 });
    for (const f of f0) expect(f).toBeCloseTo(330, 0);
  });

  it('passes the masked difference through mask_blend', () => {
    const n = 512;
    const hop = 128;
    const x = sine(1000, 0.5, 4096);
    const cols = Math.floor((4096 - n) / hop) + 1;
    const mask = new Float32Array(cols * (n / 2 + 1)).fill(1);
    const y = maskBlend(d, x, mask, cols, n, hop, n / 2);
    for (let i = n; i < 4096 - n; i++) expect(y[i]).toBeCloseTo(x[i], 3);
  });
});

describe('Match Loudness planning', () => {
  const s = { ...MATCH_DEFAULTS, target: -16, peak: -1, tolerance: 0.5, limit: true };
  it('applies plain gain when peaks stay under the ceiling', () => {
    expect(planMatch({ integrated: -20, truePeakDb: -10 }, s)).toMatchObject({ action: 'gain', gainDb: 4 });
  });
  it('limits when the gain would push peaks over the ceiling', () => {
    expect(planMatch({ integrated: -24, truePeakDb: -3 }, s)).toMatchObject({ action: 'limit', gainDb: 8 });
    const p = planMatch({ integrated: -24, truePeakDb: -3 }, { ...s, limit: false });
    expect(p.action).toBe('gain');
    expect(p.gainDb).toBeCloseTo(2);
    expect(p.note).toMatch(/-22.0 LUFS/);
  });
  it('says when limiting kept a file below the target', () => {
    const s = { ...MATCH_DEFAULTS, target: -16, peak: -1 };
    const plan = planMatch({ integrated: -26, truePeakDb: -3 }, s);
    expect(plan.action).toBe('limit');
    expect(matchOutcome(plan, { integrated: -16.2 }, s)).toEqual({ text: 'Gain with limiting', short: false });
    expect(matchOutcome(plan, { integrated: -24 }, s)).toEqual({ text: 'Gain with limiting: reached -24.0 LUFS', short: true });
    expect(matchOutcome(planMatch({ integrated: -20, truePeakDb: -10 }, s), { integrated: -16 }, s)).toEqual({ text: 'Gain +4.0 dB', short: false });
    const capped = planMatch({ integrated: -24, truePeakDb: -3 }, { ...s, limit: false });
    expect(matchOutcome(capped, { integrated: -22 }, { ...s, limit: false }).short).toBe(true);
  });

  it('skips files within tolerance and silent files', () => {
    expect(planMatch({ integrated: -16.3, truePeakDb: -5 }, s).action).toBe('skip');
    expect(planMatch({ integrated: -Infinity, truePeakDb: -Infinity }, s).action).toBe('skip');
  });
  it('has the standard presets', () => {
    const t = Object.fromEntries(LOUDNESS_PRESETS.map((p) => [p.id, p.target]));
    expect(t).toMatchObject({ ebu: -23, atsc: -24, podcast: -16, streaming: -14 });
  });
});

describe('analysis helpers', () => {
  it('computes phase correlation', () => {
    const a = sine(100, 1, 4800);
    const b = a.map((v) => -v);
    expect(correlation(a, a)).toBeCloseTo(1);
    expect(correlation(a, b)).toBeCloseTo(-1);
    expect(Math.abs(correlation(a, sine(100, 1, 4800, 48000, Math.PI / 2)))).toBeLessThan(0.01);
    expect(correlation(new Float32Array(10), a.subarray(0, 10))).toBe(0);
  });
  it('formats statistics rows per channel', () => {
    const ch = { min: -0.5, max: 0.25, sum: 0, sq: 100 * 0.0625, clipped: 0, bad: 0, bits: 16, rmsMin: 0.1, rmsMax: 0.4, rmsSum: 0.5, rmsCount: 2, frames: 100 };
    const rows = statsRows({ channels: [ch, { ...ch, bits: 32 }], loudness: { truePeak: [0.5, 0.5], integrated: -20, range: 3, maxMomentary: -18, maxShortTerm: -19 } }, 2);
    const get = (label) => rows.find((r) => r[0] === label)[1];
    expect(get('Peak Amplitude')).toEqual(['-6.02 dB', '-6.02 dB']);
    expect(get('Total RMS Amplitude')[0]).toBe('-12.04 dB');
    expect(get('Measured Bit Depth')).toEqual(['16', '32 (float)']);
    expect(get('Dynamic Range')[0]).toBe('12.04 dB');
    expect(get('Integrated Loudness')).toBe('-20.00 LUFS');
    expect(fmtDb(-Infinity)).toBe('-∞');
  });
});

describe('live frequency analysis', () => {
  it('fills FFT sizes larger than a mixer tap from earlier taps', () => {
    const d = testDsp();
    const TAP = 8192;
    const size = 16384;
    const x = sine(1000, 1, 48000);
    // Taps every 4096 frames, each holding the latest TAP frames played.
    const tapAt = (end) => ({ L: x.slice(end - TAP, end), R: x.slice(end - TAP, end), frame: end });
    let hist = null;
    for (const end of [8192, 12288, 16384, 20480]) hist = liveWindow(hist, tapAt(end), size);
    expect(Array.from(hist.L)).toEqual(Array.from(x.subarray(20480 - size, 20480)));
    const peak = (a) => Math.max(...a);
    const a = d.analyzer(size, 0);
    // As loud as a full window of the tone (a half-filled window reads 6 dB low).
    expect(peak(a.frame(hist.L))).toBeCloseTo(peak(a.frame(x.subarray(0, size))), 1);
    // A seek moves the window by a whole tap; the newest frames are always the tap's.
    hist = liveWindow(hist, tapAt(40000), size);
    expect(Array.from(hist.R.subarray(size - TAP))).toEqual(Array.from(x.subarray(40000 - TAP, 40000)));
    // Sizes a tap covers come straight from it.
    expect(Array.from(liveWindow(hist, tapAt(40000), 4096).L)).toEqual(Array.from(x.subarray(40000 - 4096, 40000)));
  });
});

describe('RMS histogram', () => {
  it('counts NaN and infinite samples as silence, like the window RMS statistics', async () => {
    const { accumulateRmsHistogram, rmsBin, HIST_BINS } =
      await import('../src/analysis/rms-histogram.js');
    const win = 480;
    const x = sine(1000, 0.5, win * 10);
    x[10] = NaN;
    x[win * 3 + 5] = Infinity;
    const hist = accumulateRmsHistogram(new Uint32Array(HIST_BINS), x, win);
    // Every window holds the 0.5 sine (about -9 dB); none lands at the bottom or top bin.
    expect(hist[rmsBin(0.5 * Math.SQRT1_2)]).toBe(10);
    expect(hist[0]).toBe(0);
    expect(hist[HIST_BINS - 1]).toBe(0);
  });
});
