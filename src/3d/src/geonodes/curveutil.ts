// Poly curve helpers: lengths, tangents, minimum-twist normals, parameterization.
import type { CurvesComponent } from './geometry';

export function curveLengths(c: CurvesComponent): {
  segment: Float32Array;
  total: Float32Array;
} {
  const P = c.positions;
  const segment = new Float32Array(c.pointCount); // distance from curve start to each point
  const total = new Float32Array(c.curveCount);
  for (let k = 0; k < c.curveCount; k++) {
    const s = c.curveOffsets[k],
      e = c.curveOffsets[k + 1];
    let acc = 0;
    for (let i = s; i < e; i++) {
      segment[i] = acc;
      if (i + 1 < e) acc += Math.hypot(P[(i + 1) * 3] - P[i * 3], P[(i + 1) * 3 + 1] - P[i * 3 + 1], P[(i + 1) * 3 + 2] - P[i * 3 + 2]);
    }
    if (c.cyclic[k] && e - s > 1) acc += Math.hypot(P[s * 3] - P[(e - 1) * 3], P[s * 3 + 1] - P[(e - 1) * 3 + 1], P[s * 3 + 2] - P[(e - 1) * 3 + 2]);
    total[k] = acc;
  }
  return { segment, total };
}

/** Per curve: first and last tangent overrides (NaN = none), e.g. Bézier ends following handles. */
export const endTangentOverrides = new WeakMap<CurvesComponent, Float32Array>();

export function curveTangents(c: CurvesComponent): Float32Array {
  const out = polyTangents(c);
  const ends = endTangentOverrides.get(c);
  if (ends)
    for (let k = 0; k < c.curveCount; k++) {
      const s = c.curveOffsets[k],
        e = c.curveOffsets[k + 1];
      if (e - s < 2) continue;
      if (!Number.isNaN(ends[k * 6])) out.set(ends.subarray(k * 6, k * 6 + 3), s * 3);
      if (!Number.isNaN(ends[k * 6 + 3])) out.set(ends.subarray(k * 6 + 3, k * 6 + 6), (e - 1) * 3);
    }
  return out;
}

function polyTangents(c: CurvesComponent): Float32Array {
  const P = c.positions,
    out = new Float32Array(P.length);
  for (let k = 0; k < c.curveCount; k++) {
    const s = c.curveOffsets[k],
      e = c.curveOffsets[k + 1],
      n = e - s,
      cyc = !!c.cyclic[k];
    for (let i = s; i < e; i++) {
      let a = i - 1,
        b = i + 1;
      if (a < s) a = cyc ? e - 1 : i;
      if (b >= e) b = cyc ? s : i;
      if (n < 2) {
        out[i * 3 + 2] = 1;
        continue;
      }
      // average of normalized adjacent segment directions
      let tx = 0,
        ty = 0,
        tz = 0;
      if (a !== i) {
        const dx = P[i * 3] - P[a * 3],
          dy = P[i * 3 + 1] - P[a * 3 + 1],
          dz = P[i * 3 + 2] - P[a * 3 + 2];
        const l = Math.hypot(dx, dy, dz) || 1;
        tx += dx / l;
        ty += dy / l;
        tz += dz / l;
      }
      if (b !== i) {
        const dx = P[b * 3] - P[i * 3],
          dy = P[b * 3 + 1] - P[i * 3 + 1],
          dz = P[b * 3 + 2] - P[i * 3 + 2];
        const l = Math.hypot(dx, dy, dz) || 1;
        tx += dx / l;
        ty += dy / l;
        tz += dz / l;
      }
      const l = Math.hypot(tx, ty, tz) || 1;
      out[i * 3] = tx / l;
      out[i * 3 + 1] = ty / l;
      out[i * 3 + 2] = tz / l;
    }
  }
  return out;
}

function rotateAround(v: number[], axis: number[], angle: number): number[] {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const cx = axis[1] * v[2] - axis[2] * v[1],
    cy = axis[2] * v[0] - axis[0] * v[2],
    cz = axis[0] * v[1] - axis[1] * v[0];
  return [v[0] * c + cx * s + axis[0] * d * (1 - c), v[1] * c + cy * s + axis[1] * d * (1 - c), v[2] * c + cz * s + axis[2] * d * (1 - c)];
}

/** Minimum-twist normals (parallel transport), cyclic curves distribute the closing twist. */
export function curveNormals(c: CurvesComponent, tangents = curveTangents(c)): Float32Array {
  const out = new Float32Array(c.positions.length);
  const tilt = c.attrs.get('tilt');
  const modes = c.attrs.get('normal_mode');
  const custom = c.attrs.get('custom_normal');
  for (let k = 0; k < c.curveCount; k++) {
    const s = c.curveOffsets[k],
      e = c.curveOffsets[k + 1];
    if (e <= s) continue;
    const mode = modes && modes.domain === 'CURVE' ? modes.data[k] : 0;
    if (mode === 1 || (mode === 2 && custom)) {
      // Z up: horizontal, to the right of the direction of travel; free: the stored normal
      for (let i = s; i < e; i++) {
        let n = mode === 1 ? [tangents[i * 3 + 1], -tangents[i * 3], 0] : [custom!.data[i * 3], custom!.data[i * 3 + 1], custom!.data[i * 3 + 2]];
        const l = Math.hypot(n[0], n[1], n[2]);
        n = l > 1e-9 ? n.map((x) => x / l) : mode === 1 ? [1, 0, 0] : [0, 0, 1];
        out.set(n, i * 3);
      }
      applyTilt(out, tangents, tilt?.data, s, e);
      continue;
    }
    const t0 = [tangents[s * 3], tangents[s * 3 + 1], tangents[s * 3 + 2]];
    // initial normal: tangent × Z (horizontal, to the right of the direction of travel);
    // curves starting along Z use the X axis
    let n = [t0[1], -t0[0], 0];
    let l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-6) {
      n = [1, 0, 0];
      l = 1;
    }
    n = n.map((x) => x / l);
    const ref = n;
    out.set(n, s * 3);
    let prevT = t0;
    for (let i = s + 1; i < e; i++) {
      const t = [tangents[i * 3], tangents[i * 3 + 1], tangents[i * 3 + 2]];
      const ax = [prevT[1] * t[2] - prevT[2] * t[1], prevT[2] * t[0] - prevT[0] * t[2], prevT[0] * t[1] - prevT[1] * t[0]];
      const al = Math.hypot(ax[0], ax[1], ax[2]);
      if (al > 1e-8) {
        const ang = Math.atan2(al, prevT[0] * t[0] + prevT[1] * t[1] + prevT[2] * t[2]);
        n = rotateAround(
          n,
          ax.map((x) => x / al),
          ang,
        );
      }
      l = Math.hypot(n[0], n[1], n[2]) || 1;
      n = n.map((x) => x / l);
      out.set(n, i * 3);
      prevT = t;
    }
    if (c.cyclic[k] && e - s > 2) {
      // twist correction so the end normal matches the start after closing the loop
      const t = t0;
      const ax = [prevT[1] * t[2] - prevT[2] * t[1], prevT[2] * t[0] - prevT[0] * t[2], prevT[0] * t[1] - prevT[1] * t[0]];
      const al = Math.hypot(ax[0], ax[1], ax[2]);
      let endN = n;
      if (al > 1e-8)
        endN = rotateAround(
          n,
          ax.map((x) => x / al),
          Math.atan2(al, prevT[0] * t[0] + prevT[1] * t[1] + prevT[2] * t[2]),
        );
      const cr = [endN[1] * ref[2] - endN[2] * ref[1], endN[2] * ref[0] - endN[0] * ref[2], endN[0] * ref[1] - endN[1] * ref[0]];
      const sign = cr[0] * t[0] + cr[1] * t[1] + cr[2] * t[2] < 0 ? -1 : 1;
      const twist = sign * Math.acos(Math.max(-1, Math.min(1, endN[0] * ref[0] + endN[1] * ref[1] + endN[2] * ref[2])));
      const cnt = e - s;
      for (let i = s + 1; i < e; i++) {
        const tt = [tangents[i * 3], tangents[i * 3 + 1], tangents[i * 3 + 2]];
        const r = rotateAround([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]], tt, (twist * (i - s)) / cnt);
        out.set(r, i * 3);
      }
    }
    applyTilt(out, tangents, tilt?.data, s, e);
  }
  return out;
}

function applyTilt(out: Float32Array, tangents: Float32Array, tilt: ArrayLike<number> | undefined, s: number, e: number) {
  if (!tilt) return;
  for (let i = s; i < e; i++) {
    const a = tilt[i];
    if (!a) continue;
    const tt = [tangents[i * 3], tangents[i * 3 + 1], tangents[i * 3 + 2]];
    out.set(rotateAround([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]], tt, a), i * 3);
  }
}

/** Euler XYZ rotation that maps local Z to `z` and local X to `x` (orthonormalized). */
export function eulerFromAxes(xAxis: number[], zAxis: number[]): [number, number, number] {
  let z = zAxis;
  let l = Math.hypot(z[0], z[1], z[2]) || 1;
  z = z.map((v) => v / l);
  let x = xAxis.map((v, i) => v - z[i] * (xAxis[0] * z[0] + xAxis[1] * z[1] + xAxis[2] * z[2]));
  l = Math.hypot(x[0], x[1], x[2]);
  if (l < 1e-8) {
    const ref = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    x = ref.map((v, i) => v - z[i] * (ref[0] * z[0] + ref[1] * z[1] + ref[2] * z[2]));
    l = Math.hypot(x[0], x[1], x[2]) || 1;
  }
  x = x.map((v) => v / l);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  // rotation matrix columns x, y, z → XYZ euler (R = Rz Ry Rx)
  const r20 = x[2],
    r21 = y[2],
    r22 = z[2],
    r10 = x[1],
    r00 = x[0];
  const ry = Math.asin(Math.max(-1, Math.min(1, -r20)));
  let rx: number, rz: number;
  if (Math.abs(r20) < 0.9999999) {
    rx = Math.atan2(r21, r22);
    rz = Math.atan2(r10, r00);
  } else {
    rx = Math.atan2(-z[1], y[1]);
    rz = 0;
  }
  return [rx, ry, rz];
}
