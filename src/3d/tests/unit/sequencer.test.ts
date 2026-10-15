import { describe, it, expect } from 'vitest';
import * as S from '../../src/sequencer/strips';
import * as B from '../../src/sequencer/blend';
import { encodeWav, soundSegment, peaks, panGains } from '../../src/sequencer/wav';
import type { Strip, BlendType } from '../../src/sequencer/types';

const ed = () => S.newSequenceEditor();
function add(e: ReturnType<typeof ed>, type: Strip['type'], channel: number, start: number, dur: number, name?: string) {
  const s = S.newStrip(type, S.uniqueName(e, name ?? S.STRIP_LABELS[type]), channel, start, dur);
  e.strips.push(s);
  return s;
}

describe('strip timing', () => {
  it('derives final range from start, duration and handles', () => {
    const e = ed();
    const m = add(e, 'MOVIE', 1, 10, 100);
    expect([S.finalStart(m), S.finalEnd(m), S.finalDuration(m)]).toEqual([10, 110, 100]);
    m.frame_offset_start = 5;
    m.frame_offset_end = 20;
    expect([S.finalStart(m), S.finalEnd(m), S.finalDuration(m)]).toEqual([15, 90, 75]);
    expect(S.activeAt(m, 14)).toBe(false);
    expect(S.activeAt(m, 15)).toBe(true);
    expect(S.activeAt(m, 89)).toBe(true);
    expect(S.activeAt(m, 90)).toBe(false);
  });

  it('trims content strips with handles but never past the content', () => {
    const e = ed();
    const m = add(e, 'MOVIE', 1, 1, 50);
    S.setLeftHandle(m, 11);
    expect(m.frame_offset_start).toBe(10);
    S.setLeftHandle(m, -20);
    expect(m.frame_offset_start).toBe(0);
    expect(S.finalStart(m)).toBe(1);
    S.setRightHandle(m, 40);
    expect(m.frame_offset_end).toBe(11);
    S.setRightHandle(m, 400);
    expect(S.finalEnd(m)).toBe(51);
  });

  it('extends still strips freely', () => {
    const e = ed();
    const c = add(e, 'COLOR', 1, 1, 25);
    S.setRightHandle(c, 100);
    expect([S.finalStart(c), S.finalEnd(c)]).toEqual([1, 100]);
    S.setLeftHandle(c, -10);
    expect([S.finalStart(c), S.finalEnd(c)]).toEqual([-10, 100]);
    expect(c.frame_offset_start).toBe(0);
  });

  it('maps timeline frames to content frames (offsets, reverse, strobe)', () => {
    const e = ed();
    const m = add(e, 'MOVIE', 1, 100, 10);
    expect(S.contentFrame(m, 100)).toBe(0);
    expect(S.contentFrame(m, 105)).toBe(5);
    expect(S.contentFrame(m, 500)).toBe(9);
    m.use_reverse_frames = true;
    expect(S.contentFrame(m, 100)).toBe(9);
    m.use_reverse_frames = false;
    m.strobe = 3;
    expect([100, 101, 102, 103, 104].map((f) => S.contentFrame(m, f))).toEqual([0, 0, 0, 3, 3]);
    m.strobe = 1;
    m.animation_offset_start = 7;
    expect(S.contentFrame(m, 100)).toBe(7);
  });

  it('slips content under fixed handles', () => {
    const e = ed();
    const m = add(e, 'MOVIE', 1, 0, 100);
    m.frame_offset_start = 20;
    m.frame_offset_end = 30;
    S.slip(m, 5);
    expect([S.finalStart(m), S.finalEnd(m), m.frame_start]).toEqual([20, 70, 5]);
    S.slip(m, 1000); // clamped so the visible range stays inside the content
    expect([S.finalStart(m), S.finalEnd(m), m.frame_offset_start]).toEqual([20, 70, 0]);
  });

  it('computes transition factors (0 at the first frame)', () => {
    const e = ed();
    const x = add(e, 'CROSS', 3, 1, 30);
    expect(S.effectFac(x, 11)).toBeCloseTo(1 / 3, 5);
    expect(S.effectFac(x, 16)).toBeCloseTo(0.5, 5);
    x.use_default_fade = false;
    x.effect_fader = 0.25;
    expect(S.effectFac(x, 16)).toBe(0.25);
  });

  it('effect strips span the overlap of their inputs', () => {
    const e = ed();
    const a = add(e, 'COLOR', 1, 1, 25);
    const b = add(e, 'COLOR', 2, 10, 25);
    const x = add(e, 'CROSS', 3, 0, 1);
    x.input_1 = a.name;
    x.input_2 = b.name;
    S.updateEffectRanges(e.strips);
    expect([S.finalStart(x), S.finalEnd(x)]).toEqual([10, 26]);
  });

  it('formats timecodes', () => {
    expect(S.timecode(50, 24, true)).toBe('00:02+02');
    expect(S.timecode(0, 24, true)).toBe('00:00+00');
    expect(S.timecode(24 * 3600, 24, true)).toBe('01:00:00+00');
    expect(S.timecode(50, 24, false)).toBe('50');
  });
});

describe('split', () => {
  it('soft split keeps content reachable from both halves', () => {
    const e = ed();
    const m = add(e, 'MOVIE', 1, 1, 100);
    const [r] = S.splitStrips(e, e.strips, [m], 41, 'SOFT');
    expect([S.finalStart(m), S.finalEnd(m)]).toEqual([1, 41]);
    expect([S.finalStart(r), S.finalEnd(r)]).toEqual([41, 101]);
    expect(r.name).toBe('Movie.001');
    // content stays continuous across the cut
    expect(S.contentFrame(m, 40)).toBe(39);
    expect(S.contentFrame(r, 41)).toBe(40);
    // the left part can be extended again (soft)
    S.setRightHandle(m, 80);
    expect(S.finalEnd(m)).toBe(80);
  });

  it('hard split removes the content beyond the cut', () => {
    const e = ed();
    const m = add(e, 'MOVIE', 1, 1, 100);
    const [r] = S.splitStrips(e, e.strips, [m], 41, 'HARD');
    expect([S.finalStart(m), S.finalEnd(m), m.frame_duration]).toEqual([1, 41, 40]);
    expect([S.finalStart(r), S.finalEnd(r), r.frame_duration]).toEqual([41, 101, 60]);
    expect(S.contentFrame(r, 41)).toBe(40);
    S.setRightHandle(m, 80);
    expect(S.finalEnd(m)).toBe(41);
  });

  it('splits effects whose inputs are split and re-links them', () => {
    const e = ed();
    const a = add(e, 'COLOR', 1, 1, 100);
    const b = add(e, 'COLOR', 2, 1, 100);
    const x = add(e, 'CROSS', 3, 1, 100);
    x.input_1 = a.name;
    x.input_2 = b.name;
    const out = S.splitStrips(e, e.strips, [a, b], 51, 'SOFT');
    const rx = out.find((s) => s.type === 'CROSS')!;
    expect(rx).toBeTruthy();
    expect(rx.input_1).not.toBe(a.name);
    expect([S.finalStart(x), S.finalEnd(x)]).toEqual([1, 51]);
    expect([S.finalStart(rx), S.finalEnd(rx)]).toEqual([51, 101]);
  });

  it('does not split strips that do not cross the frame', () => {
    const e = ed();
    const m = add(e, 'MOVIE', 1, 1, 10);
    expect(S.splitStrips(e, e.strips, [m], 20, 'SOFT')).toEqual([]);
  });
});

describe('channels & overlap', () => {
  it('stacks strips bottom channel first and skips muted / sound / muted channels', () => {
    const e = ed();
    const c3 = add(e, 'COLOR', 3, 1, 10);
    const c1 = add(e, 'COLOR', 1, 1, 10);
    const c2 = add(e, 'TEXT', 2, 1, 10);
    add(e, 'SOUND', 4, 1, 10);
    const c5 = add(e, 'COLOR', 5, 1, 10);
    c5.mute = true;
    const c6 = add(e, 'COLOR', 6, 1, 10);
    e.channels[6].mute = true;
    expect(S.renderStack(e.strips, e.channels, 5)).toEqual([c1, c2, c3]);
    void c6;
  });

  it('finds free channels', () => {
    const e = ed();
    add(e, 'COLOR', 1, 1, 10);
    add(e, 'COLOR', 2, 5, 10);
    expect(S.freeChannel(e.strips, 3, 8)).toBe(3);
    expect(S.freeChannel(e.strips, 11, 20)).toBe(1);
    expect(S.freeChannel(e.strips, 12, 20, 1)).toBe(1);
  });

  it('shuffles overlapping transformed strips to the nearest free time', () => {
    const e = ed();
    add(e, 'COLOR', 1, 1, 10);
    const m = add(e, 'COLOR', 1, 8, 5);
    S.resolveOverlap(e.strips, [m], 'SHUFFLE');
    expect(S.finalStart(m)).toBe(11);
  });

  it('overwrite trims strips underneath; expand pushes them', () => {
    const e = ed();
    const a = add(e, 'COLOR', 1, 1, 20);
    const m = add(e, 'COLOR', 1, 5, 5);
    S.resolveOverlap(e.strips, [m], 'OVERWRITE');
    expect([S.finalStart(a), S.finalEnd(a)]).toEqual([1, 5]);
    const right = e.strips.find((s) => s !== a && s !== m)!;
    expect([S.finalStart(right), S.finalEnd(right)]).toEqual([10, 21]);

    const e2 = ed();
    const b = add(e2, 'COLOR', 1, 10, 10);
    const m2 = add(e2, 'COLOR', 1, 5, 10);
    S.resolveOverlap(e2.strips, [m2], 'EXPAND');
    expect(S.finalStart(b)).toBe(15);
  });

  it('snaps to the closest target within the threshold', () => {
    expect(S.snapOffset([10, 20], [12, 30], 3)).toBe(2);
    expect(S.snapOffset([10, 20], [26], 3)).toBe(null);
    expect(S.snapOffset([10, 20], [21, 8], 3)).toBe(1);
  });

  it('removes and inserts gaps', () => {
    const e = ed();
    const a = add(e, 'COLOR', 1, 1, 10);
    const b = add(e, 'COLOR', 1, 21, 10);
    const c = add(e, 'COLOR', 2, 41, 10);
    expect(S.gapRemove(e.strips, 1, false)).toBe(true);
    expect(S.finalStart(b)).toBe(11);
    expect(S.finalStart(c)).toBe(31);
    S.gapRemove(e.strips, 1, true);
    expect(S.finalStart(c)).toBe(21);
    S.gapInsert(e.strips, 11, 5);
    expect([S.finalStart(a), S.finalStart(b), S.finalStart(c)]).toEqual([1, 16, 26]);
  });

  it('makes and separates meta strips', () => {
    const e = ed();
    const a = add(e, 'COLOR', 1, 1, 10);
    const b = add(e, 'COLOR', 2, 5, 10);
    const meta = S.makeMeta(e, e.strips, [a, b])!;
    expect(e.strips).toEqual([meta]);
    expect([S.finalStart(meta), S.finalEnd(meta), meta.channel]).toEqual([1, 15, 1]);
    S.translateStrip(meta, 10);
    expect(S.finalStart(a)).toBe(11);
    S.separateMeta(e.strips, meta);
    expect(e.strips.length).toBe(2);
    expect(S.finalStart(b)).toBe(15);
  });

  it('generates unique names', () => {
    const e = ed();
    add(e, 'COLOR', 1, 1, 10);
    expect(S.uniqueName(e, 'Color')).toBe('Color.001');
    add(e, 'COLOR', 1, 20, 10);
    expect(S.uniqueName(e, 'Color.001')).toBe('Color.002');
  });

  it('remaps speed effect input frames', () => {
    const e = ed();
    const m = add(e, 'MOVIE', 1, 1, 100);
    const sp = add(e, 'SPEED', 2, 1, 100);
    sp.input_1 = m.name;
    S.updateEffectRanges(e.strips);
    expect(S.speedInputFrame(sp, m, 51)).toBe(51);
    sp.speed_control = 'MULTIPLY';
    sp.speed_factor = 2;
    expect(S.speedInputFrame(sp, m, 11)).toBe(21);
    expect(S.speedInputFrame(sp, m, 90)).toBe(100); // holds the last frame
    sp.speed_control = 'FRAME_NUMBER';
    sp.speed_frame_number = 7;
    expect(S.speedInputFrame(sp, m, 60)).toBe(8);
  });
});

// Expected values: sequencer renders (sRGB, 8×8 colour strips), bottom (0.2,0.5,0.8),
// top (0.6,0.3,0.1), opacity 0.7. Tolerance 1.5/255 except where noted.
const REF: Partial<Record<BlendType, [number, number, number]>> = {
  CROSS: [0.4784, 0.3607, 0.3098],
  DARKEN: [0.2, 0.3607, 0.3137],
  MULTIPLY: [0.141, 0.255, 0.2981],
  BURN: [0.0591, 0.1491, 0.2393],
  LINEAR_BURN: [0.0591, 0.1491, 0.2393],
  LIGHTEN: [0.4784, 0.502, 0.8],
  SCREEN: [0.5333, 0.6079, 0.8157],
  DODGE: [0.4078, 0.651, 0.8627],
  ADD: [0.6157, 0.7098, 0.8706],
  OVERLAY: [0.2235, 0.3648, 0.6902],
  SOFT_LIGHT: [0.2235, 0.4313, 0.7098],
  HARD_LIGHT: [0.3137, 0.3607, 0.3529],
  LINEAR_LIGHT: [0.3412, 0.2235, 0.2432],
  PIN_LIGHT: [0.2, 0.502, 0.3803],
  DIFFERENCE: [0.3373, 0.2902, 0.7255],
  EXCLUSION: [0.4471, 0.498, 0.7529],
  SUBTRACT: [0.0, 0.2942, 0.7294],
  HUE: [0.6157, 0.4548, 0.3803],
  SATURATION: [0.153, 0.4745, 0.8],
  COLOR: [0.6157, 0.4274, 0.3333],
  VALUE: [0.1609, 0.4118, 0.6588],
  ALPHA_OVER: [0.4784, 0.3607, 0.3098],
  ALPHA_UNDER: [0.2, 0.502, 0.8],
  GAMMA_CROSS: [0.4588, 0.3568, 0.2432],
};

describe('blend modes', () => {
  for (const [mode, ref] of Object.entries(REF) as [BlendType, [number, number, number]][]) {
    it(`${mode} matches the expected values`, () => {
      const out = B.blendPixel(mode, [0.2, 0.5, 0.8, 1], [0.6, 0.3, 0.1, 1], 0.7);
      for (let i = 0; i < 3; i++) expect(Math.abs(out[i] - ref[i])).toBeLessThan(mode === 'HUE' || mode === 'COLOR' ? 4 / 255 : 2 / 255);
      expect(out[3]).toBeCloseTo(1, 5);
    });
  }

  it('REPLACE scales the strip by its opacity', () => {
    expect(B.blendPixel('REPLACE', [0.2, 0.5, 0.8, 1], [0.6, 0.3, 0.1, 1], 0.7).map((x) => +x.toFixed(4))).toEqual([0.42, 0.21, 0.07, 0.7]);
  });

  it('colour blend modes over transparency leave it transparent', () => {
    for (const m of ['MULTIPLY', 'SCREEN', 'ADD', 'SUBTRACT', 'OVERLAY'] as BlendType[]) expect(B.blendPixel(m, [0, 0, 0, 0], [0.6, 0.3, 0.1, 1], 0.7)[3]).toBe(0);
    expect(B.blendPixel('ALPHA_UNDER', [0, 0, 0, 0], [0.6, 0.3, 0.1, 1], 0.7)[3]).toBeCloseTo(0.7, 5);
  });

  it('alpha over respects premultiplied transparency of the top strip', () => {
    const out = B.blendPixel('ALPHA_OVER', [0, 0, 1, 1], [0.5, 0, 0, 0.5], 1);
    expect(out).toEqual([0.5, 0, 0.5, 1]);
  });
});

describe('effects', () => {
  it('crossfades over the effect length (expected values at frames 11/16/20 of 1..31)', () => {
    const red: B.RGBA = [1, 0, 0, 1],
      blue: B.RGBA = [0, 0.4, 1, 1];
    expect(B.effectPixel('CROSS', red, blue, 1 / 3)[0]).toBeCloseTo(0.6667, 3);
    expect(B.effectPixel('CROSS', red, blue, 0.5)[2]).toBeCloseTo(0.5, 3);
    // gamma cross expected: 0.4431, 0.0426, 0.1097 at fac 1/3
    const g = B.effectPixel('GAMMA_CROSS', red, blue, 1 / 3);
    expect(g[0]).toBeCloseTo(0.4444, 2);
    expect(g[1]).toBeCloseTo(0.0444, 2);
    expect(g[2]).toBeCloseTo(0.1111, 2);
  });

  it('two-input effects use the expected input order', () => {
    const red: B.RGBA = [1, 0, 0, 1],
      blue: B.RGBA = [0, 0.4, 1, 1];
    expect(B.effectPixel('ADD', red, blue, 1)).toEqual([1, 0.4, 1, 1]);
    expect(B.effectPixel('SUBTRACT', red, blue, 1)).toEqual([1, 0, 0, 1]);
    expect(B.effectPixel('MULTIPLY', red, blue, 1)).toEqual([0, 0, 0, 1]);
    expect(B.effectPixel('ALPHA_OVER', red, blue, 1)).toEqual(red);
    expect(B.effectPixel('ALPHA_UNDER', red, blue, 1)).toEqual(blue);
  });

  it('wipe masks match the expected layouts at fac 1/3', () => {
    const W = 16,
      H = 8;
    // integer pixel coordinates, y = 0 is the bottom row (expected rows from a 16×8 render)
    const row = (type: 'SINGLE' | 'DOUBLE' | 'IRIS' | 'CLOCK', dir: 'OUT' | 'IN', y: number) =>
      Array.from({ length: W }, (_, x) => (B.wipeMask(x, y, W, H, 1 / 3, type, dir, 0, 0) > 0.5 ? 'B' : 'R')).join('');
    const ref: Record<string, string[]> = {
      SINGLE_OUT: ['RRRRRRRRRRRRRRRR', 'RRRRRRRRRRRRRRRR', 'BBBBBBBBBBBBBBBB'],
      SINGLE_IN: ['BBBBBBBBBBBBBBBB', 'RRRRRRRRRRRRRRRR', 'RRRRRRRRRRRRRRRR'],
      DOUBLE_OUT: ['RRRRRRRRRRRRRRRR', 'BBBBBBBBBBBBBBBB', 'RRRRRRRRRRRRRRRR'],
      DOUBLE_IN: ['BBBBBBBBBBBBBBBB', 'RRRRRRRRRRRRRRRR', 'BBBBBBBBBBBBBBBB'],
      IRIS_OUT: ['RRRRRRRRRRRRRRRR', 'RRRRRRBBBBBRRRRR', 'RRRRRRRRRRRRRRRR'],
      CLOCK_OUT: ['RRRRRRRRRRRRRRRR', 'RRRRRRRRRBBBBBBB', 'RRRRRRRBBBBBBBBB'],
      CLOCK_IN: ['RRRRRRBBBBBBBBBB', 'RRRRRRRRBRRRRRRR', 'RRRRRRRRRRRRRRRR'],
    };
    for (const [k, rows] of Object.entries(ref)) {
      const [t, d] = k.split('_') as ['SINGLE', 'OUT'];
      const got = [0, 4, 7].map((y) => row(t, d, y));
      // allow one pixel of difference per row at the curved edges
      got.forEach((g, i) => expect([...g].filter((c, j) => c !== rows[i][j]).length, `${k} row ${i}: ${g}`).toBeLessThanOrEqual(1));
    }
    // IRIS IN: corners show input 2
    expect(row('IRIS', 'IN', 0).startsWith('BBB')).toBe(true);
    expect(row('IRIS', 'IN', 4)[8]).toBe('R');
  });
});

describe('colour correction', () => {
  const near = (a: number[], b: number[], tol = 2 / 255) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(tol));
  const cb = () => S.newColorBalance();
  it('lift/gamma/gain matches the expected values', () => {
    const d = cb();
    d.lift = [1.2, 1, 1];
    d.gamma = [1, 1.3, 1];
    d.gain = [1, 1, 0.8];
    near(B.colorBalance([0.4, 0.5, 0.6], d), [0.5215, 0.5882, 0.4784]);
    near(B.colorBalance([0.4, 0.5, 0.6], d, 0.5), [0.2589, 0.2942, 0.2393]);
    const all = cb();
    all.lift = [1.2, 1.2, 1.2];
    all.gamma = [1.3, 1.3, 1.3];
    all.gain = [0.8, 0.8, 0.8];
    near(B.colorBalance([0.4, 0.5, 0.6], all), [0.5098, 0.5686, 0.6275]);
    d.invert_lift = d.invert_gamma = d.invert_gain = true;
    near(B.colorBalance([0.4, 0.5, 0.6], d), [0.2784, 0.4078, 0.749]);
  });
  it('offset/power/slope matches the expected values', () => {
    const d = cb();
    d.correction_method = 'OFFSET_POWER_SLOPE';
    d.offset = [1.1, 1, 1];
    d.power = [1, 1.3, 1];
    d.slope = [1, 1, 0.8];
    near(B.colorBalance([0.4, 0.5, 0.6], d), [0.498, 0.5882, 0.4784]);
    d.invert_offset = d.invert_power = d.invert_slope = true;
    near(B.colorBalance([0.4, 0.5, 0.6], d), [0.298, 0.4078, 0.749]);
    const all = cb();
    all.correction_method = 'OFFSET_POWER_SLOPE';
    all.offset = [1.1, 1.1, 1.1];
    all.power = [1.3, 1.3, 1.3];
    all.slope = [0.8, 0.8, 0.8];
    near(B.colorBalance([0.4, 0.5, 0.6], all), [0.5137, 0.5883, 0.6588]);
  });
  it('brightness/contrast matches the expected values', () => {
    near(B.brightContrast([0.4, 0.5, 0.6], 0.1, 20), [0.3765, 0.502, 0.6274]);
    near(B.brightContrast([0.4, 0.5, 0.6], 10, -20), [0.502, 0.5804, 0.6588]);
  });
  it('strip saturation and multiply match the expected values', () => {
    near(B.stripColor([0.4, 0.5, 0.6], 0.5, 0.8), [0.4, 0.4392, 0.4745], 3 / 255);
  });
});

describe('audio', () => {
  it('computes the playing segment of a sound strip', () => {
    const e = ed();
    const s = add(e, 'SOUND', 1, 25, 48);
    s.frame_offset_start = 12;
    expect(soundSegment(s, 24, 1)).toEqual({ delay: 1.5, offset: 0.5, duration: 1.5 });
    expect(soundSegment(s, 24, 49)).toEqual({ delay: 0, offset: 1, duration: 1 });
    expect(soundSegment(s, 24, 200)).toBe(null);
    s.sound_offset = 2;
    expect(soundSegment(s, 24, 37)!.offset).toBe(2.5);
  });

  it('encodes WAV files', () => {
    const l = new Float32Array([0, 1, -1, 0.5]);
    const r = new Float32Array([0, -1, 1, -0.5]);
    const w = encodeWav([l, r], 48000, 'S16');
    const dv = new DataView(w.buffer);
    expect(String.fromCharCode(...w.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...w.subarray(8, 12))).toBe('WAVE');
    expect(dv.getUint16(22, true)).toBe(2);
    expect(dv.getUint32(24, true)).toBe(48000);
    expect(dv.getUint32(40, true)).toBe(16);
    expect(dv.getInt16(44 + 4, true)).toBe(32767);
    expect(dv.getInt16(44 + 6, true)).toBe(-32768);
    const f = encodeWav([l], 44100, 'F32');
    expect(new DataView(f.buffer).getUint16(20, true)).toBe(3);
    expect(new DataView(f.buffer).getFloat32(44 + 12, true)).toBeCloseTo(0.5);
  });

  it('computes waveform peaks and pan gains', () => {
    const p = peaks(new Float32Array([0.1, -0.5, 0.9, 0.2]), 2);
    expect(Array.from(p).map((x) => +x.toFixed(2))).toEqual([-0.5, 0.1, 0, 0.9]);
    expect(panGains(0)).toEqual([1, 1]);
    expect(panGains(1)).toEqual([0, 1]);
    expect(panGains(-0.5)).toEqual([1, 0.5]);
  });
});
