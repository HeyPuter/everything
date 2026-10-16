// Pure CPU stages of a bake: turning traced/rasterized texel values into the stored pass
// (normal space conversion and swizzle, lighting × color), filling the margin around UV islands
// (Extend and Adjacent Faces) and compositing several bakes into one image. Exported for tests.
import type { NormalSwizzle } from './settings';

/** A baked image region: RGBA floats (rows bottom-up, like texture space) and a texel state. */
export interface BakeBuffer {
  width: number;
  height: number;
  data: Float32Array;
  /** 0 empty, 1 margin, 2 baked */
  mask: Uint8Array;
}

export const EMPTY = 0;
export const MARGIN = 1;
export const BAKED = 2;

export function newBuffer(width: number, height: number): BakeBuffer {
  return { width, height, data: new Float32Array(width * height * 4), mask: new Uint8Array(width * height) };
}

// ---------------------------------------------------------------------------
// normals

const AXIS: Record<NormalSwizzle, [number, number]> = {
  POS_X: [0, 1],
  POS_Y: [1, 1],
  POS_Z: [2, 1],
  NEG_X: [0, -1],
  NEG_Y: [1, -1],
  NEG_Z: [2, -1],
};

/** Reorder / flip the components of a normal for storage (R, G, B taken from the chosen axes). */
export function swizzle(v: ArrayLike<number>, r: NormalSwizzle, g: NormalSwizzle, b: NormalSwizzle): [number, number, number] {
  return [r, g, b].map((s) => v[AXIS[s][0]] * AXIS[s][1]) as [number, number, number];
}

/** Solve [T B N]·c = n (tangent frame given as columns, not necessarily orthogonal). */
export function toTangentSpace(n: ArrayLike<number>, T: ArrayLike<number>, B: ArrayLike<number>, N: ArrayLike<number>): [number, number, number] {
  // inverse of the 3×3 matrix with columns T, B, N via cross products (rows of the inverse)
  const r0 = cross(B, N),
    r1 = cross(N, T),
    r2 = cross(T, B);
  const det = T[0] * r0[0] + T[1] * r0[1] + T[2] * r0[2];
  if (Math.abs(det) < 1e-12) return [0, 0, 1];
  const c: [number, number, number] = [dot(r0, n) / det, dot(r1, n) / det, dot(r2, n) / det];
  return normalize(c);
}

/** World normal → object space for an object whose world matrix has the 3×3 part `m` (column-major 3×3). */
export function toObjectSpace(n: ArrayLike<number>, m: ArrayLike<number>): [number, number, number] {
  // the object-space decode is n_world ∝ inverse(transpose(M)) · c, so c ∝ transpose(M) · n
  return normalize([m[0] * n[0] + m[1] * n[1] + m[2] * n[2], m[3] * n[0] + m[4] * n[1] + m[5] * n[2], m[6] * n[0] + m[7] * n[1] + m[8] * n[2]]);
}

/** Encode a unit vector as a color (−1..1 → 0..1). */
export function encodeUnit(v: ArrayLike<number>): [number, number, number] {
  return [v[0] * 0.5 + 0.5, v[1] * 0.5 + 0.5, v[2] * 0.5 + 0.5];
}

function cross(a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: ArrayLike<number>, b: ArrayLike<number>) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
}

// ---------------------------------------------------------------------------
// margin

/**
 * Extend: grow the baked texels outwards one ring per step, each new texel taking the average of
 * its already-filled neighbours, up to `size` texels away from the baked ones. Texels already
 * filled (e.g. by Adjacent Faces) are kept and feed the rings around them.
 */
export function extendMargin(buf: BakeBuffer, size: number) {
  const { width: W, height: H, data, mask } = buf;
  if (size <= 0) return;
  // distance (in rings) of every texel from the baked ones
  const dist = new Int32Array(W * H).fill(-1);
  let ring: number[] = [];
  for (let i = 0; i < W * H; i++) if (mask[i] === BAKED) (dist[i] = 0), ring.push(i);
  const rings: number[][] = [];
  for (let k = 1; k <= size && ring.length; k++) {
    const next: number[] = [];
    for (const i of ring) {
      const x = i % W,
        y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx;
          if (dist[j] >= 0) continue;
          dist[j] = k;
          next.push(j);
        }
    }
    rings.push(next);
    ring = next;
  }
  for (const list of rings) {
    const fill: [number, number, number, number, number][] = [];
    for (const i of list) {
      if (mask[i] !== EMPTY) continue;
      const x = i % W,
        y = (i / W) | 0;
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx,
            yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx;
          if (mask[j] === EMPTY) continue;
          // orthogonal neighbours weigh more than diagonal ones
          const w = dx && dy ? 0.5 : 1;
          r += data[j * 4] * w;
          g += data[j * 4 + 1] * w;
          b += data[j * 4 + 2] * w;
          a += data[j * 4 + 3] * w;
          n += w;
        }
      if (n) fill.push([i, r / n, g / n, b / n, a / n]);
    }
    for (const [i, r, g, b, a] of fill) {
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = a;
      mask[i] = MARGIN;
    }
  }
}

/**
 * A UV island border edge (texel coordinates). `across` is the same mesh edge as seen from the face
 * on the other side of the seam (its UVs for the same two vertices, and a point inside that face),
 * or null on an open mesh border.
 */
export interface SeamEdge {
  a: [number, number];
  b: [number, number];
  /** a point inside the face owning the edge (tells which side is inside) */
  inside: [number, number];
  across: { a: [number, number]; b: [number, number]; inside: [number, number] } | null;
}

/**
 * Adjacent Faces: texels outside an island take the color found by continuing across the seam into
 * the face that is next to it on the mesh (so filtering across seams blends matching colors).
 * Texels with no neighbouring face are filled by extending.
 */
export function adjacentFacesMargin(buf: BakeBuffer, size: number, edges: SeamEdge[]) {
  const { width: W, height: H, data, mask } = buf;
  if (size <= 0) return;
  // bucket edges by grid cells covering their margin band
  const cell = Math.max(8, size);
  const gw = Math.ceil(W / cell),
    gh = Math.ceil(H / cell);
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  edges.forEach((e, k) => {
    const x0 = Math.max(0, Math.floor((Math.min(e.a[0], e.b[0]) - size) / cell)),
      x1 = Math.min(gw - 1, Math.floor((Math.max(e.a[0], e.b[0]) + size) / cell));
    const y0 = Math.max(0, Math.floor((Math.min(e.a[1], e.b[1]) - size) / cell)),
      y1 = Math.min(gh - 1, Math.floor((Math.max(e.a[1], e.b[1]) + size) / cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * gw + x].push(k);
  });
  const src = new Float32Array(data);
  const srcMask = new Uint8Array(mask);
  const out: [number, number[]][] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i] !== EMPTY) continue;
      const list = grid[Math.floor(y / cell) * gw + Math.floor(x / cell)];
      if (!list.length) continue;
      const px = x + 0.5,
        py = y + 0.5;
      let best = -1,
        bestD = size + 0.5,
        bestT = 0;
      for (const k of list) {
        const e = edges[k];
        const ex = e.b[0] - e.a[0],
          ey = e.b[1] - e.a[1];
        const len2 = ex * ex + ey * ey;
        if (len2 < 1e-12) continue;
        const t = Math.max(0, Math.min(1, ((px - e.a[0]) * ex + (py - e.a[1]) * ey) / len2));
        const d = Math.hypot(px - (e.a[0] + ex * t), py - (e.a[1] + ey * t));
        // only texels on the outer side of the edge
        const side = (ex * (py - e.a[1]) - ey * (px - e.a[0])) * (ex * (e.inside[1] - e.a[1]) - ey * (e.inside[0] - e.a[0]));
        if (side > 0) continue;
        if (d < bestD) {
          bestD = d;
          best = k;
          bestT = t;
        }
      }
      if (best < 0) continue;
      const e = edges[best];
      if (!e.across) continue;
      const c = e.across;
      const ax = c.b[0] - c.a[0],
        ay = c.b[1] - c.a[1];
      const la = Math.hypot(ax, ay),
        le = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      if (la < 1e-9) continue;
      // unit normal of the far edge pointing into its face
      let nx = -ay / la,
        ny = ax / la;
      if (nx * (c.inside[0] - c.a[0]) + ny * (c.inside[1] - c.a[1]) < 0) (nx = -nx), (ny = -ny);
      const d = bestD * (la / Math.max(1e-9, le));
      const qx = c.a[0] + ax * bestT + nx * d,
        qy = c.a[1] + ay * bestT + ny * d;
      const v = sampleBaked(src, srcMask, W, H, qx, qy);
      if (v) out.push([i, v]);
    }
  for (const [i, v] of out) {
    data.set(v, i * 4);
    mask[i] = MARGIN;
  }
  // texels on open borders (or where the far side had no data) extend as usual
  extendMargin(buf, size);
}

/** Bilinear sample of baked texels at a texel-space point (pixel centers at +0.5). */
function sampleBaked(data: Float32Array, mask: Uint8Array, W: number, H: number, x: number, y: number): number[] | null {
  const fx = x - 0.5,
    fy = y - 0.5;
  const x0 = Math.floor(fx),
    y0 = Math.floor(fy);
  const tx = fx - x0,
    ty = fy - y0;
  const acc = [0, 0, 0, 0];
  let wsum = 0;
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const xx = Math.min(W - 1, Math.max(0, x0 + i)),
        yy = Math.min(H - 1, Math.max(0, y0 + j));
      const k = yy * W + xx;
      if (mask[k] !== BAKED) continue;
      const w = (i ? tx : 1 - tx) * (j ? ty : 1 - ty) + 1e-6;
      for (let c = 0; c < 4; c++) acc[c] += data[k * 4 + c] * w;
      wsum += w;
    }
  if (!wsum) {
    // nearest baked texel in a small neighbourhood
    const cx = Math.floor(x),
      cy = Math.floor(y);
    for (let r = 1; r <= 2; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const xx = cx + dx,
            yy = cy + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const k = yy * W + xx;
          if (mask[k] === BAKED) return Array.from(data.subarray(k * 4, k * 4 + 4));
        }
    return null;
  }
  return acc.map((v) => v / wsum);
}

// ---------------------------------------------------------------------------
// seams of a mesh in texel space

export interface SeamMesh {
  offsets: ArrayLike<number>;
  indices: ArrayLike<number>;
  uvs: ArrayLike<number>;
}

/** UV border edges of the faces accepted by `useFace`, with the matching edge across each seam. */
export function seamEdges(m: SeamMesh, W: number, H: number, useFace: (f: number) => boolean): SeamEdge[] {
  const nf = m.offsets.length - 1;
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const byEdge = new Map<string, { f: number; c0: number; c1: number }[]>();
  const centroid = (f: number): [number, number] => {
    let x = 0,
      y = 0;
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    for (let c = s; c < e; c++) {
      x += m.uvs[c * 2];
      y += m.uvs[c * 2 + 1];
    }
    return [(x / (e - s)) * W, (y / (e - s)) * H];
  };
  for (let f = 0; f < nf; f++) {
    if (!useFace(f)) continue;
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    for (let c = s; c < e; c++) {
      const c1 = c + 1 < e ? c + 1 : s;
      const k = key(m.indices[c], m.indices[c1]);
      let l = byEdge.get(k);
      if (!l) byEdge.set(k, (l = []));
      l.push({ f, c0: c, c1 });
    }
  }
  const uv = (c: number): [number, number] => [m.uvs[c * 2] * W, m.uvs[c * 2 + 1] * H];
  const same = (p: [number, number], q: [number, number]) => Math.abs(p[0] - q[0]) < 1e-3 && Math.abs(p[1] - q[1]) < 1e-3;
  const out: SeamEdge[] = [];
  for (const list of byEdge.values()) {
    for (const it of list) {
      const a = uv(it.c0),
        b = uv(it.c1);
      const other = list.find((o) => o !== it);
      let across: SeamEdge['across'] = null;
      if (other) {
        // the other face's UVs for the same two vertices (it walks the edge the other way)
        const va = m.indices[it.c0];
        const oa = m.indices[other.c0] === va ? other.c0 : other.c1;
        const ob = oa === other.c0 ? other.c1 : other.c0;
        const pa = uv(oa),
          pb = uv(ob);
        if (same(pa, a) && same(pb, b)) continue; // not a seam: the island continues here
        across = { a: pa, b: pb, inside: centroid(other.f) };
      }
      out.push({ a, b, inside: centroid(it.f), across });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// compositing and storage

/** Copy texels of `src` into `dst` where they rank higher (baked over margin over empty). */
export function composite(dst: BakeBuffer, src: BakeBuffer) {
  for (let i = 0; i < dst.mask.length; i++) {
    if (src.mask[i] > dst.mask[i]) {
      dst.mask[i] = src.mask[i];
      dst.data.set(src.data.subarray(i * 4, i * 4 + 4), i * 4);
    }
  }
}

const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/**
 * Store the bake into 8-bit RGBA pixels (rows top-down, as in canvases). Texels left empty keep
 * the previous pixels, or get `clear` when clearing.
 */
export function storeBytes(buf: BakeBuffer, prev: Uint8ClampedArray | null, opts: { srgb: boolean; clear: [number, number, number, number] | null }): Uint8ClampedArray {
  const { width: W, height: H, data, mask } = buf;
  const out = new Uint8ClampedArray(W * H * 4);
  const enc = (v: number, color: boolean) => Math.round(Math.max(0, Math.min(1, color && opts.srgb ? linearToSrgb(Math.max(0, v)) : v)) * 255);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = ((H - 1 - y) * W + x) * 4;
      if (mask[i] !== EMPTY) {
        for (let c = 0; c < 3; c++) out[o + c] = enc(data[i * 4 + c], true);
        out[o + 3] = enc(data[i * 4 + 3], false);
      } else if (opts.clear) {
        for (let c = 0; c < 3; c++) out[o + c] = enc(opts.clear[c], true);
        out[o + 3] = enc(opts.clear[3], false);
      } else if (prev) out.set(prev.subarray(o, o + 4), o);
    }
  return out;
}
