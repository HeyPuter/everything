// Sidebar (N) ▸ Item in Grease Pencil Edit Mode: the median of the selected points (local or
// global coordinates), their mean radius and opacity, and the settings of the active stroke
// (cyclic, caps, fill opacity, softness, spline type and resolution).
import { Vector3 } from 'three';
import { app } from '../app/app';
import { h, type Child } from '../ui/h';
import { panel, numberField, col, enumMenu, checkbox } from '../ui/widgets';
import { itemPanels } from '../editors/view3d/sidebar';
import { splitRow } from '../ui/props';
import { inGPEdit, editTargets, drawing, setDrawing, type EditTarget } from './edit';
import { toStrokes, fromStrokes, type GPStroke } from './data';
import { withDerived, CURVE_TYPE_NAMES } from './curves';
import { setCurveType } from './curvefit';
import type { GPDrawing } from './types';

let useGlobal = true;

interface Sel {
  t: EditTarget;
  d: GPDrawing;
  idx: number[];
}

function selection(): Sel[] {
  const out: Sel[] = [];
  for (const t of editTargets()) {
    const d = drawing(t);
    const idx: number[] = [];
    for (let i = 0; i < d.select!.length; i++) if (d.select![i]) idx.push(i);
    if (idx.length) out.push({ t, d, idx });
  }
  return out;
}

/** Write per point values of the selection (positions also carry their handles along). */
function editPoints(fn: (s: Sel, d: GPDrawing) => void, label: string, final: boolean) {
  for (const s of selection()) {
    const d: GPDrawing = { ...s.d, position: s.d.position.slice(), radius: s.d.radius.slice(), opacity: s.d.opacity.slice() };
    if (d.handle_left) Object.assign(d, { handle_left: d.handle_left.slice(), handle_right: d.handle_right!.slice() });
    fn(s, d);
    setDrawing(s.t, withDerived(d));
  }
  app.changed('doc', 'geometry');
  if (final) app.pushUndo(label);
}

function transformPanel(sel: Sel[]): Child {
  const n = sel.reduce((a, s) => a + s.idx.length, 0);
  const median = new Vector3();
  let radius = 0,
    opacity = 0;
  for (const s of sel)
    for (const i of s.idx) {
      const p = new Vector3(s.d.position[i * 3], s.d.position[i * 3 + 1], s.d.position[i * 3 + 2]);
      median.add(useGlobal ? p.applyMatrix4(s.t.world) : p);
      radius += s.d.radius[i];
      opacity += s.d.opacity[i];
    }
  median.multiplyScalar(1 / n);
  radius /= n;
  opacity /= n;
  const setAxis = (axis: number, x: number, final: boolean) => {
    const delta = x - median.getComponent(axis);
    editPoints(
      (s, d) => {
        // the move in the space shown, brought into each drawing's layer space
        const dw = new Vector3().setComponent(axis, delta);
        const dl = useGlobal ? dw.clone().applyMatrix4(s.t.world.clone().invert()).sub(new Vector3().applyMatrix4(s.t.world.clone().invert())) : dw;
        for (const i of s.idx)
          for (const [k, v] of [
            [0, dl.x],
            [1, dl.y],
            [2, dl.z],
          ]) {
            d.position[i * 3 + k] += v;
            if (d.handle_left) {
              d.handle_left[i * 3 + k] += v;
              d.handle_right![i * 3 + k] += v;
            }
          }
      },
      'Edit Point',
      final,
    );
  };
  return panel('gp-item-tf', 'Transform', () => [
    h('div', { class: 'sb-label' }, n === 1 ? 'Point:' : 'Median:'),
    col(...['X', 'Y', 'Z'].map((l, axis) => numberField({ id: `gp-item-p${axis}`, label: l, value: median.getComponent(axis), unit: 'distance', set: (x, final) => setAxis(axis, x, !!final) }))),
    h(
      'div',
      { class: 'btn-row' },
      ['Local', 'Global'].map((l) => h('button', { class: { btn: true, on: (l === 'Global') === useGlobal }, onclick: () => ((useGlobal = l === 'Global'), app.changed('ui')) }, l)),
    ),
    numberField({
      id: 'gp-item-rad',
      label: n === 1 ? 'Radius' : 'Mean Radius',
      value: radius,
      min: 0,
      unit: 'distance',
      precision: 4,
      set: (x, final) => editPoints((s, d) => s.idx.forEach((i) => (d.radius[i] = radius > 1e-9 ? (d.radius[i] * x) / radius : x)), 'Point Radius', !!final),
    }),
    numberField({
      id: 'gp-item-op',
      label: n === 1 ? 'Opacity' : 'Mean Opacity',
      value: opacity,
      min: 0,
      max: 1,
      slider: true,
      set: (x, final) => editPoints((s, d) => s.idx.forEach((i) => (d.opacity[i] = Math.max(0, Math.min(1, opacity > 1e-9 ? (d.opacity[i] * x) / opacity : x)))), 'Point Opacity', !!final),
    }),
  ]);
}

/** The first stroke holding a selected point. */
function activeStroke(sel: Sel[]): { t: EditTarget; s: number } | null {
  const first = sel[0];
  if (!first) return null;
  const i = first.idx[0];
  let s = 0;
  while (s + 1 < first.d.offsets.length && first.d.offsets[s + 1] <= i) s++;
  return { t: first.t, s };
}

function strokePanel(sel: Sel[]): Child {
  const a = activeStroke(sel);
  if (!a) return null;
  const strokes = toStrokes(drawing(a.t));
  const st = strokes[a.s];
  if (!st) return null;
  const set = (patch: (s: GPStroke) => GPStroke, label: string, final = true) => {
    const list = toStrokes(drawing(a.t));
    list[a.s] = patch(list[a.s]);
    setDrawing(a.t, fromStrokes(list));
    app.changed('doc', 'geometry');
    if (final) app.pushUndo(label);
  };
  const caps = [
    { value: '0', label: 'Round' },
    { value: '1', label: 'Flat' },
  ];
  const type = st.curve_type ?? 1;
  return panel('gp-item-stroke', 'Curve Data', () => [
    checkbox('gp-item-cyc', 'Cyclic', st.cyclic, (x) => set((s) => ({ ...s, cyclic: x }), 'Cyclic')),
    numberField({ id: 'gp-item-fo', label: 'Fill Opacity', value: st.fill_opacity, min: 0, max: 1, slider: true, set: (x, final) => set((s) => ({ ...s, fill_opacity: x }), 'Fill Opacity', !!final) }),
    splitRow(
      'Start Cap',
      enumMenu('gp-item-sc', caps, String(st.start_cap), (x) => set((s) => ({ ...s, start_cap: +x as 0 | 1 }), 'Start Cap')),
    ),
    splitRow(
      'End Cap',
      enumMenu('gp-item-ec', caps, String(st.end_cap), (x) => set((s) => ({ ...s, end_cap: +x as 0 | 1 }), 'End Cap')),
    ),
    numberField({ id: 'gp-item-soft', label: 'Softness', value: st.softness ?? 0, min: 0, max: 1, slider: true, set: (x, final) => set((s) => ({ ...s, softness: x }), 'Softness', !!final) }),
    splitRow(
      'Type',
      enumMenu(
        'gp-item-ct',
        CURVE_TYPE_NAMES.map((v, k) => ({ value: String(k), label: ['Catmull Rom', 'Poly', 'Bézier', 'NURBS'][k] ?? v })),
        String(type),
        (x) => set((s) => setCurveType(s, +x, false), 'Set Curve Type'),
      ),
    ),
    type !== 1
      ? numberField({
          id: 'gp-item-res',
          label: 'Resolution',
          value: st.resolution ?? 12,
          min: 1,
          max: 64,
          int: true,
          set: (x, final) => set((s) => ({ ...s, resolution: Math.round(x) }), 'Curve Resolution', !!final),
        })
      : null,
  ]);
}

itemPanels.push(() => {
  if (!inGPEdit()) return null;
  const sel = selection();
  if (!sel.length) return h('div', { class: 'sb-empty' }, 'Nothing selected');
  return [transformPanel(sel), strokePanel(sel)];
});
