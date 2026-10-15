// Sidebar Item tab in mesh Edit Mode: median / vertex coordinates (local or global), mean edge
// crease of the selected edges, and the vertex group weights of the active vertex.
import { Matrix4, Vector3 } from 'three';
import { h } from '../../ui/h';
import { app } from '../../app/app';
import { itemPanels } from '../../editors/view3d/sidebar';
import { panel, numberField, enumRow } from '../../ui/widgets';
import { MeshEdit, edgeKey } from './meshedit';
import { inMeshEdit, editMeshObjects, active, worldMatrix } from './context';
import { selectedEdgeSet } from './selset';
import type { MeshData } from '../../data/types';

let space: 'LOCAL' | 'GLOBAL' = 'LOCAL';

/** Median (or the single vertex) of the selection, in local or global coordinates of the active object. */
function median(): { p: Vector3; count: number } | null {
  const ob = app.activeObject;
  if (!ob?.data) return null;
  const me = app.doc.meshes[ob.data];
  if (!me?.select_vert) return null;
  const p = new Vector3();
  let n = 0;
  for (let i = 0; i < me.select_vert.length; i++)
    if (me.select_vert[i] && !me.hide_vert?.[i]) {
      p.x += me.positions[i * 3];
      p.y += me.positions[i * 3 + 1];
      p.z += me.positions[i * 3 + 2];
      n++;
    }
  if (!n) return null;
  p.multiplyScalar(1 / n);
  if (space === 'GLOBAL') p.applyMatrix4(worldMatrix(ob));
  return { p, count: n };
}

/** Move the active object's selection so its median component `axis` becomes `value`. */
function setMedian(axis: number, value: number, final: boolean) {
  const ob = app.activeObject;
  const cur = median();
  if (!ob?.data || !cur) return;
  const me = app.doc.meshes[ob.data];
  const delta = new Vector3();
  delta.setComponent(axis, value - cur.p.getComponent(axis));
  if (space === 'GLOBAL') delta.applyMatrix4(new Matrix4().copy(worldMatrix(ob)).invert().setPosition(0, 0, 0));
  const P = new Float32Array(me.positions);
  for (let i = 0; i < me.select_vert!.length; i++)
    if (me.select_vert![i] && !me.hide_vert?.[i]) {
      P[i * 3] += delta.x;
      P[i * 3 + 1] += delta.y;
      P[i * 3 + 2] += delta.z;
    }
  me.positions = P;
  if (me.shape_keys.length) me.shape_keys = me.shape_keys.map((k, j) => (j === 0 ? { ...k, data: new Float32Array(P) } : k));
  app.changed('geometry');
  if (final) app.pushUndo('Move Vertices');
}

const creaseCache = new WeakMap<object, { creases: unknown; indices: unknown; value: number | null }>();

/** Mean crease of the selected edges (cached per selection / crease array, the sidebar redraws often). */
function meanCrease(me: MeshData): number | null {
  if (!me.select_vert) return null;
  const hit = creaseCache.get(me.select_vert);
  if (hit && hit.creases === me.creases && hit.indices === me.indices) return hit.value;
  const value = computeMeanCrease(me);
  creaseCache.set(me.select_vert, { creases: me.creases, indices: me.indices, value });
  return value;
}

function computeMeanCrease(me: MeshData): number | null {
  const sel = selectedEdgeSet(me);
  if (!sel.size) return null;
  let sum = 0;
  const seen = new Set<string>();
  for (let f = 0; f < me.offsets.length - 1; f++) {
    const s0 = me.offsets[f],
      e = me.offsets[f + 1];
    for (let c = s0; c < e; c++) {
      const k = edgeKey(me.indices[c], me.indices[c + 1 < e ? c + 1 : s0]);
      if (!sel.has(k) || seen.has(k)) continue;
      seen.add(k);
      sum += me.creases?.[c] ?? 0;
    }
  }
  return seen.size ? sum / seen.size : null;
}

function setCrease(value: number, final: boolean) {
  for (const { me } of editMeshObjects()) {
    const m = MeshEdit.from(me);
    const sel = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
    if (!sel.size) continue;
    for (const f of m.faces) f.verts.forEach((v, i) => sel.has(edgeKey(v, f.verts[(i + 1) % f.verts.length])) && (f.creases[i] = Math.max(0, Math.min(1, value))));
    m.write(me);
  }
  app.changed('geometry');
  if (final) app.pushUndo('Edge Crease');
}

itemPanels.push(() => {
  if (!inMeshEdit()) return null;
  const med = median();
  const ob = app.activeObject!;
  const me = app.doc.meshes[ob.data!];
  const crease = meanCrease(me);
  const activeVert = active.kind === 'VERT' && active.objectId === ob.id ? active.index : -1;
  const groups = activeVert >= 0 && me.select_vert?.[activeVert] ? me.vertex_groups.map((g, gi) => ({ name: g.name, gi, w: me.weights[gi]?.[activeVert] ?? 0 })).filter((x) => x.w > 0) : [];
  return [
    panel('sb-edit-transform', 'Transform', () =>
      med
        ? [
            h('div', { class: 'sb-label' }, med.count === 1 ? 'Vertex:' : 'Median:'),
            ...['X', 'Y', 'Z'].map((l, i) =>
              numberField({ id: `em-med-${i}-${space}`, label: l, value: med.p.getComponent(i), unit: 'distance', precision: 4, set: (x, final) => setMedian(i, x, final) }),
            ),
            enumRow(
              'em-space',
              [
                { value: 'GLOBAL', label: 'Global' },
                { value: 'LOCAL', label: 'Local' },
              ],
              space,
              (x) => {
                space = x as typeof space;
                app.changed('ui');
              },
            ),
            crease !== null ? [h('div', { class: 'sb-label' }, 'Edge Data:'), numberField({ id: 'em-crease', label: 'Mean Crease', value: crease, min: 0, max: 1, unit: 'factor', slider: true, set: (x, final) => setCrease(x, final) })] : null,
          ]
        : h('div', { class: 'sb-empty' }, 'Nothing selected'),
    ),
    groups.length
      ? panel('sb-edit-weights', 'Vertex Weights', () =>
          groups.map((g) =>
            numberField({
              id: `em-w-${g.gi}`,
              label: g.name,
              value: g.w,
              min: 0,
              max: 1,
              unit: 'factor',
              slider: true,
              set: (x, final) => {
                const w = new Float32Array(me.weights[g.gi]);
                w[activeVert] = x;
                me.weights = me.weights.map((arr, i) => (i === g.gi ? w : arr));
                app.changed('doc');
                if (final) app.pushUndo('Vertex Weight');
              },
            }),
          ),
        )
      : null,
  ];
});
