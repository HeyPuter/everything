// Gradient tool (Edit Mode): drag a line over the selected strokes to place their fill gradient —
// it starts where the drag starts and ends where it ends (radial gradients: center and radius).
// Reset UVs (curveedit.ts) brings back the material's mapping.
import { Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { activeTools } from '../app/prefs';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { toolSettingsRenderers, toolsByMode, type ToolDef } from '../editors/view3d/toolbar';
import { h, type VNode } from '../ui/h';
import { inGPEdit, editTargets, drawing, setDrawing } from './edit';
import { toStrokes, fromStrokes } from './data';
import { evaluatedDrawing } from './curves';
import { fillPlane } from './geometry';

/** Plane coordinates (fill plane of the stroke, layer space) of a viewport pixel, or null. */
function planeCoords(v: View3D, x: number, y: number, world: import('three').Matrix4, P: ArrayLike<number>, loop: number[], plane: { N: number[]; U: number[]; V: number[] }): [number, number] | null {
  const i0 = loop[0];
  const p0 = new Vector3(P[i0 * 3], P[i0 * 3 + 1], P[i0 * 3 + 2]).applyMatrix4(world);
  const n = new Vector3(...plane.N).transformDirection(world);
  const { origin, dir } = v.ray(x, y);
  const den = dir.dot(n);
  const hit = Math.abs(den) < 1e-9 ? v.unproject(x, y, p0) : origin.clone().addScaledVector(dir, p0.clone().sub(origin).dot(n) / den);
  const l = hit.applyMatrix4(world.clone().invert());
  return [l.x * plane.U[0] + l.y * plane.U[1] + l.z * plane.U[2], l.x * plane.V[0] + l.y * plane.V[1] + l.z * plane.V[2]];
}

registerOperators([
  {
    idname: 'grease_pencil.texture_gradient',
    label: 'Texture Gradient',
    description: 'Place the fill gradient of the selected strokes along a line drawn in the viewport',
    props: [
      { id: 'xstart', label: 'X Start', type: 'int', default: 0, hidden: true },
      { id: 'xend', label: 'X End', type: 'int', default: 0, hidden: true },
      { id: 'ystart', label: 'Y Start', type: 'int', default: 0, hidden: true },
      { id: 'yend', label: 'Y End', type: 'int', default: 0, hidden: true },
      { id: 'flip', label: 'Flip', type: 'bool', default: false },
      { id: 'cursor', label: 'Cursor', type: 'int', default: 5, hidden: true },
    ],
    poll: () => inGPEdit(),
    exec: (_c, p) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      let a = [p.xstart as number, p.ystart as number],
        b = [p.xend as number, p.yend as number];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 2) return 'CANCELLED';
      if (p.flip) [a, b] = [b, a];
      let any = false;
      for (const t of editTargets()) {
        const d = drawing(t);
        const ev = evaluatedDrawing(d);
        const strokes = toStrokes(d);
        let changed = false;
        strokes.forEach((s, si) => {
          if (!s.points.some((q) => q.select) || s.points.length < 2) return;
          const loop: number[] = [];
          for (let i = ev.offsets[si]; i < ev.offsets[si + 1]; i++) loop.push(i);
          const plane = fillPlane(ev.position, [loop]);
          const A = planeCoords(v, a[0], a[1], t.world, ev.position, loop, plane),
            B = planeCoords(v, b[0], b[1], t.world, ev.position, loop, plane);
          if (!A || !B) return;
          const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
          if (len < 1e-9) return;
          strokes[si] = { ...s, uv_translation: A, uv_rotation: Math.atan2(B[1] - A[1], B[0] - A[0]), uv_scale: [len, len] };
          changed = true;
        });
        if (changed) {
          setDrawing(t, fromStrokes(strokes));
          any = true;
        }
      }
      if (!any) {
        app.report('WARNING', 'Select the strokes whose fill gradient to place');
        return 'CANCELLED';
      }
    },
  },
]);

// ---------------------------------------------------------------------------
// tool

const TOOL: ToolDef = { id: 'builtin.texture_gradient', label: 'Gradient', icon: 'gp_texture_gradient', description: 'Drag a line over the selected strokes to place their fill gradient' };
{
  const list = toolsByMode.EDIT_GREASEPENCIL;
  const at = list.findIndex((t) => t?.id === 'builtin.interpolate');
  list.splice(at >= 0 ? at + 1 : list.length, 0, null, TOOL);
}

let preview: { x0: number; y0: number; x1: number; y1: number } | null = null;

editModeHooks.svg.push(() => {
  if (!preview) return null;
  const { x0, y0, x1, y1 } = preview;
  const parts: VNode[] = [
    h('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: '#000000', 'stroke-width': 3, opacity: 0.5 }),
    h('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: '#ffffff', 'stroke-width': 1.2, 'stroke-dasharray': '5 3' }),
    h('circle', { cx: x0, cy: y0, r: 4, fill: '#ffffff', stroke: '#000000' }),
    h('circle', { cx: x1, cy: y1, r: 4, fill: '#000000', stroke: '#ffffff' }),
  ];
  return h('g', { class: 'gp-gradient-line' }, parts);
});

editModeHooks.pointer.unshift((v, e) => {
  if (e.button !== 0 || !inGPEdit() || activeTools.EDIT !== 'builtin.texture_gradient') return false;
  const r = v.el.getBoundingClientRect();
  const x0 = e.clientX - r.left,
    y0 = e.clientY - r.top;
  preview = { x0, y0, x1: x0, y1: y0 };
  const move = (ev: PointerEvent) => {
    preview = { x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top };
    app.changed('ui');
  };
  const up = (ev: PointerEvent) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    preview = null;
    const x1 = ev.clientX - r.left,
      y1 = ev.clientY - r.top;
    if (Math.hypot(x1 - x0, y1 - y0) < 4) {
      // a click selects
      for (const hk of editModeHooks.pick) if (hk(v, x0, y0, { extend: e.shiftKey, toggle: e.shiftKey, deselectAll: !e.shiftKey })) break;
    } else app.run('grease_pencil.texture_gradient', { xstart: Math.round(x0), ystart: Math.round(y0), xend: Math.round(x1), yend: Math.round(y1) }, { invoke: false });
    app.changed('ui');
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  return true;
});

toolSettingsRenderers['builtin.texture_gradient'] = () => h('span', { class: 'th-label' }, 'Drag over the selected strokes: the fill gradient runs from the start to the end of the line');
