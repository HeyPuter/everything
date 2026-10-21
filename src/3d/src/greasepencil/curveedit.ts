// Edit Mode support for stroke spline types: Bézier handles (overlay, picking, box / circle / lasso
// selection), the curve operators (Set Curve Type, Convert Type, Set Handle Type, Set Resolution),
// per stroke stroke / fill types, corner types and fill texture reset, plus their menus and keys.
import { Vector3 } from 'three';
import { app, registerOperators, type PropDef } from '../app/app';
import { addKeys } from '../app/keymap';
import { editModeHooks, type SelectRegion } from '../editors/view3d/hooks';
import { h, type VNode } from '../ui/h';
import type { MenuItem } from '../ui/menu';
import { gpOf, slotStyle, type GPStroke } from './data';
import { inGPEdit, editTargets, drawing, setDrawing, mapStrokes, type EditTarget } from './edit';
import { hasBezier, strokeCurveType, GP_BEZIER, GP_POLY, CURVE_TYPE_NAMES } from './curves';
import { setCurveType, convertCurveType, setHandleType, toggleTarget, strokeSelected, type HandleTypeOp } from './curvefit';
import type { GPDrawing } from './types';

const CURVE_ITEMS: [string, string, string][] = [
  ['CATMULL_ROM', 'Catmull Rom', 'A spline through its points with smooth tangents'],
  ['POLY', 'Poly', 'Straight segments between the points'],
  ['BEZIER', 'Bézier', 'Control points with two handles each'],
  ['NURBS', 'NURBS', 'A weighted B-spline shaped by its control points'],
];
const typeIndex = (name: unknown) => Math.max(0, CURVE_TYPE_NAMES.indexOf(name as (typeof CURVE_TYPE_NAMES)[number]));

const HANDLE_ITEMS: [string, string, string][] = [
  ['AUTO', 'Auto', 'Smooth handles computed from the neighbouring points'],
  ['VECTOR', 'Vector', 'Handles pointing at the neighbouring points (corners)'],
  ['ALIGN', 'Align', 'Handles stay on one line through the point'],
  ['FREE_ALIGN', 'Free', 'Handles move independently'],
  ['TOGGLE_FREE_ALIGN', 'Toggle Free/Align', 'Switch the selected handles between free and aligned'],
];

const STROKE_TYPE_ITEMS: [string, string, string][] = [
  ['STROKE', 'Stroke', 'Draw only the line'],
  ['FILL', 'Fill', 'Draw only the fill'],
  ['BOTH', 'Both', 'Draw the line and the fill'],
];

const CORNER_ITEMS: [string, string, string][] = [
  ['ROUND', 'Round', 'Rounded joins'],
  ['FLAT', 'Flat', 'Joins are cut off flat'],
  ['SHARP', 'Sharp', 'Pointed joins up to the miter angle'],
];

const poll = () => inGPEdit();

/** Strokes with a selected point or handle go through `fn`; unchanged results (same object) are skipped. */
function mapSelected(fn: (s: GPStroke) => GPStroke | null): boolean {
  return mapStrokes((strokes) => {
    let changed = false;
    const out = strokes.map((s) => {
      if (!strokeSelected(s)) return s;
      const r = fn(s);
      if (!r || r === s) return s;
      changed = true;
      return r;
    });
    return changed ? out : null;
  });
}

const nothing = () => {
  app.report('WARNING', 'No strokes selected');
  return 'CANCELLED' as const;
};

registerOperators([
  {
    idname: 'grease_pencil.set_curve_type',
    label: 'Set Curve Type',
    description: 'Change the spline type of the selected strokes, keeping their control points',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'POLY', items: CURVE_ITEMS },
      { id: 'use_handles', label: 'Handles', type: 'bool', default: false },
    ],
    poll,
    exec: (_c, p) => (mapSelected((s) => setCurveType(s, typeIndex(p.type), !!p.use_handles)) ? 'FINISHED' : nothing()),
  },
  {
    idname: 'grease_pencil.convert_curve_type',
    label: 'Convert Curve Type',
    description: 'Rebuild the selected strokes as another spline type that follows their current shape',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'POLY', items: CURVE_ITEMS },
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0.01, min: 0, max: 100, softMax: 1, step: 0.001, precision: 3, subtype: 'distance', showIf: (q) => q.type !== 'POLY' } as PropDef,
    ],
    poll,
    exec: (_c, p) => (mapSelected((s) => convertCurveType(s, typeIndex(p.type), p.threshold as number)) ? 'FINISHED' : nothing()),
  },
  {
    idname: 'grease_pencil.set_handle_type',
    label: 'Set Handle Type',
    description: 'Set the type of the selected Bézier handles',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'AUTO', items: HANDLE_ITEMS }],
    poll,
    exec: (_c, p) => {
      const op = p.type as HandleTypeOp;
      let target: number | undefined;
      if (op === 'TOGGLE_FREE_ALIGN') {
        const all: GPStroke[] = [];
        mapStrokes((ss) => {
          all.push(...ss);
          return null;
        });
        target = toggleTarget(all.filter(strokeSelected));
      }
      return mapSelected((s) => setHandleType(s, op, target)) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.set_curve_resolution',
    label: 'Set Curve Resolution',
    description: 'Set the number of evaluated points per segment of the selected smooth strokes',
    props: [{ id: 'resolution', label: 'Resolution', type: 'int', default: 12, min: 0, max: 10000, softMin: 1, softMax: 64 }],
    poll,
    exec: (_c, p) => (mapSelected((s) => ({ ...s, resolution: p.resolution as number, ...(s.curve_type === undefined ? { curve_type: GP_POLY } : {}) })) ? 'FINISHED' : nothing()),
  },
  {
    idname: 'grease_pencil.set_stroke_type',
    label: 'Set Stroke Type',
    description: 'Draw the selected strokes as lines, fills or both, whatever their material says',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'STROKE', items: STROKE_TYPE_ITEMS }],
    poll,
    exec: (_c, p) => {
      const t = p.type === 'FILL' ? 2 : p.type === 'BOTH' ? 3 : 1;
      return mapSelected((s) => ({ ...s, stroke_type: t })) ? 'FINISHED' : nothing();
    },
  },
  {
    idname: 'grease_pencil.select_by_stroke_type',
    label: 'Select By Stroke Type',
    description: 'Select the strokes that draw a line, or the ones that draw a fill',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'STROKE', items: STROKE_TYPE_ITEMS.slice(0, 2) },
      { id: 'deselect', label: 'Deselect', type: 'bool', default: false },
    ],
    poll,
    exec: (_c, p) => {
      const ob = app.activeObject!;
      const gp = gpOf(app.doc, ob)!;
      const wantFill = p.type === 'FILL';
      mapStrokes((strokes) =>
        strokes.map((s) => {
          const st = slotStyle(app.doc, gp, s.material_index);
          const t = s.stroke_type ?? 0;
          const shows = wantFill ? (t ? (t & 2) !== 0 : !!st?.show_fill) : t ? (t & 1) !== 0 : st?.show_stroke !== false;
          if (!shows) return s;
          return { ...s, points: s.points.map((q) => ({ ...q, select: !p.deselect })) };
        }),
      );
      app.changed('select');
    },
  },
  {
    idname: 'grease_pencil.set_corner_type',
    label: 'Set Corner Type',
    description: 'Set how the joins at the selected points are drawn',
    props: [
      { id: 'corner_type', label: 'Corner Type', type: 'enum', default: 'SHARP', items: CORNER_ITEMS },
      { id: 'miter_angle', label: 'Miter Cut Angle', type: 'float', default: Math.PI / 4, min: 0, max: Math.PI, subtype: 'angle', showIf: (q) => q.corner_type === 'SHARP' },
    ],
    poll,
    exec: (_c, p) => {
      const v = p.corner_type === 'ROUND' ? 0 : p.corner_type === 'FLAT' ? Math.PI : Math.max(1e-4, p.miter_angle as number);
      let any = false;
      mapStrokes((strokes) =>
        strokes.map((s) => {
          if (!s.points.some((q) => q.select)) return s;
          any = true;
          return { ...s, points: s.points.map((q) => (q.select ? { ...q, miter_angle: v } : q)) };
        }),
      );
      return any ? 'FINISHED' : nothing();
    },
  },
  {
    idname: 'grease_pencil.reset_uvs',
    label: 'Reset UVs',
    description: 'Reset the fill texture offset, rotation and scale of the selected strokes',
    poll,
    exec: () =>
      mapSelected((s) => {
        if (!s.uv_translation && !s.uv_rotation && !s.uv_scale) return null;
        const o = { ...s };
        delete o.uv_translation;
        delete o.uv_rotation;
        delete o.uv_scale;
        return o;
      })
        ? 'FINISHED'
        : 'CANCELLED',
  },
]);

// ---------------------------------------------------------------------------
// handles: overlay, picking and region selection

type HandleDisplay = 'ALL' | 'SELECTED' | 'NONE';
const handleMode = (v: { overlay: { display_handle?: HandleDisplay } }): HandleDisplay => v.overlay.display_handle ?? 'SELECTED';

/** Handles drawn for point i of a Bézier stroke. */
function handlesShown(d: GPDrawing, i: number, mode: HandleDisplay) {
  if (mode === 'ALL') return true;
  if (mode === 'NONE') return false;
  return !!(d.select![i] || d.select_handle_left![i] || d.select_handle_right![i]);
}

/** Visible handles of the edit targets: [target, point, side, screen position]. */
function visibleHandles(v: Parameters<(typeof editModeHooks.pick)[number]>[0]) {
  const out: { t: EditTarget; i: number; side: 'L' | 'R'; x: number; y: number; z: number }[] = [];
  const mode = handleMode(v);
  if (mode === 'NONE') return out;
  const p = new Vector3();
  for (const t of editTargets()) {
    const d = drawing(t);
    if (!hasBezier(d)) continue;
    for (let s = 0; s + 1 < d.offsets.length; s++) {
      if (strokeCurveType(d, s) !== GP_BEZIER) continue;
      for (let i = d.offsets[s]; i < d.offsets[s + 1]; i++) {
        if (!handlesShown(d, i, mode)) continue;
        for (const side of ['L', 'R'] as const) {
          const a = side === 'L' ? d.handle_left! : d.handle_right!;
          const q = v.project(p.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).applyMatrix4(t.world));
          out.push({ t, i, side, x: q.x, y: q.y, z: q.z });
        }
      }
    }
  }
  return out;
}

const HANDLE_COLORS = [
  ['#000000', '#e7fc57'], // free
  ['#899102', '#e7fc57'], // auto
  ['#3d8f32', '#3cc233'], // vector
  ['#7e315c', '#ef939e'], // align
];

editModeHooks.svg.push((v) => {
  if (!inGPEdit() || !v.overlay.show_overlays) return null;
  const mode = handleMode(v);
  if (mode === 'NONE') return null;
  const lines: VNode[] = [],
    dots: VNode[] = [];
  const p = new Vector3();
  const P = (a: ArrayLike<number>, i: number, t: EditTarget) => v.project(p.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).applyMatrix4(t.world));
  for (const t of editTargets()) {
    const d = drawing(t);
    if (!hasBezier(d)) continue;
    for (let s = 0; s + 1 < d.offsets.length; s++) {
      if (strokeCurveType(d, s) !== GP_BEZIER) continue;
      for (let i = d.offsets[s]; i < d.offsets[s + 1]; i++) {
        if (!handlesShown(d, i, mode)) continue;
        const c = P(d.position, i, t);
        if (c.z > 1) continue;
        const cx = c.x,
          cy = c.y;
        for (const side of ['L', 'R'] as const) {
          const hp = P(side === 'L' ? d.handle_left! : d.handle_right!, i, t);
          const type = (side === 'L' ? d.handle_type_left! : d.handle_type_right!)[i] ?? 0;
          const sel = !!(d.select![i] || (side === 'L' ? d.select_handle_left! : d.select_handle_right!)[i]);
          const col = HANDLE_COLORS[type]?.[sel ? 1 : 0] ?? '#000000';
          lines.push(h('line', { x1: cx, y1: cy, x2: hp.x, y2: hp.y, stroke: col, 'stroke-width': 1.5 }));
          const hs = !!(side === 'L' ? d.select_handle_left! : d.select_handle_right!)[i];
          dots.push(h('circle', { cx: hp.x, cy: hp.y, r: 3, fill: hs ? '#f58e04' : '#000000', stroke: col, 'stroke-width': 1 }));
        }
      }
    }
  }
  return lines.length ? h('g', { class: 'gp-handles' }, lines, dots) : null;
});

function setHandleSel(t: EditTarget, fn: (L: Uint8Array, R: Uint8Array, d: GPDrawing) => void) {
  const d = drawing(t);
  if (!hasBezier(d)) return;
  const L = d.select_handle_left!.slice(),
    R = d.select_handle_right!.slice();
  fn(L, R, d);
  setDrawing(t, { ...d, select_handle_left: L, select_handle_right: R });
}

// a click near a visible handle selects the handle (before the point picking of edit.ts)
editModeHooks.pick.unshift((v, x, y, o) => {
  if (!inGPEdit()) return false;
  const hs = visibleHandles(v);
  let best: (typeof hs)[number] | null = null,
    bd = 9;
  for (const hd of hs) {
    if (hd.z > 1) continue;
    const dd = Math.hypot(hd.x - x, hd.y - y);
    if (dd < bd) {
      bd = dd;
      best = hd;
    }
  }
  // points win over handles lying on top of them
  if (best) {
    const d = drawing(best.t);
    const c = v.project(new Vector3(d.position[best.i * 3], d.position[best.i * 3 + 1], d.position[best.i * 3 + 2]).applyMatrix4(best.t.world));
    if (Math.hypot(c.x - x, c.y - y) <= bd) best = null;
  }
  if (!best) {
    if (!o.extend && !o.toggle && !o.deselect) for (const t of editTargets()) setHandleSel(t, (L, R) => (L.fill(0), R.fill(0)));
    return false;
  }
  const hit = best;
  if (!o.extend && !o.toggle && !o.deselect)
    for (const t of editTargets()) {
      const d = drawing(t);
      setDrawing(t, { ...d, select: new Uint8Array(d.select!.length) });
      setHandleSel(t, (L, R) => (L.fill(0), R.fill(0)));
    }
  setHandleSel(hit.t, (L, R) => {
    const a = hit.side === 'L' ? L : R;
    a[hit.i] = o.deselect ? 0 : o.toggle && a[hit.i] ? 0 : 1;
  });
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
});

function regionHandles(v: Parameters<(typeof editModeHooks.pick)[number]>[0], inside: (x: number, y: number) => boolean, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR') {
  const hs = visibleHandles(v);
  const hits = new Map<EditTarget, { L: Set<number>; R: Set<number> }>();
  for (const hd of hs) {
    if (hd.z > 1 || !inside(hd.x, hd.y)) continue;
    let e = hits.get(hd.t);
    if (!e) hits.set(hd.t, (e = { L: new Set(), R: new Set() }));
    (hd.side === 'L' ? e.L : e.R).add(hd.i);
  }
  for (const t of editTargets())
    setHandleSel(t, (L, R) => {
      const e = hits.get(t);
      for (const [arr, set] of [
        [L, e?.L],
        [R, e?.R],
      ] as const)
        for (let i = 0; i < arr.length; i++) {
          const cur = arr[i],
            ht = set?.has(i) ? 1 : 0;
          arr[i] = mode === 'SET' ? ht : mode === 'ADD' ? cur | ht : mode === 'SUB' ? cur & (ht ^ 1) : mode === 'AND' ? cur & ht : cur ^ ht;
        }
    });
}

// box / circle / lasso also (de)select the visible handles; the points are handled by edit.ts
editModeHooks.box.unshift((v, x0, y0, x1, y1, mode) => {
  if (!inGPEdit()) return false;
  const [lx, hx, ly, hy] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
  regionHandles(v, (x, y) => x >= lx && x <= hx && y >= ly && y <= hy, mode);
  return false;
});
editModeHooks.region.unshift((v, r: SelectRegion, mode) => {
  if (!inGPEdit()) return false;
  const inside =
    r.kind === 'circle'
      ? (x: number, y: number) => Math.hypot(x - r.x, y - r.y) <= r.r
      : r.kind === 'box'
        ? (x: number, y: number) => x >= Math.min(r.x0, r.x1) && x <= Math.max(r.x0, r.x1) && y >= Math.min(r.y0, r.y1) && y <= Math.max(r.y0, r.y1)
        : (x: number, y: number) => {
            let c = false;
            const Q = r.pts;
            for (let i = 0, j = Q.length - 1; i < Q.length; j = i++) if (Q[i].y > y !== Q[j].y > y && x < ((Q[j].x - Q[i].x) * (y - Q[i].y)) / (Q[j].y - Q[i].y) + Q[i].x) c = !c;
            return c;
          };
  regionHandles(v, inside, mode);
  return false;
});

// ---------------------------------------------------------------------------
// menus and keys

export function convertTypeMenu(): MenuItem[] {
  return CURVE_ITEMS.map(([id, label]) => ({ label, op: 'grease_pencil.convert_curve_type', props: { type: id } }));
}
export function setCurveTypeMenu(): MenuItem[] {
  return CURVE_ITEMS.map(([id, label]) => ({ label, op: 'grease_pencil.set_curve_type', props: { type: id } }));
}
export function handleTypeMenu(): MenuItem[] {
  return HANDLE_ITEMS.map(([id, label]) => ({ label, op: 'grease_pencil.set_handle_type', props: { type: id } }));
}
export function strokeTypeMenu(): MenuItem[] {
  return STROKE_TYPE_ITEMS.map(([id, label]) => ({ label, op: 'grease_pencil.set_stroke_type', props: { type: id } }));
}
export function cornerTypeMenu(): MenuItem[] {
  return CORNER_ITEMS.map(([id, label]) => ({ label, op: 'grease_pencil.set_corner_type', props: { corner_type: id } }));
}
export function selectByStrokeTypeMenu(): MenuItem[] {
  return STROKE_TYPE_ITEMS.slice(0, 2).map(([id, label]) => ({ label, op: 'grease_pencil.select_by_stroke_type', props: { type: id } }));
}

addKeys('Grease Pencil', [{ key: 'V', menu: handleTypeMenu, menuTitle: 'Set Handle Type', when: poll }]);

