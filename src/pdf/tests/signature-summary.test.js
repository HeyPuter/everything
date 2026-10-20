import { expect, it } from 'vitest';
import { signatureSummary } from '../src/signatures-panel.js';

it('words the signature bar for one valid signature and for several', () => {
  expect(signatureSummary([{ status: 'valid' }])).toEqual({
    tone: 'good',
    text: 'Signed, and the signature is valid.',
  });
  expect(signatureSummary([{ status: 'valid' }, { status: 'valid' }])).toEqual({
    tone: 'good',
    text: 'Signed, and all 2 signatures are valid.',
  });
  expect(signatureSummary([{ status: 'valid-unknown-identity' }]).text).toBe(
    'Signed. The signature is valid, but the signer’s identity is not trusted on this device.',
  );
});
