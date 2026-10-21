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
  // --- spline types (absent = every stroke is a poly line) -----------------------------------
  /** per stroke: 0 Catmull-Rom, 1 poly, 2 Bézier, 3 NURBS */
  curve_type?: Uint8Array;
  /** per stroke: evaluated points per segment of smooth types (default 12) */
  resolution?: Uint16Array;
  /** per stroke NURBS order (default 4) and knot mode (0 normal, 1 endpoint, 2 Bézier, 3 endpoint + Bézier) */
  nurbs_order?: Uint8Array;
  knots_mode?: Uint8Array;
  /** per point Bézier handles (xyz) and their types (0 free, 1 auto, 2 vector, 3 align) */
  handle_left?: Float32Array;
  handle_right?: Float32Array;
  handle_type_left?: Uint8Array;
  handle_type_right?: Uint8Array;
  /** Edit Mode selection of the handles */
  select_handle_left?: Uint8Array;
  select_handle_right?: Uint8Array;
  /** per stroke override of the material's stroke / fill visibility: 0 material, 1 stroke, 2 fill, 3 both */
  stroke_type?: Uint8Array;
  /** per point corner limit: joins sharper than this angle are cut (radians, absent / 0 = round) */
  miter_angle?: Float32Array;
  /** per stroke fill texture transform (Gradient tool): offset, rotation, scale */
  uv_translation?: Float32Array;
  uv_rotation?: Float32Array;
  uv_scale?: Float32Array;
  /** per stroke: helper lines drawn with the Fill tool (not rendered, removed by Remove Fill Guides) */
  is_fill_guide?: Uint8Array;
  /** per stroke edge softness 0 (hard) .. 1 (fades from the center line) */
  softness?: Float32Array;
  /** per stroke texture mapping of the line (4 per stroke): offset, scale, fit to the stroke (0/1), dot rotation */
  uv_stroke?: Float32Array;
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
  /** name of the layer group the layer belongs to */
  parent_group?: string;
}

export interface GPLayerGroup {
  name: string;
  expanded?: boolean;
  color_tag?: string;
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
  /** layer groups (members are kept next to each other in the stack) */
  layer_groups?: GPLayerGroup[];
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
  stroke_style: 'SOLID' | 'TEXTURE';
  fill_style: 'SOLID' | 'GRADIENT' | 'TEXTURE';
  /** image textures (image data-block ids) of the stroke and the fill */
  stroke_image?: ID | null;
  fill_image?: ID | null;
  /** stroke texture: blend toward the base color (0 = texture only) and length of one repeat in stroke widths */
  mix_stroke_factor?: number;
  pixel_size?: number;
  /** fill texture: show it once instead of repeating */
  texture_clamp?: boolean;
  /** gradient fills */
  gradient_type?: 'LINEAR' | 'RADIAL';
  mix_color?: [number, number, number, number];
  mix_factor?: number;
  flip?: boolean;
  texture_offset?: [number, number];
  texture_angle?: number;
  texture_scale?: [number, number];
  /** holdout: cut the strokes / fills below instead of drawing */
  use_stroke_holdout?: boolean;
  use_fill_holdout?: boolean;
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
  /** Sculpt / Vertex Paint: only affect selected points, strokes or segments */
  use_gpencil_select_mask_point?: boolean;
  use_gpencil_select_mask_stroke?: boolean;
  use_gpencil_select_mask_segment?: boolean;
  use_gpencil_vertex_select_mask_point?: boolean;
  use_gpencil_vertex_select_mask_stroke?: boolean;
  use_gpencil_vertex_select_mask_segment?: boolean;
  /** Sculpt auto-masking */
  use_automasking_stroke?: boolean;
  use_automasking_layer_stroke?: boolean;
  use_automasking_material_stroke?: boolean;
  use_automasking_layer_active?: boolean;
  use_automasking_material_active?: boolean;
  /** Edit Mode: scaling also scales the thickness */
  use_scale_thickness?: boolean;
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
  /** Fill gap closure: extension length (world units), mode, stop at strokes, show the lines */
  fill_extend?: number;
  fill_extend_mode?: 'EXTEND' | 'RADIUS';
  use_collide_strokes?: boolean;
  show_fill_extend?: boolean;
  /** Primitives: number of subdivisions per edge */
  subdivision?: number;
  /** Sculpt brushes: affect the stroke falloff */
  direction?: 'ADD' | 'SUBTRACT';
  /** Draw: edge hardness of new strokes (1 = hard; lower values give soft edges) */
  hardness?: number;
  /** Draw: pen nib — strokes running along `angle` (screen, radians) get thinner by up to `angle_factor` */
  angle?: number;
  angle_factor?: number;
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
