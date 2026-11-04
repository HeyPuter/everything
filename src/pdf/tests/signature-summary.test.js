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

it('says a certified PDF is certified', () => {
  const certified = { status: 'valid', certification: { level: 2 } };
  expect(signatureSummary([certified]).text).toBe('Certified, and the signature is valid.');
  expect(signatureSummary([{ ...certified, status: 'valid-unknown-identity' }]).text).toBe(
    'Certified. The signature is valid, but the signer’s identity is not trusted on this device.',
  );
  // A later approval signature does not make it any less certified.
  expect(signatureSummary([certified, { status: 'valid' }]).text).toBe(
    'Certified, and all 2 signatures are valid.',
  );
});
