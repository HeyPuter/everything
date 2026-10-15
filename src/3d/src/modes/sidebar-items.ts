// Sidebar (N) Item panels for the curve, armature and lattice edit modes: the selected control
// point / bone / lattice point (or the median of several) with editable coordinates and attributes.
import { Matrix4, Vector3 } from 'three';
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, numberField, col, enumMenu } from '../ui/widgets';
import { itemPanels } from '../editors/view3d/sidebar';
import type { Bone, CurveData, HandleType, ObjectData, Vec3 } from '../data/types';
import { activeArmature } from './armature/armature';
import { boneVisible } from './armature/armkernels';
import * as K from './curve/curveops';
import { recalcHandles } from './curve/curve';

let useGlobal = false;

const worldOf = (ob: ObjectData) => app.graph.get(ob.id)?.world ?? new Matrix4();

/** X / Y / Z fields for a point; `apply` receives the new local-space position. */
function xyz(id: string, local: Vector3, ob: ObjectData, apply: (p: Vector3) => void): Child {
  const w = worldOf(ob);
  const shown = useGlobal ? local.clone().applyMatrix4(w) : local;
  return col(
    ...['X', 'Y', 'Z'].map((l, i) =>
      numberField({
        id: `${id}.${i}`,
        label: l,
        value: shown.getComponent(i),
        unit: 'distance',
        set: (x, final) => {
          const p = shown.clone().setComponent(i, x);
          apply(useGlobal ? p.applyMatrix4(w.clone().invert()) : p);
          app.changed('doc', 'geometry');
          if (final) app.pushUndo('Edit Point');
        },
      }),
    ),
  );
}

function spaceToggle(): Child {
  return h(
    'div',
    { class: 'btn-row' },
    ['Local', 'Global'].map((l) =>
      h(
        'button',
        {
          class: { btn: true, on: (l === 'Global') === useGlobal },
          onclick: () => {
            useGlobal = l === 'Global';
            app.changed('ui');
          },
        },
        l,
      ),
    ),
  );
}

function num(id: string, label: string, value: number, set: (v: number) => void, opts: { min?: number; max?: number; unit?: 'distance' | 'angle' | 'none' } = {}) {
  return numberField({
    id,
    label,
    value,
    min: opts.min,
    max: opts.max,
    unit: opts.unit ?? 'none',
    set: (x, final) => {
      set(x);
      app.changed('doc', 'geometry');
      if (final) app.pushUndo('Edit Point');
    },
  });
}

// ---------------------------------------------------------------------------
// curves

function curvePanel(ob: ObjectData, cu: CurveData): Child {
  const sel: { sp: CurveData['splines'][number]; i: number }[] = [];
  for (const sp of cu.splines) for (let i = 0; i < K.pointCount(sp); i++) if (K.isSel(sp, i) && !K.isHidden(sp, i)) sel.push({ sp, i });
  if (!sel.length) return h('div', { class: 'sb-empty' }, 'Nothing selected');
  const median = new Vector3();
  sel.forEach(({ sp, i }) => median.add(K.pointCo(sp, i)));
  median.multiplyScalar(1 / sel.length);
  const one = sel.length === 1 ? sel[0] : null;
  const avg = (f: (sp: CurveData['splines'][number], i: number) => number) => sel.reduce((s, x) => s + f(x.sp, x.i), 0) / sel.length;
  const attr = (k: 'radius' | 'tilt') => (sp: CurveData['splines'][number], i: number) => (sp.type === 'BEZIER' ? sp.bezier_points[i][k] : sp.points[i][k]);
  const setAttr = (k: 'radius' | 'tilt', v: number) => sel.forEach(({ sp, i }) => (sp.type === 'BEZIER' ? (sp.bezier_points[i][k] = v) : (sp.points[i][k] = v)));
  const nurbs = sel.filter(({ sp }) => sp.type !== 'BEZIER');
  const bez = one && one.sp.type === 'BEZIER' ? one.sp.bezier_points[one.i] : null;
  const HT: [HandleType, string][] = [
    ['AUTO', 'Automatic'],
    ['VECTOR', 'Vector'],
    ['ALIGNED', 'Aligned'],
    ['FREE', 'Free'],
  ];
  return [
    h('div', { class: 'sb-label' }, one ? 'Control Point:' : 'Median:'),
    xyz('cu-pt', median, ob, (p) => {
      const d = p.clone().sub(median);
      for (const { sp, i } of sel) {
        if (sp.type === 'BEZIER') {
          const b = sp.bezier_points[i];
          for (const k of ['co', 'handle_left', 'handle_right'] as const) b[k] = [b[k][0] + d.x, b[k][1] + d.y, b[k][2] + d.z] as Vec3;
        } else {
          const q = sp.points[i];
          q.co = [q.co[0] + d.x, q.co[1] + d.y, q.co[2] + d.z, q.co[3]];
        }
      }
      cu.splines.forEach(recalcHandles);
    }),
    spaceToggle(),
    nurbs.length ? num('cu-w', 'W', nurbs.reduce((s, x) => s + x.sp.points[x.i].co[3], 0) / nurbs.length, (v) => nurbs.forEach(({ sp, i }) => (sp.points[i].co[3] = Math.max(0.0001, v))), { min: 0.0001, max: 100 }) : null,
    num('cu-radius', 'Radius', avg(attr('radius')), (v) => setAttr('radius', Math.max(0, v)), { min: 0 }),
    num('cu-tilt', 'Tilt', avg(attr('tilt')), (v) => setAttr('tilt', v), { unit: 'angle' }),
    bez
      ? [
          h('div', { class: 'sb-label' }, 'Left Handle:'),
          enumMenu('cu-hlt', HT.map(([value, label]) => ({ value, label })), bez.handle_left_type, (v) => ((bez.handle_left_type = v as HandleType), app.pushUndo('Handle Type'), app.changed('doc', 'geometry'))),
          xyz('cu-hl', new Vector3(...bez.handle_left), ob, (p) => ((bez.handle_left = [p.x, p.y, p.z]), bez.handle_left_type === 'AUTO' || bez.handle_left_type === 'VECTOR' ? (bez.handle_left_type = 'FREE') : null)),
          h('div', { class: 'sb-label' }, 'Right Handle:'),
          enumMenu('cu-hrt', HT.map(([value, label]) => ({ value, label })), bez.handle_right_type, (v) => ((bez.handle_right_type = v as HandleType), app.pushUndo('Handle Type'), app.changed('doc', 'geometry'))),
          xyz('cu-hr', new Vector3(...bez.handle_right), ob, (p) => ((bez.handle_right = [p.x, p.y, p.z]), bez.handle_right_type === 'AUTO' || bez.handle_right_type === 'VECTOR' ? (bez.handle_right_type = 'FREE') : null)),
        ]
      : null,
  ];
}

// ---------------------------------------------------------------------------
// bones

/** Keep connected joints together after editing a head or tail. */
function syncJoints(b: Bone) {
  const a = activeArmature();
  if (!a) return;
  if (b.use_connect && b.parent) {
    const p = a.arm.bones.find((x) => x.name === b.parent);
    if (p) p.tail = [...b.head] as Vec3;
  }
  for (const c of a.arm.bones) if (c.parent === b.name && c.use_connect) c.head = [...b.tail] as Vec3;
}

function bonePanel(ob: ObjectData, b: Bone): Child {
  const len = new Vector3(...b.tail).distanceTo(new Vector3(...b.head));
  return [
    h('div', { class: 'sb-label' }, 'Head:'),
    xyz('bn-head', new Vector3(...b.head), ob, (p) => ((b.head = [p.x, p.y, p.z]), syncJoints(b))),
    h('div', { class: 'sb-label' }, 'Tail:'),
    xyz('bn-tail', new Vector3(...b.tail), ob, (p) => ((b.tail = [p.x, p.y, p.z]), syncJoints(b))),
    spaceToggle(),
    num('bn-roll', 'Roll', b.roll, (v) => (b.roll = v), { unit: 'angle' }),
    num(
      'bn-len',
      'Length',
      len,
      (v) => {
        const d = new Vector3(...b.tail).sub(new Vector3(...b.head));
        if (d.lengthSq() < 1e-12 || v <= 0) return;
        b.tail = new Vector3(...b.head).addScaledVector(d.normalize(), v).toArray() as Vec3;
        syncJoints(b);
      },
      { min: 0.0001, unit: 'distance' },
    ),
    num('bn-env', 'Envelope', b.envelope_distance, (v) => (b.envelope_distance = Math.max(0, v)), { min: 0, unit: 'distance' }),
    num('bn-rh', 'Radius Head', b.head_radius, (v) => (b.head_radius = Math.max(0, v)), { min: 0, unit: 'distance' }),
    num('bn-rt', 'Tail', b.tail_radius, (v) => (b.tail_radius = Math.max(0, v)), { min: 0, unit: 'distance' }),
  ];
}

// ---------------------------------------------------------------------------
// lattice

function latticePanel(ob: ObjectData): Child {
  const lt = app.doc.lattices[ob.data!] as typeof app.doc.lattices[string] & { select?: Uint8Array };
  const sel = lt.select ? [...lt.select.keys()].filter((i) => lt.select![i]) : [];
  if (!sel.length) return h('div', { class: 'sb-empty' }, 'Nothing selected');
  const median = new Vector3();
  for (const i of sel) median.add(new Vector3(lt.points[i * 3], lt.points[i * 3 + 1], lt.points[i * 3 + 2]));
  median.multiplyScalar(1 / sel.length);
  return [
    h('div', { class: 'sb-label' }, sel.length === 1 ? 'Vertex:' : 'Median:'),
    xyz('lt-pt', median, ob, (p) => {
      const d = p.clone().sub(median);
      const pts = new Float32Array(lt.points);
      for (const i of sel) {
        pts[i * 3] += d.x;
        pts[i * 3 + 1] += d.y;
        pts[i * 3 + 2] += d.z;
      }
      lt.points = pts;
    }),
    spaceToggle(),
  ];
}

itemPanels.push(() => {
  if (app.doc.mode !== 'EDIT') return null;
  const ob = app.activeObject;
  if (!ob?.data) return null;
  if (ob.type === 'CURVE') {
    const cu = app.doc.curves[ob.data];
    return cu ? panel('sb-curve-pt', 'Transform', () => curvePanel(ob, cu)) : null;
  }
  if (ob.type === 'ARMATURE') {
    const a = activeArmature();
    const b = a?.arm.bones.find((x) => x.name === a.arm.active_bone && boneVisible(a.arm, x));
    return a ? panel('sb-bone', 'Transform', () => (b ? bonePanel(ob, b) : h('div', { class: 'sb-empty' }, 'No active bone'))) : null;
  }
  if (ob.type === 'LATTICE') return panel('sb-lattice-pt', 'Transform', () => latticePanel(ob));
  return null;
});
