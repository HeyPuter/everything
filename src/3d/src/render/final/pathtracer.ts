// Progressive path tracer built on three-gpu-pathtracer's WebGLPathTracer. We drive the inner
// accumulation renderer directly so the result can be denoised and colour-managed ourselves.
import { Matrix4, type Camera, type Light, type Material, type Object3D, type WebGLRenderer, type Texture, type WebGLRenderTarget } from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import type { RenderScene } from './renderscene';
import type { RenderSettings } from '../../data/types';
import { bounceSettings } from './units';
import { filterGLSL, filterTable, type PixelFilter } from './filter';
import { applySssUniforms, applyVolumeUniforms, patchVolumeShader, ptVolumeSets, volumeUniforms } from './ptvolume';
import { patchIntegrator, integratorUniforms, applyIntegrator, seedOffset } from './ptintegrator';
import { patchPanorama, panoramaUniforms, applyPanorama, type PanoramaParams } from './ptcamera';
import { integratorValues, adaptiveCheckpoints, updateAdaptiveMask } from './ptsettings';
import { AlwaysStencilFunc, DataTexture, NearestFilter, NotEqualStencilFunc, RedFormat, ReplaceStencilOp, ShaderMaterial, UnsignedByteType, type Data3DTexture } from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

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

/** Writes stencil 1 where the adaptive mask marks converged pixels (they are skipped then). */
const maskFill = new ShaderMaterial({
  colorWrite: false,
  depthTest: false,
  depthWrite: false,
  stencilWrite: true,
  stencilRef: 1,
  stencilFunc: AlwaysStencilFunc,
  stencilZPass: ReplaceStencilOp,
  uniforms: { tMask: { value: null } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `uniform sampler2D tMask; varying vec2 vUv; void main() { if (texture2D(tMask, vUv).r < 0.5) discard; gl_FragColor = vec4(0.0); }`,
});
const maskQuad = new FullScreenQuad(maskFill);

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

/**
 * Light linking and indirect-only surfaces: per-light masks of the link groups a light lights
 * (receivers) and that cast its shadows (blockers); materials carry their link group and an
 * "invisible to camera rays" flag in their shading flags. Supplied by the scenes module.
 */
export const pathTracerLinkHook: {
  data?: (rs: RenderScene, lights: Light[], materials: Material[]) => { lights: Float32Array; on: boolean };
} = {};

/** Patch the path tracing shader for light linking and indirect-only surfaces (null when the shader does not match). */
export function patchLightLinking(src: string): string | null {
  const helpersAt = src.indexOf('float applyFilteredGlossy(');
  const mainAt = src.indexOf('void main()');
  if (helpersAt < 0 || mainAt < 0) return null;
  const helpers = `
    uniform int ptLinkOn;
    // per light (path tracer order): bit masks of the link groups it lights / that block it
    uniform vec2 ptLinkL[ ${PT_LINK_LIGHTS} ];
    uint ptCurMat = 0u;
    int ptCurLight = -1;
    int ptSkips = 0;
    // link group and indirect-only flag are packed above the shading flags of each material
    int ptMatFlags( uint m ) { return int( texelFetch1D( materials, m * uint( MATERIAL_PIXELS ) + 14u ).b + 0.5 ); }
    bool ptIndirectOnly( uint m ) { return ( ( ptMatFlags( m ) >> 3 ) & 1 ) != 0; }
    // channel 0: does the light light material m, 1: does material m block the light
    bool ptLinkTest( int light, uint m, int ch ) {
      if ( ptLinkOn == 0 || light < 0 || light >= ${PT_LINK_LIGHTS} ) return true;
      vec2 L = ptLinkL[ light ];
      int g = ( ptMatFlags( m ) >> 4 ) & 31;
      // round, not +0.5: all 24 group bits (16777215) are exact but 16777215.5 is not
      int mask = int( round( ch == 0 ? L.x : L.y ) );
      return ( ( mask >> g ) & 1 ) != 0;
    }
  `;
  let head = src.slice(0, helpersAt) + helpers + src.slice(helpersAt, mainAt);
  let body = src.slice(mainAt);
  // light sampling: the sampled light must light the shading point; its shadow rays only see blockers
  const sample = /LightRecord lightRec = randomLightSample\( lights\.tex, iesProfiles, lights\.count, rayOrigin, rand3\( 6 \) \);/;
  if (!sample.test(head)) return null;
  head = head.replace(
    sample,
    `vec3 ptR = rand3( 6 );
     LightRecord lightRec = randomLightSample( lights.tex, iesProfiles, lights.count, rayOrigin, ptR );
     int ptLi = min( int( ptR.x * float( lights.count ) ), int( lights.count ) - 1 );
     if ( ! ptLinkTest( ptLi, ptCurMat, 0 ) ) lightRec.pdf = 0.0;
     ptCurLight = ptLi;`,
  );
  const envBranch = /\} else if \( envMapInfo\.totalSum != 0\.0 && environmentIntensity != 0\.0 \) \{/;
  if (!envBranch.test(head)) return null;
  head = head.replace(envBranch, (m) => `ptCurLight = -1;\n${m}`);
  const shadowSkip = /if \( ! material\.castShadow && isShadowRay \) \{\s*continue;\s*\}/;
  if (!shadowSkip.test(head)) return null;
  head = head.replace(shadowSkip, (m) => `${m}\n if ( ! ptLinkTest( ptCurLight, materialIndex, 1 ) ) { continue; }`);
  // main loop: remember the shading material, skip indirect-only surfaces for camera rays
  const read = 'Material material = readMaterialInfo( materials, materialIndex );';
  if (!body.includes(read)) return null;
  body = body.replace(read, `${read}\n ptCurMat = materialIndex;`);
  const matte = '// early out if this is a matte material';
  if (!body.includes(matte)) return null;
  body = body.replace(
    matte,
    `if ( state.firstRay && ptLinkOn != 0 && ptIndirectOnly( materialIndex ) && ptSkips < 8 ) {
       ptSkips ++;
       ray.origin = stepRayOrigin( ray.origin, ray.direction, - surfaceHit.faceNormal, surfaceHit.dist );
       i --;
       state.depth --;
       continue;
     }
     ${matte}`,
  );
  const hit = 'intersectLightAtIndex( lights.tex, ray.origin, ray.direction, i, lightRec ) &&';
  if (!body.includes(hit)) return null;
  body = body.replace(hit, `${hit} ptLinkTest( int( i ), ptCurMat, 0 ) &&`);
  return head + body;
}

/** Link group mask with every group (as exact in the float uniforms). */
const PT_ALL_GROUPS = 0xffffff;

/** Lights with individual link masks in the path tracer (later lights are not linked). */
export const PT_LINK_LIGHTS = 64;

/** Lights in the path tracer's order (visible lights sorted by descending uuid). */
function tracerLights(root: Object3D): Light[] {
  const out: Light[] = [];
  root.traverse((c) => {
    const l = c as Light & { isRectAreaLight?: boolean; isSpotLight?: boolean; isPointLight?: boolean; isDirectionalLight?: boolean };
    if (c.visible && (l.isRectAreaLight || l.isSpotLight || l.isPointLight || l.isDirectionalLight)) out.push(l);
  });
  return out.sort((a, b) => (a.uuid < b.uuid ? 1 : a.uuid > b.uuid ? -1 : 0));
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
    const linked = patchLightLinking(mat.fragmentShader);
    if (linked) {
      mat.uniforms.ptLinkOn = { value: 0 };
      mat.uniforms.ptLinkL = { value: new Float32Array(PT_LINK_LIGHTS * 2) };
      mat.fragmentShader = linked;
      mat.needsUpdate = true;
      this.linkPatched = true;
    }
    // panoramic cameras
    const pano = patchPanorama(mat.fragmentShader);
    if (pano) {
      this.pano = panoramaUniforms();
      Object.assign(mat.uniforms, this.pano);
      mat.fragmentShader = pano;
      mat.needsUpdate = true;
    } else console.warn('Path tracer: panoramic cameras unavailable (unexpected shader layout)');
    // integrator options: adaptive sampling, bounce kinds, caustics, fast GI, transparent glass
    const integ = patchIntegrator(mat.fragmentShader);
    if (integ) {
      this.integ = integratorUniforms();
      Object.assign(mat.uniforms, this.integ);
      mat.fragmentShader = integ;
      mat.needsUpdate = true;
    } else console.warn('Path tracer: integrator options unavailable (unexpected shader layout)');
    // a fixed seed gives the same noise pattern for the same settings (Sampling ▸ Advanced ▸ Seed):
    // stable sample sequences, and blue noise offsets generated from a fixed seed
    (this.pt as unknown as { stableNoise: boolean }).stableNoise = true;
    const blue = (mat.uniforms.stratifiedOffsetTexture?.value ?? null) as { update?: () => void } | null;
    if (blue?.update) {
      const random = Math.random;
      let st = 0x2545f491;
      Math.random = () => {
        st = (Math.imul(st, 1103515245) + 12345) >>> 0;
        return st / 4294967296;
      };
      try {
        blue.update();
      } finally {
        Math.random = random;
      }
    }
    // adaptive sampling skips converged pixels with the stencil test
    const prim = (this.inner as unknown as { _primaryTarget: WebGLRenderTarget })._primaryTarget;
    prim.stencilBuffer = true;
    prim.depthBuffer = true;
    prim.dispose();
  }

  private integ: ReturnType<typeof integratorUniforms> | null = null;
  private pano: ReturnType<typeof panoramaUniforms> | null = null;
  private integKey = '';
  private seed = 0;
  private adaptive: { threshold: number; min: number; checkpoints: number[]; half: Float32Array | null; mask: Uint8Array | null; active: number } | null = null;
  private adaptiveKey = '';

  /** Pixels still sampling (adaptive sampling), as a fraction of the image; 1 without it. */
  activeFraction = 1;

  /** Noise pattern seed; takes effect on the next reset. */
  setSeed(seed: number) {
    if (seed === this.seed) return;
    this.seed = seed;
    this.reset();
  }

  /**
   * Adaptive sampling: from `min` samples on (then at each doubling) pixels whose estimated noise
   * is below `threshold` stop sampling. Pass null to sample every pixel.
   */
  setAdaptive(a: { threshold: number; min: number; max: number } | null) {
    const key = a ? `${a.threshold}|${a.min}|${a.max}` : '';
    if (key === this.adaptiveKey) return;
    this.adaptiveKey = key;
    this.adaptive = a && this.integ ? { threshold: a.threshold, min: a.min, checkpoints: adaptiveCheckpoints(Math.max(2, a.min), a.max), half: null, mask: null, active: 0 } : null;
    this.reset();
  }

  private resetAdaptive() {
    this.activeFraction = 1;
    if (!this.integ) return;
    const m = this.inner.material as unknown as ShaderMaterial;
    m.stencilWrite = false;
    if (this.adaptive) {
      this.adaptive.half = null;
      this.adaptive.mask = null;
    }
  }

  /** Read the accumulated image (RGBA floats, bottom row first). */
  private readImage(): Float32Array {
    const w = this.width,
      h = this.height;
    const out = new Float32Array(w * h * 4);
    this.renderer.readRenderTargetPixels(this.inner.target as unknown as WebGLRenderTarget, 0, 0, w, h, out);
    return out;
  }

  /** Mark converged pixels in the stencil of the accumulation target and skip them from now on. */
  private writeMask(mask: Uint8Array, w: number, h: number) {
    const tex = new DataTexture(mask, w, h, RedFormat, UnsignedByteType);
    tex.minFilter = tex.magFilter = NearestFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const scissor = r.getScissorTest();
    const prim = (this.inner as unknown as { _primaryTarget: WebGLRenderTarget })._primaryTarget;
    r.setScissorTest(false);
    r.setRenderTarget(prim);
    r.clear(false, false, true);
    maskFill.uniforms.tMask.value = tex;
    maskQuad.render(r);
    r.setRenderTarget(prev);
    r.setScissorTest(scissor);
    tex.dispose();
    const m = this.inner.material as unknown as ShaderMaterial;
    m.stencilWrite = true;
    m.stencilRef = 1;
    m.stencilFunc = NotEqualStencilFunc;
    m.stencilWriteMask = 0;
  }

  /** Convergence test at checkpoints: half-way snapshot, then the mask. */
  private adaptiveStep() {
    const a = this.adaptive;
    if (!a || !this.integ) return;
    const n = this.samples;
    const w = this.width,
      h = this.height;
    // snapshots: half of the first checkpoint, then every checkpoint (half of the next one)
    if (n === Math.max(1, Math.floor(a.checkpoints[0] / 2)) && !a.checkpoints.includes(n)) {
      a.half = this.readImage();
      return;
    }
    if (!a.checkpoints.includes(n)) return;
    const cur = this.readImage();
    if (a.half && a.half.length === cur.length) {
      if (!a.mask || a.mask.length !== w * h) a.mask = new Uint8Array(w * h);
      a.active = updateAdaptiveMask(a.mask, cur, a.half, w, h, a.threshold);
      this.activeFraction = a.active / (w * h);
      this.writeMask(a.mask, w, h);
    }
    // this checkpoint's image is the half-way point of the next one
    a.half = cur;
  }

  private linkPatched = false;
  private linkKey = '';

  /** Upload light linking / indirect-only data for the current scene. */
  private updateLinks(rs: RenderScene) {
    if (!this.linkPatched) return;
    const u = this.inner.material.uniforms;
    const mats = ((this.pt as unknown as { _materials?: Material[] })._materials ?? []) as Material[];
    const lights = tracerLights(rs.scene);
    let d = pathTracerLinkHook.data && rs.vis ? pathTracerLinkHook.data(rs, lights, mats) : null;
    // lights with Cast Shadow off: nothing blocks them
    const noShadow = lights.map((l) => !!l.userData.noShadow);
    if (noShadow.some(Boolean)) {
      if (!d?.on) {
        const L = new Float32Array(Math.max(1, lights.length) * 4);
        for (let i = 0; i < lights.length; i++) L[i * 4] = L[i * 4 + 1] = PT_ALL_GROUPS;
        d = { lights: L, on: true };
      }
      noShadow.forEach((off, i) => {
        if (off) d!.lights[i * 4 + 1] = 0;
      });
    }
    const key = d && d.on ? `${Array.from(d.lights).join(',')}|${mats.length}` : '';
    if (key === this.linkKey) return;
    this.linkKey = key;
    u.ptLinkOn.value = d?.on ? 1 : 0;
    if (!d?.on) {
      this.reset();
      return;
    }
    const L = u.ptLinkL.value as Float32Array;
    L.fill(0);
    for (let i = 0; i < PT_LINK_LIGHTS && i * 4 < d.lights.length; i++) {
      L[i * 2] = d.lights[i * 4];
      L[i * 2 + 1] = d.lights[i * 4 + 1];
    }
    this.reset();
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

  applySettings(r: RenderSettings, viewport = false) {
    let reset = false;
    if (this.integ) {
      const v = integratorValues(r, viewport);
      if (this.pt.bounces !== v.total || this.pt.transmissiveBounces !== v.transmissive) {
        this.pt.bounces = v.total;
        this.pt.transmissiveBounces = v.transmissive;
        reset = true;
      }
      const key = applyIntegrator(this.integ, v);
      if (key !== this.integKey) {
        this.integKey = key;
        reset = true;
      }
    } else {
      const b = bounceSettings(r);
      if (this.pt.bounces !== b.bounces || this.pt.transmissiveBounces !== b.transmissive) {
        this.pt.bounces = b.bounces;
        this.pt.transmissiveBounces = b.transmissive;
        reset = true;
      }
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
      this.updateLinks(rs);
      this.syncVolumes(rs, true);
      this.reset();
      return;
    }
    if (this.syncVolumes(rs, false)) this.reset();
    if (rs.lightsVersion !== this.lightsVersion) {
      this.lightsVersion = rs.lightsVersion;
      this.pt.updateLights();
      this.updateLinks(rs);
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
    return camera.matrixWorld.elements.join(',') + '|' + (camera as unknown as { projectionMatrix: Matrix4 }).projectionMatrix.elements.join(',') + '|' + ((camera as unknown as { focusDistance?: number }).focusDistance ?? '') + ((camera as unknown as { fStop?: number }).fStop ?? '') + '|' + JSON.stringify(camera.userData.panorama ?? null);
  }

  private storeCamera(camera: Camera) {
    if (this.pano) applyPanorama(this.pano, (camera.userData.panorama as PanoramaParams | undefined) ?? null);
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
    // stable noise restarts the sequence: offset it by the seed
    const m = this.inner.material as unknown as { seed: number; bounces: number; transmissiveBounces: number; stratifiedTexture?: { generator?: { seed: number }; init(count: number, depth: number): void; reset(): void } };
    m.seed = this.seed * 7919;
    if (this.integ) this.integ.ptSeedOff.value.set(...seedOffset(this.seed));
    const st = m.stratifiedTexture;
    if (st?.generator) {
      // size the sample table now (the first sample would otherwise rebuild it from an unseeded state)
      st.init(20, m.bounces + m.transmissiveBounces + 5);
      st.reset();
      st.generator.seed = (this.seed * 2654435761) % 0x80000000;
    }
    this.resetAdaptive();
  }

  /** Render one sample pass (one tile when tiled). */
  sample() {
    const r = this.renderer;
    const ext = r.extensions.get('EXT_float_blend');
    this.inner.alpha = this.inner.material.backgroundAlpha !== 1 || !ext;
    const scissor = r.getScissorTest();
    r.setScissorTest(false);
    const before = this.inner.samples;
    this.inner.update();
    r.setScissorTest(scissor);
    if (this.adaptive && this.inner.samples !== before && Number.isInteger(this.inner.samples)) this.adaptiveStep();
  }

  dispose() {
    this.pt.dispose();
  }
}
