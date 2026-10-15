// Curve Edit Mode toolbar: Draw (freehand, fitted to Bézier), Pen (click/drag to place points and
// handles), Extrude, Extrude to Cursor, Radius and Tilt, with their tool settings.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators, type OpContext } from '../../app/app';
import { activeTools } from '../../app/prefs';
import { toolsByMode, COMMON_TOOLS, toolSettingsRenderers } from '../../editors/view3d/toolbar';
import { editModeHooks } from '../../editors/view3d/hooks';
import { activeView3D, type View3D } from '../../editors/view3d/view3d';
import { registerIcons } from '../../ui/icons';
import { h } from '../../ui/h';
import { numberField, checkbox, enumMenu } from '../../ui/widgets';
import { surfaceHit } from '../../ops/view3d';
import type { BezierPoint, Spline, Vec3 } from '../../data/types';
import { activeCurve, inCurveEdit, recalcHandles, pickPoint, setActivePoint, activePoint } from './curve';
import * as K from './curveops';

registerIcons({
  curve_draw: '<path class="s" d="M1.5 13.5c2-5 4.5-1 6.5-4s1.5-5 3-6" fill="none" stroke-width="1.3"/><path class="f" d="M11.2 1.6l2.2-.9.9 2.2-3.3 3.6-1.6-1.4z"/>',
  curve_pen: '<path class="s" d="M1.5 14.5c3-1 4-5 7-6" fill="none" stroke-width="1.2"/><path class="f" d="M9 2l5 5-3.5 2.2L6.8 5.5z"/><circle class="f" cx="9.6" cy="6.4" r=".9" opacity=".35"/><path class="s" d="M3.5 12.5 8.4 7.6" stroke-width="1"/>',
  curve_extrude: '<path class="s" d="M1.5 13c3 0 4-6 7-7" fill="none" stroke-width="1.3"/><circle class="f" cx="8.5" cy="6" r="1.6"/><path class="f" d="M10.5 4.4 14.5 1.5l-.8 4.6-1.2-1.3-1.3 1.2z"/>',
  curve_extrude_cursor: '<path class="s" d="M1.5 13c3 0 4-6 7-7" fill="none" stroke-width="1.3"/><circle class="f" cx="8.5" cy="6" r="1.6"/><circle class="s" cx="13" cy="3.5" r="2.2" fill="none" stroke-width="1.1" stroke-dasharray="1.5 1.2"/>',
  curve_radius: '<path class="s" d="M1.5 12c4 0 6-8 13-8" fill="none" stroke-width="1"/><circle class="s" cx="8" cy="8" r="3.6" fill="none" stroke-width="1.2"/><path class="f" d="M8 8l4.6-4.6-.2 2.5-2.3-.1z"/>',
  curve_tilt: '<path class="s" d="M1.5 8h13" stroke-width="1.2"/><path class="s" d="M8 3.2c-2.4.4-2.4 9.2 0 9.6 1.4.2 2-1.4 2.2-3" fill="none" stroke-width="1.2"/><path class="f" d="M9 8.6l1.2 2.6 1.4-2.4z"/>',
});

toolsByMode.EDIT_CURVE = [
  ...COMMON_TOOLS,
  null,
  { id: 'builtin.draw', label: 'Draw', icon: 'curve_draw', description: 'Draw a freehand curve, fitted to Bézier points' },
  { id: 'builtin.pen', label: 'Curve Pen', icon: 'curve_pen', description: 'Click to add points, drag to shape handles; Ctrl-click inserts on a segment or deletes a point, double-click toggles sharp/smooth' },
  null,
  { id: 'builtin.extrude', label: 'Extrude', icon: 'curve_extrude', shortcut: 'E', description: 'Extrude the selected end points by dragging' },
  { id: 'builtin.extrude_cursor', label: 'Extrude to Cursor', icon: 'curve_extrude_cursor', description: 'Add a point at the clicked location, connected to the selected end point' },
  null,
  { id: 'builtin.radius', label: 'Radius', icon: 'curve_radius', shortcut: 'Alt S', description: 'Drag to scale the radius of the selected points' },
  { id: 'builtin.tilt', label: 'Tilt', icon: 'curve_tilt', shortcut: 'Ctrl T', description: 'Drag to twist the selected points around the curve' },
];

const CURVE_TOOLS = new Set(['builtin.draw', 'builtin.pen', 'builtin.extrude', 'builtin.extrude_cursor', 'builtin.radius', 'builtin.tilt']);

/** Draw tool settings (session state, shown in the tool header). */
export const drawSettings = {
  error_threshold: 0.03,
  corner_angle: (70 * Math.PI) / 180,
  use_cyclic: true,
  depth_mode: 'CURSOR' as 'CURSOR' | 'SURFACE',
  surface_offset: 0,
  use_pressure_radius: false,
  radius_min: 0,
  radius_max: 1,
};

toolSettingsRenderers['builtin.draw'] = () =>
  inCurveEdit()
    ? h(
        'span',
        { class: 'th-settings' },
        h('span', { class: 'th-label' }, 'Depth'),
        enumMenu(
          'cdraw-depth',
          [
            { value: 'CURSOR', label: 'Cursor' },
            { value: 'SURFACE', label: 'Surface' },
          ],
          drawSettings.depth_mode,
          (v) => ((drawSettings.depth_mode = v as 'CURSOR'), app.changed('ui')),
        ),
        h('span', { class: 'th-label' }, 'Tolerance'),
        numberField({ id: 'cdraw-err', value: drawSettings.error_threshold, min: 0.0001, max: 10, step: 0.005, precision: 3, unit: 'distance', set: (x) => ((drawSettings.error_threshold = x), app.changed('ui')) }),
        checkbox('cdraw-cyc', 'Detect Cyclic', drawSettings.use_cyclic, (x) => ((drawSettings.use_cyclic = x), app.changed('ui'))),
        checkbox('cdraw-pr', 'Pressure Radius', drawSettings.use_pressure_radius, (x) => ((drawSettings.use_pressure_radius = x), app.changed('ui'))),
        h('span', { class: 'th-label' }, 'Radius'),
        numberField({ id: 'cdraw-rmax', value: drawSettings.radius_max, min: 0, max: 100, step: 0.05, set: (x) => ((drawSettings.radius_max = x), app.changed('ui')) }),
      )
    : null;
toolSettingsRenderers['builtin.pen'] = () => (inCurveEdit() ? h('span', { class: 'th-label' }, 'Click: add / select · Drag: shape handles · Ctrl-click: insert or delete · Double-click: sharp / smooth') : null);

const world = () => {
  const a = activeCurve();
  return a ? app.graph.get(a.ob.id)?.world ?? new Matrix4() : new Matrix4();
};
const V3 = (a: ArrayLike<number>) => new Vector3(a[0], a[1], a[2]);
const arr = (v: Vector3) => [v.x, v.y, v.z] as Vec3;

function viewOf(ctx: OpContext): View3D | null {
  const v = (ctx.area?.editor as View3D | undefined) ?? activeView3D();
  return v && (v as unknown as { project?: unknown }).project ? v : null;
}

// ---------------------------------------------------------------------------
// Draw

registerOperators([
  {
    idname: 'curve.draw',
    label: 'Draw Curve',
    description: 'Draw a freehand spline, fitted to Bézier control points',
    props: [
      { id: 'error_threshold', label: 'Error', type: 'float', default: 0.03, min: 0.0001, max: 10, subtype: 'distance' },
      { id: 'corner_angle', label: 'Corner Angle', type: 'float', default: (70 * Math.PI) / 180, min: 0, max: Math.PI, subtype: 'angle' },
      { id: 'use_cyclic', label: 'Cyclic', type: 'bool', default: true },
      { id: 'stroke', label: 'Stroke', type: 'string', default: '', hidden: true },
    ],
    poll: () => inCurveEdit(),
    invoke: (ctx) => (startDraw(ctx) ? 'RUNNING_MODAL' : 'CANCELLED'),
    exec: (_ctx, p) => {
      const a = activeCurve()!;
      let raw: number[][] = [];
      try {
        raw = JSON.parse((p.stroke as string) || '[]');
      } catch {
        return 'CANCELLED';
      }
      if (raw.length < 2) return 'CANCELLED';
      const inv = world().clone().invert();
      const pts = raw.map((q) => new Vector3(q[0], q[1], q[2]).applyMatrix4(inv));
      // error is given in object space
      const fit = K.fitStroke(pts, p.error_threshold as number, p.corner_angle as number, !!p.use_cyclic, raw.map((q) => q[3] ?? 1));
      if (!fit.points.length) return 'CANCELLED';
      K.deselectAll(a.cu);
      for (const b of fit.points) b.select_control_point = b.select_left_handle = b.select_right_handle = true;
      const sp: Spline = { type: 'BEZIER', bezier_points: fit.points, points: [], use_cyclic_u: fit.cyclic, resolution_u: a.cu.resolution_u, order_u: 4, use_smooth: true, material_index: 0 };
      a.cu.splines.push(sp);
      setActivePoint({ s: a.cu.splines.length - 1, i: fit.points.length - 1 });
    },
  },
]);

function depthPoint(v: View3D, x: number, y: number): Vector3 {
  const cursor = V3(app.doc.scene.cursor.location);
  if (drawSettings.depth_mode === 'SURFACE') {
    const hit = surfaceHit(v, x, y);
    if (hit) {
      if (drawSettings.surface_offset) hit.addScaledVector(v.ray(x, y).dir, -drawSettings.surface_offset);
      return hit;
    }
  }
  return v.unproject(x, y, cursor);
}

function startDraw(ctx: OpContext): boolean {
  const v = viewOf(ctx);
  if (!v) return false;
  const r = v.el.getBoundingClientRect();
  const stroke: number[][] = [];
  const screen: { x: number; y: number }[] = [];
  const add = (cx: number, cy: number, pressure: number) => {
    const x = cx - r.left,
      y = cy - r.top;
    const last = screen[screen.length - 1];
    if (last && Math.hypot(last.x - x, last.y - y) < 3) return;
    screen.push({ x, y });
    const p = depthPoint(v, x, y);
    const rad = drawSettings.use_pressure_radius ? drawSettings.radius_min + (drawSettings.radius_max - drawSettings.radius_min) * pressure : drawSettings.radius_max;
    stroke.push([p.x, p.y, p.z, rad]);
    drawPreview();
  };
  let svg: SVGSVGElement | null = v.el.querySelector(':scope > svg.curve-draw-preview');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('curve-draw-preview');
    svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:5');
    v.el.append(svg);
  }
  const drawPreview = () => {
    if (svg) svg.innerHTML = `<polyline points="${screen.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#e8e8e8" stroke-width="1.5" stroke-linejoin="round"/>`;
  };
  const cleanup = () => svg?.remove();
  const e0 = ctx.event ?? app.pointer;
  add(e0.x, e0.y, 0.5);
  const finish = () => {
    cleanup();
    if (stroke.length < 2) return;
    // run as exec so the redo panel can refit the same stroke
    queueMicrotask(() => app.run('curve.draw', { error_threshold: drawSettings.error_threshold, corner_angle: drawSettings.corner_angle, use_cyclic: drawSettings.use_cyclic, stroke: JSON.stringify(stroke.map((q) => q.map((x) => +x.toFixed(5)))) }, { invoke: false }));
  };
  app.startModal({
    label: 'Draw Curve',
    header: () => 'Draw Curve: release to finish, Esc to cancel',
    onPointerMove: (e) => add(e.clientX, e.clientY, e.pointerType === 'pen' ? e.pressure : 0.5),
    onPointerUp: () => {
      finish();
      return 'CANCELLED'; // the curve.draw exec records the undo step
    },
    onKey: (e) => (e.type === 'keydown' && e.key === 'Escape' ? (cleanup(), 'CANCELLED') : true),
    cancel: () => {},
  });
  return true;
}

// ---------------------------------------------------------------------------
// Pen

interface HandleHit {
  s: number;
  i: number;
  side: 'handle_left' | 'handle_right';
}

function pickHandle(v: View3D, x: number, y: number): HandleHit | null {
  const a = activeCurve();
  if (!a) return null;
  const w = world();
  let best: HandleHit | null = null,
    bd = 9;
  a.cu.splines.forEach((sp, s) => {
    if (sp.type !== 'BEZIER') return;
    sp.bezier_points.forEach((b, i) => {
      if (b.hide || !(b.select_control_point || b.select_left_handle || b.select_right_handle)) return;
      for (const side of ['handle_left', 'handle_right'] as const) {
        const p = v.project(V3(b[side]).applyMatrix4(w));
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) {
          bd = d;
          best = { s, i, side };
        }
      }
    });
  });
  return best;
}

/** Nearest point on any segment in screen space: spline, segment start index, parameter. */
function pickSegment(v: View3D, x: number, y: number, maxDist = 10): { s: number; i: number; t: number } | null {
  const a = activeCurve();
  if (!a) return null;
  const w = world();
  let best: { s: number; i: number; t: number } | null = null,
    bd = maxDist;
  a.cu.splines.forEach((sp, s) => {
    const n = K.pointCount(sp);
    const segs = sp.use_cyclic_u ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const steps = 24;
      let prev: { x: number; y: number } | null = null;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        let p: Vector3;
        if (sp.type === 'BEZIER') {
          const A = sp.bezier_points[i],
            B = sp.bezier_points[j];
          p = K.bezierAt(V3(A.co), V3(A.handle_right), V3(B.handle_left), V3(B.co), t);
        } else p = V3(sp.points[i].co).lerp(V3(sp.points[j].co), t);
        const q = v.project(p.applyMatrix4(w));
        if (prev) {
          const dx = q.x - prev.x,
            dy = q.y - prev.y,
            l2 = dx * dx + dy * dy || 1;
          const f = Math.max(0, Math.min(1, ((x - prev.x) * dx + (y - prev.y) * dy) / l2));
          const d = Math.hypot(prev.x + dx * f - x, prev.y + dy * f - y);
          if (d < bd) {
            bd = d;
            best = { s, i, t: (k - 1 + f) / steps };
          }
        }
        prev = q;
      }
    }
  });
  return best;
}

/** Drag something with the mouse until release: `move` gets the world-space point under the mouse at `depth`. */
function dragModal(v: View3D, label: string, depth: Vector3, move: (p: Vector3, e: PointerEvent) => void, restore: () => void, onClick?: () => void) {
  const r = v.el.getBoundingClientRect();
  let moved = false;
  const start = { ...app.pointer };
  app.startModal({
    label,
    header: () => `${label}: release to confirm`,
    onPointerMove: (e) => {
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 3) return;
      moved = true;
      move(v.unproject(e.clientX - r.left, e.clientY - r.top, depth), e);
      app.changed('doc', 'geometry');
    },
    onPointerUp: () => {
      if (!moved) onClick?.();
      return 'FINISHED';
    },
    onKey: (e) => (e.type === 'keydown' && e.key === 'Escape' ? 'CANCELLED' : true),
    cancel: () => {
      restore();
      app.changed('doc', 'geometry');
    },
  });
}

function selectedEnd(): { s: number; atEnd: boolean } | null {
  const a = activeCurve()!;
  let found: { s: number; atEnd: boolean } | null = null,
    count = 0;
  a.cu.splines.forEach((sp, s) => {
    const n = K.pointCount(sp);
    for (let i = 0; i < n; i++) if (K.isSel(sp, i)) count++;
    if (!n || sp.use_cyclic_u) return;
    if (K.isSel(sp, n - 1)) found = { s, atEnd: true };
    else if (K.isSel(sp, 0)) found = { s, atEnd: false };
  });
  return count === 1 ? found : null;
}

registerOperators([
  {
    idname: 'curve.pen',
    label: 'Curve Pen',
    description: 'Construct and edit splines by clicking and dragging',
    props: [
      { id: 'extrude_point', label: 'Extrude Point', type: 'bool', default: false },
      { id: 'insert_point', label: 'Insert Point', type: 'bool', default: false },
      { id: 'delete_point', label: 'Delete Point', type: 'bool', default: false },
      { id: 'move_point', label: 'Move Point', type: 'bool', default: false },
      { id: 'select_point', label: 'Select Point', type: 'bool', default: false },
      { id: 'close_spline', label: 'Close Spline', type: 'bool', default: true },
      { id: 'toggle_vector', label: 'Toggle Vector', type: 'bool', default: false },
    ],
    poll: () => inCurveEdit(),
    invoke: (ctx, p) => {
      const v = viewOf(ctx);
      if (!v) return 'CANCELLED';
      const a = activeCurve()!;
      const r = v.el.getBoundingClientRect();
      const ev = ctx.event ?? app.pointer;
      const x = ev.x - r.left,
        y = ev.y - r.top;
      const w = world(),
        inv = w.clone().invert();
      const hit = pickPoint(v, x, y, 9);
      const snapshot = structuredClone(a.cu.splines);
      const finish = () => {
        for (const sp of a.cu.splines) recalcHandles(sp);
        return 'FINISHED' as const;
      };
      if (p.toggle_vector && hit) {
        const sp = a.cu.splines[hit.s];
        if (sp.type !== 'BEZIER') return 'CANCELLED';
        const b = sp.bezier_points[hit.i];
        const vec = b.handle_left_type === 'VECTOR' && b.handle_right_type === 'VECTOR';
        b.handle_left_type = b.handle_right_type = vec ? 'AUTO' : 'VECTOR';
        return finish();
      }
      if (p.delete_point && hit) {
        const sp = a.cu.splines[hit.s];
        if (sp.type === 'BEZIER') sp.bezier_points.splice(hit.i, 1);
        else sp.points.splice(hit.i, 1);
        if (!K.pointCount(sp)) a.cu.splines.splice(hit.s, 1);
        else if (K.pointCount(sp) < 3 && sp.type !== 'BEZIER') sp.use_cyclic_u = false;
        setActivePoint(null);
        return finish();
      }
      if (p.insert_point) {
        const seg = pickSegment(v, x, y);
        if (!seg) return 'CANCELLED';
        const sp = a.cu.splines[seg.s];
        K.deselectAll(a.cu);
        const i = K.insertPointOnSegment(sp, seg.i, Math.max(0.001, Math.min(0.999, seg.t)));
        K.setSel(sp, i, true);
        setActivePoint({ s: seg.s, i });
        return finish();
      }
      // close: clicking the other end of the spline whose end point is selected
      const end = selectedEnd();
      if (p.close_spline && hit && end && hit.s === end.s) {
        const sp = a.cu.splines[hit.s];
        const n = K.pointCount(sp);
        const other = end.atEnd ? 0 : n - 1;
        if (hit.i === other && n > 2) {
          sp.use_cyclic_u = true;
          return finish();
        }
      }
      // handle of a selected point: drag it
      const hh = pickHandle(v, x, y);
      if (hh && (p.move_point || p.select_point)) {
        const sp = a.cu.splines[hh.s];
        const b = sp.bezier_points[hh.i];
        const before = structuredClone(b);
        dragModal(
          v,
          'Move Handle',
          V3(b[hh.side]).applyMatrix4(w),
          (wp) => {
            const lp = wp.applyMatrix4(inv);
            b[hh.side] = arr(lp);
            const tk = hh.side === 'handle_left' ? 'handle_left_type' : 'handle_right_type';
            const ok = hh.side === 'handle_left' ? 'handle_right_type' : 'handle_left_type';
            if (b[tk] === 'AUTO' || b[tk] === 'VECTOR') b[tk] = 'ALIGNED';
            if (b[ok] === 'AUTO' || b[ok] === 'VECTOR') b[ok] = 'ALIGNED';
            if (b[tk] === 'ALIGNED' && b[ok] === 'ALIGNED') {
              const co = V3(b.co);
              const dir = lp.clone().sub(co);
              const other = hh.side === 'handle_left' ? 'handle_right' : 'handle_left';
              const len = V3(before[other]).distanceTo(co);
              if (dir.lengthSq() > 1e-12) b[other] = arr(co.clone().addScaledVector(dir.normalize(), -len));
            }
            recalcHandles(sp);
          },
          () => Object.assign(b, before),
        );
        return 'RUNNING_MODAL';
      }
      if (hit && (p.select_point || p.move_point)) {
        K.deselectAll(a.cu);
        const sp = a.cu.splines[hit.s];
        K.setSel(sp, hit.i, true);
        setActivePoint(hit);
        if (!p.move_point) return finish();
        const before = structuredClone(sp);
        const co0 = K.pointCo(sp, hit.i);
        dragModal(
          v,
          'Move Point',
          co0.clone().applyMatrix4(w),
          (wp) => {
            const d = wp.applyMatrix4(inv).sub(co0);
            if (sp.type === 'BEZIER') {
              const b0 = before.bezier_points[hit.i],
                b = sp.bezier_points[hit.i];
              b.co = arr(V3(b0.co).add(d));
              b.handle_left = arr(V3(b0.handle_left).add(d));
              b.handle_right = arr(V3(b0.handle_right).add(d));
            } else {
              const q0 = before.points[hit.i].co;
              sp.points[hit.i].co = [q0[0] + d.x, q0[1] + d.y, q0[2] + d.z, q0[3]];
            }
            recalcHandles(sp);
          },
          () => Object.assign(sp, structuredClone(before)),
        );
        return 'RUNNING_MODAL';
      }
      if (!p.extrude_point) return 'CANCELLED';
      // extrude a new point from the selected end (or start a new spline) and drag its handles
      let depth = V3(ctx.doc.scene.cursor.location);
      let sp: Spline;
      let idx: number;
      const nb = (co: Vec3): BezierPoint => ({ co: [...co] as Vec3, handle_left: [...co] as Vec3, handle_right: [...co] as Vec3, handle_left_type: 'VECTOR', handle_right_type: 'VECTOR', radius: 1, tilt: 0 });
      if (end) {
        sp = a.cu.splines[end.s];
        const n = K.pointCount(sp);
        depth = K.pointCo(sp, end.atEnd ? n - 1 : 0).applyMatrix4(w);
      }
      const lp = v.unproject(x, y, depth).applyMatrix4(inv);
      K.deselectAll(a.cu);
      if (end) {
        sp = a.cu.splines[end.s];
        if (sp.type === 'BEZIER') {
          if (end.atEnd) sp.bezier_points.push(nb(arr(lp)));
          else sp.bezier_points.unshift(nb(arr(lp)));
        } else {
          const q = { co: [lp.x, lp.y, lp.z, 1] as [number, number, number, number], radius: 1, tilt: 0 };
          if (end.atEnd) sp.points.push(q);
          else sp.points.unshift(q);
        }
        idx = end.atEnd ? K.pointCount(sp) - 1 : 0;
      } else {
        sp = { type: 'BEZIER', bezier_points: [nb(arr(lp))], points: [], use_cyclic_u: false, resolution_u: a.cu.resolution_u, order_u: 4, use_smooth: true, material_index: 0 };
        a.cu.splines.push(sp);
        idx = 0;
      }
      K.setSel(sp, idx, true);
      setActivePoint({ s: a.cu.splines.indexOf(sp), i: idx });
      recalcHandles(sp);
      app.changed('doc', 'geometry');
      if (sp.type !== 'BEZIER') return finish();
      const b = sp.bezier_points[idx];
      const forward = !end || end.atEnd; // dragging sets the outgoing handle
      dragModal(
        v,
        'Curve Pen',
        V3(b.co).applyMatrix4(w),
        (wp) => {
          const h = wp.applyMatrix4(inv);
          const co = V3(b.co);
          const mirrored = co.clone().multiplyScalar(2).sub(h);
          b.handle_left_type = b.handle_right_type = 'ALIGNED';
          b.handle_right = arr(forward ? h : mirrored);
          b.handle_left = arr(forward ? mirrored : h);
          recalcHandles(sp);
        },
        () => (a.cu.splines = structuredClone(snapshot)),
      );
      return 'RUNNING_MODAL';
    },
  },
]);

// ---------------------------------------------------------------------------
// tool pointer handling

editModeHooks.pointer.push((v, e) => {
  if (!inCurveEdit()) return false;
  const tool = activeTools.EDIT;
  if (!CURVE_TOOLS.has(tool)) return false;
  const ev = { x: e.clientX, y: e.clientY };
  if (tool === 'builtin.draw') {
    if (e.shiftKey || e.ctrlKey) return false;
    app.run('curve.draw', {}, { event: ev });
    return true;
  }
  if (tool === 'builtin.pen') {
    const dbl = e.detail > 1;
    const props = dbl ? { toggle_vector: true } : e.ctrlKey ? { insert_point: true, delete_point: true } : { extrude_point: true, select_point: true, move_point: true, close_spline: true };
    app.run('curve.pen', props, { event: ev });
    return true;
  }
  if (tool === 'builtin.extrude_cursor') {
    if (e.shiftKey || e.ctrlKey) return false;
    app.run('curve.vertex_add', {}, { event: ev });
    return true;
  }
  // click selects, drag runs the tool
  const sx = e.clientX,
    sy = e.clientY;
  const run = (x: number, y: number) => {
    if (tool === 'builtin.extrude') app.run('curve.extrude_move', { release_confirm: true }, { event: { x, y } });
    else if (tool === 'builtin.radius') app.run('transform.transform', { mode: 'CURVE_SHRINKFATTEN', release_confirm: true }, { event: { x, y } });
    else app.run('transform.tilt', { release_confirm: true }, { event: { x, y } });
  };
  const move = (m: PointerEvent) => {
    if (Math.hypot(m.clientX - sx, m.clientY - sy) < 5) return;
    cleanup();
    // with nothing selected, a drag on a point grabs it first
    const a = activeCurve();
    if (a && !a.cu.splines.some((sp) => [...Array(K.pointCount(sp)).keys()].some((i) => K.isSel(sp, i)))) {
      const r = v.el.getBoundingClientRect();
      const hit = pickPoint(v, sx - r.left, sy - r.top);
      if (hit) {
        K.setSel(a.cu.splines[hit.s], hit.i, true);
        setActivePoint(hit);
      }
    }
    run(sx, sy);
  };
  const up = () => {
    cleanup();
    const r = v.el.getBoundingClientRect();
    for (const hk of editModeHooks.pick) if (hk(v, sx - r.left, sy - r.top, { extend: e.shiftKey, toggle: e.shiftKey, deselectAll: !e.shiftKey })) break;
  };
  const cleanup = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  return true;
});

void activePoint;
