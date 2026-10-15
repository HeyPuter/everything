// Dependency evaluation: animation → local transforms → parenting/constraints →
// object data (modifier stacks, curves, armature deformation). Results are cached
// and recomputed only when their inputs change.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { DocumentData, ObjectData, MeshData, ModifierBase } from '../data/types';
import type { EvalMesh, ModifierContext } from './types';
import { localMatrix, toMatrix4 } from './transform';
import { modifierTypes } from './modifiers';
import { constraintTypes } from './constraints';
import { evaluatePose, type PoseResult } from './armature';
import { curveToMesh } from './curve';
import { applyAnimation } from '../anim/evaluate';

/** Called at the start of every evaluation, after animation (e.g. physics caches stepping to the frame). */
export const preEvaluateHooks: ((graph: Depsgraph, doc: DocumentData) => void)[] = [];

export interface EvalObject {
  id: string;
  ob: ObjectData;
  world: Matrix4;
  /** world matrix before constraints */
  worldBasis: Matrix4;
  visible: boolean;
  selectable: boolean;
  mesh?: EvalMesh;
  /** Mesh with only deform modifiers applied (edit cage) */
  cage?: EvalMesh;
  pose?: PoseResult;
  /** Bump when the evaluated geometry changes (for GPU cache invalidation) */
  geomVersion: number;
  error?: string;
}

let arrayIds = new WeakMap<object, number>(),
  nextArrayId = 1;
function aid(a: object | undefined | null): number {
  if (!a) return 0;
  let id = arrayIds.get(a);
  if (!id) {
    id = nextArrayId++;
    arrayIds.set(a, id);
  }
  return id;
}

export function meshSignature(me: MeshData) {
  return `${aid(me.positions)}:${aid(me.indices)}:${aid(me.loose_edges)}:${aid(me.offsets)}:${aid(me.uvs)}:${aid(me.smooth)}:${aid(me.material_index)}:${aid(me.seams)}:${aid(me.sharp)}:${aid(me.creases)}:${aid(me.custom_normals)}:${aid(me.quad_flip)}:${me.auto_smooth_angle ?? ''}:${me.weights.map(aid).join(',')}:${me.shape_keys
    .map((k) => `${aid(k.data)}=${k.mute ? 'm' : k.value}`)
    .join(',')}:${me.color_attributes.map((c) => aid(c.data)).join(',')}:${me.active_color_index}`;
}

export function baseEvalMesh(me: MeshData, editMode = false): EvalMesh {
  let positions = me.positions;
  // shape keys (relative to basis = key 0)
  if (me.shape_keys.length > 1 && !(editMode && !me.use_shape_key_edit_mode)) {
    const basis = me.shape_keys[0].data;
    const out = new Float32Array(positions);
    let changed = false;
    for (let k = 1; k < me.shape_keys.length; k++) {
      const key = me.shape_keys[k];
      if (key.mute || !key.value) continue;
      const rel = me.shape_keys.find((x) => x.name === key.relative_key)?.data ?? basis;
      const gi = key.vertex_group ? me.vertex_groups.findIndex((g) => g.name === key.vertex_group) : -1;
      const w = gi >= 0 ? me.weights[gi] : null;
      if (key.data.length !== out.length || rel.length !== out.length) continue;
      for (let i = 0; i < out.length; i++) {
        const f = key.value * (w ? w[(i / 3) | 0] : 1);
        out[i] += (key.data[i] - rel[i]) * f;
      }
      changed = true;
    }
    if (changed) positions = out;
  }
  const colorAttr = me.color_attributes[me.active_color_index];
  let colors: Float32Array | undefined;
  if (colorAttr) {
    if (colorAttr.domain === 'CORNER') colors = colorAttr.data;
    else {
      colors = new Float32Array(me.indices.length * 4);
      for (let c = 0; c < me.indices.length; c++) colors.set(colorAttr.data.subarray(me.indices[c] * 4, me.indices[c] * 4 + 4), c * 4);
    }
  }
  return {
    positions,
    offsets: me.offsets,
    indices: me.indices,
    uvs: me.uvs,
    normals: me.normals,
    smooth: me.smooth,
    material_index: me.material_index,
    seams: me.seams,
    sharp: me.sharp,
    creases: me.creases,
    custom_normals: me.custom_normals && me.custom_normals.length === me.indices.length * 3 ? me.custom_normals : undefined,
    quad_flip: me.quad_flip && me.quad_flip.length === me.offsets.length - 1 ? me.quad_flip : undefined,
    colors,
    weights: me.weights,
    vertex_groups: me.vertex_groups,
    auto_smooth_angle: me.auto_smooth_angle,
    looseEdges: me.loose_edges,
  };
}

interface CacheEntry {
  signature: string;
  mesh: EvalMesh;
  cage?: EvalMesh;
  version: number;
  error?: string;
}

export class Depsgraph {
  objects = new Map<string, EvalObject>();
  frame = 1;
  private meshCache = new Map<string, CacheEntry>();
  private version = 1;
  /** Ids of objects being edited (edit mode): modifiers marked show_in_editmode only */
  editObjects = new Set<string>();
  /** Render (final) evaluation uses show_render instead of show_viewport */
  render = false;
  /** Physics/simulation caches can inject per-object deformed positions */
  simulationPositions = new Map<string, Float32Array>();
  /** Physics caches (rigid bodies) can override an object's world matrix (applied after constraints) */
  simulationMatrices = new Map<string, Matrix4>();
  /** Optional hook for geometry nodes evaluation (set by nodes module) */
  constructor(public doc: DocumentData) {}

  get(id: string | null | undefined) {
    return id ? this.objects.get(id) : undefined;
  }

  /** Evaluate the whole scene for the document's current frame. */
  evaluate(doc: DocumentData = this.doc, animate = true) {
    this.doc = doc;
    this.frame = doc.scene.frame_current + (doc.scene.frame_subframe ?? 0);
    if (animate) applyAnimation(doc, this.frame);
    for (const hook of preEvaluateHooks) hook(this, doc);
    const order = this.sortObjects(doc);
    const visibleSet = visibleObjects(doc);
    const seen = new Set<string>();
    for (const ob of order) {
      seen.add(ob.id);
      let ev = this.objects.get(ob.id);
      if (!ev) {
        ev = { id: ob.id, ob, world: new Matrix4(), worldBasis: new Matrix4(), visible: true, selectable: true, geomVersion: 0 };
        this.objects.set(ob.id, ev);
      }
      ev.ob = ob;
      const vis = visibleSet.get(ob.id);
      ev.visible = !!vis && !ob.hide && !ob.hide_viewport;
      ev.selectable = ev.visible && !ob.hide_select && !(vis?.noSelect ?? false);
      this.evaluateTransform(doc, ob, ev);
    }
    for (const id of [...this.objects.keys()]) if (!seen.has(id)) this.objects.delete(id);
    for (const key of [...this.meshCache.keys()]) if (!seen.has(key)) this.meshCache.delete(key);
    // data evaluation after all transforms (armatures need final matrices)
    for (const ob of order) {
      const ev = this.objects.get(ob.id)!;
      if (ob.type === 'ARMATURE') {
        const arm = ob.data ? doc.armatures[ob.data] : undefined;
        ev.pose = arm ? evaluatePose(doc, ob, arm, this) : undefined;
      }
    }
    for (const ob of order) this.evaluateData(doc, ob, this.objects.get(ob.id)!);
    return this;
  }

  private sortObjects(doc: DocumentData): ObjectData[] {
    const out: ObjectData[] = [],
      state = new Map<string, number>();
    const visit = (id: string) => {
      const s = state.get(id);
      if (s === 2) return;
      if (s === 1) return; // cycle: break it
      const ob = doc.objects[id];
      if (!ob) return;
      state.set(id, 1);
      if (ob.parent) visit(ob.parent);
      for (const c of ob.constraints) if (c.target && !c.mute) visit(c.target as string);
      for (const c of ob.constraints) if (!c.mute) for (const d of constraintTypes[c.type]?.deps?.(c, doc) ?? []) if (d && d !== ob.id) visit(d);
      if (ob.pose) for (const pb of Object.values(ob.pose)) for (const c of pb.constraints) if (c.target && c.target !== ob.id) visit(c.target as string);
      for (const m of ob.modifiers) {
        const t = modifierTypes[m.type];
        for (const dep of t?.deps?.(m) ?? []) if (dep && dep !== ob.id) visit(dep);
      }
      state.set(id, 2);
      out.push(ob);
    };
    for (const id of doc.object_order) visit(id);
    for (const id of Object.keys(doc.objects)) visit(id);
    return out;
  }

  private evaluateTransform(doc: DocumentData, ob: ObjectData, ev: EvalObject) {
    localMatrix(ob, ev.world);
    if (ob.parent) {
      const parent = this.objects.get(ob.parent);
      if (parent) {
        const pm = parent.world.clone();
        if (ob.parent_type === 'BONE' && ob.parent_bone && parent.pose) {
          const bone = parent.pose.bones.get(ob.parent_bone);
          if (bone) {
            // child is relative to the bone tail
            const tail = new Matrix4().makeTranslation(0, bone.length, 0);
            pm.multiply(bone.pose).multiply(tail);
          }
        }
        ev.world.premultiply(new Matrix4().multiplyMatrices(pm, toMatrix4(ob.matrix_parent_inverse)));
      }
    }
    ev.worldBasis.copy(ev.world);
    for (const c of ob.constraints) {
      if (c.mute || c.influence <= 0) continue;
      const t = constraintTypes[c.type];
      if (!t) continue;
      const before = ev.world.clone();
      try {
        t.apply(ev.world, c, { doc, graph: this, ob, frame: this.frame });
      } catch {
        ev.world.copy(before);
      }
      if (c.influence < 1) blendMatrices(before, ev.world, c.influence, ev.world);
    }
    const simMatrix = this.simulationMatrices.get(ob.id);
    if (simMatrix) ev.world.copy(simMatrix);
  }

  /** Signature of all inputs to an object's evaluated geometry. */
  private dataSignature(doc: DocumentData, ob: ObjectData, me: MeshData | null): string {
    const edit = this.editObjects.has(ob.id);
    let s = `${ob.type}|${edit ? 'E' : ''}|${this.render ? 'R' : ''}|`;
    if (me) s += meshSignature(me);
    else if (ob.data) {
      const cu = doc.curves[ob.data];
      if (cu) s += JSON.stringify(cu);
    }
    if (ob.modifiers.length) {
      s += '|' + JSON.stringify(ob.modifiers);
      for (const m of ob.modifiers) {
        const t = modifierTypes[m.type];
        if (!t) continue;
        for (const dep of t.deps?.(m) ?? []) {
          const d = dep ? this.objects.get(dep) : undefined;
          if (d) {
            s += `|${dep}:${d.world.elements.map((x) => x.toFixed(5)).join(',')}:${d.geomVersion}`;
            if (d.pose) s += ':' + d.pose.signature;
          }
        }
        if (t.timeDependent?.(m)) s += `|t${this.frame}`;
        if (t.signature) s += '|' + t.signature(m, { doc, ob, graph: this, frame: this.frame });
      }
      // modifiers that relate other objects to this one (warp, boolean, mirror object…) depend on its world
      // transform; a plain move must not re-evaluate the rest of the stack
      if (ob.modifiers.some((m) => (modifierTypes[m.type]?.deps?.(m) ?? []).some(Boolean) || m.texture_coords === 'GLOBAL')) s += '|' + this.objects.get(ob.id)!.world.elements.map((x) => x.toFixed(4)).join(',');
    }
    const sim = this.simulationPositions.get(ob.id);
    if (sim) s += '|sim' + aid(sim);
    return s;
  }

  private evaluateData(doc: DocumentData, ob: ObjectData, ev: EvalObject) {
    if (ob.type !== 'MESH' && ob.type !== 'CURVE' && ob.type !== 'FONT') {
      ev.mesh = undefined;
      return;
    }
    const me = ob.type === 'MESH' && ob.data ? doc.meshes[ob.data] : null;
    if (ob.type === 'MESH' && !me) {
      ev.mesh = undefined;
      return;
    }
    const sig = this.dataSignature(doc, ob, me);
    const cached = this.meshCache.get(ob.id);
    if (cached && cached.signature === sig) {
      ev.mesh = cached.mesh;
      ev.cage = cached.cage;
      ev.geomVersion = cached.version;
      ev.error = cached.error;
      return;
    }
    const edit = this.editObjects.has(ob.id);
    let mesh: EvalMesh;
    if (me) mesh = baseEvalMesh(me, edit);
    else {
      const cu = doc.curves[ob.data!];
      mesh = curveToMesh(cu, ob.type === 'FONT');
    }
    const sim = this.simulationPositions.get(ob.id);
    if (sim && sim.length === mesh.positions.length) mesh = { ...mesh, positions: sim };
    let cage: EvalMesh | undefined = edit ? mesh : undefined;
    let error: string | undefined;
    const ctx: ModifierContext = { doc, ob, graph: this, frame: this.frame, source: me, editMode: edit, render: this.render };
    let topologyChanged = false;
    for (const m of ob.modifiers) {
      if (this.render ? !m.show_render : !m.show_viewport) continue;
      if (edit && !m.show_in_editmode) continue;
      const t = modifierTypes[m.type];
      if (!t) continue;
      try {
        mesh = t.apply(mesh, m as ModifierBase, ctx);
        if (!t.deformOnly) topologyChanged = true;
        else if (edit && !topologyChanged && m.show_on_cage) cage = mesh;
      } catch (e) {
        error = `${m.name}: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
    }
    const version = ++this.version;
    this.meshCache.set(ob.id, { signature: sig, mesh, cage, version, error });
    ev.mesh = mesh;
    ev.cage = cage;
    ev.geomVersion = version;
    ev.error = error;
  }

  invalidate(id?: string) {
    if (id) this.meshCache.delete(id);
    else this.meshCache.clear();
  }
}

/** Blend two matrices (decomposed lerp/slerp). */
export function blendMatrices(a: Matrix4, b: Matrix4, t: number, out: Matrix4) {
  const pa = new Vector3(),
    pb = new Vector3(),
    sa = new Vector3(),
    sb = new Vector3(),
    qa = new Quaternion(),
    qb = new Quaternion();
  a.decompose(pa, qa, sa);
  b.decompose(pb, qb, sb);
  pa.lerp(pb, t);
  sa.lerp(sb, t);
  qa.slerp(qb, t);
  return out.compose(pa, qa, sa);
}

/** Objects visible through collection hierarchy; value says if selection is disabled. */
export function visibleObjects(doc: DocumentData): Map<string, { noSelect: boolean; noRender: boolean }> {
  const out = new Map<string, { noSelect: boolean; noRender: boolean }>();
  const walk = (cid: string, hidden: boolean, noSelect: boolean, noRender: boolean) => {
    const c = doc.collections[cid];
    if (!c) return;
    const isMaster = cid === doc.scene.collection;
    if (!isMaster && (c.exclude || c.hide_viewport)) return;
    const h = hidden || (!isMaster && c.hide);
    const ns = noSelect || c.hide_select;
    const nr = noRender || c.hide_render;
    if (!h)
      for (const oid of c.objects) {
        const prev = out.get(oid);
        out.set(oid, { noSelect: prev ? prev.noSelect && ns : ns, noRender: prev ? prev.noRender && nr : nr });
      }
    for (const child of c.children) walk(child, h, ns, nr);
  };
  walk(doc.scene.collection, false, false, false);
  return out;
}

/** Collections containing an object. */
export function objectCollections(doc: DocumentData, id: string) {
  return Object.values(doc.collections).filter((c) => c.objects.includes(id));
}
