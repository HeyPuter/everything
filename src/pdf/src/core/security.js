/**
 * The PDF standard security handler: open password-protected PDFs (RC4 40/128-bit, AES-128,
 * AES-256) and protect PDFs with AES-256 (revision 6) passwords and permissions.
 *
 * pdf-lib parses encrypted files but never decrypts them, so unlocking runs its parser with a
 * hook that decrypts every string and stream as it is read, defers object streams until the
 * file key is known, and then saves an ordinary unencrypted document. Protecting works the
 * other way round: a loaded document has its strings and streams encrypted in place before an
 * ordinary save writes them with the new /Encrypt dictionary.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectStreamParser,
  PDFParser,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFXRefStreamParser,
  ParseSpeeds,
} from 'pdf-lib';

import { pdfVersion, savePdf } from './version.js';
import { withoutCryptFilter } from './stream-filters.js';

export class PasswordError extends Error {
  constructor(message = 'Incorrect password.') {
    super(message);
    this.code = 'password';
  }
}

/* ---------- Byte helpers ---------- */
const EMPTY = new Uint8Array(0);
const ZERO_IV = new Uint8Array(16);
const bytesOf = (part) => (part instanceof Uint8Array ? part : Uint8Array.from(part));
export function concat(...parts) {
  const chunks = parts.map(bytesOf);
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
const equal = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
function randomBytes(length) {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
const utf8 = (text) => new TextEncoder().encode(text);
/**
 * Whether this page can hash passwords at all. The Web Crypto API belongs to secure contexts,
 * so a page served over plain http can neither protect a PDF nor open one that uses AES-256.
 */
export const passwordsSupported = () => !!globalThis.crypto?.subtle;
/**
 * SHA through the Web Crypto API, which browsers expose in secure contexts alone. A page
 * served over plain http therefore cannot handle the passwords of revision 5 and 6 files
 * (AES-256); it says so rather than failing on a missing property.
 */
async function sha(bits, data) {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new Error('Passwords need a secure connection. Open this page over https.');
  return new Uint8Array(await api.digest(`SHA-${bits}`, data));
}

/* ---------- MD5 ---------- */
const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = new Int32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);
export function md5(bytes) {
  const length = bytes.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (length << 3) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(length / 0x20000000), true);
  let a0 = 0x67452301,
    b0 = 0xefcdab89 | 0,
    c0 = 0x98badcfe | 0,
    d0 = 0x10325476;
  const words = new Int32Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4, true);
    let a = a0,
      b = b0,
      c = c0,
      d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      f = (f + a + MD5_K[i] + words[g]) | 0;
      a = d;
      d = c;
      c = b;
      const s = MD5_SHIFTS[((i >> 4) << 2) | (i & 3)];
      b = (b + ((f << s) | (f >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, a0, true);
  outView.setInt32(4, b0, true);
  outView.setInt32(8, c0, true);
  outView.setInt32(12, d0, true);
  return out;
}

/* ---------- RC4 ---------- */
export function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

/* ---------- AES (128 and 256-bit keys, CBC) ---------- */
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const xtime = (x) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
function gmul(a, b) {
  let product = 0;
  for (; b; b >>= 1) {
    if (b & 1) product ^= a;
    a = xtime(a);
  }
  return product;
}
const MUL = Object.fromEntries(
  [2, 3, 9, 11, 13, 14].map((factor) => [
    factor,
    Uint8Array.from({ length: 256 }, (_, i) => gmul(i, factor)),
  ]),
);
{
  // Generate the S-box from the multiplicative inverse and the affine transform.
  const rotl8 = (x, shift) => ((x << shift) | (x >> (8 - shift))) & 0xff;
  let p = 1,
    q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    SBOX[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
}
function expandKey(key) {
  if (key.length !== 16 && key.length !== 32) throw new Error('AES keys must be 16 or 32 bytes.');
  const nk = key.length / 4;
  const rounds = nk + 6;
  const w = new Uint8Array(16 * (rounds + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (rounds + 1); i++) {
    let t0 = w[(i - 1) * 4],
      t1 = w[(i - 1) * 4 + 1],
      t2 = w[(i - 1) * 4 + 2],
      t3 = w[(i - 1) * 4 + 3];
    if (i % nk === 0) {
      [t0, t1, t2, t3] = [SBOX[t1] ^ rcon, SBOX[t2], SBOX[t3], SBOX[t0]];
      rcon = xtime(rcon);
    } else if (nk > 6 && i % nk === 4) {
      [t0, t1, t2, t3] = [SBOX[t0], SBOX[t1], SBOX[t2], SBOX[t3]];
    }
    w[i * 4] = w[(i - nk) * 4] ^ t0;
    w[i * 4 + 1] = w[(i - nk) * 4 + 1] ^ t1;
    w[i * 4 + 2] = w[(i - nk) * 4 + 2] ^ t2;
    w[i * 4 + 3] = w[(i - nk) * 4 + 3] ^ t3;
  }
  return { w, rounds };
}
/** Encrypt one block in place: `state` holds the input and receives the output. */
function encryptBlock({ w, rounds }, state, temp) {
  for (let i = 0; i < 16; i++) state[i] ^= w[i];
  for (let round = 1; round <= rounds; round++) {
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) temp[r + 4 * c] = SBOX[state[r + 4 * ((c + r) & 3)]];
    if (round < rounds) {
      for (let c = 0; c < 4; c++) {
        const a0 = temp[4 * c],
          a1 = temp[4 * c + 1],
          a2 = temp[4 * c + 2],
          a3 = temp[4 * c + 3];
        state[4 * c] = MUL[2][a0] ^ MUL[3][a1] ^ a2 ^ a3;
        state[4 * c + 1] = a0 ^ MUL[2][a1] ^ MUL[3][a2] ^ a3;
        state[4 * c + 2] = a0 ^ a1 ^ MUL[2][a2] ^ MUL[3][a3];
        state[4 * c + 3] = MUL[3][a0] ^ a1 ^ a2 ^ MUL[2][a3];
      }
    } else state.set(temp);
    const base = round * 16;
    for (let i = 0; i < 16; i++) state[i] ^= w[base + i];
  }
}
function decryptBlock({ w, rounds }, state, temp) {
  for (let i = 0; i < 16; i++) state[i] ^= w[rounds * 16 + i];
  for (let round = rounds - 1; round >= 0; round--) {
    const base = round * 16;
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++)
        temp[r + 4 * c] = INV_SBOX[state[r + 4 * ((c - r) & 3)]] ^ w[base + r + 4 * c];
    if (round > 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = temp[4 * c],
          a1 = temp[4 * c + 1],
          a2 = temp[4 * c + 2],
          a3 = temp[4 * c + 3];
        state[4 * c] = MUL[14][a0] ^ MUL[11][a1] ^ MUL[13][a2] ^ MUL[9][a3];
        state[4 * c + 1] = MUL[9][a0] ^ MUL[14][a1] ^ MUL[11][a2] ^ MUL[13][a3];
        state[4 * c + 2] = MUL[13][a0] ^ MUL[9][a1] ^ MUL[14][a2] ^ MUL[11][a3];
        state[4 * c + 3] = MUL[11][a0] ^ MUL[13][a1] ^ MUL[9][a2] ^ MUL[14][a3];
      }
    } else state.set(temp);
  }
}
/** AES-CBC without padding: `data` must be a whole number of blocks. */
export function aesCbcEncrypt(key, iv, data) {
  if (data.length % 16) throw new Error('AES-CBC input must be a multiple of 16 bytes.');
  const schedule = expandKey(key);
  const out = new Uint8Array(data.length);
  const state = new Uint8Array(16);
  const temp = new Uint8Array(16);
  let previous = iv;
  for (let offset = 0; offset < data.length; offset += 16) {
    for (let i = 0; i < 16; i++) state[i] = data[offset + i] ^ previous[i];
    encryptBlock(schedule, state, temp);
    out.set(state, offset);
    previous = out.subarray(offset, offset + 16);
  }
  return out;
}
/** AES-CBC without padding; trailing bytes short of a block are dropped as PDF.js does. */
export function aesCbcDecrypt(key, iv, data) {
  const schedule = expandKey(key);
  const blocks = Math.floor(data.length / 16);
  const out = new Uint8Array(blocks * 16);
  const state = new Uint8Array(16);
  const temp = new Uint8Array(16);
  for (let block = 0; block < blocks; block++) {
    const offset = block * 16;
    state.set(data.subarray(offset, offset + 16));
    decryptBlock(schedule, state, temp);
    const previous = block ? data.subarray(offset - 16, offset) : iv;
    for (let i = 0; i < 16; i++) out[offset + i] = state[i] ^ previous[i];
  }
  return out;
}
/** PDF strings and streams: a random IV followed by PKCS#5-padded AES-CBC ciphertext. */
function aesEncryptData(key, data) {
  const pad = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + pad);
  padded.set(data);
  padded.fill(pad, data.length);
  const iv = randomBytes(16);
  return concat(iv, aesCbcEncrypt(key, iv, padded));
}
function aesDecryptData(key, data) {
  if (data.length < 32) return EMPTY;
  const plain = aesCbcDecrypt(key, data.subarray(0, 16), data.subarray(16));
  const pad = plain[plain.length - 1];
  // Some writers pad badly; keep the data rather than fail on the padding byte.
  return pad >= 1 && pad <= 16 && pad <= plain.length
    ? plain.subarray(0, plain.length - pad)
    : plain;
}

/* ---------- Standard security handler ---------- */
const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
const int32le = (n) =>
  Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
/** Passwords before revision 5 are Latin-1 bytes padded to 32 with the standard pad string. */
const legacyPassword = (password) =>
  concat(Uint8Array.from(Array.from(password, (ch) => ch.charCodeAt(0) & 0xff)), PAD).subarray(
    0,
    32,
  );
// SASLprep (RFC 4013) as revision 6 prescribes and PDF.js applies it: other spaces become
// spaces, and characters that are commonly mapped to nothing are dropped, before NFKC.
const NON_ASCII_SPACES = new Set([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x200b, 0x202f, 0x205f, 0x3000,
]);
const MAPPED_TO_NOTHING = new Set([
  0x00ad, 0x034f, 0x1806, 0x180b, 0x180c, 0x180d, 0x200b, 0x200c, 0x200d, 0x2060, 0xfe00, 0xfe01,
  0xfe02, 0xfe03, 0xfe04, 0xfe05, 0xfe06, 0xfe07, 0xfe08, 0xfe09, 0xfe0a, 0xfe0b, 0xfe0c, 0xfe0d,
  0xfe0e, 0xfe0f, 0xfeff,
]);
function saslPrep(password) {
  let mapped = '';
  for (const char of password) {
    const code = char.codePointAt(0);
    if (NON_ASCII_SPACES.has(code)) mapped += ' ';
    else if (!MAPPED_TO_NOTHING.has(code)) mapped += char;
  }
  return mapped.normalize('NFKC');
}
const modernPassword = (password) => utf8(saslPrep(password)).subarray(0, 127);

/** Whether new AES-256 protection treats two typed passwords as the same password. */
export const sameEncryptionPassword = (first, second) =>
  equal(modernPassword(first), modernPassword(second));

/** Algorithm 2: the file key from a padded user password. */
function legacyFileKey(padded, security) {
  const { O, P, id, R, keyLength, encryptMetadata } = security;
  let input = concat(padded, O.subarray(0, 32), int32le(P), id);
  if (R >= 4 && !encryptMetadata) input = concat(input, [0xff, 0xff, 0xff, 0xff]);
  let hash = md5(input);
  const n = R === 2 ? 5 : keyLength;
  if (R >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, n));
  return hash.subarray(0, n);
}
/** Algorithms 4 and 5: does this file key belong to the user password? */
function legacyUserKeyMatches(key, security) {
  const { U, R, id } = security;
  if (R === 2) return equal(rc4(key, PAD), U.subarray(0, 32));
  let value = rc4(key, md5(concat(PAD, id)));
  for (let i = 1; i <= 19; i++)
    value = rc4(
      key.map((byte) => byte ^ i),
      value,
    );
  return equal(value, U.subarray(0, 16));
}
/** Algorithm 7: recover the padded user password from an owner password. */
function legacyUserFromOwner(paddedOwner, security) {
  const { O, R, keyLength } = security;
  let hash = md5(paddedOwner);
  const n = R === 2 ? 5 : keyLength;
  // Algorithm 3 step d: each of the 50 rounds hashes only the first n bytes of the previous
  // digest, which matters for the 40-bit keys some revision 3 writers still produce.
  if (R >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, n));
  const key = hash.subarray(0, n);
  if (R === 2) return rc4(key, O.subarray(0, 32));
  let value = O.subarray(0, 32);
  for (let i = 19; i >= 0; i--)
    value = rc4(
      key.map((byte) => byte ^ i),
      value,
    );
  return value;
}
/** The password a padded legacy password was made from: its bytes before the pad string. */
function unpaddedPassword(padded) {
  let length = 0;
  while (length < 32 && !equal(padded.subarray(length), PAD.subarray(0, 32 - length))) length++;
  return String.fromCharCode(...padded.subarray(0, length));
}

/** Algorithm 2.B (revision 6) or plain SHA-256 (revision 5). */
async function hashPassword(password, salt, userData, R) {
  let k = await sha(256, concat(password, salt, userData));
  if (R === 5) return k;
  for (let round = 0; ;) {
    const k1 = new Uint8Array((password.length + k.length + userData.length) * 64);
    const unit = concat(password, k, userData);
    for (let i = 0; i < 64; i++) k1.set(unit, i * unit.length);
    const e = aesCbcEncrypt(k.subarray(0, 16), k.subarray(16, 32), k1);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    k = await sha(sum % 3 === 0 ? 256 : sum % 3 === 1 ? 384 : 512, e);
    round++;
    if (round >= 64 && e[e.length - 1] <= round - 32) break;
  }
  return k.subarray(0, 32);
}

function readSecurity(dict, id) {
  const name = (key) => {
    const value = dict.lookup(PDFName.of(key));
    return value instanceof PDFName ? value.decodeText() : undefined;
  };
  const number = (key, fallback) => {
    const value = dict.lookup(PDFName.of(key));
    return value instanceof PDFNumber ? value.asNumber() : fallback;
  };
  const string = (key) => {
    const value = dict.lookup(PDFName.of(key));
    return value instanceof PDFString || value instanceof PDFHexString ? value.asBytes() : EMPTY;
  };
  if (name('Filter') !== 'Standard')
    throw new Error('This PDF uses a security handler this app cannot open.');
  const V = number('V', 0);
  const R = number('R', V >= 4 ? 4 : V >= 2 ? 3 : 2);
  if (R < 2 || R > 6) throw new Error('This PDF uses a security handler this app cannot open.');
  if (R === 6) {
    const P = number('P', NaN);
    const metadata = dict.lookup(PDFName.of('EncryptMetadata'));
    if (
      !Number.isInteger(P) ||
      P < -2147483648 ||
      P > 2147483647 ||
      (metadata !== undefined && !(metadata instanceof PDFBool))
    )
      throw new Error('This PDF contains invalid encrypted permissions data.');
  }
  let keyLength = V === 1 ? 5 : Math.max(5, Math.min(16, Math.round(number('Length', 40) / 8)));
  let streamMethod = 'V2';
  let stringMethod = 'V2';
  if (V >= 4) {
    const filters = dict.lookup(PDFName.of('CF'));
    const method = (key) => {
      const filterName = dict.lookup(PDFName.of(key));
      if (!(filterName instanceof PDFName) || filterName === PDFName.of('Identity')) return 'None';
      const filter = filters instanceof PDFDict ? filters.lookup(filterName) : undefined;
      const cfm = filter instanceof PDFDict ? filter.lookup(PDFName.of('CFM')) : undefined;
      const length = filter instanceof PDFDict ? filter.lookup(PDFName.of('Length')) : undefined;
      if (length instanceof PDFNumber && !dict.has(PDFName.of('Length'))) {
        const raw = length.asNumber();
        keyLength = raw > 40 ? raw / 8 : raw;
      }
      return cfm instanceof PDFName ? cfm.decodeText() : 'None';
    };
    streamMethod = method('StmF');
    stringMethod = method('StrF');
  }
  for (const method of [streamMethod, stringMethod])
    if (!['None', 'V2', 'AESV2', 'AESV3'].includes(method))
      throw new Error('This PDF uses an encryption method this app cannot open.');
  if (streamMethod === 'AESV2' || stringMethod === 'AESV2') keyLength = 16;
  if (R >= 5) keyLength = 32;
  return {
    V,
    R,
    keyLength,
    streamMethod,
    stringMethod,
    O: string('O'),
    U: string('U'),
    OE: string('OE'),
    UE: string('UE'),
    Perms: string('Perms'),
    P: number('P', -1) | 0,
    id,
    encryptMetadata: dict.lookup(PDFName.of('EncryptMetadata')) !== PDFBool.False,
  };
}

/** Revision-6 Algorithm 13: the authenticated key must also validate the permission data. */
function validatePermissions(security, fileKey) {
  if (security.R !== 6) return;
  const invalid = () => new Error('This PDF contains invalid encrypted permissions data.');
  if (fileKey.length !== 32 || security.Perms.length !== 16) throw invalid();
  // A single CBC block with a zero IV is exactly the ECB block specified by Algorithm 13.
  const plain = aesCbcDecrypt(fileKey, ZERO_IV, security.Perms);
  if (
    !equal(plain.subarray(0, 4), int32le(security.P)) ||
    !plain.subarray(4, 8).every((byte) => byte === 0xff) ||
    plain[8] !== (security.encryptMetadata ? 0x54 : 0x46) ||
    !equal(plain.subarray(9, 12), [0x61, 0x64, 0x62])
  )
    throw invalid();
}

/** The file key and authenticated role. Owner authentication takes precedence over user. */
async function authenticate(security, password) {
  const { R, U, O, UE, OE } = security;
  const accepted = (fileKey, owner) => {
    validatePermissions(security, fileKey);
    return { fileKey, owner };
  };
  if (R >= 5) {
    if (U.length < 48 || O.length < 48) throw new PasswordError();
    // Some writers hash the typed bytes instead of the prescribed normalized password, and
    // this app once hashed it after NFKC alone.
    const forms = [];
    for (const form of [
      modernPassword(password),
      utf8(password.normalize('NFKC')).subarray(0, 127),
      utf8(password).subarray(0, 127),
    ])
      if (!forms.some((other) => equal(other, form))) forms.push(form);
    const userData = U.subarray(0, 48);
    for (const owner of [true, false]) {
      const entry = owner ? O : U;
      const data = owner ? userData : EMPTY;
      for (const pw of forms) {
        if (!equal(await hashPassword(pw, entry.subarray(32, 40), data, R), entry.subarray(0, 32)))
          continue;
        const intermediate = await hashPassword(pw, entry.subarray(40, 48), data, R);
        return accepted(
          aesCbcDecrypt(intermediate, ZERO_IV, (owner ? OE : UE).subarray(0, 32)),
          owner,
        );
      }
    }
    throw new PasswordError();
  }
  const padded = legacyPassword(password);
  const user = legacyUserFromOwner(padded, security);
  let key = legacyFileKey(user, security);
  if (legacyUserKeyMatches(key, security))
    return { ...accepted(key, true), userPassword: unpaddedPassword(user) };
  key = legacyFileKey(padded, security);
  if (legacyUserKeyMatches(key, security)) return accepted(key, false);
  throw new PasswordError();
}

/** Algorithm 1: the per-object key for RC4 and AES-128. */
function objectKey(fileKey, ref, aes) {
  const { objectNumber: num, generationNumber: gen } = ref;
  const salt = aes ? [0x73, 0x41, 0x6c, 0x54] : [];
  const input = concat(
    fileKey,
    [num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff],
    salt,
  );
  return md5(input).subarray(0, Math.min(fileKey.length + 5, 16));
}
function decryptorFor(method, fileKey) {
  if (method === 'None') return (data) => data;
  if (method === 'AESV3') return (data) => aesDecryptData(fileKey, data);
  if (method === 'AESV2') return (data, ref) => aesDecryptData(objectKey(fileKey, ref, true), data);
  return (data, ref) => rc4(objectKey(fileKey, ref, false), data);
}
function encryptorFor(method, fileKey) {
  if (method === 'None') return (data) => data;
  if (method === 'AESV3') return (data) => aesEncryptData(fileKey, data);
  if (method === 'AESV2') return (data, ref) => aesEncryptData(objectKey(fileKey, ref, true), data);
  return (data, ref) => rc4(objectKey(fileKey, ref, false), data);
}

/* ---------- Walking objects ---------- */
const isString = (value) => value instanceof PDFString || value instanceof PDFHexString;
/** Replace every string inside `value` (in place for containers) with `replace(bytes, ref)`. */
function transformStrings(value, ref, replace) {
  if (value instanceof PDFDict) {
    // A signature's Contents string is never encrypted.
    const signature = value.get(PDFName.of('Type')) === PDFName.of('Sig');
    for (const [key, entry] of value.entries()) {
      if (signature && key === PDFName.of('Contents')) continue;
      const next = transformStrings(entry, ref, replace);
      if (next !== entry) value.set(key, next);
    }
  } else if (value instanceof PDFArray) {
    for (let i = 0; i < value.size(); i++) {
      const entry = value.get(i);
      const next = transformStrings(entry, ref, replace);
      if (next !== entry) value.set(i, next);
    }
  } else if (isString(value)) return PDFHexString.of(toHex(replace(value.asBytes(), ref)));
  return value;
}
/** An explicit Crypt selector overrides the document's default stream cipher. */
function streamCryptName(dict) {
  const filters = dict.lookup(PDFName.of('Filter'));
  let index = 0;
  if (filters instanceof PDFArray) {
    for (; index < filters.size(); index++)
      if (filters.lookup(index) === PDFName.of('Crypt')) break;
    if (index === filters.size()) return undefined;
  } else if (filters !== PDFName.of('Crypt')) return undefined;
  const parms = dict.lookup(PDFName.of('DecodeParms'));
  const parm = parms instanceof PDFArray ? dict.context.lookup(parms.get(index)) : parms;
  const name = parm instanceof PDFDict ? parm.lookup(PDFName.of('Name')) : undefined;
  return name instanceof PDFName ? name : PDFName.of('Identity');
}
function streamMethodFor(dict, security, encryptionDict) {
  const type = dict.lookup(PDFName.of('Type'));
  if (type === PDFName.of('XRef') || (type === PDFName.of('Metadata') && !security.encryptMetadata))
    return 'None';
  let name = streamCryptName(dict);
  if (!name && type === PDFName.of('EmbeddedFile') && encryptionDict && security.V >= 4) {
    const embedded = encryptionDict.lookup(PDFName.of('EFF'));
    if (embedded instanceof PDFName) name = embedded;
  }
  if (name === PDFName.of('Identity')) return 'None';
  if (name && encryptionDict && security.V >= 4) {
    const filters = encryptionDict.lookup(PDFName.of('CF'));
    const filter = filters instanceof PDFDict ? filters.lookup(name) : undefined;
    const cfm = filter instanceof PDFDict ? filter.lookup(PDFName.of('CFM')) : undefined;
    return cfm instanceof PDFName ? cfm.decodeText() : 'None';
  }
  return security.streamMethod;
}
/** Native AES uses the same keys, IV prefix and PKCS#7 padding as PDF stream encryption. */
function nativeAesStreams(method, fileKey, operation) {
  const api = globalThis.crypto?.subtle;
  const decrypting = operation === 'decrypt';
  if (
    !api?.[operation] ||
    (decrypting && !api.encrypt) ||
    (method !== 'AESV2' && method !== 'AESV3')
  )
    return null;
  const usages = decrypting ? ['encrypt', 'decrypt'] : ['encrypt'];
  let sharedKey;
  return async (data, ref) => {
    const key = method === 'AESV2' ? objectKey(fileKey, ref, true) : fileKey;
    const imported =
      method === 'AESV2'
        ? api.importKey('raw', key, 'AES-CBC', false, usages)
        : (sharedKey ??= api.importKey('raw', key, 'AES-CBC', false, usages));
    const cryptoKey = await imported;
    if (!decrypting) {
      const iv = randomBytes(16);
      return concat(
        iv,
        new Uint8Array(await api.encrypt({ name: 'AES-CBC', iv }, cryptoKey, data)),
      );
    }
    // Bound the native input snapshots and output buffers. CBC chains through each preceding
    // ciphertext block. Appending one encrypted padding block lets native CBC return the raw
    // plaintext of each chunk; only the original final padding is removed below.
    const length = Math.floor((data.length - 16) / 16) * 16;
    // Unlocking's parser owns a copy of each stream. Reuse it without changing the input PDF.
    const plain = data.subarray(16, 16 + length);
    const input = new Uint8Array(Math.min(length, 1024 * 1024) + 16);
    let iv = data.slice(0, 16);
    for (let offset = 0; offset < length; offset += 1024 * 1024) {
      const end = Math.min(offset + 1024 * 1024, length);
      const chunk = data.subarray(16 + offset, 16 + end);
      const nextIv = chunk.slice(chunk.length - 16);
      const padding = new Uint8Array(
        await api.encrypt({ name: 'AES-CBC', iv: nextIv }, cryptoKey, EMPTY),
      );
      input.set(chunk);
      input.set(padding, chunk.length);
      const decoded = new Uint8Array(
        await api.decrypt({ name: 'AES-CBC', iv }, cryptoKey, input.subarray(0, chunk.length + 16)),
      );
      plain.set(decoded, offset);
      iv = nextIv;
    }
    // Keep the established recovery for missing/damaged padding and trailing partial blocks.
    const pad = plain[plain.length - 1];
    return pad >= 1 && pad <= 16 && pad <= plain.length
      ? plain.subarray(0, plain.length - pad)
      : plain;
  };
}

/** Cache both paths per selected method, preserving small-stream and legacy performance. */
function streamCiphers(security, fileKey, operation, encryptionDict) {
  const cache = new Map();
  const create = operation === 'encrypt' ? encryptorFor : decryptorFor;
  return (dict) => {
    const method = streamMethodFor(dict, security, encryptionDict);
    const cached = cache.get(method);
    if (cached) return cached;
    if (!['None', 'V2', 'AESV2', 'AESV3'].includes(method))
      throw new Error('This PDF uses an encryption method this app cannot open.');
    const cipher = {
      method,
      sync: create(method, fileKey),
      native: nativeAesStreams(method, fileKey, operation),
    };
    cache.set(method, cipher);
    return cipher;
  };
}

/** Each stream uses its own cipher; large AES payloads use the asynchronous platform path. */
async function transformLargeStreams(context, string, selectStream, skipRef) {
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (ref === skipRef) continue;
    if (!(object instanceof PDFStream)) {
      const next = transformStrings(object, ref, string);
      if (next !== object) context.assign(ref, next);
      continue;
    }
    transformStrings(object.dict, ref, string);
    const cipher = selectStream(object.dict);
    if (cipher.method === 'None') continue;
    const contents =
      cipher.native && object.getContentsSize() >= 64 * 1024
        ? await cipher.native(object.getContents(), ref)
        : cipher.sync(object.getContents(), ref);
    if (object instanceof PDFRawStream) object.contents = contents;
    else context.assign(ref, PDFRawStream.of(object.dict, contents));
  }
}

/* ---------- Unlocking ---------- */
const ENDOBJ = [0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a];
/**
 * pdf-lib's parser with object streams held back: their contents can only be read once the
 * file key is known, so they are parsed afterwards in file order without letting an older
 * object stream override a newer direct definition of the same object.
 */
class DeferringParser extends PDFParser {
  constructor(bytes) {
    // Uint8Array.slice copies each parsed stream; Buffer.slice would alias the caller's file.
    super(
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      ParseSpeeds.Slow,
      false,
      false,
    );
    this.deferred = [];
    this.order = new Map();
    this.sequence = 0;
  }
  async parseIndirectObject() {
    const ref = this.parseIndirectObjectHeader();
    this.skipWhitespaceAndComments();
    const object = this.parseObject();
    this.skipWhitespaceAndComments();
    this.matchKeyword(ENDOBJ);
    const type = object instanceof PDFRawStream ? object.dict.lookup(PDFName.of('Type')) : null;
    if (type === PDFName.of('ObjStm'))
      this.deferred.push({ ref, object, sequence: this.sequence++ });
    else if (type === PDFName.of('XRef')) PDFXRefStreamParser.forStream(object).parseIntoContext();
    else {
      this.context.assign(ref, object);
      this.order.set(ref, this.sequence++);
    }
    return ref;
  }
  async parseObjectStreams(decrypt) {
    for (const { ref, object, sequence } of this.deferred) {
      // Cryptographic failures must surface, rather than silently discard valid objects.
      const contents = await decrypt(object.getContents(), ref, object.dict);
      const before = new Map(this.context.indirectObjects);
      try {
        const stream = PDFRawStream.of(withoutCryptFilter(object.dict), contents);
        await PDFObjectStreamParser.forStream(stream, this.shouldWaitForTick).parseIntoContext();
      } catch (error) {
        console.warn(`Skipping unreadable object stream ${ref}: ${error.message}`);
      }
      for (const [inner, value] of this.context.indirectObjects) {
        const previous = before.get(inner);
        if (previous === value) continue;
        if (previous !== undefined && this.order.get(inner) > sequence)
          this.context.assign(inner, previous);
        else this.order.set(inner, sequence);
      }
    }
  }
}
/**
 * Decrypt a password-protected PDF into an ordinary one. Throws PasswordError for a wrong
 * password and a plain Error for security handlers this app cannot open.
 */
export async function unlockPdf(bytes, password = '') {
  const parser = new DeferringParser(bytes);
  const context = await parser.parseDocument();
  const encryptRef = context.trailerInfo.Encrypt;
  const encrypt = context.lookup(encryptRef);
  if (!(encrypt instanceof PDFDict)) throw new Error('This PDF is not password protected.');
  const ids = context.lookup(context.trailerInfo.ID);
  const first = ids instanceof PDFArray && ids.size() ? context.lookup(ids.get(0)) : undefined;
  const security = readSecurity(encrypt, isString(first) ? first.asBytes() : EMPTY);
  const { fileKey, owner, userPassword } = await authenticate(security, password);
  const selectStream = streamCiphers(security, fileKey, 'decrypt', encrypt);
  await transformLargeStreams(
    context,
    decryptorFor(security.stringMethod, fileKey),
    selectStream,
    encryptRef,
  );
  await parser.parseObjectStreams((data, ref, dict) => {
    const cipher = selectStream(dict);
    return cipher.native && data.length >= 64 * 1024
      ? cipher.native(data, ref)
      : cipher.sync(data, ref);
  });
  delete context.trailerInfo.Encrypt;
  if (encryptRef instanceof PDFRef) context.delete(encryptRef);
  const doc = new PDFDocument(context, false, false);
  // What it takes to write the file back with the very same protection: the key, the
  // methods, and the dictionary holding the password checks (see protectPdf).
  const encryption = { fileKey, security, dict: encrypt };
  // Decryption must not enumerate an unvalidated page tree just to consider adding a
  // default page. The caller validates the decrypted document before opening/copying it.
  return {
    bytes: await savePdf(doc, { updateFieldAppearances: false, addDefaultPage: false }),
    owner,
    encryption,
    // The permissions password of older revisions also yields the open password.
    userPassword,
  };
}
/** What readers may do without the owner password, from the permission flags. */
export const permissionsOf = (P) => ({
  print: !!(P & 0x4),
  copy: !!(P & 0x10),
  annotate: !!(P & 0x20),
  edit: !!(P & 0x8),
});
/**
 * The protection of a file that has just been opened: the typed password in the role it
 * played, the other one unknown (null), the permissions the file grants, and its encryption so
 * an unchanged protection goes back as it came.
 */
export function openedProtection({ owner, encryption, userPassword = null }, password) {
  return {
    owner,
    open: owner ? userPassword : password,
    permissions: owner ? password : null,
    allow: permissionsOf(encryption.security.P),
    original: encryption,
  };
}

/** Effective reader permissions. New protection is configured by the current document owner. */
export function documentAccess(protection) {
  const unrestricted = !protection?.original || protection.owner === true;
  const { P = -4, R = 6 } = protection?.original?.security || {};
  const bit = (mask) => unrestricted || !!(P & mask);
  return {
    owner: unrestricted,
    print: bit(0x4),
    printHighQuality: bit(0x4) && (R < 3 || bit(0x800)),
    copy: bit(0x10),
    edit: bit(0x8),
    annotate: bit(0x20),
    fill: bit(0x20) || (R >= 3 && bit(0x100)),
    assemble: R < 3 ? bit(0x8) : bit(0x400),
    // Revision 2 shares the copy bit; 3–5 have a separate accessibility bit. Revision 6
    // cannot restrict accessibility, even when an old writer has cleared that bit.
    accessibility: unrestricted || R >= 6 || bit(R < 3 ? 0x10 : 0x200),
  };
}
const ACCESS_ACTIONS = {
  owner: 'changing protection',
  print: 'printing',
  copy: 'copying or extracting content',
  edit: 'editing content',
  annotate: 'editing comments and links',
  fill: 'filling forms',
  assemble: 'changing pages and bookmarks',
};
export function requireDocumentAccess(protection, ...actions) {
  const access = documentAccess(protection);
  for (const action of actions)
    if (!access[action])
      throw new Error(
        `This PDF does not allow ${ACCESS_ACTIONS[action]} without its permissions password.`,
      );
}

/** Authenticate the owner without changing the file's passwords, permissions, or export key. */
export async function authenticateOwner(protection, password) {
  if (documentAccess(protection).owner) return protection;
  const authenticated = await authenticate(protection.original.security, password);
  if (!authenticated.owner || !equal(authenticated.fileKey, protection.original.fileKey))
    throw new PasswordError('Enter the permissions password to unlock this PDF.');
  return { ...protection, owner: true, permissions: password };
}

/* ---------- Protecting ---------- */
/** Revision 6 needs PDF 2.0 or PDF 1.7 with Adobe extension level 8. */
function declareRevision6(doc) {
  if (pdfVersion(doc)[0] >= 2) return;
  const name = PDFName.of;
  let extensions = doc.catalog.lookup(name('Extensions'));
  if (!(extensions instanceof PDFDict)) {
    extensions = doc.context.obj({});
    doc.catalog.set(name('Extensions'), extensions);
  }
  let adbe = extensions.lookup(name('ADBE'));
  if (!(adbe instanceof PDFDict)) {
    adbe = doc.context.obj({});
    extensions.set(name('ADBE'), adbe);
  }
  const base = adbe.lookup(name('BaseVersion'));
  const version = base instanceof PDFName && /^(\d+)\.(\d+)$/.exec(base.decodeText());
  // Preserve requirements newer than 1.7, and all unrelated extension entries.
  if (version && (+version[1] > 1 || (+version[1] === 1 && +version[2] > 7))) return;
  adbe.set(name('BaseVersion'), name('1.7'));
  const level = adbe.lookup(name('ExtensionLevel'));
  if (!(level instanceof PDFNumber) || level.asNumber() < 8)
    adbe.set(name('ExtensionLevel'), PDFNumber.of(8));
}

/** A copy of an object for another context, with references resolved into place. */
function copyInto(value, context, from) {
  if (value instanceof PDFRef) return copyInto(from.lookup(value), context, from);
  if (value instanceof PDFDict) {
    const dict = context.obj({});
    for (const [key, entry] of value.entries()) {
      const copy = copyInto(entry, context, from);
      if (copy !== undefined) dict.set(key, copy);
    }
    return dict;
  }
  if (value instanceof PDFArray)
    return context.obj(
      value
        .asArray()
        .map((entry) => copyInto(entry, context, from))
        .filter((entry) => entry !== undefined),
    );
  return value?.clone();
}
/**
 * Encrypt a PDF again exactly as it was when it was opened: same key, same methods, same
 * password checks, so both of its passwords and its permissions carry on, whichever of the
 * passwords was typed to open it.
 */
async function encryptAsBefore(bytes, { fileKey, security, dict }) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (security.R === 6) declareRevision6(doc);
  const { context } = doc;
  await transformLargeStreams(
    context,
    encryptorFor(security.stringMethod, fileKey),
    streamCiphers(security, fileKey, 'encrypt', dict),
  );
  context.trailerInfo.Encrypt = context.register(copyInto(dict, context, dict.context));
  // The password checks of the older revisions mix in the file's first identifier.
  const hexString = (data) => PDFHexString.of(toHex(data));
  if (security.id.length)
    context.trailerInfo.ID = context.obj([hexString(security.id), hexString(randomBytes(16))]);
  else delete context.trailerInfo.ID;
  return savePdf(doc, {
    useObjectStreams: false,
    updateFieldAppearances: false,
    addDefaultPage: false,
  });
}

/** Bits 3 to 12 of the permission flags; the other bits are fixed by the specification. */
export function permissionFlags({ print = true, copy = true, annotate = true, edit = true } = {}) {
  let flags = 0xfffff0c0 | 0x200; // Text access for accessibility is always allowed.
  if (print) flags |= 0x4 | 0x800;
  if (copy) flags |= 0x10;
  if (annotate) flags |= 0x20 | 0x100;
  if (edit) flags |= 0x8 | 0x400;
  return flags | 0;
}
/**
 * Encrypt a PDF with AES-256 (revision 6). `open` is the password readers type; `permissions`
 * is the owner password that lifts the restrictions in `allow`, defaulting to the open password.
 * With `open: null`, `openFrom` (an AES-256 file's encryption, as unlockPdf returns it) keeps
 * that file's open password, which need not be known: its key and user entries carry over.
 */
export async function protectPdf(
  bytes,
  { open = '', permissions = '', allow = {}, original = null, openFrom = null } = {},
) {
  if (original) return encryptAsBefore(bytes, original);
  const reader = open === null && openFrom?.security.R >= 5 ? openFrom : null;
  if (open === null && !reader) throw new Error('Choose a password to open the PDF.');
  open ||= '';
  // Without restrictions the permissions password lifts nothing; a random one will do.
  const ownerPassword = permissions || open || (reader && toHex(randomBytes(16)));
  if (!open && !ownerPassword) throw new Error('Choose a password.');
  const R = reader ? reader.security.R : 6;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (R === 6) declareRevision6(doc);
  const { context } = doc;
  // Fresh protection defines only StdCF, and encrypts every stream with it. A Crypt selector
  // from the old file must yield to that default, Identity exemptions included: edited content
  // and field appearances inherit their source's selector, so an exemption the user never chose
  // would leave new text readable without the password. Other filter parameters are kept.
  for (const [ref, object] of context.indirectObjects) {
    if (!(object instanceof PDFStream)) continue;
    if (streamCryptName(object.dict))
      context.assign(ref, PDFRawStream.of(withoutCryptFilter(object.dict), object.getContents()));
  }
  const ownerBytes = modernPassword(ownerPassword);
  const P = permissionFlags(allow);
  let fileKey, U, UE;
  if (reader) {
    // The open password checks (U, UE) depend only on that password and the file key.
    ({ fileKey } = reader);
    U = reader.security.U.subarray(0, 48);
    UE = reader.security.UE.subarray(0, 32);
  } else {
    fileKey = randomBytes(32);
    const user = modernPassword(open);
    const validationSalt = randomBytes(8);
    const keySalt = randomBytes(8);
    U = concat(await hashPassword(user, validationSalt, EMPTY, 6), validationSalt, keySalt);
    UE = aesCbcEncrypt(await hashPassword(user, keySalt, EMPTY, 6), ZERO_IV, fileKey);
  }
  const ownerValidationSalt = randomBytes(8);
  const ownerKeySalt = randomBytes(8);
  const O = concat(
    await hashPassword(ownerBytes, ownerValidationSalt, U, R),
    ownerValidationSalt,
    ownerKeySalt,
  );
  const OE = aesCbcEncrypt(await hashPassword(ownerBytes, ownerKeySalt, U, R), ZERO_IV, fileKey);
  const perms = aesCbcEncrypt(
    fileKey,
    ZERO_IV,
    concat(int32le(P), [0xff, 0xff, 0xff, 0xff], [0x54, 0x61, 0x64, 0x62], randomBytes(4)),
  );
  const encryptData = (data) => aesEncryptData(fileKey, data);
  await transformLargeStreams(
    context,
    encryptData,
    streamCiphers({ streamMethod: 'AESV3', encryptMetadata: true }, fileKey, 'encrypt'),
  );
  const hexString = (data) => PDFHexString.of(toHex(data));
  const encrypt = context.obj({
    Filter: 'Standard',
    V: 5,
    R,
    Length: 256,
    P,
    CF: { StdCF: { CFM: 'AESV3', AuthEvent: 'DocOpen', Length: 32 } },
    StmF: 'StdCF',
    StrF: 'StdCF',
    O: hexString(O),
    U: hexString(U),
    OE: hexString(OE),
    UE: hexString(UE),
    Perms: hexString(perms),
    EncryptMetadata: true,
  });
  context.trailerInfo.Encrypt = context.register(encrypt);
  const ids = context.lookup(context.trailerInfo.ID);
  const first = ids instanceof PDFArray && ids.size() ? context.lookup(ids.get(0)) : undefined;
  const firstId = isString(first) && first.asBytes().length ? first.asBytes() : randomBytes(16);
  context.trailerInfo.ID = context.obj([hexString(firstId), hexString(randomBytes(16))]);
  return savePdf(doc, {
    useObjectStreams: false,
    updateFieldAppearances: false,
    addDefaultPage: false,
  });
}
