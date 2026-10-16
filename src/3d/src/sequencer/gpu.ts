// GPU compositor for the sequencer: a private WebGL2 context with half-float render targets.
// Frame space is in output pixels with y up (target texel (0,0) is the bottom-left pixel).
// Uploaded sources are straight-alpha, top-down images; targets hold premultiplied colour.
// The shader math mirrors blend.ts (unit tested) and is checked against it in the browser.
import type { BlendType, ColorBalanceData } from './types';
import { BLEND_ITEMS } from './strips';
import { brightContrastParams } from './blend';
import { CURVE_GLSL } from '../compositor/color/curvemap';

export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

/** An image to place into the frame: `w`/`h` are its logical size in output (render) pixels. */
export interface Source {
  tex: WebGLTexture;
  w: number;
  h: number;
  /** rows stored top-down (uploaded images) — targets are y-up */
  topDown: boolean;
  /** straight alpha (uploaded images) — targets are premultiplied */
  straight: boolean;
}

export const BLEND_INDEX: Record<string, number> = Object.fromEntries(BLEND_ITEMS.map(([k], i) => [k, i]));

const EFFECT_INDEX: Record<string, number> = { CROSS: 0, GAMMA_CROSS: 1, ADD: 2, SUBTRACT: 3, MULTIPLY: 4, ALPHA_OVER: 5, ALPHA_UNDER: 6, COLORMIX: 7, WIPE: 8 };

const VS_FULL = /* glsl */ `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }`;

const VS_PLACE = /* glsl */ `#version 300 es
in vec2 aPos; out vec2 vUv;
uniform mat3 uM; uniform vec4 uRect; uniform vec2 uImg; uniform vec2 uFrame;
void main() {
  vec2 p = mix(uRect.xy, uRect.zw, aPos);
  vUv = p / uImg;
  vec3 q = uM * vec3(p, 1.0);
  gl_Position = vec4(q.xy / uFrame * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_PLACE = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform int uTopDown; uniform int uStraight; uniform bvec2 uFlip;
void main() {
  vec2 uv = vUv;
  if (uFlip.x) uv.x = 1.0 - uv.x;
  if (uFlip.y) uv.y = 1.0 - uv.y;
  if (uTopDown == 1) uv.y = 1.0 - uv.y;
  vec4 c = texture(uTex, uv);
  if (uStraight == 1) c.rgb *= c.a;
  o = c;
}`;

const GLSL_BLEND = /* glsl */ `
vec3 rgb2hsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn, h = 0.0;
  if (d > 1e-12) {
    if (mx == c.r) h = (c.g - c.b) / d; else if (mx == c.g) h = 2.0 + (c.b - c.r) / d; else h = 4.0 + (c.r - c.g) / d;
    h /= 6.0; if (h < 0.0) h += 1.0;
  }
  return vec3(h, mx > 0.0 ? d / mx : 0.0, mx);
}
vec3 hsv2rgb(vec3 c) {
  float h = fract(c.x) * 6.0; float i = floor(h); float f = h - i;
  float v = c.z, s = c.y, p = v * (1.0 - s), q = v * (1.0 - f * s), t = v * (1.0 - (1.0 - f) * s);
  int k = int(i) % 6;
  if (k == 0) return vec3(v, t, p); if (k == 1) return vec3(q, v, p); if (k == 2) return vec3(p, v, t);
  if (k == 3) return vec3(p, q, v); if (k == 4) return vec3(t, p, v); return vec3(v, p, q);
}
float burn1(float b, float t) { return t <= 0.0 ? 0.0 : clamp(1.0 - (1.0 - b) / t, 0.0, 1.0); }
float dodge1(float b, float t) { return t >= 1.0 ? (b > 0.0 ? 1.0 : 0.0) : clamp(b / (1.0 - t), 0.0, 1.0); }
// mode ids follow BLEND_ITEMS
float bch(int m, float b, float t) {
  if (m == 2) return min(b, t);
  if (m == 3) return b * t;
  if (m == 4) return burn1(b, t);
  if (m == 5) return max(0.0, b + t - 1.0);
  if (m == 6) return max(b, t);
  if (m == 7) return 1.0 - (1.0 - b) * (1.0 - t);
  if (m == 8) return dodge1(b, t);
  if (m == 9) return b + t;
  if (m == 10) return b <= 0.5 ? 2.0 * b * t : 1.0 - 2.0 * (1.0 - b) * (1.0 - t);
  if (m == 11) { float scr = 1.0 - (1.0 - t) * (1.0 - b); return (1.0 - b) * t * b + b * scr; }
  if (m == 12) return t > 0.5 ? 1.0 - (1.0 - b) * (1.0 - (2.0 * t - 1.0)) : b * 2.0 * t;
  if (m == 13) return t > 0.5 ? dodge1(b, 2.0 * (t - 0.5)) : burn1(b, 2.0 * t);
  if (m == 14) return b + 2.0 * t - 1.0;
  if (m == 15) return t > 0.5 ? max(b, 2.0 * t - 1.0) : min(b, 2.0 * t);
  if (m == 16) return abs(b - t);
  if (m == 17) return b + t - 2.0 * b * t;
  if (m == 18) return b - t;
  return t;
}
vec3 bcol(int m, vec3 b, vec3 t) {
  if (m >= 19 && m <= 22) {
    vec3 hb = rgb2hsv(b), ht = rgb2hsv(t);
    if (m == 19) return ht.y > 0.0 ? hsv2rgb(vec3(ht.x, hb.y, hb.z)) : b;
    if (m == 20) return hb.y > 0.0 ? hsv2rgb(vec3(hb.x, ht.y, hb.z)) : b;
    if (m == 21) return ht.y > 0.0 ? hsv2rgb(vec3(ht.x, ht.y, hb.z)) : b;
    return hsv2rgb(vec3(hb.x, hb.y, ht.z));
  }
  return vec3(bch(m, b.r, t.r), bch(m, b.g, t.g), bch(m, b.b, t.b));
}
vec4 gammaCross(vec4 a, vec4 b, float fac) {
  float al = mix(a.a, b.a, fac);
  vec3 sa = a.a > 0.0 ? sqrt(max(a.rgb / a.a, 0.0)) : vec3(0.0);
  vec3 sb = b.a > 0.0 ? sqrt(max(b.rgb / b.a, 0.0)) : vec3(0.0);
  vec3 v = mix(sa, sb, fac);
  return vec4(v * v * al, al);
}
vec4 blendPx(int m, vec4 B, vec4 T, float fac) {
  if (m == 0) return T * fac;
  if (m == 1) return mix(B, T, fac);
  if (m == 23) return T * fac + B * (1.0 - T.a * fac);
  if (m == 24) return B + T * fac * (1.0 - B.a);
  if (m == 25) return gammaCross(B, T, fac);
  if (B.a <= 0.0) return B;
  vec3 bs = B.rgb / B.a;
  vec3 ts = T.a > 0.0 ? T.rgb / T.a : vec3(0.0);
  vec3 c = bcol(m, bs, ts);
  return vec4(clamp(mix(bs, c, fac * T.a), 0.0, 1.0) * B.a, B.a);
}
`;

const FS_BLEND = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uB; uniform sampler2D uT; uniform int uMode; uniform float uFac;
${GLSL_BLEND}
void main() { o = blendPx(uMode, texture(uB, vUv), texture(uT, vUv), uFac); }`;

const FS_EFFECT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uA; uniform sampler2D uC; uniform int uType; uniform float uFac; uniform int uMix;
uniform vec2 uSize; uniform int uWipe; uniform int uDir; uniform float uAngle; uniform float uBlur;
${GLSL_BLEND}
float smoothR(float a, float b, float x) { float t = clamp((x - a) / max(b - a, 1e-9), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float wipeMask(vec2 frag) {
  vec2 p = frag - uSize * 0.5;
  bool inv = uDir == 1;
  float f = inv ? 1.0 - uFac : uFac;
  if (uWipe == 3) {
    float a = mod(atan(p.y, p.x) - (inv ? -uAngle : uAngle), 6.283185307179586);
    if (inv) a = 6.283185307179586 - a;
    float s = a / 6.283185307179586;
    float soft = uBlur * 0.5;
    return soft > 0.0 ? 1.0 - smoothR(uFac - soft, uFac + soft, s) : (s < uFac ? 1.0 : 0.0);
  }
  vec2 d = vec2(-sin(uAngle), cos(uAngle));
  float half_ = (abs(d.x) * uSize.x + abs(d.y) * uSize.y) * 0.5;
  if (uWipe == 0) {
    float s = (dot(p, d) + half_) / (2.0 * half_);
    float edge = 1.0 - f, soft = uBlur * 0.5;
    float m = soft > 0.0 ? smoothR(edge - soft, edge + soft, s) : (s > edge ? 1.0 : 0.0);
    return inv ? 1.0 - m : m;
  }
  float s = uWipe == 1 ? abs(dot(p, d)) / half_ : length(p) / length(uSize * 0.5);
  float soft = uBlur * 0.5;
  float m = soft > 0.0 ? 1.0 - smoothR(f - soft, f + soft, s) : (s < f ? 1.0 : 0.0);
  return inv ? 1.0 - m : m;
}
void main() {
  vec4 a = texture(uA, vUv), c = texture(uC, vUv);
  if (uType == 0) o = mix(a, c, uFac);
  else if (uType == 1) o = gammaCross(a, c, uFac);
  else if (uType == 2) o = vec4(clamp(a.rgb + c.rgb * uFac, 0.0, 1.0), a.a);
  else if (uType == 3) o = vec4(clamp(a.rgb - c.rgb * uFac, 0.0, 1.0), a.a);
  else if (uType == 4) { vec3 s = c.a > 0.0 ? c.rgb / c.a : vec3(0.0); o = vec4(a.rgb * (1.0 - uFac + s * uFac), a.a); }
  else if (uType == 5) o = blendPx(23, c, a, uFac);
  else if (uType == 6) o = blendPx(23, a, c, uFac);
  else if (uType == 7) o = blendPx(uMix, a, c, uFac);
  else o = mix(a, c, wipeMask(gl_FragCoord.xy - 0.5));
}`;

const FS_COLOR = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform int uOp;
uniform float uSat; uniform float uMul; uniform int uMulAlpha;
uniform int uMethod; uniform vec3 uP0; uniform vec3 uP1; uniform vec3 uP2; uniform float uCbMul;
uniform vec2 uBC;
${GLSL_BLEND}
void main() {
  vec4 p = texture(uTex, vUv);
  if (p.a <= 0.0) { o = p; return; }
  vec3 c = p.rgb / p.a;
  float a = p.a;
  if (uOp == 0) {
    if (uSat != 1.0) { vec3 h = rgb2hsv(c); c = hsv2rgb(vec3(h.x, max(0.0, h.y * uSat), h.z)); }
    c *= uMul;
    if (uMulAlpha == 1) a = clamp(a * uMul, 0.0, 1.0);
  } else if (uOp == 1) {
    // uP0 = lift-1 / slope, uP1 = gain / offset, uP2 = gamma exponent / power exponent
    if (uMethod == 0) { c = c + uP0 * (1.0 - c); c = pow(max(c * uP1, 0.0), uP2); }
    else c = pow(max(c * uP0 + uP1, 0.0), uP2);
    c *= uCbMul;
  } else if (uOp == 2) {
    c = c * uBC.x + uBC.y;
  } else if (uOp == 3) {
    // white balance: uP0 is the colour that should become white
    c = c / max(uP0, vec3(1e-4));
  }
  o = vec4(max(c, 0.0) * a, a);
}`;

const FS_BLUR = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uStep; uniform float uSigma; uniform int uRadius;
void main() {
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = -64; i <= 64; i++) {
    if (i < -uRadius || i > uRadius) continue;
    float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
    vec2 uv = vUv + uStep * float(i);
    wsum += w;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    acc += texture(uTex, uv) * w;
  }
  o = acc / wsum;
}`;

const FS_GLOW = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform sampler2D uGlow; uniform int uStage; uniform float uThr; uniform float uClamp; uniform float uBoost; uniform int uOnly;
void main() {
  vec4 p = texture(uTex, vUv);
  if (uStage == 0) {
    vec3 c = p.a > 0.0 ? p.rgb / p.a : vec3(0.0);
    float i = max(c.r, max(c.g, c.b));
    float k = min(uClamp, max(0.0, i - uThr)) * uBoost;
    vec3 g = c * k * p.a;
    o = vec4(g, max(g.r, max(g.g, g.b)));
  } else {
    vec4 g = texture(uGlow, vUv);
    if (uOnly == 1) o = vec4(g.rgb, clamp(g.a, 0.0, 1.0));
    else o = vec4(p.rgb + g.rgb, clamp(p.a + g.a * (1.0 - p.a), 0.0, 1.0));
  }
}`;

const FS_FILL = /* glsl */ `#version 300 es
precision highp float;
out vec4 o; uniform vec4 uColor;
void main() { o = uColor; }`;

const FS_COPY = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o; uniform sampler2D uTex; uniform int uOpaque; uniform vec3 uBg;
void main() { vec4 c = texture(uTex, vUv); if (uOpaque == 1) { c.rgb += uBg * (1.0 - c.a); c.a = 1.0; } o = c; }`;

/** Modifier masks: keep the original where the mask is black, the modified image where white. */
const FS_MASKMIX = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o; uniform sampler2D uA; uniform sampler2D uB; uniform sampler2D uM;
void main() {
  vec4 m = texture(uM, vUv);
  float k = clamp(dot(m.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  o = mix(texture(uA, vUv), texture(uB, vUv), k);
}`;

/** Curves: combined curve, then the red / green / blue curves (rows 0–3 of the lookup table). */
const FS_CURVES = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o; uniform sampler2D uTex; uniform sampler2D uLut; uniform vec4 uP[4]; uniform vec3 uBlack; uniform vec3 uWhite;
${CURVE_GLSL}
void main() {
  vec4 p = texture(uTex, vUv);
  if (p.a <= 0.0) { o = p; return; }
  vec3 c = (p.rgb / p.a - uBlack) / max(uWhite - uBlack, vec3(1e-6));
  vec3 r = vec3(cmp_curve(uLut, uP[1], 1, cmp_curve(uLut, uP[0], 0, c.r)), cmp_curve(uLut, uP[2], 2, cmp_curve(uLut, uP[0], 0, c.g)), cmp_curve(uLut, uP[3], 3, cmp_curve(uLut, uP[0], 0, c.b)));
  o = vec4(max(r, 0.0) * p.a, p.a);
}`;

type Prog = { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> };

/** 3×3 column-major matrix (image pixels → frame pixels). */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export class Compositor {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  W = 1;
  H = 1;
  private float = false;
  private all: Target[] = [];
  private free: Target[] = [];
  private vao: WebGLVertexArrayObject;
  private progs: Record<string, Prog> = {};
  private texCache = new Map<object, { tex: WebGLTexture; w: number; h: number; used: number }>();
  lost = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 1;
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL 2 is not available for the sequencer');
    this.gl = gl;
    this.float = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.progs.place = this.program(VS_PLACE, FS_PLACE);
    this.progs.blend = this.program(VS_FULL, FS_BLEND);
    this.progs.effect = this.program(VS_FULL, FS_EFFECT);
    this.progs.color = this.program(VS_FULL, FS_COLOR);
    this.progs.blur = this.program(VS_FULL, FS_BLUR);
    this.progs.glow = this.program(VS_FULL, FS_GLOW);
    this.progs.fill = this.program(VS_FULL, FS_FILL);
    this.progs.copy = this.program(VS_FULL, FS_COPY);
    this.progs.maskmix = this.program(VS_FULL, FS_MASKMIX);
    this.progs.curves = this.program(VS_FULL, FS_CURVES);
  }

  private luts = new Map<string, WebGLTexture>();
  private lutParams = new Map<string, { data: Float32Array; params: Float32Array }>();

  /** Apply RGB curves (lookup table baked from the curve mapping, cached by its key). */
  curves(dst: Target, src: Target, key: string, bake: () => { data: Float32Array; params: Float32Array }, black: number[], white: number[]) {
    const gl = this.gl;
    let tex = this.luts.get(key);
    const lut = tex ? this.lutParams.get(key)! : bake();
    if (!tex) {
      tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, lut.data.length / 4 / 4, 4, 0, gl.RGBA, gl.FLOAT, lut.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      if (this.luts.size > 32) {
        const [k, t] = this.luts.entries().next().value!;
        gl.deleteTexture(t);
        this.luts.delete(k);
        this.lutParams.delete(k);
      }
      this.luts.set(key, tex);
      this.lutParams.set(key, { data: new Float32Array(0), params: lut.params });
    }
    this.bindTarget(dst);
    const u = this.use('curves');
    this.bindTex(0, src.tex);
    this.bindTex(1, tex);
    gl.uniform1i(u('uTex'), 0);
    gl.uniform1i(u('uLut'), 1);
    gl.uniform4fv(u('uP'), lut.params);
    gl.uniform3f(u('uBlack'), black[0] ?? 0, black[1] ?? 0, black[2] ?? 0);
    gl.uniform3f(u('uWhite'), white[0] ?? 1, white[1] ?? 1, white[2] ?? 1);
    this.draw();
  }

  /** dst = mix(original, modified, luminance of mask). */
  maskMix(dst: Target, original: Target, modified: Target, mask: Target) {
    const gl = this.gl;
    this.bindTarget(dst);
    const u = this.use('maskmix');
    this.bindTex(0, original.tex);
    this.bindTex(1, modified.tex);
    this.bindTex(2, mask.tex);
    gl.uniform1i(u('uA'), 0);
    gl.uniform1i(u('uB'), 1);
    gl.uniform1i(u('uM'), 2);
    this.draw();
  }

  private program(vs: string, fs: string): Prog {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Sequencer shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Sequencer program: ${gl.getProgramInfoLog(p)}`);
    return { p, u: new Map() };
  }

  private use(name: string) {
    const pr = this.progs[name];
    this.gl.useProgram(pr.p);
    return (n: string) => {
      if (!pr.u.has(n)) pr.u.set(n, this.gl.getUniformLocation(pr.p, n));
      return pr.u.get(n)!;
    };
  }

  // ------------------------------------------------------------------ targets

  /** Set the frame size; drops pooled targets when it changes. */
  resize(W: number, H: number) {
    W = Math.max(1, Math.round(W));
    H = Math.max(1, Math.round(H));
    if (W === this.W && H === this.H) return;
    for (const t of this.all) this.deleteTarget(t);
    this.all = [];
    this.free = [];
    this.W = W;
    this.H = H;
  }

  private deleteTarget(t: Target) {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  acquire(): Target {
    const t = this.free.pop();
    if (t) return t;
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.float ? gl.RGBA16F : gl.RGBA8, this.W, this.H);
    this.texParams(false);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const nt = { tex, fbo, w: this.W, h: this.H };
    this.all.push(nt);
    return nt;
  }

  release(t: Target | null | undefined) {
    if (!t) return;
    if (t.w !== this.W || t.h !== this.H || !this.all.includes(t)) return;
    if (!this.free.includes(t)) this.free.push(t);
  }

  get poolSize() {
    return this.all.length;
  }

  private texParams(nearest: boolean) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private bindTarget(t: Target | null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.w : this.canvas.width, t ? t.h : this.canvas.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
  }

  private draw() {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  private bindTex(unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  // ------------------------------------------------------------------ sources

  /** Upload a straight-alpha, top-down image (bitmap, video frame, canvas or raw RGBA8). */
  upload(src: TexImageSource | { data: Uint8Array | Uint8ClampedArray; width: number; height: number; bottomUp?: boolean }, w: number, h: number, existing?: WebGLTexture): Source {
    const gl = this.gl;
    const tex = existing ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if ('data' in src) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, src.width, src.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.data instanceof Uint8ClampedArray ? new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.byteLength) : src.data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.texParams(false);
    return { tex, w, h, topDown: !(src as { bottomUp?: boolean }).bottomUp, straight: true };
  }

  /** Upload once and keep (LRU) for persistent images keyed by an object (e.g. an ImageBitmap). */
  cached(key: object, src: TexImageSource, w: number, h: number): Source {
    const hit = this.texCache.get(key);
    if (hit) {
      hit.used = performance.now();
      return { tex: hit.tex, w, h, topDown: true, straight: true };
    }
    const s = this.upload(src, w, h);
    this.texCache.set(key, { tex: s.tex, w, h, used: performance.now() });
    if (this.texCache.size > 96) {
      const old = [...this.texCache.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, this.texCache.size - 96);
      for (const [k, v] of old) {
        this.gl.deleteTexture(v.tex);
        this.texCache.delete(k);
      }
    }
    return s;
  }

  dropSource(s: Source) {
    for (const v of this.texCache.values()) if (v.tex === s.tex) return;
    this.gl.deleteTexture(s.tex);
  }

  /** A target viewed as a full-frame source. */
  asSource(t: Target, w: number, h: number): Source {
    return { tex: t.tex, w, h, topDown: false, straight: false };
  }

  // ------------------------------------------------------------------ passes

  clear(t: Target, c: [number, number, number, number] = [0, 0, 0, 0]) {
    const gl = this.gl;
    this.bindTarget(t);
    gl.clearColor(c[0], c[1], c[2], c[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  fill(t: Target, premul: [number, number, number, number]) {
    this.clear(t, premul);
  }

  /** Draw `src` through matrix `M` into `dst` (cleared first). `crop` = [x0, y0, x1, y1] in source pixels (y up). */
  place(dst: Target, src: Source, M: Mat3, crop: [number, number, number, number], flipX: boolean, flipY: boolean, nearest: boolean) {
    const gl = this.gl;
    this.clear(dst);
    const u = this.use('place');
    this.bindTex(0, src.tex);
    this.texParams(nearest);
    gl.uniform1i(u('uTex'), 0);
    gl.uniformMatrix3fv(u('uM'), false, M);
    gl.uniform4f(u('uRect'), crop[0], crop[1], crop[2], crop[3]);
    gl.uniform2f(u('uImg'), src.w, src.h);
    gl.uniform2f(u('uFrame'), dst.w, dst.h);
    gl.uniform1i(u('uTopDown'), src.topDown ? 1 : 0);
    gl.uniform1i(u('uStraight'), src.straight ? 1 : 0);
    gl.uniform2i(u('uFlip'), flipX ? 1 : 0, flipY ? 1 : 0);
    this.draw();
    this.texParams(false);
  }

  blend(dst: Target, bottom: Target, top: Target, mode: BlendType, fac: number) {
    const gl = this.gl;
    this.bindTarget(dst);
    const u = this.use('blend');
    this.bindTex(0, bottom.tex);
    this.bindTex(1, top.tex);
    gl.uniform1i(u('uB'), 0);
    gl.uniform1i(u('uT'), 1);
    gl.uniform1i(u('uMode'), BLEND_INDEX[mode] ?? 23);
    gl.uniform1f(u('uFac'), fac);
    this.draw();
  }

  effect(dst: Target, a: Target, c: Target, type: string, fac: number, opts: { mix?: BlendType; wipe?: { type: number; dir: number; angle: number; blur: number } } = {}) {
    const gl = this.gl;
    this.bindTarget(dst);
    const u = this.use('effect');
    this.bindTex(0, a.tex);
    this.bindTex(1, c.tex);
    gl.uniform1i(u('uA'), 0);
    gl.uniform1i(u('uC'), 1);
    gl.uniform1i(u('uType'), EFFECT_INDEX[type] ?? 0);
    gl.uniform1f(u('uFac'), fac);
    gl.uniform1i(u('uMix'), BLEND_INDEX[opts.mix ?? 'OVERLAY'] ?? 10);
    gl.uniform2f(u('uSize'), dst.w, dst.h);
    const w = opts.wipe ?? { type: 0, dir: 0, angle: 0, blur: 0 };
    gl.uniform1i(u('uWipe'), w.type);
    gl.uniform1i(u('uDir'), w.dir);
    gl.uniform1f(u('uAngle'), w.angle);
    gl.uniform1f(u('uBlur'), w.blur);
    this.draw();
  }

  /** Strip colour adjustments (saturation, multiply). */
  stripColor(dst: Target, src: Target, saturation: number, multiply: number, multiplyAlpha: boolean) {
    const gl = this.gl;
    this.bindTarget(dst);
    const u = this.use('color');
    this.bindTex(0, src.tex);
    gl.uniform1i(u('uTex'), 0);
    gl.uniform1i(u('uOp'), 0);
    gl.uniform1f(u('uSat'), saturation);
    gl.uniform1f(u('uMul'), multiply);
    gl.uniform1i(u('uMulAlpha'), multiplyAlpha ? 1 : 0);
    this.draw();
  }

  colorBalance(dst: Target, src: Target, cb: ColorBalanceData, multiply: number) {
    const gl = this.gl;
    this.bindTarget(dst);
    const u = this.use('color');
    this.bindTex(0, src.tex);
    gl.uniform1i(u('uTex'), 0);
    gl.uniform1i(u('uOp'), 1);
    const inv = (v: number) => 1 / (v || 1e-6);
    if (cb.correction_method === 'OFFSET_POWER_SLOPE') {
      gl.uniform1i(u('uMethod'), 1);
      gl.uniform3fv(u('uP0'), cb.slope.map((v) => (cb.invert_slope ? inv(v) : v)));
      gl.uniform3fv(u('uP1'), cb.offset.map((v) => (cb.invert_offset ? -(v - 1) : v - 1)));
      gl.uniform3fv(u('uP2'), cb.power.map((v) => (cb.invert_power ? v : inv(v))));
    } else {
      gl.uniform1i(u('uMethod'), 0);
      gl.uniform3fv(u('uP0'), cb.lift.map((v) => (cb.invert_lift ? 2 - v : v) - 1));
      gl.uniform3fv(u('uP1'), cb.gain.map((v) => (cb.invert_gain ? inv(v) : v)));
      gl.uniform3fv(u('uP2'), cb.gamma.map((v) => (cb.invert_gamma ? v : inv(v))));
    }
    gl.uniform1f(u('uCbMul'), multiply);
    this.draw();
  }

  brightContrast(dst: Target, src: Target, bright: number, contrast: number) {
    const gl = this.gl;
    this.bindTarget(dst);
    const u = this.use('color');
    this.bindTex(0, src.tex);
    gl.uniform1i(u('uTex'), 0);
    gl.uniform1i(u('uOp'), 2);
    const [a, b] = brightContrastParams(bright, contrast);
    gl.uniform2f(u('uBC'), a, b);
    this.draw();
  }

  whiteBalance(dst: Target, src: Target, white: number[]) {
    const gl = this.gl;
    this.bindTarget(dst);
    const u = this.use('color');
    this.bindTex(0, src.tex);
    gl.uniform1i(u('uTex'), 0);
    gl.uniform1i(u('uOp'), 3);
    gl.uniform3f(u('uP0'), white[0] ?? 1, white[1] ?? 1, white[2] ?? 1);
    this.draw();
  }

  /** Separable gaussian blur (zero outside the frame); sigma in pixels per axis. */
  blur(dst: Target, src: Target, sx: number, sy: number) {
    const tmp = this.acquire();
    this.blurPass(tmp, src, 1 / src.w, 0, sx);
    this.blurPass(dst, tmp, 0, 1 / src.h, sy);
    this.release(tmp);
  }

  private blurPass(dst: Target, src: Target, dx: number, dy: number, sigma: number) {
    const gl = this.gl;
    this.bindTarget(dst);
    const u = this.use('blur');
    this.bindTex(0, src.tex);
    gl.uniform1i(u('uTex'), 0);
    // large radii are sampled sparsely (step > 1 texel) to stay within 64 taps
    const s = Math.max(0.01, sigma);
    const radius = Math.ceil(s * 2.5);
    const stride = Math.max(1, Math.ceil(radius / 64));
    gl.uniform2f(u('uStep'), dx * stride, dy * stride);
    gl.uniform1f(u('uSigma'), s / stride);
    gl.uniform1i(u('uRadius'), Math.min(64, Math.ceil(radius / stride)));
    this.draw();
  }

  glow(dst: Target, src: Target, threshold: number, clamp: number, boost: number, sigma: number, onlyBoost: boolean) {
    const gl = this.gl;
    const g = this.acquire();
    this.bindTarget(g);
    let u = this.use('glow');
    this.bindTex(0, src.tex);
    gl.uniform1i(u('uTex'), 0);
    gl.uniform1i(u('uStage'), 0);
    gl.uniform1f(u('uThr'), threshold);
    gl.uniform1f(u('uClamp'), clamp);
    gl.uniform1f(u('uBoost'), boost);
    this.draw();
    const gb = this.acquire();
    this.blur(gb, g, sigma, sigma);
    this.bindTarget(dst);
    u = this.use('glow');
    this.bindTex(0, src.tex);
    this.bindTex(1, gb.tex);
    gl.uniform1i(u('uTex'), 0);
    gl.uniform1i(u('uGlow'), 1);
    gl.uniform1i(u('uStage'), 1);
    gl.uniform1i(u('uOnly'), onlyBoost ? 1 : 0);
    this.draw();
    this.release(g);
    this.release(gb);
  }

  copy(dst: Target, src: Target) {
    const gl = this.gl;
    this.bindTarget(dst);
    const u = this.use('copy');
    this.bindTex(0, src.tex);
    gl.uniform1i(u('uTex'), 0);
    gl.uniform1i(u('uOpaque'), 0);
    this.draw();
  }

  /** Draw a target to the compositor canvas (resized to the target), optionally over a background. */
  present(src: Target, background: [number, number, number] | null = null) {
    const gl = this.gl;
    if (this.canvas.width !== src.w || this.canvas.height !== src.h) {
      this.canvas.width = src.w;
      this.canvas.height = src.h;
    }
    this.bindTarget(null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const u = this.use('copy');
    this.bindTex(0, src.tex);
    gl.uniform1i(u('uTex'), 0);
    gl.uniform1i(u('uOpaque'), background ? 1 : 0);
    gl.uniform3fv(u('uBg'), background ?? [0, 0, 0]);
    this.draw();
  }

  /** Read a target as straight-alpha RGBA8, top-down rows. */
  read(src: Target): Uint8ClampedArray {
    this.present(src);
    const gl = this.gl;
    const W = src.w,
      H = src.h;
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const srow = (H - 1 - y) * W * 4;
      for (let x = 0; x < W * 4; x += 4) {
        const a = buf[srow + x + 3];
        const k = a > 0 ? 255 / a : 0;
        const d = y * W * 4 + x;
        out[d] = buf[srow + x] * k;
        out[d + 1] = buf[srow + x + 1] * k;
        out[d + 2] = buf[srow + x + 2] * k;
        out[d + 3] = a;
      }
    }
    return out;
  }

  /** Read one pixel of a target (premultiplied float, y up) — used for verification. */
  readPixel(src: Target, x: number, y: number): number[] {
    const gl = this.gl;
    this.bindTarget(src);
    if (this.float) {
      const b = new Float32Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, b);
      return Array.from(b);
    }
    const b = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
    return Array.from(b).map((v) => v / 255);
  }

  // ------------------------------------------------------------------ extension passes

  /** Premultiplied float RGBA of a target, rows bottom-up. */
  readFloat(src: Target): Float32Array {
    const gl = this.gl;
    this.bindTarget(src);
    const out = new Float32Array(src.w * src.h * 4);
    if (this.float) gl.readPixels(0, 0, src.w, src.h, gl.RGBA, gl.FLOAT, out);
    else {
      const b = new Uint8Array(src.w * src.h * 4);
      gl.readPixels(0, 0, src.w, src.h, gl.RGBA, gl.UNSIGNED_BYTE, b);
      for (let i = 0; i < b.length; i++) out[i] = b[i] / 255;
    }
    return out;
  }

  /** Upload premultiplied float RGBA (rows bottom-up) into a texture (reused when given). */
  uploadFloat(data: Float32Array, w: number, h: number, existing?: WebGLTexture): WebGLTexture {
    const gl = this.gl;
    const tex = existing ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    this.texParams(true);
    return tex;
  }

  deleteTexture(tex: WebGLTexture) {
    this.gl.deleteTexture(tex);
  }

  private lutTextures = new Map<string, WebGLTexture>();

  /**
   * Run a fragment shader over `dst` (compiled once per name). Textures bind to units in order
   * (as uniforms `uTex0`, `uTex1`, …); numbers and arrays of 2–4 / 9 / 16 become uniforms.
   */
  pass(name: string, fs: string, dst: Target, textures: WebGLTexture[], uniforms: Record<string, number | number[]> = {}) {
    const gl = this.gl;
    if (!this.progs[name]) this.progs[name] = this.program(VS_FULL, fs);
    this.bindTarget(dst);
    const u = this.use(name);
    textures.forEach((t, i) => {
      this.bindTex(i, t);
      gl.uniform1i(u(`uTex${i}`), i);
    });
    for (const [k, v] of Object.entries(uniforms)) {
      const loc = u(k);
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2fv(loc, v);
      else if (v.length === 3) gl.uniform3fv(loc, v);
      else if (v.length === 4) gl.uniform4fv(loc, v);
      else if (v.length === 9) gl.uniformMatrix3fv(loc, false, v);
      else if (v.length === 16) gl.uniformMatrix4fv(loc, false, v);
    }
    this.draw();
  }

  /** A float lookup table texture (width × 1 RGBA), cached by key. */
  lut(key: string, width: number, bake: () => Float32Array): WebGLTexture {
    const gl = this.gl;
    let tex = this.lutTextures.get(key);
    if (tex) return tex;
    tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, 1, 0, gl.RGBA, gl.FLOAT, bake());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    if (this.lutTextures.size > 32) {
      const [k, t] = this.lutTextures.entries().next().value!;
      gl.deleteTexture(t);
      this.lutTextures.delete(k);
    }
    this.lutTextures.set(key, tex);
    return tex;
  }

  private small: { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number } | null = null;

  /** Straight-alpha RGBA of a target scaled down to at most 64 pixels wide (for image statistics). */
  sample(src: Target): { data: Float32Array; w: number; h: number } {
    const gl = this.gl;
    const w = Math.max(1, Math.min(64, src.w)),
      h = Math.max(1, Math.round((src.h * w) / src.w));
    if (!this.small || this.small.w !== w || this.small.h !== h) {
      if (this.small) {
        gl.deleteTexture(this.small.tex);
        gl.deleteFramebuffer(this.small.fbo);
      }
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, this.float ? gl.RGBA16F : gl.RGBA8, w, h);
      this.texParams(false);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.small = { tex, fbo, w, h };
    }
    const t = { tex: this.small.tex, fbo: this.small.fbo, w, h };
    this.copy(t, src);
    this.bindTarget(t);
    const out = new Float32Array(w * h * 4);
    if (this.float) gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out);
    else {
      const b = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
      for (let i = 0; i < b.length; i++) out[i] = b[i] / 255;
    }
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3];
      if (a > 0) for (let k = 0; k < 3; k++) out[i + k] /= a;
    }
    return { data: out, w, h };
  }
}

/** Image → frame matrix for a strip transform (all in output pixels, y up), scaled by `k`. */
export function placementMatrix(W: number, H: number, w: number, h: number, t: { offset_x: number; offset_y: number; scale_x: number; scale_y: number; rotation: number; origin: [number, number] }, k = 1): Mat3 {
  const ox = t.origin[0] * w,
    oy = t.origin[1] * h;
  const c = Math.cos(t.rotation),
    s = Math.sin(t.rotation);
  // p' = k * (C + off + (o - c_img) + R S (p - o))
  const a = c * t.scale_x,
    b = s * t.scale_x,
    d = -s * t.scale_y,
    e = c * t.scale_y;
  const tx = W / 2 + t.offset_x + (ox - w / 2) - (a * ox + d * oy);
  const ty = H / 2 + t.offset_y + (oy - h / 2) - (b * ox + e * oy);
  return [k * a, k * b, 0, k * d, k * e, 0, k * tx, k * ty, 1];
}

/** Whether a placement is pixel-exact (AUTO filter → nearest). */
export function isPixelExact(m: Mat3) {
  const near = (v: number, t: number) => Math.abs(v - t) < 1e-6;
  return near(m[0], 1) && near(m[1], 0) && near(m[3], 0) && near(m[4], 1) && near(m[6], Math.round(m[6])) && near(m[7], Math.round(m[7]));
}
