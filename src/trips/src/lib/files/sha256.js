// SHA-256 over a Blob read in slices, for files too large to hold in memory at once (videos up to 500 MB).
// WebCrypto has no incremental digest, so this is a plain implementation of FIPS 180-4.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function createSha256() {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const tail = new Uint8Array(64);
  let used = 0;
  let total = 0;
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  function compress(bytes, offset) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]; const b = w[i - 2];
      w[i] = (w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
  }

  return {
    update(bytes) {
      total += bytes.length;
      let offset = 0;
      if (used) {
        const take = Math.min(64 - used, bytes.length);
        tail.set(bytes.subarray(0, take), used);
        used += take; offset = take;
        if (used < 64) return;
        compress(tail, 0); used = 0;
      }
      for (; offset + 64 <= bytes.length; offset += 64) compress(bytes, offset);
      tail.set(bytes.subarray(offset), 0);
      used = bytes.length - offset;
    },
    hex() {
      const bits = total * 8;
      const pad = new Uint8Array((used < 56 ? 56 : 120) - used + 8);
      pad[0] = 0x80;
      const view = new DataView(pad.buffer);
      view.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32));
      view.setUint32(pad.length - 4, bits >>> 0);
      this.update(pad);
      return [...h].map((word) => word.toString(16).padStart(8, '0')).join('');
    },
  };
}

/** Hex SHA-256 of a Blob, reading `chunk` bytes at a time. */
export async function sha256Stream(blob, { chunk = 4 * 1024 * 1024 } = {}) {
  const hash = createSha256();
  for (let start = 0; start < blob.size; start += chunk) hash.update(new Uint8Array(await blob.slice(start, start + chunk).arrayBuffer()));
  return hash.hex();
}
