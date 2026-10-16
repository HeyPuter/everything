// Camera intrinsics of the solver: focal length and optical center in pixels, pixel aspect and a
// lens distortion model. Image coordinates are pixels with the origin at the bottom-left corner
// (y up), like markers. Normalized coordinates (x, y) are the undistorted image plane at unit
// distance with y up:
//   px = cx + f · xd,   py = cy + f · aspect · yd,   (xd, yd) = distort(x, y)
//
// Distortion models (all in normalized coordinates, r² = x² + y²):
//   POLYNOMIAL  xd = x (1 + k1 r² + k2 r⁴ + k3 r⁶)
//   DIVISION    x = xd / (1 + k1 rd² + k2 rd⁴)            (defined from distorted to undistorted)
//   BROWN       xd = x (1 + k1 r² + k2 r⁴ + k3 r⁶ + k4 r⁸) + 2 p1 x y + p2 (r² + 2x²)
//               yd = y (1 + …)                              + p1 (r² + 2y²) + 2 p2 x y

export type DistortionModel = 'POLYNOMIAL' | 'DIVISION' | 'BROWN';

export interface Intrinsics {
  focal: number;
  cx: number;
  cy: number;
  aspect: number;
  model: DistortionModel;
  /** radial coefficients k1..k4 (POLYNOMIAL uses 3, DIVISION 2, BROWN 4) */
  k: [number, number, number, number];
  /** tangential coefficients (BROWN) */
  p: [number, number];
}

export function radialCount(model: DistortionModel) {
  return model === 'POLYNOMIAL' ? 3 : model === 'DIVISION' ? 2 : 4;
}

export function cloneIntrinsics(I: Intrinsics): Intrinsics {
  return { ...I, k: [...I.k] as Intrinsics['k'], p: [...I.p] as Intrinsics['p'] };
}

export function hasDistortion(I: Intrinsics) {
  return I.k.some((v) => v !== 0) || (I.model === 'BROWN' && (I.p[0] !== 0 || I.p[1] !== 0));
}

/** Distorted normalized coordinates of an undistorted normalized point. */
export function distort(I: Intrinsics, x: number, y: number): [number, number] {
  const [k1, k2, k3, k4] = I.k;
  if (I.model === 'DIVISION') {
    if (k1 === 0 && k2 === 0) return [x, y];
    // solve x = xd / D(rd²) for xd along the same ray: xd = x · s with s = D(s² r²)
    const r2 = x * x + y * y;
    let s = 1;
    for (let i = 0; i < 30; i++) {
      const rd2 = s * s * r2;
      const D = 1 + k1 * rd2 + k2 * rd2 * rd2;
      // Newton on g(s) = s − D(s² r²)
      const dD = (k1 + 2 * k2 * rd2) * 2 * s * r2;
      const g = s - D,
        dg = 1 - dD;
      const ns = Math.abs(dg) > 1e-12 ? s - g / dg : D;
      if (!Number.isFinite(ns) || ns <= 0) break;
      if (Math.abs(ns - s) < 1e-14) {
        s = ns;
        break;
      }
      s = ns;
    }
    return [x * s, y * s];
  }
  const r2 = x * x + y * y;
  let L = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
  if (I.model === 'BROWN') {
    L += k4 * r2 * r2 * r2 * r2;
    const [p1, p2] = I.p;
    return [x * L + 2 * p1 * x * y + p2 * (r2 + 2 * x * x), y * L + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y];
  }
  return [x * L, y * L];
}

/** Undistorted normalized coordinates of a distorted normalized point (inverse of `distort`). */
export function undistort(I: Intrinsics, xd: number, yd: number): [number, number] {
  if (!hasDistortion(I)) return [xd, yd];
  if (I.model === 'DIVISION') {
    const rd2 = xd * xd + yd * yd;
    const D = 1 + I.k[0] * rd2 + I.k[1] * rd2 * rd2;
    return [xd / D, yd / D];
  }
  // Newton iterations on distort(x) = xd starting from xd
  let x = xd,
    y = yd;
  for (let i = 0; i < 40; i++) {
    const [dx, dy] = distort(I, x, y);
    const ex = dx - xd,
      ey = dy - yd;
    if (ex * ex + ey * ey < 1e-26) break;
    const J = distortJacobian(I, x, y);
    const det = J[0] * J[3] - J[1] * J[2];
    if (Math.abs(det) < 1e-12) break;
    x -= (J[3] * ex - J[1] * ey) / det;
    y -= (-J[2] * ex + J[0] * ey) / det;
  }
  return [x, y];
}

/** ∂(xd, yd)/∂(x, y) as [a, b, c, d] (row-major 2×2). */
export function distortJacobian(I: Intrinsics, x: number, y: number): [number, number, number, number] {
  const [k1, k2, k3, k4] = I.k;
  if (I.model === 'DIVISION') {
    if (k1 === 0 && k2 === 0) return [1, 0, 0, 1];
    const [xd, yd] = distort(I, x, y);
    const g = divisionUndistortJacobian(k1, k2, xd, yd);
    const det = g[0] * g[3] - g[1] * g[2];
    return [g[3] / det, -g[1] / det, -g[2] / det, g[0] / det];
  }
  const r2 = x * x + y * y;
  let L = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
  let dL = k1 + 2 * k2 * r2 + 3 * k3 * r2 * r2;
  if (I.model === 'BROWN') {
    L += k4 * r2 * r2 * r2 * r2;
    dL += 4 * k4 * r2 * r2 * r2;
  }
  let a = L + 2 * x * x * dL,
    b = 2 * x * y * dL,
    c = 2 * x * y * dL,
    d = L + 2 * y * y * dL;
  if (I.model === 'BROWN') {
    const [p1, p2] = I.p;
    a += 2 * p1 * y + 6 * p2 * x;
    b += 2 * p1 * x + 2 * p2 * y;
    c += 2 * p1 * x + 2 * p2 * y;
    d += 6 * p1 * y + 2 * p2 * x;
  }
  return [a, b, c, d];
}

/** Jacobian of the division model's undistortion x = xd / D(rd²) with respect to (xd, yd). */
function divisionUndistortJacobian(k1: number, k2: number, xd: number, yd: number): [number, number, number, number] {
  const rd2 = xd * xd + yd * yd;
  const D = 1 + k1 * rd2 + k2 * rd2 * rd2;
  const dD = k1 + 2 * k2 * rd2; // ∂D/∂rd²
  const q = (2 * dD) / (D * D);
  return [1 / D - q * xd * xd, -q * xd * yd, -q * xd * yd, 1 / D - q * yd * yd];
}

/**
 * Derivatives of (xd, yd) with respect to the distortion coefficients, in parameter order
 * k1..kN (radialCount) then p1, p2 (BROWN, when `tangential`).
 */
export function distortCoeffJacobian(I: Intrinsics, x: number, y: number, radial: boolean, tangential: boolean): number[][] {
  const out: number[][] = [];
  const r2 = x * x + y * y;
  if (I.model === 'DIVISION') {
    if (!radial) return out;
    const [xd, yd] = distort(I, x, y);
    const rd2 = xd * xd + yd * yd;
    const D = 1 + I.k[0] * rd2 + I.k[1] * rd2 * rd2;
    const g = divisionUndistortJacobian(I.k[0], I.k[1], xd, yd);
    const det = g[0] * g[3] - g[1] * g[2];
    for (const pw of [rd2, rd2 * rd2]) {
      // ∂x/∂k = −xd · pw / D², and J_g · ∂xd/∂k = −∂x/∂k
      const gx = (xd * pw) / (D * D),
        gy = (yd * pw) / (D * D);
      out.push([(g[3] * gx - g[1] * gy) / det, (-g[2] * gx + g[0] * gy) / det]);
    }
    return out;
  }
  if (radial) {
    const n = radialCount(I.model);
    let pw = r2;
    for (let i = 0; i < n; i++) {
      out.push([x * pw, y * pw]);
      pw *= r2;
    }
  }
  if (tangential && I.model === 'BROWN') {
    out.push([2 * x * y, r2 + 2 * y * y]);
    out.push([r2 + 2 * x * x, 2 * x * y]);
  }
  return out;
}

/** Pixel position (origin bottom-left) of an undistorted normalized point. */
export function toPixel(I: Intrinsics, x: number, y: number): [number, number] {
  const [xd, yd] = distort(I, x, y);
  return [I.cx + I.focal * xd, I.cy + I.focal * I.aspect * yd];
}

/** Undistorted normalized point of a pixel position (origin bottom-left). */
export function fromPixel(I: Intrinsics, px: number, py: number): [number, number] {
  return undistort(I, (px - I.cx) / I.focal, (py - I.cy) / (I.focal * I.aspect));
}

/** Names of the refined intrinsic parameters, in the order the bundle adjuster packs them. */
export function intrinsicParamNames(I: Intrinsics, refine: RefineFlags): string[] {
  const out: string[] = [];
  if (refine.focal_length) out.push('focal');
  if (refine.principal_point) out.push('cx', 'cy');
  if (refine.radial_distortion) {
    const n = radialCount(I.model);
    for (let i = 0; i < n; i++) out.push(`k${i + 1}`);
  }
  if (refine.tangential_distortion && I.model === 'BROWN') out.push('p1', 'p2');
  return out;
}

export interface RefineFlags {
  focal_length: boolean;
  principal_point: boolean;
  radial_distortion: boolean;
  tangential_distortion: boolean;
}

export function getParam(I: Intrinsics, name: string): number {
  if (name === 'focal') return I.focal;
  if (name === 'cx') return I.cx;
  if (name === 'cy') return I.cy;
  if (name[0] === 'k') return I.k[Number(name[1]) - 1];
  return I.p[Number(name[1]) - 1];
}

export function setParam(I: Intrinsics, name: string, v: number) {
  if (name === 'focal') I.focal = v;
  else if (name === 'cx') I.cx = v;
  else if (name === 'cy') I.cy = v;
  else if (name[0] === 'k') I.k[Number(name[1]) - 1] = v;
  else I.p[Number(name[1]) - 1] = v;
}
