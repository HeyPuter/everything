/**
 * 3D renderer: element meshes batched into chunks of GPU buffers, drawn
 * with a visual style (wireframe, hidden line, shaded, consistent colours,
 * realistic), screen-space feature edges, clip planes (section box, section
 * and elevation depth), transparency, and GPU picking by element index.
 */
import { createProgram, STATE_GLSL, Grow } from './gl.js';

const CHUNK = 160;
export const STYLE = { wireframe: 0, hidden: 1, shaded: 2, consistent: 3, realistic: 4 };

const MESH_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec4 aCol;
layout(location=3) in uint aElem;
uniform mat4 uVP;
uniform vec3 uOrigin;
${STATE_GLSL}
out vec3 vN;
out vec4 vCol;
out vec3 vW;
flat out uint vFlags;
flat out uint vElem;
void main() {
  vFlags = stateOf(aElem);
  vElem = aElem;
  vW = aPos + uOrigin;
  vN = aNrm;
  vCol = aCol;
  gl_Position = uVP * vec4(aPos, 1.0);
  if ((vFlags & 4u) != 0u) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const CLIP_GLSL = /* glsl */ `
uniform vec4 uClip[8];
uniform int uClipN;
bool clipped(vec3 w) {
  for (int i = 0; i < 8; i++) {
    if (i >= uClipN) break;
    if (dot(uClip[i].xyz, w) > uClip[i].w) return true;
  }
  return false;
}`;

const MESH_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec3 vN;
in vec4 vCol;
in vec3 vW;
flat in uint vFlags;
flat in uint vElem;
uniform int uStyle;
uniform vec3 uBg;
uniform vec3 uSel;
uniform vec3 uHover;
uniform vec3 uLight;
uniform vec3 uEye;
uniform float uFlat;
${CLIP_GLSL}
out vec4 o;
void main() {
  if (clipped(vW)) discard;
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 base = vCol.rgb;
  vec3 c;
  if (uStyle == 1) c = uBg;
  else if (uStyle == 3) c = base * (0.9 + 0.1 * abs(n.z));
  else {
    float d = max(dot(n, uLight), 0.0);
    float sky = 0.5 + 0.5 * n.z;
    c = base * (0.36 + 0.52 * d + 0.18 * sky);
    if (uStyle == 4) {
      vec3 v = normalize(uEye - vW);
      vec3 h = normalize(uLight + v);
      c += vec3(0.08) * pow(max(dot(n, h), 0.0), 32.0);
    }
  }
  float a = vCol.a;
  if (uStyle == 1 && a < 0.99) a = 0.25;
  if ((vFlags & 8u) != 0u) c = mix(c, uBg, 0.5);
  if ((vFlags & 16u) != 0u) { c = mix(c, uBg, 0.7); a *= 0.5; }
  if ((vFlags & 1u) != 0u) c = mix(c, uSel, 0.55);
  else if ((vFlags & 2u) != 0u) c = mix(c, uHover, 0.35);
  o = vec4(c, a);
}`;

const PICK_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec3 vN;
in vec4 vCol;
in vec3 vW;
flat in uint vFlags;
flat in uint vElem;
${CLIP_GLSL}
out uvec4 o;
void main() {
  if (clipped(vW)) discard;
  o = uvec4(vElem, 0u, 0u, 1u);
}`;

const EDGE_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aA;
layout(location=2) in vec3 aB;
layout(location=3) in uint aElem;
uniform mat4 uVP;
uniform vec3 uOrigin;
uniform vec2 uRes;
uniform float uWidth;
uniform float uBias;
${STATE_GLSL}
out float vAcross;
out vec3 vW;
flat out float vHalf;
flat out uint vFlags;
void main() {
  vFlags = stateOf(aElem);
  vec4 ca = uVP * vec4(aA, 1.0);
  vec4 cb = uVP * vec4(aB, 1.0);
  float e = 1e-3;
  if (ca.w < e && cb.w < e) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (ca.w < e) ca = mix(ca, cb, (e - ca.w) / (cb.w - ca.w));
  if (cb.w < e) cb = mix(cb, ca, (e - cb.w) / (ca.w - cb.w));
  vec2 sa = ca.xy / ca.w * 0.5 * uRes;
  vec2 sb = cb.xy / cb.w * 0.5 * uRes;
  vec2 d = sb - sa;
  float L = length(d);
  vec2 dir = L > 1e-6 ? d / L : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float w = uWidth;
  if ((vFlags & 3u) != 0u) w = max(w * 1.6, 2.0);
  float h = w * 0.5 + 0.75;
  vec4 c = mix(ca, cb, aCorner.x);
  vec2 off = (n * aCorner.y * h + dir * (aCorner.x * 2.0 - 1.0) * 0.5) / (0.5 * uRes);
  c.xy += off * c.w;
  c.z -= uBias * c.w;
  vAcross = aCorner.y * h;
  vHalf = w * 0.5;
  vW = mix(aA, aB, aCorner.x) + uOrigin;
  gl_Position = c;
  if ((vFlags & 4u) != 0u) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const EDGE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in float vAcross;
in vec3 vW;
flat in float vHalf;
flat in uint vFlags;
uniform vec3 uInk;
uniform vec3 uBg;
uniform vec3 uSel;
uniform vec3 uHover;
uniform float uAlpha;
${CLIP_GLSL}
out vec4 o;
void main() {
  if (clipped(vW)) discard;
  float a = clamp(vHalf + 0.5 - abs(vAcross), 0.0, 1.0) * uAlpha;
  vec3 c = uInk;
  if ((vFlags & 8u) != 0u) c = mix(c, uBg, 0.55);
  if ((vFlags & 16u) != 0u) { c = mix(c, uBg, 0.75); }
  if ((vFlags & 1u) != 0u) { c = uSel; a = max(a, clamp(vHalf + 0.5 - abs(vAcross), 0.0, 1.0)); }
  else if ((vFlags & 2u) != 0u) c = uHover;
  if (a <= 0.003) discard;
  o = vec4(c, a);
}`;

class MeshChunk {
  constructor() {
    this.ids = new Set();
    this.dirty = true;
    this.vbo = null;
    this.vao = null;
    this.ebo = null;
    this.evao = null;
    this.opaque = 0;
    this.transparent = 0;
    this.edges = 0;
  }
}

export class Renderer3D {
  constructor(gl, state) {
    this.gl = gl;
    this.state = state;
    this.mesh = createProgram(gl, MESH_VS, MESH_FS, 'mesh3d');
    this.pickP = createProgram(gl, MESH_VS, PICK_FS, 'pick3d');
    this.edge = createProgram(gl, EDGE_VS, EDGE_FS, 'edge3d');
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]), gl.STATIC_DRAW);
    this.items = new Map();
    this.chunks = [];
    this.chunkOf = new Map();
    this.origin = [0, 0, 0];
    this.pick = null;
  }

  set(id, idx, mesh) {
    const prev = this.items.get(id);
    if (prev && prev.mesh === mesh && prev.idx === idx) return;
    if (!mesh) return this.remove(id);
    this.items.set(id, { idx, mesh });
    let ci = this.chunkOf.get(id);
    if (ci === undefined) {
      ci = this.chunks.findIndex((c) => c.ids.size < CHUNK);
      if (ci < 0) {
        this.chunks.push(new MeshChunk());
        ci = this.chunks.length - 1;
      }
      this.chunks[ci].ids.add(id);
      this.chunkOf.set(id, ci);
    }
    this.chunks[ci].dirty = true;
    this.boundsDirty = true;
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
    this.boundsDirty = true;
  }

  retain(ids) {
    for (const id of [...this.items.keys()]) if (!ids.has(id)) this.remove(id);
  }

  /** World bounds of everything, or of a subset of ids. */
  bounds(ids = null) {
    if (!ids && !this.boundsDirty && this._bounds !== undefined) return this._bounds;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (const [id, it] of this.items) {
      if (ids && !ids.has(id)) continue;
      const b = it.mesh.bounds;
      if (!b) continue;
      any = true;
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], b.min[i]);
        max[i] = Math.max(max[i], b.max[i]);
      }
    }
    const r = any ? { min, max } : null;
    if (!ids) {
      this._bounds = r;
      this.boundsDirty = false;
    }
    return r;
  }

  buildChunk(c) {
    const gl = this.gl;
    const [ox, oy, oz] = this.origin;
    let nOpaque = 0;
    let nTrans = 0;
    let nEdges = 0;
    const items = [...c.ids].map((id) => this.items.get(id)).filter(Boolean);
    for (const it of items) {
      const m = it.mesh;
      const tris = m.pos.length / 9;
      for (let t = 0; t < tris; t++) (m.col[t * 12 + 3] < 250 ? nTrans++ : nOpaque++);
      nEdges += m.edges.length / 6;
    }
    // 6 words per vertex: x y z, normal (packed bytes), colour, element.
    const buf = new ArrayBuffer((nOpaque + nTrans) * 3 * 24);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    const i8 = new Int8Array(buf);
    const u8 = new Uint8Array(buf);
    let o = 0;
    let t0 = nOpaque * 3 * 6;
    const write = (m, v, idx, base) => {
      f[base] = m.pos[v * 3] - ox;
      f[base + 1] = m.pos[v * 3 + 1] - oy;
      f[base + 2] = m.pos[v * 3 + 2] - oz;
      const bn = (base + 3) * 4;
      i8[bn] = m.nrm[v * 3];
      i8[bn + 1] = m.nrm[v * 3 + 1];
      i8[bn + 2] = m.nrm[v * 3 + 2];
      i8[bn + 3] = 0;
      const bc = (base + 4) * 4;
      u8[bc] = m.col[v * 4];
      u8[bc + 1] = m.col[v * 4 + 1];
      u8[bc + 2] = m.col[v * 4 + 2];
      u8[bc + 3] = m.col[v * 4 + 3];
      u[base + 5] = idx;
    };
    for (const it of items) {
      const m = it.mesh;
      const tris = m.pos.length / 9;
      for (let t = 0; t < tris; t++) {
        const trans = m.col[t * 12 + 3] < 250;
        for (let k = 0; k < 3; k++) {
          if (trans) {
            write(m, t * 3 + k, it.idx, t0);
            t0 += 6;
          } else {
            write(m, t * 3 + k, it.idx, o);
            o += 6;
          }
        }
      }
    }
    const eb = new ArrayBuffer(nEdges * 28);
    const ef = new Float32Array(eb);
    const eu = new Uint32Array(eb);
    let e = 0;
    for (const it of items) {
      const E = it.mesh.edges;
      for (let k = 0; k < E.length; k += 6) {
        ef[e] = E[k] - ox;
        ef[e + 1] = E[k + 1] - oy;
        ef[e + 2] = E[k + 2] - oz;
        ef[e + 3] = E[k + 3] - ox;
        ef[e + 4] = E[k + 4] - oy;
        ef[e + 5] = E[k + 5] - oz;
        eu[e + 6] = it.idx;
        e += 7;
      }
    }
    if (!c.vbo) {
      c.vbo = gl.createBuffer();
      c.vao = gl.createVertexArray();
      gl.bindVertexArray(c.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, c.vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.BYTE, true, 24, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 24, 16);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 24, 20);
      c.ebo = gl.createBuffer();
      c.evao = gl.createVertexArray();
      gl.bindVertexArray(c.evao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, c.ebo);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 28, 12);
      gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 28, 24);
      gl.vertexAttribDivisor(3, 1);
      gl.bindVertexArray(null);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, c.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.ebo);
    gl.bufferData(gl.ARRAY_BUFFER, eb, gl.DYNAMIC_DRAW);
    c.opaque = nOpaque * 3;
    c.transparent = nTrans * 3;
    c.edges = nEdges;
    c.dirty = false;
  }

  sync() {
    for (const c of this.chunks) if (c.dirty) this.buildChunk(c);
  }

  /** Clip planes as [nx, ny, nz, d] meaning "discard where n.p > d". */
  setUniformsCommon(p, cam, clip) {
    const gl = this.gl;
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.u.uVP, false, cam.vpF32);
    if (p.u.uOrigin) gl.uniform3f(p.u.uOrigin, this.origin[0], this.origin[1], this.origin[2]);
    if (p.u.uState) {
      gl.uniform1i(p.u.uState, 0);
      gl.uniform1i(p.u.uStateW, this.state.width);
    }
    if (p.u.uClip) {
      const arr = new Float32Array(32);
      clip.slice(0, 8).forEach((c, i) => arr.set(c, i * 4));
      gl.uniform4fv(p.u.uClip, arr);
      gl.uniform1i(p.u.uClipN, Math.min(8, clip.length));
    }
  }

  /**
   * cam: { vp (world matrix), eye, width, height, dpr }; theme: { ink, bg, sel, hover }
   * opts: { style, edges (bool), clip: [[nx,ny,nz,d]], light: [x,y,z] }
   */
  draw(cam, theme, opts = {}) {
    const gl = this.gl;
    this.sync();
    const style = STYLE[opts.style] ?? STYLE.shaded;
    const clip = opts.clip || [];
    cam.vpF32 = this.relativeVP(cam.vp);
    this.state.bind(0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    if (style !== STYLE.wireframe) {
      const p = this.mesh;
      this.setUniformsCommon(p, cam, clip);
      gl.uniform1i(p.u.uStyle, style);
      gl.uniform3fv(p.u.uBg, theme.bg);
      gl.uniform3fv(p.u.uSel, theme.sel);
      gl.uniform3fv(p.u.uHover, theme.hover);
      gl.uniform3fv(p.u.uLight, opts.light || [0.35, -0.45, 0.82]);
      gl.uniform3fv(p.u.uEye, cam.eye || [0, 0, 0]);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      for (const c of this.chunks) {
        if (!c.opaque) continue;
        gl.bindVertexArray(c.vao);
        gl.drawArrays(gl.TRIANGLES, 0, c.opaque);
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    const drawEdges = opts.edges !== false && (style !== STYLE.realistic || opts.edges === true);
    if (drawEdges) {
      const p = this.edge;
      this.setUniformsCommon(p, cam, clip);
      gl.uniform2f(p.u.uRes, cam.width, cam.height);
      gl.uniform1f(p.u.uWidth, (opts.edgeWidth || 1) * (cam.dpr || 1));
      gl.uniform1f(p.u.uBias, style === STYLE.wireframe ? 0 : 0.00002);
      gl.uniform3fv(p.u.uInk, theme.ink);
      gl.uniform3fv(p.u.uBg, theme.bg);
      gl.uniform3fv(p.u.uSel, theme.sel);
      gl.uniform3fv(p.u.uHover, theme.hover);
      gl.uniform1f(p.u.uAlpha, 1);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      if (style === STYLE.wireframe) gl.disable(gl.DEPTH_TEST);
      for (const c of this.chunks) {
        if (!c.edges) continue;
        gl.bindVertexArray(c.evao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, c.edges);
      }
      gl.enable(gl.DEPTH_TEST);
    }
    if (style !== STYLE.wireframe) {
      const p = this.mesh;
      this.setUniformsCommon(p, cam, clip);
      gl.uniform1i(p.u.uStyle, style);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const c of this.chunks) {
        if (!c.transparent) continue;
        gl.bindVertexArray(c.vao);
        gl.drawArrays(gl.TRIANGLES, c.opaque, c.transparent);
      }
    }
    gl.depthMask(true);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    this.lastCam = cam;
    this.lastClip = clip;
    this.pickDirty = true;
  }

  relativeVP(vp) {
    // vp * T(origin), so vertices relative to the origin land in place.
    const [x, y, z] = this.origin;
    const m = new Float32Array(16);
    for (let i = 0; i < 16; i++) m[i] = vp[i];
    m[12] = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    m[13] = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    m[14] = vp[2] * x + vp[6] * y + vp[10] * z + vp[14];
    m[15] = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    return m;
  }

  ensurePickTarget(w, h) {
    const gl = this.gl;
    if (this.pick && this.pick.w === w && this.pick.h === h) return this.pick;
    if (this.pick) {
      gl.deleteFramebuffer(this.pick.fb);
      gl.deleteTexture(this.pick.tex);
      gl.deleteRenderbuffer(this.pick.depth);
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pick = { fb, tex, depth, w, h };
    return this.pick;
  }

  /** Element index under a device pixel (0 when none). Renders the pick buffer on demand. */
  pickAt(x, y) {
    const gl = this.gl;
    const cam = this.lastCam;
    if (!cam) return 0;
    const t = this.ensurePickTarget(cam.width, cam.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    if (this.pickDirty) {
      gl.viewport(0, 0, t.w, t.h);
      gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      this.state.bind(0);
      const p = this.pickP;
      this.setUniformsCommon(p, cam, this.lastClip || []);
      for (const c of this.chunks) {
        if (!c.opaque && !c.transparent) continue;
        gl.bindVertexArray(c.vao);
        gl.drawArrays(gl.TRIANGLES, 0, c.opaque + c.transparent);
      }
      gl.bindVertexArray(null);
      this.pickDirty = false;
    }
    const out = new Uint32Array(4);
    const px = Math.max(0, Math.min(t.w - 1, Math.round(x)));
    const py = Math.max(0, Math.min(t.h - 1, Math.round(t.h - 1 - y)));
    gl.readPixels(px, py, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    return out[0];
  }

  clear() {
    const gl = this.gl;
    for (const c of this.chunks) {
      if (c.vbo) gl.deleteBuffer(c.vbo);
      if (c.ebo) gl.deleteBuffer(c.ebo);
      if (c.vao) gl.deleteVertexArray(c.vao);
      if (c.evao) gl.deleteVertexArray(c.evao);
    }
    this.items.clear();
    this.chunks = [];
    this.chunkOf.clear();
    this.boundsDirty = true;
  }
}
