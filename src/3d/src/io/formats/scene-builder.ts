// Document → export scene: evaluated meshes, hierarchy, materials, armatures and sampled
// animation, in document space (Z-up, meters). Every exporter consumes this structure.
import { Matrix4 } from 'three';
import type { ArmatureData, CameraData, DocumentData, LightData, MaterialData, ObjectData } from '../../data/types';
import { Depsgraph, baseEvalMesh, visibleObjects } from '../../eval/depsgraph';
import type { EvalMesh, ModifierContext } from '../../eval/types';
import { modifierTypes } from '../../eval/modifiers';
import { curveToMesh } from '../../eval/curve';
import { boneRestMatrix, sortedBones, evaluatePose } from '../../eval/armature';
import { localMatrix, toMatrix4 } from '../../eval/transform';
import { cornerNormals } from '../../mesh/mesh';
import { readMaterial, type ExportMaterial } from './material-nodes';

export interface ExportOptions {
  selectedOnly?: boolean;
  /** apply the modifier stack (viewport settings); default true */
  applyModifiers?: boolean;
  /** export armatures + skin weights (armature modifiers are then not applied); default true */
  skins?: boolean;
  /** export shape keys as morph targets (modifiers are not applied to shape-keyed meshes); default true */
  shapeKeys?: boolean;
  /** sample animation; default true */
  animation?: boolean;
  /** use scene frame range instead of keyframe ranges */
  sceneFrameRange?: boolean;
  /** include objects hidden in the viewport (eye icon); default true */
  includeHidden?: boolean;
  /** object types to export (default all) */
  types?: ObjectData['type'][];
  /** export exactly these objects (a collection exporter), whatever their visibility */
  objectIds?: Set<string>;
}

export interface ExportColorLayer {
  name: string;
  /** RGBA (linear) per corner */
  data: Float32Array;
}

export interface ExportMesh {
  name: string;
  /** object-local positions */
  positions: Float32Array;
  offsets: Uint32Array;
  indices: Uint32Array;
  uvs: Float32Array | null;
  uvName: string;
  /** per corner render normals */
  normals: Float32Array;
  smooth: Uint8Array;
  materialIndex: Uint16Array;
  /** material ids per slot (null = empty) */
  materials: (string | null)[];
  colors: ExportColorLayer[];
  /** vertex groups (names aligned with weights) */
  groups: { names: string[]; weights: Float32Array[] } | null;
  /** absolute positions per shape key (excluding basis) with current values */
  shapeKeys: { name: string; positions: Float32Array; value: number }[];
  /** source mesh data id (meshes shared between objects export once when unmodified) */
  sourceId: string | null;
  modified: boolean;
}

export interface ExportBone {
  name: string;
  parent: string | null;
  /** armature-space rest matrix (Y along the bone) */
  rest: Matrix4;
  length: number;
  deform: boolean;
}

export interface ExportObject {
  id: string;
  name: string;
  type: ObjectData['type'];
  ob: ObjectData;
  parent: ExportObject | null;
  /** when parented to a bone of `parent` (an exported armature) */
  parentBone: string | null;
  /** local matrix relative to the parent frame (parent world, or the bone frame for bone parents) */
  local: Matrix4;
  world: Matrix4;
  mesh?: ExportMesh;
  camera?: CameraData;
  light?: LightData;
  armature?: { data: ArmatureData; bones: ExportBone[]; pose: Map<string, Matrix4> };
  /** skinned mesh: the armature object it is deformed by */
  skin?: ExportObject;
  children: ExportObject[];
}

export interface ExportTrack {
  object: ExportObject;
  /** action name (for grouping into animations) */
  name: string;
  /** local matrices per sampled frame (null when the object transform is static) */
  locals: Matrix4[] | null;
  /** bone name → bone-local (parent-relative pose) matrices per frame, armature space */
  bones: Map<string, Matrix4[]>;
  /** shape key values per frame [frame][key] */
  shapeKeys: number[][] | null;
}

export interface ExportScene {
  doc: DocumentData;
  objects: ExportObject[];
  roots: ExportObject[];
  materials: Map<string, ExportMaterial>;
  frames: number[];
  fps: number;
  tracks: ExportTrack[];
  warnings: string[];
}

export function buildExportScene(doc: DocumentData, opts: ExportOptions = {}, graphIn?: Depsgraph): ExportScene {
  const warnings: string[] = [];
  const applyModifiers = opts.applyModifiers !== false;
  const skins = opts.skins !== false;
  const graph = graphIn ?? new Depsgraph(doc).evaluate(doc);
  const inScene = visibleObjects(doc);
  const candidates = doc.object_order.map((id) => doc.objects[id]).filter((ob): ob is ObjectData => !!ob);
  const exported = new Set<string>();
  for (const ob of candidates) {
    const vis = inScene.has(ob.id);
    if (opts.objectIds) {
      if (!opts.objectIds.has(ob.id)) continue;
    } else if (!vis && !(opts.includeHidden !== false && isLinked(doc, ob.id))) continue;
    if (opts.includeHidden === false && (ob.hide || ob.hide_viewport)) continue;
    if (opts.selectedOnly && !ob.select) continue;
    if (opts.types && !opts.types.includes(ob.type)) continue;
    if (!['MESH', 'CURVE', 'FONT', 'EMPTY', 'LIGHT', 'CAMERA', 'ARMATURE'].includes(ob.type)) {
      warnings.push(`"${ob.name}": ${ob.type.toLowerCase()} objects are not exported`);
      continue;
    }
    exported.add(ob.id);
  }

  const byId = new Map<string, ExportObject>();
  const list: ExportObject[] = [];
  for (const ob of candidates) {
    if (!exported.has(ob.id)) continue;
    const ev = graph.get(ob.id);
    const world = ev ? ev.world.clone() : localMatrix(ob);
    const eo: ExportObject = { id: ob.id, name: ob.name, type: ob.type, ob, parent: null, parentBone: null, local: world.clone(), world, children: [] };
    if (ob.type === 'CAMERA' && ob.data) eo.camera = doc.cameras[ob.data];
    if (ob.type === 'LIGHT' && ob.data) eo.light = doc.lights[ob.data];
    if (ob.type === 'ARMATURE' && ob.data && doc.armatures[ob.data]) {
      const data = doc.armatures[ob.data];
      const bones = sortedBones(data).map((b) => ({
        name: b.name,
        parent: b.parent && data.bones.some((x) => x.name === b.parent) ? b.parent : null,
        rest: boneRestMatrix(b),
        length: Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]),
        deform: b.use_deform,
      }));
      const pose = new Map<string, Matrix4>();
      const pr = ev?.pose ?? evaluatePose(doc, ob, data, graph);
      for (const b of bones) pose.set(b.name, pr.bones.get(b.name)?.pose.clone() ?? b.rest.clone());
      eo.armature = { data, bones, pose };
    }
    byId.set(ob.id, eo);
    list.push(eo);
  }
  // hierarchy (nearest exported ancestor; bone parents keep the bone frame)
  for (const eo of list) {
    let p = eo.ob.parent ? doc.objects[eo.ob.parent] : undefined;
    let viaBone = eo.ob.parent_type === 'BONE' ? eo.ob.parent_bone : '';
    while (p && !exported.has(p.id)) {
      viaBone = '';
      p = p.parent ? doc.objects[p.parent] : undefined;
    }
    if (p) {
      const pe = byId.get(p.id)!;
      eo.parent = pe;
      pe.children.push(eo);
      if (viaBone && pe.armature?.pose.has(viaBone)) {
        eo.parentBone = viaBone;
        eo.local = boneFrameWorld(pe, viaBone).invert().multiply(eo.world);
      } else eo.local = pe.world.clone().invert().multiply(eo.world);
    }
  }
  // meshes
  for (const eo of list) {
    if (eo.type !== 'MESH' && eo.type !== 'CURVE' && eo.type !== 'FONT') continue;
    const armMod = eo.ob.modifiers.find((m) => m.type === 'ARMATURE' && m.show_viewport && typeof m.object === 'string' && byId.get(m.object as string)?.armature);
    const skinArm = skins && armMod ? byId.get(armMod.object as string)! : undefined;
    const mesh = evaluateExportMesh(doc, graph, eo.ob, { applyModifiers, skipArmature: !!skinArm, shapeKeys: opts.shapeKeys !== false }, warnings);
    if (!mesh) continue;
    eo.mesh = mesh;
    if (skinArm) eo.skin = skinArm;
  }
  // materials
  const materials = new Map<string, ExportMaterial>();
  for (const eo of list)
    for (const id of eo.mesh?.materials ?? [])
      if (id && !materials.has(id) && doc.materials[id]) {
        const m = readMaterial(doc, doc.materials[id] as MaterialData);
        materials.set(id, m);
        warnings.push(...m.warnings);
      }

  const scene: ExportScene = { doc, objects: list, roots: list.filter((o) => !o.parent), materials, frames: [], fps: doc.scene.render.fps / (doc.scene.render.fps_base || 1), tracks: [], warnings };
  if (opts.animation !== false) sampleAnimation(scene, opts, graph);
  return scene;
}

function isLinked(doc: DocumentData, id: string) {
  return Object.values(doc.collections).some((c) => c.objects.includes(id) && !c.exclude);
}

/** World frame children of a bone are expressed in: armWorld · pose · T(length). */
export function boneFrameWorld(arm: ExportObject, bone: string, pose = arm.armature!.pose.get(bone)!, armWorld = arm.world): Matrix4 {
  const b = arm.armature!.bones.find((x) => x.name === bone)!;
  return armWorld
    .clone()
    .multiply(pose)
    .multiply(new Matrix4().makeTranslation(0, b.length, 0));
}

export function evaluateExportMesh(
  doc: DocumentData,
  graph: Depsgraph,
  ob: ObjectData,
  o: { applyModifiers: boolean; skipArmature: boolean; shapeKeys: boolean },
  warnings: string[],
): ExportMesh | null {
  const me = ob.type === 'MESH' && ob.data ? doc.meshes[ob.data] : null;
  if (ob.type === 'MESH' && !me) return null;
  const hasKeys = !!me && me.shape_keys.length > 1 && o.shapeKeys;
  let mesh: EvalMesh;
  if (me) mesh = baseEvalMesh(hasKeys ? { ...me, shape_keys: [] } : me);
  else {
    const cu = ob.data ? doc.curves[ob.data] : undefined;
    if (!cu) return null;
    mesh = curveToMesh(cu, ob.type === 'FONT');
  }
  let modified = false;
  const mods = ob.modifiers.filter((m) => m.show_viewport && modifierTypes[m.type] && !(o.skipArmature && m.type === 'ARMATURE'));
  if (o.applyModifiers && mods.length) {
    if (hasKeys && mods.some((m) => !modifierTypes[m.type].deformOnly)) warnings.push(`"${ob.name}": modifiers were not applied because the mesh has shape keys`);
    else if (hasKeys) warnings.push(`"${ob.name}": deform modifiers were not applied because the mesh has shape keys`);
    else {
      const ctx: ModifierContext = { doc, ob, graph, frame: graph.frame, source: me, editMode: false, render: false };
      for (const m of mods) {
        try {
          mesh = modifierTypes[m.type].apply(mesh, m, ctx);
          modified = true;
        } catch (e) {
          warnings.push(`"${ob.name}": modifier ${m.name} failed (${e instanceof Error ? e.message : e})`);
          break;
        }
      }
    }
  }
  const nf = mesh.offsets.length - 1;
  if (nf <= 0 && !mesh.positions.length) return null;
  const normals = cornerNormals(mesh as never, mesh.positions);
  const colors: ExportColorLayer[] = [];
  if (me && !modified) {
    for (const ca of me.color_attributes) {
      if (ca.domain === 'CORNER') colors.push({ name: ca.name, data: ca.data });
      else {
        const d = new Float32Array(me.indices.length * 4);
        for (let c = 0; c < me.indices.length; c++) d.set(ca.data.subarray(me.indices[c] * 4, me.indices[c] * 4 + 4), c * 4);
        colors.push({ name: ca.name, data: d });
      }
    }
  } else if (mesh.colors && mesh.colors.length === mesh.indices.length * 4) colors.push({ name: me?.color_attributes[me.active_color_index]?.name ?? 'Color', data: mesh.colors });
  const groups = mesh.vertex_groups && mesh.weights && mesh.vertex_groups.length ? { names: mesh.vertex_groups.map((g) => g.name), weights: mesh.weights } : null;
  const shapeKeys = hasKeys && me ? me.shape_keys.slice(1).map((k) => ({ name: k.name, positions: k.data, value: k.mute ? 0 : k.value })) : [];
  const anyUv = mesh.uvs && mesh.uvs.length === mesh.indices.length * 2 && mesh.uvs.some((v) => v !== 0);
  return {
    name: me?.name ?? (ob.data ? doc.curves[ob.data]?.name : null) ?? ob.name,
    positions: mesh.positions,
    offsets: mesh.offsets,
    indices: mesh.indices,
    uvs: anyUv ? mesh.uvs : null,
    uvName: me?.uv_map_name ?? 'UVMap',
    normals,
    smooth: mesh.smooth ?? new Uint8Array(nf),
    materialIndex: mesh.material_index ?? new Uint16Array(nf),
    materials: me ? [...me.materials] : ob.data ? [...(doc.curves[ob.data]?.materials ?? [])] : [],
    colors,
    groups,
    shapeKeys,
    sourceId: me?.id ?? null,
    modified,
  };
}

// ---------------------------------------------------------------------------
// Animation sampling

function actionRange(doc: DocumentData, ob: ObjectData): [number, number] | null {
  const ad = ob.animation_data;
  if (!ad) return null;
  let lo = Infinity,
    hi = -Infinity;
  const ids = [ad.action, ...ad.nla_tracks.filter((t) => !t.mute).flatMap((t) => t.strips.map((s) => s.action))];
  for (const id of ids) {
    const act = id ? doc.actions[id] : undefined;
    if (!act) continue;
    for (const fc of act.fcurves)
      for (const k of fc.keyframe_points) {
        lo = Math.min(lo, k.co[0]);
        hi = Math.max(hi, k.co[0]);
      }
  }
  for (const t of ad.nla_tracks)
    if (!t.mute)
      for (const s of t.strips) {
        lo = Math.min(lo, s.frame_start);
        hi = Math.max(hi, s.frame_end);
      }
  return Number.isFinite(lo) ? [lo, hi] : ad.drivers.length ? [doc.scene.frame_start, doc.scene.frame_end] : null;
}

function sampleAnimation(scene: ExportScene, opts: ExportOptions, appGraph: Depsgraph) {
  const doc = scene.doc;
  let lo = Infinity,
    hi = -Infinity;
  let animated = false;
  for (const eo of scene.objects) {
    const r = actionRange(doc, eo.ob);
    if (r) {
      animated = true;
      lo = Math.min(lo, r[0]);
      hi = Math.max(hi, r[1]);
    }
  }
  if (!animated) return;
  if (opts.sceneFrameRange || !Number.isFinite(lo)) {
    lo = doc.scene.frame_start;
    hi = doc.scene.frame_end;
  }
  lo = Math.floor(lo);
  hi = Math.ceil(hi);
  if (hi - lo > 100000) hi = lo + 100000;
  const frames: number[] = [];
  for (let f = lo; f <= hi; f++) frames.push(f);
  if (frames.length < 2) return;
  scene.frames = frames;
  const original = doc.scene.frame_current,
    originalSub = doc.scene.frame_subframe;
  const graph = new Depsgraph(doc);
  for (const [k, v] of appGraph.simulationPositions) graph.simulationPositions.set(k, v);
  const samples = new Map<ExportObject, { locals: Matrix4[]; bones: Map<string, Matrix4[]>; keys: number[][] }>();
  for (const eo of scene.objects) samples.set(eo, { locals: [], bones: new Map(), keys: [] });
  try {
    for (const f of frames) {
      doc.scene.frame_current = f;
      doc.scene.frame_subframe = 0;
      graph.evaluate(doc);
      const worldOf = new Map<ExportObject, Matrix4>();
      for (const eo of scene.objects) worldOf.set(eo, graph.get(eo.id)?.world.clone() ?? eo.world.clone());
      for (const eo of scene.objects) {
        const s = samples.get(eo)!;
        const w = worldOf.get(eo)!;
        let local: Matrix4;
        if (eo.parent && eo.parentBone) {
          const pev = graph.get(eo.parent.id);
          const pose = pev?.pose?.bones.get(eo.parentBone)?.pose ?? eo.parent.armature!.pose.get(eo.parentBone)!;
          local = boneFrameWorld(eo.parent, eo.parentBone, pose, worldOf.get(eo.parent)!).invert().multiply(w);
        } else if (eo.parent) local = worldOf.get(eo.parent)!.clone().invert().multiply(w);
        else local = w;
        s.locals.push(local);
        if (eo.armature) {
          const pr = graph.get(eo.id)?.pose;
          for (const b of eo.armature.bones) {
            const pose = pr?.bones.get(b.name)?.pose ?? b.rest;
            const parentPose = b.parent ? (pr?.bones.get(b.parent)?.pose ?? eo.armature.bones.find((x) => x.name === b.parent)!.rest) : null;
            const rel = parentPose ? parentPose.clone().invert().multiply(pose) : pose.clone();
            if (!s.bones.has(b.name)) s.bones.set(b.name, []);
            s.bones.get(b.name)!.push(rel);
          }
        }
        const me = eo.ob.type === 'MESH' && eo.ob.data ? doc.meshes[eo.ob.data] : undefined;
        if (eo.mesh?.shapeKeys.length && me) s.keys.push(me.shape_keys.slice(1).map((k) => (k.mute ? 0 : k.value)));
      }
    }
  } finally {
    doc.scene.frame_current = original;
    doc.scene.frame_subframe = originalSub;
    graph.evaluate(doc);
  }
  const changes = (ms: Matrix4[]) => ms.some((m) => !m.equals(ms[0]) && m.elements.some((v, i) => Math.abs(v - ms[0].elements[i]) > 1e-6));
  for (const eo of scene.objects) {
    const s = samples.get(eo)!;
    const locals = changes(s.locals) ? s.locals : null;
    const bones = new Map<string, Matrix4[]>();
    for (const [name, ms] of s.bones) if (changes(ms)) bones.set(name, ms);
    const keys = s.keys.length && s.keys.some((k) => k.some((v, i) => Math.abs(v - s.keys[0][i]) > 1e-7)) ? s.keys : null;
    if (!locals && !bones.size && !keys) continue;
    const act = eo.ob.animation_data?.action ? doc.actions[eo.ob.animation_data.action] : undefined;
    scene.tracks.push({ object: eo, name: act?.name ?? `${eo.name}Action`, locals, bones, shapeKeys: keys });
  }
}

/** Matrix of an object relative to its export parent as a plain array (debug helper). */
export function toArray(m: Matrix4) {
  return Array.from(m.elements);
}
export { toMatrix4 };
