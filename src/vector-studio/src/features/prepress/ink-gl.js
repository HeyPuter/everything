/**
 * GPU pass for the ink previews: the finished art canvas goes through a
 * 3D lookup table in a WebGL2 fragment shader, either
 *   proof        RGB -> proofed RGB, or
 *   separations  RGB -> CMYK plates, then the visible plates (and spot
 *                plates rendered separately) are printed over white with
 *                their ink colors, or one plate shown as black on white.
 * The result is drawn back onto the 2D canvas. When WebGL2 is unavailable,
 * the same math runs on the CPU (inkPixels) at a reduced resolution.
 */

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
precision highp sampler2DArray;
in vec2 uv;
out vec4 o;
uniform sampler2D src;
uniform sampler3D lut;
uniform sampler2DArray spots;
uniform int mode;
uniform float lutN;
uniform vec4 show;
uniform vec3 absorb[4];
uniform float gain;
uniform vec3 blackRel;
uniform int single;
uniform int spotCount;
uniform vec3 spotAbsorb[8];
uniform float spotShow[8];
float area(float v) { return clamp(v + gain * 4.0 * v * (1.0 - v), 0.0, 1.0); }
void main() {
  vec4 s = texture(src, uv);
  vec3 q = (s.rgb * (lutN - 1.0) + 0.5) / lutN;
  vec4 t = texture(lut, q);
  if (mode == 0) { o = vec4(t.rgb, s.a); return; }
  vec3 c = vec3(1.0);
  for (int i = 0; i < 4; i++) if (show[i] > 0.5) c *= 1.0 - area(t[i]) * absorb[i];
  for (int i = 0; i < 8; i++) {
    if (i >= spotCount) break;
    if (spotShow[i] > 0.5) c *= 1.0 - (1.0 - texture(spots, vec3(uv, float(i))).r) * spotAbsorb[i];
  }
  c = clamp((c - blackRel) / max(vec3(1e-4), 1.0 - blackRel), 0.0, 1.0);
  if (single >= 0) {
    float v = single < 4 ? area(t[single]) : 1.0 - texture(spots, vec3(uv, float(single - 4))).r;
    c = vec3(1.0 - v);
  }
  o = vec4(c, 1.0);
}`;

let shared = null;

function setup() {
  if (shared !== null) return shared;
  shared = false;
  try {
    if (typeof document === 'undefined') return shared;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl || typeof gl.createShader !== 'function') return shared;
    const sh = (type, text) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = (target) => {
      const t = gl.createTexture();
      gl.bindTexture(target, t);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (target !== gl.TEXTURE_2D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      return t;
    };
    gl.activeTexture(gl.TEXTURE0);
    const src = tex(gl.TEXTURE_2D);
    gl.activeTexture(gl.TEXTURE1);
    const lut = tex(gl.TEXTURE_3D);
    gl.activeTexture(gl.TEXTURE2);
    const spots = tex(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    const u = (n) => gl.getUniformLocation(prog, n);
    gl.uniform1i(u('src'), 0);
    gl.uniform1i(u('lut'), 1);
    gl.uniform1i(u('spots'), 2);
    shared = { canvas, gl, src, lut, spots, u, lutKey: null, spotSize: '' };
  } catch {
    shared = false;
  }
  return shared;
}

/** Whether the GPU path is available. */
export function gpuAvailable() {
  return Boolean(setup());
}

function uploadLut(s, lut) {
  if (s.lutKey === lut) return;
  const { gl } = s;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, s.lut);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lut.n, lut.n, lut.n, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data);
  s.lutKey = lut;
}

/**
 * Run the pass on `source` (a canvas). params:
 *   mode 'proof' | 'separations', lut { n, data: Uint8Array (b fastest... r slowest? see lutTexture) },
 *   show [c, m, y, k] booleans, absorb [[r, g, b] x4], gain, blackRel [r, g, b],
 *   single (-1 or plate index; 4+ for spots), spots [{ canvas, absorb, show }]
 * Returns the GL canvas holding the result, or null when the GPU path is unavailable.
 */
export function runInkPass(source, params) {
  const s = setup();
  if (!s) return null;
  const { gl, canvas } = s;
  const w = source.width;
  const hgt = source.height;
  if (canvas.width !== w || canvas.height !== hgt) {
    canvas.width = w;
    canvas.height = hgt;
  }
  gl.viewport(0, 0, w, hgt);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s.src);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  uploadLut(s, params.lut);
  const spots = (params.spots || []).slice(0, 8);
  if (spots.length) {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, s.spots);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, w, hgt, spots.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    spots.forEach((sp, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, w, hgt, 1, gl.RGBA, gl.UNSIGNED_BYTE, sp.canvas));
  }
  const { u } = s;
  gl.uniform1i(u('mode'), params.mode === 'proof' ? 0 : 1);
  gl.uniform1f(u('lutN'), params.lut.n);
  gl.uniform4fv(u('show'), (params.show || [1, 1, 1, 1]).map((v) => (v ? 1 : 0)));
  gl.uniform3fv(u('absorb'), (params.absorb || [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]]).flat());
  gl.uniform1f(u('gain'), params.gain || 0);
  gl.uniform3fv(u('blackRel'), params.blackRel || [0, 0, 0]);
  gl.uniform1i(u('single'), params.single ?? -1);
  gl.uniform1i(u('spotCount'), spots.length);
  const sa = new Float32Array(24);
  const ss = new Float32Array(8);
  spots.forEach((sp, i) => {
    sa.set(sp.absorb, i * 3);
    ss[i] = sp.show ? 1 : 0;
  });
  gl.uniform3fv(u('spotAbsorb'), sa);
  gl.uniform1fv(u('spotShow'), ss);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas;
}

/**
 * The CPU version of the separations/proof pass on RGBA bytes (in place).
 * lutFn(r, g, b, out) writes 4 values (0..1): plates, or proofed RGB.
 * spots: [{ data (RGBA bytes of the spot plate pass), absorb, show }].
 */
export function inkPixels(data, params, lutFn) {
  const t = new Float32Array(4);
  const show = params.show || [1, 1, 1, 1];
  const absorb = params.absorb || [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]];
  const g = params.gain || 0;
  const bp = params.blackRel || [0, 0, 0];
  const area = (v) => Math.max(0, Math.min(1, v + g * 4 * v * (1 - v)));
  const spots = params.spots || [];
  const single = params.single ?? -1;
  for (let i = 0; i < data.length; i += 4) {
    lutFn(data[i], data[i + 1], data[i + 2], t);
    if (params.mode === 'proof') {
      data[i] = t[0] * 255 + 0.5;
      data[i + 1] = t[1] * 255 + 0.5;
      data[i + 2] = t[2] * 255 + 0.5;
      continue;
    }
    let r = 1;
    let gg = 1;
    let b = 1;
    for (let p = 0; p < 4; p++) {
      if (!show[p]) continue;
      const a = area(t[p]);
      r *= 1 - a * absorb[p][0];
      gg *= 1 - a * absorb[p][1];
      b *= 1 - a * absorb[p][2];
    }
    for (const sp of spots) {
      if (!sp.show) continue;
      const cov = 1 - sp.data[i] / 255;
      r *= 1 - cov * sp.absorb[0];
      gg *= 1 - cov * sp.absorb[1];
      b *= 1 - cov * sp.absorb[2];
    }
    r = (r - bp[0]) / Math.max(1e-4, 1 - bp[0]);
    gg = (gg - bp[1]) / Math.max(1e-4, 1 - bp[1]);
    b = (b - bp[2]) / Math.max(1e-4, 1 - bp[2]);
    if (single >= 0) {
      const v = single < 4 ? area(t[single]) : 1 - spots[single - 4].data[i] / 255;
      r = gg = b = 1 - v;
    }
    data[i] = Math.max(0, Math.min(1, r)) * 255 + 0.5;
    data[i + 1] = Math.max(0, Math.min(1, gg)) * 255 + 0.5;
    data[i + 2] = Math.max(0, Math.min(1, b)) * 255 + 0.5;
    data[i + 3] = 255;
  }
  return data;
}
