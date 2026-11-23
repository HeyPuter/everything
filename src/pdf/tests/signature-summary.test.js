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

it('names as many untrusted identities as there are among several signatures', () => {
  const unknown = { status: 'valid-unknown-identity' };
  expect(signatureSummary([unknown, unknown]).text).toBe(
    'Signed. All 2 signatures are valid, but the signers’ identities are not trusted on this device.',
  );
  expect(signatureSummary([{ status: 'valid' }, unknown, { status: 'valid' }]).text).toBe(
    'Signed. All 3 signatures are valid, but one signer’s identity is not trusted on this device.',
  );
  expect(signatureSummary([unknown, { status: 'valid' }, unknown]).text).toBe(
    'Signed. All 3 signatures are valid, but 2 signers’ identities are not trusted on this device.',
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

it('says a PDF with only a document timestamp is timestamped, not signed', () => {
  const timestamp = { status: 'valid', kind: 'timestamp' };
  expect(signatureSummary([timestamp]).text).toBe('Timestamped, and the timestamp is valid.');
  expect(signatureSummary([{ status: 'valid', kind: 'approval' }, timestamp]).text).toBe(
    'Signed, and all 2 signatures are valid.',
  );
});
