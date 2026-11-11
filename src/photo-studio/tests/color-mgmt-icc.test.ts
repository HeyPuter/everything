import { describe, expect, it } from 'vitest';
import { builtinProfile, BUILTIN_PROFILES } from '../src/color/builtin-profiles';
import { D50, decodeLab, xyzToLab, labToXYZ, encodeLab } from '../src/color/color-math';
import { deltaE2000 } from '../src/color/delta-e';
import {
  clutEvaluator,
  deviceToXYZ,
  parseIcc,
  xyzToDevice,
  type Clut,
  type LutABTag,
  type Lut16Tag,
  type Profile,
} from '../src/color/icc-lut';
import { serializeIcc } from '../src/color/icc-write';
import { readRgbProfile } from '../src/color/profile';
import { createTransform, detectBlackPoint } from '../src/color/transform';

const toXYZ = (p: Profile, v: number[], intent: 'relative' | 'perceptual' = 'relative') => {
  const buf = new Float64Array(16);
  buf.set(v);
  for (const s of deviceToXYZ(p, intent).stages) s(buf);
  return [buf[0], buf[1], buf[2]];
};
const fromXYZ = (p: Profile, xyz: number[], intent: 'relative' | 'perceptual' = 'relative') => {
  const buf = new Float64Array(16);
  buf.set(xyz);
  for (const s of xyzToDevice(p, intent).stages) s(buf);
  return Array.from(buf.slice(0, p.channels));
};
const id = { kind: 'parametric' as const, type: 0, parameters: [1] };

describe('built-in matrix/TRC profiles', { timeout: 120000 }, () => {
  it('round-trips sRGB through XYZ and maps white to the PCS white', () => {
    const srgb = builtinProfile('srgb');
    const white = toXYZ(srgb, [1, 1, 1]);
    white.forEach((v, i) => expect(v).toBeCloseTo(D50[i], 6));
    // sRGB red in D50 (Bradford-adapted ICC colorant).
    const red = toXYZ(srgb, [1, 0, 0]);
    expect(red[0]).toBeCloseTo(0.4361, 3);
    expect(red[1]).toBeCloseTo(0.2225, 3);
    for (let i = 0; i < 200; i++) {
      const rgb = [Math.random(), Math.random(), Math.random()];
      const back = fromXYZ(srgb, toXYZ(srgb, rgb));
      back.forEach((v, c) => expect(v).toBeCloseTo(rgb[c], 9));
    }
    // Via the Lab profile, as transforms do.
    const lab = builtinProfile('lab-d50');
    const there = createTransform(srgb, lab),
      back = createTransform(lab, srgb);
    const mid = there.one([0.5, 0.5, 0.5]);
    expect(decodeLab(mid, 'v4')[0]).toBeCloseTo(53.39, 1);
    expect(back.one(mid)[0]).toBeCloseTo(0.5, 5);
  });

  it('exposes every built-in profile and keeps their whites at D50', () => {
    for (const { id: key, colorSpace } of BUILTIN_PROFILES) {
      if (colorSpace === 'CMYK') continue;
      const p = builtinProfile(key);
      const white = toXYZ(p, new Array(p.channels).fill(colorSpace === 'Lab' ? 0 : 1).map((v, i) => (colorSpace === 'Lab' ? (i ? 0.5 + 0.5 / 255 : 1) : v)));
      expect(white[1]).toBeCloseTo(1, 3);
      expect(xyzToLab(white)[0]).toBeCloseTo(100, 1);
    }
    expect(BUILTIN_PROFILES.map((p) => p.name)).toContain('Compatible RGB (1998 primaries)');
    // ROMM's blue primary sits far outside sRGB: converting it clips.
    const t = createTransform(builtinProfile('romm-rgb'), builtinProfile('srgb'));
    expect(t.one([0, 0, 1])[0]).toBe(0);
    // Gray Gamma 2.2: mid gray has Y = 0.5^2.2; the dot gain profile darkens 50% more.
    expect(toXYZ(builtinProfile('gray-gamma-22'), [0.5])[1]).toBeCloseTo(0.5 ** 2.2, 6);
    expect(toXYZ(builtinProfile('gray-dot-gain-20'), [0.5])[1]).toBeCloseTo(0.3, 3);
    // Rec. 2020 transfer: E' = 4.5 E in the toe.
    expect(toXYZ(builtinProfile('rec2020'), [0.045, 0.045, 0.045])[1]).toBeCloseTo(0.01, 6);
  });

  it('serializes v2 and v4 matrix/TRC profiles that parse back identically', () => {
    for (const key of ['srgb', 'display-p3', 'romm-rgb', 'compatible-rgb-1998', 'rec2020'] as const) {
      const p = builtinProfile(key);
      for (const version of [2, 4] as const) {
        const bytes = serializeIcc(p, { version });
        expect(String.fromCharCode(...bytes.subarray(36, 40))).toBe('acsp');
        expect(bytes[8]).toBe(version);
        expect(new DataView(bytes.buffer).getUint32(0)).toBe(bytes.length);
        const q = parseIcc(bytes);
        expect(q.name).toBe(p.name);
        q.matrix!.forEach((n, i) => expect(Math.abs(n - p.matrix![i])).toBeLessThan(2e-5));
        for (const v of [0, 0.02, 0.2, 0.5, 0.9, 1]) {
          const a = toXYZ(p, [v, v * 0.7, 1 - v]),
            b = toXYZ(q, [v, v * 0.7, 1 - v]);
          expect(deltaE2000(xyzToLab(a), xyzToLab(b))).toBeLessThan(0.02);
        }
      }
      // The pre-existing matrix/TRC reader accepts the v4 output too.
      expect(readRgbProfile(serializeIcc(p, { version: 4 })).matrix[0]).toBeCloseTo(p.matrix![0], 4);
    }
    const gray = parseIcc(serializeIcc(builtinProfile('gray-dot-gain-20')));
    expect(toXYZ(gray, [0.5])[1]).toBeCloseTo(0.3, 3);
  });

  it('reads damaged profile names without looping over bogus record counts', () => {
    // An embedded profile with a valid matrix/TRC but a description claiming
    // two billion records once froze the editor when the document was read.
    const bytes = serializeIcc(builtinProfile('srgb'), { version: 4 }).slice();
    const view = new DataView(bytes.buffer);
    let desc = -1;
    for (let i = 0; i < view.getUint32(128); i++)
      if (String.fromCharCode(...bytes.subarray(132 + i * 12, 136 + i * 12)) === 'desc') desc = view.getUint32(136 + i * 12);
    view.setUint32(desc + 8, 0x7fffffff);
    bytes.set([0x78, 0x78], desc + 16); // Not English, so every record is searched.
    expect(readRgbProfile(bytes).matrix).toHaveLength(9);
    const p = parseIcc(bytes);
    expect(p.colorSpace).toBe('RGB');
    expect(p.name).toBe(builtinProfile('srgb').name);
    // A record pointing past the tag or a length beyond it gives no name.
    view.setUint32(desc + 16 + 4, 0xfffffff0);
    expect(parseIcc(bytes).name).toBe('Untitled profile');
  });
});

describe('LUT-based profiles', { timeout: 120000 }, () => {
  // A smooth, nonlinear RGB -> Lab test function.
  const fn = (r: number, g: number, b: number): number[] => [
    100 * (0.2 * r + 0.7 * g + 0.1 * b) ** 0.8,
    60 * (r - g),
    40 * (g - b) * (1 - 0.3 * r),
  ];
  const makeClut = (grid: number[], outputs: number, f: (x: number[]) => ArrayLike<number>, precision: 1 | 2 = 2): Clut => {
    const n = grid.reduce((a, b) => a * b, 1);
    const data = new Float32Array(n * outputs);
    for (let i = 0; i < n; i++) {
      const idx: number[] = [];
      let rem = i;
      for (let d = grid.length - 1; d >= 0; d--) {
        idx[d] = (rem % grid[d]) / (grid[d] - 1);
        rem = Math.floor(rem / grid[d]);
      }
      const q = precision === 2 ? 65535 : 255;
      Array.from(f(idx)).forEach((v, k) => (data[i * outputs + k] = Math.round(v * q) / q));
    }
    return { grid, inputs: grid.length, outputs, data, precision };
  };
  const shell = (a2b0: Lut16Tag | LutABTag, version: number): Profile => ({
    name: 'Test LUT RGB',
    version,
    deviceClass: 'scnr',
    colorSpace: 'RGB',
    channels: 3,
    pcs: 'Lab',
    renderingIntent: 0,
    mediaWhite: [...D50],
    a2b: [a2b0, undefined, undefined],
    b2a: [undefined, undefined, undefined],
    key: `test:${Math.random()}`,
  });

  it('parses a lut16 profile it serialized and evaluates it like the original', () => {
    const clut = makeClut([9, 9, 9], 3, ([r, g, b]) => encodeLab(fn(r, g, b), 'legacy'));
    const tag: Lut16Tag = {
      type: 'lut16',
      inputs: 3,
      outputs: 3,
      matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      inCurves: [0, 1, 2].map(() => Float32Array.from({ length: 256 }, (_, i) => Math.round((i / 255) ** 0.9 * 65535) / 65535)),
      clut,
      outCurves: [0, 1, 2].map(() => Float32Array.from([0, 1])),
    };
    const p = shell(tag, 2.1);
    const q = parseIcc(serializeIcc(p, { version: 2 }));
    const t = q.a2b[0] as Lut16Tag;
    expect(t.type).toBe('lut16');
    expect(t.clut.grid).toEqual([9, 9, 9]);
    expect(Array.from(t.clut.data)).toEqual(Array.from(clut.data));
    expect(q.a2b[1]).toBeUndefined();
    for (let i = 0; i < 50; i++) {
      const rgb = [Math.random(), Math.random(), Math.random()];
      // Relative intent falls back to A2B0 (ICC tag precedence).
      const a = toXYZ(p, rgb),
        b = toXYZ(q, rgb, 'relative');
      expect(deltaE2000(xyzToLab(a), xyzToLab(b))).toBeLessThan(1e-3);
      // And the legacy Lab encoding decodes to the intended values on nodes.
    }
    // On grid nodes (input curves map 0 and 1 to themselves) the legacy
    // 16-bit Lab encoding decodes to the stored colors.
    for (const rgb of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 1]]) {
      const lab = xyzToLab(toXYZ(q, rgb));
      fn(rgb[0], rgb[1], rgb[2]).forEach((v, k) => expect(lab[k]).toBeCloseTo(v, 1));
    }
  });

  it('parses lutAtoB/lutBtoA with per-axis grids, 8- and 16-bit CLUTs, curves and matrix', () => {
    for (const precision of [1, 2] as const) {
      const curvesA = [
        { kind: 'parametric' as const, type: 0, parameters: [1.8] },
        { kind: 'parametric' as const, type: 3, parameters: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045] },
        { kind: 'table' as const, values: Array.from({ length: 64 }, (_, i) => (i / 63) ** 1.3) },
      ];
      const tag: LutABTag = {
        type: 'mAB',
        inputs: 3,
        outputs: 3,
        A: curvesA,
        clut: makeClut([5, 7, 9], 3, ([r, g, b]) => encodeLab(fn(r, g, b), 'v4'), precision),
        M: [id, { kind: 'parametric', type: 1, parameters: [1, 1, 0] }, id],
        matrix: [1, 0, 0, 0, 0.98, 0, 0, 0, 1, 0, 0.005, 0],
        B: [id, id, id],
      };
      const p = shell(tag, 4.3);
      const q = parseIcc(serializeIcc(p, { version: 4 }));
      const t = q.a2b[0] as LutABTag;
      expect(t.type).toBe('mAB');
      expect(t.clut!.grid).toEqual([5, 7, 9]);
      expect(t.clut!.precision).toBe(precision);
      expect(t.A!.map((c) => c.kind)).toEqual(['parametric', 'parametric', 'table']);
      for (let i = 0; i < 50; i++) {
        const rgb = [Math.random(), Math.random(), Math.random()];
        expect(deltaE2000(xyzToLab(toXYZ(p, rgb)), xyzToLab(toXYZ(q, rgb)))).toBeLessThan(0.02);
      }
    }
    // v2 cannot carry lutAtoB.
    const tag: LutABTag = { type: 'mAB', inputs: 3, outputs: 3, B: [id, id, id] };
    expect(() => serializeIcc(shell(tag, 2.1), { version: 2 })).toThrow();
  });

  it('handles v2 legacy vs v4 Lab PCS encodings and lut8 tags', () => {
    // The same Lab colors stored through lut16 (legacy) and mAB (v4) decode equally.
    const target = (r: number, g: number, b: number) => [20 + 70 * r, 50 * (g - 0.5), -30 * (b - 0.5)];
    const legacy: Lut16Tag = {
      type: 'lut16',
      inputs: 3,
      outputs: 3,
      matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      inCurves: [0, 1, 2].map(() => Float32Array.from([0, 1])),
      clut: makeClut([2, 2, 2], 3, ([r, g, b]) => encodeLab(target(r, g, b), 'legacy')),
      outCurves: [0, 1, 2].map(() => Float32Array.from([0, 1])),
    };
    const v4: LutABTag = { type: 'mAB', inputs: 3, outputs: 3, A: [id, id, id], clut: makeClut([2, 2, 2], 3, ([r, g, b]) => encodeLab(target(r, g, b), 'v4')), B: [id, id, id] };
    const lut8: Lut16Tag = {
      ...legacy,
      type: 'lut8',
      inCurves: [0, 1, 2].map(() => Float32Array.from({ length: 256 }, (_, i) => i / 255)),
      outCurves: [0, 1, 2].map(() => Float32Array.from({ length: 256 }, (_, i) => i / 255)),
      clut: makeClut([2, 2, 2], 3, ([r, g, b]) => encodeLab(target(r, g, b), 'v4'), 1),
    };
    for (const [tag, version, tol] of [[legacy, 2, 0.01], [v4, 4, 0.01], [lut8, 2, 0.6]] as const) {
      const q = parseIcc(serializeIcc(shell(tag, version + 0.1), { version }));
      for (const rgb of [[0, 0, 0], [1, 1, 1], [0.5, 0.25, 0.75]]) {
        const lab = xyzToLab(toXYZ(q, rgb));
        const want = target(rgb[0], rgb[1], rgb[2]);
        lab.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThan(tol));
      }
    }
  });

  it('interpolates CLUTs exactly at nodes and linearly along edges, for 1-5 inputs', () => {
    for (const inputs of [1, 2, 3, 4, 5]) {
      const grid = new Array(inputs).fill(3);
      const f = (x: number[]) => [x.reduce((a, v, i) => a + v * (i + 1), 0) / ((inputs * (inputs + 1)) / 2)];
      const ev = clutEvaluator(makeClut(grid, 1, f));
      const out = new Float64Array(1);
      for (let i = 0; i < 20; i++) {
        const x = Array.from({ length: inputs }, () => Math.random());
        ev(x, out);
        // Linear functions are reproduced exactly by tetrahedral/multilinear.
        expect(out[0]).toBeCloseTo(f(x)[0], 4);
      }
    }
  });
});

describe('intents, media white and black point compensation', { timeout: 120000 }, () => {
  const cmyk = builtinProfile('generic-coated-cmyk');
  const srgb = builtinProfile('srgb');

  it('falls back to A2B0/B2A0 and scales by media white for absolute colorimetric', () => {
    const toS = createTransform(cmyk, srgb, 'relative');
    expect(toS.one([0, 0, 0, 0])).toEqual([expect.closeTo(1, 2), expect.closeTo(1, 2), expect.closeTo(1, 2)]);
    // Absolute: the paper (L* 95, slightly blue) is no longer display white.
    const abs = createTransform(cmyk, builtinProfile('lab-d50'), 'absolute');
    const paper = decodeLab(abs.one([0, 0, 0, 0]), 'v4');
    expect(paper[0]).toBeCloseTo(95, 0);
    expect(paper[2]).toBeLessThan(-1);
  });

  it('detects black points and maps black to black with BPC', () => {
    expect(detectBlackPoint(srgb, 'relative')[1]).toBe(0);
    const bp = xyzToLab(detectBlackPoint(cmyk, 'relative'))[0];
    expect(bp).toBeGreaterThan(5);
    expect(bp).toBeLessThan(20);
    // Perceptual tables already stretch to the full range.
    expect(xyzToLab(detectBlackPoint(cmyk, 'perceptual'))[0]).toBeLessThan(4);
    const lab = builtinProfile('lab-d50');
    const plain = createTransform(cmyk, lab, 'relative');
    const comp = chainBpc(cmyk, srgb);
    // Without BPC rich black prints as the dark gray it is; with BPC it maps to black.
    // The darkest printable color: PCS black separated with relative colorimetry.
    const black = createTransform(lab, cmyk, 'relative').one([0, 0.5, 0.5]);
    expect(black.reduce((a, b) => a + b)).toBeLessThanOrEqual(3.0001);
    expect(decodeLab(plain.one(black), 'v4')[0]).toBeGreaterThan(8);
    expect(Math.max(...comp.one(black))).toBeLessThan(0.03);
    // White is preserved by BPC.
    comp.one([0, 0, 0, 0]).forEach((v) => expect(v).toBeCloseTo(1, 2));
    // Absolute ignores BPC.
    expect(createTransform(cmyk, srgb, 'absolute', { bpc: true }).bpc).toBe(false);
  });

  it('adapts XYZ PCS conversions through the Lab helpers consistently', () => {
    const xyz = labToXYZ([50, 10, -10]);
    expect(xyzToLab(xyz)[1]).toBeCloseTo(10, 9);
  });
});

function chainBpc(src: Profile, dst: Profile) {
  return createTransform(src, dst, 'relative', { bpc: true });
}
