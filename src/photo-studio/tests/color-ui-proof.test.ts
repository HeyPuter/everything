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
});
