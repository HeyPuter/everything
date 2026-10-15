// 3D View regions and picking: Clipping Region (Alt B), Render Region (Ctrl B / Ctrl Alt B),
// center view on the surface under the mouse (Alt MMB click), axis-aligned view helpers and
// the walk / fly navigation dispatcher.
import { Plane, Vector3 } from 'three';
import { app, registerOperators, type ModalHandler } from '../app/app';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { editModeHooks } from '../editors/view3d/hooks';
import { drawHooks } from '../editors/view3d/draw';
import { renderContext } from '../render/context';
import { renderPostHooks } from '../render/final/result';
import type { RenderSettings } from '../data/types';
import { prefs } from '../app/prefs';
import { h, type VNode } from '../ui/h';
import { surfaceHit } from './view3d';

const v3d = () => !!activeView3D();

function redraw(v: View3D) {
  renderContext?.engine.requestDraw();
  v.drawSvg();
  v.drawUI();
  app.changed('view');
}

// ---------------------------------------------------------------------------
// Region drag (shared by clipping / render region)

const region: { view: View3D | null; mouse: { x: number; y: number } | null; start: { x: number; y: number } | null } = { view: null, mouse: null, start: null };

function dragRegion(v: View3D, label: string, done: (x0: number, y0: number, x1: number, y1: number) => void) {
  const r = () => v.el.getBoundingClientRect();
  const local = (e: { clientX: number; clientY: number }) => ({ x: e.clientX - r().left, y: e.clientY - r().top });
  region.view = v;
  region.start = null;
  region.mouse = { x: app.pointer.x - r().left, y: app.pointer.y - r().top };
  const end = () => {
    region.view = null;
    region.start = null;
    region.mouse = null;
    v.boxEl.hidden = true;
    v.drawSvg();
  };
  const handler: ModalHandler = {
    label,
    header: () => (region.start ? 'Release to set the region' : `${label}: drag a rectangle · Esc to cancel`),
    status: () => [
      ['LMB drag', 'Define Region'],
      ['RMB/Esc', 'Cancel'],
    ],
    onPointerDown(e) {
      if (e.button !== 0) return 'CANCELLED';
      region.start = local(e);
      return undefined;
    },
    onPointerMove(e) {
      region.mouse = local(e);
      if (region.start) v.showBox(region.start.x, region.start.y, region.mouse.x, region.mouse.y, 'box');
      v.drawSvg();
    },
    onPointerUp(e) {
      if (!region.start || e.button !== 0) return undefined;
      const s = region.start,
        p = local(e);
      end();
      if (Math.abs(p.x - s.x) < 3 || Math.abs(p.y - s.y) < 3) return 'CANCELLED';
      done(Math.min(s.x, p.x), Math.min(s.y, p.y), Math.max(s.x, p.x), Math.max(s.y, p.y));
      return 'FINISHED';
    },
    onKey(e) {
      if (e.type === 'keydown' && e.key === 'Escape') return 'CANCELLED';
      return true;
    },
    cancel() {
      end();
    },
  };
  app.startModal(handler);
  v.drawSvg();
}

// crosshair before the drag starts
editModeHooks.svg.push((v) => {
  if (region.view !== v || region.start || !region.mouse) return null;
  const { x, y } = region.mouse;
  return h('g', { class: 'region-cross' }, h('line', { x1: 0, y1: y, x2: v.width, y2: y, stroke: '#fff', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.7 }), h('line', { x1: x, y1: 0, x2: x, y2: v.height, stroke: '#fff', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.7 }));
});

// ---------------------------------------------------------------------------
// Clipping region

/** Planes (inward normals, world space) of the view volume through a screen rectangle. */
export function clipPlanesForRect(v: View3D, x0: number, y0: number, x1: number, y1: number): number[][] {
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(([x, y]) => v.ray(x, y));
  const mid = v.ray((x0 + x1) / 2, (y0 + y1) / 2);
  const inside = mid.origin.clone().addScaledVector(mid.dir, 1);
  const planes: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i],
      b = corners[(i + 1) % 4];
    const p = new Plane().setFromCoplanarPoints(a.origin, a.origin.clone().add(a.dir), b.origin.clone().add(b.dir));
    if (p.distanceToPoint(inside) < 0) p.negate();
    planes.push([p.normal.x, p.normal.y, p.normal.z, p.constant]);
  }
  return planes;
}

drawHooks.passes.push((_pass, view) => {
  const planes = (view as View3D).clipPlanes;
  const r = renderContext?.engine.renderer;
  if (!planes?.length || !r) return;
  r.clippingPlanes = planes.map((p) => new Plane(new Vector3(p[0], p[1], p[2]), p[3]));
  return () => {
    r.clippingPlanes = [];
  };
});

// ---------------------------------------------------------------------------
// Render region (camera view)

type BorderSettings = RenderSettings & { use_border?: boolean; border_min_x?: number; border_min_y?: number; border_max_x?: number; border_max_y?: number };
const renderSettings = () => app.doc.scene.render as BorderSettings;

editModeHooks.svg.push((v) => {
  const r = renderSettings();
  if (!v.cameraView || !r.use_border || !v.overlay.show_overlays) return null;
  const f = v.cameraFrame();
  if (!f) return null;
  const x0 = f.x + (r.border_min_x ?? 0) * f.w,
    x1 = f.x + (r.border_max_x ?? 1) * f.w,
    y0 = f.y + (1 - (r.border_max_y ?? 1)) * f.h,
    y1 = f.y + (1 - (r.border_min_y ?? 0)) * f.h;
  return h('rect', { class: 'render-region', x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: 'none', stroke: '#e0503c', 'stroke-width': 1.2, 'stroke-dasharray': '6 4' });
});

/** Final renders only keep the pixels inside the render region (the rest is transparent). */
renderPostHooks.unshift((res, ctx) => {
  const r = renderSettings();
  if (!ctx.final || !r.use_border) return;
  const W = res.width,
    H = res.height;
  const x0 = Math.floor((r.border_min_x ?? 0) * W),
    x1 = Math.ceil((r.border_max_x ?? 1) * W),
    // passes are stored top-down, the region is measured bottom-up
    y0 = Math.floor((1 - (r.border_max_y ?? 1)) * H),
    y1 = Math.ceil((1 - (r.border_min_y ?? 0)) * H);
  const mask = (buf: Float32Array | undefined, ch: number) => {
    if (!buf) return;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
        buf.fill(0, (y * W + x) * ch, (y * W + x + 1) * ch);
      }
  };
  mask(res.passes.Combined, 4);
  mask(res.passes.Normal, 4);
});

// ---------------------------------------------------------------------------
// operators

registerOperators([
  {
    idname: 'view3d.clip_border',
    label: 'Clipping Region',
    description: 'Hide everything outside a dragged rectangle (the region stays fixed in the scene); run again to clear it',
    poll: v3d,
    invoke: () => {
      const v = activeView3D()!;
      if (v.clipPlanes) {
        v.clipPlanes = null;
        redraw(v);
        return 'FINISHED';
      }
      dragRegion(v, 'Clipping Region', (x0, y0, x1, y1) => {
        v.clipPlanes = clipPlanesForRect(v, x0, y0, x1, y1);
        v.idDirty = true;
        redraw(v);
      });
      return 'RUNNING_MODAL';
    },
    undo: false,
  },
  {
    idname: 'view3d.render_border',
    label: 'Set Render Region',
    description: 'Drag a rectangle in camera view to render only that part of the image',
    poll: () => !!activeView3D()?.cameraView,
    invoke: () => {
      const v = activeView3D()!;
      dragRegion(v, 'Render Region', (x0, y0, x1, y1) => {
        const f = v.cameraFrame();
        if (!f) return;
        const cl = (t: number) => Math.max(0, Math.min(1, t));
        const r = renderSettings();
        r.border_min_x = cl((x0 - f.x) / f.w);
        r.border_max_x = cl((x1 - f.x) / f.w);
        r.border_min_y = cl(1 - (y1 - f.y) / f.h);
        r.border_max_y = cl(1 - (y0 - f.y) / f.h);
        r.use_border = r.border_max_x - r.border_min_x > 1e-4 && r.border_max_y - r.border_min_y > 1e-4;
        app.pushUndo('Set Render Region');
        app.changed('doc');
        redraw(v);
      });
      return 'RUNNING_MODAL';
    },
    undo: false,
  },
  {
    idname: 'view3d.clear_render_border',
    label: 'Clear Render Region',
    description: 'Render the whole camera frame again',
    poll: () => v3d() && !!renderSettings().use_border,
    exec: () => {
      const r = renderSettings();
      r.use_border = false;
      r.border_min_x = r.border_min_y = 0;
      r.border_max_x = r.border_max_y = 1;
    },
  },
  {
    idname: 'view3d.view_center_pick',
    label: 'Center View to Mouse',
    description: 'Center the view on the surface point under the mouse',
    poll: v3d,
    invoke: (ctx) => {
      const v = activeView3D()!;
      const r = v.el.getBoundingClientRect();
      const x = (ctx.event?.x ?? app.pointer.x) - r.left,
        y = (ctx.event?.y ?? app.pointer.y) - r.top;
      const hit = surfaceHit(v, x, y);
      if (!hit) return 'CANCELLED';
      if (v.cameraView && !v.lockCameraToView) v.leaveCamera();
      // keep the viewing direction: move the view so the point becomes its center
      const from = v.nav.pivot.clone();
      const t0 = performance.now();
      const step = () => {
        const t = Math.min(1, (performance.now() - t0) / 180);
        const e = t * t * (3 - 2 * t);
        v.nav.pivot.lerpVectors(from, hit, e);
        v.afterNav();
        if (t < 1) requestAnimationFrame(step);
      };
      step();
      return 'FINISHED';
    },
    undo: false,
  },
  {
    idname: 'view3d.transform_gizmo_set',
    label: 'Transform Gizmo Set',
    description: 'Show the move, rotate or scale handles on the selection whatever tool is active',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'TRANSLATE', items: [['TRANSLATE', 'Move'], ['ROTATE', 'Rotate'], ['SCALE', 'Scale']] },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: v3d,
    exec: (_ctx, p) => {
      const v = activeView3D()!;
      const og = v.objectGizmos;
      const key = ({ TRANSLATE: 'translate', ROTATE: 'rotate', SCALE: 'scale' } as const)[p.type as 'TRANSLATE'] ?? 'translate';
      const only = og[key] && Object.entries(og).every(([k, on]) => k === key || !on);
      if (p.extend) og[key] = !og[key];
      else {
        og.translate = og.rotate = og.scale = false;
        og[key] = !only;
      }
      v.showGizmos = true;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.navigate',
    label: 'View Navigation (Walk/Fly)',
    description: 'Walk or fly through the scene, as chosen in the preferences',
    poll: v3d,
    invoke: () => {
      app.run((prefs as { navigation_mode?: string }).navigation_mode === 'FLY' ? 'view3d.fly' : 'view3d.walk');
      return 'CANCELLED';
    },
    undo: false,
  },
]);

export type { VNode };
