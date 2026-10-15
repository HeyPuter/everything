// 3D View operators (navigation, framing, cursor, snapping, local view, copy/paste).
import { Box3, Vector3, Matrix3, Matrix4, Quaternion, Euler } from 'three';
import { orientationBasis } from './orientations';
import { app, registerOperators } from '../app/app';
import { activeView3D, worldBounds, View3D } from '../editors/view3d/view3d';
import { applyMatrixToObject, toMatrix4 } from '../eval/transform';
import { renderContext } from '../render/context';
import { openPie } from '../ui/menu';
import { setActiveTool } from '../editors/view3d/toolbar';
import { relativeAxisView } from '../editors/view3d/navextra';
import { cloneShared } from '../data/cow';
import { uid } from '../data/defaults';
import { uniqueName, activeCollection } from './object';
import type { ObjectData } from '../data/types';

const v3d = () => !!activeView3D();
/** the view may be turned (not one of Quad View's fixed views) */
const v3dTurnable = () => !!activeView3D() && !activeView3D()!.lockRotation;

/** Optional hook used by edit modes to frame the current component selection. */
export const frameHooks: (() => Box3 | null)[] = [];

function redraw(v: View3D) {
  renderContext?.engine.requestDraw();
  v.drawSvg();
  v.drawUI();
  app.changed('view');
}

/** All viewports of the Quad View group of `v` (or just `v`). */
function quadViews(v: View3D): View3D[] {
  if (!v.quad) return [v];
  return v.area.screen.areas.map((a) => a.editor as unknown as View3D).filter((e) => e instanceof View3D && e.quad?.group === v.quad!.group);
}

function selectionBox(): Box3 {
  for (const hk of frameHooks) {
    const b = hk();
    if (b) return b;
  }
  return worldBounds(app.selectedObjects().map((o) => o.id));
}

registerOperators([
  {
    idname: 'view3d.view_all',
    label: 'Frame All',
    description: 'View all objects in scene',
    props: [
      { id: 'center', label: 'Center', type: 'bool', default: false },
      { id: 'use_all_regions', label: 'All Regions', type: 'bool', default: false },
    ],
    poll: v3d,
    exec: (ctx, p) => {
      const v = activeView3D()!;
      if (p.center) ctx.doc.scene.cursor.location = [0, 0, 0];
      const ids = [...app.graph.objects.values()].filter((e) => e.visible).map((e) => e.id);
      const box = worldBounds(ids);
      if (box.isEmpty()) box.set(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
      for (const view of p.use_all_regions ? quadViews(v) : [v]) {
        view.frameBox(box);
        redraw(view);
      }
    },
    undo: false,
  },
  {
    idname: 'view3d.view_selected',
    label: 'Frame Selected',
    description: 'Move the view to the selection center',
    props: [{ id: 'use_all_regions', label: 'All Regions', type: 'bool', default: false }],
    poll: v3d,
    exec: (_ctx, p) => {
      const v = activeView3D()!;
      const box = selectionBox();
      if (box.isEmpty()) return 'CANCELLED';
      for (const view of p.use_all_regions ? quadViews(v) : [v]) {
        view.frameBox(box);
        redraw(view);
      }
    },
    undo: false,
  },
  {
    idname: 'view3d.view_axis',
    label: 'View Axis',
    props: [{ id: 'type', label: 'View', type: 'enum', default: 'FRONT', items: [['LEFT', 'Left'], ['RIGHT', 'Right'], ['BOTTOM', 'Bottom'], ['TOP', 'Top'], ['FRONT', 'Front'], ['BACK', 'Back']] }, { id: 'align_active', label: 'Align Active', type: 'bool', default: false }, { id: 'relative', label: 'Relative', type: 'bool', default: false }],
    poll: v3dTurnable,
    exec: (_ctx, p) => {
      const v = activeView3D()!;
      v.leaveCamera();
      if (p.relative) {
        relativeAxisView(v, p.type as string);
        redraw(v);
        return;
      }
      v.nav.setAxisView(p.type as 'FRONT');
      if (p.align_active && app.activeObject) {
        const q = new Quaternion();
        app.graph.get(app.activeObject.id)!.world.decompose(new Vector3(), q, new Vector3());
        v.nav.rot.premultiply(q);
      }
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_persportho',
    label: 'View Perspective/Orthographic',
    poll: v3d,
    exec: () => {
      const v = activeView3D()!;
      v.nav.ortho = !v.nav.ortho;
      v.nav.wasAutoOrtho = false;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_orbit',
    label: 'View Orbit',
    props: [{ id: 'type', label: 'Orbit', type: 'enum', default: 'ORBITLEFT', items: [['ORBITLEFT', 'Orbit Left'], ['ORBITRIGHT', 'Orbit Right'], ['ORBITUP', 'Orbit Up'], ['ORBITDOWN', 'Orbit Down'], ['ORBITOPPOSITE', 'Orbit Opposite']] }, { id: 'angle', label: 'Roll', type: 'float', default: (15 * Math.PI) / 180, subtype: 'angle' }],
    poll: v3dTurnable,
    exec: (_ctx, p) => {
      const v = activeView3D()!;
      v.leaveCamera();
      const a = p.angle as number;
      const wasAxis = v.nav.view !== 'USER';
      const keepOrtho = v.nav.ortho;
      if (p.type === 'ORBITLEFT') v.nav.step('yaw', -a);
      else if (p.type === 'ORBITRIGHT') v.nav.step('yaw', a);
      else if (p.type === 'ORBITUP') v.nav.step('pitch', -a);
      else if (p.type === 'ORBITDOWN') v.nav.step('pitch', a);
      else if (p.type === 'ORBITOPPOSITE') v.nav.step('yaw', Math.PI);
      if (wasAxis && p.type === 'ORBITOPPOSITE') v.nav.ortho = keepOrtho;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_roll',
    label: 'View Roll',
    props: [{ id: 'angle', label: 'Roll', type: 'float', default: (15 * Math.PI) / 180, subtype: 'angle' }],
    poll: v3dTurnable,
    exec: (_ctx, p) => {
      const v = activeView3D()!;
      v.nav.roll(p.angle as number);
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_pan',
    label: 'Pan View Direction',
    props: [{ id: 'type', label: 'Pan', type: 'enum', default: 'PANLEFT', items: [['PANLEFT', 'Pan Left'], ['PANRIGHT', 'Pan Right'], ['PANUP', 'Pan Up'], ['PANDOWN', 'Pan Down']] }],
    poll: v3d,
    exec: (_ctx, p) => {
      const v = activeView3D()!;
      const d = 40;
      if (p.type === 'PANLEFT') v.nav.pan(d, 0);
      if (p.type === 'PANRIGHT') v.nav.pan(-d, 0);
      if (p.type === 'PANUP') v.nav.pan(0, d);
      if (p.type === 'PANDOWN') v.nav.pan(0, -d);
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.zoom',
    label: 'Zoom View',
    props: [{ id: 'delta', label: 'Delta', type: 'int', default: 1 }],
    poll: v3d,
    exec: (_ctx, p) => {
      const v = activeView3D()!;
      if (v.cameraView && !v.lockCameraToView) {
        v.zoomCameraFrame((p.delta as number) > 0 ? 1.2 : 1 / 1.2);
        return;
      }
      v.nav.zoom((p.delta as number) > 0 ? 1 / 1.2 : 1.2);
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_camera',
    label: 'View Camera',
    description: 'Toggle the camera view',
    poll: v3d,
    exec: (ctx) => {
      const v = activeView3D()!;
      if (!ctx.doc.scene.camera) {
        // like the reference: use the first camera object if none is active
        const cam = Object.values(ctx.doc.objects).find((o) => o.type === 'CAMERA');
        if (!cam) {
          app.report('WARNING', 'No active camera found');
          return 'CANCELLED';
        }
        ctx.doc.scene.camera = cam.id;
      }
      if (v.cameraView) v.leaveCamera();
      else v.cameraView = true;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.object_as_camera',
    label: 'Set Active Object as Camera',
    poll: () => v3d() && app.activeObject?.type === 'CAMERA',
    exec: (ctx) => {
      const v = activeView3D()!;
      ctx.doc.scene.camera = app.activeObject!.id;
      v.cameraView = true;
      redraw(v);
    },
  },
  {
    idname: 'view3d.camera_to_view',
    label: 'Align Camera to View',
    description: 'Set camera view to active view',
    poll: (ctx) => v3d() && !!ctx.doc.scene.camera,
    exec: (ctx) => {
      const v = activeView3D()!;
      const cam = ctx.doc.objects[ctx.doc.scene.camera!];
      v.nav.update();
      const world = new Matrix4().compose(v.nav.eye, v.nav.rot, new Vector3(1, 1, 1));
      const parentInv = cam.parent ? app.graph.get(cam.parent)!.world.clone().multiply(toMatrix4(cam.matrix_parent_inverse)).invert() : new Matrix4();
      applyMatrixToObject(cam, parentInv.multiply(world));
      v.cameraView = true;
      redraw(v);
    },
  },
  {
    idname: 'view3d.camera_to_view_selected',
    label: 'Camera Fit Frame to Selected',
    poll: (ctx) => v3d() && !!ctx.doc.scene.camera && app.selectedObjects().length > 0,
    exec: (ctx) => {
      const cam = ctx.doc.objects[ctx.doc.scene.camera!];
      const ca = ctx.doc.cameras[cam.data!];
      const box = worldBounds(app.selectedObjects().filter((o) => o.id !== cam.id).map((o) => o.id));
      if (box.isEmpty()) return 'CANCELLED';
      const c = box.getCenter(new Vector3()),
        r = box.getSize(new Vector3()).length() / 2;
      const q = new Quaternion();
      app.graph.get(cam.id)!.world.decompose(new Vector3(), q, new Vector3());
      const fov = 2 * Math.atan(ca.sensor_width / 2 / ca.lens);
      const dist = r / Math.sin(fov / 2);
      const pos = c.clone().add(new Vector3(0, 0, 1).applyQuaternion(q).multiplyScalar(dist));
      const parentInv = cam.parent ? app.graph.get(cam.parent)!.world.clone().multiply(toMatrix4(cam.matrix_parent_inverse)).invert() : new Matrix4();
      applyMatrixToObject(cam, parentInv.multiply(new Matrix4().compose(pos, q, new Vector3(1, 1, 1))));
    },
  },
  {
    idname: 'view3d.toggle_lock_camera',
    label: 'Lock Camera to View',
    poll: v3d,
    exec: () => {
      const v = activeView3D()!;
      v.lockCameraToView = !v.lockCameraToView;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.localview',
    label: 'Local View',
    description: 'Toggle display of selected object(s) separately and centered in view',
    poll: v3d,
    exec: () => {
      const v = activeView3D()!;
      if (v.localView) {
        v.localView = null;
        if (v.localViewSaved) v.nav.load(v.localViewSaved);
      } else {
        const sel = app.selectedObjects();
        if (!sel.length) return 'CANCELLED';
        v.localViewSaved = v.nav.serialize();
        v.localView = new Set(sel.map((o) => o.id));
        v.frameBox(worldBounds([...v.localView]));
      }
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.toggle_toolbar',
    label: 'Toolbar',
    poll: v3d,
    exec: () => {
      const v = activeView3D()!;
      v.showToolbar = !v.showToolbar;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.toggle_sidebar',
    label: 'Sidebar',
    poll: v3d,
    exec: () => {
      const v = activeView3D()!;
      v.showSidebar = !v.showSidebar;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.toggle_tool_header',
    label: 'Tool Settings',
    poll: v3d,
    exec: () => {
      const v = activeView3D()!;
      v.showToolHeader = !v.showToolHeader;
      v.area.drawHeader();
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.toggle_xray',
    label: 'Toggle X-Ray',
    poll: v3d,
    exec: () => {
      const v = activeView3D()!;
      if (v.shading.type === 'WIREFRAME') v.shading.show_xray_wireframe = !v.shading.show_xray_wireframe;
      else v.shading.show_xray = !v.shading.show_xray;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.toggle_shading',
    label: 'Toggle Shading Type',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'WIREFRAME', items: [['WIREFRAME', 'Wireframe'], ['SOLID', 'Solid'], ['MATERIAL', 'Material Preview'], ['RENDERED', 'Rendered']] }],
    poll: v3d,
    exec: (_ctx, p) => {
      const v = activeView3D()!;
      // toggling the current mode returns to solid
      v.shading.type = v.shading.type === p.type && p.type !== 'SOLID' ? 'SOLID' : (p.type as 'SOLID');
      renderContext?.forceSync();
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.toggle_overlays',
    label: 'Toggle Overlays',
    poll: v3d,
    exec: () => {
      const v = activeView3D()!;
      v.overlay.show_overlays = !v.overlay.show_overlays;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.pie_shading',
    label: 'Shading Pie',
    internal: true,
    poll: v3d,
    invoke: () => {
      const v = activeView3D()!;
      const s = v.shading.type;
      openPie('Shading', [
        { label: 'Wireframe', icon: 'shading_wire', active: s === 'WIREFRAME', op: 'view3d.toggle_shading', props: { type: 'WIREFRAME' } },
        { label: 'Solid', icon: 'shading_solid', active: s === 'SOLID', op: 'view3d.toggle_shading', props: { type: 'SOLID' } },
        { label: 'Material Preview', icon: 'shading_texture', active: s === 'MATERIAL', op: 'view3d.toggle_shading', props: { type: 'MATERIAL' } },
        { label: 'Rendered', icon: 'shading_rendered', active: s === 'RENDERED', op: 'view3d.toggle_shading', props: { type: 'RENDERED' } },
        { label: 'Toggle X-Ray', icon: 'xray', active: v.shading.type === 'WIREFRAME' ? v.shading.show_xray_wireframe : v.shading.show_xray, op: 'view3d.toggle_xray' },
        { label: 'Overlays', icon: 'overlay', active: v.overlay.show_overlays, op: 'view3d.toggle_overlays' },
        null,
        null,
      ], app.pointer.x, app.pointer.y, 'KeyZ');
      return 'CANCELLED';
    },
    undo: false,
  },
  {
    idname: 'view3d.pie_view',
    label: 'View Pie',
    internal: true,
    poll: v3d,
    invoke: () => {
      openPie('View', [
        { label: 'Left', op: 'view3d.view_axis', props: { type: 'LEFT' } },
        { label: 'Right', op: 'view3d.view_axis', props: { type: 'RIGHT' } },
        { label: 'Bottom', op: 'view3d.view_axis', props: { type: 'BOTTOM' } },
        { label: 'Top', op: 'view3d.view_axis', props: { type: 'TOP' } },
        { label: 'Front', op: 'view3d.view_axis', props: { type: 'FRONT' } },
        { label: 'Back', op: 'view3d.view_axis', props: { type: 'BACK' } },
        { label: 'View Camera', icon: 'view_camera', op: 'view3d.view_camera' },
        { label: 'View Selected', icon: 'view_zoom', op: 'view3d.view_selected' },
      ], app.pointer.x, app.pointer.y, 'Backquote');
      return 'CANCELLED';
    },
    undo: false,
  },
  {
    idname: 'view3d.pie_pivot',
    label: 'Pivot Point Pie',
    internal: true,
    poll: v3d,
    invoke: (ctx) => {
      const ts = ctx.doc.scene.tool_settings;
      const set = (v: string) => () => {
        ts.transform_pivot_point = v as typeof ts.transform_pivot_point;
        app.pushUndo('Pivot Point');
        app.changed('ui');
      };
      const onlyLoc = !!(ts as { use_transform_pivot_point_align?: boolean }).use_transform_pivot_point_align;
      openPie('Pivot Point', [
        { label: 'Bounding Box Center', icon: 'pivot_boundbox', active: ts.transform_pivot_point === 'BOUNDING_BOX_CENTER', action: set('BOUNDING_BOX_CENTER') },
        { label: '3D Cursor', icon: 'pivot_cursor', active: ts.transform_pivot_point === 'CURSOR', action: set('CURSOR') },
        { label: 'Individual Origins', icon: 'pivot_individual', active: ts.transform_pivot_point === 'INDIVIDUAL_ORIGINS', action: set('INDIVIDUAL_ORIGINS') },
        { label: 'Median Point', icon: 'pivot_median', active: ts.transform_pivot_point === 'MEDIAN_POINT', action: set('MEDIAN_POINT') },
        { label: 'Active Element', icon: 'pivot_active', active: ts.transform_pivot_point === 'ACTIVE_ELEMENT', action: set('ACTIVE_ELEMENT') },
        ctx.doc.mode === 'OBJECT'
          ? {
              label: 'Only Locations',
              active: onlyLoc,
              action: () => {
                (ts as { use_transform_pivot_point_align?: boolean }).use_transform_pivot_point_align = !onlyLoc;
                app.pushUndo('Only Locations');
                app.changed('ui');
              },
            }
          : null,
        null,
        null,
      ], app.pointer.x, app.pointer.y, 'Period');
      return 'CANCELLED';
    },
    undo: false,
  },
  {
    idname: 'view3d.pie_snap',
    label: 'Snap Pie',
    internal: true,
    poll: v3d,
    invoke: () => {
      openPie('Snap', [
        { label: 'Cursor to Grid', op: 'view3d.snap_cursor_to_grid' },
        { label: 'Selection to Grid', op: 'view3d.snap_selected_to_grid' },
        { label: 'Cursor to Selected', op: 'view3d.snap_cursor_to_selected' },
        { label: 'Selection to Cursor', op: 'view3d.snap_selected_to_cursor', props: { use_offset: false } },
        { label: 'Selection to Cursor (Keep Offset)', op: 'view3d.snap_selected_to_cursor', props: { use_offset: true } },
        { label: 'Selection to Active', op: 'view3d.snap_selected_to_active' },
        { label: 'Cursor to World Origin', op: 'view3d.snap_cursor_to_center' },
        { label: 'Cursor to Active', op: 'view3d.snap_cursor_to_active' },
      ], app.pointer.x, app.pointer.y, 'KeyS');
      return 'CANCELLED';
    },
    undo: false,
  },
  {
    idname: 'view3d.cursor3d',
    label: 'Set 3D Cursor',
    description: 'Set the location of the 3D cursor (on surfaces under the mouse, or on the view plane)',
    props: [
      { id: 'use_depth', label: 'Surface Project', type: 'bool', default: true },
      { id: 'orientation', label: 'Orientation', type: 'enum', default: 'VIEW', items: [['NONE', 'None'], ['VIEW', 'View'], ['TRANSFORM', 'Transform'], ['GEOMETRY', 'Geometry']] },
    ],
    poll: v3d,
    invoke: (ctx, p) => {
      const v = activeView3D()!;
      const r = v.el.getBoundingClientRect();
      placeCursor(v, (ctx.event?.x ?? app.pointer.x) - r.left, (ctx.event?.y ?? app.pointer.y) - r.top, p as CursorOptions);
      return 'FINISHED';
    },
  },
  {
    idname: 'view3d.snap_cursor_to_center',
    label: 'Snap Cursor to World Origin',
    exec: (ctx) => {
      ctx.doc.scene.cursor.location = [0, 0, 0];
      ctx.doc.scene.cursor.rotation_euler = [0, 0, 0];
    },
  },
  {
    idname: 'view3d.snap_cursor_to_grid',
    label: 'Snap Cursor to Grid',
    exec: (ctx) => {
      ctx.doc.scene.cursor.location = ctx.doc.scene.cursor.location.map((v) => Math.round(v)) as [number, number, number];
    },
  },
  {
    idname: 'view3d.snap_cursor_to_selected',
    label: 'Snap Cursor to Selected',
    exec: (ctx) => {
      const b = selectionBox();
      if (b.isEmpty()) return 'CANCELLED';
      const c = selectionMedian() ?? b.getCenter(new Vector3());
      ctx.doc.scene.cursor.location = [c.x, c.y, c.z];
    },
  },
  {
    idname: 'view3d.snap_cursor_to_active',
    label: 'Snap Cursor to Active',
    poll: () => !!app.activeObject,
    exec: (ctx) => {
      const p = new Vector3().setFromMatrixPosition(app.graph.get(app.activeObject!.id)!.world);
      ctx.doc.scene.cursor.location = [p.x, p.y, p.z];
    },
  },
  {
    idname: 'view3d.snap_selected_to_cursor',
    label: 'Snap Selection to Cursor',
    props: [{ id: 'use_offset', label: 'Offset', type: 'bool', default: false }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (ctx, p) => {
      const cur = new Vector3(...ctx.doc.scene.cursor.location);
      const sel = app.selectedObjects();
      const center = selectionMedian() ?? new Vector3();
      for (const ob of sel) {
        const w = app.graph.get(ob.id)!.world.clone();
        const pos = new Vector3().setFromMatrixPosition(w);
        const target = p.use_offset ? cur.clone().add(pos.clone().sub(center)) : cur;
        w.setPosition(target);
        setWorld(ob, w);
      }
    },
  },
  {
    idname: 'view3d.snap_selected_to_grid',
    label: 'Snap Selection to Grid',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: () => {
      for (const ob of app.selectedObjects()) {
        const w = app.graph.get(ob.id)!.world.clone();
        const pos = new Vector3().setFromMatrixPosition(w);
        w.setPosition(Math.round(pos.x), Math.round(pos.y), Math.round(pos.z));
        setWorld(ob, w);
      }
    },
  },
  {
    idname: 'view3d.snap_selected_to_active',
    label: 'Snap Selection to Active',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!app.activeObject && app.selectedObjects().length > 1,
    exec: () => {
      const target = new Vector3().setFromMatrixPosition(app.graph.get(app.activeObject!.id)!.world);
      for (const ob of app.selectedObjects()) {
        if (ob.id === app.activeObject!.id) continue;
        const w = app.graph.get(ob.id)!.world.clone();
        w.setPosition(target);
        setWorld(ob, w);
      }
    },
  },
  {
    idname: 'view3d.select_box_tool',
    label: 'Box Select',
    poll: v3d,
    exec: () => {
      setActiveTool('builtin.select_box');
    },
    undo: false,
  },
  {
    idname: 'view3d.select_circle_tool',
    label: 'Circle Select',
    poll: v3d,
    exec: () => {
      setActiveTool('builtin.select_circle');
    },
    undo: false,
  },
  {
    idname: 'view3d.copybuffer',
    label: 'Copy Objects',
    description: 'Copy the selected objects to the internal clipboard',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (ctx) => {
      const sel = app.selectedObjects();
      const data: Record<string, unknown> = {};
      for (const ob of sel) {
        if (!ob.data) continue;
        for (const t of ['meshes', 'curves', 'lights', 'cameras', 'armatures', 'lattices'] as const) if ((ctx.doc[t] as Record<string, unknown>)[ob.data]) data[ob.data] = { table: t, value: cloneShared((ctx.doc[t] as Record<string, unknown>)[ob.data]) };
      }
      clipboard = { objects: sel.map((o) => ({ ob: cloneShared(o), world: app.graph.get(o.id)!.world.toArray() })), data };
      app.report('INFO', `Copied ${sel.length} selected object(s)`);
    },
    undo: false,
  },
  {
    idname: 'view3d.pastebuffer',
    label: 'Paste Objects',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!clipboard,
    exec: (ctx) => {
      const doc = ctx.doc;
      const dataMap = new Map<string, string>();
      for (const o of Object.values(doc.objects)) o.select = false;
      for (const [oldId, entry] of Object.entries(clipboard!.data) as [string, { table: string; value: { id: string; name: string } }][]) {
        const v = cloneShared(entry.value);
        v.id = uid('da');
        (doc as unknown as Record<string, Record<string, unknown>>)[entry.table][v.id] = v;
        dataMap.set(oldId, v.id);
      }
      for (const { ob, world } of clipboard!.objects) {
        const c = cloneShared(ob) as ObjectData;
        c.id = uid('ob');
        c.name = uniqueName(doc, c.name);
        c.parent = null;
        c.data = c.data ? dataMap.get(c.data) ?? c.data : null;
        c.select = true;
        applyMatrixToObject(c, new Matrix4().fromArray(world));
        doc.objects[c.id] = c;
        doc.object_order.push(c.id);
        doc.collections[activeCollection(doc)].objects.push(c.id);
        doc.scene.active_object = c.id;
      }
      app.report('INFO', `${clipboard!.objects.length} object(s) pasted`);
    },
  },
]);

let clipboard: { objects: { ob: ObjectData; world: number[] }[]; data: Record<string, unknown> } | null = null;

function setWorld(ob: ObjectData, w: Matrix4) {
  const parentInv = ob.parent ? app.graph.get(ob.parent)!.world.clone().multiply(toMatrix4(ob.matrix_parent_inverse)).invert() : new Matrix4();
  applyMatrixToObject(ob, parentInv.multiply(w));
}

/** Median point of the current selection (objects, or components via hooks) */
export const medianHooks: (() => Vector3 | null)[] = [];
function selectionMedian(): Vector3 | null {
  for (const hk of medianHooks) {
    const m = hk();
    if (m) return m;
  }
  const sel = app.selectedObjects();
  if (!sel.length) return null;
  const c = new Vector3();
  for (const o of sel) c.add(new Vector3().setFromMatrixPosition(app.graph.get(o.id)!.world));
  return c.multiplyScalar(1 / sel.length);
}

/** Ray-cast visible meshes under a viewport pixel (world space). */
export function surfaceHit(v: View3D, x: number, y: number): Vector3 | null {
  const hit = v.pick(x, y, 1);
  const ev = hit ? app.graph.get(hit.id) : undefined;
  if (!ev?.mesh) return null;
  const { origin, dir } = v.ray(x, y);
  const inv = ev.world.clone().invert();
  const o = origin.clone().applyMatrix4(inv),
    d = dir.clone().transformDirection(inv);
  const P = ev.mesh.positions;
  let best = Infinity;
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  const e1 = new Vector3(),
    e2 = new Vector3(),
    pv = new Vector3(),
    tv = new Vector3(),
    qv = new Vector3();
  const m = ev.mesh;
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    for (let k = s + 1; k < e - 1; k++) {
      a.fromArray(P, m.indices[s] * 3);
      b.fromArray(P, m.indices[k] * 3);
      c.fromArray(P, m.indices[k + 1] * 3);
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      pv.crossVectors(d, e2);
      const det = e1.dot(pv);
      if (Math.abs(det) < 1e-12) continue;
      const id = 1 / det;
      tv.subVectors(o, a);
      const u = tv.dot(pv) * id;
      if (u < 0 || u > 1) continue;
      qv.crossVectors(tv, e1);
      const vv = d.dot(qv) * id;
      if (vv < 0 || u + vv > 1) continue;
      const t = e2.dot(qv) * id;
      if (t > 1e-6 && t < best) best = t;
    }
  }
  if (best === Infinity) return null;
  return o.addScaledVector(d, best).applyMatrix4(ev.world);
}

export interface CursorOptions {
  use_depth?: boolean;
  orientation?: 'NONE' | 'VIEW' | 'TRANSFORM' | 'GEOMETRY';
}

/** Cursor tool settings (also used by Shift+right click). */
export const cursorToolSettings: Required<CursorOptions> = { use_depth: true, orientation: 'VIEW' };

/** Place the 3D cursor under a viewport pixel: on the surface (optionally) and oriented as asked. */
export function placeCursor(v: View3D, x: number, y: number, o: CursorOptions = cursorToolSettings) {
  const cursor = app.doc.scene.cursor;
  const cur = new Vector3(...cursor.location);
  const hit = o.use_depth !== false ? surfaceHitWithNormal(v, x, y) : null;
  const p = hit?.point ?? v.unproject(x, y, cur);
  cursor.location = [p.x, p.y, p.z];
  let q: Quaternion | null = null;
  if (o.orientation === 'VIEW') q = v.camera.quaternion.clone();
  else if (o.orientation === 'TRANSFORM') {
    const b = orientationBasis();
    q = new Quaternion().setFromRotationMatrix(new Matrix4().setFromMatrix3(b));
  } else if (o.orientation === 'GEOMETRY' && hit) {
    // Z along the surface normal, X kept as level as possible
    const z = hit.normal.clone().normalize();
    const x0 = Math.abs(z.z) < 0.99 ? new Vector3(0, 0, 1).cross(z).normalize() : new Vector3(1, 0, 0);
    const y0 = new Vector3().crossVectors(z, x0);
    q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x0, y0, z));
  }
  if (q) {
    const e = new Euler().setFromQuaternion(q, 'ZYX');
    cursor.rotation_euler = [e.x, e.y, e.z];
  }
  app.changed('doc');
}

/** Like surfaceHit, also returning the world-space normal of the face that was hit. */
export function surfaceHitWithNormal(v: View3D, x: number, y: number): { point: Vector3; normal: Vector3 } | null {
  const hit = v.pick(x, y, 1);
  const ev = hit ? app.graph.get(hit.id) : undefined;
  if (!ev?.mesh) return null;
  const { origin, dir } = v.ray(x, y);
  const inv = ev.world.clone().invert();
  const o = origin.clone().applyMatrix4(inv),
    d = dir.clone().transformDirection(inv);
  const P = ev.mesh.positions;
  const m = ev.mesh;
  let best = Infinity;
  const n = new Vector3();
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3(),
    e1 = new Vector3(),
    e2 = new Vector3(),
    pv = new Vector3(),
    tv = new Vector3(),
    qv = new Vector3();
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      en = m.offsets[f + 1];
    for (let k = s + 1; k < en - 1; k++) {
      a.fromArray(P, m.indices[s] * 3);
      b.fromArray(P, m.indices[k] * 3);
      c.fromArray(P, m.indices[k + 1] * 3);
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      pv.crossVectors(d, e2);
      const det = e1.dot(pv);
      if (Math.abs(det) < 1e-12) continue;
      const id = 1 / det;
      tv.subVectors(o, a);
      const u = tv.dot(pv) * id;
      if (u < 0 || u > 1) continue;
      qv.crossVectors(tv, e1);
      const vv = d.dot(qv) * id;
      if (vv < 0 || u + vv > 1) continue;
      const t = e2.dot(qv) * id;
      if (t > 1e-6 && t < best) {
        best = t;
        n.crossVectors(e1, e2);
      }
    }
  }
  if (best === Infinity) return null;
  const normalWorld = n.applyMatrix3(new Matrix3().getNormalMatrix(ev.world)).normalize();
  if (normalWorld.dot(dir) > 0) normalWorld.negate();
  return { point: o.addScaledVector(d, best).applyMatrix4(ev.world), normal: normalWorld };
}

export { Euler, Box3 };
