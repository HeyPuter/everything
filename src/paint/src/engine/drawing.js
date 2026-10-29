/**
 * Paint drawing primitives (original). MS Paint–inspired — not Microsoft Paint.
 */

/** @typedef {{ r:number,g:number,b:number,a?:number }} RGBA */

/** @param {string} hex */
export function parseHex(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = Number.parseInt(full.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
}

/** @param {RGBA} a @param {RGBA} b */
export function sameColor(a, b, tol = 0) {
  return (
    Math.abs(a.r - b.r) <= tol &&
    Math.abs(a.g - b.g) <= tol &&
    Math.abs(a.b - b.b) <= tol
  );
}

/**
 * Flood fill on ImageData (scanline). Mutates data.
 * @param {ImageData} image
 * @param {number} sx
 * @param {number} sy
 * @param {RGBA} fill
 */
export function floodFillAt(image, sx, sy, fill) {
  const { width: w, height: h, data } = image;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return 0;
  const idx = (sy * w + sx) * 4;
  const target = { r: data[idx], g: data[idx + 1], b: data[idx + 2], a: data[idx + 3] };
  if (sameColor(target, fill)) return 0;

  /** @type {[number, number][]} */
  const stack = [[sx, sy]];
  let painted = 0;
  while (stack.length) {
    const [x, y] = stack.pop();
    let lx = x;
    while (lx >= 0 && match(lx, y)) lx -= 1;
    lx += 1;
    let spanUp = false;
    let spanDown = false;
    for (let i = lx; i < w && match(i, y); i += 1) {
      set(i, y, fill);
      painted += 1;
      if (y > 0) {
        if (match(i, y - 1)) {
          if (!spanUp) {
            stack.push([i, y - 1]);
            spanUp = true;
          }
        } else spanUp = false;
      }
      if (y < h - 1) {
        if (match(i, y + 1)) {
          if (!spanDown) {
            stack.push([i, y + 1]);
            spanDown = true;
          }
        } else spanDown = false;
      }
    }
  }
  return painted;

  function match(x, y) {
    const i = (y * w + x) * 4;
    return sameColor({ r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] }, target);
  }
  /** @param {number} x @param {number} y @param {RGBA} c */
  function set(x, y, c) {
    const i = (y * w + x) * 4;
    data[i] = c.r;
    data[i + 1] = c.g;
    data[i + 2] = c.b;
    data[i + 3] = c.a ?? 255;
  }
}

/** Bresenham line points. @returns {[number, number][]} */
export function linePoints(x0, y0, x1, y1) {
  /** @type {[number, number][]} */
  const pts = [];
  let x = Math.round(x0);
  let y = Math.round(y0);
  const xEnd = Math.round(x1);
  const yEnd = Math.round(y1);
  const dx = Math.abs(xEnd - x);
  const dy = Math.abs(yEnd - y);
  const sx = x < xEnd ? 1 : -1;
  const sy = y < yEnd ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    pts.push([x, y]);
    if (x === xEnd && y === yEnd) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return pts;
}

/** Undo stack of ImageData snapshots. */
export function createHistory(limit = 30) {
  /** @type {ImageData[]} */
  const stack = [];
  return {
    /** @param {ImageData} snap */
    push(snap) {
      stack.push(snap);
      while (stack.length > limit) stack.shift();
    },
    /** @returns {ImageData | null} */
    pop() {
      return stack.pop() || null;
    },
    get size() {
      return stack.length;
    },
  };
}

export const TOOLS = Object.freeze([
  'pencil',
  'brush',
  'eraser',
  'line',
  'rect',
  'ellipse',
  'fill',
]);
