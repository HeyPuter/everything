// Tool gizmos (move / rotate / scale / transform) drawn as an SVG overlay.
import { Vector3, Matrix3 } from 'three';
import { h, type VNode } from '../../ui/h';
import { app } from '../../app/app';
import { activeTools, prefs } from '../../app/prefs';
import type { View3D } from './view3d';
import { startTransform, transformProviders } from '../../ops/transform';
import { currentOrientation, orientationBasis, customOrientations, BUILTIN_ORIENTATIONS } from '../../ops/orientations';
import { gizmoOrientationSlot, type GizmoKind } from './transformtool';

/** Orientation a gizmo uses: its own slot, or the header orientation for "Default". */
export function gizmoOrientation(kind: GizmoKind): string {
  const slot = gizmoOrientationSlot(kind);
  if (slot !== 'DEFAULT' && (BUILTIN_ORIENTATIONS.some((b) => b[0] === slot) || customOrientations().some((c) => c.name === slot))) return slot;
  return currentOrientation();
}

const COLORS = ['#fc364b', '#84e003', '#398efc'];

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
  const size = v.nav.pixelSize(pivot) * 80 * (prefs.gizmo_size / 75);
  return { pivot, basis, screen: { x: s.x, y: s.y }, size };
}

/** set by edit-mode modules: center of the current component selection */
export let gizmoCenterHook: (() => { center: Vector3; basis?: Matrix3 } | null) | null = null;
export function setGizmoCenterHook(fn: typeof gizmoCenterHook) {
  gizmoCenterHook = fn;
}

function toolKind(): 'move' | 'rotate' | 'scale' | 'transform' | null {
  const t = activeTools[app.doc.mode];
  if (t === 'builtin.scale_cage') return null;
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
  if (v.showToolGizmo && activeTools[app.doc.mode] === 'builtin.scale_cage' && !app.modal) return scaleCage(v);
  const show = gizmoParts(v);
  const count = +show.move + +show.rotate + +show.scale;
  if (!count || app.modal) return null;
  const kind = count > 1 ? 'transform' : show.move ? 'move' : show.rotate ? 'rotate' : 'scale';
  const f = gizmoFrame(v);
  if (!f) return null;
  const parts: VNode[] = [];
  let basis = f.basis;
  const axisEnd = (i: number, k = 1) => {
    const dir = new Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyMatrix3(basis).normalize();
    return v.project(f.pivot.clone().addScaledVector(dir, f.size * k));
  };
  const { x, y } = f.screen;
  if (show.move) {
    basis = orientationBasis(gizmoOrientation('move'));
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
      // plane handles: small squares away from the centre, in the plane of the other two axes
      const ua = new Vector3(...[0, 1, 2].map((k) => (k === (i + 1) % 3 ? 1 : 0))).applyMatrix3(basis).normalize(),
        va = new Vector3(...[0, 1, 2].map((k) => (k === (i + 2) % 3 ? 1 : 0))).applyMatrix3(basis).normalize();
      const corner = (du: number, dv: number) => v.project(f.pivot.clone().addScaledVector(ua, f.size * du).addScaledVector(va, f.size * dv));
      const q = [corner(0.26, 0.26), corner(0.4, 0.26), corner(0.4, 0.4), corner(0.26, 0.4)];
      parts.push(h('path', { d: `M${q[0].x} ${q[0].y}L${q[1].x} ${q[1].y}L${q[2].x} ${q[2].y}L${q[3].x} ${q[3].y}Z`, fill: COLORS[i], 'fill-opacity': 0.55, stroke: COLORS[i], 'stroke-width': 1, 'data-gizmo': `plane:${i}`, class: 'gz plane' }));
    }
    parts.push(h('circle', { cx: x, cy: y, r: 10, fill: 'transparent', stroke: '#ffffff', 'stroke-width': 1.4, 'data-gizmo': 'view', class: 'gz' }));
  }
  if (show.scale) {
    basis = orientationBasis(gizmoOrientation('scale'));
    for (let i = 0; i < 3; i++) {
      const e = axisEnd(i, kind === 'transform' ? 0.7 : 1);
      const dx = e.x - x,
        dy = e.y - y,
        l = Math.hypot(dx, dy);
      if (l < 4) continue;
      const ux = dx / l,
        uy = dy / l;
      if (kind === 'scale') parts.push(h('line', { x1: x + ux * 14, y1: y + uy * 14, x2: e.x, y2: e.y, stroke: COLORS[i], 'stroke-width': 1.8, 'data-gizmo': `scale:${i}`, class: 'gz' }));
      parts.push(h('rect', { x: e.x - 5, y: e.y - 5, width: 10, height: 10, fill: COLORS[i], 'data-gizmo': `scale:${i}`, class: 'gz' }));
      if (kind === 'scale') {
        // plane handles scale along the two other axes
        const ua = new Vector3(...[0, 1, 2].map((k) => (k === (i + 1) % 3 ? 1 : 0))).applyMatrix3(basis).normalize(),
          va = new Vector3(...[0, 1, 2].map((k) => (k === (i + 2) % 3 ? 1 : 0))).applyMatrix3(basis).normalize();
        const corner = (du: number, dv: number) => v.project(f.pivot.clone().addScaledVector(ua, f.size * du).addScaledVector(va, f.size * dv));
        const q = [corner(0.26, 0.26), corner(0.4, 0.26), corner(0.4, 0.4), corner(0.26, 0.4)];
        parts.push(h('path', { d: `M${q[0].x} ${q[0].y}L${q[1].x} ${q[1].y}L${q[2].x} ${q[2].y}L${q[3].x} ${q[3].y}Z`, fill: COLORS[i], 'fill-opacity': 0.55, stroke: COLORS[i], 'stroke-width': 1, 'data-gizmo': `scaleplane:${i}`, class: 'gz plane' }));
      }
    }
    if (kind === 'scale') {
      // uniform scale: the outer ring and the small ring at the centre
      const R = (f.size / v.nav.pixelSize(f.pivot)) * 1.2;
      parts.push(h('circle', { cx: x, cy: y, r: R, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.6, 'data-gizmo': 'scale:all', class: 'gz', opacity: 0.85 }));
      parts.push(h('circle', { cx: x, cy: y, r: 10, fill: 'transparent', stroke: '#ffffff', 'stroke-width': 1.4, 'data-gizmo': 'scale:all', class: 'gz' }));
    }
  }
  if (show.rotate) {
    basis = orientationBasis(gizmoOrientation('rotate'));
    // rotation rings: project circles around each axis
    for (let i = 0; i < 3; i++) {
      const pts: string[] = [];
      const n = new Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyMatrix3(basis);
      const u = new Vector3(i === 1 ? 1 : 0, i === 2 ? 1 : 0, i === 0 ? 1 : 0).applyMatrix3(basis);
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
      parts.push(h('path', { d: pts.join(''), fill: 'none', stroke: COLORS[i], 'stroke-width': 2.8, 'data-gizmo': `rotate:${i}`, class: 'gz' }));
    }
    const R = (f.size / v.nav.pixelSize(f.pivot)) * 1.2;
    parts.push(h('circle', { cx: x, cy: y, r: R, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.4, 'data-gizmo': 'rotate:view', class: 'gz' }));
    parts.push(h('circle', { cx: x, cy: y, r: R * 0.83, fill: 'transparent', stroke: 'rgba(255, 255, 255,0.15)', 'stroke-width': 1, 'data-gizmo': 'trackball', class: 'gz' }));
  }
  return h('g', { class: 'transform-gizmo' }, parts);
}

export function gizmoPointerDown(v: View3D, e: PointerEvent): boolean {
  const t = e.target as Element;
  const g = t.closest?.('[data-gizmo]') as SVGElement | null;
  if (!g) return false;
  const id = g.getAttribute('data-gizmo')!;
  if (id.startsWith('cage:')) return cagePointerDown(v, e, id);
  const [kind, axis] = id.split(':');
  e.preventDefault();
  e.stopPropagation();
  const i = Number(axis);
  const constraint = Number.isInteger(i) ? (kind === 'plane' || kind === 'scaleplane' ? [0, 1, 2].map((k) => k !== i) : [0, 1, 2].map((k) => k === i)) : undefined;
  const ev = { x: e.clientX, y: e.clientY };
  const mode = kind === 'move' || kind === 'plane' || kind === 'view' ? 'TRANSLATION' : kind === 'scale' || kind === 'scaleplane' ? 'RESIZE' : kind === 'trackball' ? 'TRACKBALL' : 'ROTATION';
  const orient = gizmoOrientation(mode === 'RESIZE' ? 'scale' : mode === 'ROTATION' || mode === 'TRACKBALL' ? 'rotate' : 'move');
  if (startTransform(mode, { constraint, event: ev, release_confirm: true, orient, redoSelf: true })) {
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

// ---------------------------------------------------------------------------
// Scale Cage: a box around the selection (in the scale gizmo's orientation) with handles on its
// corners, edges and faces; dragging one scales the selection from the opposite side.

/** Selection bounds in the coordinates of `basis` (object mode: geometry of the selected objects). */
function cageBounds(basis: Matrix3): { min: Vector3; max: Vector3 } | null {
  const inv = basis.clone().invert();
  const min = new Vector3(Infinity, Infinity, Infinity),
    max = new Vector3(-Infinity, -Infinity, -Infinity);
  const add = (p: Vector3) => {
    p.applyMatrix3(inv);
    min.min(p);
    max.max(p);
  };
  if (app.doc.mode === 'OBJECT') {
    for (const ob of app.selectedObjects()) {
      const ev = app.graph.get(ob.id);
      if (!ev) continue;
      const P = ev.mesh?.positions;
      if (P && P.length) {
        const step = Math.max(1, Math.floor(P.length / 3 / 5000));
        for (let i = 0; i < P.length / 3; i += step) add(new Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(ev.world));
      } else add(new Vector3().setFromMatrixPosition(ev.world));
    }
  } else {
    const c = gizmoCenterHook?.();
    if (c) add(c.center.clone());
  }
  return Number.isFinite(min.x) ? { min, max } : null;
}

function cageFrame(): { basis: Matrix3; min: Vector3; max: Vector3; at: (ix: number, iy: number, iz: number) => Vector3 } | null {
  const basis = orientationBasis(gizmoOrientation('scale'));
  const b = cageBounds(basis);
  if (!b) return null;
  const pick = (i: number, k: 'x' | 'y' | 'z') => (i < 0 ? b.min[k] : i > 0 ? b.max[k] : (b.min[k] + b.max[k]) / 2);
  return { basis, min: b.min, max: b.max, at: (ix, iy, iz) => new Vector3(pick(ix, 'x'), pick(iy, 'y'), pick(iz, 'z')).applyMatrix3(basis) };
}

function scaleCage(v: View3D): VNode | null {
  const f = cageFrame();
  if (!f) return null;
  const parts: VNode[] = [];
  const P = (ix: number, iy: number, iz: number) => v.project(f.at(ix, iy, iz));
  const edges: [number[], number[]][] = [];
  for (const a of [-1, 1])
    for (const b of [-1, 1]) {
      edges.push([[-1, a, b], [1, a, b]], [[a, -1, b], [a, 1, b]], [[a, b, -1], [a, b, 1]]);
    }
  const flat = [0, 1, 2].map((k) => Math.abs((k === 0 ? f.max.x - f.min.x : k === 1 ? f.max.y - f.min.y : f.max.z - f.min.z)) < 1e-9);
  for (const [a, b] of edges) {
    const p = P(a[0], a[1], a[2]),
      q = P(b[0], b[1], b[2]);
    if (p.z > 1 || q.z > 1) continue;
    parts.push(h('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: '#ffffff', 'stroke-width': 1, opacity: 0.7 }));
  }
  for (const ix of [-1, 0, 1])
    for (const iy of [-1, 0, 1])
      for (const iz of [-1, 0, 1]) {
        if (!ix && !iy && !iz) continue;
        // a flat box has no handles off its plane
        if ((flat[0] && ix) || (flat[1] && iy) || (flat[2] && iz)) continue;
        const p = P(ix, iy, iz);
        if (p.z > 1) continue;
        const n = +!!ix + +!!iy + +!!iz;
        const r = n === 3 ? 4.5 : n === 2 ? 3.5 : 4;
        const color = n === 1 ? COLORS[ix ? 0 : iy ? 1 : 2] : '#ffffff';
        parts.push(h('rect', { x: p.x - r, y: p.y - r, width: r * 2, height: r * 2, fill: color, stroke: '#000000', 'stroke-width': 0.6, 'data-gizmo': `cage:${ix},${iy},${iz}`, class: 'gz' }));
      }
  return h('g', { class: 'transform-gizmo scale-cage' }, parts);
}

function cagePointerDown(v: View3D, e: PointerEvent, id: string): boolean {
  const [ix, iy, iz] = id.slice(5).split(',').map(Number);
  const f = cageFrame();
  if (!f) return false;
  e.preventDefault();
  e.stopPropagation();
  const center = f.at(-ix, -iy, -iz);
  const constraint = [ix !== 0, iy !== 0, iz !== 0];
  if (startTransform('RESIZE', { constraint, center, event: { x: e.clientX, y: e.clientY }, release_confirm: true, orient: gizmoOrientation('scale'), label: 'Scale Cage' })) {
    const up = () => {
      removeEventListener('pointerup', up, true);
      if (app.modal) app.endModal('FINISHED');
    };
    addEventListener('pointerup', up, true);
  }
  void v;
  return true;
}
