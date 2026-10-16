// Extrude variants: along normals, manifold, repeat, screw, plus exec (redo) support for the
// basic extrude operators.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { app, registerOperators, type OpContext } from '../../app/app';
import { startTransform } from '../../ops/transform';
import { activeView3D } from '../../editors/view3d/view3d';
import { MeshEdit, edgeKey } from './meshedit';
import { withEdit, editMeshObjects } from './context';
import { editPoll } from './ops-basic';
import { extrudeRegion, extrudeTypes } from './ops-topology';
import { flipFace } from './ops-basic';
import { V, vertexNormalsFromFaces, dissolveEdgeSet, dissolveCollinearVerts, edgeChains } from './geom';

/** Move every selected vertex along the normal of its selected faces (shrink/fatten). */
export function shrinkFatten(m: MeshEdit, value: number) {
  const normals = vertexNormalsFromFaces(m, m.selectedFaces());
  for (const v of m.selectedVerts()) {
    const n = normals.get(v);
    if (!n) continue;
    const p = V(m.p(v)).addScaledVector(n, value);
    m.setP(v, [p.x, p.y, p.z]);
  }
}

/** Move selected vertices by a local-space vector. */
export function moveSelected(m: MeshEdit, d: Vector3) {
  for (const v of m.selectedVerts()) m.setP(v, [m.pos[v * 3] + d.x, m.pos[v * 3 + 1] + d.y, m.pos[v * 3 + 2] + d.z]);
}

/**
 * After extruding and moving, merge each side wall into the neighbouring face when both are
 * coplanar (so extruding a face of a box outwards along its normal keeps clean quads).
 */
export function dissolveOrthogonalWalls(m: MeshEdit, angle = 1e-3): number {
  const ef = m.edgeFaces();
  const isWall = (fi: number) => {
    const f = m.faces[fi];
    return f.verts.some((v) => m.sel[v]) && f.verts.some((v) => !m.sel[v]);
  };
  const keys = new Set<string>();
  const touched = new Set<number>();
  for (const [k, l] of ef) {
    if (l.length !== 2) continue;
    const [a, b] = k.split(':').map(Number);
    if (m.sel[a] || m.sel[b]) continue;
    const [fa] = l[0],
      [fb] = l[1];
    const wa = isWall(fa),
      wb = isWall(fb);
    if (wa === wb) continue;
    const na = V(m.faceNormal(m.faces[fa])),
      nb = V(m.faceNormal(m.faces[fb]));
    if (na.angleTo(nb) > angle) continue;
    keys.add(k);
    touched.add(a).add(b);
  }
  if (!keys.size) return 0;
  const n = dissolveEdgeSet(m, keys);
  dissolveCollinearVerts(m, touched);
  return n;
}

/** Extrude the selection `steps` times, moving by `offset` (local) each time. */
export function extrudeRepeat(m: MeshEdit, steps: number, offset: Vector3) {
  for (let i = 0; i < steps; i++) {
    if (!extrudeRegion(m)) return i > 0;
    moveSelected(m, offset);
  }
  return steps > 0;
}

/** Spin the selected edge profile around an axis several turns, advancing along the axis by the profile's end-to-end offset per turn. */
export function screw(m: MeshEdit, steps: number, turns: number, center: Vector3, axis: Vector3): boolean {
  const edges = m.selectedEdges();
  const chains = edgeChains(edges);
  if (!edges.length || chains.length !== 1) return false;
  const chain = chains[0];
  axis = axis.clone().normalize();
  // advance per turn: the offset from the profile's later end to its first end (lowest index), along the axis
  const ends = [chain.verts[0], chain.verts[chain.verts.length - 1]].sort((a, b) => a - b);
  const advance = chain.closed ? 0 : V(m.p(ends[0])).sub(V(m.p(ends[1]))).dot(axis);
  const total = steps * turns;
  const profile = chain.verts;
  let prev = new Map(profile.map((v) => [v, v]));
  for (let s = 1; s <= total; s++) {
    const q = new Quaternion().setFromAxisAngle(axis, (Math.PI * 2 * s) / steps);
    const shift = axis.clone().multiplyScalar((advance * s) / steps);
    const cur = new Map<number, number>();
    for (const v of profile) {
      const p = V(m.p(v)).sub(center).applyQuaternion(q).add(center).add(shift);
      cur.set(v, m.addVert([p.x, p.y, p.z], [[v, 1]], s === total ? 1 : 0));
    }
    for (const [a, b] of edges) m.faces.push(m.makeFace([prev.get(a)!, prev.get(b)!, cur.get(b)!, cur.get(a)!]));
    prev = cur;
  }
  for (const v of profile) m.sel[v] = 0;
  return true;
}

/** Extrude each selected edge into a quad (faces are ignored; edges share their new vertices). */
export function extrudeEdges(m: MeshEdit): boolean {
  const edges = m.selectedEdges();
  if (!edges.length) return false;
  const ef = m.edgeFaces();
  const map = new Map<number, number>();
  for (const [a, b] of edges) {
    for (const v of [a, b]) if (!map.has(v)) map.set(v, m.addVert(m.p(v), [[v, 1]], 1));
    // orient like an adjacent face so normals stay consistent
    const l = ef.get(edgeKey(a, b));
    let x = a,
      y = b;
    if (l?.length && m.faces[l[0][0]].verts[l[0][1]] === a) {
      x = b;
      y = a;
    }
    m.faces.push(m.makeFace([x, y, map.get(y)!, map.get(x)!], l?.length ? m.faces[l[0][0]] : undefined, [0, 0, 1, 0, 1, 1, 0, 1]));
  }
  for (const v of map.keys()) m.sel[v] = 0;
  return true;
}

/** Extrude each selected vertex into a new wire edge. */
export function extrudeVerts(m: MeshEdit): boolean {
  const verts = m.selectedVerts();
  if (!verts.length) return false;
  for (const v of verts) {
    const nv = m.addVert(m.p(v), [[v, 1]], 1);
    m.looseEdges.push([v, nv]);
    m.sel[v] = 0;
  }
  return true;
}

/** World-space vector → local vector of an object (rotation/scale only). */
function toLocal(ob: { id: string }, d: Vector3) {
  const inv = (app.graph.get(ob.id)?.world ?? new Matrix4()).clone().invert();
  return d.clone().applyMatrix4(new Matrix4().copy(inv).setPosition(0, 0, 0));
}

function regionNormalWorld(): Vector3 {
  const n = new Vector3();
  for (const { ob, me } of editMeshObjects()) {
    const w = app.graph.get(ob.id)?.world ?? new Matrix4();
    const m = MeshEdit.from(me);
    for (const fi of m.selectedFaces()) n.add(V(m.faceNormal(m.faces[fi])).transformDirection(w));
  }
  return n.lengthSq() ? n.normalize() : new Vector3(0, 0, 1);
}

/** Extrude (region) then translate interactively; faces move along their normal. */
function invokeExtrudeMove(ctx: OpContext, idname: string, label: string, opts: { dissolveOrtho?: boolean; free?: boolean } = {}) {
  let faces = false;
  if (!withEdit((m) => {
    if (!m.selectedVerts().length) return false;
    // nothing to extrude in this select mode: the selection is simply moved
    const k = extrudeRegion(m, false, extrudeTypes());
    if (k === 'FACES') faces = true;
  }))
    return 'CANCELLED' as const;
  app.flush();
  const normal = faces && !opts.free ? regionNormalWorld() : null;
  const ok = startTransform('TRANSLATION', {
    event: ctx.event,
    constraint: normal ? [false, false, true] : undefined,
    orient: normal ? 'NORMAL' : undefined,
    label,
    redo: (v) => {
      // the walls can only be merged once the final position is known
      if (opts.dissolveOrtho) withEdit((m) => dissolveOrthogonalWalls(m) > 0);
      return { idname, props: { value: v, use_dissolve_ortho_edges: !!opts.dissolveOrtho } };
    },
  });
  return ok ? ('RUNNING_MODAL' as const) : ('CANCELLED' as const);
}

function execExtrudeMove(p: Record<string, unknown>) {
  const value = V((p.value as number[]) ?? [0, 0, 0]);
  const ok = withEdit((m, ob) => {
    if (!m.selectedVerts().length) return false;
    extrudeRegion(m, false, extrudeTypes());
    moveSelected(m, toLocal(ob, value));
    if (p.use_dissolve_ortho_edges) dissolveOrthogonalWalls(m);
  });
  return ok ? ('FINISHED' as const) : ('CANCELLED' as const);
}

function invokeExtrudeShrink(ctx: OpContext, idname: string, label: string, individual = false) {
  if (!withEdit((m) => extrudeRegion(m, individual, individual ? { edges: false, verts: false } : extrudeTypes()) !== null)) return 'CANCELLED' as const;
  app.flush();
  return startTransform('SHRINKFATTEN', { event: ctx.event, label, redo: (v) => ({ idname, props: { value: v[0] } }) }) ? ('RUNNING_MODAL' as const) : ('CANCELLED' as const);
}

const moveProps = [
  { id: 'value', label: 'Move', type: 'vec3' as const, default: [0, 0, 0], subtype: 'distance' as const },
  { id: 'use_dissolve_ortho_edges', label: 'Dissolve Orthogonal Edges', type: 'bool' as const, default: false },
];
const offsetProp = [{ id: 'value', label: 'Offset', type: 'float' as const, default: 0, subtype: 'distance' as const }];

registerOperators([
  {
    idname: 'view3d.edit_mesh_extrude_move_normal',
    label: 'Extrude and Move on Normals',
    description: 'Extrude the selection and move it, along the normal for faces',
    props: moveProps,
    poll: editPoll,
    invoke: (ctx, p) => invokeExtrudeMove(ctx, 'view3d.edit_mesh_extrude_move_normal', 'Extrude Region and Move', { dissolveOrtho: !!p.use_dissolve_ortho_edges }),
    exec: (_ctx, p) => execExtrudeMove(p),
  },
  {
    idname: 'mesh.extrude_context_move',
    label: 'Extrude Region and Move',
    description: 'Extrude whatever is selected (faces, edges or vertices) and move the result',
    props: moveProps,
    poll: editPoll,
    invoke: (ctx, p) => invokeExtrudeMove(ctx, 'mesh.extrude_context_move', 'Extrude Region and Move', { dissolveOrtho: !!p.use_dissolve_ortho_edges }),
    exec: (_ctx, p) => execExtrudeMove(p),
  },
  {
    idname: 'mesh.extrude_manifold',
    label: 'Extrude Manifold',
    description: 'Extrude faces and merge the new side walls into coplanar neighbours, keeping the surface closed',
    props: moveProps.map((d) => (d.id === 'use_dissolve_ortho_edges' ? { ...d, default: true } : d)),
    poll: editPoll,
    invoke: (ctx) => invokeExtrudeMove(ctx, 'mesh.extrude_manifold', 'Extrude Manifold', { dissolveOrtho: true }),
    exec: (_ctx, p) => execExtrudeMove(p),
  },
  {
    idname: 'view3d.edit_mesh_extrude_move_shrink_fatten',
    label: 'Extrude and Move on Individual Normals',
    description: 'Extrude the selected region and offset each vertex along its own normal',
    props: offsetProp,
    poll: editPoll,
    invoke: (ctx) => invokeExtrudeShrink(ctx, 'view3d.edit_mesh_extrude_move_shrink_fatten', 'Extrude Faces Along Normals'),
    exec: (_ctx, p) => (withEdit((m) => (extrudeRegion(m, false, extrudeTypes()) ? void shrinkFatten(m, p.value as number) : false)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.extrude_region_shrink_fatten',
    label: 'Extrude Region and Shrink/Fatten',
    description: 'Extrude the selected region and offset it along the vertex normals',
    props: offsetProp,
    poll: editPoll,
    invoke: (ctx) => invokeExtrudeShrink(ctx, 'mesh.extrude_region_shrink_fatten', 'Extrude Region and Shrink/Fatten'),
    exec: (_ctx, p) => (withEdit((m) => (extrudeRegion(m, false, extrudeTypes()) ? void shrinkFatten(m, p.value as number) : false)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.extrude_faces_move',
    label: 'Extrude Individual Faces and Move',
    description: 'Extrude each selected face separately and offset it along its normal',
    props: offsetProp,
    poll: editPoll,
    invoke: (ctx) => invokeExtrudeShrink(ctx, 'mesh.extrude_faces_move', 'Extrude Individual Faces', true),
    exec: (_ctx, p) => (withEdit((m) => (m.selectedFaces().length && extrudeRegion(m, true, { edges: false, verts: false }) ? void shrinkFatten(m, p.value as number) : false)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.extrude_edges_move',
    label: 'Extrude Edges and Move',
    description: 'Extrude the selected edges into faces and move them',
    props: [moveProps[0]],
    poll: editPoll,
    invoke: (ctx) => {
      if (!withEdit((m) => extrudeEdges(m))) return 'CANCELLED';
      app.flush();
      return startTransform('TRANSLATION', { event: ctx.event, label: 'Extrude Edges', redo: (v) => ({ idname: 'mesh.extrude_edges_move', props: { value: v } }) }) ? 'RUNNING_MODAL' : 'CANCELLED';
    },
    exec: (_ctx, p) => (withEdit((m, ob) => (extrudeEdges(m) ? void moveSelected(m, toLocal(ob, V(p.value as number[]))) : false)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.extrude_vertices_move',
    label: 'Extrude Vertices and Move',
    description: 'Extrude the selected vertices into edges and move them',
    props: [moveProps[0]],
    poll: editPoll,
    invoke: (ctx) => {
      if (!withEdit((m) => extrudeVerts(m))) return 'CANCELLED';
      app.flush();
      return startTransform('TRANSLATION', { event: ctx.event, label: 'Extrude Vertices', redo: (v) => ({ idname: 'mesh.extrude_vertices_move', props: { value: v } }) }) ? 'RUNNING_MODAL' : 'CANCELLED';
    },
    exec: (_ctx, p) => (withEdit((m, ob) => (extrudeVerts(m) ? void moveSelected(m, toLocal(ob, V(p.value as number[]))) : false)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.extrude_repeat',
    label: 'Extrude Repeat',
    description: 'Extrude the selection several times in a row, each copy offset from the previous one',
    props: [
      { id: 'steps', label: 'Steps', type: 'int', default: 10, min: 0, max: 1000000, softMax: 180 },
      { id: 'offset', label: 'Offset', type: 'vec3', default: [0, 0, 0], subtype: 'distance' },
      { id: 'scale_offset', label: 'Scale Offset', type: 'float', default: 1, min: 0, softMax: 100 },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      let off = V(p.offset as number[]);
      if (off.lengthSq() === 0) {
        // no offset given: step towards the viewer
        const v = activeView3D();
        off = v ? new Vector3(0, 0, 1).applyQuaternion(v.camera.quaternion) : new Vector3(0, 0, 1);
        p.offset = [off.x, off.y, off.z];
      }
      const scaled = off.clone().multiplyScalar(p.scale_offset as number);
      return withEdit((m, ob) => extrudeRepeat(m, p.steps as number, toLocal(ob, scaled))) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'mesh.screw',
    label: 'Screw',
    description: 'Sweep the selected edge profile around the 3D cursor in a helix',
    props: [
      { id: 'steps', label: 'Steps', type: 'int', default: 9, min: 1, max: 100000, softMax: 256 },
      { id: 'turns', label: 'Turns', type: 'int', default: 1, min: 1, max: 100000, softMax: 256 },
      { id: 'center', label: 'Center', type: 'vec3', default: null, subtype: 'distance' },
      { id: 'axis', label: 'Axis', type: 'vec3', default: null },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const c = p.center ? V(p.center as number[]) : V(app.doc.scene.cursor.location);
      p.center = [c.x, c.y, c.z];
      let axis = p.axis ? V(p.axis as number[]) : null;
      if (!axis || axis.lengthSq() === 0) {
        const v = activeView3D();
        axis = v ? new Vector3(0, 0, 1).applyQuaternion(v.camera.quaternion) : new Vector3(0, 0, 1);
        p.axis = [axis.x, axis.y, axis.z];
      }
      const ax = axis;
      const ok = withEdit((m, ob) => {
        const inv = (app.graph.get(ob.id)?.world ?? new Matrix4()).clone().invert();
        return screw(m, p.steps as number, p.turns as number, c.clone().applyMatrix4(inv), ax.clone().transformDirection(inv));
      });
      if (!ok) {
        app.report('ERROR', 'Select one connected chain of edges to screw');
        return 'CANCELLED';
      }
    },
  },
]);

// ---------------------------------------------------------------------------
// extrude without moving (building blocks for scripts and macros) and the context-aware variants

/** Turn every face touching the new (selected) geometry around. */
function flipNew(m: MeshEdit) {
  for (const f of m.faces) if (f.verts.some((v) => m.sel[v])) flipFace(f);
}

const flipProp = { id: 'use_normal_flip', label: 'Flip Normals', type: 'bool' as const, default: false };
const orthoProp = { id: 'use_dissolve_ortho_edges', label: 'Dissolve Orthogonal Edges', type: 'bool' as const, default: false };
const extrudeOnly = (individual: boolean) => (_ctx: OpContext, p: Record<string, unknown>) =>
  withEdit((m) => {
    if (!extrudeRegion(m, individual, individual ? { edges: false, verts: false } : extrudeTypes())) return false;
    if (p.use_normal_flip) flipNew(m);
  })
    ? ('FINISHED' as const)
    : ('CANCELLED' as const);

/** Faces selected anywhere in the edited meshes? */
const anyFaceSelected = () => editMeshObjects().some(({ me }) => MeshEdit.from(me).selectedFaces().length > 0);

registerOperators([
  {
    idname: 'mesh.extrude_region',
    label: 'Extrude Region',
    description: 'Extrude the selected faces as one region (plus selected edges and vertices the select mode allows), without moving them',
    props: [flipProp, orthoProp],
    poll: editPoll,
    exec: extrudeOnly(false),
  },
  {
    idname: 'mesh.extrude_context',
    label: 'Extrude Context',
    description: 'Extrude whatever the select mode makes extrudable, without moving it',
    props: [flipProp, orthoProp],
    poll: editPoll,
    exec: extrudeOnly(false),
  },
  {
    idname: 'mesh.extrude_verts_indiv',
    label: 'Extrude Only Vertices',
    description: 'Give every selected vertex a new edge, ignoring the edges and faces between them',
    poll: editPoll,
    exec: () => (withEdit((m) => extrudeVerts(m)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.extrude_edges_indiv',
    label: 'Extrude Only Edges',
    description: 'Turn every selected edge into a new face, ignoring the faces between them',
    props: [flipProp],
    poll: editPoll,
    exec: (_ctx, p) =>
      withEdit((m) => {
        if (!extrudeEdges(m)) return false;
        if (p.use_normal_flip) flipNew(m);
      })
        ? 'FINISHED'
        : 'CANCELLED',
  },
  {
    idname: 'mesh.extrude_faces_indiv',
    label: 'Extrude Individual Faces',
    description: 'Extrude every selected face on its own, without moving it',
    poll: editPoll,
    exec: extrudeOnly(true),
  },
  {
    idname: 'view3d.edit_mesh_extrude_individual_move',
    label: 'Extrude Individual and Move',
    description: 'Extrude each face along its own normal, or each edge / vertex on its own in Edge / Vertex select mode',
    poll: editPoll,
    invoke: (ctx) => {
      const [, e, f] = app.doc.scene.tool_settings.mesh_select_mode;
      const id = f && anyFaceSelected() ? 'mesh.extrude_faces_move' : e || f ? 'mesh.extrude_edges_move' : 'mesh.extrude_vertices_move';
      return app.run(id, {}, { event: ctx.event }) as 'RUNNING_MODAL' | 'CANCELLED' | 'FINISHED';
    },
  },
  {
    idname: 'view3d.edit_mesh_extrude_manifold_normal',
    label: 'Extrude Manifold Along Normals',
    description: 'Extrude the selected faces along their normal and merge the side walls into the neighbouring surface',
    poll: editPoll,
    invoke: (ctx) => app.run('mesh.extrude_manifold', {}, { event: ctx.event }) as 'RUNNING_MODAL' | 'CANCELLED' | 'FINISHED',
  },
]);
