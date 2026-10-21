// Loop selection while a paint selection mask is on: Alt+right-click (or Alt+click with a select
// tool) selects the face loop across the edge under the pointer (face mask), or the edge loop of
// vertices along it (vertex mask). Shift extends, Shift+Ctrl deselects.
import { Vector3 } from 'three';
import { app, registerOperators, type OpContext } from '../app/app';
import type { MeshData } from '../data/types';
import { viewportExtensions } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { activeTools } from '../app/prefs';
import { edgeLoop, edgeRing } from '../modes/editmesh/select';
import { invalidatePaintAttributes } from './display';
import { meshSession } from './session';
import { faceMaskOn, isSelectTool, vertMaskOn } from './selmask';

const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function meshOf(): MeshData | null {
  const ob = app.activeObject;
  return ob?.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] ?? null : null;
}

/** The face edge closest to the surface point under (x, y): [a, b] vertex indices. */
function edgeUnder(v: View3D, x: number, y: number): [number, number] | null {
  const s = meshSession();
  if (!s) return null;
  const hit = s.raycast(v, x, y);
  if (!hit) return null;
  const P = s.positions;
  const p = hit.point;
  let best: [number, number] | null = null,
    bd = Infinity;
  const a = new Vector3(),
    b = new Vector3(),
    q = new Vector3();
  const c0 = s.offsets[hit.face],
    c1 = s.offsets[hit.face + 1];
  for (let c = c0; c < c1; c++) {
    const i = s.indices[c],
      j = s.indices[c + 1 < c1 ? c + 1 : c0];
    a.fromArray(P, i * 3);
    b.fromArray(P, j * 3);
    const ab = b.clone().sub(a);
    const t = Math.max(0, Math.min(1, q.copy(p).sub(a).dot(ab) / Math.max(1e-12, ab.lengthSq())));
    const d = a.clone().addScaledVector(ab, t).distanceToSquared(p);
    if (d < bd) {
      bd = d;
      best = [i, j];
    }
  }
  return best;
}

/** Faces of the loop across edge (a, b): faces between the edges of its ring. Pure. */
export function faceLoop(me: MeshData, a: number, b: number): number[] {
  const ring = new Set(edgeRing(me, a, b).map(([x, y]) => key(x, y)));
  const nf = me.offsets.length - 1;
  const out: number[] = [];
  for (let f = 0; f < nf; f++) {
    const c0 = me.offsets[f],
      c1 = me.offsets[f + 1];
    let n = 0;
    for (let c = c0; c < c1; c++) if (ring.has(key(me.indices[c], me.indices[c + 1 < c1 ? c + 1 : c0]))) n++;
    if (n >= 2) out.push(f);
  }
  if (!out.length) {
    // no quad strip: the faces on either side of the edge
    const k = key(a, b);
    for (let f = 0; f < nf; f++) {
      const c0 = me.offsets[f],
        c1 = me.offsets[f + 1];
      for (let c = c0; c < c1; c++) if (key(me.indices[c], me.indices[c + 1 < c1 ? c + 1 : c0]) === k) out.push(f);
    }
  }
  return out;
}

/** Vertices of the edge loop along edge (a, b). Pure. */
export function vertLoop(me: MeshData, a: number, b: number): number[] {
  const out = new Set<number>();
  for (const [x, y] of edgeLoop(me, a, b)) {
    out.add(x);
    out.add(y);
  }
  return [...out];
}

function loopSelect(face: boolean, ctx: OpContext, p: Record<string, unknown>, useEvent: boolean): 'FINISHED' | 'CANCELLED' {
  const me = meshOf();
  if (!me) return 'CANCELLED';
  let a = p.edge_a as number,
    b = p.edge_b as number;
  if (useEvent || a < 0 || b < 0) {
    const v = activeView3D();
    if (!v || !ctx.event) return 'CANCELLED';
    const r = v.el.getBoundingClientRect();
    const e = edgeUnder(v, ctx.event.x - r.left, ctx.event.y - r.top);
    if (!e) return 'CANCELLED';
    [a, b] = e;
    p.edge_a = a;
    p.edge_b = b;
  }
  const nv = me.positions.length / 3;
  const sel = p.extend && me.select_vert && me.select_vert.length === nv ? me.select_vert.slice() : new Uint8Array(nv);
  const on = p.select !== false ? 1 : 0;
  const hv = me.hide_vert && me.hide_vert.length === nv ? me.hide_vert : null;
  if (face) {
    for (const f of faceLoop(me, a, b)) {
      let hidden = false;
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (hv?.[me.indices[c]]) hidden = true;
      if (hidden) continue;
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) sel[me.indices[c]] = on;
    }
  } else for (const vi of vertLoop(me, a, b)) if (!hv?.[vi]) sel[vi] = on;
  me.select_vert = sel;
  invalidatePaintAttributes();
  app.changed('select');
  return 'FINISHED';
}

const loopProps = [
  { id: 'select', label: 'Select', type: 'bool' as const, default: true },
  { id: 'extend', label: 'Extend', type: 'bool' as const, default: false },
  { id: 'edge_a', label: 'Edge Vertex A', type: 'int' as const, default: -1, hidden: true },
  { id: 'edge_b', label: 'Edge Vertex B', type: 'int' as const, default: -1, hidden: true },
];

registerOperators([
  {
    idname: 'paint.face_select_loop',
    label: 'Select Loop',
    description: 'Select the loop of faces across the edge under the pointer',
    props: loopProps,
    poll: () => faceMaskOn(),
    invoke: (ctx, p) => loopSelect(true, ctx, p, true),
    exec: (ctx, p) => loopSelect(true, ctx, p, false),
  },
  {
    idname: 'paint.vert_select_loop',
    label: 'Select Loop',
    description: 'Select the loop of vertices along the edge under the pointer',
    props: loopProps,
    poll: () => vertMaskOn(),
    invoke: (ctx, p) => loopSelect(false, ctx, p, true),
    exec: (ctx, p) => loopSelect(false, ctx, p, false),
  },
]);

// Alt+right-click anywhere, or Alt+click with a select tool
viewportExtensions.push((v) => {
  const down = (e: PointerEvent) => {
    if (!e.altKey || app.modal) return;
    const mode = app.doc.mode;
    if (mode !== 'VERTEX_PAINT' && mode !== 'WEIGHT_PAINT' && mode !== 'TEXTURE_PAINT') return;
    const face = faceMaskOn(),
      vert = vertMaskOn();
    if (!face && !vert) return;
    if (!(e.button === 2 || (e.button === 0 && isSelectTool(activeTools[mode])))) return;
    e.preventDefault();
    e.stopPropagation();
    const ctrl = e.ctrlKey || e.metaKey;
    app.run(face ? 'paint.face_select_loop' : 'paint.vert_select_loop', { extend: e.shiftKey, select: !(e.shiftKey && ctrl) }, { event: { x: e.clientX, y: e.clientY }, area: v.area as never });
  };
  v.el.addEventListener('pointerdown', down, true);
  return () => v.el.removeEventListener('pointerdown', down, true);
});
