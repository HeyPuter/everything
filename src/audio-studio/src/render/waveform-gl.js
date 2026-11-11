// WebGL2 waveform renderer. Zoomed out, each pixel column is one instanced
// quad spanning that column's min..max (one draw call per channel). Zoomed in
// past one sample per pixel, the samples are drawn as a line strip, with dots
// once samples are far enough apart to grab. Falls back to Canvas 2D when
// WebGL2 is unavailable (and in tests).

import { channelColumns } from '../audio/peaks.js';
import { parseColor } from '../ui/theme.js';

const COLUMN_VS = `#version 300 es
layout(location = 0) in vec2 corner;      // (0|1, 0|1)
layout(location = 1) in vec2 minmax;      // per instance
uniform float uCols;
uniform vec2 uLane;                        // lane top/bottom in clip space
uniform float uAmp;
uniform float uColOffset;
void main() {
  float col = float(gl_InstanceID) + uColOffset;
  float x = (col + corner.x) / uCols * 2.0 - 1.0;
  float lo = clamp(minmax.x * uAmp, -1.0, 1.0);
  float hi = clamp(minmax.y * uAmp, -1.0, 1.0);
  // Keep at least one device pixel of height so silence still draws a line.
  float v = mix(lo, hi, corner.y);
  float mid = (uLane.x + uLane.y) * 0.5;
  float halfH = (uLane.x - uLane.y) * 0.5;
  gl_Position = vec4(x, mid + v * halfH, 0.0, 1.0);
}`;

const COLUMN_FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 color;
void main() { color = uColor; }`;

const LINE_VS = `#version 300 es
layout(location = 0) in float sampleValue;
uniform float uFirstX;     // clip-space x of sample 0
uniform float uStepX;      // clip-space distance between samples
uniform vec2 uLane;
uniform float uAmp;
uniform float uPoint;
void main() {
  float x = uFirstX + float(gl_VertexID) * uStepX;
  float v = clamp(sampleValue * uAmp, -1.05, 1.05);
  float mid = (uLane.x + uLane.y) * 0.5;
  float halfH = (uLane.x - uLane.y) * 0.5;
  gl_Position = vec4(x, mid + v * halfH, 0.0, 1.0);
  gl_PointSize = uPoint;
}`;

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
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

export class WaveformRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    try {
      this.gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
    } catch {
      this.gl = null;
    }
    this.ctx2d = null;
    if (this.gl) {
      this.#initGL();
      // Listeners go on once; a restored context only needs its resources rebuilt.
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
      });
      canvas.addEventListener('webglcontextrestored', () => {
        this.lost = false;
        this.#initGL();
        this.onRestore?.();
      });
    } else this.ctx2d = canvas.getContext('2d');
    this.columns = new Float32Array(0);
  }

  get webgl() {
    return Boolean(this.gl);
  }

  #initGL() {
    const gl = this.gl;
    this.columnProg = program(gl, COLUMN_VS, COLUMN_FS);
    this.lineProg = program(gl, LINE_VS, COLUMN_FS);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.instBuf = gl.createBuffer();
    this.lineBuf = gl.createBuffer();
    this.columnVao = gl.createVertexArray();
    gl.bindVertexArray(this.columnVao);
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
  }

  /** Matches the backing store to CSS size; returns device pixel size. */
  resize(width, height, dpr = window.devicePixelRatio || 1) {
    const w = Math.max(1, Math.round(width * dpr));
    const hh = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== hh) {
      this.canvas.width = w;
      this.canvas.height = hh;
    }
    this.dpr = dpr;
    return [w, hh];
  }

  /**
   * Draws channels into horizontal lanes.
   * @param {object} p
   * @param {Channel[]} p.channels
   * @param {number} p.start first frame at the left edge
   * @param {number} p.fpp frames per device pixel
   * @param {number} p.amp vertical zoom
   * @param {{top:number,bottom:number}[]} p.lanes lane rectangles in device pixels
   * @param {string[]} p.colors CSS colors per channel
   */
  draw({ channels, start, fpp, amp, lanes, colors }) {
    if (this.lost) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (this.gl) this.#drawGL(channels, start, fpp, amp, lanes, colors, W, H);
    else this.#draw2d(channels, start, fpp, amp, lanes, colors, W, H);
  }

  #drawGL(channels, start, fpp, amp, lanes, colors, W, H) {
    const gl = this.gl;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const toClip = (y) => 1 - (y / H) * 2;
    channels.forEach((ch, i) => {
      const lane = lanes[i];
      if (!lane) return;
      const [r, g, b, a] = parseColor(colors[i] || colors[0]);
      const laneClip = [toClip(lane.top), toClip(lane.bottom)];
      if (fpp > 1) {
        const cols = W;
        if (this.columns.length < cols * 2) this.columns = new Float32Array(cols * 2);
        const data = channelColumns(ch, start, fpp, cols, this.columns);
        // Expand each column by a hair so flat silence stays visible.
        const minSpan = (2 / Math.max(1, lane.bottom - lane.top)) / Math.max(amp, 1e-6);
        let first = 0;
        while (first < cols && Number.isNaN(data[2 * first])) first++;
        let last = cols - 1;
        while (last >= first && Number.isNaN(data[2 * last])) last--;
        if (last < first) return;
        for (let c = first; c <= last; c++) {
          const lo = data[2 * c];
          const hi = data[2 * c + 1];
          if (hi - lo < minSpan) {
            const m = (lo + hi) / 2;
            data[2 * c] = m - minSpan / 2;
            data[2 * c + 1] = m + minSpan / 2;
          }
        }
        const sub = data.subarray(2 * first, 2 * (last + 1));
        const P = this.columnProg;
        gl.useProgram(P.p);
        gl.uniform1f(P.u.uCols, cols);
        gl.uniform1f(P.u.uColOffset, first);
        gl.uniform2f(P.u.uLane, laneClip[0], laneClip[1]);
        gl.uniform1f(P.u.uAmp, amp);
        gl.uniform4f(P.u.uColor, r * a, g * a, b * a, a);
        gl.bindVertexArray(this.columnVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
        gl.bufferData(gl.ARRAY_BUFFER, sub, gl.STREAM_DRAW);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, last - first + 1);
      } else {
        const s0 = Math.max(0, Math.floor(start) - 1);
        const s1 = Math.min(ch.length, Math.ceil(start + W * fpp) + 2);
        if (s1 <= s0) return;
        const samples = ch.toArray(s0, s1);
        const P = this.lineProg;
        gl.useProgram(P.p);
        const pxPerSample = 1 / fpp;
        gl.uniform1f(P.u.uFirstX, (((s0 - start) * pxPerSample) / W) * 2 - 1);
        gl.uniform1f(P.u.uStepX, (pxPerSample / W) * 2);
        gl.uniform2f(P.u.uLane, laneClip[0], laneClip[1]);
        gl.uniform1f(P.u.uAmp, amp);
        gl.uniform4f(P.u.uColor, r * a, g * a, b * a, a);
        gl.bindVertexArray(this.lineVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
        gl.bufferData(gl.ARRAY_BUFFER, samples, gl.STREAM_DRAW);
        gl.uniform1f(P.u.uPoint, 1);
        gl.drawArrays(gl.LINE_STRIP, 0, samples.length);
        if (pxPerSample >= 6 * (this.dpr || 1)) {
          gl.uniform1f(P.u.uPoint, Math.min(7, 3 * (this.dpr || 1)));
          gl.drawArrays(gl.POINTS, 0, samples.length);
        }
      }
    });
    gl.bindVertexArray(null);
  }

  #draw2d(channels, start, fpp, amp, lanes, colors, W, H) {
    const ctx = this.ctx2d;
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    channels.forEach((ch, i) => {
      const lane = lanes[i];
      if (!lane) return;
      const mid = (lane.top + lane.bottom) / 2;
      const half = (lane.bottom - lane.top) / 2;
      ctx.fillStyle = colors[i] || colors[0];
      ctx.strokeStyle = colors[i] || colors[0];
      if (fpp > 1) {
        if (this.columns.length < W * 2) this.columns = new Float32Array(W * 2);
        const data = channelColumns(ch, start, fpp, W, this.columns);
        for (let c = 0; c < W; c++) {
          const lo = data[2 * c];
          if (Number.isNaN(lo)) continue;
          const hi = data[2 * c + 1];
          const y0 = mid - Math.max(-1, Math.min(1, hi * amp)) * half;
          const y1 = mid - Math.max(-1, Math.min(1, lo * amp)) * half;
          ctx.fillRect(c, y0, 1, Math.max(1, y1 - y0));
        }
      } else {
        const s0 = Math.max(0, Math.floor(start) - 1);
        const s1 = Math.min(ch.length, Math.ceil(start + W * fpp) + 2);
        const samples = ch.toArray(s0, s1);
        ctx.beginPath();
        for (let k = 0; k < samples.length; k++) {
          const x = (s0 + k - start) / fpp;
          const y = mid - Math.max(-1.05, Math.min(1.05, samples[k] * amp)) * half;
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    });
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteBuffer(this.cornerBuf);
    gl.deleteBuffer(this.instBuf);
    gl.deleteBuffer(this.lineBuf);
    gl.deleteVertexArray(this.columnVao);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteProgram(this.columnProg.p);
    gl.deleteProgram(this.lineProg.p);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
