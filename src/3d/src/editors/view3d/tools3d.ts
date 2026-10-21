// Interactive viewport tools shared by Object and Edit Mode: Measure, plus the annotation data
// (layers, strokes, settings) the Annotate tools in greasepencil/annotate.ts draw with.
// Annotations and rulers are stored on the scene so they are saved and undoable.
import { Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { activeTools } from '../../app/prefs';
import { editModeHooks } from './hooks';
import type { View3D } from './view3d';
import { h, type VNode } from '../../ui/h';
import { surfaceHit, cursorToolSettings } from '../../ops/view3d';
import { toolSettingsRenderers } from './toolbar';
import { formatNumber, enumMenu, opButton, checkbox } from '../../ui/widgets';
import { addKeys } from '../../app/keymap';
import { findSnapTarget } from '../../ops/snap';
import { activeView3D } from './view3d';

import type { SceneData } from '../../data/types';

export type AnnotationArrow = 'NONE' | 'ARROW' | 'ARROW_OPEN' | 'ARROW_OPEN_INVERTED' | 'DIAMOND';

export interface AnnotationStroke {
  points: number[]; // flat xyz, world space
  color: [number, number, number];
  thickness: number;
  /** annotation layer (by name); its colour and thickness win when it exists */
  layer?: string;
  /** end decorations of straight lines */
  arrow_start?: AnnotationArrow;
  arrow_end?: AnnotationArrow;
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
export function strokeLook(s: AnnotationStroke): { color: number[]; thickness: number; opacity: number } | null {
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

export function placePoint(v: View3D, x: number, y: number, mode: 'CURSOR' | 'VIEW' | 'SURFACE'): Vector3 {
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


// ---------------------------------------------------------------------------
// drawing (always visible while overlays are on)

let activeRuler = -1;

editModeHooks.svg.push((v) => {
  if (!v.overlay.show_overlays) return null;
  const sc = scene();
  const parts: VNode[] = [];
  // annotation strokes are drawn by the annotation tools (greasepencil/annotate.ts)
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
  return parts.length ? h('g', { class: 'tools3d' }, parts) : null;
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
  { key: 'X', op: 'view3d.ruler_remove', when: () => tool() === 'builtin.measure' && activeRuler >= 0 },
  { key: 'DEL', op: 'view3d.ruler_remove', when: () => tool() === 'builtin.measure' && activeRuler >= 0 },
]);

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

