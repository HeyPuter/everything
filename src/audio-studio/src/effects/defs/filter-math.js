// Filter design mirrored from wasm/dsp/src/fx/filter (RBJ biquads,
// Butterworth/Chebyshev/Bessel sections, graphic EQ band correction), used to
// draw response curves on the main thread without touching WASM. Tests check
// these curves against the WASM processors.

const TAU = 2 * Math.PI;

function norm(b0, b1, b2, a0, a1, a2) {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function w(rate, f) {
  const fc = Math.min(Math.max(f, 1), rate * 0.4999);
  const w0 = (TAU * fc) / rate;
  return [Math.cos(w0), Math.sin(w0)];
}

export const IDENTITY = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };

export function lowpass(rate, f, q) {
  const [c, s] = w(rate, f);
  const al = s / (2 * Math.max(q, 0.01));
  return norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
}

export function highpass(rate, f, q) {
  const [c, s] = w(rate, f);
  const al = s / (2 * Math.max(q, 0.01));
  return norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
}

export function peaking(rate, f, q, db) {
  const [c, s] = w(rate, f);
  const a = 10 ** (db / 40);
  const al = s / (2 * Math.max(q, 0.01));
  return norm(1 + al * a, -2 * c, 1 - al * a, 1 + al / a, -2 * c, 1 - al / a);
}

export function peakingCq(rate, f, q, db) {
  const [c, s] = w(rate, f);
  const g = 10 ** (Math.abs(db) / 20);
  const al = s / (2 * Math.max(q, 0.01));
  return db >= 0 ? norm(1 + al * g, -2 * c, 1 - al * g, 1 + al, -2 * c, 1 - al) : norm(1 + al, -2 * c, 1 - al, 1 + al * g, -2 * c, 1 - al * g);
}

/** Notch with pole-defined width (stays narrow when deep). */
export function notchBell(rate, f, q, db) {
  const [c, s] = w(rate, f);
  const g = 10 ** (Math.min(db, 0) / 20);
  const al = s / (2 * Math.max(q, 0.01));
  return norm(1 + al * g, -2 * c, 1 - al * g, 1 + al, -2 * c, 1 - al);
}

export function lowShelf(rate, f, q, db) {
  const [c, s] = w(rate, f);
  const a = 10 ** (db / 40);
  const al = s / (2 * Math.max(q, 0.01));
  const sa = 2 * Math.sqrt(a) * al;
  return norm(a * (a + 1 - (a - 1) * c + sa), 2 * a * (a - 1 - (a + 1) * c), a * (a + 1 - (a - 1) * c - sa), a + 1 + (a - 1) * c + sa, -2 * (a - 1 + (a + 1) * c), a + 1 + (a - 1) * c - sa);
}

export function highShelf(rate, f, q, db) {
  const [c, s] = w(rate, f);
  const a = 10 ** (db / 40);
  const al = s / (2 * Math.max(q, 0.01));
  const sa = 2 * Math.sqrt(a) * al;
  return norm(a * (a + 1 + (a - 1) * c + sa), -2 * a * (a - 1 + (a + 1) * c), a * (a + 1 + (a - 1) * c - sa), a + 1 - (a - 1) * c + sa, 2 * (a - 1 - (a + 1) * c), a + 1 - (a - 1) * c - sa);
}

function k1(rate, f) {
  return Math.tan((Math.PI * Math.min(Math.max(f, 1), rate * 0.4999)) / rate);
}

export function lowpass1(rate, f) {
  const k = k1(rate, f);
  return norm(k, k, 0, 1 + k, k - 1, 0);
}

export function highpass1(rate, f) {
  const k = k1(rate, f);
  return norm(1, -1, 0, 1 + k, k - 1, 0);
}

/** Linear magnitude of one biquad at f Hz. */
export function magnitude(c, f, rate) {
  const x = (TAU * f) / rate;
  const c1 = Math.cos(x);
  const s1 = -Math.sin(x);
  const c2 = Math.cos(2 * x);
  const s2 = -Math.sin(2 * x);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
  const ni = c.b1 * s1 + c.b2 * s2;
  const dr = 1 + c.a1 * c1 + c.a2 * c2;
  const di = c.a1 * s1 + c.a2 * s2;
  return Math.sqrt((nr * nr + ni * ni) / Math.max(dr * dr + di * di, 1e-30));
}

/** Phase in radians of one biquad at f. */
export function phase(c, f, rate) {
  const x = (TAU * f) / rate;
  const nr = c.b0 + c.b1 * Math.cos(x) + c.b2 * Math.cos(2 * x);
  const ni = -c.b1 * Math.sin(x) - c.b2 * Math.sin(2 * x);
  const dr = 1 + c.a1 * Math.cos(x) + c.a2 * Math.cos(2 * x);
  const di = -c.a1 * Math.sin(x) - c.a2 * Math.sin(2 * x);
  return Math.atan2(ni, nr) - Math.atan2(di, dr);
}

/** Phase of a cascade in degrees, wrapped to [-180, 180), at each frequency. */
export function cascadePhase(coefs, freqs, rate) {
  return Float32Array.from(freqs, (f) => {
    let ph = 0;
    for (const c of coefs) ph += phase(c, f, rate);
    const deg = (ph * 180) / Math.PI;
    return ((((deg + 180) % 360) + 360) % 360) - 180;
  });
}

/**
 * Group delay of a cascade in milliseconds at each frequency: the negative
 * slope of the (unwrapped) phase, measured over a small frequency step.
 */
export function cascadeGroupDelay(coefs, freqs, rate) {
  return Float32Array.from(freqs, (f) => {
    const df = Math.max(0.01, f * 1e-4);
    let d = 0;
    for (const c of coefs) {
      let dp = phase(c, f + df, rate) - phase(c, f - df, rate);
      dp -= TAU * Math.round(dp / TAU);
      d += -dp / ((TAU * 2 * df) / rate);
    }
    return (d / rate) * 1000;
  });
}

const toDb = (g) => 20 * Math.log10(Math.max(Math.abs(g), 1e-10));

/**
 * Summed dB response of a list of biquads at each frequency, plus `offsetDb`.
 * The floor (-200 dB a section) applies to the total, not to each section:
 * a normalised narrow band pass puts its whole gain in one section (1e-18
 * for 10 to 100 Hz), which the other sections make up.
 */
export function cascadeDb(coefs, freqs, rate, offsetDb = 0) {
  const out = new Float32Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    let db = offsetDb;
    for (const c of coefs) db += 20 * Math.log10(Math.max(magnitude(c, freqs[i], rate), 1e-300));
    out[i] = Math.max(db, offsetDb - 200 * coefs.length);
  }
  return out;
}

/** Butterworth pass sections of order n (1..8). */
export function butterworth(rate, f, order, high) {
  const n = Math.min(8, Math.max(1, Math.round(order)));
  const out = [];
  for (let k = 0; k < Math.floor(n / 2); k++) {
    const psi = n % 2 === 0 ? (Math.PI * (2 * k + 1)) / (2 * n) : (Math.PI * (k + 1)) / n;
    const q = 1 / (2 * Math.cos(psi));
    out.push(high ? highpass(rate, f, q) : lowpass(rate, f, q));
  }
  if (n % 2) out.push(high ? highpass1(rate, f) : lowpass1(rate, f));
  return out;
}

// ------------------------------------------------------------ scientific

const cx = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
  mul: (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
  scale: (a, k) => [a[0] * k, a[1] * k],
  div: (a, b) => {
    const d = b[0] * b[0] + b[1] * b[1];
    return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
  },
  abs: (a) => Math.hypot(a[0], a[1]),
  sqrt: (a) => {
    const r = Math.hypot(a[0], a[1]);
    const re = Math.sqrt(Math.max(0, (r + a[0]) / 2));
    const im = Math.sqrt(Math.max(0, (r - a[0]) / 2));
    return [re, a[1] < 0 ? -im : im];
  },
};

const fact = (n) => {
  let v = 1;
  for (let k = 2; k <= n; k++) v *= k;
  return v;
};

const besselCache = new Map();

/** Bessel prototype poles normalised for -3 dB at 1 rad/s: { pairs: [[re, im]], real }. */
export function besselProto(order) {
  const n = Math.min(8, Math.max(1, Math.round(order)));
  if (besselCache.has(n)) return besselCache.get(n);
  const a = [];
  for (let k = 0; k <= n; k++) a[k] = fact(2 * n - k) / (2 ** (n - k) * fact(k) * fact(n - k));
  const lead = a[n];
  const evalP = (s) => {
    let v = [a[n] / lead, 0];
    for (let k = n - 1; k >= 0; k--) v = cx.add(cx.mul(v, s), [a[k] / lead, 0]);
    return v;
  };
  const roots = [];
  let z = [1, 0];
  for (let i = 0; i < n; i++) {
    z = cx.mul(z, [0.4, 0.9]);
    roots.push(z);
  }
  for (let it = 0; it < 500; it++) {
    for (let i = 0; i < n; i++) {
      let den = [1, 0];
      for (let j = 0; j < n; j++) if (i !== j) den = cx.mul(den, cx.sub(roots[i], roots[j]));
      roots[i] = cx.sub(roots[i], cx.div(evalP(roots[i]), den));
    }
  }
  const mag = (wv) => a[0] / cx.abs(cx.scale(evalP([0, wv]), lead));
  let lo = 0.01;
  let hi = 20;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (mag(mid) > Math.SQRT1_2) lo = mid;
    else hi = mid;
  }
  const w3 = (lo + hi) / 2;
  const proto = { pairs: [], real: null };
  for (const r of roots) {
    if (r[1] > 1e-9) proto.pairs.push([r[0] / w3, r[1] / w3]);
    else if (Math.abs(r[1]) <= 1e-9) proto.real = r[0] / w3;
  }
  besselCache.set(n, proto);
  return proto;
}

export function butterworthProto(order) {
  const n = Math.min(8, Math.max(1, Math.round(order)));
  const proto = { pairs: [], real: n % 2 ? -1 : null };
  for (let k = 0; k < Math.floor(n / 2); k++) {
    const t = (Math.PI * (2 * k + 1)) / (2 * n);
    proto.pairs.push([-Math.sin(t), Math.cos(t)]);
  }
  return proto;
}

export function chebyshevProto(order, rippleDb) {
  const n = Math.min(8, Math.max(1, Math.round(order)));
  const eps = Math.sqrt(10 ** (Math.max(rippleDb, 0.001) / 10) - 1);
  const mu = Math.asinh(1 / eps) / n;
  const proto = { pairs: [], real: n % 2 ? -Math.sinh(mu) : null };
  for (let k = 0; k < Math.floor(n / 2); k++) {
    const t = (Math.PI * (2 * k + 1)) / (2 * n);
    proto.pairs.push([-Math.sinh(mu) * Math.sin(t), Math.cosh(mu) * Math.cos(t)]);
  }
  return proto;
}

function bilinear(b, a) {
  return norm(b[0] + b[1] + b[2], 2 * (b[0] - b[2]), b[0] - b[1] + b[2], a[0] + a[1] + a[2], 2 * (a[0] - a[2]), a[0] - a[1] + a[2]);
}

function bilinear1(b, a) {
  return norm(b[0] + b[1], b[0] - b[1], 0, a[0] + a[1], a[0] - a[1], 0);
}

const warp = (f, rate) => Math.tan((Math.PI * Math.min(Math.max(f, 1), rate * 0.49)) / rate);

/**
 * Scientific filter sections. family 0 Butterworth, 1 Chebyshev, 2 Bessel;
 * mode 0 low pass, 1 high pass, 2 band pass, 3 band stop.
 */
export function scientificSections({ type = 0, mode = 0, order = 4, cutoff = 1000, highCutoff = 4000, ripple = 1 }, rate) {
  const n = Math.min(8, Math.max(1, Math.round(order)));
  const r = Math.min(12, Math.max(0.01, ripple));
  const proto = type === 1 ? chebyshevProto(n, r) : type === 2 ? besselProto(n) : butterworthProto(n);
  const out = [];
  if (mode === 0 || mode === 1) {
    const k = warp(cutoff, rate);
    const hp = mode === 1;
    for (const [re, im] of proto.pairs) {
      const ab = Math.hypot(re, im);
      const w0 = hp ? k / ab : k * ab;
      const q = ab / (-2 * re);
      out.push(bilinear(hp ? [0, 0, 1] : [w0 * w0, 0, 0], [w0 * w0, w0 / q, 1]));
    }
    if (proto.real != null) {
      const wv = hp ? k / -proto.real : k * -proto.real;
      out.push(bilinear1(hp ? [0, 1] : [wv, 0], [wv, 1]));
    }
  } else {
    const lo = Math.min(cutoff, highCutoff);
    const hi = Math.max(highCutoff, cutoff * 1.01, lo * 1.01);
    const ka = warp(lo, rate);
    const kb = Math.max(warp(hi, rate), ka * 1.001);
    const w02 = ka * kb;
    const bw = kb - ka;
    const bp = mode === 2;
    const num = bp ? [0, 1, 0] : [w02, 0, 1];
    for (const [re, im] of proto.pairs) {
      const p = [re, im];
      const c = bp ? cx.scale(p, bw) : cx.div([bw, 0], p);
      const disc = cx.sqrt(cx.sub(cx.mul(c, c), [4 * w02, 0]));
      for (const q of [cx.scale(cx.add(c, disc), 0.5), cx.scale(cx.sub(c, disc), 0.5)]) {
        out.push(bilinear(num, [q[0] * q[0] + q[1] * q[1], -2 * q[0], 1]));
      }
    }
    if (proto.real != null) {
      const c = bp ? proto.real * bw : bw / proto.real;
      out.push(bilinear(num, [w02, -c, 1]));
    }
  }
  let fref = 0;
  if (mode === 1) fref = rate / 2;
  if (mode === 2) fref = (Math.atan(Math.sqrt(warp(Math.min(cutoff, highCutoff), rate) * warp(Math.max(highCutoff, cutoff * 1.01), rate))) * rate) / Math.PI;
  let g = 1;
  for (const c of out) g *= magnitude(c, fref, rate);
  const target = type === 1 && n % 2 === 0 ? 1 / Math.sqrt(10 ** (r / 10)) : 1;
  if (out.length && g > 1e-20) {
    const s = target / g;
    out[0] = { ...out[0], b0: out[0].b0 * s, b1: out[0].b1 * s, b2: out[0].b2 * s };
  }
  return out;
}

// --------------------------------------------------------------- graphic

export const ISO_OCTAVE = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const ISO_HALF_OCTAVE = [22.4, 31.5, 45, 63, 90, 125, 180, 250, 355, 500, 710, 1000, 1400, 2000, 2800, 4000, 5600, 8000, 11200, 16000];
export const ISO_THIRD_OCTAVE = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];
export const MAX_CENTRE = 0.46;

/** Bell Q for bands `octaves` apart. */
export function bandQ(octaves) {
  const r = 2 ** octaves;
  return Math.sqrt(r) / (r - 1);
}

function solve(a, b, n) {
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    [a[col], a[piv]] = [a[piv], a[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const d = a[col][col];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = col + 1; r < n; r++) {
      const m = a[r][col] / d;
      if (m === 0) continue;
      for (let k = col; k < n; k++) a[r][k] -= m * a[col][k];
      b[r] -= m * b[col];
    }
  }
  for (let col = n - 1; col >= 0; col--) {
    let v = b[col];
    for (let k = col + 1; k < n; k++) v -= a[col][k] * b[k];
    b[col] = Math.abs(a[col][col]) < 1e-12 ? 0 : v / a[col][col];
  }
}

/** Band gains that make the summed bells hit `want` at the centres (see graphic.rs). */
export function correctGraphic(want, centres, q, rate) {
  const n = want.length;
  let m = 0;
  while (m < n && centres[m] <= MAX_CENTRE * rate) m++;
  const REF = 6;
  const LAMBDA = 0.005;
  const B = Array.from({ length: m }, () => new Float64Array(m));
  for (let i = 0; i < m; i++) {
    const c = peakingCq(rate, centres[i], q, REF);
    for (let j = 0; j < m; j++) B[j][i] = toDb(magnitude(c, centres[j], rate)) / REF;
  }
  const N = Array.from({ length: m }, () => new Float64Array(m));
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < m; k++) {
      let v = 0;
      for (let j = 0; j < m; j++) v += B[j][i] * B[j][k];
      N[i][k] = v + (i === k ? LAMBDA : 0);
    }
  }
  const lo = Math.max(-36, Math.min(0, ...want.slice(0, m)) - 6);
  const hi = Math.min(36, Math.max(0, ...want.slice(0, m)) + 6);
  const x = new Float64Array(m);
  for (let it = 0; it < 6; it++) {
    const coefs = Array.from(x, (g, i) => peakingCq(rate, centres[i], q, g));
    const r = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      let sum = 0;
      for (const c of coefs) sum += toDb(magnitude(c, centres[j], rate));
      r[j] = want[j] - sum;
    }
    const rhs = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      let v = 0;
      for (let j = 0; j < m; j++) v += B[j][i] * r[j];
      rhs[i] = v - LAMBDA * x[i];
    }
    solve(N.map((row) => Float64Array.from(row)), rhs, m);
    for (let i = 0; i < m; i++) x[i] = Math.min(hi, Math.max(lo, x[i] + rhs[i]));
  }
  return Array.from({ length: n }, (_, i) => (i < m ? x[i] : 0));
}

// ----------------------------------------------------------------- curves

/** Curve value (dB or degrees) at f from [{ f, g }] points, like curve_at in Rust. */
export function curveAt(points, f, log = true) {
  const pts = [...(points || [])].filter((p) => Number.isFinite(p.f) && Number.isFinite(p.g)).sort((a, b) => a.f - b.f);
  if (!pts.length) return 0;
  if (f <= pts[0].f) return pts[0].g;
  const last = pts[pts.length - 1];
  if (f >= last.f) return last.g;
  let i = 1;
  while (i < pts.length && pts[i].f < f) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const t = log && a.f > 0 ? Math.log(f / a.f) / Math.max(Math.log(b.f / a.f), 1e-9) : (f - a.f) / Math.max(b.f - a.f, 1e-9);
  return a.g + (b.g - a.g) * Math.min(1, Math.max(0, t));
}

/** Nearest power of two within [min, max], like fft_size in Rust. */
export function fftSize(v, min, max) {
  const p = Math.min(Math.log2(max), Math.max(Math.log2(min), Math.round(Math.log2(Math.max(1, Number(v) || 4096)))));
  return 2 ** p;
}
