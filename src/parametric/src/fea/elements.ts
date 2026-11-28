// 10-node (quadratic) tetrahedra and 6-node boundary triangles for linear
// isotropic elasticity: stiffness by 4-point Gauss quadrature (exact for
// straight-sided elements), consistent nodal loads for body forces and for
// tractions and pressures on curved faces, and stresses at the nodes.

import { GAUSS4, quadDerivs } from './mesher';

/** Lame constants of an isotropic material. */
export function lame(E: number, nu: number): { lambda: number; mu: number } {
  return { lambda: (E * nu) / ((1 + nu) * (1 - 2 * nu)), mu: E / (2 * (1 + nu)) };
}

/** Shape functions of the 10-node tetrahedron at volume coordinates (L1, L2, L3). */
export function quadShape(l1: number, l2: number, l3: number, out: Float64Array) {
  const l0 = 1 - l1 - l2 - l3;
  out[0] = l0 * (2 * l0 - 1); out[1] = l1 * (2 * l1 - 1); out[2] = l2 * (2 * l2 - 1); out[3] = l3 * (2 * l3 - 1);
  out[4] = 4 * l0 * l1; out[5] = 4 * l1 * l2; out[6] = 4 * l2 * l0; out[7] = 4 * l0 * l3; out[8] = 4 * l1 * l3; out[9] = 4 * l2 * l3;
}

const dN = new Float64Array(30);

/**
 * Gradients of the shape functions (x, y, z per node, 30 values) at volume
 * coordinates; returns the Jacobian determinant (6 times the volume for a straight element).
 */
export function shapeGradients(X: ArrayLike<number>, nodes: ArrayLike<number>, off: number, l1: number, l2: number, l3: number, g: Float64Array): number {
  quadDerivs(l1, l2, l3, dN);
  let j00 = 0, j01 = 0, j02 = 0, j10 = 0, j11 = 0, j12 = 0, j20 = 0, j21 = 0, j22 = 0;
  for (let a = 0; a < 10; a++) {
    const n = nodes[off + a] * 3;
    const x = X[n], y = X[n + 1], z = X[n + 2];
    const d0 = dN[a * 3], d1 = dN[a * 3 + 1], d2 = dN[a * 3 + 2];
    j00 += d0 * x; j01 += d0 * y; j02 += d0 * z;
    j10 += d1 * x; j11 += d1 * y; j12 += d1 * z;
    j20 += d2 * x; j21 += d2 * y; j22 += d2 * z;
  }
  const c00 = j11 * j22 - j12 * j21, c01 = j02 * j21 - j01 * j22, c02 = j01 * j12 - j02 * j11;
  const c10 = j12 * j20 - j10 * j22, c11 = j00 * j22 - j02 * j20, c12 = j02 * j10 - j00 * j12;
  const c20 = j10 * j21 - j11 * j20, c21 = j01 * j20 - j00 * j21, c22 = j00 * j11 - j01 * j10;
  const det = j00 * c00 + j01 * c10 + j02 * c20;
  const inv = 1 / det;
  // dN/dx = J^-1 dN/dxi, with J[i][j] = dx_j/dxi_i.
  for (let a = 0; a < 10; a++) {
    const d0 = dN[a * 3], d1 = dN[a * 3 + 1], d2 = dN[a * 3 + 2];
    g[a * 3] = (c00 * d0 + c01 * d1 + c02 * d2) * inv;
    g[a * 3 + 1] = (c10 * d0 + c11 * d1 + c12 * d2) * inv;
    g[a * 3 + 2] = (c20 * d0 + c21 * d1 + c22 * d2) * inv;
  }
  return det;
}

const grad = new Float64Array(30);

/**
 * Element stiffness (30 x 30, row-major, node-major degrees of freedom) of
 * element e: K_ab^ij = int lambda a_i b_j + mu a_j b_i + mu delta_ij (a . b) dV.
 * Returns false if the element is inverted.
 */
export function elementStiffness(X: ArrayLike<number>, tets: ArrayLike<number>, e: number, lambda: number, mu: number, K: Float64Array): boolean {
  K.fill(0);
  for (const [l1, l2, l3, w] of GAUSS4) {
    const det = shapeGradients(X, tets, e * 10, l1, l2, l3, grad);
    if (!(det > 0)) return false;
    const f = det * w;
    for (let a = 0; a < 10; a++) {
      const ax = grad[a * 3], ay = grad[a * 3 + 1], az = grad[a * 3 + 2];
      for (let b = a; b < 10; b++) {
        const bx = grad[b * 3], by = grad[b * 3 + 1], bz = grad[b * 3 + 2];
        const dot = mu * (ax * bx + ay * by + az * bz);
        const r = a * 3, c = b * 3;
        K[r * 30 + c] += f * (lambda * ax * bx + mu * ax * bx + dot);
        K[r * 30 + c + 1] += f * (lambda * ax * by + mu * ay * bx);
        K[r * 30 + c + 2] += f * (lambda * ax * bz + mu * az * bx);
        K[(r + 1) * 30 + c] += f * (lambda * ay * bx + mu * ax * by);
        K[(r + 1) * 30 + c + 1] += f * (lambda * ay * by + mu * ay * by + dot);
        K[(r + 1) * 30 + c + 2] += f * (lambda * ay * bz + mu * az * by);
        K[(r + 2) * 30 + c] += f * (lambda * az * bx + mu * ax * bz);
        K[(r + 2) * 30 + c + 1] += f * (lambda * az * by + mu * ay * bz);
        K[(r + 2) * 30 + c + 2] += f * (lambda * az * bz + mu * az * bz + dot);
      }
    }
  }
  // Mirror the upper node blocks.
  for (let a = 0; a < 10; a++) for (let b = a + 1; b < 10; b++) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) K[(b * 3 + j) * 30 + a * 3 + i] = K[(a * 3 + i) * 30 + b * 3 + j];
  }
  return true;
}

const Nv = new Float64Array(10);

/** Adds the consistent nodal loads of a body force b (force per volume) on element e to F. Returns the element's volume. */
export function addBodyForce(X: ArrayLike<number>, tets: ArrayLike<number>, e: number, b: ArrayLike<number>, F: Float64Array): number {
  let vol = 0;
  for (const [l1, l2, l3, w] of GAUSS4) {
    const det = shapeGradients(X, tets, e * 10, l1, l2, l3, grad);
    quadShape(l1, l2, l3, Nv);
    const f = det * w;
    vol += f;
    for (let a = 0; a < 10; a++) {
      const n = tets[e * 10 + a] * 3;
      F[n] += Nv[a] * f * b[0]; F[n + 1] += Nv[a] * f * b[1]; F[n + 2] += Nv[a] * f * b[2];
    }
  }
  return vol;
}

// 6-point Gauss rule on the triangle (degree 4): (s, t, weight of the unit triangle, area 1/2).
const TA = 0.445948490915965, TB = 0.091576213509771, WA = 0.223381589678011 / 2, WB = 0.109951743655322 / 2;
const TRI6: [number, number, number][] = [
  [TA, TA, WA], [1 - 2 * TA, TA, WA], [TA, 1 - 2 * TA, WA],
  [TB, TB, WB], [1 - 2 * TB, TB, WB], [TB, 1 - 2 * TB, WB],
];

/** Shape functions and their s, t derivatives of the 6-node triangle (corners 0-2, then edges 01, 12, 20). */
function triShape(s: number, t: number, N: Float64Array, Ns: Float64Array, Nt: Float64Array) {
  const r = 1 - s - t;
  N[0] = r * (2 * r - 1); N[1] = s * (2 * s - 1); N[2] = t * (2 * t - 1); N[3] = 4 * r * s; N[4] = 4 * s * t; N[5] = 4 * t * r;
  Ns[0] = 1 - 4 * r; Ns[1] = 4 * s - 1; Ns[2] = 0; Ns[3] = 4 * (r - s); Ns[4] = 4 * t; Ns[5] = -4 * t;
  Nt[0] = 1 - 4 * r; Nt[1] = 0; Nt[2] = 4 * t - 1; Nt[3] = -4 * s; Nt[4] = 4 * s; Nt[5] = 4 * (r - t);
}

const tN = new Float64Array(6), tNs = new Float64Array(6), tNt = new Float64Array(6);

/**
 * Integrates over boundary triangle f (6 nodes): calls fn(node slot, weight N_a dA, n dA) per
 * quadrature point and node, with n dA the area-weighted outward normal. Returns its area.
 */
export function integrateTriangle(X: ArrayLike<number>, tris: ArrayLike<number>, f: number, fn?: (a: number, w: number, nx: number, ny: number, nz: number) => void): number {
  let area = 0;
  for (const [s, t, w] of TRI6) {
    triShape(s, t, tN, tNs, tNt);
    let sx = 0, sy = 0, sz = 0, tx = 0, ty = 0, tz = 0;
    for (let a = 0; a < 6; a++) {
      const n = tris[f * 6 + a] * 3;
      sx += tNs[a] * X[n]; sy += tNs[a] * X[n + 1]; sz += tNs[a] * X[n + 2];
      tx += tNt[a] * X[n]; ty += tNt[a] * X[n + 1]; tz += tNt[a] * X[n + 2];
    }
    const nx = (sy * tz - sz * ty) * w, ny = (sz * tx - sx * tz) * w, nz = (sx * ty - sy * tx) * w;
    const dA = Math.hypot(nx, ny, nz);
    area += dA;
    if (fn) for (let a = 0; a < 6; a++) fn(a, tN[a] * dA, tN[a] * nx, tN[a] * ny, tN[a] * nz);
  }
  return area;
}

/** Natural coordinates of the 10 nodes of the tetrahedron (L1, L2, L3). */
export const TET_NODES: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0], [0, 0, 0.5], [0.5, 0, 0.5], [0, 0.5, 0.5],
];

/**
 * Strain (xx, yy, zz, xy, yz, zx as tensor components) at each node of element e from
 * the displacements U; 60 values (6 per node).
 */
export function elementNodeStrains(X: ArrayLike<number>, tets: ArrayLike<number>, e: number, U: ArrayLike<number>, out: Float64Array) {
  for (let k = 0; k < 10; k++) {
    const [l1, l2, l3] = TET_NODES[k];
    shapeGradients(X, tets, e * 10, l1, l2, l3, grad);
    let uxx = 0, uxy = 0, uxz = 0, uyx = 0, uyy = 0, uyz = 0, uzx = 0, uzy = 0, uzz = 0;
    for (let a = 0; a < 10; a++) {
      const n = tets[e * 10 + a] * 3;
      const gx = grad[a * 3], gy = grad[a * 3 + 1], gz = grad[a * 3 + 2];
      const ux = U[n], uy = U[n + 1], uz = U[n + 2];
      uxx += ux * gx; uxy += ux * gy; uxz += ux * gz;
      uyx += uy * gx; uyy += uy * gy; uyz += uy * gz;
      uzx += uz * gx; uzy += uz * gy; uzz += uz * gz;
    }
    const o = k * 6;
    out[o] = uxx; out[o + 1] = uyy; out[o + 2] = uzz;
    out[o + 3] = (uxy + uyx) / 2; out[o + 4] = (uyz + uzy) / 2; out[o + 5] = (uzx + uxz) / 2;
  }
}

/** Eigenvalues of a symmetric 3 x 3 tensor (xx, yy, zz, xy, yz, zx), largest first. */
export function principal(xx: number, yy: number, zz: number, xy: number, yz: number, zx: number): [number, number, number] {
  const p1 = xy * xy + yz * yz + zx * zx;
  const q = (xx + yy + zz) / 3;
  if (p1 <= 1e-30 * (xx * xx + yy * yy + zz * zz + 1e-300)) {
    const v = [xx, yy, zz].sort((a, b) => b - a);
    return [v[0], v[1], v[2]];
  }
  const p2 = (xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const bxx = (xx - q) / p, byy = (yy - q) / p, bzz = (zz - q) / p, bxy = xy / p, byz = yz / p, bzx = zx / p;
  const detB = bxx * (byy * bzz - byz * byz) - bxy * (bxy * bzz - byz * bzx) + bzx * (bxy * byz - byy * bzx);
  const r = Math.max(-1, Math.min(1, detB / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  return [e1, 3 * q - e1 - e3, e3];
}
