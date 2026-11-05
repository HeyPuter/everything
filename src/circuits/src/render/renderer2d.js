// WebGL2 renderer for the schematic and board canvases.
//
// Shapes are drawn as instanced quads whose fragment shader evaluates a signed
// distance function, so every line, pad and arc stays crisp and antialiased at
// any zoom without tessellation. Polygons (copper pours, fills, body shapes)
// are triangulated once on the CPU. Lines never get thinner than a pixel, which
// keeps fine detail visible when zoomed out.

import { KINDS } from './batch.js';

const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

const HEADER = `#version 300 es
precision highp float;
uniform vec2 u_center;   // view centre, micrometres
uniform vec2 u_scale;    // clip units per micrometre (x, y)
uniform float u_px;      // micrometres per device pixel
`;

const FS_HEADER = `#version 300 es
precision highp float;
uniform float u_px;
uniform float u_alpha;
uniform vec4 u_mix;      // rgb target, a amount
out vec4 o_color;
vec4 finish(vec4 c, float cov) {
  vec3 rgb = mix(c.rgb, u_mix.rgb, u_mix.a);
  float a = c.a * cov * u_alpha;
  return vec4(rgb * a, a);
}
`;

const PROGRAMS = {
  seg: {
    attrs: [['a_seg', 4, 0], ['a_hw', 1, 16], ['a_color', 4, 20, true]],
    stride: 24,
    vs: `${HEADER}
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_seg;
layout(location=2) in float a_hw;
layout(location=3) in vec4 a_color;
out vec2 v_local; out float v_len; out float v_hw; out vec4 v_color;
void main() {
  vec2 d = a_seg.zw - a_seg.xy;
  float len = length(d);
  vec2 u = len > 0.0 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-u.y, u.x);
  float hw = max(a_hw, u_px * 0.5);
  float e = hw + u_px;
  vec2 lc = vec2(mix(-e, len + e, a_corner.x), mix(-e, e, a_corner.y));
  vec2 w = a_seg.xy + u * lc.x + n * lc.y;
  gl_Position = vec4((w - u_center) * u_scale, 0.0, 1.0);
  v_local = lc; v_len = len; v_hw = hw; v_color = a_color;
}`,
    fs: `${FS_HEADER}
in vec2 v_local; in float v_len; in float v_hw; in vec4 v_color;
void main() {
  float dx = max(max(-v_local.x, v_local.x - v_len), 0.0);
  float d = length(vec2(dx, v_local.y)) - v_hw;
  float cov = clamp(0.5 - d / u_px, 0.0, 1.0);
  if (cov <= 0.0) discard;
  o_color = finish(v_color, cov);
}`,
  },
  circ: {
    attrs: [['a_circ', 4, 0], ['a_color', 4, 16, true]],
    stride: 20,
    vs: `${HEADER}
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_circ;
layout(location=2) in vec4 a_color;
out vec2 v_local; out float v_r; out float v_in; out vec4 v_color;
void main() {
  float r = max(a_circ.z, u_px * 0.5);
  float e = r + u_px;
  vec2 lc = mix(vec2(-e), vec2(e), a_corner);
  gl_Position = vec4((a_circ.xy + lc - u_center) * u_scale, 0.0, 1.0);
  v_local = lc; v_r = r; v_in = a_circ.w; v_color = a_color;
}`,
    fs: `${FS_HEADER}
in vec2 v_local; in float v_r; in float v_in; in vec4 v_color;
void main() {
  float l = length(v_local);
  float d = l - v_r;
  if (v_in > 0.0) d = max(d, v_in - l);
  float cov = clamp(0.5 - d / u_px, 0.0, 1.0);
  if (cov <= 0.0) discard;
  o_color = finish(v_color, cov);
}`,
  },
  rect: {
    attrs: [['a_rect', 4, 0], ['a_rot', 2, 16], ['a_color', 4, 24, true]],
    stride: 28,
    vs: `${HEADER}
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_rect;
layout(location=2) in vec2 a_rot;
layout(location=3) in vec4 a_color;
out vec2 v_local; out vec2 v_half; out float v_rad; out vec4 v_color;
void main() {
  vec2 hs = max(a_rect.zw, vec2(u_px * 0.5));
  vec2 e = hs + u_px;
  vec2 lc = mix(-e, e, a_corner);
  float c = cos(a_rot.x), s = sin(a_rot.x);
  vec2 w = a_rect.xy + vec2(lc.x * c - lc.y * s, lc.x * s + lc.y * c);
  gl_Position = vec4((w - u_center) * u_scale, 0.0, 1.0);
  v_local = lc; v_half = hs; v_rad = min(a_rot.y, min(hs.x, hs.y)); v_color = a_color;
}`,
    fs: `${FS_HEADER}
in vec2 v_local; in vec2 v_half; in float v_rad; in vec4 v_color;
void main() {
  vec2 q = abs(v_local) - (v_half - vec2(v_rad));
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - v_rad;
  float cov = clamp(0.5 - d / u_px, 0.0, 1.0);
  if (cov <= 0.0) discard;
  o_color = finish(v_color, cov);
}`,
  },
  arc: {
    attrs: [['a_arc', 4, 0], ['a_arc2', 2, 16], ['a_color', 4, 24, true]],
    stride: 28,
    vs: `${HEADER}
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_arc;   // cx cy r a0
layout(location=2) in vec2 a_arc2;  // sweep halfWidth
layout(location=3) in vec4 a_color;
out vec2 v_local; out float v_r; out float v_a0; out float v_sw; out float v_hw; out vec4 v_color;
void main() {
  float hw = max(a_arc2.y, u_px * 0.5);
  float e = a_arc.z + hw + u_px;
  vec2 lc = mix(vec2(-e), vec2(e), a_corner);
  gl_Position = vec4((a_arc.xy + lc - u_center) * u_scale, 0.0, 1.0);
  v_local = lc; v_r = a_arc.z; v_a0 = a_arc.w; v_sw = a_arc2.x; v_hw = hw; v_color = a_color;
}`,
    fs: `${FS_HEADER}
in vec2 v_local; in float v_r; in float v_a0; in float v_sw; in float v_hw; in vec4 v_color;
const float TAU = 6.28318530718;
void main() {
  float a = atan(v_local.y, v_local.x) - v_a0;
  a = mod(a, TAU);
  float d;
  if (v_sw >= TAU - 1e-4 || a <= v_sw) {
    d = abs(length(v_local) - v_r) - v_hw;
  } else {
    vec2 p0 = v_r * vec2(cos(v_a0), sin(v_a0));
    vec2 p1 = v_r * vec2(cos(v_a0 + v_sw), sin(v_a0 + v_sw));
    d = min(length(v_local - p0), length(v_local - p1)) - v_hw;
  }
  float cov = clamp(0.5 - d / u_px, 0.0, 1.0);
  if (cov <= 0.0) discard;
  o_color = finish(v_color, cov);
}`,
  },
  tri: {
    attrs: [['a_pos', 2, 0], ['a_color', 4, 8, true]],
    stride: 12,
    vs: `${HEADER}
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_color;
out vec4 v_color;
void main() {
  gl_Position = vec4((a_pos - u_center) * u_scale, 0.0, 1.0);
  v_color = a_color;
}`,
    fs: `${FS_HEADER}
in vec4 v_color;
void main() { o_color = finish(v_color, 1.0); }`,
  },
};

const GRID = {
  vs: `#version 300 es
layout(location=0) in vec2 a_corner;
void main() { gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0); }`,
  fs: `#version 300 es
precision highp float;
uniform vec2 u_origin;      // world micrometres at the bottom-left device pixel
uniform float u_px;         // micrometres per device pixel
uniform vec2 u_offset;      // grid origin, micrometres
uniform float u_step;       // grid step, micrometres
uniform int u_major;        // major line every n steps (0 = none)
uniform int u_style;        // 0 lines, 1 dots
uniform vec4 u_minor;
uniform vec4 u_majorColor;
uniform vec4 u_clip;        // optional clip rect (minX minY maxX maxY), z<x disables
out vec4 o_color;
float gridCov(vec2 w, float step, float width) {
  vec2 g = abs(mod(w - u_offset + step * 0.5, step) - step * 0.5) / u_px;
  return u_style == 0 ? clamp(width - min(g.x, g.y), 0.0, 1.0) : clamp(width + 0.5 - max(g.x, g.y), 0.0, 1.0) * clamp(width + 0.5 - min(g.x, g.y), 0.0, 1.0);
}
void main() {
  vec2 w = u_origin + (gl_FragCoord.xy - 0.5) * u_px;
  if (u_clip.z >= u_clip.x && (w.x < u_clip.x || w.y < u_clip.y || w.x > u_clip.z || w.y > u_clip.w)) discard;
  float step = u_step;
  float n = float(max(u_major, 1));
  float fade = 1.0;
  // Hide grids denser than a few pixels; fall back to the major grid.
  float spacing = step / u_px;
  bool minorOn = spacing >= 6.0;
  fade = clamp((spacing - 6.0) / 6.0, 0.0, 1.0);
  vec4 c = vec4(0.0);
  if (minorOn) {
    float cov = gridCov(w, step, u_style == 0 ? 1.0 : 1.0);
    c = u_minor * cov * fade;
  }
  if (u_major > 0 && step * n / u_px >= 6.0) {
    float cov = gridCov(w, step * n, u_style == 0 ? 1.0 : 1.5);
    vec4 m = u_majorColor * cov;
    c = m.a > c.a ? m : c;
  }
  if (c.a <= 0.0) discard;
  o_color = vec4(c.rgb * c.a, c.a);
}`,
};

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl, vs, fs) {
  const p = gl.createProgram();
  const v = compile(gl, gl.VERTEX_SHADER, vs), f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v); gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(p)}`);
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { program: p, uniforms };
}

export class Renderer2D {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.dpr = 1;
    this.width = 1; this.height = 1;
    this.view = { cx: 0, cy: 0, scale: 0.01 }; // scale: CSS px per micrometre
    this._gpu = new WeakMap();
    this._all = new Set();
    this._init();
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this._gpu = new WeakMap(); this._all.clear(); this._init(); this.onRestore?.(); });
  }

  _init() {
    const gl = this.gl;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    this.programs = {};
    for (const [kind, def] of Object.entries(PROGRAMS)) this.programs[kind] = { ...link(gl, def.vs, def.fs), def };
    this.grid = link(gl, GRID.vs, GRID.fs);
    this.gridVao = gl.createVertexArray();
    gl.bindVertexArray(this.gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Resizes the drawing buffer to the canvas' CSS size. Returns true if it changed. */
  resize(cssW, cssH, dpr = Math.min(window.devicePixelRatio || 1, 2)) {
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    if (w === this.width && h === this.height) return false;
    this.width = w; this.height = h;
    this.canvas.width = w; this.canvas.height = h;
    return true;
  }

  // Camera helpers. Screen coordinates are CSS pixels from the canvas' top-left;
  // world coordinates are nanometres with +y up.

  screenToWorld(sx, sy) {
    const v = this.view;
    return [((sx - this.cssW / 2) / v.scale + v.cx) * 1000, (-(sy - this.cssH / 2) / v.scale + v.cy) * 1000];
  }

  worldToScreen(x, y) {
    const v = this.view;
    return [(x / 1000 - v.cx) * v.scale + this.cssW / 2, -(y / 1000 - v.cy) * v.scale + this.cssH / 2];
  }

  /** Visible world box in nanometres. */
  visibleBox(margin = 0) {
    const [x0, y0] = this.screenToWorld(-margin, this.cssH + margin);
    const [x1, y1] = this.screenToWorld(this.cssW + margin, -margin);
    return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  }

  /** Nanometres per CSS pixel at the current zoom. */
  get nmPerPx() { return 1000 / this.view.scale; }

  // Limits: zoomed out, a two metre design still spans 200 px (further out
  // everything collapses into a dot and the view is easy to lose); zoomed
  // in, 10 px per micrometre (float32 coordinates start to wobble beyond).
  zoomAt(sx, sy, factor, minScale = 1e-4, maxScale = 10) {
    const [wx, wy] = this.screenToWorld(sx, sy);
    const v = this.view;
    v.scale = Math.min(maxScale, Math.max(minScale, v.scale * factor));
    // Keep the world point under the cursor fixed.
    v.cx = wx / 1000 - (sx - this.cssW / 2) / v.scale;
    v.cy = wy / 1000 + (sy - this.cssH / 2) / v.scale;
  }

  panBy(dxCss, dyCss) {
    const v = this.view;
    v.cx -= dxCss / v.scale;
    v.cy += dyCss / v.scale;
  }

  fitBox(box, paddingPx = 40) {
    const w = (box.maxX - box.minX) / 1000, h = (box.maxY - box.minY) / 1000;
    const availW = Math.max(10, this.cssW - paddingPx * 2), availH = Math.max(10, this.cssH - paddingPx * 2);
    const v = this.view;
    v.scale = Math.min(availW / Math.max(w, 1e-3), availH / Math.max(h, 1e-3));
    v.cx = (box.minX + box.maxX) / 2000;
    v.cy = (box.minY + box.maxY) / 2000;
  }

  _upload(batch) {
    const gl = this.gl;
    let g = this._gpu.get(batch);
    if (!g) {
      g = { version: -1, kinds: {} };
      for (const kind of KINDS) {
        const vao = gl.createVertexArray();
        const buf = gl.createBuffer();
        const def = PROGRAMS[kind];
        gl.bindVertexArray(vao);
        if (kind === 'tri') {
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          def.attrs.forEach(([, size, offset, norm], i) => {
            gl.enableVertexAttribArray(i);
            gl.vertexAttribPointer(i, size, norm ? gl.UNSIGNED_BYTE : gl.FLOAT, !!norm, def.stride, offset);
          });
        } else {
          gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
          gl.enableVertexAttribArray(0);
          gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          def.attrs.forEach(([, size, offset, norm], i) => {
            gl.enableVertexAttribArray(i + 1);
            gl.vertexAttribPointer(i + 1, size, norm ? gl.UNSIGNED_BYTE : gl.FLOAT, !!norm, def.stride, offset);
            gl.vertexAttribDivisor(i + 1, 1);
          });
        }
        gl.bindVertexArray(null);
        g.kinds[kind] = { vao, buf, count: 0, cap: 0 };
      }
      this._gpu.set(batch, g);
      this._all.add(g);
    }
    if (g.version !== batch.version) {
      for (const kind of KINDS) {
        const src = batch.bufs[kind], k = g.kinds[kind];
        k.count = src.count;
        if (!src.count) continue;
        gl.bindBuffer(gl.ARRAY_BUFFER, k.buf);
        const bytes = src.byteLength;
        if (bytes > k.cap) {
          k.cap = Math.max(bytes, k.cap * 2);
          gl.bufferData(gl.ARRAY_BUFFER, k.cap, gl.DYNAMIC_DRAW);
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(src.buffer, 0, bytes));
      }
      g.version = batch.version;
    }
    return g;
  }

  /** Frees GPU memory held for a batch that will not be drawn again. */
  release(batch) {
    const g = this._gpu.get(batch);
    if (!g) return;
    const gl = this.gl;
    for (const k of Object.values(g.kinds)) { gl.deleteVertexArray(k.vao); gl.deleteBuffer(k.buf); }
    this._gpu.delete(batch);
    this._all.delete(g);
  }

  _uniforms(u, pxUm) {
    const gl = this.gl, v = this.view;
    gl.uniform2f(u.u_center, v.cx, v.cy);
    gl.uniform2f(u.u_scale, (2 * v.scale) / this.cssW, (2 * v.scale) / this.cssH);
    gl.uniform1f(u.u_px, pxUm);
  }

  /**
   * Draws one frame.
   * frame = { background: [r,g,b], grid?: {...}, passes: [{ batch, alpha?, mix?: [r,g,b,a], offset?: [dx, dy] nm }] }
   * Passes draw in order; within a pass triangles go first, then shapes.
   */
  draw(frame) {
    if (this.lost) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    const bg = frame.background || [0, 0, 0];
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const pxUm = 1 / (this.view.scale * this.dpr);

    for (const pass of frame.passes) {
      if (pass.grid) { this._drawGrid(pass.grid, pxUm); continue; }
      const batch = pass.batch;
      if (!batch || batch.empty) continue;
      const g = this._upload(batch);
      const saved = pass.offset ? { cx: this.view.cx, cy: this.view.cy } : null;
      if (saved) { this.view.cx -= pass.offset[0] / 1000; this.view.cy -= pass.offset[1] / 1000; }
      for (const kind of KINDS) {
        const k = g.kinds[kind];
        if (!k.count) continue;
        const p = this.programs[kind];
        gl.useProgram(p.program);
        this._uniforms(p.uniforms, pxUm);
        gl.uniform1f(p.uniforms.u_alpha, pass.alpha ?? 1);
        const mix = pass.mix || [0, 0, 0, 0];
        gl.uniform4f(p.uniforms.u_mix, mix[0], mix[1], mix[2], mix[3]);
        gl.bindVertexArray(k.vao);
        if (kind === 'tri') gl.drawArrays(gl.TRIANGLES, 0, k.count);
        else gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k.count);
      }
      if (saved) { this.view.cx = saved.cx; this.view.cy = saved.cy; }
    }
    gl.bindVertexArray(null);
  }

  _drawGrid(grid, pxUm) {
    const gl = this.gl, u = this.grid.uniforms;
    gl.useProgram(this.grid.program);
    const [ox, oy] = this.screenToWorld(0, this.cssH);
    gl.uniform2f(u.u_origin, ox / 1000, oy / 1000);
    gl.uniform1f(u.u_px, pxUm);
    gl.uniform2f(u.u_offset, (grid.originX || 0) / 1000, (grid.originY || 0) / 1000);
    gl.uniform1f(u.u_step, grid.step / 1000);
    gl.uniform1i(u.u_major, grid.major ?? 10);
    gl.uniform1i(u.u_style, grid.style === 'dots' ? 1 : 0);
    gl.uniform4fv(u.u_minor, grid.minor);
    gl.uniform4fv(u.u_majorColor, grid.majorColor || grid.minor);
    const c = grid.clip;
    gl.uniform4f(u.u_clip, c ? c.minX / 1000 : 1, c ? c.minY / 1000 : 1, c ? c.maxX / 1000 : 0, c ? c.maxY / 1000 : 0);
    gl.bindVertexArray(this.gridVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    const gl = this.gl;
    for (const g of this._all) for (const k of Object.values(g.kinds)) { gl.deleteVertexArray(k.vao); gl.deleteBuffer(k.buf); }
    this._all.clear();
    for (const p of Object.values(this.programs)) gl.deleteProgram(p.program);
    gl.deleteProgram(this.grid.program);
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.gridVao);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
