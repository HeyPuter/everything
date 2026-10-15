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
import { smoothPoints, simplifyPoints, subdivideStroke } from './strokeops';
import { stabilize, trimEnds, noise, type Sample } from './drawproc';
import { startSculpt } from './sculpt';
import { fillRegion } from './fill';
import type { GPBrush, GPLayer, GreasePencilData } from './types';

/** Primitive tools → their operators (see primitives.ts). */
export const PRIM_OPS: Record<string, string> = {
  'builtin.line': 'grease_pencil.primitive_line',
  'builtin.polyline': 'grease_pencil.primitive_polyline',
  'builtin.arc': 'grease_pencil.primitive_arc',
  'builtin.curve': 'grease_pencil.primitive_curve',
  'builtin.box': 'grease_pencil.primitive_box',
  'builtin.circle': 'grease_pencil.primitive_circle',
};

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

export function checkLayer(layer: GPLayer | null): layer is GPLayer {
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

export function samplesToPoints(pl: Placement, samples: Sample[], b: GPBrush, brushColor: [number, number, number] | null, seed = 0): GPPoint[] {
  const sc = pl.scale();
  const out: GPPoint[] = [];
  const rnd = !!b.use_settings_random;
  samples.forEach((s0, i) => {
    let s = s0;
    if (rnd && b.pen_jitter) {
      // jitter across the stroke direction
      const a = samples[Math.max(0, i - 1)],
        c = samples[Math.min(samples.length - 1, i + 1)];
      const dx = c.x - a.x,
        dy = c.y - a.y,
        l = Math.hypot(dx, dy) || 1;
      const j = noise(seed, i * 3) * b.pen_jitter * (b.size / 2);
      s = { ...s0, x: s0.x - (dy / l) * j, y: s0.y + (dx / l) * j };
    }
    const w = pl.project(s.x, s.y);
    if (!w) return;
    const pr = pressureOf(b, s.pressure);
    let radius = ((b.size / 2) * pr.size * pl.pixelSize(w)) / sc;
    let opacity = b.strength * pr.strength;
    if (rnd) {
      radius *= Math.max(0.05, 1 + (b.random_pressure ?? 0) * noise(seed, i * 3 + 1));
      opacity *= Math.max(0, 1 + (b.random_strength ?? 0) * noise(seed, i * 3 + 2));
    }
    out.push({
      co: pl.toLocal(w),
      radius: Math.max(1e-5, radius),
      opacity: Math.max(0, Math.min(1, opacity)),
      vertex_color: brushColor ? [brushColor[0], brushColor[1], brushColor[2], 1] : [0, 0, 0, 0],
    });
  });
  return out;
}

/** Post-processing of a finished Draw stroke: trim, simplify (screen space), then smooth and subdivide. */
export function postProcess(samples: Sample[], b: GPBrush): Sample[] {
  if (b.use_settings_postprocess === false) return samples;
  let out = samples;
  if (b.use_trim) out = trimEnds(out);
  if ((b.simplify_factor ?? 0) > 0 && out.length > 2) {
    const pts = out.map((q) => ({ co: [q.x, q.y, 0] as [number, number, number], radius: q.pressure, opacity: 1, vertex_color: [0, 0, 0, 0] as [number, number, number, number] }));
    out = simplifyPoints(pts, (b.simplify_factor ?? 0) * 8).map((q) => ({ x: q.co[0], y: q.co[1], pressure: q.radius }));
  }
  return out;
}

export function brushColorFor(b: GPBrush): [number, number, number] | null {
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

export function materialUsable(c: NonNullable<ReturnType<typeof drawContext>>): boolean {
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

/** Live stabilizer state for the cursor overlay (lazy line from the drawing point to the pointer). */
export const lazy = { on: false, x: 0, y: 0, cx: 0, cy: 0, view: null as View3D | null };
let strokeSeed = 1;

function startDraw(v: View3D, e: PointerEvent) {
  const c = drawContext();
  if (!c || !checkLayer(c.layer) || !materialUsable(c)) return;
  const b = gpBrush(app.doc, 'builtin.brush.Draw');
  const pl = new Placement(v, c.ob, c.gp, c.layer);
  const samples: Sample[] = [];
  const mat = Math.min(c.ob.active_material_index, Math.max(0, c.gp.materials.length - 1));
  const color = brushColorFor(b);
  const seed = strokeSeed++;
  const build = (list = samples) => newStroke(samplesToPoints(pl, list, b, color, seed), { material_index: mat });
  const stab = !!b.use_smooth_stroke;
  const p0 = v.local(e);
  Object.assign(lazy, { on: stab, x: p0.x, y: p0.y, cx: p0.x, cy: p0.y, view: v });
  runStroke(v, e, {
    spacing: () => 0,
    radiusPx: () => b.size / 2,
    dab: (d) => {
      let q = { x: d.x, y: d.y };
      if (stab && samples.length) {
        q = stabilize({ x: lazy.x, y: lazy.y }, q, b.smooth_stroke_radius ?? 75, b.smooth_stroke_factor ?? 0.9);
        Object.assign(lazy, { x: q.x, y: q.y, cx: d.x, cy: d.y });
      }
      const last = samples[samples.length - 1];
      if (last && Math.hypot(q.x - last.x, q.y - last.y) < 1.5) return;
      samples.push({ x: q.x, y: q.y, pressure: d.pressure });
    },
    update: () => {
      setStrokePreview(c.ob.id, fromStrokes([build()]), c.layer);
      if (stab) v.drawSvg();
    },
    end: () => {
      lazy.on = false;
      setStrokePreview(null, null);
      const st = build(postProcess(samples, b));
      if (!st.points.length) return;
      const post = b.use_settings_postprocess !== false;
      const steps = b.pen_smooth_steps ?? 1,
        f = b.pen_smooth_factor ?? 0;
      if (post && f > 0 && st.points.length > 2)
        st.points = smoothPoints(st.points, f, steps, false, {
          position: true,
          radius: false,
          opacity: false,
        });
      let out = st;
      if (post) for (let k = 0; k < (b.pen_subdivision_steps ?? 0); k++) out = subdivideStroke(out, 1, false);
      commitStroke(c, out);
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
// pointer dispatch & cursor

const cursor = { x: 0, y: 0, inside: false, view: null as View3D | null };

editModeHooks.pointer.unshift((v, e) => {
  if (!inDrawMode() || e.button !== 0) return false;
  const tool = activeTools[app.doc.mode] ?? 'builtin.brush.Draw';
  if (tool === 'builtin.brush.Draw') {
    if (e.ctrlKey) startErase(v, e);
    else if (e.shiftKey) startSculpt(v, e, 'builtin.brush.Smooth');
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
  if (PRIM_OPS[tool]) {
    app.run(PRIM_OPS[tool], {}, { event: { x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey } });
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

// stabilizer: a lazy line from the drawing point to the pointer while drawing
editModeHooks.svg.push((v) => {
  if (!lazy.on || lazy.view !== v) return null;
  return h(
    'g',
    { key: 'gp-lazy', 'pointer-events': 'none' },
    h('line', { x1: lazy.x, y1: lazy.y, x2: lazy.cx, y2: lazy.cy, stroke: 'rgba(255,255,255,0.8)', 'stroke-width': 1.2, 'stroke-dasharray': '4 3' }),
    h('circle', { cx: lazy.x, cy: lazy.y, r: 2.5, fill: '#fff' }),
  );
});

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
