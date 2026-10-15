// Screen tracing buffer: before the main pass the scene is rendered (at the tracing resolution)
// into a radiance + view-depth texture with mip levels. Materials then trace reflection rays and
// horizon-scan rays against it (see fxshader.ts).
import {
  DepthTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  NearestFilter,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  WebGLRenderTarget,
  type Camera,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { fxUniforms, FX_AO, FX_BOUNCE, FX_REFLECT } from './fxshader';
import type { TraceSettings } from './settings';

const packMaterial = new ShaderMaterial({
  blending: NoBlending,
  depthTest: false,
  depthWrite: false,
  uniforms: { tColor: { value: null }, tDepth: { value: null }, uInvProj: { value: new Matrix4() } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor; uniform sampler2D tDepth; uniform mat4 uInvProj; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tColor, vUv);
      float d = texture2D(tDepth, vUv).x;
      if (d >= 1.0) { gl_FragColor = vec4(c.rgb, 0.0); return; }
      vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      // reciprocal depth: linear across planes in screen space
      gl_FragColor = vec4(c.rgb, 1.0 / max(1e-4, -v.z / v.w));
    }`,
});

/** Size of the traced buffer for a render of W×H at resolution divisor `div`. */
export function traceSize(W: number, H: number, div: number): [number, number] {
  const d = Math.max(1, div);
  return [Math.max(1, Math.ceil(W / d)), Math.max(1, Math.ceil(H / d))];
}

/** Effect flags of the main pass. */
export function traceFlags(t: TraceSettings): number {
  return (t.reflections ? FX_REFLECT : 0) | (t.fastGi ? FX_AO : 0) | (t.giBounce ? FX_BOUNCE : 0);
}

export class TraceBuffer {
  private scene: WebGLRenderTarget | null = null;
  private packed: WebGLRenderTarget | null = null;
  private quad = new FullScreenQuad(packMaterial);
  private invProj = new Matrix4();

  private floatLinear = false;

  private ensure(w: number, h: number) {
    if (!this.scene) {
      this.scene = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false });
      this.scene.depthTexture = new DepthTexture(w, h, FloatType);
      this.packed = new WebGLRenderTarget(w, h, { type: this.floatLinear ? FloatType : HalfFloatType, format: RGBAFormat, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, generateMipmaps: true, depthBuffer: false });
    } else if (this.scene.width !== w || this.scene.height !== h) {
      this.scene.setSize(w, h);
      this.packed!.setSize(w, h);
    }
  }

  /**
   * Render the tracing buffer for `camera` and arm the material effects for the next render.
   * Returns false when nothing is traced. Call `disarm()` after the main pass.
   */
  prepare(renderer: WebGLRenderer, scene: Scene, camera: Camera, W: number, H: number, t: TraceSettings | null, sample: number): boolean {
    const flags = t ? traceFlags(t) : 0;
    const u = fxUniforms;
    // the per-sample random also rotates dithered transparency, traced or not
    const rnd = (sample * 0.6180339887) % 1;
    u.ndFx.value.set(0, rnd, 0, 0);
    if (!flags || !t) return false;
    const [w, h] = traceSize(W, H, t.resolution);
    // view depth needs float precision when it can be filtered
    this.floatLinear = renderer.extensions.has('OES_texture_float_linear');
    this.ensure(w, h);
    const prevTarget = renderer.getRenderTarget();
    const scissor = renderer.getScissorTest();
    renderer.setScissorTest(false);
    renderer.setRenderTarget(this.scene);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    this.invProj.copy((camera as PerspectiveCamera).projectionMatrix).invert();
    packMaterial.uniforms.tColor.value = this.scene!.texture;
    packMaterial.uniforms.tDepth.value = this.scene!.depthTexture;
    packMaterial.uniforms.uInvProj.value = this.invProj;
    renderer.setRenderTarget(this.packed);
    this.quad.render(renderer);
    renderer.setRenderTarget(prevTarget);
    renderer.setScissorTest(scissor);
    u.ndSsTex.value = this.packed!.texture;
    u.ndSsProj.value.copy((camera as PerspectiveCamera).projectionMatrix);
    u.ndSsr.value.set(t.maxRoughness, t.thickness, t.steps, t.temporal ? 1 : 0);
    u.ndGi.value.set(t.giDistance, t.giThickness, t.giRays, t.giSteps);
    u.ndGi2.value.set(t.giBias, 0, 0, 0);
    const levels = Math.floor(Math.log2(Math.max(w, h)));
    u.ndFx.value.set(flags, rnd, levels, t.spatial ? 1 : 0);
    return true;
  }

  /** Stop tracing (other renders sharing the materials must not read a stale buffer). */
  disarm() {
    fxUniforms.ndFx.value.x = 0;
    fxUniforms.ndSsTex.value = null;
  }

  dispose() {
    this.scene?.depthTexture?.dispose();
    this.scene?.dispose();
    this.packed?.dispose();
    this.scene = this.packed = null;
  }
}
