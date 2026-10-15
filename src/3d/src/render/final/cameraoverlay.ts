// Camera view overlays from the camera's Viewport Display settings: safe areas (with the
// 4:3 center-cut), composition guides and the camera name, drawn over the camera frame.
import { h, type VNode } from '../../ui/h';
import { app } from '../../app/app';
import { editModeHooks } from '../../editors/view3d/hooks';
import type { CameraData, SceneData } from '../../data/types';

export const DEFAULT_SAFE_AREAS: NonNullable<SceneData['safe_areas']> = { title: [0.1, 0.05], action: [0.035, 0.035], title_center: [0.175, 0.05], action_center: [0.15, 0.05] };

type Rect = { x: number; y: number; w: number; h: number };
type Seg = [number, number, number, number];

/** A rectangle inset by margins given as fractions of its size (split between both sides). */
export function insetRect(r: Rect, mx: number, my: number): Rect {
  return { x: r.x + (r.w * mx) / 2, y: r.y + (r.h * my) / 2, w: r.w * (1 - mx), h: r.h * (1 - my) };
}

/** The centred 4:3 part of a wider frame (the frame itself when it is not wider). */
export function centerCut(r: Rect): Rect {
  const w = Math.min(r.w, (r.h * 4) / 3);
  return { x: r.x + (r.w - w) / 2, y: r.y, w, h: r.h };
}

/** Foot of the perpendicular from p onto the line a→b. */
function foot(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax,
    dy = by - ay;
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1);
  return [ax + dx * t, ay + dy * t];
}

/** Extend the segment p→q until it leaves the rectangle. */
function toEdge(p: [number, number], q: [number, number], r: Rect): [number, number] {
  const dx = q[0] - p[0],
    dy = q[1] - p[1];
  let t = Infinity;
  if (dx > 1e-9) t = Math.min(t, (r.x + r.w - p[0]) / dx);
  if (dx < -1e-9) t = Math.min(t, (r.x - p[0]) / dx);
  if (dy > 1e-9) t = Math.min(t, (r.y + r.h - p[1]) / dy);
  if (dy < -1e-9) t = Math.min(t, (r.y - p[1]) / dy);
  return Number.isFinite(t) ? [p[0] + dx * t, p[1] + dy * t] : q;
}

/** Line segments of the enabled composition guides inside the frame rectangle. */
export function compositionGuides(ca: Partial<CameraData>, r: Rect): Seg[] {
  const out: Seg[] = [];
  const x0 = r.x,
    y0 = r.y,
    x1 = r.x + r.w,
    y1 = r.y + r.h;
  const vx = (f: number) => out.push([x0 + r.w * f, y0, x0 + r.w * f, y1]);
  const hy = (f: number) => out.push([x0, y0 + r.h * f, x1, y0 + r.h * f]);
  if (ca.show_composition_thirds) [1 / 3, 2 / 3].forEach((f) => (vx(f), hy(f)));
  if (ca.show_composition_center) (vx(0.5), hy(0.5));
  if (ca.show_composition_center_diagonal) out.push([x0, y0, x1, y1], [x0, y1, x1, y0]);
  if (ca.show_composition_golden) {
    const g = 1 / ((1 + Math.sqrt(5)) / 2);
    [1 - g, g].forEach((f) => (vx(f), hy(f)));
  }
  // triangles: one diagonal and lines from the two other corners meeting it at right angles;
  // the harmonious variants continue those lines to the frame edge
  const tri = (diag: Seg, corners: [number, number][], extend: boolean) => {
    out.push(diag);
    for (const [cx, cy] of corners) {
      const f = foot(cx, cy, diag[0], diag[1], diag[2], diag[3]);
      const e = extend ? toEdge([cx, cy], f, r) : f;
      out.push([cx, cy, e[0], e[1]]);
    }
  };
  const diagA: Seg = [x0, y1, x1, y0],
    diagB: Seg = [x0, y0, x1, y1];
  if (ca.show_composition_golden_tria_a) tri(diagA, [[x0, y0], [x1, y1]], false);
  if (ca.show_composition_golden_tria_b) tri(diagB, [[x1, y0], [x0, y1]], false);
  if (ca.show_composition_harmony_tri_a) tri(diagA, [[x0, y0], [x1, y1]], true);
  if (ca.show_composition_harmony_tri_b) tri(diagB, [[x1, y0], [x0, y1]], true);
  return out;
}

const rectEl = (r: Rect, stroke: string, dash = '') => h('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: 'none', stroke, 'stroke-width': 1, 'stroke-dasharray': dash });

editModeHooks.svg.push((v) => {
  if (!v.cameraView || !v.overlay.show_overlays) return null;
  const f = v.cameraFrame();
  const id = v.activeCameraId();
  const ob = id ? app.doc.objects[id] : undefined;
  const ca = ob?.data ? app.doc.cameras[ob.data] : undefined;
  if (!f || !ob || !ca) return null;
  const parts: VNode[] = [];
  const safe = app.doc.scene.safe_areas ?? DEFAULT_SAFE_AREAS;
  if (ca.show_safe_areas) {
    parts.push(rectEl(insetRect(f, safe.action[0], safe.action[1]), 'rgba(255,255,255,0.55)'), rectEl(insetRect(f, safe.title[0], safe.title[1]), 'rgba(255,255,255,0.55)'));
    if (ca.show_safe_center) {
      const c = centerCut(f);
      parts.push(rectEl(insetRect(c, safe.action_center[0], safe.action_center[1]), 'rgba(255,255,255,0.4)', '4 3'), rectEl(insetRect(c, safe.title_center[0], safe.title_center[1]), 'rgba(255,255,255,0.4)', '4 3'));
    }
  }
  const guides = compositionGuides(ca, f);
  if (guides.length) parts.push(h('path', { d: guides.map((s) => `M${s[0]} ${s[1]}L${s[2]} ${s[3]}`).join(''), fill: 'none', stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 1 }));
  if (ca.show_name) parts.push(h('text', { x: f.x + 6, y: f.y - 6, fill: '#e6e6e6', 'font-size': 12, style: { 'paint-order': 'stroke', stroke: 'rgba(0,0,0,0.6)', 'stroke-width': 3 } }, ob.name));
  return parts.length ? h('g', { class: 'camera-guides', 'pointer-events': 'none' }, ...parts) : null;
});
