// Texture baking settings (scene.render.bake and scene.render.bake_type): what to bake, where the
// result goes and how the rays are cast. Pure data helpers shared by the panel, the operator and
// scripts.
import type { RenderSettings } from '../data/types';

export type BakeType = 'COMBINED' | 'AO' | 'SHADOW' | 'POSITION' | 'NORMAL' | 'UV' | 'ROUGHNESS' | 'EMIT' | 'ENVIRONMENT' | 'DIFFUSE' | 'GLOSSY' | 'TRANSMISSION';
export type NormalSwizzle = 'POS_X' | 'POS_Y' | 'POS_Z' | 'NEG_X' | 'NEG_Y' | 'NEG_Z';
export type PassFilterItem = 'NONE' | 'EMIT' | 'DIRECT' | 'INDIRECT' | 'COLOR' | 'DIFFUSE' | 'GLOSSY' | 'TRANSMISSION';

export interface BakeSettings {
  /** multires bake: what to bake from the highest subdivision level */
  type: 'NORMALS' | 'DISPLACEMENT';
  use_multires: boolean;
  /** multires displacement: measure against the base mesh instead of the preview level */
  use_lores_mesh: boolean;
  use_selected_to_active: boolean;
  use_cage: boolean;
  /** object id of the cage mesh (same topology as the active object) */
  cage_object: string | null;
  cage_extrusion: number;
  max_ray_distance: number;
  target: 'IMAGE_TEXTURES' | 'VERTEX_COLORS';
  use_clear: boolean;
  margin: number;
  margin_type: 'ADJACENT_FACES' | 'EXTEND';
  normal_space: 'OBJECT' | 'TANGENT';
  normal_r: NormalSwizzle;
  normal_g: NormalSwizzle;
  normal_b: NormalSwizzle;
  /** where glossy and other view-dependent passes are seen from */
  view_from: 'ABOVE_SURFACE' | 'ACTIVE_CAMERA';
  use_pass_direct: boolean;
  use_pass_indirect: boolean;
  use_pass_color: boolean;
  use_pass_diffuse: boolean;
  use_pass_glossy: boolean;
  use_pass_transmission: boolean;
  use_pass_emit: boolean;
}

export const BAKE_TYPES: [BakeType, string, string][] = [
  ['COMBINED', 'Combined', 'Everything the surface shows: lighting of all its shading components plus emission'],
  ['AO', 'Ambient Occlusion', 'How open each point is to its surroundings (white: unobstructed)'],
  ['SHADOW', 'Shadow', 'Fraction of the lights reaching each point'],
  ['POSITION', 'Position', 'World-space position of each point'],
  ['NORMAL', 'Normal', 'Shading normal, in tangent or object space'],
  ['UV', 'UV', 'Texture coordinates of each point'],
  ['ROUGHNESS', 'Roughness', 'Material roughness'],
  ['EMIT', 'Emission', 'Emitted light (color times strength)'],
  ['ENVIRONMENT', 'Environment', 'World light arriving along the surface normal'],
  ['DIFFUSE', 'Diffuse', 'Diffuse component: lighting and/or color'],
  ['GLOSSY', 'Glossy', 'Specular reflection component: lighting and/or color'],
  ['TRANSMISSION', 'Transmission', 'Refraction component: lighting and/or color'],
];

export const SWIZZLE: [NormalSwizzle, string][] = [
  ['POS_X', '+X'],
  ['POS_Y', '+Y'],
  ['POS_Z', '+Z'],
  ['NEG_X', '-X'],
  ['NEG_Y', '-Y'],
  ['NEG_Z', '-Z'],
];

export function defaultBakeSettings(): BakeSettings {
  return {
    type: 'NORMALS',
    use_multires: false,
    use_lores_mesh: false,
    use_selected_to_active: false,
    use_cage: false,
    cage_object: null,
    cage_extrusion: 0,
    max_ray_distance: 0,
    target: 'IMAGE_TEXTURES',
    use_clear: true,
    margin: 16,
    margin_type: 'ADJACENT_FACES',
    normal_space: 'TANGENT',
    normal_r: 'POS_X',
    normal_g: 'POS_Y',
    normal_b: 'POS_Z',
    view_from: 'ABOVE_SURFACE',
    use_pass_direct: true,
    use_pass_indirect: true,
    use_pass_color: true,
    use_pass_diffuse: true,
    use_pass_glossy: true,
    use_pass_transmission: true,
    use_pass_emit: true,
  };
}

type WithBake = RenderSettings;

/** The scene's bake settings with every field present (older files lack them). */
export function bakeSettings(r: RenderSettings): BakeSettings {
  const w = r as WithBake;
  const d = defaultBakeSettings();
  if (!w.bake) w.bake = d;
  else for (const k in d) if ((w.bake as unknown as Record<string, unknown>)[k] === undefined) (w.bake as unknown as Record<string, unknown>)[k] = (d as unknown as Record<string, unknown>)[k];
  return w.bake;
}

export function bakeType(r: RenderSettings): BakeType {
  return (r as WithBake).bake_type ?? 'COMBINED';
}

export function setBakeType(r: RenderSettings, t: BakeType) {
  (r as WithBake).bake_type = t;
}

/** Bake types whose result depends on lighting (traced with many samples). */
export const LIT_TYPES = new Set<BakeType>(['COMBINED', 'DIFFUSE', 'GLOSSY', 'TRANSMISSION']);
/** Bake types that are noisy and need the scene's sample count. */
export const SAMPLED_TYPES = new Set<BakeType>(['COMBINED', 'DIFFUSE', 'GLOSSY', 'TRANSMISSION', 'AO', 'SHADOW']);
/** Bake types holding data rather than colors (written without view transform; images should be Non-Color). */
export const DATA_TYPES = new Set<BakeType>(['NORMAL', 'POSITION', 'UV', 'ROUGHNESS']);

/** The pass_filter flag set as the operator takes it (from the use_pass_* settings). */
export function passFilterOf(b: BakeSettings): PassFilterItem[] {
  const out: PassFilterItem[] = [];
  if (b.use_pass_emit) out.push('EMIT');
  if (b.use_pass_direct) out.push('DIRECT');
  if (b.use_pass_indirect) out.push('INDIRECT');
  if (b.use_pass_color) out.push('COLOR');
  if (b.use_pass_diffuse) out.push('DIFFUSE');
  if (b.use_pass_glossy) out.push('GLOSSY');
  if (b.use_pass_transmission) out.push('TRANSMISSION');
  return out;
}

/** Contributions selected by a pass filter (an empty filter means the scene's settings). */
export interface Contributions {
  direct: boolean;
  indirect: boolean;
  color: boolean;
  diffuse: boolean;
  glossy: boolean;
  transmission: boolean;
  emit: boolean;
}

export function contributions(filter: readonly string[] | null | undefined, b: BakeSettings): Contributions {
  const f = filter && filter.length ? new Set(filter) : new Set<string>(passFilterOf(b));
  if (f.has('NONE')) f.clear();
  return {
    direct: f.has('DIRECT'),
    indirect: f.has('INDIRECT'),
    color: f.has('COLOR'),
    diffuse: f.has('DIFFUSE'),
    glossy: f.has('GLOSSY'),
    transmission: f.has('TRANSMISSION'),
    emit: f.has('EMIT'),
  };
}

/** Why a bake with these contributions would produce nothing (null when it is valid). */
export function contributionProblem(type: BakeType, c: Contributions): string | null {
  if (type === 'COMBINED') {
    if (!c.emit && !((c.direct || c.indirect) && (c.diffuse || c.glossy || c.transmission))) return 'Combined bake: enable Emission, or Direct/Indirect lighting together with at least one of Diffuse, Glossy or Transmission';
  } else if (type === 'DIFFUSE' || type === 'GLOSSY' || type === 'TRANSMISSION') {
    if (!c.direct && !c.indirect && !c.color) return `${type[0] + type.slice(1).toLowerCase()} bake: enable at least one of Direct, Indirect or Color`;
  }
  return null;
}
