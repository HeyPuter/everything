// User preferences and per-session UI state (not part of the undo history).
// Preferences ▸ (src/prefs/) edits these; `savePrefs()` persists them in localStorage.
export interface Preferences {
  // --- Interface
  /** active theme preset id (themes are stored separately, see src/prefs/themes.ts) */
  theme: string;
  resolution_scale: number;
  font_size: number;
  show_tooltips: boolean;
  /** tooltips also show operator ids and data paths for scripting */
  show_tooltips_python: boolean;
  /** extra options aimed at add-on and script developers */
  show_developer_ui: boolean;
  show_splash: boolean;
  /** zoom / pan / camera / perspective buttons under the navigation gizmo */
  show_navigate_ui: boolean;
  /** drag an area corner to split / join areas */
  show_corner_split: boolean;
  /** drag the gaps between areas to resize them */
  show_edge_resize: boolean;
  /** small arrows that bring back hidden headers */
  show_regions_visibility_toggle: boolean;
  color_picker_type: 'CIRCLE_HSV' | 'CIRCLE_HSL' | 'SQUARE_SV' | 'SQUARE_HS' | 'SQUARE_HV';
  /** header placement of newly shown editors: keep each editor's own default, or force top / bottom */
  header_align: 'NONE' | 'TOP' | 'BOTTOM';
  factor_display_type: 'FACTOR' | 'PERCENTAGE';
  show_statusbar_stats: boolean;
  show_statusbar_scene_duration: boolean;
  show_statusbar_memory: boolean;
  show_statusbar_version: boolean;
  /** where F12 shows the render result */
  render_display_type: 'NONE' | 'AREA' | 'WINDOW' | 'SCREEN';
  use_text_antialiasing: boolean;
  /** CSS font family for the interface ('' = built-in) */
  font_ui: string;
  font_ui_mono: string;
  date_format: 'DEFAULT' | 'LE_SLASH' | 'LE_DOT' | 'ME_SLASH' | 'BE_DASH';
  time_format: 'H24' | 'H12';
  use_mouse_over_open: boolean;
  /** delays in ms */
  open_toplevel_delay: number;
  open_sublevel_delay: number;
  pie_animation_timeout: number;
  pie_tap_timeout: number;
  pie_menu_radius: number;
  pie_menu_threshold: number;
  pie_menu_confirm: number;
  use_reduce_motion: boolean;

  // --- Viewport
  show_object_info: boolean;
  show_view_name: boolean;
  show_playback_fps: boolean;
  gizmo_size: number;
  gizmo_size_navigate_v3d: number;
  view_lens: number;
  /** multisample anti-aliasing (applies when the app starts) */
  viewport_aa: 'OFF' | 'MSAA';
  anisotropic_filter: number;

  // --- Navigation
  orbit_method: 'TURNTABLE' | 'TRACKBALL';
  view_rotate_sensitivity: number;
  use_rotate_around_active: boolean;
  use_auto_perspective: boolean;
  /** animated view transitions in ms (0 = instant) */
  smooth_view: number;
  /** numpad orbit step in degrees */
  rotation_angle: number;
  view_zoom_axis: 'VERTICAL' | 'HORIZONTAL';
  invert_mouse_zoom: boolean;
  invert_zoom_wheel: boolean;
  use_zoom_to_mouse: boolean;
  /** Shift ` starts walk or fly navigation */
  navigation_mode?: 'WALK' | 'FLY';
  walk_mouse_speed: number;
  walk_use_mouse_reverse: boolean;
  walk_speed: number;
  walk_speed_factor: number;
  walk_teleport_time: number;
  walk_use_gravity: boolean;
  walk_view_height: number;
  walk_jump_height: number;

  // --- Input
  emulate_numpad: boolean;
  emulate_3_button_mouse: boolean;
  mouse_emulate_3_button_modifier: 'ALT' | 'OSKEY';
  /** trackpad: two-finger scroll orbits (true) or zooms (false) */
  trackpad_orbit: boolean;
  touchpad_scroll_direction: 'TRADITIONAL' | 'NATURAL';
  mouse_double_click_time: number;
  drag_threshold_mouse: number;
  use_drag_immediately: boolean;
  /** moves keep going past the window edge (the pointer is captured while transforming) */
  use_mouse_continuous: boolean;
  pressure_threshold_max: number;
  pressure_softness: number;
  ndof_enabled: boolean;
  ndof_translation_sensitivity: number;
  ndof_rotation_sensitivity: number;
  ndof_deadzone: number;
  ndof_navigation_mode: 'OBJECT' | 'FLY';
  ndof_zoom_direction: 'FORWARD' | 'UP';
  ndof_lock_horizon: boolean;
  ndof_rotx_invert_axis: boolean;
  ndof_roty_invert_axis: boolean;
  ndof_rotz_invert_axis: boolean;
  ndof_panx_invert_axis: boolean;
  ndof_pany_invert_axis: boolean;
  ndof_panz_invert_axis: boolean;
  /** left- or right-click select (not used by the dispatcher yet) */
  select_mouse: 'LEFT' | 'RIGHT';

  // --- Editing
  object_align: 'WORLD' | 'VIEW' | 'CURSOR';
  use_enter_edit_mode: boolean;
  duplicate: Record<string, boolean>;
  annotation_color: [number, number, number];
  annotation_eraser_radius: number;
  /** smallest pointer movement (px) that adds a point to a Grease Pencil stroke */
  gpencil_min_distance: number;
  use_text_edit_auto_close: boolean;
  sculpt_paint_overlay_color: [number, number, number];
  /** weight paint shows weights with the colours below instead of the default heat map */
  use_weight_color_range: boolean;
  /** colours at weights 0, .25, .5, .75 and 1 */
  weight_color_range: [number, number, number][];
  node_use_insert_offset: boolean;
  node_margin: number;

  // --- Animation
  view2d_grid_spacing_min: number;
  timecode_style: 'MINIMAL' | 'SMPTE' | 'SMPTE_COMPACT' | 'MILLISECONDS' | 'SECONDS_ONLY';
  use_keyframe_insert_needed: boolean;
  use_insertkey_xyz_to_rgb: boolean;
  fcurve_unselected_alpha: number;
  show_only_selected_curve_keyframes: boolean;
  keyframe_new_interpolation_type: 'CONSTANT' | 'LINEAR' | 'BEZIER';
  keyframe_new_handle_type: 'FREE' | 'ALIGNED' | 'VECTOR' | 'AUTO' | 'AUTO_CLAMPED';
  use_negative_frames: boolean;

  // --- System
  undo_steps: number;
  scrollback: number;
  audio_sample_rate: number;
  audio_channels: number;
  audio_latency: 'interactive' | 'balanced' | 'playback';

  // --- Save & Load
  autosave_interval: number;
  use_auto_save_temporary_files: boolean;
  /** write preference changes to storage as they happen */
  use_preferences_save: boolean;
  recent_files: number;
  use_save_prompt: boolean;
  use_load_ui: boolean;
  use_tabs_as_spaces: boolean;
  show_hidden_files_datablocks: boolean;
  use_filter_files: boolean;
  use_scripts_auto_execute: boolean;

  // --- File Paths
  render_output_directory: string;
}

const KEY = 'p3d.preferences.v1';

export const DUPLICATE_TYPES = ['MESH', 'CURVE', 'FONT', 'LATTICE', 'META', 'ARMATURE', 'CAMERA', 'LIGHT', 'SPEAKER', 'GREASEPENCIL', 'POINTCLOUD', 'MATERIAL', 'ACTION'] as const;

export const defaultPreferences = (): Preferences => ({
  theme: 'DARK',
  resolution_scale: 1,
  font_size: 12,
  show_tooltips: true,
  show_tooltips_python: true,
  show_developer_ui: false,
  show_splash: true,
  show_navigate_ui: true,
  show_corner_split: true,
  show_edge_resize: true,
  show_regions_visibility_toggle: true,
  color_picker_type: 'CIRCLE_HSV',
  header_align: 'NONE',
  factor_display_type: 'FACTOR',
  show_statusbar_stats: true,
  show_statusbar_scene_duration: false,
  show_statusbar_memory: false,
  show_statusbar_version: true,
  render_display_type: 'WINDOW',
  use_text_antialiasing: true,
  font_ui: '',
  font_ui_mono: '',
  date_format: 'DEFAULT',
  time_format: 'H24',
  use_mouse_over_open: false,
  open_toplevel_delay: 100,
  open_sublevel_delay: 0,
  pie_animation_timeout: 0,
  pie_tap_timeout: 250,
  pie_menu_radius: 110,
  pie_menu_threshold: 20,
  pie_menu_confirm: 0,
  use_reduce_motion: false,

  show_object_info: true,
  show_view_name: true,
  show_playback_fps: true,
  gizmo_size: 75,
  gizmo_size_navigate_v3d: 80,
  view_lens: 50,
  viewport_aa: 'MSAA',
  anisotropic_filter: 8,

  orbit_method: 'TURNTABLE',
  view_rotate_sensitivity: 0.43,
  use_rotate_around_active: false,
  use_auto_perspective: true,
  smooth_view: 200,
  rotation_angle: 15,
  view_zoom_axis: 'VERTICAL',
  invert_mouse_zoom: false,
  invert_zoom_wheel: false,
  use_zoom_to_mouse: false,
  navigation_mode: 'WALK',
  walk_mouse_speed: 1,
  walk_use_mouse_reverse: false,
  walk_speed: 2.5,
  walk_speed_factor: 5,
  walk_teleport_time: 0.25,
  walk_use_gravity: false,
  walk_view_height: 1.6,
  walk_jump_height: 0.4,

  emulate_numpad: false,
  emulate_3_button_mouse: false,
  mouse_emulate_3_button_modifier: 'ALT',
  trackpad_orbit: true,
  touchpad_scroll_direction: 'TRADITIONAL',
  mouse_double_click_time: 350,
  drag_threshold_mouse: 4,
  use_drag_immediately: true,
  use_mouse_continuous: false,
  pressure_threshold_max: 1,
  pressure_softness: 0,
  ndof_enabled: true,
  ndof_translation_sensitivity: 4,
  ndof_rotation_sensitivity: 4,
  ndof_deadzone: 0.1,
  ndof_navigation_mode: 'OBJECT',
  ndof_zoom_direction: 'FORWARD',
  ndof_lock_horizon: true,
  ndof_rotx_invert_axis: false,
  ndof_roty_invert_axis: false,
  ndof_rotz_invert_axis: false,
  ndof_panx_invert_axis: false,
  ndof_pany_invert_axis: false,
  ndof_panz_invert_axis: false,
  select_mouse: 'LEFT',

  object_align: 'WORLD',
  use_enter_edit_mode: false,
  duplicate: { MESH: true, CURVE: true, FONT: true, LATTICE: true, META: true, ARMATURE: true, CAMERA: true, LIGHT: true, SPEAKER: true, GREASEPENCIL: true, POINTCLOUD: true, MATERIAL: false, ACTION: true },
  annotation_color: [0.12, 0.65, 0.95],
  annotation_eraser_radius: 12,
  gpencil_min_distance: 1.5,
  use_text_edit_auto_close: false,
  sculpt_paint_overlay_color: [0, 0, 0],
  use_weight_color_range: false,
  weight_color_range: [
    [0.05, 0.05, 0.2],
    [0.2, 0.3, 0.75],
    [0.85, 0.85, 0.85],
    [0.95, 0.6, 0.2],
    [0.8, 0.1, 0.1],
  ],
  node_use_insert_offset: true,
  node_margin: 40,

  view2d_grid_spacing_min: 50,
  timecode_style: 'MINIMAL',
  use_keyframe_insert_needed: false,
  use_insertkey_xyz_to_rgb: true,
  fcurve_unselected_alpha: 0.5,
  show_only_selected_curve_keyframes: false,
  keyframe_new_interpolation_type: 'BEZIER',
  keyframe_new_handle_type: 'AUTO_CLAMPED',
  use_negative_frames: true,

  undo_steps: 64,
  scrollback: 5000,
  audio_sample_rate: 48000,
  audio_channels: 2,
  audio_latency: 'interactive',

  autosave_interval: 2,
  use_auto_save_temporary_files: true,
  use_preferences_save: true,
  recent_files: 10,
  use_save_prompt: false,
  use_load_ui: true,
  use_tabs_as_spaces: true,
  show_hidden_files_datablocks: false,
  use_filter_files: true,
  use_scripts_auto_execute: false,

  render_output_directory: '//render/',
});

/** Stored values merged over the defaults (unknown keys from newer builds are kept). */
export function readStoredPrefs(): Partial<Preferences> | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<Preferences>) : null;
  } catch {
    return null;
  }
}

function load(): Preferences {
  const d = defaultPreferences();
  const stored = readStoredPrefs();
  if (!stored) return d;
  const out = { ...d, ...stored } as Preferences;
  // nested records merge per key so new data types get their defaults
  out.duplicate = { ...d.duplicate, ...(stored.duplicate ?? {}) };
  // older builds stored a light / dark choice
  if ((stored.theme as string) === 'LIGHT') out.theme = 'LIGHT';
  return out;
}

export const prefs: Preferences = load();

export function savePrefs() {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage unavailable: preferences apply to this session only
  }
}

/** Pen pressure after Preferences ▸ Input ▸ Tablet: full strength at the threshold, softness bends the curve. */
export function tabletPressure(p: number): number {
  const t = Math.max(0.01, Math.min(1, prefs.pressure_threshold_max));
  const x = Math.max(0, Math.min(1, p / t));
  return Math.pow(x, Math.pow(4, -Math.max(-1, Math.min(1, prefs.pressure_softness))));
}

/** A date (and time) in the format chosen in Preferences ▸ Interface ▸ Language. */
export function formatDate(t: number | Date, withTime = true): string {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const p2 = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear(),
    m = p2(d.getMonth() + 1),
    day = p2(d.getDate());
  let date: string;
  switch (prefs.date_format) {
    case 'LE_SLASH':
      date = `${day}/${m}/${y}`;
      break;
    case 'LE_DOT':
      date = `${day}.${m}.${y}`;
      break;
    case 'ME_SLASH':
      date = `${m}/${day}/${y}`;
      break;
    case 'BE_DASH':
      date = `${y}-${m}-${day}`;
      break;
    default:
      date = d.toLocaleDateString();
  }
  if (!withTime) return date;
  const hh = d.getHours();
  const time = prefs.time_format === 'H12' ? `${((hh + 11) % 12) + 1}:${p2(d.getMinutes())} ${hh < 12 ? 'AM' : 'PM'}` : `${p2(hh)}:${p2(d.getMinutes())}`;
  return `${date} ${time}`;
}

/** Active workspace tool per mode, e.g. 'builtin.select_box'. */
export const activeTools: Record<string, string> = {
  OBJECT: 'builtin.select_box',
  EDIT: 'builtin.select_box',
  SCULPT: 'brush_draw',
  POSE: 'builtin.select_box',
  WEIGHT_PAINT: 'brush_weight',
  VERTEX_PAINT: 'brush_vertpaint',
  TEXTURE_PAINT: 'brush_texpaint',
};

export const uiState = {
  /** transform orientation */
  orientation: 'GLOBAL' as 'GLOBAL' | 'LOCAL' | 'NORMAL' | 'GIMBAL' | 'VIEW' | 'CURSOR' | 'PARENT' | (string & {}),
  /** last used add-menu primitive */
  workspace: 'Layout',
  /** select box mode: SET / ADD / SUB / XOR / AND */
  selectMode: 'SET' as 'SET' | 'ADD' | 'SUB' | 'XOR' | 'AND',
  /** radius of the circle select tool / modal, in pixels */
  circleRadius: 25,
  /** last snap */
  snapToggle: false,
  clipboard: null as unknown,
  /** properties editor: tab per area handled by editor */
};
