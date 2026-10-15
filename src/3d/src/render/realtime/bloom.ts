// Bloom of the realtime engine. It follows the compositor's Glare node in Bloom mode step by
// step (soft-knee highlights, half-resolution processing, box downsample chain, tent upsample,
// energy normalisation, strength and tint), so the render setting and a Glare node with the
// matching values give the same image.
import { HalfFloatType, LinearFilter, NoBlending, RGBAFormat, ShaderMaterial, Vector2, Vector3, WebGLRenderTarget, type Texture, type WebGLRenderer } from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export interface BloomSettings {
  threshold: number;
  /** 0..1 soft knee as a fraction of the threshold */
  smoothness: number;
  /** 0..1 spread */
  size: number;
  strength: number;
  color: [number, number, number];
  /** maximum highlight brightness (0 = none) */
  clamp: number;
}

/** Number of downsample levels for an image of w×h (same rule as the Glare node). */
export function bloomLevels(size: number, w: number, h: number): number {
  return Math.max(1, Math.min(16, Math.round(size * Math.log2(Math.max(2, Math.min(w, h))) * 1.2)));
}

/** Soft-knee highlight extraction of one pixel value (pure, mirrors the GLSL). */
export function bloomHighlight(rgb: [number, number, number], threshold: number, smoothness: number): [number, number, number] {
  const knee = Math.max(1e-4, threshold * smoothness);
  const b = Math.max(rgb[0], rgb[1], rgb[2]);
  let soft = Math.min(2 * knee, Math.max(0, b - threshold + knee));
  soft = (soft * soft) / (4 * knee + 1e-5);
  const k = Math.max(0, Math.max(soft, b - threshold) / Math.max(b, 1e-5));
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}

const vert = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const mat = (fragmentShader: string, uniforms: Record<string, { value: unknown }>) => new ShaderMaterial({ blending: NoBlending, depthTest: false, depthWrite: false, uniforms, vertexShader: vert, fragmentShader });

const highlights = mat(
  /* glsl */ `
  uniform sampler2D tSrc; uniform float uThreshold; uniform float uKnee; uniform float uClamp; varying vec2 vUv;
  void main() {
    // box filter of the source over the (half resolution) output texel
    vec2 px = 1.0 / vec2(textureSize(tSrc, 0));
    vec3 c = 0.25 * (texture2D(tSrc, vUv + px * vec2(-0.5, -0.5)).rgb + texture2D(tSrc, vUv + px * vec2(0.5, -0.5)).rgb + texture2D(tSrc, vUv + px * vec2(-0.5, 0.5)).rgb + texture2D(tSrc, vUv + px * vec2(0.5, 0.5)).rgb);
    float b = max(c.r, max(c.g, c.b));
    float soft = clamp(b - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-5);
    float k = max(soft, b - uThreshold) / max(b, 1e-5);
    vec3 h = c * max(k, 0.0);
    if (uClamp > 0.0) { float m = max(h.r, max(h.g, h.b)); if (m > uClamp) h *= uClamp / m; }
    gl_FragColor = vec4(h, 1.0);
  }`,
  { tSrc: { value: null }, uThreshold: { value: 1 }, uKnee: { value: 0.1 }, uClamp: { value: 0 } },
);

const down = mat(
  /* glsl */ `
  uniform sampler2D tSrc; varying vec2 vUv;
  void main() {
    vec2 px = 1.0 / vec2(textureSize(tSrc, 0));
    gl_FragColor = 0.25 * (texture2D(tSrc, vUv + px * vec2(-0.5, -0.5)) + texture2D(tSrc, vUv + px * vec2(0.5, -0.5)) + texture2D(tSrc, vUv + px * vec2(-0.5, 0.5)) + texture2D(tSrc, vUv + px * vec2(0.5, 0.5)));
  }`,
  { tSrc: { value: null } },
);

const up = mat(
  /* glsl */ `
  uniform sampler2D tSmall; uniform sampler2D tBig; varying vec2 vUv;
  void main() {
    vec2 px = 1.0 / vec2(textureSize(tSmall, 0));
    vec4 acc = vec4(0.0);
    for (int j = -1; j <= 1; j++)
      for (int i = -1; i <= 1; i++) acc += texture2D(tSmall, vUv + vec2(i, j) * px) * float((2 - abs(i)) * (2 - abs(j)));
    gl_FragColor = texture2D(tBig, vUv) + acc / 16.0;
  }`,
  { tSmall: { value: null }, tBig: { value: null } },
);

const combine = mat(
  /* glsl */ `
  uniform sampler2D tSrc; uniform sampler2D tGlare; uniform sampler2D tCore; uniform float uSpread; uniform float uStrength; uniform vec3 uTint; varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tSrc, vUv);
    vec3 g = (texture2D(tGlare, vUv).rgb * uSpread + texture2D(tCore, vUv).rgb * 0.25) * uTint * uStrength;
    gl_FragColor = vec4(c.rgb + g, c.a);
  }`,
  { tSrc: { value: null }, tGlare: { value: null }, tCore: { value: null }, uSpread: { value: 0 }, uStrength: { value: 1 }, uTint: { value: new Vector3(1, 1, 1) } },
);

const target = (w: number, h: number) =>
  new WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, generateMipmaps: false });

export class BloomPass extends Pass {
  settings: BloomSettings = { threshold: 0.8, smoothness: 0.5, size: 0.65, strength: 1, color: [1, 1, 1], clamp: 0 };
  /** the last glare image (for the Bloom render pass) */
  glare: Texture | null = null;
  private quad = new FullScreenQuad();
  private chain: WebGLRenderTarget[] = [];
  private ups: WebGLRenderTarget[] = [];
  private size = new Vector2();

  constructor() {
    super();
    this.needsSwap = true;
  }

  setSize(w: number, h: number) {
    this.size.set(w, h);
  }

  private draw(renderer: WebGLRenderer, m: ShaderMaterial, rt: WebGLRenderTarget | null) {
    renderer.setRenderTarget(rt);
    this.quad.material = m;
    this.quad.render(renderer);
  }

  private ensureChain(w: number, h: number, levels: number) {
    const sizes: [number, number][] = [[Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2))]];
    for (let i = 0; i < levels; i++) {
      const [pw, ph] = sizes[sizes.length - 1];
      if (pw < 2 && ph < 2) break;
      sizes.push([Math.max(1, Math.ceil(pw / 2)), Math.max(1, Math.ceil(ph / 2))]);
    }
    sizes.forEach(([sw, sh], i) => {
      if (!this.chain[i]) this.chain[i] = target(sw, sh);
      else if (this.chain[i].width !== sw || this.chain[i].height !== sh) this.chain[i].setSize(sw, sh);
      if (!this.ups[i]) this.ups[i] = target(sw, sh);
      else if (this.ups[i].width !== sw || this.ups[i].height !== sh) this.ups[i].setSize(sw, sh);
    });
    for (const t of this.chain.splice(sizes.length)) t.dispose();
    for (const t of this.ups.splice(sizes.length)) t.dispose();
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget) {
    const s = this.settings;
    const w = readBuffer.width,
      h = readBuffer.height;
    // levels counted on the processing (half) resolution, like the Glare node at Medium quality
    const levels = bloomLevels(s.size, Math.round(w / 2), Math.round(h / 2));
    this.ensureChain(w, h, levels);
    const hu = highlights.uniforms;
    hu.tSrc.value = readBuffer.texture;
    hu.uThreshold.value = s.threshold;
    hu.uKnee.value = Math.max(1e-4, s.threshold * s.smoothness);
    hu.uClamp.value = s.clamp;
    this.draw(renderer, highlights, this.chain[0]);
    for (let i = 1; i < this.chain.length; i++) {
      down.uniforms.tSrc.value = this.chain[i - 1].texture;
      this.draw(renderer, down, this.chain[i]);
    }
    let cur = this.chain[this.chain.length - 1];
    for (let i = this.chain.length - 2; i >= 0; i--) {
      up.uniforms.tSmall.value = cur.texture;
      up.uniforms.tBig.value = this.chain[i].texture;
      this.draw(renderer, up, this.ups[i]);
      cur = this.ups[i];
    }
    const cu = combine.uniforms;
    cu.tSrc.value = readBuffer.texture;
    cu.tGlare.value = cur.texture;
    cu.tCore.value = this.chain[0].texture;
    cu.uSpread.value = 0.75 / this.chain.length;
    cu.uStrength.value = s.strength;
    (cu.uTint.value as Vector3).set(s.color[0], s.color[1], s.color[2]);
    this.glare = cur.texture;
    this.draw(renderer, combine, this.renderToScreen ? null : writeBuffer);
  }

  dispose() {
    for (const t of [...this.chain, ...this.ups]) t.dispose();
    this.chain = [];
    this.ups = [];
    this.quad.dispose();
  }
}
