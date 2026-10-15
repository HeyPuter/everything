// Sculpt Mode mask operators: mask from cavity / boundaries, random masks, mask by color, and
// mesh operations driven by the mask or a face set (extract, slice).
import { app, operators, registerOperators, type OpContext } from '../app/app';
import type { MeshData, ObjectData } from '../data/types';
import { newMeshData, newObject, uid } from '../data/defaults';
import { buildMesh, edgeTopology, type PolyFace } from '../mesh/mesh';
import { newModifier } from '../eval/modifiers';
import { activeCollection, uniqueName } from '../ops/object';
import { activeView3D } from '../editors/view3d/view3d';
import { activeMeshData, dropSession, meshSession } from './session';
import { boundaryVerts, faceSetBoundaryVerts, faceSetsOf, hiddenFacesOf, looseVertexParts } from './fsdata';
import { commitMask, editableMask } from './gestureops';
import { faceUnderCursor, lastHoveredFaceSet, sculptPoll } from './facesetops';
import { topologySteps } from './expandmath';
import { invalidatePaintAttributes } from './display';
import { vertexColors } from './vpaint';
import { boundaryLoops, cavityValues, hash01, mixMask, smoothValues } from './maskmath';
export { mixMask, boundaryLoops, cavityValues };

const MIX: [string, string, string][] = [
  ['MIX', 'Mix', 'Replace the mask'],
  ['MULTIPLY', 'Multiply', 'Multiply with the current mask'],
  ['DIVIDE', 'Divide', 'Divide the current mask'],
  ['ADD', 'Add', 'Add to the current mask'],
  ['SUBTRACT', 'Subtract', 'Subtract from the current mask'],
];

const mixProps = [
  { id: 'mix_mode', label: 'Mode', type: 'enum' as const, default: 'MIX', items: MIX },
  { id: 'mix_factor', label: 'Mix Factor', type: 'float' as const, default: 1, min: 0, max: 5, softMax: 1, subtype: 'factor' as const },
];

// ---------------------------------------------------------------------------
// sub-meshes (extract / slice)

/** Faces → new mesh arrays (vertices renumbered); optionally caps the open boundary loops. */
export function subMesh(me: MeshData, faces: Uint8Array, fillHoles = false): { arrays: ReturnType<typeof buildMesh>; vmap: Int32Array } {
  const nv = me.positions.length / 3;
  const vmap = new Int32Array(nv).fill(-1);
  const pos: number[] = [];
  const polys: PolyFace[] = [];
  for (let f = 0; f < faces.length; f++) {
    if (!faces[f]) continue;
    const verts: number[] = [];
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
      const v = me.indices[c];
      if (vmap[v] < 0) {
        vmap[v] = pos.length / 3;
        pos.push(me.positions[v * 3], me.positions[v * 3 + 1], me.positions[v * 3 + 2]);
      }
      verts.push(vmap[v]);
    }
    polys.push({ verts, uvs: Array.from(me.uvs.subarray(me.offsets[f] * 2, me.offsets[f + 1] * 2)), smooth: !!me.smooth?.[f], material: me.material_index?.[f] ?? 0 });
  }
  if (fillHoles) for (const loop of boundaryLoops(polys)) if (loop.length >= 3) polys.push({ verts: loop, smooth: polys[0]?.smooth, material: polys[0]?.material });
  return { arrays: buildMesh(pos, polys), vmap };
}

/** Add a new mesh object with the given arrays, sharing the transform and materials of `src`. */
function addMeshObject(src: ObjectData, me: MeshData, arrays: ReturnType<typeof buildMesh>, suffix: string): ObjectData {
  const doc = app.doc;
  const nme = newMeshData(uniqueName(doc, `${me.name}${suffix}`, 'meshes'), arrays);
  nme.materials = [...me.materials];
  doc.meshes[nme.id] = nme;
  const ob = newObject(uniqueName(doc, `${src.name}${suffix}`), 'MESH', nme.id);
  ob.location = [...src.location] as [number, number, number];
  ob.rotation_euler = [...src.rotation_euler] as [number, number, number];
  ob.rotation_mode = src.rotation_mode;
  ob.scale = [...src.scale] as [number, number, number];
  ob.parent = src.parent;
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[activeCollection(doc)].objects.push(ob.id);
  return ob;
}

/** Laplacian smoothing of the open border vertices of a mesh (keeps the extracted edge tidy). */
function smoothBorder(arr: ReturnType<typeof buildMesh>, iterations: number) {
  if (!iterations) return;
  const et = edgeTopology(arr);
  const nv = arr.positions.length / 3;
  const border = new Uint8Array(nv);
  const nbs: number[][] = Array.from({ length: nv }, () => []);
  for (let e = 0; e < et.count; e++)
    if (et.faceOffsets[e + 1] - et.faceOffsets[e] === 1) {
      const a = et.verts[e * 2],
        b = et.verts[e * 2 + 1];
      border[a] = border[b] = 1;
      nbs[a].push(b);
      nbs[b].push(a);
    }
  const P = arr.positions;
  for (let it = 0; it < iterations; it++) {
    const src = P.slice();
    for (let v = 0; v < nv; v++) {
      if (!border[v] || nbs[v].length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (const u of nbs[v]) s += src[u * 3 + c];
        P[v * 3 + c] = src[v * 3 + c] * 0.5 + (s / nbs[v].length) * 0.5;
      }
    }
  }
}

function extractFaces(faces: Uint8Array, p: Record<string, unknown>, suffix: string): 'CANCELLED' | void {
  const { ob, me } = activeMeshData()!;
  if (!faces.some((x) => x)) {
    app.report('WARNING', 'Nothing to extract');
    return 'CANCELLED';
  }
  const { arrays } = subMesh(me, faces, false);
  smoothBorder(arrays, p.smooth_iterations as number);
  const nob = addMeshObject(ob, me, arrays, suffix);
  if (p.apply_solidify) {
    const md = newModifier('SOLIDIFY', uid('md'), []);
    (md as unknown as Record<string, unknown>).thickness = p.extract_offset;
    (md as unknown as Record<string, unknown>).offset = 1;
    nob.modifiers.push(md);
  }
  app.report('INFO', `Extracted ${arrays.offsets.length - 1} faces into "${nob.name}"`);
}

const extractProps = [
  { id: 'smooth_iterations', label: 'Smooth Iterations', type: 'int' as const, default: 4, min: 0, max: 100 },
  { id: 'apply_solidify', label: 'Solidify', type: 'bool' as const, default: true },
  { id: 'extract_offset', label: 'Thickness', type: 'float' as const, default: 0.01, min: -1, max: 1, softMin: -0.2, softMax: 0.2, subtype: 'distance' as const, showIf: (q: Record<string, unknown>) => !!q.apply_solidify },
];

function maskedFaces(me: MeshData, threshold: number): Uint8Array {
  const nf = me.offsets.length - 1;
  const out = new Uint8Array(nf);
  const m = me.sculpt_mask;
  if (!m || m.length !== me.positions.length / 3) return out;
  for (let f = 0; f < nf; f++) {
    let all = 1;
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++)
      if (m[me.indices[c]] < threshold) {
        all = 0;
        break;
      }
    out[f] = all;
  }
  return out;
}

/** Replace the active mesh with a subset of its faces (keeps per-vertex sculpt data). */
function keepFaces(me: MeshData, keep: Uint8Array, fillHoles: boolean) {
  const { arrays, vmap } = subMesh(me, keep, fillHoles);
  const nv = arrays.positions.length / 3;
  const remapV = (a: Float32Array, comps = 1) => {
    const out = new Float32Array(nv * comps);
    for (let v = 0; v < vmap.length; v++) if (vmap[v] >= 0) for (let c = 0; c < comps; c++) out[vmap[v] * comps + c] = a[v * comps + c];
    return out;
  };
  const oldNv = me.positions.length / 3;
  const weights = me.weights.map((w) => (w && w.length === oldNv ? remapV(w) : new Float32Array(nv)));
  const mask = me.sculpt_mask && me.sculpt_mask.length === oldNv ? remapV(me.sculpt_mask) : undefined;
  const fsOld = faceSetsOf(me);
  let fs: Int32Array | undefined;
  if (fsOld) {
    const list: number[] = [];
    for (let f = 0; f < keep.length; f++) if (keep[f]) list.push(fsOld[f]);
    fs = new Int32Array(arrays.offsets.length - 1).fill(1);
    fs.set(list);
  }
  Object.assign(me, arrays);
  me.seams = arrays.seams;
  me.sharp = arrays.sharp;
  me.creases = arrays.creases;
  me.weights = weights;
  me.sculpt_mask = mask;
  me.sculpt_face_set = fs;
  me.color_attributes = me.color_attributes.filter((c) => c.domain === 'POINT').map((c) => ({ ...c, data: remapV(c.data, 4) }));
  me.active_color_index = Math.min(me.active_color_index, Math.max(0, me.color_attributes.length - 1));
  me.shape_keys = [];
  me.active_shape_key_index = 0;
  me.select_vert = undefined;
  me.hide_vert = undefined;
  me.hide_poly = undefined;
  me.loose_edges = undefined;
  me.uv_select = undefined;
  dropSession();
  invalidatePaintAttributes();
}

registerOperators([
  {
    idname: 'sculpt.mask_from_cavity',
    label: 'Mask from Cavity',
    description: 'Mask the cavities (or the peaks, inverted) of the mesh',
    props: [
      ...mixProps,
      { id: 'factor', label: 'Factor', type: 'float', default: 0.5, min: 0, max: 5, subtype: 'factor' },
      { id: 'blur_steps', label: 'Blur', type: 'int', default: 2, min: 0, max: 25 },
      { id: 'invert', label: 'Cavity (Inverted)', type: 'bool', default: false },
    ],
    poll: sculptPoll,
    exec: (_ctx, p) => {
      const s = meshSession();
      if (!s) return 'CANCELLED';
      const { me } = activeMeshData()!;
      const nb = s.neighbors;
      let cav = cavityValues(s.positions, s.vn, nb.offsets, nb.neighbors);
      cav = smoothValues(cav, nb.offsets, nb.neighbors, p.blur_steps as number);
      // map concavity to 0..1: the factor widens or narrows the response
      let max = 0;
      for (const c of cav) max = Math.max(max, Math.abs(c));
      const k = (p.factor as number) * 4 + 0.01;
      const mask = editableMask(me);
      for (let v = 0; v < s.nv; v++) {
        if (s.hiddenV?.[v]) continue;
        let val = max > 0 ? cav[v] / max : 0;
        if (p.invert) val = -val;
        val = Math.max(0, Math.min(1, val * k));
        mask[v] = mixMask(p.mix_mode as string, mask[v], val, p.mix_factor as number);
      }
      commitMask(me);
    },
  },
  {
    idname: 'sculpt.mask_from_boundary',
    label: 'Mask from Boundary',
    description: 'Mask the vertices near the mesh boundary or the face set borders',
    props: [
      ...mixProps,
      {
        id: 'boundary_mode',
        label: 'Mode',
        type: 'enum',
        default: 'MESH',
        items: [
          ['MESH', 'Mesh', 'Open mesh borders'],
          ['FACE_SETS', 'Face Sets', 'Borders between face sets'],
        ],
      },
      { id: 'propagation_steps', label: 'Propagation Steps', type: 'int', default: 1, min: 1, max: 20 },
    ],
    poll: sculptPoll,
    exec: (_ctx, p) => {
      const s = meshSession();
      if (!s) return 'CANCELLED';
      const { me } = activeMeshData()!;
      const b = p.boundary_mode === 'FACE_SETS' ? faceSetBoundaryVerts(me) : boundaryVerts(me);
      const sources: number[] = [];
      for (let v = 0; v < s.nv; v++) if (b[v]) sources.push(v);
      if (!sources.length) {
        app.report('INFO', p.boundary_mode === 'FACE_SETS' ? 'The mesh has a single face set' : 'The mesh has no open boundary');
        return 'CANCELLED';
      }
      const nb = s.neighbors;
      const d = topologySteps(nb.offsets, nb.neighbors, sources, s.hiddenV);
      const steps = p.propagation_steps as number;
      const mask = editableMask(me);
      for (let v = 0; v < s.nv; v++) {
        if (s.hiddenV?.[v]) continue;
        const val = Math.max(0, 1 - d[v] / steps);
        mask[v] = mixMask(p.mix_mode as string, mask[v], val, p.mix_factor as number);
      }
      commitMask(me);
    },
  },
  {
    idname: 'sculpt.mask_init',
    label: 'Init Mask',
    description: 'Fill the mask with random values',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'RANDOM_PER_VERTEX',
        items: [
          ['RANDOM_PER_VERTEX', 'Random per Vertex', 'A random value for every vertex'],
          ['RANDOM_PER_FACE_SET', 'Random per Face Set', 'A random value for every face set'],
          ['RANDOM_PER_LOOSE_PART', 'Random per Loose Part', 'A random value for every loose part'],
        ],
      },
      { id: 'seed', label: 'Seed', type: 'int', default: 0, min: 0, max: 100000 },
    ],
    poll: sculptPoll,
    invoke: (ctx, p) => {
      p.seed = Math.floor(Math.random() * 100000);
      return registered('sculpt.mask_init').exec!(ctx, p);
    },
    exec: (_ctx, p) => {
      const s = meshSession();
      if (!s) return 'CANCELLED';
      const { me } = activeMeshData()!;
      const seed = p.seed as number;
      const mask = editableMask(me);
      const fs = faceSetsOf(me);
      const parts = p.mode === 'RANDOM_PER_LOOSE_PART' ? looseVertexParts(me).part : null;
      for (let v = 0; v < s.nv; v++) {
        if (s.hiddenV?.[v]) continue;
        let key = v;
        if (p.mode === 'RANDOM_PER_FACE_SET') key = fs ? fs[s.vf.faces[s.vf.offsets[v]] ?? 0] ?? 1 : 1;
        else if (parts) key = parts[v];
        mask[v] = hash01(key, seed);
      }
      commitMask(me);
    },
  },
  {
    idname: 'sculpt.mask_by_color',
    label: 'Mask by Color',
    description: 'Mask the vertices with a color similar to the one under the cursor',
    props: [
      { id: 'contiguous', label: 'Contiguous', type: 'bool', default: false },
      { id: 'invert', label: 'Invert', type: 'bool', default: false },
      { id: 'preserve_previous_mask', label: 'Preserve Mask', type: 'bool', default: false },
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0.35, min: 0, max: 1, subtype: 'factor' },
      { id: 'vertex', label: 'Vertex', type: 'int', default: -1, hidden: true },
    ],
    poll: () => sculptPoll() && !!activeMeshData()?.me.color_attributes.length,
    invoke: (ctx, p) => {
      const v = vertexUnderCursor(ctx);
      if (v < 0) return 'CANCELLED';
      p.vertex = v;
      return registered('sculpt.mask_by_color').exec!(ctx, p);
    },
    exec: (_ctx, p) => {
      const s = meshSession();
      const { me } = activeMeshData()!;
      const a = me.color_attributes[me.active_color_index] ?? me.color_attributes[0];
      const src = p.vertex as number;
      if (!s || !a || src < 0 || src >= s.nv) return 'CANCELLED';
      const col = vertexColors(me, a);
      const ref = [col[src * 4], col[src * 4 + 1], col[src * 4 + 2]];
      const thr = p.threshold as number;
      const sim = (v: number) => {
        const d = Math.hypot(col[v * 4] - ref[0], col[v * 4 + 1] - ref[1], col[v * 4 + 2] - ref[2]) / Math.sqrt(3);
        // soft edge around the threshold
        return d <= thr ? 1 : d >= thr + 0.1 ? 0 : 1 - (d - thr) / 0.1;
      };
      let reach: Uint8Array | null = null;
      if (p.contiguous) {
        reach = new Uint8Array(s.nv);
        const nb = s.neighbors;
        const stack = [src];
        reach[src] = 1;
        while (stack.length) {
          const v = stack.pop()!;
          for (let k = nb.offsets[v]; k < nb.offsets[v + 1]; k++) {
            const u = nb.neighbors[k];
            if (reach[u] || sim(u) <= 0) continue;
            reach[u] = 1;
            stack.push(u);
          }
        }
      }
      const mask = editableMask(me);
      for (let v = 0; v < s.nv; v++) {
        if (s.hiddenV?.[v]) continue;
        let val = reach && !reach[v] ? 0 : sim(v);
        if (p.invert) val = 1 - val;
        mask[v] = p.preserve_previous_mask ? Math.max(mask[v], val) : val;
      }
      commitMask(me);
    },
  },
  {
    idname: 'sculpt.paint_mask_extract',
    label: 'Mask Extract',
    description: 'Create a new mesh object from the masked part of the mesh',
    props: [{ id: 'mask_threshold', label: 'Threshold', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' }, ...extractProps],
    poll: sculptPoll,
    exec: (_ctx, p) => {
      const { me } = activeMeshData()!;
      const faces = maskedFaces(me, p.mask_threshold as number);
      const hide = hiddenFacesOf(me);
      if (hide) for (let f = 0; f < faces.length; f++) if (hide[f]) faces[f] = 0;
      return extractFaces(faces, p, '.extracted');
    },
  },
  {
    idname: 'sculpt.face_set_extract',
    label: 'Face Set Extract',
    description: 'Create a new mesh object from the face set under the cursor',
    props: [{ id: 'face_set', label: 'Face Set', type: 'int', default: 0, hidden: true }, ...extractProps],
    poll: sculptPoll,
    invoke: (ctx, p) => {
      if ((p.face_set as number) < 0) p.face_set = lastHoveredFaceSet();
      else {
        const f = faceUnderCursor(ctx);
        p.face_set = f === null ? 0 : (faceSetsOf(activeMeshData()!.me)?.[f] ?? 1);
      }
      if (!p.face_set) {
        app.report('INFO', 'Face Set Extract: point at the face set to extract');
        return 'CANCELLED';
      }
      return registered('sculpt.face_set_extract').exec!(ctx, p);
    },
    exec: (_ctx, p) => {
      const { me } = activeMeshData()!;
      const fs = faceSetsOf(me);
      const nf = me.offsets.length - 1;
      const faces = new Uint8Array(nf);
      for (let f = 0; f < nf; f++) faces[f] = (fs ? fs[f] : 1) === p.face_set ? 1 : 0;
      return extractFaces(faces, p, '.extracted');
    },
  },
  {
    idname: 'sculpt.paint_mask_slice',
    label: 'Mask Slice',
    description: 'Remove the masked part of the mesh, optionally closing the holes or moving it to a new object',
    props: [
      { id: 'mask_threshold', label: 'Threshold', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
      { id: 'fill_holes', label: 'Fill Holes', type: 'bool', default: true },
      { id: 'new_object', label: 'Slice to New Object', type: 'bool', default: true },
    ],
    poll: sculptPoll,
    exec: (_ctx, p) => {
      const { ob, me } = activeMeshData()!;
      const masked = maskedFaces(me, p.mask_threshold as number);
      const n = masked.reduce((s, x) => s + x, 0);
      if (!n) {
        app.report('WARNING', 'No masked faces');
        return 'CANCELLED';
      }
      if (n === masked.length) {
        app.report('WARNING', 'The whole mesh is masked');
        return 'CANCELLED';
      }
      if (p.new_object) {
        const { arrays } = subMesh(me, masked, !!p.fill_holes);
        addMeshObject(ob, me, arrays, '.slice');
      }
      const keep = masked.map((x) => (x ? 0 : 1));
      keepFaces(me, keep, !!p.fill_holes);
      // the remaining mesh is unmasked: the masked part is gone
      if (me.sculpt_mask) me.sculpt_mask = new Float32Array(me.positions.length / 3);
      app.changed('geometry');
    },
  },
]);

function registered(id: string) {
  return operators.get(id)!;
}

function vertexUnderCursor(ctx: OpContext): number {
  const v = activeView3D();
  const s = meshSession();
  if (!v || !s) return -1;
  const r = v.el.getBoundingClientRect();
  const hit = s.raycast(v, (ctx.event?.x ?? app.pointer.x) - r.left, (ctx.event?.y ?? app.pointer.y) - r.top);
  if (!hit) return -1;
  let best = -1,
    bd = Infinity;
  for (let c = s.offsets[hit.face]; c < s.offsets[hit.face + 1]; c++) {
    const vi = s.indices[c];
    const d = Math.hypot(s.positions[vi * 3] - hit.point.x, s.positions[vi * 3 + 1] - hit.point.y, s.positions[vi * 3 + 2] - hit.point.z);
    if (d < bd) {
      bd = d;
      best = vi;
    }
  }
  return best;
}
