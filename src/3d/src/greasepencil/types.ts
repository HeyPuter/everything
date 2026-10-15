// Grease Pencil data model (curves-based):
// a data-block holds layers; each layer has keyframes (frame number → drawing index); a drawing
// stores its strokes as struct-of-arrays typed buffers (point domain + curve domain) so undo
// snapshots share them and the native file format stores them as binary buffers.
// Property names follow the public `bpy` RNA naming conventions.
import type { ID, Color, Vec3 } from '../data/types';

export type GPKeyframeType = 'KEYFRAME' | 'BREAKDOWN' | 'MOVING_HOLD' | 'EXTREME' | 'JITTER' | 'GENERATED';
export type GPBlendMode = 'REGULAR' | 'HARDLIGHT' | 'ADD' | 'SUBTRACT' | 'MULTIPLY' | 'DIVIDE';
export type GPCap = 0 | 1; // 0 = ROUND, 1 = FLAT

/** Strokes of one keyframe. Point arrays are indexed by point, curve arrays by stroke. */
export interface GPDrawing {
  /** xyz per point (layer space) */
  position: Float32Array;
  /** per point radius (object units) */
  radius: Float32Array;
  /** per point opacity 0..1 */
  opacity: Float32Array;
  /** per point RGBA; alpha is the mix factor over the material color */
  vertex_color: Float32Array;
  /** edit mode point selection */
  select?: Uint8Array;
  /** curve point offsets (strokes + 1) */
  offsets: Uint32Array;
  /** per stroke */
  cyclic: Uint8Array;
  material_index: Uint16Array;
  start_cap: Uint8Array;
  end_cap: Uint8Array;
  /** RGBA, alpha is the mix factor over the material fill color */
  fill_color: Float32Array;
  fill_opacity: Float32Array;
  /** strokes sharing a non-zero fill id are filled together (even-odd: inner curves are holes) */
  fill_id: Int32Array;
  /** per point weights of the vertex groups, by group name */
  weights?: Record<string, Float32Array>;
}

export interface GPFrame {
  frame_number: number;
  /** index into GreasePencilData.drawings (several frames may share a drawing) */
  drawing: number;
  keyframe_type: GPKeyframeType;
  select?: boolean;
}

export interface GPLayer {
  name: string;
  hide: boolean;
  lock: boolean;
  /** layer channel selection (dope sheet) */
  select?: boolean;
  opacity: number;
  blend_mode: GPBlendMode;
  use_lights: boolean;
  use_onion_skinning: boolean;
  tint_color: Color;
  tint_factor: number;
  radius_offset: number;
  translation: Vec3;
  rotation: Vec3;
  scale: Vec3;
  /** keyframes sorted by frame_number */
  frames: GPFrame[];
  /** Relations: parent object (and bone), pass index for modifier / effect filters */
  parent?: string | null;
  parent_type?: 'OBJECT' | 'BONE';
  parent_bone?: string;
  /** inverse of the parent's world matrix at parenting time, relative to the object (column-major) */
  parent_inverse?: number[];
  pass_index?: number;
  /** Masks: the layer only shows inside (or outside, inverted) the strokes of its mask layers */
  use_masks?: boolean;
  mask_layers?: GPLayerMask[];
  active_mask_index?: number;
  /** Display: channel color in the dope sheet */
  channel_color?: Color;
}

export interface GPLayerMask {
  name: string;
  hide: boolean;
  invert: boolean;
}

export interface GreasePencilData {
  id: ID;
  name: string;
  layers: GPLayer[];
  active_layer_index: number;
  drawings: GPDrawing[];
  materials: (ID | null)[];
  stroke_depth_order: '2D' | '3D';
  onion_mode: 'ABSOLUTE' | 'RELATIVE' | 'SELECTED';
  onion_keyframe_type: 'ALL' | GPKeyframeType;
  ghost_before_range: number;
  ghost_after_range: number;
  use_ghost_custom_colors: boolean;
  before_color: Color;
  after_color: Color;
  onion_factor: number;
  use_onion_fade: boolean;
  use_onion_loop: boolean;
  users?: number;
  /** vertex groups (weights live on the drawings, by name) */
  vertex_groups?: { name: string; lock_weight?: boolean }[];
  active_vertex_group_index?: number;
}

export interface MaterialGPencilStyle {
  show_stroke: boolean;
  show_fill: boolean;
  /** RGBA (linear) */
  color: [number, number, number, number];
  fill_color: [number, number, number, number];
  mode: 'LINE' | 'DOTS' | 'BOX';
  stroke_style: 'SOLID';
  fill_style: 'SOLID';
  alignment_mode: 'PATH' | 'OBJECT' | 'FIXED';
  hide: boolean;
  lock: boolean;
  /** shown in onion skins */
  ghost: boolean;
  pass_index: number;
}

/** Grease Pencil tool settings stored on scene.tool_settings (`bpy` RNA names). */
export interface GPToolSettings {
  gpencil_stroke_placement_view3d: 'ORIGIN' | 'CURSOR' | 'SURFACE' | 'STROKE';
  gpencil_surface_offset: number;
  /** drawing plane */
  gpencil_lock_axis: 'VIEW' | 'AXIS_Y' | 'AXIS_X' | 'AXIS_Z' | 'CURSOR';
  gpencil_selectmode_edit: 'POINT' | 'STROKE' | 'SEGMENT';
  use_gpencil_draw_additive: boolean;
  use_gpencil_draw_onback: boolean;
  use_grease_pencil_multi_frame_editing: boolean;
  /** per tool brush settings, keyed by tool id */
  gpencil_brushes: Record<string, GPBrush>;
  /** active Draw brush preset id */
  gpencil_draw_brush: string;
}

export interface GPBrush {
  /** radius in pixels */
  size: number;
  strength: number;
  use_pressure_size: boolean;
  use_pressure_strength: boolean;
  /** Draw: post-processing (smoothing factor and steps, subdivisions, simplify, trim) */
  use_settings_postprocess?: boolean;
  pen_smooth_factor?: number;
  pen_smooth_steps?: number;
  pen_subdivision_steps?: number;
  simplify_factor?: number;
  use_trim?: boolean;
  /** Draw: stabilizer (lazy mouse) */
  use_smooth_stroke?: boolean;
  smooth_stroke_radius?: number;
  smooth_stroke_factor?: number;
  /** Draw: per point randomness */
  use_settings_random?: boolean;
  random_pressure?: number;
  random_strength?: number;
  pen_jitter?: number;
  /** Draw: color mode */
  color_mode?: 'MATERIAL' | 'VERTEXCOLOR';
  color?: Color;
  /** swapped with `color` by X */
  secondary_color?: Color;
  /** Erase */
  eraser_mode?: 'SOFT' | 'HARD' | 'STROKE';
  /** Tint */
  vertex_mode?: 'STROKE' | 'FILL' | 'BOTH';
  /** Fill */
  fill_layer_mode?: 'ACTIVE' | 'ABOVE' | 'BELOW' | 'ALL_ABOVE' | 'ALL_BELOW' | 'VISIBLE';
  dilate?: number;
  fill_direction?: 'NORMAL' | 'INVERT';
  /** Primitives: number of subdivisions per edge */
  subdivision?: number;
  /** Sculpt brushes: affect the stroke falloff */
  direction?: 'ADD' | 'SUBTRACT';
}

/** A visual effect applied to a grease pencil object's rendered image. */
export interface ShaderFx {
  id: string;
  name: string;
  type: string;
  show_viewport: boolean;
  show_render: boolean;
  show_expanded: boolean;
  [key: string]: unknown;
}
