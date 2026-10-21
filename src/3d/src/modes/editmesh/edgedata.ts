// Edge / vertex weights edited in Edit Mode: edge crease, vertex crease and edge / vertex bevel weight.
// The operators add their value to the current weights (negative values lower them) and clamp to 0..1;
// invoked from a key or menu they follow the mouse until confirmed.
import { registerOperators, type OpContext } from '../../app/app';
import { MeshEdit, edgeKey, VERT_FLOAT_LAYERS } from './meshedit';
import { withEdit } from './context';
import { editPoll } from './ops-basic';
import { startValueModal } from './modal';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Add `value` to the crease of every selected edge. Returns the number of edges changed. */
export function addEdgeCrease(m: MeshEdit, value: number): number {
  const sel = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  // the crease lives on face corners: compute each edge's new value once so both sides agree
  const next = new Map<string, number>();
  for (const f of m.faces)
    for (let i = 0; i < f.verts.length; i++) {
      const k = edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]);
      if (sel.has(k) && !next.has(k)) next.set(k, clamp01((f.creases[i] ?? 0) + value));
    }
  for (const f of m.faces)
    for (let i = 0; i < f.verts.length; i++) {
      const w = next.get(edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]));
      if (w !== undefined) f.creases[i] = w;
    }
  return next.size;
}

/** Add `value` to the bevel weight of every selected edge (loose edges included). */
export function addEdgeBevelWeight(m: MeshEdit, value: number): number {
  const edges = m.selectedEdges();
  for (const [a, b] of edges) {
    const k = edgeKey(a, b);
    const w = clamp01(m.edgeBevelWeight(a, b) + value);
    if (w > 0) m.ebw.set(k, w);
    else m.ebw.delete(k);
  }
  return edges.length;
}

/** Add `value` to a per-vertex layer (vertex crease or vertex bevel weight) of the selected vertices. */
export function addVertexLayer(m: MeshEdit, key: (typeof VERT_FLOAT_LAYERS)[number], value: number): number {
  const sel = m.selectedVerts();
  if (!sel.length) return 0;
  const l = m.vertLayer(key);
  for (const v of sel) l[v] = clamp01(l[v] + value);
  return sel.length;
}

type Kind = 'EDGE_CREASE' | 'VERT_CREASE' | 'EDGE_BEVEL' | 'VERT_BEVEL';
const applyKind = (m: MeshEdit, kind: Kind, value: number) =>
  kind === 'EDGE_CREASE' ? addEdgeCrease(m, value) : kind === 'EDGE_BEVEL' ? addEdgeBevelWeight(m, value) : addVertexLayer(m, kind === 'VERT_CREASE' ? 'crease_vert' : 'bevel_weight_vert', value);

function weightOperator(idname: string, label: string, name: string, kind: Kind, description: string) {
  return {
    idname,
    label,
    description,
    props: [
      { id: 'value', label: 'Factor', type: 'float' as const, default: 0, min: -1, max: 1, subtype: 'factor' as const },
    ],
    poll: editPoll,
    invoke: (ctx: OpContext, p: Record<string, unknown>) =>
      startValueModal({ label, idname, prop: 'value', initial: (p.value as number) || 0, min: -1, max: 1, perPixel: 0.005, name, apply: (m, v) => applyKind(m, kind, v) > 0 }, ctx.event),
    exec: (_ctx: OpContext, p: Record<string, unknown>) => (withEdit((m) => applyKind(m, kind, p.value as number) > 0) ? 'FINISHED' : 'CANCELLED') as 'FINISHED' | 'CANCELLED',
  };
}

registerOperators([
  weightOperator('transform.edge_crease', 'Edge Crease', 'Crease', 'EDGE_CREASE', 'Change how much the selected edges sharpen a subdivided surface'),
  weightOperator('transform.vert_crease', 'Vertex Crease', 'Vertex Crease', 'VERT_CREASE', 'Change how much the selected vertices sharpen a subdivided surface'),
  weightOperator('transform.edge_bevelweight', 'Edge Bevel Weight', 'Bevel Weight', 'EDGE_BEVEL', 'Change the bevel weight of the selected edges (used by the Bevel modifier limited by weight)'),
]);

// vertex bevel weights are set from the sidebar's Item panel; keep a scripted entry point too
export { applyKind as applyWeightKind };
