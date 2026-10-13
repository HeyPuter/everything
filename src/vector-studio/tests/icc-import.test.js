import { describe, it, expect } from 'vitest';
import { onePage, leaves, enc } from './interop-helpers.js';
import { pdfToDocument } from '../src/features/interop/pdf/import.js';
import { interpretEPS } from '../src/features/interop/ps/eps.js';
import { writeProfile, sampleClut, identityCurve } from '../src/features/icc/write.js';
import { rgbToPcsMatrix, srgbToPcs, pcsToSrgb, xyzToLab, labToXyz } from '../src/features/icc/math.js';
import { importTarget, dscIccProfile } from '../src/features/icc/import.js';

const FAMILIES = ['Inter'];
const open = (bytes) => pdfToDocument(bytes, { families: FAMILIES });

// Linear-light RGB with sRGB primaries: its 50% gray is sRGB #bcbcbc.
function linearRgb() {
  const M = rgbToPcsMatrix([[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], [0.3127, 0.329]);
  const col = (i) => ({ kind: 'XYZ', values: [[M[i], M[3 + i], M[6 + i]]] });
  const lin = { kind: 'curve', curve: { kind: 'identity' } };
  return writeProfile({ version: 2, deviceClass: 'mntr', colorSpace: 'RGB ', pcs: 'XYZ ', tags: [['desc', { kind: 'text', text: 'Linear' }], ['rXYZ', col(0)], ['gXYZ', col(1)], ['bXYZ', col(2)], ['rTRC', lin], ['gTRC', lin], ['bTRC', lin]] });
}

// A press whose inks are sRGB's complement with a black that only reaches 50%.
function weakBlackCmyk() {
  const L = 65535 / 65280;
  const AB = 65535 / 256;
  const encLab = (x) => { const l = xyzToLab(x); return [l[0] / 100 / L, (l[1] + 128) / AB, (l[2] + 128) / AB]; };
  const decLab = (v) => labToXyz([v[0] * L * 100, v[1] * AB - 128, v[2] * AB - 128]);
  const lut = (i, o, clut) => ({ kind: 'lut', bits: 16, inputs: i, outputs: o, inCurves: new Array(i).fill(identityCurve), clut, outCurves: new Array(o).fill(identityCurve) });
  const a2b = lut(4, 3, sampleClut(4, 3, 9, (v) => encLab(srgbToPcs([0, 1, 2].map((i) => (1 - v[i]) * (1 - v[3] * 0.5))))));
  const b2a = lut(3, 4, sampleClut(3, 4, 9, (v) => { const rgb = pcsToSrgb(decLab(v)); return [1 - rgb[0], 1 - rgb[1], 1 - rgb[2], 0]; }));
  return writeProfile({ version: 2, deviceClass: 'prtr', colorSpace: 'CMYK', pcs: 'Lab ', tags: [['desc', { kind: 'text', text: 'Weak Black' }], ['wtpt', { kind: 'XYZ', values: [[0.9642, 1, 0.8249]] }], ['A2B0', a2b], ['B2A0', b2a]] });
}

const fills = (doc) => leaves(doc).map((n) => n.fill?.color);
const epsLeaves = (r) => [...r.nodes.values()].filter((n) => n.type !== 'group' && n.type !== 'compound');

describe('PDF import through the color engine', () => {
  it('converts ICC-based colors with their embedded profile', async () => {
    const res = '<< /ColorSpace << /CS0 [/ICCBased 5 0 R] /CS1 [/ICCBased 6 0 R] >> >>';
    const doc = await open(onePage('/CS0 cs 0.5 0.5 0.5 sc 0 0 5 5 re f /CS1 cs 0 0 0 1 sc 10 0 5 5 re f /CS1 cs 0 0 0 0 sc 20 0 5 5 re f', {
      resources: res,
      extra: [{ dict: '<< /N 3 /Alternate /DeviceRGB >>', stream: linearRgb(), flate: true }, { dict: '<< /N 4 /Alternate /DeviceCMYK >>', stream: weakBlackCmyk() }],
    }));
    const [gray, black, white] = fills(doc);
    expect(gray).toBe('#bcbcbc');
    // K 100% of this press prints a mid gray, not black.
    const k = parseInt(black.slice(1, 3), 16);
    expect(k).toBeGreaterThan(0x70);
    expect(k).toBeLessThan(0x90);
    expect(white).toBe('#ffffff');
  });

  it('falls back to the alternate space for damaged profiles', async () => {
    const res = '<< /ColorSpace << /CS0 [/ICCBased 5 0 R] >> >>';
    const doc = await open(onePage('/CS0 cs 1 0 0 sc 0 0 5 5 re f', { resources: res, extra: [{ dict: '<< /N 3 /Alternate /DeviceRGB >>', stream: 'not a profile' }] }));
    expect(fills(doc)).toEqual(['#ff0000']);
  });

  it('characterizes device colors by Default color spaces and the output intent', async () => {
    const res = '<< /ColorSpace << /DefaultRGB [/ICCBased 5 0 R] >> >>';
    const doc = await open(onePage('0.5 0.5 0.5 rg 0 0 5 5 re f', { resources: res, extra: [{ dict: '<< /N 3 >>', stream: linearRgb() }] }));
    expect(fills(doc)).toEqual(['#bcbcbc']);
    const withIntent = await open(onePage('0 0 0 1 k 0 0 5 5 re f 0.5 0.5 0.5 rg 10 0 5 5 re f', {
      catalogExtra: '/OutputIntents [<< /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier (Custom) /DestOutputProfile 5 0 R >>]',
      extra: [{ dict: '<< /N 4 >>', stream: weakBlackCmyk() }],
    }));
    const [k, rgb] = fills(withIntent);
    expect(parseInt(k.slice(1, 3), 16)).toBeGreaterThan(0x70);
    // RGB numbers are not touched by a CMYK output intent.
    expect(rgb).toBe('#808080');
  });

  it('converts calibrated and Lab spaces through the engine', async () => {
    const res = '<< /ColorSpace << /C [/CalRGB << /WhitePoint [0.9505 1 1.089] /Gamma [1 1 1] /Matrix [0.4124 0.2126 0.0193 0.3576 0.7152 0.1192 0.1805 0.0722 0.9505] >>] /CG [/CalGray << /WhitePoint [0.9505 1 1.089] /Gamma 1 >>] /L [/Lab << /WhitePoint [0.9642 1 0.8249] >>] >> >>';
    const doc = await open(onePage('/C cs 0.5 0.5 0.5 sc 0 0 5 5 re f /CG cs 0.5 sc 10 0 5 5 re f /L cs 53.39 0 0 sc 20 0 5 5 re f', { resources: res }));
    const [cal, gray, lab] = fills(doc);
    expect(cal).toBe('#bcbcbc');
    expect(gray).toBe('#bcbcbc');
    expect(lab).toBe('#808080');
  });

  it('converts into the RGB working space', async () => {
    const prev = { ...importTarget };
    importTarget.rgb = 'mac18';
    try {
      const res = '<< /ColorSpace << /CS0 [/ICCBased 5 0 R] >> >>';
      const doc = await open(onePage('/CS0 cs 0.5 0.5 0.5 sc 0 0 5 5 re f', { resources: res, extra: [{ dict: '<< /N 3 >>', stream: linearRgb() }] }));
      // Linear 50% in gamma 1.8 numbers: 0.5^(1/1.8) = 0.68.
      expect(fills(doc)[0]).toBe('#aeaeae');
    } finally {
      Object.assign(importTarget, prev);
    }
  });
});

describe('EPS import through the color engine', () => {
  const hexLines = (bytes) => Buffer.from(bytes).toString('hex').match(/.{1,64}/g).map((l) => `%${l}`).join('\n');

  it('reads a profile from the DSC comments and applies it to device colors', () => {
    const prof = linearRgb();
    const ps = `%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 200 100\n%%BeginICCProfile: (Linear) -1 Hex\n${hexLines(prof)}\n%%EndICCProfile\n%%EndComments\n0.5 0.5 0.5 setrgbcolor 10 10 moveto 60 10 lineto 60 40 lineto closepath fill\n0 0 0 1 setcmykcolor 70 10 moveto 90 10 lineto 90 40 lineto closepath fill\n%%EOF\n`;
    expect(dscIccProfile(ps)?.length).toBe(prof.length);
    const r = interpretEPS(enc(ps), { families: FAMILIES });
    const [tri, cmyk] = epsLeaves(r);
    expect(tri.fill.color).toBe('#bcbcbc');
    // CMYK colors are not described by an RGB profile: they keep the working CMYK conversion.
    expect(cmyk.fill.color).toMatch(/^#[0-3]/);
  });
});
