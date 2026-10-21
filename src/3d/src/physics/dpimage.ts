// Dynamic Paint image sequences: a surface in Image Sequence format simulates one point per texel of
// its UV map (instead of one per vertex). The texels come from rasterizing the UV triangles; each
// stores its triangle and barycentric weights so it follows the (deforming) mesh. The results are
// written to images (paint map, wet map, displacement, waves or weights) that follow the frame.

/** Texel samples of a mesh's UV map at a resolution. */
export interface TexelSamples {
  res: number;
  /** pixel index (y * res + x) of each sample */
  pix: Int32Array;
  /** triangle vertex indices (3 per sample) and barycentric weights (3 per sample) */
  tv: Int32Array;
  tb: Float32Array;
  /** neighbour lists (CSR) over the texel grid, and samples at an island border */
  start: Uint32Array;
  nb: Uint32Array;
  border: Uint8Array;
}

interface MeshLike {
  positions: Float32Array;
  offsets: Uint32Array;
  indices: Uint32Array;
  uvs: Float32Array;
}

const memo = new WeakMap<Float32Array, { res: number; idx: Uint32Array; s: TexelSamples }>();

/** Rasterize the UV triangles: one sample per covered texel centre (the first triangle wins). */
export function texelSamples(mesh: MeshLike, res: number): TexelSamples | null {
  if (!mesh.uvs.length || mesh.uvs.length < mesh.indices.length * 2) return null;
  const hit = memo.get(mesh.uvs);
  if (hit && hit.res === res && hit.idx === mesh.indices) return hit.s;
  const owner = new Int32Array(res * res).fill(-1);
  const tv: number[] = [],
    tb: number[] = [],
    pix: number[] = [];
  const U = mesh.uvs;
  for (let f = 0; f < mesh.offsets.length - 1; f++) {
    const s = mesh.offsets[f],
      e = mesh.offsets[f + 1];
    for (let k = s + 1; k + 1 < e; k++) {
      const c = [s, k, k + 1];
      const x = c.map((q) => U[q * 2] * res),
        y = c.map((q) => U[q * 2 + 1] * res);
      const den = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2]);
      if (Math.abs(den) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(...x))),
        x1 = Math.min(res - 1, Math.ceil(Math.max(...x))),
        y0 = Math.max(0, Math.floor(Math.min(...y))),
        y1 = Math.min(res - 1, Math.ceil(Math.max(...y)));
      for (let py = y0; py <= y1; py++)
        for (let px = x0; px <= x1; px++) {
          const p = py * res + px;
          if (owner[p] >= 0) continue;
          const cx = px + 0.5,
            cy = py + 0.5;
          const w0 = ((y[1] - y[2]) * (cx - x[2]) + (x[2] - x[1]) * (cy - y[2])) / den;
          const w1 = ((y[2] - y[0]) * (cx - x[2]) + (x[0] - x[2]) * (cy - y[2])) / den;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          owner[p] = pix.length;
          pix.push(p);
          tv.push(mesh.indices[c[0]], mesh.indices[c[1]], mesh.indices[c[2]]);
          tb.push(w0, w1, w2);
        }
    }
  }
  const n = pix.length;
  const start = new Uint32Array(n + 1);
  const lists: number[][] = [];
  const border = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = pix[i];
    const x = p % res,
      y = (p - x) / res;
    const l: number[] = [];
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      const qx = x + dx,
        qy = y + dy;
      const q = qx >= 0 && qy >= 0 && qx < res && qy < res ? owner[qy * res + qx] : -1;
      if (q >= 0) l.push(q);
    }
    if (l.length < 4) border[i] = 1;
    lists.push(l);
    start[i + 1] = start[i] + l.length;
  }
  const nb = new Uint32Array(start[n]);
  for (let i = 0; i < n; i++) nb.set(lists[i], start[i]);
  const out: TexelSamples = { res, pix: Int32Array.from(pix), tv: Int32Array.from(tv), tb: Float32Array.from(tb), start, nb, border };
  memo.set(mesh.uvs, { res, idx: mesh.indices, s: out });
  return out;
}

/** Per-sample values from per-vertex values (`stride` floats each), by barycentric interpolation. */
export function interpolate(t: TexelSamples, vertexValues: ArrayLike<number>, stride: number, normalize = false): Float32Array {
  const n = t.pix.length;
  const out = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) {
    const a = t.tv[i * 3] * stride,
      b = t.tv[i * 3 + 1] * stride,
      c = t.tv[i * 3 + 2] * stride;
    const wa = t.tb[i * 3],
      wb = t.tb[i * 3 + 1],
      wc = t.tb[i * 3 + 2];
    for (let k = 0; k < stride; k++) out[i * stride + k] = vertexValues[a + k] * wa + vertexValues[b + k] * wb + vertexValues[c + k] * wc;
    if (normalize && stride === 3) {
      const l = Math.hypot(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]) || 1;
      out[i * 3] /= l;
      out[i * 3 + 1] /= l;
      out[i * 3 + 2] /= l;
    }
  }
  return out;
}

export type DPImageKind = 'paintmap' | 'wetmap' | 'displace' | 'waves' | 'weight';

/**
 * RGBA8 pixels of one output from a surface state (`stride` floats per sample). Texels outside the
 * UV islands take the value of a painted neighbour (a few pixels of padding against seams).
 */
export function outputPixels(t: TexelSamples, st: Float32Array, kind: DPImageKind, opts: { depthClamp?: number } = {}): Uint8ClampedArray {
  const res = t.res;
  const px = new Uint8ClampedArray(res * res * 4);
  const filled = new Uint8Array(res * res);
  const to8 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  for (let i = 0; i < t.pix.length; i++) {
    const p = t.pix[i];
    let r = 0,
      g = 0,
      b = 0,
      a = 1;
    if (kind === 'paintmap') {
      r = st[i * 5];
      g = st[i * 5 + 1];
      b = st[i * 5 + 2];
      a = st[i * 5 + 3];
    } else if (kind === 'wetmap') r = g = b = st[i * 5 + 4];
    else if (kind === 'displace') r = g = b = opts.depthClamp && opts.depthClamp > 0 ? st[i] / opts.depthClamp : st[i];
    else if (kind === 'waves') r = g = b = 0.5 + st[i * 2] * 0.5;
    else r = g = b = st[i];
    px[p * 4] = to8(r);
    px[p * 4 + 1] = to8(g);
    px[p * 4 + 2] = to8(b);
    px[p * 4 + 3] = to8(a);
    filled[p] = 1;
  }
  // padding: grow the islands by a few pixels
  for (let pass = 0; pass < 2; pass++) {
    const add: [number, number][] = [];
    for (let p = 0; p < res * res; p++) {
      if (filled[p]) continue;
      const x = p % res,
        y = (p - x) / res;
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const qx = x + dx,
          qy = y + dy;
        if (qx < 0 || qy < 0 || qx >= res || qy >= res) continue;
        const q = qy * res + qx;
        if (filled[q] === 1) {
          add.push([p, q]);
          break;
        }
      }
    }
    for (const [p, q] of add) {
      px.copyWithin(p * 4, q * 4, q * 4 + 4);
      filled[p] = 2;
    }
    for (const [p] of add) filled[p] = 1;
  }
  return px;
}

/** Images a surface writes, by kind, with the image names it uses. */
export function surfaceOutputs(sf: { surface_type: string; use_output_a?: boolean; use_output_b?: boolean; output_name_a?: string; output_name_b?: string; name: string }): { kind: DPImageKind; name: string }[] {
  const out: { kind: DPImageKind; name: string }[] = [];
  const nm = (n: string | undefined, d: string) => (n && n.trim() ? n : d);
  if (sf.surface_type === 'PAINT') {
    if (sf.use_output_a !== false) out.push({ kind: 'paintmap', name: nm(sf.output_name_a, 'dp_paintmap') });
    if (sf.use_output_b !== false) out.push({ kind: 'wetmap', name: nm(sf.output_name_b, 'dp_wetmap') });
  } else if (sf.surface_type === 'DISPLACE') out.push({ kind: 'displace', name: nm(sf.output_name_a, 'dp_displacement') });
  else if (sf.surface_type === 'WAVE') out.push({ kind: 'waves', name: nm(sf.output_name_a, 'dp_waves') });
  else out.push({ kind: 'weight', name: nm(sf.output_name_a, 'dp_weight') });
  return out;
}
