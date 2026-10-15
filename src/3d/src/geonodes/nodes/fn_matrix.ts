// Matrix nodes (4×4, column-major, as matrix fields).
import './fdata';
import { gn } from './defs';
import { lift } from './flift';
import { fnField, matrixToEuler, type Evaluated } from '../field';
import { eulerToQuat, quatToMat3 } from '../rotmath';
import { invertMat } from '../geometry';

const M = (v: number | number[]) => v as number[];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function det4(a: ArrayLike<number>): number {
  const s0 = a[0] * a[5] - a[4] * a[1],
    s1 = a[0] * a[6] - a[4] * a[2],
    s2 = a[0] * a[7] - a[4] * a[3],
    s3 = a[1] * a[6] - a[5] * a[2],
    s4 = a[1] * a[7] - a[5] * a[3],
    s5 = a[2] * a[7] - a[6] * a[3];
  const c5 = a[10] * a[15] - a[14] * a[11],
    c4 = a[9] * a[15] - a[13] * a[11],
    c3 = a[9] * a[14] - a[13] * a[10],
    c2 = a[8] * a[15] - a[12] * a[11],
    c1 = a[8] * a[14] - a[12] * a[10],
    c0 = a[8] * a[13] - a[12] * a[9];
  return s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
}

export function mul4(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const r = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  return r;
}

/** Transform matrix from translation, rotation (Euler) and scale. */
export function composeTRS(t: ArrayLike<number>, e: ArrayLike<number>, s: ArrayLike<number>): number[] {
  const r = quatToMat3(eulerToQuat(e[0], e[1], e[2]));
  return [r[0] * s[0], r[1] * s[0], r[2] * s[0], 0, r[3] * s[1], r[4] * s[1], r[5] * s[1], 0, r[6] * s[2], r[7] * s[2], r[8] * s[2], 0, t[0], t[1], t[2], 1];
}

/** Translation, rotation (Euler) and scale (column lengths) of a transform matrix. */
export function decomposeTRS(m: ArrayLike<number>): { t: number[]; r: number[]; s: number[] } {
  const s = [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])];
  const r = [0, 0, 0];
  matrixToEuler(m, 0, r, 0);
  return { t: [m[12], m[13], m[14]], r, s };
}

gn('FunctionNodeCombineMatrix', 'converter', {
  exec: (ctx) => {
    const ids: string[] = [];
    for (let c = 1; c <= 4; c++) for (let r = 1; r <= 4; r++) ids.push(`Column ${c} Row ${r}`);
    return {
      Matrix: fnField(
        'MATRIX',
        ids.map((id) => ctx.field(id, 'FLOAT')),
        (ev, out, n) => {
          for (let i = 0; i < n; i++) for (let k = 0; k < 16; k++) out[i * 16 + k] = ev[k].data[ev[k].single ? 0 : i];
        },
      ),
    };
  },
});

gn('FunctionNodeSeparateMatrix', 'converter', {
  exec: (ctx) => {
    const m = ctx.field('Matrix', 'MATRIX');
    const out: Record<string, ReturnType<typeof lift>> = {};
    for (let c = 1; c <= 4; c++)
      for (let r = 1; r <= 4; r++) {
        const k = (c - 1) * 4 + (r - 1);
        out[`Column ${c} Row ${r}`] = fnField('FLOAT', [m], ([a]: Evaluated[], o, n) => {
          const s = a.single ? 0 : 16;
          for (let i = 0; i < n; i++) o[i] = a.data[i * s + k];
        });
      }
    return out;
  },
});

gn('FunctionNodeCombineTransform', 'converter', {
  exec: (ctx) => ({
    Transform: lift('MATRIX', [ctx.field('Translation', 'VECTOR'), ctx.field('Rotation', 'ROTATION'), ctx.field('Scale', 'VECTOR')], ([t, r, s]) => composeTRS(M(t), M(r), M(s))),
  }),
});

gn('FunctionNodeSeparateTransform', 'converter', {
  exec: (ctx) => {
    const m = ctx.field('Transform', 'MATRIX');
    return {
      Translation: lift('VECTOR', [m], ([a]) => [M(a)[12], M(a)[13], M(a)[14]]),
      Rotation: lift('ROTATION', [m], ([a]) => decomposeTRS(M(a)).r),
      Scale: lift('VECTOR', [m], ([a]) => decomposeTRS(M(a)).s),
    };
  },
});

gn('FunctionNodeMatrixDeterminant', 'converter', {
  exec: (ctx) => ({ Determinant: lift('FLOAT', [ctx.field('Matrix', 'MATRIX')], ([a]) => det4(M(a))) }),
});

gn('FunctionNodeInvertMatrix', 'converter', {
  exec: (ctx) => {
    const m = ctx.field('Matrix', 'MATRIX');
    return {
      Matrix: lift('MATRIX', [m], ([a]) => (det4(M(a)) === 0 ? IDENTITY : Array.from(invertMat(M(a))))),
      Invertible: lift('BOOLEAN', [m], ([a]) => (det4(M(a)) !== 0 ? 1 : 0)),
    };
  },
});

gn('FunctionNodeMatrixMultiply', 'converter', {
  exec: (ctx) => ({ Matrix: lift('MATRIX', [ctx.field('Matrix', 'MATRIX'), ctx.field('Matrix_001', 'MATRIX')], ([a, b]) => mul4(M(a), M(b))) }),
});

gn('FunctionNodeTransposeMatrix', 'converter', {
  exec: (ctx) => ({
    Matrix: lift('MATRIX', [ctx.field('Matrix', 'MATRIX')], ([a]) => {
      const m = M(a),
        r = new Array<number>(16);
      for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) r[row * 4 + c] = m[c * 4 + row];
      return r;
    }),
  }),
});

gn('FunctionNodeTransformPoint', 'converter', {
  exec: (ctx) => ({
    Vector: lift('VECTOR', [ctx.field('Vector', 'VECTOR'), ctx.field('Transform', 'MATRIX')], ([v, a]) => {
      const p = M(v),
        m = M(a);
      return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
    }),
  }),
});

gn('FunctionNodeTransformDirection', 'converter', {
  exec: (ctx) => ({
    Direction: lift('VECTOR', [ctx.field('Direction', 'VECTOR'), ctx.field('Transform', 'MATRIX')], ([v, a]) => {
      const p = M(v),
        m = M(a);
      return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]];
    }),
  }),
});

gn('FunctionNodeProjectPoint', 'converter', {
  exec: (ctx) => ({
    Vector: lift('VECTOR', [ctx.field('Vector', 'VECTOR'), ctx.field('Transform', 'MATRIX')], ([v, a]) => {
      const p = M(v),
        m = M(a);
      const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      const aw = Math.abs(w);
      return aw ? [x / aw, y / aw, z / aw] : [0, 0, 0];
    }),
  }),
});

// ---------------------------------------------------------------------------
// SVD of the 3×3 part (one-sided Jacobi): M = U · diag(S) · Vᵀ

export function svd3(m: ArrayLike<number>): { U: number[]; S: number[]; V: number[] } {
  // A as columns
  const A = [
    [m[0], m[1], m[2]],
    [m[4], m[5], m[6]],
    [m[8], m[9], m[10]],
  ];
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < 2; p++)
      for (let q = p + 1; q < 3; q++) {
        let alpha = 0,
          beta = 0,
          gamma = 0;
        for (let k = 0; k < 3; k++) {
          alpha += A[p][k] * A[p][k];
          beta += A[q][k] * A[q][k];
          gamma += A[p][k] * A[q][k];
        }
        off = Math.max(off, Math.abs(gamma) / Math.sqrt(alpha * beta || 1));
        if (Math.abs(gamma) < 1e-30) continue;
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t),
          s = c * t;
        for (let k = 0; k < 3; k++) {
          const ap = A[p][k],
            aq = A[q][k];
          A[p][k] = c * ap - s * aq;
          A[q][k] = s * ap + c * aq;
          const vp = V[p][k],
            vq = V[q][k];
          V[p][k] = c * vp - s * vq;
          V[q][k] = s * vp + c * vq;
        }
      }
    if (off < 1e-15) break;
  }
  const S = A.map((col) => Math.hypot(col[0], col[1], col[2]));
  // sort by descending singular value
  const order = [0, 1, 2].sort((a, b) => S[b] - S[a]);
  const U: number[] = new Array(16).fill(0),
    VV: number[] = new Array(16).fill(0);
  U[15] = VV[15] = 1;
  const Ss: number[] = [];
  order.forEach((j, c) => {
    Ss.push(S[j]);
    for (let k = 0; k < 3; k++) {
      U[c * 4 + k] = S[j] ? A[j][k] / S[j] : 0;
      VV[c * 4 + k] = V[j][k];
    }
  });
  // complete U for rank-deficient input
  for (let c = 0; c < 3; c++) {
    if (Ss[c]) continue;
    const a = [U[((c + 1) % 3) * 4], U[((c + 1) % 3) * 4 + 1], U[((c + 1) % 3) * 4 + 2]],
      b = [U[((c + 2) % 3) * 4], U[((c + 2) % 3) * 4 + 1], U[((c + 2) % 3) * 4 + 2]];
    let x = [b[1] * a[2] - b[2] * a[1], b[2] * a[0] - b[0] * a[2], b[0] * a[1] - b[1] * a[0]];
    if (!Math.hypot(x[0], x[1], x[2])) x = c === 0 ? [1, 0, 0] : c === 1 ? [0, 1, 0] : [0, 0, 1];
    const l = Math.hypot(x[0], x[1], x[2]);
    for (let k = 0; k < 3; k++) U[c * 4 + k] = x[k] / l;
  }
  return { U, S: Ss, V: VV };
}

gn('FunctionNodeMatrixSVD', 'converter', {
  exec: (ctx) => {
    const m = ctx.field('Matrix', 'MATRIX');
    return {
      U: lift('MATRIX', [m], ([a]) => svd3(M(a)).U),
      S: lift('VECTOR', [m], ([a]) => svd3(M(a)).S),
      V: lift('MATRIX', [m], ([a]) => svd3(M(a)).V),
    };
  },
});
