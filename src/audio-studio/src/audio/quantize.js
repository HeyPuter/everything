// Float to integer sample conversion with optional dither, shared by every
// integer encoder (WAV, AIFF, FLAC, MP3). Full scale is 2^(bits-1), so a
// value written as k / 2^(bits-1) reads back exactly.
//
// Dither modes:
//   none        plain rounding (truncation distortion on quiet material)
//   triangular  TPDF dither of +/- 1 LSB, the usual choice
//   shaped      TPDF dither with first-order noise shaping, which moves the
//               requantization noise towards high frequencies

export const DITHER_MODES = [
  { id: 'none', label: 'No Dither' },
  { id: 'triangular', label: 'Triangular' },
  { id: 'shaped', label: 'Triangular, Noise Shaped' },
];

export class Quantizer {
  /**
   * @param {number} bits 8 to 32 (integer output)
   * @param {number} channels
   * @param {'none'|'triangular'|'shaped'} dither
   */
  constructor(bits, channels, dither = 'triangular', seed = 0x9e3779b9) {
    this.bits = bits;
    this.scale = 2 ** (bits - 1);
    this.max = this.scale - 1;
    this.min = -this.scale;
    this.dither = bits >= 24 && dither === 'shaped' ? 'triangular' : dither;
    this.error = new Float64Array(channels);
    this.seed = seed >>> 0 || 1;
  }

  #rand() {
    // xorshift32, uniform in [0, 1).
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  /**
   * Converts src[0, n) of channel `c` into integers written to
   * out[offset + i * stride].
   */
  convert(c, src, n, out, offset = 0, stride = 1) {
    const { scale, max, min } = this;
    const mode = this.dither;
    let err = this.error[c];
    for (let i = 0, o = offset; i < n; i++, o += stride) {
      let v = src[i];
      if (!(v === v)) v = 0; // NaN reads as silence
      let x = v * scale;
      let q = Math.round(x);
      // Samples already on the output grid (untouched 16-bit audio saved as
      // 16-bit, digital silence) pass through exactly: dither only where
      // there is something to requantize.
      const onGrid = x - q < 1e-7 && q - x < 1e-7;
      if (mode === 'none' || onGrid) {
        if (onGrid) err = 0;
      } else if (mode === 'triangular') {
        q = Math.round(x + this.#rand() - this.#rand());
      } else {
        x -= err;
        q = Math.round(x + this.#rand() - this.#rand());
        err = q - x;
        // Keep the loop stable after clipping; an infinite sample leaves NaN, which would
        // otherwise silence every later sample of the channel.
        if (!(err <= 4 && err >= -4)) err = 0;
      }
      out[o] = q > max ? max : q < min ? min : q;
    }
    this.error[c] = err;
  }
}
