/**
 * Triangle mesh builder for element geometry. Faces are flat shaded
 * (vertices are not shared between faces), each vertex carries an RGBA
 * colour, and feature edges are collected explicitly as line segments.
 *
 * Output: { pos: Float32Array (xyz), nrm: Int8Array (xyz, -127..127),
 *           col: Uint8Array (rgba), edges: Float32Array (xyz pairs), bounds }
 */
import earcut from 'earcut';

export function hexToRgba(hex, opacity = 1) {
  let h = String(hex || '#c8c8c8').replace('#', '');
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(Math.max(0, Math.min(1, opacity)) * 255)];
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize3(a) {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.edges = [];
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
  }

  get empty() {
    return this.pos.length === 0 && this.edges.length === 0;
  }

  _v(p, n, c) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(Math.round(n[0] * 127), Math.round(n[1] * 127), Math.round(n[2] * 127));
    this.col.push(c[0], c[1], c[2], c[3]);
    for (let i = 0; i < 3; i++) {
      if (p[i] < this.min[i]) this.min[i] = p[i];
      if (p[i] > this.max[i]) this.max[i] = p[i];
    }
  }

  tri(a, b, c, color, n) {
    const nn = n || normalize3(cross3(sub3(b, a), sub3(c, a)));
    this._v(a, nn, color);
    this._v(b, nn, color);
    this._v(c, nn, color);
  }

  /** Planar quad a-b-c-d (counterclockwise seen from the front). */
  quad(a, b, c, d, color) {
    const n = normalize3(cross3(sub3(b, a), sub3(d, a)));
    this.tri(a, b, c, color, n);
    this.tri(a, c, d, color, n);
  }

  edge(a, b) {
    this.edges.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }

  edgeLoop(points) {
    for (let i = 0; i < points.length; i++) this.edge(points[i], points[(i + 1) % points.length]);
  }

  /**
   * A planar face given in a local frame: 3D point = origin + u*U + v*V.
   * outer/holes are [u, v] loops. The face normal is U x V.
   */
  planar(origin, U, V, outer, holes, color, { edges = false } = {}) {
    const flat = [];
    const idx = [];
    const pts = [];
    const push = (p) => {
      flat.push(p[0], p[1]);
      pts.push([origin[0] + U[0] * p[0] + V[0] * p[1], origin[1] + U[1] * p[0] + V[1] * p[1], origin[2] + U[2] * p[0] + V[2] * p[1]]);
    };
    for (const p of outer) push(p);
    for (const h of holes || []) {
      idx.push(pts.length);
      for (const p of h) push(p);
    }
    const tris = earcut(flat, idx.length ? idx : undefined, 2);
    // earcut keeps the winding of the input; make the triangles face U x V.
    const n = normalize3(cross3(U, V));
    for (let i = 0; i < tris.length; i += 3) {
      const a = pts[tris[i]];
      const b = pts[tris[i + 1]];
      const c = pts[tris[i + 2]];
      const fn = cross3(sub3(b, a), sub3(c, a));
      if (fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2] >= 0) this.tri(a, b, c, color, n);
      else this.tri(a, c, b, color, n);
    }
    if (edges) {
      const lift = (loop) => loop.map((p) => [origin[0] + U[0] * p[0] + V[0] * p[1], origin[1] + U[1] * p[0] + V[1] * p[1], origin[2] + U[2] * p[0] + V[2] * p[1]]);
      this.edgeLoop(lift(outer));
      for (const h of holes || []) this.edgeLoop(lift(h));
    }
  }

  /** Horizontal polygon at height z (plan points), facing up or down. */
  horizontal(outer, holes, z, up, color, opts) {
    if (up) this.planar([0, 0, z], [1, 0, 0], [0, 1, 0], outer, holes, color, opts);
    else this.planar([0, 0, z], [1, 0, 0], [0, -1, 0], outer.map((p) => [p[0], -p[1]]), (holes || []).map((h) => h.map((p) => [p[0], -p[1]])), color, opts);
  }

  /**
   * Vertical prism from z0 to z1 over a plan polygon with holes. Feature
   * edges: top and bottom outlines, and vertical edges at corners that turn
   * by more than `edgeAngle` radians.
   */
  prism(outer, holes, z0, z1, color, { top = color, bottom = color, sides = color, edges = true, edgeAngle = 0.15 } = {}) {
    if (z1 - z0 < 1e-6) return;
    const ccw = signed(outer) > 0 ? outer : outer.slice().reverse();
    const hs = (holes || []).map((h) => (signed(h) < 0 ? h : h.slice().reverse()));
    this.horizontal(ccw, hs, z1, true, top);
    this.horizontal(ccw, hs, z0, false, bottom);
    for (const loop of [ccw, ...hs]) {
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % n];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;
        this.quad([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1], sides);
      }
      if (edges) {
        for (let i = 0; i < n; i++) {
          const a = loop[i];
          const b = loop[(i + 1) % n];
          this.edge([a[0], a[1], z0], [b[0], b[1], z0]);
          this.edge([a[0], a[1], z1], [b[0], b[1], z1]);
          const p = loop[(i - 1 + n) % n];
          if (turn(p, a, b) > edgeAngle) this.edge([a[0], a[1], z0], [a[0], a[1], z1]);
        }
      }
    }
  }

  /** Axis-aligned box in a local frame placed at `origin` rotated by `rot` about z. */
  box(x0, y0, z0, x1, y1, z1, color, frame, { edges = true } = {}) {
    const loop = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    if (!frame) return this.prism(loop, [], z0, z1, color, { edges });
    this.prism(loop.map((p) => frame.apply(p)), [], z0 + frame.z, z1 + frame.z, color, { edges });
  }

  /** Vertical cylinder (or cone when r1 differs) at plan center c. */
  cylinder(c, r0, z0, z1, color, { r1 = r0, segments = 24, edges = true, caps = true } = {}) {
    const ring = (r, z) => {
      const out = [];
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, z]);
      }
      return out;
    };
    const lo = ring(r0, z0);
    const hi = ring(r1, z1);
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      const a = lo[i];
      const b = lo[j];
      const cc = hi[j];
      const d = hi[i];
      // Smooth normals around the side.
      const na = normalize3([a[0] - c[0], a[1] - c[1], (r0 - r1) / Math.max(1e-6, z1 - z0) * Math.max(r0, r1)]);
      const nb = normalize3([b[0] - c[0], b[1] - c[1], (r0 - r1) / Math.max(1e-6, z1 - z0) * Math.max(r0, r1)]);
      this._v(a, na, color);
      this._v(b, nb, color);
      this._v(cc, nb, color);
      this._v(a, na, color);
      this._v(cc, nb, color);
      this._v(d, na, color);
    }
    if (caps) {
      if (r1 > 1e-6) for (let i = 1; i < segments - 1; i++) this.tri(hi[0], hi[i], hi[i + 1], color, [0, 0, 1]);
      if (r0 > 1e-6) for (let i = 1; i < segments - 1; i++) this.tri(lo[0], lo[i + 1], lo[i], color, [0, 0, -1]);
    }
    if (edges) {
      if (r1 > 1e-6) this.edgeLoop(hi);
      if (r0 > 1e-6) this.edgeLoop(lo);
    }
  }

  /** Sphere-like blob (for foliage). */
  sphere(c, r, color, { segments = 12, rings = 8, sz = 1 } = {}) {
    const pts = [];
    for (let j = 0; j <= rings; j++) {
      const phi = (j / rings) * Math.PI;
      const row = [];
      for (let i = 0; i <= segments; i++) {
        const th = (i / segments) * Math.PI * 2;
        row.push([Math.sin(phi) * Math.cos(th), Math.sin(phi) * Math.sin(th), Math.cos(phi)]);
      }
      pts.push(row);
    }
    const P = (n) => [c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r * sz];
    for (let j = 0; j < rings; j++)
      for (let i = 0; i < segments; i++) {
        const a = pts[j][i];
        const b = pts[j + 1][i];
        const cc = pts[j + 1][i + 1];
        const d = pts[j][i + 1];
        this._v(P(a), a, color);
        this._v(P(b), b, color);
        this._v(P(cc), cc, color);
        this._v(P(a), a, color);
        this._v(P(cc), cc, color);
        this._v(P(d), d, color);
      }
  }

  /** Extrude a 2D profile (in a vertical plane) along a horizontal direction. */
  extrudeProfile(profile, origin, along, width, color, { edges = true } = {}) {
    // profile points: [s, z] where s runs along `along`; the extrusion is
    // across the perpendicular, from 0 to width.
    const dir = along;
    const side = [-dir[1], dir[0]];
    const P = (p, w) => [origin[0] + dir[0] * p[0] + side[0] * w, origin[1] + dir[1] * p[0] + side[1] * w, p[1]];
    const n = profile.length;
    const ccw = signed(profile) > 0 ? profile : profile.slice().reverse();
    // Faces at w = 0 and w = width, in the vertical plane (U = dir, V = z).
    this.planar([origin[0], origin[1], 0], [dir[0], dir[1], 0], [0, 0, 1], ccw, [], color, {});
    this.planar([origin[0] + side[0] * width, origin[1] + side[1] * width, 0], [-dir[0], -dir[1], 0], [0, 0, 1], ccw.map((p) => [-p[0], p[1]]), [], color, {});
    for (let i = 0; i < n; i++) {
      const a = ccw[i];
      const b = ccw[(i + 1) % n];
      this.quad(P(b, 0), P(a, 0), P(a, width), P(b, width), color);
      if (edges) {
        this.edge(P(a, 0), P(b, 0));
        this.edge(P(a, width), P(b, width));
        this.edge(P(a, 0), P(a, width));
      }
    }
  }

  /** Append another builder's output. */
  merge(other) {
    for (let i = 0; i < other.pos.length; i += 3) {
      this.pos.push(other.pos[i], other.pos[i + 1], other.pos[i + 2]);
    }
    this.nrm.push(...other.nrm);
    this.col.push(...other.col);
    this.edges.push(...other.edges);
    for (let i = 0; i < 3; i++) {
      this.min[i] = Math.min(this.min[i], other.min[i]);
      this.max[i] = Math.max(this.max[i], other.max[i]);
    }
  }

  build() {
    return {
      pos: new Float32Array(this.pos),
      nrm: new Int8Array(this.nrm),
      col: new Uint8Array(this.col),
      edges: new Float32Array(this.edges),
      bounds: this.pos.length || this.edges.length ? { min: this.min.slice(), max: this.max.slice() } : null,
    };
  }
}

function signed(loop) {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function turn(p, a, b) {
  const u = [a[0] - p[0], a[1] - p[1]];
  const v = [b[0] - a[0], b[1] - a[1]];
  const lu = Math.hypot(u[0], u[1]);
  const lv = Math.hypot(v[0], v[1]);
  if (lu < 1e-9 || lv < 1e-9) return 0;
  const c = (u[0] * v[0] + u[1] * v[1]) / (lu * lv);
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/** A 2D rigid placement: translate to `at`, rotate by `rot`, raise by z. */
export class Frame {
  constructor(at, rot = 0, z = 0) {
    this.at = at;
    this.c = Math.cos(rot);
    this.s = Math.sin(rot);
    this.z = z;
    this.rot = rot;
  }

  apply(p) {
    return [this.at[0] + p[0] * this.c - p[1] * this.s, this.at[1] + p[0] * this.s + p[1] * this.c];
  }

  apply3(p) {
    const q = this.apply(p);
    return [q[0], q[1], p[2] + this.z];
  }

  dir(v) {
    return [v[0] * this.c - v[1] * this.s, v[0] * this.s + v[1] * this.c];
  }

  inverse(p) {
    const x = p[0] - this.at[0];
    const y = p[1] - this.at[1];
    return [x * this.c + y * this.s, -x * this.s + y * this.c];
  }
}
