/**
 * The color engine: profile models, transforms between them, rendering
 * intents, black point compensation and baked lookup tables.
 *
 * A model is what the engine needs from a profile:
 *   { key, name, colorSpace ('RGB ' | 'CMYK' | 'GRAY' | 'Lab ' | ...),
 *     channels, deviceClass, version,
 *     mediaWhite [X, Y, Z] (PCS, D50),
 *     toPcs(intent) -> (device values 0..1) -> PCS XYZ (D50, media-relative) | null
 *     fromPcs(intent) -> (PCS XYZ) -> device values 0..1 | null
 *     blackPoint?(intent) -> PCS XYZ  (overrides the detected black point)
 *     matrixShaper? }
 * modelFromProfile() builds one from a parsed ICC profile (matrix/curve
 * RGB and gray profiles, and LUT profiles with lut8, lut16, lutAtoB and
 * lutBtoA tags, with an XYZ or Lab PCS). Other code (press models, Lab)
 * provides models directly.
 *
 * Intents: 'perceptual' (tag 0), 'relative' (tag 1), 'saturation' (tag 2)
 * and 'absolute' (tag 1 scaled by the media white points). A missing
 * intent tag falls back to the perceptual one.
 */
import { D50, mul3, inv3, xyzToLab, labToXyz, clamp01 } from './math.js';

export const INTENT_IDS = ['perceptual', 'relative', 'saturation', 'absolute'];
const TAG_INDEX = { perceptual: 0, relative: 1, saturation: 2, absolute: 1 };

// The PCS black of v4 perceptual tables.
export const PERCEPTUAL_BLACK = Object.freeze([0.00336, 0.0034731, 0.00287]);

// ---- curves ----

/** Inverse of a monotonic curve on 0..1 (by bisection on a dense sampling). */
export function invertCurve(curve) {
  if (curve.kind === 'identity') return (v) => v;
  if (curve.kind === 'gamma' && curve.gamma > 0) return (v) => (v <= 0 ? 0 : clamp01(v) ** (1 / curve.gamma));
  const N = 4096;
  const t = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) t[i] = curve.eval(i / N);
  const rising = t[N] >= t[0];
  const lo = Math.min(t[0], t[N]);
  const hi = Math.max(t[0], t[N]);
  return (v) => {
    if (v <= lo) return rising ? 0 : 1;
    if (v >= hi) return rising ? 1 : 0;
    let a = 0;
    let b = N;
    while (b - a > 1) {
      const m = (a + b) >> 1;
      if ((t[m] <= v) === rising) a = m;
      else b = m;
    }
    const d = t[b] - t[a];
    const f = d ? (v - t[a]) / d : 0;
    return (a + f) / N;
  };
}

// ---- lookup tables ----

/** Interpolation in a CLUT (tetrahedral for three inputs, multilinear otherwise); x (0..1 per input) -> out. */
export function clutEval(clut, x, out = new Float64Array(clut.outputs)) {
  const { grid, inputs, outputs, data } = clut;
  let strides = clut._strides;
  if (!strides) {
    strides = new Array(inputs);
    let s = outputs;
    for (let i = inputs - 1; i >= 0; i--) {
      strides[i] = s;
      s *= grid[i];
    }
    clut._strides = strides;
  }
  if (inputs === 3) return clutTetra(clut, strides, x, out);
  const base = new Array(inputs);
  const frac = new Array(inputs);
  let origin = 0;
  for (let i = 0; i < inputs; i++) {
    const n1 = grid[i] - 1;
    const p = clamp01(x[i]) * n1;
    const i0 = Math.min(n1 - 1, Math.floor(p));
    base[i] = i0;
    frac[i] = p - i0;
    origin += i0 * strides[i];
  }
  for (let o = 0; o < outputs; o++) out[o] = 0;
  const corners = 1 << inputs;
  for (let c = 0; c < corners; c++) {
    let w = 1;
    let off = origin;
    for (let i = 0; i < inputs; i++) {
      if (c & (1 << i)) {
        w *= frac[i];
        off += strides[i];
      } else w *= 1 - frac[i];
      if (!w) break;
    }
    if (!w) continue;
    for (let o = 0; o < outputs; o++) out[o] += w * data[off + o];
  }
  return out;
}

function clutTetra(clut, strides, x, out) {
  const { grid, outputs, data } = clut;
  let c0 = 0;
  const r = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const n1 = grid[i] - 1;
    const p = clamp01(x[i]) * n1;
    const i0 = Math.min(n1 - 1, Math.floor(p));
    r[i] = p - i0;
    c0 += i0 * strides[i];
  }
  const [sx, sy, sz] = strides;
  const [rx, ry, rz] = r;
  let a;
  let b;
  let ra;
  let rb;
  let rc;
  if (rx >= ry) {
    if (ry >= rz) [a, b, ra, rb, rc] = [sx, sx + sy, rx, ry, rz];
    else if (rx >= rz) [a, b, ra, rb, rc] = [sx, sx + sz, rx, rz, ry];
    else [a, b, ra, rb, rc] = [sz, sx + sz, rz, rx, ry];
  } else if (rz >= ry) [a, b, ra, rb, rc] = [sz, sy + sz, rz, ry, rx];
  else if (rz >= rx) [a, b, ra, rb, rc] = [sy, sy + sz, ry, rz, rx];
  else [a, b, ra, rb, rc] = [sy, sx + sy, ry, rx, rz];
  const c3 = c0 + sx + sy + sz;
  for (let o = 0; o < outputs; o++) {
    const v0 = data[c0 + o];
    const v1 = data[c0 + a + o];
    const v2 = data[c0 + b + o];
    out[o] = v0 + ra * (v1 - v0) + rb * (v2 - v1) + rc * (data[c3 + o] - v2);
  }
  return out;
}

const applyCurves = (curves, v) => {
  for (let i = 0; i < curves.length; i++) v[i] = curves[i].eval(clamp01(v[i]));
  return v;
};

/** A function evaluating a LUT tag on normalized values (0..1 in and out). */
export function lutFunction(tag) {
  if (tag.kind === 'lut') {
    const { matrix, inCurves, clut, outCurves } = tag;
    return (input) => {
      let v = Array.from(input);
      if (matrix) v = mul3(matrix, v).map(clamp01);
      applyCurves(inCurves, v);
      const out = Array.from(clutEval(clut, v));
      return applyCurves(outCurves, out);
    };
  }
  const { A, clut, M, matrix, B } = tag;
  const mat = (v) => {
    const r = mul3(matrix.m, v);
    return [clamp01(r[0] + matrix.offset[0]), clamp01(r[1] + matrix.offset[1]), clamp01(r[2] + matrix.offset[2])];
  };
  if (tag.kind === 'mAB') {
    return (input) => {
      let v = Array.from(input);
      if (A) applyCurves(A, v);
      if (clut) v = Array.from(clutEval(clut, v));
      if (M) applyCurves(M, v);
      if (matrix) v = mat(v);
      return applyCurves(B, v);
    };
  }
  return (input) => {
    let v = Array.from(input);
    applyCurves(B, v);
    if (matrix) v = mat(v);
    if (M) applyCurves(M, v);
    if (clut) v = Array.from(clutEval(clut, v));
    if (A) applyCurves(A, v);
    return v;
  };
}

// PCS encodings of normalized table values: Lab in lut16 tags uses the
// legacy encoding (L* 100 at 0xFF00); lut8, lutAtoB and lutBtoA the v4 one.
const XYZ_SCALE = 65535 / 32768;
function pcsCodec(pcs, tag) {
  if (pcs === 'XYZ ') {
    return { decode: (v) => [v[0] * XYZ_SCALE, v[1] * XYZ_SCALE, v[2] * XYZ_SCALE], encode: (x) => [clamp01(x[0] / XYZ_SCALE), clamp01(x[1] / XYZ_SCALE), clamp01(x[2] / XYZ_SCALE)] };
  }
  if (tag.kind === 'lut' && tag.bits === 16) {
    const L = 65535 / 65280;
    const AB = 65535 / 256;
    return {
      decode: (v) => labToXyz([v[0] * L * 100, v[1] * AB - 128, v[2] * AB - 128]),
      encode: (x) => {
        const lab = xyzToLab(x);
        return [clamp01(lab[0] / 100 / L), clamp01((lab[1] + 128) / AB), clamp01((lab[2] + 128) / AB)];
      },
    };
  }
  return {
    decode: (v) => labToXyz([v[0] * 100, v[1] * 255 - 128, v[2] * 255 - 128]),
    encode: (x) => {
      const lab = xyzToLab(x);
      return [clamp01(lab[0] / 100), clamp01((lab[1] + 128) / 255), clamp01((lab[2] + 128) / 255)];
    },
  };
}

// ---- models from ICC profiles ----

const usable = (t) => t && (t.kind === 'lut' || t.kind === 'mAB' || t.kind === 'mBA');

/** Media white of a profile in the PCS: display profiles count as D50 (v4 rule, applied to v2 too). */
function mediaWhite(p) {
  if (p.deviceClass === 'mntr' || !p.whitePoint) return D50.slice();
  return p.whitePoint;
}

/** Build an engine model from a parsed profile. Throws when the profile cannot convert colors. */
export function modelFromProfile(p, key = null) {
  const tags = p.tags;
  const model = {
    key: key || `icc:${p.id || p.size}:${p.description}`,
    name: p.description,
    colorSpace: p.colorSpace,
    channels: p.channels,
    deviceClass: p.deviceClass,
    version: p.version.major,
    mediaWhite: mediaWhite(p),
    profile: p,
  };
  const lutFor = (prefix, intent) => {
    const t = tags.get(`${prefix}${TAG_INDEX[intent]}`);
    if (usable(t)) return t;
    const t0 = tags.get(`${prefix}0`);
    return usable(t0) ? t0 : null;
  };
  const curve = (s) => (tags.get(s)?.kind === 'curve' ? tags.get(s).curve : null);
  const xyz = (s) => (tags.get(s)?.kind === 'XYZ' ? tags.get(s).values[0] : null);
  const rgbMatrix = p.colorSpace === 'RGB ' && xyz('rXYZ') && xyz('gXYZ') && xyz('bXYZ') && curve('rTRC') && curve('gTRC') && curve('bTRC');
  const grayTrc = p.colorSpace === 'GRAY' && curve('kTRC');

  let shaperTo = null;
  let shaperFrom = null;
  if (rgbMatrix) {
    const [r, g, b] = [xyz('rXYZ'), xyz('gXYZ'), xyz('bXYZ')];
    const M = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
    const Mi = inv3(M);
    const trc = [curve('rTRC'), curve('gTRC'), curve('bTRC')];
    const inv = trc.map(invertCurve);
    shaperTo = (v) => mul3(M, [trc[0].eval(clamp01(v[0])), trc[1].eval(clamp01(v[1])), trc[2].eval(clamp01(v[2]))]);
    if (Mi) shaperFrom = (x) => { const l = mul3(Mi, x); return [inv[0](clamp01(l[0])), inv[1](clamp01(l[1])), inv[2](clamp01(l[2]))]; };
    model.matrixShaper = true;
    model.matrix = M;
  } else if (grayTrc) {
    const trc = curve('kTRC');
    const inv = invertCurve(trc);
    // A gray profile's curve gives luminance (Y) or, with a Lab PCS, L*/100.
    if (p.pcs === 'Lab ') {
      shaperTo = (v) => labToXyz([trc.eval(clamp01(v[0])) * 100, 0, 0]);
      shaperFrom = (x) => [inv(clamp01(xyzToLab(x)[0] / 100))];
    } else {
      shaperTo = (v) => { const y = trc.eval(clamp01(v[0])); return [D50[0] * y, y, D50[2] * y]; };
      shaperFrom = (x) => [inv(clamp01(x[1]))];
    }
    model.matrixShaper = true;
  }
  const hasA2B = usable(tags.get('A2B0')) || usable(tags.get('A2B1'));
  const hasB2A = usable(tags.get('B2A0')) || usable(tags.get('B2A1'));
  model.toPcs = (intent) => {
    const t = lutFor('A2B', intent);
    if (t) {
      const fn = lutFunction(t);
      const codec = pcsCodec(p.pcs, t);
      if (t.inputs !== p.channels || t.outputs !== 3) return null;
      return (v) => codec.decode(fn(v));
    }
    return shaperTo;
  };
  model.fromPcs = (intent) => {
    const t = lutFor('B2A', intent);
    if (t) {
      const fn = lutFunction(t);
      const codec = pcsCodec(p.pcs, t);
      if (t.inputs !== 3 || t.outputs !== p.channels) return null;
      return (x) => fn(codec.encode(x));
    }
    return shaperFrom;
  };
  model.lutBased = hasA2B || hasB2A;
  if (!hasA2B && !shaperTo && !hasB2A) throw new Error('This profile has no color conversion tables.');
  return model;
}

// ---- black points ----

const neutral = (y) => [D50[0] * y, y, D50[2] * y];

/** The darkest color a model reproduces for an intent, as a neutral PCS XYZ (Y only). */
export function blackPoint(model, intent) {
  if (intent === 'absolute') return [0, 0, 0];
  if (model.blackPoint) return model.blackPoint(intent);
  if (model.version >= 4 && model.lutBased && (intent === 'perceptual' || intent === 'saturation')) return PERCEPTUAL_BLACK.slice();
  const toRel = model.toPcs('relative');
  if (!toRel) return [0, 0, 0];
  let dev;
  if (model.colorSpace === 'CMYK' || model.channels > 3 || model.colorSpace === 'CMY ') {
    // Ink-based devices: the darkest colorant mix the profile itself chooses for black.
    const from = model.fromPcs(intent) || model.fromPcs('relative');
    dev = from ? from([0, 0, 0]) : new Array(model.channels).fill(1);
  } else if (model.colorSpace === 'Lab ' || model.colorSpace === 'XYZ ') return [0, 0, 0];
  else dev = new Array(model.channels).fill(0);
  const y = toRel(dev)[1];
  return neutral(Math.max(0, Math.min(0.5, y)));
}

/** Black point compensation: a per-component scale mapping src black to dst black and keeping D50 white. */
export function bpcFunction(src, dst) {
  if (Math.abs(src[1] - dst[1]) < 1e-6) return null;
  const a = [];
  const b = [];
  for (let i = 0; i < 3; i++) {
    const t = src[i] - D50[i];
    a.push(Math.abs(t) < 1e-9 ? 1 : (dst[i] - D50[i]) / t);
    b.push(Math.abs(t) < 1e-9 ? 0 : (-D50[i] * (dst[i] - src[i])) / t);
  }
  return (x) => [a[0] * x[0] + b[0], a[1] * x[1] + b[1], a[2] * x[2] + b[2]];
}

// ---- transforms ----

/**
 * A transform from one model to another:
 *   { nIn, nOut, key, convert(values) -> values (exact), lut(n?) -> baked }
 * opts: intent (default 'relative'), bpc (default false).
 */
export function createTransform(src, dst, { intent = 'relative', bpc = false } = {}) {
  if (!INTENT_IDS.includes(intent)) intent = 'relative';
  const to = src.toPcs(intent) || src.toPcs('perceptual') || src.toPcs('relative');
  const from = dst.fromPcs(intent) || dst.fromPcs('perceptual') || dst.fromPcs('relative');
  if (!to) throw new Error(`“${src.name}” cannot be used as a source profile.`);
  if (!from) throw new Error(`“${dst.name}” cannot be used as a destination profile.`);
  const steps = [];
  if (intent === 'absolute') {
    const ws = src.mediaWhite;
    const wd = dst.mediaWhite;
    const k = [ws[0] / wd[0], ws[1] / wd[1], ws[2] / wd[2]];
    if (k.some((v) => Math.abs(v - 1) > 1e-4)) steps.push((x) => [x[0] * k[0], x[1] * k[1], x[2] * k[2]]);
  } else if (bpc) {
    const fn = bpcFunction(blackPoint(src, intent), blackPoint(dst, intent));
    if (fn) steps.push(fn);
  }
  const pcs = steps.length ? (x) => steps.reduce((v, f) => f(v), x) : (x) => x;
  const t = makeTransform(src.channels, dst.channels, `${src.key}>${dst.key}|${intent}|${bpc ? 1 : 0}`, (v) => from(pcs(to(v))));
  if (dst.costly && src.channels === 3) t.grid = 17;
  return t;
}

/** A transform object around a function. */
export function makeTransform(nIn, nOut, key, fn) {
  const t = {
    nIn,
    nOut,
    key,
    convert: (v) => fn(v).map((x) => clamp01(x)),
    /** Converted through the baked table: fast, close to convert(). */
    fast: (v, out) => t.lut().eval(v, out),
    lut: (n = t.grid || defaultGrid(nIn)) => {
      t._luts ||= new Map();
      if (!t._luts.has(n)) t._luts.set(n, bake(t, n));
      return t._luts.get(n);
    },
  };
  return t;
}

/** Transforms one after the other (a proof: document -> press -> display). Costly links go through their tables. */
export function chainTransforms(...ts) {
  const list = ts.filter(Boolean);
  return makeTransform(list[0].nIn, list[list.length - 1].nOut, list.map((t) => t.key).join('»'), (v) => list.reduce((x, t) => (t.grid ? Array.from(t.fast(x)) : t.convert(x)), v));
}

export const defaultGrid = (nIn) => (nIn === 1 ? 256 : nIn === 3 ? 33 : nIn === 4 ? 17 : 9);

// ---- baked tables ----

/**
 * Sample a transform on a regular grid of n points per input:
 *   { n, nIn, nOut, data: Float32Array (first input slowest), eval(values, out) }
 * Three-input tables interpolate tetrahedrally, others multilinearly.
 */
export function bake(t, n) {
  const { nIn, nOut } = t;
  const total = n ** nIn;
  const data = new Float32Array(total * nOut);
  const x = new Array(nIn).fill(0);
  for (let i = 0; i < total; i++) {
    let r = i;
    for (let k = nIn - 1; k >= 0; k--) {
      x[k] = (r % n) / (n - 1);
      r = Math.floor(r / n);
    }
    const y = t.convert(x);
    for (let o = 0; o < nOut; o++) data[i * nOut + o] = y[o];
  }
  const lut = { n, nIn, nOut, data };
  lut.eval = evaluator(lut);
  return lut;
}

function tetra(data, n, nOut, base, x, y, z, out) {
  const n1 = n - 1;
  const fx = clamp01(x) * n1;
  const fy = clamp01(y) * n1;
  const fz = clamp01(z) * n1;
  const x0 = Math.min(n1 - 1, Math.floor(fx));
  const y0 = Math.min(n1 - 1, Math.floor(fy));
  const z0 = Math.min(n1 - 1, Math.floor(fz));
  const rx = fx - x0;
  const ry = fy - y0;
  const rz = fz - z0;
  const sx = n * n * nOut;
  const sy = n * nOut;
  const sz = nOut;
  const c0 = base + x0 * sx + y0 * sy + z0 * sz;
  // Pick the tetrahedron containing the point; walk its edges from c0 to c111.
  let a;
  let b;
  let ra;
  let rb;
  let rc;
  if (rx >= ry) {
    if (ry >= rz) [a, b, ra, rb, rc] = [sx, sx + sy, rx, ry, rz];
    else if (rx >= rz) [a, b, ra, rb, rc] = [sx, sx + sz, rx, rz, ry];
    else [a, b, ra, rb, rc] = [sz, sx + sz, rz, rx, ry];
  } else if (rz >= ry) [a, b, ra, rb, rc] = [sz, sy + sz, rz, ry, rx];
  else if (rz >= rx) [a, b, ra, rb, rc] = [sy, sy + sz, ry, rz, rx];
  else [a, b, ra, rb, rc] = [sy, sx + sy, ry, rx, rz];
  const c1 = c0 + a;
  const c2 = c0 + b;
  const c3 = c0 + sx + sy + sz;
  for (let o = 0; o < nOut; o++) {
    const v0 = data[c0 + o];
    const v1 = data[c1 + o];
    const v2 = data[c2 + o];
    const v3 = data[c3 + o];
    out[o] = v0 + ra * (v1 - v0) + rb * (v2 - v1) + rc * (v3 - v2);
  }
}

function evaluator(lut) {
  const { n, nIn, nOut, data } = lut;
  if (nIn === 3) return (v, out = new Float32Array(nOut)) => (tetra(data, n, nOut, 0, v[0], v[1], v[2], out), out);
  if (nIn === 4) {
    const n1 = n - 1;
    return (v, out = new Float32Array(nOut)) => {
      const fk = clamp01(v[3]) * n1;
      const k0 = Math.min(n1 - 1, Math.floor(fk));
      return quad(data, n, nOut, v, k0, fk - k0, out);
    };
  }
  return (v, out = new Float32Array(nOut)) => {
    const x = new Array(nIn);
    for (let i = 0; i < nIn; i++) x[i] = v[i];
    const res = clutEval({ grid: new Array(nIn).fill(n), inputs: nIn, outputs: nOut, data }, x);
    for (let o = 0; o < nOut; o++) out[o] = res[o];
    return out;
  };
}

// Four inputs (first slowest, fourth fastest): multilinear over the 16 corners.
function quad(data, n, nOut, v, k0, rk, out) {
  const n1 = n - 1;
  const idx = [];
  const fr = [];
  for (let i = 0; i < 3; i++) {
    const p = clamp01(v[i]) * n1;
    const i0 = Math.min(n1 - 1, Math.floor(p));
    idx.push(i0);
    fr.push(p - i0);
  }
  const s0 = n * n * n * nOut;
  const s1 = n * n * nOut;
  const s2 = n * nOut;
  const s3 = nOut;
  for (let o = 0; o < nOut; o++) out[o] = 0;
  for (let c = 0; c < 16; c++) {
    const w = (c & 1 ? fr[0] : 1 - fr[0]) * (c & 2 ? fr[1] : 1 - fr[1]) * (c & 4 ? fr[2] : 1 - fr[2]) * (c & 8 ? rk : 1 - rk);
    if (!w) continue;
    const off = (idx[0] + (c & 1 ? 1 : 0)) * s0 + (idx[1] + (c & 2 ? 1 : 0)) * s1 + (idx[2] + (c & 4 ? 1 : 0)) * s2 + (k0 + (c & 8 ? 1 : 0)) * s3;
    for (let o = 0; o < nOut; o++) out[o] += w * data[off + o];
  }
  return out;
}
