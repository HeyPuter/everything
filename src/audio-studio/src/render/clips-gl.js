// WebGL2 renderer for many clip waveforms in one canvas (the multitrack
// lanes). Each clip channel is drawn into its own viewport rectangle: zoomed
// out as one instanced quad per pixel column (min..max), zoomed in as a line
// strip through the samples. Column data comes from audio/peaks.js, which
// caches min/max levels on immutable blocks, so redraws are cheap even with
// hundreds of clips. Falls back to Canvas 2D without WebGL2 (and in tests).

import { channelColumns } from '../audio/peaks.js';
import { parseColor } from '../ui/theme.js';
import { claimContext, readyContext, dropContext } from './gl-slots.js';

const COLUMN_VS = `#version 300 es
layout(location = 0) in vec2 corner;
layout(location = 1) in vec2 minmax;
uniform float uCols;
uniform float uAmp;
void main() {
  float x = (float(gl_InstanceID) + corner.x) / uCols * 2.0 - 1.0;
  float lo = clamp(minmax.x * uAmp, -1.0, 1.0);
  float hi = clamp(minmax.y * uAmp, -1.0, 1.0);
  gl_Position = vec4(x, mix(lo, hi, corner.y), 0.0, 1.0);
}`;

const LINE_VS = `#version 300 es
layout(location = 0) in float sampleValue;
uniform float uFirstX;
uniform float uStepX;
uniform float uAmp;
void main() {
  float x = uFirstX + float(gl_VertexID) * uStepX;
  gl_Position = vec4(x, clamp(sampleValue * uAmp, -1.0, 1.0), 0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 color;
void main() { color = uColor; }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

export class ClipWaveRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    try {
      this.gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
    } catch {
      this.gl = null;
    }
    this.ctx2d = this.gl ? null : canvas.getContext?.('2d') || null;
    this.columns = new Float32Array(0);
    if (this.gl) {
      this.#init();
      // Listeners go on once; a restored context only needs its resources rebuilt.
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
      });
      canvas.addEventListener('webglcontextrestored', () => {
        this.lost = false;
        this.#init();
        this.onRestore?.();
      });
      claimContext(this);
    }
  }

  get webgl() {
    return Boolean(this.gl);
  }

  #init() {
    const gl = this.gl;
    this.colProg = program(gl, COLUMN_VS, FS);
    this.lineProg = program(gl, LINE_VS, FS);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.instBuf = gl.createBuffer();
    this.lineBuf = gl.createBuffer();
    this.colVao = gl.createVertexArray();
    gl.bindVertexArray(this.colVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);
  }

  resize(width, height, dpr = window.devicePixelRatio || 1) {
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  clear() {
    if (this.gl && !readyContext(this)) return;
    if (this.lost) return;
    const gl = this.gl;
    if (gl) {
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
    } else this.ctx2d?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Draws one channel of a clip segment into a device-pixel rectangle.
   * @param {Channel} ch source channel
   * @param {number} srcStart source frame at the rectangle's left edge
   * @param {number} fpp source frames per device pixel
   * @param {{x, y, w, h}} rect device pixels (y from the top); clip: {y0, y1} visible band
   * @param {number} amp gain applied to the drawing
   * @param {string} color CSS color
   */
  drawChannel(ch, srcStart, fpp, rect, amp, color, clipBand) {
    if (this.gl && !readyContext(this)) return;
    if (this.lost || rect.w < 1 || rect.h < 1) return;
    const H = this.canvas.height;
    const y0 = Math.max(rect.y, clipBand ? clipBand.y0 : 0);
    const y1 = Math.min(rect.y + rect.h, clipBand ? clipBand.y1 : H);
    if (y1 <= y0) return;
    if (this.gl) this.#drawGL(ch, srcStart, fpp, rect, amp, color, y0, y1, H);
    else this.#draw2d(ch, srcStart, fpp, rect, amp, color, y0, y1);
  }

  #drawGL(ch, srcStart, fpp, rect, amp, color, y0, y1, H) {
    const gl = this.gl;
    const x = Math.round(rect.x);
    const w = Math.max(1, Math.round(rect.w));
    gl.viewport(x, Math.round(H - rect.y - rect.h), w, Math.round(rect.h));
    gl.scissor(x, Math.round(H - y1), w, Math.round(y1 - y0));
    const [r, g, b, a] = parseColor(color);
    if (fpp > 1) {
      if (this.columns.length < w * 2) this.columns = new Float32Array(w * 2);
      const data = channelColumns(ch, srcStart, fpp, w, this.columns);
      const minSpan = 2 / Math.max(1, rect.h) / Math.max(amp, 1e-6);
      let first = 0;
      while (first < w && Number.isNaN(data[2 * first])) first++;
      let last = w - 1;
      while (last >= first && Number.isNaN(data[2 * last])) last--;
      if (last < first) return;
      for (let c = first; c <= last; c++) {
        if (Number.isNaN(data[2 * c])) {
          data[2 * c] = 0;
          data[2 * c + 1] = 0;
        }
        if (data[2 * c + 1] - data[2 * c] < minSpan) {
          const m = (data[2 * c] + data[2 * c + 1]) / 2;
          data[2 * c] = m - minSpan / 2;
          data[2 * c + 1] = m + minSpan / 2;
        }
      }
      // Draw only the columns with data; re-anchor the viewport to the first.
      const n = last - first + 1;
      gl.viewport(x + first, Math.round(H - rect.y - rect.h), n, Math.round(rect.h));
      const P = this.colProg;
      gl.useProgram(P.p);
      gl.uniform1f(P.u.uCols, n);
      gl.uniform1f(P.u.uAmp, amp);
      gl.uniform4f(P.u.uColor, r * a, g * a, b * a, a);
      gl.bindVertexArray(this.colVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(2 * first, 2 * (last + 1)), gl.STREAM_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    } else {
      const s0 = Math.max(0, Math.floor(srcStart) - 1);
      const s1 = Math.min(ch.length, Math.ceil(srcStart + w * fpp) + 2);
      if (s1 <= s0) return;
      const samples = ch.toArray(s0, s1);
      const P = this.lineProg;
      gl.useProgram(P.p);
      gl.uniform1f(P.u.uFirstX, ((s0 - srcStart) / fpp / w) * 2 - 1);
      gl.uniform1f(P.u.uStepX, (1 / fpp / w) * 2);
      gl.uniform1f(P.u.uAmp, amp);
      gl.uniform4f(P.u.uColor, r * a, g * a, b * a, a);
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, samples, gl.STREAM_DRAW);
      gl.drawArrays(gl.LINE_STRIP, 0, samples.length);
    }
    gl.bindVertexArray(null);
  }

  #draw2d(ch, srcStart, fpp, rect, amp, color, y0, y1) {
    const ctx = this.ctx2d;
    if (!ctx) return;
    const w = Math.max(1, Math.round(rect.w));
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, y0, w, y1 - y0);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    const mid = rect.y + rect.h / 2;
    const half = rect.h / 2;
    if (fpp > 1) {
      if (this.columns.length < w * 2) this.columns = new Float32Array(w * 2);
      const data = channelColumns(ch, srcStart, fpp, w, this.columns);
      for (let c = 0; c < w; c++) {
        const lo = data[2 * c];
        if (Number.isNaN(lo)) continue;
        const hi = data[2 * c + 1];
        const ya = mid - Math.max(-1, Math.min(1, hi * amp)) * half;
        const yb = mid - Math.max(-1, Math.min(1, lo * amp)) * half;
        ctx.fillRect(rect.x + c, ya, 1, Math.max(1, yb - ya));
      }
    } else {
      const s0 = Math.max(0, Math.floor(srcStart) - 1);
      const s1 = Math.min(ch.length, Math.ceil(srcStart + w * fpp) + 2);
      const samples = ch.toArray(s0, s1);
      ctx.beginPath();
      for (let k = 0; k < samples.length; k++) {
        const px = rect.x + (s0 + k - srcStart) / fpp;
        const py = mid - Math.max(-1, Math.min(1, samples[k] * amp)) * half;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    dropContext(this);
    gl.deleteBuffer(this.cornerBuf);
    gl.deleteBuffer(this.instBuf);
    gl.deleteBuffer(this.lineBuf);
    gl.deleteVertexArray(this.colVao);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteProgram(this.colProg.p);
    gl.deleteProgram(this.lineProg.p);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
