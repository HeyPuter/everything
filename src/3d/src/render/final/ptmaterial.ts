// Convert arbitrary viewport materials into MeshPhysicalMaterials the path tracer understands.
// Standard/physical materials map directly. Custom shader materials (e.g. from the shader node
// compiler) may describe their PBR base parameters in `material.userData.pbr`
// (see `PbrHint`); otherwise uniforms with conventional names are inspected.
import { MeshPhysicalMaterial, MeshBasicMaterial, Color, DoubleSide, FrontSide, BackSide, type Material, type Texture, MeshStandardMaterial, ShaderMaterial, Vector2 } from 'three';

export interface PbrHint {
  color?: [number, number, number] | Color;
  map?: Texture | null;
  roughness?: number;
  roughnessMap?: Texture | null;
  metalness?: number;
  metalnessMap?: Texture | null;
  normalMap?: Texture | null;
  normalScale?: number;
  emissive?: [number, number, number] | Color;
  emissiveIntensity?: number;
  emissiveMap?: Texture | null;
  transmission?: number;
  ior?: number;
  opacity?: number;
  alphaMap?: Texture | null;
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheen?: number;
  sheenColor?: [number, number, number] | Color;
  sheenRoughness?: number;
  specularIntensity?: number;
  specularColor?: [number, number, number] | Color;
  iridescence?: number;
  thickness?: number;
  attenuationColor?: [number, number, number] | Color;
  attenuationDistance?: number;
  /** random-walk subsurface scattering (path tracer only) */
  subsurface?: { weight: number; radius: [number, number, number]; scale: number; ior: number; anisotropy: number } | null;
}

const cache = new WeakMap<Material, { version: number; hint: number; out: MeshPhysicalMaterial }>();

const toColor = (c: [number, number, number] | Color | undefined, target: Color) => {
  if (!c) return;
  if (c instanceof Color) target.copy(c);
  else target.setRGB(c[0], c[1], c[2]);
};

function uniformValue(m: ShaderMaterial, names: string[]): unknown {
  for (const n of names) if (m.uniforms?.[n] !== undefined) return m.uniforms[n].value;
  return undefined;
}

/** Path-tracer material for a viewport material (cached per material version). */
export function pathTracerMaterial(src: Material): MeshPhysicalMaterial {
  const hit = cache.get(src);
  // compiled node materials refresh their hint when only values change (no new program)
  const hint = (src.userData?.pbrVersion as number | undefined) ?? 0;
  if (hit && hit.version === src.version && hit.hint === hint) return hit.out;
  const out = hit?.out ?? new MeshPhysicalMaterial();
  convertInto(src, out);
  out.needsUpdate = true;
  cache.set(src, { version: src.version, hint, out });
  return out;
}

function convertInto(src: Material, m: MeshPhysicalMaterial) {
  m.side = src.side === FrontSide ? FrontSide : src.side === BackSide ? BackSide : DoubleSide;
  m.transparent = src.transparent;
  m.opacity = src.opacity;
  m.alphaTest = src.alphaTest;
  const hint = (src.userData?.pbr ?? null) as PbrHint | null;
  if (src instanceof MeshStandardMaterial) {
    // copy every physical property the path tracer reads
    m.color.copy(src.color);
    m.map = src.map;
    m.roughness = src.roughness;
    m.roughnessMap = src.roughnessMap;
    m.metalness = src.metalness;
    m.metalnessMap = src.metalnessMap;
    m.normalMap = src.normalMap;
    m.normalScale.copy(src.normalScale);
    m.emissive.copy(src.emissive);
    m.emissiveIntensity = src.emissiveIntensity;
    m.emissiveMap = src.emissiveMap;
    m.alphaMap = src.alphaMap;
    m.opacity = src.opacity;
    m.vertexColors = src.vertexColors;
    m.flatShading = src.flatShading;
    if ((src as MeshPhysicalMaterial).isMeshPhysicalMaterial) {
      const p = src as MeshPhysicalMaterial;
      m.ior = p.ior;
      m.transmission = p.transmission;
      m.transmissionMap = p.transmissionMap;
      m.thickness = p.thickness;
      m.attenuationColor.copy(p.attenuationColor);
      m.attenuationDistance = p.attenuationDistance;
      m.clearcoat = p.clearcoat;
      m.clearcoatRoughness = p.clearcoatRoughness;
      m.clearcoatMap = p.clearcoatMap;
      m.clearcoatRoughnessMap = p.clearcoatRoughnessMap;
      m.sheen = p.sheen;
      m.sheenColor.copy(p.sheenColor);
      m.sheenRoughness = p.sheenRoughness;
      m.specularIntensity = p.specularIntensity;
      m.specularColor.copy(p.specularColor);
      m.iridescence = p.iridescence;
      m.iridescenceIOR = p.iridescenceIOR;
    } else {
      m.ior = 1.5;
      m.transmission = 0;
    }
  } else if (src instanceof MeshBasicMaterial) {
    // unlit: emit its colour
    m.color.setRGB(0, 0, 0);
    m.emissive.copy(src.color);
    m.emissiveMap = src.map;
    m.emissiveIntensity = 1;
    m.roughness = 1;
    m.metalness = 0;
  } else {
    const sm = src as ShaderMaterial;
    const col = uniformValue(sm, ['uColor', 'color', 'diffuse', 'baseColor', 'uBaseColor']);
    if (col instanceof Color) m.color.copy(col);
    else m.color.setRGB(0.8, 0.8, 0.8);
    const map = uniformValue(sm, ['map', 'uMap', 'baseColorMap']);
    m.map = map && (map as Texture).isTexture ? (map as Texture) : null;
    const r = uniformValue(sm, ['roughness', 'uRoughness']);
    m.roughness = typeof r === 'number' ? r : 0.5;
    const mt = uniformValue(sm, ['metalness', 'metallic', 'uMetallic']);
    m.metalness = typeof mt === 'number' ? mt : 0;
    m.emissive.setRGB(0, 0, 0);
    m.transmission = 0;
  }
  if (hint) applyHint(m, hint);
  // a finite stand-in for "no absorption" inside solid transmissive objects (infinite values
  // turned refraction black on some GPUs); thin surfaces keep Infinity, which marks them thin
  if (!isFinite(m.attenuationDistance) && m.thickness > 0) m.attenuationDistance = 1e20;
  m.userData.sss = hint?.subsurface ?? null;
}

function applyHint(m: MeshPhysicalMaterial, h: PbrHint) {
  toColor(h.color, m.color);
  if (h.map !== undefined) m.map = h.map;
  if (h.roughness !== undefined) m.roughness = h.roughness;
  if (h.roughnessMap !== undefined) m.roughnessMap = h.roughnessMap;
  if (h.metalness !== undefined) m.metalness = h.metalness;
  if (h.metalnessMap !== undefined) m.metalnessMap = h.metalnessMap;
  if (h.normalMap !== undefined) m.normalMap = h.normalMap;
  if (h.normalScale !== undefined) m.normalScale = new Vector2(h.normalScale, h.normalScale);
  toColor(h.emissive, m.emissive);
  if (h.emissiveIntensity !== undefined) m.emissiveIntensity = h.emissiveIntensity;
  if (h.emissiveMap !== undefined) m.emissiveMap = h.emissiveMap;
  if (h.transmission !== undefined) m.transmission = h.transmission;
  if (h.ior !== undefined) m.ior = h.ior;
  if (h.opacity !== undefined) {
    m.opacity = h.opacity;
    m.transparent = h.opacity < 1;
  }
  if (h.alphaMap !== undefined) m.alphaMap = h.alphaMap;
  if (h.clearcoat !== undefined) m.clearcoat = h.clearcoat;
  if (h.clearcoatRoughness !== undefined) m.clearcoatRoughness = h.clearcoatRoughness;
  if (h.sheen !== undefined) m.sheen = h.sheen;
  toColor(h.sheenColor, m.sheenColor);
  if (h.sheenRoughness !== undefined) m.sheenRoughness = h.sheenRoughness;
  if (h.specularIntensity !== undefined) m.specularIntensity = h.specularIntensity;
  toColor(h.specularColor, m.specularColor);
  if (h.iridescence !== undefined) m.iridescence = h.iridescence;
  if (h.thickness !== undefined) m.thickness = h.thickness;
  toColor(h.attenuationColor, m.attenuationColor);
  if (h.attenuationDistance !== undefined) m.attenuationDistance = h.attenuationDistance;
}

/** Base colour / albedo of a (converted) material, used by the denoiser's albedo guide. */
const albedoCache = new WeakMap<MeshPhysicalMaterial, { version: number; out: MeshBasicMaterial }>();
export function albedoMaterial(m: MeshPhysicalMaterial): MeshBasicMaterial {
  const hit = albedoCache.get(m);
  if (hit && hit.version === m.version) return hit.out;
  const out = hit?.out ?? new MeshBasicMaterial();
  out.color.copy(m.color);
  // metals and glass reflect their surroundings: use a neutral guide so the filter keeps detail
  if (m.metalness > 0.5 || m.transmission > 0.5) out.color.setRGB(1, 1, 1);
  out.map = m.metalness > 0.5 || m.transmission > 0.5 ? null : m.map;
  out.side = m.side;
  out.vertexColors = m.vertexColors;
  out.toneMapped = false;
  out.needsUpdate = true;
  albedoCache.set(m, { version: m.version, out });
  return out;
}
