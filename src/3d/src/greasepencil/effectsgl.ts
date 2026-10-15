// GPU side of the grease pencil visual effects: each object is drawn into its own image, the
// effects run as full screen passes over it (premultiplied RGBA), then the result is composited.
import { Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector2, Vector4, WebGLRenderTarget, HalfFloatType, NoBlending, type Texture, type WebGLRenderer, LinearFilter } from 'three';
import type { ShaderFx } from './types';

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const common = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uRes;
  uniform vec2 uOrigin;
  varying vec2 vUv;
  vec4 src(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture2D(tSrc, uv); }
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

function material(body: string, uniforms: Record<string, { value: unknown }> = {}): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: common + body,
    uniforms: { tSrc: { value: null }, uRes: { value: new Vector2() }, uOrigin: { value: new Vector2() }, ...uniforms },
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
  });
}

// directional gaussian blur over `uRadius` pixels with uSamples taps per side
const blurMat = material(
  /* glsl */ `
  uniform vec2 uDir;
  uniform float uSamples;
  void main() {
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int i = -32; i <= 32; i++) {
      float fi = float(i);
      if (abs(fi) > uSamples) continue;
      float t = uSamples > 0.0 ? fi / uSamples : 0.0;
      float w = exp(-t * t * 2.0);
      acc += src(vUv + uDir * t / uRes) * w;
      wsum += w;
    }
    gl_FragColor = acc / max(wsum, 1e-5);
  }`,
  { uDir: { value: new Vector2() }, uSamples: { value: 8 } },
);

const colorizeMat = material(
  /* glsl */ `
  uniform int uMode;
  uniform float uFactor;
  uniform vec4 uLow;
  uniform vec4 uHigh;
  void main() {
    vec4 c = src(vUv);
    if (c.a <= 0.0) { gl_FragColor = c; return; }
    vec3 rgb = c.rgb / c.a;
    float l = luma(rgb);
    vec3 r = rgb;
    float a = c.a;
    if (uMode == 0) r = vec3(l);
    else if (uMode == 1) r = vec3(dot(rgb, vec3(0.393, 0.769, 0.189)), dot(rgb, vec3(0.349, 0.686, 0.168)), dot(rgb, vec3(0.272, 0.534, 0.131)));
    else if (uMode == 2) r = l > 0.5 ? uHigh.rgb : uLow.rgb;
    else if (uMode == 3) a = c.a * (1.0 - uFactor);
    else r = mix(uLow.rgb, uHigh.rgb, l);
    if (uMode != 3) r = mix(rgb, r, uFactor);
    gl_FragColor = vec4(r * a, a);
  }`,
  { uMode: { value: 0 }, uFactor: { value: 0.5 }, uLow: { value: new Vector4() }, uHigh: { value: new Vector4() } },
);

const flipMat = material(
  /* glsl */ `
  uniform vec2 uFlip;
  void main() {
    vec2 o = uOrigin / uRes;
    vec2 uv = vUv;
    if (uFlip.x > 0.5) uv.x = 2.0 * o.x - uv.x;
    if (uFlip.y > 0.5) uv.y = 2.0 * o.y - uv.y;
    gl_FragColor = src(uv);
  }`,
  { uFlip: { value: new Vector2() } },
);

const pixelMat = material(
  /* glsl */ `
  uniform vec2 uSize;
  uniform float uAA;
  void main() {
    vec2 s = max(uSize, vec2(1.0));
    vec2 cell = floor(vUv * uRes / s);
    vec2 uv = (cell + 0.5) * s / uRes;
    vec4 c = src(uv);
    if (uAA > 0.5) {
      // average the cell corners for softer blocks
      vec2 q = s * 0.25 / uRes;
      c = (c * 2.0 + src(uv + q) + src(uv - q) + src(uv + vec2(q.x, -q.y)) + src(uv + vec2(-q.x, q.y))) / 6.0;
    }
    gl_FragColor = c;
  }`,
  { uSize: { value: new Vector2(5, 5) }, uAA: { value: 1 } },
);

const swirlMat = material(
  /* glsl */ `
  uniform float uRadius;
  uniform float uAngle;
  uniform float uTransparent;
  void main() {
    vec2 p = vUv * uRes - uOrigin;
    float d = length(p);
    if (d < uRadius) {
      float t = 1.0 - d / uRadius;
      float a = uAngle * t * t;
      p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
    } else if (uTransparent > 0.5) { gl_FragColor = vec4(0.0); return; }
    gl_FragColor = src((p + uOrigin) / uRes);
  }`,
  { uRadius: { value: 100 }, uAngle: { value: 1.57 }, uTransparent: { value: 0 } },
);

const waveMat = material(
  /* glsl */ `
  uniform float uAmp;
  uniform float uPeriod;
  uniform float uPhase;
  uniform float uVertical;
  void main() {
    vec2 px = vUv * uRes;
    float k = 6.2831853 / max(uPeriod, 0.001);
    if (uVertical > 0.5) px.x += uAmp * sin(px.y * k + uPhase);
    else px.y += uAmp * sin(px.x * k + uPhase);
    gl_FragColor = src(px / uRes);
  }`,
  { uAmp: { value: 10 }, uPeriod: { value: 20 }, uPhase: { value: 0 }, uVertical: { value: 1 } },
);

// glow source: bright (or matching) parts, recolored
const glowMaskMat = material(
  /* glsl */ `
  uniform int uMode;
  uniform float uThreshold;
  uniform vec3 uSelect;
  uniform vec3 uGlow;
  void main() {
    vec4 c = src(vUv);
    if (c.a <= 0.0) { gl_FragColor = vec4(0.0); return; }
    vec3 rgb = c.rgb / c.a;
    float m = uMode == 0 ? step(uThreshold, luma(rgb)) : step(distance(rgb, uSelect), uThreshold);
    gl_FragColor = vec4(uGlow, 1.0) * c.a * m;
  }`,
  { uMode: { value: 0 }, uThreshold: { value: 0.1 }, uSelect: { value: new Vector4() }, uGlow: { value: new Vector4() } },
);

// shadow source: the object's alpha moved / scaled / rotated (and waved) around the origin
const shadowMaskMat = material(
  /* glsl */ `
  uniform vec2 uOffset;
  uniform vec2 uScale;
  uniform float uRot;
  uniform vec4 uColor;
  uniform float uWave;
  uniform float uVertical;
  uniform float uAmp;
  uniform float uPeriod;
  uniform float uPhase;
  void main() {
    vec2 p = vUv * uRes - uOrigin - uOffset;
    p = mat2(cos(-uRot), -sin(-uRot), sin(-uRot), cos(-uRot)) * p;
    p /= max(abs(uScale), vec2(0.001));
    p += uOrigin;
    if (uWave > 0.5) {
      float k = 6.2831853 / max(uPeriod, 0.001);
      if (uVertical > 0.5) p.x += uAmp * sin(p.y * k + uPhase); else p.y += uAmp * sin(p.x * k + uPhase);
    }
    float a = src(p / uRes).a;
    gl_FragColor = vec4(uColor.rgb, 1.0) * uColor.a * a;
  }`,
  { uOffset: { value: new Vector2() }, uScale: { value: new Vector2(1, 1) }, uRot: { value: 0 }, uColor: { value: new Vector4() }, uWave: { value: 0 }, uVertical: { value: 1 }, uAmp: { value: 10 }, uPeriod: { value: 20 }, uPhase: { value: 0 } },
);

// rim source: where the object is but its offset copy is not
const rimMaskMat = material(
  /* glsl */ `
  uniform vec2 uOffset;
  uniform vec3 uColor;
  void main() {
    float a = src(vUv).a;
    float b = src(vUv - uOffset / uRes).a;
    gl_FragColor = vec4(uColor, 1.0) * a * (1.0 - b);
  }`,
  { uOffset: { value: new Vector2() }, uColor: { value: new Vector4() } },
);

// combine an effect layer (tFx) with the object image: 0 over, 1 under, 2 add, 3 subtract, 4 multiply, 5 divide, 6 overlay
const combineMat = material(
  /* glsl */ `
  uniform sampler2D tFx;
  uniform int uMode;
  uniform float uOpacity;
  void main() {
    vec4 c = src(vUv);
    vec4 f = texture2D(tFx, vUv) * uOpacity;
    if (uMode == 0) { gl_FragColor = f + c * (1.0 - f.a); return; }
    if (uMode == 1) { gl_FragColor = c + f * (1.0 - c.a); return; }
    vec3 base = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    vec3 fx = f.a > 0.0 ? f.rgb / f.a : vec3(0.0);
    vec3 r = base;
    if (uMode == 2) r = base + fx;
    else if (uMode == 3) r = base - fx;
    else if (uMode == 4) r = base * fx;
    else if (uMode == 5) r = base / max(fx, vec3(0.001));
    else r = mix(2.0 * base * fx, 1.0 - 2.0 * (1.0 - base) * (1.0 - fx), step(0.5, base));
    // blend modes only change the object where it exists; outside it the effect shows as is (add)
    vec3 mixed = mix(base, clamp(r, 0.0, 1.0), f.a);
    float a = uMode == 2 ? max(c.a, f.a) : c.a;
    gl_FragColor = vec4(mixed * c.a + (uMode == 2 ? fx * f.a * (1.0 - c.a) : vec3(0.0)), a);
  }`,
  { tFx: { value: null }, uMode: { value: 0 }, uOpacity: { value: 1 } },
);

const quad = new Mesh(new PlaneGeometry(2, 2));
quad.frustumCulled = false;
const scene = new Scene();
scene.add(quad);
const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

const targets: WebGLRenderTarget[] = [];
function target(i: number, W: number, H: number) {
  let t = targets[i];
  if (!t) t = targets[i] = new WebGLRenderTarget(W, H, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  if (t.width !== W || t.height !== H) t.setSize(W, H);
  return t;
}

function pass(r: WebGLRenderer, m: ShaderMaterial, src: Texture, out: WebGLRenderTarget, W: number, H: number, origin: Vector2) {
  m.uniforms.tSrc.value = src;
  m.uniforms.uRes.value.set(W, H);
  m.uniforms.uOrigin.value.copy(origin);
  quad.material = m;
  r.setRenderTarget(out);
  r.render(scene, cam);
  return out.texture;
}

function blur(r: WebGLRenderer, tex: Texture, a: WebGLRenderTarget, b: WebGLRenderTarget, W: number, H: number, origin: Vector2, size: number[], samples: number, rotation = 0): Texture {
  const sx = size[0] ?? 0,
    sy = size[1] ?? 0;
  if (sx <= 0 && sy <= 0) return tex;
  const c = Math.cos(rotation),
    s = Math.sin(rotation);
  blurMat.uniforms.uSamples.value = Math.max(1, Math.min(32, samples));
  blurMat.uniforms.uDir.value.set(c * sx, s * sx);
  let t = pass(r, blurMat, tex, a, W, H, origin);
  blurMat.uniforms.uDir.value.set(-s * sy, c * sy);
  t = pass(r, blurMat, t, b, W, H, origin);
  return t;
}

const n = (fx: ShaderFx, k: string, d = 0) => (typeof fx[k] === 'number' ? (fx[k] as number) : d);
const v = (fx: ShaderFx, k: string, d: number[]) => (Array.isArray(fx[k]) ? (fx[k] as number[]) : d);
const b = (fx: ShaderFx, k: string) => !!fx[k];
const BLEND: Record<string, number> = { REGULAR: 0, NORMAL: 0, ADD: 2, SUBTRACT: 3, MULTIPLY: 4, DIVIDE: 5, OVERLAY: 6 };

export interface FxContext {
  /** object origin in image pixels (y up) */
  origin: Vector2;
  /** screen position (y up) of another object, for effects that follow an object */
  objectOrigin: (id: string) => Vector2 | null;
  /** image pixels per effect pixel (render resolution vs viewport) */
  scale: number;
}

/** Run the effects over `src` (W × H); returns the texture holding the result. */
export function applyEffects(r: WebGLRenderer, src: Texture, W: number, H: number, list: ShaderFx[], c: FxContext): Texture {
  const prev = r.getRenderTarget();
  let cur = src;
  let ping = 0;
  const next = () => target((ping = (ping + 1) % 2), W, H);
  const k = c.scale;
  for (const fx of list) {
    const origin = c.origin;
    switch (fx.type) {
      case 'FX_BLUR':
        cur = blur(r, cur, target(2, W, H), next(), W, H, origin, v(fx, 'size', [50, 50]).map((x) => x * k), n(fx, 'samples', 8), n(fx, 'rotation'));
        break;
      case 'FX_COLORIZE': {
        const u = colorizeMat.uniforms;
        u.uMode.value = ['GRAYSCALE', 'SEPIA', 'DUOTONE', 'TRANSPARENT', 'CUSTOM'].indexOf(String(fx.mode ?? 'GRAYSCALE'));
        u.uFactor.value = n(fx, 'factor', 0.5);
        u.uLow.value.fromArray([...v(fx, 'low_color', [0, 0, 0, 1]), 1]);
        u.uHigh.value.fromArray([...v(fx, 'high_color', [1, 1, 1, 1]), 1]);
        cur = pass(r, colorizeMat, cur, next(), W, H, origin);
        break;
      }
      case 'FX_FLIP':
        flipMat.uniforms.uFlip.value.set(b(fx, 'use_flip_x') ? 1 : 0, b(fx, 'use_flip_y') ? 1 : 0);
        cur = pass(r, flipMat, cur, next(), W, H, origin);
        break;
      case 'FX_PIXEL': {
        const s = v(fx, 'size', [5, 5]);
        pixelMat.uniforms.uSize.value.set(s[0] * k, s[1] * k);
        pixelMat.uniforms.uAA.value = b(fx, 'use_antialiasing') ? 1 : 0;
        cur = pass(r, pixelMat, cur, next(), W, H, origin);
        break;
      }
      case 'FX_SWIRL': {
        const center = (typeof fx.object === 'string' && c.objectOrigin(fx.object)) || origin;
        swirlMat.uniforms.uRadius.value = n(fx, 'radius', 100) * k;
        swirlMat.uniforms.uAngle.value = n(fx, 'angle', Math.PI / 2);
        swirlMat.uniforms.uTransparent.value = b(fx, 'use_transparent') ? 1 : 0;
        cur = pass(r, swirlMat, cur, next(), W, H, center);
        break;
      }
      case 'FX_WAVE': {
        const u = waveMat.uniforms;
        u.uAmp.value = n(fx, 'amplitude', 10) * k;
        u.uPeriod.value = n(fx, 'period', 20) * k;
        u.uPhase.value = n(fx, 'phase', 0);
        u.uVertical.value = fx.orientation === 'HORIZONTAL' ? 0 : 1;
        cur = pass(r, waveMat, cur, next(), W, H, origin);
        break;
      }
      case 'FX_GLOW': {
        const u = glowMaskMat.uniforms;
        u.uMode.value = fx.mode === 'COLOR' ? 1 : 0;
        u.uThreshold.value = n(fx, 'threshold', 0.1);
        u.uSelect.value.fromArray([...v(fx, 'select_color', [0, 0, 0]), 1]);
        u.uGlow.value.fromArray([...v(fx, 'glow_color', [0.75, 1, 1]), 1]);
        const mask = pass(r, glowMaskMat, cur, target(2, W, H), W, H, origin);
        const glow = blur(r, mask, target(3, W, H), target(2, W, H), W, H, origin, v(fx, 'size', [50, 50]).map((x) => x * k), n(fx, 'samples', 8), n(fx, 'rotation'));
        combineMat.uniforms.tFx.value = glow;
        combineMat.uniforms.uMode.value = b(fx, 'use_glow_under') ? 1 : fx.blend_mode === 'REGULAR' || !fx.blend_mode ? 2 : BLEND[String(fx.blend_mode)] ?? 2;
        combineMat.uniforms.uOpacity.value = n(fx, 'opacity', 1);
        cur = pass(r, combineMat, cur, next(), W, H, origin);
        break;
      }
      case 'FX_SHADOW': {
        const u = shadowMaskMat.uniforms;
        const center = (b(fx, 'use_object') && typeof fx.object === 'string' && c.objectOrigin(fx.object)) || origin;
        const off = v(fx, 'offset', [15, 20]);
        u.uOffset.value.set(off[0] * k, -off[1] * k);
        u.uScale.value.fromArray(v(fx, 'scale', [1, 1]));
        u.uRot.value = n(fx, 'rotation');
        u.uColor.value.fromArray(v(fx, 'shadow_color', [0, 0, 0, 0.8]));
        u.uWave.value = b(fx, 'use_wave') ? 1 : 0;
        u.uVertical.value = fx.orientation === 'HORIZONTAL' ? 0 : 1;
        u.uAmp.value = n(fx, 'amplitude', 10) * k;
        u.uPeriod.value = n(fx, 'period', 20) * k;
        u.uPhase.value = n(fx, 'phase', 0);
        const sh = pass(r, shadowMaskMat, cur, target(2, W, H), W, H, center);
        const blurred = blur(r, sh, target(3, W, H), target(2, W, H), W, H, center, v(fx, 'blur', [5, 5]).map((x) => x * k), n(fx, 'samples', 2) * 2);
        combineMat.uniforms.tFx.value = blurred;
        combineMat.uniforms.uMode.value = 1; // under the object
        combineMat.uniforms.uOpacity.value = 1;
        cur = pass(r, combineMat, cur, next(), W, H, origin);
        break;
      }
      case 'FX_RIM': {
        const u = rimMaskMat.uniforms;
        const off = v(fx, 'offset', [50, -100]);
        u.uOffset.value.set(off[0] * k, -off[1] * k);
        u.uColor.value.fromArray([...v(fx, 'rim_color', [1, 1, 0.5]), 1]);
        const rim = pass(r, rimMaskMat, cur, target(2, W, H), W, H, origin);
        const blurred = blur(r, rim, target(3, W, H), target(2, W, H), W, H, origin, v(fx, 'blur', [0, 0]).map((x) => x * k), n(fx, 'samples', 2) * 2);
        combineMat.uniforms.tFx.value = blurred;
        combineMat.uniforms.uMode.value = BLEND[String(fx.mode ?? 'OVERLAY')] ?? 6;
        combineMat.uniforms.uOpacity.value = 1;
        cur = pass(r, combineMat, cur, next(), W, H, origin);
        break;
      }
    }
  }
  r.setRenderTarget(prev);
  return cur;
}
