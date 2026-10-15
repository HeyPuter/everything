// Realtime (raster) renderer: HDR scene pass with MSAA, ground-truth ambient occlusion and bloom,
// producing a scene-linear premultiplied buffer that is colour-managed for display afterwards.
import { Color, ShaderMaterial, NoBlending, Vector2, Vector3, Vector4, MeshBasicMaterial, type Camera, type Scene, type Texture, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { RenderSettings } from '../../data/types';
import { floatTarget, Blit } from './gbuffer';
import { displayGLSL, VIEW_INDEX, lookParams, viewWhiteBalance, viewCurve, CURVE_TABLE_SIZE, type ViewSettings } from './colormanage';

export interface RasterEffects {
  gtao: boolean;
  gtaoDistance: number;
  bloom: boolean;
  bloomThreshold: number;
  bloomIntensity: number;
  bloomRadius: number;
  transparent: boolean;
}

export function effectsFrom(r: RenderSettings): RasterEffects {
  return {
    gtao: r.use_gtao,
    gtaoDistance: r.gtao_distance,
    bloom: r.use_bloom,
    bloomThreshold: r.bloom_threshold,
    bloomIntensity: r.bloom_intensity,
    bloomRadius: r.bloom_radius,
    transparent: r.film_transparent,
  };
}

/** Map the scene's bloom settings onto the bloom pass (strength, radius 0..1). */
export function bloomParams(intensity: number, radius: number): { strength: number; radius: number } {
  return { strength: Math.max(0, intensity) * 12, radius: Math.min(1, Math.max(0, radius / 10)) };
}

export class RasterRenderer {
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private gtao: GTAOPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private size = new Vector2();

  constructor(private samples = 4) {}

  private ensure(renderer: WebGLRenderer, scene: Scene, camera: Camera, w: number, h: number) {
    if (!this.composer) {
      const rt = floatTarget(w, h, { half: true, linear: true, samples: this.samples });
      this.composer = new EffectComposer(renderer, rt);
      this.composer.renderToScreen = false;
      this.composer.setPixelRatio(1);
      this.renderPass = new RenderPass(scene, camera);
      this.composer.addPass(this.renderPass);
    }
    if (this.size.x !== w || this.size.y !== h) {
      this.size.set(w, h);
      this.composer.setSize(w, h);
    }
    this.renderPass!.scene = scene;
    this.renderPass!.camera = camera;
  }

  /** Render into the composer and return the linear HDR result texture. */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera, w: number, h: number, fx: RasterEffects): Texture {
    this.ensure(renderer, scene, camera, w, h);
    const composer = this.composer!;
    const rp = this.renderPass!;
    rp.clearColor = new Color(0, 0, 0);
    rp.clearAlpha = 0;
    // ambient occlusion
    if (fx.gtao) {
      if (!this.gtao) {
        this.gtao = new GTAOPass(scene, camera, w, h);
        composer.insertPass(this.gtao, 1);
      }
      this.gtao.scene = scene;
      this.gtao.camera = camera;
      this.gtao.enabled = true;
      this.gtao.updateGtaoMaterial({ radius: Math.max(0.01, fx.gtaoDistance) * 2, distanceExponent: 1, thickness: 1, scale: 1, samples: 16 });
      this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      this.gtao.blendIntensity = 1;
    } else if (this.gtao) this.gtao.enabled = false;
    // bloom
    if (fx.bloom) {
      const p = bloomParams(fx.bloomIntensity, fx.bloomRadius);
      if (!this.bloom) {
        this.bloom = new UnrealBloomPass(new Vector2(w, h), p.strength, p.radius, fx.bloomThreshold);
        composer.addPass(this.bloom);
      }
      this.bloom.enabled = true;
      this.bloom.strength = p.strength;
      this.bloom.radius = p.radius;
      this.bloom.threshold = fx.bloomThreshold;
    } else if (this.bloom) this.bloom.enabled = false;
    const tm = renderer.toneMapping;
    const scissor = renderer.getScissorTest();
    const prev = renderer.getRenderTarget();
    renderer.setScissorTest(false);
    renderer.toneMapping = 0; // NoToneMapping: keep scene-linear values
    composer.render();
    renderer.toneMapping = tm;
    renderer.setRenderTarget(prev);
    renderer.setScissorTest(scissor);
    return composer.readBuffer.texture;
  }

  dispose() {
    this.composer?.dispose();
    this.gtao?.dispose();
    this.bloom?.dispose();
    this.composer = null;
    this.gtao = null;
    this.bloom = null;
    this.size.set(0, 0);
  }
}

// ---------------------------------------------------------------------------
// display (colour management on the GPU) & accumulation

export const displayMaterial = new ShaderMaterial({
  blending: NoBlending,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
  uniforms: {
    tMap: { value: null as Texture | null },
    uView: { value: 1 },
    uExposure: { value: 1 },
    uInvGamma: { value: 1 },
    uBg: { value: new Color() },
    uComposite: { value: 1 },
    uWb: { value: new Vector3(1, 1, 1) },
    uLook: { value: new Vector4(1, 0, 1, 1) },
    uCurve: { value: new Float32Array(CURVE_TABLE_SIZE) },
    uUseCurve: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tMap; uniform int uView; uniform float uExposure; uniform float uInvGamma; uniform vec3 uBg; uniform float uComposite; uniform vec3 uWb; uniform vec4 uLook;
    uniform float uCurve[${CURVE_TABLE_SIZE}]; uniform float uUseCurve;
    float cmCurve1(float x) {
      float p = clamp(x, 0.0, 1.0) * ${CURVE_TABLE_SIZE - 1}.0;
      int i = int(min(floor(p), ${CURVE_TABLE_SIZE - 2}.0));
      return mix(uCurve[i], uCurve[i + 1], p - float(i));
    }
    varying vec2 vUv;
    ${displayGLSL}
    void main() {
      vec4 p = texture2D(tMap, vUv);
      if (uComposite > 0.5) { p.rgb += uBg * (1.0 - clamp(p.a, 0.0, 1.0)); p.a = 1.0; }
      gl_FragColor = cmDisplayX(p, uView, uExposure, uInvGamma, uWb, uLook);
      if (uUseCurve > 0.5) gl_FragColor.rgb = vec3(cmCurve1(gl_FragColor.r), cmCurve1(gl_FragColor.g), cmCurve1(gl_FragColor.b));
    }`,
});

/** Display settings of the Rendered viewport: the scene's view settings with an exposure offset. */
export function setDisplay(s: ViewSettings, exposureOffset: number, bg: Color | null) {
  const u = displayMaterial.uniforms;
  u.uView.value = VIEW_INDEX[s.view_transform] ?? 1;
  u.uExposure.value = Math.pow(2, s.exposure + exposureOffset);
  u.uInvGamma.value = s.gamma > 0 ? 1 / s.gamma : 1;
  const wb = viewWhiteBalance(s) ?? [1, 1, 1];
  (u.uWb.value as Vector3).set(wb[0], wb[1], wb[2]);
  const look = lookParams(s.view_transform, s.look) ?? [1, 0, 1, 1];
  (u.uLook.value as Vector4).set(look[0], look[1], look[2], look[3]);
  const curve = viewCurve(s);
  u.uUseCurve.value = curve ? 1 : 0;
  if (curve) (u.uCurve.value as Float32Array).set(curve);
  u.uComposite.value = bg ? 1 : 0;
  if (bg) u.uBg.value.copy(bg);
}

const accumMaterial = new ShaderMaterial({
  blending: NoBlending,
  depthTest: false,
  depthWrite: false,
  uniforms: { tPrev: { value: null }, tNew: { value: null }, uWeight: { value: 1 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tPrev; uniform sampler2D tNew; uniform float uWeight; varying vec2 vUv;
    void main() { gl_FragColor = mix(texture2D(tPrev, vUv), texture2D(tNew, vUv), uWeight); }`,
});

/** Running average of sample images (ping-pong float targets). */
export class Accumulator {
  private a: WebGLRenderTarget | null = null;
  private b: WebGLRenderTarget | null = null;
  count = 0;
  private blit = new Blit();

  reset(w: number, h: number) {
    for (const k of ['a', 'b'] as const) {
      const t = this[k];
      if (!t) this[k] = floatTarget(w, h, { depth: false });
      else if (t.width !== w || t.height !== h) t.setSize(w, h);
    }
    this.count = 0;
  }

  add(renderer: WebGLRenderer, tex: Texture) {
    const u = accumMaterial.uniforms;
    u.tPrev.value = this.a!.texture;
    u.tNew.value = tex;
    u.uWeight.value = 1 / (this.count + 1);
    const scissor = renderer.getScissorTest();
    renderer.setScissorTest(false);
    this.blit.draw(renderer, accumMaterial, this.b);
    renderer.setScissorTest(scissor);
    [this.a, this.b] = [this.b, this.a];
    this.count++;
  }

  get target(): WebGLRenderTarget {
    return this.a!;
  }

  dispose() {
    this.a?.dispose();
    this.b?.dispose();
    this.a = this.b = null;
  }
}

/** Depth-only material used to give viewport overlays correct occlusion. */
export const depthOnlyMaterial = new MeshBasicMaterial({ colorWrite: false });
