// Edge and face selection on top of the per-vertex selection.
//
// The document stores which vertices are selected. In Edge and Face select mode that is not enough
// (two opposite edges of a quad, or three faces of a 2×2 grid, select every vertex of other
// edges/faces too), so the elements that are covered by selected vertices but NOT selected are
// remembered here, keyed by the select_vert array they belong to. Any operation that assigns a new
// select_vert array without registering exclusions falls back to the plain vertex-derived
// selection, so stale data can never leak into later selections.
import type { MeshData } from '../../data/types';
import { edgeKey } from './meshedit';
import { selectMode } from './context';

export interface Exclusions {
  /** face indices whose vertices are all selected but which are not selected */
  faces: Set<number>;
  /** edge keys whose two vertices are selected but which are not selected */
  edges: Set<string>;
}

const table = new WeakMap<Uint8Array, Exclusions>();

function mode(): 'VERT' | 'EDGE' | 'FACE' {
  try {
    return selectMode();
  } catch {
    return 'EDGE';
  }
}

/** Exclusions that apply to the mesh's current selection (none in vertex select mode). */
export function exclusionsOf(me: MeshData): Exclusions | null {
  if (!me.select_vert || mode() === 'VERT') return null;
  return table.get(me.select_vert) ?? null;
}

/** Register exclusions for a selection array (empty sets are not stored). */
export function setExclusions(sel: Uint8Array, ex: Exclusions | null) {
  if (ex && (ex.faces.size || ex.edges.size)) table.set(sel, ex);
  else table.delete(sel);
}

function faceVerts(me: MeshData, f: number) {
  return me.indices.subarray(me.offsets[f], me.offsets[f + 1]);
}

/** Faces currently selected (all vertices selected and not excluded). */
export function selectedFaceSet(me: MeshData): Set<number> {
  const sel = me.select_vert;
  const out = new Set<number>();
  if (!sel) return out;
  const ex = exclusionsOf(me);
  for (let f = 0; f < me.offsets.length - 1; f++) {
    if (ex?.faces.has(f)) continue;
    if (faceVerts(me, f).every((v) => !!sel[v] && !me.hide_vert?.[v])) out.add(f);
  }
  return out;
}

/** Edges currently selected (as keys), including loose edges. */
export function selectedEdgeSet(me: MeshData): Set<string> {
  const sel = me.select_vert;
  const out = new Set<string>();
  if (!sel) return out;
  const ex = exclusionsOf(me);
  const add = (a: number, b: number) => {
    const k = edgeKey(a, b);
    if (sel[a] && sel[b] && !ex?.edges.has(k) && !me.hide_vert?.[a] && !me.hide_vert?.[b]) out.add(k);
  };
  for (let f = 0; f < me.offsets.length - 1; f++) {
    const s = me.offsets[f],
      e = me.offsets[f + 1];
    for (let c = s; c < e; c++) add(me.indices[c], me.indices[c + 1 < e ? c + 1 : s]);
  }
  const loose = me.loose_edges;
  if (loose) for (let i = 0; i < loose.length; i += 2) add(loose[i], loose[i + 1]);
  return out;
}

/**
 * Select exactly these faces (Face mode): their vertices become the vertex selection, and the faces
 * and edges that those vertices cover by accident are excluded.
 */
export function selectFaces(me: MeshData, faces: Set<number>) {
  const sel = new Uint8Array(me.positions.length / 3);
  const edges = new Set<string>();
  for (const f of faces) {
    const vs = faceVerts(me, f);
    for (let i = 0; i < vs.length; i++) {
      sel[vs[i]] = 1;
      edges.add(edgeKey(vs[i], vs[(i + 1) % vs.length]));
    }
  }
  me.select_vert = sel;
  setExclusions(sel, coverage(me, sel, faces, edges));
}

/** Select exactly these edges (Edge mode); faces count as selected when all their edges are. */
export function selectEdges(me: MeshData, edges: Set<string>) {
  const sel = new Uint8Array(me.positions.length / 3);
  for (const k of edges) {
    const [a, b] = k.split(':').map(Number);
    sel[a] = sel[b] = 1;
  }
  me.select_vert = sel;
  const faces = new Set<number>();
  for (let f = 0; f < me.offsets.length - 1; f++) {
    const vs = faceVerts(me, f);
    let all = true;
    for (let i = 0; i < vs.length && all; i++) if (!edges.has(edgeKey(vs[i], vs[(i + 1) % vs.length]))) all = false;
    if (all) faces.add(f);
  }
  setExclusions(sel, coverage(me, sel, faces, edges));
}

/** Faces / edges covered by the vertex selection that are not in the given sets. */
function coverage(me: MeshData, sel: Uint8Array, faces: Set<number>, edges: Set<string>): Exclusions {
  const ex: Exclusions = { faces: new Set(), edges: new Set() };
  for (let f = 0; f < me.offsets.length - 1; f++) {
    const vs = faceVerts(me, f);
    if (!faces.has(f) && vs.every((v) => sel[v])) ex.faces.add(f);
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i],
        b = vs[(i + 1) % vs.length];
      const k = edgeKey(a, b);
      if (sel[a] && sel[b] && !edges.has(k)) ex.edges.add(k);
    }
  }
  const loose = me.loose_edges;
  if (loose)
    for (let i = 0; i < loose.length; i += 2) {
      const k = edgeKey(loose[i], loose[i + 1]);
      if (sel[loose[i]] && sel[loose[i + 1]] && !edges.has(k)) ex.edges.add(k);
    }
  return ex;
}
