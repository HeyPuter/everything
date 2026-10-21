// Child hair: extra strands generated from the parent strands of a hair system.
//  - Simple children sit around their parent (radius, roundness) and copy its shape.
//  - Interpolated children grow from their own points on the emitter surface and blend the shapes
//    of the nearest parents (parting keeps them to one side where parents diverge).
// Both are then clumped towards their parent (or a virtual parent), kinked (curl, radial, wave,
// braid, spiral), roughened and shortened. The description of every child is made once from the
// emitter; the paths are rebuilt from the (possibly simulated) parent strands.
import { rand01 } from './common';
import type { MeshSampler } from './sampling';
import { newSample } from './sampling';

export interface ChildSettings {
  type: 'SIMPLE' | 'INTERPOLATED';
  /** children per parent */
  count: number;
  radius: number;
  roundness: number;
  length: number;
  lengthThreshold: number;
  seed: number;
  virtualParents: number;
  clump: number;
  clumpShape: number;
  clumpNoise: boolean;
  clumpNoiseSize: number;
  kink: 'NO' | 'CURL' | 'RADIAL' | 'WAVE' | 'BRAID' | 'SPIRAL';
  kinkAmplitude: number;
  kinkAmplitudeClump: number;
  kinkAmplitudeRandom: number;
  kinkFrequency: number;
  kinkShape: number;
  kinkFlat: number;
  kinkAxis: 'X' | 'Y' | 'Z';
  kinkAxisRandom: number;
  partingFactor: number;
  /** degrees */
  partingMin: number;
  partingMax: number;
  rough1: number;
  rough1Size: number;
  roughEnd: number;
  roughEndShape: number;
  rough2: number;
  rough2Size: number;
  rough2Threshold: number;
}

/** What each child is made from (independent of the parents' current shapes). */
export interface ChildDesc {
  n: number;
  /** up to four parents and their weights per child (index -1 = unused) */
  par: Int32Array;
  wt: Float32Array;
  /** simple: offset from the parent root; interpolated: the child's own root */
  off: Float32Array;
  /** per child random seed, length factor, random roughness on/off, clump target (-1: parents) */
  seed: Uint32Array;
  len: Float32Array;
  r2: Uint8Array;
  vpar: Int32Array;
}

export function childSettings(s: Record<string, unknown>, count: number): ChildSettings {
  const n = (k: string, d: number) => (typeof s[k] === 'number' ? (s[k] as number) : d);
  return {
    type: s.child_type === 'INTERPOLATED' ? 'INTERPOLATED' : 'SIMPLE',
    count,
    radius: n('child_radius', 0.2),
    roundness: n('child_roundness', 0),
    length: n('child_length', 1),
    lengthThreshold: n('child_length_threshold', 0),
    seed: n('child_seed', 0),
    virtualParents: n('virtual_parents', 0),
    clump: n('clump_factor', 0),
    clumpShape: n('clump_shape', 0),
    clumpNoise: !!s.use_clump_noise,
    clumpNoiseSize: n('clump_noise_size', 1),
    kink: (s.kink as ChildSettings['kink']) ?? 'NO',
    kinkAmplitude: n('kink_amplitude', 0.2),
    kinkAmplitudeClump: n('kink_amplitude_clump', 1),
    kinkAmplitudeRandom: n('kink_amplitude_random', 0),
    kinkFrequency: n('kink_frequency', 2),
    kinkShape: n('kink_shape', 0),
    kinkFlat: n('kink_flat', 0),
    kinkAxis: (s.kink_axis as ChildSettings['kinkAxis']) ?? 'Z',
    kinkAxisRandom: n('kink_axis_random', 0),
    partingFactor: n('child_parting_factor', 0),
    partingMin: n('child_parting_min', 0),
    partingMax: n('child_parting_max', 0),
    rough1: n('roughness_1', 0),
    rough1Size: n('roughness_1_size', 1),
    roughEnd: n('roughness_endpoint', 0),
    roughEndShape: n('roughness_end_shape', 1),
    rough2: n('roughness_2', 0),
    rough2Size: n('roughness_2_size', 1),
    rough2Threshold: n('roughness_2_threshold', 0),
  };
}

/** Shape curve used by clump and kink: 0 linear, positive rises early, negative late. */
export function shapeCurve(u: number, shape: number): number {
  const sh = Math.max(-0.999, Math.min(0.999, shape));
  const e = sh >= 0 ? 1 - sh : 1 / (1 + sh);
  return Math.pow(Math.max(0, Math.min(1, u)), e);
}

/** Describe the children of `parents` strands (`per` points each, object space). */
export function describeChildren(parentPts: Float32Array, per: number, parents: number, cs: ChildSettings, seed: number, sampler: MeshSampler | null): ChildDesc {
  const per3 = per * 3;
  const count = Math.max(0, Math.round(cs.count));
  const n = parents * count;
  const par = new Int32Array(n * 4).fill(-1);
  const wt = new Float32Array(n * 4);
  const off = new Float32Array(n * 3);
  const sd = new Uint32Array(n);
  const len = new Float32Array(n);
  const r2 = new Uint8Array(n);
  const vpar = new Int32Array(n).fill(-1);
  const cseed = (seed + Math.round(cs.seed) * 7919) >>> 0;
  for (let c = 0; c < n; c++) {
    sd[c] = (cseed + c * 2654435761) >>> 0;
    len[c] = rand01(cseed, c, 201) < cs.lengthThreshold ? 1 : Math.max(0, Math.min(1, cs.length));
    r2[c] = rand01(cseed, c, 202) >= cs.rough2Threshold ? 1 : 0;
  }
  if (cs.type === 'SIMPLE' || !sampler || !parents) {
    for (let i = 0; i < parents; i++) {
      const b = i * per3;
      // parent direction and a frame around it
      let dx = parentPts[b + 3] - parentPts[b],
        dy = parentPts[b + 4] - parentPts[b + 1],
        dz = parentPts[b + 5] - parentPts[b + 2];
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const ux = Math.abs(dz) < 0.9 ? 0 : 1,
        uz = Math.abs(dz) < 0.9 ? 1 : 0;
      let tx = dy * uz,
        ty = dz * ux - dx * uz,
        tz = -dy * ux;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const bx = dy * tz - dz * ty,
        by = dz * tx - dx * tz,
        bz = dx * ty - dy * tx;
      for (let k = 0; k < count; k++) {
        const c = i * count + k;
        const ang = rand01(cseed, i, k, 60) * Math.PI * 2;
        const rad = Math.sqrt(rand01(cseed, i, k, 61)) * cs.radius;
        // roundness lifts children off the plane around the parent (towards a ball)
        const lift = (rand01(cseed, i, k, 62) - 0.5) * 2 * rad * Math.max(0, Math.min(1, cs.roundness));
        par[c * 4] = i;
        wt[c * 4] = 1;
        off[c * 3] = tx * Math.cos(ang) * rad + bx * Math.sin(ang) * rad + dx * lift;
        off[c * 3 + 1] = ty * Math.cos(ang) * rad + by * Math.sin(ang) * rad + dy * lift;
        off[c * 3 + 2] = tz * Math.cos(ang) * rad + bz * Math.sin(ang) * rad + dz * lift;
      }
    }
  } else {
    // interpolated: own roots on the emitter, weighted by the nearest parent roots
    const roots = new Float32Array(parents * 3);
    for (let i = 0; i < parents; i++) roots.set(parentPts.subarray(i * per3, i * per3 + 3), i * 3);
    const grid = new RootGrid(roots, parents);
    const sm = newSample();
    for (let c = 0; c < n; c++) {
      sampler.sample('FACE', cseed ^ 0x5bd1e995, c, sm);
      off[c * 3] = sm.px;
      off[c * 3 + 1] = sm.py;
      off[c * 3 + 2] = sm.pz;
      const near = grid.nearest(sm.px, sm.py, sm.pz, 4);
      const d0 = near.length ? near[0].d : 0;
      let sum = 0;
      near.forEach((p, j) => {
        // ignore parents much further away than the closest one
        if (j > 0 && p.d > d0 * 2 + 1e-6) return;
        const w = 1 / Math.max(1e-6, p.d * p.d);
        par[c * 4 + j] = p.i;
        wt[c * 4 + j] = w;
        sum += w;
      });
      for (let j = 0; j < 4; j++) wt[c * 4 + j] /= sum || 1;
    }
    // virtual parents: a share of the children others clump to
    if (cs.virtualParents > 0) {
      const vlist: number[] = [];
      for (let c = 0; c < n; c++) if (rand01(cseed, c, 203) < cs.virtualParents) vlist.push(c);
      if (vlist.length) {
        const vr = new Float32Array(vlist.length * 3);
        vlist.forEach((c, j) => vr.set(off.subarray(c * 3, c * 3 + 3), j * 3));
        const vg = new RootGrid(vr, vlist.length);
        const isV = new Set(vlist);
        for (let c = 0; c < n; c++) {
          if (isV.has(c)) continue;
          const nn = vg.nearest(off[c * 3], off[c * 3 + 1], off[c * 3 + 2], 1)[0];
          if (nn) vpar[c] = vlist[nn.i];
        }
      }
    }
  }
  return { n, par, wt, off, seed: sd, len, r2, vpar };
}

/** Spatial hash of root points for nearest-root lookups. */
class RootGrid {
  private cells = new Map<string, number[]>();
  private cell: number;
  constructor(
    private pts: Float32Array,
    n: number,
  ) {
    let mn = [Infinity, Infinity, Infinity],
      mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
      for (let c = 0; c < 3; c++) {
        mn[c] = Math.min(mn[c], pts[i * 3 + c]);
        mx[c] = Math.max(mx[c], pts[i * 3 + c]);
      }
    if (!n) mn = mx = [0, 0, 0];
    const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
    this.cell = Math.max(1e-4, diag / Math.max(1, Math.cbrt(n) * 1.5));
    for (let i = 0; i < n; i++) {
      const k = this.key(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(i);
    }
  }
  private key(x: number, y: number, z: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)},${Math.floor(z / this.cell)}`;
  }
  nearest(x: number, y: number, z: number, k: number): { i: number; d: number }[] {
    const cx = Math.floor(x / this.cell),
      cy = Math.floor(y / this.cell),
      cz = Math.floor(z / this.cell);
    const found: { i: number; d: number }[] = [];
    for (let r = 0; r < 64; r++) {
      for (let a = -r; a <= r; a++)
        for (let b = -r; b <= r; b++)
          for (let c = -r; c <= r; c++) {
            if (Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) !== r) continue;
            const l = this.cells.get(`${cx + a},${cy + b},${cz + c}`);
            if (!l) continue;
            for (const i of l) found.push({ i, d: Math.hypot(this.pts[i * 3] - x, this.pts[i * 3 + 1] - y, this.pts[i * 3 + 2] - z) });
          }
      // a ring further out cannot hold anything closer than r cells
      if (found.length >= k) {
        found.sort((p, q) => p.d - q.d);
        if (found[k - 1].d <= r * this.cell) break;
      }
      if (this.cells.size && r > 0 && found.length >= this.cells.size) break;
    }
    found.sort((p, q) => p.d - q.d);
    return found.slice(0, k);
  }
}

/** Smooth 3D value noise in -1..1 (one channel per `ch`). */
function noise3(x: number, y: number, z: number, seed: number, ch: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z);
  const fx = x - ix,
    fy = y - iy,
    fz = z - iz;
  const s = (t: number) => t * t * (3 - 2 * t);
  const ux = s(fx),
    uy = s(fy),
    uz = s(fz);
  const h = (a: number, b: number, c: number) => rand01(ix + a + seed * 31, iy + b, iz + c, ch + 977) * 2 - 1;
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(l(l(h(0, 0, 0), h(1, 0, 0), ux), l(h(0, 1, 0), h(1, 1, 0), ux), uy), l(l(h(0, 0, 1), h(1, 0, 1), ux), l(h(0, 1, 1), h(1, 1, 1), ux), uy), uz);
}

/** Child strands (`per` points each) from the current parent strands. */
export function childStrands(parentPts: Float32Array, per: number, desc: ChildDesc, cs: ChildSettings): Float32Array {
  const per3 = per * 3;
  const seg = per - 1;
  const out = new Float32Array(desc.n * per3);
  const base = new Float32Array(per3);
  const clumpTo = new Float32Array(per3);
  // parent path lengths (kink amplitude and roughness scale with the hair length)
  const nPar = parentPts.length / per3;
  const plen = new Float32Array(nPar);
  for (let i = 0; i < nPar; i++) {
    let l = 0;
    for (let k = 1; k < per; k++) {
      const a = i * per3 + k * 3;
      l += Math.hypot(parentPts[a] - parentPts[a - 3], parentPts[a + 1] - parentPts[a - 2], parentPts[a + 2] - parentPts[a - 1]);
    }
    plen[i] = l;
  }
  const axis = cs.kinkAxis === 'X' ? [1, 0, 0] : cs.kinkAxis === 'Y' ? [0, 1, 0] : [0, 0, 1];
  // virtual parents are built first (others clump to them)
  const order: number[] = [];
  for (let c = 0; c < desc.n; c++) if (desc.vpar[c] < 0) order.push(c);
  for (let c = 0; c < desc.n; c++) if (desc.vpar[c] >= 0) order.push(c);
  for (const c of order) {
    const sd = desc.seed[c];
    // weights, with parting where the parents point different ways
    const w = [desc.wt[c * 4], desc.wt[c * 4 + 1], desc.wt[c * 4 + 2], desc.wt[c * 4 + 3]];
    const P = [desc.par[c * 4], desc.par[c * 4 + 1], desc.par[c * 4 + 2], desc.par[c * 4 + 3]];
    if (cs.type === 'INTERPOLATED' && cs.partingFactor > 0 && P[1] >= 0) {
      const dir = (i: number) => {
        const a = i * per3,
          b = a + seg * 3;
        const v = [parentPts[b] - parentPts[a], parentPts[b + 1] - parentPts[a + 1], parentPts[b + 2] - parentPts[a + 2]];
        const l = Math.hypot(v[0], v[1], v[2]) || 1;
        return v.map((x) => x / l);
      };
      const d0 = dir(P[0]);
      let maxAng = 0;
      for (let j = 1; j < 4; j++)
        if (P[j] >= 0) {
          const dj = dir(P[j]);
          maxAng = Math.max(maxAng, (Math.acos(Math.max(-1, Math.min(1, d0[0] * dj[0] + d0[1] * dj[1] + d0[2] * dj[2]))) * 180) / Math.PI);
        }
      const lo = cs.partingMin,
        hi = Math.max(cs.partingMin + 1e-3, cs.partingMax);
      const t = Math.max(0, Math.min(1, (maxAng - lo) / (hi - lo))) * cs.partingFactor;
      if (t > 0) for (let j = 0; j < 4; j++) w[j] = w[j] * (1 - t) + (j === 0 ? t : 0);
    }
    // base path (shape of the parent(s), placed at the child's root)
    let hairLen = 0;
    for (let k = 0; k < per; k++) {
      let x = 0,
        y = 0,
        z = 0,
        cx = 0,
        cy = 0,
        cz = 0;
      for (let j = 0; j < 4; j++) {
        if (P[j] < 0 || !w[j]) continue;
        const a = P[j] * per3 + k * 3,
          r = P[j] * per3;
        if (cs.type === 'SIMPLE') {
          x += (parentPts[a] + desc.off[c * 3]) * w[j];
          y += (parentPts[a + 1] + desc.off[c * 3 + 1]) * w[j];
          z += (parentPts[a + 2] + desc.off[c * 3 + 2]) * w[j];
        } else {
          x += (parentPts[a] - parentPts[r]) * w[j];
          y += (parentPts[a + 1] - parentPts[r + 1]) * w[j];
          z += (parentPts[a + 2] - parentPts[r + 2]) * w[j];
        }
        cx += parentPts[a] * w[j];
        cy += parentPts[a + 1] * w[j];
        cz += parentPts[a + 2] * w[j];
        if (k === 0) hairLen += plen[P[j]] * w[j];
      }
      if (cs.type === 'INTERPOLATED') {
        x += desc.off[c * 3];
        y += desc.off[c * 3 + 1];
        z += desc.off[c * 3 + 2];
      }
      base[k * 3] = x;
      base[k * 3 + 1] = y;
      base[k * 3 + 2] = z;
      clumpTo[k * 3] = cx;
      clumpTo[k * 3 + 1] = cy;
      clumpTo[k * 3 + 2] = cz;
    }
    // clump target: a virtual parent's finished path, else the (weighted) parent
    const vp = desc.vpar[c];
    if (vp >= 0) clumpTo.set(out.subarray(vp * per3, vp * per3 + per3));
    const o = c * per3;
    const rootX = base[0],
      rootY = base[1],
      rootZ = base[2];
    const kAmp = cs.kinkAmplitude * (1 - cs.kinkAmplitudeRandom * rand01(sd, 1, 0, 301));
    let ax = axis[0],
      ay = axis[1],
      az = axis[2];
    if (cs.kinkAxisRandom > 0) {
      ax += (rand01(sd, 2, 0, 302) - 0.5) * 2 * cs.kinkAxisRandom;
      ay += (rand01(sd, 3, 0, 302) - 0.5) * 2 * cs.kinkAxisRandom;
      az += (rand01(sd, 4, 0, 302) - 0.5) * 2 * cs.kinkAxisRandom;
    }
    const endDir = [rand01(sd, 5, 0, 303) - 0.5, rand01(sd, 6, 0, 303) - 0.5, rand01(sd, 7, 0, 303) - 0.5];
    for (let k = 0; k < per; k++) {
      const u = seg ? k / seg : 0;
      let x = base[k * 3],
        y = base[k * 3 + 1],
        z = base[k * 3 + 2];
      let cx = clumpTo[k * 3],
        cy = clumpTo[k * 3 + 1],
        cz = clumpTo[k * 3 + 2];
      // clump noise moves the clump centres around
      if (cs.clumpNoise && cs.clump) {
        const ns = Math.max(1e-5, cs.clumpNoiseSize);
        const amp = cs.radius * 0.5 * u;
        cx += noise3(rootX / ns, rootY / ns, rootZ / ns, 5, 0) * amp;
        cy += noise3(rootX / ns, rootY / ns, rootZ / ns, 5, 1) * amp;
        cz += noise3(rootX / ns, rootY / ns, rootZ / ns, 5, 2) * amp;
      }
      const cl = cs.clump * shapeCurve(u, cs.clumpShape);
      if (cl > 0) {
        x += (cx - x) * cl;
        y += (cy - y) * cl;
        z += (cz - z) * cl;
      } else if (cl < 0) {
        // negative clump spreads the children out towards the tips
        x += (x - cx) * -cl;
        y += (y - cy) * -cl;
        z += (z - cz) * -cl;
      }
      // kink around the clump centre line
      if (cs.kink !== 'NO' && kAmp) {
        const ka = Math.max(0, k + 1 < per ? k + 1 : k),
          kb = ka - 1 >= 0 ? ka - 1 : 0;
        let tx = clumpTo[ka * 3] - clumpTo[kb * 3],
          ty = clumpTo[ka * 3 + 1] - clumpTo[kb * 3 + 1],
          tz = clumpTo[ka * 3 + 2] - clumpTo[kb * 3 + 2];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl;
        ty /= tl;
        tz /= tl;
        // n1: from the centre line towards the child (or any perpendicular)
        let n1x = x - cx,
          n1y = y - cy,
          n1z = z - cz;
        const dot = n1x * tx + n1y * ty + n1z * tz;
        n1x -= tx * dot;
        n1y -= ty * dot;
        n1z -= tz * dot;
        let nl = Math.hypot(n1x, n1y, n1z);
        if (nl < 1e-9) {
          n1x = Math.abs(tz) < 0.9 ? -ty : 1;
          n1y = Math.abs(tz) < 0.9 ? tx : 0;
          n1z = 0;
          nl = Math.hypot(n1x, n1y, n1z) || 1;
        }
        n1x /= nl;
        n1y /= nl;
        n1z /= nl;
        const n2x = ty * n1z - tz * n1y,
          n2y = tz * n1x - tx * n1z,
          n2z = tx * n1y - ty * n1x;
        const shaped = shapeCurve(u, cs.kinkShape);
        const A = kAmp * shaped * (1 - cs.kinkAmplitudeClump * Math.max(0, cl) * 0.5);
        const phi = 2 * Math.PI * cs.kinkFrequency * u + rand01(sd, 8, 0, 304) * 2 * Math.PI;
        const flat = 1 - Math.max(0, Math.min(1, cs.kinkFlat));
        let d1 = 0,
          d2 = 0;
        switch (cs.kink) {
          case 'CURL':
            d1 = (Math.cos(phi) - 1) * A;
            d2 = Math.sin(phi) * A * flat;
            break;
          case 'RADIAL':
            d1 = Math.sin(phi) * A;
            break;
          case 'BRAID':
            d1 = Math.sin(phi) * A;
            d2 = Math.sin(2 * phi) * A * 0.5 * flat;
            break;
          case 'SPIRAL':
            d1 = Math.cos(phi) * A * u;
            d2 = Math.sin(phi) * A * u * flat;
            break;
          case 'WAVE': {
            // along the kink axis (perpendicular to the strand)
            const ad = ax * tx + ay * ty + az * tz;
            let wx = ax - tx * ad,
              wy = ay - ty * ad,
              wz = az - tz * ad;
            const wl = Math.hypot(wx, wy, wz);
            if (wl > 1e-9) {
              wx /= wl;
              wy /= wl;
              wz /= wl;
              const s = Math.sin(phi) * A;
              x += wx * s;
              y += wy * s;
              z += wz * s;
            }
            break;
          }
        }
        x += n1x * d1 + n2x * d2;
        y += n1y * d1 + n2y * d2;
        z += n1z * d1 + n2z * d2;
      }
      // roughness: uniform (by position), at the ends, and random per child
      const L = hairLen || 1;
      if (cs.rough1) {
        const sz = Math.max(0.01, cs.rough1Size) * L * 0.5;
        const r = cs.rough1 * L * 0.1 * Math.min(1, u * 4);
        x += noise3(x / sz, y / sz, z / sz, 11, 0) * r;
        y += noise3(x / sz, y / sz, z / sz, 11, 1) * r;
        z += noise3(x / sz, y / sz, z / sz, 11, 2) * r;
      }
      if (cs.roughEnd) {
        const r = cs.roughEnd * L * 0.2 * Math.pow(u, Math.max(0, cs.roughEndShape));
        x += endDir[0] * r;
        y += endDir[1] * r;
        z += endDir[2] * r;
      }
      if (cs.rough2 && desc.r2[c]) {
        const sz = Math.max(0.01, cs.rough2Size) * L * 0.5;
        const r = cs.rough2 * L * 0.1 * u;
        x += noise3(x / sz + sd * 1e-3, y / sz, z / sz, 13, 0) * r;
        y += noise3(x / sz + sd * 1e-3, y / sz, z / sz, 13, 1) * r;
        z += noise3(x / sz + sd * 1e-3, y / sz, z / sz, 13, 2) * r;
      }
      out[o + k * 3] = x;
      out[o + k * 3 + 1] = y;
      out[o + k * 3 + 2] = z;
    }
    // shorter children keep the first part of their path (resampled to the same point count)
    const lf = desc.len[c];
    if (lf < 0.999 && per > 1) shorten(out, o, per, lf);
  }
  return out;
}

/** Cut a polyline (`per` points at `o`) to a share of its length, keeping its point count. */
function shorten(a: Float32Array, o: number, per: number, f: number) {
  const seg = per - 1;
  const src = a.slice(o, o + per * 3);
  const cum = new Float32Array(per);
  for (let k = 1; k < per; k++) cum[k] = cum[k - 1] + Math.hypot(src[k * 3] - src[k * 3 - 3], src[k * 3 + 1] - src[k * 3 - 2], src[k * 3 + 2] - src[k * 3 - 1]);
  const total = cum[seg] * Math.max(0, f);
  let j = 0;
  for (let k = 0; k < per; k++) {
    const t = (k / seg) * total;
    while (j < seg - 1 && cum[j + 1] < t) j++;
    const span = cum[j + 1] - cum[j] || 1;
    const q = Math.max(0, Math.min(1, (t - cum[j]) / span));
    for (let c = 0; c < 3; c++) a[o + k * 3 + c] = src[j * 3 + c] + (src[(j + 1) * 3 + c] - src[j * 3 + c]) * q;
  }
}
