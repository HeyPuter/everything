// Draw Mode tools: Draw (pressure-sensitive strokes, Ctrl = erase), Erase (Point / Stroke /
// Dissolve), Tint, Fill (2D flood fill of closed regions) and the primitives (Line, Polyline,
// Arc, Box, Circle).
import { Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { activeTools } from '../app/prefs';
import { editModeHooks } from '../editors/view3d/hooks';
import type { View3D } from '../editors/view3d/view3d';
import { activeView3D } from '../editors/view3d/view3d';
import { runStroke } from '../paint/stroke';
import { h } from '../ui/h';
import { renderContext } from '../render/context';
import type { ObjectData } from '../data/types';
import { gpOf, gpTS, gpBrush, activeLayer, frameAt, setKeyframe, emptyDrawing, copyDrawing, toStrokes, fromStrokes, newStroke, slotStyle, type GPPoint, type GPStroke } from './data';
import { eraseHard, eraseSoft, eraseStrokes, type ScreenFn } from './erase';
import { Placement } from './placement';
import { setStrokePreview, layerMatrix } from './render';
import { smoothPoints } from './strokeops';
import { fillRegion } from './fill';
import type { GPBrush, GPLayer, GreasePencilData } from './types';

export const inDrawMode = () => app.doc.mode === 'PAINT_GREASE_PENCIL' && !!gpOf(app.doc, app.activeObject);

export function drawContext(): {
  ob: ObjectData;
  gp: GreasePencilData;
  layer: GPLayer | null;
} | null {
  const ob = app.activeObject;
  const gp = gpOf(app.doc, ob);
  if (!ob || !gp) return null;
  return { ob, gp, layer: activeLayer(gp) };
}

/**
 * Index of the drawing to modify on `layer` at the current frame. Keyframe rules:
 * no key yet → a new blank key; with auto keying, drawing on a held frame inserts a
 * new key (a copy of the held drawing when `copy` or additive drawing is on).
 */
export function editableDrawing(gp: GreasePencilData, layer: GPLayer, frame: number, copy: boolean): number {
  const doc = app.doc;
  const cur = frameAt(layer, frame);
  if (!cur) return setKeyframe(gp, layer, frame, emptyDrawing(), doc.scene.tool_settings.keyframe_type).drawing;
  if (cur.frame_number !== frame && doc.scene.tool_settings.use_keyframe_insert_auto) {
    const additive = copy || gpTS(doc).use_gpencil_draw_additive;
    return setKeyframe(gp, layer, frame, additive ? copyDrawing(gp.drawings[cur.drawing]) : emptyDrawing(), doc.scene.tool_settings.keyframe_type).drawing;
  }
  return cur.drawing;
}

function checkLayer(layer: GPLayer | null): layer is GPLayer {
  if (!layer) {
    app.report('ERROR', 'No active layer');
    return false;
  }
  if (layer.lock) {
    app.report('ERROR', 'Active layer is locked');
    return false;
  }
  if (layer.hide) {
    app.report('ERROR', 'Active layer is hidden');
    return false;
  }
  return true;
}

const pressureOf = (b: GPBrush, p: number) => ({
  size: b.use_pressure_size ? p : 1,
  strength: b.use_pressure_strength ? p : 1,
});

/** Screen projection for the points of a layer drawing. */
export function layerScreen(v: View3D, ob: ObjectData, layer: GPLayer): ScreenFn {
  const m = (app.graph.get(ob.id)?.world.clone() ?? undefined)?.multiply(layerMatrix(layer));
  const p = new Vector3();
  return (pt: GPPoint) => {
    p.set(pt.co[0], pt.co[1], pt.co[2]);
    if (m) p.applyMatrix4(m);
    const s = v.project(p);
    return [s.x, s.y];
  };
}

// ---------------------------------------------------------------------------
// Draw

interface Sample {
  x: number;
  y: number;
  pressure: number;
}

export function samplesToPoints(pl: Placement, samples: Sample[], b: GPBrush, brushColor: [number, number, number] | null): GPPoint[] {
  const sc = pl.scale();
  const out: GPPoint[] = [];
  for (const s of samples) {
    const w = pl.project(s.x, s.y);
    if (!w) continue;
    const pr = pressureOf(b, s.pressure);
    const radius = ((b.size / 2) * pr.size * pl.pixelSize(w)) / sc;
    out.push({
      co: pl.toLocal(w),
      radius: Math.max(1e-5, radius),
      opacity: Math.max(0, Math.min(1, b.strength * pr.strength)),
      vertex_color: brushColor ? [brushColor[0], brushColor[1], brushColor[2], 1] : [0, 0, 0, 0],
    });
  }
  return out;
}

function brushColorFor(b: GPBrush): [number, number, number] | null {
  return b.color_mode === 'VERTEXCOLOR' && b.color ? [b.color[0], b.color[1], b.color[2]] : null;
}

function commitStroke(c: NonNullable<ReturnType<typeof drawContext>>, stroke: GPStroke, onBack = gpTS(app.doc).use_gpencil_draw_onback, label = 'Grease Pencil Draw') {
  const frame = app.doc.scene.frame_current;
  const idx = editableDrawing(c.gp, c.layer!, frame, false);
  const strokes = toStrokes(c.gp.drawings[idx]);
  if (onBack) strokes.unshift(stroke);
  else strokes.push(stroke);
  c.gp.drawings[idx] = fromStrokes(strokes);
  app.pushUndo(label);
  app.changed('doc');
}

function materialUsable(c: NonNullable<ReturnType<typeof drawContext>>): boolean {
  const st = slotStyle(app.doc, c.gp, c.ob.active_material_index);
  if (st?.lock) {
    app.report('ERROR', 'Active material is locked');
    return false;
  }
  if (st?.hide) {
    app.report('ERROR', 'Active material is hidden');
    return false;
  }
  return true;
}

function startDraw(v: View3D, e: PointerEvent) {
  const c = drawContext();
  if (!c || !checkLayer(c.layer) || !materialUsable(c)) return;
  const b = gpBrush(app.doc, 'builtin.brush.Draw');
  const pl = new Placement(v, c.ob, c.gp, c.layer);
  const samples: Sample[] = [];
  const mat = Math.min(c.ob.active_material_index, Math.max(0, c.gp.materials.length - 1));
  const color = brushColorFor(b);
  const build = () => newStroke(samplesToPoints(pl, samples, b, color), { material_index: mat });
  runStroke(v, e, {
    spacing: () => 0,
    radiusPx: () => b.size / 2,
    dab: (d) => {
      const last = samples[samples.length - 1];
      if (last && Math.hypot(d.x - last.x, d.y - last.y) < 1.5) return;
      samples.push({ x: d.x, y: d.y, pressure: d.pressure });
    },
    update: () => setStrokePreview(c.ob.id, fromStrokes([build()]), c.layer),
    end: () => {
      setStrokePreview(null, null);
      const st = build();
      if (!st.points.length) return;
      const steps = b.pen_smooth_steps ?? 1,
        f = b.pen_smooth_factor ?? 0;
      if (f > 0 && st.points.length > 2)
        st.points = smoothPoints(st.points, f, steps, false, {
          position: true,
          radius: false,
          opacity: false,
        });
      commitStroke(c, st);
    },
  });
}

// ---------------------------------------------------------------------------
// Erase

function eraseDab(v: View3D, x: number, y: number, pressure: number, b: GPBrush, touched: Map<GPLayer, number>) {
  const c = drawContext();
  if (!c) return;
  const frame = app.doc.scene.frame_current;
  const r = b.size / 2;
  const doc = app.doc;
  const locked = new Set<number>();
  c.gp.materials.forEach((id, i) => id && doc.materials[id]?.grease_pencil?.lock && locked.add(i));
  for (const layer of c.gp.layers) {
    if (layer.lock || layer.hide) continue;
    const fr = frameAt(layer, frame);
    if (!fr) continue;
    const src = c.gp.drawings[touched.get(layer) ?? fr.drawing];
    const all = toStrokes(src);
    const screen = layerScreen(v, c.ob, layer);
    const mode = b.eraser_mode ?? 'HARD';
    const strength = b.strength * (b.use_pressure_strength ? pressure : 1) * 0.5;
    // strokes with a locked material are kept; the rest are erased in place (order preserved)
    const out: GPStroke[] = [];
    let changed = false;
    for (const st of all) {
      if (locked.has(st.material_index)) {
        out.push(st);
        continue;
      }
      const res = mode === 'STROKE' ? eraseStrokes([st], screen, x, y, r) : mode === 'SOFT' ? eraseSoft([st], screen, x, y, r, strength) : eraseHard([st], screen, x, y, r);
      if (res.changed) changed = true;
      out.push(...res.strokes);
    }
    if (!changed) continue;
    let idx = touched.get(layer);
    if (idx === undefined) {
      idx = editableDrawing(c.gp, layer, frame, true);
      touched.set(layer, idx);
    }
    c.gp.drawings[idx] = fromStrokes(out);
  }
  app.changed('doc');
}

function startErase(v: View3D, e: PointerEvent) {
  const b = gpBrush(app.doc, 'builtin.brush.Erase');
  const touched = new Map<GPLayer, number>();
  runStroke(v, e, {
    spacing: () => 25,
    radiusPx: () => b.size / 2,
    dab: (d) => eraseDab(v, d.x, d.y, d.pressure, b, touched),
    end: () => {
      if (touched.size) app.pushUndo('Grease Pencil Erase');
    },
  });
}

// ---------------------------------------------------------------------------
// Tint

function startTint(v: View3D, e: PointerEvent) {
  const c = drawContext();
  if (!c) return;
  const b = gpBrush(app.doc, 'builtin.brush.Tint');
  const col = b.color ?? [1, 0, 0];
  const frame = app.doc.scene.frame_current;
  const touched = new Map<GPLayer, number>();
  const r = b.size / 2;
  runStroke(v, e, {
    spacing: () => 20,
    radiusPx: () => r,
    dab: (d) => {
      for (const layer of c.gp.layers) {
        if (layer.lock || layer.hide) continue;
        const fr = frameAt(layer, frame);
        if (!fr) continue;
        const screen = layerScreen(v, c.ob, layer);
        let idx = touched.get(layer) ?? fr.drawing;
        const dr = c.gp.drawings[idx];
        const n = dr.position.length / 3;
        const hits: [number, number][] = [];
        const pt: GPPoint = {
          co: [0, 0, 0],
          radius: 0,
          opacity: 0,
          vertex_color: [0, 0, 0, 0],
        };
        for (let i = 0; i < n; i++) {
          pt.co = [dr.position[i * 3], dr.position[i * 3 + 1], dr.position[i * 3 + 2]];
          const [sx, sy] = screen(pt);
          const dd = Math.hypot(sx - d.x, sy - d.y) / r;
          if (dd < 1) hits.push([i, 1 - dd * dd * (3 - 2 * dd)]);
        }
        if (!hits.length) continue;
        if (!touched.has(layer)) {
          idx = editableDrawing(c.gp, layer, frame, true);
          touched.set(layer, idx);
          const t = c.gp.drawings[idx];
          t.vertex_color = t.vertex_color.slice();
          t.fill_color = t.fill_color.slice();
        }
        const t = c.gp.drawings[idx];
        const s0 = b.strength * (b.use_pressure_strength ? d.pressure : 1) * 0.25;
        const mode = b.vertex_mode ?? 'BOTH';
        const strokesHit = new Set<number>();
        for (const [i, f] of hits) {
          const s = s0 * f;
          if (mode !== 'FILL') {
            for (let k = 0; k < 3; k++) t.vertex_color[i * 4 + k] += (col[k] - t.vertex_color[i * 4 + k]) * s;
            t.vertex_color[i * 4 + 3] += (1 - t.vertex_color[i * 4 + 3]) * s;
          }
          // stroke of point i
          let lo = 0,
            hi = t.offsets.length - 2;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (t.offsets[mid] <= i) lo = mid;
            else hi = mid - 1;
          }
          strokesHit.add(lo);
        }
        if (mode !== 'STROKE')
          for (const sIdx of strokesHit) {
            for (let k = 0; k < 3; k++) t.fill_color[sIdx * 4 + k] += (col[k] - t.fill_color[sIdx * 4 + k]) * s0;
            t.fill_color[sIdx * 4 + 3] += (1 - t.fill_color[sIdx * 4 + 3]) * s0;
          }
        // new array identities so the GPU cache rebuilds
        t.vertex_color = t.vertex_color.slice();
        t.fill_color = t.fill_color.slice();
      }
      app.changed('doc');
    },
    end: () => {
      if (touched.size) app.pushUndo('Grease Pencil Tint');
    },
  });
}

// ---------------------------------------------------------------------------
// Fill

function doFill(v: View3D, x: number, y: number) {
  const c = drawContext();
  if (!c || !checkLayer(c.layer) || !materialUsable(c)) return;
  const b = gpBrush(app.doc, 'builtin.brush.Fill');
  const res = fillRegion(v, c.ob, c.gp, c.layer!, x, y, b);
  if (typeof res === 'string') {
    app.report('WARNING', res);
    return;
  }
  const frame = app.doc.scene.frame_current;
  const idx = editableDrawing(c.gp, c.layer!, frame, false);
  const strokes = toStrokes(c.gp.drawings[idx]);
  const fid = Math.max(0, ...strokes.map((s) => s.fill_id)) + 1;
  const mat = Math.min(c.ob.active_material_index, Math.max(0, c.gp.materials.length - 1));
  const color = brushColorFor(b);
  const created = res.map((pts) =>
    newStroke(
      pts.map((p) => ({
        ...p,
        vertex_color: color ? [color[0], color[1], color[2], 1] : [0, 0, 0, 0],
      })),
      {
        cyclic: true,
        material_index: mat,
        fill_id: res.length > 1 ? fid : 0,
        fill_color: color ? [color[0], color[1], color[2], 1] : [0, 0, 0, 0],
      },
    ),
  );
  // fills go behind the existing strokes of the layer
  c.gp.drawings[idx] = fromStrokes([...created, ...strokes]);
  app.pushUndo('Grease Pencil Fill');
  app.changed('doc');
}

// ---------------------------------------------------------------------------
// Primitives (modal: drag for line / arc / box / circle; click points for polyline)

type PrimType = 'LINE' | 'POLYLINE' | 'ARC' | 'BOX' | 'CIRCLE';

export function primitivePoints(type: PrimType, pts: { x: number; y: number }[], subdiv: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const seg = (a: { x: number; y: number }, b: { x: number; y: number }, n: number, incEnd: boolean) => {
    for (let i = 0; i <= n; i++) {
      if (i === n && !incEnd) break;
      const t = i / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  };
  const n = Math.max(1, subdiv + 1);
  if (type === 'LINE' || type === 'POLYLINE') {
    for (let k = 0; k + 1 < pts.length; k++) seg(pts[k], pts[k + 1], n, k === pts.length - 2);
    if (pts.length === 1) out.push(pts[0]);
    return out;
  }
  const [a, b] = [pts[0], pts[pts.length - 1]];
  if (type === 'BOX') {
    const c = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    for (let k = 0; k < 4; k++) seg(c[k], c[(k + 1) % 4], n, false);
    return out;
  }
  if (type === 'CIRCLE') {
    const cx = (a.x + b.x) / 2,
      cy = (a.y + b.y) / 2,
      rx = Math.abs(b.x - a.x) / 2,
      ry = Math.abs(b.y - a.y) / 2;
    const N = Math.max(8, subdiv);
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      out.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
    }
    return out;
  }
  // ARC: quarter ellipse from a to b bulging away from the corner (b.x, a.y)
  const N = Math.max(4, subdiv);
  const cx = a.x,
    cy = b.y;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * (Math.PI / 2);
    out.push({
      x: cx + (b.x - a.x) * Math.sin(t),
      y: cy + (a.y - b.y) * Math.cos(t),
    });
  }
  return out;
}

const PRIM_TOOLS: Record<string, PrimType> = {
  'builtin.line': 'LINE',
  'builtin.polyline': 'POLYLINE',
  'builtin.arc': 'ARC',
  'builtin.box': 'BOX',
  'builtin.circle': 'CIRCLE',
};

function startPrimitive(v: View3D, e: PointerEvent, tool: string) {
  const c = drawContext();
  if (!c || !checkLayer(c.layer) || !materialUsable(c)) return;
  const type = PRIM_TOOLS[tool];
  const b = gpBrush(app.doc, tool);
  const pl = new Placement(v, c.ob, c.gp, c.layer);
  const p0 = v.local(e);
  const pts: { x: number; y: number }[] = [p0, { ...p0 }];
  const mat = Math.min(c.ob.active_material_index, Math.max(0, c.gp.materials.length - 1));
  const color = brushColorFor(gpBrush(app.doc, 'builtin.brush.Draw'));
  const build = (): GPStroke => {
    let ps = pts;
    if (type !== 'POLYLINE') {
      const a = pts[0];
      let bb = pts[pts.length - 1];
      if (shift && (type === 'BOX' || type === 'CIRCLE')) {
        const d = Math.max(Math.abs(bb.x - a.x), Math.abs(bb.y - a.y));
        bb = {
          x: a.x + Math.sign(bb.x - a.x || 1) * d,
          y: a.y + Math.sign(bb.y - a.y || 1) * d,
        };
      }
      ps = alt && type !== 'LINE' && type !== 'ARC' ? [{ x: 2 * a.x - bb.x, y: 2 * a.y - bb.y }, bb] : [a, bb];
    }
    const sp = primitivePoints(type, ps, b.subdivision ?? 6).map((p) => ({
      ...p,
      pressure: 1,
    }));
    return newStroke(samplesToPoints(pl, sp, b, color), {
      material_index: mat,
      cyclic: type === 'BOX' || type === 'CIRCLE',
    });
  };
  let shift = e.shiftKey,
    alt = e.altKey;
  const update = () => setStrokePreview(c.ob.id, fromStrokes([build()]), c.layer);
  const finish = () => {
    setStrokePreview(null, null);
    const st = build();
    if (st.points.length < 2) return 'CANCELLED' as const;
    const frame = app.doc.scene.frame_current;
    const idx = editableDrawing(c.gp, c.layer!, frame, false);
    const strokes = toStrokes(c.gp.drawings[idx]);
    strokes.push(st);
    c.gp.drawings[idx] = fromStrokes(strokes);
    return 'FINISHED' as const;
  };
  update();
  app.startModal({
    label: `Grease Pencil ${type[0] + type.slice(1).toLowerCase()}`,
    cursor: 'crosshair',
    onPointerMove: (ev) => {
      shift = ev.shiftKey;
      alt = ev.altKey;
      pts[pts.length - 1] = v.local(ev);
      update();
    },
    onPointerUp: () => {
      if (type === 'POLYLINE') return;
      const a = pts[0],
        bb = pts[pts.length - 1];
      if (Math.hypot(bb.x - a.x, bb.y - a.y) < 3) {
        setStrokePreview(null, null);
        return 'CANCELLED';
      }
      return finish();
    },
    onPointerDown: (ev) => {
      if (type !== 'POLYLINE') return;
      if (ev.button === 2) {
        pts.pop();
        return pts.length >= 2 ? finish() : (setStrokePreview(null, null), 'CANCELLED');
      }
      const q = v.local(ev);
      const prev = pts[pts.length - 2];
      // double click on the last point finishes
      if (prev && Math.hypot(q.x - prev.x, q.y - prev.y) < 4) {
        pts.pop();
        return finish();
      }
      pts[pts.length - 1] = q;
      pts.push({ ...q });
      update();
    },
    onKey: (ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.key === 'Escape') return 'CANCELLED';
      if (ev.key === 'Enter' || ev.key === ' ') {
        if (type === 'POLYLINE') pts.pop();
        return finish();
      }
      return true;
    },
    cancel: () => setStrokePreview(null, null),
    header: () =>
      type === 'POLYLINE'
        ? 'Polyline: click to add points, Enter / right click / double click to confirm, Esc to cancel'
        : `${type[0] + type.slice(1).toLowerCase()}: drag to size (Shift: square, Alt: from center), Esc to cancel`,
  });
}

// ---------------------------------------------------------------------------
// pointer dispatch & cursor

const cursor = { x: 0, y: 0, inside: false, view: null as View3D | null };

editModeHooks.pointer.unshift((v, e) => {
  if (!inDrawMode() || e.button !== 0) return false;
  const tool = activeTools[app.doc.mode] ?? 'builtin.brush.Draw';
  if (tool === 'builtin.brush.Draw') {
    if (e.ctrlKey) startErase(v, e);
    else startDraw(v, e);
    return true;
  }
  if (tool === 'builtin.brush.Erase') {
    startErase(v, e);
    return true;
  }
  if (tool === 'builtin.brush.Tint') {
    startTint(v, e);
    return true;
  }
  if (tool === 'builtin.brush.Fill') {
    const p = v.local(e);
    doFill(v, p.x, p.y);
    return true;
  }
  if (PRIM_TOOLS[tool]) {
    startPrimitive(v, e, tool);
    return true;
  }
  return false;
});

editModeHooks.hover.push((v, e) => {
  if (!inDrawMode() && app.doc.mode !== 'SCULPT_GREASE_PENCIL') return;
  const p = v.local(e);
  cursor.x = p.x;
  cursor.y = p.y;
  cursor.inside = true;
  cursor.view = v;
  v.drawSvg();
});

/** Brush radius in px for the cursor ring of the active tool (null = no ring). */
export const cursorRadius: { fn: (tool: string) => number | null } = {
  fn: (tool) => {
    if (tool === 'builtin.brush.Draw') return gpBrush(app.doc, tool).size / 2;
    if (tool === 'builtin.brush.Erase' || tool === 'builtin.brush.Tint') return gpBrush(app.doc, tool).size / 2;
    return null;
  },
};

editModeHooks.svg.push((v) => {
  const mode = app.doc.mode;
  if ((mode !== 'PAINT_GREASE_PENCIL' && mode !== 'SCULPT_GREASE_PENCIL') || !cursor.inside || cursor.view !== v || app.modal) return null;
  const tool = activeTools[mode] ?? '';
  const r = cursorRadius.fn(tool);
  if (r === null) return null;
  const col = tool === 'builtin.brush.Erase' ? 'rgba(255,120,120,0.95)' : 'rgba(255,255,255,0.9)';
  return h(
    'g',
    { key: 'gp-cursor', 'pointer-events': 'none' },
    h('circle', {
      cx: cursor.x,
      cy: cursor.y,
      r: Math.max(1, r),
      fill: 'none',
      stroke: 'rgba(0,0,0,0.4)',
      'stroke-width': 3,
    }),
    h('circle', {
      cx: cursor.x,
      cy: cursor.y,
      r: Math.max(1, r),
      fill: 'none',
      stroke: col,
      'stroke-width': 1.2,
    }),
  );
});

addEventListener('pointerleave', () => (cursor.inside = false));

// ---------------------------------------------------------------------------
// scripted / testing entry points (stroke from a list of viewport points)

registerOperators([
  {
    idname: 'grease_pencil.draw_points',
    label: 'Draw Stroke',
    description: 'Draw a stroke through viewport points (x, y, pressure triples) with the Draw brush',
    internal: true,
    props: [
      {
        id: 'points',
        label: 'Points',
        type: 'string',
        default: '[]',
        hidden: true,
      },
    ],
    poll: () => inDrawMode(),
    exec: (_ctx, p) => {
      const c = drawContext();
      const v = activeView3D();
      if (!c || !v || !checkLayer(c.layer)) return 'CANCELLED';
      const raw = JSON.parse(p.points as string) as number[][];
      const b = gpBrush(app.doc, 'builtin.brush.Draw');
      const pl = new Placement(v, c.ob, c.gp, c.layer);
      const st = newStroke(
        samplesToPoints(
          pl,
          raw.map(([x, y, pr]) => ({ x, y, pressure: pr ?? 1 })),
          b,
          brushColorFor(b),
        ),
        {
          material_index: Math.min(c.ob.active_material_index, Math.max(0, c.gp.materials.length - 1)),
        },
      );
      const frame = app.doc.scene.frame_current;
      const idx = editableDrawing(c.gp, c.layer!, frame, false);
      const strokes = toStrokes(c.gp.drawings[idx]);
      strokes.push(st);
      c.gp.drawings[idx] = fromStrokes(strokes);
    },
  },
  {
    idname: 'grease_pencil.fill',
    label: 'Grease Pencil Fill',
    description: 'Fill the closed region under a viewport point',
    props: [
      { id: 'x', label: 'X', type: 'float', default: 0, hidden: true },
      { id: 'y', label: 'Y', type: 'float', default: 0, hidden: true },
    ],
    poll: () => inDrawMode(),
    exec: (_ctx, p) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      doFill(v, p.x as number, p.y as number);
      return 'CANCELLED'; // doFill pushes its own undo step
    },
  },
]);

export { renderContext };
