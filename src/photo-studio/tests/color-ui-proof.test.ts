import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentSession } from '../src/app/session';
import { colorSettings, defaultSettings, saveColorSettings } from '../src/features/color/profiles';
import { plateSetup, proofState, setProof } from '../src/features/color/proof';
import type { Editor } from '../src/editor';

describe('proof setup', () => {
  afterEach(() => saveColorSettings({ ...defaultSettings }));

  it('Working CMYK and the working plates follow later Color Settings changes', async () => {
    const session = {} as DocumentSession;
    expect(proofState(session).setup.ref).toBe(colorSettings().cmyk);
    // Opening a document creates its proof state; the working CMYK profile,
    // intent and compensation chosen afterwards must be what the proof shows.
    saveColorSettings({ ...colorSettings(), cmyk: 'builtin:generic-uncoated-cmyk', intent: 'perceptual', bpc: false });
    expect(proofState(session).setup).toMatchObject({ kind: 'cmyk', ref: 'builtin:generic-uncoated-cmyk', intent: 'perceptual', bpc: false });
    const e = { session, update() {}, message() {} } as unknown as Editor;
    await setProof(e, plateSetup('k'), false);
    saveColorSettings({ ...colorSettings(), cmyk: 'builtin:generic-coated-cmyk' });
    expect(proofState(session).setup).toMatchObject({ kind: 'plate', plate: 'k', ref: 'builtin:generic-coated-cmyk' });
    // A custom proof condition keeps its own profile.
    await setProof(e, { kind: 'custom', ref: 'builtin:generic-uncoated-cmyk', intent: 'relative', bpc: true, paper: false, ink: false }, false);
    saveColorSettings({ ...colorSettings(), cmyk: 'builtin:generic-coated-cmyk' });
    expect(proofState(session).setup.ref).toBe('builtin:generic-uncoated-cmyk');
  });

  it('proofing a CMYK document on its own press shows it as it is, whatever the intent', async () => {
    const { displayLut, workingCmykSetup } = await import('../src/features/color/proof');
    const { cmykMap } = await import('../src/features/color/convert');
    const { builtinProfile, sampleLut3D } = await import('../src/color/color-management');
    const { newDocument } = await import('../src/model/document');
    saveColorSettings({ ...defaultSettings, intent: 'perceptual' });
    const srgb = builtinProfile('srgb'),
      cmyk = builtinProfile('generic-coated-cmyk');
    const doc = { ...newDocument(4, 4), mode: 'cmyk' as const, modeData: { profile: 'builtin:generic-coated-cmyk' } };
    const src = new Uint8ClampedArray(64 * 4);
    for (let p = 0; p < 64; p++) src.set([(p * 37) % 256, (p * 59) % 256, (p * 83) % 256, 255], p * 4);
    // The document's pixels: Image > Mode > CMYK Color with Perceptual.
    const px = cmykMap(srgb, cmyk, 'perceptual', true)({ width: 64, height: 1, data: src }).data;
    const shown = (setup: ReturnType<typeof workingCmykSetup>) => {
      const lut = displayLut(doc, { setup, on: true, gamut: false })!;
      let total = 0;
      const out = [0, 0, 0, 0];
      for (let p = 0; p < 64; p++) {
        sampleLut3D(lut, px[p * 4] / 255, px[p * 4 + 1] / 255, px[p * 4 + 2] / 255, out);
        for (let c = 0; c < 3; c++) total += Math.abs(out[c] * 255 - px[p * 4 + c]);
      }
      return total / (64 * 3);
    };
    // Proof Colors (Working CMYK) used to compress the printable colors again.
    expect(shown(workingCmykSetup())).toBeLessThan(2);
    // The working plates are the document's own plates too.
    const cmy = displayLut(doc, { setup: { ...workingCmykSetup(), kind: 'plate', plate: 'k' }, on: true, gamut: false })!;
    const out = [0, 0, 0, 0];
    sampleLut3D(cmy, 0.5, 0.5, 0.5, out);
    const relative = displayLut(doc, { setup: { ...workingCmykSetup(), kind: 'plate', plate: 'k', intent: 'relative' }, on: true, gamut: false })!;
    const ref = [0, 0, 0, 0];
    sampleLut3D(relative, 0.5, 0.5, 0.5, ref);
    expect(out[0]).toBeCloseTo(ref[0], 3);
  });
});
