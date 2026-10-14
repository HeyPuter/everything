// Trendline fits for chart series: least-squares regressions on the data's
// own x values (category charts use 1, 2, 3...), as spreadsheet charts fit
// them, with the equation and R² they show beside the line.

export type TrendlineType =
  "linear" | "exp" | "log" | "poly" | "power" | "movingAvg";

export interface TrendlineFit {
  /** The fitted curve, or null for a moving average. */
  readonly at: ((x: number) => number) | null;
  /** Moving-average points (data units), when the type is movingAvg. */
  readonly points: ReadonlyArray<readonly [number, number]>;
  /** The equation as display parts: plain text and superscripts. */
  readonly equation: ReadonlyArray<{ text: string; sup?: boolean }>;
  readonly rSquared: number | null;
  /** Whether the curve bends (draw it sampled, not as a segment). */
  readonly curved: boolean;
}

/** Solves A·x = b by Gaussian elimination with partial pivoting. */
const solve = (A: number[][], b: number[]): number[] | null => {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-12) return null;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = m[r]![c]! / m[c]![c]!;
      for (let j = c; j <= n; j++) m[r]![j]! -= k * m[c]![j]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
};

/** Least-squares polynomial coefficients, constant term first. */
export const polyFit = (
  xs: ReadonlyArray<number>,
  ys: ReadonlyArray<number>,
  order: number,
): number[] | null => {
  const k = Math.max(1, Math.min(6, Math.floor(order), xs.length - 1));
  const A = Array.from({ length: k + 1 }, (_, i) =>
    Array.from({ length: k + 1 }, (_, j) =>
      xs.reduce((s, x) => s + x ** (i + j), 0),
    ),
  );
  const b = Array.from({ length: k + 1 }, (_, i) =>
    xs.reduce((s, x, n) => s + ys[n]! * x ** i, 0),
  );
  return solve(A, b);
};

const rSquared = (
  ys: ReadonlyArray<number>,
  fitted: ReadonlyArray<number>,
): number => {
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const total = ys.reduce((s, y) => s + (y - mean) ** 2, 0);
  const residual = ys.reduce((s, y, i) => s + (y - fitted[i]!) ** 2, 0);
  return total === 0 ? 1 : 1 - residual / total;
};

/** A coefficient as spreadsheet charts print it: four decimals, trimmed. */
export const formatCoefficient = (v: number): string => {
  if (!Number.isFinite(v)) return "0";
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-4)) {
    const [m, e] = v.toExponential(4).split("e");
    return `${String(Number(m))}E${Number(e) >= 0 ? "+" : ""}${Number(e)}`;
  }
  const s = v.toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

const SUPERSCRIPT: Record<string, string> = {
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
};

/** Joins signed terms: "y = a + b" with minus signs folded in. */
const terms = (
  parts: ReadonlyArray<{
    value: number;
    tail: Array<{ text: string; sup?: boolean }>;
  }>,
): Array<{ text: string; sup?: boolean }> => {
  const out: Array<{ text: string; sup?: boolean }> = [{ text: "y = " }];
  parts.forEach(({ value, tail }, i) => {
    const sign = value < 0 ? "-" : "+";
    const abs = formatCoefficient(Math.abs(value));
    out.push({
      text: i === 0 ? `${value < 0 ? "-" : ""}${abs}` : ` ${sign} ${abs}`,
    });
    out.push(...tail);
  });
  return out;
};

/**
 * Fits a trendline of `type` through the points (`xs` in data units).
 * Exponential and power fits need positive values (and power positive x,
 * log positive x); without them the fit falls back to a straight line.
 */
export const fitTrendline = (
  type: string,
  xs: ReadonlyArray<number>,
  ys: ReadonlyArray<number>,
  opts: { order?: number; period?: number } = {},
): TrendlineFit => {
  const n = xs.length;
  const linear = (): TrendlineFit => {
    const c = polyFit(xs, ys, 1) ?? [ys.reduce((a, b) => a + b, 0) / n, 0];
    const at = (x: number) => c[0]! + c[1]! * x;
    return {
      at,
      points: [],
      equation: terms([
        { value: c[1]!, tail: [{ text: "x" }] },
        { value: c[0]!, tail: [] },
      ]),
      rSquared: rSquared(ys, xs.map(at)),
      curved: false,
    };
  };
  switch (type) {
    case "movingAvg": {
      const period = Math.max(2, Math.min(n, opts.period ?? 2));
      const points: Array<[number, number]> = [];
      for (let i = period - 1; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += ys[i - j]!;
        points.push([xs[i]!, sum / period]);
      }
      return { at: null, points, equation: [], rSquared: null, curved: false };
    }
    case "poly": {
      const c = polyFit(xs, ys, opts.order ?? 2);
      if (!c) return linear();
      const at = (x: number) => c.reduce((s, v, i) => s + v * x ** i, 0);
      const parts = c
        .map((value, i) => ({
          value,
          tail:
            i === 0
              ? []
              : i === 1
                ? [{ text: "x" }]
                : [{ text: `x${SUPERSCRIPT[String(i)] ?? `^${i}`}` }],
        }))
        .reverse();
      return {
        at,
        points: [],
        equation: terms(parts),
        rSquared: rSquared(ys, xs.map(at)),
        curved: c.length > 2,
      };
    }
    case "exp": {
      if (!ys.every((y) => y > 0)) return linear();
      const c = polyFit(
        xs,
        ys.map((y) => Math.log(y)),
        1,
      );
      if (!c) return linear();
      const a = Math.exp(c[0]!),
        b = c[1]!;
      const at = (x: number) => a * Math.exp(b * x);
      return {
        at,
        points: [],
        equation: [
          { text: `y = ${formatCoefficient(a)}e` },
          { text: `${formatCoefficient(b)}x`, sup: true },
        ],
        // Spreadsheet charts report R² of the linearized fit.
        rSquared: rSquared(
          ys.map((y) => Math.log(y)),
          xs.map((x) => c[0]! + b * x),
        ),
        curved: true,
      };
    }
    case "log": {
      if (!xs.every((x) => x > 0)) return linear();
      const lx = xs.map((x) => Math.log(x));
      const c = polyFit(lx, ys, 1);
      if (!c) return linear();
      const at = (x: number) => c[0]! + c[1]! * Math.log(x);
      return {
        at: (x) => (x > 0 ? at(x) : NaN),
        points: [],
        equation: terms([
          { value: c[1]!, tail: [{ text: "ln(x)" }] },
          { value: c[0]!, tail: [] },
        ]),
        rSquared: rSquared(ys, xs.map(at)),
        curved: true,
      };
    }
    case "power": {
      if (!xs.every((x) => x > 0) || !ys.every((y) => y > 0)) return linear();
      const lx = xs.map((x) => Math.log(x)),
        ly = ys.map((y) => Math.log(y));
      const c = polyFit(lx, ly, 1);
      if (!c) return linear();
      const a = Math.exp(c[0]!),
        b = c[1]!;
      return {
        at: (x) => (x > 0 ? a * x ** b : NaN),
        points: [],
        equation: [
          { text: `y = ${formatCoefficient(a)}x` },
          { text: formatCoefficient(b), sup: true },
        ],
        rSquared: rSquared(
          ly,
          lx.map((x) => c[0]! + b * x),
        ),
        curved: true,
      };
    }
    default:
      return linear();
  }
};

/**
 * The trendline's points in data units: the data's x span extended by
 * `backward` / `forward` (in x units), sampled densely when it bends.
 */
export const trendlineSamples = (
  fit: TrendlineFit,
  xs: ReadonlyArray<number>,
  extend: { forward?: number; backward?: number } = {},
): Array<readonly [number, number]> => {
  if (!fit.at) return [...fit.points];
  const lo = Math.min(...xs) - (extend.backward ?? 0),
    hi = Math.max(...xs) + (extend.forward ?? 0);
  const steps = fit.curved ? 64 : 1;
  const out: Array<readonly [number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const x = lo + ((hi - lo) * i) / steps;
    const y = fit.at(x);
    if (Number.isFinite(y)) out.push([x, y]);
  }
  return out;
};
