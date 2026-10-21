/**
 * 2D renderer for plan graphics (and the 2D annotations of elevations,
 * sections and sheets). Primitives are grouped per element into chunks of
 * GPU buffers; an edit re-uploads only the chunks it touches. Draw order is
 * by layer (floors under furniture under walls under annotations), so
 * blending and masks work without a depth buffer.
 *
 * Lines are instanced quads with pixel widths per weight class, antialiased
 * and dashed in the fragment shader (dash lengths in paper millimetres).
 * Fills carry an optional hatch pattern drawn in model space.
 */
import earcut from 'earcut';
import { createProgram, STATE_GLSL, Grow } from './gl.js';

const CHUNK = 384;
const LAYERS = 26;

/** Draw layer per element kind. Fills use 2z, lines 2z + 1. */
export const KIND_Z = {
  topo: 0,
  image: 0,
  floor: 0,
  ceiling: 0,
  footing: 1,
  wallFooting: 1,
  mass: 1,
  roof: 1,
  brace: 5,
  duct: 9,
  pipe: 9,
  cableTray: 9,
  conduit: 9,
  propertyLine: 8,
  room: 2,
  area: 2,
  component: 3,
  stair: 4,
  ramp: 4,
  railing: 4,
  beam: 5,
  wall: 6,
  column: 6,
  door: 7,
  window: 7,
  grid: 8,
  refPlane: 8,
  roomSeparator: 8,
  areaBoundary: 8,
  modelLine: 8,
  level: 8,
  section: 9,
  elevation: 9,
  plan: 9,
  region: 10,
  detailLine: 10,
  detailArc: 10,
  detailItem: 10,
  insulation: 10,
  revisionCloud: 11,
  dimension: 11,
  angularDim: 11,
  radialDim: 11,
  spot: 11,
  tag: 11,
  text: 11,
  symbol: 11,
  colorLegend: 11,
  overlay: 12,
};

const FILL_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aCol;
layout(location=2) in uint aPat;
layout(location=3) in uint aElem;
uniform mat3 uMat;
uniform vec2 uOrigin;
${STATE_GLSL}
out vec4 vCol;
out vec2 vP;
flat out uint vPat;
flat out uint vFlags;
void main() {
  vFlags = stateOf(aElem);
  vCol = aCol;
  vPat = aPat;
  vP = aPos + uOrigin;
  vec3 c = uMat * vec3(aPos, 1.0);
  gl_Position = vec4(c.xy, 0.0, 1.0);
  if ((vFlags & 4u) != 0u) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FILL_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec4 vCol;
in vec2 vP;
flat in uint vPat;
flat in uint vFlags;
uniform vec3 uInk;
uniform vec3 uBg;
uniform vec3 uSel;
uniform vec3 uHover;
uniform float uSpacing;
out vec4 o;
float hatch(float c, float s) {
  float d = abs(fract(c / s + 0.5) - 0.5) * s;
  float w = max(fwidth(c), 1e-6);
  return 1.0 - smoothstep(0.35 * w, 1.1 * w, d);
}
float dots(vec2 p, float s, float r) {
  vec2 g = fract(p / s) - 0.5;
  float d = length(g) * s;
  float w = max(fwidth(p.x), 1e-6);
  return 1.0 - smoothstep(r - w, r + w, d);
}
void main() {
  uint mode = (vPat >> 4u) & 15u;
  uint pat = vPat & 15u;
  vec4 c = vCol;
  if (mode == 1u) c.rgb = uInk;
  else if (mode == 2u) c.rgb = uBg;
  float s = uSpacing;
  float h = 0.0;
  if (pat == 1u) h = hatch(vP.x + vP.y, s * 1.4142);
  else if (pat == 2u) h = max(hatch(vP.x + vP.y, s * 1.4142), hatch(vP.x - vP.y, s * 1.4142));
  else if (pat == 3u) h = max(dots(vP, s * 0.9, s * 0.07), dots(vP + vec2(s * 0.37, s * 0.21), s * 1.3, s * 0.05)) * 0.9;
  else if (pat == 4u) { float z = abs(fract(vP.x / s) - 0.5) * s; h = hatch(vP.y + z * 1.6, s); }
  else if (pat == 5u) h = max(hatch(vP.x + vP.y, s * 0.7), hatch(vP.y, s * 2.4) * 0.6);
  else if (pat == 6u) h = hatch(vP.y + sin(vP.x / s * 1.7) * s * 0.18, s * 0.8);
  else if (pat == 7u) h = max(hatch(vP.x - vP.y, s * 2.0), hatch(vP.y, s * 0.9) * step(0.55, fract(vP.x / (s * 2.2))));
  else if (pat == 8u) { c = vec4(uInk, 0.78); }
  if (h > 0.0) {
    float a = h * 0.75;
    float outA = a + c.a * (1.0 - a);
    c.rgb = (uInk * a + c.rgb * c.a * (1.0 - a)) / max(outA, 1e-4);
    c.a = outA;
  }
  if ((vFlags & 8u) != 0u) { c.rgb = mix(c.rgb, uBg, 0.55); }
  if ((vFlags & 16u) != 0u) { c.rgb = mix(c.rgb, uBg, 0.75); }
  if ((vFlags & 1u) != 0u) { c.rgb = mix(c.rgb, uSel, 0.6); c.a = max(c.a, 0.22); }
  else if ((vFlags & 2u) != 0u) { c.rgb = mix(c.rgb, uHover, 0.45); c.a = max(c.a, 0.12); }
  if (c.a <= 0.002) discard;
  o = c;
}`;

const LINE_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aAB;
layout(location=2) in vec4 aCol;
layout(location=3) in uint aPack;
layout(location=4) in uint aElem;
uniform mat3 uMat;
uniform vec2 uRes;
uniform float uWeights[8];
uniform float uDpr;
uniform float uThin;
${STATE_GLSL}
out vec4 vCol;
out float vAcross;
out float vAlong;
flat out float vHalf;
flat out uint vDash;
flat out uint vFlags;
flat out uint vMode;
flat out float vPxPerUnit;
void main() {
  vFlags = stateOf(aElem);
  vec3 a = uMat * vec3(aAB.xy, 1.0);
  vec3 b = uMat * vec3(aAB.zw, 1.0);
  vec2 pa = (a.xy * 0.5 + 0.5) * uRes;
  vec2 pb = (b.xy * 0.5 + 0.5) * uRes;
  vec2 d = pb - pa;
  float L = length(d);
  vec2 dir = L > 1e-6 ? d / L : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  uint w = aPack & 255u;
  vDash = (aPack >> 8u) & 255u;
  vMode = (aPack >> 16u) & 255u;
  float width = (uThin > 0.5 ? 1.0 : uWeights[min(w, 7u)]) * uDpr;
  if ((vFlags & 3u) != 0u) width = max(width, 1.6 * uDpr);
  float h = width * 0.5 + 1.0;
  float ext = (aCorner.x * 2.0 - 1.0) * h * (vDash == 0u ? 1.0 : 0.0);
  vec2 p = mix(pa, pb, aCorner.x) + dir * ext + n * aCorner.y * h;
  float modelLen = length(aAB.zw - aAB.xy);
  vPxPerUnit = modelLen > 1e-9 ? L / modelLen : 1.0;
  vAlong = aCorner.x * modelLen + ext / max(vPxPerUnit, 1e-9);
  vAcross = aCorner.y * h;
  vHalf = width * 0.5;
  vCol = aCol;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
  if ((vFlags & 4u) != 0u) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec4 vCol;
in float vAcross;
in float vAlong;
flat in float vHalf;
flat in uint vDash;
flat in uint vFlags;
flat in uint vMode;
flat in float vPxPerUnit;
uniform vec3 uInk;
uniform vec3 uBg;
uniform vec3 uSel;
uniform vec3 uHover;
uniform float uDashScale;
out vec4 o;
float onOff(float t, vec4 seg) {
  float period = seg.x + seg.y + seg.z + seg.w;
  float m = mod(t, period);
  if (m < seg.x) return 1.0;
  if (m < seg.x + seg.y) return 0.0;
  if (m < seg.x + seg.y + seg.z) return 1.0;
  return 0.0;
}
void main() {
  float a = clamp(vHalf + 0.5 - abs(vAcross), 0.0, 1.0);
  if (vDash != 0u) {
    vec4 seg = vDash == 1u ? vec4(3.0, 1.5, 0.0, 0.0) : vDash == 2u ? vec4(1.6, 1.0, 0.0, 0.0) : vDash == 3u ? vec4(8.0, 1.6, 1.6, 1.6) : vec4(0.4, 1.2, 0.0, 0.0);
    float period = seg.x + seg.y + seg.z + seg.w;
    float periodPx = period * uDashScale * vPxPerUnit;
    if (periodPx > 5.0) a *= onOff(vAlong / uDashScale, seg);
    else a *= 0.6;
  }
  vec4 c = vCol;
  if (vMode == 1u) c.rgb = uInk;
  else if (vMode == 2u) c.rgb = uBg;
  if ((vFlags & 8u) != 0u) c.rgb = mix(c.rgb, uBg, 0.55);
  if ((vFlags & 16u) != 0u) c.rgb = mix(c.rgb, uBg, 0.75);
  if ((vFlags & 1u) != 0u) c.rgb = uSel;
  else if ((vFlags & 2u) != 0u) c.rgb = uHover;
  c.a *= a;
  if (c.a <= 0.003) discard;
  o = c;
}`;

/** Pack a PlanBuilder colour into RGBA8 + colour mode. */
function colorOf(c) {
  if (!c) return [0, 0, 0, 255, 1];
  if (c[0] === -1) return [0, 0, 0, c[3], 1];
  if (c[0] === -2) return [0, 0, 0, c[3], 2];
  return [c[0], c[1], c[2], c[3] ?? 255, 0];
}

const u32 = (r, g, b, a) => ((r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24)) >>> 0;

/** Triangulate a builder's fills once and keep the result on it. */
function trianglesOf(g) {
  if (g._tris) return g._tris;
  const out = [];
  for (const f of g.fills) {
    const flat = [];
    const holes = [];
    for (const p of f.poly) flat.push(p[0], p[1]);
    for (const h of f.holes || []) {
      holes.push(flat.length / 2);
      for (const p of h) flat.push(p[0], p[1]);
    }
    const idx = earcut(flat, holes.length ? holes : undefined, 2);
    out.push({ flat, idx, f });
  }
  g._tris = out;
  return out;
}

class Chunk {
  constructor() {
    this.ids = new Set();
    this.dirty = true;
    this.fillVbo = null;
    this.lineVbo = null;
    this.fillVao = null;
    this.lineVao = null;
    this.fillRanges = new Int32Array(LAYERS * 2);
    this.lineRanges = new Int32Array(LAYERS * 2);
  }
}

/**
 * A set of element graphics drawn together (one view). Items: id -> { idx, z, g }.
 */
export class Layer2D {
  constructor(r) {
    this.r = r;
    this.items = new Map();
    this.chunks = [];
    this.chunkOf = new Map();
    this.origin = [0, 0];
    this.textsDirty = true;
    this._texts = [];
  }

  set(id, idx, kind, g) {
    const prev = this.items.get(id);
    if (prev && prev.g === g && prev.idx === idx) return;
    if (!g) return this.remove(id);
    this.items.set(id, { idx, z: KIND_Z[kind] ?? 6, g, kind });
    let ci = this.chunkOf.get(id);
    if (ci === undefined) {
      ci = this.chunks.findIndex((c) => c.ids.size < CHUNK);
      if (ci < 0) {
        this.chunks.push(new Chunk());
        ci = this.chunks.length - 1;
      }
      this.chunks[ci].ids.add(id);
      this.chunkOf.set(id, ci);
    }
    this.chunks[ci].dirty = true;
    this.textsDirty = true;
  }

  remove(id) {
    if (!this.items.has(id)) return;
    this.items.delete(id);
    const ci = this.chunkOf.get(id);
    if (ci !== undefined) {
      this.chunks[ci].ids.delete(id);
      this.chunks[ci].dirty = true;
    }
    this.chunkOf.delete(id);
    this.textsDirty = true;
  }

  /** Keep only these ids. */
  retain(ids) {
    for (const id of [...this.items.keys()]) if (!ids.has(id)) this.remove(id);
  }

  clear() {
    for (const c of this.chunks) this.r.freeChunk(c);
    this.items.clear();
    this.chunks = [];
    this.chunkOf.clear();
    this.textsDirty = true;
  }

  sync() {
    for (const c of this.chunks) if (c.dirty) this.r.buildChunk(this, c);
  }

  /** All text items with their element id (cached until graphics change). */
  texts() {
    if (!this.textsDirty) return this._texts;
    const out = [];
    for (const [id, it] of this.items) for (const t of it.g.texts) out.push({ ...t, id, z: it.z });
    out.sort((a, b) => a.z - b.z);
    this._texts = out;
    this.textsDirty = false;
    return out;
  }

  dispose() {
    this.clear();
  }
}

export class Renderer2D {
  constructor(gl, state) {
    this.gl = gl;
    this.state = state;
    this.fill = createProgram(gl, FILL_VS, FILL_FS, 'fill2d');
    this.line = createProgram(gl, LINE_VS, LINE_FS, 'line2d');
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]), gl.STATIC_DRAW);
    this.weights = new Float32Array([1, 1, 1.4, 2, 2.8, 3.8, 5, 6.5]);
  }

  layer() {
    return new Layer2D(this);
  }

  freeChunk(c) {
    const gl = this.gl;
    if (c.fillVbo) gl.deleteBuffer(c.fillVbo);
    if (c.lineVbo) gl.deleteBuffer(c.lineVbo);
    if (c.fillVao) gl.deleteVertexArray(c.fillVao);
    if (c.lineVao) gl.deleteVertexArray(c.lineVao);
    c.fillVbo = c.lineVbo = c.fillVao = c.lineVao = null;
  }

  buildChunk(layer, c) {
    const gl = this.gl;
    const [ox, oy] = layer.origin;
    const items = [...c.ids].map((id) => layer.items.get(id)).filter(Boolean);
    items.sort((a, b) => a.z - b.z);
    // Fills: 5 words per vertex (x, y, rgba, pattern|mode, elem).
    const fb = new Grow(Float32Array, 4096);
    const fu = [];
    const lb = new Grow(Float32Array, 4096);
    c.fillRanges.fill(0);
    c.lineRanges.fill(0);
    let fv = 0;
    let lv = 0;
    let zi = 0;
    const fillStart = new Int32Array(LAYERS).fill(-1);
    const lineStart = new Int32Array(LAYERS).fill(-1);
    const fillEnd = new Int32Array(LAYERS);
    const lineEnd = new Int32Array(LAYERS);
    const f32 = new Float32Array(1);
    const asU = new Uint32Array(f32.buffer);
    const bits = (u) => {
      asU[0] = u;
      return f32[0];
    };
    for (const it of items) {
      const zf = it.z * 2;
      const zl = it.z * 2 + 1;
      zi = zf;
      if (fillStart[zf] < 0) fillStart[zf] = fv;
      for (const { flat, idx, f } of trianglesOf(it.g)) {
        const [r, g, b, a, mode] = colorOf(f.color);
        const col = bits(u32(r, g, b, a));
        const pat = bits(((f.pattern || 0) & 15) | (mode << 4));
        const el = bits(it.idx);
        fb.reserve(idx.length * 5);
        for (const k of idx) {
          fb.a[fb.n++] = flat[k * 2] - ox;
          fb.a[fb.n++] = flat[k * 2 + 1] - oy;
          fb.a[fb.n++] = col;
          fb.a[fb.n++] = pat;
          fb.a[fb.n++] = el;
        }
        fv += idx.length;
      }
      fillEnd[zf] = fv;
      if (lineStart[zl] < 0) lineStart[zl] = lv;
      const el = bits(it.idx);
      lb.reserve(it.g.lines.length * 7);
      for (const l of it.g.lines) {
        const [r, g, b, a, mode] = colorOf(l.c);
        lb.a[lb.n++] = l.a[0] - ox;
        lb.a[lb.n++] = l.a[1] - oy;
        lb.a[lb.n++] = l.b[0] - ox;
        lb.a[lb.n++] = l.b[1] - oy;
        lb.a[lb.n++] = bits(u32(r, g, b, a));
        lb.a[lb.n++] = bits(((l.w || 1) & 255) | ((l.d || 0) << 8) | (mode << 16));
        lb.a[lb.n++] = el;
      }
      lv += it.g.lines.length;
      lineEnd[zl] = lv;
    }
    void zi;
    void fu;
    for (let z = 0; z < LAYERS; z++) {
      if (fillStart[z] >= 0) {
        c.fillRanges[z * 2] = fillStart[z];
        c.fillRanges[z * 2 + 1] = fillEnd[z] - fillStart[z];
      }
      if (lineStart[z] >= 0) {
        c.lineRanges[z * 2] = lineStart[z];
        c.lineRanges[z * 2 + 1] = lineEnd[z] - lineStart[z];
      }
    }
    if (!c.fillVbo) {
      c.fillVbo = gl.createBuffer();
      c.lineVbo = gl.createBuffer();
      c.fillVao = gl.createVertexArray();
      c.lineVao = gl.createVertexArray();
      gl.bindVertexArray(c.fillVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, c.fillVbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 20, 8);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 20, 12);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 20, 16);
      gl.bindVertexArray(c.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, c.lineVbo);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 28, 16);
      gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 28, 20);
      gl.vertexAttribDivisor(3, 1);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 28, 24);
      gl.vertexAttribDivisor(4, 1);
      gl.bindVertexArray(null);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, c.fillVbo);
    gl.bufferData(gl.ARRAY_BUFFER, fb.view(), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, lb.view(), gl.DYNAMIC_DRAW);
    c.dirty = false;
  }

  /**
   * Draw layers. cam: { matrix (Float32Array(9), relative to layer origin),
   * width, height (device px), dpr }. theme: { ink, bg, sel, hover } as
   * [r, g, b] 0..1. opts: { dashScale, spacing, thin }.
   */
  draw(layer, cam, theme, opts = {}) {
    const gl = this.gl;
    layer.sync();
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this.state.bind(0);
    const setCommon = (p) => {
      gl.useProgram(p.program);
      gl.uniformMatrix3fv(p.u.uMat, false, cam.matrix);
      gl.uniform1i(p.u.uState, 0);
      gl.uniform1i(p.u.uStateW, this.state.width);
      gl.uniform3fv(p.u.uInk, theme.ink);
      gl.uniform3fv(p.u.uBg, theme.bg);
      gl.uniform3fv(p.u.uSel, theme.sel);
      gl.uniform3fv(p.u.uHover, theme.hover);
    };
    const fillP = this.fill;
    const lineP = this.line;
    for (let z = 0; z < LAYERS; z++) {
      const isFill = z % 2 === 0;
      const p = isFill ? fillP : lineP;
      let ready = false;
      for (const c of layer.chunks) {
        const ranges = isFill ? c.fillRanges : c.lineRanges;
        const count = ranges[z * 2 + 1];
        if (!count) continue;
        if (!ready) {
          setCommon(p);
          if (isFill) {
            gl.uniform2f(p.u.uOrigin, layer.origin[0], layer.origin[1]);
            gl.uniform1f(p.u.uSpacing, opts.spacing || 100);
          } else {
            gl.uniform2f(p.u.uRes, cam.width, cam.height);
            gl.uniform1fv(p.u.uWeights, this.weights);
            gl.uniform1f(p.u.uDpr, cam.dpr || 1);
            gl.uniform1f(p.u.uThin, opts.thin ? 1 : 0);
            gl.uniform1f(p.u.uDashScale, opts.dashScale || 100);
          }
          ready = true;
        }
        if (isFill) {
          gl.bindVertexArray(c.fillVao);
          gl.drawArrays(gl.TRIANGLES, ranges[z * 2], count);
        } else {
          gl.bindVertexArray(c.lineVao);
          gl.drawArraysInstancedBaseInstance ? gl.drawArraysInstancedBaseInstance(gl.TRIANGLES, 0, 6, count, ranges[z * 2]) : this.drawLinesOffset(c, ranges[z * 2], count);
        }
      }
    }
    gl.bindVertexArray(null);
  }

  /** Instanced draw starting at an instance offset (rebinds attribute pointers). */
  drawLinesOffset(c, first, count) {
    const gl = this.gl;
    if (first) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.lineVbo);
      const off = first * 28;
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, off);
      gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 28, off + 16);
      gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 28, off + 20);
      gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 28, off + 24);
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    if (first) {
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 0);
      gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 28, 16);
      gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 28, 20);
      gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 28, 24);
    }
  }
}

/** Model-to-clip matrix (column-major mat3) for a 2D camera. */
export function viewMatrix2D(cx, cy, zoom, width, height, origin = [0, 0], rotation = 0) {
  const sx = (zoom * 2) / width;
  const sy = (zoom * 2) / height;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const tx = origin[0] - cx;
  const ty = origin[1] - cy;
  // clip = S * R * (p + origin - center)
  return new Float32Array([sx * c, sy * s, 0, -sx * s, sy * c, 0, sx * (c * tx - s * ty), sy * (s * tx + c * ty), 1]);
}
