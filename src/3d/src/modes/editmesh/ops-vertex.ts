// Vertex tools: Laplacian smoothing, blend from / propagate to shape keys, snap to symmetry,
// sort elements, randomize.
import { Vector3 } from 'three';
import { app, registerOperators, registerOperator, operators, onAppReady, type PropDef } from '../../app/app';
import { activeView3D } from '../../editors/view3d/view3d';
import { MeshEdit, edgeKey } from './meshedit';
import { withEdit, worldMatrix, editMeshObjects as editMeshObjectsList } from './context';
import { selectedFaceSet } from './selset';
import { editPoll } from './ops-basic';
import { V, vertexNormals } from './geom';

// ---------------------------------------------------------------------------
// Laplacian smooth

export interface LaplacianOptions {
  repeat: number;
  lambda: number;
  lambdaBorder: number;
  axes: [boolean, boolean, boolean];
  preserveVolume: boolean;
}

function volumeOf(m: MeshEdit) {
  let vol = 0;
  for (const f of m.faces)
    for (let i = 1; i < f.verts.length - 1; i++) vol += V(m.p(f.verts[0])).dot(V(m.p(f.verts[i])).cross(V(m.p(f.verts[i + 1]))));
  return vol / 6;
}

/** Smooth selected vertices towards the average of their neighbours (boundary vertices use their own factor). */
export function smoothLaplacian(m: MeshEdit, o: LaplacianOptions): boolean {
  const sel = m.selectedVerts();
  if (!sel.length) return false;
  const nb = m.neighbors();
  const ef = m.edgeFaces();
  const boundary = new Set<number>();
  for (const [k, l] of ef) if (l.length === 1) k.split(':').forEach((x) => boundary.add(Number(x)));
  const vol0 = o.preserveVolume ? volumeOf(m) : 0;
  for (let it = 0; it < o.repeat; it++) {
    const next = m.pos.slice();
    for (const v of sel) {
      // boundary vertices only follow their boundary neighbours
      const ns = boundary.has(v) ? nb[v].filter((w) => boundary.has(w) && ef.get(edgeKey(v, w))?.length === 1) : nb[v];
      if (!ns.length) continue;
      const lambda = boundary.has(v) ? o.lambdaBorder : o.lambda;
      // cotangent-free: inverse distance weights keep spacing more even than a plain average
      const c = new Vector3();
      let wsum = 0;
      const p = V(m.p(v));
      for (const w of ns) {
        const q = V(m.p(w));
        const wt = 1 / Math.max(1e-6, q.distanceTo(p));
        c.addScaledVector(q, wt);
        wsum += wt;
      }
      c.multiplyScalar(1 / wsum);
      for (let k = 0; k < 3; k++) if (o.axes[k]) next[v * 3 + k] = p.getComponent(k) + (c.getComponent(k) - p.getComponent(k)) * Math.min(1, lambda);
    }
    m.pos = next;
  }
  if (o.preserveVolume && vol0) {
    const vol1 = volumeOf(m);
    if (vol1 > 1e-12 && Math.sign(vol1) === Math.sign(vol0)) {
      // scale the smoothed vertices about their centroid to restore the enclosed volume
      const s = Math.cbrt(vol0 / vol1);
      const c = new Vector3();
      for (const v of sel) c.add(V(m.p(v)));
      c.multiplyScalar(1 / sel.length);
      for (const v of sel) {
        const p = V(m.p(v)).sub(c).multiplyScalar(s).add(c);
        m.setP(v, [o.axes[0] ? p.x : m.pos[v * 3], o.axes[1] ? p.y : m.pos[v * 3 + 1], o.axes[2] ? p.z : m.pos[v * 3 + 2]]);
      }
    }
  }
  if (m.keys.length) m.keys[0] = m.pos.slice();
  return true;
}

// ---------------------------------------------------------------------------
// shape keys

export function blendFromShape(m: MeshEdit, key: number, blend: number, add: boolean): boolean {
  const k = m.keys[key];
  if (!k) return false;
  const basis = m.keys[0] ?? m.pos;
  for (const v of m.selectedVerts())
    for (let c = 0; c < 3; c++) {
      const i = v * 3 + c;
      m.pos[i] = add ? m.pos[i] + (k[i] - basis[i]) * blend : m.pos[i] + (k[i] - m.pos[i]) * blend;
    }
  if (m.keys.length) m.keys[0] = m.pos.slice();
  return true;
}

/** Copy the selected vertices' positions into every shape key. */
export function propagateToShapes(m: MeshEdit): boolean {
  if (m.keys.length < 2) return false;
  for (const v of m.selectedVerts()) for (const k of m.keys) for (let c = 0; c < 3; c++) k[v * 3 + c] = m.pos[v * 3 + c];
  return true;
}

// ---------------------------------------------------------------------------
// snap to symmetry

export function symmetrySnap(m: MeshEdit, direction: string, threshold: number, factor: number, useCenter: boolean): { mirrored: number; already: number } {
  const axis = direction.endsWith('X') ? 0 : direction.endsWith('Y') ? 1 : 2;
  // the source side is the one named first ("-X to +X": -X is the source)
  const srcSign = direction.startsWith('NEGATIVE') ? -1 : 1;
  const sel = m.selectedVerts();
  const mirror = (p: Vector3) => {
    const q = p.clone();
    q.setComponent(axis, -q.getComponent(axis));
    return q;
  };
  let mirrored = 0,
    already = 0;
  const done = new Set<number>();
  const src = sel.filter((v) => m.pos[v * 3 + axis] * srcSign > threshold);
  const dst = sel.filter((v) => m.pos[v * 3 + axis] * srcSign < -threshold);
  for (const s of src) {
    const ps = V(m.p(s));
    const target = mirror(ps);
    let best = -1,
      bd = threshold;
    for (const d of dst) {
      if (done.has(d)) continue;
      const dist = V(m.p(d)).distanceTo(target);
      if (dist <= bd) {
        bd = dist;
        best = d;
      }
    }
    if (best < 0) continue;
    done.add(best);
    if (bd < 1e-7) {
      already++;
      continue;
    }
    const pd = V(m.p(best));
    // the destination moves towards the mirrored source by `factor`; the source becomes its mirror
    const nd = V(m.p(best)).lerp(target, factor);
    const ns = mirror(nd);
    m.setP(best, [nd.x, nd.y, nd.z]);
    m.setP(s, [ns.x, ns.y, ns.z]);
    mirrored++;
  }
  if (useCenter)
    for (const v of sel)
      if (Math.abs(m.pos[v * 3 + axis]) <= threshold) {
        if (m.pos[v * 3 + axis] === 0) already++;
        else mirrored++;
        m.pos[v * 3 + axis] = 0;
      }
  if (m.keys.length) m.keys[0] = m.pos.slice();
  return { mirrored, already };
}

// ---------------------------------------------------------------------------
// sort elements

/** Reorder vertices (new order lists old indices). */
export function permuteVerts(m: MeshEdit, order: number[]) {
  const map = new Array(m.vcount);
  order.forEach((old, i) => (map[old] = i));
  const pick = <T>(arr: T[], stride: number) => order.flatMap((o) => arr.slice(o * stride, o * stride + stride));
  m.pos = pick(m.pos, 3);
  m.sel = pick(m.sel, 1);
  m.hide = pick(m.hide, 1);
  m.weights = m.weights.map((w) => pick(w, 1));
  m.keys = m.keys.map((k) => pick(k, 3));
  m.pcolors = m.pcolors.map((c) => pick(c, 4));
  if (m.skin) m.skin = pick(m.skin, 4);
  for (const k in m.vfloat) m.vfloat[k] = pick(m.vfloat[k], 1);
  m.gattrs.forEach((g, k) => g.domain === 'POINT' && (m.vgen[k] = pick(m.vgen[k], g.width)));
  const rekey = (k: string) => k.split(':').map((x) => map[+x]).sort((a, b) => a - b).join(':');
  m.ebw = new Map([...m.ebw].map(([k, w]) => [rekey(k), w]));
  m.ebwMid = new Map([...m.ebwMid].map(([v, [a, b]]) => [map[v], [map[a], map[b]]]));
  m.fsEdges = new Set([...m.fsEdges].map(rekey));
  m.fsMid = new Map([...m.fsMid].map(([v, [a, b]]) => [map[v], [map[a], map[b]]]));
  m.edgeExcl = new Set([...m.edgeExcl].map(rekey));
  m.egen = m.egen.map((e) => new Map([...e].map(([k, w]) => [rekey(k), w])));
  for (const f of m.faces) f.verts = f.verts.map((v) => map[v]);
  m.looseEdges = m.looseEdges.map(([a, b]) => [map[a], map[b]] as [number, number]);
}

function seeded(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function sortElements(m: MeshEdit, type: string, elements: string[], reverse: boolean, seed: number, ctx: { view?: Vector3; viewX?: Vector3; cursor?: Vector3 }) {
  const sortIdx = (count: number, key: (i: number) => number, selected: (i: number) => boolean) => {
    // only selected elements move; they take the slots of the selected elements in sorted order
    const slots = Array.from({ length: count }, (_, i) => i).filter(selected);
    let sorted = [...slots];
    if (type === 'RANDOMIZE') {
      const rnd = seeded(seed);
      for (let i = sorted.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
      }
    } else if (type === 'REVERSE') sorted.reverse();
    else if (type === 'SELECTED') {
      // selected elements first, keeping their order
      const all = Array.from({ length: count }, (_, i) => i);
      const order = [...all.filter(selected), ...all.filter((i) => !selected(i))];
      return reverse ? order.reverse() : order;
    } else sorted.sort((a, b) => key(a) - key(b));
    if (reverse && type !== 'REVERSE') sorted.reverse();
    const order = Array.from({ length: count }, (_, i) => i);
    slots.forEach((slot, i) => (order[slot] = sorted[i]));
    return order;
  };
  const vkey = (p: Vector3) => (type === 'VIEW_ZAXIS' ? -(ctx.view ? p.dot(ctx.view) : p.z) : type === 'VIEW_XAXIS' ? (ctx.viewX ? p.dot(ctx.viewX) : p.x) : type === 'CURSOR_DISTANCE' ? p.distanceTo(ctx.cursor ?? new Vector3()) : 0);
  if (elements.includes('VERT')) {
    const order = sortIdx(m.vcount, (i) => vkey(V(m.p(i))), (i) => !!m.sel[i] && !m.hide[i]);
    permuteVerts(m, order);
  }
  if (elements.includes('FACE')) {
    const fsel = new Set(m.selectedFaces());
    const order = sortIdx(m.faces.length, (i) => (type === 'MATERIAL' ? m.faces[i].material : vkey(V(m.faceCenter(m.faces[i])))), (i) => fsel.has(i));
    m.faces = order.map((i) => m.faces[i]);
  }
}

// ---------------------------------------------------------------------------
// randomize

export function randomizeVerts(m: MeshEdit, offset: number, uniform: number, normal: number, seed: number) {
  if (!m.selectedVerts().length) return false;
  const rnd = seeded(seed + 1);
  const normals = normal ? vertexNormals(m) : null;
  for (const v of m.selectedVerts()) {
    // random direction inside the unit sphere
    let d: Vector3;
    do d = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    while (d.lengthSq() > 1);
    let len = offset;
    if (uniform) len *= 1 - uniform + uniform * rnd();
    if (normals && normal) d.lerp(normals[v].clone().multiplyScalar(rnd() * 2 - 1), normal);
    const p = V(m.p(v)).addScaledVector(d, len);
    m.setP(v, [p.x, p.y, p.z]);
  }
  if (m.keys.length) m.keys[0] = m.pos.slice();
  return true;
}

// ---------------------------------------------------------------------------

const shapeProp: PropDef = {
  id: 'shape',
  label: 'Shape',
  type: 'enum',
  default: '',
  get items(): [string, string][] {
    const ob = app.activeObject;
    const me = ob?.data ? app.doc.meshes[ob.data] : undefined;
    return (me?.shape_keys ?? []).slice(1).map((k) => [k.name, k.name]);
  },
};

const DIRECTIONS: [string, string][] = [
  ['NEGATIVE_X', '-X to +X'],
  ['POSITIVE_X', '+X to -X'],
  ['NEGATIVE_Y', '-Y to +Y'],
  ['POSITIVE_Y', '+Y to -Y'],
  ['NEGATIVE_Z', '-Z to +Z'],
  ['POSITIVE_Z', '+Z to -Z'],
];

registerOperators([
  {
    idname: 'mesh.vertices_smooth_laplacian',
    label: 'Laplacian Smooth Vertices',
    description: 'Smooth the selected vertices while keeping the overall volume',
    props: [
      { id: 'repeat', label: 'Number of Iterations', type: 'int', default: 1, min: 1, max: 1000, softMax: 200 },
      { id: 'lambda_factor', label: 'Lambda Factor', type: 'float', default: 1, min: 1e-7, max: 1000 },
      { id: 'lambda_border', label: 'Lambda Border', type: 'float', default: 5e-5, min: 1e-7, max: 1000 },
      { id: 'use_x', label: 'Smooth X Axis', type: 'bool', default: true },
      { id: 'use_y', label: 'Smooth Y Axis', type: 'bool', default: true },
      { id: 'use_z', label: 'Smooth Z Axis', type: 'bool', default: true },
      { id: 'preserve_volume', label: 'Preserve Volume', type: 'bool', default: true },
    ],
    poll: editPoll,
    exec: (_ctx, p) =>
      withEdit((m) => smoothLaplacian(m, { repeat: p.repeat as number, lambda: p.lambda_factor as number, lambdaBorder: p.lambda_border as number, axes: [!!p.use_x, !!p.use_y, !!p.use_z], preserveVolume: !!p.preserve_volume })) ? 'FINISHED' : 'CANCELLED',
  },
  {
    idname: 'mesh.blend_from_shape',
    label: 'Blend from Shape',
    description: 'Blend the selected vertices towards a shape key',
    props: [shapeProp, { id: 'blend', label: 'Blend', type: 'float', default: 1, min: -1000, max: 1000, softMin: -2, softMax: 2 }, { id: 'add', label: 'Add', type: 'bool', default: true }],
    poll: (ctx) => editPoll(ctx) && !!app.activeObject?.data && (app.doc.meshes[app.activeObject.data]?.shape_keys.length ?? 0) > 1,
    exec: (_ctx, p) => {
      const ok = withEdit((m, ob) => {
        const me = app.doc.meshes[ob.data!];
        let k = me.shape_keys.findIndex((s) => s.name === p.shape);
        if (k <= 0) k = me.shape_keys.length > 1 ? 1 : -1;
        if (k < 0) return false;
        p.shape = me.shape_keys[k].name;
        return blendFromShape(m, k, p.blend as number, !!p.add);
      });
      return ok ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'mesh.shape_propagate_to_all',
    label: 'Shape Propagate',
    description: 'Copy the selected vertices’ positions into all shape keys',
    poll: (ctx) => editPoll(ctx) && !!app.activeObject?.data && (app.doc.meshes[app.activeObject.data]?.shape_keys.length ?? 0) > 1,
    exec: () => (withEdit((m) => propagateToShapes(m)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.symmetry_snap',
    label: 'Snap to Symmetry',
    description: 'Move nearly mirrored vertex pairs so they are exactly symmetrical',
    props: [
      { id: 'direction', label: 'Direction', type: 'enum', default: 'NEGATIVE_X', items: DIRECTIONS },
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0.05, min: 0, max: 10, softMin: 0.0001, softMax: 1, subtype: 'distance' },
      { id: 'factor', label: 'Factor', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
      { id: 'use_center', label: 'Center', type: 'bool', default: true },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      let mirrored = 0,
        already = 0;
      withEdit((m) => {
        const r = symmetrySnap(m, p.direction as string, p.threshold as number, p.factor as number, !!p.use_center);
        mirrored += r.mirrored;
        already += r.already;
        return r.mirrored > 0;
      });
      app.report('INFO', `${already} already symmetrical, ${mirrored} snapped`);
    },
  },
  {
    idname: 'mesh.sort_elements',
    label: 'Sort Mesh Elements',
    description: 'Change the order of the selected vertices and faces',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'VIEW_ZAXIS',
        items: [
          ['VIEW_ZAXIS', 'View Z Axis', 'Sort from the farthest to the nearest element in the view'],
          ['VIEW_XAXIS', 'View X Axis', 'Sort from left to right in the view'],
          ['CURSOR_DISTANCE', 'Cursor Distance', 'Sort from the nearest to the farthest from the 3D cursor'],
          ['MATERIAL', 'Material', 'Sort faces by material slot'],
          ['SELECTED', 'Selected', 'Move the selected elements to the start'],
          ['RANDOMIZE', 'Randomize', 'Shuffle the selected elements'],
          ['REVERSE', 'Reverse', 'Reverse the order of the selected elements'],
        ],
      },
      { id: 'elements', label: 'Elements', type: 'enum', default: 'VERT', items: [['VERT', 'Vertices'], ['FACE', 'Faces'], ['BOTH', 'Vertices and Faces']] },
      { id: 'reverse', label: 'Reverse', type: 'bool', default: false },
      { id: 'seed', label: 'Seed', type: 'int', default: 0, min: 0, showIf: (p) => p.type === 'RANDOMIZE' },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const v = activeView3D();
      const view = v ? new Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion) : undefined;
      const viewX = v ? new Vector3(1, 0, 0).applyQuaternion(v.camera.quaternion) : undefined;
      const el = p.elements === 'BOTH' ? ['VERT', 'FACE'] : [p.elements as string];
      withEdit((m, ob) => {
        const inv = worldMatrix(ob).clone().invert();
        const cursor = V(app.doc.scene.cursor.location).applyMatrix4(inv);
        sortElements(m, p.type as string, el, !!p.reverse, p.seed as number, { view: view?.clone().transformDirection(inv), viewX: viewX?.clone().transformDirection(inv), cursor });
      });
    },
  },
]);

// ---------------------------------------------------------------------------
// set attribute (active color attribute) on the selection

registerOperators([
  {
    idname: 'mesh.attribute_set',
    label: 'Set Attribute',
    description: 'Set the active color attribute on the selected elements',
    props: [{ id: 'value_color', label: 'Value', type: 'color', default: [1, 1, 1, 1] }],
    poll: (ctx) => {
      if (!editPoll(ctx)) return false;
      const me = app.activeObject?.data ? app.doc.meshes[app.activeObject.data] : undefined;
      return !!me?.color_attributes[me.active_color_index];
    },
    exec: (_ctx, p) => {
      const col = (p.value_color as number[]).slice(0, 4);
      while (col.length < 4) col.push(1);
      let any = false;
      for (const { me } of editMeshObjectsList()) {
        const attr = me.color_attributes[me.active_color_index];
        if (!attr || !me.select_vert) continue;
        const data = new Float32Array(attr.data);
        if (attr.domain === 'POINT') {
          for (let v = 0; v < me.select_vert.length; v++) if (me.select_vert[v] && !me.hide_vert?.[v]) data.set(col, v * 4);
        } else {
          // corners of selected faces (or of selected vertices when no face is selected)
          const faces = selectedFaceSet(me);
          for (let f = 0; f < me.offsets.length - 1; f++)
            for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (faces.size ? faces.has(f) : me.select_vert[me.indices[c]]) data.set(col, c * 4);
        }
        me.color_attributes = me.color_attributes.map((c) => (c === attr ? { ...c, data } : c));
        any = true;
      }
      if (!any) return 'CANCELLED';
      app.changed('doc', 'geometry');
    },
  },
]);

// Randomize in mesh Edit Mode; other modes keep the general transform operator
const meshRandomize = (p: Record<string, unknown>) => void withEdit((m) => randomizeVerts(m, p.offset as number, p.uniform as number, p.normal as number, p.seed as number));
onAppReady(() => {
  const base = operators.get('transform.vertex_random');
  registerOperator({
    idname: 'transform.vertex_random',
    label: 'Randomize',
    description: 'Move the selected vertices by random amounts',
    props: [
      { id: 'offset', label: 'Amount', type: 'float', default: 0.1, min: -10000, max: 10000, softMin: -10, softMax: 10, subtype: 'distance' },
      { id: 'uniform', label: 'Uniform', type: 'float', default: 0, min: 0, max: 1, subtype: 'factor' },
      { id: 'normal', label: 'Normal', type: 'float', default: 0, min: 0, max: 1, subtype: 'factor' },
      { id: 'seed', label: 'Random Seed', type: 'int', default: 0, min: 0, max: 10000 },
    ],
    poll: (ctx) => editPoll(ctx) || !!base?.poll?.(ctx),
    invoke: base?.invoke ? (ctx, p) => (editPoll(ctx) ? meshRandomize(p) : base.invoke!(ctx, p)) : undefined,
    exec: (ctx, p) => (editPoll(ctx) ? meshRandomize(p) : base?.exec?.(ctx, p)),
  });
});
