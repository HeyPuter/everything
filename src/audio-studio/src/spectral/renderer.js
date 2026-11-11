// WebGL2 spectrogram renderer. Each tile is an R8 texture (one row per
// analysis column, one texel per bin, bytes = dB from FLOOR_DB to 0). The
// fragment shader maps each pixel's height to a frequency on the current
// linear or logarithmic axis, samples the tile with linear filtering, maps dB
// through the user's range and looks the level up in a colour map texture.

import { FLOOR_DB } from './tiles.js';

const VS = `#version 300 es
layout(location = 0) in vec2 corner;
uniform vec2 uX;      // clip-space x of the tile's left and right edges
out vec2 vUv;
void main() {
  vUv = corner;
  gl_Position = vec4(mix(uX.x, uX.y, corner.x), corner.y * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uLut;
uniform float uBins;
uniform float uNyq;
uniform float uLog;
uniform float uLo;
uniform float uHi;
uniform float uFloor;
uniform vec2 uRange;   // min dB, max dB
out vec4 color;
// Bin (texel x) at a height in the lane: 0 bottom, 1 top.
float binAt(float y) {
  float f = uLog > 0.5 ? uLo * pow(uHi / uLo, y) : mix(uLo, uHi, y);
  return clamp(f / uNyq, 0.0, 1.0) * (uBins - 1.0);
}
void main() {
  // A pixel can span many bins (high frequencies on a log axis, or a large
  // FFT): show the loudest of them so narrow tones do not vanish between
  // pixel centres.
  float dy = 0.5 * abs(dFdy(vUv.y));
  float b0 = binAt(vUv.y - dy);
  float b1 = binAt(vUv.y + dy);
  float v;
  if (b1 - b0 <= 1.0) {
    v = texture(uTex, vec2((binAt(vUv.y) + 0.5) / uBins, vUv.x)).r;
  } else {
    float first = floor(b0 + 0.5);
    float count = floor(b1 + 0.5) - first;
    float step = max(1.0, count / 32.0);
    v = 0.0;
    for (int i = 0; i <= 32; i++) {
      float b = first + float(i) * step;
      if (b > first + count) break;
      v = max(v, texture(uTex, vec2((b + 0.5) / uBins, vUv.x)).r);
    }
  }
  float db = uFloor * (1.0 - v);
  float t = clamp((db - uRange.x) / (uRange.y - uRange.x), 0.0, 1.0);
  color = texture(uLut, vec2(t, 0.5));
}`;

/**
 * Tile bytes (`cols` rows of `bins` values) narrowed to at most `max` texels
 * per row: each texel keeps the loudest of `k` neighbouring bins, so texel j
 * covers bins [j * k, j * k + k). Returns { bytes, width }.
 */
export function fitBins(bytes, bins, cols, max) {
  if (!(max > 0) || bins <= max) return { bytes, width: bins };
  const k = Math.ceil(bins / max);
  const width = Math.ceil(bins / k);
  const out = new Uint8Array(width * cols);
  for (let c = 0; c < cols; c++) {
    const src = c * bins;
    const dst = c * width;
    for (let b = 0; b < bins; b++) {
      const j = dst + Math.floor(b / k);
      if (bytes[src + b] > out[j]) out[j] = bytes[src + b];
    }
  }
  return { bytes: out, width };
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class SpectrogramRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.lutKey = '';
    try {
      this.gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
    } catch {
      this.gl = null;
    }
    if (this.gl) this.#init();
    canvas.addEventListener?.('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener?.('webglcontextrestored', () => {
      this.lost = false;
      this.#init();
      this.lutKey = '';
      this.onRestore?.();
    });
  }

  get available() {
    return Boolean(this.gl) && !this.lost;
  }

  #init() {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p;
    this.u = {};
    for (const n of ['uX', 'uTex', 'uLut', 'uBins', 'uNyq', 'uLog', 'uLo', 'uHi', 'uFloor', 'uRange']) this.u[n] = gl.getUniformLocation(p, n);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.lut = gl.createTexture();
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.widths = new WeakMap(); // texture -> texels per row, when bins were combined
  }

  resize(width, height, dpr) {
    this.dpr = dpr;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /** Uploads a colour map (256 RGBA entries) when it changed. */
  setLut(key, rgba) {
    if (!this.available || key === this.lutKey) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.lutKey = key;
  }

  /** Creates a texture for tile bytes (cols rows of bins texels); returns null without WebGL. */
  createTile(bytes, bins, cols) {
    if (!this.available) return null;
    const gl = this.gl;
    // Wider than the GPU allows (8192-point FFTs on 4096-texel GPUs): keep the loudest of neighbouring bins.
    const fit = fitBins(bytes, bins, cols, this.maxTexture);
    const tex = gl.createTexture();
    this.widths.set(tex, fit.width);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, fit.width, cols, 0, gl.RED, gl.UNSIGNED_BYTE, fit.bytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  deleteTile(tex) {
    if (tex && this.gl && !this.lost) this.gl.deleteTexture(tex);
  }

  /**
   * Draws lanes. frame = {
   *   lanes: [{ top, bottom, tiles: [{ tex, bins, x0, x1 }] }],  CSS px and document frames
   *   start, fpp (document frames per CSS px), width,
   *   scale: { log, lo, hi }, nyquist, range: [minDb, maxDb], background: [r, g, b, a]
   * }
   */
  draw(frame) {
    if (!this.available) return;
    const gl = this.gl;
    const dpr = this.dpr || 1;
    const W = this.canvas.width;
    const H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.uniform1i(this.u.uLut, 1);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1f(this.u.uNyq, frame.nyquist);
    gl.uniform1f(this.u.uLog, frame.scale.log ? 1 : 0);
    gl.uniform1f(this.u.uLo, frame.scale.lo);
    gl.uniform1f(this.u.uHi, frame.scale.hi);
    gl.uniform1f(this.u.uFloor, FLOOR_DB);
    gl.uniform2f(this.u.uRange, frame.range[0], frame.range[1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.SCISSOR_TEST);
    const [br, bg, bb, ba] = frame.background;
    for (const lane of frame.lanes) {
      const y0 = Math.round(H - lane.bottom * dpr);
      const y1 = Math.round(H - lane.top * dpr);
      if (y1 <= y0) continue;
      gl.viewport(0, y0, W, y1 - y0);
      gl.scissor(0, y0, W, y1 - y0);
      gl.clearColor(br, bg, bb, ba);
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (const t of lane.tiles) {
        const xa = (t.x0 - frame.start) / frame.fpp;
        const xb = (t.x1 - frame.start) / frame.fpp;
        if (xb < 0 || xa > frame.width) continue;
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.uniform1f(this.u.uBins, this.widths.get(t.tex) ?? t.bins);
        gl.uniform2f(this.u.uX, (xa / frame.width) * 2 - 1, (xb / frame.width) * 2 - 1);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
  }

  dispose() {
    const ext = this.gl?.getExtension('WEBGL_lose_context');
    ext?.loseContext();
    this.gl = null;
  }
}
