// Progressive path tracer built on three-gpu-pathtracer's WebGLPathTracer. We drive the inner
// accumulation renderer directly so the result can be denoised and colour-managed ourselves.
import { Matrix4, type Camera, type WebGLRenderer, type Texture, type WebGLRenderTarget } from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import type { RenderScene } from './renderscene';
import type { RenderSettings } from '../../data/types';
import { bounceSettings } from './units';
import { filterGLSL, filterTable, type PixelFilter } from './filter';
import { applySssUniforms, applyVolumeUniforms, patchVolumeShader, ptVolumeSets, volumeUniforms } from './ptvolume';
import type { Data3DTexture, Material } from 'three';

interface Inner {
  _pathTracer: {
    setSize(w: number, h: number): void;
    getSize(v: { x: number; y: number }): void;
    update(): void;
    reset(): void;
    samples: number;
    alpha: boolean;
    tiles: { set(x: number, y: number): void };
    target: { texture: Texture };
    isCompiling: boolean;
    material: PtMaterial;
  };
}

interface PtMaterial {
  backgroundAlpha: number;
  filterGlossyFactor: number;
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
  needsUpdate: boolean;
}

/**
 * Extend the path tracing shader with our film and light path settings: a pixel filter
 * (camera rays are jittered by an importance-sampled filter table instead of a fixed tent)
 * and clamping of direct / indirect sample contributions. Returns false when the shader
 * did not have the expected structure (the stock behaviour is kept then).
 */
export function patchPathTracingShader(src: string): string | null {
  const jitter = /vec2 jitteredUv = vUv \+ vec2\( tentFilter\( ruv\.x \) \* ssd\.x, tentFilter\( ruv\.y \) \* ssd\.y \);/;
  const mainAt = src.indexOf('void main()');
  if (!jitter.test(src) || mainAt < 0) return null;
  let out = src.replace(jitter, 'vec2 jitteredUv = vUv + vec2( ptFilterSample( ruv.x ) * ssd.x, ptFilterSample( ruv.y ) * ssd.y );');
  const helpers = `
    ${filterGLSL('ptFilter')}
    uniform float ptClampDirect;
    uniform float ptClampIndirect;
    vec3 ptClamp( vec3 c, bool direct ) {
      float lim = direct ? ptClampDirect : ptClampIndirect;
      if ( lim <= 0.0 ) return c;
      float m = max( c.r, max( c.g, c.b ) );
      return m > lim ? c * ( lim / m ) : c;
    }
  `;
  // helpers go before the first function that samples the camera (the jitter lives there)
  const camAt = out.indexOf('vec3 ndcToRayOrigin');
  if (camAt < 0) return null;
  out = out.slice(0, camAt) + helpers + out.slice(camAt);
  // clamp every radiance contribution in main(): next-event estimation at the first hit and
  // light seen directly or after one bounce count as direct light, the rest as indirect
  const m2 = out.indexOf('void main()');
  const head = out.slice(0, m2);
  let body = out.slice(m2);
  let count = 0;
  body = body.replace(/gl_FragColor\.rgb \+=([^;]+);/g, (_all, expr: string) => {
    count++;
    const direct = expr.includes('directLightContribution') ? 'state.depth <= 1u' : 'state.depth <= 2u';
    return `gl_FragColor.rgb += ptClamp( ${expr.trim()}, ${direct} );`;
  });
  if (!count) return null;
  return head + body;
}

export class PathTracerCore {
  readonly pt: WebGLPathTracer;
  private inner: Inner['_pathTracer'];
  private renderer: WebGLRenderer;
  private sceneVersion = -1;
  private lightsVersion = -1;
  private envKey = '';
  private revision = -1;
  private camMatrix = new Matrix4();
  private camProj = new Matrix4();
  private camKey = '';
  width = 0;
  height = 0;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    this.pt = new WebGLPathTracer(renderer);
    this.pt.renderToCanvas = false;
    this.pt.synchronizeRenderSize = false;
    this.pt.multipleImportanceSampling = true;
    this.pt.filterGlossyFactor = 0.25;
    this.inner = (this.pt as unknown as Inner)._pathTracer;
    this.inner.tiles.set(1, 1);
    const mat = this.inner.material;
    // volumes and subsurface scattering (src/render/final/ptvolume.ts)
    const vol = patchVolumeShader(mat.fragmentShader);
    if (vol) {
      Object.assign(mat.uniforms, volumeUniforms());
      (mat as unknown as { defines: Record<string, number> }).defines.ND_VOLUMES = 0;
      mat.fragmentShader = vol;
      mat.needsUpdate = true;
      this.volumes = true;
      // the fog code paths also serve the world volume (no fog material needed), and the volume
      // atlas needs a texture unit: the background then comes from the environment map (the
      // same image for scene worlds). Overrides are applied where the library sets its defines
      // so the shader is not recompiled every frame.
      const m = mat as unknown as { onBeforeRender: (...a: unknown[]) => void; setDefine(k: string, v: number): void };
      const set = m.setDefine.bind(mat);
      m.setDefine = (k: string, v: number) => {
        if (k === 'FEATURE_FOG' && this.forceFog) v = 1;
        if (k === 'FEATURE_BACKGROUND_MAP' && this.hasVolumes) v = 0;
        set(k, v);
      };
      const before = m.onBeforeRender.bind(mat);
      m.onBeforeRender = (...a: unknown[]) => {
        set('ND_VOLUMES', this.hasVolumes ? 1 : 0);
        before(...a);
      };
    } else console.warn('Path tracer: volume and subsurface support unavailable (unexpected shader layout)');
    const patched = patchPathTracingShader(mat.fragmentShader);
    if (patched) {
      mat.uniforms.ptFilter = { value: filterTable('BLACKMAN_HARRIS', 1.5) };
      mat.uniforms.ptClampDirect = { value: 0 };
      mat.uniforms.ptClampIndirect = { value: 0 };
      mat.fragmentShader = patched;
      mat.needsUpdate = true;
      this.patched = true;
    }
  }

  private patched = false;
  private filterKey = '';
  private volumes = false;
  private forceFog = false;
  private hasVolumes = false;
  private volumeCache: { key: string; tex: Data3DTexture | null } = { key: '', tex: null };
  private volumeKey = '';

  /** Volume and subsurface data of the render scene (after its geometry is set). */
  private syncVolumes(rs: RenderScene, structure: boolean): boolean {
    if (!this.volumes) return false;
    const u = this.inner.material.uniforms;
    if (structure) applySssUniforms(u, ((this.pt as unknown as { _materials?: Material[] })._materials ?? []) as Material[]);
    const set = ptVolumeSets.get(rs.scene);
    applyVolumeUniforms(u, set, this.volumeCache);
    this.forceFog = !!set?.world;
    this.hasVolumes = !!set?.volumes.length;
    const key = `${set?.key ?? ''}|${JSON.stringify(set?.world ?? null)}`;
    if (key === this.volumeKey) return false;
    this.volumeKey = key;
    return true;
  }

  get samples() {
    return Math.floor(this.inner.samples);
  }

  get isCompiling() {
    return this.inner.isCompiling;
  }

  get texture(): Texture {
    return this.inner.target.texture;
  }

  /** Render target holding the accumulated (scene-linear, premultiplied) image. */
  get renderTarget(): WebGLRenderTarget {
    return this.inner.target as unknown as WebGLRenderTarget;
  }

  setTiles(x: number, y: number) {
    this.inner.tiles.set(x, y);
  }

  applySettings(r: RenderSettings) {
    const b = bounceSettings(r);
    let reset = false;
    if (this.pt.bounces !== b.bounces || this.pt.transmissiveBounces !== b.transmissive) {
      this.pt.bounces = b.bounces;
      this.pt.transmissiveBounces = b.transmissive;
      reset = true;
    }
    const glossy = Math.max(0, r.blur_glossy ?? 1) / 4;
    if (this.pt.filterGlossyFactor !== glossy) {
      this.pt.filterGlossyFactor = glossy;
      reset = true;
    }
    if (this.patched) {
      const u = this.inner.material.uniforms;
      const type: PixelFilter = r.pixel_filter_type ?? 'BLACKMAN_HARRIS';
      const width = r.filter_width ?? 1.5;
      const key = `${type}|${width}`;
      if (key !== this.filterKey) {
        this.filterKey = key;
        u.ptFilter.value = filterTable(type, width);
        reset = true;
      }
      const cd = Math.max(0, r.sample_clamp_direct ?? 0),
        ci = Math.max(0, r.sample_clamp_indirect ?? 0);
      if (u.ptClampDirect.value !== cd || u.ptClampIndirect.value !== ci) {
        u.ptClampDirect.value = cd;
        u.ptClampIndirect.value = ci;
        reset = true;
      }
    }
    if (reset) this.reset();
  }

  /**
   * Update scene data. `revision` is the document revision the RenderScene was built from;
   * geometry/material/light/environment changes are uploaded and restart accumulation.
   */
  sync(rs: RenderScene, camera: Camera, revision: number) {
    if (this.sceneVersion === -1 || revision !== this.revision) {
      // the generator detects unchanged geometry and only refits/rebuilds as needed
      this.pt.setScene(rs.scene, camera);
      this.sceneVersion = rs.structureVersion;
      this.lightsVersion = rs.lightsVersion;
      this.envKey = rs.envKey;
      this.revision = revision;
      this.storeCamera(camera);
      this.syncVolumes(rs, true);
      this.reset();
      return;
    }
    if (this.syncVolumes(rs, false)) this.reset();
    if (rs.lightsVersion !== this.lightsVersion) {
      this.lightsVersion = rs.lightsVersion;
      this.pt.updateLights();
      this.reset();
    }
    if (rs.envKey !== this.envKey) {
      this.envKey = rs.envKey;
      this.pt.updateEnvironment();
      this.reset();
    }
    const key = this.cameraKey(camera);
    if (key !== this.camKey) {
      this.pt.setCamera(camera);
      this.storeCamera(camera);
      this.reset();
    }
  }

  private cameraKey(camera: Camera) {
    camera.updateMatrixWorld();
    return camera.matrixWorld.elements.join(',') + '|' + (camera as unknown as { projectionMatrix: Matrix4 }).projectionMatrix.elements.join(',') + '|' + ((camera as unknown as { focusDistance?: number }).focusDistance ?? '') + ((camera as unknown as { fStop?: number }).fStop ?? '');
  }

  private storeCamera(camera: Camera) {
    this.camKey = this.cameraKey(camera);
    this.camMatrix.copy(camera.matrixWorld);
    this.camProj.copy((camera as unknown as { projectionMatrix: Matrix4 }).projectionMatrix);
  }

  setSize(w: number, h: number) {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.inner.setSize(w, h);
    this.reset();
  }

  reset() {
    this.pt.reset();
    this.inner.reset();
  }

  /** Render one sample pass (one tile when tiled). */
  sample() {
    const r = this.renderer;
    const ext = r.extensions.get('EXT_float_blend');
    this.inner.alpha = this.inner.material.backgroundAlpha !== 1 || !ext;
    const scissor = r.getScissorTest();
    r.setScissorTest(false);
    this.inner.update();
    r.setScissorTest(scissor);
  }

  dispose() {
    this.pt.dispose();
  }
}
