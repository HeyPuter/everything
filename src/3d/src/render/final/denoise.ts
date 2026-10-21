// Edge-avoiding À-trous wavelet denoiser for path-traced images, guided by world normals,
// view depth and albedo (demodulated so texture detail survives filtering).
import { ShaderMaterial, NoBlending, Vector2, type Texture, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { Blit, floatTarget } from './gbuffer';
import type { DenoiseOptions } from './ptsettings';

/** 1D B3-spline taps of the À-trous kernel. */
export const ATROUS_TAPS = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16];

/** Iteration count and colour sigma for a given sample count (fewer samples → stronger filtering). */
export function denoiseSchedule(samples: number): { iterations: number; colorSigma: number } {
  const s = Math.max(1, samples);
  return { iterations: s < 4 ? 5 : s < 16 ? 4 : s < 128 ? 3 : 2, colorSigma: 0.8 / Math.sqrt(s) + 0.04 };
}

const vert = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const demodulate = new ShaderMaterial({
  blending: NoBlending,
  depthTest: false,
  depthWrite: false,
  uniforms: { tColor: { value: null }, tAlbedo: { value: null }, uUse: { value: 1 } },
  vertexShader: vert,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor; uniform sampler2D tAlbedo; uniform float uUse; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tColor, vUv);
      vec4 a = uUse > 0.5 ? texture2D(tAlbedo, vUv) : vec4(0.0);
      vec3 alb = a.a > 0.5 ? max(a.rgb, vec3(0.02)) : vec3(1.0);
      gl_FragColor = vec4(c.rgb / alb, c.a);
    }`,
});

// Geometry edges: the multisampled guide averages normals across silhouettes/creases, so
// |n| < 1 marks partially covered pixels. They keep the (anti-aliased) path-traced value
// lightly smoothed among neighbours of similar colour instead of the edge-stopped filter result.
const remodulate = new ShaderMaterial({
  blending: NoBlending,
  depthTest: false,
  depthWrite: false,
  uniforms: { tColor: { value: null }, tAlbedo: { value: null }, tRaw: { value: null }, tGuide: { value: null }, uTexel: { value: new Vector2() }, uUse: { value: 1 }, uGuideOn: { value: 1 } },
  vertexShader: vert,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor; uniform sampler2D tAlbedo; uniform sampler2D tRaw; uniform sampler2D tGuide; uniform vec2 uTexel; uniform float uUse; uniform float uGuideOn; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tColor, vUv);
      vec4 a = uUse > 0.5 ? texture2D(tAlbedo, vUv) : vec4(0.0);
      vec3 alb = a.a > 0.5 ? max(a.rgb, vec3(0.02)) : vec3(1.0);
      vec4 den = vec4(c.rgb * alb, c.a);
      vec4 g = texture2D(tGuide, vUv);
      float cover = uGuideOn < 0.5 ? 1.0 : g.a > 0.0 ? length(g.xyz) : 1.0;
      // partial background coverage also shows up in alpha
      float edge = clamp((0.995 - cover) * 25.0, 0.0, 1.0);
      if (edge > 0.0) {
        vec4 raw = texture2D(tRaw, vUv);
        vec4 sum = raw; float w = 1.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          if (i == 0 && j == 0) continue;
          vec4 r = texture2D(tRaw, vUv + vec2(float(i), float(j)) * uTexel);
          vec3 d = r.rgb / (1.0 + r.rgb) - raw.rgb / (1.0 + raw.rgb);
          float k = 0.5 * exp(-dot(d, d) * 200.0);
          sum += r * k; w += k;
        }
        den = mix(den, sum / w, edge);
      }
      gl_FragColor = den;
    }`,
});

// Firefly prefilter: a pixel much brighter than its neighbourhood is pulled back to the
// neighbourhood's mean plus a few deviations (luminance, in a compressed range).
const fireflies = new ShaderMaterial({
  blending: NoBlending,
  depthTest: false,
  depthWrite: false,
  uniforms: { tColor: { value: null }, uTexel: { value: new Vector2() }, uK: { value: 2.5 } },
  vertexShader: vert,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor; uniform vec2 uTexel; uniform float uK; varying vec2 vUv;
    float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    void main() {
      vec4 c0 = texture2D(tColor, vUv);
      float s = 0.0, s2 = 0.0;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        if (i == 0 && j == 0) continue;
        float l = log(1.0 + max(lum(texture2D(tColor, vUv + vec2(float(i), float(j)) * uTexel).rgb), 0.0));
        s += l; s2 += l * l;
      }
      float m = s / 8.0;
      float sd = sqrt(max(s2 / 8.0 - m * m, 0.0));
      float l0 = log(1.0 + max(lum(c0.rgb), 0.0));
      float lim = m + uK * sd + 0.05;
      gl_FragColor = l0 > lim ? vec4(c0.rgb * ((exp(lim) - 1.0) / max(exp(l0) - 1.0, 1e-6)), c0.a) : c0;
    }`,
});

const atrous = new ShaderMaterial({
  blending: NoBlending,
  depthTest: false,
  depthWrite: false,
  uniforms: {
    tColor: { value: null },
    tGuide: { value: null },
    uStep: { value: 1 },
    uTexel: { value: new Vector2() },
    uColorSigma: { value: 1 },
    uNormalPower: { value: 64 },
    uDepthSigma: { value: 0.02 },
    uVariance: { value: 0 },
  },
  vertexShader: vert,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor; uniform sampler2D tGuide;
    uniform float uStep; uniform vec2 uTexel; uniform float uColorSigma; uniform float uNormalPower; uniform float uDepthSigma; uniform float uVariance;
    varying vec2 vUv;
    float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    // compress HDR so fireflies do not dominate the colour distance
    vec3 tm(vec3 c) { return c / (1.0 + lum(c)); }
    void main() {
      const float taps[5] = float[5](1.0 / 16.0, 1.0 / 4.0, 3.0 / 8.0, 1.0 / 4.0, 1.0 / 16.0);
      vec4 c0 = texture2D(tColor, vUv);
      vec4 g0 = texture2D(tGuide, vUv);
      vec3 t0 = tm(c0.rgb);
      // without guides, empty (alpha 0) pixels are told apart by the colour's alpha
      bool bg0 = uNormalPower > 0.0 ? g0.a <= 0.0 : c0.a <= 0.0;
      vec4 sum = vec4(0.0);
      float wsum = 0.0;
      // noisier neighbourhoods (local deviation of the compressed colour) are filtered harder
      float sigma = uColorSigma;
      if (uVariance > 0.0) {
        vec3 m1 = vec3(0.0), m2 = vec3(0.0);
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec3 t = tm(texture2D(tColor, vUv + vec2(float(i), float(j)) * uTexel).rgb);
          m1 += t; m2 += t * t;
        }
        m1 /= 9.0; m2 /= 9.0;
        vec3 v = max(m2 - m1 * m1, vec3(0.0));
        sigma = max(sigma, uVariance * sqrt(v.r + v.g + v.b));
      }
      for (int j = -2; j <= 2; j++) {
        for (int i = -2; i <= 2; i++) {
          vec2 uv = vUv + vec2(float(i), float(j)) * uStep * uTexel;
          vec4 c = texture2D(tColor, uv);
          vec4 g = texture2D(tGuide, uv);
          float w = taps[i + 2] * taps[j + 2];
          bool bg = uNormalPower > 0.0 ? g.a <= 0.0 : c.a <= 0.0;
          if (bg != bg0) continue;
          if (!bg0 && uNormalPower > 0.0) {
            w *= pow(max(dot(g0.xyz, g.xyz), 0.0), uNormalPower);
            w *= exp(-abs(g.a - g0.a) / (uDepthSigma * g0.a * uStep + 1e-4));
          }
          vec3 d = tm(c.rgb) - t0;
          w *= exp(-dot(d, d) / (sigma * sigma + 1e-6));
          sum += c * w;
          wsum += w;
        }
      }
      gl_FragColor = wsum > 0.0 ? sum / wsum : c0;
    }`,
});

/** GPU denoiser with reusable targets. */
export class Denoiser {
  private a: WebGLRenderTarget | null = null;
  private b: WebGLRenderTarget | null = null;
  out: WebGLRenderTarget | null = null;
  private blit = new Blit();

  private ensure(w: number, h: number) {
    for (const k of ['a', 'b', 'out'] as const) {
      const t = this[k];
      if (!t) this[k] = floatTarget(w, h, { depth: false });
      else if (t.width !== w || t.height !== h) t.setSize(w, h);
    }
  }

  /**
   * Filter `color` (linear, premultiplied) using `guide` (normal.xyz, view depth) and `albedo`.
   * Returns the texture holding the result (valid until the next call).
   */
  run(renderer: WebGLRenderer, color: Texture, guide: Texture, albedo: Texture, w: number, h: number, samples: number, opts: Partial<DenoiseOptions> = {}): Texture {
    this.ensure(w, h);
    const sched = denoiseSchedule(samples);
    const iterations = Math.max(1, Math.min(6, sched.iterations + (opts.quality ?? 0)));
    const colorSigma = sched.colorSigma;
    const scissor = renderer.getScissorTest();
    renderer.setScissorTest(false);
    const useAlbedo = opts.albedo !== false;
    demodulate.uniforms.tColor.value = color;
    demodulate.uniforms.tAlbedo.value = useAlbedo ? albedo : null;
    demodulate.uniforms.uUse.value = useAlbedo ? 1 : 0;
    this.blit.draw(renderer, demodulate, this.a);
    let src = this.a!,
      dst = this.b!;
    // fireflies first, so that the edge-stopping filter does not keep them
    if (opts.prefilter && opts.prefilter !== 'NONE') {
      fireflies.uniforms.tColor.value = src.texture;
      fireflies.uniforms.uTexel.value.set(1 / w, 1 / h);
      fireflies.uniforms.uK.value = opts.prefilter === 'ACCURATE' ? 2 : 3;
      this.blit.draw(renderer, fireflies, dst);
      [src, dst] = [dst, src];
    }
    const u = atrous.uniforms;
    u.tGuide.value = guide;
    u.uTexel.value.set(1 / w, 1 / h);
    u.uNormalPower.value = opts.normal === false ? 0 : 64;
    u.uVariance.value = opts.prefilter === 'ACCURATE' ? 1.5 : 0;
    for (let i = 0; i < iterations; i++) {
      u.tColor.value = src.texture;
      u.uStep.value = 1 << i;
      u.uColorSigma.value = colorSigma * Math.pow(0.5, i * 0.5);
      this.blit.draw(renderer, atrous, dst);
      [src, dst] = [dst, src];
    }
    remodulate.uniforms.tColor.value = src.texture;
    remodulate.uniforms.tAlbedo.value = useAlbedo ? albedo : null;
    remodulate.uniforms.uUse.value = useAlbedo ? 1 : 0;
    remodulate.uniforms.uGuideOn.value = opts.normal === false ? 0 : 1;
    remodulate.uniforms.tRaw.value = color;
    remodulate.uniforms.tGuide.value = guide;
    remodulate.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.blit.draw(renderer, remodulate, this.out);
    renderer.setScissorTest(scissor);
    return this.out!.texture;
  }

  dispose() {
    this.a?.dispose();
    this.b?.dispose();
    this.out?.dispose();
    this.a = this.b = this.out = null;
  }
}
