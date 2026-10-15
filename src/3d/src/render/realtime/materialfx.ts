// Material ▸ Settings options of the realtime engine applied to compiled three.js materials.
import { FrontSide, type Material, type MeshPhysicalMaterial } from 'three';
import type { MaterialData } from '../../data/types';
import { fxOnBeforeCompile } from './fxshader';

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
