// Rip (V / Alt+V): disconnect faces along the selected edges (or at a selected vertex) so the side
// nearest the mouse can be moved away, leaving a hole.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { startTransform } from '../../ops/transform';
import { activeView3D } from '../../editors/view3d/view3d';
import { MeshEdit, edgeKey } from './meshedit';
import { withEdit, inMeshEdit, worldMatrix } from './context';
import { extrudeRegion } from './ops-topology';

/**
 * Rip the selection. `side(faceIndex)` scores faces (lower = closer to the mouse); per selected
 * vertex, the fan group with the best score receives a new copy of the vertex.
 * Returns the number of new vertices.
 */
export function ripSelection(m: MeshEdit, score: (f: number) => number, ripMap?: Map<number, number>): number {
  const selEdges = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  const facesOf = new Map<number, number[]>();
  m.faces.forEach((f, fi) => {
    for (const v of f.verts) if (m.sel[v] && !m.hide[v]) (facesOf.get(v) ?? facesOf.set(v, []).get(v)!).push(fi);
  });
  const remapPerFace = new Map<number, Map<number, number>>(); // face → (old vertex → new vertex)
  let created = 0;
  const newSel: number[] = [];
  for (const [v, fs] of facesOf) {
    if (fs.length < 2) continue;
    // group the fan: faces sharing an edge through v that is NOT a selected (rip) edge stay together
    const parent = new Map(fs.map((f) => [f, f]));
    const find = (f: number): number => {
      while (parent.get(f) !== f) f = parent.get(f)!;
      return f;
    };
    const edgesAt = (fi: number) => {
      const vs = m.faces[fi].verts,
        n = vs.length,
        i = vs.indexOf(v);
      return [vs[(i + n - 1) % n], vs[(i + 1) % n]];
    };
    for (let i = 0; i < fs.length; i++)
      for (let j = i + 1; j < fs.length; j++) {
        const shared = edgesAt(fs[i]).filter((o) => edgesAt(fs[j]).includes(o));
        for (const o of shared) if (!selEdges.has(edgeKey(v, o))) parent.set(find(fs[i]), find(fs[j]));
      }
    const groups = new Map<number, number[]>();
    for (const f of fs) (groups.get(find(f)) ?? groups.set(find(f), []).get(find(f))!).push(f);
    let ripped: number[];
    if (groups.size >= 2) {
      // the group nearest the mouse moves
      let best: number[] = [],
        bs = Infinity;
      for (const g of groups.values()) {
        const s = Math.min(...g.map(score));
        if (s < bs) {
          bs = s;
          best = g;
        }
      }
      ripped = best;
    } else {
      // a lone vertex: rip the single face nearest the mouse out of the fan
      ripped = [fs.reduce((a, b) => (score(a) <= score(b) ? a : b))];
    }
    const nv = m.addVert(m.p(v), [[v, 1]], 1);
    ripMap?.set(v, nv);
    created++;
    newSel.push(nv);
    for (const f of ripped) (remapPerFace.get(f) ?? remapPerFace.set(f, new Map()).get(f)!).set(v, nv);
  }
  if (!created) return 0;
  for (const [f, map] of remapPerFace) m.faces[f].verts = m.faces[f].verts.map((x) => map.get(x) ?? x);
  // the moved side becomes the selection
  m.sel = m.sel.map(() => 0);
  for (const v of newSel) m.sel[v] = 1;
  return created;
}

/** Close the gap a rip opened with new faces between the old and the new vertices. */
export function ripFill(m: MeshEdit, ripMap: Map<number, number>) {
  const ef = m.edgeFaces();
  const done = new Set<string>();
  const first = m.faces.length;
  for (const [v, nv] of ripMap) {
    for (const [k, l] of ef) {
      if (l.length !== 1) continue;
      const [a, b] = k.split(':').map(Number);
      if (a !== v && b !== v) continue;
      const o = a === v ? b : a;
      const no = ripMap.get(o) ?? o;
      const twin = edgeKey(nv, no);
      if (!ef.has(twin) || done.has(k)) continue;
      done.add(k).add(twin);
      // the remaining face runs x→y along the old edge; the fill runs y→x then over to the new side
      const [fi, ci] = l[0];
      const f = m.faces[fi];
      const x = f.verts[ci],
        y = f.verts[(ci + 1) % f.verts.length];
      const map = (q: number) => ripMap.get(q) ?? q;
      const verts = [y, x, map(x), map(y)].filter((q, i, arr) => arr.indexOf(q) === i);
      if (verts.length >= 3) m.faces.push(m.makeFace(verts, f));
    }
  }
  return m.faces.length - first;
}

/** Extend boundary vertices: each gets a new vertex joined by a triangle on its boundary edge nearest `score`. */
export function ripEdge(m: MeshEdit, score: (v: number) => number): number {
  const ef = m.edgeFaces();
  const sel = m.selectedVerts();
  const created: number[] = [];
  for (const v of sel) {
    let best: { o: number; fi: number; ci: number } | null = null,
      bs = Infinity;
    for (const [k, l] of ef) {
      if (l.length !== 1) continue;
      const [a, b] = k.split(':').map(Number);
      if (a !== v && b !== v) continue;
      const o = a === v ? b : a;
      const s = score(o);
      if (s < bs) {
        bs = s;
        best = { o, fi: l[0][0], ci: l[0][1] };
      }
    }
    const nv = m.addVert(m.p(v), [[v, 1]], 1);
    created.push(nv);
    if (!best) {
      m.looseEdges.push([v, nv]);
      continue;
    }
    const f = m.faces[best.fi];
    const x = f.verts[best.ci],
      y = f.verts[(best.ci + 1) % f.verts.length];
    // new triangle on the open side of edge x→y, with the new vertex replacing v's role
    m.faces.push(m.makeFace(x === v ? [y, x, nv] : [nv, y, x], f));
  }
  m.sel = m.sel.map(() => 0);
  for (const v of created) m.sel[v] = 1;
  return created.length;
}

/** Rip the selection away from the side nearest the mouse; false when nothing could be ripped. */
function ripAtMouse(ev: { x: number; y: number } | undefined, fill: boolean): boolean {
  const v = activeView3D();
  if (!v) return false;
  const r = v.el.getBoundingClientRect();
  const mx = (ev?.x ?? app.pointer.x) - r.left,
    my = (ev?.y ?? app.pointer.y) - r.top;
  let total = 0;
  withEdit((m, ob) => {
    const w: Matrix4 = worldMatrix(ob);
    const centre = (fi: number) => {
      const c = new Vector3();
      for (const vi of m.faces[fi].verts) c.add(new Vector3(...m.p(vi)));
      c.multiplyScalar(1 / m.faces[fi].verts.length).applyMatrix4(w);
      const s = v.project(c);
      return Math.hypot(s.x - mx, s.y - my);
    };
    const ripMap = new Map<number, number>();
    const n = ripSelection(m, centre, ripMap);
    if (n && fill) ripFill(m, ripMap);
    total += n;
    return n > 0;
  });
  if (!total) app.report('WARNING', 'Cannot rip selected faces or vertices without connected geometry');
  return total > 0;
}

/** Extend the selected boundary vertices towards the mouse; false when nothing was extended. */
function ripEdgeAtMouse(ev: { x: number; y: number } | undefined): boolean {
  const v = activeView3D();
  if (!v) return false;
  const r = v.el.getBoundingClientRect();
  const mx = (ev?.x ?? app.pointer.x) - r.left,
    my = (ev?.y ?? app.pointer.y) - r.top;
  return withEdit((m, ob) => {
    const w = worldMatrix(ob);
    const dist = (vi: number) => {
      const s = v.project(new Vector3(...m.p(vi)).applyMatrix4(w));
      return Math.hypot(s.x - mx, s.y - my);
    };
    return ripEdge(m, dist) > 0;
  });
}

// the mouse position a rip was invoked at, so the redo panel can repeat it
let lastRipMouse: { x: number; y: number } | undefined;

registerOperators([
  {
    idname: 'mesh.rip_move',
    label: 'Rip',
    description: 'Disconnect vertex or edges from connected geometry and move them',
    props: [{ id: 'use_fill', label: 'Fill', type: 'bool', default: false }],
    poll: inMeshEdit,
    invoke: (ctx, p) => {
      if (!ripAtMouse(ctx.event, !!p.use_fill)) return 'CANCELLED';
      app.flush();
      return startTransform('TRANSLATION', { event: ctx.event, label: 'Rip' }) ? 'RUNNING_MODAL' : 'CANCELLED';
    },
  },
  {
    idname: 'mesh.rip',
    label: 'Rip',
    description: 'Tear the selection loose from the faces on the side nearest the mouse, leaving it in place',
    props: [{ id: 'use_fill', label: 'Fill', type: 'bool', default: false }],
    poll: inMeshEdit,
    invoke: (ctx, p) => {
      lastRipMouse = ctx.event ?? { ...app.pointer };
      return ripAtMouse(lastRipMouse, !!p.use_fill) ? 'FINISHED' : 'CANCELLED';
    },
    exec: (_ctx, p) => (ripAtMouse(lastRipMouse, !!p.use_fill) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.rip_edge',
    label: 'Extend Vertices',
    description: 'Extend the selected boundary vertices with new faces on the side nearest the mouse, leaving them in place',
    poll: inMeshEdit,
    invoke: (ctx) => {
      lastRipMouse = ctx.event ?? { ...app.pointer };
      return ripEdgeAtMouse(lastRipMouse) ? 'FINISHED' : 'CANCELLED';
    },
    exec: () => (ripEdgeAtMouse(lastRipMouse) ? 'FINISHED' : 'CANCELLED'),
  },
]);

registerOperators([
  {
    idname: 'mesh.dupli_extrude_cursor',
    label: 'Extrude to Cursor or Add',
    description: 'Duplicate and extrude the selection to the mouse position, or add a vertex there',
    poll: inMeshEdit,
    invoke: (ctx) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      const r = v.el.getBoundingClientRect();
      const mx = (ctx.event?.x ?? app.pointer.x) - r.left,
        my = (ctx.event?.y ?? app.pointer.y) - r.top;
      let done = false;
      withEdit((m, ob) => {
        const w = worldMatrix(ob),
          inv = w.clone().invert();
        const sel = m.sel.map((s, i) => (s && !m.hide[i] ? i : -1)).filter((i) => i >= 0);
        if (!sel.length) {
          // nothing selected: add a single vertex under the mouse at the 3D cursor depth
          const p = v.unproject(mx, my, new Vector3(...(ctx.doc.scene.cursor.location as [number, number, number]))).applyMatrix4(inv);
          m.sel = m.sel.map(() => 0);
          m.addVert([p.x, p.y, p.z], [], 1);
          done = true;
          return true;
        }
        const centre = new Vector3();
        for (const i of sel) centre.add(new Vector3(...m.p(i)));
        centre.multiplyScalar(1 / sel.length).applyMatrix4(w);
        const target = v.unproject(mx, my, centre);
        if (!extrudeRegion(m)) return false;
        const d = target.sub(centre).applyMatrix4(new Matrix4().copy(inv).setPosition(0, 0, 0));
        for (let i = 0; i < m.vcount; i++) if (m.sel[i]) m.setP(i, [m.p(i)[0] + d.x, m.p(i)[1] + d.y, m.p(i)[2] + d.z]);
        done = true;
        return true;
      });
      return done ? 'FINISHED' : 'CANCELLED';
    },
  },
]);

registerOperators([
  {
    idname: 'mesh.rip_edge_move',
    label: 'Extend Vertices',
    description: 'Extend the selected boundary vertices with new faces and move the new vertices',
    poll: inMeshEdit,
    invoke: (ctx) => {
      if (!ripEdgeAtMouse(ctx.event)) return 'CANCELLED';
      app.flush();
      return startTransform('TRANSLATION', { event: ctx.event, label: 'Extend Vertices' }) ? 'RUNNING_MODAL' : 'CANCELLED';
    },
  },
]);

addKeys('Mesh', [
  { key: 'V', op: 'mesh.rip_move', when: inMeshEdit },
  { key: 'V', alt: true, op: 'mesh.rip_move', props: { use_fill: true }, when: inMeshEdit },
  { key: 'D', alt: true, op: 'mesh.rip_edge_move', when: inMeshEdit },
]);
