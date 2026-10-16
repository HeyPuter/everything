// Mask point operators behind the clip editor's mouse interactions (usable from search and
// scripts): select, add vertex / feather (and slide), slide point, slide spline curvature, and the
// shape key feather reset / re-key tools.
import { app, registerOperators, type OpContext } from '../app/app';
import { activeLayer, newPoint, type MaskData, type MaskLayer, type MaskPoint } from './types';
import { insertPoint, layerData, recalcHandles } from './geom';
import { allPoints, aspectOf, deselectAll, hitSegment, hostMask, m2s, s2m, selectedPoints, updateHandles } from './clipmask';
import { maskEditor } from './maskops';

type V = [number, number];

const editing = () => !!maskEditor() && !!hostMask(maskEditor()!);
const mask = () => hostMask(maskEditor()!)!;

function refresh() {
  const ed = maskEditor();
  if (!ed) return;
  updateHandles(mask(), aspectOf(ed));
  app.changed('doc');
  ed.draw();
  ed.drawUI();
}

/** Mask-space position (0..1, y up) under the pointer. */
function pointerAt(): V {
  const ed = maskEditor()!;
  const r = ed.canvas.getBoundingClientRect();
  return s2m(ed, app.pointer.x - r.left, app.pointer.y - r.top);
}

function nearestPoint(m: MaskData, at: V): { point: MaskPoint; dist: number } | null {
  const ed = maskEditor()!;
  const s = m2s(ed, at);
  let best: MaskPoint | null = null,
    bd = Infinity;
  for (const { point } of allPoints(m)) {
    const q = m2s(ed, point.co);
    const d = Math.hypot(q[0] - s[0], q[1] - s[1]);
    if (d < bd) ((bd = d), (best = point));
  }
  return best ? { point: best, dist: bd } : null;
}

/** Add a point: on a curve near `at`, at the selected end of the active open spline, or a new spline. */
export function addVertexAt(m: MaskData, at: V, aspect: number): MaskPoint | null {
  const layer = activeLayer(m);
  if (!layer || layer.hide || layer.hide_select) return null;
  const ed = maskEditor();
  const s = ed ? m2s(ed, at) : null;
  const seg = ed && s ? hitSegment(ed, s[0], s[1], 6, [layer]) : null;
  let pt: MaskPoint;
  if (seg) {
    pt = insertPoint(seg.spline, seg.seg, seg.t);
    layer.active_spline = layer.splines.indexOf(seg.spline);
  } else {
    let sp = layer.splines[layer.active_spline];
    const ends = sp && !sp.use_cyclic && sp.points.length ? [...new Set([sp.points[0], sp.points[sp.points.length - 1]])] : [];
    const sel = ends.filter((q) => q.select);
    pt = newPoint(at[0], at[1], 'AUTO');
    if (sp && sel.length === 1) {
      if (sel[0] === sp.points[0] && sp.points.length > 1) sp.points.unshift(pt);
      else sp.points.push(pt);
    } else {
      sp = { points: [pt], use_cyclic: false, use_fill: true };
      layer.splines.push(sp);
      layer.active_spline = layer.splines.length - 1;
    }
    recalcHandles(sp, aspect);
  }
  deselectAll(m);
  pt.select = true;
  return pt;
}

const locProp = { id: 'location', label: 'Location', type: 'vec2' as const, default: [0, 0] };

function shapeKeyPointMask(layer: MaskLayer): boolean[] {
  return layer.splines.flatMap((s) => s.points.map((p) => p.select && !p.hide));
}

registerOperators([
  {
    idname: 'mask.select',
    label: 'Select',
    description: 'Select the mask point nearest to a position',
    props: [
      locProp,
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'deselect', label: 'Deselect', type: 'bool', default: false },
      { id: 'toggle', label: 'Toggle', type: 'bool', default: false },
      { id: 'deselect_all', label: 'Deselect On Nothing', type: 'bool', default: false },
    ],
    poll: editing,
    invoke: (ctx, p) => {
      p.location = pointerAt();
      return selectExec(ctx, p);
    },
    exec: (ctx, p) => selectExec(ctx, p),
  },
  {
    idname: 'mask.add_vertex',
    label: 'Add Vertex',
    description: 'Add a point: on the curve under the position, after the selected end of the active spline, or as a new spline',
    props: [locProp],
    poll: editing,
    invoke: (_ctx, p) => {
      p.location = pointerAt();
      return addVertexExec(p);
    },
    exec: (_ctx, p) => addVertexExec(p),
  },
  {
    idname: 'mask.add_vertex_slide',
    label: 'Add Vertex and Slide',
    description: 'Add a point under the mouse and move it',
    poll: editing,
    invoke: (ctx) => {
      if (addVertexExec({ location: pointerAt() }) === 'CANCELLED') return 'CANCELLED';
      app.pushUndo('Add Vertex');
      return app.run('mask.transform', { mode: 'TRANSLATE' }, { area: ctx.area });
    },
  },
  {
    idname: 'mask.add_feather_vertex',
    label: 'Add Feather Vertex',
    description: 'Set the feather of the point nearest to a position so the feather reaches it',
    props: [locProp],
    poll: editing,
    invoke: (_ctx, p) => {
      p.location = pointerAt();
      return featherExec(p);
    },
    exec: (_ctx, p) => featherExec(p),
  },
  {
    idname: 'mask.add_feather_vertex_slide',
    label: 'Add Feather Vertex and Slide',
    description: 'Select the point under the mouse and drag its feather width',
    poll: editing,
    invoke: (ctx) => {
      const m = mask();
      const n = nearestPoint(m, pointerAt());
      if (!n) return 'CANCELLED';
      deselectAll(m);
      n.point.select = true;
      refresh();
      return app.run('mask.transform', { mode: 'FEATHER' }, { area: ctx.area });
    },
  },
  {
    idname: 'mask.slide_point',
    label: 'Slide Point',
    description: 'Move the selected mask points (offset in frame units)',
    props: [{ id: 'offset', label: 'Offset', type: 'vec2', default: [0, 0] }],
    poll: () => editing() && selectedPoints(mask()).length > 0,
    invoke: (ctx) => app.run('mask.transform', { mode: 'TRANSLATE' }, { area: ctx.area }),
    exec: (_ctx, p) => {
      const d = p.offset as V;
      for (const { point: q } of selectedPoints(mask())) {
        q.co = [q.co[0] + d[0], q.co[1] + d[1]];
        q.handle_left = [q.handle_left[0] + d[0], q.handle_left[1] + d[1]];
        q.handle_right = [q.handle_right[0] + d[0], q.handle_right[1] + d[1]];
      }
      refresh();
    },
  },
  {
    idname: 'mask.slide_spline_curvature',
    label: 'Slide Spline Curvature',
    description: 'Bend the curve segment under the mouse by dragging it',
    poll: editing,
    invoke: () => {
      const ed = maskEditor()!;
      const m = mask();
      const r = ed.canvas.getBoundingClientRect();
      const x0 = app.pointer.x - r.left,
        y0 = app.pointer.y - r.top;
      const hit = hitSegment(ed, x0, y0, 8);
      if (!hit) return 'CANCELLED';
      const aspect = aspectOf(ed);
      const sp = hit.spline;
      const a = sp.points[hit.seg],
        b = sp.points[(hit.seg + 1) % sp.points.length];
      const orig = { ar: [...a.handle_right] as V, bl: [...b.handle_left] as V, at: a.handle_type, bt: b.handle_type };
      const m0 = s2m(ed, x0, y0);
      const t = Math.min(0.9, Math.max(0.1, hit.t));
      const wa = 3 * (1 - t) * (1 - t) * t,
        wb = 3 * (1 - t) * t * t;
      const k = 1 / (wa * wa + wb * wb);
      app.startModal({
        label: 'Slide Spline Curvature',
        onPointerMove: (e) => {
          const mm = s2m(ed, e.clientX - r.left, e.clientY - r.top);
          const d: V = [mm[0] - m0[0], mm[1] - m0[1]];
          if (a.handle_type === 'AUTO' || a.handle_type === 'VECTOR') a.handle_type = 'ALIGNED';
          if (b.handle_type === 'AUTO' || b.handle_type === 'VECTOR') b.handle_type = 'ALIGNED';
          a.handle_right = [orig.ar[0] + d[0] * wa * k, orig.ar[1] + d[1] * wa * k];
          b.handle_left = [orig.bl[0] + d[0] * wb * k, orig.bl[1] + d[1] * wb * k];
          updateHandles(m, aspect);
          app.changed('doc');
          ed.draw();
        },
        onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : 'FINISHED'),
        onPointerUp: () => 'FINISHED',
        onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Escape' ? 'CANCELLED' : e.key === 'Enter' ? 'FINISHED' : true),
        cancel: () => {
          a.handle_right = orig.ar;
          b.handle_left = orig.bl;
          a.handle_type = orig.at;
          b.handle_type = orig.bt;
          app.changed('doc');
          ed.draw();
        },
      });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'mask.shape_key_feather_reset',
    label: 'Feather Reset Animation',
    description: "Set the feather of the selected points in every shape key to the points' current feather",
    poll: () => editing() && mask().layers.some((l) => l.shape_keys.length),
    exec: () => {
      let n = 0;
      for (const layer of mask().layers) {
        const sel = shapeKeyPointMask(layer);
        const cur = layerData(layer);
        for (const key of layer.shape_keys) {
          if (key.data.length !== cur.length) continue;
          sel.forEach((s, i) => {
            if (s) ((key.data[i * 7 + 6] = cur[i * 7 + 6]), n++);
          });
        }
      }
      if (!n) return 'CANCELLED';
      refresh();
    },
  },
  {
    idname: 'mask.shape_key_rekey',
    label: 'Re-Key Points of Selected Shapes',
    description: 'Store the current location and / or feather of the selected points in every shape key; keys from before a change of the point count are rebuilt from the current shape',
    props: [
      { id: 'location', label: 'Location', type: 'bool', default: true },
      { id: 'feather', label: 'Feather', type: 'bool', default: true },
    ],
    poll: () => editing() && mask().layers.some((l) => l.shape_keys.length),
    exec: (_ctx, p) => {
      for (const layer of mask().layers) {
        const sel = shapeKeyPointMask(layer);
        const cur = layerData(layer);
        for (const key of layer.shape_keys) {
          if (key.data.length !== cur.length) {
            key.data = [...cur];
            continue;
          }
          sel.forEach((s, i) => {
            if (!s) return;
            if (p.location) for (let j = 0; j < 6; j++) key.data[i * 7 + j] = cur[i * 7 + j];
            if (p.feather) key.data[i * 7 + 6] = cur[i * 7 + 6];
          });
        }
      }
      refresh();
    },
  },
]);

function selectExec(_ctx: OpContext, p: Record<string, unknown>) {
  const m = mask();
  const n = nearestPoint(m, p.location as V);
  if (!n || n.dist > 12) {
    if (p.deselect_all) {
      deselectAll(m);
      refresh();
      return 'FINISHED';
    }
    return 'CANCELLED';
  }
  if (p.deselect) n.point.select = false;
  else if (p.toggle) n.point.select = !n.point.select;
  else {
    if (!p.extend) deselectAll(m);
    n.point.select = true;
  }
  refresh();
  return 'FINISHED';
}

function addVertexExec(p: Record<string, unknown>) {
  const ed = maskEditor()!;
  const pt = addVertexAt(mask(), p.location as V, aspectOf(ed));
  if (!pt) return 'CANCELLED';
  refresh();
  return 'FINISHED';
}

function featherExec(p: Record<string, unknown>) {
  const ed = maskEditor()!;
  const m = mask();
  const at = p.location as V;
  const n = nearestPoint(m, at);
  if (!n) return 'CANCELLED';
  const aspect = aspectOf(ed);
  n.point.weight = Math.hypot((at[0] - n.point.co[0]) * aspect, at[1] - n.point.co[1]) / aspect;
  refresh();
  return 'FINISHED';
}
