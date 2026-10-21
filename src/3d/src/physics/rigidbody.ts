// Rigid body world simulated with Rapier (Apache-2.0, loaded lazily as WASM).
// The world is stepped frame by frame from its start frame into a frame cache; the
// simulated transforms override evaluated world matrices through the depsgraph's
// `simulationMatrices` map.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type RAPIERNS from '@dimforge/rapier3d-compat';
import type { DocumentData, ObjectData } from '../data/types';
import type { Depsgraph } from '../eval/depsgraph';
import type { EvalMesh } from '../eval/types';
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
  collider: RAPIERNS.Collider;
  /** the collision shape follows the deforming mesh */
  deform: boolean;
  /** positions the current shape was made from */
  shapeFrom: Float32Array | null;
  /** deactivation: thresholds and frames spent below them */
  sleepLin: number;
  sleepAng: number;
  slow: number;
}

interface Live {
  world: RAPIERNS.World;
  bodies: Body[];
  /** contact filter for collision collections (null when every body uses the first one only) */
  hooks: RAPIERNS.PhysicsHooks | null;
  /** the engine only runs contact filters when stepping with an event queue */
  events: RAPIERNS.EventQueue | null;
  /** breakable joints and the impulse that breaks them */
  breakable: { joint: RAPIERNS.ImpulseJoint; b1: Body; b2: Body; threshold: number; broken: boolean }[];
  /** collision collection mask per collider handle */
  masks: Map<number, number>;
}

/** Bit mask of a rigid body's collision collections (first collection when unset). */
export function collectionMask(rb: RigidBodyX): number {
  const c = rb.collision_collections;
  if (!c || !c.length) return 1;
  let m = 0;
  for (let i = 0; i < 20; i++) if (c[i]) m |= 1 << i;
  return m;
}

/** Frame state: per body tx ty tz qx qy qz qw (order = cache.order). */
interface RBCache extends FrameCache<Float32Array, Live> {
  order?: string[];
}

/** Objects in a collection (and its children). */
function inCollection(doc: DocumentData, cid: string | null | undefined): Set<string> | null {
  const c = cid ? doc.collections[cid] : undefined;
  if (!c) return null;
  const out = new Set<string>();
  const visit = (id: string, depth: number) => {
    const cc = doc.collections[id];
    if (!cc || depth > 32) return;
    for (const o of cc.objects) out.add(o);
    for (const ch of cc.children) visit(ch, depth + 1);
  };
  visit(c.id, 0);
  return out;
}

export function rigidBodyObjects(doc: DocumentData): ObjectData[] {
  const out: ObjectData[] = [];
  // the world's collection limits which rigid bodies take part (all of them without one)
  const only = inCollection(doc, doc.scene.rigidbody_world?.collection);
  for (const id of doc.object_order) {
    const ob = doc.objects[id];
    if (ob?.rigid_body && ob.type === 'MESH' && ob.data && doc.meshes[ob.data] && (!only || only.has(ob.id))) out.push(ob);
  }
  return out;
}

export function constraintObjects(doc: DocumentData): ObjectPhysics[] {
  const out: ObjectPhysics[] = [];
  const only = inCollection(doc, (doc.scene.rigidbody_world as RigidBodyWorldX | null)?.constraints);
  for (const id of doc.object_order) {
    const ob = doc.objects[id] as ObjectPhysics | undefined;
    if (ob?.rigid_body_constraint?.enabled && (!only || only.has(ob.id))) out.push(ob);
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

/** The mesh a body's collision shape is made from (its Source: base mesh, deformed or final). */
function sourceMesh(ob: ObjectData, rb: RigidBodyX, doc: DocumentData, graph: Depsgraph | null): EvalMesh {
  const me = doc.meshes[ob.data!];
  const base = baseEvalMesh(me);
  const src = rb.mesh_source ?? 'DEFORM';
  if (src === 'BASE' || !graph) return base;
  const ev = graph.get(ob.id)?.mesh;
  if (!ev || !ev.positions.length) return base;
  // Deform keeps the base topology (modifiers that add or remove geometry are ignored)
  if (src === 'DEFORM' && ev.positions.length !== base.positions.length) return base;
  return ev;
}

function shapeDesc(R: Rapier, ob: ObjectData, rb: RigidBodyX, doc: DocumentData, scale: Vector3, dynamic: boolean, graph: Depsgraph | null = null, mesh?: EvalMesh): RAPIERNS.ColliderDesc {
  const em = mesh ?? sourceMesh(ob, rb, doc, graph);
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

/** Friction, bounciness, margin, mass and collision collections of a collider. */
function colliderProps(R: Rapier, cd: RAPIERNS.ColliderDesc, rb: RigidBodyX, dynamic: boolean) {
  cd.setFriction(Math.max(0, rb.friction)).setRestitution(Math.max(0, rb.restitution));
  cd.setFrictionCombineRule(R.CoefficientCombineRule.Multiply).setRestitutionCombineRule(R.CoefficientCombineRule.Multiply);
  if (rb.use_margin) cd.setContactSkin(Math.max(0, rb.collision_margin));
  if (dynamic) cd.setMass(Math.max(1e-3, rb.mass));
  if (collectionMask(rb) !== 1) cd.setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS);
  return cd;
}

function buildWorld(R: Rapier, doc: DocumentData, graph: Depsgraph | null = null): Live {
  const w = doc.scene.rigidbody_world as RigidBodyWorldX;
  const gw = w.effector_weights_gravity ?? 1;
  const g = doc.scene.use_gravity ? doc.scene.gravity : [0, 0, 0];
  const world = new R.World({ x: g[0] * gw, y: g[1] * gw, z: g[2] * gw });
  const substeps = Math.max(1, Math.round(w.substeps_per_frame));
  world.timestep = Math.max(1e-6, (w.time_scale || 0) / fps(doc) / substeps);
  world.integrationParameters.numSolverIterations = Math.max(1, Math.round(w.solver_iterations));
  // split impulse: overlaps are pushed apart gently, without the push turning into a bounce
  if (w.use_split_impulse) world.integrationParameters.contact_natural_frequency = 8;
  const bodies: Body[] = [];
  const byId = new Map<string, Body>();
  const masks = new Map<number, number>();
  const breakable: Live['breakable'] = [];
  for (const ob of rigidBodyObjects(doc)) {
    const rb = ob.rigid_body as RigidBodyX;
    const { p, q, s } = decompose(objectWorldAt(doc, ob, w.frame_start));
    const dynamic = rb.type === 'ACTIVE' && rb.enabled && !rb.kinematic;
    const kinematic = !dynamic && (rb.kinematic || (rb.type === 'ACTIVE' && !rb.enabled));
    const desc = dynamic ? R.RigidBodyDesc.dynamic() : kinematic ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.fixed();
    desc.setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    desc.setLinearDamping(damping(rb.linear_damping)).setAngularDamping(damping(rb.angular_damping)).setCanSleep(!!rb.use_deactivation);
    if (dynamic && rb.use_deactivation && rb.use_start_deactivated) desc.setSleeping(true);
    const body = world.createRigidBody(desc);
    const mesh = sourceMesh(ob, rb, doc, graph);
    const cd = colliderProps(R, shapeDesc(R, ob, rb, doc, new Vector3(s.x, s.y, s.z), dynamic, graph, mesh), rb, dynamic);
    const mask = collectionMask(rb);
    const collider = world.createCollider(cd, body);
    masks.set(collider.handle, mask);
    const b: Body = {
      id: ob.id,
      body,
      dynamic,
      kinematic,
      scale: s.clone(),
      mass: rb.mass,
      collider,
      deform: !!rb.use_deform && (rb.mesh_source ?? 'DEFORM') !== 'BASE',
      shapeFrom: mesh.positions,
      sleepLin: rb.deactivate_linear_velocity ?? 0.4,
      sleepAng: rb.deactivate_angular_velocity ?? 0.5,
      slow: 0,
    };
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
    // a constraint can ask for more solver iterations than the world uses
    if (c.use_override_solver_iterations) {
      const extra = Math.max(0, Math.round(Number(c.solver_iterations ?? 10)) - world.integrationParameters.numSolverIterations);
      for (const b of [b1, b2]) if (b.dynamic) b.body.setAdditionalSolverIterations(Math.max(b.body.additionalSolverIterations(), extra));
    }
    if (c.use_breaking) breakable.push({ joint, b1, b2, threshold: Math.max(0, Number(c.breaking_threshold ?? 10)), broken: false });
  }
  const filtered = [...masks.values()].some((m) => m !== 1);
  const hooks: RAPIERNS.PhysicsHooks | null = filtered
    ? {
        filterContactPair: (c1, c2) => ((masks.get(c1) ?? 1) & (masks.get(c2) ?? 1) ? R.SolverFlags.COMPUTE_IMPULSE : null),
        filterIntersectionPair: () => true,
      }
    : null;
  return { world, bodies, hooks, events: hooks ? new R.EventQueue(false) : null, breakable, masks };
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
  // deforming collision shapes follow their (evaluated) mesh
  if (graph && RAPIER)
    for (const b of live.bodies) {
      if (!b.deform) continue;
      const ob = doc.objects[b.id];
      const rb = ob?.rigid_body as RigidBodyX | undefined;
      const mesh = ob && rb ? sourceMesh(ob, rb, doc, graph) : null;
      if (!ob || !rb || !mesh || mesh.positions === b.shapeFrom) continue;
      live.world.removeCollider(b.collider, false);
      const cd = colliderProps(RAPIER, shapeDesc(RAPIER, ob, rb, doc, b.scale, b.dynamic, graph, mesh), rb, b.dynamic);
      b.collider = live.world.createCollider(cd, b.body);
      live.masks.set(b.collider.handle, collectionMask(rb));
      b.shapeFrom = mesh.positions;
    }
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
      effectorForce(effs, p.x, p.y, p.z, v.x, v.y, v.z, frame - 1 + t, f, 1, null, (w as { effector_weights_types?: Record<string, number> }).effector_weights_types ?? null);
      b.body.resetForces(false);
      if (f[0] || f[1] || f[2]) b.body.addForce({ x: f[0], y: f[1], z: f[2] }, true);
    }
    // velocities before the step: the change beyond gravity is the impulse the solver applied
    const watch = live.breakable.length ? breakWatch(live, doc) : null;
    live.world.step(live.events ?? undefined, live.hooks ?? undefined);
    if (watch) breakJoints(live, watch);
  }
  // deactivation: bodies slower than their thresholds for a while go to sleep
  for (const b of live.bodies) {
    if (!b.dynamic || !b.body.isEnabled() || b.body.isSleeping()) continue;
    const ob = doc.objects[b.id];
    if (!(ob?.rigid_body as RigidBodyX | undefined)?.use_deactivation) continue;
    const v = b.body.linvel(),
      a = b.body.angvel();
    if (Math.hypot(v.x, v.y, v.z) < b.sleepLin && Math.hypot(a.x, a.y, a.z) < b.sleepAng) {
      if (++b.slow >= 5) b.body.sleep();
    } else b.slow = 0;
  }
}

interface BreakWatch {
  v: Map<Body, { x: number; y: number; z: number }>;
  g: [number, number, number];
  dt: number;
}

function breakWatch(live: Live, doc: DocumentData): BreakWatch {
  const w = doc.scene.rigidbody_world as RigidBodyWorldX;
  const gw = w.effector_weights_gravity ?? 1;
  const g = doc.scene.use_gravity ? doc.scene.gravity : [0, 0, 0];
  const v = new Map<Body, { x: number; y: number; z: number }>();
  for (const b of live.breakable)
    if (!b.broken) for (const body of [b.b1, b.b2]) if (body.dynamic && !v.has(body)) v.set(body, { ...body.body.linvel() });
  return { v, g: [g[0] * gw, g[1] * gw, g[2] * gw], dt: live.world.timestep };
}

/** Remove joints whose bodies received more than their breaking impulse in the last step. */
function breakJoints(live: Live, w: BreakWatch) {
  for (const b of live.breakable) {
    if (b.broken) continue;
    let impulse = 0;
    for (const body of [b.b1, b.b2]) {
      const before = w.v.get(body);
      if (!before) continue;
      const after = body.body.linvel();
      const dx = after.x - before.x - w.g[0] * w.dt,
        dy = after.y - before.y - w.g[1] * w.dt,
        dz = after.z - before.z - w.g[2] * w.dt;
      impulse = Math.max(impulse, body.mass * Math.hypot(dx, dy, dz));
    }
    if (impulse > b.threshold) {
      live.world.removeImpulseJoint(b.joint, true);
      b.broken = true;
    }
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
  c.live?.events?.free();
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
    cache.live = buildWorld(RAPIER, doc, graph);
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
