// Ocean: a statistical (FFT) ocean surface. Wave amplitudes come from a wind spectrum, evolve with
// the deep/shallow water dispersion relation and are summed with an inverse FFT into heights,
// horizontal "choppy" displacement and an optional foam mask.
import type { ModifierBase } from '../../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from '../types';
import { registerModifier } from '../modifiers';
import { MeshBuilder } from '../meshbuild';
import { bool, num, str } from './common';

const G = 9.81;

/** In-place radix-2 complex FFT (inverse when `inv`), arrays of length n (power of two). */
export function fft(re: Float64Array, im: Float64Array, inv: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang),
      wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k],
          ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci,
          bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** 2D inverse FFT of an n×n grid (row-major), in place. */
function ifft2(re: Float64Array, im: Float64Array, n: number) {
  const rr = new Float64Array(n),
    ri = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      rr[x] = re[y * n + x];
      ri[x] = im[y * n + x];
    }
    fft(rr, ri, true);
    for (let x = 0; x < n; x++) {
      re[y * n + x] = rr[x];
      im[y * n + x] = ri[x];
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      rr[y] = re[y * n + x];
      ri[y] = im[y * n + x];
    }
    fft(rr, ri, true);
    for (let y = 0; y < n; y++) {
      re[y * n + x] = rr[y];
      im[y * n + x] = ri[y];
    }
  }
}

/** Deterministic Gaussian pairs (Box–Muller over a small hash generator). */
function gaussian(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
  return () => {
    const u = next(),
      v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
  };
}

export interface OceanParams {
  n: number;
  /** patch size in meters */
  L: number;
  wind: number;
  direction: number;
  alignment: number;
  damping: number;
  minWave: number;
  scale: number;
  depth: number;
  chop: number;
  time: number;
  seed: number;
  spectrum: string;
  fetch: number;
  sharpen: number;
  foam: boolean;
  coverage: number;
}

export interface OceanField {
  n: number;
  h: Float64Array;
  dx: Float64Array;
  dy: Float64Array;
  foam: Float64Array | null;
}

/** Spectrum energy for wave vector (kx, ky). */
function spectrum(p: OceanParams, kx: number, ky: number): number {
  const k = Math.hypot(kx, ky);
  if (k < 1e-6) return 0;
  const wx = Math.cos(p.direction),
    wy = Math.sin(p.direction);
  const cos = (kx * wx + ky * wy) / k;
  // directional spreading: alignment narrows the spread around the wind
  let dir = Math.pow(Math.abs(cos), 2 + p.alignment * 8);
  if (cos < 0) dir *= 1 - p.damping;
  const small = Math.exp(-k * k * p.minWave * p.minWave);
  const V = Math.max(0.01, p.wind);
  if (p.spectrum === 'PHILLIPS') {
    const Lw = (V * V) / G;
    return (Math.exp(-1 / (k * Lw * k * Lw)) / (k * k * k * k)) * dir * small;
  }
  // frequency spectra converted to wave numbers (deep water ω² = g k)
  const w = Math.sqrt(G * k);
  const dwdk = G / (2 * w);
  let S: number;
  if (p.spectrum === 'PIERSON_MOSKOWITZ') {
    const w0 = G / V;
    S = ((0.0081 * G * G) / Math.pow(w, 5)) * Math.exp(-0.74 * Math.pow(w0 / w, 4));
  } else {
    // JONSWAP style peaked spectrum (fetch limited); shallow water attenuation for TMA
    const F = Math.max(1, p.fetch * 1000);
    const wp = 22 * Math.pow((G * G) / (V * F), 1 / 3);
    const alpha = 0.076 * Math.pow((V * V) / (F * G), 0.22);
    const sigma = w <= wp ? 0.07 : 0.09;
    const gamma = 3.3 * (1 + p.sharpen * 2);
    const r = Math.exp(-((w - wp) ** 2) / (2 * sigma * sigma * wp * wp));
    S = ((alpha * G * G) / Math.pow(w, 5)) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(gamma, r);
    if (p.spectrum === 'TEXEL_MARSEN_ARSLOE') {
      const wh = w * Math.sqrt(p.depth / G);
      S *= wh <= 1 ? 0.5 * wh * wh : wh < 2 ? 1 - 0.5 * (2 - wh) ** 2 : 1;
    }
  }
  // per unit wave-number area (S(ω) dω / (k dk)), a factor matching Phillips' scale
  return ((S * dwdk) / k) * dir * small * (p.spectrum === 'PIERSON_MOSKOWITZ' ? 160 : 50);
}

/** Height, horizontal displacement and foam fields at time t. */
export function oceanField(p: OceanParams): OceanField {
  const n = p.n,
    L = p.L;
  const h0r = new Float64Array(n * n),
    h0i = new Float64Array(n * n),
    m0r = new Float64Array(n * n),
    m0i = new Float64Array(n * n);
  const rnd = gaussian(p.seed + 1);
  // the amplitude scale gives waves of about a meter in a 30 m/s wind over a 50 m patch
  const dk = (2 * Math.PI) / L;
  const A = 2.15e-3 * p.scale * p.scale * dk * dk;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const kx = ((2 * Math.PI) / L) * (i < n / 2 ? i : i - n),
        ky = ((2 * Math.PI) / L) * (j < n / 2 ? j : j - n);
      const [g1, g2] = rnd();
      const a = Math.sqrt((A * spectrum(p, kx, ky)) / 2);
      h0r[j * n + i] = g1 * a;
      h0i[j * n + i] = g2 * a;
    }
  // h0(-k) for the conjugate term (keeps the field real)
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const mi = (n - i) % n,
        mj = (n - j) % n;
      m0r[j * n + i] = h0r[mj * n + mi];
      m0i[j * n + i] = h0i[mj * n + mi];
    }
  const hr = new Float64Array(n * n),
    hi = new Float64Array(n * n),
    xr = new Float64Array(n * n),
    xi = new Float64Array(n * n),
    yr = new Float64Array(n * n),
    yi = new Float64Array(n * n);
  const foam = p.foam;
  const jxx = foam ? [new Float64Array(n * n), new Float64Array(n * n)] : null,
    jyy = foam ? [new Float64Array(n * n), new Float64Array(n * n)] : null,
    jxy = foam ? [new Float64Array(n * n), new Float64Array(n * n)] : null;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const id = j * n + i;
      const kx = ((2 * Math.PI) / L) * (i < n / 2 ? i : i - n),
        ky = ((2 * Math.PI) / L) * (j < n / 2 ? j : j - n);
      const k = Math.hypot(kx, ky);
      const w = Math.sqrt(G * k * Math.tanh(k * Math.max(0.01, p.depth)));
      const c = Math.cos(w * p.time),
        s = Math.sin(w * p.time);
      // h(k,t) = h0(k) e^{iωt} + conj(h0(-k)) e^{-iωt}
      const re = h0r[id] * c - h0i[id] * s + (m0r[id] * c - m0i[id] * s),
        im = h0r[id] * s + h0i[id] * c - (m0r[id] * s + m0i[id] * c);
      hr[id] = re;
      hi[id] = im;
      if (k > 1e-9) {
        // D = -i k/|k| h
        xr[id] = (kx / k) * im;
        xi[id] = -(kx / k) * re;
        yr[id] = (ky / k) * im;
        yi[id] = -(ky / k) * re;
        if (jxx && jyy && jxy) {
          // derivatives of D: i kx · D
          jxx[0][id] = (-kx * kx / k) * re;
          jxx[1][id] = (-kx * kx / k) * im;
          jyy[0][id] = (-ky * ky / k) * re;
          jyy[1][id] = (-ky * ky / k) * im;
          jxy[0][id] = (-kx * ky / k) * re;
          jxy[1][id] = (-kx * ky / k) * im;
        }
      }
    }
  ifft2(hr, hi, n);
  ifft2(xr, xi, n);
  ifft2(yr, yi, n);
  let foamField: Float64Array | null = null;
  if (jxx && jyy && jxy) {
    ifft2(jxx[0], jxx[1], n);
    ifft2(jyy[0], jyy[1], n);
    ifft2(jxy[0], jxy[1], n);
    foamField = new Float64Array(n * n);
    for (let id = 0; id < n * n; id++) {
      const J = (1 + p.chop * jxx[0][id]) * (1 + p.chop * jyy[0][id]) - p.chop * p.chop * jxy[0][id] * jxy[0][id];
      // folding (J < 1) makes foam; coverage shifts the threshold
      foamField[id] = Math.max(0, Math.min(1, (1 - J) + p.coverage));
    }
  }
  for (let id = 0; id < n * n; id++) {
    xr[id] *= p.chop;
    yr[id] *= p.chop;
  }
  return { n, h: hr, dx: xr, dy: yr, foam: foamField };
}

/** Bilinear lookup of a periodic n×n field at (u, v) in grid units. */
function sample(f: Float64Array, n: number, u: number, v: number): number {
  const x0 = Math.floor(u),
    y0 = Math.floor(v);
  const fx = u - x0,
    fy = v - y0;
  const a = ((x0 % n) + n) % n,
    b = (a + 1) % n,
    c = ((y0 % n) + n) % n,
    d = (c + 1) % n;
  return (f[c * n + a] * (1 - fx) + f[c * n + b] * fx) * (1 - fy) + (f[d * n + a] * (1 - fx) + f[d * n + b] * fx) * fy;
}

export function oceanParams(mod: ModifierBase, render: boolean): OceanParams {
  const res = Math.max(1, Math.min(16, Math.round(num(mod, render ? 'resolution' : 'viewport_resolution', 7))));
  const cells = res * res;
  let n = 16;
  while (n < cells && n < 256) n <<= 1;
  return {
    n,
    L: Math.max(0.01, num(mod, 'spatial_size', 50)),
    wind: num(mod, 'wind_velocity', 30),
    direction: num(mod, 'wave_direction', 0),
    alignment: num(mod, 'wave_alignment', 0),
    damping: num(mod, 'damping', 0.5),
    minWave: num(mod, 'wave_scale_min', 0.01),
    scale: num(mod, 'wave_scale', 1),
    depth: num(mod, 'depth', 200),
    chop: num(mod, 'choppiness', 1),
    time: num(mod, 'time', 1),
    seed: Math.round(num(mod, 'random_seed', 0)),
    spectrum: str(mod, 'spectrum', 'PHILLIPS'),
    fetch: num(mod, 'fetch_jonswap', 120),
    sharpen: num(mod, 'sharpen_peak_jonswap', 0),
    foam: bool(mod, 'use_foam'),
    coverage: num(mod, 'foam_coverage', 0),
  };
}

function oceanMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const p = oceanParams(mod, ctx.render);
  const f = oceanField(p);
  const size = num(mod, 'size', 1);
  const span = p.L * size;
  const toGrid = f.n / span; // world units → field cells
  const smooth = bool(mod, 'use_normals') ? 1 : 0;
  const foamColor = (u: number, v: number) => {
    const x = f.foam ? sample(f.foam, f.n, u, v) : 0;
    return [x, x, x, 1];
  };
  if (str(mod, 'geometry_mode', 'GENERATE') === 'DISPLACE') {
    const P = m.positions;
    const out = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      const u = P[i] * toGrid,
        v = P[i + 1] * toGrid;
      out[i] = P[i] + sample(f.dx, f.n, u, v);
      out[i + 1] = P[i + 1] + sample(f.dy, f.n, u, v);
      out[i + 2] = P[i + 2] + sample(f.h, f.n, u, v);
    }
    let colors = m.colors;
    if (f.foam) {
      colors = new Float32Array(m.indices.length * 4);
      for (let c = 0; c < m.indices.length; c++) colors.set(foamColor(P[m.indices[c] * 3] * toGrid, P[m.indices[c] * 3 + 1] * toGrid), c * 4);
    }
    return { ...m, positions: out, colors, smooth: smooth ? new Uint8Array(m.offsets.length - 1).fill(1) : m.smooth };
  }
  const res = Math.max(1, Math.min(16, Math.round(num(mod, ctx.render ? 'resolution' : 'viewport_resolution', 7))));
  const cells = res * res;
  const rx = Math.max(1, Math.round(num(mod, 'repeat_x', 1))),
    ry = Math.max(1, Math.round(num(mod, 'repeat_y', 1)));
  const cx = cells * rx,
    cy = cells * ry;
  const b = new MeshBuilder(0, !!f.foam);
  const ids = new Int32Array((cx + 1) * (cy + 1));
  const foamV: number[][] = [];
  for (let j = 0; j <= cy; j++)
    for (let i = 0; i <= cx; i++) {
      const x = -span / 2 + (i / cells) * span,
        y = -span / 2 + (j / cells) * span;
      const u = (i / cells) * f.n,
        v = (j / cells) * f.n;
      ids[j * (cx + 1) + i] = b.addVert(x + sample(f.dx, f.n, u, v), y + sample(f.dy, f.n, u, v), sample(f.h, f.n, u, v), -1);
      if (f.foam) foamV.push(foamColor(u, v));
    }
  for (let j = 0; j < cy; j++)
    for (let i = 0; i < cx; i++) {
      const a = j * (cx + 1) + i,
        c = a + cx + 2;
      const vs = [a, a + 1, c, c - 1];
      const uv = [i / cx, j / cy, (i + 1) / cx, j / cy, (i + 1) / cx, (j + 1) / cy, i / cx, (j + 1) / cy];
      b.addFace(
        vs.map((k) => ids[k]),
        uv,
        smooth,
        0,
        f.foam ? { colors: vs.flatMap((k) => foamV[k]) } : undefined,
      );
    }
  return b.build({ vertex_groups: m.vertex_groups, weights: undefined });
}

export const oceanModifiers: ModifierType[] = [
  {
    type: 'OCEAN',
    label: 'Ocean',
    category: 'PHYSICS',
    icon: 'mod_ocean',
    defaults: () => ({
      geometry_mode: 'GENERATE',
      repeat_x: 1,
      repeat_y: 1,
      viewport_resolution: 7,
      resolution: 7,
      time: 1,
      depth: 200,
      size: 1,
      spatial_size: 50,
      random_seed: 0,
      use_normals: false,
      spectrum: 'PHILLIPS',
      wave_scale: 1,
      wave_scale_min: 0.01,
      choppiness: 1,
      wind_velocity: 30,
      wave_alignment: 0,
      wave_direction: 0,
      damping: 0.5,
      fetch_jonswap: 120,
      sharpen_peak_jonswap: 0,
      use_foam: false,
      foam_coverage: 0,
      foam_layer_name: '',
    }),
    apply: oceanMod,
  },
];

for (const t of oceanModifiers) registerModifier(t);
