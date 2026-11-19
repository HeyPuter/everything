// Per-kind color math. Each adjustment becomes a Plan: an optional separable
// curve stage (composite RGB map, then per-channel maps) followed by an
// optional per-pixel color function. The exact CPU path evaluates the plan
// directly; compileAdjustment samples curves into 1D tables and the color
// function into a 3D LUT for the GPU.
import { curveFunction, gain, isIdentityCurve, isIdentityLevels, levelsFunction, type Fn1 } from './curves';
import {
  clamp,
  clamp01,
  hslToRgb,
  linearToSrgb,
  linearToSrgbFast,
  luma,
  LUMA_B,
  LUMA_G,
  LUMA_R,
  srgbToLinear,
  srgbToLinearFast,
} from './color-math';
import { gradientTable } from './gradient-stops';
import { parseCubeLut, sampleCubeLut, type CubeLut } from './cube';
import { builtinLook, type LookFn } from './looks';
import { HUE_RANGES, SELECTIVE_RANGES, type Adjustment, type AdjustmentParamsMap, type LookSource } from './model';

// Color function over n RGB triples (stride 3, floats in [0, 1]). Each kind
// owns its loop so the hot path stays monomorphic and inlinable in V8.
export type PixelFn = (inp: Float64Array, out: Float64Array, n: number) => void;
export type Plan = {
  curves?: { rgb?: Fn1; r?: Fn1; g?: Fn1; b?: Fn1 };
  pixel?: PixelFn;
  // Alternative factoring for compilers that support curves after the 3D LUT:
  // `pixel` here is linear in RGB (exact under trilinear sampling) and `post`
  // carries the discontinuous part (Threshold, Gradient Map).
  split?: { pixel: PixelFn; post: { r: Fn1; g: Fn1; b: Fn1 } };
  // Ordered dithering before quantization (exact path only; position-dependent).
  dither?: boolean;
  // The 3D LUT is a known approximation (hard edges inside one grid cell).
  approximate?: boolean;
};

const EMPTY: Plan = {};
// Parameters may come from JSON or old files: non-finite values count as 0.
const fin = (v: number, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const pct = (v: number, lo = -100, hi = 100) => clamp(fin(Number(v)), lo, hi) / 100;

function brightnessContrast(p: AdjustmentParamsMap['brightness-contrast']): Plan {
  if (!p.brightness && !p.contrast) return EMPTY;
  if (p.legacy) {
    // Linear offset and slope around mid-gray, clipping at the ends.
    const off = clamp(fin(p.brightness), -150, 150) / 255;
    const c = pct(p.contrast);
    const k = c >= 0 ? 1 / Math.max(0.01, 1 - c) : 1 + c;
    return { curves: { rgb: (x) => clamp01((x + off - 0.5) * k + 0.5) } };
  }
  // Modern mode keeps black and white fixed: brightness is a power curve
  // (+150 = exponent 0.5) and contrast an S-curve around mid-gray.
  const power = Math.pow(2, -clamp(fin(p.brightness), -150, 150) / 150);
  const c = clamp(fin(p.contrast), -50, 100);
  const g = c >= 0 ? 0.5 + (c / 100) * 0.35 : 0.5 + (c / 50) * 0.25;
  return { curves: { rgb: (x) => clamp01(gain(power === 1 ? x : Math.pow(clamp01(x), power), g)) } };
}

function levels(p: AdjustmentParamsMap['levels']): Plan {
  const curves: Plan['curves'] = {};
  for (const k of ['rgb', 'r', 'g', 'b'] as const) if (!isIdentityLevels(p[k])) curves[k] = levelsFunction(p[k]);
  return Object.keys(curves).length ? { curves } : EMPTY;
}

function curves(p: AdjustmentParamsMap['curves']): Plan {
  const curves: Plan['curves'] = {};
  for (const k of ['rgb', 'r', 'g', 'b'] as const) if (!isIdentityCurve(p[k])) curves[k] = curveFunction(p[k]);
  return Object.keys(curves).length ? { curves } : EMPTY;
}

function exposure(p: AdjustmentParamsMap['exposure']): Plan {
  const e = clamp(fin(p.exposure), -20, 20),
    off = clamp(fin(p.offset), -0.5, 0.5),
    g = clamp(fin(p.gamma, 1) || 1, 0.01, 9.99);
  if (!e && !off && g === 1) return EMPTY;
  const mul = Math.pow(2, e),
    inv = 1 / g;
  // Exposure and offset act on linear light; gamma bends the result.
  return {
    curves: {
      rgb: (x) => {
        let v = srgbToLinear(x) * mul + off;
        v = v <= 0 ? 0 : inv === 1 ? v : Math.pow(v, inv);
        return clamp01(linearToSrgb(v));
      },
    },
  };
}

function hueOf(r: number, g: number, b: number, max: number, d: number): number {
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return h * 60;
}

function vibrance(p: AdjustmentParamsMap['vibrance']): Plan {
  const v = pct(p.vibrance),
    s = pct(p.saturation);
  if (!v && !s) return EMPTY;
  return {
    pixel: (inp, out, n) => {
      for (let j = 0, e = n * 3; j < e; j += 3) {
        const r = inp[j],
          g = inp[j + 1],
          b = inp[j + 2];
        const max = r > g ? (r > b ? r : b) : g > b ? g : b;
        const min = r < g ? (r < b ? r : b) : g < b ? g : b;
        const l = luma(r, g, b);
        let k = 1 + s;
        if (v !== 0 && max > min) {
          // Vibrance boosts muted colors most and saturated colors barely.
          let amt = v * (1 - (max - min) / max);
          if (v > 0) {
            // Skin tones (orange, around 28 degrees) receive at most half the boost.
            let dist = Math.abs(hueOf(r, g, b, max, max - min) - 28);
            if (dist > 180) dist = 360 - dist;
            if (dist < 35) amt *= 1 - 0.25 * (1 + Math.cos((Math.PI * dist) / 35));
          }
          // (A hard stop at the gamut boundary was tried: it makes the result
          // jump within a few codes of white, which no 3D LUT can follow.)
          k *= 1 + amt;
        }
        out[j] = clamp01(l + (r - l) * k);
        out[j + 1] = clamp01(l + (g - l) * k);
        out[j + 2] = clamp01(l + (b - l) * k);
      }
    },
  };
}

// Trapezoid membership on the hue circle; ranges may wrap through 0 degrees.
export function hueRangeWeight(h: number, range: readonly [number, number, number, number]): number {
  const mod = (v: number) => ((v % 360) + 360) % 360;
  const [a, b, c, d] = range;
  const ab = mod(b - a),
    bc = mod(c - b),
    cd = mod(d - c);
  const x = mod(h - a);
  if (x < ab) return x / ab;
  if (x <= ab + bc) return 1;
  if (x < ab + bc + cd) return 1 - (x - ab - bc) / cd;
  return 0;
}

const HUE_STEPS = 4; // table entries per degree
const applySat = (s: number, a: number) => (a === 0 ? s : clamp01(s * (1 + a)));
const applyLight = (c: number, a: number) => (a > 0 ? c + (1 - c) * a : c * (1 + a));

function hueSaturation(p: AdjustmentParamsMap['hue-saturation']): Plan {
  const mh = clamp(fin(p.master.hue), -180, 180),
    ms = pct(p.master.saturation),
    ml = pct(p.master.lightness);
  const tmp = new Float64Array(3);
  if (p.colorize) {
    const hue = (((Number(p.colorizeHue) || 0) % 360) + 360) % 360,
      sat = pct(p.colorizeSaturation, 0, 100);
    return {
      pixel: (inp, out, n) => {
        for (let j = 0, e = n * 3; j < e; j += 3) {
          const r = inp[j],
            g = inp[j + 1],
            b = inp[j + 2];
          hslToRgb(hue, sat, luma(r, g, b), tmp);
          out[j] = clamp01(applyLight(tmp[0], ml));
          out[j + 1] = clamp01(applyLight(tmp[1], ml));
          out[j + 2] = clamp01(applyLight(tmp[2], ml));
        }
      },
    };
  }
  const active = HUE_RANGES.filter((n) => {
    const q = p.ranges[n];
    return q && (q.hue || q.saturation || q.lightness);
  });
  if (!mh && !ms && !ml && !active.length) return EMPTY;
  // Weighted per-range amounts sampled every quarter degree; linear
  // interpolation keeps them continuous in hue.
  const n = 360 * HUE_STEPS;
  const hueT = new Float32Array(n + 1),
    satT = new Float32Array(n + 1),
    lightT = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const h = i / HUE_STEPS;
    for (const name of active) {
      const q = p.ranges[name],
        w = hueRangeWeight(h, q.range);
      if (!w) continue;
      hueT[i] += w * clamp(fin(q.hue), -180, 180);
      satT[i] += w * pct(q.saturation);
      lightT[i] += w * pct(q.lightness);
    }
  }
  const hasRanges = active.length > 0;
  return {
    pixel: (inp, out, n) => {
      for (let j = 0, e = n * 3; j < e; j += 3) {
        const r = inp[j],
          g = inp[j + 1],
          b = inp[j + 2];
        const max = r > g ? (r > b ? r : b) : g > b ? g : b;
        const min = r < g ? (r < b ? r : b) : g < b ? g : b;
        const d = max - min,
          l = (max + min) / 2;
        if (d <= 0) {
          // Gray has no hue: only lightness applies.
          out[j] = out[j + 1] = out[j + 2] = clamp01(applyLight(r, ml));
          continue;
        }
        const s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
        const h = hueOf(r, g, b, max, d);
        let dh = mh,
          ss = s,
          rl = 0;
        if (hasRanges) {
          const x = h * HUE_STEPS,
            i = x | 0,
            f = x - i;
          dh += hueT[i] + (hueT[i + 1] - hueT[i]) * f;
          ss = applySat(ss, satT[i] + (satT[i + 1] - satT[i]) * f);
          // Range lightness fades out toward gray, where hue is meaningless.
          const t = d * 4 >= 1 ? 1 : d * 4;
          rl = (lightT[i] + (lightT[i + 1] - lightT[i]) * f) * t * t * (3 - 2 * t);
        }
        ss = applySat(ss, ms);
        hslToRgb(h + dh, ss, l, tmp);
        for (let k = 0; k < 3; k++) {
          let c = tmp[k];
          if (rl) c = applyLight(c, rl);
          if (ml) c = applyLight(c, ml);
          out[j + k] = clamp01(c);
        }
      }
    },
  };
}

const BALANCE_STRENGTH = 0.4;
function colorBalance(p: AdjustmentParamsMap['color-balance']): Plan {
  const S = p.shadows.map((v) => pct(v) * BALANCE_STRENGTH),
    M = p.midtones.map((v) => pct(v) * BALANCE_STRENGTH),
    H = p.highlights.map((v) => pct(v) * BALANCE_STRENGTH);
  if (![...S, ...M, ...H].some((v) => v)) return EMPTY;
  const keep = p.preserveLuminosity;
  return {
    pixel: (inp, out, n) => {
      for (let j = 0, e = n * 3; j < e; j += 3) {
        const r = inp[j],
          g = inp[j + 1],
          b = inp[j + 2];
        // Smooth tonal weights from luma: shadows peak at black, midtones at
        // mid-gray, highlights at white.
        const l = luma(r, g, b),
          ws = (1 - l) * (1 - l),
          wm = 4 * l * (1 - l),
          wh = l * l;
        let nr = clamp01(r + ws * S[0] + wm * M[0] + wh * H[0]);
        let ng = clamp01(g + ws * S[1] + wm * M[1] + wh * H[1]);
        let nb = clamp01(b + ws * S[2] + wm * M[2] + wh * H[2]);
        if (keep) {
          const dl = l - luma(nr, ng, nb);
          (nr += dl), (ng += dl), (nb += dl);
        }
        out[j] = clamp01(nr);
        out[j + 1] = clamp01(ng);
        out[j + 2] = clamp01(nb);
      }
    },
  };
}

// Gray = min + (mid - min) * secondary weight + (max - mid) * primary weight,
// where the primary is the hue of the largest channel and the secondary the
// mix of the two largest. With LUMA_GRAY_WEIGHTS this equals Rec. 709 luma.
function grayMixer(w: Record<(typeof HUE_RANGES)[number], number>) {
  const R = w.reds / 100,
    Y = w.yellows / 100,
    G = w.greens / 100,
    C = w.cyans / 100,
    B = w.blues / 100,
    M = w.magentas / 100;
  return (r: number, g: number, b: number) => {
    if (r >= g) {
      if (g >= b) return b + (g - b) * Y + (r - g) * R; // r >= g >= b
      if (r >= b) return g + (b - g) * M + (r - b) * R; // r >= b > g
      return g + (r - g) * M + (b - r) * B; // b > r >= g
    }
    if (r >= b) return b + (r - b) * Y + (g - r) * G; // g > r >= b
    if (g >= b) return r + (b - r) * C + (g - b) * G; // g >= b > r
    return r + (g - r) * C + (b - g) * B; // b > g > r
  };
}

function blackWhite(p: AdjustmentParamsMap['black-white']): Plan {
  const mix = grayMixer(p);
  const tint = p.tint,
    th = p.tintHue,
    ts = pct(p.tintSaturation, 0, 100);
  const tmp = new Float64Array(3);
  return {
    pixel: (inp, out, n) => {
      for (let j = 0, e = n * 3; j < e; j += 3) {
        const r = inp[j],
          g = inp[j + 1],
          b = inp[j + 2];
        const v = clamp01(mix(r, g, b));
        if (tint) {
          hslToRgb(th, ts, v, tmp);
          (out[j] = tmp[0]), (out[j + 1] = tmp[1]), (out[j + 2] = tmp[2]);
        } else out[j] = out[j + 1] = out[j + 2] = v;
      }
    },
  };
}

function photoFilter(p: AdjustmentParamsMap['photo-filter']): Plan {
  const d = pct(p.density, 0, 100);
  if (!d) return EMPTY;
  // A filter multiplies light: gains interpolate from 1 toward the filter color in linear light.
  const gains = p.color.map((c) => 1 + d * (srgbToLinear(clamp(c, 0, 255) / 255) - 1));
  if (!p.preserveLuminosity) {
    const ch = (k: number): Fn1 => (x) => clamp01(linearToSrgb(srgbToLinear(x) * gains[k]));
    return { curves: { r: ch(0), g: ch(1), b: ch(2) } };
  }
  const [gr, gg, gb] = gains;
  return {
    pixel: (inp, out, n) => {
      for (let j = 0, e = n * 3; j < e; j += 3) {
        const r = inp[j],
          g = inp[j + 1],
          b = inp[j + 2];
        const lr = srgbToLinearFast(r),
          lg = srgbToLinearFast(g),
          lb = srgbToLinearFast(b);
        const yin = LUMA_R * lr + LUMA_G * lg + LUMA_B * lb;
        const nr = lr * gr,
          ng = lg * gg,
          nb = lb * gb;
        const yout = LUMA_R * nr + LUMA_G * ng + LUMA_B * nb;
        const k = yout > 1e-9 ? yin / yout : 1;
        out[j] = linearToSrgbFast(nr * k);
        out[j + 1] = linearToSrgbFast(ng * k);
        out[j + 2] = linearToSrgbFast(nb * k);
      }
    },
  };
}

function channelMixer(p: AdjustmentParamsMap['channel-mixer']): Plan {
  const rows = p.monochrome ? [p.gray, p.gray, p.gray] : [p.red, p.green, p.blue];
  const m = rows.flatMap((row) => [row.r, row.g, row.b, row.constant].map((v) => clamp(Number(v) || 0, -200, 200) / 100));
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  if (m.every((v, i) => v === identity[i])) return EMPTY;
  return {
    pixel: (inp, out, n) => {
      for (let j = 0, e = n * 3; j < e; j += 3) {
        const r = inp[j],
          g = inp[j + 1],
          b = inp[j + 2];
        out[j] = clamp01(m[0] * r + m[1] * g + m[2] * b + m[3]);
        out[j + 1] = clamp01(m[4] * r + m[5] * g + m[6] * b + m[7]);
        out[j + 2] = clamp01(m[8] * r + m[9] * g + m[10] * b + m[11]);
      }
    },
  };
}

// Parsed .cube files keyed by their text, so re-rendering a layer is cheap.
const cubeCache = new Map<string, CubeLut>();
export function resolveLookSource(source: LookSource): CubeLut | LookFn | undefined {
  if (source.type === 'builtin') return builtinLook(source.id);
  if (source.type === 'lut') return source.lut;
  let lut = cubeCache.get(source.text);
  if (!lut) {
    lut = parseCubeLut(source.text);
    if (cubeCache.size >= 8) cubeCache.delete(cubeCache.keys().next().value!);
    cubeCache.set(source.text, lut);
  }
  return lut;
}

function colorLookup(p: AdjustmentParamsMap['color-lookup']): Plan {
  const a = pct(p.amount, 0, 100);
  if (!p.source || !a) return EMPTY;
  const look = resolveLookSource(p.source);
  if (!look) return EMPTY;
  const t = new Float64Array(3);
  if (typeof look !== 'function' && look.kind === '1d' && !look.shaper) {
    const ch = (k: number): Fn1 => (x) => {
      sampleCubeLut(look, x, x, x, t);
      return clamp01(x + (t[k] - x) * a);
    };
    return { curves: { r: ch(0), g: ch(1), b: ch(2) } };
  }
  const fn: LookFn = typeof look === 'function' ? look : (r, g, b, o) => void sampleCubeLut(look, r, g, b, o);
  return {
    pixel: (inp, out, n) => {
      for (let j = 0, e = n * 3; j < e; j += 3) {
        const r = inp[j],
          g = inp[j + 1],
          b = inp[j + 2];
        fn(r, g, b, t);
        out[j] = clamp01(r + (t[0] - r) * a);
        out[j + 1] = clamp01(g + (t[1] - g) * a);
        out[j + 2] = clamp01(b + (t[2] - b) * a);
      }
    },
  };
}

const grayPixel: PixelFn = (inp, out, n) => {
  for (let j = 0, e = n * 3; j < e; j += 3) out[j] = out[j + 1] = out[j + 2] = luma(inp[j], inp[j + 1], inp[j + 2]);
};

function threshold(p: AdjustmentParamsMap['threshold']): Plan {
  // White where the rounded 8-bit luma reaches the level.
  const edge = (clamp(Math.round(fin(p.level, 128)), 1, 255) - 0.5) / 255 - 1e-7;
  const step: Fn1 = (x) => (x >= edge ? 1 : 0);
  return {
    pixel: (inp, out, n) => {
      for (let j = 0, e = n * 3; j < e; j += 3) {
        const r = inp[j],
          g = inp[j + 1],
          b = inp[j + 2];
        out[j] = out[j + 1] = out[j + 2] = luma(r, g, b) >= edge ? 1 : 0;
      }
    },
    split: { pixel: grayPixel, post: { r: step, g: step, b: step } },
    approximate: true,
  };
}

function posterize(p: AdjustmentParamsMap['posterize']): Plan {
  const n = clamp(Math.round(fin(p.levels, 4)), 2, 255) - 1;
  return { curves: { rgb: (x) => Math.round(clamp01(x) * n) / n } };
}

const GRADIENT_N = 4096;
function gradientMap(p: AdjustmentParamsMap['gradient-map']): Plan {
  const t = gradientTable(p.gradient, GRADIENT_N + 1, p.reverse);
  const look = (x: number, k: number) => {
    const q = clamp01(x) * GRADIENT_N,
      i = Math.min(GRADIENT_N - 1, q | 0),
      f = q - i;
    return t[i * 4 + k] + (t[i * 4 + 4 + k] - t[i * 4 + k]) * f;
  };
  return {
    pixel: (inp, out, n) => {
      for (let j = 0, e = n * 3; j < e; j += 3) {
        const r = inp[j],
          g = inp[j + 1],
          b = inp[j + 2];
        const l = luma(r, g, b);
        out[j] = look(l, 0);
        out[j + 1] = look(l, 1);
        out[j + 2] = look(l, 2);
      }
    },
    split: { pixel: grayPixel, post: { r: (x) => look(x, 0), g: (x) => look(x, 1), b: (x) => look(x, 2) } },
    dither: p.dither,
  };
}

function selectiveColor(p: AdjustmentParamsMap['selective-color']): Plan {
  // ink[range * 3 + channel]: change of cyan/magenta/yellow ink (red/green/blue
  // channels) including the range's black amount, as fractions.
  const ink = new Float64Array(SELECTIVE_RANGES.length * 3);
  SELECTIVE_RANGES.forEach((name, i) => {
    const q = p.ranges[name];
    if (!q) return;
    const k = pct(q.black);
    ink[i * 3] = pct(q.cyan) + k;
    ink[i * 3 + 1] = pct(q.magenta) + k;
    ink[i * 3 + 2] = pct(q.yellow) + k;
  });
  if (!ink.some((v) => v)) return EMPTY;
  const relative = p.method !== 'absolute';
  // Range indices in SELECTIVE_RANGES order.
  const REDS = 0,
    YELLOWS = 1,
    GREENS = 2,
    CYANS = 3,
    BLUES = 4,
    MAGENTAS = 5,
    WHITES = 6,
    NEUTRALS = 7,
    BLACKS = 8;
  return {
    pixel: (inp, out, n) => {
      for (let j = 0, e = n * 3; j < e; j += 3) {
        const r = inp[j],
          g = inp[j + 1],
          b = inp[j + 2];
        const max = r > g ? (r > b ? r : b) : g > b ? g : b;
        const min = r < g ? (r < b ? r : b) : g < b ? g : b;
        const mid = r + g + b - max - min;
        // Hue membership splits the chroma between the primary (largest channel)
        // and secondary (two largest) colors, like the Black & White mixer.
        const prim = (max === r ? REDS : max === g ? GREENS : BLUES) * 3;
        const sec = (min === b ? YELLOWS : min === r ? CYANS : MAGENTAS) * 3;
        const wp = max - mid,
          ws = mid - min;
        // The remaining (1 - chroma) is shared by whites, neutrals and blacks
        // along lightness, so all nine weights sum to one.
        const neutral = 1 - (max - min),
          l2 = max + min - 1;
        const tone = (l2 > 0 ? WHITES : BLACKS) * 3,
          wt = neutral * (l2 > 0 ? l2 : -l2),
          wn = neutral - wt,
          n = NEUTRALS * 3;
        for (let k = 0; k < 3; k++) {
          const vk = k === 0 ? r : k === 1 ? g : b;
          const d = wp * ink[prim + k] + ws * ink[sec + k] + wt * ink[tone + k] + wn * ink[n + k];
          // Relative changes scale with the ink already present; absolute add it.
          out[j + k] = clamp01(vk - (relative ? d * (1 - vk) : d));
        }
      }
    },
  };
}

const INVERT: Plan = { curves: { rgb: (x) => 1 - x } };

/** The Light & Tone curve: exposure (linear light), then a contrast S-curve,
 * shadow and highlight lifts peaking at 1/3 and 2/3, and the white and black
 * ends; applied to each channel like a tone curve. */
export function lightToneCurve(p: AdjustmentParamsMap['light-tone']): Fn1 | undefined {
  const e = clamp(fin(p.exposure), -5, 5),
    c = pct(p.contrast),
    hi = pct(p.highlights),
    sh = pct(p.shadows),
    wh = pct(p.whites),
    bl = pct(p.blacks);
  if (!e && !c && !hi && !sh && !wh && !bl) return undefined;
  const mul = Math.pow(2, e),
    g = 0.5 + c * 0.3;
  // v(1-v)^2 and v^2(1-v) peak at 4/27; scaled so a full slider moves the
  // peak by a quarter of the range.
  const k = 0.25 * (27 / 4);
  return (x) => {
    let v = mul === 1 ? x : clamp01(linearToSrgb(srgbToLinear(x) * mul));
    if (c) v = gain(v, g);
    if (sh) v += sh * k * v * (1 - v) * (1 - v);
    if (hi) v += hi * k * v * v * (1 - v);
    if (wh) v += wh * 0.2 * v * v * v;
    if (bl) v += bl * 0.2 * (1 - v) * (1 - v) * (1 - v);
    return clamp01(v);
  };
}
function lightTone(p: AdjustmentParamsMap['light-tone']): Plan {
  const rgb = lightToneCurve(p);
  return rgb ? { curves: { rgb } } : EMPTY;
}

/** White balance gains in linear light for a temperature (blue-amber) and
 * tint (green-magenta) shift, normalized so white keeps its luminance. */
export function whiteBalanceGains(temperature: number, tint: number): [number, number, number] {
  const t = pct(temperature),
    m = pct(tint);
  const r = 1 + 0.3 * t + 0.08 * m,
    g = 1 - 0.22 * m,
    b = 1 - 0.3 * t + 0.08 * m;
  const y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  return [r / y, g / y, b / y];
}
function colorVibrance(p: AdjustmentParamsMap['color-vibrance']): Plan {
  const plan: Plan = {};
  if (fin(p.temperature) || fin(p.tint)) {
    const gains = whiteBalanceGains(p.temperature, p.tint);
    const ch = (k: number): Fn1 => (x) => clamp01(linearToSrgb(srgbToLinear(x) * gains[k]));
    plan.curves = { r: ch(0), g: ch(1), b: ch(2) };
  }
  const v = vibrance({ vibrance: p.vibrance, saturation: p.saturation });
  if (v.pixel) plan.pixel = v.pixel;
  return plan.curves || plan.pixel ? plan : EMPTY;
}

export function planFor(adj: Adjustment): Plan {
  switch (adj.kind) {
    case 'brightness-contrast':
      return brightnessContrast(adj.params);
    case 'levels':
      return levels(adj.params);
    case 'curves':
      return curves(adj.params);
    case 'exposure':
      return exposure(adj.params);
    case 'vibrance':
      return vibrance(adj.params);
    case 'hue-saturation':
      return hueSaturation(adj.params);
    case 'color-balance':
      return colorBalance(adj.params);
    case 'black-white':
      return blackWhite(adj.params);
    case 'photo-filter':
      return photoFilter(adj.params);
    case 'channel-mixer':
      return channelMixer(adj.params);
    case 'color-lookup':
      return colorLookup(adj.params);
    case 'invert':
      return INVERT;
    case 'posterize':
      return posterize(adj.params);
    case 'threshold':
      return threshold(adj.params);
    case 'gradient-map':
      return gradientMap(adj.params);
    case 'selective-color':
      return selectiveColor(adj.params);
    case 'light-tone':
      return lightTone(adj.params);
    case 'color-vibrance':
      return colorVibrance(adj.params);
    // Spatial kinds have no color plan (see spatial.ts).
    case 'clarity-dehaze':
    case 'grain':
    case 'relight':
      return EMPTY;
  }
}
