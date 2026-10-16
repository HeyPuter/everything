// Core document model. Field names follow the publicly documented `bpy` RNA property
// naming conventions (snake_case) so animation data paths, the
// scripting API and file importers can map 1:1 without translation tables.
// All typed arrays are treated as immutable once committed to the undo history:
// edits replace arrays instead of writing into them (see data/cow.ts).

import type { RealtimeRenderSettings, RealtimeLightSettings, RealtimeMaterialSettings, RealtimeWorldSettings, LightProbeSettings } from '../render/realtime/types';
export type ID = string;
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
export type Color = [number, number, number];
export type Color4 = [number, number, number, number];
export type Mat4 = number[]; // column-major 16

export type ObjectType =
  | 'MESH'
  | 'CURVE'
  | 'FONT'
  | 'EMPTY'
  | 'LIGHT'
  | 'CAMERA'
  | 'ARMATURE'
  | 'LATTICE'
  | 'POINTCLOUD'
  | 'GREASEPENCIL'
  | 'SPEAKER'
  | 'META'
  | 'CURVES'
  | 'LIGHT_PROBE'
  | 'VOLUME';

export type RotationMode = 'XYZ' | 'XZY' | 'YXZ' | 'YZX' | 'ZXY' | 'ZYX' | 'QUATERNION' | 'AXIS_ANGLE';

export type Mode =
  | 'OBJECT'
  | 'EDIT'
  | 'SCULPT'
  | 'VERTEX_PAINT'
  | 'WEIGHT_PAINT'
  | 'TEXTURE_PAINT'
  | 'POSE'
  | 'PAINT_GREASE_PENCIL'
  | 'SCULPT_GREASE_PENCIL'
  | 'VERTEX_GREASE_PENCIL'
  | 'WEIGHT_GREASE_PENCIL'
  | 'SCULPT_CURVES'
  | 'PARTICLE_EDIT';

export type SelectMode = 'VERT' | 'EDGE' | 'FACE';

export interface CustomProps {
  [key: string]: number | string | boolean | number[];
}

// ---------------------------------------------------------------------------
// Mesh

export interface VertexGroup {
  name: string;
  lock_weight?: boolean;
}

export interface ShapeKey {
  name: string;
  /** Absolute positions (vertex count * 3). */
  data: Float32Array;
  value: number;
  slider_min: number;
  slider_max: number;
  mute: boolean;
  relative_key: string; // name of the basis key
  vertex_group?: string;
  /** protected from edits (Edit Mode shape editing, sculpting) */
  lock_shape?: boolean;
}

export interface ColorAttribute {
  name: string;
  domain: 'POINT' | 'CORNER';
  /** RGBA, linear. */
  data: Float32Array;
}

export interface MeshData {
  id: ID;
  name: string;
  /** xyz per vertex */
  positions: Float32Array;
  /** face corner offsets (faces + 1) */
  offsets: Uint32Array;
  /** vertex index per face corner (loop) */
  indices: Uint32Array;
  /** uv per face corner (active UV map) */
  uvs: Float32Array;
  /** flat normals per corner, kept for the polygon tool kernels; viewport normals are derived */
  normals: Float32Array;
  /** per-corner flag: the edge starting at this corner is a UV seam */
  seams?: Uint32Array;
  /** per-corner flag: the edge starting at this corner is marked sharp */
  sharp?: Uint32Array;
  /** per-corner edge crease weight (0..1) for subdivision */
  creases?: Float32Array;
  /** custom split normals, xyz per face corner (overrides the computed shading normals) */
  custom_normals?: Float32Array;
  /** per face: split this quad along the other diagonal than the automatic choice */
  quad_flip?: Uint8Array;
  /** per face strength for the Weighted Normal modifier's face influence: 0 weak, 1 medium, 2 strong */
  face_strength?: Uint8Array;
  /** per-face smooth shading flag */
  smooth?: Uint8Array;
  /** per-face material slot index */
  material_index?: Uint16Array;
  /** Edit-mode selection: per-vertex flag (edges/faces derive from vertices). */
  select_vert?: Uint8Array;
  /** Edit-mode hidden: per-vertex flag. */
  hide_vert?: Uint8Array;
  /** Per-vertex bevel weight etc could follow; keep minimal. */
  vertex_groups: VertexGroup[];
  /** weights[group][vertex]; 0 means not assigned */
  weights: Float32Array[];
  shape_keys: ShapeKey[];
  active_shape_key_index: number;
  use_shape_key_edit_mode?: boolean;
  color_attributes: ColorAttribute[];
  active_color_index: number;
  uv_map_name: string;
  /** Material slots (material ids or null for empty slot). */
  materials: (ID | null)[];
  /** Auto smooth by angle (radians); undefined = off. */
  auto_smooth_angle?: number;
  remesh_voxel_size?: number;
  /** Sculpt mode mask, one value per vertex (0 = unmasked, 1 = fully masked). */
  sculpt_mask?: Float32Array;
  /** Sculpt face sets, one id per face (ids start at 1). */
  sculpt_face_set?: Int32Array;
  /** Face set id drawn without a color (the "default" set). */
  face_sets_color_default?: number;
  /** Seed for the face set display colors. */
  face_sets_color_seed?: number;
  /** Per-face hidden flag used by Sculpt Mode visibility tools. */
  hide_poly?: Uint8Array;
  /** Paint modes: only paint the faces selected in the face selection mask. */
  use_paint_mask?: boolean;
  /** Paint modes: only paint the vertices selected in the vertex selection mask. */
  use_paint_mask_vertex?: boolean;
  /** edges that do not belong to any face (vertex index pairs) */
  loose_edges?: Uint32Array;
  /** Skin modifier data, 4 per vertex: radius x, radius y, root flag, loose flag */
  skin_vertices?: Float32Array;
  /** UV editor selection, one flag per face corner */
  uv_select?: Uint8Array;
  /** UV pins (kept in place by unwrapping and UV tools), one flag per face corner */
  uv_pin?: Uint8Array;
  /** faces hidden in the UV editor (without sync selection), one flag per face */
  uv_hide?: Uint8Array;
  users?: number;
  /** texture space (Generated coordinates): automatic from the bounds, or location ± size */
  use_auto_texspace?: boolean;
  texspace_location?: [number, number, number];
  texspace_size?: [number, number, number];
}

// ---------------------------------------------------------------------------
// Curves

export type HandleType = 'FREE' | 'VECTOR' | 'ALIGNED' | 'AUTO';

export interface BezierPoint {
  co: Vec3;
  handle_left: Vec3;
  handle_right: Vec3;
  handle_left_type: HandleType;
  handle_right_type: HandleType;
  radius: number;
  tilt: number;
  select_control_point?: boolean;
  select_left_handle?: boolean;
  select_right_handle?: boolean;
  /** hidden in Edit Mode (not drawn, not selectable) */
  hide?: boolean;
}

export interface SplinePoint {
  co: Vec4; // x y z w
  radius: number;
  tilt: number;
  select?: boolean;
  hide?: boolean;
}

export interface Spline {
  type: 'BEZIER' | 'POLY' | 'NURBS';
  bezier_points: BezierPoint[];
  points: SplinePoint[];
  use_cyclic_u: boolean;
  resolution_u: number;
  order_u: number;
  use_endpoint_u?: boolean;
  use_smooth: boolean;
  material_index: number;
}

export interface CurveData {
  id: ID;
  name: string;
  /** texture space (Generated coordinates): automatic from the bounds, or location ± size */
  use_auto_texspace?: boolean;
  texspace_location?: [number, number, number];
  texspace_size?: [number, number, number];
  dimensions: '2D' | '3D';
  /** Path animation: frames for one run along the path, and the current position in frames (animatable). */
  path_duration?: number;
  eval_time?: number;
  splines: Spline[];
  resolution_u: number;
  bevel_depth: number;
  bevel_resolution: number;
  extrude: number;
  offset: number;
  fill_mode: 'FULL' | 'BACK' | 'FRONT' | 'HALF' | 'NONE' | 'BOTH';
  /** ROUND: tube of bevel_depth; OBJECT: cross-section from bevel_object */
  bevel_mode?: 'ROUND' | 'OBJECT';
  bevel_object?: ID | null;
  /** curve object whose height along its X extent scales the radius */
  taper_object?: ID | null;
  use_fill_caps: boolean;
  materials: (ID | null)[];
  // Text (FONT objects share curve data)
  body?: string;
  size?: number;
  align_x?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY' | 'FLUSH';
  align_y?: 'TOP_BASELINE' | 'TOP' | 'CENTER' | 'BOTTOM' | 'BOTTOM_BASELINE';
  space_line?: number;
  space_character?: number;
  space_word?: number;
  font_family?: string;
  users?: number;
  /** per-character styles, parallel to `body` (UTF-16 code units) */
  body_format?: CharFormat[];
  underline_position?: number;
  underline_height?: number;
  small_caps_scale?: number;
  shear?: number;
  offset_x?: number;
  offset_y?: number;
  /** text frames; a box with width 0 does not wrap */
  text_boxes?: TextBox[];
  overflow?: 'NONE' | 'SCALE' | 'TRUNCATE';
  /** custom font data-blocks per style (null / missing: built-in font) */
  font?: ID | null;
  font_bold?: ID | null;
  font_italic?: ID | null;
  font_bold_italic?: ID | null;
  /** text: curve object the text is bent along */
  follow_curve?: ID | null;
}

/** A loaded font file (TrueType / OpenType / WOFF), packed into the document. */
export interface VectorFontData {
  id: ID;
  name: string;
  filepath: string;
  bytes: Uint8Array | null;
  users?: number;
}

export interface CharFormat {
  use_bold?: boolean;
  use_italic?: boolean;
  use_underline?: boolean;
  use_small_caps?: boolean;
  kerning?: number;
  /** material slot of the character */
  material_index?: number;
}

export interface TextBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Lights / cameras / armatures

export interface LightData extends RealtimeLightSettings {
  id: ID;
  name: string;
  type: 'POINT' | 'SUN' | 'SPOT' | 'AREA';
  color: Color;
  energy: number; // W for point/spot/area, W/m² (strength) for sun
  shadow_soft_size: number; // radius
  angle: number; // sun angular diameter (rad)
  spot_size: number; // rad
  spot_blend: number;
  show_cone: boolean;
  shape: 'SQUARE' | 'RECTANGLE' | 'DISK' | 'ELLIPSE';
  size: number;
  size_y: number;
  use_shadow: boolean;
  shadow_buffer_bias?: number;
  cutoff_distance?: number;
  use_custom_distance?: boolean;
  diffuse_factor: number;
  specular_factor: number;
  volume_factor: number;
  users?: number;
}

export interface CameraData {
  id: ID;
  name: string;
  type: 'PERSP' | 'ORTHO' | 'PANO';
  lens: number; // mm
  lens_unit: 'MILLIMETERS' | 'FOV';
  sensor_width: number;
  sensor_height: number;
  sensor_fit: 'AUTO' | 'HORIZONTAL' | 'VERTICAL';
  ortho_scale: number;
  clip_start: number;
  clip_end: number;
  shift_x: number;
  shift_y: number;
  dof: {
    use_dof: boolean;
    focus_object: ID | null;
    focus_distance: number;
    aperture_fstop: number;
    aperture_blades: number;
    /** rotation of the aperture polygon (radians) */
    aperture_rotation?: number;
    /** anamorphic distortion of the bokeh (1 = round) */
    aperture_ratio?: number;
  };
  display_size: number;
  show_passepartout: boolean;
  passepartout_alpha: number;
  show_limits?: boolean;
  /** camera view overlays (src/render/final/cameraoverlay.ts) */
  show_name?: boolean;
  show_safe_areas?: boolean;
  show_safe_center?: boolean;
  show_composition_thirds?: boolean;
  show_composition_center?: boolean;
  show_composition_center_diagonal?: boolean;
  show_composition_golden?: boolean;
  show_composition_golden_tria_a?: boolean;
  show_composition_golden_tria_b?: boolean;
  show_composition_harmony_tri_a?: boolean;
  show_composition_harmony_tri_b?: boolean;
  /** reference images drawn behind or in front of the scene when looking through this camera */
  show_background_images?: boolean;
  background_images?: CameraBackgroundImage[];
  users?: number;
}

export interface CameraBackgroundImage {
  image: ID | null;
  alpha: number;
  display_depth: 'BACK' | 'FRONT';
  frame_method: 'STRETCH' | 'FIT' | 'CROP';
  /** offset in units of the camera frame width */
  offset: [number, number];
  rotation: number;
  scale: number;
  use_flip_x: boolean;
  use_flip_y: boolean;
  show_background_image: boolean;
  show_expanded: boolean;
}

export interface Bone {
  name: string;
  parent: string | null;
  head: Vec3; // armature space
  tail: Vec3;
  roll: number;
  use_connect: boolean;
  use_deform: boolean;
  use_inherit_rotation: boolean;
  inherit_scale: 'FULL' | 'NONE' | 'NONE_LEGACY' | 'ALIGNED' | 'AVERAGE' | 'FIX_SHEAR';
  envelope_distance: number;
  head_radius: number;
  tail_radius: number;
  bbone_segments: number;
  hide?: boolean;
  select?: boolean;
  select_head?: boolean;
  select_tail?: boolean;
  layer_collections?: string[];
  /** names of the bone collections this bone is assigned to */
  collections?: string[];
  /** draw as wireframe only */
  show_wire?: boolean;
  /** B-Bone display size (default: a tenth of the bone length) */
  bbone_x?: number;
  bbone_z?: number;
}

/** Named group of bones (visibility, selection, organisation). */
export interface BoneCollection {
  name: string;
  is_visible: boolean;
  is_solo?: boolean;
}

export interface ArmatureData {
  id: ID;
  name: string;
  bones: Bone[];
  display_type: 'OCTAHEDRAL' | 'STICK' | 'BBONE' | 'ENVELOPE' | 'WIRE';
  pose_position: 'POSE' | 'REST';
  show_names: boolean;
  show_axes: boolean;
  show_in_front?: boolean;
  active_bone?: string | null;
  users?: number;
  collections?: BoneCollection[];
  active_collection_index?: number;
  /** Edit Mode X-Axis Mirror: joints of `.L`/`.R` counterparts move together */
  use_mirror_x?: boolean;
}

export interface PoseBone {
  location: Vec3;
  rotation_mode: RotationMode;
  rotation_quaternion: Vec4; // w x y z
  rotation_euler: Vec3;
  rotation_axis_angle: Vec4; // angle x y z
  scale: Vec3;
  constraints: Constraint[];
  custom_shape?: ID | null;
  lock_location?: [boolean, boolean, boolean];
  lock_rotation?: [boolean, boolean, boolean];
  lock_scale?: [boolean, boolean, boolean];
  /** IK limits */
  ik_stretch?: number;
  lock_ik_x?: boolean;
  lock_ik_y?: boolean;
  lock_ik_z?: boolean;
  ik_stiffness_x?: number;
  ik_stiffness_y?: number;
  ik_stiffness_z?: number;
  use_ik_limit_x?: boolean;
  use_ik_limit_y?: boolean;
  use_ik_limit_z?: boolean;
  ik_min_x?: number;
  ik_max_x?: number;
  ik_min_y?: number;
  ik_max_y?: number;
  ik_min_z?: number;
  ik_max_z?: number;
  select?: boolean;
}

export interface LatticeData {
  id: ID;
  name: string;
  points_u: number;
  points_v: number;
  points_w: number;
  /** deformed point positions (u*v*w*3), in lattice local space ±0.5 */
  points: Float32Array;
  interpolation: 'KEY_LINEAR' | 'KEY_BSPLINE';
  users?: number;
}

// ---------------------------------------------------------------------------
// Node trees (shader, geometry, compositor, world)

export type SocketValue = number | boolean | string | number[] | null;

export interface NodeData {
  id: ID;
  /** Node type identifier, e.g. 'ShaderNodeBsdfPrincipled' */
  type: string;
  name: string;
  label?: string;
  location: Vec2;
  width?: number;
  /** Unconnected input values, keyed by input identifier. */
  inputs: Record<string, SocketValue>;
  /** Node-level settings (enums, data references, etc). */
  props: Record<string, SocketValue>;
  /** Inputs hidden in UI */
  hide?: boolean;
  mute?: boolean;
  select?: boolean;
  color?: Color | null;
  parent?: ID | null;
  /** Use `color` for the node body (custom node color) */
  use_custom_color?: boolean;
  /** Sockets hidden in the node UI (Ctrl+H), as 'in:<identifier>' / 'out:<identifier>' */
  hidden_sockets?: string[];
  /** Names of the node's collapsible panels that are open */
  open_panels?: string[];
  /** Hide the node's property buttons (show_options off) */
  hide_options?: boolean;
  /** number key (1-9) that views this node in the node editor */
  viewer_shortcut?: number;
  /** show a rendered preview of the node's output above it (shader nodes) */
  show_preview?: boolean;
}

export interface LinkData {
  id: ID;
  from_node: ID;
  from_socket: string;
  to_node: ID;
  to_socket: string;
  is_muted?: boolean;
}

export interface NodeTreeData {
  type: 'SHADER' | 'GEOMETRY' | 'COMPOSITOR' | 'WORLD';
  nodes: NodeData[];
  links: LinkData[];
  /** For node groups: interface sockets */
  interface?: { in_out: 'INPUT' | 'OUTPUT'; name: string; socket_type: string; default_value?: SocketValue; min_value?: number; max_value?: number; identifier: string; hide_value?: boolean; /** identifier of the interface panel holding this input */ panel?: string; /** tooltip of the socket */ description?: string }[];
  /** node groups: collapsible panels that organize the group node's inputs */
  interface_panels?: { identifier: string; name: string; default_closed?: boolean; /** boolean input drawn as a checkbox in the panel header */ toggle?: string }[];
  active_node?: ID | null;
  view?: { x: number; y: number; zoom: number };
  /** node groups: description shown as a tooltip */
  description?: string;
  /** node groups: width of newly added group nodes */
  default_group_node_width?: number;
  /** node groups: header color of the group's nodes, by node category ('input', 'shader', …) */
  color_tag?: string;
}

export interface NodeGroupData {
  id: ID;
  name: string;
  tree: NodeTreeData;
  is_modifier?: boolean;
  is_tool?: boolean;
  use_fake_user?: boolean;
  users?: number;
}

export interface MaterialData extends RealtimeMaterialSettings {
  id: ID;
  name: string;
  use_nodes: boolean;
  tree: NodeTreeData;
  // Viewport display / fallbacks
  diffuse_color: Color4;
  metallic: number;
  roughness: number;
  blend_method: 'OPAQUE' | 'CLIP' | 'HASHED' | 'BLEND';
  alpha_threshold: number;
  use_backface_culling: boolean;
  show_transparent_back?: boolean;
  shadow_method?: 'OPAQUE' | 'CLIP' | 'HASHED' | 'NONE';
  pass_index?: number;
  use_fake_user?: boolean;
  users?: number;
  /** Grease Pencil material settings (src/greasepencil) */
  grease_pencil?: import('../greasepencil/types').MaterialGPencilStyle;
}

export interface WorldData extends RealtimeWorldSettings {
  id: ID;
  name: string;
  color: Color;
  use_nodes: boolean;
  tree: NodeTreeData;
  /** mist settings */
  mist_start?: number;
  mist_depth?: number;
  mist_falloff?: 'QUADRATIC' | 'LINEAR' | 'INVERSE_QUADRATIC';
  users?: number;
}

export interface ImageData {
  id: ID;
  name: string;
  /** Encoded bytes (PNG/JPEG/WebP/...) or generated */
  mime: string;
  bytes: Uint8Array | null;
  width: number;
  height: number;
  source: 'FILE' | 'GENERATED' | 'VIEWER' | 'RENDER';
  generated_type?: 'BLANK' | 'UV_GRID' | 'COLOR_GRID';
  generated_color?: Color4;
  colorspace: 'sRGB' | 'Non-Color' | 'Linear';
  alpha_mode?: 'STRAIGHT' | 'PREMUL' | 'NONE';
  filepath?: string;
  /** bumps whenever pixels are painted so GPU textures refresh */
  revision?: number;
  use_fake_user?: boolean;
  users?: number;
}

export interface TextData {
  id: ID;
  name: string;
  body: string;
  language: 'javascript' | 'python' | 'text';
  use_module?: boolean;
  users?: number;
}

// ---------------------------------------------------------------------------
// Animation

export type Interpolation =
  | 'CONSTANT'
  | 'LINEAR'
  | 'BEZIER'
  | 'SINE'
  | 'QUAD'
  | 'CUBIC'
  | 'QUART'
  | 'QUINT'
  | 'EXPO'
  | 'CIRC'
  | 'BACK'
  | 'BOUNCE'
  | 'ELASTIC';

export type KeyHandleType = 'FREE' | 'ALIGNED' | 'VECTOR' | 'AUTO' | 'AUTO_CLAMPED';

export interface Keyframe {
  co: Vec2; // frame, value
  handle_left: Vec2;
  handle_right: Vec2;
  handle_left_type: KeyHandleType;
  handle_right_type: KeyHandleType;
  interpolation: Interpolation;
  easing: 'AUTO' | 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_OUT';
  type: 'KEYFRAME' | 'BREAKDOWN' | 'MOVING_HOLD' | 'EXTREME' | 'JITTER' | 'GENERATED';
  back?: number;
  amplitude?: number;
  period?: number;
  select_control_point?: boolean;
  select_left_handle?: boolean;
  select_right_handle?: boolean;
}

export interface FModifier {
  type: 'NOISE' | 'CYCLES' | 'GENERATOR' | 'LIMITS' | 'STEPPED' | 'FNGENERATOR' | 'ENVELOPE';
  mute?: boolean;
  /** influence and restricted frame range (with blend in/out) */
  use_influence?: boolean;
  influence?: number;
  use_restricted_range?: boolean;
  frame_start?: number;
  frame_end?: number;
  blend_in?: number;
  blend_out?: number;
  // noise
  scale?: number;
  strength?: number;
  phase?: number;
  offset?: number;
  depth?: number;
  // cycles
  mode_before?: 'NONE' | 'REPEAT' | 'REPEAT_OFFSET' | 'MIRROR';
  mode_after?: 'NONE' | 'REPEAT' | 'REPEAT_OFFSET' | 'MIRROR';
  // generator
  coefficients?: number[];
  // stepped
  frame_step?: number;
  frame_offset?: number;
  // limits
  use_min_y?: boolean;
  use_max_y?: boolean;
  min_y?: number;
  max_y?: number;
  // built-in function (FNGENERATOR)
  function_type?: 'SIN' | 'COS' | 'TAN' | 'SQRT' | 'LN' | 'SINC';
  amplitude?: number;
  phase_multiplier?: number;
  phase_offset?: number;
  value_offset?: number;
  use_additive?: boolean;
  // envelope
  reference_value?: number;
  default_min?: number;
  default_max?: number;
  control_points?: { frame: number; min: number; max: number }[];
}

export interface FCurve {
  data_path: string;
  array_index: number;
  keyframe_points: Keyframe[];
  extrapolation: 'CONSTANT' | 'LINEAR';
  modifiers: FModifier[];
  group?: string;
  mute?: boolean;
  hide?: boolean;
  lock?: boolean;
  select?: boolean;
  color_mode?: 'AUTO_RAINBOW' | 'AUTO_RGB' | 'AUTO_YRGB' | 'CUSTOM';
  color?: Color;
  /** baked samples (frame, value) used when the curve has no keyframes */
  sampled_points?: [number, number][];
}

export interface ActionData {
  id: ID;
  name: string;
  fcurves: FCurve[];
  frame_range?: Vec2;
  use_fake_user?: boolean;
  /** markers stored with the action (shown in the Action Editor with Show Pose Markers) */
  pose_markers?: TimelineMarker[];
  users?: number;
}

export interface NlaStrip {
  name: string;
  action: ID;
  frame_start: number;
  frame_end: number;
  action_frame_start: number;
  action_frame_end: number;
  scale: number;
  repeat: number;
  blend_type: 'REPLACE' | 'COMBINE' | 'ADD' | 'SUBTRACT' | 'MULTIPLY';
  blend_in: number;
  blend_out: number;
  influence?: number;
  mute: boolean;
  select?: boolean;
  extrapolation: 'HOLD' | 'HOLD_FORWARD' | 'NOTHING';
  /** strip kind (action clip when absent) */
  type?: 'CLIP' | 'TRANSITION' | 'META';
  /** META: the grouped strips, in inner time (action_frame_start..end) */
  strips?: NlaStrip[];
}

export interface NlaTrack {
  name: string;
  strips: NlaStrip[];
  mute: boolean;
  is_solo: boolean;
  lock?: boolean;
  select?: boolean;
}

export interface AnimData {
  action: ID | null;
  nla_tracks: NlaTrack[];
  action_blend_type?: NlaStrip['blend_type'];
  action_influence?: number;
  drivers: Driver[];
  /** NLA tweak mode: the strip whose action is being edited */
  tweak?: { track: number; strip: number; prev_action: ID | null; upper: boolean } | null;
}

export type DriverIdType = 'OBJECT' | 'SCENE' | 'MESH' | 'CURVE' | 'LIGHT' | 'CAMERA' | 'ARMATURE' | 'LATTICE' | 'MATERIAL' | 'WORLD' | 'IMAGE' | 'ACTION' | 'NODETREE' | 'TEXT' | 'COLLECTION' | 'PARTICLE';

export interface DriverTarget {
  /** target data-block (an object unless id_type says otherwise) */
  id: ID | null;
  /** table the id refers to (default OBJECT) */
  id_type?: DriverIdType;
  data_path: string;
  /** pose bone of an armature target (Transform Channel, Distance, Rotational Difference) */
  bone_target?: string;
  transform_type?: string;
  transform_space?: 'WORLD_SPACE' | 'TRANSFORM_SPACE' | 'LOCAL_SPACE';
  /** how rotation channels are read: AUTO, an Euler order, QUATERNION or SWING_TWIST_X/Y/Z */
  rotation_mode?: string;
  /** Context Property variables: which context data-block the path is read from */
  context_property?: 'ACTIVE_SCENE' | 'ACTIVE_VIEW_LAYER';
  /** use fallback_value when the path can't be resolved instead of flagging an error */
  use_fallback_value?: boolean;
  fallback_value?: number;
}

export interface DriverVariable {
  name: string;
  type: 'SINGLE_PROP' | 'TRANSFORMS' | 'ROTATION_DIFF' | 'LOC_DIFF' | 'CONTEXT_PROP';
  targets: DriverTarget[];
}

export interface Driver {
  data_path: string;
  array_index: number;
  type: 'AVERAGE' | 'SUM' | 'SCRIPTED' | 'MIN' | 'MAX';
  expression: string;
  variables: DriverVariable[];
  /** scripted expressions can read the driven data-block as `self` */
  use_self?: boolean;
  /** maps the driver value (x) to the property value (y); without keys or modifiers the value passes through */
  fcurve?: FCurve;
}

// ---------------------------------------------------------------------------
// Modifiers / constraints / physics

export interface ModifierBase {
  id: ID;
  name: string;
  type: string;
  show_viewport: boolean;
  show_render: boolean;
  show_in_editmode: boolean;
  show_on_cage?: boolean;
  show_expanded: boolean;
  [key: string]: unknown;
}

export interface Constraint {
  id: ID;
  name: string;
  type: string;
  mute: boolean;
  influence: number;
  show_expanded: boolean;
  target?: ID | null;
  subtarget?: string;
  owner_space?: 'WORLD' | 'LOCAL' | 'POSE' | 'LOCAL_WITH_PARENT' | 'CUSTOM' | 'LOCAL_OWNER_ORIENT';
  target_space?: 'WORLD' | 'LOCAL' | 'POSE' | 'LOCAL_WITH_PARENT' | 'CUSTOM' | 'LOCAL_OWNER_ORIENT';
  [key: string]: unknown;
}

export interface RigidBodyData {
  type: 'ACTIVE' | 'PASSIVE';
  enabled: boolean;
  kinematic: boolean;
  mass: number;
  friction: number;
  restitution: number;
  collision_shape: 'BOX' | 'SPHERE' | 'CAPSULE' | 'CYLINDER' | 'CONE' | 'CONVEX_HULL' | 'MESH';
  collision_margin: number;
  linear_damping: number;
  angular_damping: number;
  use_deactivation?: boolean;
}

export interface ParticleSettings {
  id: ID;
  name: string;
  type: 'EMITTER' | 'HAIR';
  count: number;
  frame_start: number;
  frame_end: number;
  lifetime: number;
  lifetime_random: number;
  emit_from: 'VERT' | 'FACE' | 'VOLUME';
  normal_factor: number;
  object_align_factor: Vec3;
  factor_random: number;
  mass: number;
  particle_size: number;
  size_random: number;
  render_type: 'NONE' | 'HALO' | 'LINE' | 'PATH' | 'OBJECT' | 'COLLECTION';
  instance_object?: ID | null;
  hair_length: number;
  hair_step?: number;
  effector_weights_gravity: number;
  drag_factor?: number;
  brownian_factor?: number;
  damping?: number;
  use_rotations?: boolean;
  angular_velocity_factor?: number;
  seed?: number;
  display_color?: Color;
  child_type?: 'NONE' | 'SIMPLE' | 'INTERPOLATED';
  rendered_child_count?: number;
  clump_factor?: number;
  roughness_1?: number;
  users?: number;
}

export interface ParticleSystem {
  name: string;
  settings: ID;
  seed: number;
}

export interface ForceField {
  type: 'NONE' | 'FORCE' | 'WIND' | 'VORTEX' | 'TURBULENCE' | 'DRAG' | 'MAGNET' | 'HARMONIC' | 'LENNARDJ' | 'GUIDE';
  strength: number;
  flow: number;
  noise?: number;
  falloff_type?: 'SPHERE' | 'TUBE' | 'CONE';
  use_max_distance?: boolean;
  distance_max?: number;
  size?: number;
  seed?: number;
}

export interface CollisionSettings {
  use: boolean;
  thickness_outer: number;
  cloth_friction: number;
  damping: number;
  use_culling: boolean;
}

// ---------------------------------------------------------------------------
// Objects & collections

export interface ObjectData {
  id: ID;
  name: string;
  type: ObjectType;
  data: ID | null;
  parent: ID | null;
  parent_type: 'OBJECT' | 'BONE' | 'VERTEX' | 'VERTEX_3';
  parent_bone: string;
  /** VERTEX / VERTEX_3 parenting: element indices of the parent (vertices, curve points, lattice points) */
  parent_vertices?: number[];
  /** inverse of the parent's world matrix at parenting time */
  matrix_parent_inverse: Mat4;
  location: Vec3;
  rotation_mode: RotationMode;
  rotation_euler: Vec3;
  rotation_quaternion: Vec4; // w x y z
  rotation_axis_angle: Vec4; // angle x y z
  scale: Vec3;
  delta_location: Vec3;
  delta_rotation_euler: Vec3;
  delta_scale: Vec3;
  lock_location: [boolean, boolean, boolean];
  lock_rotation: [boolean, boolean, boolean];
  lock_scale: [boolean, boolean, boolean];
  hide_viewport: boolean; // monitor icon (global)
  hide: boolean; // eye icon (view layer, H key)
  hide_render: boolean;
  hide_select: boolean;
  select: boolean;
  display_type: 'TEXTURED' | 'SOLID' | 'WIRE' | 'BOUNDS';
  show_wire: boolean;
  show_in_front: boolean;
  show_name: boolean;
  show_axis: boolean;
  show_bounds?: boolean;
  color: Color4; // object color
  empty_display_type: 'PLAIN_AXES' | 'ARROWS' | 'SINGLE_ARROW' | 'CIRCLE' | 'CUBE' | 'SPHERE' | 'CONE' | 'IMAGE';
  empty_display_size: number;
  /** image empties (ob.data is the image id): offset of the image relative to the origin, in image-size units */
  empty_image_offset?: [number, number];
  empty_image_depth?: 'DEFAULT' | 'FRONT' | 'BACK';
  empty_image_side?: 'DOUBLE_SIDED' | 'FRONT' | 'BACK';
  show_empty_image_orthographic?: boolean;
  show_empty_image_perspective?: boolean;
  show_empty_image_only_axis_aligned?: boolean;
  use_empty_image_alpha?: boolean;
  instance_type: 'NONE' | 'COLLECTION' | 'VERTS' | 'FACES';
  instance_collection: ID | null;
  /** vertex instancing: rotate instances to the vertex normal */
  use_instance_vertices_rotation?: boolean;
  /** face instancing: scale instances by the face size */
  use_instance_faces_scale?: boolean;
  instance_faces_scale?: number;
  modifiers: ModifierBase[];
  /** visual effects of grease pencil objects (Properties ▸ Visual Effects) */
  shader_effects?: import('../greasepencil/types').ShaderFx[];
  constraints: Constraint[];
  animation_data: AnimData | null;
  pose: Record<string, PoseBone> | null;
  active_material_index: number;
  /** Object-linked material overrides per slot (null = use data's). */
  material_slots_link?: ('DATA' | 'OBJECT')[];
  object_materials?: (ID | null)[];
  rigid_body: RigidBodyData | null;
  particle_systems: ParticleSystem[];
  field: ForceField | null;
  collision: CollisionSettings | null;
  vertex_group_active_index?: number;
  /** show only the active shape key, at full strength */
  show_only_shape_key?: boolean;
  /** sound settings of a SPEAKER object */
  speaker?: import('../object/speaker').SpeakerSettings;
  /** settings of a LIGHT_PROBE object (src/render/realtime/probes) */
  lightprobe?: LightProbeSettings;
  pass_index?: number;
  is_shadow_catcher?: boolean;
  is_holdout?: boolean;
  visible_camera?: boolean;
  visible_shadow?: boolean;
  custom: CustomProps;
  /** Last mode the object was in (restored on activation) */
  mode?: Mode;
}

export interface CollectionData {
  id: ID;
  name: string;
  objects: ID[];
  children: ID[];
  hide_viewport: boolean;
  hide_render: boolean;
  hide_select: boolean;
  /** view-layer exclude checkbox */
  exclude: boolean;
  /** view-layer eye */
  hide: boolean;
  color_tag: 'NONE' | 'COLOR_01' | 'COLOR_02' | 'COLOR_03' | 'COLOR_04' | 'COLOR_05' | 'COLOR_06' | 'COLOR_07' | 'COLOR_08';
  instance_offset: Vec3;
  holdout?: boolean;
  indirect_only?: boolean;
}

// ---------------------------------------------------------------------------
// Scene

export type RenderEngine = 'RASTER' | 'PATHTRACE' | 'SOLID';

export interface RenderSettings extends RealtimeRenderSettings {
  engine: RenderEngine;
  resolution_x: number;
  resolution_y: number;
  resolution_percentage: number;
  pixel_aspect_x: number;
  pixel_aspect_y: number;
  film_transparent: boolean;
  fps: number;
  fps_base: number;
  file_format: 'PNG' | 'JPEG' | 'WEBP' | 'WEBM';
  color_mode: 'BW' | 'RGB' | 'RGBA';
  filepath: string;
  // sampling
  samples: number; // path tracer
  preview_samples: number;
  raster_samples: number; // taa
  max_bounces: number;
  diffuse_bounces?: number;
  glossy_bounces?: number;
  transmission_bounces?: number;
  use_denoising: boolean;
  preview_denoising?: boolean;
  // raster
  use_gtao: boolean;
  gtao_distance: number;
  use_bloom: boolean;
  bloom_threshold: number;
  bloom_intensity: number;
  bloom_radius: number;
  use_ssr: boolean;
  shadow_cube_size: number;
  shadow_cascade_size: number;
  use_soft_shadows: boolean;
  use_motion_blur: boolean;
  motion_blur_shutter: number;
  // color management
  view_transform: 'STANDARD' | 'FILMIC' | 'AGX' | 'KHRONOS_PBR_NEUTRAL' | 'RAW';
  look: string;
  exposure: number;
  gamma: number;
  // passes
  use_pass_combined: boolean;
  use_pass_z: boolean;
  use_pass_normal: boolean;
  use_pass_mist: boolean;
  use_pass_ambient_occlusion?: boolean;
  use_pass_emit?: boolean;
  use_pass_diffuse_color?: boolean;
  use_pass_object_index?: boolean;
  use_compositing: boolean;
  use_stamp?: boolean;
  dither_intensity: number;
  use_freestyle?: boolean;
  // --- sampling / light paths (see src/render/final/props/render.ts)
  /** realtime viewport anti-aliasing samples accumulated while the view is still */
  preview_raster_samples?: number;
  /** path tracer: stop sampling after this many seconds (0 = no limit) */
  time_limit?: number;
  sample_clamp_direct?: number;
  sample_clamp_indirect?: number;
  /** path tracer: roughness added along glossy paths to reduce caustic noise */
  blur_glossy?: number;
  /** realtime: scale of light from lamps / from the world */
  direct_light_intensity?: number;
  indirect_light_intensity?: number;
  // --- simplify
  use_simplify?: boolean;
  simplify_subdivision?: number;
  simplify_subdivision_render?: number;
  simplify_child_particles?: number;
  simplify_child_particles_render?: number;
  // --- depth of field / motion blur / film
  use_bokeh_jittered?: boolean;
  motion_blur_position?: 'START' | 'CENTER' | 'END';
  filter_size?: number;
  pixel_filter_type?: 'BOX' | 'GAUSSIAN' | 'BLACKMAN_HARRIS';
  filter_width?: number;
  film_exposure?: number;
  // --- performance
  preview_pixel_size?: 'AUTO' | '1' | '2' | '4' | '8';
  use_auto_tile?: boolean;
  tile_size?: number;
  // --- colour management
  display_device?: string;
  sequencer_colorspace?: string;
  use_white_balance?: boolean;
  white_balance_temperature?: number;
  white_balance_tint?: number;
  use_curve_mapping?: boolean;
  /** display curve control points (x, y in 0..1) applied after the view transform */
  curve_mapping?: [number, number][];
  // --- output
  frame_map_old?: number;
  frame_map_new?: number;
  use_border?: boolean;
  border_min_x?: number;
  border_min_y?: number;
  border_max_x?: number;
  border_max_y?: number;
  use_crop_to_border?: boolean;
  use_file_extension?: boolean;
  /** JPEG / WebP quality (percent) */
  quality?: number;
  use_lock_interface?: boolean;
  // --- metadata (stamp)
  use_stamp_date?: boolean;
  use_stamp_time?: boolean;
  use_stamp_render_time?: boolean;
  use_stamp_frame?: boolean;
  use_stamp_frame_range?: boolean;
  use_stamp_memory?: boolean;
  use_stamp_hostname?: boolean;
  use_stamp_camera?: boolean;
  use_stamp_lens?: boolean;
  use_stamp_scene?: boolean;
  use_stamp_marker?: boolean;
  use_stamp_filename?: boolean;
  use_stamp_note?: boolean;
  stamp_note_text?: string;
  use_stamp_labels?: boolean;
  stamp_font_size?: number;
  stamp_foreground?: [number, number, number, number];
  stamp_background?: [number, number, number, number];
  /** Solid (Workbench) engine: shading of final renders */
  display_shading?: {
    light: 'STUDIO' | 'MATCAP' | 'FLAT';
    color_type: 'MATERIAL' | 'OBJECT' | 'SINGLE' | 'RANDOM' | 'VERTEX' | 'TEXTURE';
    single_color: [number, number, number];
    show_backface_culling: boolean;
    show_xray: boolean;
    xray_alpha: number;
    show_shadows: boolean;
    show_cavity: boolean;
    show_object_outline: boolean;
    show_specular_highlight: boolean;
  };
  // --- view layer
  /** the view layer is rendered */
  use_view_layer?: boolean;
  use_sky?: boolean;
  use_solid?: boolean;
  use_pass_position?: boolean;
  use_pass_uv?: boolean;
  use_pass_material_index?: boolean;
}

export interface ToolSettings {
  use_snap: boolean;
  snap_elements: ('INCREMENT' | 'VERTEX' | 'EDGE' | 'FACE' | 'VOLUME' | 'EDGE_MIDPOINT' | 'GRID')[];
  snap_target: 'CLOSEST' | 'CENTER' | 'MEDIAN' | 'ACTIVE';
  use_snap_align_rotation?: boolean;
  use_snap_grid_absolute?: boolean;
  use_proportional_edit: boolean;
  use_proportional_edit_objects: boolean;
  proportional_edit_falloff: 'SMOOTH' | 'SPHERE' | 'ROOT' | 'INVERSE_SQUARE' | 'SHARP' | 'LINEAR' | 'CONSTANT' | 'RANDOM';
  proportional_size: number;
  use_proportional_connected: boolean;
  use_proportional_projected?: boolean;
  transform_pivot_point: 'BOUNDING_BOX_CENTER' | 'CURSOR' | 'INDIVIDUAL_ORIGINS' | 'MEDIAN_POINT' | 'ACTIVE_ELEMENT';
  use_transform_data_origin?: boolean;
  use_transform_skip_children?: boolean;
  mesh_select_mode: [boolean, boolean, boolean]; // vert, edge, face
  use_mesh_automerge: boolean;
  double_threshold: number;
  use_keyframe_insert_auto: boolean;
  /** markers can't be selected, moved or deleted */
  lock_markers?: boolean;
  /** proportional editing of keys in the Dope Sheet / Graph Editor */
  use_proportional_action?: boolean;
  use_proportional_fcurve?: boolean;
  keyframe_type: Keyframe['type'];
  use_uv_select_sync: boolean;
  uv_select_mode: 'VERTEX' | 'EDGE' | 'FACE' | 'ISLAND';
  /** re-unwrap islands while their pinned UVs are moved */
  use_live_unwrap?: boolean;
  /** snapping while transforming UVs, and what to snap to */
  use_snap_uv?: boolean;
  snap_uv_element?: 'INCREMENT' | 'VERTEX';
  /** which UVs are selected together with a picked UV (default SHARED_LOCATION) */
  uv_sticky_select_mode?: 'SHARED_LOCATION' | 'DISABLED' | 'SHARED_VERTEX';
  // sculpt / paint
  sculpt: SculptSettings;
  unified_paint: { size: number; strength: number; color: Color; secondary_color: Color; weight: number };
  use_auto_normalize?: boolean;
  vertex_group_weight?: number;
  /** Mirror options for mesh editing */
  use_mesh_mirror_x?: boolean;
  use_mesh_mirror_y?: boolean;
  use_mesh_mirror_z?: boolean;
}

export interface SculptSettings {
  brush: string; // brush id
  use_symmetry_x: boolean;
  use_symmetry_y: boolean;
  use_symmetry_z: boolean;
  radius: number; // px
  strength: number;
  use_dyntopo?: boolean;
  /** dynamic topology detail: pixels (relative), percent of the brush, or constant resolution */
  detail_size?: number;
  detail_type_method?: 'RELATIVE' | 'CONSTANT' | 'BRUSH' | 'MANUAL';
  detail_refine_method?: 'SUBDIVIDE' | 'COLLAPSE' | 'SUBDIVIDE_COLLAPSE';
  detail_percent?: number;
  /** pull the surface down (world -Z) with every dab */
  gravity?: number;
  /** meshes with modifiers update their shading only after a stroke */
  use_sculpt_delay_updates?: boolean;
  constant_detail_resolution?: number;
  use_frontface?: boolean;
  falloff: 'SMOOTH' | 'SPHERE' | 'ROOT' | 'SHARP' | 'LINEAR' | 'CONSTANT';
  autosmooth_factor: number;
  direction: 'ADD' | 'SUBTRACT';
  use_accumulate?: boolean;
  normal_radius_factor?: number;
  use_space?: boolean;
  spacing?: number;
  /** auto-masking: limit brushes by topology, face sets, boundaries, cavity or normals */
  use_automasking_topology?: boolean;
  use_automasking_face_sets?: boolean;
  use_automasking_boundary_edges?: boolean;
  use_automasking_boundary_face_sets?: boolean;
  use_automasking_cavity?: boolean;
  use_automasking_cavity_inverted?: boolean;
  use_automasking_start_normal?: boolean;
  use_automasking_view_normal?: boolean;
  automasking_boundary_edges_propagation_steps?: number;
  automasking_cavity_factor?: number;
  automasking_cavity_blur_steps?: number;
  automasking_start_normal_limit?: number;
  automasking_start_normal_falloff?: number;
  automasking_view_normal_limit?: number;
  automasking_view_normal_falloff?: number;
}

export interface UnitSettings {
  system: 'METRIC' | 'IMPERIAL' | 'NONE';
  scale_length: number;
  length_unit: 'ADAPTIVE' | 'KILOMETERS' | 'METERS' | 'CENTIMETERS' | 'MILLIMETERS' | 'MICROMETERS';
  system_rotation: 'DEGREES' | 'RADIANS';
}

export interface TimelineMarker {
  name: string;
  frame: number;
  select: boolean;
  camera?: ID | null;
}

export interface RigidBodyWorld {
  enabled: boolean;
  collection: ID | null;
  substeps_per_frame: number;
  solver_iterations: number;
  time_scale: number;
  frame_start: number;
  frame_end: number;
}

export interface KeyingSetPath {
  /** object the path belongs to */
  id: ID | null;
  data_path: string;
  /** array element, or -1 for all elements */
  index: number;
}

export interface KeyingSetData {
  name: string;
  paths: KeyingSetPath[];
  active_path_index?: number;
}

export interface SceneData {
  name: string;
  /** step of the timeline's Jump buttons (Ctrl ← / →), in time_jump_unit */
  time_jump_delta?: number;
  time_jump_unit?: 'SECONDS' | 'FRAMES';
  /** camera view safe-area margins (fractions of the frame, x and y) */
  safe_areas?: { title: [number, number]; action: [number, number]; title_center: [number, number]; action_center: [number, number] };
  frame_start: number;
  frame_end: number;
  frame_step: number;
  frame_current: number;
  frame_preview_start?: number;
  frame_preview_end?: number;
  use_preview_range?: boolean;
  frame_subframe?: number;
  camera: ID | null;
  world: ID | null;
  collection: ID; // master collection
  cursor: { location: Vec3; rotation_euler: Vec3 };
  render: RenderSettings;
  tool_settings: ToolSettings;
  unit_settings: UnitSettings;
  gravity: Vec3;
  use_gravity: boolean;
  timeline_markers: TimelineMarker[];
  rigidbody_world: RigidBodyWorld | null;
  compositor: NodeTreeData | null;
  use_nodes: boolean; // compositing
  /** compositing node group (node_groups id, tree type COMPOSITOR); supersedes `compositor` */
  compositing_node_group?: ID | null;
  /** sync mode for playback */
  sync_mode: 'NONE' | 'FRAME_DROP' | 'AUDIO_SYNC';
  /** active object id (view layer) */
  active_object: ID | null;
  custom: CustomProps;
  /** active keying set: a built-in set or `KS:<name>` for one of `keying_sets` */
  keying_set?: 'LocRotScale' | 'Location' | 'Rotation' | 'Scale' | 'Available' | 'WholeCharacter' | `KS:${string}`;
  /** scrubbing stays inside the scene (or preview) frame range */
  lock_frame_selection_to_range?: boolean;
  /** user keying sets (absolute property paths) */
  keying_sets?: KeyingSetData[];
}

export interface DocumentData {
  version: number;
  scene: SceneData;
  objects: Record<ID, ObjectData>;
  collections: Record<ID, CollectionData>;
  meshes: Record<ID, MeshData>;
  curves: Record<ID, CurveData>;
  lights: Record<ID, LightData>;
  cameras: Record<ID, CameraData>;
  armatures: Record<ID, ArmatureData>;
  lattices: Record<ID, LatticeData>;
  materials: Record<ID, MaterialData>;
  worlds: Record<ID, WorldData>;
  images: Record<ID, ImageData>;
  actions: Record<ID, ActionData>;
  node_groups: Record<ID, NodeGroupData>;
  particles: Record<ID, ParticleSettings>;
  texts: Record<ID, TextData>;
  brushes: Record<ID, BrushData>;
  /** Font data-blocks used by text objects; absent in older files */
  fonts?: Record<ID, VectorFontData>;
  /** Grease Pencil data-blocks (src/greasepencil); absent in older files */
  grease_pencils?: Record<ID, import('../greasepencil/types').GreasePencilData>;
  /** Files stored in the project for geometry import nodes; absent in older files */
  packed_files?: Record<ID, import('../geonodes/curves/importers').PackedFile>;
  /** Metaball data-blocks (src/metaball); absent in older files */
  metaballs?: Record<ID, import('../metaball/types').MetaballData>;
  /** Hair curves data-blocks (src/hair); absent in older files */
  hair_curves?: Record<ID, import('../hair/types').HairCurvesData>;
  /** Volume data-blocks (src/volume); absent in older files */
  volumes?: Record<ID, import('../volume/types').VolumeData>;
  /** Point cloud data-blocks (src/pointcloud); absent in older files */
  pointclouds?: Record<ID, import('../pointcloud/types').PointCloudData>;
  /** Mode of the active object */
  mode: Mode;
  /** Ordering of object ids for stable iteration */
  object_order: ID[];
}

export interface BrushData {
  id: ID;
  name: string;
  /** sculpt tool identifier */
  sculpt_tool: string;
  mode: 'SCULPT' | 'TEXTURE_PAINT' | 'VERTEX_PAINT' | 'WEIGHT_PAINT';
  strength: number;
  radius: number;
  falloff: SculptSettings['falloff'];
  direction: 'ADD' | 'SUBTRACT';
  color?: Color;
  blend?: 'MIX' | 'ADD' | 'SUB' | 'MUL' | 'LIGHTEN' | 'DARKEN' | 'ERASE_ALPHA';
  auto_smooth_factor: number;
  spacing: number;
  normal_radius_factor?: number;
  hardness?: number;
}

export type DataBlockKind =
  | 'objects'
  | 'meshes'
  | 'curves'
  | 'lights'
  | 'cameras'
  | 'armatures'
  | 'lattices'
  | 'materials'
  | 'worlds'
  | 'images'
  | 'actions'
  | 'node_groups'
  | 'particles'
  | 'texts'
  | 'brushes'
  | 'collections';
