// Provenance codecs: CBOR, JUMBF, X.509, COSE and C2PA manifest stores,
// round-tripped byte for byte and checked for tamper detection.
import { describe, expect, it } from 'vitest';
import { CborTag, decodeCbor, encodeCbor } from '../src/imaging/provenance/cbor';
import { contentBox, jumbfUuid, readJumbf, superbox, uuidFourcc, writeJumbf, type JumbfSuperbox } from '../src/imaging/provenance/jumbf';
import { createSelfSignedCertificate, derToRawSignature, parseCertificate, rawToDerSignature, verifyCertificateSignature } from '../src/imaging/provenance/x509';
import { signSign1, verifySign1 } from '../src/imaging/provenance/cose';
import { buildManifestStore, readManifestStore, recordActions } from '../src/imaging/provenance/c2pa';
import { createSigner } from '../src/imaging/provenance';
import { NOW, sampleRecord } from './provenance-fixtures';

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const toHex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
describe('CBOR (RFC 8949 Appendix A)', () => {
  const vectors: [unknown, string][] = [
    [0, '00'], [1, '01'], [10, '0a'], [23, '17'], [24, '1818'], [25, '1819'], [100, '1864'], [1000, '1903e8'],
    [1000000, '1a000f4240'], [1000000000000, '1b000000e8d4a51000'], [9007199254740991, '1b001fffffffffffff'],
    [-1, '20'], [-10, '29'], [-100, '3863'], [-1000, '3903e7'], [1.1, 'fb3ff199999999999a'],
    [false, 'f4'], [true, 'f5'], [null, 'f6'], [undefined, 'f7'],
    [new Uint8Array(0), '40'], [hexBytes('01020304'), '4401020304'],
    ['', '60'], ['a', '6161'], ['IETF', '6449455446'], ['"\\', '62225c'], ['ü', '62c3bc'], ['水', '63e6b0b4'],
    [[], '80'], [[1, 2, 3], '83010203'], [[1, [2, 3], [4, 5]], '8301820203820405'],
    [{}, 'a0'], [new Map([[1, 2], [3, 4]]), 'a201020304'], [{ a: 1, b: [2, 3] }, 'a26161016162820203'], [['a', { b: 'c' }], '826161a161626163'],
    [new CborTag(1, 1363896240), 'c11a514b67b0'], [new CborTag(23, hexBytes('01020304')), 'd74401020304'],
  ];
  it('encodes the specification examples byte for byte', () => {
    for (const [v, h] of vectors) expect(toHex(encodeCbor(v)), h).toBe(h);
  });
  it('decodes them back', () => {
    for (const [v, h] of vectors) expect(decodeCbor(hexBytes(h))).toEqual(v);
    // Half and single precision floats.
    expect(decodeCbor(hexBytes('f93c00'))).toBe(1);
    expect(decodeCbor(hexBytes('f97bff'))).toBe(65504);
    expect(decodeCbor(hexBytes('fa47c35000'))).toBe(100000);
    expect(decodeCbor(hexBytes('f90001'))).toBeCloseTo(5.960464477539063e-8);
  });
  it('keeps map order and integer keys', () => {
    const m = decodeCbor(encodeCbor(new Map<number | string, unknown>([[33, 'x'], [1, -7], ['k', true]])));
    expect(m).toBeInstanceOf(Map);
    expect([...(m as Map<unknown, unknown>).keys()]).toEqual([33, 1, 'k']);
    expect(Object.keys(decodeCbor(encodeCbor({ z: 1, a: 2 })) as object)).toEqual(['z', 'a']);
  });
  it('reports malformed data', () => {
    for (const h of ['', '18', '5f', '62c3', '9f', 'a1', '83010203ff', '7f', 'fc', '1c'])
      expect(() => decodeCbor(hexBytes(h)), h).toThrow();
    expect(() => decodeCbor(hexBytes('62c328'))).toThrow(/UTF-8/);
    // Deep nesting is refused instead of overflowing the stack.
    expect(() => decodeCbor(new Uint8Array(100).fill(0x81))).toThrow(/deeply/);
  });
});

describe('JUMBF', () => {
  const tree = (): JumbfSuperbox => superbox('c2pa', 'c2pa', [superbox('c2ma', 'urn:uuid:x', [superbox('json', 'j', [contentBox('json', new TextEncoder().encode('{"a":1}'))])]), contentBox('free', new Uint8Array(3))]);
  it('writes ISO 19566-5 boxes and reads them back byte for byte', () => {
    const bytes = writeJumbf(tree());
    // LBox, 'jumb', then the description box with the type UUID, toggles and label.
    expect(new DataView(bytes.buffer).getUint32(0)).toBe(bytes.length);
    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe('jumb');
    expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe('jumd');
    expect(toHex(bytes.subarray(16, 32))).toBe('63327061001100108000' + '00aa00389b71');
    expect(bytes[32]).toBe(0x03);
    const back = readJumbf(bytes);
    expect(writeJumbf(back)).toEqual(bytes);
    expect(back.label).toBe('c2pa');
    expect(uuidFourcc(back.uuid)).toBe('c2pa');
    const m = back.children[0] as JumbfSuperbox;
    expect(m.label).toBe('urn:uuid:x');
    expect(bytes.subarray(m.start!, m.end!)).toEqual(writeJumbf(m));
    expect(uuidFourcc(jumbfUuid('cbor'))).toBe('cbor');
  });
  it('keeps IDs and private description data', () => {
    const b: JumbfSuperbox = { kind: 'super', uuid: jumbfUuid('json'), toggles: 0x07, label: 'x', id: 42, extra: Uint8Array.of(1, 2), children: [] };
    const back = readJumbf(writeJumbf(b));
    expect(back.id).toBe(42);
    expect(back.extra).toEqual(Uint8Array.of(1, 2));
    expect(writeJumbf(back)).toEqual(writeJumbf(b));
  });
  it('rejects broken boxes', () => {
    const bytes = writeJumbf(tree());
    expect(() => readJumbf(bytes.subarray(0, 20))).toThrow();
    const bad = bytes.slice();
    bad[3] = 0xff;
    expect(() => readJumbf(bad)).toThrow();
    expect(() => readJumbf(new Uint8Array(0))).toThrow();
  });
});

describe('X.509 and COSE', () => {
  it('creates, parses and verifies a self-signed P-256 certificate', async () => {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const der = await createSelfSignedCertificate(keys, { commonName: 'Test Key', organization: 'Photo Studio (self-signed)', notBefore: NOW, notAfter: new Date('2061-01-02T03:04:05Z'), serial: Uint8Array.of(1, 2, 3) });
    const c = parseCertificate(der);
    expect(c.subject).toBe('O=Photo Studio (self-signed), CN=Test Key');
    expect(c.issuer).toBe(c.subject);
    expect(c.selfSigned).toBe(true);
    expect(c.notBefore).toBe('2026-01-02T03:04:05Z');
    // GeneralizedTime from 2050 on.
    expect(c.notAfter).toBe('2061-01-02T03:04:05Z');
    expect(c.signatureAlgorithm).toBe('1.2.840.10045.4.3.2');
    expect(new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))).toEqual(c.spki);
    expect(await verifyCertificateSignature(der)).toBe(true);
    const tampered = der.slice();
    tampered[der.indexOf(0x54)] ^= 1; // a byte of "Test" in the subject
    expect(await verifyCertificateSignature(tampered)).toBe(false);
  });
  it('converts ECDSA signatures between raw and DER form', () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80;
    raw[63] = 5;
    const der = rawToDerSignature(raw);
    expect(toHex(der.subarray(0, 4))).toBe('30260221');
    expect(derToRawSignature(der)).toEqual(raw);
  });
  it('signs and verifies a COSE_Sign1 with a detached payload', async () => {
    const signer = await createSigner('Cose Test', NOW);
    const payload = new TextEncoder().encode('claim bytes');
    const cose = await signSign1(payload, signer);
    const v = decodeCbor(cose) as CborTag;
    expect(v.tag).toBe(18);
    expect((v.value as unknown[])[2]).toBeNull();
    const ok = await verifySign1(cose, payload);
    expect(ok).toMatchObject({ valid: true, algorithm: 'ES256' });
    expect(ok.certificate).toEqual(signer.certificate);
    expect((await verifySign1(cose, new TextEncoder().encode('claim bytez'))).valid).toBe(false);
    const broken = cose.slice();
    broken[broken.length - 3] ^= 0xff;
    expect((await verifySign1(broken, payload)).valid).toBe(false);
    expect((await verifySign1(new Uint8Array([1, 2, 3]), payload)).valid).toBe(false);
  });
});

describe('C2PA manifest store', () => {
  const input = (r = sampleRecord()) => ({ record: r, title: 'Kite', format: 'png', manifestId: 'aaaaaaaa-0000-4000-8000-000000000001', instanceId: 'bbbbbbbb-0000-4000-8000-000000000002', generator: { name: 'Photo Studio', version: '1.0' }, now: NOW });
  it('maps the record to actions', () => {
    const actions = recordActions(sampleRecord(), 'Photo Studio');
    expect(actions.map((a) => a.action)).toEqual(['c2pa.opened', 'c2pa.placed', 'c2pa.edited', 'c2pa.edited', 'c2pa.edited']);
    expect(actions[2].parameters).toMatchObject({ description: 'Brush Tool', count: 2, 'photo-studio.tool': 'brush' });
    expect(actions[4].digitalSourceType).toBe('http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia');
    expect(actions[4].parameters).toMatchObject({ 'photo-studio.prompt': 'a red kite' });
  });
  it('builds a signed store that reads back byte for byte and verifies', async () => {
    const signer = await createSigner('Store Test', NOW);
    const store = await buildManifestStore(input(), signer, { start: 33, length: 500 }, new Uint8Array(32));
    expect(writeJumbf(readJumbf(store))).toEqual(store);
    const report = await readManifestStore(store);
    expect(report.errors).toEqual([]);
    expect(report.manifests).toHaveLength(1);
    const m = report.manifests[0];
    expect(m.errors).toEqual([]);
    expect(m.label).toBe('urn:uuid:aaaaaaaa-0000-4000-8000-000000000001');
    expect(report.active).toBe(m.label);
    expect(m).toMatchObject({ title: 'Kite', format: 'image/png', instanceId: 'urn:uuid:bbbbbbbb-0000-4000-8000-000000000002', claimGenerator: 'Photo_Studio/1.0', assertionHashesValid: true });
    expect(m.signature).toMatchObject({ valid: true, selfSigned: true, algorithm: 'ES256', subject: 'O=Photo Studio (self-signed), CN=Store Test' });
    expect(m.assertions).toEqual(['c2pa.actions', 'c2pa.ingredient', 'c2pa.ingredient__1', 'c2pa.hash.data', 'photo-studio.record']);
    expect(m.ingredients).toEqual([
      { title: 'beach.jpg', format: 'image/jpeg', relationship: 'parentOf', sha256: 'a'.repeat(64) },
      { title: 'logo.png', format: 'image/png', relationship: 'componentOf', sha256: 'b'.repeat(64) },
    ]);
    expect(m.actions[0]).toMatchObject({ action: 'c2pa.opened', softwareAgent: 'Photo Studio', when: NOW.toISOString() });
    expect(m.record).toEqual(sampleRecord());
  });
  it('detects a changed assertion and a changed claim', async () => {
    const signer = await createSigner('Store Test', NOW);
    const store = await buildManifestStore(input(), signer, { start: 33, length: 500 }, new Uint8Array(32));
    // Change a character of the JSON record assertion ("Brush" -> "Brusk").
    const at = toHex(store).indexOf(toHex(new TextEncoder().encode('"Brush Tool"'))) / 2;
    const changed = store.slice();
    changed[at + 5] = 'k'.charCodeAt(0);
    const m = (await readManifestStore(changed)).manifests[0];
    expect(m.assertionHashesValid).toBe(false);
    expect(m.signature.valid).toBe(true);
    expect(m.errors.join(' ')).toMatch(/photo-studio\.record was changed/);
    // Changing the title inside the claim breaks the signature.
    const t = toHex(store).indexOf(toHex(new TextEncoder().encode('Kite'))) / 2;
    const claimChanged = store.slice();
    claimChanged[t] = 'k'.charCodeAt(0);
    expect((await readManifestStore(claimChanged)).manifests[0].signature.valid).toBe(false);
  });
  it('reports unreadable stores instead of throwing', async () => {
    expect((await readManifestStore(new Uint8Array([0, 0, 0, 8, 1, 2, 3, 4]))).errors.length).toBeGreaterThan(0);
    const other = writeJumbf(superbox('json', 'x', []));
    expect((await readManifestStore(other)).errors[0]).toMatch(/not a C2PA/);
  });
});
