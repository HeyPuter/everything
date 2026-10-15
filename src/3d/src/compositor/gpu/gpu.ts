// Minimal WebGL2 compute layer for the compositor: float (RGBA32F) textures, fullscreen fragment
// passes with multiple render targets, a texture pool and read-back. The compositor runs in its
// own context so it never disturbs the viewport renderer's GL state.
//
// Conventions: textures are stored bottom-up (row 0 = bottom, like GL and the
// compositor's pixel space); sampling is always done with texelFetch (NEAREST storage) and the
// helpers in glsl.ts, so float-linear filtering support is not required.
import { GLSL_COMMON } from './glsl';

export interface Texture {
  readonly tex: WebGLTexture;
  readonly w: number;
  readonly h: number;
  /** debugging / leak tracking */
  label?: string;
}

export type UniformValue = number | boolean | readonly number[] | Float32Array | Int32Array | Texture | null;

interface UniformInfo {
  loc: WebGLUniformLocation;
  type: number;
  size: number;
}

export interface Program {
  key: string;
  prog: WebGLProgram;
  uniforms: Map<string, UniformInfo>;
  outputs: number;
}

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

export class GpuError extends Error {}

export class Gpu {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private fbo: WebGLFramebuffer;
  private programs = new Map<string, Program>();
  private pool = new Map<string, WebGLTexture[]>();
  private vs: WebGLShader;
  /** textures currently allocated (not in the pool) */
  readonly live = new Set<Texture>();
  readonly maxSize: number;
  lost = false;

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.vao = gl.createVertexArray()!;
    this.fbo = gl.createFramebuffer()!;
    this.vs = this.compile(gl.VERTEX_SHADER, VERT);
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  /** Create the compositor GPU context (null when WebGL2 float render targets are unavailable). */
  static create(): Gpu | null {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) return null;
    if (!gl.getExtension('EXT_color_buffer_float')) return null;
    return new Gpu(canvas, gl);
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? '';
      gl.deleteShader(sh);
      const numbered = src
        .split('\n')
        .map((l, i) => `${i + 1}: ${l}`)
        .join('\n');
      console.error(`Compositor shader error:\n${log}\n${numbered}`);
      throw new GpuError(`Shader compile error: ${log.split('\n')[0]}`);
    }
    return sh;
  }

  /**
   * Program from a fragment body (GLSL after the common header/library). `outputs` is the number
   * of `layout(location = i) out vec4` targets the body declares.
   */
  program(key: string, body: string | (() => string), outputs = 1): Program {
    const hit = this.programs.get(key);
    if (hit) return hit;
    const gl = this.gl;
    const src = `${HEADER}${GLSL_COMMON}\n${typeof body === 'string' ? body : body()}`;
    const fs = this.compile(gl.FRAGMENT_SHADER, src);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, this.vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new GpuError(`Program link error: ${gl.getProgramInfoLog(prog)}`);
    const uniforms = new Map<string, UniformInfo>();
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i)!;
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(prog, info.name);
      if (loc) uniforms.set(name, { loc, type: info.type, size: info.size });
    }
    const p: Program = { key, prog, uniforms, outputs };
    this.programs.set(key, p);
    return p;
  }

  // -------------------------------------------------------------------------
  // textures

  alloc(w: number, h: number, label?: string): Texture {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w > this.maxSize || h > this.maxSize) throw new GpuError(`Image size ${w}×${h} exceeds the GPU limit of ${this.maxSize} px`);
    const gl = this.gl;
    const k = `${w}x${h}`;
    let tex = this.pool.get(k)?.pop();
    if (!tex) {
      tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    const t: Texture = { tex, w, h, label };
    this.live.add(t);
    return t;
  }

  free(t: Texture | null | undefined) {
    if (!t || !this.live.has(t)) return;
    this.live.delete(t);
    const k = `${t.w}x${t.h}`;
    let list = this.pool.get(k);
    if (!list) this.pool.set(k, (list = []));
    list.push(t.tex);
  }

  /** Release pooled (unused) textures, keeping at most `keep` bytes worth. */
  trim(keep = 0) {
    const gl = this.gl;
    let bytes = 0;
    for (const [k, list] of this.pool) {
      const [w, h] = k.split('x').map(Number);
      const size = w * h * 16;
      while (list.length && bytes + size > keep) gl.deleteTexture(list.pop()!);
      bytes += size * list.length;
      if (!list.length) this.pool.delete(k);
    }
  }

  /** Upload float RGBA data (rows in the order given: bottom-up unless the caller flips). */
  upload(data: Float32Array, w: number, h: number, label?: string): Texture {
    const t = this.alloc(w, h, label);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, data);
    return t;
  }

  /** Upload an 8-bit image source (image/canvas/bitmap) as a temporary RGBA8 texture, rows bottom-up. */
  uploadSource(src: TexImageSource, w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Wrap a raw texture handle for use as a sampler uniform (not pooled). */
  wrap(tex: WebGLTexture, w: number, h: number): Texture {
    return { tex, w, h, label: 'external' };
  }

  // -------------------------------------------------------------------------
  // passes

  /** Run a fullscreen pass of `prog` into `out` (one texture per program output). */
  run(prog: Program, out: Texture | Texture[], uniforms: Record<string, UniformValue> = {}) {
    const gl = this.gl;
    const outs = Array.isArray(out) ? out : [out];
    const w = outs[0].w,
      h = outs[0].h;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const bufs: number[] = [];
    for (let i = 0; i < outs.length; i++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, outs[i].tex, 0);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    }
    // detach stale attachments from an earlier pass with more outputs
    for (let i = outs.length; i < 4; i++) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers(bufs);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.prog);
    let unit = 0;
    const set = (name: string, v: UniformValue) => {
      const u = prog.uniforms.get(name);
      if (!u || v === undefined) return;
      switch (u.type) {
        case gl.SAMPLER_2D: {
          const t = v as Texture | null;
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, t ? t.tex : null);
          gl.uniform1i(u.loc, unit);
          unit++;
          return;
        }
        case gl.FLOAT:
          if (u.size > 1) gl.uniform1fv(u.loc, v as Float32Array);
          else gl.uniform1f(u.loc, typeof v === 'boolean' ? (v ? 1 : 0) : (v as number));
          return;
        case gl.FLOAT_VEC2:
          gl.uniform2fv(u.loc, v as Float32Array);
          return;
        case gl.FLOAT_VEC3:
          gl.uniform3fv(u.loc, v as Float32Array);
          return;
        case gl.FLOAT_VEC4:
          gl.uniform4fv(u.loc, v as Float32Array);
          return;
        case gl.INT:
        case gl.BOOL:
          if (u.size > 1) gl.uniform1iv(u.loc, v as Int32Array);
          else gl.uniform1i(u.loc, typeof v === 'boolean' ? (v ? 1 : 0) : Math.round(v as number));
          return;
        case gl.INT_VEC2:
          gl.uniform2iv(u.loc, (v as number[]).map(Math.round));
          return;
        case gl.INT_VEC4:
          gl.uniform4iv(u.loc, (v as number[]).map(Math.round));
          return;
        case gl.FLOAT_MAT3:
          gl.uniformMatrix3fv(u.loc, false, v as Float32Array);
          return;
        case gl.FLOAT_MAT4:
          gl.uniformMatrix4fv(u.loc, false, v as Float32Array);
          return;
        default:
          throw new GpuError(`Unsupported uniform type for ${name}`);
      }
    };
    for (const [k, v] of Object.entries(uniforms)) set(k, v);
    // unbound samplers would alias unit 0; bind them to nothing
    for (const [k, u] of prog.uniforms) if (u.type === gl.SAMPLER_2D && !(k in uniforms)) set(k, null);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    for (let i = 0; i < unit; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  /** Read a texture back as float RGBA (rows bottom-up, like the texture). */
  read(t: Texture, x = 0, y = 0, w = t.w, h = t.h): Float32Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    for (let i = 1; i < 4; i++) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, null, 0);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const out = new Float32Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
    return out;
  }

  /** Draw a texture through `prog` into the context's own canvas (for 8-bit display copies). */
  present(prog: Program, w: number, h: number, uniforms: Record<string, UniformValue>) {
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.prog);
    let unit = 0;
    for (const [k, v] of Object.entries(uniforms)) {
      const u = prog.uniforms.get(k);
      if (!u) continue;
      if (u.type === gl.SAMPLER_2D) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, (v as Texture).tex);
        gl.uniform1i(u.loc, unit++);
      } else if (u.type === gl.FLOAT) gl.uniform1f(u.loc, v as number);
      else if (u.type === gl.INT) gl.uniform1i(u.loc, v as number);
      else if (u.type === gl.FLOAT_VEC4) gl.uniform4fv(u.loc, v as Float32Array);
      else if (u.type === gl.FLOAT_VEC2) gl.uniform2fv(u.loc, v as Float32Array);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}

let shared: Gpu | null | undefined;
/** The shared compositor GPU context (created on first use). */
export function gpu(): Gpu | null {
  if (shared === undefined || shared?.lost) shared = Gpu.create();
  return shared;
}
