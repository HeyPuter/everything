// Interactive viewport tools shared by Object and Edit Mode: Annotate, Measure.
// Annotations and rulers are stored on the scene so they are saved and undoable.
import { Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { activeTools } from '../../app/prefs';
import { editModeHooks } from './hooks';
import type { View3D } from './view3d';
import { h, type VNode } from '../../ui/h';
import { surfaceHit, cursorToolSettings } from '../../ops/view3d';
import { toolSettingsRenderers } from './toolbar';
import { colorSwatch, formatNumber, numberField, enumMenu, opButton, checkbox } from '../../ui/widgets';
import { addKeys } from '../../app/keymap';
import { findSnapTarget } from '../../ops/snap';
import { activeView3D } from './view3d';
import { registerIcons } from '../../ui/icons';
import type { SceneData } from '../../data/types';

export interface AnnotationStroke {
  points: number[]; // flat xyz, world space
  color: [number, number, number];
  thickness: number;
  /** annotation layer (by name); its colour and thickness win when it exists */
  layer?: string;
}

export interface AnnotationLayer {
  name: string;
  color: [number, number, number];
  thickness: number;
  annotation_opacity: number;
  annotation_hide: boolean;
  lock: boolean;
}
export interface Ruler {
  a: [number, number, number];
  b: [number, number, number];
  /** corner point: the ruler measures the angle a–c–b (protractor) */
  c?: [number, number, number];
}

type SceneExt = SceneData & { annotations?: AnnotationStroke[]; rulers?: Ruler[]; annotation_layers?: AnnotationLayer[]; annotation_layer_active?: number };
const scene = () => app.doc.scene as SceneExt;

/** The active annotation layer (created on demand when `create`). */
export function activeAnnotationLayer(create = false): AnnotationLayer | null {
  const sc = scene();
  const list = sc.annotation_layers ?? [];
  if (!list.length) {
    if (!create) return null;
    sc.annotation_layers = [{ name: 'Note', color: [...annotateSettings.color] as [number, number, number], thickness: annotateSettings.thickness, annotation_opacity: 1, annotation_hide: false, lock: false }];
    sc.annotation_layer_active = 0;
  }
  const l = sc.annotation_layers!;
  return l[Math.max(0, Math.min(l.length - 1, sc.annotation_layer_active ?? 0))] ?? null;
}

/** How a stroke draws: its layer's colour, thickness and opacity (null when the layer is hidden). */
function strokeLook(s: AnnotationStroke): { color: number[]; thickness: number; opacity: number } | null {
  const l = s.layer ? scene().annotation_layers?.find((x) => x.name === s.layer) : undefined;
  if (l?.annotation_hide) return null;
  return { color: l?.color ?? s.color, thickness: l?.thickness ?? s.thickness, opacity: l?.annotation_opacity ?? 1 };
}

export const annotateSettings = {
  color: [0.12, 0.65, 0.95] as [number, number, number],
  thickness: 3,
  /** pick distance of the annotation eraser in pixels */
  eraserRadius: 12,
  placement: 'CURSOR' as 'CURSOR' | 'VIEW' | 'SURFACE',
};

const tool = () => activeTools[app.doc.mode];

function localXY(v: View3D, e: PointerEvent) {
  const r = v.el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function placePoint(v: View3D, x: number, y: number, mode: 'CURSOR' | 'VIEW' | 'SURFACE'): Vector3 {
  const cursor = new Vector3(...app.doc.scene.cursor.location);
  if (mode === 'SURFACE') {
    const hit = surfaceHit(v, x, y);
    if (hit) return hit;
  }
  if (mode === 'VIEW') {
    // a plane just in front of the view pivot
    return v.unproject(x, y, v.nav.pivot.clone());
  }
  return v.unproject(x, y, cursor);
}

const rgbCss = (c: number[]) => `rgb(${c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255)).join(',')})`;

// ---------------------------------------------------------------------------
// drawing (always visible while overlays are on)

let preview: VNode | null = null;
let activeRuler = -1;

editModeHooks.svg.push((v) => {
  if (!v.overlay.show_overlays) return null;
  const sc = scene();
  const parts: VNode[] = [];
  // Overlays ▸ Annotations hides the strokes (rulers stay)
  for (const s of v.overlay.show_annotation === false ? [] : sc.annotations ?? []) {
    const pts: string[] = [];
    for (let i = 0; i < s.points.length; i += 3) {
      const p = v.project(new Vector3(s.points[i], s.points[i + 1], s.points[i + 2]));
      if (p.z > 1) continue;
      pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    const look = strokeLook(s);
    if (pts.length > 1 && look) parts.push(h('polyline', { points: pts.join(' '), fill: 'none', stroke: rgbCss(look.color), 'stroke-width': look.thickness, 'stroke-opacity': look.opacity, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  (sc.rulers ?? []).forEach((r, i) => {
    const a = v.project(new Vector3(...r.a)),
      b = v.project(new Vector3(...r.b));
    if (a.z > 1 || b.z > 1) return;
    const on = i === activeRuler;
    const label = (x: number, y: number, text: string) => [
      h('rect', { x: x - text.length * 3.6 - 5, y: y - 18, width: text.length * 7.2 + 10, height: 16, rx: 3, fill: 'rgba(0, 0, 0,.6)' }),
      h('text', { x, y: y - 6, fill: '#ffffff', 'font-size': 11, 'text-anchor': 'middle' }, text),
    ];
    const seg = (p: { x: number; y: number }, q: { x: number; y: number }) => [
      h('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: '#000000', 'stroke-width': 3, opacity: 0.6 }),
      h('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: on ? '#ffffff' : '#dedfe1', 'stroke-width': 1.2, 'stroke-dasharray': '6 3' }),
    ];
    const dot = (p: { x: number; y: number }) => h('circle', { cx: p.x, cy: p.y, r: 4, fill: on ? '#ffffff' : '#bbbcbe', stroke: '#000000' });
    if (r.c) {
      // protractor: angle at the corner between the two arms
      const c = v.project(new Vector3(...r.c));
      const A = new Vector3(...r.a).sub(new Vector3(...r.c)),
        B = new Vector3(...r.b).sub(new Vector3(...r.c));
      const ang = A.lengthSq() && B.lengthSq() ? A.angleTo(B) : 0;
      const a0 = Math.atan2(a.y - c.y, a.x - c.x),
        b0 = Math.atan2(b.y - c.y, b.x - c.x);
      let d = b0 - a0;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      const R = 22;
      const arc = `M${c.x + Math.cos(a0) * R} ${c.y + Math.sin(a0) * R}A${R} ${R} 0 0 ${d > 0 ? 1 : 0} ${c.x + Math.cos(b0) * R} ${c.y + Math.sin(b0) * R}`;
      const mid = a0 + d / 2;
      parts.push(h('g', { class: 'ruler protractor' }, ...seg(c, a), ...seg(c, b), h('path', { d: arc, fill: 'none', stroke: on ? '#ffffff' : '#dedfe1', 'stroke-width': 1.2 }), dot(a), dot(b), dot(c), ...label(c.x + Math.cos(mid) * (R + 22), c.y + Math.sin(mid) * (R + 22) + 6, `${((ang * 180) / Math.PI).toFixed(2)}°`)));
      return;
    }
    const len = new Vector3(...r.a).distanceTo(new Vector3(...r.b));
    const mx = (a.x + b.x) / 2,
      my = (a.y + b.y) / 2;
    parts.push(h('g', { class: 'ruler' }, ...seg(a, b), dot(a), dot(b), h('circle', { cx: mx, cy: my, r: 3, fill: 'none', stroke: on ? '#ffffff' : '#bbbcbe', 'stroke-width': 1 }), ...label(mx, my, formatNumber(len, 'distance'))));
  });
  if (preview) parts.push(preview);
  return parts.length ? h('g', { class: 'tools3d' }, parts) : null;
});

// ---------------------------------------------------------------------------
// Annotate

function annotatePointer(v: View3D, e: PointerEvent): boolean {
  const t = tool();
  if (t === 'builtin.annotate_polygon') return polygonPointer(v, e);
  // the Eraser tool (or Ctrl with the other annotate tools) removes strokes under the pointer
  const erase = e.ctrlKey || t === 'builtin.annotate_eraser';
  // Annotate Line draws one straight segment from the press to the release
  const straight = t === 'builtin.annotate_line';
  const layer = activeAnnotationLayer(!erase);
  if (layer?.lock) {
    app.report('WARNING', `Annotation layer "${layer.name}" is locked`);
    return true;
  }
  const lookColor = layer?.color ?? annotateSettings.color,
    lookWidth = layer?.thickness ?? annotateSettings.thickness;
  const pts: number[] = [];
  const add = (ev: PointerEvent) => {
    const { x, y } = localXY(v, ev);
    if (erase) {
      eraseAt(v, x, y);
      return;
    }
    const p = placePoint(v, x, y, annotateSettings.placement);
    if (straight && pts.length >= 6) pts.length = 3;
    pts.push(p.x, p.y, p.z);
    const screen: string[] = [];
    for (let i = 0; i < pts.length; i += 3) {
      const s = v.project(new Vector3(pts[i], pts[i + 1], pts[i + 2]));
      screen.push(`${s.x.toFixed(1)},${s.y.toFixed(1)}`);
    }
    preview = h('polyline', { points: screen.join(' '), fill: 'none', stroke: rgbCss(lookColor), 'stroke-width': lookWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    app.changed('ui');
  };
  let erased = false;
  const eraseAt = (vv: View3D, x: number, y: number) => {
    const sc = scene();
    const before = sc.annotations?.length ?? 0;
    const locked = new Set((sc.annotation_layers ?? []).filter((l) => l.lock || l.annotation_hide).map((l) => l.name));
    sc.annotations = (sc.annotations ?? []).filter((s) => {
      if (s.layer && locked.has(s.layer)) return true;
      for (let i = 0; i < s.points.length; i += 3) {
        const p = vv.project(new Vector3(s.points[i], s.points[i + 1], s.points[i + 2]));
        if (Math.hypot(p.x - x, p.y - y) < annotateSettings.eraserRadius) return false;
      }
      return true;
    });
    if (sc.annotations.length !== before) {
      erased = true;
      app.changed('doc');
    }
  };
  add(e);
  const up = () => {
    removeEventListener('pointermove', add);
    removeEventListener('pointerup', up);
    preview = null;
    if (erase) {
      if (erased) app.pushUndo('Annotation Erase');
      app.changed('doc');
      return;
    }
    if (pts.length >= 6) {
      const sc = scene();
      sc.annotations = [...(sc.annotations ?? []), { points: pts, color: [...lookColor] as [number, number, number], thickness: lookWidth, layer: layer?.name }];
      app.pushUndo('Annotate');
    }
    app.changed('doc');
  };
  addEventListener('pointermove', add);
  addEventListener('pointerup', up);
  return true;
}

// Annotate Polygon: each click adds a corner; double-click, Enter, Esc or the right button ends it

let polygon: { v: View3D; pts: number[]; color: [number, number, number]; width: number; layer?: string } | null = null;
let polygonHover: { x: number; y: number } | null = null;

function polygonPreview() {
  if (!polygon) return;
  const v = polygon.v;
  const screen: string[] = [];
  for (let i = 0; i < polygon.pts.length; i += 3) {
    const s = v.project(new Vector3(polygon.pts[i], polygon.pts[i + 1], polygon.pts[i + 2]));
    screen.push(`${s.x.toFixed(1)},${s.y.toFixed(1)}`);
  }
  if (polygonHover) screen.push(`${polygonHover.x.toFixed(1)},${polygonHover.y.toFixed(1)}`);
  preview = h('polyline', { points: screen.join(' '), fill: 'none', stroke: rgbCss(polygon.color), 'stroke-width': polygon.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  app.changed('ui');
  v.drawSvg();
}

/** Finish the polygon being drawn (a stroke needs two corners or more). */
export function finishAnnotationPolygon() {
  const p = polygon;
  polygon = null;
  polygonHover = null;
  preview = null;
  if (p && p.pts.length >= 6) {
    const sc = scene();
    sc.annotations = [...(sc.annotations ?? []), { points: p.pts, color: p.color, thickness: p.width, layer: p.layer }];
    app.pushUndo('Annotate Polygon');
  }
  app.changed('doc');
  p?.v.drawSvg();
}

function polygonPointer(v: View3D, e: PointerEvent): boolean {
  if (e.button === 2) {
    finishAnnotationPolygon();
    return true;
  }
  const { x, y } = localXY(v, e);
  if (!polygon) {
    const layer = activeAnnotationLayer(true);
    if (layer?.lock) {
      app.report('WARNING', `Annotation layer "${layer.name}" is locked`);
      return true;
    }
    polygon = { v, pts: [], color: [...(layer?.color ?? annotateSettings.color)] as [number, number, number], width: layer?.thickness ?? annotateSettings.thickness, layer: layer?.name };
  }
  // a second click on the last corner (double-click) ends the polygon
  const n = polygon.pts.length;
  if (n >= 3) {
    const last = v.project(new Vector3(polygon.pts[n - 3], polygon.pts[n - 2], polygon.pts[n - 1]));
    if (Math.hypot(last.x - x, last.y - y) < 4) {
      finishAnnotationPolygon();
      return true;
    }
  }
  const p = placePoint(v, x, y, annotateSettings.placement);
  polygon.pts.push(p.x, p.y, p.z);
  polygonPreview();
  return true;
}

editModeHooks.hover.push((v, e) => {
  if (!polygon || polygon.v !== v) return;
  polygonHover = localXY(v, e);
  polygonPreview();
});

// ---------------------------------------------------------------------------
// Measure

export function measurePointer(v: View3D, e: PointerEvent): boolean {
  const sc = scene();
  const { x, y } = localXY(v, e);
  // Ctrl snaps to vertices, edges (and their middles) and surfaces of any object
  const snap = (ev: PointerEvent, px: number, py: number, depth: Vector3) => (ev.ctrlKey ? findSnapTarget(v, { x: px, y: py }, ['VERTEX', 'EDGE_MIDPOINT', 'EDGE'], true)?.point ?? surfaceHit(v, px, py) ?? v.unproject(px, py, depth) : v.unproject(px, py, depth));
  // grab an existing point? dragging a ruler's midpoint turns it into a protractor
  let grab: { i: number; end: 'a' | 'b' | 'c' } | null = null;
  (sc.rulers ?? []).forEach((r, i) => {
    for (const end of ['a', 'b', 'c'] as const) {
      const w = r[end];
      if (!w) continue;
      const p = v.project(new Vector3(...w));
      if (Math.hypot(p.x - x, p.y - y) < 9) grab = { i, end };
    }
    if (!r.c && !grab) {
      const mid = v.project(new Vector3(...r.a).add(new Vector3(...r.b)).multiplyScalar(0.5));
      if (Math.hypot(mid.x - x, mid.y - y) < 7) grab = { i, end: 'c' };
    }
  });
  let ruler: Ruler;
  let end: 'a' | 'b' | 'c';
  let created = false;
  let converted = false;
  if (grab) {
    const g = grab as { i: number; end: 'a' | 'b' | 'c' };
    sc.rulers = sc.rulers!.map((r) => ({ a: [...r.a], b: [...r.b], ...(r.c ? { c: [...r.c] } : {}) }) as Ruler);
    ruler = sc.rulers[g.i];
    end = g.end;
    if (end === 'c' && !ruler.c) {
      ruler.c = new Vector3(...ruler.a).add(new Vector3(...ruler.b)).multiplyScalar(0.5).toArray() as [number, number, number];
      converted = true;
    }
    activeRuler = g.i;
  } else {
    const p = (e.ctrlKey ? findSnapTarget(v, { x, y }, ['VERTEX', 'EDGE_MIDPOINT', 'EDGE'], true)?.point : null) ?? surfaceHit(v, x, y) ?? v.unproject(x, y, new Vector3(...app.doc.scene.cursor.location));
    ruler = { a: [p.x, p.y, p.z], b: [p.x, p.y, p.z] };
    sc.rulers = [...(sc.rulers ?? []), ruler];
    activeRuler = sc.rulers.length - 1;
    end = 'b';
    created = true;
  }
  const depth = new Vector3(...(ruler[end] ?? ruler.a));
  let moved = false;
  const move = (ev: PointerEvent) => {
    const q = localXY(v, ev);
    const p = snap(ev, q.x, q.y, depth);
    ruler[end] = [p.x, p.y, p.z];
    moved = true;
    app.changed('doc');
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (converted && !moved) delete ruler.c;
    if (created && !moved) {
      // a click without drag does not create a zero length ruler
      sc.rulers = sc.rulers!.filter((r) => r !== ruler);
      activeRuler = -1;
    } else if (moved) app.pushUndo(created ? 'Add Ruler' : 'Move Ruler');
    app.changed('doc');
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  return true;
}

editModeHooks.pointer.push((v, e) => {
  const t = tool();
  if (e.altKey) return false;
  if (t === 'builtin.annotate' || t === 'builtin.annotate_line' || t === 'builtin.annotate_polygon' || t === 'builtin.annotate_eraser') return annotatePointer(v, e);
  if (t === 'builtin.measure') return measurePointer(v, e);
  return false;
});

// ---------------------------------------------------------------------------
// operators, keys and tool settings

registerOperators([
  {
    idname: 'annotation.clear',
    label: 'Clear Annotations',
    description: 'Remove all annotation strokes',
    poll: () => !!scene().annotations?.length,
    exec: () => {
      scene().annotations = [];
    },
  },
  {
    idname: 'view3d.ruler_remove',
    label: 'Remove Ruler',
    description: 'Remove the active ruler',
    poll: () => activeRuler >= 0 && activeRuler < (scene().rulers?.length ?? 0),
    exec: () => {
      scene().rulers = scene().rulers!.filter((_, i) => i !== activeRuler);
      activeRuler = -1;
    },
  },
  {
    idname: 'view3d.ruler_add',
    label: 'Ruler Add',
    description: 'Add a ruler by dragging (or drag an existing ruler point); Ctrl snaps',
    undo: false,
    poll: () => !!activeView3D(),
    invoke: () => {
      const v = activeView3D()!;
      app.startModal({
        label: 'Ruler Add',
        header: () => 'Ruler: drag with the left mouse button to measure · Ctrl snaps · RMB / Esc to cancel',
        onPointerDown(e) {
          if (e.button !== 0) return 'CANCELLED';
          measurePointer(v, e);
          return 'CANCELLED';
        },
        onKey: (e) => (e.type === 'keydown' && e.key === 'Escape' ? 'CANCELLED' : true),
        cancel() {},
      });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'view3d.ruler_clear',
    label: 'Clear Rulers',
    poll: () => !!scene().rulers?.length,
    exec: () => {
      scene().rulers = [];
      activeRuler = -1;
    },
  },
]);

addKeys('3D View', [
  { key: 'RET', action: finishAnnotationPolygon, when: () => !!polygon },
  { key: 'ESC', action: finishAnnotationPolygon, when: () => !!polygon },
  { key: 'X', op: 'view3d.ruler_remove', when: () => tool() === 'builtin.measure' && activeRuler >= 0 },
  { key: 'DEL', op: 'view3d.ruler_remove', when: () => tool() === 'builtin.measure' && activeRuler >= 0 },
]);

// the colour and thickness edit the active annotation layer when there is one
toolSettingsRenderers['builtin.annotate'] = () =>
  h(
    'span',
    { class: 'th-settings' },
    h('span', { class: 'th-label' }, 'Color'),
    colorSwatch('ann-color', activeAnnotationLayer()?.color ?? annotateSettings.color, (c, final) => {
      annotateSettings.color = [c[0], c[1], c[2]];
      const l = activeAnnotationLayer();
      if (l) {
        l.color = [c[0], c[1], c[2]];
        if (final) app.pushUndo('Annotation Color');
      }
      app.changed('ui');
    }),
    h('span', { class: 'th-label' }, 'Thickness'),
    numberField({
      id: 'ann-thick',
      value: activeAnnotationLayer()?.thickness ?? annotateSettings.thickness,
      min: 1,
      max: 10,
      int: true,
      set: (x, final) => {
        annotateSettings.thickness = x;
        const l = activeAnnotationLayer();
        if (l) {
          l.thickness = x;
          if (final) app.pushUndo('Annotation Thickness');
        }
        app.changed('ui');
      },
    }),
    h('span', { class: 'th-label' }, 'Placement'),
    enumMenu(
      'ann-place',
      [
        { value: 'CURSOR', label: '3D Cursor' },
        { value: 'VIEW', label: 'View' },
        { value: 'SURFACE', label: 'Surface' },
      ],
      annotateSettings.placement,
      (p) => ((annotateSettings.placement = p as 'CURSOR'), app.changed('ui')),
    ),
    opButton('annotation.clear', 'Clear'),
    h('span', { class: 'th-label' }, 'Ctrl-drag to erase'),
  );

toolSettingsRenderers['builtin.measure'] = () =>
  h('span', { class: 'th-settings' }, h('span', { class: 'th-label' }, 'Drag to measure · drag a midpoint to measure an angle · Ctrl snaps to vertices, edges and surfaces · X removes the active ruler'), opButton('view3d.ruler_clear', 'Clear Rulers'));



toolSettingsRenderers['builtin.cursor'] = () =>
  h(
    'span',
    { class: 'th-settings' },
    checkbox('cur-depth', 'Surface Project', cursorToolSettings.use_depth, (x) => ((cursorToolSettings.use_depth = x), app.changed('ui'))),
    h('span', { class: 'th-label' }, 'Orientation'),
    enumMenu(
      'cur-orient',
      [
        { value: 'NONE', label: 'None', description: 'Keep the cursor rotation' },
        { value: 'VIEW', label: 'View', description: 'Orient the cursor to the view' },
        { value: 'TRANSFORM', label: 'Transform', description: 'Orient the cursor to the transform orientation' },
        { value: 'GEOMETRY', label: 'Geometry', description: 'Orient the cursor to the surface under the mouse' },
      ],
      cursorToolSettings.orientation,
      (o) => ((cursorToolSettings.orientation = o as typeof cursorToolSettings.orientation), app.changed('ui')),
    ),
  );

// the annotate tool variants share the annotate settings
for (const id of ['builtin.annotate_line', 'builtin.annotate_polygon', 'builtin.annotate_eraser']) toolSettingsRenderers[id] = () => toolSettingsRenderers['builtin.annotate']();

registerIcons({
  annotate_line: '<path class="f" d="M2.5 12.2 12.2 2.5l1.3 1.3-9.7 9.7z"/><circle class="f" cx="3" cy="13" r="1.6"/><circle class="f" cx="13" cy="3" r="1.6"/>',
  annotate_polygon: '<path class="s" d="M2.5 12.5 5 4l5.5 2.5L13.5 12z" fill="none" stroke-width="1.4" stroke-linejoin="round"/><circle class="f" cx="2.5" cy="12.5" r="1.4"/><circle class="f" cx="5" cy="4" r="1.4"/><circle class="f" cx="10.5" cy="6.5" r="1.4"/><circle class="f" cx="13.5" cy="12" r="1.4"/>',
  annotate_eraser: '<path class="f" d="M9.5 2.5 14 7l-6 6H4.5L2 10.5z" opacity=".35"/><path class="s" d="M9.5 2.5 14 7l-6 6H4.5L2 10.5zM6 6.5l4.5 4.5M7 13.5h7" fill="none" stroke-width="1.2" stroke-linejoin="round"/>',
});
