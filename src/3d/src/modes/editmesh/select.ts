// Edit-mode selection: picking, regions, loops/rings, linked, more/less, similar, etc.
import { app, registerOperators, type OpContext } from '../../app/app';
import { editModeHooks } from '../../editors/view3d/hooks';
import { activeView3D, type View3D } from '../../editors/view3d/view3d';
import { editMeshObjects, selectMode, active, inMeshEdit, ensureSelection, pushSelectHistory } from './context';
import { pickContext, nearestVertex, nearestEdge, pickFace, vertsInRegion, facesInRegion, type Region } from './pick';
import { MeshEdit, edgeKey } from './meshedit';
import { selectedFaceSet, selectedEdgeSet, selectFaces, selectEdges, setExclusions } from './selset';
import type { MeshData } from '../../data/types';
import { edgeTopology } from '../../mesh/mesh';

function commitSel(label: string) {
  app.pushUndo(label);
  app.changed('select', 'doc');
}

/** Click selection in edit mode (returns true when handled). */
function pick(v: View3D, x: number, y: number, o: { extend?: boolean; toggle?: boolean; deselect?: boolean; deselectAll?: boolean; loop?: boolean; ring?: boolean; path?: boolean }): boolean {
  if (!inMeshEdit()) return false;
  const mode = selectMode();
  let best: { me: MeshData; obId: string; kind: 'VERT' | 'EDGE' | 'FACE'; v?: number; e?: [number, number]; f?: number; d: number } | null = null;
  for (const { ob, me } of editMeshObjects()) {
    if (v.localView && !v.localView.has(ob.id)) continue;
    ensureSelection(me);
    const c = pickContext(v, ob, me);
    if (mode === 'VERT') {
      const r = nearestVertex(c, x, y, 25);
      if (r && (!best || r.dist < best.d)) best = { me, obId: ob.id, kind: 'VERT', v: r.index, d: r.dist };
    } else if (mode === 'EDGE') {
      const r = nearestEdge(c, x, y, 20);
      if (r && (!best || r.dist < best.d)) best = { me, obId: ob.id, kind: 'EDGE', e: [r.a, r.b], d: r.dist };
    } else {
      const r = pickFace(c, x, y);
      if (r && (!best || r.dist < best.d)) best = { me, obId: ob.id, kind: 'FACE', f: r.face, d: r.dist };
    }
  }
  if (o.loop || o.ring) {
    // loops/rings are based on the edge nearest to the cursor in any mode
    for (const { ob, me } of editMeshObjects()) {
      const c = pickContext(v, ob, me);
      const r = nearestEdge(c, x, y, 40);
      if (!r) continue;
      selectLoopOrRing(me, r.a, r.b, !!o.ring, !!o.extend, mode);
      active.objectId = ob.id;
      active.kind = 'EDGE';
      active.edge = [r.a, r.b];
      commitSel(o.ring ? 'Edge Ring Select' : 'Edge Loop Select');
      return true;
    }
    return true;
  }
  if (!best) {
    if (o.deselectAll && !o.extend) {
      for (const { me } of editMeshObjects()) me.select_vert = new Uint8Array(me.positions.length / 3);
      active.kind = '';
      commitSel('Select');
    }
    return true;
  }
  if (o.path && active.objectId === best.obId && active.kind) {
    selectShortestPath(best.me, best);
    commitSel('Pick Shortest Path');
    return true;
  }
  const me = best.me;
  if (best.kind !== 'VERT') {
    // edge / face mode: work on the exact edge or face set
    const isFace = best.kind === 'FACE';
    const key: string | number = isFace ? best.f! : edgeKey(best.e![0], best.e![1]);
    const set = (isFace ? selectedFaceSet(me) : selectedEdgeSet(me)) as Set<string | number>;
    const wasSel = set.has(key);
    const isAct = active.objectId === best.obId && active.kind === best.kind && (isFace ? active.index === best.f : edgeKey(active.edge[0], active.edge[1]) === key);
    if (o.deselect) set.delete(key);
    else if (o.toggle && wasSel && isAct) set.delete(key);
    else {
      if (!o.toggle && !o.extend) {
        for (const { me: m2 } of editMeshObjects()) if (m2 !== me) m2.select_vert = new Uint8Array(m2.positions.length / 3);
        set.clear();
      }
      set.add(key);
    }
    if (isFace) selectFaces(me, set as Set<number>);
    else selectEdges(me, set as Set<string>);
    active.objectId = best.obId;
    active.kind = best.kind;
    active.index = isFace ? best.f! : -1;
    active.edge = best.e ?? [-1, -1];
    if (!o.deselect && set.has(key)) pushSelectHistory();
    commitSel('Select');
    return true;
  }
  const sel = new Uint8Array(me.select_vert!);
  const verts = [best.v!];
  const isSel = !!sel[best.v!];
  const isActive = active.objectId === best.obId && active.kind === 'VERT' && active.index === best.v;
  if (o.deselect) sel[best.v!] = 0;
  else if (o.toggle && isSel && isActive) sel[best.v!] = 0;
  else {
    if (!o.toggle && !o.extend) for (const { me: m2 } of editMeshObjects()) if (m2 !== me) m2.select_vert = new Uint8Array(m2.positions.length / 3);
    if (!o.toggle && !o.extend) sel.fill(0);
    for (const vv of verts) sel[vv] = 1;
  }
  me.select_vert = sel;
  active.objectId = best.obId;
  active.kind = best.kind;
  active.index = best.kind === 'VERT' ? best.v! : best.kind === 'FACE' ? best.f! : -1;
  active.edge = best.e ?? [-1, -1];
  if (!o.deselect) pushSelectHistory();
  commitSel('Select');
  return true;
}

function region(v: View3D, r: Region, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR'): boolean {
  if (!inMeshEdit()) return false;
  const sm = selectMode();
  for (const { ob, me } of editMeshObjects()) {
    if (v.localView && !v.localView.has(ob.id)) continue;
    ensureSelection(me);
    const c = pickContext(v, ob, me);
    const nv = me.positions.length / 3;
    const inside = new Uint8Array(nv);
    if (sm === 'FACE') {
      for (const f of facesInRegion(c, r)) for (let k = me.offsets[f]; k < me.offsets[f + 1]; k++) inside[me.indices[k]] = 1;
    } else if (sm === 'EDGE') {
      const vin = new Uint8Array(nv);
      for (const i of vertsInRegion(c, r)) vin[i] = 1;
      // edges fully inside
      const et = edgeTopology(me);
      for (let e = 0; e < et.count; e++) {
        const a = et.verts[e * 2],
          b = et.verts[e * 2 + 1];
        if (vin[a] && vin[b]) inside[a] = inside[b] = 1;
      }
    } else for (const i of vertsInRegion(c, r)) inside[i] = 1;
    if (sm !== 'VERT') {
      // combine exact edge / face sets
      const cur = (sm === 'FACE' ? selectedFaceSet(me) : selectedEdgeSet(me)) as Set<string | number>;
      const hit = new Set<string | number>();
      if (sm === 'FACE') for (const f of facesInRegion(c, r)) hit.add(f);
      else {
        const et = edgeTopology(me);
        for (let e = 0; e < et.count; e++) {
          const a = et.verts[e * 2],
            b = et.verts[e * 2 + 1];
          if (inside[a] && inside[b]) hit.add(edgeKey(a, b));
        }
      }
      const out = new Set<string | number>();
      if (mode === 'SET') hit.forEach((k) => out.add(k));
      else if (mode === 'ADD') [...cur, ...hit].forEach((k) => out.add(k));
      else if (mode === 'SUB') cur.forEach((k) => !hit.has(k) && out.add(k));
      else if (mode === 'AND') cur.forEach((k) => hit.has(k) && out.add(k));
      else {
        cur.forEach((k) => !hit.has(k) && out.add(k));
        hit.forEach((k) => !cur.has(k) && out.add(k));
      }
      if (sm === 'FACE') selectFaces(me, out as Set<number>);
      else selectEdges(me, out as Set<string>);
      continue;
    }
    const sel = new Uint8Array(me.select_vert!);
    for (let i = 0; i < nv; i++) {
      const a = sel[i],
        b = inside[i];
      sel[i] = mode === 'SET' ? b : mode === 'ADD' ? a | b : mode === 'SUB' ? a & (b ^ 1) : mode === 'AND' ? a & b : a ^ b;
    }
    me.select_vert = sel;
  }
  commitSel('Box Select');
  return true;
}

editModeHooks.pick.push((v, x, y, o) => {
  const ev = window.event as PointerEvent | undefined;
  return pick(v, x, y, { ...o, loop: !!ev?.altKey && !ev?.ctrlKey, ring: !!ev?.altKey && !!ev?.ctrlKey, path: !!ev?.ctrlKey && !ev?.altKey && !ev?.shiftKey });
});
editModeHooks.box.push((v, x0, y0, x1, y1, mode) => region(v, { kind: 'box', x0, y0, x1, y1 }, mode));

/** Run a pick at the operator's mouse position (for the click-select operators). */
function pickAt(ctx: OpContext, o: Parameters<typeof pick>[3]) {
  const v = activeView3D();
  if (!v || !ctx.event) return 'CANCELLED' as const;
  const r = v.el.getBoundingClientRect();
  return pick(v, ctx.event.x - r.left, ctx.event.y - r.top, o) ? ('FINISHED' as const) : ('CANCELLED' as const);
}

registerOperators([
  {
    idname: 'mesh.loop_select',
    label: 'Loop Select',
    description: 'Select the edge loop under the mouse',
    props: [
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'toggle', label: 'Toggle Select', type: 'bool', default: false },
      { id: 'ring', label: 'Select Ring', type: 'bool', default: false },
    ],
    poll: (ctx) => inMeshEdit() && !!ctx.event,
    invoke: (ctx, p) => pickAt(ctx, { loop: !p.ring, ring: !!p.ring, extend: !!p.extend || !!p.toggle }),
    undo: false,
  },
  {
    idname: 'mesh.edgering_select',
    label: 'Edge Ring Select',
    description: 'Select the edge ring under the mouse',
    props: [
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'toggle', label: 'Toggle Select', type: 'bool', default: false },
    ],
    poll: (ctx) => inMeshEdit() && !!ctx.event,
    invoke: (ctx, p) => pickAt(ctx, { ring: true, extend: !!p.extend || !!p.toggle }),
    undo: false,
  },
  {
    idname: 'mesh.shortest_path_pick',
    label: 'Pick Shortest Path',
    description: 'Select the shortest path from the active element to the one under the mouse',
    poll: (ctx) => inMeshEdit() && !!ctx.event,
    invoke: (ctx) => pickAt(ctx, { path: true }),
    undo: false,
  },
]);
editModeHooks.region.push((v, r, mode) => region(v, r, mode));

export function selectRegion(v: View3D, r: Region, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR') {
  return region(v, r, mode);
}

// ---------------------------------------------------------------------------
// loops & rings

function faceList(me: MeshData) {
  const out: number[][] = [];
  for (let f = 0; f < me.offsets.length - 1; f++) out.push(Array.from(me.indices.subarray(me.offsets[f], me.offsets[f + 1])));
  return out;
}

export function edgeLoop(me: MeshData, a: number, b: number): [number, number][] {
  const faces = faceList(me);
  const ef = new Map<string, number[]>();
  faces.forEach((f, fi) => f.forEach((v, i) => {
    const k = edgeKey(v, f[(i + 1) % f.length]);
    (ef.get(k) ?? ef.set(k, []).get(k)!).push(fi);
  }));
  const vedges = new Map<number, number[]>();
  for (const k of ef.keys()) {
    const [x, y] = k.split(':').map(Number);
    (vedges.get(x) ?? vedges.set(x, []).get(x)!).push(y);
    (vedges.get(y) ?? vedges.set(y, []).get(y)!).push(x);
  }
  const out: [number, number][] = [[a, b]];
  const seen = new Set([edgeKey(a, b)]);
  const boundary = (ef.get(edgeKey(a, b))?.length ?? 0) === 1;
  const walk = (from: number, to: number) => {
    let p = from,
      q = to;
    for (let guard = 0; guard < 100000; guard++) {
      const ns = vedges.get(q) ?? [];
      let next = -1;
      if (boundary) {
        // follow the boundary
        const cands = ns.filter((n) => n !== p && (ef.get(edgeKey(q, n))?.length ?? 0) === 1);
        if (cands.length === 1) next = cands[0];
      } else if (ns.length === 4) {
        const curFaces = new Set(ef.get(edgeKey(p, q)) ?? []);
        const cands = ns.filter((n) => n !== p && !(ef.get(edgeKey(q, n)) ?? []).some((f) => curFaces.has(f)));
        if (cands.length === 1) next = cands[0];
      }
      if (next < 0) break;
      const k = edgeKey(q, next);
      if (seen.has(k)) break;
      seen.add(k);
      out.push([q, next]);
      p = q;
      q = next;
    }
  };
  walk(a, b);
  walk(b, a);
  return out;
}

export function edgeRing(me: MeshData, a: number, b: number): [number, number][] {
  const faces = faceList(me);
  const ef = new Map<string, number[]>();
  faces.forEach((f, fi) => f.forEach((v, i) => {
    const k = edgeKey(v, f[(i + 1) % f.length]);
    (ef.get(k) ?? ef.set(k, []).get(k)!).push(fi);
  }));
  const out: [number, number][] = [[a, b]];
  const seen = new Set([edgeKey(a, b)]);
  const walk = (ea: number, eb: number, fromFace: number) => {
    let x = ea,
      y = eb,
      ff = fromFace;
    for (let guard = 0; guard < 100000; guard++) {
      const fs = (ef.get(edgeKey(x, y)) ?? []).filter((f) => f !== ff);
      if (!fs.length) break;
      const f = fs[0];
      const vs = faces[f];
      if (vs.length !== 4) break;
      const i = vs.indexOf(x),
        j = vs.indexOf(y);
      // opposite edge in the quad
      const o = [0, 1, 2, 3].filter((k) => k !== i && k !== j);
      const nx = vs[o[0]],
        ny = vs[o[1]];
      const k = edgeKey(nx, ny);
      if (seen.has(k)) break;
      seen.add(k);
      out.push([nx, ny]);
      x = nx;
      y = ny;
      ff = f;
    }
  };
  const fs = ef.get(edgeKey(a, b)) ?? [];
  walk(a, b, -1);
  if (fs.length > 1) walk(a, b, fs[0]);
  return out;
}

function selectLoopOrRing(me: MeshData, a: number, b: number, ring: boolean, extend: boolean, mode: string) {
  const edges = ring ? edgeRing(me, a, b) : edgeLoop(me, a, b);
  if (mode === 'EDGE') {
    const set = extend ? selectedEdgeSet(me) : new Set<string>();
    const keys = edges.map(([x, y]) => edgeKey(x, y));
    const allSel = extend && keys.every((k) => set.has(k));
    for (const k of keys) {
      if (allSel) set.delete(k);
      else set.add(k);
    }
    selectEdges(me, set);
    return;
  }
  if (mode === 'FACE') {
    // face loop: the faces between consecutive ring edges
    const ringEdges = ring ? edges : edgeRing(me, a, b);
    const ringKeys = new Set(ringEdges.map(([x, y]) => edgeKey(x, y)));
    const set = extend ? selectedFaceSet(me) : new Set<number>();
    const loopFaces: number[] = [];
    for (let f = 0; f < me.offsets.length - 1; f++) {
      const vs = me.indices.subarray(me.offsets[f], me.offsets[f + 1]);
      let n = 0;
      for (let i = 0; i < vs.length; i++) if (ringKeys.has(edgeKey(vs[i], vs[(i + 1) % vs.length]))) n++;
      if (n >= 2) loopFaces.push(f);
    }
    const allSel = extend && loopFaces.every((f) => set.has(f));
    for (const f of loopFaces) {
      if (allSel) set.delete(f);
      else set.add(f);
    }
    selectFaces(me, set);
    return;
  }
  const sel = extend ? new Uint8Array(me.select_vert!) : new Uint8Array(me.positions.length / 3);
  // when extending onto an already selected loop: toggle off
  const allSel = extend && edges.every(([x, y]) => sel[x] && sel[y]);
  for (const [x, y] of edges) sel[x] = sel[y] = allSel ? 0 : 1;
  if (mode === 'FACE' && !ring) {
    // face loop: faces between consecutive ring edges — approximate by selecting faces whose verts are all selected
  }
  me.select_vert = sel;
}

function selectShortestPath(me: MeshData, target: { kind: string; v?: number; e?: [number, number]; f?: number }) {
  const startV = active.kind === 'VERT' ? active.index : active.kind === 'EDGE' ? active.edge[0] : active.kind === 'FACE' ? me.indices[me.offsets[active.index]] : -1;
  const endV = target.kind === 'VERT' ? target.v! : target.kind === 'EDGE' ? target.e![0] : me.indices[me.offsets[target.f!]];
  if (startV < 0) return;
  const P = me.positions;
  const m = MeshEdit.from(me);
  const nb = m.neighbors();
  const n = m.vcount;
  const dist = new Float64Array(n).fill(Infinity),
    prev = new Int32Array(n).fill(-1),
    done = new Uint8Array(n);
  dist[startV] = 0;
  for (let it = 0; it < n; it++) {
    let u = -1,
      bd = Infinity;
    for (let i = 0; i < n; i++)
      if (!done[i] && dist[i] < bd) {
        bd = dist[i];
        u = i;
      }
    if (u < 0 || u === endV) break;
    done[u] = 1;
    for (const w of nb[u]) {
      const d = bd + Math.hypot(P[u * 3] - P[w * 3], P[u * 3 + 1] - P[w * 3 + 1], P[u * 3 + 2] - P[w * 3 + 2]);
      if (d < dist[w]) {
        dist[w] = d;
        prev[w] = u;
      }
    }
  }
  const sel = new Uint8Array(me.select_vert!);
  for (let v = endV; v >= 0; v = prev[v]) {
    sel[v] = 1;
    if (v === startV) break;
  }
  me.select_vert = sel;
}

// ---------------------------------------------------------------------------
// operators

const editPoll = (ctx: OpContext) => ctx.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH';

function eachMesh(fn: (me: MeshData, m: MeshEdit) => void) {
  for (const { me } of editMeshObjects()) {
    ensureSelection(me);
    fn(me, MeshEdit.from(me));
  }
}

registerOperators([
  {
    idname: 'mesh.select_mode',
    label: 'Select Mode',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'VERT', items: [['VERT', 'Vertex'], ['EDGE', 'Edge'], ['FACE', 'Face']] }, { id: 'use_extend', label: 'Extend', type: 'bool', default: false }, { id: 'use_expand', label: 'Expand', type: 'bool', default: false }],
    poll: editPoll,
    exec: (ctx, p) => {
      const ts = ctx.doc.scene.tool_settings;
      const i = ['VERT', 'EDGE', 'FACE'].indexOf(p.type as string);
      if (p.use_extend) {
        ts.mesh_select_mode[i] = !ts.mesh_select_mode[i];
        if (!ts.mesh_select_mode.some(Boolean)) ts.mesh_select_mode[i] = true;
      } else {
        const prev = ts.mesh_select_mode.findIndex(Boolean);
        // expand: going to a larger element type keeps everything the selection touched
        if (p.use_expand && i > prev)
          for (const { me } of editMeshObjects()) {
            ensureSelection(me);
            const m = MeshEdit.from(me);
            const sel = new Uint8Array(me.select_vert!);
            if (i === 1) for (const [a, b] of m.edges()) (me.select_vert![a] || me.select_vert![b]) && (sel[a] = sel[b] = 1);
            else for (const f of m.faces) if (f.verts.some((v) => me.select_vert![v])) for (const v of f.verts) sel[v] = 1;
            if (me.hide_vert) for (let k = 0; k < sel.length; k++) if (me.hide_vert[k]) sel[k] = 0;
            me.select_vert = sel;
          }
        ts.mesh_select_mode = [i === 0, i === 1, i === 2];
      }
      // vertex mode flushes: everything the selected vertices cover counts as selected again
      if (ts.mesh_select_mode[0]) for (const { me } of editMeshObjects()) if (me.select_vert) setExclusions(me.select_vert, null);
      // switching to face mode keeps only fully selected faces
      if (i === 2 && !p.use_extend && !p.use_expand)
        for (const { me } of editMeshObjects()) {
          ensureSelection(me);
          // the set as seen from the previous mode (edge exclusions still apply)
          const m = MeshEdit.from(me);
          ts.mesh_select_mode = [false, false, true];
          selectFaces(me, new Set(m.selectedFaces()));
        }
    },
    redo: false,
  },
  {
    idname: 'mesh.select_all',
    label: '(De)select All',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: editPoll,
    exec: (_ctx, p) => {
      let action = p.action as string;
      if (action === 'TOGGLE') action = editMeshObjects().some(({ me }) => me.select_vert?.some(Boolean)) ? 'DESELECT' : 'SELECT';
      for (const { me } of editMeshObjects()) {
        ensureSelection(me);
        const s = new Uint8Array(me.select_vert!);
        for (let i = 0; i < s.length; i++) {
          if (me.hide_vert?.[i]) continue;
          s[i] = action === 'SELECT' ? 1 : action === 'DESELECT' ? 0 : s[i] ^ 1;
        }
        const sm = selectMode();
        if (action === 'INVERT' && sm === 'FACE') {
          // invert at face level
          const cur = selectedFaceSet(me);
          const out = new Set<number>();
          for (let f = 0; f < me.offsets.length - 1; f++) {
            let hidden = false;
            for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (me.hide_vert?.[me.indices[c]]) hidden = true;
            if (!hidden && !cur.has(f)) out.add(f);
          }
          selectFaces(me, out);
        } else if (action === 'INVERT' && sm === 'EDGE') {
          const cur = selectedEdgeSet(me);
          const out = new Set<string>();
          for (const [a, b] of MeshEdit.from(me).edges()) {
            const k = edgeKey(a, b);
            if (!cur.has(k) && !me.hide_vert?.[a] && !me.hide_vert?.[b]) out.add(k);
          }
          selectEdges(me, out);
        } else me.select_vert = s;
      }
      if (action === 'DESELECT') active.kind = '';
    },
    redo: false,
  },
  {
    idname: 'mesh.select_more',
    label: 'Select More',
    props: [{ id: 'use_face_step', label: 'Face Step', type: 'bool', default: true }],
    poll: editPoll,
    exec: (_ctx, p) => {
      eachMesh((me, m) => {
        const sel = new Uint8Array(me.select_vert!);
        const add = new Uint8Array(sel.length);
        if (p.use_face_step) {
          for (const f of m.faces) if (f.verts.some((v) => sel[v])) for (const v of f.verts) add[v] = 1;
        } else for (const [a, b] of m.edges()) if (sel[a] || sel[b]) add[a] = add[b] = 1;
        for (let i = 0; i < sel.length; i++) if (!me.hide_vert?.[i]) sel[i] |= add[i];
        me.select_vert = sel;
      });
    },
  },
  {
    idname: 'mesh.select_less',
    label: 'Select Less',
    poll: editPoll,
    exec: () => {
      eachMesh((me, m) => {
        const sel = new Uint8Array(me.select_vert!);
        const drop = new Uint8Array(sel.length);
        for (const f of m.faces) if (f.verts.some((v) => !sel[v])) for (const v of f.verts) drop[v] = 1;
        for (const [a, b] of m.edges()) if (!sel[a] || !sel[b]) drop[a] = drop[b] = 1;
        for (let i = 0; i < sel.length; i++) if (drop[i]) sel[i] = 0;
        me.select_vert = sel;
      });
    },
  },
  {
    idname: 'mesh.select_linked',
    label: 'Select Linked All',
    props: [{ id: 'delimit', label: 'Delimit', type: 'enum', default: 'SEAM', items: [['NONE', 'None'], ['SEAM', 'Seam'], ['SHARP', 'Sharp'], ['MATERIAL', 'Material']] }],
    poll: editPoll,
    exec: (_ctx, p) => {
      eachMesh((me, m) => {
        const sel = new Uint8Array(me.select_vert!);
        linkedFlood(me, m, sel, p.delimit as string);
        me.select_vert = sel;
      });
    },
  },
  {
    idname: 'mesh.select_linked_pick',
    label: 'Select Linked',
    props: [{ id: 'deselect', label: 'Deselect', type: 'bool', default: false }, { id: 'delimit', label: 'Delimit', type: 'enum', default: 'SEAM', items: [['NONE', 'None'], ['SEAM', 'Seam'], ['SHARP', 'Sharp'], ['MATERIAL', 'Material']] }],
    poll: editPoll,
    invoke: (ctx, p) => {
      const area = ctx.area?.editor as View3D | undefined;
      if (!area || !(area as unknown as { pick?: unknown }).pick) return 'CANCELLED';
      const r = area.el.getBoundingClientRect();
      const x = app.pointer.x - r.left,
        y = app.pointer.y - r.top;
      for (const { ob, me } of editMeshObjects()) {
        ensureSelection(me);
        const c = pickContext(area, ob, me);
        const hit = nearestVertex(c, x, y, 40) ?? (() => {
          const f = pickFace(c, x, y);
          return f ? { index: me.indices[me.offsets[f.face]], dist: 0 } : null;
        })();
        if (!hit) continue;
        const m = MeshEdit.from(me);
        const seed = new Uint8Array(me.positions.length / 3);
        seed[hit.index] = 1;
        linkedFlood(me, m, seed, p.delimit as string);
        const sel = new Uint8Array(me.select_vert!);
        for (let i = 0; i < sel.length; i++) if (seed[i]) sel[i] = p.deselect ? 0 : 1;
        me.select_vert = sel;
        return 'FINISHED';
      }
      return 'CANCELLED';
    },
  },
  {
    idname: 'mesh.select_random',
    label: 'Select Random',
    props: [{ id: 'ratio', label: 'Ratio', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' }, { id: 'seed', label: 'Random Seed', type: 'int', default: 0, min: 0 }, { id: 'action', label: 'Action', type: 'enum', default: 'SELECT', items: [['SELECT', 'Select'], ['DESELECT', 'Deselect']] }],
    poll: editPoll,
    exec: (_ctx, p) => {
      let s = (p.seed as number) * 7919 + 1;
      const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      eachMesh((me) => {
        const sel = new Uint8Array(me.select_vert!);
        if (selectMode() === 'FACE') {
          for (let f = 0; f < me.offsets.length - 1; f++) if (rnd() < (p.ratio as number)) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) sel[me.indices[c]] = p.action === 'SELECT' ? 1 : 0;
        } else for (let i = 0; i < sel.length; i++) if (rnd() < (p.ratio as number)) sel[i] = p.action === 'SELECT' ? 1 : 0;
        me.select_vert = sel;
      });
    },
  },
  {
    idname: 'mesh.select_nth',
    label: 'Checker Deselect',
    props: [{ id: 'skip', label: 'Deselected', type: 'int', default: 1, min: 1 }, { id: 'nth', label: 'Selected', type: 'int', default: 1, min: 1 }, { id: 'offset', label: 'Offset', type: 'int', default: 0 }],
    poll: editPoll,
    exec: (_ctx, p) => {
      eachMesh((me) => {
        const sel = new Uint8Array(me.select_vert!);
        const period = (p.skip as number) + (p.nth as number);
        if (selectMode() === 'FACE') {
          let k = 0;
          const faces: number[] = [];
          for (let f = 0; f < me.offsets.length - 1; f++) {
            let all = true;
            for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (!sel[me.indices[c]]) all = false;
            if (all) faces.push(f);
          }
          sel.fill(0);
          for (const f of faces) {
            if ((k++ + (p.offset as number)) % period < (p.nth as number)) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) sel[me.indices[c]] = 1;
          }
        } else {
          let k = 0;
          for (let i = 0; i < sel.length; i++) if (sel[i]) sel[i] = (k++ + (p.offset as number)) % period < (p.nth as number) ? 1 : 0;
        }
        me.select_vert = sel;
      });
    },
  },
  {
    idname: 'mesh.select_non_manifold',
    label: 'Select Non-Manifold',
    props: [{ id: 'extend', label: 'Extend', type: 'bool', default: true }, { id: 'use_wire', label: 'Wire', type: 'bool', default: true }, { id: 'use_boundary', label: 'Boundaries', type: 'bool', default: true }, { id: 'use_multi_face', label: 'Multiple Faces', type: 'bool', default: true }, { id: 'use_verts', label: 'Vertices', type: 'bool', default: true }],
    poll: (ctx) => editPoll(ctx) && selectMode() !== 'FACE',
    exec: (_ctx, p) => {
      eachMesh((me, m) => {
        const sel = p.extend ? new Uint8Array(me.select_vert!) : new Uint8Array(me.positions.length / 3);
        const ef = m.edgeFaces();
        for (const [k, l] of ef) {
          const [a, b] = k.split(':').map(Number);
          if ((p.use_boundary && l.length === 1) || (p.use_multi_face && l.length > 2)) sel[a] = sel[b] = 1;
        }
        if (p.use_wire) for (const [a, b] of m.looseEdges) sel[a] = sel[b] = 1;
        if (p.use_verts) {
          const vf = m.vertexFaces();
          vf.forEach((fs, v) => {
            if (!fs.length && !m.looseEdges.some((e) => e[0] === v || e[1] === v)) sel[v] = 1;
          });
        }
        me.select_vert = sel;
      });
    },
  },
  {
    idname: 'mesh.select_loose',
    label: 'Select Loose Geometry',
    props: [{ id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) => {
      eachMesh((me, m) => {
        const sel = p.extend ? new Uint8Array(me.select_vert!) : new Uint8Array(me.positions.length / 3);
        const used = new Uint8Array(sel.length);
        for (const f of m.faces) for (const v of f.verts) used[v] = 1;
        for (let i = 0; i < sel.length; i++) if (!used[i]) sel[i] = 1;
        me.select_vert = sel;
      });
    },
  },
  {
    idname: 'mesh.select_face_by_sides',
    label: 'Select Faces by Sides',
    props: [{ id: 'number', label: 'Number of Vertices', type: 'int', default: 4, min: 3 }, { id: 'type', label: 'Type', type: 'enum', default: 'EQUAL', items: [['LESS', 'Less Than'], ['EQUAL', 'Equal To'], ['GREATER', 'Greater Than'], ['NOTEQUAL', 'Not Equal To']] }, { id: 'extend', label: 'Extend', type: 'bool', default: true }],
    poll: editPoll,
    exec: (_ctx, p) => {
      eachMesh((me) => {
        const sel = p.extend ? new Uint8Array(me.select_vert!) : new Uint8Array(me.positions.length / 3);
        const N = p.number as number;
        for (let f = 0; f < me.offsets.length - 1; f++) {
          const n = me.offsets[f + 1] - me.offsets[f];
          const ok = p.type === 'LESS' ? n < N : p.type === 'GREATER' ? n > N : p.type === 'NOTEQUAL' ? n !== N : n === N;
          if (ok) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) sel[me.indices[c]] = 1;
        }
        me.select_vert = sel;
      });
    },
  },
  {
    idname: 'mesh.select_mirror',
    label: 'Select Mirror',
    props: [{ id: 'axis', label: 'Axis', type: 'bools', default: [true, false, false] }, { id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) => {
      eachMesh((me) => {
        const P = me.positions,
          n = P.length / 3;
        const ax = (p.axis as boolean[]).map((b) => (b ? -1 : 1));
        const grid = new Map<string, number>();
        const key = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
        for (let i = 0; i < n; i++) grid.set(key(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]), i);
        const sel = p.extend ? new Uint8Array(me.select_vert!) : new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          if (!me.select_vert![i]) continue;
          const j = grid.get(key(P[i * 3] * ax[0], P[i * 3 + 1] * ax[1], P[i * 3 + 2] * ax[2]));
          if (j !== undefined) sel[j] = 1;
        }
        me.select_vert = sel;
      });
    },
  },
  {
    idname: 'mesh.loop_multi_select',
    label: 'Multi Select Loops',
    props: [{ id: 'ring', label: 'Ring', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) => {
      eachMesh((me, m) => {
        const sel = new Uint8Array(me.select_vert!);
        for (const [a, b] of m.selectedEdges()) for (const [x, y] of p.ring ? edgeRing(me, a, b) : edgeLoop(me, a, b)) sel[x] = sel[y] = 1;
        me.select_vert = sel;
      });
    },
  },
  {
    idname: 'mesh.hide',
    label: 'Hide Selected',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) => {
      for (const { me } of editMeshObjects()) {
        ensureSelection(me);
        const n = me.positions.length / 3;
        const hide = new Uint8Array(me.hide_vert ?? new Uint8Array(n));
        const sel = new Uint8Array(me.select_vert!);
        if (selectMode() === 'FACE' && !p.unselected) {
          // hide vertices only used by selected faces
          const m = MeshEdit.from(me);
          const vf = m.vertexFaces();
          const fsel = new Set(m.selectedFaces());
          vf.forEach((fs, v) => {
            if (fs.length && fs.every((f) => fsel.has(f))) hide[v] = 1;
          });
        } else for (let i = 0; i < n; i++) if (p.unselected ? !sel[i] : sel[i]) hide[i] = 1;
        for (let i = 0; i < n; i++) if (hide[i]) sel[i] = 0;
        me.hide_vert = hide;
        me.select_vert = sel;
      }
    },
  },
  {
    idname: 'mesh.reveal',
    label: 'Reveal Hidden',
    props: [{ id: 'select', label: 'Select', type: 'bool', default: true }],
    poll: editPoll,
    exec: (_ctx, p) => {
      for (const { me } of editMeshObjects()) {
        if (!me.hide_vert) continue;
        ensureSelection(me);
        const sel = new Uint8Array(me.select_vert!);
        me.hide_vert.forEach((h, i) => h && p.select && (sel[i] = 1));
        me.select_vert = sel;
        me.hide_vert = undefined;
      }
    },
  },
]);

function linkedFlood(me: MeshData, m: MeshEdit, sel: Uint8Array, delimit: string) {
  const ef = m.edgeFaces();
  const blocked = new Set<string>();
  if (delimit === 'SEAM' || delimit === 'SHARP') {
    for (const f of m.faces)
      for (let i = 0; i < f.verts.length; i++) {
        if ((delimit === 'SEAM' && f.seams[i]) || (delimit === 'SHARP' && f.sharp[i])) blocked.add(edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]));
      }
  }
  // flood over faces through non-blocked edges, starting from faces touching selection
  const faceSel = new Uint8Array(m.faces.length);
  const stack: number[] = [];
  m.faces.forEach((f, fi) => {
    if (f.verts.some((v) => sel[v])) {
      faceSel[fi] = 1;
      stack.push(fi);
    }
  });
  while (stack.length) {
    const fi = stack.pop()!;
    const f = m.faces[fi];
    for (let i = 0; i < f.verts.length; i++) {
      const k = edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]);
      if (blocked.has(k)) continue;
      for (const [g] of ef.get(k) ?? []) {
        if (faceSel[g]) continue;
        if (delimit === 'MATERIAL' && m.faces[g].material !== f.material) continue;
        faceSel[g] = 1;
        stack.push(g);
      }
    }
  }
  m.faces.forEach((f, fi) => faceSel[fi] && f.verts.forEach((v) => (sel[v] = 1)));
  // loose edges
  let grew = true;
  while (grew) {
    grew = false;
    for (const [a, b] of m.looseEdges)
      if (sel[a] !== sel[b]) {
        sel[a] = sel[b] = 1;
        grew = true;
      }
  }
  void me;
}
