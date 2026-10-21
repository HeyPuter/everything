// Object ▸ Convert ▸ Grease Pencil (meshes: faces become filled strokes; curves: their splines
// become strokes) and grease pencil to Mesh (fills as faces, strokes as flat ribbons) or Curve
// (one poly spline per stroke).
import { Vector3 } from 'three';
import { app, onAppReady, operators } from '../app/app';
import type { DocumentData, MaterialData, ObjectData } from '../data/types';
import { newCurve, newMeshData, newObject } from '../data/defaults';
import { uniqueName, addObjectToScene } from '../ops/object';
import { gpTable, gpOf, newGreasePencil, newLayer, newGPMaterial, fromStrokes, toStrokes, setKeyframe, frameAt, newPoint, newStroke, normalizeDrawing, slotStyle, strokeShows, type GPPoint, type GPStroke } from './data';
import { layerMatrix } from './render';
import { evaluatedDrawing } from './curves';

// ---------------------------------------------------------------------------
// kernels (pure)

/** Faces of a mesh as closed strokes (object space). */
export function meshFaceStrokes(positions: ArrayLike<number>, offsets: ArrayLike<number>, indices: ArrayLike<number>, materialIndex?: ArrayLike<number>, radius = 0.01): GPStroke[] {
  const out: GPStroke[] = [];
  for (let f = 0; f + 1 < offsets.length; f++) {
    const pts: GPPoint[] = [];
    for (let k = offsets[f]; k < offsets[f + 1]; k++) {
      const v = indices[k];
      pts.push(newPoint([positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]], radius));
    }
    if (pts.length >= 3) out.push(newStroke(pts, { cyclic: true, material_index: materialIndex?.[f] ?? 0 }));
  }
  return out;
}

const cubic = (a: number[], b: number[], c: number[], d: number[], t: number) => {
  const m = 1 - t;
  return [0, 1, 2].map((k) => m * m * m * a[k] + 3 * m * m * t * b[k] + 3 * m * t * t * c[k] + t * t * t * d[k]) as [number, number, number];
};

/** Splines of a curve as strokes (Bézier segments sampled by the curve resolution). */
export function curveStrokes(cu: { splines: import('../data/types').Spline[]; resolution_u: number }, radius = 0.01): GPStroke[] {
  return cu.splines
    .map((sp) => {
      const pts: GPPoint[] = [];
      if (sp.type === 'BEZIER') {
        const bp = sp.bezier_points;
        const n = bp.length;
        const segs = sp.use_cyclic_u ? n : n - 1;
        const res = Math.max(1, sp.resolution_u || cu.resolution_u || 12);
        for (let s = 0; s < segs; s++) {
          const a = bp[s],
            b = bp[(s + 1) % n];
          for (let i = 0; i < res; i++) pts.push(newPoint(cubic(a.co, a.handle_right, b.handle_left, b.co, i / res), radius * (a.radius + (b.radius - a.radius) * (i / res))));
        }
        if (!sp.use_cyclic_u && n) pts.push(newPoint([...bp[n - 1].co] as [number, number, number], radius * bp[n - 1].radius));
      } else for (const p of sp.points) pts.push(newPoint([p.co[0], p.co[1], p.co[2]], radius * p.radius));
      return newStroke(pts, { cyclic: sp.use_cyclic_u, material_index: sp.material_index });
    })
    .filter((s) => s.points.length > 1);
}

/** A flat ribbon around a stroke (quads), in the stroke's plane. */
export function strokeRibbon(s: GPStroke): { positions: number[]; faces: number[][] } {
  const P = s.points.map((p) => new Vector3(...p.co));
  const n = P.length;
  const positions: number[] = [];
  const faces: number[][] = [];
  if (n < 2) return { positions, faces };
  // plane normal (Newell), or front facing
  const N = new Vector3();
  for (let i = 0; i < n; i++) {
    const a = P[i],
      b = P[(i + 1) % n];
    N.x += (a.y - b.y) * (a.z + b.z);
    N.y += (a.z - b.z) * (a.x + b.x);
    N.z += (a.x - b.x) * (a.y + b.y);
  }
  if (N.lengthSq() < 1e-12) N.set(0, 1, 0);
  N.normalize();
  for (let i = 0; i < n; i++) {
    const t = P[Math.min(n - 1, i + 1)].clone().sub(P[Math.max(0, i - 1)]);
    const side = new Vector3().crossVectors(N, t);
    if (side.lengthSq() < 1e-12) side.set(0, 0, 1);
    side.normalize().multiplyScalar(s.points[i].radius);
    const l = P[i].clone().add(side),
      r = P[i].clone().sub(side);
    positions.push(l.x, l.y, l.z, r.x, r.y, r.z);
  }
  const segs = s.cyclic ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    faces.push([i * 2, j * 2, j * 2 + 1, i * 2 + 1]);
  }
  return { positions, faces };
}

// ---------------------------------------------------------------------------

function gpMaterialFrom(doc: DocumentData, ma: MaterialData | undefined, fill: boolean): string {
  const col = (ma?.diffuse_color ?? [0.8, 0.8, 0.8, 1]) as [number, number, number, number];
  const m = newGPMaterial(uniqueName(doc, ma ? `${ma.name}_GP` : 'Material', 'materials'), { color: fill ? [0, 0, 0, 1] : [...col], fill_color: [...col], show_fill: fill, show_stroke: true });
  doc.materials[m.id] = m;
  return m.id;
}

function toGreasePencil(doc: DocumentData, ob: ObjectData): ObjectData | null {
  let strokes: GPStroke[] = [];
  let mats: (string | null)[] = [];
  if (ob.type === 'MESH' && ob.data && doc.meshes[ob.data]) {
    const ev = app.graph.get(ob.id);
    const me = doc.meshes[ob.data];
    const m = ev?.mesh ?? me;
    strokes = meshFaceStrokes(m.positions, m.offsets, m.indices, m.material_index);
    mats = (me.materials.length ? me.materials : [null]).map((id) => gpMaterialFrom(doc, id ? doc.materials[id] : undefined, true));
  } else if ((ob.type === 'CURVE' || ob.type === 'FONT') && ob.data && doc.curves[ob.data]) {
    const cu = doc.curves[ob.data];
    strokes = curveStrokes(cu);
    mats = (cu.materials.length ? cu.materials : [null]).map((id) => gpMaterialFrom(doc, id ? doc.materials[id] : undefined, ob.type === 'FONT'));
    if (ob.type === 'FONT') strokes = strokes.map((s) => ({ ...s, cyclic: true }));
  } else return null;
  if (!strokes.length) return null;
  const gp = newGreasePencil(uniqueName(doc, ob.name, 'objects'));
  gpTable(doc)[gp.id] = gp;
  gp.materials = mats;
  const l = newLayer('Layer');
  gp.layers.push(l);
  setKeyframe(gp, l, doc.scene.frame_current, fromStrokes(strokes));
  const out = newObject(gp.name, 'GREASEPENCIL', gp.id);
  return placeLike(doc, ob, out);
}

function placeLike(doc: DocumentData, src: ObjectData, ob: ObjectData): ObjectData {
  addObjectToScene(doc, ob, { location: [...src.location], rotation: [...src.rotation_euler] });
  ob.scale = [...src.scale] as ObjectData['scale'];
  ob.rotation_mode = src.rotation_mode;
  ob.parent = src.parent;
  ob.matrix_parent_inverse = [...src.matrix_parent_inverse] as ObjectData['matrix_parent_inverse'];
  return ob;
}

function fromGreasePencil(doc: DocumentData, ob: ObjectData, target: 'MESH' | 'CURVE'): ObjectData | null {
  const gp = gpOf(doc, ob);
  if (!gp) return null;
  const frame = doc.scene.frame_current;
  const all: { s: GPStroke }[] = [];
  const v = new Vector3();
  for (const l of gp.layers) {
    if (l.hide) continue;
    const fr = frameAt(l, frame);
    if (!fr || !gp.drawings[fr.drawing]) continue;
    const m = layerMatrix(l);
    for (const s of toStrokes(evaluatedDrawing(normalizeDrawing(gp.drawings[fr.drawing])))) if (!s.is_fill_guide) all.push({ s: { ...s, points: s.points.map((p) => ({ ...p, co: v.set(...p.co).applyMatrix4(m).toArray() as [number, number, number] })) } });
  }
  if (!all.length) return null;
  if (target === 'CURVE') {
    const cu = newCurve(uniqueName(doc, gp.name, 'curves'));
    cu.splines = all.map(({ s }) => ({
      type: 'POLY',
      bezier_points: [],
      points: s.points.map((p) => ({ co: [p.co[0], p.co[1], p.co[2], 1], radius: p.radius / 0.01, tilt: 0 })),
      use_cyclic_u: s.cyclic,
      resolution_u: 12,
      order_u: 4,
      use_smooth: true,
      material_index: s.material_index,
    }));
    cu.materials = [...gp.materials];
    doc.curves[cu.id] = cu;
    return placeLike(doc, ob, newObject(ob.name, 'CURVE', cu.id));
  }
  const positions: number[] = [];
  const offsets: number[] = [0];
  const indices: number[] = [];
  const matIdx: number[] = [];
  for (const { s } of all) {
    const st = slotStyle(doc, gp, s.material_index);
    const shows = strokeShows(st, s.stroke_type);
    if (shows.fill && s.points.length >= 3) {
      const base = positions.length / 3;
      for (const p of s.points) positions.push(...p.co);
      for (let i = 0; i < s.points.length; i++) indices.push(base + i);
      offsets.push(indices.length);
      matIdx.push(s.material_index);
    }
    if (!shows.stroke) continue;
    const rb = strokeRibbon(s);
    const base = positions.length / 3;
    positions.push(...rb.positions);
    for (const f of rb.faces) {
      for (const i of f) indices.push(base + i);
      offsets.push(indices.length);
      matIdx.push(s.material_index);
    }
  }
  const nCorners = indices.length;
  const me = newMeshData(uniqueName(doc, gp.name, 'meshes'), {
    positions: new Float32Array(positions),
    offsets: new Uint32Array(offsets),
    indices: new Uint32Array(indices),
    uvs: new Float32Array(nCorners * 2),
    normals: new Float32Array(nCorners * 3),
    material_index: new Uint16Array(matIdx),
  });
  me.materials = [...gp.materials];
  doc.meshes[me.id] = me;
  return placeLike(doc, ob, newObject(ob.name, 'MESH', me.id));
}

onAppReady(() => {
  const op = operators.get('object.convert');
  if (!op?.exec) return;
  const target = op.props?.find((p) => p.id === 'target');
  if (target?.items && !target.items.some((i) => i[0] === 'GREASEPENCIL')) target.items.push(['GREASEPENCIL', 'Grease Pencil', 'Strokes from mesh faces or curve splines']);
  const base = op.exec;
  op.exec = (ctx, p) => {
    const doc = ctx.doc;
    const sel = app.selectedObjects();
    const gpSel = sel.filter((o) => o.type === 'GREASEPENCIL');
    const toGP = p.target === 'GREASEPENCIL';
    if (!toGP && !gpSel.length) return base(ctx, p);
    // grease pencil sources (or targets) are converted here, everything else by the original
    const handled: ObjectData[] = toGP ? sel.filter((o) => o.type === 'MESH' || o.type === 'CURVE' || o.type === 'FONT') : gpSel;
    let made = 0;
    for (const ob of handled) {
      const out = toGP ? toGreasePencil(doc, ob) : fromGreasePencil(doc, ob, p.target === 'CURVE' ? 'CURVE' : 'MESH');
      if (!out) continue;
      made++;
      if (!p.keep_original) {
        delete doc.objects[ob.id];
        doc.object_order = doc.object_order.filter((id) => id !== ob.id);
        for (const c of Object.values(doc.collections)) c.objects = c.objects.filter((id) => id !== ob.id);
      }
    }
    if (!toGP) {
      // the rest of the selection goes through the regular conversion
      for (const o of gpSel) o.select = false;
      if (app.selectedObjects().length) base(ctx, p);
    }
    if (!made) return 'CANCELLED';
  };
});
