// Automatic bounds of XY (scatter and bubble) value axes, as spreadsheet
// charts choose them.

/** The smallest 1-2-5 unit that spans [lo, hi] in at most `most` intervals. */
export const autoMajorUnit = (lo: number, hi: number, most = 10): number => {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  let unit = 10 ** Math.floor(Math.log10(span / most));
  for (let guard = 0; guard < 64; guard++) {
    for (const m of [1, 2, 5]) {
      const u = unit * m;
      if (Math.ceil(hi / u - 1e-9) - Math.floor(lo / u + 1e-9) <= most)
        return u;
    }
    unit *= 10;
  }
  return span;
};

/**
 * Bounds and major unit of an axis over data from `lo` to `hi`: zero is
 * kept when the data sit on one side of it and spread over more than a
 * sixth of their extent; otherwise the ends get 5% headroom. The ends are
 * whole units, with at most ten intervals between them.
 */
export const autoValueScale = (
  lo: number,
  hi: number,
): { min: number; max: number; unit: number } => {
  if (!Number.isFinite(lo) || !Number.isFinite(hi))
    return { min: 0, max: 1, unit: 0.2 };
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    if (lo === 0) return { min: 0, max: 1, unit: 0.2 };
    // A single value: the axis runs from zero to it.
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  const spread = hi - lo;
  const fromZero = lo >= 0 && spread / hi > 1 / 6;
  const toZero = hi <= 0 && spread / -lo > 1 / 6;
  const low = fromZero ? 0 : lo - spread * 0.05,
    high = toZero ? 0 : hi + spread * 0.05;
  const unit = autoMajorUnit(low, high);
  return {
    min: fromZero ? 0 : Math.floor(low / unit + 1e-9) * unit,
    max: toZero ? 0 : Math.ceil(high / unit - 1e-9) * unit,
    unit,
  };
};

/**
 * Bubble axes also make room for the bubbles: each point extends by its
 * radius, given as a fraction of the axis span (`radius(i)`), worked out
 * against the span it produces until that settles.
 */
export const autoBubbleScale = (
  values: ReadonlyArray<number>,
  radius: (i: number) => number,
): { min: number; max: number; unit: number } => {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { min: 0, max: 1, unit: 0.2 };
  let scale = autoValueScale(Math.min(...finite), Math.max(...finite));
  for (let pass = 0; pass < 4; pass++) {
    const span = scale.max - scale.min;
    let lo = Infinity,
      hi = -Infinity;
    values.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const r = radius(i) * span;
      lo = Math.min(lo, v - r);
      hi = Math.max(hi, v + r);
    });
    const next = autoValueScale(lo, hi);
    if (next.min === scale.min && next.max === scale.max) return next;
    scale = next;
  }
  return scale;
};
