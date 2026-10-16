// Ray-traced bake passes on the GPU: the path tracer, with its camera replaced by one ray per
// texel (from just above the baked surface, or from the cage towards the high-resolution
// objects). The first hit is the point being baked; from there the shader either outputs a
// surface property, traces ambient occlusion / shadow rays, or continues the light path with the
// chosen shading component only, weighting direct and indirect light as requested.
import { DataTexture, FloatType, RGBAFormat, NearestFilter, PerspectiveCamera, type Material, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { patchPathTracingShader } from '../render/final/pathtracer';
import { filterTable } from '../render/final/filter';
import type { RenderScene } from '../render/final/renderscene';

/** What the first hit outputs (0 = continue the light path). */
export const TRACE_MODES = {
  LIGHT: 0,
  AO: 1,
  SHADOW: 2,
  ENVIRONMENT: 3,
  NORMAL: 4,
  POSITION: 5,
  ROUGHNESS: 6,
  EMIT: 7,
  DIFFUSE_COLOR: 8,
  GLOSSY_COLOR: 9,
  TRANSMISSION_COLOR: 10,
  HIT: 11,
} as const;
export type TraceMode = keyof typeof TRACE_MODES;

/** Shading components kept at the baked point when continuing the light path. */
export const LOBES = { ALL: 0, DIFFUSE: 1, GLOSSY: 2, TRANSMISSION: 3 } as const;
export type Lobe = keyof typeof LOBES;

const HELPERS = /* glsl */ `
  // per texel: origin (xyz, w > 0.5 when baked) at x * 2, direction (xyz, w = max distance) at x * 2 + 1
  uniform sampler2D bakeRays;
  #define BAKE_MAX_ALLOWED 32
  uniform int bakeAllowed[ BAKE_MAX_ALLOWED ];
  uniform int bakeAllowedCount;
  uniform int bakeMode;
  uniform int bakeLobe;
  uniform float bakeDirectW;
  uniform float bakeIndirectW;
  uniform float bakeEmitW;
  uniform float bakeAoDistance;
  bool bakeInvalid = false;
  bool bakeFirst = true;
  bool bakeMissed = false;
  int bakeSkips = 0;
  float bakeMaxDist = 0.0;

  Ray bakeCameraRay() {
    ivec2 px = ivec2( gl_FragCoord.xy );
    vec4 o = texelFetch( bakeRays, ivec2( px.x * 2, px.y ), 0 );
    vec4 d = texelFetch( bakeRays, ivec2( px.x * 2 + 1, px.y ), 0 );
    Ray r;
    r.origin = o.xyz;
    r.direction = dot( d.xyz, d.xyz ) > 0.0 ? normalize( d.xyz ) : vec3( 0.0, 0.0, - 1.0 );
    bakeInvalid = o.w < 0.5;
    bakeMaxDist = d.w;
    return r;
  }

  bool bakeAllowedMaterial( uint index ) {
    if ( bakeAllowedCount <= 0 ) return true;
    for ( int k = 0; k < BAKE_MAX_ALLOWED; k ++ ) {
      if ( k >= bakeAllowedCount ) break;
      if ( bakeAllowed[ k ] == int( index ) ) return true;
    }
    return false;
  }

  vec3 bakeW( vec3 c, bool direct ) {
    return ptClamp( c, direct ) * ( direct ? bakeDirectW : bakeIndirectW );
  }

  vec3 bakeCosineDir( vec3 n, vec2 u ) {
    vec3 t = abs( n.z ) < 0.999 ? normalize( cross( n, vec3( 0.0, 0.0, 1.0 ) ) ) : normalize( cross( n, vec3( 1.0, 0.0, 0.0 ) ) );
    vec3 b = cross( n, t );
    float r = sqrt( u.x );
    float phi = 6.28318530718 * u.y;
    return normalize( t * ( r * cos( phi ) ) + b * ( r * sin( phi ) ) + n * sqrt( max( 0.0, 1.0 - u.x ) ) );
  }

  void bakeOverrideLobe( inout SurfaceRecord surf ) {
    if ( bakeLobe == 0 ) return;
    surf.clearcoat = 0.0;
    surf.sheen = 0.0;
    surf.iridescence = 0.0;
    surf.color = vec3( 1.0 );
    if ( bakeLobe == 1 ) {
      surf.metalness = 0.0;
      surf.transmission = 0.0;
      surf.specularIntensity = 0.0;
      surf.ior = 1.0;
      surf.eta = 1.0;
      surf.f0 = 0.0;
    } else if ( bakeLobe == 2 ) {
      surf.metalness = 1.0;
      surf.transmission = 0.0;
    } else {
      surf.metalness = 0.0;
      surf.transmission = 1.0;
      surf.specularIntensity = 0.0;
    }
  }
`;

/** Insert the bake logic into the (already clamp-patched) path tracing shader. */
export function patchBakeTracingShader(src: string): string | null {
  const clamped = patchPathTracingShader(src);
  if (!clamped) return null;
  let s = clamped;
  const mainAt = s.indexOf('void main()');
  if (mainAt < 0) return null;
  s = s.slice(0, mainAt) + HELPERS + s.slice(mainAt);
  const steps: [RegExp | string, string][] = [
    // one ray per texel from the bake rays
    ['Ray ray = getCameraRay();', 'Ray ray = bakeCameraRay();\nif ( bakeInvalid ) { gl_FragColor = vec4( 0.0 ); return; }'],
    // direct / indirect weights on every contribution
    [/gl_FragColor\.rgb \+= ptClamp\(/g, 'gl_FragColor.rgb += bakeW('],
    // the first hit: miss, too far, or another object (skipped through)
    [
      'int hitType = traceScene( ray, state.fogMaterial, surfaceHit );',
      `int hitType = traceScene( ray, state.fogMaterial, surfaceHit );
      if ( bakeFirst ) {
        if ( hitType == NO_HIT || ( bakeMaxDist > 0.0 && surfaceHit.dist > bakeMaxDist ) ) {
          bakeMissed = true;
          gl_FragColor = vec4( 0.0 );
          break;
        }
        uint bakeMi = uTexelFetch1D( materialIndexAttribute, surfaceHit.faceIndices.x ).r;
        if ( ! bakeAllowedMaterial( bakeMi ) ) {
          bakeSkips ++;
          if ( bakeSkips > 16 ) { bakeMissed = true; gl_FragColor = vec4( 0.0 ); break; }
          if ( bakeMaxDist > 0.0 ) bakeMaxDist -= surfaceHit.dist;
          ray.origin = stepRayOrigin( ray.origin, ray.direction, - surfaceHit.faceNormal, surfaceHit.dist );
          i --;
          state.depth --;
          continue;
        }
      }`,
    ],
    // at the baked point: output a property or keep tracing one shading component
    [
      'scatterRec = bsdfSample( - ray.direction, surf );',
      `if ( bakeFirst ) {
        bakeFirst = false;
        vec3 bN = dot( surf.normal, ray.direction ) > 0.0 ? - surf.normal : surf.normal;
        vec3 bP = stepRayOrigin( ray.origin, ray.direction, dot( surf.faceNormal, ray.direction ) > 0.0 ? - surf.faceNormal : surf.faceNormal, surfaceHit.dist );
        if ( bakeMode != 0 ) {
          vec3 v = vec3( 0.0 );
          if ( bakeMode == 1 ) {
            Ray ao;
            ao.origin = bP;
            ao.direction = bakeCosineDir( bN, rand2( 11 ) );
            SurfaceHit aoHit;
            int t = traceScene( ao, state.fogMaterial, aoHit );
            v = vec3( t == NO_HIT || aoHit.dist > bakeAoDistance ? 1.0 : 0.0 );
          } else if ( bakeMode == 2 ) {
            v = vec3( 1.0 );
            if ( lights.count > 0u ) {
              LightRecord lr = randomLightSample( lights.tex, iesProfiles, lights.count, bP, rand3( 12 ) );
              Ray sr;
              sr.origin = bP;
              sr.direction = lr.direction;
              vec3 att;
              bool blocked = dot( lr.direction, bN ) <= 0.0 || attenuateHit( state, sr, lr.dist, att );
              v = blocked ? vec3( 0.0 ) : att;
            }
          } else if ( bakeMode == 3 ) v = environmentIntensity * sampleEquirectColor( envMapInfo.map, envRotation3x3 * bN );
          else if ( bakeMode == 4 ) v = bN;
          else if ( bakeMode == 5 ) v = ray.origin + ray.direction * surfaceHit.dist;
          else if ( bakeMode == 6 ) v = vec3( sqrt( max( surf.roughness, 0.0 ) ) );
          else if ( bakeMode == 7 ) v = surf.emission;
          else if ( bakeMode == 8 ) v = surf.color * ( 1.0 - surf.metalness ) * ( 1.0 - surf.transmission );
          else if ( bakeMode == 9 ) v = mix( surf.f0 * surf.specularColor * surf.specularIntensity, surf.color, surf.metalness );
          else if ( bakeMode == 10 ) v = surf.color * ( 1.0 - surf.metalness ) * surf.transmission;
          else v = vec3( 1.0 );
          gl_FragColor = vec4( v, 1.0 );
          break;
        }
        gl_FragColor.rgb += surf.emission * bakeEmitW;
        surf.emission = vec3( 0.0 );
        bakeOverrideLobe( surf );
      }
      scatterRec = bsdfSample( - ray.direction, surf );`,
    ],
    // texels that reached their surface are valid even when the path ended in the background
    ['gl_FragColor.a *= opacity;', 'if ( ! bakeMissed ) gl_FragColor.a = 1.0;\ngl_FragColor.a *= opacity;'],
  ];
  for (const [find, repl] of steps) {
    const before = s;
    s = typeof find === 'string' ? s.replace(find, repl) : s.replace(find, repl);
    if (s === before) return null;
  }
  return s;
}

interface Inner {
  _pathTracer: {
    setSize(w: number, h: number): void;
    update(): void;
    reset(): void;
    samples: number;
    alpha: boolean;
    tiles: { set(x: number, y: number): void };
    target: WebGLRenderTarget;
    _blendTargets?: WebGLRenderTarget[];
    _compilePromise: unknown;
    isCompiling: boolean;
    material: { fragmentShader: string; uniforms: Record<string, { value: unknown }>; needsUpdate: boolean; backgroundAlpha: number };
  };
  _materials: Material[] | null;
}

function floatTexture(data: Float32Array, w: number, h: number) {
  const t = new DataTexture(data, w, h, RGBAFormat, FloatType);
  t.minFilter = t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export interface TraceConfig {
  mode: TraceMode;
  lobe?: Lobe;
  direct?: boolean;
  indirect?: boolean;
  emit?: boolean;
  aoDistance?: number;
}

/** A path tracer whose camera shoots the given per-texel rays. */
export class BakeTracer {
  readonly pt: WebGLPathTracer;
  private inner: Inner['_pathTracer'];
  private renderer: WebGLRenderer;
  private rays: DataTexture | null = null;
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
    const patched = patchBakeTracingShader(mat.fragmentShader);
    if (!patched) throw new Error('The path tracer could not be prepared for baking');
    const u = mat.uniforms;
    u.ptFilter = { value: filterTable('BOX', 1) };
    u.ptClampDirect = { value: 0 };
    u.ptClampIndirect = { value: 0 };
    u.bakeRays = { value: null };
    u.bakeAllowed = { value: new Array(32).fill(-1) };
    u.bakeAllowedCount = { value: 0 };
    u.bakeMode = { value: 0 };
    u.bakeLobe = { value: 0 };
    u.bakeDirectW = { value: 1 };
    u.bakeIndirectW = { value: 1 };
    u.bakeEmitW = { value: 1 };
    u.bakeAoDistance = { value: 1 };
    mat.fragmentShader = patched;
    mat.needsUpdate = true;
  }

  get samples() {
    return Math.floor(this.inner.samples);
  }

  get isCompiling() {
    return this.inner.isCompiling;
  }

  /** Scene to trace; `firstHit` limits which materials the bake rays may stop at (null: any). */
  setScene(rs: RenderScene, firstHit: Set<Material> | null, bounces: { total: number; transmissive: number }, clamp: { direct: number; indirect: number }) {
    this.pt.bounces = bounces.total;
    this.pt.transmissiveBounces = bounces.transmissive;
    const u = this.inner.material.uniforms;
    u.ptClampDirect.value = clamp.direct;
    u.ptClampIndirect.value = clamp.indirect;
    this.pt.setScene(rs.scene, new PerspectiveCamera());
    const mats = (this.pt as unknown as Inner)._materials ?? [];
    const list: number[] = [];
    if (firstHit) mats.forEach((m, i) => firstHit.has(m) && list.push(i));
    // more materials than the list holds: any surface may be hit first
    const ok = !!firstHit && list.length > 0 && list.length <= 32;
    u.bakeAllowed.value = Array.from({ length: 32 }, (_, k) => (ok ? (list[k] ?? -1) : -1));
    u.bakeAllowedCount.value = ok ? list.length : 0;
  }

  /** Per-texel rays: origin xyz (w > 0.5 when the texel is baked) and direction xyz (w = max distance, 0 unlimited). */
  setRays(origin: Float32Array, dir: Float32Array, w: number, h: number) {
    this.rays?.dispose();
    const packed = new Float32Array(w * h * 8);
    for (let i = 0; i < w * h; i++) {
      packed.set(origin.subarray(i * 4, i * 4 + 4), i * 8);
      packed.set(dir.subarray(i * 4, i * 4 + 4), i * 8 + 4);
    }
    this.rays = floatTexture(packed, w * 2, h);
    const u = this.inner.material.uniforms;
    u.bakeRays.value = this.rays;
    this.width = w;
    this.height = h;
    this.inner.setSize(w, h);
    // average color and alpha separately: alpha tells which texels reached their surface
    this.inner.material.backgroundAlpha = 0;
    this.inner.alpha = true;
  }

  configure(c: TraceConfig) {
    const u = this.inner.material.uniforms;
    u.bakeMode.value = TRACE_MODES[c.mode];
    u.bakeLobe.value = LOBES[c.lobe ?? 'ALL'];
    u.bakeDirectW.value = c.direct === false ? 0 : 1;
    u.bakeIndirectW.value = c.indirect === false ? 0 : 1;
    u.bakeEmitW.value = c.emit === false ? 0 : 1;
    u.bakeAoDistance.value = Math.max(1e-4, c.aoDistance ?? 1);
    this.reset();
  }

  reset() {
    this.pt.reset();
    this.inner.reset();
  }

  /** Trace one sample per texel. With `force`, compile the shader now instead of waiting for it. */
  sample(force = false) {
    const r = this.renderer;
    const scissor = r.getScissorTest();
    r.setScissorTest(false);
    this.inner.update();
    if (force && this.inner.isCompiling) {
      this.inner._compilePromise = null;
      this.inner.update();
    }
    r.setScissorTest(scissor);
  }

  /** The averaged result (rows bottom-up, RGBA; color averaged over the samples with alpha). */
  read(): Float32Array {
    const out = new Float32Array(this.width * this.height * 4);
    // the two blend targets alternate: after an even number of samples the latest is the first one
    const bt = this.inner._blendTargets;
    const target = bt && this.samples % 2 === 0 ? bt[0] : this.inner.target;
    this.renderer.readRenderTargetPixels(target, 0, 0, this.width, this.height, out);
    return out;
  }

  dispose() {
    this.rays?.dispose();
    this.pt.dispose();
  }
}
