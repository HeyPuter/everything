// Line rendering data: line styles (data-blocks), line sets and the view layer's line settings,
// per-material line colour, per-mesh edge / face marks and the line art usage flags.
// Property names follow the public `bpy` naming so scripts and files map one to one.
import type { ID } from '../data/types';

export type EdgeTypeKey = 'silhouette' | 'border' | 'crease' | 'ridge_valley' | 'suggestive_contour' | 'material_boundary' | 'contour' | 'external_contour' | 'edge_mark';
export const EDGE_TYPES: [EdgeTypeKey, string][] = [
  ['silhouette', 'Silhouette'],
  ['border', 'Border'],
  ['contour', 'Contour'],
  ['crease', 'Crease'],
  ['external_contour', 'External Contour'],
  ['ridge_valley', 'Ridge & Valley'],
  ['edge_mark', 'Edge Mark'],
  ['suggestive_contour', 'Suggestive Contour'],
  ['material_boundary', 'Material Boundary'],
];

export interface LineSet {
  name: string;
  show_render: boolean;
  linestyle: ID | null;
  select_by_visibility: boolean;
  select_by_edge_types: boolean;
  select_by_face_marks: boolean;
  select_by_collection: boolean;
  select_by_image_border: boolean;
  visibility: 'VISIBLE' | 'HIDDEN' | 'RANGE';
  qi_start: number;
  qi_end: number;
  edge_type_negation: 'INCLUSIVE' | 'EXCLUSIVE';
  edge_type_combination: 'OR' | 'AND';
  face_mark_negation: 'INCLUSIVE' | 'EXCLUSIVE';
  face_mark_condition: 'ONE' | 'BOTH';
  collection: ID | null;
  collection_negation: 'INCLUSIVE' | 'EXCLUSIVE';
  // select_<type> / exclude_<type> for every edge type
  [k: `select_${string}` | `exclude_${string}`]: boolean;
}

/** Settings of the view layer (stored with the render settings, like the passes). */
export interface FreestyleSettings {
  /** view_layer.use_freestyle: this layer draws lines */
  use_freestyle: boolean;
  mode: 'EDITOR';
  as_render_pass: boolean;
  use_culling: boolean;
  use_smoothness: boolean;
  use_suggestive_contours: boolean;
  use_ridges_and_valleys: boolean;
  use_material_boundaries: boolean;
  crease_angle: number;
  sphere_radius: number;
  kr_derivative_epsilon: number;
  linesets: LineSet[];
  active_lineset_index: number;
}

export type BlendColor = 'MIX' | 'DARKEN' | 'MULTIPLY' | 'BURN' | 'LIGHTEN' | 'SCREEN' | 'DODGE' | 'ADD' | 'OVERLAY' | 'SOFT_LIGHT' | 'LINEAR_LIGHT' | 'DIFFERENCE' | 'EXCLUSION' | 'SUBTRACT' | 'DIVIDE' | 'HUE' | 'SATURATION' | 'COLOR' | 'VALUE';
export type BlendValue = 'MIX' | 'ADD' | 'SUBTRACT' | 'MULTIPLY' | 'DIVIDE' | 'DIFFERENCE' | 'MINIMUM' | 'MAXIMUM';

/** A colour / alpha / thickness / geometry modifier of a line style (type-specific fields inline). */
export interface LineStyleModifier {
  name: string;
  type: string;
  use: boolean;
  expanded: boolean;
  blend?: string;
  influence?: number;
  /** colour ramp, flat [pos, r, g, b, a]* (same layout as the node ramps) */
  color_ramp?: number[];
  /** value mapping: LINEAR or through `curve_0` (flat [x, y, handle]*) */
  mapping?: 'LINEAR' | 'CURVE';
  invert?: boolean;
  curve_0?: number[];
  [k: string]: unknown;
}

export interface LineStyleData {
  id: ID;
  name: string;
  use_fake_user?: boolean;
  color: [number, number, number];
  alpha: number;
  thickness: number;
  thickness_position: 'CENTER' | 'INSIDE' | 'OUTSIDE' | 'RELATIVE';
  thickness_ratio: number;
  color_modifiers: LineStyleModifier[];
  alpha_modifiers: LineStyleModifier[];
  thickness_modifiers: LineStyleModifier[];
  geometry_modifiers: LineStyleModifier[];
  use_chaining: boolean;
  chaining: 'PLAIN' | 'SKETCHY';
  rounds: number;
  use_same_object: boolean;
  use_split_length: boolean;
  split_length: number;
  use_angle_min: boolean;
  angle_min: number;
  use_angle_max: boolean;
  angle_max: number;
  use_length_min: boolean;
  length_min: number;
  use_length_max: boolean;
  length_max: number;
  use_chain_count: boolean;
  chain_count: number;
  use_split_pattern: boolean;
  split_dash1: number;
  split_gap1: number;
  split_dash2: number;
  split_gap2: number;
  split_dash3: number;
  split_gap3: number;
  material_boundary: boolean;
  use_sorting: boolean;
  sort_key: 'DISTANCE_FROM_CAMERA' | '2D_LENGTH' | 'PROJECTED_X' | 'PROJECTED_Y';
  sort_order: 'DEFAULT' | 'REVERSE';
  integration_type: 'MEAN' | 'MIN' | 'MAX' | 'FIRST' | 'LAST';
  use_dashed_line: boolean;
  caps: 'BUTT' | 'ROUND' | 'SQUARE';
  dash1: number;
  gap1: number;
  dash2: number;
  gap2: number;
  dash3: number;
  gap3: number;
  /** Properties: which modifier list the Line Style panels show expanded (UI only) */
  panel?: 'STROKES' | 'COLOR' | 'ALPHA' | 'THICKNESS' | 'GEOMETRY';
}

/** Line art usage of objects / collections. */
export type LineartUsage = 'INHERIT' | 'INCLUDE' | 'OCCLUSION_ONLY' | 'EXCLUDE' | 'INTERSECTION_ONLY' | 'NO_INTERSECTION' | 'FORCE_INTERSECTION';

export interface MaterialLineArt {
  use_material_mask: boolean;
  use_material_mask_bits: boolean[];
  /** surfaces a face of this material counts as when it hides lines (0: transparent) */
  mat_occlusion: number;
}

export interface ObjectLineArt {
  usage: LineartUsage;
  use_crease_override: boolean;
  crease_threshold: number;
}

declare module '../data/types' {
  interface DocumentData {
    /** Line style data-blocks (src/lines); absent in older files */
    linestyles?: Record<ID, LineStyleData>;
  }
  interface RenderSettings {
    /** Render ▸ Freestyle */
    line_thickness_mode?: 'ABSOLUTE' | 'RELATIVE';
    line_thickness?: number;
    /** the view layer's line settings */
    freestyle_settings?: FreestyleSettings;
  }
  interface MaterialData {
    /** colour (and alpha) handed to line styles reading the material */
    line_color?: [number, number, number, number];
    line_priority?: number;
    /** Line Art: occlusion levels of the faces and mask bits */
    lineart?: MaterialLineArt;
  }
  interface MeshData {
    /** per face corner: the edge from this corner to the next is marked for line rendering */
    freestyle_edge?: Uint8Array;
    /** per face: marked for line rendering */
    freestyle_face?: Uint8Array;
  }
  interface ObjectData {
    lineart?: ObjectLineArt;
  }
  interface CollectionData {
    lineart_usage?: LineartUsage;
  }
}

export function linestyleTable(doc: { linestyles?: Record<ID, LineStyleData> }): Record<ID, LineStyleData> {
  return (doc.linestyles ??= {});
}
