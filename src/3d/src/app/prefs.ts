// User preferences and per-session UI state (not part of the undo history).
export interface Preferences {
  theme: 'DARK' | 'LIGHT';
  resolution_scale: number;
  emulate_numpad: boolean;
  emulate_3_button_mouse: boolean;
  /** trackpad: two-finger scroll orbits (true) or zooms (false) */
  trackpad_orbit: boolean;
  orbit_method: 'TURNTABLE' | 'TRACKBALL';
  /** Shift ` starts walk or fly navigation */
  navigation_mode?: 'WALK' | 'FLY';
  use_zoom_to_mouse: boolean;
  use_rotate_around_active: boolean;
  use_auto_perspective: boolean;
  invert_zoom_wheel: boolean;
  undo_steps: number;
  show_splash: boolean;
  select_mouse: 'LEFT' | 'RIGHT';
  use_mouse_depth_navigate: boolean;
  view_lens: number;
  autosave_interval: number;
  show_statusbar_stats: boolean;
  show_statusbar_scene_duration: boolean;
  show_statusbar_memory: boolean;
  show_statusbar_version: boolean;
  show_tooltips_python: boolean;
  gizmo_size: number;
  font_size: number;
}

const KEY = 'p3d.preferences.v1';

export const defaultPreferences = (): Preferences => ({
  theme: 'DARK',
  resolution_scale: 1,
  emulate_numpad: false,
  emulate_3_button_mouse: false,
  trackpad_orbit: true,
  orbit_method: 'TURNTABLE',
  use_zoom_to_mouse: false,
  use_rotate_around_active: false,
  use_auto_perspective: true,
  invert_zoom_wheel: false,
  undo_steps: 64,
  show_splash: true,
  select_mouse: 'LEFT',
  use_mouse_depth_navigate: false,
  view_lens: 50,
  autosave_interval: 2,
  show_statusbar_stats: true,
  show_statusbar_scene_duration: false,
  show_statusbar_memory: false,
  show_statusbar_version: true,
  show_tooltips_python: true,
  gizmo_size: 75,
  font_size: 11,
});

function load(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultPreferences(), ...JSON.parse(raw) };
  } catch {
    // storage unavailable
  }
  return defaultPreferences();
}

export const prefs: Preferences = load();

export function savePrefs() {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage unavailable: preferences apply to this session only
  }
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
