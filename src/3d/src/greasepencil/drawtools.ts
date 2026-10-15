// Draw Mode tools and operators beyond the brushes: Trim (cut strokes between their crossings
// with a lasso), Eyedropper (sample a color into a material or the brush), Interpolate (drag),
// box / lasso erase (B, Ctrl Alt right drag). Edit Mode tools: Extrude, Radius, Bend, Shear,
// To Sphere and Interpolate run their operator on a drag.
import { Vector3, Matrix4 } from 'three';
import { app, registerOperators, type ModalHandler } from '../app/app';
import { activeTools } from '../app/prefs';
import { addKeys } from '../app/keymap';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { toolSettingsRenderers, toolsByMode, type ToolDef } from '../editors/view3d/toolbar';
import { dragRegion } from '../ops/viewregions';
import { uniqueName } from '../ops/object';
import { h } from '../ui/h';
import { gpOf, gpBrush, gpTS, frameAt, toStrokes, fromStrokes, normalizeDrawing, newGPMaterial, type GPPoint, type GPStroke } from './data';
import { checkbox, enumMenu, numberField } from '../ui/widgets';
import { drawContext, editableDrawing } from './paint';
import { layerMatrix } from './render';
import { filterPoints } from './strokeops';
import { screenColor } from './brushops';
import { inGPEdit } from './edit';
import type { GPLayer } from './types';

type P2 = { x: number; y: number };

export function insidePolygon(x: number, y: number, P: P2[]): boolean {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) if (P[i].y > y !== P[j].y > y && x < ((P[j].x - P[i].x) * (y - P[i].y)) / (P[j].y - P[i].y) + P[i].x) c = !c;
  return c;
}

function segT(a: P2, b: P2, c: P2, d: P2): number | null {
  const rx = b.x - a.x,
    ry = b.y - a.y,
    sx = d.x - c.x,
    sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den,
    u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  return t > 1e-6 && t < 1 - 1e-6 && u >= 0 && u <= 1 ? t : null;
}

const lerpPt = (a: GPPoint, b: GPPoint, t: number): GPPoint => ({
  co: [a.co[0] + (b.co[0] - a.co[0]) * t, a.co[1] + (b.co[1] - a.co[1]) * t, a.co[2] + (b.co[2] - a.co[2]) * t],
  radius: a.radius + (b.radius - a.radius) * t,
  opacity: a.opacity + (b.opacity - a.opacity) * t,
  vertex_color: [0, 1, 2, 3].map((k) => a.vertex_color[k] + (b.vertex_color[k] - a.vertex_color[k]) * t) as GPPoint['vertex_color'],
});

/**
 * Trim: every stroke is cut where it crosses other strokes (screen space); the pieces touched by
 * the lasso are removed. `screen[s][i]` holds the screen position of point i of stroke s.
 */
export function trimStrokes(strokes: GPStroke[], screen: P2[][], lasso: P2[]): GPStroke[] | null {
  let changed = false;
  const out: GPStroke[] = [];
  const segsOf = (s: number) => {
    const P = screen[s];
    const n = P.length;
    const list: [P2, P2][] = [];
    for (let i = 0; i + 1 < n; i++) list.push([P[i], P[i + 1]]);
    if (strokes[s].cyclic && n > 2) list.push([P[n - 1], P[0]]);
    return list;
  };
  strokes.forEach((st, s) => {
    const P = screen[s];
    if (!P.some((p) => insidePolygon(p.x, p.y, lasso)) && !segsOf(s).some(([a, b]) => insidePolygon((a.x + b.x) / 2, (a.y + b.y) / 2, lasso))) {
      out.push(st);
      return;
    }
    // cut positions along this stroke: (segment index, t)
    const cuts: { i: number; t: number }[] = [];
    const mine = segsOf(s);
    strokes.forEach((_o, o) => {
      if (o === s) return;
      for (const [c, d] of segsOf(o))
        mine.forEach(([a, b], i) => {
          const t = segT(a, b, c, d);
          if (t !== null) cuts.push({ i, t });
        });
    });
    cuts.sort((p, q) => p.i - q.i || p.t - q.t);
    // walk the stroke building pieces (screen + data) between cuts
    const n = st.points.length;
    const segCount = mine.length;
    const pieces: { pts: GPPoint[]; scr: P2[] }[] = [{ pts: [st.points[0]], scr: [P[0]] }];
    let k = 0;
    for (let i = 0; i < segCount; i++) {
      const a = st.points[i],
        b = st.points[(i + 1) % n];
      while (k < cuts.length && cuts[k].i === i) {
        const t = cuts[k].t;
        const q = lerpPt(a, b, t);
        const qs = { x: P[i].x + (P[(i + 1) % n].x - P[i].x) * t, y: P[i].y + (P[(i + 1) % n].y - P[i].y) * t };
        pieces[pieces.length - 1].pts.push(q);
        pieces[pieces.length - 1].scr.push(qs);
        pieces.push({ pts: [q], scr: [qs] });
        k++;
      }
      pieces[pieces.length - 1].pts.push(b);
      pieces[pieces.length - 1].scr.push(P[(i + 1) % n]);
    }
    // a closed stroke: the last piece continues into the first
    if (st.cyclic && pieces.length > 1) {
      const last = pieces.pop()!;
      pieces[0] = { pts: [...last.pts, ...pieces[0].pts.slice(1)], scr: [...last.scr, ...pieces[0].scr.slice(1)] };
    }
    const hit = (pc: { scr: P2[] }) => pc.scr.some((p) => insidePolygon(p.x, p.y, lasso)) || pc.scr.some((p, i) => i + 1 < pc.scr.length && insidePolygon((p.x + pc.scr[i + 1].x) / 2, (p.y + pc.scr[i + 1].y) / 2, lasso));
    const keep = pieces.filter((pc) => !hit(pc));
    if (keep.length === pieces.length && !(st.cyclic && pieces.length === 1 && hit(pieces[0]))) {
      out.push(st);
      return;
    }
    changed = true;
    const wasCyclicWhole = st.cyclic && pieces.length === 1;
    if (wasCyclicWhole) return; // a closed stroke without crossings is removed entirely
    for (const pc of keep) if (pc.pts.length >= 2) out.push({ ...st, cyclic: false, points: pc.pts.map((p) => ({ ...p, select: false })) });
  });
  return changed ? out : null;
}

// ---------------------------------------------------------------------------
// shared: layers of the current frame and their screen projection

function screenOf(v: View3D, world: Matrix4, st: GPStroke): P2[] {
  const w = new Vector3();
  return st.points.map((p) => {
    const s = v.project(w.set(p.co[0], p.co[1], p.co[2]).applyMatrix4(world));
    return { x: s.x, y: s.y };
  });
}

function eachLayer(fn: (layer: GPLayer, strokes: GPStroke[], world: Matrix4) => GPStroke[] | null): boolean {
  const c = drawContext();
  if (!c) return false;
  const frame = app.doc.scene.frame_current;
  const obWorld = app.graph.get(c.ob.id)?.world ?? new Matrix4();
  let changed = false;
  for (const layer of c.gp.layers) {
    if (layer.lock || layer.hide) continue;
    const fr = frameAt(layer, frame);
    if (!fr || !c.gp.drawings[fr.drawing]) continue;
    const out = fn(layer, toStrokes(normalizeDrawing(c.gp.drawings[fr.drawing])), obWorld.clone().multiply(layerMatrix(layer)));
    if (!out) continue;
    const idx = editableDrawing(c.gp, layer, frame, true);
    c.gp.drawings[idx] = fromStrokes(out);
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// lasso input

const lassoState = { view: null as View3D | null, pts: [] as P2[], color: '#ffffff' };

function dragLasso(v: View3D, e: { clientX: number; clientY: number }, label: string, idname: string, color: string, done: (pts: P2[]) => boolean) {
  lassoState.view = v;
  lassoState.pts = [v.local(e)];
  lassoState.color = color;
  const end = () => {
    lassoState.view = null;
    lassoState.pts = [];
    v.drawSvg();
  };
  const handler: ModalHandler = {
    label,
    cursor: 'crosshair',
    header: () => `${label}: draw a lasso around the parts to remove · Esc to cancel`,
    onPointerMove(ev) {
      const q = v.local(ev);
      const last = lassoState.pts[lassoState.pts.length - 1];
      if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 3) lassoState.pts.push(q);
      v.drawSvg();
    },
    onPointerUp() {
      const pts = lassoState.pts.slice();
      end();
      if (pts.length < 3 || !done(pts)) return 'CANCELLED';
      handler.redoOp = { idname, props: { path: JSON.stringify(pts.map((q) => [Math.round(q.x), Math.round(q.y)])) } };
      return 'FINISHED';
    },
    onPointerDown: (ev) => (ev.button === 2 && ev.ctrlKey ? undefined : ev.button === 2 ? 'CANCELLED' : undefined),
    onKey: (ev) => (ev.type === 'keydown' && ev.key === 'Escape' ? 'CANCELLED' : true),
    cancel: end,
  };
  app.startModal(handler);
}

editModeHooks.svg.push((v) => {
  if (lassoState.view !== v || lassoState.pts.length < 2) return null;
  const d = lassoState.pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + ' Z';
  return h('path', { key: 'gp-lasso', d, fill: 'rgba(255, 255, 255,0.06)', stroke: lassoState.color, 'stroke-width': 1.2, 'stroke-dasharray': '5 3', 'pointer-events': 'none' });
});

const pollDraw = () => app.doc.mode === 'PAINT_GREASE_PENCIL' && !!drawContext() && !!activeView3D();
const parsePath = (s: unknown): P2[] => {
  try {
    return (JSON.parse(String(s)) as number[][]).map(([x, y]) => ({ x, y }));
  } catch {
    return [];
  }
};

function trimLasso(v: View3D, lasso: P2[]): boolean {
  return eachLayer((_l, strokes, world) => trimStrokes(strokes, strokes.map((st) => screenOf(v, world, st)), lasso));
}

function erasePointsIn(v: View3D, inside: (x: number, y: number) => boolean): boolean {
  const locked = new Set<number>();
  const c = drawContext()!;
  c.gp.materials.forEach((id, i) => id && app.doc.materials[id]?.grease_pencil?.lock && locked.add(i));
  return eachLayer((_l, strokes, world) => {
    let changed = false;
    const out = strokes.flatMap((st) => {
      if (locked.has(st.material_index)) return [st];
      const scr = screenOf(v, world, st);
      if (!scr.some((p) => inside(p.x, p.y))) return [st];
      changed = true;
      return filterPoints(st, (_p, i) => !inside(scr[i].x, scr[i].y));
    });
    return changed ? out : null;
  });
}

// ---------------------------------------------------------------------------
// eyedropper

function rgbClose(a: number[], b: number[]) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.01;
}

/** Make the active material one with the given stroke / fill color (reusing a matching one). */
export function materialForColor(col: [number, number, number], mode: 'STROKE' | 'FILL' | 'BOTH'): number {
  const c = drawContext()!;
  const doc = app.doc;
  const match = c.gp.materials.findIndex((id) => {
    const st = id ? doc.materials[id]?.grease_pencil : undefined;
    if (!st) return false;
    if (mode === 'STROKE') return st.show_stroke && !st.show_fill && rgbClose(st.color, col);
    if (mode === 'FILL') return st.show_fill && !st.show_stroke && rgbClose(st.fill_color, col);
    return st.show_fill && st.show_stroke && rgbClose(st.color, col) && rgbClose(st.fill_color, col);
  });
  if (match >= 0) return match;
  const rgba: [number, number, number, number] = [col[0], col[1], col[2], 1];
  const ma = newGPMaterial(uniqueName(doc, mode === 'FILL' ? 'Fill' : 'Stroke', 'materials'), { color: rgba, fill_color: rgba, show_stroke: mode !== 'FILL', show_fill: mode !== 'STROKE' });
  doc.materials[ma.id] = ma;
  c.gp.materials.push(ma.id);
  return c.gp.materials.length - 1;
}

registerOperators([
  {
    idname: 'grease_pencil.stroke_trim',
    label: 'Grease Pencil Trim',
    description: 'Remove the parts of strokes inside a lasso, cutting them where they cross other strokes',
    props: [{ id: 'path', label: 'Path', type: 'string', default: '[]', hidden: true }],
    poll: pollDraw,
    invoke: (ctx) => {
      const v = activeView3D()!;
      const ev = ctx.event ?? app.pointer;
      dragLasso(v, { clientX: ev.x, clientY: ev.y }, 'Grease Pencil Trim', 'grease_pencil.stroke_trim', '#fd6f68', (pts) => trimLasso(v, pts));
      return 'RUNNING_MODAL';
    },
    exec: (_c, p) => {
      const lasso = parsePath(p.path);
      if (lasso.length < 3 || !trimLasso(activeView3D()!, lasso)) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.erase_box',
    label: 'Grease Pencil Box Erase',
    description: 'Erase the stroke points inside a box',
    props: [
      { id: 'xmin', label: 'X Min', type: 'int', default: 0, hidden: true },
      { id: 'xmax', label: 'X Max', type: 'int', default: 0, hidden: true },
      { id: 'ymin', label: 'Y Min', type: 'int', default: 0, hidden: true },
      { id: 'ymax', label: 'Y Max', type: 'int', default: 0, hidden: true },
    ],
    poll: pollDraw,
    invoke: () => {
      const v = activeView3D()!;
      dragRegion(v, 'Grease Pencil Box Erase', (x0, y0, x1, y1) => void erasePointsIn(v, (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1), { hint: 'drag a box around the points to erase' });
      return 'RUNNING_MODAL';
    },
    exec: (_c, p) => {
      const v = activeView3D()!;
      const [x0, x1, y0, y1] = [p.xmin, p.xmax, p.ymin, p.ymax] as number[];
      if (x1 - x0 < 1 || y1 - y0 < 1) return 'CANCELLED';
      if (!erasePointsIn(v, (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.erase_lasso',
    label: 'Grease Pencil Erase Lasso',
    description: 'Erase the stroke points inside a lasso',
    props: [{ id: 'path', label: 'Path', type: 'string', default: '[]', hidden: true }],
    poll: pollDraw,
    invoke: (ctx) => {
      const v = activeView3D()!;
      const ev = ctx.event ?? app.pointer;
      dragLasso(v, { clientX: ev.x, clientY: ev.y }, 'Grease Pencil Erase Lasso', 'grease_pencil.erase_lasso', '#fda09b', (pts) => erasePointsIn(v, (x, y) => insidePolygon(x, y, pts)));
      return 'RUNNING_MODAL';
    },
    exec: (_c, p) => {
      const v = activeView3D()!;
      const lasso = parsePath(p.path);
      if (lasso.length < 3) return 'CANCELLED';
      if (!erasePointsIn(v, (x, y) => insidePolygon(x, y, lasso))) return 'CANCELLED';
    },
  },
  {
    idname: 'ui.eyedropper_grease_pencil_color',
    label: 'Grease Pencil Eyedropper',
    description: 'Sample a color from the viewport into a stroke / fill material or the brush color',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'MATERIAL',
        items: [
          ['MATERIAL', 'Material', 'Use a material with the sampled color'],
          ['BRUSH', 'Brush', 'Set the brush color (vertex color)'],
        ],
      },
      {
        id: 'material_mode',
        label: 'Material Mode',
        type: 'enum',
        default: 'STROKE',
        items: [
          ['STROKE', 'Stroke', 'A stroke material'],
          ['FILL', 'Fill', 'A fill material'],
          ['BOTH', 'Stroke & Fill', 'A material with stroke and fill'],
        ],
      },
      { id: 'x', label: 'X', type: 'float', default: -1, hidden: true },
      { id: 'y', label: 'Y', type: 'float', default: -1, hidden: true },
    ],
    poll: pollDraw,
    exec: (ctx, p) => {
      const v = activeView3D()!;
      const r = v.el.getBoundingClientRect();
      const x = (p.x as number) >= 0 ? (p.x as number) : (ctx.event?.x ?? app.pointer.x) - r.left;
      const y = (p.y as number) >= 0 ? (p.y as number) : (ctx.event?.y ?? app.pointer.y) - r.top;
      const col = screenColor(v, x, y);
      if (!col) return 'CANCELLED';
      if (p.mode === 'BRUSH') {
        const b = gpBrush(app.doc, 'builtin.brush.Draw');
        b.color = col;
        b.color_mode = 'VERTEXCOLOR';
        return;
      }
      app.activeObject!.active_material_index = materialForColor(col, p.material_mode as 'STROKE' | 'FILL' | 'BOTH');
    },
  },
]);

// ---------------------------------------------------------------------------
// tools: pointer dispatch

editModeHooks.pointer.unshift((v, e) => {
  if (e.button !== 0) return false;
  const mode = app.doc.mode;
  if (mode === 'PAINT_GREASE_PENCIL' && drawContext()) {
    const tool = activeTools[mode];
    const ev = { x: e.clientX, y: e.clientY };
    if (tool === 'builtin.trim') {
      app.run('grease_pencil.stroke_trim', {}, { event: ev });
      return true;
    }
    if (tool === 'builtin.eyedropper') {
      const props = e.ctrlKey && !e.shiftKey ? { mode: 'BRUSH' } : { mode: 'MATERIAL', material_mode: e.shiftKey && e.ctrlKey ? 'BOTH' : e.shiftKey ? 'FILL' : 'STROKE' };
      app.run('ui.eyedropper_grease_pencil_color', props, { event: ev });
      return true;
    }
    if (tool === 'builtin.interpolate') return dragThen(v, e, () => app.run('grease_pencil.interpolate', { ...interpolateSettings(), release_confirm: true, use_selection: false }, { event: ev }));
    return false;
  }
  if (mode === 'EDIT' && inGPEdit()) {
    const op = EDIT_TOOL_OPS[activeTools.EDIT ?? ''];
    if (!op) return false;
    const extra = activeTools.EDIT === 'builtin.interpolate' ? interpolateSettings() : {};
    return dragThen(v, e, () => app.run(op[0], { ...extra, ...op[1] }, { event: { x: e.clientX, y: e.clientY } }));
  }
  return false;
});

/** Run `fn` once the pointer is dragged; a plain click falls through to selection. */
function dragThen(v: View3D, e: PointerEvent, fn: () => void): boolean {
  const sx = e.clientX,
    sy = e.clientY;
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    cleanup();
    fn();
  };
  const up = () => {
    cleanup();
    if (app.doc.mode !== 'EDIT') return;
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
}

const EDIT_TOOL_OPS: Record<string, [string, Record<string, unknown>]> = {
  'builtin.extrude': ['grease_pencil.extrude_move', {}],
  'builtin.radius': ['transform.transform', { mode: 'CURVE_SHRINKFATTEN', release_confirm: true }],
  'builtin.bend': ['transform.bend', { release_confirm: true }],
  'builtin.shear': ['transform.shear', { release_confirm: true }],
  'builtin.to_sphere': ['transform.tosphere', { release_confirm: true }],
  'builtin.interpolate': ['grease_pencil.interpolate', { release_confirm: true, use_selection: true }],
};

const EDIT_TOOLS: (ToolDef | null)[] = [
  null,
  { id: 'builtin.extrude', label: 'Extrude', icon: 'extrude', shortcut: 'E', description: 'Extrude the selected points' },
  { id: 'builtin.radius', label: 'Radius', icon: 'shrink_fatten', shortcut: 'Alt S', description: 'Grow or shrink the thickness of the selected points' },
  { id: 'builtin.bend', label: 'Bend', icon: 'bend', shortcut: 'Shift W', description: 'Bend the selected points between the 3D cursor and the mouse' },
  { id: 'builtin.shear', label: 'Shear', icon: 'shear', description: 'Slant the selected points' },
  { id: 'builtin.to_sphere', label: 'To Sphere', icon: 'tosphere', shortcut: 'Shift Alt S', description: 'Move the selected points outward into a round shape' },
  null,
  { id: 'builtin.interpolate', label: 'Interpolate', icon: 'gp_interpolate', shortcut: 'Ctrl E', description: 'Drag to create an in-between of the selected strokes' },
];
toolsByMode.EDIT_GREASEPENCIL.push(...EDIT_TOOLS);

const hint = (text: string) => () => h('span', { class: 'th-label' }, text);
toolSettingsRenderers['builtin.trim'] = hint('Draw a lasso over the parts of strokes to remove; strokes are cut where they cross');
toolSettingsRenderers['builtin.eyedropper'] = hint('Click: stroke material · Shift: fill material · Shift Ctrl: stroke & fill · Ctrl: brush color');
toolSettingsRenderers['builtin.interpolate'] = () => {
  const s = interpolateSettings();
  const set = () => app.changed('ui');
  return [
    h(
      'div',
      { style: { width: '110px', flex: 'none' } },
      enumMenu(
        'gpi-layers',
        [
          { value: 'ACTIVE', label: 'Active Layer' },
          { value: 'ALL', label: 'All Layers' },
        ],
        s.layers,
        (x) => ((s.layers = x as 'ACTIVE' | 'ALL'), set()),
        { tip: 'Layers to interpolate' },
      ),
    ),
    checkbox('gpi-excl', 'Exclude Breakdowns', s.exclude_breakdowns, (x) => ((s.exclude_breakdowns = x), set()), { tip: 'Interpolate between keys only, skipping breakdowns' }),
    h(
      'div',
      { style: { width: '100px', flex: 'none' } },
      enumMenu(
        'gpi-flip',
        [
          { value: 'AUTO', label: 'Automatic' },
          { value: 'NONE', label: 'No Flip' },
          { value: 'FLIP', label: 'Flip' },
        ],
        s.flip,
        (x) => ((s.flip = x as 'AUTO'), set()),
        { tip: 'Flip Mode\nHow the target strokes are paired by direction' },
      ),
    ),
    h('div', { style: { width: '110px', flex: 'none' } }, numberField({ id: 'gpi-smooth', label: 'Smooth', value: s.smooth_factor, min: 0, max: 2, slider: true, set: (x) => ((s.smooth_factor = x), set()) })),
    h('div', { style: { width: '90px', flex: 'none' } }, numberField({ id: 'gpi-steps', label: 'Steps', value: s.smooth_steps, min: 1, max: 3, int: true, set: (x) => ((s.smooth_steps = Math.round(x)), set()) })),
  ];
};

/** Interpolate tool settings (also used by its drags). */
export function interpolateSettings() {
  const ts = gpTS(app.doc) as unknown as { gpencil_interpolate?: { layers: 'ACTIVE' | 'ALL'; exclude_breakdowns: boolean; flip: 'AUTO' | 'NONE' | 'FLIP'; smooth_factor: number; smooth_steps: number } };
  return (ts.gpencil_interpolate ??= { layers: 'ACTIVE', exclude_breakdowns: false, flip: 'AUTO', smooth_factor: 0, smooth_steps: 1 });
}
for (const id of ['builtin.extrude', 'builtin.radius', 'builtin.bend', 'builtin.shear', 'builtin.to_sphere']) toolSettingsRenderers[id] ??= hint('Drag to apply to the selected points');

const draw = () => app.doc.mode === 'PAINT_GREASE_PENCIL' && !!gpOf(app.doc, app.activeObject);
addKeys('Grease Pencil', [{ key: 'B', op: 'grease_pencil.erase_box', when: draw }]);

// Ctrl (Alt) right drag in Draw Mode: there is nothing to select, the lasso erases instead
editModeHooks.region.unshift((_v, r) => {
  if (!draw() || r.kind !== 'lasso') return false;
  app.run('grease_pencil.erase_lasso', { path: JSON.stringify(r.pts.map((q) => [Math.round(q.x), Math.round(q.y)])) }, { invoke: false });
  return true;
});
