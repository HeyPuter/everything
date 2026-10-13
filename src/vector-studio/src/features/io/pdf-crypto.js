/**
 * PDF password protection: the standard security handler, revision 4,
 * with 128-bit AES for streams (crypt filter AESV2; strings stay as they
 * are). MD5 and RC4 for the key derivation are implemented here; AES runs
 * on WebCrypto.
 *
 *   securityHandler({ userPassword, ownerPassword, permissions, id })
 *     -> { key, O, U, P, dict }   dict is the /Encrypt dictionary body
 *   encryptStream(key, objNum, gen, bytes) -> Promise<Uint8Array> (IV + data)
 */

// ---- MD5 (RFC 1321) ----

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(bytes) {
  const len = bytes.length;
  const total = ((len + 8) >> 6) * 64 + 64;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(msg.buffer);
  dv.setUint32(total - 8, bits >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return out;
}

// ---- RC4 ----

export function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const PAD = new Uint8Array([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Password bytes padded to 32 (Latin-1; other characters become '?'). */
export function padPassword(pw) {
  const s = String(pw || '');
  const b = new Uint8Array(Math.min(32, s.length));
  for (let i = 0; i < b.length; i++) b[i] = s.charCodeAt(i) < 256 ? s.charCodeAt(i) : 0x3f;
  return concat(b, PAD.subarray(0, 32 - b.length));
}

const le32 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);

/** Permission flags (P) from choices: printing 'none'|'low'|'high', changes 'none'|'assemble'|'fill'|'comment'|'any', copy, accessibility. */
export function permissionBits({ printing = 'high', changes = 'any', copy = true, accessibility = true } = {}) {
  let p = 0xfffff0c0;
  const bit = (n) => (p |= 1 << (n - 1));
  if (printing !== 'none') bit(3);
  if (printing === 'high') bit(12);
  if (changes === 'any') [4, 6, 9, 11].forEach(bit);
  if (changes === 'comment') [6, 9].forEach(bit);
  if (changes === 'fill') bit(9);
  if (changes === 'assemble') bit(11);
  if (copy) bit(5);
  if (accessibility || copy) bit(10);
  return p | 0;
}

/** Owner key (O), file key and user key (U) per the standard security handler, revision 4, 128-bit. */
export function securityHandler({ userPassword = '', ownerPassword = '', permissions = {}, id }) {
  const n = 16;
  const P = permissionBits(permissions);
  // O: the owner password (or the user password when none) keys RC4 over the padded user password.
  let h = md5(padPassword(ownerPassword || userPassword));
  for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  const okey = h.subarray(0, n);
  let O = rc4(okey, padPassword(userPassword));
  for (let i = 1; i <= 19; i++) O = rc4(okey.map((b) => b ^ i), O);
  // File key from the user password, O, P and the document id.
  let k = md5(concat(padPassword(userPassword), O, le32(P), id));
  for (let i = 0; i < 50; i++) k = md5(k.subarray(0, n));
  const key = k.slice(0, n);
  // U: the padding string hashed with the id, encrypted 20 times; padded to 32 bytes.
  let U = rc4(key, md5(concat(PAD, id)));
  for (let i = 1; i <= 19; i++) U = rc4(key.map((b) => b ^ i), U);
  U = concat(U, new Uint8Array(16));
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const dict = `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /Identity /O <${hex(O)}> /U <${hex(U)}> /P ${P} /EncryptMetadata true >>`;
  return { key, O, U, P, dict };
}

/** The per-object AES key. */
export function objectKey(key, objNum, gen = 0) {
  const salt = new Uint8Array([0x73, 0x41, 0x6c, 0x54]);
  return md5(concat(key, new Uint8Array([objNum & 255, (objNum >> 8) & 255, (objNum >> 16) & 255, gen & 255, (gen >> 8) & 255]), salt)).subarray(0, 16);
}

/** AES-128-CBC with a random IV in front (PKCS#7 padding), as AESV2 streams are stored. */
export async function encryptStream(key, objNum, gen, bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Password protection needs a browser with Web Crypto.');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const k = await subtle.importKey('raw', objectKey(key, objNum, gen), { name: 'AES-CBC' }, false, ['encrypt']);
  const enc = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, k, bytes));
  return concat(iv, enc);
}

/** 16 random bytes for the document id. */
export function newDocumentId() {
  return globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(16)) : md5(new TextEncoder().encode(`${Date.now()}:${Math.random()}`));
}
