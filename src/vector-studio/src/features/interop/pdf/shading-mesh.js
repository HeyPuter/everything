/**
 * Function-based (type 1) and mesh shadings (types 4-7) as gradient mesh
 * objects.
 *
 *   meshShadingNodes(xref, sh, m, alpha) -> [mesh node] | null
 *
 * Coons and tensor patches (types 6 and 7) become mesh patches with the
 * same edges; patches that tile a grid (shared edges and corner colors, in
 * row order, as mesh exporters write them) become one mesh object, other
 * patches one object each. Tensor patches keep their boundary (the four
 * inner control points are dropped). Lattice triangle meshes (type 5)
 * become a grid; free triangles (type 4) become one degenerate patch each.
 * Function-based shadings are sampled on a grid fine enough that bilinear
 * color matches the function. Shadings whose colors go through a Function
 * are subdivided where the function is not linear in the parameter, so the
 * bilinear mesh colors follow it.
 */
import { compileFunction } from './functions.js';
import { parseColorSpace, rgbHex } from './colors.js';
import { PDFStream, PDFDict } from './primitives.js';
import { createMesh, meshPoint, patchOf, evalPatch, patchDerivatives } from '../../mesh/mesh-model.js';
// Mesh objects need their live kind for bounds while the import builds clip groups.
import '../../mesh/mesh-live.js';

const MAX_PATCHES = 4000;
const TOL = 2 / 255;

const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

/** MSB-first bit reader over a byte array. */
class Bits {
  constructor(data) {
    this.data = data;
    this.bit = 0;
    this.total = data.length * 8;
  }

  left() {
    return this.total - this.bit;
  }

  read(n) {
    let v = 0;
    // Byte-aligned fast path for whole bytes.
    if ((this.bit & 7) === 0 && (n & 7) === 0) {
      for (let i = 0; i < n; i += 8) {
        v = v * 256 + (this.data[this.bit >> 3] ?? 0);
        this.bit += 8;
      }
      return v;
    }
    for (let i = 0; i < n; i++, this.bit++) v = v * 2 + (((this.data[this.bit >> 3] ?? 0) >> (7 - (this.bit & 7))) & 1);
    return v;
  }

  align() {
    this.bit = Math.ceil(this.bit / 8) * 8;
  }
}

/**
 * The shading's stream layout and color evaluation: { color(values) -> [r,g,b] 0..1,
 * readPoint(bits), readColor(bits) -> values, ncomp, fn }.
 */
function readerFor(xref, sh, m) {
  const d = sh.dict;
  const space = parseColorSpace(xref, d.get('ColorSpace'), null);
  const fn = compileFunction(xref, d.get('Function'));
  const bpc = d.num('BitsPerCoordinate', 16);
  const bpcomp = d.num('BitsPerComponent', 8);
  const bpf = d.num('BitsPerFlag', 8);
  const decode = d.array('Decode') || [];
  const ncomp = fn ? 1 : space.n || 1;
  const cmax = 2 ** bpc - 1;
  const vmax = 2 ** bpcomp - 1;
  const [x0 = 0, x1 = 1, y0 = 0, y1 = 1] = decode;
  return {
    fn,
    ncomp,
    bpf,
    pointBits: 2 * bpc,
    colorBits: ncomp * bpcomp,
    readPoint(b) {
      const x = x0 + (b.read(bpc) / cmax) * (x1 - x0);
      const y = y0 + (b.read(bpc) / cmax) * (y1 - y0);
      return apply(m, x, y);
    },
    readColor(b) {
      const out = [];
      for (let k = 0; k < ncomp; k++) {
        const lo = decode[4 + 2 * k] ?? 0;
        const hi = decode[5 + 2 * k] ?? 1;
        out.push(lo + (b.read(bpcomp) / vmax) * (hi - lo));
      }
      return out;
    },
    color(values) {
      const rgb = space.toRGB(fn ? fn(values) : values);
      return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
    },
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);
const hexOf = (rgb) => rgbHex(rgb);

// ---------------------------------------------------------------- patches

/**
 * A patch: 12 boundary points p[0..11] counterclockwise from corner A
 * (p0 = A, p3 = B, p6 = C, p9 = D) and the values at the four corners.
 */
function readPatches(sh, rd, tensor) {
  const b = new Bits(sh.decoded());
  const out = [];
  let prev = null;
  const extra = tensor ? 4 : 0;
  while (out.length <= MAX_PATCHES) {
    if (b.left() < rd.bpf) break;
    const flag = b.read(rd.bpf);
    const newPts = flag === 0 ? 12 : 8;
    const newCols = flag === 0 ? 4 : 2;
    if (b.left() < (newPts + extra) * rd.pointBits + newCols * rd.colorBits) break;
    const p = new Array(12);
    const v = new Array(4);
    let first = 0;
    if (flag !== 0) {
      if (!prev) break;
      // The new patch's first edge is an edge of the previous one.
      const at = { 1: [3, 4, 5, 6], 2: [6, 7, 8, 9], 3: [9, 10, 11, 0] }[flag];
      const cs = { 1: [1, 2], 2: [2, 3], 3: [3, 0] }[flag];
      if (!at) break;
      for (let k = 0; k < 4; k++) p[k] = prev.p[at[k]];
      v[0] = prev.v[cs[0]];
      v[1] = prev.v[cs[1]];
      first = 4;
    }
    for (let k = first; k < 12; k++) p[k] = rd.readPoint(b);
    for (let k = 0; k < extra; k++) rd.readPoint(b);
    for (let k = flag === 0 ? 0 : 2; k < 4; k++) v[k] = rd.readColor(b);
    b.align();
    prev = { p, v };
    out.push(prev);
  }
  return out;
}

/** Mesh points of a 1x1 grid for one patch: [A, B, D, C] in row-major order. */
function patchPoints({ p }) {
  const pt = (q) => meshPoint(q.x, q.y);
  const A = pt(p[0]);
  const B = pt(p[3]);
  const C = pt(p[6]);
  const D = pt(p[9]);
  Object.assign(A, { rx: p[1].x, ry: p[1].y, dx: p[11].x, dy: p[11].y });
  Object.assign(B, { lx: p[2].x, ly: p[2].y, dx: p[4].x, dy: p[4].y });
  Object.assign(C, { ux: p[5].x, uy: p[5].y, lx: p[7].x, ly: p[7].y });
  Object.assign(D, { rx: p[8].x, ry: p[8].y, ux: p[10].x, uy: p[10].y });
  return [A, B, D, C];
}

/**
 * Patches as a value grid: { rows, cols, points (geometry), values } when
 * they tile a rows x cols grid in row order with shared edges, else null.
 */
function assembleGrid(patches, tol) {
  const n = patches.length;
  const same = (a, b) => Math.abs(a - b) <= tol;
  const sameVal = (a, b) => a.length === b.length && a.every((x, k) => Math.abs(x - b[k]) < 1e-6);
  for (let cols = n; cols >= 1; cols--) {
    if (n % cols) continue;
    const rows = n / cols;
    const W = cols + 1;
    const pts = new Array((rows + 1) * W).fill(null);
    const vals = new Array((rows + 1) * W).fill(null);
    let ok = true;
    for (let i = 0; i < rows && ok; i++) {
      for (let j = 0; j < cols && ok; j++) {
        const patch = patches[i * cols + j];
        const [A, B, D, C] = patchPoints(patch);
        const cells = [[i, j, A, patch.v[0], ['rx', 'ry', 'dx', 'dy']], [i, j + 1, B, patch.v[1], ['lx', 'ly', 'dx', 'dy']], [i + 1, j + 1, C, patch.v[2], ['lx', 'ly', 'ux', 'uy']], [i + 1, j, D, patch.v[3], ['rx', 'ry', 'ux', 'uy']]];
        for (const [r, c, q, val, keys] of cells) {
          const k = r * W + c;
          const have = pts[k];
          if (!have) {
            pts[k] = { ...q };
            vals[k] = val;
            continue;
          }
          if (!same(have.x, q.x) || !same(have.y, q.y) || !sameVal(vals[k], val)) {
            ok = false;
            break;
          }
          // Handles this patch defines must agree with those already set by a neighbor.
          for (let h = 0; h < keys.length; h += 2) {
            const kx = keys[h];
            const ky = keys[h + 1];
            const unset = have[kx] === have.x && have[ky] === have.y;
            if (unset) {
              have[kx] = q[kx];
              have[ky] = q[ky];
            } else if (!same(have[kx], q[kx]) || !same(have[ky], q[ky])) ok = false;
          }
        }
      }
    }
    if (ok) return { rows, cols, points: pts, values: vals };
  }
  return null;
}

// ---------------------------------------------------------------- triangles

function readTriangles(sh, rd, type) {
  const b = new Bits(sh.decoded());
  const verts = [];
  const tris = [];
  if (type === 4) {
    let va = null;
    let vb = null;
    let vc = null;
    while (tris.length <= MAX_PATCHES) {
      if (b.left() < rd.bpf + rd.pointBits + rd.colorBits) break;
      const flag = b.read(rd.bpf);
      const p = rd.readPoint(b);
      const v = rd.readColor(b);
      b.align();
      const vert = { p, v };
      if (flag === 0) {
        // Two more vertices complete the triangle (their flags are ignored).
        const more = [];
        for (let k = 0; k < 2; k++) {
          if (b.left() < rd.bpf + rd.pointBits + rd.colorBits) break;
          b.read(rd.bpf);
          const q = rd.readPoint(b);
          const w = rd.readColor(b);
          b.align();
          more.push({ p: q, v: w });
        }
        if (more.length < 2) break;
        [va, vb, vc] = [vert, more[0], more[1]];
      } else if (flag === 1 && vb) [va, vb, vc] = [vb, vc, vert];
      else if (flag === 2 && va) [va, vb, vc] = [va, vc, vert];
      else break;
      tris.push([va, vb, vc]);
    }
    return { tris };
  }
  const perRow = Math.max(2, sh.dict.num('VerticesPerRow', 2));
  while (b.left() >= rd.pointBits + rd.colorBits && verts.length <= MAX_PATCHES * 2) verts.push({ p: rd.readPoint(b), v: rd.readColor(b) });
  const rows = Math.floor(verts.length / perRow);
  return { lattice: { rows, cols: perRow, verts: verts.slice(0, rows * perRow) } };
}

// ---------------------------------------------------------------- color grids

/**
 * A mesh node from geometry points (row-major, (rows+1) x (cols+1)) and
 * the shading values at them, subdividing each patch k x k when colors go
 * through a non-linear function.
 */
function meshFrom(rows, cols, points, values, rd, alpha) {
  const k = rd.fn ? subdivisions(rows, cols, values, rd) : 1;
  let grid = { rows, cols, points: points.map((p, i) => ({ ...p, c: hexOf(rd.color(values[i])), a: 1 })) };
  if (k > 1) grid = subdivide(grid, values, k, rd);
  return createMesh(grid.rows, grid.cols, grid.points, alpha < 1 ? { opacity: Math.max(0, alpha) } : {});
}

/** Subdivisions per patch (1, 2, 4 or 8) so a bilinear blend of corner colors follows the function. */
function subdivisions(rows, cols, values, rd) {
  const W = cols + 1;
  let worst = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const v = [values[i * W + j], values[i * W + j + 1], values[(i + 1) * W + j + 1], values[(i + 1) * W + j]];
      for (let k = 1; k <= 8; k *= 2) {
        if (k >= 8) {
          worst = 8;
          break;
        }
        // Compare at the centers of the k x k sub-patches.
        let err = 0;
        for (let a = 0; a < k && err <= TOL; a++) {
          for (let b = 0; b < k && err <= TOL; b++) {
            const s0 = a / k;
            const s1 = (a + 1) / k;
            const t0 = b / k;
            const t1 = (b + 1) / k;
            const corners = [[s0, t0], [s1, t0], [s1, t1], [s0, t1]].map(([s, t]) => rd.color(blend(v, s, t)));
            const mid = rd.color(blend(v, (s0 + s1) / 2, (t0 + t1) / 2));
            for (let c = 0; c < 3; c++) err = Math.max(err, Math.abs((corners[0][c] + corners[1][c] + corners[2][c] + corners[3][c]) / 4 - mid[c]));
          }
        }
        if (err <= TOL) {
          worst = Math.max(worst, k);
          break;
        }
      }
      if (worst >= 8) return 8;
    }
  }
  return Math.max(1, worst);
}

/** Bilinear blend of corner values [A, B, C, D] at (s, t). */
function blend(v, s, t) {
  const out = [];
  for (let c = 0; c < v[0].length; c++) out.push((1 - s) * (1 - t) * v[0][c] + s * (1 - t) * v[1][c] + s * t * v[2][c] + (1 - s) * t * v[3][c]);
  return out;
}

/** Split every patch into k x k patches on the same surface, with colors from the shading values. */
function subdivide(grid, values, k, rd) {
  const { rows, cols } = grid;
  const R = rows * k;
  const C = cols * k;
  const W = C + 1;
  const pts = new Array((R + 1) * W);
  const m = { rows, cols, points: grid.points };
  const d = 1 / k;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const patch = patchOf(m, i, j);
      const v = [values[i * (cols + 1) + j], values[i * (cols + 1) + j + 1], values[(i + 1) * (cols + 1) + j + 1], values[(i + 1) * (cols + 1) + j]];
      for (let a = 0; a <= k; a++) {
        for (let b = 0; b <= k; b++) {
          const gi = i * k + a;
          const gj = j * k + b;
          const idx = gi * W + gj;
          const s = b * d;
          const t = a * d;
          const P = evalPatch(patch, s, t);
          const { su, tv } = patchDerivatives(patch, s, t);
          const hs = d / 3;
          const q = pts[idx] || meshPoint(P.x, P.y, hexOf(rd.color(blend(v, s, t))));
          // Handles toward the inside of this patch; neighbors fill the others.
          if (b > 0) Object.assign(q, { lx: P.x - su.x * hs, ly: P.y - su.y * hs });
          if (b < k) Object.assign(q, { rx: P.x + su.x * hs, ry: P.y + su.y * hs });
          if (a > 0) Object.assign(q, { ux: P.x - tv.x * hs, uy: P.y - tv.y * hs });
          if (a < k) Object.assign(q, { dx: P.x + tv.x * hs, dy: P.y + tv.y * hs });
          pts[idx] = q;
        }
      }
    }
  }
  return { rows: R, cols: C, points: pts };
}

// ---------------------------------------------------------------- entry points

/** Function-based shading (type 1): a grid over its domain, refined until bilinear colors match. */
function functionMesh(xref, dict, m, alpha) {
  const fn = compileFunction(xref, dict.get('Function'));
  if (!fn) return null;
  const space = parseColorSpace(xref, dict.get('ColorSpace'), null);
  const [x0, x1, y0, y1] = dict.array('Domain') || [0, 1, 0, 1];
  const mat = dict.array('Matrix') || [1, 0, 0, 1, 0, 0];
  const total = [m[0] * mat[0] + m[2] * mat[1], m[1] * mat[0] + m[3] * mat[1], m[0] * mat[2] + m[2] * mat[3], m[1] * mat[2] + m[3] * mat[3], m[0] * mat[4] + m[2] * mat[5] + m[4], m[1] * mat[4] + m[3] * mat[5] + m[5]];
  const colorAt = (x, y) => {
    const rgb = space.toRGB(fn([x, y]));
    return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
  };
  let n = 1;
  for (; n < 32; n *= 2) {
    let err = 0;
    for (let i = 0; i < n && err <= TOL; i++) {
      for (let j = 0; j < n && err <= TOL; j++) {
        const xa = x0 + ((x1 - x0) * j) / n;
        const xb = x0 + ((x1 - x0) * (j + 1)) / n;
        const ya = y0 + ((y1 - y0) * i) / n;
        const yb = y0 + ((y1 - y0) * (i + 1)) / n;
        const c = [colorAt(xa, ya), colorAt(xb, ya), colorAt(xb, yb), colorAt(xa, yb)];
        const mid = colorAt((xa + xb) / 2, (ya + yb) / 2);
        for (let k = 0; k < 3; k++) err = Math.max(err, Math.abs((c[0][k] + c[1][k] + c[2][k] + c[3][k]) / 4 - mid[k]));
      }
    }
    if (err <= TOL) break;
  }
  const points = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const x = x0 + ((x1 - x0) * j) / n;
      const y = y0 + ((y1 - y0) * i) / n;
      const p = apply(total, x, y);
      points.push(meshPoint(p.x, p.y, hexOf(colorAt(x, y))));
    }
  }
  return [createMesh(n, n, points, alpha < 1 ? { opacity: Math.max(0, alpha) } : {})];
}

/**
 * Mesh nodes for a function-based or mesh shading under matrix m (shading
 * space -> document), or null for other shading types or unreadable data.
 */
export function meshShadingNodes(xref, sh, m, alpha = 1) {
  const dict = sh instanceof PDFStream ? sh.dict : sh;
  if (!(dict instanceof PDFDict)) return null;
  const type = dict.num('ShadingType', 0);
  if (type === 1) return functionMesh(xref, dict, m, alpha);
  if (type < 4 || type > 7 || !(sh instanceof PDFStream)) return null;
  const rd = readerFor(xref, sh, m);
  if (type === 6 || type === 7) {
    const patches = readPatches(sh, rd, type === 7);
    if (!patches.length || patches.length > MAX_PATCHES) return null;
    let size = 0;
    for (const pa of patches) for (const q of pa.p) size = Math.max(size, Math.abs(q.x), Math.abs(q.y));
    const grid = assembleGrid(patches, Math.max(1e-6, size * 1e-6));
    if (grid) return [meshFrom(grid.rows, grid.cols, grid.points, grid.values, rd, alpha)];
    return patches.map((pa) => meshFrom(1, 1, patchPoints(pa), [pa.v[0], pa.v[1], pa.v[3], pa.v[2]], rd, alpha));
  }
  const res = readTriangles(sh, rd, type);
  if (res.lattice) {
    const { rows, cols, verts } = res.lattice;
    if (rows < 2) return null;
    return [meshFrom(rows - 1, cols - 1, verts.map((v) => meshPoint(v.p.x, v.p.y)), verts.map((v) => v.v), rd, alpha)];
  }
  if (!res.tris.length || res.tris.length > MAX_PATCHES) return null;
  // One patch per triangle, its last corner doubled.
  return res.tris.map(([a, b, c]) => meshFrom(1, 1, [meshPoint(a.p.x, a.p.y), meshPoint(b.p.x, b.p.y), meshPoint(c.p.x, c.p.y), meshPoint(c.p.x, c.p.y)], [a.v, b.v, c.v, c.v], rd, alpha));
}
