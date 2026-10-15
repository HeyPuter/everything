// Material ▸ Settings options of the realtime engine applied to compiled three.js materials.
import { DoubleSide, FrontSide, MeshDepthMaterial, MeshDistanceMaterial, type Material, type MeshPhysicalMaterial, type WebGLProgramParametersWithUniforms } from 'three';
import type { MaterialData } from '../../data/types';
import { fxOnBeforeCompile, fxUniforms, ALPHA_HASH_TEMPORAL } from './fxshader';

/** Part of the compiled-material cache key that depends on realtime settings. */
export function realtimeMaterialKey(ma: MaterialData): string {
  return `${ma.use_raytrace_refraction === false ? 1 : 0}|${ma.refraction_depth ?? 0}|${ma.use_backface_culling_shadow ? 1 : 0}`;
}

/** Shadow casting of a material (None disables it). */
export function castsShadow(ma: MaterialData | undefined): boolean {
  return !ma || ma.shadow_method !== 'NONE';
}

/** Apply refraction / shadow options to a compiled material. */
export function applyRealtimeMaterial(mat: Material, ma: MaterialData) {
  const m = mat as MeshPhysicalMaterial;
  if (!m.isMeshStandardMaterial) return;
  const defines = { ...(m.defines ?? {}) } as Record<string, string>;
  if (ma.use_raytrace_refraction === false) defines.ND_PROBE_REFRACTION = '';
  else delete defines.ND_PROBE_REFRACTION;
  m.defines = defines;
  const depth = ma.refraction_depth ?? 0;
  if (m.isMeshPhysicalMaterial && m.transmission > 0 && depth > 0) m.thickness = depth;
  m.shadowSide = ma.use_backface_culling_shadow ? FrontSide : null;
}

/** Fallback materials (no node tree patches of their own) get the realtime effects too. */
export function withRealtimeFx<T extends Material>(m: T): T {
  m.onBeforeCompile = fxOnBeforeCompile;
  return m;
}

const shadowCache = new WeakMap<Material, { opacity: number; side: unknown; depth: MeshDepthMaterial; distance: MeshDistanceMaterial }>();

/**
 * Shadow-casting materials for Transparent shadow mode: partly transparent surfaces cast
 * dithered (stochastic) shadows that average to a partial shadow. Undefined when the surface
 * casts a plain opaque shadow.
 */
export function transparentShadowMaterials(mat: Material, ma: MaterialData | undefined): { depth: MeshDepthMaterial; distance: MeshDistanceMaterial } | undefined {
  if (!ma || (ma.shadow_method !== 'HASHED' && ma.shadow_method !== 'CLIP')) return undefined;
  const m = mat as MeshPhysicalMaterial;
  const opacity = m.opacity ?? 1;
  if (!(opacity < 1)) return undefined;
  const side = ma.use_backface_culling_shadow ? FrontSide : DoubleSide;
  const hit = shadowCache.get(mat);
  if (hit && hit.opacity === opacity && hit.side === side) return hit;
  const clip = ma.shadow_method === 'CLIP';
  const opts = { opacity, alphaHash: !clip, alphaTest: clip ? Math.max(1e-4, ma.alpha_threshold) : 0, side };
  const depth = new MeshDepthMaterial(opts),
    distance = new MeshDistanceMaterial(opts);
  // the distance material ignores opacity, and the dither pattern changes per sample
  const patch = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.ndOpacity = { value: opacity };
    shader.uniforms.ndFx = fxUniforms.ndFx;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float ndOpacity;\nuniform vec4 ndFx;\nvoid main() {')
      .replace('vec4 diffuseColor = vec4( 1.0 );', 'vec4 diffuseColor = vec4( 1.0, 1.0, 1.0, ndOpacity );')
      .replace('#include <alphahash_fragment>', ALPHA_HASH_TEMPORAL);
  };
  depth.onBeforeCompile = distance.onBeforeCompile = patch;
  const out = { opacity, side, depth, distance };
  hit?.depth.dispose();
  hit?.distance.dispose();
  shadowCache.set(mat, out);
  return out;
}
