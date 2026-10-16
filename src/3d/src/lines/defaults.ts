// Factories for line sets, line styles and their modifiers, plus lookup helpers.
import { uid } from '../data/defaults';
import type { DocumentData, ID, RenderSettings } from '../data/types';
import { EDGE_TYPES, linestyleTable, type FreestyleSettings, type LineSet, type LineStyleData, type LineStyleModifier } from './types';

export type ModifierKind = 'color' | 'alpha' | 'thickness' | 'geometry';

export const COLOR_MODIFIER_TYPES: [string, string][] = [
  ['ALONG_STROKE', 'Along Stroke'],
  ['CREASE_ANGLE', 'Crease Angle'],
  ['CURVATURE_3D', 'Curvature 3D'],
  ['DISTANCE_FROM_CAMERA', 'Distance from Camera'],
  ['DISTANCE_FROM_OBJECT', 'Distance from Object'],
  ['MATERIAL', 'Material'],
  ['NOISE', 'Noise'],
  ['TANGENT', 'Tangent'],
];
export const ALPHA_MODIFIER_TYPES = COLOR_MODIFIER_TYPES;
export const THICKNESS_MODIFIER_TYPES: [string, string][] = [
  ['ALONG_STROKE', 'Along Stroke'],
  ['CALLIGRAPHY', 'Calligraphy'],
  ['CREASE_ANGLE', 'Crease Angle'],
  ['CURVATURE_3D', 'Curvature 3D'],
  ['DISTANCE_FROM_CAMERA', 'Distance from Camera'],
  ['DISTANCE_FROM_OBJECT', 'Distance from Object'],
  ['MATERIAL', 'Material'],
  ['NOISE', 'Noise'],
  ['TANGENT', 'Tangent'],
];
export const GEOMETRY_MODIFIER_TYPES: [string, string][] = [
  ['2D_OFFSET', '2D Offset'],
  ['2D_TRANSFORM', '2D Transform'],
  ['BACKBONE_STRETCHER', 'Backbone Stretcher'],
  ['BEZIER_CURVE', 'Bézier Curve'],
  ['BLUEPRINT', 'Blueprint'],
  ['GUIDING_LINES', 'Guiding Lines'],
  ['PERLIN_NOISE_1D', 'Perlin Noise 1D'],
  ['PERLIN_NOISE_2D', 'Perlin Noise 2D'],
  ['POLYGONIZATION', 'Polygonization'],
  ['SAMPLING', 'Sampling'],
  ['SIMPLIFICATION', 'Simplification'],
  ['SINUS_DISPLACEMENT', 'Sinus Displacement'],
  ['SPATIAL_NOISE', 'Spatial Noise'],
  ['TIP_REMOVER', 'Tip Remover'],
];
export const MODIFIER_TYPES: Record<ModifierKind, [string, string][]> = { color: COLOR_MODIFIER_TYPES, alpha: ALPHA_MODIFIER_TYPES, thickness: THICKNESS_MODIFIER_TYPES, geometry: GEOMETRY_MODIFIER_TYPES };

export const COLOR_BLEND: [string, string][] = [
  ['MIX', 'Mix'],
  ['DARKEN', 'Darken'],
  ['MULTIPLY', 'Multiply'],
  ['BURN', 'Color Burn'],
  ['LIGHTEN', 'Lighten'],
  ['SCREEN', 'Screen'],
  ['DODGE', 'Color Dodge'],
  ['ADD', 'Add'],
  ['OVERLAY', 'Overlay'],
  ['SOFT_LIGHT', 'Soft Light'],
  ['LINEAR_LIGHT', 'Linear Light'],
  ['DIFFERENCE', 'Difference'],
  ['EXCLUSION', 'Exclusion'],
  ['SUBTRACT', 'Subtract'],
  ['DIVIDE', 'Divide'],
  ['HUE', 'Hue'],
  ['SATURATION', 'Saturation'],
  ['COLOR', 'Color'],
  ['VALUE', 'Value'],
];
export const VALUE_BLEND: [string, string][] = [
  ['MIX', 'Mix'],
  ['ADD', 'Add'],
  ['SUBTRACT', 'Subtract'],
  ['MULTIPLY', 'Multiply'],
  ['DIVIDE', 'Divide'],
  ['DIFFERENCE', 'Difference'],
  ['MINIMUM', 'Minimum'],
  ['MAXIMUM', 'Maximum'],
];
export const MATERIAL_ATTRIBUTES: [string, string][] = [
  ['LINE', 'Line Color'],
  ['LINE_R', 'Line Color Red'],
  ['LINE_G', 'Line Color Green'],
  ['LINE_B', 'Line Color Blue'],
  ['LINE_A', 'Line Color Alpha'],
  ['DIFF', 'Diffuse Color'],
  ['DIFF_R', 'Diffuse Color Red'],
  ['DIFF_G', 'Diffuse Color Green'],
  ['DIFF_B', 'Diffuse Color Blue'],
  ['SPEC', 'Specular Color'],
  ['SPEC_R', 'Specular Color Red'],
  ['SPEC_G', 'Specular Color Green'],
  ['SPEC_B', 'Specular Color Blue'],
  ['SPEC_HARD', 'Specular Hardness'],
  ['ALPHA', 'Alpha Transparency'],
];

export function newLineSet(name = 'LineSet', linestyle: ID | null = null): LineSet {
  const ls = {
    name,
    show_render: true,
    linestyle,
    select_by_visibility: true,
    select_by_edge_types: true,
    select_by_face_marks: false,
    select_by_collection: false,
    select_by_image_border: true,
    visibility: 'VISIBLE',
    qi_start: 0,
    qi_end: 100,
    edge_type_negation: 'INCLUSIVE',
    edge_type_combination: 'OR',
    face_mark_negation: 'INCLUSIVE',
    face_mark_condition: 'ONE',
    collection: null,
    collection_negation: 'INCLUSIVE',
  } as LineSet;
  for (const [k] of EDGE_TYPES) {
    ls[`select_${k}`] = k === 'silhouette' || k === 'border' || k === 'crease';
    ls[`exclude_${k}`] = false;
  }
  return ls;
}

export function defaultFreestyleSettings(): FreestyleSettings {
  return {
    use_freestyle: true,
    mode: 'EDITOR',
    as_render_pass: false,
    use_culling: false,
    use_smoothness: false,
    use_suggestive_contours: false,
    use_ridges_and_valleys: false,
    use_material_boundaries: false,
    crease_angle: (134.43 * Math.PI) / 180,
    sphere_radius: 0.1,
    kr_derivative_epsilon: 0,
    linesets: [],
    active_lineset_index: 0,
  };
}

const ramp = (a: number[], b: number[]) => [0, ...a, 1, ...b];
const linearCurve = () => [0, 0, 0, 1, 1, 0];

/** A new modifier of a line style with its defaults. */
export function newLineStyleModifier(kind: ModifierKind, type: string, name?: string): LineStyleModifier {
  const label = MODIFIER_TYPES[kind].find((t) => t[0] === type)?.[1] ?? type;
  const m: LineStyleModifier = { name: name ?? label, type, use: true, expanded: true };
  if (kind !== 'geometry') {
    m.blend = 'MIX';
    m.influence = 1;
  }
  if (kind === 'color') m.color_ramp = ramp([0, 0, 0, 1], [1, 1, 1, 1]);
  if ((kind === 'alpha' || kind === 'thickness') && type !== 'CALLIGRAPHY' && type !== 'NOISE') {
    m.mapping = 'LINEAR';
    m.invert = false;
    m.curve_0 = linearCurve();
  }
  if (kind === 'alpha' && type === 'NOISE') {
    m.mapping = 'LINEAR';
    m.invert = false;
    m.curve_0 = linearCurve();
  }
  const thick = kind === 'thickness';
  switch (type) {
    case 'ALONG_STROKE':
      if (thick) Object.assign(m, { value_min: 0, value_max: 1 });
      break;
    case 'CREASE_ANGLE':
      Object.assign(m, { angle_min: 0, angle_max: Math.PI }, thick ? { thickness_min: 1, thickness_max: 10 } : {});
      break;
    case 'CURVATURE_3D':
      Object.assign(m, { curvature_min: 0, curvature_max: 0.5 }, thick ? { thickness_min: 1, thickness_max: 10 } : {});
      break;
    case 'DISTANCE_FROM_CAMERA':
      Object.assign(m, { range_min: 0, range_max: thick ? 1000 : 10000 }, thick ? { value_min: 0, value_max: 1 } : {});
      break;
    case 'DISTANCE_FROM_OBJECT':
      Object.assign(m, { range_min: 0, range_max: thick ? 1000 : 10000, target: null }, thick ? { value_min: 0, value_max: 1 } : {});
      break;
    case 'MATERIAL':
      Object.assign(m, { material_attribute: kind === 'alpha' ? 'LINE_A' : 'LINE' }, kind === 'color' ? { use_ramp: false } : {}, thick ? { value_min: 0, value_max: 1 } : {});
      break;
    case 'NOISE':
      Object.assign(m, { amplitude: 10, period: 10, seed: 512 }, thick ? { use_asymmetric: true } : {});
      break;
    case 'TANGENT':
      if (thick) Object.assign(m, { thickness_min: 1, thickness_max: 10 });
      break;
    case 'CALLIGRAPHY':
      Object.assign(m, { orientation: Math.PI / 3, thickness_min: 1, thickness_max: 10 });
      break;
    case '2D_OFFSET':
      Object.assign(m, { start: 0, end: 0, x: 0, y: 0 });
      break;
    case '2D_TRANSFORM':
      Object.assign(m, { pivot: 'CENTER', scale_x: 1, scale_y: 1, angle: 0, pivot_u: 0.5, pivot_x: 0, pivot_y: 0 });
      break;
    case 'BACKBONE_STRETCHER':
      m.backbone_length = 10;
      break;
    case 'BEZIER_CURVE':
      m.error = 10;
      break;
    case 'BLUEPRINT':
      Object.assign(m, { shape: 'CIRCLES', rounds: 1, backbone_length: 10, random_radius: 3, random_center: 5, random_backbone: 5 });
      break;
    case 'GUIDING_LINES':
      m.offset = 0;
      break;
    case 'PERLIN_NOISE_1D':
    case 'PERLIN_NOISE_2D':
      Object.assign(m, { frequency: 10, amplitude: 10, octaves: 4, angle: Math.PI / 4, seed: 0 });
      break;
    case 'POLYGONIZATION':
      m.error = 10;
      break;
    case 'SAMPLING':
      m.sampling = 10;
      break;
    case 'SIMPLIFICATION':
      m.tolerance = 0.1;
      break;
    case 'SINUS_DISPLACEMENT':
      Object.assign(m, { wavelength: 20, amplitude: 5, phase: 0 });
      break;
    case 'SPATIAL_NOISE':
      Object.assign(m, { amplitude: 5, scale: 20, octaves: 4, smooth: true, use_pure_random: true });
      break;
    case 'TIP_REMOVER':
      m.tip_length = 10;
      break;
  }
  return m;
}

export function newLineStyle(name = 'LineStyle'): Omit<LineStyleData, 'id'> {
  return {
    name,
    color: [0, 0, 0],
    alpha: 1,
    thickness: 3,
    thickness_position: 'CENTER',
    thickness_ratio: 0.5,
    color_modifiers: [],
    alpha_modifiers: [],
    thickness_modifiers: [],
    geometry_modifiers: [newLineStyleModifier('geometry', 'SAMPLING')],
    use_chaining: true,
    chaining: 'PLAIN',
    rounds: 3,
    use_same_object: true,
    use_split_length: false,
    split_length: 100,
    use_angle_min: false,
    angle_min: 0,
    use_angle_max: false,
    angle_max: 0,
    use_length_min: false,
    length_min: 0,
    use_length_max: false,
    length_max: 10000,
    use_chain_count: false,
    chain_count: 10,
    use_split_pattern: false,
    split_dash1: 0,
    split_gap1: 0,
    split_dash2: 0,
    split_gap2: 0,
    split_dash3: 0,
    split_gap3: 0,
    material_boundary: false,
    use_sorting: false,
    sort_key: 'DISTANCE_FROM_CAMERA',
    sort_order: 'DEFAULT',
    integration_type: 'MEAN',
    use_dashed_line: false,
    caps: 'BUTT',
    dash1: 0,
    gap1: 0,
    dash2: 0,
    gap2: 0,
    dash3: 0,
    gap3: 0,
  };
}

/** Name unique within a table (`.001` suffixes). */
export function uniqueIn(names: Iterable<string>, base: string): string {
  const taken = new Set(names);
  if (!taken.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(n)) return n;
  }
}

/** Add a line style data-block to the document. */
export function addLineStyle(doc: DocumentData, name = 'LineStyle', from?: LineStyleData): LineStyleData {
  const t = linestyleTable(doc);
  const ls: LineStyleData = { ...(from ? structuredClone(from) : newLineStyle()), id: uid('ls'), name: uniqueIn(Object.values(t).map((x) => x.name), from ? from.name : name) };
  t[ls.id] = ls;
  return ls;
}

/** The view layer's line settings (created with one line set and line style on first use). */
export function freestyleSettings(doc: DocumentData): FreestyleSettings {
  const r = doc.scene.render as RenderSettings;
  if (!r.freestyle_settings) {
    const fs = defaultFreestyleSettings();
    const style = Object.values(linestyleTable(doc))[0] ?? addLineStyle(doc);
    fs.linesets.push(newLineSet('LineSet', style.id));
    r.freestyle_settings = fs;
  }
  r.line_thickness_mode ??= 'ABSOLUTE';
  r.line_thickness ??= 1;
  const fs = r.freestyle_settings;
  // fields added later
  const d = defaultFreestyleSettings() as unknown as Record<string, unknown>;
  for (const k in d) if ((fs as unknown as Record<string, unknown>)[k] === undefined) (fs as unknown as Record<string, unknown>)[k] = d[k];
  return fs;
}

export function activeLineSet(doc: DocumentData): LineSet | null {
  const fs = freestyleSettings(doc);
  return fs.linesets[Math.max(0, Math.min(fs.linesets.length - 1, fs.active_lineset_index))] ?? null;
}

export function lineStyleOf(doc: DocumentData, set: LineSet | null): LineStyleData | null {
  return set?.linestyle ? linestyleTable(doc)[set.linestyle] ?? null : null;
}

export function modifierList(ls: LineStyleData, kind: ModifierKind): LineStyleModifier[] {
  return kind === 'color' ? ls.color_modifiers : kind === 'alpha' ? ls.alpha_modifiers : kind === 'thickness' ? ls.thickness_modifiers : ls.geometry_modifiers;
}
