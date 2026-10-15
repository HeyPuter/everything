// Interactive viewport tools shared by Object and Edit Mode: Annotate, Measure, Add Cube.
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
import { newMeshData, newObject } from '../../data/defaults';
import * as prim from '../../mesh/primitives';
import { addObjectToScene, uniqueName } from '../../ops/object';
import { modeHandlers } from '../../ops/modes';
import { addKeys } from '../../app/keymap';
import type { SceneData } from '../../data/types';

export interface AnnotationStroke {
  points: number[]; // flat xyz, world space
  color: [number, number, number];
  thickness: number;
}
export interface Ruler {
  a: [number, number, number];
  b: [number, number, number];
  /** corner point: the ruler measures the angle a–c–b (protractor) */
  c?: [number, number, number];
}

type SceneExt = SceneData & { annotations?: AnnotationStroke[]; rulers?: Ruler[] };
const scene = () => app.doc.scene as SceneExt;

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
  for (const s of sc.annotations ?? []) {
    const pts: string[] = [];
    for (let i = 0; i < s.points.length; i += 3) {
      const p = v.project(new Vector3(s.points[i], s.points[i + 1], s.points[i + 2]));
      if (p.z > 1) continue;
      pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    if (pts.length > 1) parts.push(h('polyline', { points: pts.join(' '), fill: 'none', stroke: rgbCss(s.color), 'stroke-width': s.thickness, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
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
  const erase = e.ctrlKey;
  const pts: number[] = [];
  const add = (ev: PointerEvent) => {
    const { x, y } = localXY(v, ev);
    if (erase) {
      eraseAt(v, x, y);
      return;
    }
    const p = placePoint(v, x, y, annotateSettings.placement);
    pts.push(p.x, p.y, p.z);
    const screen: string[] = [];
    for (let i = 0; i < pts.length; i += 3) {
      const s = v.project(new Vector3(pts[i], pts[i + 1], pts[i + 2]));
      screen.push(`${s.x.toFixed(1)},${s.y.toFixed(1)}`);
    }
    preview = h('polyline', { points: screen.join(' '), fill: 'none', stroke: rgbCss(annotateSettings.color), 'stroke-width': annotateSettings.thickness, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    app.changed('ui');
  };
  let erased = false;
  const eraseAt = (vv: View3D, x: number, y: number) => {
    const sc = scene();
    const before = sc.annotations?.length ?? 0;
    sc.annotations = (sc.annotations ?? []).filter((s) => {
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
      sc.annotations = [...(sc.annotations ?? []), { points: pts, color: [...annotateSettings.color] as [number, number, number], thickness: annotateSettings.thickness }];
      app.pushUndo('Annotate');
    }
    app.changed('doc');
  };
  addEventListener('pointermove', add);
  addEventListener('pointerup', up);
  return true;
}

// ---------------------------------------------------------------------------
// Measure

function measurePointer(v: View3D, e: PointerEvent): boolean {
  const sc = scene();
  const { x, y } = localXY(v, e);
  const snap = (ev: PointerEvent, px: number, py: number, depth: Vector3) => (ev.ctrlKey ? surfaceHit(v, px, py) ?? v.unproject(px, py, depth) : v.unproject(px, py, depth));
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
    const p = surfaceHit(v, x, y) ?? v.unproject(x, y, new Vector3(...app.doc.scene.cursor.location));
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

// ---------------------------------------------------------------------------
// Add Cube: drag the base on the ground (or a surface), then move to set the height, click to confirm.

function addCubePointer(v: View3D, e: PointerEvent): boolean {
  const { x, y } = localXY(v, e);
  const hit = surfaceHit(v, x, y);
  const base = hit ?? new Vector3(...app.doc.scene.cursor.location);
  // base plane: horizontal through the start point
  const planeZ = base.z;
  const onPlane = (px: number, py: number) => {
    const { origin, dir } = v.ray(px, py);
    if (Math.abs(dir.z) < 1e-6) return null;
    const t = (planeZ - origin.z) / dir.z;
    return t > 0 ? origin.clone().addScaledVector(dir, t) : null;
  };
  const p0 = onPlane(x, y) ?? base.clone();
  let p1 = p0.clone();
  let height = 0;
  let phase: 'BASE' | 'HEIGHT' = 'BASE';
  let heightStartY = 0;
  const box = () => {
    const minX = Math.min(p0.x, p1.x),
      maxX = Math.max(p0.x, p1.x),
      minY = Math.min(p0.y, p1.y),
      maxY = Math.max(p0.y, p1.y);
    return { minX, maxX, minY, maxY, z0: Math.min(planeZ, planeZ + height), z1: Math.max(planeZ, planeZ + height) };
  };
  const draw = () => {
    const b = box();
    const c = [
      [b.minX, b.minY, b.z0],
      [b.maxX, b.minY, b.z0],
      [b.maxX, b.maxY, b.z0],
      [b.minX, b.maxY, b.z0],
      [b.minX, b.minY, b.z1],
      [b.maxX, b.minY, b.z1],
      [b.maxX, b.maxY, b.z1],
      [b.minX, b.maxY, b.z1],
    ].map((q) => v.project(new Vector3(q[0], q[1], q[2])));
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    preview = h('g', {}, E.map(([i, j]) => h('line', { x1: c[i].x, y1: c[i].y, x2: c[j].x, y2: c[j].y, stroke: '#ffffff', 'stroke-width': 1.2 })));
    app.changed('ui');
  };
  const finish = () => {
    cleanup();
    preview = null;
    const b = box();
    const sx = b.maxX - b.minX,
      sy = b.maxY - b.minY,
      sz = b.z1 - b.z0;
    if (sx < 1e-4 || sy < 1e-4) {
      app.changed('ui');
      return;
    }
    const center = new Vector3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.z0 + b.z1) / 2);
    const arrays = prim.cube(2);
    const P = arrays.positions;
    const zs = Math.max(sz, 1e-4);
    for (let i = 0; i < P.length; i += 3) {
      P[i] *= sx / 2;
      P[i + 1] *= sy / 2;
      P[i + 2] *= zs / 2;
    }
    const doc = app.doc;
    if (doc.mode === 'EDIT') {
      modeHandlers.EDIT?.addPrimitive?.(arrays, { location: center.toArray(), rotation: [0, 0, 0] });
      app.pushUndo('Add Cube');
    } else {
      const me = newMeshData(uniqueName(doc, 'Cube', 'meshes'), arrays);
      doc.meshes[me.id] = me;
      addObjectToScene(doc, newObject('Cube', 'MESH', me.id), { location: center.toArray() });
      app.pushUndo('Add Cube');
    }
    app.changed('doc');
  };
  const move = (ev: PointerEvent) => {
    const q = localXY(v, ev);
    if (phase === 'BASE') {
      const p = onPlane(q.x, q.y);
      if (p) p1 = p;
      if (ev.shiftKey) {
        // square base
        const s = Math.max(Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));
        p1 = new Vector3(p0.x + Math.sign(p1.x - p0.x || 1) * s, p0.y + Math.sign(p1.y - p0.y || 1) * s, planeZ);
      }
    } else {
      // height follows vertical mouse motion scaled by the view's pixel size at the base
      const center = new Vector3((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, planeZ);
      height = (heightStartY - q.y) * v.nav.pixelSize(center);
      if (ev.ctrlKey) height = Math.round(height * 10) / 10;
    }
    draw();
  };
  const up = () => {
    if (phase === 'BASE') {
      phase = 'HEIGHT';
      heightStartY = app.pointer.y - v.el.getBoundingClientRect().top;
      const d = Math.max(Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));
      height = d; // start as a cube-ish shape
      heightStartY += d / Math.max(1e-6, v.nav.pixelSize(p0));
      draw();
    }
  };
  const down = (ev: PointerEvent) => {
    if (phase !== 'HEIGHT') return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.button === 0) finish();
    else cancel();
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
    } else if (ev.key === 'Enter' && phase === 'HEIGHT') {
      ev.preventDefault();
      ev.stopPropagation();
      finish();
    }
  };
  const cancel = () => {
    cleanup();
    preview = null;
    app.changed('ui');
  };
  const cleanup = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointerdown', down, true);
    removeEventListener('keydown', key, true);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointerdown', down, true);
  addEventListener('keydown', key, true);
  draw();
  return true;
}

editModeHooks.pointer.push((v, e) => {
  const t = tool();
  if (e.altKey) return false;
  if (t === 'builtin.annotate') return annotatePointer(v, e);
  if (t === 'builtin.measure') return measurePointer(v, e);
  if (t === 'builtin.add_cube' && (app.doc.mode === 'OBJECT' || (app.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH'))) return addCubePointer(v, e);
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

toolSettingsRenderers['builtin.annotate'] = () =>
  h(
    'span',
    { class: 'th-settings' },
    h('span', { class: 'th-label' }, 'Color'),
    colorSwatch('ann-color', annotateSettings.color, (c) => {
      annotateSettings.color = [c[0], c[1], c[2]];
      app.changed('ui');
    }),
    h('span', { class: 'th-label' }, 'Thickness'),
    numberField({ id: 'ann-thick', value: annotateSettings.thickness, min: 1, max: 10, int: true, set: (x) => ((annotateSettings.thickness = x), app.changed('ui')) }),
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
  h('span', { class: 'th-settings' }, h('span', { class: 'th-label' }, 'Drag to measure · drag a midpoint to measure an angle · Ctrl snaps to surfaces · X removes the active ruler'), opButton('view3d.ruler_clear', 'Clear Rulers'));

toolSettingsRenderers['builtin.add_cube'] = () => h('span', { class: 'th-label' }, 'Drag to define the base (Shift: square), move to set the height, click to confirm');


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
