// 2D drawing surface for the editors (playlist, piano roll, automation).
// Rectangles go through WebGL2 as one instanced draw call per frame (rounded
// corners and antialiasing in the fragment shader); text and a few top-most
// marks go on a Canvas 2D overlay above it. Without WebGL2 everything falls
// back to Canvas 2D with the same API.
//
//   const g = createGfx(host);            // host: a positioned element
//   g.frame((d) => {                      // d = { w, h, dpr }
//     d.clear(rgba);
//     d.rect(x, y, w, h, rgba, radius);   // rgba = [r, g, b, a] in 0..1
//     d.text('Pattern 1', x, y, cssColor, { font, align, baseline, maxWidth });
//     d.top(x, y, w, h, cssColor);        // above text (playhead, cursors)
//   });
//
// Coordinates are CSS pixels. `g.destroy()` releases the GPU context.

import { parseColor } from '../ui/theme.js';

const VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_rect;
layout(location=2) in vec4 a_color;
layout(location=3) in float a_radius;
uniform vec2 u_view;
out vec2 v_local;
out vec2 v_half;
out vec4 v_color;
out float v_radius;
void main() {
  vec2 pad = vec2(1.0);
  vec2 pos = a_rect.xy - pad + a_corner * (a_rect.zw + pad * 2.0);
  v_half = a_rect.zw * 0.5;
  v_local = pos - (a_rect.xy + v_half);
  v_color = a_color;
  v_radius = min(a_radius, min(v_half.x, v_half.y));
  vec2 clip = (pos / u_view) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 v_local;
in vec2 v_half;
in vec4 v_color;
in float v_radius;
uniform float u_dpr;
out vec4 o;
void main() {
  vec2 q = abs(v_local) - v_half + vec2(v_radius);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - v_radius;
  float aa = 0.5 / u_dpr;
  float cover = clamp(0.5 - d / (aa * 2.0), 0.0, 1.0);
  if (cover <= 0.0) discard;
  o = vec4(v_color.rgb * v_color.a * cover, v_color.a * cover);
}`;

const FLOATS = 9; // x, y, w, h, r, g, b, a, radius

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
  return s;
}

function cssRgba(c) {
  if (typeof c === 'string') return c;
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] ?? 1})`;
}

function makeGL(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
  if (!gl) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const inst = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  const stride = FLOATS * 4;
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
  gl.vertexAttribDivisor(2, 1);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
  gl.vertexAttribDivisor(3, 1);
  gl.bindVertexArray(null);
  return {
    gl,
    prog,
    vao,
    inst,
    uView: gl.getUniformLocation(prog, 'u_view'),
    uDpr: gl.getUniformLocation(prog, 'u_dpr'),
    capacity: 0,
  };
}

export function createGfx(host, { forceCanvas = false } = {}) {
  const base = document.createElement('canvas');
  const over = document.createElement('canvas');
  for (const c of [base, over]) {
    c.style.position = 'absolute';
    c.style.inset = '0';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.pointerEvents = 'none';
    c.setAttribute('aria-hidden', 'true');
  }
  host.append(base, over);
  let glState = null;
  if (!forceCanvas) {
    try {
      glState = makeGL(base);
    } catch {
      glState = null;
    }
  }
  const ctx2 = over.getContext('2d');
  const baseCtx = glState ? null : base.getContext('2d');
  let lost = false;
  base.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lost = true;
  });
  base.addEventListener('webglcontextrestored', () => {
    try {
      glState = makeGL(base);
      lost = false;
    } catch {
      glState = null;
    }
  });

  let data = new Float32Array(FLOATS * 1024);
  let count = 0;
  let w = 0;
  let hgt = 0;
  let dpr = 1;
  let clearColor = [0, 0, 0, 1];
  const texts = [];
  const tops = [];

  const push = (x, y, rw, rh, c, radius) => {
    if (rw <= 0 || rh <= 0 || (c[3] ?? 1) <= 0) return;
    if (x > w || y > hgt || x + rw < 0 || y + rh < 0) return;
    if ((count + 1) * FLOATS > data.length) {
      const next = new Float32Array(data.length * 2);
      next.set(data);
      data = next;
    }
    const o = count * FLOATS;
    data[o] = x;
    data[o + 1] = y;
    data[o + 2] = rw;
    data[o + 3] = rh;
    data[o + 4] = c[0];
    data[o + 5] = c[1];
    data[o + 6] = c[2];
    data[o + 7] = c[3] ?? 1;
    data[o + 8] = radius;
    count++;
  };

  function resize() {
    const r = host.getBoundingClientRect();
    const nd = Math.min(window.devicePixelRatio || 1, 2);
    const nw = Math.max(1, Math.round(r.width));
    const nh = Math.max(1, Math.round(r.height));
    if (nw === w && nh === hgt && nd === dpr) return false;
    w = nw;
    hgt = nh;
    dpr = nd;
    for (const c of [base, over]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    return true;
  }

  const api = {
    clear(c) {
      clearColor = typeof c === 'string' ? parseColor(c) : c;
    },
    rect(x, y, rw, rh, c, radius = 0) {
      push(x, y, rw, rh, typeof c === 'string' ? parseColor(c) : c, radius);
    },
    strokeRect(x, y, rw, rh, c, lw = 1) {
      const col = typeof c === 'string' ? parseColor(c) : c;
      push(x, y, rw, lw, col, 0);
      push(x, y + rh - lw, rw, lw, col, 0);
      push(x, y + lw, lw, rh - lw * 2, col, 0);
      push(x + rw - lw, y + lw, lw, rh - lw * 2, col, 0);
    },
    text(str, x, y, color, opts = {}) {
      if (x > w || y > hgt + 20) return;
      texts.push([str, x, y, color, opts]);
    },
    top(x, y, rw, rh, color) {
      tops.push([x, y, rw, rh, color]);
    },
    get w() {
      return w;
    },
    get h() {
      return hgt;
    },
    get dpr() {
      return dpr;
    },
  };

  function flush() {
    if (glState && !lost) {
      const { gl, prog, vao, inst, uView, uDpr } = glState;
      gl.viewport(0, 0, base.width, base.height);
      gl.clearColor(clearColor[0], clearColor[1], clearColor[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (count) {
        gl.useProgram(prog);
        gl.uniform2f(uView, w, hgt);
        gl.uniform1f(uDpr, dpr);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindBuffer(gl.ARRAY_BUFFER, inst);
        const bytes = count * FLOATS;
        if (glState.capacity < data.length) {
          gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
          glState.capacity = data.length;
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, bytes);
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        gl.bindVertexArray(null);
      }
    } else if (baseCtx) {
      baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      baseCtx.fillStyle = cssRgba(clearColor);
      baseCtx.fillRect(0, 0, w, hgt);
      for (let i = 0; i < count; i++) {
        const o = i * FLOATS;
        baseCtx.fillStyle = `rgba(${Math.round(data[o + 4] * 255)},${Math.round(data[o + 5] * 255)},${Math.round(data[o + 6] * 255)},${data[o + 7]})`;
        const r = data[o + 8];
        if (r > 0.5 && baseCtx.roundRect) {
          baseCtx.beginPath();
          baseCtx.roundRect(data[o], data[o + 1], data[o + 2], data[o + 3], Math.min(r, data[o + 2] / 2, data[o + 3] / 2));
          baseCtx.fill();
        } else baseCtx.fillRect(data[o], data[o + 1], data[o + 2], data[o + 3]);
      }
    }
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, w, hgt);
    let font = '';
    for (const [str, x, y, color, opts] of texts) {
      const f = opts.font || '11px system-ui, -apple-system, sans-serif';
      if (f !== font) {
        ctx2.font = f;
        font = f;
      }
      ctx2.fillStyle = cssRgba(color);
      ctx2.textAlign = opts.align || 'left';
      ctx2.textBaseline = opts.baseline || 'middle';
      if (opts.maxWidth !== undefined) {
        if (opts.maxWidth < 8) continue;
        ctx2.save();
        ctx2.beginPath();
        ctx2.rect(opts.align === 'right' ? x - opts.maxWidth : opts.align === 'center' ? x - opts.maxWidth / 2 : x, y - 12, opts.maxWidth, 24);
        ctx2.clip();
        ctx2.fillText(str, x, y);
        ctx2.restore();
      } else ctx2.fillText(str, x, y);
    }
    for (const [x, y, rw, rh, color] of tops) {
      ctx2.fillStyle = cssRgba(color);
      ctx2.fillRect(x, y, rw, rh);
    }
  }

  return {
    canvas: base,
    overlay: over,
    usesWebGL: Boolean(glState),
    resize,
    /** Draws one frame: `draw(api)` queues shapes, then they are flushed in order. */
    frame(draw) {
      resize();
      count = 0;
      texts.length = 0;
      tops.length = 0;
      draw(api);
      flush();
    },
    get size() {
      return { w, h: hgt, dpr };
    },
    destroy() {
      glState?.gl.getExtension('WEBGL_lose_context')?.loseContext();
      base.remove();
      over.remove();
    },
  };
}

/** Parses a CSS color to rgba once (for colors used every frame). */
export const rgba = (css, alpha) => {
  const c = parseColor(css);
  if (alpha !== undefined) c[3] = alpha;
  return c;
};

/** Mixes two rgba colors. */
export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, (a[3] ?? 1) + ((b[3] ?? 1) - (a[3] ?? 1)) * t];
}
