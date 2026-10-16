// Volumes and subsurface scattering for the path tracer.
//
// Volumes: heterogeneous media (volume objects, geometry nodes grids, smoke domains) are packed
// into one 3D texture atlas. Each one is bounded by a box mesh with a fog material whose
// (otherwise unused) emissive intensity holds −(index + 1). Inside a box, free paths are sampled
// with spectral delta tracking against a per-volume majorant (scattering / absorption / null
// collisions chosen by the path throughput), emission is accumulated at every tentative
// collision, scattering uses the Henyey–Greenstein phase function and shadow rays use ratio
// tracking. A homogeneous world volume applies wherever no object volume does.
//
// Subsurface scattering: materials with a subsurface weight enter the surface with that
// probability and random-walk through a medium whose per-channel extinction is 1 / radius and
// whose single-scattering albedo is inverted from the base colour; the path continues from the
// exit point as a diffuse surface. The remaining diffuse lobe is scaled by (1 − weight).
import { Data3DTexture, LinearFilter, Matrix4, RGBAFormat, UnsignedByteType, Vector4, type Material } from 'three';
import type { PackedVolume } from '../../volume/pack';
import type { VolumeShader } from '../../volume/shader';

export const MAX_VOLUMES = 8;
/** Materials (by path tracer material index) that can use subsurface scattering. */
export const MAX_SSS = 64;

/** One volume as the path tracer sees it. */
export interface PtVolume {
  key: string;
  packed: PackedVolume;
  shader: VolumeShader;
  /** world → texture coordinates [0,1]³ */
  worldToUvw: Matrix4;
  /** world-space diagonal of the box (for the emission majorant) */
  diagonal: number;
  /** densities below this count as empty space */
  clipping?: number;
}

export interface PtWorldVolume {
  scatter: [number, number, number];
  absorb: [number, number, number];
  emission: [number, number, number];
  anisotropy: number;
}

export interface PtVolumeSet {
  volumes: PtVolume[];
  world: PtWorldVolume | null;
  /** changes when the uploaded data must change */
  key: string;
}

/** Volumes of each render scene (keyed by its three.js scene), filled by renderSceneHooks. */
export const ptVolumeSets = new WeakMap<object, PtVolumeSet>();

// ---------------------------------------------------------------------------
// GLSL

const GLOBALS = /* glsl */ `
#define ND_MAX_VOL ${MAX_VOLUMES}
precision highp sampler3D;
uniform sampler3D ndVolAtlas;
uniform int ndVolCount;
uniform mat4 ndVolToUvw[ ND_MAX_VOL ];
uniform vec4 ndVolTile[ ND_MAX_VOL ];
uniform vec4 ndVolScatter[ ND_MAX_VOL ];
uniform vec4 ndVolAbsorb[ ND_MAX_VOL ];
uniform vec4 ndVolEmit[ ND_MAX_VOL ];
uniform vec4 ndVolBody[ ND_MAX_VOL ];
uniform vec4 ndVolTint[ ND_MAX_VOL ];
uniform vec4 ndWorldScatter;
uniform vec4 ndWorldAbsorb;
uniform vec4 ndWorldEmit;
#define ND_MAX_SSS 64
uniform vec4 ndSssA[ ND_MAX_SSS ];
uniform vec4 ndSssB[ ND_MAX_SSS ];
uniform int ndSssCount;

uint ndSeed;
float ndRand() {
  ndSeed = ndSeed * 747796405u + 2891336453u;
  uint w = ( ( ndSeed >> ( ( ndSeed >> 28u ) + 4u ) ) ^ ndSeed ) * 277803737u;
  w = ( w >> 22u ) ^ w;
  return float( w ) / 4294967296.0;
}

vec3 ndThroughput;
vec3 ndVolWeight;
vec3 ndVolEmission;
bool ndVolAbsorbed;
bool ndInWorldFog;
float ndPhaseG;
float ndDiffuseScale;

float ndAvg( vec3 v ) { return ( v.r + v.g + v.b ) / 3.0; }

float ndHG( float cosTheta, float g ) {
  float d = 1.0 + g * g - 2.0 * g * cosTheta;
  return ( 1.0 - g * g ) / ( 4.0 * PI * d * sqrt( max( d, 1e-8 ) ) );
}

// sample a direction around 'dir' from the Henyey–Greenstein distribution
vec3 ndSampleHG( vec3 dir, float g, vec2 u ) {
  float cosTheta;
  if ( abs( g ) < 1e-3 ) cosTheta = 1.0 - 2.0 * u.x;
  else {
    float s = ( 1.0 - g * g ) / ( 1.0 - g + 2.0 * g * u.x );
    cosTheta = ( 1.0 + g * g - s * s ) / ( 2.0 * g );
  }
  float sinTheta = sqrt( max( 0.0, 1.0 - cosTheta * cosTheta ) );
  float phi = 2.0 * PI * u.y;
  vec3 t = abs( dir.z ) < 0.999 ? normalize( cross( dir, vec3( 0.0, 0.0, 1.0 ) ) ) : normalize( cross( dir, vec3( 1.0, 0.0, 0.0 ) ) );
  vec3 b = cross( dir, t );
  return normalize( t * cos( phi ) * sinTheta + b * sin( phi ) * sinTheta + dir * cosTheta );
}

vec3 ndBlackbody( float T ) {
  float x = clamp( ( T - 800.0 ) / 5700.0, 0.0, 1.0 );
  return clamp( vec3( 1.0, 0.18 + 0.82 * pow( x, 0.55 ), 0.02 + 0.98 * pow( x, 1.4 ) ), 0.0, 1.0 );
}

// scattering, absorption and emission coefficients of volume i at a world position
// (i = -2: the world volume; i = -1: a homogeneous fog material)
void ndVolCoeffs( int i, Material m, vec3 p, out vec3 ss, out vec3 sa, out vec3 em ) {
  if ( i == -2 ) {
    ss = ndWorldScatter.rgb; sa = ndWorldAbsorb.rgb; em = ndWorldEmit.rgb;
    return;
  }
  if ( i < 0 ) {
    ss = m.color * m.opacity; sa = ( 1.0 - m.color ) * m.opacity; em = vec3( 0.0 );
    return;
  }
  vec3 uvw = ( ndVolToUvw[ i ] * vec4( p, 1.0 ) ).xyz;
  if ( any( lessThan( uvw, vec3( 0.0 ) ) ) || any( greaterThan( uvw, vec3( 1.0 ) ) ) ) {
    ss = vec3( 0.0 ); sa = vec3( 0.0 ); em = vec3( 0.0 );
    return;
  }
  vec4 tile = ndVolTile[ i ];
  #if ND_VOLUMES
  vec3 t = texture( ndVolAtlas, vec3( uvw.x * tile.x, uvw.y * tile.y, tile.z + uvw.z * tile.w ) ).rgb;
  #else
  vec3 t = vec3( 0.0 );
  #endif
  float d = t.r;
  vec4 body = ndVolBody[ i ];
  if ( d < body.w ) d = 0.0;
  ss = ndVolScatter[ i ].rgb * d;
  sa = ndVolAbsorb[ i ].rgb * d;
  vec4 e = ndVolEmit[ i ];
  em = e.rgb * ( e.w > 0.0 ? t.g : step( 1e-4, d ) );
  if ( body.x > 0.0 ) {
    float T = body.z > 0.0 ? body.z : t.b * body.y;
    if ( T > 400.0 ) em += ndVolTint[ i ].rgb * ndBlackbody( T ) * body.x * 1.805e-13 * T * T * T * T;
  }
}

int ndVolIndex( Material m ) {
  return m.emissiveIntensity < 0.0 ? int( - m.emissiveIntensity + 0.5 ) - 1 : -1;
}
`;

const TRACKING = /* glsl */ `
// majorant of a medium (constant over its box)
float ndMajorant( int i, Material m ) {
  if ( i == -2 ) return max( ndWorldScatter.r + ndWorldAbsorb.r, max( ndWorldScatter.g + ndWorldAbsorb.g, ndWorldScatter.b + ndWorldAbsorb.b ) );
  if ( i < 0 ) return m.opacity;
  return ndVolScatter[ i ].w;
}

// Spectral delta tracking from the ray origin up to tMax. Returns the distance of a scattering
// (or absorption) event, INFINITY when the ray passes. Updates ndVolWeight / ndVolEmission.
float ndTrack( int i, Material m, vec3 origin, vec3 dir, float tMax ) {
  float mu = ndMajorant( i, m );
  if ( mu <= 0.0 ) return INFINITY;
  float t = 0.0;
  for ( int k = 0; k < 512; k ++ ) {
    t -= log( 1.0 - ndRand() ) / mu;
    if ( t >= tMax ) return INFINITY;
    vec3 ss, sa, em;
    ndVolCoeffs( i, m, origin + dir * t, ss, sa, em );
    ndVolEmission += ndVolWeight * em / mu;
    vec3 sn = max( vec3( mu ) - ss - sa, vec3( 0.0 ) );
    vec3 w = ndThroughput * ndVolWeight;
    float pa = ndAvg( w * sa ), ps = ndAvg( w * ss ), pn = ndAvg( w * sn );
    float c = pa + ps + pn;
    if ( c <= 0.0 ) continue;
    float xi = ndRand() * c;
    if ( xi < pa ) {
      ndVolAbsorbed = true;
      return t;
    }
    if ( xi < pa + ps ) {
      ndVolWeight *= ss * c / ( mu * ps );
      ndPhaseG = i >= 0 ? ndVolTint[ i ].w : i == -2 ? ndWorldScatter.w : 0.0;
      return t;
    }
    ndVolWeight *= sn * c / ( mu * pn );
    if ( max( ndVolWeight.r, max( ndVolWeight.g, ndVolWeight.b ) ) < 1e-6 ) {
      ndVolAbsorbed = true;
      return t;
    }
  }
  return INFINITY;
}

// object volumes and lookups from the library's fog material
float ndFogDistance( Material m, Ray ray, float tMax ) {
  return ndTrack( ndVolIndex( m ), m, ray.origin, ray.direction, tMax );
}

// world volume (only where no object volume applies)
float ndWorldDistance( Ray ray, float tMax ) {
  if ( ndWorldAbsorb.w <= 0.0 ) return INFINITY;
  Material m;
  return ndTrack( -2, m, ray.origin, ray.direction, tMax );
}

// ratio-tracked transmittance through a medium
vec3 ndTransmittance( int i, Material m, vec3 origin, vec3 dir, float tEnd ) {
  float mu = ndMajorant( i, m );
  if ( mu <= 0.0 ) return vec3( 1.0 );
  if ( i == -1 ) return vec3( exp( - mu * tEnd ) );
  if ( i == -2 ) return tEnd >= INFINITY * 0.5 ? vec3( 0.0 ) : exp( - ( ndWorldScatter.rgb + ndWorldAbsorb.rgb ) * tEnd );
  vec3 T = vec3( 1.0 );
  float t = 0.0;
  for ( int k = 0; k < 256; k ++ ) {
    t -= log( 1.0 - ndRand() ) / mu;
    if ( t >= tEnd ) break;
    vec3 ss, sa, em;
    ndVolCoeffs( i, m, origin + dir * t, ss, sa, em );
    T *= max( vec3( 1.0 ) - ( ss + sa ) / mu, vec3( 0.0 ) );
    float mx = max( T.r, max( T.g, T.b ) );
    if ( mx < 0.05 ) {
      if ( ndRand() > mx ) return vec3( 0.0 );
      T /= mx;
    }
  }
  return T;
}

// scene intersection for shadow rays: attenuates by the current medium and never scatters
int ndTraceShadow( Ray ray, Material fogMaterial, inout SurfaceHit surfaceHit, inout vec3 color, float remaining ) {
  bool hit = bvhIntersectFirstHit( bvh, ray.origin, ray.direction, surfaceHit.faceIndices, surfaceHit.faceNormal, surfaceHit.barycoord, surfaceHit.side, surfaceHit.dist );
  float tEnd = min( hit ? surfaceHit.dist : INFINITY, max( remaining, 0.0 ) );
  bool inObject = false;
  #if FEATURE_FOG
  inObject = fogMaterial.fogVolume;
  #endif
  if ( inObject ) color *= ndTransmittance( ndVolIndex( fogMaterial ), fogMaterial, ray.origin, ray.direction, tEnd );
  else if ( ndWorldAbsorb.w > 0.0 ) {
    Material wm;
    color *= ndTransmittance( -2, wm, ray.origin, ray.direction, tEnd );
  }
  if ( max( color.r, max( color.g, color.b ) ) < 1e-5 ) return FOG_HIT;
  return hit ? SURFACE_HIT : NO_HIT;
}

// --- subsurface scattering

bool ndSssParams( uint mi, out vec4 a, out vec4 b ) {
  int i = int( mi );
  if ( i >= ndSssCount ) return false;
  a = ndSssA[ i ];
  b = ndSssB[ i ];
  return a.x > 0.0;
}

// random walk inside a mesh; returns false when the walk is lost
bool ndSubsurfaceWalk( vec3 albedo, vec3 radius, float g, vec3 p, vec3 d, out vec3 lastP, out vec3 lastD, out vec3 weight, out SurfaceHit h ) {
  vec3 A = clamp( albedo, vec3( 0.001 ), vec3( 0.999 ) );
  vec3 s = 4.09712 + 4.20863 * A - sqrt( 9.59217 + 41.6808 * A + 17.7126 * A * A );
  vec3 alpha = clamp( 1.0 - s * s, vec3( 0.0 ), vec3( 0.9999 ) );
  vec3 sigT = 1.0 / max( radius, vec3( 1e-7 ) );
  vec3 sigS = alpha * sigT;
  weight = vec3( 1.0 );
  lastP = p;
  lastD = d;
  for ( int k = 0; k < 384; k ++ ) {
    // pick the channel that drives the distance in proportion to its weight (keeps weights bounded)
    vec3 pc = weight / max( weight.r + weight.g + weight.b, 1e-12 );
    float r = ndRand();
    float st = r < pc.r ? sigT.r : r < pc.r + pc.g ? sigT.g : sigT.b;
    float t = - log( 1.0 - ndRand() ) / st;
    bool hit = bvhIntersectFirstHit( bvh, p, d, h.faceIndices, h.faceNormal, h.barycoord, h.side, h.dist );
    if ( ! hit ) return false;
    if ( h.dist <= t ) {
      vec3 T = exp( - sigT * h.dist );
      weight *= T / max( dot( pc, T ), 1e-12 );
      lastP = p;
      lastD = d;
      return true;
    }
    vec3 T = exp( - sigT * t );
    weight *= sigS * T / max( dot( pc, sigT * T ), 1e-12 );
    p += d * t;
    d = ndSampleHG( d, g, vec2( ndRand(), ndRand() ) );
    float mx = max( weight.r, max( weight.g, weight.b ) );
    if ( mx < 0.05 ) {
      if ( ndRand() > mx * 10.0 ) return false;
      weight /= mx * 10.0;
    }
  }
  return false;
}
`;

const SSS_BLOCK = /* glsl */ `
						// --- subsurface scattering (random walk) / diffuse share of the remaining lobes
						ndDiffuseScale = 1.0;
						vec4 ndSa, ndSb;
						if ( hitType == SURFACE_HIT && ! surf.volumeParticle && surfaceHit.side == 1.0 && ndSssParams( materialIndex, ndSa, ndSb ) ) {
							float ndW = ndSa.x * ( 1.0 - surf.metalness ) * ( 1.0 - surf.transmission );
							float ndP = min( ndW, 0.8 );
							if ( ndP > 0.0 && ndRand() < ndP ) {
								vec3 ndN = surf.normal;
								vec3 ndIn = normalize( - ndN + sampleSphere( vec2( ndRand(), ndRand() ) ) * 0.999 );
								if ( dot( ndIn, surf.faceNormal ) >= 0.0 ) ndIn = - surf.faceNormal;
								float ndF0 = pow( ( ndSa.z - 1.0 ) / ( ndSa.z + 1.0 ), 2.0 );
								float ndF = schlickFresnel( clamp( dot( - ray.direction, ndN ), 0.0, 1.0 ), ndF0 );
								vec3 ndEntry = stepRayOrigin( ray.origin, ray.direction, - surf.faceNormal, surfaceHit.dist );
								vec3 ndLastP, ndLastD, ndWalk;
								SurfaceHit ndExit;
								if ( ! ndSubsurfaceWalk( surf.color, ndSb.rgb * ndSa.y, ndSa.w, ndEntry, ndIn, ndLastP, ndLastD, ndWalk, ndExit ) ) break;
								state.throughputColor *= ndWalk * ( 1.0 - ndF ) * ndW / ndP;
								vec3 ndOut = ndExit.faceNormal * sign( dot( ndExit.faceNormal, ndLastD ) );
								vec3 ndSmooth = textureSampleBarycoord( attributesArray, ATTR_NORMAL, ndExit.barycoord, ndExit.faceIndices.xyz ).xyz;
								ndSmooth = length( ndSmooth ) > 0.0 ? normalize( ndSmooth ) : ndOut;
								if ( dot( ndSmooth, ndOut ) < 0.0 ) ndSmooth = - ndSmooth;
								vec3 ndExitP = ndLastP + ndLastD * ndExit.dist;
								// continue from the exit point as a white diffuse surface
								surf.faceNormal = ndOut;
								surf.normal = ndSmooth;
								surf.clearcoatNormal = ndSmooth;
								surf.color = vec3( 1.0 );
								surf.emission = vec3( 0.0 );
								surf.metalness = 0.0;
								surf.transmission = 0.0;
								surf.clearcoat = 0.0;
								surf.sheen = 0.0;
								surf.iridescence = 0.0;
								surf.specularIntensity = 0.0;
								surf.roughness = 1.0;
								surf.filteredRoughness = 1.0;
								surf.frontFace = true;
								surf.normalBasis = getBasisFromNormal( ndSmooth );
								surf.normalInvBasis = inverse( surf.normalBasis );
								surf.clearcoatBasis = surf.normalBasis;
								surf.clearcoatInvBasis = surf.normalInvBasis;
								ray.origin = ndExitP + ndOut;
								ray.direction = - ndOut;
								surfaceHit.dist = 1.0;
								surfaceHit.faceNormal = ndOut;
								surfaceHit.side = 1.0;
							} else {
								state.throughputColor /= ( 1.0 - ndP );
								ndDiffuseScale = 1.0 - ndSa.x;
							}
						}
`;

function replaceOnce(src: string, find: string | RegExp, rep: string | ((m: string) => string)): string | null {
  const m = typeof find === 'string' ? (src.includes(find) ? find : null) : src.match(find)?.[0] ?? null;
  if (m === null) return null;
  const i = src.indexOf(m);
  return src.slice(0, i) + (typeof rep === 'string' ? rep : rep(m)) + src.slice(i + m.length);
}

/**
 * Add heterogeneous volumes, world volume and subsurface scattering to the path tracing shader.
 * Returns null when the shader does not have the expected structure (features stay off).
 */
export function patchVolumeShader(src: string): string | null {
  let s: string | null = src;
  const step = (find: string | RegExp, rep: string | ((m: string) => string)) => {
    if (s !== null) s = replaceOnce(s, find, rep);
  };
  // declarations: globals before the fog / BSDF functions, tracking after the render structs
  step('#ifndef FOG_CHECK_ITERATIONS', (m) => GLOBALS + '\n' + m);
  step(/#define FOG_HIT 3/, (m) => m + '\n' + TRACKING);
  // per-pixel random state
  step('rng_initialize( gl_FragCoord.xy, seed );', (m) => `${m}\n ndSeed = ( uint( gl_FragCoord.x ) * 1973u + uint( gl_FragCoord.y ) * 9277u + uint( seed ) * 26699u ) | 1u; ndRand(); ndPhaseG = 0.0; ndDiffuseScale = 1.0;`);
  // camera / bounce rays: scattering, absorption and emission of the current medium
  step(
    'int hitType = traceScene( ray, state.fogMaterial, surfaceHit );',
    `ndThroughput = state.throughputColor; ndVolWeight = vec3( 1.0 ); ndVolEmission = vec3( 0.0 ); ndVolAbsorbed = false; ndInWorldFog = false;
						int hitType = traceScene( ray, state.fogMaterial, surfaceHit );
						gl_FragColor.rgb += ndVolEmission * state.throughputColor;
						state.throughputColor *= ndVolWeight;
						if ( ndVolAbsorbed ) break;`,
  );
  step('float particleDist = intersectFogVolume( fogMaterial, rand( 1 ) );', 'float particleDist = ndFogDistance( fogMaterial, ray, hit ? surfaceHit.dist : INFINITY );');
  step(/#endif\s*if \( hit \) \{\s*result = SURFACE_HIT;/, (m) =>
    m.replace(
      /if \( hit \) \{/,
      `if ( ! ndVolAbsorbed && ndWorldAbsorb.w > 0.0 ${'&& ! fogMaterial.fogVolume'} ) {
			float worldDist = ndWorldDistance( ray, hit ? surfaceHit.dist : INFINITY );
			if ( worldDist < INFINITY ) {
				surfaceHit.side = 1.0;
				surfaceHit.faceNormal = normalize( - ray.direction );
				surfaceHit.dist = worldDist;
				ndInWorldFog = true;
				return FOG_HIT;
			}
		}

		if ( hit ) {`,
    ),
  );
  // scattering events: white albedo (the tracker weighted the path), no stored emission
  step(/material = state\.fogMaterial;\s*state\.accumulatedRoughness \+= 0\.2;/, 'material = state.fogMaterial; material.color = vec3( 1.0 ); material.emissiveIntensity = 0.0; material.emissive = vec3( 0.0 ); material.fogVolume = true; state.accumulatedRoughness += 0.2;');
  // shadow rays: ratio tracking
  step('int hitType = traceScene( ray, fogMaterial, surfaceHit );', 'int hitType = ndTraceShadow( ray, fogMaterial, surfaceHit, color, rayDist - distance( startPoint, ray.origin ) );');
  // Henyey–Greenstein phase function
  step(/color = surf\.color \/ \( 4\.0 \* PI \);\s*return 1\.0 \/ \( 4\.0 \* PI \);/, 'float ndPh = ndHG( dot( - worldWo, worldWi ), ndPhaseG ); color = surf.color * ndPh; return ndPh;');
  step(
    /sampleRec\.pdf = 1\.0 \/ \( 4\.0 \* PI \);\s*sampleRec\.direction = sampleSphere\( rand2\( 16 \) \);\s*sampleRec\.color = surf\.color \/ \( 4\.0 \* PI \);/,
    'sampleRec.direction = ndSampleHG( - worldWo, ndPhaseG, rand2( 16 ) ); sampleRec.pdf = ndHG( dot( - worldWo, sampleRec.direction ), ndPhaseG ); sampleRec.color = surf.color * sampleRec.pdf;',
  );
  // diffuse share left after subsurface scattering
  step('color = ( 1.0 - F ) * transFactor * metalFactor * wi.z * surf.color * ( retro + lambert ) / PI;', 'color = ( 1.0 - F ) * transFactor * metalFactor * wi.z * surf.color * ( retro + lambert ) / PI * ndDiffuseScale;');
  step('scatterRec = bsdfSample( - ray.direction, surf );', (m) => SSS_BLOCK + '\n\t\t\t\t\t\t' + m);
  return s;
}

// ---------------------------------------------------------------------------
// Uniforms

export function volumeUniforms(): Record<string, { value: unknown }> {
  const arr4 = () => Array.from({ length: MAX_VOLUMES }, () => new Vector4());
  const empty = new Data3DTexture(new Uint8Array(4), 1, 1, 1);
  empty.needsUpdate = true;
  return {
    ndVolAtlas: { value: empty },
    ndVolCount: { value: 0 },
    ndVolToUvw: { value: Array.from({ length: MAX_VOLUMES }, () => new Matrix4()) },
    ndVolTile: { value: arr4() },
    ndVolScatter: { value: arr4() },
    ndVolAbsorb: { value: arr4() },
    ndVolEmit: { value: arr4() },
    ndVolBody: { value: arr4() },
    ndVolTint: { value: arr4() },
    ndWorldScatter: { value: new Vector4() },
    ndWorldAbsorb: { value: new Vector4() },
    ndWorldEmit: { value: new Vector4() },
    ndSssA: { value: Array.from({ length: MAX_SSS }, () => new Vector4()) },
    ndSssB: { value: Array.from({ length: MAX_SSS }, () => new Vector4()) },
    ndSssCount: { value: 0 },
  };
}

/** Pack several volumes into one RGBA8 3D atlas (stacked along z with one empty slice between). */
export function buildAtlas(list: PackedVolume[]): { tex: Data3DTexture; tiles: [number, number, number, number][] } {
  const W = Math.max(1, ...list.map((p) => p.dims[0]));
  const H = Math.max(1, ...list.map((p) => p.dims[1]));
  const D = Math.max(1, list.reduce((a, p) => a + p.dims[2] + 1, 0));
  const data = new Uint8Array(W * H * D * 4);
  const tiles: [number, number, number, number][] = [];
  let z0 = 0;
  for (const p of list) {
    const [nx, ny, nz] = p.dims;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++) {
        const src = ((k * ny + j) * nx) * 4;
        const dst = (((z0 + k) * H + j) * W) * 4;
        data.set(p.data.subarray(src, src + nx * 4), dst);
      }
    tiles.push([nx / W, ny / H, z0 / D, nz / D]);
    z0 += nz + 1;
  }
  const tex = new Data3DTexture(data, W, H, D);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return { tex, tiles };
}

/** Majorant of a volume: the largest extinction it can reach (plus enough for emitters). */
export function volumeMajorant(v: Pick<PtVolume, 'packed' | 'shader' | 'diagonal'>): number {
  const s = v.shader;
  const k = s.densityScale * v.packed.scale[0];
  let mu = 0;
  for (let c = 0; c < 3; c++) mu = Math.max(mu, (s.scatter[c] + s.absorb[c]) * k);
  const emits = s.emission.some((x) => x > 0) || s.blackbodyIntensity > 0;
  if (emits) mu = Math.max(mu, 48 / Math.max(1e-6, v.diagonal));
  return mu;
}

/** Upload a volume set into the path tracing material's uniforms. */
export function applyVolumeUniforms(u: Record<string, { value: unknown }>, set: PtVolumeSet | undefined, cache: { key: string; tex: Data3DTexture | null }) {
  const list = (set?.volumes ?? []).slice(0, MAX_VOLUMES);
  if (cache.key !== (set?.key ?? '')) {
    cache.key = set?.key ?? '';
    cache.tex?.dispose();
    cache.tex = null;
    if (list.length) {
      const a = buildAtlas(list.map((v) => v.packed));
      cache.tex = a.tex;
      list.forEach((v, i) => (u.ndVolTile.value as Vector4[])[i].set(...a.tiles[i]));
    }
  }
  if (cache.tex) u.ndVolAtlas.value = cache.tex;
  u.ndVolCount.value = list.length;
  list.forEach((v, i) => {
    const s = v.shader;
    const k = s.densityScale * v.packed.scale[0];
    (u.ndVolToUvw.value as Matrix4[])[i].copy(v.worldToUvw);
    (u.ndVolScatter.value as Vector4[])[i].set(s.scatter[0] * k, s.scatter[1] * k, s.scatter[2] * k, volumeMajorant(v));
    (u.ndVolAbsorb.value as Vector4[])[i].set(s.absorb[0] * k, s.absorb[1] * k, s.absorb[2] * k, k);
    const eg = !!s.emissionGrid && v.packed.scale[1] > 0;
    const es = eg ? v.packed.scale[1] : 1;
    (u.ndVolEmit.value as Vector4[])[i].set(s.emission[0] * es, s.emission[1] * es, s.emission[2] * es, eg ? 1 : 0);
    const tg = !!s.temperatureGrid && v.packed.scale[2] > 0;
    (u.ndVolBody.value as Vector4[])[i].set(s.blackbodyIntensity, tg ? s.temperature * v.packed.scale[2] : 0, tg ? 0 : s.temperature, v.clipping ?? 0);
    (u.ndVolTint.value as Vector4[])[i].set(s.blackbodyTint[0], s.blackbodyTint[1], s.blackbodyTint[2], s.anisotropy);
  });
  const w = set?.world;
  if (w) {
    (u.ndWorldScatter.value as Vector4).set(w.scatter[0], w.scatter[1], w.scatter[2], w.anisotropy);
    (u.ndWorldAbsorb.value as Vector4).set(w.absorb[0], w.absorb[1], w.absorb[2], w.scatter.some((x) => x > 0) || w.absorb.some((x) => x > 0) ? 1 : 0);
    (u.ndWorldEmit.value as Vector4).set(w.emission[0], w.emission[1], w.emission[2], 0);
  } else {
    (u.ndWorldAbsorb.value as Vector4).set(0, 0, 0, 0);
    (u.ndWorldScatter.value as Vector4).set(0, 0, 0, 0);
    (u.ndWorldEmit.value as Vector4).set(0, 0, 0, 0);
  }
}

/** Subsurface settings per path tracer material (material order of the scene generator). */
export interface SssSettings {
  weight: number;
  radius: [number, number, number];
  scale: number;
  ior: number;
  anisotropy: number;
}

export function applySssUniforms(u: Record<string, { value: unknown }>, materials: Material[]): boolean {
  let count = 0;
  const A = u.ndSssA.value as Vector4[],
    B = u.ndSssB.value as Vector4[];
  for (let i = 0; i < MAX_SSS; i++) {
    const s = (materials[i]?.userData?.sss ?? null) as SssSettings | null;
    if (!s || !(s.weight > 0)) {
      A[i].set(0, 0, 0, 0);
      continue;
    }
    A[i].set(s.weight, Math.max(0, s.scale), Math.max(1.01, s.ior), Math.max(-0.95, Math.min(0.95, s.anisotropy)));
    B[i].set(Math.max(0, s.radius[0]), Math.max(0, s.radius[1]), Math.max(0, s.radius[2]), 0);
    count = i + 1;
  }
  u.ndSssCount.value = count;
  return count > 0;
}
