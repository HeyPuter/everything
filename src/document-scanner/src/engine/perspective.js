/**
 * Homography-based perspective warp for document quads.
 * Corners are [{x,y}, ...] in source image pixel space, ordered
 * TL → TR → BR → BL.
 */

export function orderCorners(points) {
  if (!points || points.length !== 4) {
    throw new Error('exactly four corners are required');
  }
  const sorted = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
  const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = sorted.slice(2).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bottom[1], bottom[0]]; // TL TR BR BL
}

/** Solve 8x8 for perspective transform mapping src→dst unit square. */
export function computeHomography(src, dst) {
  // Maps destination (u,v) → source (x,y) for inverse sampling.
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i += 1) {
    const { x: x1, y: y1 } = dst[i];
    const { x: x2, y: y2 } = src[i];
    A.push([x1, y1, 1, 0, 0, 0, -x2 * x1, -x2 * y1]);
    b.push(x2);
    A.push([0, 0, 0, x1, y1, 1, -y2 * x1, -y2 * y1]);
    b.push(y2);
  }
  const h = solveLinear(A, b);
  return [...h, 1];
}

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  };
}

/**
 * Warp ImageData from src corners into a flat width×height ImageData.
 */
export function warpPerspective(srcData, srcWidth, srcHeight, corners, outWidth, outHeight) {
  const ordered = orderCorners(corners);
  const dst = [
    { x: 0, y: 0 },
    { x: outWidth - 1, y: 0 },
    { x: outWidth - 1, y: outHeight - 1 },
    { x: 0, y: outHeight - 1 },
  ];
  const H = computeHomography(ordered, dst);
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const p = applyHomography(H, x, y);
      const sample = sampleBilinear(srcData, srcWidth, srcHeight, p.x, p.y);
      const i = (y * outWidth + x) * 4;
      out[i] = sample[0];
      out[i + 1] = sample[1];
      out[i + 2] = sample[2];
      out[i + 3] = 255;
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

export function defaultQuad(width, height, inset = 0.08) {
  const x0 = width * inset;
  const y0 = height * inset;
  const x1 = width * (1 - inset);
  const y1 = height * (1 - inset);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

export function outputSizeForQuad(corners, maxEdge = 1600) {
  const [tl, tr, br, bl] = orderCorners(corners);
  const w = Math.max(dist(tl, tr), dist(bl, br));
  const h = Math.max(dist(tl, bl), dist(tr, br));
  const scale = Math.min(1, maxEdge / Math.max(w, h, 1));
  return {
    width: Math.max(64, Math.round(w * scale)),
    height: Math.max(64, Math.round(h * scale)),
  };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function sampleBilinear(data, w, h, x, y) {
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return [255, 255, 255];
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const dx = x - x0;
  const dy = y - y0;
  const idx = (yy, xx) => (yy * w + xx) * 4;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const v00 = data[idx(y0, x0) + c];
    const v10 = data[idx(y0, x0 + 1) + c];
    const v01 = data[idx(y0 + 1, x0) + c];
    const v11 = data[idx(y0 + 1, x0 + 1) + c];
    out[c] = Math.round(
      v00 * (1 - dx) * (1 - dy) + v10 * dx * (1 - dy) + v01 * (1 - dx) * dy + v11 * dx * dy,
    );
  }
  return out;
}

/** Gaussian elimination for an 8×8 system. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row.map(Number), Number(b[i])]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) throw new Error('degenerate corner set');
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let c = col; c <= n; c += 1) M[col][c] /= div;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}
