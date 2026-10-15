// Ambient Occlusion render pass: screen-space occlusion of every pixel computed from the normal /
// depth guide buffer of a final render (1 = open, 0 = fully occluded). Pure, unit tested.

/**
 * `guide`: top-down RGBA rows (rgb world normal, a view depth, 0 = background). `proj` / `invProj`: camera projection and its inverse, `view`: world → view
 * matrix (column-major). Returns top-down rows like the other passes.
 */
export function ambientOcclusionPass(guide: Float32Array, W: number, H: number, proj: ArrayLike<number>, invProj: ArrayLike<number>, view: ArrayLike<number>, ortho: boolean, distance: number, dirs = 8, steps = 6): Float32Array {
  const out = new Float32Array(W * H).fill(1);
  const n = W * H;
  // view-space positions of every pixel
  const pos = new Float32Array(n * 3);
  const e = invProj;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = guide[i * 4 + 3];
      if (!(d > 0)) continue;
      const nx = ((x + 0.5) / W) * 2 - 1,
        ny = 1 - ((y + 0.5) / H) * 2;
      // point on the near plane, then scaled along the view ray to depth d
      const w = e[3] * nx + e[7] * ny + e[11] * -1 + e[15];
      const vx = (e[0] * nx + e[4] * ny + e[8] * -1 + e[12]) / w,
        vy = (e[1] * nx + e[5] * ny + e[9] * -1 + e[13]) / w,
        vz = (e[2] * nx + e[6] * ny + e[10] * -1 + e[14]) / w;
      if (ortho) {
        pos[i * 3] = vx;
        pos[i * 3 + 1] = vy;
        pos[i * 3 + 2] = -d;
      } else {
        const k = d / Math.max(1e-6, -vz);
        pos[i * 3] = vx * k;
        pos[i * 3 + 1] = vy * k;
        pos[i * 3 + 2] = -d;
      }
    }
  const R = Math.max(1e-4, distance);
  const fy = proj[5] * H * 0.5;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = guide[i * 4 + 3];
      if (!(d > 0)) continue;
      const px = pos[i * 3],
        py = pos[i * 3 + 1],
        pz = pos[i * 3 + 2];
      // world normal → view normal (rotation part of the view matrix)
      const wx = guide[i * 4],
        wy = guide[i * 4 + 1],
        wz = guide[i * 4 + 2];
      const nxv = view[0] * wx + view[4] * wy + view[8] * wz,
        nyv = view[1] * wx + view[5] * wy + view[9] * wz,
        nzv = view[2] * wx + view[6] * wy + view[10] * wz;
      const radiusPx = Math.max(2, Math.min(Math.max(W, H) / 4, ortho ? R * fy : (R * fy) / Math.max(1e-4, d)));
      let occ = 0,
        count = 0;
      // rotate the directions per pixel to trade banding for noise
      const rot = ((x * 7 + y * 13) % 16) / 16;
      for (let k = 0; k < dirs; k++) {
        const a = ((k + rot) / dirs) * Math.PI * 2;
        const dx = Math.cos(a),
          dy = Math.sin(a);
        for (let s = 1; s <= steps; s++) {
          const t = (s / steps) * radiusPx;
          const qx = Math.round(x + dx * t),
            qy = Math.round(y + dy * t);
          if (qx < 0 || qy < 0 || qx >= W || qy >= H) break;
          const j = qy * W + qx;
          if (!(guide[j * 4 + 3] > 0)) continue;
          const vx = pos[j * 3] - px,
            vy = pos[j * 3 + 1] - py,
            vz = pos[j * 3 + 2] - pz;
          const len = Math.hypot(vx, vy, vz);
          if (len < 1e-5 || len > R) continue;
          const c = (vx * nxv + vy * nyv + vz * nzv) / len;
          if (c > 0.1) occ += (c - 0.1) * (1 - len / R);
          count++;
        }
      }
      out[i] = count ? Math.max(0, 1 - (2 * occ) / (dirs * steps)) : 1;
    }
  return out;
}
