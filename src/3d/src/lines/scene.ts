// Gathers the evaluated scene for line drawing: renderable mesh objects (with geometry node /
// particle instances), edge / face marks carried onto evaluated meshes, material attributes,
// collection membership and the camera as a `LineCamera`.
import { Matrix4, Vector3, type Camera } from 'three';
import type { App } from '../app/app';
import type { DocumentData, ObjectData } from '../data/types';
import type { EvalMesh } from '../eval/types';
import { materialSlots } from '../editors/view3d/draw';
import { renderVisibleObjects } from '../render/final/renderscene';
import { mapEdgeMarks } from './core/features';
import type { LineObject } from './core/pipeline';
import type { MaterialAttrs } from './core/style';
import type { LineCamera } from './core/visibility';

/** Line camera from a three.js camera (matrices up to date). */
export function lineCamera(camera: Camera, width: number, height: number): LineCamera {
  camera.updateMatrixWorld(true);
  const vp = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const eye = new Vector3().setFromMatrixPosition(camera.matrixWorld);
  const dir = new Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
  const ortho = !!(camera as unknown as { isOrthographicCamera?: boolean }).isOrthographicCamera;
  return { viewProj: vp.elements.slice(), width, height, view: { ortho, eye: [eye.x, eye.y, eye.z], dir: [dir.x, dir.y, dir.z] } };
}

function marksFor(doc: DocumentData, ob: ObjectData, m: EvalMesh): { edgeMarks?: Uint8Array; faceMarks?: Uint8Array } {
  if (ob.type !== 'MESH' || !ob.data) return {};
  const me = doc.meshes[ob.data];
  if (!me) return {};
  const nv = me.positions.length / 3;
  const same = m.indices.length === me.indices.length && m.positions.length / 3 === nv && m.offsets.length === me.offsets.length;
  // evaluated vertices map back through origIndex, or directly when the count is unchanged
  const mappable = same || !!m.origIndex || m.positions.length / 3 === nv;
  const edgeMarks = me.freestyle_edge && mappable ? mapEdgeMarks(me, m, same) : undefined;
  const faceMarks = me.freestyle_face && me.freestyle_face.length === m.offsets.length - 1 ? me.freestyle_face : undefined;
  return { edgeMarks, faceMarks };
}

/** Mesh objects that render, as line drawing inputs (instances become their own entries). */
export function lineObjects(app: App, filter?: (ob: ObjectData) => boolean): LineObject[] {
  const doc = app.doc;
  const visible = renderVisibleObjects(doc);
  const out: LineObject[] = [];
  for (const ev of app.graph.objects.values()) {
    const ob = ev.ob;
    if (!visible.has(ev.id) || ob.type === 'GREASEPENCIL' || (filter && !filter(ob))) continue;
    const m = ev.mesh;
    if (!m) continue;
    const slots = materialSlots(doc, ob);
    if (m.indices.length || m.looseEdges?.length)
      out.push({ id: ob.id, positions: m.positions, offsets: m.offsets, indices: m.indices, material_index: m.material_index, smooth: m.smooth, sharp: m.sharp, looseEdges: m.looseEdges, world: ev.world.elements, materials: slots, weights: m.weights, groups: (m.vertex_groups ?? (ob.type === 'MESH' && ob.data ? doc.meshes[ob.data]?.vertex_groups : undefined))?.map((g) => g.name), ...marksFor(doc, ob, m) });
    for (const it of m.instances ?? []) {
      const src = it.mesh ?? (it.objectId ? app.graph.get(it.objectId)?.mesh : undefined);
      if (!src || !src.indices.length) continue;
      const w = ev.world.clone().multiply(new Matrix4().fromArray(it.matrix));
      const srcOb = it.objectId ? doc.objects[it.objectId] : undefined;
      out.push({ id: ob.id, positions: src.positions, offsets: src.offsets, indices: src.indices, material_index: src.material_index, smooth: src.smooth, world: w.elements, materials: (it.materialIds as (string | null)[] | undefined) ?? (srcOb ? materialSlots(doc, srcOb) : slots) });
    }
  }
  return out;
}

/** Attributes the line style Material modifiers read. */
export function materialAttrs(doc: DocumentData, id: string): MaterialAttrs | null {
  const ma = doc.materials[id];
  if (!ma) return null;
  const d = ma.diffuse_color ?? [0.8, 0.8, 0.8, 1];
  const spec = 0.5 * (1 - (ma.metallic ?? 0)) + (ma.metallic ?? 0);
  return {
    line: ma.line_color ?? [0, 0, 0, 0],
    diffuse: [d[0], d[1], d[2], d[3] ?? 1],
    specular: [spec, spec, spec],
    hardness: Math.round((1 - (ma.roughness ?? 0.5)) * 511),
    alpha: d[3] ?? 1,
  };
}

/** Is object `id` in collection `col` or one of its children? */
export function inCollection(doc: DocumentData, id: string, col: string): boolean {
  const seen = new Set<string>();
  const walk = (cid: string): boolean => {
    if (seen.has(cid)) return false;
    seen.add(cid);
    const c = doc.collections[cid];
    if (!c) return false;
    if (c.objects.includes(id)) return true;
    return c.children.some(walk);
  };
  return walk(col);
}
