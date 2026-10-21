// Realtime shading extensions injected into the scene materials (node materials and the
// Principled fallback): per-light diffuse/glossy influence, screen-space traced reflections,
// horizon-scan ambient occlusion with one-bounce indirect light, planar reflection probes,
// irradiance volumes blended with the world, and probe-only refraction.
//
// All effects read shared uniforms (`fxUniforms`). With `ndFx.x == 0` (the default) only the
// light influence factors apply, so viewports that do not trace (Material Preview) are unchanged.
import { ShaderChunk, Matrix4, Vector4, Uniform, type Texture, type WebGLProgramParametersWithUniforms } from 'three';
import { SSS_PARS, SSS_APPLY, SSS_OUTPUT, sssUniforms } from './sss';

/** Maximum lights per type with individual influence factors. */
export const MAX_LIGHTS = 64;

export const FX_REFLECT = 1;
export const FX_AO = 2;
export const FX_BOUNCE = 4;
export const FX_PLANAR = 8;

/** Shared uniforms (same objects in every patched material). */
export const fxUniforms = {
  // x: effect flags, y: per-sample random offset, z: mip levels of the trace buffer, w: spatial blur
  ndFx: new Uniform(new Vector4(0, 0, 0, 0)),
  ndSsTex: new Uniform(null as Texture | null),
  ndSsProj: new Uniform(new Matrix4()),
  // x: max roughness, y: thickness, z: steps, w: temporal (1 = vary noise between samples)
  ndSsr: new Uniform(new Vector4(0.5, 0.2, 32, 1)),
  // x: distance (0 = screen), y: thickness, z: rays, w: steps
  ndGi: new Uniform(new Vector4(0, 0.25, 2, 8)),
  // x: bias
  ndGi2: new Uniform(new Vector4(0.05, 0, 0, 0)),
  // light influence: (1 - diffuse, 1 - glossy) per light, by light type (defaults 0 = factor 1)
  ndLiPoint: new Uniform(new Float32Array(MAX_LIGHTS * 2)),
  ndLiSpot: new Uniform(new Float32Array(MAX_LIGHTS * 2)),
  ndLiDir: new Uniform(new Float32Array(MAX_LIGHTS * 2)),
  ndLiSun: new Uniform(new Float32Array(MAX_LIGHTS * 2)),
  ndLiRect: new Uniform(new Float32Array(MAX_LIGHTS * 2)),
  // planar reflection: x on, y influence distance, z falloff, w max lod
  ndPl: new Uniform(new Vector4(0, 0, 0, 0)),
  ndPlTex: new Uniform(null as Texture | null),
  /** world → probe local (plane spans -1..1 in x/y, normal +z) */
  ndPlLocal: new Uniform(new Matrix4()),
  /** world → mirrored camera texture coordinates */
  ndPlTexMat: new Uniform(new Matrix4()),
  /** world-space plane: normal (xyz) and offset (w) with dot(n, p) = w on the plane */
  ndPlN: new Uniform(new Vector4(0, 0, 1, 0)),
  // irradiance volumes: min (xyz) + intensity, max (xyz) + replaces-world flag
  ndVolMin: new Uniform([new Vector4(), new Vector4(), new Vector4(), new Vector4()]),
  ndVolMax: new Uniform([new Vector4(), new Vector4(), new Vector4(), new Vector4()]),
  /** world volume: view distances where the medium starts and ends */
  ndFogRange: new Uniform(new Vector4(0, 1e9, 0, 0)),
  /** x: maximum brightness of each light's contribution, y: of indirect light (0 = no clamp) */
  ndClamp: new Uniform(new Vector4(0, 0, 0, 0)),
  /** per area light (packing order): spot shadow slot of its shadow proxy, -1 for none */
  ndRectShadow: new Uniform(new Float32Array(MAX_LIGHTS).fill(-1)),
};

/** Volume Scatter factors per light type (same packing as the influence factors). */
export const volumeFactorUniforms = {
  ndLvPoint: new Uniform(new Float32Array(MAX_LIGHTS).fill(1)),
  ndLvSpot: new Uniform(new Float32Array(MAX_LIGHTS).fill(1)),
  ndLvDir: new Uniform(new Float32Array(MAX_LIGHTS).fill(1)),
};

// ---------------------------------------------------------------------------
// GLSL

const PARS = /* glsl */ `
uniform vec4 ndFx;
uniform sampler2D ndSsTex;
uniform mat4 ndSsProj;
uniform vec4 ndSsr;
uniform vec4 ndGi;
uniform vec4 ndGi2;
uniform vec4 ndPl;
uniform sampler2D ndPlTex;
uniform mat4 ndPlLocal;
uniform mat4 ndPlTexMat;
uniform vec4 ndPlN;
uniform vec4 ndVolMin[ 4 ];
uniform vec4 ndFogRange;
uniform vec4 ndClamp;
vec3 ndClampRGB( vec3 c, float m ) {
  float b = max( c.r, max( c.g, c.b ) );
  return m > 0.0 && b > m ? c * ( m / b ) : c;
}
uniform vec4 ndVolMax[ 4 ];
#if NUM_POINT_LIGHTS > 0
uniform vec2 ndLiPoint[ NUM_POINT_LIGHTS ];
#endif
#if NUM_SPOT_LIGHTS > 0
uniform vec2 ndLiSpot[ NUM_SPOT_LIGHTS ];
#endif
#if NUM_DIR_LIGHTS > 0
uniform vec2 ndLiDir[ NUM_DIR_LIGHTS ];
#endif
#if NUM_SUN_LIGHTS > 0
uniform vec2 ndLiSun[ NUM_SUN_LIGHTS ];
#endif
#if NUM_RECT_AREA_LIGHTS > 0
uniform vec2 ndLiRect[ NUM_RECT_AREA_LIGHTS ];
#endif

bool ndFlag( int f ) { return ( int( ndFx.x + 0.5 ) & f ) != 0; }

float ndNoise( vec2 p, float k ) {
  // interleaved gradient noise, rotated per sample when the noise is temporal
  vec2 q = p + ( ndSsr.w > 0.5 ? ndFx.y * vec2( 47.0, 17.0 ) : vec2( 0.0 ) ) + k * vec2( 5.588238, 3.0 );
  return fract( 52.9829189 * fract( dot( q, vec2( 0.06711056, 0.00583715 ) ) ) );
}

// the buffer stores 1 / view depth: it interpolates exactly across planes (0 = empty)
float ndDepthAt( vec2 uv ) {
  float r = textureLod( ndSsTex, uv, 0.0 ).a;
  return r > 0.0 ? 1.0 / r : 0.0;
}

// view-space size of one traced texel at view depth d
float ndTexel( float d ) {
  return 2.0 * d / ( float( textureSize( ndSsTex, 0 ).y ) * ndSsProj[ 1 ][ 1 ] );
}

vec2 ndProject( vec3 vp ) {
  vec4 c = ndSsProj * vec4( vp, 1.0 );
  return c.xy / c.w * 0.5 + 0.5;
}

// March a view-space ray against the traced depth (alpha of ndSsTex: 1 / view depth, 0 = empty).
// Returns the hit coordinates, a confidence (0 = miss) and the hit distance.
vec4 ndTrace( vec3 origin, vec3 dir, float maxDist, int steps, float thickness, float jitter ) {
  float prevT = 0.0;
  for ( int i = 1; i <= 128; i ++ ) {
    if ( i > steps ) break;
    float s = ( float( i ) - 1.0 + jitter ) / float( steps );
    float t = maxDist * s * s + 1e-3;
    vec3 p = origin + dir * t;
    if ( p.z > - 1e-3 ) break;
    vec2 uv = ndProject( p );
    if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) break;
    float d = ndDepthAt( uv );
    float diff = - p.z - d;
    if ( d > 0.0 && diff > 2e-3 * d && diff < thickness + ( t - prevT ) ) {
      // refine between the last two steps
      float a = prevT, b = t;
      for ( int k = 0; k < 5; k ++ ) {
        float m = 0.5 * ( a + b );
        vec3 q = origin + dir * m;
        vec2 quv = ndProject( q );
        float qd = ndDepthAt( quv );
        if ( qd > 0.0 && - q.z > qd ) { b = m; uv = quv; } else a = m;
      }
      vec2 e = smoothstep( vec2( 0.0 ), vec2( 0.08 ), uv ) * smoothstep( vec2( 0.0 ), vec2( 0.08 ), 1.0 - uv );
      return vec4( uv, e.x * e.y, b );
    }
    prevT = t;
  }
  return vec4( 0.0 );
}

vec3 ndTangent( vec3 n ) {
  vec3 up = abs( n.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
  return normalize( cross( up, n ) );
}

// GGX half vector sample around n (view space)
vec3 ndSampleGGX( vec3 n, float roughness, vec2 xi ) {
  float a = roughness * roughness;
  float phi = 6.2831853 * xi.x;
  float cosT = sqrt( ( 1.0 - xi.y ) / ( 1.0 + ( a * a - 1.0 ) * xi.y ) );
  float sinT = sqrt( 1.0 - cosT * cosT );
  vec3 t = ndTangent( n ), b = cross( n, t );
  return normalize( t * cos( phi ) * sinT + b * sin( phi ) * sinT + n * cosT );
}

vec3 ndWorldPos( vec3 viewPos ) {
  return ( ( vec4( viewPos, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
}

vec4 ndScreenReflection( vec3 P, vec3 N, vec3 V, float roughness ) {
  float maxR = ndSsr.x;
  if ( roughness > maxR ) return vec4( 0.0 );
  float spatial = ndFx.w;
  vec2 xi = vec2( ndNoise( gl_FragCoord.xy, 1.0 ), ndNoise( gl_FragCoord.xy, 2.0 ) );
  // spatial blur takes over part of the roughness: the ray stays closer to the mirror direction
  vec3 H = ndSampleGGX( N, roughness * ( 1.0 - 0.6 * spatial ), xi );
  vec3 R = reflect( - V, H );
  if ( dot( R, N ) <= 0.0 ) R = reflect( - V, N );
  float depth = max( - P.z, 0.1 );
  float jitter = ndNoise( gl_FragCoord.xy, 3.0 );
  vec4 hit = ndTrace( P + N * 2.0 * ndTexel( depth ), R, depth * 2.0 + 2.0, int( ndSsr.z ), ndSsr.y, jitter );
  if ( hit.z <= 0.0 ) return vec4( 0.0 );
  float lod = spatial * roughness * ndFx.z * 0.6;
  vec3 c = textureLod( ndSsTex, hit.xy, lod ).rgb;
  float fade = 1.0 - smoothstep( maxR * 0.6, maxR, roughness );
  return vec4( c, hit.z * fade );
}

// Horizon scan: cosine-weighted rays around N. rgb = gathered radiance (sum), a = visibility.
vec4 ndHorizonScan( vec3 P, vec3 N ) {
  int rays = int( ndGi.z );
  int steps = int( ndGi.w );
  float depth = max( - P.z, 0.1 );
  float dist = ndGi.x > 0.0 ? ndGi.x : depth * 0.25;
  vec3 origin = P + N * ( ndGi2.x * 0.05 * depth + 2.0 * ndTexel( depth ) );
  vec3 t = ndTangent( N ), b = cross( N, t );
  vec3 gathered = vec3( 0.0 );
  float visible = 0.0;
  for ( int r = 0; r < 16; r ++ ) {
    if ( r >= rays ) break;
    vec2 xi = vec2( ndNoise( gl_FragCoord.xy, 4.0 + float( r ) * 2.0 ), ndNoise( gl_FragCoord.xy, 5.0 + float( r ) * 2.0 ) );
    float phi = 6.2831853 * xi.x;
    float sr = sqrt( xi.y );
    vec3 dir = normalize( t * cos( phi ) * sr + b * sin( phi ) * sr + N * sqrt( max( 0.0, 1.0 - xi.y ) ) );
    vec4 hit = ndTrace( origin, dir, dist, steps, ndGi.y, ndNoise( gl_FragCoord.xy, 9.0 + float( r ) ) );
    // occluders fade out towards the scan distance
    float occ = hit.z > 0.0 ? 1.0 - smoothstep( 0.5 * dist, dist, hit.w ) : 0.0;
    gathered += textureLod( ndSsTex, hit.xy, 1.0 ).rgb * hit.z * occ;
    visible += 1.0 - occ;
  }
  return vec4( gathered, visible / float( max( rays, 1 ) ) );
}

float ndGridEnv = 1.0;

float ndGridWeight( vec3 wp, out float intensity ) {
  intensity = 1.0;
  #ifdef USE_LIGHT_PROBES_GRID
  vec3 size = max( probesMax - probesMin, vec3( 1e-5 ) );
  vec3 l = ( wp - probesMin ) / size;
  vec3 edge = min( l, 1.0 - l ) * size;
  float w = clamp( min( min( edge.x, edge.y ), edge.z ) / max( 0.1 * min( min( size.x, size.y ), size.z ), 1e-4 ), 0.0, 1.0 );
  float replaceEnv = 1.0;
  for ( int i = 0; i < 4; i ++ ) {
    if ( all( lessThan( abs( ndVolMin[ i ].xyz - probesMin ), vec3( 1e-3 ) ) ) && all( lessThan( abs( ndVolMax[ i ].xyz - probesMax ), vec3( 1e-3 ) ) ) ) {
      intensity = ndVolMin[ i ].w;
      replaceEnv = ndVolMax[ i ].w;
    }
  }
  ndGridEnv = 1.0 - w * replaceEnv;
  return w;
  #else
  return 0.0;
  #endif
}

vec4 ndPlanar( vec3 wp, vec3 wn, float roughness ) {
  if ( ndPl.x < 0.5 ) return vec4( 0.0 );
  vec3 l = ( ndPlLocal * vec4( wp, 1.0 ) ).xyz;
  vec3 n = ndPlN.xyz;
  float h = abs( dot( wp, n ) - ndPlN.w );
  float inside = step( abs( l.x ), 1.0 ) * step( abs( l.y ), 1.0 );
  float near = 1.0 - smoothstep( ndPl.y * ( 1.0 - ndPl.z ), ndPl.y + 1e-4, h );
  float facing = smoothstep( 0.6, 0.9, dot( wn, n ) );
  float w = inside * near * facing * ( 1.0 - smoothstep( 0.5, 1.0, roughness ) );
  if ( w <= 0.0 ) return vec4( 0.0 );
  vec4 c = ndPlTexMat * vec4( wp, 1.0 );
  vec2 uv = c.xy / c.w;
  // bend the lookup with the surface normal (ripples, bumps)
  uv += ( wn - n * dot( wn, n ) ).xy * 0.1;
  vec3 col = textureLod( ndPlTex, clamp( uv, 0.0, 1.0 ), roughness * ndPl.w ).rgb;
  return vec4( col, w );
}
`;

/** Refraction samples the light probes / world instead of the screen (probe-only refraction). */
const PROBE_REFRACTION = /* glsl */ `
vec4 ndRefractSample( const in vec2 fragCoord, const in float roughness, const in float ior, const in vec3 ray ) {
  #if defined( ND_PROBE_REFRACTION ) && defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  return vec4( textureCubeUV( envMap, envMapRotation * normalize( ray ), applyIorToRoughness( roughness, ior ) ).rgb * envMapIntensity, 1.0 );
  #else
  return getTransmissionSample( fragCoord, roughness, ior );
  #endif
}
`;

const LIGHT_LOOPS: [string, string][] = [
  ['NUM_POINT_LIGHTS', 'ndLiPoint'],
  ['NUM_SPOT_LIGHTS', 'ndLiSpot'],
  ['NUM_SUN_LIGHTS', 'ndLiSun'],
  ['NUM_DIR_LIGHTS', 'ndLiDir'],
  ['NUM_RECT_AREA_LIGHTS', 'ndLiRect'],
];

const LI_SAVE = `ndLiD0 = reflectedLight.directDiffuse; ndLiS0 = reflectedLight.directSpecular;
#ifdef USE_CLEARCOAT
ndLiC0 = clearcoatSpecularDirect;
#endif
#ifdef USE_SHEEN
ndLiH0 = sheenSpecularDirect;
#endif
`;
const liApply = (arr: string) => `{ vec2 ndF = vec2( 1.0 ) - ${arr}[ i ];
reflectedLight.directDiffuse = ndLiD0 + ndClampRGB( ( reflectedLight.directDiffuse - ndLiD0 ) * ndF.x, ndClamp.x );
reflectedLight.directSpecular = ndLiS0 + ndClampRGB( ( reflectedLight.directSpecular - ndLiS0 ) * ndF.y, ndClamp.x );
#ifdef USE_CLEARCOAT
clearcoatSpecularDirect = ndLiC0 + ( clearcoatSpecularDirect - ndLiC0 ) * ndF.y;
#endif
#ifdef USE_SHEEN
sheenSpecularDirect = ndLiH0 + ( sheenSpecularDirect - ndLiH0 ) * ndF.y;
#endif
}`;

/** Area lights: shadow from their proxy spot light's shadow map (render/final/renderscene.ts). */
const RECT_SHADOW = `
{ // the shadow map sees from the light's centre: surfaces turned away from it fade to unshadowed
float ndNL = dot( geometryNormal, normalize( rectAreaLight.position - geometryPosition ) );
float ndAS = mix( 1.0, ndAreaShadowAt( int( ndRectShadow[ i ] ) ), smoothstep( 0.0, 0.3, ndNL ) );
reflectedLight.directDiffuse = ndLiD0 + ( reflectedLight.directDiffuse - ndLiD0 ) * ndAS;
reflectedLight.directSpecular = ndLiS0 + ( reflectedLight.directSpecular - ndLiS0 ) * ndAS; }
`;

/** Area light shadow proxies whose shadow maps can be read (spot shadow slots). */
export const AREA_SHADOW_SLOTS = 8;

/** Shadow of spot shadow slot `k` (constant-index lookups, as sampler arrays require). */
function areaShadowGLSL(): string {
  let cases = '';
  for (let j = 0; j < AREA_SHADOW_SLOTS; j++)
    cases += `#if NUM_SPOT_LIGHT_SHADOWS > ${j}
  if ( k == ${j} ) { s = spotLightShadows[ ${j} ]; return getShadow( spotShadowMap[ ${j} ], s.shadowMapSize, s.shadowIntensity, s.shadowBias, s.shadowRadius, vSpotLightCoord[ ${j} ] ); }
#endif
`;
  return `
#if NUM_RECT_AREA_LIGHTS > 0
uniform float ndRectShadow[ NUM_RECT_AREA_LIGHTS ];
#endif
float ndAreaShadowAt( int k ) {
#if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
  if ( k < 0 || ! receiveShadow ) return 1.0;
  SpotLightShadow s;
${cases}#endif
  return 1.0;
}
`;
}
export const AREA_SHADOW_PARS = areaShadowGLSL();

/** The lights loop chunk with per-light influence factors and irradiance-volume weighting. */
export function patchLightsBegin(src: string): string {
  let out = src;
  for (const [count, arr] of LIGHT_LOOPS) {
    const at = out.indexOf(`i < ${count};`);
    if (at < 0) continue;
    const end = out.indexOf('#pragma unroll_loop_end', at);
    if (end < 0) continue;
    const seg = out.slice(at, end).replace(/(RE_Direct(?:_RectArea)?\s*\([^;]*\);)/, (m) => `${LI_SAVE}${m}\n${liApply(arr)}${count === 'NUM_RECT_AREA_LIGHTS' ? RECT_SHADOW : ''}`);
    out = out.slice(0, at) + seg + out.slice(end);
  }
  const decl = `vec3 ndLiD0 = vec3( 0.0 ), ndLiS0 = vec3( 0.0 );
#ifdef USE_CLEARCOAT
vec3 ndLiC0 = vec3( 0.0 );
#endif
#ifdef USE_SHEEN
vec3 ndLiH0 = vec3( 0.0 );
#endif
IncidentLight directLight;`;
  out = out.replace('IncidentLight directLight;', decl);
  // irradiance volumes fade in from their border and may replace the world's diffuse light
  out = out.replace(
    /irradiance \+= getLightProbeGridIrradiance\( probeWorldPos, probeWorldNormal \);/,
    '{ float ndGI; float ndGW = ndGridWeight( probeWorldPos, ndGI ); irradiance += getLightProbeGridIrradiance( probeWorldPos, probeWorldNormal ) * ndGW * ndGI; }',
  );
  return out;
}

/** Indirect light: screen tracing, horizon scan and planar probes adjust radiance / irradiance. */
export const FX_MAPS = /* glsl */ `
#if defined( RE_IndirectSpecular ) && defined( RE_IndirectDiffuse )
iblIrradiance *= ndGridEnv;
radiance = ndClampRGB( radiance, ndClamp.y );
iblIrradiance = ndClampRGB( iblIrradiance, ndClamp.y * PI );
{
  vec3 ndWP = ndWorldPos( geometryPosition );
  vec3 ndWN = normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz );
  vec4 ndP = ndPlanar( ndWP, ndWN, material.roughness );
  if ( ndP.a > 0.0 ) radiance = mix( radiance, ndP.rgb, ndP.a );
  if ( ndFlag( ${FX_REFLECT} ) ) {
    vec4 ndR = ndScreenReflection( geometryPosition, geometryNormal, geometryViewDir, material.roughness );
    radiance = mix( radiance, ndR.rgb, ndR.a );
  }
  if ( ndFlag( ${FX_AO} ) ) {
    vec4 ndH = ndHorizonScan( geometryPosition, geometryNormal );
    float ndV = ndH.a;
    irradiance *= ndV;
    iblIrradiance *= ndV;
    if ( ndFlag( ${FX_BOUNCE} ) ) iblIrradiance += PI * ndH.rgb / max( ndGi.z, 1.0 );
    float ndNV = saturate( dot( geometryNormal, geometryViewDir ) );
    radiance *= saturate( pow( ndNV + ndV, exp2( - 16.0 * material.roughness - 1.0 ) ) - 1.0 + ndV );
  }
}
#endif
`;

/** Dithered transparency varies its pattern per accumulated sample so that samples average out. */
export const ALPHA_HASH_TEMPORAL = /* glsl */ `
#ifdef USE_ALPHAHASH
if ( diffuseColor.a < fract( getAlphaHashThreshold( vPosition ) + ndFx.y ) ) discard;
#endif
`;

/** World volume: Beer–Lambert transmittance over the view distance inside the volume range. */
export const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
#ifdef FOG_EXP2
float ndFogD = clamp( vFogDepth - ndFogRange.x, 0.0, max( ndFogRange.y - ndFogRange.x, 0.0 ) );
float fogFactor = 1.0 - exp( - fogDensity * ndFogD );
#else
float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
#endif
gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * gl_FragColor.a, fogFactor );
#endif
`;

const lightsBegin = patchLightsBegin(ShaderChunk.lights_fragment_begin);
/** Transmission functions with the refraction lookup routed through `ndRefractSample`. */
export function patchTransmissionPars(src: string): string {
  return src
    .replace(/getTransmissionSample\( refractionCoords, roughness, (iors\[ i \]|ior) \)/g, (_m, i) => `ndRefractSample( refractionCoords, roughness, ${i}, refract( - v, normalize( n ), 1.0 / ${i} ) )`)
    .replace('vec4 getIBLVolumeRefraction(', `${PROBE_REFRACTION}\n\tvec4 getIBLVolumeRefraction(`);
}
const transmissionPars = patchTransmissionPars(ShaderChunk.transmission_pars_fragment);

/** Inject the realtime effects into a MeshStandard/Physical material's shader (onBeforeCompile). */
export function patchFx(shader: WebGLProgramParametersWithUniforms) {
  let f = shader.fragmentShader;
  if (!f.includes('#include <lights_fragment_begin>') || !f.includes('#include <lights_physical_pars_fragment>')) return;
  f = f
    .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${PARS}\n${SSS_PARS}`)
    .replace('#include <shadowmap_pars_fragment>', `#include <shadowmap_pars_fragment>\n${AREA_SHADOW_PARS}`)
    .replace('#include <lights_fragment_begin>', lightsBegin)
    .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${FX_MAPS}`)
    .replace('#include <alphahash_fragment>', ALPHA_HASH_TEMPORAL)
    .replace('#include <fog_fragment>', FOG_FRAGMENT)
    // subsurface scattering: capture / gather the diffuse light (see sss.ts)
    .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${SSS_APPLY}`)
    .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${SSS_OUTPUT}`);
  // the refraction lookup is defined after the transmission functions it may fall back to
  if (f.includes('#include <transmission_pars_fragment>')) f = f.replace('#include <transmission_pars_fragment>', transmissionPars);
  shader.fragmentShader = f;
  Object.assign(shader.uniforms, fxUniforms, sssUniforms);
}

/** onBeforeCompile for materials that have no other patches (Principled fallback). */
export function fxOnBeforeCompile(shader: WebGLProgramParametersWithUniforms) {
  patchFx(shader);
}
