// CPU-side primitive lists. A Batch collects instanced shapes (capsules,
// discs and rings, rounded rectangles, arcs) and triangles. The renderer
// uploads a batch when its version changes, so building a batch costs one
// pass over the objects and drawing it is a handful of instanced draw calls.
//
// Input coordinates are nanometres. They are stored as float32 micrometres,
// which keeps sub-micron precision anywhere on a two metre board.

import earcut from 'earcut';
import { layoutText, uprightText } from './font.js';
import { DEG } from '../core/geom.js';

const S = 1 / 1000;

class Buf {
  constructor(stride, initial = 256) {
    this.stride = stride;
    this.count = 0;
    this._alloc(initial);
  }
  _alloc(n) {
    const buf = new ArrayBuffer(n * this.stride * 4);
    const f = new Float32Array(buf), u = new Uint32Array(buf);
    if (this.f) f.set(this.f.subarray(0, this.count * this.stride));
    this.buffer = buf; this.f = f; this.u = u; this.capacity = n;
  }
  reserve() {
    if (this.count >= this.capacity) this._alloc(this.capacity * 2);
    return this.count++ * this.stride;
  }
  clear() { this.count = 0; }
  get byteLength() { return this.count * this.stride * 4; }
}

export const KINDS = ['tri', 'rect', 'circ', 'arc', 'seg'];

export class Batch {
  constructor() {
    this.bufs = {
      seg: new Buf(6),        // x1 y1 x2 y2 halfWidth color
      circ: new Buf(5),       // x y r inner color
      rect: new Buf(7),       // cx cy hw hh rot radius color
      arc: new Buf(7),        // cx cy r a0 sweep halfWidth color
      tri: new Buf(3, 1024),  // x y color, three per triangle
    };
    this.version = 0;
  }

  clear() {
    for (const k of KINDS) this.bufs[k].clear();
    this.version++;
  }

  /** Marks the batch for upload after a series of additions. */
  touch() { this.version++; }

  get empty() {
    const b = this.bufs;
    return !(b.seg.count || b.circ.count || b.rect.count || b.arc.count || b.tri.count);
  }

  /** Round-capped line of full width w (0 = one pixel). */
  line(x1, y1, x2, y2, w, color) {
    const b = this.bufs.seg, o = b.reserve(), f = b.f;
    f[o] = x1 * S; f[o + 1] = y1 * S; f[o + 2] = x2 * S; f[o + 3] = y2 * S; f[o + 4] = w * S * 0.5;
    b.u[o + 5] = color;
  }

  polyline(pts, w, color, closed = false) {
    const n = pts.length;
    for (let i = 2; i < n; i += 2) this.line(pts[i - 2], pts[i - 1], pts[i], pts[i + 1], w, color);
    if (closed && n >= 6) this.line(pts[n - 2], pts[n - 1], pts[0], pts[1], w, color);
  }

  /** Filled disc, or a ring when inner > 0. */
  circle(x, y, r, color, inner = 0) {
    const b = this.bufs.circ, o = b.reserve(), f = b.f;
    f[o] = x * S; f[o + 1] = y * S; f[o + 2] = r * S; f[o + 3] = inner * S;
    b.u[o + 4] = color;
  }

  /** Circle outline of stroke width w centred on radius r. */
  ring(x, y, r, w, color) {
    if (w <= 0) { this.arc(x, y, r, 0, 360, 0, color); return; }
    this.circle(x, y, r + w / 2, color, Math.max(0, r - w / 2));
  }

  /** Filled rectangle centred at (cx, cy), rotated rot degrees, corner radius in nm. */
  rect(cx, cy, w, h, rot, radius, color) {
    const b = this.bufs.rect, o = b.reserve(), f = b.f;
    f[o] = cx * S; f[o + 1] = cy * S; f[o + 2] = w * S * 0.5; f[o + 3] = h * S * 0.5;
    f[o + 4] = (rot || 0) * DEG; f[o + 5] = (radius || 0) * S;
    b.u[o + 6] = color;
  }

  rectOutline(x1, y1, x2, y2, w, color) {
    this.line(x1, y1, x2, y1, w, color); this.line(x2, y1, x2, y2, w, color);
    this.line(x2, y2, x1, y2, w, color); this.line(x1, y2, x1, y1, w, color);
  }

  /** Arc stroke: centre, radius, start angle and CCW sweep in degrees. */
  arc(cx, cy, r, a0, sweep, w, color) {
    const b = this.bufs.arc, o = b.reserve(), f = b.f;
    f[o] = cx * S; f[o + 1] = cy * S; f[o + 2] = r * S; f[o + 3] = a0 * DEG; f[o + 4] = Math.min(sweep, 360) * DEG;
    f[o + 5] = w * S * 0.5;
    b.u[o + 6] = color;
  }

  /** Filled polygon with holes: rings[0] is the outline, the rest are holes. */
  poly(rings, color) {
    if (!rings.length || rings[0].length < 6) return;
    let flat, holes = null;
    if (rings.length === 1) flat = rings[0];
    else {
      let total = 0;
      for (const r of rings) total += r.length;
      flat = new Float64Array(total);
      holes = [];
      let at = 0;
      for (let i = 0; i < rings.length; i++) {
        if (i > 0) holes.push(at / 2);
        flat.set(rings[i], at);
        at += rings[i].length;
      }
    }
    const idx = earcut(flat, holes, 2);
    const b = this.bufs.tri;
    for (let i = 0; i < idx.length; i++) {
      const o = b.reserve(), k = idx[i] * 2;
      b.f[o] = flat[k] * S; b.f[o + 1] = flat[k + 1] * S; b.u[o + 2] = color;
    }
  }

  /** Triangles already in nm, flat [x0,y0,x1,y1,x2,y2,...]. */
  triangles(pts, color) {
    const b = this.bufs.tri;
    for (let i = 0; i < pts.length; i += 2) {
      const o = b.reserve();
      b.f[o] = pts[i] * S; b.f[o + 1] = pts[i + 1] * S; b.u[o + 2] = color;
    }
  }

  /**
   * Stroke text. size is the cap height; w the stroke width (0 picks one from
   * the size). rot in degrees; text never renders upside down when upright is set.
   */
  text(str, x, y, size, color, { rot = 0, align, mirror = false, w = 0, upright = false } = {}) {
    if (!str) return;
    let r = ((rot % 360) + 360) % 360;
    let al = align;
    if (upright) ({ rot: r, align: al } = uprightText(r, align));
    const lay = layoutText(String(str), size, al);
    const sw = w || size * 0.13;
    const c = Math.cos(r * DEG), s = Math.sin(r * DEG), m = mirror ? -1 : 1;
    for (const pl of lay.strokes) {
      let px = 0, py = 0;
      for (let i = 0; i < pl.length; i += 2) {
        const lx = pl[i] * m, ly = pl[i + 1];
        const wx = x + lx * c - ly * s, wy = y + lx * s + ly * c;
        if (i > 0) this.line(px, py, wx, wy, sw, color);
        else if (pl.length === 2) this.line(wx, wy, wx, wy, sw, color);
        px = wx; py = wy;
      }
    }
  }
}
