// Per-viewport display settings (shading & overlays), mirroring the reference
// View3DShading / View3DOverlay property names.
export interface Shading {
  type: 'WIREFRAME' | 'SOLID' | 'MATERIAL' | 'RENDERED';
  light: 'STUDIO' | 'MATCAP' | 'FLAT';
  color_type: 'MATERIAL' | 'OBJECT' | 'SINGLE' | 'RANDOM' | 'VERTEX' | 'TEXTURE';
  wireframe_color_type: 'THEME' | 'OBJECT' | 'RANDOM';
  single_color: [number, number, number];
  background_type: 'THEME' | 'WORLD' | 'VIEWPORT';
  background_color: [number, number, number];
  show_xray: boolean;
  xray_alpha: number;
  show_xray_wireframe: boolean;
  xray_alpha_wireframe: number;
  show_backface_culling: boolean;
  show_shadows: boolean;
  show_cavity: boolean;
  show_specular_highlight: boolean;
  show_object_outline: boolean;
  use_scene_lights: boolean;
  use_scene_world: boolean;
  use_scene_lights_render: boolean;
  use_scene_world_render: boolean;
  studiolight_intensity: number;
  studiolight_background_alpha: number;
  studiolight_rotate_z: number;
}

export interface Overlay {
  show_overlays: boolean;
  show_motion_paths?: boolean;
  show_floor: boolean;
  show_axis_x: boolean;
  show_axis_y: boolean;
  show_axis_z: boolean;
  grid_scale: number;
  show_cursor: boolean;
  show_object_origins: boolean;
  show_object_origins_all: boolean;
  show_relationship_lines: boolean;
  show_extras: boolean;
  show_bones: boolean;
  show_outline_selected: boolean;
  show_wireframes: boolean;
  wireframe_threshold: number;
  wireframe_opacity: number;
  show_face_orientation: boolean;
  show_text: boolean;
  show_stats: boolean;
  show_ortho_grid: boolean;
  // edit mode
  show_edge_seams: boolean;
  show_edge_sharp: boolean;
  show_edge_crease: boolean;
  show_face_normals: boolean;
  show_vertex_normals: boolean;
  normals_length: number;
  show_face_center: boolean;
  show_weight: boolean;
  show_statvis: boolean;
  show_extra_edge_length: boolean;
  show_extra_face_area: boolean;
  show_extra_indices: boolean;
  // sculpt / paint
  sculpt_mode_mask_opacity: number;
  show_sculpt_mask?: boolean;
  show_sculpt_face_sets?: boolean;
  sculpt_mode_face_sets_opacity?: number;
  show_paint_wire: boolean;
  weight_paint_mode_opacity: number;
  texture_paint_mode_opacity: number;
  show_annotation: boolean;
}

export const defaultShading = (): Shading => ({
  type: 'SOLID',
  light: 'STUDIO',
  color_type: 'MATERIAL',
  wireframe_color_type: 'THEME',
  single_color: [0.8, 0.8, 0.8],
  background_type: 'THEME',
  background_color: [0.05, 0.05, 0.05],
  show_xray: false,
  xray_alpha: 0.5,
  show_xray_wireframe: true,
  xray_alpha_wireframe: 0,
  show_backface_culling: false,
  show_shadows: false,
  show_cavity: false,
  show_specular_highlight: true,
  show_object_outline: true,
  use_scene_lights: false,
  use_scene_world: false,
  use_scene_lights_render: true,
  use_scene_world_render: true,
  studiolight_intensity: 1,
  studiolight_background_alpha: 0,
  studiolight_rotate_z: 0,
});

export const defaultOverlay = (): Overlay => ({
  show_overlays: true,
  show_floor: true,
  show_axis_x: true,
  show_axis_y: true,
  show_axis_z: false,
  grid_scale: 1,
  show_cursor: true,
  show_object_origins: true,
  show_object_origins_all: false,
  show_relationship_lines: true,
  show_extras: true,
  show_motion_paths: true,
  show_bones: true,
  show_outline_selected: true,
  show_wireframes: false,
  wireframe_threshold: 1,
  wireframe_opacity: 1,
  show_face_orientation: false,
  show_text: true,
  show_stats: false,
  show_ortho_grid: true,
  show_edge_seams: true,
  show_edge_sharp: true,
  show_edge_crease: true,
  show_face_normals: false,
  show_vertex_normals: false,
  normals_length: 0.1,
  show_face_center: false,
  show_weight: false,
  show_statvis: false,
  show_extra_edge_length: false,
  show_extra_face_area: false,
  show_extra_indices: false,
  sculpt_mode_mask_opacity: 0.75,
  show_sculpt_mask: true,
  show_sculpt_face_sets: true,
  sculpt_mode_face_sets_opacity: 1,
  show_paint_wire: false,
  weight_paint_mode_opacity: 1,
  texture_paint_mode_opacity: 1,
  show_annotation: true,
});
