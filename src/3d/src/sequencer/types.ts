// Video Sequencer data model. Stored additively on the scene (`scene.sequence_editor`) using the
// public `bpy` RNA naming conventions (strips, channels, frame_start,
// frame_offset_start, blend_type, …). Plain JSON-able objects; media bytes are typed arrays so
// undo snapshots and the native file format share them instead of copying.
import type { ID } from '../data/types';

export type StripType =
  | 'IMAGE'
  | 'MOVIE'
  | 'SOUND'
  | 'SCENE'
  | 'COLOR'
  | 'TEXT'
  | 'ADJUSTMENT'
  | 'META'
  | 'CROSS'
  | 'GAMMA_CROSS'
  | 'WIPE'
  | 'ADD'
  | 'SUBTRACT'
  | 'MULTIPLY'
  | 'ALPHA_OVER'
  | 'ALPHA_UNDER'
  | 'COLORMIX'
  | 'TRANSFORM'
  | 'SPEED'
  | 'GLOW'
  | 'GAUSSIAN_BLUR'
  | 'MULTICAM'
  | 'MASK';

export type BlendType =
  | 'REPLACE'
  | 'CROSS'
  | 'DARKEN'
  | 'MULTIPLY'
  | 'BURN'
  | 'LINEAR_BURN'
  | 'LIGHTEN'
  | 'SCREEN'
  | 'DODGE'
  | 'ADD'
  | 'OVERLAY'
  | 'SOFT_LIGHT'
  | 'HARD_LIGHT'
  | 'VIVID_LIGHT'
  | 'LINEAR_LIGHT'
  | 'PIN_LIGHT'
  | 'DIFFERENCE'
  | 'EXCLUSION'
  | 'SUBTRACT'
  | 'HUE'
  | 'SATURATION'
  | 'COLOR'
  | 'VALUE'
  | 'ALPHA_OVER'
  | 'ALPHA_UNDER'
  | 'GAMMA_CROSS';

export type ColorTag = 'NONE' | 'COLOR_01' | 'COLOR_02' | 'COLOR_03' | 'COLOR_04' | 'COLOR_05' | 'COLOR_06' | 'COLOR_07' | 'COLOR_08' | 'COLOR_09';

/** Encoded media file kept inside the document. */
export interface MediaFile {
  /** original file name (shown as the strip source) */
  filepath: string;
  mime: string;
  bytes: Uint8Array;
}

export interface StripTransform {
  offset_x: number;
  offset_y: number;
  scale_x: number;
  scale_y: number;
  /** radians, counter-clockwise */
  rotation: number;
  /** pivot, relative to the image (0..1) */
  origin: [number, number];
  filter: 'AUTO' | 'NEAREST' | 'BILINEAR';
}

export interface StripCrop {
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
}

export type ModifierType = 'COLOR_BALANCE' | 'BRIGHT_CONTRAST' | 'WHITE_BALANCE' | 'CURVES';

export interface ColorBalanceData {
  correction_method: 'LIFT_GAMMA_GAIN' | 'OFFSET_POWER_SLOPE';
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  offset: [number, number, number];
  power: [number, number, number];
  slope: [number, number, number];
  invert_lift: boolean;
  invert_gamma: boolean;
  invert_gain: boolean;
  invert_offset: boolean;
  invert_power: boolean;
  invert_slope: boolean;
}

export interface StripModifier {
  name: string;
  type: ModifierType;
  mute: boolean;
  show_expanded: boolean;
  /** COLOR_BALANCE */
  color_balance?: ColorBalanceData;
  color_multiply?: number;
  /** BRIGHT_CONTRAST */
  bright?: number;
  contrast?: number;
  /** WHITE_BALANCE: this colour becomes white */
  white_value?: number[];
  /** CURVES: curve mapping (combined, red, green, blue) stored like the RGB Curves node's props */
  curve_mapping?: Record<string, import('../data/types').SocketValue>;
  /** limit the modifier to a mask: another strip's image or a mask data-block */
  input_mask_type?: 'NONE' | 'STRIP' | 'ID';
  input_mask_strip?: string | null;
  input_mask_id?: string | null;
}

/** Retiming key: timeline offset from frame_start → content frame offset. */
export interface RetimingKey {
  frame: number;
  content: number;
  select?: boolean;
  /** the segment starting at this key eases between the neighbouring speeds */
  transition?: boolean;
}

export interface ImageElement {
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

export interface Strip {
  name: string;
  type: StripType;
  channel: number;
  /** timeline frame of the first content frame */
  frame_start: number;
  /** content length in frames (after hard trims) */
  frame_duration: number;
  /** soft trims (handles), frames */
  frame_offset_start: number;
  frame_offset_end: number;
  /** hard trims of the source content, frames (content_trim_start/end in 5.x) */
  animation_offset_start: number;
  animation_offset_end: number;
  select: boolean;
  select_left_handle: boolean;
  select_right_handle: boolean;
  mute: boolean;
  lock: boolean;
  blend_type: BlendType;
  blend_alpha: number;
  use_default_fade: boolean;
  effect_fader: number;
  color_tag: ColorTag;
  modifiers: StripModifier[];
  // visual
  transform: StripTransform;
  crop: StripCrop;
  use_flip_x: boolean;
  use_flip_y: boolean;
  use_reverse_frames: boolean;
  color_saturation: number;
  color_multiply: number;
  multiply_alpha: boolean;
  strobe: number;
  alpha_mode: 'STRAIGHT' | 'PREMUL';
  /** source size in pixels (images/movies; 0 = full frame generator) */
  orig_width?: number;
  orig_height?: number;
  // media
  media?: MediaFile;
  elements?: ImageElement[];
  /** movie frame rate */
  fps?: number;
  // sound
  volume?: number;
  pan?: number;
  show_waveform?: boolean;
  /** seconds into the sound file at the content start */
  sound_offset?: number;
  // scene
  scene?: string;
  scene_camera?: ID | null;
  // color / text
  color?: number[];
  text?: string;
  /** TEXT: a font file embedded in the document (the bundled sans-serif when unset) */
  font_file?: MediaFile | null;
  font_size?: number;
  use_bold?: boolean;
  use_italic?: boolean;
  wrap_width?: number;
  location?: [number, number];
  anchor_x?: 'LEFT' | 'CENTER' | 'RIGHT';
  anchor_y?: 'BOTTOM' | 'CENTER' | 'TOP';
  alignment_x?: 'LEFT' | 'CENTER' | 'RIGHT';
  use_shadow?: boolean;
  shadow_color?: number[];
  shadow_angle?: number;
  shadow_offset?: number;
  shadow_blur?: number;
  use_outline?: boolean;
  outline_color?: number[];
  outline_width?: number;
  use_box?: boolean;
  box_color?: number[];
  box_margin?: number;
  box_roundness?: number;
  // effects
  input_1?: string | null;
  input_2?: string | null;
  transition_type?: 'SINGLE' | 'DOUBLE' | 'IRIS' | 'CLOCK';
  direction?: 'OUT' | 'IN';
  angle?: number;
  blur_width?: number;
  threshold?: number;
  clamp?: number;
  boost_factor?: number;
  blur_radius?: number;
  quality?: number;
  use_only_boost?: boolean;
  size_x?: number;
  size_y?: number;
  speed_control?: 'STRETCH' | 'MULTIPLY' | 'FRAME_NUMBER' | 'LENGTH';
  speed_factor?: number;
  speed_frame_number?: number;
  speed_length?: number;
  blend_effect?: BlendType;
  /** MASK: the mask data-block shown */
  mask?: string | null;
  /** MULTICAM: channel shown by the selector */
  multicam_source?: number;
  factor?: number;
  // legacy Transform effect
  translation_unit?: 'PIXELS' | 'PERCENT';
  translate_start_x?: number;
  translate_start_y?: number;
  scale_start_x?: number;
  scale_start_y?: number;
  use_uniform_scale?: boolean;
  rotation_start?: number;
  // meta
  strips?: Strip[];
  channels?: SeqChannel[];
  /** names of the strips this one is connected to (selected and edited together) */
  connections?: string[];
  /** speed changes (see retime.ts); with keys, frame_duration is the retimed timeline length */
  retiming_keys?: RetimingKey[];
  show_retiming_keys?: boolean;
  /** animated properties (fades, keyframes): [timeline frame, value] keys per property, linear */
  keys?: Partial<Record<StripKeyPath, [number, number][]>>;
}

/** Strip properties that can be animated with keyframes. */
export type StripKeyPath = 'blend_alpha' | 'volume' | 'transform.offset_x' | 'transform.offset_y' | 'transform.scale_x' | 'transform.scale_y' | 'transform.rotation';

export interface SeqChannel {
  name: string;
  lock: boolean;
  mute: boolean;
}

export interface SequenceEditor {
  strips: Strip[];
  channels: SeqChannel[];
  active_strip: string | null;
  /** names of the meta strips being edited, outermost first */
  meta_stack: string[];
  /** frame overlay: reference frame offset from the current frame (or the frame itself when locked) */
  overlay_frame?: number;
  show_overlay_frame?: boolean;
  use_overlay_frame_lock?: boolean;
  /** how the reference frame shows: inside a rectangle over the current one, alone, or not */
  overlay_frame_type?: 'RECTANGLE' | 'REFERENCE' | 'CURRENT';
  /** the rectangle, as shares of the frame: [x0, y0, x1, y1] (y up) */
  overlay_frame_rect?: [number, number, number, number];
  proxy_storage?: 'PER_STRIP' | 'PROJECT';
  use_cache_raw?: boolean;
  use_cache_final?: boolean;
}

export interface SequencerToolSettings {
  overlap_mode: 'OVERWRITE' | 'EXPAND' | 'SHUFFLE';
  fit_method: 'FIT' | 'FILL' | 'STRETCH' | 'ORIGINAL';
  snap_to_current_frame: boolean;
  snap_to_hold_offset: boolean;
  snap_to_markers: boolean;
  snap_ignore_muted: boolean;
  snap_ignore_sound: boolean;
  snap_distance: number;
  /** preview snapping targets */
  snap_to_borders?: boolean;
  snap_to_center?: boolean;
  snap_to_strips_preview?: boolean;
  /** preview transforms pivot around this */
  pivot_point?: 'MEDIAN_POINT' | 'BOUNDING_BOX_CENTER' | 'CURSOR' | 'INDIVIDUAL_ORIGINS';
  /** 2D cursor of the preview, output pixels from the frame centre */
  cursor_location?: [number, number];
}

declare module '../data/types' {
  interface SceneData {
    sequence_editor?: SequenceEditor | null;
  }
  interface RenderSettings {
    /** Post Processing ▸ Sequencer */
    use_sequencer?: boolean;
  }
  interface ToolSettings {
    use_snap_sequencer?: boolean;
    sequencer_tool_settings?: SequencerToolSettings;
  }
}

export const MAX_CHANNELS = 128;
