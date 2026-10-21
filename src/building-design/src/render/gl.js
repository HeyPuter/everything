/**
 * Small WebGL2 helpers: programs, buffers, the per-element state texture.
 */

export function createProgram(gl, vs, fs, name = 'program') {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`${name}: shader compile failed: ${log}`);
    }
    return s;
  };
  const p = gl.createProgram();
  const v = compile(gl.VERTEX_SHADER, vs);
  const f = compile(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name}: link failed: ${gl.getProgramInfoLog(p)}`);
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const key = info.name.replace(/\[0\]$/, '');
    uniforms[key] = gl.getUniformLocation(p, info.name);
  }
  return { program: p, u: uniforms };
}

/**
 * Per-element flags in an R8UI texture (one texel per element index):
 * 1 selected, 2 hovered, 4 hidden, 8 halftone, 16 isolated-out.
 */
export const FLAG = { selected: 1, hover: 2, hidden: 4, halftone: 8, dim: 16, color: 32, transparent: 64 };

export class StateTexture {
  constructor(gl, width = 1024) {
    this.gl = gl;
    this.width = width;
    this.rows = 1;
    this.data = new Uint8Array(width);
    // Per-element colour override (rgb) and opacity (a), for 3D views.
    this.rgba = new Uint8Array(width * 4);
    this.tex = gl.createTexture();
    this.ctex = gl.createTexture();
    this.dirty = true;
    this.alloc();
  }

  alloc() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, this.width, this.rows, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.data);
    this.dirty = false;
  }

  ensure(count) {
    const need = Math.ceil((count + 1) / this.width);
    if (need > this.rows) {
      const rows = Math.max(need, this.rows * 2);
      const d = new Uint8Array(this.width * rows);
      d.set(this.data);
      this.data = d;
      const c = new Uint8Array(this.width * rows * 4);
      c.set(this.rgba);
      this.rgba = c;
      this.rows = rows;
      this.dirty = true;
    }
  }

  /** Replace all flags: [element index, flags, rgba?] entries. */
  setAll(entries) {
    this.data.fill(0);
    let max = 0;
    for (const [i] of entries) if (i > max) max = i;
    this.ensure(max);
    this.rgba.fill(255);
    this.anySeeThrough = false;
    for (const [i, f, c] of entries) {
      this.data[i] = f;
      if (f & 64) this.anySeeThrough = true;
      if (c) this.rgba.set(c, i * 4);
    }
    this.dirty = true;
  }

  bind(unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.dirty) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, this.width, this.rows, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.data);
      gl.bindTexture(gl.TEXTURE_2D, this.ctex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.rgba);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      this.dirty = false;
    }
  }

  /** Bind the colour override texture (after bind(), which uploads it). */
  bindColors(unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.ctex);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose() {
    this.gl.deleteTexture(this.tex);
    this.gl.deleteTexture(this.ctex);
  }
}

/** GLSL helper for reading element flags. */
export const STATE_GLSL = /* glsl */ `
uniform highp usampler2D uState;
uniform int uStateW;
uint stateOf(uint idx) {
  int i = int(idx);
  return texelFetch(uState, ivec2(i % uStateW, i / uStateW), 0).r;
}
`;

/** Parse a CSS colour (#rrggbb or rgb()) into [r, g, b] in 0..1. */
export function cssColor(str, fallback = [0, 0, 0]) {
  const s = String(str || '').trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16) / 255);
  m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(s);
  if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
  return fallback;
}

/** Growable typed array builder. */
export class Grow {
  constructor(Type, initial = 1024) {
    this.Type = Type;
    this.a = new Type(initial);
    this.n = 0;
  }

  reserve(k) {
    if (this.n + k > this.a.length) {
      let cap = this.a.length * 2;
      while (cap < this.n + k) cap *= 2;
      const b = new this.Type(cap);
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
  }

  push(v) {
    if (this.n >= this.a.length) this.reserve(1);
    this.a[this.n++] = v;
  }

  view() {
    return this.a.subarray(0, this.n);
  }
}
