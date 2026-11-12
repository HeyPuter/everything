import { describe, it, expect } from 'vitest';
import { Channel } from '../src/audio/channel.js';
import { weightAt, selectionBounds, rasterize, addBrushDot, timeSelection, shapeIntervals } from '../src/spectral/mask.js';
import { applySpectralMask, healSpectral, restrictEdit, processingGrid } from '../src/spectral/process.js';
import { gainRange } from '../src/model/edits.js';
import { testDsp } from './wasm-helper.js';

const RATE = 48000;
const tone = (f, a, n, phase = 0) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / RATE + phase));
const mix = (...xs) => xs[0].map((_, i) => xs.reduce((s, x) => s + x[i], 0));

/** Amplitude of frequency f over samples [a, b) by correlation. */
function level(x, f, a, b) {
  let s = 0;
  let c = 0;
  for (let i = a; i < b; i++) {
    const ph = (2 * Math.PI * f * i) / RATE;
    s += x[i] * Math.sin(ph);
    c += x[i] * Math.cos(ph);
  }
  return (2 * Math.hypot(s, c)) / (b - a);
}

describe('spectral selection shapes', () => {
  it('evaluates rectangles, lassos and brush strokes', () => {
    const sel = {
      channels: [true],
      shapes: [
        { type: 'rect', t0: 100, t1: 200, f0: 1000, f1: 2000 },
        { type: 'poly', log: false, points: [[300, 100], [400, 100], [350, 900]] },
      ],
    };
    expect(weightAt(sel, 150, 1500)).toBe(1);
    expect(weightAt(sel, 150, 2500)).toBe(0);
    expect(weightAt(sel, 350, 500)).toBe(1);
    expect(weightAt(sel, 310, 800)).toBe(0);
    const brush = { type: 'brush', log: true, rt: 100, rf: 1, opacity: 0.5, dots: [] };
    addBrushDot(brush, 1000, 1000);
    addBrushDot(brush, 2000, 1000);
    expect(brush.dots.length).toBeGreaterThan(5);
    expect(weightAt({ shapes: [brush] }, 1500, 1500)).toBe(0.5);
    expect(weightAt({ shapes: [brush] }, 1500, 2500)).toBe(0);
    // One octave of radius on a log brush: 500..2000 Hz at the centre.
    const [[lo, hi]] = shapeIntervals({ ...brush, dots: [[0, 1000]] }, 0);
    expect(lo).toBeCloseTo(500);
    expect(hi).toBeCloseTo(2000);
    const b = selectionBounds({ shapes: [brush] });
    expect(b.t0).toBeCloseTo(900);
    expect(b.t1).toBeCloseTo(2100);
    expect(b.f0).toBeCloseTo(500);
  });
  it('rasterises with a full-strength core and feathered edges', () => {
    const sel = { shapes: [{ type: 'rect', t0: 0, t1: 10000, f0: 1000, f1: 2000 }] };
    const n = 1024;
    const bins = n / 2 + 1;
    const r = rasterize(sel, { first: 0, cols: 20, hop: 256, n, rate: RATE });
    const at = (c, f) => r[c * bins + Math.round(f / (RATE / n))];
    expect(at(10, 1500)).toBe(1);
    expect(at(10, 1000)).toBe(1);
    expect(at(10, 5000)).toBe(0);
    const edge = at(10, 1000 - 2 * (RATE / n));
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
  });
});

describe('spectral processing', () => {
  const d = testDsp();
  const n = RATE;
  const state = () => ({ sampleRate: RATE, markers: [], channels: [Channel.fromSamples(mix(tone(1000, 0.4, n), tone(6000, 0.4, n)))] });

  it('removes a masked tone while an unmasked tone survives', () => {
    const s = state();
    const sel = { channels: [true], shapes: [{ type: 'rect', t0: 12000, t1: 36000, f0: 800, f1: 1200 }] };
    const out = applySpectralMask(s, sel, 0, d);
    const y = out.channels[0].toArray();
    expect(level(y, 1000, 16000, 32000)).toBeLessThan(0.004);
    expect(level(y, 6000, 16000, 32000)).toBeCloseTo(0.4, 2);
    // Outside the selection in time, nothing changes at all.
    const x = s.channels[0].toArray();
    const { n: win } = processingGrid(RATE);
    for (let i = 0; i < 12000 - 3 * win; i++) expect(y[i]).toBe(x[i]);
    for (let i = 36000 + 3 * win; i < n; i++) expect(y[i]).toBe(x[i]);
    // The untouched part still references the original block.
    expect(out.channels[0].pieces[0].block).toBe(s.channels[0].pieces[0].block);
  });

  it('applies gain only to the selected region', () => {
    const s = state();
    const sel = { channels: [true], shapes: [{ type: 'rect', t0: 0, t1: n, f0: 4000, f1: 8000 }] };
    const out = applySpectralMask(s, sel, 0.5, d);
    const y = out.channels[0].toArray();
    expect(level(y, 6000, 8000, 40000)).toBeCloseTo(0.2, 2);
    expect(level(y, 1000, 8000, 40000)).toBeCloseTo(0.4, 2);
  });

  it('restricts any edit to the selection', () => {
    const s = state();
    const sel = { channels: [true], shapes: [{ type: 'rect', t0: 0, t1: n, f0: 4000, f1: 8000 }] };
    const boosted = gainRange(s, 0, n, 0, null); // an effect that silences everything
    const out = restrictEdit(s, boosted, sel, d);
    const y = out.channels[0].toArray();
    expect(level(y, 6000, 8000, 40000)).toBeLessThan(0.004);
    expect(level(y, 1000, 8000, 40000)).toBeCloseTo(0.4, 2);
    // Length-changing edits pass through.
    const cut = { ...s, channels: [s.channels[0].slice(0, 100)] };
    expect(restrictEdit(s, cut, sel, d)).toBe(cut);
  });

  it('leaves unselected channels alone', () => {
    const s = { ...state(), channels: [state().channels[0], state().channels[0]] };
    const sel = { channels: [false, true], shapes: [{ type: 'rect', t0: 0, t1: n, f0: 0, f1: 24000 }] };
    const out = applySpectralMask(s, sel, 0, d);
    expect(out.channels[0]).toBe(s.channels[0]);
    expect(level(out.channels[1].toArray(), 1000, 8000, 40000)).toBeLessThan(0.01);
  });

  it('processes long selections in segments with the same result', () => {
    const s = state();
    const x = s.channels[0].toArray();
    const sel = { channels: [true], shapes: [{ type: 'rect', t0: 3000, t1: 41000, f0: 700, f1: 7000 }, { type: 'rect', t0: 20000, t1: 30000, f0: 100, f1: 400 }] };
    const whole = applySpectralMask(s, sel, 0.25, d, { segment: Infinity }).channels[0].toArray();
    // 16 columns per pass: about a dozen passes over this selection.
    const parts = applySpectralMask(s, sel, 0.25, d, { segment: 16 }).channels[0].toArray();
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(parts[i] - whole[i]));
    expect(worst).toBeLessThan(1e-5);
    expect(level(parts, 1000, 8000, 36000)).toBeCloseTo(0.1, 2);
    // Edits restricted to the selection go through the same passes.
    const silenced = gainRange(s, 0, n, 0, null);
    const a = restrictEdit(s, silenced, sel, d).channels[0].toArray();
    expect(level(a, 6000, 8000, 36000)).toBeLessThan(0.004);
    expect(level(a, 1000, 8000, 36000)).toBeLessThan(0.004);
    for (let i = 0; i < 900; i++) expect(a[i]).toBe(x[i]);
  });

  it('keeps memory bounded for a selection across a long file', () => {
    const long = 48000 * 80;
    const x = new Float32Array(long);
    for (let i = 0; i < long; i++) x[i] = 0.3 * Math.sin(i / 7);
    const s = { sampleRate: RATE, markers: [], channels: [Channel.fromSamples(x)] };
    const sel = { channels: [true], shapes: [{ type: 'rect', t0: 0, t1: long, f0: 300, f1: 3000 }] };
    const out = applySpectralMask(s, sel, 0.5, d);
    expect(out).not.toBe(s);
    // One pass over 80 s copies a 31 MB mask raster and two 15 MB buffers into WebAssembly memory.
    expect(d.x.memory.buffer.byteLength).toBeLessThan(48 * 1024 * 1024);
  });

  it('heals a dropout from the surrounding spectrum', () => {
    const x = tone(2000, 0.5, n);
    x.fill(0, 24000, 25200);
    const s = { sampleRate: RATE, markers: [], channels: [Channel.fromSamples(x)] };
    const out = healSpectral(s, timeSelection(23800, 25400, RATE / 2, [true]), d);
    const y = out.channels[0].toArray();
    expect(level(x, 2000, 24100, 25100)).toBeLessThan(0.01);
    expect(level(y, 2000, 24100, 25100)).toBeGreaterThan(0.25);
  });
});
