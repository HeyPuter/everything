// Tool gizmos (move / rotate / scale / transform) drawn as an SVG overlay.
import { Vector3, Matrix3 } from 'three';
import { h, type VNode } from '../../ui/h';
import { app } from '../../app/app';
import { activeTools } from '../../app/prefs';
import type { View3D } from './view3d';
import { startTransform, transformProviders } from '../../ops/transform';
import { currentOrientation, orientationBasis } from '../../ops/orientations';

const COLORS = ['#ff3352', '#8bdc00', '#2890ff'];

interface GizmoFrame {
  pivot: Vector3;
  basis: Matrix3;
  screen: { x: number; y: number };
  size: number; // world length of axis handles
}

function gizmoFrame(v: View3D): GizmoFrame | null {
  // compute the transform center with the providers (without starting a modal)
  const doc = app.doc;
  let centers: Vector3[] = [];
  if (doc.mode === 'OBJECT') {
    const sel = app.selectedObjects();
    if (!sel.length) return null;
    centers = sel.map((o) => new Vector3().setFromMatrixPosition(app.graph.get(o.id)!.world));
  } else {
    const c = gizmoCenterHook?.();
    if (!c) return null;
    centers = [c.center];
  }
  const basis = orientationBasis(currentOrientation());
  const pp = doc.scene.tool_settings.transform_pivot_point;
  const pivot = new Vector3();
  if (pp === 'CURSOR') pivot.fromArray(doc.scene.cursor.location);
  else {
    for (const c of centers) pivot.add(c);
    pivot.multiplyScalar(1 / centers.length);
  }
  const s = v.project(pivot);
  if (s.z > 1 || s.z < -1) return null;
  const size = v.nav.pixelSize(pivot) * 80 * (75 / 75);
  return { pivot, basis, screen: { x: s.x, y: s.y }, size };
}

/** set by edit-mode modules: center of the current component selection */
export let gizmoCenterHook: (() => { center: Vector3; basis?: Matrix3 } | null) | null = null;
export function setGizmoCenterHook(fn: typeof gizmoCenterHook) {
  gizmoCenterHook = fn;
}

function toolKind(): 'move' | 'rotate' | 'scale' | 'transform' | null {
  const t = activeTools[app.doc.mode];
  if (t === 'builtin.move') return 'move';
  if (t === 'builtin.rotate') return 'rotate';
  if (t === 'builtin.scale') return 'scale';
  if (t === 'builtin.transform') return 'transform';
  return null;
}

/** Which transform handles a viewport shows: the active tool's (Active Tools) plus the Object Gizmos options. */
function gizmoParts(v: View3D) {
  const t = v.showToolGizmo ? toolKind() : null;
  const og = v.objectGizmos;
  return {
    move: t === 'move' || t === 'transform' || og.translate,
    rotate: t === 'rotate' || t === 'transform' || og.rotate,
    scale: t === 'scale' || t === 'transform' || og.scale,
  };
}

export function transformGizmo(v: View3D): VNode | null {
  const show = gizmoParts(v);
  const count = +show.move + +show.rotate + +show.scale;
  if (!count || app.modal) return null;
  const kind = count > 1 ? 'transform' : show.move ? 'move' : show.rotate ? 'rotate' : 'scale';
  const f = gizmoFrame(v);
  if (!f) return null;
  const parts: VNode[] = [];
  const axisEnd = (i: number, k = 1) => {
    const dir = new Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyMatrix3(f.basis).normalize();
    return v.project(f.pivot.clone().addScaledVector(dir, f.size * k));
  };
  const { x, y } = f.screen;
  if (show.move) {
    for (let i = 0; i < 3; i++) {
      const e = axisEnd(i, kind === 'transform' ? 1.15 : 1);
      const dx = e.x - x,
        dy = e.y - y,
        l = Math.hypot(dx, dy);
      if (l < 4) continue;
      const ux = dx / l,
        uy = dy / l;
      parts.push(
        h('line', { x1: x + ux * 14, y1: y + uy * 14, x2: e.x, y2: e.y, stroke: COLORS[i], 'stroke-width': 2.2, 'data-gizmo': `move:${i}`, class: 'gz' }),
        h('path', { d: `M${e.x + ux * 12} ${e.y + uy * 12} L${e.x - uy * 5} ${e.y + ux * 5} L${e.x + uy * 5} ${e.y - ux * 5}Z`, fill: COLORS[i], 'data-gizmo': `move:${i}`, class: 'gz' }),
      );
      // plane handles
      const j = (i + 1) % 3;
      const a = axisEnd(j, 0.28),
        b = axisEnd((i + 2) % 3, 0.28);
      const c = v.project(f.pivot.clone().add(new Vector3(j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0).applyMatrix3(f.basis).multiplyScalar(f.size * 0.28)).add(new Vector3((i + 2) % 3 === 0 ? 1 : 0, (i + 2) % 3 === 1 ? 1 : 0, (i + 2) % 3 === 2 ? 1 : 0).applyMatrix3(f.basis).multiplyScalar(f.size * 0.28)));
      parts.push(h('path', { d: `M${x} ${y}L${a.x} ${a.y}L${c.x} ${c.y}L${b.x} ${b.y}Z`, fill: COLORS[i], 'fill-opacity': 0.35, stroke: COLORS[i], 'stroke-width': 1, 'data-gizmo': `plane:${i}`, class: 'gz plane' }));
    }
    parts.push(h('circle', { cx: x, cy: y, r: 10, fill: 'transparent', stroke: '#fff', 'stroke-width': 1.4, 'data-gizmo': 'view', class: 'gz' }));
  }
  if (show.scale) {
    for (let i = 0; i < 3; i++) {
      const e = axisEnd(i, kind === 'transform' ? 0.7 : 1);
      const dx = e.x - x,
        dy = e.y - y,
        l = Math.hypot(dx, dy);
      if (l < 4) continue;
      const ux = dx / l,
        uy = dy / l;
      if (kind === 'scale') parts.push(h('line', { x1: x + ux * 14, y1: y + uy * 14, x2: e.x, y2: e.y, stroke: COLORS[i], 'stroke-width': 2.2, 'data-gizmo': `scale:${i}`, class: 'gz' }));
      parts.push(h('rect', { x: e.x - 5, y: e.y - 5, width: 10, height: 10, fill: COLORS[i], 'data-gizmo': `scale:${i}`, class: 'gz' }));
    }
    if (kind === 'scale') parts.push(h('circle', { cx: x, cy: y, r: 30, fill: 'none', stroke: '#fff', 'stroke-width': 1.2, 'data-gizmo': 'scale:all', class: 'gz', opacity: 0.8 }));
  }
  if (show.rotate) {
    // rotation rings: project circles around each axis
    for (let i = 0; i < 3; i++) {
      const pts: string[] = [];
      const n = new Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyMatrix3(f.basis);
      const u = new Vector3(i === 1 ? 1 : 0, i === 2 ? 1 : 0, i === 0 ? 1 : 0).applyMatrix3(f.basis);
      const w = new Vector3().crossVectors(n, u);
      const viewDir = new Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion);
      for (let k = 0; k <= 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        const p = f.pivot.clone().addScaledVector(u, Math.cos(a) * f.size).addScaledVector(w, Math.sin(a) * f.size);
        // hide the back half (towards the viewer's far side)
        const facing = p.clone().sub(f.pivot).dot(viewDir) > f.size * 0.05;
        const s = v.project(p);
        pts.push(`${facing ? 'M' : k === 0 ? 'M' : 'L'}${s.x.toFixed(1)} ${s.y.toFixed(1)}`);
      }
      parts.push(h('path', { d: pts.join(''), fill: 'none', stroke: COLORS[i], 'stroke-width': 2.2, 'data-gizmo': `rotate:${i}`, class: 'gz' }));
    }
    const R = (f.size / v.nav.pixelSize(f.pivot)) * 1.2;
    parts.push(h('circle', { cx: x, cy: y, r: R, fill: 'none', stroke: '#fff', 'stroke-width': 1.4, 'data-gizmo': 'rotate:view', class: 'gz' }));
    parts.push(h('circle', { cx: x, cy: y, r: R * 0.83, fill: 'transparent', stroke: 'rgba(255,255,255,0.15)', 'stroke-width': 1, 'data-gizmo': 'trackball', class: 'gz' }));
  }
  return h('g', { class: 'transform-gizmo' }, parts);
}

export function gizmoPointerDown(v: View3D, e: PointerEvent): boolean {
  const t = e.target as Element;
  const g = t.closest?.('[data-gizmo]') as SVGElement | null;
  if (!g) return false;
  const id = g.getAttribute('data-gizmo')!;
  const [kind, axis] = id.split(':');
  e.preventDefault();
  e.stopPropagation();
  const i = Number(axis);
  const constraint = Number.isInteger(i) ? (kind === 'plane' ? [0, 1, 2].map((k) => k !== i) : [0, 1, 2].map((k) => k === i)) : undefined;
  const ev = { x: e.clientX, y: e.clientY };
  const mode = kind === 'move' || kind === 'plane' || kind === 'view' ? 'TRANSLATION' : kind === 'scale' ? 'RESIZE' : kind === 'trackball' ? 'TRACKBALL' : 'ROTATION';
  if (startTransform(mode, { constraint, event: ev, release_confirm: true, orient: currentOrientation() })) {
    const up = (pe: PointerEvent) => {
      removeEventListener('pointerup', up, true);
      if (app.modal) app.endModal('FINISHED');
      void pe;
    };
    addEventListener('pointerup', up, true);
  }
  void transformProviders;
  return true;
}
