import { describe, expect, it } from 'vitest';
import { builtinProfile } from '../src/color/builtin-profiles';
import { buildCmyk, CmykModel, GENERIC_COATED, GENERIC_UNCOATED } from '../src/color/cmyk-model';
import { decodeLab, encodeLab } from '../src/color/color-math';
import { deltaE2000 } from '../src/color/delta-e';
import { parseIcc, type Lut16Tag } from '../src/color/icc-lut';
import { serializeIcc } from '../src/color/icc-write';
import { createTransform } from '../src/color/transform';

// Deterministic pseudo-random numbers for reproducible samples.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const stats = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return { mean: v.reduce((a, b) => a + b, 0) / v.length, p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
};

describe('analytic CMYK printing model', () => {
  it('produces plausible coated colors, dot gain and gray balance', () => {
    const m = new CmykModel(GENERIC_COATED);
    const lab = (c: number, mm: number, y: number, k: number) => Array.from(m.labOf(c, mm, y, k));
    expect(lab(0, 0, 0, 0)).toEqual([expect.closeTo(100, 6), expect.closeTo(0, 6), expect.closeTo(0, 6)]);
    const [cL, ca, cb] = lab(1, 0, 0, 0);
    expect(cL).toBeGreaterThan(50);
    expect(ca).toBeLessThan(-25);
    expect(cb).toBeLessThan(-40);
    expect(lab(0, 1, 0, 0)[1]).toBeGreaterThan(60);
    expect(lab(0, 0, 1, 0)[2]).toBeGreaterThan(80);
    // Overprints are darker than either ink; 400% stays above pure black.
    expect(lab(1, 1, 0, 0)[0]).toBeLessThan(Math.min(lab(1, 0, 0, 0)[0], lab(0, 1, 0, 0)[0]));
    expect(lab(1, 1, 1, 1)[0]).toBeGreaterThan(3);
    // Tone value increase on black at 50% (densitometric, from Y).
    const Y = (k: number) => m.xyzOf(0, 0, 0, k)[1];
    const tvi = (1 - Y(0.5)) / (1 - Y(1)) - 0.5;
    expect(tvi).toBeGreaterThan(0.1);
    expect(tvi).toBeLessThan(0.25);
    // Neutral mid gray needs more cyan than magenta and yellow, as on press.
    const x = new Float64Array([0.3, 0.3, 0.3, 0]);
    expect(m.separate([50, 0, 0], x)).toBeLessThan(0.01);
    expect(x[0]).toBeGreaterThan(x[1] + 0.05);
    expect(x[0]).toBeGreaterThan(x[2] + 0.05);
  });

  it('matches its analytic Jacobian to finite differences', () => {
    const m = new CmykModel(GENERIC_UNCOATED);
    const J = new Float64Array(12),
      lab = new Float64Array(3);
    const r = rng(3);
    for (let n = 0; n < 20; n++) {
      const x = [r(), r(), r(), r()].map((v) => 0.05 + 0.9 * v);
      m.labJacobian(x, lab, J);
      for (let v = 0; v < 4; v++) {
        const xp = [...x];
        xp[v] += 1e-6;
        const l2 = m.labOf(xp[0], xp[1], xp[2], xp[3]);
        for (let row = 0; row < 3; row++) expect(J[row * 4 + v]).toBeCloseTo((l2[row] - lab[row]) / 1e-6, 2);
      }
    }
  });
});

describe('generated CMYK output profiles', { timeout: 120000 }, () => {
  const coated = builtinProfile('generic-coated-cmyk');
  const lab = builtinProfile('lab-d50');

  it('builds quickly and inverts within gamut (Lab -> CMYK -> Lab)', () => {
    const t0 = performance.now();
    buildCmyk({ ...GENERIC_COATED, name: 'timing copy' });
    const ms = performance.now() - t0;
    console.log(`CMYK profile build: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(15000);
    const toLab = createTransform(coated, lab, 'relative'),
      toCmyk = createTransform(lab, coated, 'relative');
    const r = rng(7);
    const errs: number[] = [];
    for (let i = 0; i < 2000; i++) {
      let cmyk = [r(), r(), r(), r()];
      const sum = cmyk.reduce((a, b) => a + b);
      if (sum > 3) cmyk = cmyk.map((v) => (v * 3) / sum);
      const target = toLab.one(cmyk);
      const back = toLab.one(toCmyk.one(target));
      errs.push(deltaE2000(decodeLab(target, 'v4'), decodeLab(back, 'v4')));
    }
    const s = stats(errs);
    console.log(`coated round trip ΔE00 mean ${s.mean.toFixed(3)} p95 ${s.p95.toFixed(3)} max ${s.max.toFixed(3)}`);
    expect(s.mean).toBeLessThan(1);
    expect(s.p95).toBeLessThan(2);
  });

  it('separates neutrals darker than the press black as a neutral black (relative, no compensation)', () => {
    for (const p of [coated, builtinProfile('generic-uncoated-cmyk')]) {
      const toLab = createTransform(p, lab, 'relative'),
        toCmyk = createTransform(lab, p, 'relative');
      for (const L of [0, 4, 8]) {
        const ink = toCmyk.one(encodeLab([L, 0, 0], 'v4'));
        const [, a, b] = decodeLab(toLab.one(ink), 'v4');
        // Least squares used to trade neutrality for a slightly darker
        // blue-violet (C100 M100 Y0 K100 on coated, b* -5 on uncoated).
        expect(Math.hypot(a, b)).toBeLessThan(1);
        expect(ink[2]).toBeGreaterThan(0.3);
      }
    }
  });

  it('reports progress and can be cancelled while building', () => {
    const seen: number[] = [];
    let calls = 0;
    expect(() =>
      buildCmyk({ ...GENERIC_COATED, name: 'cancel me', b2aGrid: 9 }, 'cancel-test', {
        report: (f) => seen.push(f),
        cancelled: () => ++calls > 5,
      }),
    ).toThrow(/cancelled/);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1]))).toBe(true);
  });

  it('respects the total ink limit for every intent', () => {
    for (const [p, limit] of [
      [coated, 3],
      [builtinProfile('generic-uncoated-cmyk'), 2.6],
    ] as const) {
      for (const intent of ['perceptual', 'relative', 'saturation'] as const) {
        const t = createTransform(lab, p, intent);
        let worst = 0;
        for (let L = 0; L <= 100; L += 5)
          for (let a = -120; a <= 120; a += 15)
            for (let b = -120; b <= 120; b += 15) {
              const cmyk = t.one(encodeLab([L, a, b], 'v4'));
              worst = Math.max(worst, cmyk.reduce((x, y) => x + y));
            }
        expect(worst).toBeLessThanOrEqual(limit + 1e-3);
        expect(worst).toBeGreaterThan(limit - 0.15);
      }
      // From sRGB with BPC, black uses the full limit.
      const black = createTransform(builtinProfile('srgb'), p, 'relative', { bpc: true }).one([0, 0, 0]);
      expect(black.reduce((x, y) => x + y)).toBeCloseTo(limit, 1);
    }
  });

  it('uses more black ink with heavier black generation, none uses no black', () => {
    const levels = ['none', 'light', 'medium', 'heavy', 'maximum'] as const;
    const kOf = levels.map((bg) => {
      const p = buildCmyk({ ...GENERIC_COATED, name: `bg ${bg}`, blackGeneration: bg, b2aGrid: 25 }).profile;
      const t = createTransform(lab, p, 'relative');
      const toLab = createTransform(p, lab, 'relative');
      let k = 0,
        worst = 0;
      for (const L of [40, 55, 70])
        for (const [a, b] of [[0, 0], [20, 10], [-15, 25], [10, -15]]) {
          const target = encodeLab([L, a, b], 'v4');
          const cmyk = t.one(target);
          k += cmyk[3];
          worst = Math.max(worst, deltaE2000([L, a, b], decodeLab(toLab.one(cmyk), 'v4')));
        }
      // Same colors regardless of black generation.
      expect(worst, bg).toBeLessThan(2.5);
      return k;
    });
    expect(kOf[0]).toBe(0);
    for (let i = 1; i < levels.length; i++) expect(kOf[i]).toBeGreaterThan(kOf[i - 1]);
  });

  it('serializes to a real lut16 ICC binary that parses back to the same transform', () => {
    const bytes = serializeIcc(coated);
    const view = new DataView(bytes.buffer);
    const sig = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
    expect(sig(12)).toBe('prtr');
    expect(sig(16)).toBe('CMYK');
    expect(sig(20)).toBe('Lab ');
    expect(bytes[8]).toBe(2);
    expect(view.getUint32(0)).toBe(bytes.length);
    const tags = Array.from({ length: view.getUint32(128) }, (_, i) => sig(132 + i * 12));
    for (const t of ['desc', 'cprt', 'wtpt', 'A2B0', 'A2B1', 'A2B2', 'B2A0', 'B2A1', 'B2A2', 'gamt']) expect(tags).toContain(t);
    // Shared tables are stored once (A2B2 shares A2B0's payload).
    const offset = (name: string) => view.getUint32(132 + tags.indexOf(name) * 12 + 4);
    expect(offset('A2B2')).toBe(offset('A2B0'));
    expect(bytes.length).toBeLessThan(2_000_000);
    const q = parseIcc(bytes);
    expect(q.name).toBe('Generic Coated CMYK (Photo Studio)');
    expect(q.copyright).toMatch(/not a certified/);
    const b2a = q.b2a[1] as Lut16Tag;
    expect(b2a.type).toBe('lut16');
    expect(Array.from(b2a.clut.data)).toEqual(Array.from((coated.b2a[1] as Lut16Tag).clut.data));
    q.mediaWhite.forEach((v, i) => expect(v).toBeCloseTo(coated.mediaWhite[i], 4));
    const a = createTransform(builtinProfile('srgb'), coated, 'perceptual', { bpc: true });
    const b = createTransform(builtinProfile('srgb'), q, 'perceptual', { bpc: true });
    const r = rng(11);
    for (let i = 0; i < 100; i++) {
      const rgb = [r(), r(), r()];
      a.one(rgb).forEach((v, c) => expect(b.one(rgb)[c]).toBeCloseTo(v, 4));
    }
    // The gamut tag flags saturated sRGB blue but not mid gray.
    const gamut = createTransform(lab, { ...q, b2a: [q.gamut, q.gamut, q.gamut], channels: 1, key: 'gamut-test' }, 'relative');
    expect(gamut.one(encodeLab([30, 68, -112], 'v4'))[0]).toBeGreaterThan(0.2);
    expect(gamut.one(encodeLab([50, 0, 0], 'v4'))[0]).toBeLessThan(0.02);
  });
});
