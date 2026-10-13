/**
 * The PDF standard security handler: RC4 (40-128 bit), AES-128 and
 * AES-256 (revisions 5 and 6), opened with the user or the owner password.
 * Files that only restrict printing or editing have an empty user password
 * and open without asking.
 *
 * createDecryptor returns null when the password does not open the file or
 * the file uses a handler this module does not implement.
 */
import { PDFDict, PDFStream, Name, strBytes, bytesStr } from './primitives.js';

const PAD = [0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a];

// ---------------------------------------------------------------- MD5

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;

export function md5(data) {
  const len = data.length;
  const padded = new Uint8Array(((len + 72) >> 6) << 6);
  padded.set(data);
  padded[len] = 0x80;
  const bits = len * 8;
  const pl = padded.length;
  padded[pl - 8] = bits & 255;
  padded[pl - 7] = (bits >>> 8) & 255;
  padded[pl - 6] = (bits >>> 16) & 255;
  padded[pl - 5] = (bits >>> 24) & 255;
  padded[pl - 4] = Math.floor(bits / 2 ** 32) & 255;
  let a0 = 0x67452301;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476;
  const w = new Int32Array(16);
  for (let off = 0; off < pl; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = padded[off + i * 4] | (padded[off + i * 4 + 1] << 8) | (padded[off + i * 4 + 2] << 16) | (padded[off + i * 4 + 3] << 24);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
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
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + K[i] + w[g]) | 0;
      b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => {
    out[i * 4] = v & 255;
    out[i * 4 + 1] = (v >>> 8) & 255;
    out[i * 4 + 2] = (v >>> 16) & 255;
    out[i * 4 + 3] = (v >>> 24) & 255;
  });
  return out;
}

// ---------------------------------------------------------------- SHA-2

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data) {
  const len = data.length;
  const pl = ((len + 72) >> 6) << 6;
  const p = new Uint8Array(pl);
  p.set(data);
  p[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(p.buffer);
  dv.setUint32(pl - 8, Math.floor(bits / 2 ** 32));
  dv.setUint32(pl - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < pl; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
  return out;
}

const K512 = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118', 'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2', '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
  'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5', '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
  '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df', '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b', 'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3', '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec', '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
  'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b', '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817',
].map((x) => BigInt(`0x${x}`));
const M64 = (1n << 64n) - 1n;

/** SHA-512, or SHA-384 with `is384`. */
export function sha512(data, is384 = false) {
  const len = data.length;
  const pl = ((len + 144) >> 7) << 7;
  const p = new Uint8Array(pl);
  p.set(data);
  p[len] = 0x80;
  const dv = new DataView(p.buffer);
  dv.setBigUint64(pl - 8, BigInt(len) * 8n);
  const h = (is384
    ? ['cbbb9d5dc1059ed8', '629a292a367cd507', '9159015a3070dd17', '152fecd8f70e5939', '67332667ffc00b31', '8eb44a8768581511', 'db0c2e0d64f98fa7', '47b5481dbefa4fa4']
    : ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179']
  ).map((x) => BigInt(`0x${x}`));
  const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64;
  const w = new Array(80);
  for (let off = 0; off < pl; off += 128) {
    for (let i = 0; i < 16; i++) w[i] = dv.getBigUint64(off + i * 8);
    for (let i = 16; i < 80; i++) {
      const s0 = rotr(w[i - 15], 1) ^ rotr(w[i - 15], 8) ^ (w[i - 15] >> 7n);
      const s1 = rotr(w[i - 2], 19) ^ rotr(w[i - 2], 61) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M64;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41);
      const ch = (e & f) ^ (~e & M64 & g);
      const t1 = (hh + S1 + ch + K512[i] + w[i]) & M64;
      const S0 = rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & M64;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) & M64;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & M64;
    }
    h[0] = (h[0] + a) & M64;
    h[1] = (h[1] + b) & M64;
    h[2] = (h[2] + c) & M64;
    h[3] = (h[3] + d) & M64;
    h[4] = (h[4] + e) & M64;
    h[5] = (h[5] + f) & M64;
    h[6] = (h[6] + g) & M64;
    h[7] = (h[7] + hh) & M64;
  }
  const out = new Uint8Array(64);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setBigUint64(i * 8, h[i]);
  return is384 ? out.slice(0, 48) : out;
}

// ---------------------------------------------------------------- RC4

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

// ---------------------------------------------------------------- AES

const SBOX = new Uint8Array(256);
const INV = new Uint8Array(256);
(() => {
  let p = 1;
  let q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;
})();

const xt = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
function mul(a, b) {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = xt(a);
    b >>= 1;
  }
  return r;
}

function expandKey(key) {
  const nk = key.length / 4;
  const nr = nk + 6;
  const w = new Uint8Array(16 * (nr + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    const t = w.slice((i - 1) * 4, i * 4);
    if (i % nk === 0) {
      const t0 = t[0];
      t[0] = SBOX[t[1]] ^ rcon;
      t[1] = SBOX[t[2]];
      t[2] = SBOX[t[3]];
      t[3] = SBOX[t0];
      rcon = xt(rcon);
    } else if (nk > 6 && i % nk === 4) for (let k = 0; k < 4; k++) t[k] = SBOX[t[k]];
    for (let k = 0; k < 4; k++) w[i * 4 + k] = w[(i - nk) * 4 + k] ^ t[k];
  }
  return { w, nr };
}

function decryptBlock(block, { w, nr }) {
  const s = block.slice();
  const addKey = (r) => {
    for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
  };
  addKey(nr);
  for (let r = nr - 1; r >= 0; r--) {
    // Inverse shift rows.
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) s[((c + row) % 4) * 4 + row] = t[c * 4 + row];
    for (let i = 0; i < 16; i++) s[i] = INV[s[i]];
    addKey(r);
    if (r > 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4];
        const a1 = s[c * 4 + 1];
        const a2 = s[c * 4 + 2];
        const a3 = s[c * 4 + 3];
        s[c * 4] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
        s[c * 4 + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
        s[c * 4 + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
        s[c * 4 + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
      }
    }
  }
  return s;
}

function encryptBlock(block, { w, nr }) {
  const s = block.slice();
  const addKey = (r) => {
    for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
  };
  addKey(0);
  for (let r = 1; r <= nr; r++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) s[c * 4 + row] = t[((c + row) % 4) * 4 + row];
    if (r < nr) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4];
        const a1 = s[c * 4 + 1];
        const a2 = s[c * 4 + 2];
        const a3 = s[c * 4 + 3];
        s[c * 4] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3;
        s[c * 4 + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3;
        s[c * 4 + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3);
        s[c * 4 + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2);
      }
    }
    addKey(r);
  }
  return s;
}

/** AES-CBC decryption; the first 16 bytes are the IV unless `iv` is given. PKCS#5 padding removed when `unpad`. */
export function aesCbcDecrypt(key, data, { iv = null, unpad = true } = {}) {
  const ks = expandKey(key);
  let prev = iv || data.subarray(0, 16);
  const start = iv ? 0 : 16;
  const n = Math.floor((data.length - start) / 16) * 16;
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 16) {
    const block = data.subarray(start + o, start + o + 16);
    const dec = decryptBlock(block, ks);
    for (let i = 0; i < 16; i++) out[o + i] = dec[i] ^ prev[i];
    prev = block;
  }
  if (unpad && n) {
    const pad = out[n - 1];
    if (pad >= 1 && pad <= 16) return out.subarray(0, n - pad);
  }
  return out;
}

/** AES-CBC encryption without padding (input a multiple of 16 bytes). */
export function aesCbcEncrypt(key, data, iv) {
  const ks = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let o = 0; o < data.length; o += 16) {
    const block = data.slice(o, o + 16);
    for (let i = 0; i < 16; i++) block[i] ^= prev[i];
    const enc = encryptBlock(block, ks);
    out.set(enc, o);
    prev = enc;
  }
  return out;
}

// ---------------------------------------------------------------- handler

const cat = (...parts) => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Revision 6 hash (ISO 32000-2, 7.6.4.3.4). `udata` is the 48-byte U string for owner checks, else empty. */
function hash2B(password, salt, udata) {
  let k = sha256(cat(password, salt, udata));
  let e = new Uint8Array(0);
  for (let round = 0; round < 64 || e[e.length - 1] > round - 32; round++) {
    const k1 = cat(password, k, udata);
    const rep = new Uint8Array(k1.length * 64);
    for (let i = 0; i < 64; i++) rep.set(k1, i * k1.length);
    e = aesCbcEncrypt(k.subarray(0, 16), rep, k.subarray(16, 32));
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    const m = sum % 3;
    k = m === 0 ? sha256(e) : m === 1 ? sha512(e, true) : sha512(e);
  }
  return k.subarray(0, 32);
}

const equal = (a, b, n) => {
  if (a.length < n || b.length < n) return false;
  let d = 0;
  for (let i = 0; i < n; i++) d |= a[i] ^ b[i];
  return d === 0;
};

/** Password bytes for revisions 2-4: Latin-1 (PDFDocEncoding for the common characters), at most 32 bytes. */
function legacyPassword(pw) {
  const out = [];
  for (const ch of String(pw || '')) {
    const c = ch.codePointAt(0);
    out.push(c < 256 ? c : 63);
    if (out.length === 32) break;
  }
  return Uint8Array.from(out);
}

/** Password bytes for revisions 5 and 6: normalized UTF-8, at most 127 bytes. */
function unicodePassword(pw) {
  const bytes = new TextEncoder().encode(String(pw || '').normalize('NFKC'));
  return bytes.subarray(0, 127);
}

const padded = (pw) => {
  const out = new Uint8Array(32);
  out.set(pw.subarray(0, 32));
  out.set(PAD.slice(0, 32 - Math.min(32, pw.length)), Math.min(32, pw.length));
  return out;
};

/** True for encryption this module can open with the right password (the standard handler, revisions 2-6). */
export function isStandardEncryption(enc) {
  if (!(enc instanceof PDFDict) || enc.name('Filter') !== 'Standard') return false;
  const v = enc.num('V', 0);
  const r = enc.num('R', 2);
  return [1, 2, 4, 5].includes(v) && r >= 2 && r <= 6;
}

/**
 * A decryptor for the trailer's /Encrypt dictionary, or null when the
 * password (default: empty) opens neither as the user nor the owner
 * password, or the handler is not supported. The password is used only to
 * derive the file key and is not kept.
 */
export function createDecryptor(enc, id0 = '', password = '') {
  if (!isStandardEncryption(enc)) return null;
  const v = enc.num('V', 0);
  const r = enc.num('R', 2);
  const O = strBytes(enc.get('O') || '');
  const U = strBytes(enc.get('U') || '');
  let P = enc.num('P', 0);
  let method = 'rc4';
  let stmMethod = 'rc4';
  let strMethod = 'rc4';
  let keyLen = v === 1 ? 5 : Math.max(5, Math.min(16, Math.floor(enc.num('Length', 40) / 8)));
  if (v >= 4) {
    const cf = enc.get('CF');
    const methodOf = (name) => {
      if (name === 'Identity') return 'none';
      const f = cf instanceof PDFDict ? cf.get(name) : null;
      const cfm = f instanceof PDFDict ? f.name('CFM', 'None') : 'None';
      if (cfm === 'AESV2') return 'aes';
      if (cfm === 'AESV3') return 'aes256';
      if (cfm === 'V2') return 'rc4';
      return 'none';
    };
    stmMethod = methodOf(enc.name('StmF', 'Identity'));
    strMethod = methodOf(enc.name('StrF', 'Identity'));
    method = stmMethod;
    if (v === 4) keyLen = 16;
  }
  const encryptMetadata = enc.get('EncryptMetadata') !== false;
  let key = null;
  if (r >= 5) {
    // AES-256: the file key is wrapped with a key derived from the user or the owner password.
    const pw = unicodePassword(password);
    const hash = (salt, udata) => (r === 5 ? sha256(cat(pw, salt, udata)) : hash2B(pw, salt, udata));
    const none = new Uint8Array(0);
    const u48 = U.subarray(0, 48);
    const unwrap = (ik, wrapped) => aesCbcDecrypt(ik, wrapped.subarray(0, 32), { iv: new Uint8Array(16), unpad: false });
    if (equal(hash(U.subarray(32, 40), none), U, 32)) key = unwrap(hash(U.subarray(40, 48), none), strBytes(enc.get('UE') || ''));
    else if (O.length >= 48 && equal(hash(O.subarray(32, 40), u48), O, 32)) key = unwrap(hash(O.subarray(40, 48), u48), strBytes(enc.get('OE') || ''));
    if (!key || key.length < 32) return null;
  } else {
    P >>>= 0;
    const id = strBytes(id0 || '');
    // Algorithm 2: the file key from a padded user password.
    const fileKey = (upw) => {
      const parts = [padded(upw), O.subarray(0, 32), new Uint8Array([P & 255, (P >>> 8) & 255, (P >>> 16) & 255, (P >>> 24) & 255]), id];
      if (r >= 4 && !encryptMetadata) parts.push(new Uint8Array([255, 255, 255, 255]));
      let h = md5(cat(...parts));
      if (r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, keyLen));
      return h.subarray(0, keyLen);
    };
    // Algorithms 4 and 5: the U string the key would produce.
    const userOk = (k) => {
      if (r === 2) return equal(rc4(k, Uint8Array.from(PAD)), U, 32);
      let u = rc4(k, md5(cat(Uint8Array.from(PAD), id)));
      for (let i = 1; i <= 19; i++) u = rc4(k.map((b) => b ^ i), u);
      return equal(u, U, 16);
    };
    const pw = legacyPassword(password);
    const asUser = fileKey(pw);
    if (userOk(asUser)) key = asUser;
    else {
      // Algorithm 7: the owner password decrypts O to the user password.
      let h = md5(padded(pw));
      if (r >= 3) for (let i = 0; i < 50; i++) h = md5(h);
      const ok = h.subarray(0, r === 2 ? 5 : keyLen);
      let upw = O.subarray(0, 32);
      if (r === 2) upw = rc4(ok, upw);
      else for (let i = 19; i >= 0; i--) upw = rc4(ok.map((b) => b ^ i), upw);
      const asOwner = fileKey(upw);
      if (userOk(asOwner)) key = asOwner;
    }
    if (!key) return null;
  }
  const objectKey = (num, gen, aes) => {
    if (r >= 5) return key;
    const parts = [key, new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255])];
    if (aes) parts.push(new Uint8Array([0x73, 0x41, 0x6c, 0x54]));
    return md5(cat(...parts)).subarray(0, Math.min(16, key.length + 5));
  };
  const decrypt = (data, num, gen, m) => {
    if (m === 'none') return data;
    if (m === 'rc4') return rc4(objectKey(num, gen, false), data);
    if (data.length < 16) return new Uint8Array(0);
    return aesCbcDecrypt(objectKey(num, gen, true), data);
  };
  const walk = (obj, num, gen, seen) => {
    if (typeof obj === 'string') return bytesStr(decrypt(strBytes(obj), num, gen, strMethod));
    if (Array.isArray(obj)) return obj.map((x) => walk(x, num, gen, seen));
    if (obj instanceof PDFStream) {
      walk(obj.dict, num, gen, seen);
      const type = obj.dict.name('Type');
      if (type === 'XRef' || (type === 'Metadata' && !encryptMetadata)) return obj;
      const f = obj.dict.get('Filter');
      const crypt = Array.isArray(f) ? f[0] : f;
      if (crypt instanceof Name && crypt.name === 'Crypt') return obj;
      obj.raw = decrypt(obj.raw, num, gen, stmMethod);
      return obj;
    }
    if (obj instanceof PDFDict) {
      if (seen.has(obj)) return obj;
      seen.add(obj);
      for (const k of obj.keys()) obj.set(k, walk(obj.getRaw(k), num, gen, seen));
      return obj;
    }
    return obj;
  };
  return {
    method,
    decryptObject: (obj, num, gen) => walk(obj, num, gen, new Set()),
  };
}
