// Screen-space subsurface scattering for the realtime engine.
//
// Materials with a subsurface weight (Principled BSDF ▸ Subsurface, Subsurface Scattering node)
// set `ndSssParam` (scattering radius per channel in world units, weight) in their node code. When
// the scene has such materials, an extra pass renders the diffuse irradiance of those surfaces
// (lighting divided by albedo) together with the reciprocal view depth. The main pass then
// gathers that irradiance around each subsurface pixel with a per-channel diffusion profile and
// depth-aware weights, and multiplies the result by the albedo again: light bleeds into shadowed
// areas and red light travels further than blue, while texture detail and specular stay sharp.
import { DepthTexture, FloatType, HalfFloatType, NearestFilter, RGBAFormat, Uniform, Vector4, WebGLRenderTarget, type Camera, type Material, type Mesh, type Object3D, type Scene, type Texture, type WebGLRenderer } from 'three';
import { GLSL_LIB } from '../../nodes/shader/glsl/lib';

/** Library chunk the node code requests for subsurface materials (`g.lib('nd_sss')`). */
GLSL_LIB.nd_sss = {
  code: `
#define ND_HAS_SSS 1
// xyz: scattering radius per channel (world units), w: subsurface weight
vec4 ndSssParam = vec4(0.0);
void nd_sss_set(float weight, vec3 radius, float scale) {
  float w = clamp(weight, 0.0, 1.0);
  if (w <= 0.0) return;
  vec3 r = max(radius, vec3(0.0)) * max(scale, 0.0);
  ndSssParam = vec4(max(ndSssParam.xyz, r), max(ndSssParam.w, w));
}
`,
};

/** Pass modes (x of `ndSss`). */
export const SSS_OFF = 0;
export const SSS_CAPTURE = 1;
export const SSS_GATHER = 2;

export const sssUniforms = {
  // x: mode, y: samples, z: per-sample random, w: largest gather radius in pixels
  ndSss: new Uniform(new Vector4(0, 16, 0, 64)),
  ndSssTex: new Uniform(null as Texture | null),
  // x: vertical projection scale of the camera (projection matrix [1][1])
  ndSssCam: new Uniform(new Vector4(1, 0, 0, 0)),
};

/** Declarations (placed with the other effect uniforms). */
export const SSS_PARS = /* glsl */ `
uniform vec4 ndSss;
uniform sampler2D ndSssTex;
uniform vec4 ndSssCam;

// diffusion profile: a sharp and a wide exponential lobe (distance d in units of the radius)
vec3 ndSssProfile( float dist, vec3 radius ) {
  vec3 d = max( radius, vec3( 1e-6 ) ) * 0.5;
  return exp( - dist / d ) + 0.5 * exp( - dist / ( 3.0 * d ) );
}

// Gather the captured irradiance around this pixel (view-space position P, depth > 0).
vec3 ndSssGather( vec3 center, vec3 P, vec3 radius ) {
  vec2 size = vec2( textureSize( ndSssTex, 0 ) );
  float depth = max( - P.z, 1e-4 );
  bool ortho = isOrthographic;
  // pixels per world unit at this depth
  float ppu = 0.5 * size.y * ndSssCam.x / ( ortho ? 1.0 : depth );
  float rmax = max( radius.r, max( radius.g, radius.b ) );
  float rpx = min( rmax * ppu * 1.5, ndSss.w );
  if ( rpx < 0.75 ) return center;
  vec3 sum = center * ndSssProfile( 0.0, radius );
  vec3 wsum = ndSssProfile( 0.0, radius );
  int n = int( ndSss.y );
  float rot = fract( 52.9829189 * fract( dot( gl_FragCoord.xy + ndSss.z * vec2( 47.0, 17.0 ), vec2( 0.06711056, 0.00583715 ) ) ) ) * 6.2831853;
  for ( int i = 0; i < 64; i ++ ) {
    if ( i >= n ) break;
    float t = ( float( i ) + 0.5 ) / float( n );
    float r = sqrt( t ) * rpx;
    float a = float( i ) * 2.39996323 + rot;
    vec2 uv = ( gl_FragCoord.xy + vec2( cos( a ), sin( a ) ) * r ) / size;
    if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) continue;
    vec4 s = textureLod( ndSssTex, uv, 0.0 );
    // only other subsurface surfaces contribute (alpha: 1 / view depth, negative elsewhere)
    if ( s.a <= 0.0 ) continue;
    float sd = ortho ? s.a : 1.0 / s.a;
    float dz = abs( sd - ( ortho ? -P.z : depth ) );
    float dw = r / ppu;
    vec3 w = ndSssProfile( sqrt( dw * dw + dz * dz ), radius );
    sum += s.rgb * w;
    wsum += w;
  }
  return sum / max( wsum, vec3( 1e-6 ) );
}
`;

/** After the lights: capture or replace the diffuse light of subsurface surfaces. */
export const SSS_APPLY = /* glsl */ `
#ifdef ND_HAS_SSS
float ndSssW = clamp( ndSssParam.w, 0.0, 1.0 ) * ( 1.0 - metalnessFactor );
#else
float ndSssW = 0.0;
#endif
vec3 ndSssIrr = vec3( 0.0 );
#ifdef ND_HAS_SSS
if ( ndSssW > 0.0 && ndSss.x > 0.5 ) {
  vec3 ndAlb = max( material.diffuseColor, vec3( 1e-3 ) );
  vec3 ndDiff = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
  ndSssIrr = ndDiff / ndAlb;
  if ( ndSss.x > 1.5 ) {
    vec3 ndB = ndSssGather( ndSssIrr, geometryPosition, ndSssParam.xyz );
    reflectedLight.directDiffuse = mix( ndDiff, ndB * ndAlb, ndSssW );
    reflectedLight.indirectDiffuse = vec3( 0.0 );
  }
}
#endif
`;

/** End of the shader: the capture pass writes irradiance + signed reciprocal depth. */
export const SSS_OUTPUT = /* glsl */ `
if ( ndSss.x > 0.5 && ndSss.x < 1.5 ) {
  float ndZ = isOrthographic ? max( - geometryPosition.z, 1e-4 ) : 1.0 / max( - geometryPosition.z, 1e-4 );
  gl_FragColor = ndSssW > 0.0 ? vec4( ndSssIrr, ndZ ) : vec4( 0.0, 0.0, 0.0, - ndZ );
}
`;

/** Whether a three.js material was compiled from a node tree with subsurface scattering. */
export function isSssMaterial(m: Material | Material[] | undefined): boolean {
  if (!m) return false;
  if (Array.isArray(m)) return m.some((x) => !!x?.userData?.ndSss);
  return !!m.userData?.ndSss;
}

/** Does the scene contain a visible mesh with a subsurface material? */
export function sceneHasSss(scene: Object3D): boolean {
  let found = false;
  scene.traverseVisible((o) => {
    if (!found && (o as Mesh).isMesh && isSssMaterial((o as Mesh).material)) found = true;
  });
  return found;
}

/** Realtime settings that control the subsurface pass. */
export interface SssSettings {
  samples: number;
  /** largest gather radius (pixels) */
  maxRadius: number;
}

export class SssPass {
  private target: WebGLRenderTarget | null = null;

  private ensure(w: number, h: number) {
    if (!this.target) {
      this.target = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false });
      this.target.depthTexture = new DepthTexture(w, h, FloatType);
    } else if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
  }

  /**
   * Render the irradiance of subsurface surfaces and arm the gather for the next render.
   * Returns false (nothing armed) when the scene has no subsurface materials.
   */
  prepare(renderer: WebGLRenderer, scene: Scene, camera: Camera, w: number, h: number, sample: number, s: SssSettings): boolean {
    const u = sssUniforms;
    u.ndSss.value.x = SSS_OFF;
    if (!sceneHasSss(scene)) return false;
    this.ensure(w, h);
    // only shaded surfaces take part: lines, helpers, volumes and the background stay out
    const hidden: Object3D[] = [];
    scene.traverseVisible((o) => {
      if (o === scene) return;
      const m = (o as Mesh).material as Material | undefined;
      const shaded = m && !Array.isArray(m) && (m as unknown as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial && !m.transparent;
      if (((o as Mesh).isMesh || (o as unknown as { isLine?: boolean }).isLine || (o as unknown as { isPoints?: boolean }).isPoints || (o as unknown as { isSprite?: boolean }).isSprite) && (!shaded || o.userData.noDepth || o.userData.smokeOf)) hidden.push(o);
    });
    for (const o of hidden) o.visible = false;
    const bg = scene.background;
    scene.background = null;
    const prev = renderer.getRenderTarget();
    const scissor = renderer.getScissorTest();
    const clearColor = renderer.getClearAlpha();
    renderer.setScissorTest(false);
    renderer.setRenderTarget(this.target);
    renderer.setClearAlpha(0);
    renderer.clear(true, true, true);
    u.ndSss.value.set(SSS_CAPTURE, s.samples, (sample * 0.7548776662) % 1, s.maxRadius);
    u.ndSssCam.value.set((camera as unknown as { projectionMatrix: { elements: number[] } }).projectionMatrix.elements[5], 0, 0, 0);
    try {
      renderer.render(scene, camera);
    } finally {
      for (const o of hidden) o.visible = true;
      scene.background = bg;
      renderer.setClearAlpha(clearColor);
      renderer.setRenderTarget(prev);
      renderer.setScissorTest(scissor);
    }
    u.ndSss.value.x = SSS_GATHER;
    u.ndSssTex.value = this.target!.texture;
    return true;
  }

  disarm() {
    sssUniforms.ndSss.value.x = SSS_OFF;
    sssUniforms.ndSssTex.value = null;
  }

  dispose() {
    this.target?.depthTexture?.dispose();
    this.target?.dispose();
    this.target = null;
  }
}
