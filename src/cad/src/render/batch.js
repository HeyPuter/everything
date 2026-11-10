/**
 * GPU batch builder: a display-list sink (see core/display.js) that packs
 * line segments and fill triangles into interleaved typed arrays ready for
 * upload.
 *
 * World coordinates are stored as float32 high and low parts
 * (hi = fround(x), lo = x - hi) so the shader can subtract the camera
 * position without losing precision far from the origin.
 *
 * Segment instance (SEG_STRIDE bytes):
 *   f32 x1h y1h x2h y2h | f32 x1l y1l x2l y2l | f32 dist0 | f32 patScale
 *   | u8 r g b a | u8 lwIndex+flags<<5 patternRow join0 join1 | f32 band
 * join0 and join1 describe the start and end of a polyline segment: 0 is a
 * free end (square cap), otherwise the joint's bisector, given by the angle
 * (code - 1) * JOIN_STEP of its normal in world space. Both segments at a
 * joint cut themselves along that same line, so the joint is covered exactly
 * once: transparent and highlighted curves get no darker dots at vertices.
 * Fill vertex (TRI_STRIDE bytes):
 *   f32 xh yh xl yl | u8 r g b a | f32 band
 * band is the object's draw-order band (see drawBands in core/display.js).
 */
import earcut from 'earcut';

export const SEG_STRIDE = 52;
export const SEG_FLOATS = SEG_STRIDE / 4;
export const TRI_STRIDE = 24;
export const TRI_FLOATS = TRI_STRIDE / 4;

/** Segment flags. */
export const F_HIGHLIGHT = 1;
export const F_SOLID = 2;

const fround = Math.fround;

/** Angle quantum of joint codes. */
export const JOIN_STEP = (2 * Math.PI) / 255;

/**
 * Joint code for a turn from direction (ax, ay) to (bx, by): the direction
 * of the bisector's normal. 0 (square caps) for degenerate or sharp turns.
 */
export function joinCode(ax, ay, bx, by) {
  const la = Math.sqrt(ax * ax + ay * ay),
    lb = Math.sqrt(bx * bx + by * by);
  if (!la || !lb) return 0;
  return joinUnits(ax / la, ay / la, bx / lb, by / lb);
}

/** joinCode for unit directions; (0, 0) stands for a zero-length segment. */
function joinUnits(ux, uy, vx, vy) {
  if ((!ux && !uy) || (!vx && !vy)) return 0;
  const nx = ux + vx,
    ny = uy + vy;
  // Turns sharper than 120 degrees would need very long cut segments.
  if (nx * nx + ny * ny < 1) return 0;
  const a = atan2Fast(ny, nx);
  return 1 + (Math.round((a < 0 ? a + 2 * Math.PI : a) / JOIN_STEP) % 255);
}

/**
 * Math.atan2 to within 1e-5 rad, far finer than JOIN_STEP and several times
 * faster; joint codes are computed for every curve segment of a build.
 */
function atan2Fast(y, x) {
  const ax = Math.abs(x),
    ay = Math.abs(y);
  const t = ax > ay ? ay / ax : ax / ay,
    s = t * t;
  let r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * t + t;
  if (ay > ax) r = Math.PI / 2 - r;
  if (x < 0) r = Math.PI - r;
  return y < 0 ? -r : r;
}

/** Ends of the part of a segment inside a box, as fractions of its length (see clipSeg). */
let clip0 = 0,
  clip1 = 1;

/** Clip segment (x1, y1)-(x2, y2) to box [minX, minY, maxX, maxY]; false when it lies outside. */
function clipSeg(x1, y1, x2, y2, box) {
  const dx = x2 - x1,
    dy = y2 - y1;
  let t0 = 0,
    t1 = 1;
  for (let i = 0; i < 4; i++) {
    const p = i === 0 ? -dx : i === 1 ? dx : i === 2 ? -dy : dy;
    const q = i === 0 ? x1 - box[0] : i === 1 ? box[2] - x1 : i === 2 ? y1 - box[1] : box[3] - y1;
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  clip0 = t0;
  clip1 = t1;
  return true;
}

/** Grown buffers are kept this long after a build last needed them (ms). */
const KEEP_GROWN_MS = 10000;

export class Batch {
  /**
   * @param {(pattern: number[]) => number} patternRow maps a linetype's
   *   basePattern array to its row in the renderer's pattern texture.
   */
  constructor(patternRow, segCapacity = 1024, triCapacity = 256) {
    this.patternRow = patternRow;
    this.segCapacity = segCapacity;
    this.triCapacity = triCapacity;
    this.segBuf = new ArrayBuffer(segCapacity * SEG_STRIDE);
    this.segF = new Float32Array(this.segBuf);
    this.segU = new Uint8Array(this.segBuf);
    this.segCount = 0;
    this.triBuf = new ArrayBuffer(triCapacity * 3 * TRI_STRIDE);
    this.triF = new Float32Array(this.triBuf);
    this.triU = new Uint8Array(this.triBuf);
    this.vertCount = 0;
    this.flags = 0;
    /** Draw-order band stored with everything emitted next. */
    this.band = 0;
    this.alphaScale = 1;
    /** True once a fill with some transparency was emitted since reset(). */
    this.translucent = false;
    /**
     * Segments longer than longLen are cut down to the part inside `box`
     * ([minX, minY, maxX, maxY] around the view). The GPU works in single
     * floats relative to the camera, so an end millions of pixels away is
     * placed only roughly: the line wobbles in the view, and vanishes once
     * its width is lost in the rounding. `clipped` is set when a build cut
     * anything, and its buffers are then good only for views inside the box.
     */
    this.longLen = Infinity;
    this.box = null;
    this.clipped = false;
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
  }

  reset() {
    this.segCount = 0;
    this.vertCount = 0;
    this.translucent = false;
    this.clipped = false;
    this.minX = this.minY = Infinity;
    this.maxX = this.maxY = -Infinity;
  }

  /**
   * Empty the batch and give back buffers that a large build (such as
   * highlighting a select-all) grew far beyond the starting size, once no
   * build has needed them for a while: regrowing them for every repeat of
   * that build would cost more than it saves.
   */
  shrink(now = Date.now()) {
    const segBig = this.segBuf.byteLength > 4 * this.segCapacity * SEG_STRIDE,
      triBig = this.triBuf.byteLength > 4 * this.triCapacity * 3 * TRI_STRIDE;
    if (
      (segBig && this.segCount * SEG_STRIDE * 4 > this.segBuf.byteLength) ||
      (triBig && this.vertCount * TRI_STRIDE * 4 > this.triBuf.byteLength)
    ) {
      this._grownUsedAt = now;
    }
    this.reset();
    if (now - (this._grownUsedAt ?? -Infinity) < KEEP_GROWN_MS) return;
    if (segBig) {
      this.segBuf = new ArrayBuffer(this.segCapacity * SEG_STRIDE);
      this.segF = new Float32Array(this.segBuf);
      this.segU = new Uint8Array(this.segBuf);
    }
    if (triBig) {
      this.triBuf = new ArrayBuffer(this.triCapacity * 3 * TRI_STRIDE);
      this.triF = new Float32Array(this.triBuf);
      this.triU = new Uint8Array(this.triBuf);
    }
  }

  _growSeg(n) {
    const need = (this.segCount + n) * SEG_STRIDE;
    if (need <= this.segBuf.byteLength) return;
    let cap = this.segBuf.byteLength * 2;
    while (cap < need) cap *= 2;
    const buf = new ArrayBuffer(cap);
    new Uint8Array(buf).set(this.segU.subarray(0, this.segCount * SEG_STRIDE));
    this.segBuf = buf;
    this.segF = new Float32Array(buf);
    this.segU = new Uint8Array(buf);
  }

  _growTri(n) {
    const need = (this.vertCount + n) * TRI_STRIDE;
    if (need <= this.triBuf.byteLength) return;
    let cap = this.triBuf.byteLength * 2;
    while (cap < need) cap *= 2;
    const buf = new ArrayBuffer(cap);
    new Uint8Array(buf).set(this.triU.subarray(0, this.vertCount * TRI_STRIDE));
    this.triBuf = buf;
    this.triF = new Float32Array(buf);
    this.triU = new Uint8Array(buf);
  }

  _bound(x, y) {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }

  /** display-list sink: polyline */
  line(pts, closed, style) {
    const n = pts.length >> 1;
    if (n < 1) return;
    const segs = n === 1 ? 1 : closed ? n : n - 1;
    this._growSeg(segs);
    const F = this.segF,
      U = this.segU;
    const rgb = style.rgb;
    const a = Math.round(255 * (style.alpha ?? 1) * this.alphaScale);
    const lw = style.lwIndex ?? 0;
    const base = style.basePattern;
    const row = base && base.length ? this.patternRow(base) : 0;
    const patScale = style.ltscale ?? 1;
    // Dash phase only matters modulo one pattern period; keeping it small keeps it precise.
    let period = 0;
    if (row) for (const v of base) period += Math.abs(v);
    period *= patScale;
    const flags = this.flags;
    const band = this.band;
    const longLen = this.longLen;
    let dist = 0;
    let count = 0;
    let o = this.segCount * SEG_FLOATS;
    // Length and unit direction of the current segment, each computed once.
    let len = 0,
      ux = 0,
      uy = 0;
    if (n > 1) {
      const dx = pts[2] - pts[0],
        dy = pts[3] - pts[1];
      len = Math.sqrt(dx * dx + dy * dy);
      if (len) {
        ux = dx / len;
        uy = dy / len;
      }
    }
    // Joint into the first segment: from the closing segment when closed.
    let prevJoin = 0;
    if (closed && segs > 1) {
      const lx = pts[0] - pts[(n - 1) * 2],
        ly = pts[1] - pts[(n - 1) * 2 + 1];
      const ll = Math.sqrt(lx * lx + ly * ly);
      if (ll) prevJoin = joinUnits(lx / ll, ly / ll, ux, uy);
    }
    for (let i = 0; i < segs; i++) {
      const j = n === 1 ? 0 : (i + 1) % n;
      const x1 = pts[i * 2],
        y1 = pts[i * 2 + 1],
        x2 = pts[j * 2],
        y2 = pts[j * 2 + 1];
      let endJoin = 0,
        nlen = 0,
        nux = 0,
        nuy = 0;
      if (i + 1 < segs || (closed && segs > 1)) {
        const k = (j + 1) % n;
        const ex = pts[k * 2] - x2,
          ey = pts[k * 2 + 1] - y2;
        nlen = Math.sqrt(ex * ex + ey * ey);
        if (nlen) {
          nux = ex / nlen;
          nuy = ey / nlen;
        }
        endJoin = joinUnits(ux, uy, nux, nuy);
      }
      // The part to draw: all of it, unless it is long enough to need cutting.
      let ax = x1,
        ay = y1,
        bx = x2,
        by = y2,
        d0 = dist,
        j0 = prevJoin,
        j1 = endJoin,
        draw = true;
      if (len > longLen) {
        this.clipped = true;
        draw = clipSeg(x1, y1, x2, y2, this.box);
        if (draw && clip0 > 0) {
          ax = x1 + clip0 * (x2 - x1);
          ay = y1 + clip0 * (y2 - y1);
          d0 += clip0 * len;
          j0 = 0;
        }
        if (draw && clip1 < 1) {
          bx = x1 + clip1 * (x2 - x1);
          by = y1 + clip1 * (y2 - y1);
          j1 = 0;
        }
      }
      if (draw) {
        const x1h = fround(ax),
          y1h = fround(ay),
          x2h = fround(bx),
          y2h = fround(by);
        F[o] = x1h;
        F[o + 1] = y1h;
        F[o + 2] = x2h;
        F[o + 3] = y2h;
        F[o + 4] = ax - x1h;
        F[o + 5] = ay - y1h;
        F[o + 6] = bx - x2h;
        F[o + 7] = by - y2h;
        F[o + 8] = period > 0 ? d0 % period : d0;
        F[o + 9] = patScale;
        const b = (o + 10) * 4;
        U[b] = rgb[0];
        U[b + 1] = rgb[1];
        U[b + 2] = rgb[2];
        U[b + 3] = a;
        U[b + 4] = lw | (flags << 5);
        U[b + 5] = row;
        U[b + 6] = j0;
        U[b + 7] = j1;
        F[o + 12] = band;
        o += SEG_FLOATS;
        count++;
      }
      prevJoin = endJoin;
      dist += len;
      len = nlen;
      ux = nux;
      uy = nuy;
      this._bound(x1, y1);
      this._bound(x2, y2);
    }
    this.segCount += count;
  }

  /** Fast path for many independent segments, flat [x1, y1, x2, y2, ...]. */
  segs(s, style) {
    const count = s.length >> 2;
    if (!count) return;
    this._growSeg(count);
    const F = this.segF,
      U = this.segU;
    const rgb = style.rgb;
    const a = Math.round(255 * (style.alpha ?? 1) * this.alphaScale);
    const lw = style.lwIndex ?? 0;
    const flags = this.flags;
    const band = this.band;
    const longLen = this.longLen;
    let o = this.segCount * SEG_FLOATS;
    let skipped = 0;
    for (let i = 0; i < s.length; i += 4) {
      let x1 = s[i],
        y1 = s[i + 1],
        x2 = s[i + 2],
        y2 = s[i + 3];
      this._bound(x1, y1);
      this._bound(x2, y2);
      // Long segments are cut to the box, as in line().
      if (Math.abs(x2 - x1) + Math.abs(y2 - y1) > longLen) {
        this.clipped = true;
        if (!clipSeg(x1, y1, x2, y2, this.box)) {
          skipped++;
          continue;
        }
        const dx = x2 - x1,
          dy = y2 - y1;
        x2 = x1 + clip1 * dx;
        y2 = y1 + clip1 * dy;
        x1 += clip0 * dx;
        y1 += clip0 * dy;
      }
      const x1h = fround(x1),
        y1h = fround(y1),
        x2h = fround(x2),
        y2h = fround(y2);
      F[o] = x1h;
      F[o + 1] = y1h;
      F[o + 2] = x2h;
      F[o + 3] = y2h;
      F[o + 4] = x1 - x1h;
      F[o + 5] = y1 - y1h;
      F[o + 6] = x2 - x2h;
      F[o + 7] = y2 - y2h;
      F[o + 8] = 0;
      F[o + 9] = 1;
      const b = (o + 10) * 4;
      U[b] = rgb[0];
      U[b + 1] = rgb[1];
      U[b + 2] = rgb[2];
      U[b + 3] = a;
      U[b + 4] = lw | (flags << 5);
      U[b + 5] = 0;
      U[b + 6] = 0;
      U[b + 7] = 0;
      F[o + 12] = band;
      o += SEG_FLOATS;
    }
    this.segCount += count - skipped;
  }

  /** display-list sink: filled polygon with holes */
  fill(rings, style) {
    if (!rings.length || rings[0].length < 6) return;
    let total = 0;
    for (const r of rings) total += r.length;
    const flat = new Float64Array(total);
    const holes = [];
    let k = 0;
    for (let i = 0; i < rings.length; i++) {
      if (i > 0) holes.push(k >> 1);
      flat.set(rings[i], k);
      k += rings[i].length;
    }
    const idx = earcut(flat, holes.length ? holes : null, 2);
    if (!idx.length) return;
    this._growTri(idx.length);
    const F = this.triF,
      U = this.triU;
    const rgb = style.rgb;
    const a = Math.round(255 * (style.alpha ?? 1) * this.alphaScale);
    if (a < 255) this.translucent = true;
    const band = this.band;
    let o = this.vertCount * TRI_FLOATS;
    for (let i = 0; i < idx.length; i++) {
      const x = flat[idx[i] * 2],
        y = flat[idx[i] * 2 + 1];
      const xh = fround(x),
        yh = fround(y);
      F[o] = xh;
      F[o + 1] = yh;
      F[o + 2] = x - xh;
      F[o + 3] = y - yh;
      const b = (o + 4) * 4;
      U[b] = rgb[0];
      U[b + 1] = rgb[1];
      U[b + 2] = rgb[2];
      U[b + 3] = a;
      F[o + 5] = band;
      this._bound(x, y);
      o += TRI_FLOATS;
    }
    this.vertCount += idx.length;
  }

  get bounds() {
    return this.minX === Infinity ? null : [this.minX, this.minY, this.maxX, this.maxY];
  }
}
