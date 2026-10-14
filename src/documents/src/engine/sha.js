// Synchronous SHA-1, SHA-256, SHA-384 and SHA-512 (FIPS 180-4), written for this project.
// Document-protection verifiers iterate a hash 100,000 times over tiny inputs; an awaited
// Web Crypto call per iteration takes seconds, while these run in a fraction of that.
// Round constants and initial values are derived here from their definitions (fractional
// parts of square and cube roots of the first primes) rather than typed in.

const primes = count => { const out = []; for (let n = 2; out.length < count; n++) if (out.every(p => n % p)) out.push(n); return out; };
function integerRoot(value, degree) {
  let x = 1n << BigInt(Math.ceil(value.toString(2).length / degree));
  for (;;) {
    const next = ((BigInt(degree) - 1n) * x + value / x ** BigInt(degree - 1)) / BigInt(degree);
    if (next >= x) return x;
    x = next;
  }
}
/** The first `bits` bits of the fractional part of p^(1/degree). */
const fraction = (p, degree, bits) => integerRoot(BigInt(p) << BigInt(bits * degree), degree) & ((1n << BigInt(bits)) - 1n);

const P80 = primes(80);
const K512 = P80.map(p => fraction(p, 3, 64));
const K512_HI = Int32Array.from(K512, k => Number(k >> 32n) | 0), K512_LO = Int32Array.from(K512, k => Number(k & 0xFFFFFFFFn) | 0);
const IV512 = P80.slice(0, 8).map(p => fraction(p, 2, 64)), IV384 = P80.slice(8, 16).map(p => fraction(p, 2, 64));
const K256 = Int32Array.from(P80.slice(0, 64), p => Number(fraction(p, 3, 32)) | 0);
const IV256 = P80.slice(0, 8).map(p => Number(fraction(p, 2, 32)) | 0);

function pad(bytes, block, lengthBytes) {
  const total = Math.ceil((bytes.length + 1 + lengthBytes) / block) * block;
  const out = new Uint8Array(total); out.set(bytes); out[bytes.length] = 0x80;
  const view = new DataView(out.buffer), bits = bytes.length * 8;
  view.setUint32(total - 4, bits >>> 0); view.setUint32(total - 8, Math.floor(bits / 2 ** 32));
  return view;
}

const WH = new Int32Array(80), WL = new Int32Array(80);
const IV512_WORDS = Int32Array.from(IV512.flatMap(v => [Number(v >> 32n) | 0, Number(v & 0xFFFFFFFFn) | 0]));
const IV384_WORDS = Int32Array.from(IV384.flatMap(v => [Number(v >> 32n) | 0, Number(v & 0xFFFFFFFFn) | 0]));
function sha512(bytes, iv) {
  const h = Int32Array.from(iv === IV384 ? IV384_WORDS : IV512_WORDS);
  const view = pad(bytes, 128, 16), wh = WH, wl = WL;
  for (let offset = 0; offset < view.byteLength; offset += 128) {
    for (let t = 0; t < 16; t++) { wh[t] = view.getInt32(offset + 8 * t); wl[t] = view.getInt32(offset + 8 * t + 4); }
    for (let t = 16; t < 80; t++) {
      // σ0 = ROTR1 ^ ROTR8 ^ SHR7 of w[t-15]; σ1 = ROTR19 ^ ROTR61 ^ SHR6 of w[t-2].
      let xh = wh[t - 15], xl = wl[t - 15];
      const s0h = (xh >>> 1 | xl << 31) ^ (xh >>> 8 | xl << 24) ^ xh >>> 7;
      const s0l = (xl >>> 1 | xh << 31) ^ (xl >>> 8 | xh << 24) ^ (xl >>> 7 | xh << 25);
      xh = wh[t - 2]; xl = wl[t - 2];
      const s1h = (xh >>> 19 | xl << 13) ^ (xl >>> 29 | xh << 3) ^ xh >>> 6;
      const s1l = (xl >>> 19 | xh << 13) ^ (xh >>> 29 | xl << 3) ^ (xl >>> 6 | xh << 26);
      let lo = (s0l >>> 0) + (s1l >>> 0) + (wl[t - 7] >>> 0) + (wl[t - 16] >>> 0);
      wh[t] = s0h + s1h + wh[t - 7] + wh[t - 16] + Math.floor(lo / 0x100000000) | 0; wl[t] = lo | 0;
    }
    let ah = h[0], al = h[1], bh = h[2], bl = h[3], ch = h[4], cl = h[5], dh = h[6], dl = h[7], eh = h[8], el = h[9], fh = h[10], fl = h[11], gh = h[12], gl = h[13], hh = h[14], hl = h[15];
    for (let t = 0; t < 80; t++) {
      const S1h = (eh >>> 14 | el << 18) ^ (eh >>> 18 | el << 14) ^ (el >>> 9 | eh << 23);
      const S1l = (el >>> 14 | eh << 18) ^ (el >>> 18 | eh << 14) ^ (eh >>> 9 | el << 23);
      const chh = eh & fh ^ ~eh & gh, chl = el & fl ^ ~el & gl;
      let lo = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K512_LO[t] >>> 0) + (wl[t] >>> 0);
      const t1h = hh + S1h + chh + K512_HI[t] + wh[t] + Math.floor(lo / 0x100000000) | 0, t1l = lo | 0;
      const S0h = (ah >>> 28 | al << 4) ^ (al >>> 2 | ah << 30) ^ (al >>> 7 | ah << 25);
      const S0l = (al >>> 28 | ah << 4) ^ (ah >>> 2 | al << 30) ^ (ah >>> 7 | al << 25);
      const mah = ah & bh ^ ah & ch ^ bh & ch, mal = al & bl ^ al & cl ^ bl & cl;
      lo = (S0l >>> 0) + (mal >>> 0);
      const t2h = S0h + mah + Math.floor(lo / 0x100000000) | 0, t2l = lo | 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      lo = (dl >>> 0) + (t1l >>> 0); eh = dh + t1h + Math.floor(lo / 0x100000000) | 0; el = lo | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      lo = (t1l >>> 0) + (t2l >>> 0); ah = t1h + t2h + Math.floor(lo / 0x100000000) | 0; al = lo | 0;
    }
    const fold = (i, hi, lo) => { const sum = (h[i + 1] >>> 0) + (lo >>> 0); h[i] = h[i] + hi + (sum > 0xFFFFFFFF ? 1 : 0) | 0; h[i + 1] = sum | 0; };
    fold(0, ah, al); fold(2, bh, bl); fold(4, ch, cl); fold(6, dh, dl); fold(8, eh, el); fold(10, fh, fl); fold(12, gh, gl); fold(14, hh, hl);
  }
  const out = new Uint8Array(64), outView = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) outView.setInt32(4 * i, h[i]);
  return out;
}

function sha256(bytes) {
  const h = Int32Array.from(IV256), view = pad(bytes, 64, 8), w = new Int32Array(64);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getInt32(offset + 4 * t);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15], b = w[t - 2];
      const s0 = (a >>> 7 | a << 25) ^ (a >>> 18 | a << 14) ^ a >>> 3, s1 = (b >>> 17 | b << 15) ^ (b >>> 19 | b << 13) ^ b >>> 10;
      w[t] = w[t - 16] + s0 + w[t - 7] + s1 | 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7), ch = e & f ^ ~e & g;
      const t1 = k + S1 + ch + K256[t] + w[t] | 0;
      const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10), maj = a & b ^ a & c ^ b & c;
      const t2 = S0 + maj | 0;
      k = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0;
    }
    [a, b, c, d, e, f, g, k].forEach((v, i) => { h[i] = h[i] + v | 0; });
  }
  const out = new Uint8Array(32), outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setInt32(4 * i, h[i]);
  return out;
}

function sha1(bytes) {
  const h = Int32Array.from([0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]), view = pad(bytes, 64, 8), w = new Int32Array(80);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getInt32(offset + 4 * t);
    for (let t = 16; t < 80; t++) { const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; w[t] = x << 1 | x >>> 31; }
    let [a, b, c, d, e] = h;
    for (let t = 0; t < 80; t++) {
      const [f, k] = t < 20 ? [b & c | ~b & d, 0x5A827999] : t < 40 ? [b ^ c ^ d, 0x6ED9EBA1] : t < 60 ? [b & c | b & d | c & d, 0x8F1BBCDC] : [b ^ c ^ d, 0xCA62C1D6];
      const temp = (a << 5 | a >>> 27) + f + e + k + w[t] | 0;
      e = d; d = c; c = b << 30 | b >>> 2; b = a; a = temp;
    }
    [a, b, c, d, e].forEach((v, i) => { h[i] = h[i] + v | 0; });
  }
  const out = new Uint8Array(20), outView = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) outView.setInt32(4 * i, h[i]);
  return out;
}

/** Digest `bytes` with 'SHA-1', 'SHA-256', 'SHA-384' or 'SHA-512'. */
export function digest(algorithm, bytes) {
  switch (algorithm) {
    case 'SHA-512': return sha512(bytes, IV512);
    case 'SHA-384': return sha512(bytes, IV384).slice(0, 48);
    case 'SHA-256': return sha256(bytes);
    case 'SHA-1': return sha1(bytes);
    default: throw new Error(`Unsupported hash algorithm: ${algorithm}.`);
  }
}
