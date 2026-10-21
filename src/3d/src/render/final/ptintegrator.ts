// Integrator options patched into the path tracing shader: bounce limits per kind (diffuse / glossy / transmission / volume), caustics
// filtering, the fast GI approximation, transparent glass for transparent film and the bounce
// count before russian roulette. Values come from `integratorValues` (ptsettings.ts).
import { Vector2, Vector4 } from 'three';
import type { IntegratorValues } from './ptsettings';

const HELPERS = /* glsl */ `
uniform ivec4 ptBounce;
uniform vec2 ptCaus;
uniform vec4 ptFastGi;
uniform vec4 ptGlass;
uniform int ptMinB;
`;

/** Patch the shader (after the other patches). Returns null when a step does not match. */
export function patchIntegrator(src: string): string | null {
  let s = src;
  const step = (find: string, rep: (m: string) => string) => {
    const i = s.indexOf(find);
    if (i < 0 || s.indexOf(find, i + 1) >= 0) return false;
    s = s.slice(0, i) + rep(find) + s.slice(i + find.length);
    return true;
  };
  const mainAt = s.indexOf('void main()');
  if (mainAt < 0) return null;
  s = s.slice(0, mainAt) + HELPERS + s.slice(mainAt);
  const ok =
    // the noise seed shifts the per-pixel offsets of the stratified samples
    step('pixelSeed = texture( stratifiedOffsetTexture, uv );', () => 'pixelSeed = fract( texture( stratifiedOffsetTexture, uv ) + ptSeedOff );') &&
    step('void rng_initialize( vec2 screenCoord, int frame ) {', (m) => `uniform vec4 ptSeedOff;\n${m}`) &&
    step('RenderState state = initRenderState();', (m) =>
      [
        m,
        'int ptN[ 4 ] = int[ 4 ]( 0, 0, 0, 0 );',
        'bool ptAfterDiffuse = false;',
      ].join('\n'),
    ) &&
    step('bool isTransmissiveRay = ! surf.volumeParticle && dot( scatterRec.direction, surf.faceNormal * surfaceHit.side ) < 0.0;', (m) =>
      `${m}
						{
							// kind of this bounce: 0 diffuse, 1 glossy, 2 transmission, 3 volume
							int ptKind = surf.volumeParticle ? 3 : ( isTransmissiveRay || isBelowSurface ) ? 2 : state.isShadowRay ? 0 : 1;
							ptN[ ptKind ] ++;
							if ( ptN[ 0 ] > ptBounce.x || ptN[ 1 ] > ptBounce.y || ptN[ 2 ] > ptBounce.z || ptN[ 3 ] > ptBounce.w ) break;
							// caustics: specular bounces after a diffuse one
							if ( ptAfterDiffuse && ( ( ptKind == 1 && ptCaus.x < 0.5 ) || ( ptKind == 2 && ptCaus.y < 0.5 ) ) ) break;
							if ( ptKind == 0 || ptKind == 3 ) ptAfterDiffuse = true;
							// transparent film: only smooth glass lets the background through
							if ( ptKind == 2 && ( ptGlass.x < 0.5 || surf.roughness > ptGlass.y ) ) state.transmissiveRay = false;
						}`,
    ) &&
    step('uint minBounces = 3u;', () => 'uint minBounces = uint( max( ptMinB, 0 ) );') &&
    step('ray.direction = scatterRec.direction;', (m) =>
      `// fast GI approximation: past the set bounces, light comes from the world unless occluded nearby
						if ( ptFastGi.x > 0.5 && int( state.depth ) > int( ptFastGi.y ) && ! surf.volumeParticle ) {
							SurfaceHit ptAo;
							bool ptHit = bvhIntersectFirstHit( bvh, hitPoint, scatterRec.direction, ptAo.faceIndices, ptAo.faceNormal, ptAo.barycoord, ptAo.side, ptAo.dist );
							if ( ! ptHit || ptAo.dist > ptFastGi.z ) {
								gl_FragColor.rgb += environmentIntensity * sampleEquirectColor( envMapInfo.map, envRotation3x3 * scatterRec.direction ) * state.throughputColor * ptFastGi.w;
							}
							if ( ptGlass.z < 0.5 ) break;
						}
						${m}`,
    );
  return ok ? s : null;
}

/** Uniform objects of the patch (shared with the material). */
export function integratorUniforms() {
  return {
    ptSeedOff: { value: new Vector4(0, 0, 0, 0) },
    ptBounce: { value: [1024, 1024, 1024, 1024] },
    ptCaus: { value: new Vector2(1, 1) },
    ptFastGi: { value: new Vector4(0, 1, 10, 1) },
    ptGlass: { value: new Vector4(0, 0.1, 0, 0) },
    ptMinB: { value: 3 },
  };
}

type U = ReturnType<typeof integratorUniforms>;

/** Per-pixel sample offset of a noise seed (0 for seed 0). */
export function seedOffset(seed: number): [number, number, number, number] {
  if (!seed) return [0, 0, 0, 0];
  const out: [number, number, number, number] = [0, 0, 0, 0];
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < 4; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x / 4294967296;
  }
  return out;
}

/** Write integrator values into the uniforms; returns a key that changes when they change. */
export function applyIntegrator(u: U, v: IntegratorValues): string {
  u.ptBounce.value = [...v.bounces];
  u.ptCaus.value.set(v.caustics[0] ? 1 : 0, v.caustics[1] ? 1 : 0);
  u.ptFastGi.value.set(v.fastGi[0], v.fastGi[1], v.fastGi[2], v.fastGi[3]);
  u.ptGlass.value.set(v.glass[0] ? 1 : 0, v.glass[1], v.fastGiAdd ? 1 : 0, 0);
  u.ptMinB.value = v.minBounces;
  return JSON.stringify(v);
}
