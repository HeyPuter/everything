import { describe, expect, it } from 'vitest';
import {
  defaults,
  rgba8,
  type OperationContext,
  type ParamValues,
  type RGBA8,
} from '../src/imaging/types';
import { developOp } from '../src/imaging/filters/develop';
import {
  bandWeights,
  calibrationMatrix,
  gradeTable,
  gradeWeights,
  grayOf,
  grayTable,
  hueOf,
  mixPixel,
  mixerTable,
} from '../src/imaging/filters/develop/color';
import {
  curveTables,
  parametricEval,
  splineEval,
  toneLUT,
} from '../src/imaging/filters/develop/tone';
import {
  BANDS,
  DEVELOP_VERSION,
  PANELS,
  developDefaults,
  migrateDevelop,
  panelIsDefault,
} from '../src/imaging/filters/develop/params';
import { resolveDevelop } from '../src/imaging/filters/develop/profiles';
import {
  autoTone,
  autoWhiteBalance,
  wbGains,
  whiteBalanceFor,
} from '../src/imaging/filters/develop/auto';
import { normalizeFor } from '../src/features/filters/catalog';
import { gradientRow, readMask } from '../src/imaging/filters/develop/masks';
import { SRGB_TO_LINEAR, encodeSRGB } from '../src/imaging/filters/sampling';

const ctx: OperationContext = { foreground: [0, 0, 0], background: [255, 255, 255], seed: 3 };
const dev = (src: RGBA8, p: ParamValues) =>
  developOp.apply(src, { ...defaults(developOp), ...p }, ctx) as RGBA8;
function photo(w: number, h: number): RGBA8 {
  const out = rgba8(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      out.data.set(
        [(x * 255) / (w - 1), (y * 255) / (h - 1), 128 + 100 * Math.sin((x + y) / 5), 255],
        (y * w + x) * 4,
      );
  return out;
}
function maxDiff(a: RGBA8, b: RGBA8) {
  let m = 0;
  for (let i = 0; i < a.data.length; i++) m = Math.max(m, Math.abs(a.data[i] - b.data[i]));
  return m;
}
const px = (img: RGBA8, x: number, y: number) =>
  Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
const solid = (rgb: number[], w = 8, h = 8) => rgba8(w, h, [rgb[0], rgb[1], rgb[2], 255]);

describe('develop parameters and migration', () => {
  it('defaults are the identity for every panel', () => {
    const d = developDefaults();
    for (const p of PANELS) expect(panelIsDefault(d, p.id), p.id).toBe(true);
    const src = photo(40, 30);
    expect(maxDiff(dev(src, {}), src)).toBe(0);
  });
  it('settings without a version are migrated to the round, color-priority vignette', () => {
    const m = migrateDevelop({ exposure: 0.5, vignette: -40 });
    expect(m).toMatchObject({
      version: DEVELOP_VERSION,
      exposure: 0.5,
      vignette: -40,
      vignetteStyle: 'color',
      vignetteRoundness: 100,
    });
    const n = normalizeFor('develop', { vignette: -40 });
    expect(n.version).toBe(DEVELOP_VERSION);
    expect(n.vignetteStyle).toBe('color');
    // Normalizing again changes nothing (current settings are not migrated twice).
    expect(normalizeFor('develop', n)).toEqual(n);
    expect(normalizeFor('develop', { ...n, vignetteStyle: 'paint' }).vignetteStyle).toBe('paint');
  });
  it('a migrated version 1 vignette renders with the first version falloff', () => {
    const flat = solid([150, 150, 150], 40, 40);
    const out = developOp.apply(flat, normalizeFor('develop', { vignette: -100 }), ctx) as RGBA8;
    const d = Math.hypot(0.5 - 20, 0.5 - 20) / Math.hypot(20, 20),
      t = Math.min(1, Math.max(0, (d - 0.35) / 0.7)),
      gain = Math.pow(2, -1.5 * t * t * (3 - 2 * t));
    const expected = encodeSRGB(SRGB_TO_LINEAR[150] * gain);
    expect(Math.abs(out.data[0] - expected)).toBeLessThanOrEqual(1);
    expect(out.data[(20 * 40 + 20) * 4]).toBe(150);
  });
  it('old settings keep their meaning: exposure, temperature and grain', () => {
    const src = photo(32, 24);
    const p = normalizeFor('develop', { exposure: 1, temperature: 30, grain: 20, grainSize: 25 });
    const a = developOp.apply(src, p, ctx) as RGBA8;
    const b = dev(src, { exposure: 1, temperature: 30, grain: 20 });
    expect(maxDiff(a, b)).toBe(0);
  });
});

describe('develop curves', () => {
  it('the Light curve, parametric curve and point curves are monotonic', () => {
    const tones: ParamValues[] = [
      { contrast: 100, shadows: 100, highlights: -100 },
      { contrast: -100, whites: 100, blacks: -100 },
    ];
    for (const p of tones) {
      const lut = toneLUT(p, 1.5, 1, 512);
      for (let i = 1; i < lut.length; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    }
    for (const vals of [
      [100, 100, 100, 100],
      [-100, 100, -100, 100],
      [100, -100, 100, -100],
    ]) {
      const t = curveTables({
        curveShadows: vals[0],
        curveDarks: vals[1],
        curveLights: vals[2],
        curveHighlights: vals[3],
      });
      expect(t.active).toBe(true);
      expect(t.r[0]).toBe(0);
      expect(t.r[t.n]).toBeCloseTo(1, 5);
      for (let i = 1; i <= t.n; i++) expect(t.r[i]).toBeGreaterThanOrEqual(t.r[i - 1]);
    }
    const f = splineEval([
      { x: 0, y: 0 },
      { x: 0.3, y: 0.5 },
      { x: 0.31, y: 0.52 },
      { x: 1, y: 1 },
    ]);
    let prev = -1;
    for (let i = 0; i <= 200; i++) {
      const y = f(i / 200);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });
  it('region sliders move their own band most and keep black and white', () => {
    const shadows = parametricEval({ curveShadows: 100 }),
      highlights = parametricEval({ curveHighlights: -100 });
    expect(shadows(0.125)).toBeGreaterThan(0.17);
    expect(shadows(0.8)).toBeCloseTo(0.8, 6);
    expect(highlights(0.875)).toBeLessThan(0.83);
    expect(highlights(0.2)).toBeCloseTo(0.2, 6);
    expect(shadows(0)).toBe(0);
    expect(highlights(1)).toBe(1);
  });
  it('a straight or empty point curve is the identity; channel curves tint', () => {
    expect(curveTables({}).active).toBe(false);
    expect(
      curveTables({
        curveRGB: [
          [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.5 },
            { x: 1, y: 1 },
          ],
        ],
      }).active,
    ).toBe(false);
    const gray = solid([128, 128, 128]);
    const out = dev(gray, {
      curveRed: [
        [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.7 },
          { x: 1, y: 1 },
        ],
      ],
    });
    const [r, g, b] = px(out, 0, 0);
    expect(r).toBeGreaterThan(165);
    expect(g).toBe(128);
    expect(b).toBe(128);
  });
});

describe('develop color', () => {
  it('hue band weights sum to one, peak at their centers and stay local', () => {
    for (let h = 0; h < 360; h += 0.5) {
      const w = bandWeights(h);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      for (const v of w) expect(v).toBeGreaterThanOrEqual(0);
    }
    BANDS.forEach((b, k) => {
      const w = bandWeights(b.hue);
      expect(w[k]).toBe(1);
    });
    // Green does not reach red.
    expect(bandWeights(0)[3]).toBe(0);
  });
  it('the mixer leaves grays alone and moves only the chosen colors', () => {
    const t = mixerTable({ hueRed: 100, satRed: -100, lumBlue: -100, satGreen: 100 });
    expect(t.active).toBe(true);
    const gray = [0.2, 0.2, 0.2];
    mixPixel(t, gray);
    expect(gray).toEqual([0.2, 0.2, 0.2]);
    // Red loses its saturation.
    const red = [0.6, 0.05, 0.05];
    mixPixel(t, red);
    expect(Math.max(...red) - Math.min(...red)).toBeLessThan(0.05);
    // Blue darkens, a yellow is untouched.
    const blue = [0.05, 0.1, 0.6],
      Y0 = 0.2126 * 0.05 + 0.7152 * 0.1 + 0.0722 * 0.6;
    mixPixel(t, blue);
    expect(0.2126 * blue[0] + 0.7152 * blue[1] + 0.0722 * blue[2]).toBeLessThan(Y0 * 0.7);
    const yellow = [0.5, 0.5, 0.05];
    mixPixel(t, yellow);
    expect(yellow[0]).toBeCloseTo(0.5, 6);
  });
  it('a positive red hue shift turns red toward orange in the image', () => {
    const out = dev(solid([200, 30, 30]), { hueRed: 100 });
    const [r, g, b] = px(out, 0, 0);
    expect(hueOf(r, g, b)).toBeGreaterThan(8);
    expect(hueOf(r, g, b)).toBeLessThan(50);
  });
  it('black and white uses the gray mix by color', () => {
    const red = [SRGB_TO_LINEAR[200], SRGB_TO_LINEAR[40], SRGB_TO_LINEAR[40]] as const;
    const plain = grayOf(grayTable({}), ...red),
      lifted = grayOf(grayTable({ grayRed: 100 }), ...red),
      lowered = grayOf(grayTable({ grayRed: -100 }), ...red);
    expect(lifted).toBeGreaterThan(plain * 1.8);
    expect(lowered).toBeLessThan(plain * 0.6);
    const out = dev(photo(16, 16), { profile: 'mono' });
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(out.data[i + 1]);
      expect(out.data[i + 1]).toBe(out.data[i + 2]);
    }
  });
  it('color grading weights sum to one and tint the matching tones', () => {
    for (const [bl, ba] of [
      [0, 0],
      [1, 0],
      [0.5, 1],
      [0.5, -1],
    ])
      for (let L = 0; L <= 1; L += 0.05) {
        const w = gradeWeights(L, bl, ba);
        expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 9);
      }
    expect(gradeWeights(0.05, 0.5, 0)[0]).toBeGreaterThan(0.95);
    expect(gradeWeights(0.95, 0.5, 0)[2]).toBeGreaterThan(0.95);
    // Positive balance favors the highlights wheel.
    expect(gradeWeights(0.5, 0.5, 1)[2]).toBeGreaterThan(gradeWeights(0.5, 0.5, 0)[2]);
    expect(gradeTable({}).active).toBe(false);
    // Blue shadows: a dark gray turns blue, a light gray barely changes.
    const p = { gradeShadowHue: 220, gradeShadowSat: 100 };
    const dark = px(dev(solid([40, 40, 40]), p), 0, 0),
      light = px(dev(solid([225, 225, 225]), p), 0, 0);
    expect(dark[2] - dark[0]).toBeGreaterThan(10);
    expect(Math.abs(light[2] - light[0])).toBeLessThan(3);
    // Global red tint on a midtone.
    const mid = px(dev(solid([128, 128, 128]), { gradeGlobalHue: 0, gradeGlobalSat: 60 }), 0, 0);
    expect(mid[0]).toBeGreaterThan(mid[1] + 8);
  });
  it('calibration keeps neutrals neutral and turns the primaries', () => {
    expect(calibrationMatrix({})).toBeNull();
    const M = calibrationMatrix({ calRedHue: 100, calGreenSat: -50, calBlueHue: -60 })!;
    for (let r = 0; r < 3; r++) expect(M[r * 3] + M[r * 3 + 1] + M[r * 3 + 2]).toBeCloseTo(1, 9);
    const gray = px(dev(solid([120, 120, 120]), { calRedHue: 100, calBlueSat: 100 }), 0, 0);
    expect(new Set(gray).size).toBe(1);
    const red = px(dev(solid([200, 20, 20]), { calRedHue: 100 }), 0, 0);
    expect(red[1]).toBeGreaterThan(30);
  });
});

describe('develop profiles and panel switches', () => {
  it('Natural and amount 0 change nothing; Vivid adds saturation', () => {
    const src = photo(24, 24);
    expect(maxDiff(dev(src, { profile: 'natural' }), src)).toBe(0);
    expect(maxDiff(dev(src, { profile: 'vivid', profileAmount: 0 }), src)).toBe(0);
    const sat = (img: RGBA8) => {
      let s = 0;
      for (let i = 0; i < img.data.length; i += 4)
        s +=
          Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) -
          Math.min(img.data[i], img.data[i + 1], img.data[i + 2]);
      return s;
    };
    expect(sat(dev(src, { profile: 'vivid' }))).toBeGreaterThan(sat(src) * 1.05);
    expect(sat(dev(src, { profile: 'vivid', profileAmount: 200 }))).toBeGreaterThan(
      sat(dev(src, { profile: 'vivid' })),
    );
  });
  it('a switched-off panel renders as if at its defaults', () => {
    const src = photo(24, 24);
    const p = { exposure: 1, contrast: 40, hueRed: 50, gradeShadowSat: 60, curveShadows: 50 };
    expect(
      maxDiff(
        dev(src, { ...p, lightOn: false, mixerOn: false, gradingOn: false, curveOn: false }),
        src,
      ),
    ).toBe(0);
    expect(
      maxDiff(dev(src, { ...p, lightOn: false }), dev(src, { ...p, exposure: 0, contrast: 0 })),
    ).toBe(0);
    // The profile look's offsets for a switched-off panel are dropped too.
    expect(resolveDevelop({ profile: 'vivid', lightOn: false, contrast: 0 }).params.contrast).toBe(
      0,
    );
  });
});

describe('develop auto settings', () => {
  it('the white balance picked from a color neutralizes it', () => {
    const colors: [number, number, number][] = [
      [0.3, 0.25, 0.15],
      [0.15, 0.17, 0.25],
      [0.2, 0.3, 0.2],
    ];
    for (const c of colors) {
      const { temperature, tint } = whiteBalanceFor(c[0], c[1], c[2]);
      const g = wbGains(temperature, tint);
      const out = c.map((v, i) => v * g[i]);
      expect(Math.max(...out) / Math.min(...out)).toBeLessThan(1.08);
    }
    // A blue cast asks for a warmer temperature.
    const blueCast = solid([110, 120, 160], 32, 32);
    expect(autoWhiteBalance(blueCast).temperature).toBeGreaterThan(10);
  });
  it('Auto tone brightens a dark image, darkens a bright one and leaves a balanced one mostly alone', () => {
    const ramp = (lo: number, hi: number) => {
      const img = rgba8(64, 64);
      for (let i = 0; i < 64 * 64; i++) {
        const v = lo + ((hi - lo) * (i % 64)) / 63;
        img.data.set([v, v, v, 255], i * 4);
      }
      return img;
    };
    expect(autoTone(ramp(5, 70)).exposure).toBeGreaterThan(0.5);
    expect(autoTone(ramp(170, 255)).exposure).toBeLessThan(-0.3);
    const balanced = autoTone(ramp(0, 255));
    expect(Math.abs(balanced.exposure)).toBeLessThanOrEqual(0.5);
    expect(balanced.whites).toBe(0);
    // A flat, low-contrast image gets contrast and stretched ends.
    const flat = autoTone(ramp(100, 150));
    expect(flat.contrast).toBeGreaterThan(10);
    expect(flat.whites).toBeGreaterThan(0);
    expect(flat.blacks).toBeLessThan(0);
  });
});

describe('develop pixel passes in the pipeline', () => {
  const edge = () => {
    const img = rgba8(32, 32);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const v = x < 16 ? 80 : 170;
        img.data.set([v, v, v, 255], (y * 32 + x) * 4);
      }
    return img;
  };
  it('sharpening raises edge contrast and its panel switch turns it off', () => {
    const src = edge();
    const out = dev(src, { sharpenAmount: 120 });
    expect(px(out, 14, 10)[0]).toBeLessThan(80);
    expect(px(out, 17, 10)[0]).toBeGreaterThan(170);
    expect(maxDiff(dev(src, { sharpenAmount: 120, detailOn: false }), src)).toBe(0);
  });
  it('geometry and lens corrections run before the tone work', () => {
    const src = photo(40, 30);
    const rotated = dev(src, { geoRotate: 5 });
    expect(maxDiff(rotated, src)).toBeGreaterThan(20);
    expect(maxDiff(dev(src, { geoRotate: 5, geometryOn: false }), src)).toBe(0);
    const lens = dev(src, { lensVignetting: 80 });
    expect(px(lens, 0, 0)[2]).toBeGreaterThanOrEqual(px(src, 0, 0)[2]);
    // Rotation and exposure together: both apply.
    const both = dev(src, { geoRotate: 5, exposure: 1 });
    expect(maxDiff(both, rotated)).toBeGreaterThan(10);
  });
  it('grain after sharpening is deterministic', () => {
    const src = solid([128, 128, 128], 24, 24);
    const a = dev(src, { sharpenAmount: 50, grain: 40 }),
      b = dev(src, { sharpenAmount: 50, grain: 40 });
    expect(maxDiff(a, b)).toBe(0);
    expect(maxDiff(a, src)).toBeGreaterThan(2);
  });
});

describe('develop local adjustment masks', () => {
  const gray = () => solid([110, 110, 110], 40, 40);
  it('a linear gradient applies fully at its start and fades out by its end', () => {
    const out = dev(gray(), {
      mask1Type: 'linear',
      mask1Ax: 0.5,
      mask1Ay: 0,
      mask1Bx: 0.5,
      mask1By: 1,
      mask1Exposure: 1,
    });
    const top = px(out, 20, 0)[0],
      mid = px(out, 20, 20)[0],
      bottom = px(out, 20, 39)[0];
    expect(top).toBeGreaterThan(140);
    expect(mid).toBeGreaterThan(110);
    expect(mid).toBeLessThan(top);
    expect(Math.abs(bottom - 110)).toBeLessThanOrEqual(1);
  });
  it('a radial gradient changes the inside; invert changes the outside', () => {
    const p = {
      mask1Type: 'radial',
      mask1Ax: 0.5,
      mask1Ay: 0.5,
      mask1Bx: 0.8,
      mask1By: 0.8,
      mask1Exposure: -1,
    };
    const out = dev(gray(), p);
    expect(px(out, 20, 20)[0]).toBeLessThan(90);
    expect(px(out, 0, 0)[0]).toBe(110);
    const inv = dev(gray(), { ...p, mask1Invert: true });
    expect(px(inv, 20, 20)[0]).toBe(110);
    expect(px(inv, 0, 0)[0]).toBeLessThan(90);
  });
  it('brush strokes paint where they go and erase strokes take it back', () => {
    const stroke = [
      { x: 0.25, y: 0.1, t: 0.08 },
      { x: 0.25, y: 0.9, t: 0.08 },
    ];
    const p = { mask2Type: 'brush', mask2Saturation: -100, mask2Strokes: [stroke] };
    const red = solid([200, 40, 40], 40, 40);
    const out = dev(red, p);
    const [r, g] = px(out, 10, 20);
    expect(Math.abs(r - g)).toBeLessThan(8);
    expect(px(out, 32, 20)).toEqual([200, 40, 40]);
    const erased = dev(red, {
      ...p,
      mask2Strokes: [stroke, stroke.map((q) => ({ ...q, t: -0.12 }))],
    });
    expect(px(erased, 10, 20)).toEqual([200, 40, 40]);
  });
  it('masks without adjustments, at amount 0 or switched off change nothing', () => {
    const src = photo(24, 24);
    const p = { mask1Type: 'radial', mask1Exposure: 1 };
    expect(maxDiff(dev(src, { mask1Type: 'radial' }), src)).toBe(0);
    expect(maxDiff(dev(src, { ...p, mask1Amount: 0 }), src)).toBe(0);
    expect(maxDiff(dev(src, { ...p, masksOn: false }), src)).toBe(0);
    expect(maxDiff(dev(src, p), src)).toBeGreaterThan(10);
  });
  it('gradient weights stay in [0, 1] and fall off along the gradient', () => {
    const m = readMask(
      { mask1Type: 'linear', mask1Ax: 0.1, mask1Ay: 0.2, mask1Bx: 0.9, mask1By: 0.7 },
      1,
    )!;
    const row = new Float32Array(64);
    gradientRow(m, 20, 64, 64, row);
    for (let x = 0; x < 64; x++) {
      expect(row[x]).toBeGreaterThanOrEqual(0);
      expect(row[x]).toBeLessThanOrEqual(1);
      if (x) expect(row[x]).toBeLessThanOrEqual(row[x - 1] + 1e-6);
    }
  });
});
