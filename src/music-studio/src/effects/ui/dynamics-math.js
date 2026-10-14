// Static transfer curves for the dynamics effects (the compressor and limiter
// editors draw these). Feed-forward, hard ratio above a soft knee centred on
// the threshold, the standard quadratic knee interpolation:
//
//   x - T < -W/2           y = x
//   |x - T| <= W/2         y = x + (1/R - 1) (x - T + W/2)^2 / (2W)
//   x - T >  W/2           y = T + (x - T) / R
//
// then makeup gain. All values in dB.

/** Compressor output level (dB) for an input level (dB). */
export function compressorOut(x, { threshold = -18, ratio = 4, knee = 6, makeup = 0 } = {}) {
  const T = threshold;
  const R = Math.max(1, ratio);
  const W = Math.max(0, knee);
  const d = x - T;
  let y;
  if (W > 0 && Math.abs(d) <= W / 2) y = x + ((1 / R - 1) * (d + W / 2) ** 2) / (2 * W);
  else if (d > 0) y = T + d / R;
  else y = x;
  return y + makeup;
}

/** Gain reduction (dB, positive) the compressor applies at input `x`, before makeup. */
export function compressorReduction(x, params) {
  return x - compressorOut(x, { ...params, makeup: 0 });
}

/** Limiter output (dB): input gain, then a hard ceiling. */
export function limiterOut(x, { input = 0, ceiling = -0.3 } = {}) {
  return Math.min(x + input, ceiling);
}
