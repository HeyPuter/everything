// Develop geometry: upright analysis and the perspective / rotation transform.
//
// All sliders build one 3 x 3 homography in normalized coordinates centered
// on the image and scaled by half the long side (so rotations stay rigid on
// non-square images and the result does not depend on resolution). The
// forward map from source to output is
//   F = Offset * Scale * Aspect * Keystone * Rotate,
// where Rotate turns the picture clockwise for positive degrees, Keystone is
// [[1, 0, 0], [0, 1, 0], [px, py, 1]] (negative Vertical enlarges the top,
// which straightens verticals that converge upward; negative Horizontal
// enlarges the left side), Aspect stretches x and squeezes y for positive
// values, and the offsets move the picture right and up. The output is
// inverse-mapped through F^-1 with alpha-weighted bilinear sampling. With
// Constrain the result is zoomed by the smallest factor >= 1 that maps every
// frame edge point inside the source, so no empty area remains.
//
// Upright analysis works on a copy resized to a 640 px long side: edge points
// (Sobel gradient after a light blur, thinned by non-maximum suppression) vote
// in two Hough accumulators, one for lines within 30 degrees of vertical and
// one for lines near horizontal. Peaks are accepted only when a long
// contiguous run of edge points supports them, and each accepted segment is
// refit by total least squares. The roll is the weighted median tilt of all
// segments; the vertical vanishing point is the least-squares intersection of
// the near-vertical lines (smallest eigenvector of sum(w l l^T) in homogeneous
// coordinates, which also handles parallel lines at infinity). Rotating it
// onto the vertical axis gives the roll for the perspective modes, and the
// keystone py = -1 / vy sends it to infinity, making those lines parallel.
// Images without long straight lines (noise, smooth gradients) yield zeros.
import type { ParamValues, Progress, RGBA8 } from '../../types';
import { checkCancelled } from '../../types';
import { resize } from '../resample';
import { bool, num, sampleBilinear, str } from '../sampling';
import { boxBlur } from './detail';

export type UprightMode = 'auto' | 'level' | 'vertical' | 'full';
export type UprightResult = { rotate: number; vertical: number; horizontal: number };

// Keystone strength at slider +-100 (homogeneous coefficient).
const KV = 0.5,
  KH = 0.5;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const DEG = Math.PI / 180;

type M3 = Float64Array;
const m3 = (...v: number[]): M3 => Float64Array.from(v);
function mul(a: M3, b: M3): M3 {
  const r = new Float64Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}
function inv(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const k = Math.abs(det) > 1e-300 ? 1 / det : 0;
  return m3(
    A * k,
    -(b * i - c * h) * k,
    (b * f - c * e) * k,
    B * k,
    (a * i - c * g) * k,
    -(a * f - c * d) * k,
    C * k,
    -(a * h - b * g) * k,
    (a * e - b * d) * k,
  );
}

const SLIDERS = [
  'geoVertical',
  'geoHorizontal',
  'geoRotate',
  'geoAspect',
  'geoOffsetX',
  'geoOffsetY',
];

export function geometryActive(p: ParamValues): boolean {
  return (
    str(p, 'upright', 'off') !== 'off' ||
    SLIDERS.some((k) => num(p, k, 0) !== 0) ||
    num(p, 'geoScale', 100) !== 100
  );
}

/**
 * Forward homography (source -> output) in normalized coordinates, without the
 * Constrain zoom. Exported for the UI (guides, crop overlays) and tests.
 */
export function geometryMatrix(
  p: ParamValues,
  width: number,
  height: number,
  upright?: UprightResult,
): M3 {
  const u = upright ?? { rotate: 0, vertical: 0, horizontal: 0 };
  const S = Math.max(width, height) / 2;
  const rot = (clamp(num(p, 'geoRotate', 0), -10, 10) + u.rotate) * DEG,
    vert = clamp(num(p, 'geoVertical', 0) + u.vertical, -100, 100) / 100,
    hor = clamp(num(p, 'geoHorizontal', 0) + u.horizontal, -100, 100) / 100,
    asp = clamp(num(p, 'geoAspect', 0), -100, 100) / 100,
    sc = clamp(num(p, 'geoScale', 100), 50, 150) / 100,
    ox = clamp(num(p, 'geoOffsetX', 0), -100, 100) / 100,
    oy = clamp(num(p, 'geoOffsetY', 0), -100, 100) / 100;
  const c = Math.cos(rot),
    s = Math.sin(rot);
  const R = m3(c, -s, 0, s, c, 0, 0, 0, 1),
    P = m3(1, 0, 0, 0, 1, 0, -KH * hor, -KV * vert, 1),
    A = m3(Math.pow(2, 0.5 * asp), 0, 0, 0, Math.pow(2, -0.5 * asp), 0, 0, 0, 1),
    Z = m3(sc, 0, 0, 0, sc, 0, 0, 0, 1),
    T = m3(1, 0, (ox * width) / 2 / S, 0, 1, (-oy * height) / 2 / S, 0, 0, 1);
  return mul(T, mul(Z, mul(A, mul(P, R))));
}

// Smallest zoom z >= 1 such that every frame edge point maps inside the source.
function constrainZoom(F: M3, hw: number, hh: number): number {
  const G = inv(F),
    tol = 1e-6;
  const fits = (z: number) => {
    const n = 32;
    for (let k = 0; k <= n; k++) {
      const t = -1 + (2 * k) / n;
      for (const [x, y] of [
        [t * hw, -hh],
        [t * hw, hh],
        [-hw, t * hh],
        [hw, t * hh],
      ]) {
        const qx = x / z,
          qy = y / z;
        const w = G[6] * qx + G[7] * qy + G[8];
        if (!(w > 0)) return false;
        const u = (G[0] * qx + G[1] * qy + G[2]) / w,
          v = (G[3] * qx + G[4] * qy + G[5]) / w;
        if (Math.abs(u) > hw + tol || Math.abs(v) > hh + tol) return false;
      }
    }
    return true;
  };
  if (fits(1)) return 1;
  let lo = 1,
    hi = 16;
  if (!fits(hi)) return hi;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (fits(m)) hi = m;
    else lo = m;
  }
  return hi;
}

/**
 * Perspective and rotation correction. Output has the same size as the input;
 * areas outside the source become transparent unless geoConstrain is on (then
 * the result is scaled to fill). `upright` passes a cached detectUpright result;
 * without it the analysis runs on `src` when the upright mode is not 'off'.
 */
export function transformGeometry(
  src: RGBA8,
  p: ParamValues,
  _scale: number,
  progress?: Progress,
  upright?: UprightResult,
): RGBA8 {
  if (!geometryActive(p)) return src;
  const { width: W, height: H } = src;
  const mode = str(p, 'upright', 'off');
  let u = upright;
  if (!u && (mode === 'auto' || mode === 'level' || mode === 'vertical' || mode === 'full'))
    u = detectUpright(src, mode);
  const S = Math.max(W, H) / 2,
    hw = W / 2 / S,
    hh = H / 2 / S;
  let F = geometryMatrix(p, W, H, u);
  const constrain = bool(p, 'geoConstrain', false);
  if (constrain) {
    const z = constrainZoom(F, hw, hh);
    F = mul(m3(z, 0, 0, 0, z, 0, 0, 0, 1), F);
  }
  // Nothing to do (for example an upright analysis that found no lines).
  const ID = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (F.every((v, i) => Math.abs(v - ID[i]) < 1e-12)) return src;
  // Pixel -> normalized and back.
  const N = m3(1 / S, 0, -hw, 0, 1 / S, -hh, 0, 0, 1),
    Ni = m3(S, 0, W / 2, 0, S, H / 2, 0, 0, 1);
  const G = mul(Ni, mul(inv(F), N));
  const out: RGBA8 = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) },
    od = out.data,
    px = new Float32Array(4),
    edge = constrain ? 'clamp' : 'transparent';
  for (let y = 0; y < H; y++) {
    if ((y & 63) === 0) {
      checkCancelled(progress);
      progress?.report?.(y / H);
    }
    const cy = y + 0.5;
    let X = G[0] * 0.5 + G[1] * cy + G[2],
      Yh = G[3] * 0.5 + G[4] * cy + G[5],
      Wh = G[6] * 0.5 + G[7] * cy + G[8];
    for (let x = 0, o = y * W * 4; x < W; x++, o += 4, X += G[0], Yh += G[3], Wh += G[6]) {
      if (!(Wh > 1e-12)) continue;
      sampleBilinear(src, X / Wh, Yh / Wh, edge, px, 0);
      od[o] = px[0];
      od[o + 1] = px[1];
      od[o + 2] = px[2];
      od[o + 3] = px[3];
    }
  }
  progress?.report?.(1);
  return out;
}

// ---------------------------------------------------------------------------
// Upright analysis.

type Segment = { tilt: number; len: number; l: [number, number, number] };

function smallestEigenvector(M: number[][]): [number, number, number] {
  // Cyclic Jacobi rotations on a symmetric 3 x 3 matrix.
  const a = M.map((r) => r.slice()),
    v = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += a[i][j] * a[i][j];
    if (off < 1e-24) break;
    for (let pI = 0; pI < 2; pI++)
      for (let q = pI + 1; q < 3; q++) {
        if (Math.abs(a[pI][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[pI][pI]) / (2 * a[pI][q]),
          t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
          c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][pI],
            akq = a[k][q];
          a[k][pI] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[pI][k],
            aqk = a[q][k];
          a[pI][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][pI],
            vkq = v[k][q];
          v[k][pI] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  let m = 0;
  for (let i = 1; i < 3; i++) if (a[i][i] < a[m][m]) m = i;
  return [v[0][m], v[1][m], v[2][m]];
}

function weightedMedian(items: { v: number; w: number }[]): number {
  const s = items.slice().sort((a, b) => a.v - b.v);
  const total = s.reduce((t, x) => t + x.w, 0);
  let acc = 0;
  for (const x of s) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return 0;
}

const ANALYSIS = 640,
  FAMILY = 30, // degrees around vertical / horizontal
  BIN = 0.25, // degrees per angle bin
  SPREAD = 2; // degrees each edge point votes around its own orientation

function findSegments(src: RGBA8): { vert: Segment[]; horz: Segment[] } {
  const k = ANALYSIS / Math.max(src.width, src.height);
  const w = Math.max(8, Math.round(src.width * k)),
    h = Math.max(8, Math.round(src.height * k));
  const img = resize(src, w, h, 'bilinear'),
    d = img.data,
    n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++)
    Y[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  boxBlur(Y, w, h, 1);
  boxBlur(Y, w, h, 1);
  const mag = new Float32Array(n),
    gxs = new Float32Array(n),
    gys = new Float32Array(n);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // Skip edges against transparency (frame borders of earlier transforms).
      if (
        d[(i - w - 1) * 4 + 3] < 200 ||
        d[(i + w + 1) * 4 + 3] < 200 ||
        d[(i - w + 1) * 4 + 3] < 200 ||
        d[(i + w - 1) * 4 + 3] < 200
      )
        continue;
      const gx =
          (Y[i - w + 1] +
            2 * Y[i + 1] +
            Y[i + w + 1] -
            Y[i - w - 1] -
            2 * Y[i - 1] -
            Y[i + w - 1]) /
          8,
        gy =
          (Y[i + w - 1] +
            2 * Y[i + w] +
            Y[i + w + 1] -
            Y[i - w - 1] -
            2 * Y[i - w] -
            Y[i - w + 1]) /
          8;
      gxs[i] = gx;
      gys[i] = gy;
      mag[i] = Math.sqrt(gx * gx + gy * gy);
    }
  // Non-maximum suppression along the gradient (a ramp's equal neighbours fail).
  const px: number[] = [],
    py: number[] = [],
    pa: number[] = [];
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x,
        m = mag[i];
      if (m < 6) continue;
      const ax = Math.abs(gxs[i]),
        ay = Math.abs(gys[i]);
      let step: number;
      if (ay < 0.4142 * ax) step = 1;
      else if (ax < 0.4142 * ay) step = w;
      else step = gxs[i] * gys[i] > 0 ? w + 1 : w - 1;
      if (!(m > mag[i - step] && m >= mag[i + step])) continue;
      px.push(x + 0.5 - w / 2);
      py.push(y + 0.5 - h / 2);
      // Normal angle of the line through the point, in [0, 180).
      let a = Math.atan2(gys[i], gxs[i]) / DEG;
      if (a < 0) a += 180;
      if (a >= 180) a -= 180;
      pa.push(a);
    }
  const S = Math.max(w, h) / 2,
    L = Math.max(w, h);
  const family = (base: number): Segment[] => {
    const TB = Math.round(FAMILY / BIN),
      nt = 2 * TB + 1,
      rmax = Math.ceil(Math.hypot(w, h) / 2) + 2,
      nr = 2 * rmax + 1;
    const acc = new Int32Array(nt * nr),
      cs = new Float64Array(nt),
      sn = new Float64Array(nt);
    for (let t = 0; t < nt; t++) {
      const th = (base + (t - TB) * BIN) * DEG;
      cs[t] = Math.cos(th);
      sn[t] = Math.sin(th);
    }
    const sp = Math.round(SPREAD / BIN);
    // Offset of each point's normal from the family base, in (-90, 90].
    const off = new Float64Array(px.length);
    for (let j = 0; j < px.length; j++) {
      let o = pa[j] - base;
      while (o > 90) o -= 180;
      while (o <= -90) o += 180;
      off[j] = o;
      if (Math.abs(o) > FAMILY + SPREAD) continue;
      const t0 = Math.round(o / BIN) + TB;
      for (let t = Math.max(0, t0 - sp); t <= Math.min(nt - 1, t0 + sp); t++) {
        const r = Math.round(px[j] * cs[t] + py[j] * sn[t]) + rmax;
        acc[t * nr + r]++;
      }
    }
    const minVotes = Math.round(0.06 * L),
      minLen = 0.08 * L,
      segs: Segment[] = [];
    for (let iter = 0; iter < 200 && segs.length < 40; iter++) {
      let best = 0,
        bi = -1;
      for (let i = 0; i < acc.length; i++)
        if (acc[i] > best) {
          best = acc[i];
          bi = i;
        }
      if (bi < 0 || best < minVotes) break;
      const bt = Math.floor(bi / nr),
        br = bi % nr,
        rho = br - rmax,
        c = cs[bt],
        s = sn[bt],
        angOff = (bt - TB) * BIN;
      // Points on the line with a compatible orientation, ordered along it.
      const on: { s: number; j: number }[] = [];
      for (let j = 0; j < px.length; j++) {
        if (Math.abs(px[j] * c + py[j] * s - rho) > 1.5) continue;
        let da = Math.abs(off[j] - angOff);
        if (da > 90) da = 180 - da;
        if (da > 6) continue;
        on.push({ s: -px[j] * s + py[j] * c, j });
      }
      on.sort((a, b) => a.s - b.s);
      let runStart = 0,
        bestStart = 0,
        bestEnd = -1;
      for (let q = 0; q < on.length; q++) {
        if (q > 0 && on[q].s - on[q - 1].s > 4) runStart = q;
        if (bestEnd < 0 || on[q].s - on[runStart].s > on[bestEnd].s - on[bestStart].s) {
          bestStart = runStart;
          bestEnd = q;
        }
      }
      const span = bestEnd >= 0 ? on[bestEnd].s - on[bestStart].s : 0,
        count = bestEnd - bestStart + 1;
      if (span >= minLen && count >= 0.5 * span) {
        // Total least squares fit of the supporting run.
        let mx = 0,
          my = 0;
        for (let q = bestStart; q <= bestEnd; q++) ((mx += px[on[q].j]), (my += py[on[q].j]));
        mx /= count;
        my /= count;
        let sxx = 0,
          sxy = 0,
          syy = 0;
        for (let q = bestStart; q <= bestEnd; q++) {
          const ex = px[on[q].j] - mx,
            ey = py[on[q].j] - my;
          sxx += ex * ex;
          sxy += ex * ey;
          syy += ey * ey;
        }
        const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        let dx = Math.cos(a),
          dy = Math.sin(a);
        let tilt: number;
        if (base === 0) {
          if (dy < 0) ((dx = -dx), (dy = -dy));
          tilt = Math.atan2(-dx, dy) / DEG;
        } else {
          if (dx < 0) ((dx = -dx), (dy = -dy));
          tilt = Math.atan2(dy, dx) / DEG;
        }
        const nx = -dy,
          ny = dx;
        segs.push({ tilt, len: span / L, l: [nx, ny, -(nx * mx + ny * my) / S] });
        for (let t = Math.max(0, bt - 8); t <= Math.min(nt - 1, bt + 8); t++)
          for (let r = Math.max(0, br - 4); r <= Math.min(nr - 1, br + 4); r++) acc[t * nr + r] = 0;
      } else {
        for (let t = Math.max(0, bt - 1); t <= Math.min(nt - 1, bt + 1); t++)
          for (let r = Math.max(0, br - 1); r <= Math.min(nr - 1, br + 1); r++) acc[t * nr + r] = 0;
      }
    }
    return segs;
  };
  return { vert: family(0), horz: family(90) };
}

// Least-squares vanishing point of a set of lines, homogeneous (unit length).
function vanishingPoint(segs: Segment[]): [number, number, number] {
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const s of segs)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += s.len * s.l[i] * s.l[j];
  return smallestEigenvector(M);
}

/**
 * Upright analysis: rotation (degrees) and perspective corrections (in slider
 * units -100..100) that make detected lines level / vertical. Deterministic and
 * resolution independent (analyzes a copy resized to a 640 px long side).
 */
export function detectUpright(src: RGBA8, mode: UprightMode): UprightResult {
  const none = { rotate: 0, vertical: 0, horizontal: 0 };
  if (src.width < 8 || src.height < 8) return none;
  const { vert, horz } = findSegments(src);
  const tilts = [...vert, ...horz]
    .filter((s) => Math.abs(s.tilt) <= 15)
    .map((s) => ({ v: s.tilt, w: s.len }));
  if (!tilts.length) return none;
  const level = clamp(-weightedMedian(tilts), -10, 10);
  const round = (v: number, q: number) => Math.round(v / q) * q + 0;
  if (mode === 'level') return { rotate: round(level, 0.01), vertical: 0, horizontal: 0 };
  let rotate = level,
    vertical = 0,
    horizontal = 0;
  const vertLen = vert.reduce((t, s) => t + s.len, 0);
  const confident = vert.length >= (mode === 'auto' ? 3 : 2) && (mode !== 'auto' || vertLen >= 0.5);
  if (confident) {
    const [p1, p2, p3] = vanishingPoint(vert);
    const th = Math.atan(p1 / p2);
    if (Number.isFinite(th) && Math.abs(th) <= 15 * DEG) {
      rotate = clamp(th / DEG, -10, 10);
      const c = Math.cos(rotate * DEG),
        s = Math.sin(rotate * DEG),
        den = s * p1 + c * p2;
      const py = Math.abs(den) > 1e-12 ? -p3 / den : 0;
      vertical = clamp((-100 * py) / KV, -100, 100);
      if (mode === 'auto') vertical *= 0.7;
    }
  }
  if (mode === 'full' && horz.length >= 2) {
    const [q1, q2, q3] = vanishingPoint(horz);
    const c = Math.cos(rotate * DEG),
      s = Math.sin(rotate * DEG),
      den = c * q1 - s * q2;
    const pxk = Math.abs(den) > 1e-12 ? -q3 / den : 0;
    horizontal = clamp((-100 * pxk) / KH, -100, 100);
  }
  return {
    rotate: round(rotate, 0.01),
    vertical: round(vertical, 0.1),
    horizontal: round(horizontal, 0.1),
  };
}
