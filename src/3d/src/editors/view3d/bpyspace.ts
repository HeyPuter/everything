// bpy.context.space_data for 3D viewports (SpaceView3D): lens and clipping, the shading and
// overlay settings, regions, view lock and region_3d (view location / rotation / distance /
// perspective), all live on the viewport.
import { app } from '../../app/app';
import { renderContext } from '../../render/context';
import { spaceDataProviders } from '../../scripting/api';
import { View3D } from './view3d';

type Rec = Record<string, unknown>;

function redraw(v: View3D, sync = false) {
  if (sync) renderContext?.forceSync();
  renderContext?.engine.requestDraw();
  v.drawSvg();
  v.drawUI();
  app.changed('ui', 'view');
}

const toPlain = (x: unknown): unknown => (x && typeof x === 'object' && 'toJs' in (x as object) ? (x as { toJs(): unknown }).toJs() : Array.isArray(x) ? [...x] : x);

/** A struct whose attributes read and write the keys of a settings record. */
function recordStruct(type: string, rec: () => Rec, keys: string[], v: View3D, sync = false) {
  const s: Rec = { __kind: 'struct', __type: type, toString: () => `<bpy_struct, ${type}>` };
  for (const k of keys)
    Object.defineProperty(s, k, {
      enumerable: true,
      get: () => {
        const val = rec()[k];
        return Array.isArray(val) ? [...val] : val;
      },
      set: (x: unknown) => {
        rec()[k] = toPlain(x);
        redraw(v, sync);
      },
    });
  return s;
}

const SHADING_KEYS = ['type', 'light', 'color_type', 'wireframe_color_type', 'single_color', 'background_type', 'background_color', 'show_xray', 'xray_alpha', 'show_xray_wireframe', 'xray_alpha_wireframe', 'show_backface_culling', 'show_specular_highlight', 'show_object_outline', 'object_outline_color', 'use_scene_lights', 'use_scene_world', 'use_scene_lights_render', 'use_scene_world_render', 'studiolight_intensity', 'studiolight_rotate_z', 'studiolight_background_alpha', 'studio_light'];
const OVERLAY_KEYS = ['show_overlays', 'show_floor', 'show_ortho_grid', 'show_axis_x', 'show_axis_y', 'show_axis_z', 'grid_scale', 'grid_subdivisions', 'show_cursor', 'show_annotation', 'show_text', 'show_stats', 'show_extras', 'show_light_colors', 'show_bones', 'show_motion_paths', 'show_relationship_lines', 'show_outline_selected', 'show_object_origins', 'show_object_origins_all', 'show_wireframes', 'wireframe_threshold', 'wireframe_opacity', 'show_face_orientation'];

function region3d(v: View3D) {
  return {
    __kind: 'struct',
    __type: 'RegionView3D',
    get view_location() {
      return v.nav.pivot.toArray();
    },
    set view_location(x: unknown) {
      const a = toPlain(x) as number[];
      v.leaveCamera();
      v.nav.pivot.set(Number(a[0]), Number(a[1]), Number(a[2]));
      v.afterNav();
    },
    get view_distance() {
      return v.nav.distance;
    },
    set view_distance(x: number) {
      v.leaveCamera();
      v.nav.distance = Math.max(1e-4, Number(x));
      v.afterNav();
    },
    /** quaternion (w, x, y, z) */
    get view_rotation() {
      const q = v.nav.rot;
      return [q.w, q.x, q.y, q.z];
    },
    set view_rotation(x: unknown) {
      const a = toPlain(x) as number[];
      v.leaveCamera();
      v.nav.setViewQuat([Number(a[0]), Number(a[1]), Number(a[2]), Number(a[3])]);
      v.nav.view = 'USER';
      v.afterNav();
    },
    get view_perspective() {
      return v.cameraView ? 'CAMERA' : v.nav.ortho ? 'ORTHO' : 'PERSP';
    },
    set view_perspective(x: string) {
      if (x === 'CAMERA') {
        if (!v.cameraView) app.run('view3d.view_camera');
        return;
      }
      v.leaveCamera();
      v.nav.ortho = x === 'ORTHO';
      v.afterNav();
    },
    get is_perspective() {
      return !v.nav.ortho;
    },
    toString: () => '<bpy_struct, RegionView3D>',
  };
}

spaceDataProviders.VIEW_3D = (editor) => {
  if (!(editor instanceof View3D)) return undefined;
  const v = editor;
  return {
    __kind: 'struct',
    __type: 'SpaceView3D',
    type: 'VIEW_3D',
    shading: recordStruct('View3DShading', () => v.shading as unknown as Rec, SHADING_KEYS, v, true),
    overlay: recordStruct('View3DOverlay', () => v.overlay as unknown as Rec, OVERLAY_KEYS, v),
    region_3d: region3d(v),
    get lens() {
      return v.nav.lens;
    },
    set lens(x: number) {
      v.nav.lens = Math.max(1, Number(x));
      redraw(v);
    },
    get clip_start() {
      return v.nav.clipStart;
    },
    set clip_start(x: number) {
      v.nav.clipStart = Math.max(1e-6, Number(x));
      redraw(v);
    },
    get clip_end() {
      return v.nav.clipEnd;
    },
    set clip_end(x: number) {
      v.nav.clipEnd = Math.max(1e-3, Number(x));
      redraw(v);
    },
    get show_gizmo() {
      return v.showGizmos;
    },
    set show_gizmo(x: boolean) {
      v.showGizmos = !!x;
      redraw(v);
    },
    get show_region_toolbar() {
      return v.showToolbar;
    },
    set show_region_toolbar(x: boolean) {
      v.showToolbar = !!x;
      redraw(v);
    },
    get show_region_ui() {
      return v.showSidebar;
    },
    set show_region_ui(x: boolean) {
      v.showSidebar = !!x;
      redraw(v);
    },
    get lock_cursor() {
      return v.lockCursor;
    },
    set lock_cursor(x: boolean) {
      v.lockCursor = !!x;
      redraw(v);
    },
    get lock_camera() {
      return v.lockCameraToView;
    },
    set lock_camera(x: boolean) {
      v.lockCameraToView = !!x;
      redraw(v);
    },
    get lock_object() {
      return v.lockObject ? (app.doc.objects[v.lockObject]?.name ?? null) : null;
    },
    set lock_object(x: unknown) {
      const name = typeof x === 'string' ? x : ((x as { name?: string } | null)?.name ?? null);
      v.lockObject = name ? (Object.values(app.doc.objects).find((o) => o.name === name)?.id ?? null) : null;
      redraw(v);
    },
    toString: () => '<bpy_struct, SpaceView3D>',
  };
};
