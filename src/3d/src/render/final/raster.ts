// Realtime (raster) renderer: HDR scene pass with MSAA, screen-traced reflections and horizon-scan
// lighting (see ../realtime), and bloom, producing a scene-linear premultiplied buffer that is
// colour-managed for display afterwards.
import { Color, ShaderMaterial, NoBlending, Vector2, Vector3, Vector4, MeshBasicMaterial, type Camera, type Scene, type Texture, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import type { RenderSettings } from '../../data/types';
import { floatTarget, Blit } from './gbuffer';
import { displayGLSL, VIEW_INDEX, lookParams, viewWhiteBalance, viewCurve, CURVE_TABLE_SIZE, type ViewSettings } from './colormanage';
import { traceSettings, bloomOptions, type TraceSettings } from '../realtime/settings';
import { TraceBuffer } from '../realtime/trace';
import { BloomPass, type BloomSettings } from '../realtime/bloom';

export interface RasterEffects {
  /** screen effects allowed (tracing / horizon scan); false for quick previews */
  gtao: boolean;
  bloom: boolean;
  transparent: boolean;
  /** Render ▸ Raytracing options (null: nothing traced) */
  trace?: TraceSettings | null;
  bloomSettings?: BloomSettings;
  /** index of the accumulated sample (varies the tracing noise) */
  sample?: number;
}

export function effectsFrom(r: RenderSettings): RasterEffects {
  return {
    gtao: true,
    bloom: r.use_bloom,
    transparent: r.film_transparent,
    trace: traceSettings(r),
    bloomSettings: bloomOptions(r),
  };
}

export class RasterRenderer {
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloom: BloomPass | null = null;
  private trace = new TraceBuffer();
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

  /** The bloom glare of the last render (Bloom pass), when bloom is on. */
  get glare(): Texture | null {
    return this.bloom?.enabled ? this.bloom.glare : null;
  }

  /** Render into the composer and return the linear HDR result texture. */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera, w: number, h: number, fx: RasterEffects): Texture {
    this.ensure(renderer, scene, camera, w, h);
    const composer = this.composer!;
    const rp = this.renderPass!;
    rp.clearColor = new Color(0, 0, 0);
    rp.clearAlpha = 0;
    // bloom (same steps as the compositor's Glare node in Bloom mode)
    if (fx.bloom) {
      if (!this.bloom) {
        this.bloom = new BloomPass();
        composer.addPass(this.bloom);
      }
      this.bloom.enabled = true;
      if (fx.bloomSettings) this.bloom.settings = fx.bloomSettings;
    } else if (this.bloom) this.bloom.enabled = false;
    const tm = renderer.toneMapping;
    const scissor = renderer.getScissorTest();
    const prev = renderer.getRenderTarget();
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.setScissorTest(false);
    renderer.toneMapping = 0; // NoToneMapping: keep scene-linear values
    // screen tracing buffer (also renders this frame's shadow maps, reused by the main pass)
    const traced = fx.gtao && !!fx.trace && this.trace.prepare(renderer, scene, camera, w, h, fx.trace, fx.sample ?? 0);
    if (traced) renderer.shadowMap.autoUpdate = false;
    try {
      composer.render();
    } finally {
      if (traced) this.trace.disarm();
      renderer.shadowMap.autoUpdate = shadowAuto;
      renderer.toneMapping = tm;
      renderer.setRenderTarget(prev);
      renderer.setScissorTest(scissor);
    }
    return composer.readBuffer.texture;
  }

  dispose() {
    this.composer?.dispose();
    this.bloom?.dispose();
    this.trace.dispose();
    this.composer = null;
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
