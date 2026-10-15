// Pixel reconstruction filters for anti-aliasing. Instead of weighting samples, each sample's
// sub-pixel offset is drawn from the filter's distribution (importance sampling), so a plain
// running average of the samples equals the filtered image. Shared by the realtime engine
// (jittered projection) and the path tracer (camera ray jitter).

export type PixelFilter = 'BOX' | 'GAUSSIAN' | 'BLACKMAN_HARRIS';

/** Half extent (pixels) of the filter's support. The box filter always covers one pixel. */
export function filterRadius(type: PixelFilter, width: number): number {
  return type === 'BOX' ? 0.5 : Math.max(1e-4, width);
}

/**
 * Unnormalised filter weight at offset `x` (pixels). `width` sets the filter's size: the
 * Gaussian has σ = width / 4 and both smooth filters reach zero at ±width.
 */
export function filterWeight(type: PixelFilter, x: number, width: number): number {
  const r = filterRadius(type, width);
  if (Math.abs(x) > r) return 0;
  switch (type) {
    case 'BOX':
      return 1;
    case 'GAUSSIAN': {
      const s = r / 4;
      return Math.exp(-(x * x) / (2 * s * s));
    }
    default: {
      // four-term Blackman-Harris window over the support
      const t = 2 * Math.PI * (x / (2 * r) + 0.5);
      return 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
    }
  }
}

/** Number of entries of the inverse-CDF table (uniform → offset). */
export const FILTER_TABLE_SIZE = 64;

/**
 * Inverse cumulative distribution of the filter: entry k is the offset (pixels) below which a
 * fraction k / (N - 1) of the filter's weight lies. Sampling u ∈ [0,1] by linear interpolation
 * gives offsets distributed like the filter.
 */
export function filterTable(type: PixelFilter, width: number, size = FILTER_TABLE_SIZE): Float32Array {
  const r = filterRadius(type, width);
  const w = 2 * r;
  const bins = 1024;
  const cdf = new Float64Array(bins + 1);
  for (let i = 0; i < bins; i++) {
    const x = -r + ((i + 0.5) / bins) * w;
    cdf[i + 1] = cdf[i] + Math.max(0, filterWeight(type, x, width));
  }
  const total = cdf[bins] || 1;
  const out = new Float32Array(size);
  let j = 0;
  for (let k = 0; k < size; k++) {
    const target = (k / (size - 1)) * total;
    while (j < bins - 1 && cdf[j + 1] < target) j++;
    const a = cdf[j],
      b = cdf[j + 1];
    const f = b > a ? (target - a) / (b - a) : 0;
    out[k] = -r + ((j + Math.min(1, Math.max(0, f))) / bins) * w;
  }
  return out;
}

/** Offset (pixels) for a uniform random number `u` ∈ [0,1]. */
export function sampleFilter(table: Float32Array, u: number): number {
  const n = table.length - 1;
  const x = Math.min(n, Math.max(0, u * n));
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  return table[i] * (1 - f) + table[i + 1] * f;
}

/** GLSL lookup into the table uploaded as `uniform float <name>[FILTER_TABLE_SIZE]`. */
export function filterGLSL(name: string): string {
  const n = FILTER_TABLE_SIZE;
  return /* glsl */ `
    uniform float ${name}[${n}];
    float ${name}Sample(float u) {
      float x = clamp(u, 0.0, 1.0) * ${n - 1}.0;
      int i = int(min(floor(x), ${n - 2}.0));
      float f = x - float(i);
      return mix(${name}[i], ${name}[i + 1], f);
    }`;
}
