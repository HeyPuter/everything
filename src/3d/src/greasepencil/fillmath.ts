// Pure raster kernels of the Fill tool: flood fill, dilation, marching-squares contour tracing
// and loop simplification (unit tested).
/** 4-connected flood fill of non-boundary pixels. Returns null when the region touches the border. */
export function floodFill(boundary: Uint8Array, W: number, H: number, x: number, y: number): Uint8Array | null {
  const out = new Uint8Array(W * H);
  const start = y * W + x;
  if (x < 0 || y < 0 || x >= W || y >= H || boundary[start]) return null;
  const stack = new Int32Array(W * H);
  let sp = 0;
  stack[sp++] = start;
  out[start] = 1;
  while (sp) {
    const i = stack[--sp];
    const px = i % W,
      py = (i / W) | 0;
    if (px === 0 || py === 0 || px === W - 1 || py === H - 1) return null; // leaks out of the view
    const nb = [i - 1, i + 1, i - W, i + W];
    for (const j of nb)
      if (!out[j] && !boundary[j]) {
        out[j] = 1;
        stack[sp++] = j;
      }
  }
  return out;
}

/** Pixels reachable from the image border without crossing `wall`. */
export function borderFlood(wall: Uint8Array, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  const push = (i: number) => {
    if (!out[i] && !wall[i]) {
      out[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < W; x++) push(x), push((H - 1) * W + x);
  for (let y = 0; y < H; y++) push(y * W), push(y * W + W - 1);
  while (sp) {
    const i = stack[--sp];
    const px = i % W;
    if (px > 0) push(i - 1);
    if (px < W - 1) push(i + 1);
    if (i >= W) push(i - W);
    if (i < W * (H - 1)) push(i + W);
  }
  return out;
}

/**
 * Inverted fill: clicked inside a closed area → the closed areas inside it (its holes); clicked
 * outside every shape → all closed areas. Null when there is nothing to fill.
 */
export function invertedRegion(boundary: Uint8Array, W: number, H: number, x: number, y: number): Uint8Array | null {
  if (x < 0 || y < 0 || x >= W || y >= H || boundary[y * W + x]) return null;
  const region = floodFill(boundary, W, H, x, y);
  const out = new Uint8Array(W * H);
  let any = false;
  if (region) {
    // everything the clicked area surrounds, minus the lines themselves
    const outside = borderFlood(region, W, H);
    for (let i = 0; i < W * H; i++)
      if (!region[i] && !outside[i] && !boundary[i]) {
        out[i] = 1;
        any = true;
      }
  } else {
    const outside = borderFlood(boundary, W, H);
    for (let i = 0; i < W * H; i++)
      if (!boundary[i] && !outside[i]) {
        out[i] = 1;
        any = true;
      }
  }
  return any ? out : null;
}

/** Grow a mask by `r` pixels (square neighbourhood). */
export function dilate(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const next = cur.slice();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (cur[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < W - 1 && cur[i + 1]) || (y > 0 && cur[i - W]) || (y < H - 1 && cur[i + W])) next[i] = 1;
      }
    cur = next;
  }
  return cur;
}

/**
 * Marching squares: closed outlines (pixel coordinates, pixel centers at +0.5) of a binary mask,
 * outer boundaries and holes alike.
 */
export function traceContours(mask: Uint8Array, W: number, H: number): [number, number][][] {
  const val = (i: number, j: number) => (i < 0 || j < 0 || i >= W || j >= H ? 0 : mask[j * W + i]);
  const S = W + 2;
  // edge ids: horizontal edge from corner (i,j) to (i+1,j); vertical edge from (i,j) to (i,j+1)
  const hk = (i: number, j: number) => ((j + 1) * S + (i + 1)) * 2;
  const vk = (i: number, j: number) => ((j + 1) * S + (i + 1)) * 2 + 1;
  const pos = (k: number): [number, number] => {
    const cell = k >> 1;
    const i = (cell % S) - 1,
      j = Math.floor(cell / S) - 1;
    return k & 1 ? [i + 0.5, j + 1] : [i + 1, j + 0.5];
  };
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    let la = adj.get(a);
    if (!la) adj.set(a, (la = []));
    la.push(b);
    let lb = adj.get(b);
    if (!lb) adj.set(b, (lb = []));
    lb.push(a);
  };
  for (let j = -1; j < H; j++)
    for (let i = -1; i < W; i++) {
      const tl = val(i, j),
        tr = val(i + 1, j),
        br = val(i + 1, j + 1),
        bl = val(i, j + 1);
      const c = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (c === 0 || c === 15) continue;
      const T = hk(i, j),
        B = hk(i, j + 1),
        L = vk(i, j),
        R = vk(i + 1, j);
      switch (c) {
        case 1:
        case 14:
          link(L, B);
          break;
        case 2:
        case 13:
          link(B, R);
          break;
        case 3:
        case 12:
          link(L, R);
          break;
        case 4:
        case 11:
          link(T, R);
          break;
        case 6:
        case 9:
          link(T, B);
          break;
        case 7:
        case 8:
          link(T, L);
          break;
        case 5: // tr & bl inside
          link(T, R);
          link(B, L);
          break;
        case 10: // tl & br inside
          link(T, L);
          link(B, R);
          break;
      }
    }
  const seen = new Set<number>();
  const loops: [number, number][][] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop: [number, number][] = [];
    let prev = -1,
      cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      const p = pos(cur);
      loop.push([p[0] + 0.5, p[1] + 0.5]);
      const nb = adj.get(cur)!;
      const next = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur;
      cur = next;
      if (cur === undefined) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Ramer–Douglas–Peucker for closed 2D loops. */
export function simplifyLoop(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 8) return pts;
  // split the loop at its farthest point pair to simplify two open chains
  const n = pts.length;
  let far = 0,
    fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const rdp = (chain: [number, number][]): [number, number][] => {
    if (chain.length < 3) return chain;
    const keep = new Uint8Array(chain.length);
    keep[0] = keep[chain.length - 1] = 1;
    const st: [number, number][] = [[0, chain.length - 1]];
    while (st.length) {
      const [a, b] = st.pop()!;
      const [ax, ay] = chain[a],
        [bx, by] = chain[b];
      const dx = bx - ax,
        dy = by - ay;
      const L = Math.hypot(dx, dy) || 1;
      let best = -1,
        bd = eps;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((chain[i][0] - ax) * dy - (chain[i][1] - ay) * dx) / L;
        if (d > bd) {
          bd = d;
          best = i;
        }
      }
      if (best >= 0) {
        keep[best] = 1;
        st.push([a, best], [best, b]);
      }
    }
    return chain.filter((_, i) => keep[i]);
  };
  const a = rdp(pts.slice(0, far + 1));
  const b = rdp([...pts.slice(far), pts[0]]);
  return [...a, ...b.slice(1, -1)];
}

