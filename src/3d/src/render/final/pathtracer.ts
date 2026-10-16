// Progressive path tracer built on three-gpu-pathtracer's WebGLPathTracer. We drive the inner
// accumulation renderer directly so the result can be denoised and colour-managed ourselves.
import { Matrix4, type Camera, type Light, type Material, type Object3D, type WebGLRenderer, type Texture, type WebGLRenderTarget } from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import type { RenderScene } from './renderscene';
import type { RenderSettings } from '../../data/types';
import { bounceSettings } from './units';
import { filterGLSL, filterTable, type PixelFilter } from './filter';
import { applySssUniforms, applyVolumeUniforms, patchVolumeShader, ptVolumeSets, volumeUniforms } from './ptvolume';
import type { Data3DTexture } from 'three';

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
      int mask = int( ( ch == 0 ? L.x : L.y ) + 0.5 );
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
  }

  private linkPatched = false;
  private linkKey = '';

  /** Upload light linking / indirect-only data for the current scene. */
  private updateLinks(rs: RenderScene) {
    if (!this.linkPatched) return;
    const u = this.inner.material.uniforms;
    const mats = ((this.pt as unknown as { _materials?: Material[] })._materials ?? []) as Material[];
    const d = pathTracerLinkHook.data && rs.vis ? pathTracerLinkHook.data(rs, tracerLights(rs.scene), mats) : null;
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
