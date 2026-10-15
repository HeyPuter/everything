// Curves Edit Mode Draw tool: drag to draw a new curve. Points land on the surface under the
// pointer (when the curves have one and it is hit) or on the view plane through the 3D cursor;
// the stroke is resampled to evenly spaced control points.
import { Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { activeTools } from '../app/prefs';
import { editModeHooks } from '../editors/view3d/hooks';
import type { View3D } from '../editors/view3d/view3d';
import { toolsByMode, toolSettingsRenderers } from '../editors/view3d/toolbar';
import { h, type VNode } from '../ui/h';
import { numberField, checkbox } from '../ui/widgets';
import { resamplePolyline, polylineLength } from './brushmath';
import { activeHair, inCurvesEdit, surfaceOf, worldOf } from './common';
import { appendCurves, curveCount, pointCount, setSelection } from './data';
import { Surface } from './surface';

const TOOL = 'builtin.draw_curves';

const settings = { points: 8, radius: 0.005, use_surface: true };

toolsByMode.EDIT_CURVES = [...(toolsByMode.EDIT_CURVES ?? []), null, { id: TOOL, label: 'Draw', icon: 'hair_snake', description: 'Draw new curves (on the surface when one is under the pointer)' }];

toolSettingsRenderers[TOOL] = () => [
  h('div', { style: { width: '110px', flex: 'none' } }, numberField({ id: 'hcd-pts', label: 'Points', value: settings.points, min: 2, max: 200, int: true, tip: 'Control points of each drawn curve', set: (x) => ((settings.points = Math.round(x)), app.changed('ui')) })),
  h('div', { style: { width: '120px', flex: 'none' } }, numberField({ id: 'hcd-rad', label: 'Radius', value: settings.radius, min: 0, unit: 'distance', tip: 'Radius of drawn curves', set: (x) => ((settings.radius = x), app.changed('ui')) })),
  checkbox('hcd-surf', 'Project to Surface', settings.use_surface, (v) => ((settings.use_surface = v), app.changed('ui')), { tip: 'Place points on the surface mesh under the pointer' }),
];

/** Add a curve through world-space points (resampled), selected alone. */
export function addDrawnCurve(world: Vector3[], points: number, radius: number): boolean {
  const a = activeHair();
  if (!a || world.length < 2) return false;
  const inv = worldOf(a.ob).invert();
  const flat: number[] = [];
  for (const p of world) {
    const q = p.clone().applyMatrix4(inv);
    flat.push(q.x, q.y, q.z);
  }
  if (polylineLength(flat) < 1e-6) return false;
  const hc = a.hc;
  setSelection(hc, new Float32Array(hc.selection_domain === 'CURVE' ? curveCount(hc) : pointCount(hc)));
  appendCurves(hc, [{ points: resamplePolyline(flat, Math.max(2, points)), radius }], true);
  return true;
}

let stroke: { view: View3D; pts: { x: number; y: number }[] } | null = null;

function worldPoint(v: View3D, x: number, y: number): Vector3 {
  const a = activeHair()!;
  if (settings.use_surface) {
    const so = surfaceOf(a.ob, a.hc);
    if (so) {
      const sw = app.graph.get(so.ob.id)!.world;
      const inv = sw.clone().invert();
      const r = v.ray(x, y);
      const hit = Surface.of(so.mesh).raycast(r.origin.clone().applyMatrix4(inv), r.dir.clone().transformDirection(inv));
      if (hit) return hit.point.applyMatrix4(sw);
    }
  }
  return v.unproject(x, y, new Vector3(...app.doc.scene.cursor.location));
}

editModeHooks.pointer.unshift((v, e) => {
  if (!inCurvesEdit() || e.button !== 0 || e.altKey || activeTools.EDIT !== TOOL) return false;
  const p = v.local(e);
  stroke = { view: v, pts: [p] };
  const move = (ev: PointerEvent) => {
    const q = v.local(ev);
    const last = stroke!.pts[stroke!.pts.length - 1];
    if (Math.hypot(q.x - last.x, q.y - last.y) >= 3) stroke!.pts.push(q);
    v.drawSvg();
  };
  const up = () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    const s = stroke!;
    stroke = null;
    v.drawSvg();
    if (addDrawnCurve(s.pts.map((q) => worldPoint(v, q.x, q.y)), settings.points, settings.radius)) {
      app.pushUndo('Draw Curve');
      app.changed('doc');
    }
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  return true;
});

editModeHooks.svg.push((v) => {
  if (!stroke || stroke.view !== v || stroke.pts.length < 2) return null;
  const d = stroke.pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
  return h('path', { d, fill: 'none', stroke: '#fcb559', 'stroke-width': 1.5, 'pointer-events': 'none' }) as VNode;
});

registerOperators([
  {
    idname: 'curves.draw',
    label: 'Draw Curves',
    description: 'Add a curve through points given in world space (the Draw tool draws them by dragging)',
    props: [
      { id: 'points', label: 'Points', type: 'string', default: '', hidden: true },
      { id: 'count', label: 'Control Points', type: 'int', default: 8, min: 2, max: 200 },
    ],
    poll: inCurvesEdit,
    exec: (_c, p) => {
      let list: number[] = [];
      try {
        list = JSON.parse((p.points as string) || '[]');
      } catch {
        return 'CANCELLED';
      }
      const pts: Vector3[] = [];
      for (let i = 0; i + 2 < list.length; i += 3) pts.push(new Vector3(list[i], list[i + 1], list[i + 2]));
      return addDrawnCurve(pts, p.count as number, settings.radius) ? 'FINISHED' : 'CANCELLED';
    },
  },
]);
