import { describe, it, expect } from 'vitest';
import { parseProfile, ICCError } from '../src/features/icc/parse.js';
import { writeProfile, sampleClut, identityCurve } from '../src/features/icc/write.js';
import { modelFromProfile, createTransform, blackPoint, invertCurve, PERCEPTUAL_BLACK } from '../src/features/icc/transform.js';
import { D50, xyzToLab, labToXyz, srgbToPcs, pcsToSrgb, rgbToPcsMatrix, deltaE, inv3 } from '../src/features/icc/math.js';
import { profileModel, transformBetween, pressProfileBytes, pressModel, registerIccProfile, rgbProfileBytes, LAB_MODEL, calibratedModel } from '../src/features/icc/profiles.js';
import { RGB_SPACES } from '../src/features/prepress/color-management.js';

const near = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const lab = (xyz) => xyzToLab(xyz);

// ---- synthetic profiles ----

const SRGB_PARA = { kind: 'para', type: 3, params: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045] };
const SRGB_M = rgbToPcsMatrix([[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], [0.3127, 0.329]);
const col = (M, i) => ({ kind: 'XYZ', values: [[M[i], M[3 + i], M[6 + i]]] });
const text = (t) => ({ kind: 'text', text: t });

function matrixRgbProfile(version = 4) {
  return writeProfile({
    version,
    deviceClass: 'mntr',
    colorSpace: 'RGB ',
    pcs: 'XYZ ',
    tags: [['desc', text('Test sRGB')], ['wtpt', { kind: 'XYZ', values: [D50.slice()] }], ['rXYZ', col(SRGB_M, 0)], ['gXYZ', col(SRGB_M, 1)], ['bXYZ', col(SRGB_M, 2)], ['rTRC', { kind: 'curve', curve: SRGB_PARA }], ['gTRC', { kind: 'curve', curve: SRGB_PARA }], ['bTRC', { kind: 'curve', curve: SRGB_PARA }]],
  });
}

// A CMYK printer whose CMY inks are exactly sRGB's complement (K darkens), so the expected PCS values are known.
const cmykToXyz = (v) => srgbToPcs([0, 1, 2].map((i) => (1 - v[i]) * (1 - v[3])));
const xyzToCmy = (x) => {
  const rgb = pcsToSrgb(x);
  return [1 - rgb[0], 1 - rgb[1], 1 - rgb[2], 0];
};
const L16 = 65535 / 65280;
const AB16 = 65535 / 256;
const legacyLab = {
  enc: (x) => { const l = xyzToLab(x); return [l[0] / 100 / L16, (l[1] + 128) / AB16, (l[2] + 128) / AB16]; },
  dec: (v) => labToXyz([v[0] * L16 * 100, v[1] * AB16 - 128, v[2] * AB16 - 128]),
};
const v4Lab = {
  enc: (x) => { const l = xyzToLab(x); return [l[0] / 100, (l[1] + 128) / 255, (l[2] + 128) / 255]; },
  dec: (v) => labToXyz([v[0] * 100, v[1] * 255 - 128, v[2] * 255 - 128]),
};
const lutTag = (bits, inputs, outputs, clut) => ({ kind: 'lut', bits, inputs, outputs, matrix: null, inCurves: new Array(inputs).fill(identityCurve), clut, outCurves: new Array(outputs).fill(identityCurve) });

function cmykLutProfile({ bits = 16, a2bGrid = 9, b2aGrid = 17, wtpt = D50.slice(), darker = false } = {}) {
  const codec = bits === 16 ? legacyLab : v4Lab;
  const a2b = (scale) => lutTag(bits, 4, 3, sampleClut(4, 3, a2bGrid, (v) => codec.enc(cmykToXyz(v).map((x) => x * scale))));
  const tags = [
    ['desc', text(`Test CMYK lut${bits}`)],
    ['wtpt', { kind: 'XYZ', values: [wtpt] }],
    ['A2B0', a2b(1)],
    ['B2A0', lutTag(bits, 3, 4, sampleClut(3, 4, b2aGrid, (v) => xyzToCmy(codec.dec(v))))],
  ];
  if (darker) tags.push(['A2B1', a2b(0.5)]);
  return writeProfile({ version: 2, deviceClass: 'prtr', colorSpace: 'CMYK', pcs: 'Lab ', tags });
}

describe('ICC reading and writing', () => {
  it('reads the header, descriptions and curves of a v4 matrix profile', () => {
    const p = parseProfile(matrixRgbProfile(4));
    expect(p.version.major).toBe(4);
    expect(p).toMatchObject({ deviceClass: 'mntr', colorSpace: 'RGB ', pcs: 'XYZ ', channels: 3, description: 'Test sRGB' });
    expect(near(p.illuminant, [0.9642, 1, 0.8249], 1e-4)).toBe(true);
    const trc = p.tags.get('rTRC').curve;
    expect(trc.kind).toBe('para');
    expect(trc.eval(0.5)).toBeCloseTo(0.214041, 5);
    // The three curves are identical, so they share one copy in the file.
    const raw = new DataView(p.bytes.buffer, p.bytes.byteOffset);
    const offsets = [];
    for (let i = 0; i < raw.getUint32(128); i++) offsets.push(raw.getUint32(132 + i * 12 + 4));
    expect(new Set(offsets).size).toBe(offsets.length - 2);
  });

  it('reads v2 descriptions, gamma curves and lut16 tables', () => {
    const p = parseProfile(cmykLutProfile());
    expect(p.description).toBe('Test CMYK lut16');
    expect(p.tags.get('A2B0')).toMatchObject({ kind: 'lut', bits: 16, inputs: 4, outputs: 3 });
    expect(p.tags.get('A2B0').clut.grid).toEqual([9, 9, 9, 9]);
    const gray = parseProfile(writeProfile({ version: 2, deviceClass: 'mntr', colorSpace: 'GRAY', tags: [['desc', text('G')], ['kTRC', { kind: 'curve', curve: { kind: 'gamma', gamma: 2.2 } }]] }));
    expect(gray.tags.get('kTRC').curve.gamma).toBeCloseTo(2.2, 2);
  });

  it('rejects data that is not a profile', () => {
    expect(() => parseProfile(new Uint8Array(64))).toThrow(ICCError);
    const junk = new Uint8Array(400);
    expect(() => parseProfile(junk)).toThrow(/not an ICC/);
    const bytes = matrixRgbProfile();
    bytes[16] = 0x51; // unknown color space
    expect(() => parseProfile(bytes)).toThrow(ICCError);
  });

  it('inverts table curves', () => {
    const t = new Float64Array(64).map((_, i) => (i / 63) ** 1.8);
    const inv = invertCurve({ kind: 'table', table: t, eval: (v) => v ** 1.8 });
    for (const v of [0.05, 0.3, 0.8]) expect(inv(v ** 1.8)).toBeCloseTo(v, 2);
  });
});

describe('matrix and curve profiles', () => {
  it('converts sRGB primaries to the published XYZ and Lab (D50) values', () => {
    for (const m of [modelFromProfile(parseProfile(matrixRgbProfile(4))), profileModel('srgb')]) {
      const to = m.toPcs('relative');
      expect(near(to([1, 0, 0]), [0.4361, 0.2225, 0.0139], 1e-3)).toBe(true);
      expect(near(to([0, 1, 0]), [0.3851, 0.7169, 0.0971], 1e-3)).toBe(true);
      expect(near(to([0, 0, 1]), [0.1431, 0.0606, 0.7141], 1e-3)).toBe(true);
      expect(near(to([1, 1, 1]), D50, 1e-3)).toBe(true);
      expect(near(lab(to([1, 0, 0])), [54.29, 80.81, 69.89], 0.05)).toBe(true);
      expect(near(lab(to([0, 1, 0])), [87.82, -79.29, 80.99], 0.05)).toBe(true);
      expect(near(lab(to([0, 0, 1])), [29.57, 68.3, -112.03], 0.05)).toBe(true);
      expect(lab(to([0.5, 0.5, 0.5]))[0]).toBeCloseTo(53.39, 1);
    }
  });

  it('round-trips through the inverse curves and matrix', () => {
    const m = profileModel('p3');
    const to = m.toPcs('relative');
    const from = m.fromPcs('relative');
    for (const c of [[0.2, 0.5, 0.9], [1, 0, 0.3], [0.01, 0.02, 0.03]]) expect(near(from(to(c)), c, 2e-3)).toBe(true);
  });

  it('matches the built-in RGB space conversions', () => {
    const t = transformBetween('p3', 'srgb');
    // P3 red is outside sRGB and clips; a muted color converts exactly.
    expect(t.convert([1, 0, 0])[0]).toBeCloseTo(1, 4);
    const m = transformBetween('mac18', 'srgb').convert([0.5, 0.5, 0.5]);
    const expected = RGB_SPACES.srgb.trc.encode(RGB_SPACES.mac18.trc.decode(0.5));
    expect(m[1]).toBeCloseTo(expected, 3);
  });

  it('reads gray profiles with an XYZ or Lab connection space', () => {
    const g = modelFromProfile(parseProfile(writeProfile({ version: 2, deviceClass: 'mntr', colorSpace: 'GRAY', tags: [['desc', text('G')], ['kTRC', { kind: 'curve', curve: { kind: 'gamma', gamma: 2.2 } }]] })));
    expect(g.toPcs('relative')([0.5])[1]).toBeCloseTo(0.5 ** 2.2, 3);
    expect(g.fromPcs('relative')([0.2, 0.2176, 0.18])[0]).toBeCloseTo(0.5, 2);
    const gl = modelFromProfile(parseProfile(writeProfile({ version: 4, deviceClass: 'mntr', colorSpace: 'GRAY', pcs: 'Lab ', tags: [['desc', text('L')], ['kTRC', { kind: 'curve', curve: { kind: 'identity' } }]] })));
    expect(lab(gl.toPcs('relative')([0.5]))[0]).toBeCloseTo(50, 3);
    const t = createTransform(profileModel('srgb'), g);
    expect(t.convert([1, 1, 1])[0]).toBeCloseTo(1, 3);
  });
});

describe('LUT profiles', () => {
  const samples = [[0, 0, 0, 0], [1, 0, 0, 0], [0.3, 0.6, 0.1, 0.2], [0.5, 0.5, 0.5, 0], [0.12, 0.88, 0.5, 0.4]];

  for (const bits of [16, 8]) {
    it(`evaluates lut${bits} CMYK -> Lab and Lab -> CMYK tables`, () => {
      const m = modelFromProfile(parseProfile(cmykLutProfile({ bits })));
      const to = m.toPcs('relative');
      for (const c of samples) expect(deltaE(lab(to(c)), lab(cmykToXyz(c)))).toBeLessThan(bits === 16 ? 2.5 : 3.5);
      // At grid nodes the table is exact (up to the encoding precision).
      expect(deltaE(lab(to([0.5, 0.5, 0.5, 0.5])), lab(cmykToXyz([0.5, 0.5, 0.5, 0.5])))).toBeLessThan(bits === 16 ? 0.05 : 0.8);
      const from = m.fromPcs('relative');
      for (const rgb of [[0.8, 0.2, 0.3], [0.5, 0.5, 0.5], [0.1, 0.9, 0.6]]) {
        const cmyk = from(srgbToPcs(rgb));
        expect(near(cmyk, [1 - rgb[0], 1 - rgb[1], 1 - rgb[2], 0], bits === 16 ? 0.02 : 0.03)).toBe(true);
      }
    });
  }

  it('evaluates v4 lutAtoB and lutBtoA tables with curves, a matrix and offsets', () => {
    // RGB -> XYZ through M curves and a matrix (no CLUT), as a v4 matrix profile in table form.
    const scale = 32768 / 65535;
    const M = SRGB_M.map((v) => v * scale);
    const Mi = inv3(M);
    const half = 0.01;
    const curves = (c) => new Array(3).fill(c);
    const mAB = { kind: 'mAB', inputs: 3, outputs: 3, A: curves(identityCurve), M: curves(SRGB_PARA), matrix: { m: M, offset: [half, half, half] }, B: curves({ kind: 'table', table: Float64Array.from({ length: 1024 }, (_, i) => Math.max(0, i / 1023 - half)) }) };
    const mBA = { kind: 'mBA', inputs: 3, outputs: 3, B: curves(identityCurve), matrix: { m: Mi, offset: [0, 0, 0] }, M: curves({ kind: 'para', type: 0, params: [1 / 2.2] }), A: curves({ kind: 'para', type: 0, params: [2.2] }) };
    const bytes = writeProfile({ version: 4, deviceClass: 'mntr', colorSpace: 'RGB ', pcs: 'XYZ ', tags: [['desc', text('Table RGB')], ['A2B0', mAB], ['B2A0', mBA]] });
    const p = parseProfile(bytes);
    expect(p.tags.get('A2B0')).toMatchObject({ kind: 'mAB', inputs: 3, outputs: 3 });
    expect(p.tags.get('A2B0').matrix.offset[0]).toBeCloseTo(half, 4);
    const m = modelFromProfile(p);
    const to = m.toPcs('relative');
    const ref = profileModel('srgb').toPcs('relative');
    for (const c of [[1, 0, 0], [0.2, 0.7, 0.4], [1, 1, 1]]) expect(near(to(c), ref(c), 2e-3)).toBe(true);
    // M (gamma 1/2.2) then A (gamma 2.2) cancel: the inverse is linear light from the matrix.
    const from = m.fromPcs('relative');
    const lin = from(ref([0.6, 0.6, 0.6]));
    expect(lin[0]).toBeCloseTo(RGB_SPACES.srgb.trc.decode(0.6), 2);
  });

  it('evaluates a v4 lutAtoB with a CLUT and the v4 Lab encoding', () => {
    const clut = sampleClut(4, 3, 9, (v) => v4Lab.enc(cmykToXyz(v)));
    const mAB = { kind: 'mAB', inputs: 4, outputs: 3, A: new Array(4).fill(identityCurve), clut, B: new Array(3).fill(identityCurve) };
    const mBA = { kind: 'mBA', inputs: 3, outputs: 4, B: new Array(3).fill(identityCurve), clut: sampleClut(3, 4, 17, (v) => xyzToCmy(v4Lab.dec(v))), A: new Array(4).fill(identityCurve) };
    const m = modelFromProfile(parseProfile(writeProfile({ version: 4, deviceClass: 'prtr', colorSpace: 'CMYK', pcs: 'Lab ', tags: [['desc', text('v4 CMYK')], ['wtpt', { kind: 'XYZ', values: [D50.slice()] }], ['A2B0', mAB], ['B2A0', mBA]] })));
    const to = m.toPcs('relative');
    for (const c of samples) expect(deltaE(lab(to(c)), lab(cmykToXyz(c)))).toBeLessThan(2.5);
    expect(near(m.fromPcs('relative')(srgbToPcs([0.25, 0.5, 0.75])), [0.75, 0.5, 0.25, 0], 0.02)).toBe(true);
    // v4 perceptual tables share a fixed black point.
    expect(blackPoint(m, 'perceptual')).toEqual(PERCEPTUAL_BLACK.slice());
  });
});

describe('rendering intents and black point compensation', () => {
  it('uses the tag of each intent and falls back to the perceptual one', () => {
    const m = modelFromProfile(parseProfile(cmykLutProfile({ darker: true })));
    const c = [0, 0, 0, 0];
    expect(m.toPcs('perceptual')(c)[1]).toBeCloseTo(1, 2);
    expect(m.toPcs('relative')(c)[1]).toBeCloseTo(0.5, 2);
    expect(m.toPcs('saturation')(c)[1]).toBeCloseTo(1, 2);
  });

  it('shows the paper with absolute colorimetric', () => {
    const paper = [0.88, 0.92, 0.7];
    const printer = modelFromProfile(parseProfile(cmykLutProfile({ wtpt: paper })));
    const srgb = profileModel('srgb');
    const rel = createTransform(printer, srgb, { intent: 'relative' }).convert([0, 0, 0, 0]);
    const abs = createTransform(printer, srgb, { intent: 'absolute' }).convert([0, 0, 0, 0]);
    expect(near(rel, [1, 1, 1], 0.01)).toBe(true);
    expect(near(abs, pcsToSrgb(paper), 0.02)).toBe(true);
    expect(abs[2]).toBeLessThan(abs[0]);
  });

  it('maps black to black with black point compensation', () => {
    const press = pressModel('newsprint');
    const srgb = profileModel('srgb');
    const bp = blackPoint(press, 'relative');
    expect(bp[1]).toBeGreaterThan(0.004);
    expect(blackPoint(srgb, 'relative')[1]).toBeCloseTo(0, 4);
    const off = createTransform(press, srgb, { intent: 'relative', bpc: false });
    const on = createTransform(press, srgb, { intent: 'relative', bpc: true });
    const black = press.fromPcs('relative')([0, 0, 0]);
    expect(off.convert(black)[1]).toBeGreaterThan(0.05);
    expect(on.convert(black)[1]).toBeLessThan(0.02);
    // White is untouched.
    expect(near(on.convert([0, 0, 0, 0]), [1, 1, 1], 0.01)).toBe(true);
    // Without compensation, shadows darker than the press black clip together; with it they stay apart.
    const toPress = (bpc) => createTransform(srgb, press, { intent: 'relative', bpc });
    const y = (t, v) => press.toPcs('relative')(t.convert([v, v, v]))[1];
    expect(Math.abs(y(toPress(false), 0.02) - y(toPress(false), 0.08))).toBeLessThan(0.003);
    expect(y(toPress(true), 0.08) - y(toPress(true), 0.02)).toBeGreaterThan(0.004);
  });

  it('chooses perceptual tables that map black for press models', () => {
    const t = transformBetween('srgb', 'coatedWeb', { intent: 'perceptual' });
    const black = t.convert([0, 0, 0]);
    expect(black[3]).toBeGreaterThan(0.85);
    expect(black.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3.005);
  });
});

describe('baked tables and generated profiles', () => {
  it('bakes three- and four-input tables close to the exact transform', () => {
    const t = transformBetween('srgb', 'p3');
    const lut = t.lut();
    expect(lut.n).toBe(33);
    for (const c of [[0.13, 0.57, 0.91], [0.5, 0.5, 0.5], [0.99, 0.01, 0.4]]) expect(near(Array.from(lut.eval(c)), t.convert(c), 1 / 255)).toBe(true);
    const back = transformBetween('coatedWeb', 'srgb', { intent: 'relative', bpc: true });
    const lut4 = back.lut();
    expect(lut4.nIn).toBe(4);
    for (const c of [[0.1, 0.2, 0.3, 0.4], [0.9, 0.05, 0.6, 0], [0.5, 0.5, 0.5, 0.5]]) expect(near(Array.from(lut4.eval(c)), back.convert(c), 0.02)).toBe(true);
    // Separations into a press model use a coarser grid (the inversion is costly).
    expect(transformBetween('srgb', 'coatedWeb').lut().n).toBe(17);
  });

  it('generates parseable ICC profiles for the RGB working spaces', () => {
    for (const version of [2, 4]) {
      const bytes = rgbProfileBytes({ name: 'Display P3', primaries: RGB_SPACES.p3.primaries, white: RGB_SPACES.p3.white, curve: SRGB_PARA, version });
      const p = parseProfile(bytes);
      expect(p.version.major).toBe(version);
      expect(p.description).toBe('Display P3');
      const to = modelFromProfile(p).toPcs('relative');
      expect(near(to([1, 1, 1]), D50, 2e-3)).toBe(true);
    }
  });

  it('exports press models as equivalent ICC output profiles', () => {
    const bytes = pressProfileBytes('coatedWeb', { a2bGrid: 7, b2aGrid: 9 });
    const p = parseProfile(bytes);
    expect(p).toMatchObject({ deviceClass: 'prtr', colorSpace: 'CMYK', pcs: 'Lab ' });
    for (const tag of ['A2B0', 'A2B1', 'A2B2', 'B2A0', 'B2A1', 'B2A2', 'gamt', 'wtpt']) expect(p.tags.has(tag)).toBe(true);
    const icc = modelFromProfile(p);
    const press = pressModel('coatedWeb');
    for (const c of [[0, 0, 0, 0], [1, 0, 0, 0], [0.4, 0.3, 0.2, 0.1], [0, 0, 0, 1]]) {
      expect(deltaE(lab(icc.toPcs('relative')(c)), lab(press.toPcs('relative')(c)))).toBeLessThan(2);
    }
    // Paper is the media white.
    expect(near(p.whitePoint, press.mediaWhite, 1e-3)).toBe(true);
    // The same data registers once under a stable id.
    const a = registerIccProfile(bytes, { source: 'embedded' });
    const b = registerIccProfile(bytes.slice(), { source: 'user' });
    expect(a.id).toBe(b.id);
    expect(b.source).toBe('user');
    expect(a.kind).toBe('CMYK');
  });

  it('models Lab and calibrated spaces', () => {
    const t = createTransform(LAB_MODEL, profileModel('srgb'));
    expect(near(t.convert([1, 128 / 255, 128 / 255]), [1, 1, 1], 0.01)).toBe(true);
    const cal = calibratedModel({ white: [0.9505, 1, 1.089], gamma: [2.2, 2.2, 2.2], matrix: [0.4124, 0.2126, 0.0193, 0.3576, 0.7152, 0.1192, 0.1805, 0.0722, 0.9505] });
    const out = createTransform(cal, profileModel('srgb')).convert([1, 0, 0]);
    expect(out[0]).toBeGreaterThan(0.99);
    expect(out[1]).toBeLessThan(0.02);
  });
});
