// Vertex parenting: an object follows one point (or the triangle of three points) of its parent —
// mesh vertices, curve control points or lattice points. `parentPointMatrix` gives the parent-local
// frame used by the depsgraph; `object.vertex_parent_set` (Ctrl P in Edit Mode) creates it.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { addKeys } from '../app/keymap';
import type { DocumentData, ObjectData } from '../data/types';
import type { EvalObject } from '../eval/depsgraph';
import { parentFrameHooks } from '../eval/depsgraph';
import * as K from './curve/curveops';

/**
 * Parent-space positions of element `i`: mesh vertex, curve control point (Bézier points count
 * three: left handle, point, right handle) or lattice point.
 */
function elementPosition(doc: DocumentData, parent: ObjectData, ev: EvalObject | undefined, i: number): Vector3 | null {
  if (!parent.data) return null;
  if (parent.type === 'MESH') {
    const P = ev?.mesh?.positions ?? doc.meshes[parent.data]?.positions;
    return P && i * 3 + 2 < P.length ? new Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]) : null;
  }
  if (parent.type === 'LATTICE') {
    const P = doc.lattices[parent.data]?.points;
    return P && i * 3 + 2 < P.length ? new Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]) : null;
  }
  if (parent.type === 'CURVE') {
    let base = 0;
    for (const sp of doc.curves[parent.data]?.splines ?? []) {
      const n = sp.type === 'BEZIER' ? sp.bezier_points.length * 3 : sp.points.length;
      if (i < base + n) {
        const k = i - base;
        if (sp.type !== 'BEZIER') return new Vector3(...(sp.points[k].co.slice(0, 3) as [number, number, number]));
        const b = sp.bezier_points[Math.floor(k / 3)];
        return new Vector3(...(k % 3 === 0 ? b.handle_left : k % 3 === 1 ? b.co : b.handle_right));
      }
      base += n;
    }
  }
  return null;
}

/** Parent-local matrix of the vertex parent frame (translation, or a full frame for three points). */
export function parentPointMatrix(doc: DocumentData, ob: ObjectData, parentEv: EvalObject | undefined): Matrix4 | null {
  const parent = ob.parent ? doc.objects[ob.parent] : undefined;
  const idx = ob.parent_vertices;
  if (!parent || !idx?.length) return null;
  const pts = idx.map((i) => elementPosition(doc, parent, parentEv, i));
  if (pts.some((p) => !p)) return null;
  const [a, b, c] = pts as Vector3[];
  if (ob.parent_type !== 'VERTEX_3' || !b || !c) return new Matrix4().makeTranslation(a.x, a.y, a.z);
  const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
  const x = b.clone().sub(a).normalize();
  const n = b.clone().sub(a).cross(c.clone().sub(a));
  if (n.lengthSq() < 1e-14 || x.lengthSq() < 1e-14) return new Matrix4().makeTranslation(center.x, center.y, center.z);
  const z = n.normalize();
  const y = z.clone().cross(x).normalize();
  return new Matrix4().makeBasis(x, y, z).setPosition(center);
}

/** Selected element indices of the edited object (same numbering as `elementPosition`). */
export function selectedElements(doc: DocumentData, ob: ObjectData): number[] {
  if (!ob.data) return [];
  if (ob.type === 'MESH') {
    const me = doc.meshes[ob.data];
    const sel = me?.select_vert;
    return sel ? [...sel.keys()].filter((i) => sel[i]) : [];
  }
  if (ob.type === 'LATTICE') {
    const sel = (doc.lattices[ob.data] as { select?: Uint8Array }).select;
    return sel ? [...sel.keys()].filter((i) => sel[i]) : [];
  }
  if (ob.type === 'CURVE') {
    const out: number[] = [];
    let base = 0;
    for (const sp of doc.curves[ob.data]?.splines ?? []) {
      for (let i = 0; i < K.pointCount(sp); i++) if (K.isSel(sp, i)) out.push(sp.type === 'BEZIER' ? base + i * 3 + 1 : base + i);
      base += sp.type === 'BEZIER' ? sp.bezier_points.length * 3 : sp.points.length;
    }
    return out;
  }
  return [];
}

const editable = () => app.doc.mode === 'EDIT' && ['MESH', 'CURVE', 'LATTICE'].includes(app.activeObject?.type ?? '');

registerOperators([
  {
    idname: 'object.vertex_parent_set',
    label: 'Make Vertex Parent',
    description: 'Parent the other selected objects to the selected vertex (or the triangle of three selected vertices)',
    poll: () => editable() && app.selectedObjects().some((o) => o.id !== app.activeObject?.id),
    exec: (ctx) => {
      const parent = app.activeObject!;
      const idx = selectedElements(ctx.doc, parent);
      if (idx.length !== 1 && idx.length !== 3) {
        app.report('ERROR', 'Select either 1 or 3 vertices to parent to');
        return 'CANCELLED';
      }
      const pev = app.graph.get(parent.id);
      const children = app.selectedObjects().filter((o) => o.id !== parent.id);
      for (const ch of children) {
        // no cycles
        let p: string | null = parent.id,
          cyc = false;
        while (p) {
          if (p === ch.id) cyc = true;
          p = ctx.doc.objects[p]?.parent ?? null;
        }
        if (cyc) continue;
        ch.parent = parent.id;
        ch.parent_type = idx.length === 3 ? 'VERTEX_3' : 'VERTEX';
        ch.parent_vertices = [...idx];
        ch.parent_bone = '';
        // keep the child where it is
        const frame = parentPointMatrix(ctx.doc, ch, pev) ?? new Matrix4();
        const pw = (pev?.world ?? new Matrix4()).clone().multiply(frame);
        ch.matrix_parent_inverse = pw.invert().toArray();
      }
      app.changed('doc');
    },
  },
]);

for (const km of ['Curve', 'Lattice', 'Mesh'])
  addKeys(km, [{ key: 'P', ctrl: true, op: 'object.vertex_parent_set', when: editable }]);

parentFrameHooks.push((doc, ob, parent) => parentPointMatrix(doc, ob, parent));
