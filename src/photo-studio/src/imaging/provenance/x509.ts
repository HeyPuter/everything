// Minimal X.509 (RFC 5280) for self-signed ECDSA P-256 certificates: a DER
// writer for the few ASN.1 types a certificate needs, a reader for the
// fields shown to people (names, validity, public key) and the signature
// check. Signatures use ecdsa-with-SHA256 (RFC 5758); WebCrypto signs in the
// raw r||s form (IEEE P1363), which X.509 wraps in a DER Ecdsa-Sig-Value.
import { CodecError } from '../codecs/bytes';

const subtle = () => globalThis.crypto.subtle;
const ab = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

// ----- DER writer -----
function len(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255);
  return [0x80 | out.length, ...out];
}
export function tlv(tag: number, content: Uint8Array): Uint8Array {
  const h = [tag, ...len(content.length)];
  const out = new Uint8Array(h.length + content.length);
  out.set(h);
  out.set(content, h.length);
  return out;
}
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const seq = (...items: Uint8Array[]) => tlv(0x30, cat(...items));
const set = (...items: Uint8Array[]) => tlv(0x31, cat(...items));
const explicit = (n: number, inner: Uint8Array) => tlv(0xa0 | n, inner);
/** A non-negative INTEGER from big-endian magnitude bytes. */
function uint(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const b = bytes.subarray(i);
  return tlv(0x02, b[0] & 0x80 ? cat(Uint8Array.of(0), b) : b);
}
export function oid(dotted: string): Uint8Array {
  const n = dotted.split('.').map(Number);
  const out = [n[0] * 40 + n[1]];
  for (const v of n.slice(2)) {
    const b = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) b.unshift(0x80 | (x & 0x7f));
    out.push(...b);
  }
  return tlv(0x06, Uint8Array.from(out));
}
const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
function time(d: Date): Uint8Array {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  // UTCTime through 2049, GeneralizedTime after (RFC 5280 §4.1.2.5).
  return d.getUTCFullYear() < 2050 ? tlv(0x17, new TextEncoder().encode(iso.slice(2))) : tlv(0x18, new TextEncoder().encode(iso));
}

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2',
  cn: '2.5.4.3',
  o: '2.5.4.10',
  c: '2.5.4.6',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  basicConstraints: '2.5.29.19',
  subjectKeyId: '2.5.29.14',
  documentSigning: '1.3.6.1.5.5.7.3.36',
};

/** Raw r||s (64 bytes) to DER SEQUENCE { r INTEGER, s INTEGER }. */
export function rawToDerSignature(raw: Uint8Array): Uint8Array {
  const h = raw.length / 2;
  return seq(uint(raw.subarray(0, h)), uint(raw.subarray(h)));
}
/** DER Ecdsa-Sig-Value to raw r||s with `size`-byte halves. */
export function derToRawSignature(der: Uint8Array, size = 32): Uint8Array {
  const s = readTlv(der, 0);
  const [r, v] = children(der, s);
  const out = new Uint8Array(size * 2);
  for (const [i, x] of [r, v].entries()) {
    let b = der.subarray(x.start, x.end);
    while (b.length > size && b[0] === 0) b = b.subarray(1);
    if (b.length > size) throw new CodecError('ECDSA signature component is too long.');
    out.set(b, size * (i + 1) - b.length);
  }
  return out;
}

export type CertificateOptions = { commonName: string; organization?: string; notBefore: Date; notAfter: Date; serial?: Uint8Array };
/** A self-signed v3 certificate for an ECDSA P-256 key pair (DER). */
export async function createSelfSignedCertificate(keys: { privateKey: CryptoKey; publicKey: CryptoKey }, o: CertificateOptions): Promise<Uint8Array> {
  const spki = new Uint8Array(await subtle().exportKey('spki', keys.publicKey));
  const name = seq(...(o.organization ? [set(seq(oid(OID.o), utf8(o.organization)))] : []), set(seq(oid(OID.cn), utf8(o.commonName))));
  const serial = o.serial ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f; // positive, at most 20 octets (RFC 5280 §4.1.2.2)
  const keyId = new Uint8Array(await subtle().digest('SHA-256', ab(spki))).subarray(0, 20);
  const ext = (id: string, critical: boolean, value: Uint8Array) => seq(oid(id), ...(critical ? [tlv(0x01, Uint8Array.of(0xff))] : []), tlv(0x04, value));
  const extensions = seq(
    ext(OID.basicConstraints, true, seq()),
    // digitalSignature only: BIT STRING with 7 unused bits, value 0x80.
    ext(OID.keyUsage, true, tlv(0x03, Uint8Array.of(7, 0x80))),
    ext(OID.extKeyUsage, false, seq(oid(OID.documentSigning))),
    ext(OID.subjectKeyId, false, tlv(0x04, keyId)),
  );
  const alg = seq(oid(OID.ecdsaSha256));
  const tbs = seq(explicit(0, uint(Uint8Array.of(2))), uint(serial), alg, name, seq(time(o.notBefore), time(o.notAfter)), name, spki, explicit(3, extensions));
  const raw = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, ab(tbs)));
  return seq(tbs, alg, tlv(0x03, cat(Uint8Array.of(0), rawToDerSignature(raw))));
}

// ----- DER reader -----
type Tlv = { tag: number; start: number; end: number; hstart: number };
function readTlv(b: Uint8Array, p: number): Tlv {
  if (p + 2 > b.length) throw new CodecError('DER data is truncated.');
  const tag = b[p];
  let n = b[p + 1],
    q = p + 2;
  if (n & 0x80) {
    const k = n & 0x7f;
    if (k < 1 || k > 4 || q + k > b.length) throw new CodecError('Unsupported DER length.');
    n = 0;
    for (let i = 0; i < k; i++) n = n * 256 + b[q++];
  }
  if (q + n > b.length) throw new CodecError('DER data is truncated.');
  return { tag, start: q, end: q + n, hstart: p };
}
function children(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = t.start; p < t.end; ) {
    const c = readTlv(b, p);
    out.push(c);
    p = c.end;
  }
  return out;
}
function oidString(b: Uint8Array): string {
  const out = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (const x of b.subarray(1)) {
    v = v * 128 + (x & 0x7f);
    if (!(x & 0x80)) out.push(v), (v = 0);
  }
  return out.join('.');
}
const NAMES: Record<string, string> = { [OID.cn]: 'CN', [OID.o]: 'O', [OID.c]: 'C', '2.5.4.11': 'OU', '2.5.4.7': 'L', '2.5.4.8': 'ST', '1.2.840.113549.1.9.1': 'E' };
function nameString(b: Uint8Array, t: Tlv): string {
  const parts: string[] = [];
  for (const rdn of children(b, t))
    for (const atv of children(b, rdn)) {
      const [id, value] = children(b, atv);
      if (!id || !value) continue;
      const key = oidString(b.subarray(id.start, id.end));
      parts.push(`${NAMES[key] ?? key}=${new TextDecoder().decode(b.subarray(value.start, value.end))}`);
    }
  return parts.join(', ');
}
function timeString(b: Uint8Array, t: Tlv): string {
  const s = new TextDecoder().decode(b.subarray(t.start, t.end));
  const full = t.tag === 0x17 ? (Number(s.slice(0, 2)) >= 50 ? '19' : '20') + s : s;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(full);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : s;
}

export type CertificateInfo = {
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  // DER SubjectPublicKeyInfo, importable with WebCrypto ('spki').
  spki: Uint8Array;
  signatureAlgorithm: string;
  selfSigned: boolean;
  tbs: Uint8Array;
  signature: Uint8Array;
};
export function parseCertificate(der: Uint8Array): CertificateInfo {
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new CodecError('Not a DER certificate.');
  const [tbsT, algT, sigT] = children(der, cert);
  if (!tbsT || !algT || sigT?.tag !== 0x03) throw new CodecError('Malformed certificate.');
  let f = children(der, tbsT);
  if (f[0]?.tag === 0xa0) f = f.slice(1);
  const [, , issuer, validity, subject, spki] = f;
  if (!spki) throw new CodecError('Malformed certificate fields.');
  const [nb, na] = children(der, validity);
  const alg = children(der, algT)[0];
  const issuerBytes = der.subarray(issuer.hstart, issuer.end),
    subjectBytes = der.subarray(subject.hstart, subject.end);
  return {
    subject: nameString(der, subject),
    issuer: nameString(der, issuer),
    notBefore: timeString(der, nb),
    notAfter: timeString(der, na),
    spki: der.slice(spki.hstart, spki.end),
    signatureAlgorithm: oidString(der.subarray(alg.start, alg.end)),
    selfSigned: issuerBytes.length === subjectBytes.length && issuerBytes.every((v, i) => v === subjectBytes[i]),
    tbs: der.slice(tbsT.hstart, tbsT.end),
    // Skip the BIT STRING's unused-bits octet.
    signature: der.slice(sigT.start + 1, sigT.end),
  };
}

export const importPublicKey = (spki: Uint8Array) => subtle().importKey('spki', ab(spki), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);

/** Whether a self-signed certificate's signature verifies with its own key. */
export async function verifyCertificateSignature(der: Uint8Array): Promise<boolean> {
  try {
    const c = parseCertificate(der);
    if (c.signatureAlgorithm !== OID.ecdsaSha256) return false;
    const key = await importPublicKey(c.spki);
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, ab(derToRawSignature(c.signature)), ab(c.tbs));
  } catch {
    return false;
  }
}
