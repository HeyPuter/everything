// Scene → Alembic nodes: samples transforms, evaluated meshes and cameras over a frame range and
// converts them to the file's conventions (Y up, clockwise faces, camera frames, apertures in cm).
import { Matrix4 } from 'three';
import type { DocumentData, ObjectData } from '../../../data/types';
import { Depsgraph } from '../../../eval/depsgraph';
import { buildExportScene, evaluateExportMesh, type ExportMesh, type ExportObject } from '../scene-builder';
import type { MeshSample, SceneNode } from './write';

export interface AbcSampleOptions {
  frameStart: number;
  frameEnd: number;
  selectedOnly?: boolean;
  objectIds?: Set<string>;
  /** write every object at the root with its world matrix */
  flatten?: boolean;
  uvs?: boolean;
  normals?: boolean;
  faceSets?: boolean;
  applyModifiers?: boolean;
  /** uniform scale applied to the root transforms */
  scale?: number;
  /** cap on sampled vertex floats per mesh (larger animations keep their first sample) */
  maxFloats?: number;
}

/** Z-up → Y-up: (x, y, z) → (x, z, -y) */
const C = new Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const CI = C.clone().invert();
/** cameras keep looking down their local -Z after the axis change */
const CAM_FIX = new Matrix4().makeRotationX(-Math.PI / 2);

function convertMesh(m: ExportMesh, o: AbcSampleOptions): MeshSample {
  const p = m.positions;
  const positions = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    positions[i] = p[i];
    positions[i + 1] = p[i + 2];
    positions[i + 2] = -p[i + 1];
  }
  const nf = m.offsets.length - 1;
  const faceCounts = new Int32Array(nf);
  const faceIndices = new Int32Array(m.indices.length);
  // corner order of the file: each face reversed
  const order = new Uint32Array(m.indices.length);
  for (let f = 0, k = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    faceCounts[f] = e - s;
    for (let c = e - 1; c >= s; c--, k++) {
      order[k] = c;
      faceIndices[k] = m.indices[c];
    }
  }
  const out: MeshSample = { positions, faceCounts, faceIndices };
  if (o.normals !== false && m.normals?.length === m.indices.length * 3) {
    const n = new Float32Array(m.normals.length);
    for (let k = 0; k < order.length; k++) {
      const c = order[k] * 3;
      n[k * 3] = m.normals[c];
      n[k * 3 + 1] = m.normals[c + 2];
      n[k * 3 + 2] = -m.normals[c + 1];
    }
    out.normals = n;
  }
  if (o.uvs !== false && m.uvs && m.uvs.length === m.indices.length * 2) {
    // indexed: identical corner coordinates share one value
    const map = new Map<string, number>();
    const vals: number[] = [];
    const idx = new Uint32Array(order.length);
    for (let k = 0; k < order.length; k++) {
      const u = m.uvs[order[k] * 2],
        v = m.uvs[order[k] * 2 + 1];
      const key = `${u},${v}`;
      let i = map.get(key);
      if (i === undefined) {
        i = vals.length / 2;
        map.set(key, i);
        vals.push(u, v);
      }
      idx[k] = i;
    }
    out.uvs = { values: Float32Array.from(vals), indices: idx, name: m.uvName || 'UVMap' };
  }
  return out;
}

const sameSample = (a: MeshSample, b: MeshSample) =>
  a.positions.length === b.positions.length && a.faceIndices.length === b.faceIndices.length && a.positions.every((v, i) => v === b.positions[i]) && a.faceIndices.every((v, i) => v === b.faceIndices[i]) && a.faceCounts.every((v, i) => v === b.faceCounts[i]);

export function cameraCore(cam: NonNullable<ExportObject['camera']>, fps: number): Float64Array {
  const hAp = cam.sensor_width / 10;
  const vAp = cam.sensor_height / 10;
  return Float64Array.from([
    cam.lens,
    hAp,
    cam.shift_x * hAp,
    vAp,
    cam.shift_y * hAp,
    1,
    0,
    0,
    0,
    0,
    cam.dof?.aperture_fstop ?? 2.8,
    cam.dof?.focus_distance ?? 10,
    0,
    0.5 / (fps || 24),
    cam.clip_start,
    cam.clip_end,
  ]);
}

/** Whether an object's evaluated geometry can change over time (others are sampled once). */
function mayDeform(doc: DocumentData, ob: ObjectData): boolean {
  if (ob.modifiers.some((m) => m.show_viewport)) return true;
  const data = ob.data ? ((doc.meshes[ob.data] ?? doc.curves[ob.data]) as { animation_data?: unknown; shape_keys?: unknown[] } | undefined) : undefined;
  if (!data) return false;
  return !!data.animation_data || (Array.isArray(data.shape_keys) && data.shape_keys.length > 1);
}

/** Sample the scene into Alembic nodes. Restores the document's current frame. */
export function sampleAlembicScene(doc: DocumentData, o: AbcSampleOptions): { roots: SceneNode[]; frames: number; fps: number; warnings: string[] } {
  const warnings: string[] = [];
  const fps = doc.scene.render.fps / (doc.scene.render.fps_base || 1);
  const start = Math.round(o.frameStart),
    end = Math.max(start, Math.round(o.frameEnd));
  const frames = end - start + 1;
  const scene = buildExportScene(doc, { selectedOnly: o.selectedOnly, objectIds: o.objectIds, applyModifiers: o.applyModifiers !== false, skins: false, shapeKeys: false, animation: false });
  warnings.push(...scene.warnings);
  const objects = scene.objects.filter((eo) => !['LIGHT', 'ARMATURE'].includes(eo.type) || eo.children.length);
  const nodes = new Map<ExportObject, SceneNode>();
  const world = new Map<ExportObject, Matrix4[]>();
  const meshSamples = new Map<ExportObject, MeshSample[]>();
  const cams = new Map<ExportObject, Float64Array[]>();
  const vis = new Map<ExportObject, boolean[]>();
  for (const eo of objects) {
    world.set(eo, []);
    vis.set(eo, []);
    if (eo.mesh) meshSamples.set(eo, []);
    if (eo.camera) cams.set(eo, []);
  }
  const graph = new Depsgraph(doc);
  const original = doc.scene.frame_current,
    originalSub = doc.scene.frame_subframe;
  const tooBig = new Set<ExportObject>();
  try {
    for (let f = start; f <= end; f++) {
      doc.scene.frame_current = f;
      doc.scene.frame_subframe = 0;
      graph.evaluate(doc);
      for (const eo of objects) {
        const ev = graph.get(eo.id);
        const w = ev ? ev.world.clone() : eo.world.clone();
        const y = C.clone().multiply(w).multiply(CI);
        if (eo.type === 'CAMERA') y.multiply(CAM_FIX);
        world.get(eo)!.push(y);
        vis.get(eo)!.push(!(eo.ob.hide_viewport || eo.ob.hide));
        if (eo.mesh && !tooBig.has(eo) && (f === start || mayDeform(doc, eo.ob))) {
          const list = meshSamples.get(eo)!;
          const m = evaluateExportMesh(doc, graph, eo.ob as ObjectData, { applyModifiers: o.applyModifiers !== false, skipArmature: false, shapeKeys: false }, warnings);
          if (m) list.push(convertMesh(m, o));
          if (list.length > 1 && list.length * list[0].positions.length > (o.maxFloats ?? 30_000_000)) {
            tooBig.add(eo);
            list.length = 1;
            warnings.push(`"${eo.name}": the vertex animation is too large; only the first frame was written`);
          }
        }
        if (eo.camera) cams.get(eo)!.push(cameraCore((doc.cameras[eo.ob.data!] ?? eo.camera), fps));
      }
    }
  } finally {
    doc.scene.frame_current = original;
    doc.scene.frame_subframe = originalSub;
  }
  const scale = o.scale && o.scale !== 1 ? new Matrix4().makeScale(o.scale, o.scale, o.scale) : null;
  const collapse = <T>(list: T[], same: (a: T, b: T) => boolean) => (list.every((x) => same(x, list[0])) ? [list[0]] : list);
  const usedNames = new Set<string>();
  const unique = (n: string) => {
    let s = n.replace(/\//g, '_') || 'Object';
    for (let i = 1; usedNames.has(s); i++) s = `${n}.${String(i).padStart(3, '0')}`;
    usedNames.add(s);
    return s;
  };
  // parent of an exported object in the written hierarchy (flatten: none)
  const parentOf = (eo: ExportObject): ExportObject | null => {
    if (o.flatten) return null;
    let p = eo.parent;
    while (p && !nodes.has(p) && !objects.includes(p)) p = p.parent;
    return p && objects.includes(p) ? p : null;
  };
  for (const eo of objects) {
    const p = parentOf(eo);
    const ws = world.get(eo)!;
    const mats = ws.map((w, i) => {
      if (p) return world.get(p)![i].clone().invert().multiply(w);
      return scale ? scale.clone().multiply(w) : w;
    });
    const node: SceneNode = {
      name: unique(eo.name),
      matrices: collapse(
        mats.map((m) => Float64Array.from(m.elements)),
        (a, b) => a.every((v, i) => v === b[i]),
      ),
      visible: collapse(vis.get(eo)!, (a, b) => a === b),
      children: [],
    };
    const ms = meshSamples.get(eo);
    if (ms?.length) {
      const samples = collapse(ms, sameSample);
      node.mesh = { name: (eo.mesh!.name || eo.name).replace(/\//g, '_'), samples };
      if (o.faceSets && eo.mesh!.materials.length) {
        const sets: { name: string; faces: Int32Array }[] = [];
        eo.mesh!.materials.forEach((mid, slot) => {
          if (!mid) return;
          const faces: number[] = [];
          eo.mesh!.materialIndex.forEach((s, f) => s === slot && faces.push(f));
          if (faces.length) sets.push({ name: (doc.materials[mid]?.name ?? `Material${slot}`).replace(/\//g, '_'), faces: Int32Array.from(faces) });
        });
        if (sets.length) node.mesh.faceSets = sets;
      }
    }
    const cs = cams.get(eo);
    if (cs?.length) node.camera = { name: (eo.camera?.name ?? eo.name).replace(/\//g, '_'), samples: collapse(cs, (a, b) => a.every((v, i) => v === b[i])) };
    nodes.set(eo, node);
  }
  const roots: SceneNode[] = [];
  for (const eo of objects) {
    const p = parentOf(eo);
    const n = nodes.get(eo)!;
    if (p) nodes.get(p)!.children.push(n);
    else roots.push(n);
  }
  return { roots, frames, fps, warnings };
}
