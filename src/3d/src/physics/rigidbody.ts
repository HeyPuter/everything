// Rigid body world simulated with Rapier (Apache-2.0, loaded lazily as WASM).
// The world is stepped frame by frame from its start frame into a frame cache; the
// simulated transforms override evaluated world matrices through the depsgraph's
// `simulationMatrices` map.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type RAPIERNS from '@dimforge/rapier3d-compat';
import type { DocumentData, ObjectData } from '../data/types';
import type { Depsgraph } from '../eval/depsgraph';
import { meshSignature, baseEvalMesh } from '../eval/depsgraph';
import { frameOf, getCache, motionKey, objectWorldAt, outOfTime, strHash, type FrameCache } from './common';
import { collectEffectors, effectorForce, fieldsKey } from './fields';
import { triangulate } from './colliders';
import type { ObjectPhysics, RigidBodyConstraintData, RigidBodyWorldX, RigidBodyX } from './types';
import { fps } from './meshsim';
import { createJoint } from './rbjoints';

type Rapier = typeof RAPIERNS;
let RAPIER: Rapier | null = null;
let loading: Promise<Rapier> | null = null;
export const rapierReady = new Set<() => void>();

export function loadRapier(): Promise<Rapier> {
  if (!loading)
    loading = import('@dimforge/rapier3d-compat').then(async (m) => {
      const mod = ((m as unknown as { default?: Rapier }).default ?? m) as Rapier;
      await mod.init();
      RAPIER = mod;
      for (const f of rapierReady) f();
      return mod;
    });
  return loading;
}

export const rapierLoaded = () => !!RAPIER;

export const RB_CACHE = 'RIGIDBODY';

interface Body {
  id: string;
  body: RAPIERNS.RigidBody;
  dynamic: boolean;
  kinematic: boolean;
  scale: Vector3;
  mass: number;
}

interface Live {
  world: RAPIERNS.World;
  bodies: Body[];
}

/** Frame state: per body tx ty tz qx qy qz qw (order = cache.order). */
interface RBCache extends FrameCache<Float32Array, Live> {
  order?: string[];
}

export function rigidBodyObjects(doc: DocumentData): ObjectData[] {
  const out: ObjectData[] = [];
  for (const id of doc.object_order) {
    const ob = doc.objects[id];
    if (ob?.rigid_body && ob.type === 'MESH' && ob.data && doc.meshes[ob.data]) out.push(ob);
  }
  return out;
}

export function constraintObjects(doc: DocumentData): ObjectPhysics[] {
  const out: ObjectPhysics[] = [];
  for (const id of doc.object_order) {
    const ob = doc.objects[id] as ObjectPhysics | undefined;
    if (ob?.rigid_body_constraint?.enabled) out.push(ob);
  }
  return out;
}

export function rigidBodyHash(doc: DocumentData): string {
  const w = doc.scene.rigidbody_world as RigidBodyWorldX;
  const parts: string[] = [
    JSON.stringify({ ...w, is_baked: false }),
    String(doc.scene.use_gravity),
    doc.scene.gravity.join(','),
    String(fps(doc)),
    fieldsKey(doc, w.frame_start),
  ];
  for (const ob of rigidBodyObjects(doc)) {
    const me = doc.meshes[ob.data!];
    parts.push(`${ob.id}:${JSON.stringify(ob.rigid_body)}:${meshSignature(me)}:${motionKey(doc, ob, w.frame_start)}`);
  }
  for (const ob of constraintObjects(doc)) parts.push(`${ob.id}:${JSON.stringify(ob.rigid_body_constraint)}:${motionKey(doc, ob, w.frame_start)}`);
  return strHash(parts.join('#'));
}

const damping = (d: number) => -Math.log(1 - Math.min(0.999, Math.max(0, d)));

function shapeDesc(R: Rapier, ob: ObjectData, rb: RigidBodyX, doc: DocumentData, scale: Vector3, dynamic: boolean): RAPIERNS.ColliderDesc {
  const me = doc.meshes[ob.data!];
  const em = baseEvalMesh(me);
  const P = em.positions;
  const n = P.length / 3;
  const sp = new Float32Array(P.length);
  const mn = [Infinity, Infinity, Infinity],
    mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) {
      const v = P[i * 3 + c] * scale.getComponent(c);
      sp[i * 3 + c] = v;
      mn[c] = Math.min(mn[c], v);
      mx[c] = Math.max(mx[c], v);
    }
  if (!n) {
    mn.fill(-0.5);
    mx.fill(0.5);
  }
  const hx = Math.max(1e-3, (mx[0] - mn[0]) / 2),
    hy = Math.max(1e-3, (mx[1] - mn[1]) / 2),
    hz = Math.max(1e-3, (mx[2] - mn[2]) / 2);
  const cx = (mx[0] + mn[0]) / 2,
    cy = (mx[1] + mn[1]) / 2,
    cz = (mx[2] + mn[2]) / 2;
  // Y-aligned primitives are rotated so their axis is the object's Z axis
  const yToZ = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
  let d: RAPIERNS.ColliderDesc | null = null;
  switch (rb.collision_shape) {
    case 'SPHERE':
      d = R.ColliderDesc.ball(Math.max(hx, hy, hz)).setTranslation(cx, cy, cz);
      break;
    case 'CAPSULE': {
      const r = Math.max(hx, hy);
      d = R.ColliderDesc.capsule(Math.max(1e-3, hz - r), r).setTranslation(cx, cy, cz).setRotation(yToZ);
      break;
    }
    case 'CYLINDER':
      d = R.ColliderDesc.cylinder(hz, Math.max(hx, hy)).setTranslation(cx, cy, cz).setRotation(yToZ);
      break;
    case 'CONE':
      d = R.ColliderDesc.cone(hz, Math.max(hx, hy)).setTranslation(cx, cy, cz).setRotation(yToZ);
      break;
    case 'CONVEX_HULL':
      d = n >= 4 ? R.ColliderDesc.convexHull(sp) : null;
      break;
    case 'MESH': {
      const tris = triangulate(em.positions, em.offsets, em.indices);
      // triangle meshes cannot collide with each other: moving bodies use their hull
      if (dynamic || !tris.length) d = n >= 4 ? R.ColliderDesc.convexHull(sp) : null;
      else d = R.ColliderDesc.trimesh(sp, tris);
      break;
    }
  }
  if (!d) d = R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz);
  return d;
}

function decompose(m: Matrix4) {
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  m.decompose(p, q, s);
  return { p, q, s };
}

function buildWorld(R: Rapier, doc: DocumentData): Live {
  const w = doc.scene.rigidbody_world as RigidBodyWorldX;
  const gw = w.effector_weights_gravity ?? 1;
  const g = doc.scene.use_gravity ? doc.scene.gravity : [0, 0, 0];
  const world = new R.World({ x: g[0] * gw, y: g[1] * gw, z: g[2] * gw });
  const substeps = Math.max(1, Math.round(w.substeps_per_frame));
  world.timestep = Math.max(1e-6, (w.time_scale || 0) / fps(doc) / substeps);
  world.integrationParameters.numSolverIterations = Math.max(1, Math.round(w.solver_iterations));
  const bodies: Body[] = [];
  const byId = new Map<string, Body>();
  for (const ob of rigidBodyObjects(doc)) {
    const rb = ob.rigid_body as RigidBodyX;
    const { p, q, s } = decompose(objectWorldAt(doc, ob, w.frame_start));
    const dynamic = rb.type === 'ACTIVE' && rb.enabled && !rb.kinematic;
    const kinematic = !dynamic && (rb.kinematic || (rb.type === 'ACTIVE' && !rb.enabled));
    const desc = dynamic ? R.RigidBodyDesc.dynamic() : kinematic ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.fixed();
    desc.setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    desc.setLinearDamping(damping(rb.linear_damping)).setAngularDamping(damping(rb.angular_damping)).setCanSleep(!!rb.use_deactivation);
    const body = world.createRigidBody(desc);
    const cd = shapeDesc(R, ob, rb, doc, new Vector3(s.x, s.y, s.z), dynamic);
    cd.setFriction(Math.max(0, rb.friction)).setRestitution(Math.max(0, rb.restitution));
    cd.setFrictionCombineRule(R.CoefficientCombineRule.Multiply).setRestitutionCombineRule(R.CoefficientCombineRule.Multiply);
    if (rb.use_margin) cd.setContactSkin(Math.max(0, rb.collision_margin));
    if (dynamic) cd.setMass(Math.max(1e-3, rb.mass));
    world.createCollider(cd, body);
    const b: Body = { id: ob.id, body, dynamic, kinematic, scale: s.clone(), mass: rb.mass };
    bodies.push(b);
    byId.set(ob.id, b);
  }
  // constraints (joints) between bodies, anchored at the constraint object
  for (const ob of constraintObjects(doc)) {
    const c = ob.rigid_body_constraint as RigidBodyConstraintData;
    const b1 = c.object1 ? byId.get(c.object1) : undefined,
      b2 = c.object2 ? byId.get(c.object2) : undefined;
    if (!b1 || !b2 || b1 === b2) continue;
    const cm = decompose(objectWorldAt(doc, ob, w.frame_start));
    const joint = createJoint(R, world, c, b1, b2, cm.p, cm.q, world.timestep);
    joint.setContactsEnabled(!c.disable_collisions);
  }
  return { world, bodies };
}

function snapshot(live: Live): Float32Array {
  const out = new Float32Array(live.bodies.length * 7);
  live.bodies.forEach((b, i) => {
    const t = b.body.translation(),
      r = b.body.rotation();
    out.set([t.x, t.y, t.z, r.x, r.y, r.z, r.w], i * 7);
  });
  return out;
}

function stepWorld(doc: DocumentData, live: Live, frame: number, graph: Depsgraph | null) {
  const w = doc.scene.rigidbody_world as RigidBodyWorldX;
  const substeps = Math.max(1, Math.round(w.substeps_per_frame));
  // kinematic targets at the previous and this frame
  const kin = live.bodies
    .filter((b) => b.kinematic)
    .map((b) => {
      const ob = doc.objects[b.id];
      return { b, a: decompose(objectWorldAt(doc, ob, frame - 1)), c: decompose(objectWorldAt(doc, ob, frame)) };
    });
  const effs = collectEffectors({ doc, graph }, frame - 1);
  const dyn = effs.length ? live.bodies.filter((b) => b.dynamic) : [];
  const f = [0, 0, 0];
  const pp = new Vector3(),
    qq = new Quaternion();
  for (let s = 0; s < substeps; s++) {
    const t = (s + 1) / substeps;
    for (const k of kin) {
      pp.copy(k.a.p).lerp(k.c.p, t);
      qq.copy(k.a.q).slerp(k.c.q, t);
      k.b.body.setNextKinematicTranslation({ x: pp.x, y: pp.y, z: pp.z });
      k.b.body.setNextKinematicRotation({ x: qq.x, y: qq.y, z: qq.z, w: qq.w });
    }
    for (const b of dyn) {
      const p = b.body.translation(),
        v = b.body.linvel();
      f[0] = f[1] = f[2] = 0;
      effectorForce(effs, p.x, p.y, p.z, v.x, v.y, v.z, frame - 1 + t, f);
      b.body.resetForces(false);
      if (f[0] || f[1] || f[2]) b.body.addForce({ x: f[0], y: f[1], z: f[2] }, true);
    }
    live.world.step();
  }
}

/** Matrices this module set, per depsgraph (removed before each evaluation). */
const appliedByGraph = new WeakMap<Depsgraph, Set<string>>();

/** Rigid body world cache (for UI and bake operators). */
export function rigidBodyCache(): RBCache {
  return getCache<Float32Array, Live>(RB_CACHE) as RBCache;
}

export function freeRigidBodyLive() {
  const c = rigidBodyCache();
  c.live?.world.free();
  c.live = null;
}

/** Ensure the cache covers `ft` (within the time budget). Returns false when the engine is still loading. */
export function simulateRigidBodies(doc: DocumentData, ft: number, graph: Depsgraph | null): boolean {
  const w = doc.scene.rigidbody_world as RigidBodyWorldX | null;
  if (!w) return true;
  const cache = rigidBodyCache();
  if (cache.frames.has(ft)) return true;
  if (!RAPIER) {
    void loadRapier();
    return false;
  }
  if (!cache.live || cache.last < w.frame_start) {
    freeRigidBodyLive();
    cache.frames.clear();
    cache.live = buildWorld(RAPIER, doc);
    cache.order = cache.live.bodies.map((b) => b.id);
    cache.frames.set(w.frame_start, snapshot(cache.live));
    cache.last = w.frame_start;
  }
  while (cache.last < ft) {
    if (cache.last > w.frame_start && outOfTime()) break;
    const k = cache.last + 1;
    stepWorld(doc, cache.live!, k, graph);
    cache.frames.set(k, snapshot(cache.live!));
    cache.last = k;
  }
  return true;
}

/** Simulated world matrix of an object at a frame (null when not simulated there). */
export function rigidBodyMatrix(doc: DocumentData, id: string, frame: number): Matrix4 | null {
  const w = doc.scene.rigidbody_world as RigidBodyWorldX | null;
  const cache = rigidBodyCache();
  if (!w || frame <= w.frame_start || !cache.order) return null;
  const st = cache.frames.get(Math.min(frame, w.frame_end));
  const i = cache.order.indexOf(id);
  if (!st || i < 0) return null;
  const ob = doc.objects[id];
  if (!ob) return null;
  const s = decompose(objectWorldAt(doc, ob, w.frame_start)).s;
  return new Matrix4().compose(new Vector3(st[i * 7], st[i * 7 + 1], st[i * 7 + 2]), new Quaternion(st[i * 7 + 3], st[i * 7 + 4], st[i * 7 + 5], st[i * 7 + 6]), s);
}

/** Depsgraph pre-evaluation hook: step the world and override simulated objects' matrices. */
export function rigidBodyHook(graph: Depsgraph, doc: DocumentData) {
  let applied = appliedByGraph.get(graph);
  if (!applied) appliedByGraph.set(graph, (applied = new Set()));
  for (const id of applied) graph.simulationMatrices.delete(id);
  applied.clear();
  const w = doc.scene.rigidbody_world as RigidBodyWorldX | null;
  const cache = rigidBodyCache();
  if (!w || !w.enabled) return;
  cache.label = 'Rigid Body World';
  cache.start = w.frame_start;
  cache.end = w.frame_end;
  cache.baked = !!w.is_baked;
  const objects = rigidBodyObjects(doc);
  if (!objects.length) return;
  const hash = rigidBodyHash(doc);
  const usable = w.is_baked && cache.frames.size > 0;
  if (!usable && cache.hash !== hash) {
    freeRigidBodyLive();
    cache.reset(hash);
    cache.order = undefined;
  }
  const f = frameOf(graph);
  if (f <= w.frame_start) return;
  const ft = Math.min(f, w.frame_end);
  simulateRigidBodies(doc, ft, graph);
  const st = cache.frames.get(ft) ?? cache.nearest(ft);
  if (!st || !cache.order) return;
  const live = new Map(cache.live?.bodies.map((b) => [b.id, b]) ?? []);
  cache.order.forEach((id, i) => {
    const ob = doc.objects[id];
    const rb = ob?.rigid_body;
    if (!ob || !rb) return;
    const b = live.get(id);
    const dynamic = b ? b.dynamic : rb.type === 'ACTIVE' && rb.enabled && !rb.kinematic;
    if (!dynamic) return;
    const s = decompose(objectWorldAt(doc, ob, w.frame_start)).s;
    const m = new Matrix4().compose(new Vector3(st[i * 7], st[i * 7 + 1], st[i * 7 + 2]), new Quaternion(st[i * 7 + 3], st[i * 7 + 4], st[i * 7 + 5], st[i * 7 + 6]), s);
    graph.simulationMatrices.set(id, m);
    applied!.add(id);
  });
}
