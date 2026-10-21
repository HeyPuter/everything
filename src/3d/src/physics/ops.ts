// Physics operators: rigid body world/objects/constraints, bake to keyframes,
// force field and collision toggles, particle systems and point cache baking.
import { Matrix4 } from 'three';
import { app, registerOperators, type OpContext } from '../app/app';
import type { DocumentData, ObjectData, ModifierBase } from '../data/types';
import { newObject, uid } from '../data/defaults';
import { uniqueName } from '../ops/object';
import { newModifier } from '../eval/modifiers';
import { applyMatrixToObject, toMatrix4 } from '../eval/transform';
import { keyingTarget, ensureFCurve, rotationPath } from '../anim/keyframes';
import { insertKeyframe } from '../anim/fcurve';
import { caches, freeCache, objectWorldAt, startBudget } from './common';
import { freeRigidBodyLive, loadRapier, rapierLoaded, rigidBodyMatrix, simulateRigidBodies, RB_CACHE } from './rigidbody';
import { meshSimKey } from './meshsim';
import { RBC_TYPES, rbcDefaults } from './rbjoints';
import { dpCacheKey, type DynamicPaintModifier } from './dynpaint';
import { hairDynKey } from './hairdyn';
import { particleCacheKey, systemOf } from './particles';
import { fluidCacheKey } from './fluid';
import { physicsState } from './runtime';
import {
  defaultCollision,
  defaultField,
  defaultParticleSettings,
  defaultPointCache,
  defaultRigidBody,
  defaultRigidBodyWorld,
  type ObjectPhysics,
  type ParticleSystemX,
  type PointCacheSettings,
  type RigidBodyWorldX,
  type RigidBodyConstraintData,
} from './types';

const isMesh = (o: ObjectData | null | undefined) => !!o && o.type === 'MESH' && !!o.data;
const active = () => app.activeObject;
const objectMode = (ctx: OpContext) => ctx.doc.mode === 'OBJECT';

function ensureWorld(doc: DocumentData): RigidBodyWorldX {
  if (!doc.scene.rigidbody_world) doc.scene.rigidbody_world = defaultRigidBodyWorld(doc.scene.frame_start, doc.scene.frame_end);
  return doc.scene.rigidbody_world as RigidBodyWorldX;
}

// ---------------------------------------------------------------------------
// Point caches

export type CacheOwner = { key: string; label: string; pc: { frame_start: number; frame_end: number; is_baked: boolean } };

/** All point caches in the document (rigid body world, cloth/soft body modifiers, particle systems). */
export function cacheOwners(doc: DocumentData): CacheOwner[] {
  const out: CacheOwner[] = [];
  const w = doc.scene.rigidbody_world as RigidBodyWorldX | null;
  if (w) out.push({ key: RB_CACHE, label: 'Rigid Body World', pc: w as unknown as PointCacheSettings });
  for (const id of doc.object_order) {
    const ob = doc.objects[id];
    if (!ob) continue;
    for (const m of ob.modifiers) {
      if ((m.type === 'CLOTH' || m.type === 'SOFT_BODY') && m.point_cache) out.push({ key: meshSimKey(m.type, ob, m), label: `${ob.name} ▸ ${m.name}`, pc: m.point_cache as PointCacheSettings });
      if (m.type === 'FLUID' && m.fluid_type === 'DOMAIN' && m.point_cache) out.push({ key: fluidCacheKey(ob, m), label: `${ob.name} ▸ ${m.name}`, pc: m.point_cache as PointCacheSettings });
      if (m.type === 'DYNAMIC_PAINT' && m.ui_type === 'CANVAS')
        for (const sf of (m as DynamicPaintModifier).canvas_settings?.canvas_surfaces ?? []) if (sf.is_active) out.push({ key: dpCacheKey(ob, m, sf), label: `${ob.name} ▸ ${sf.name}`, pc: sf.point_cache });
      if (m.type === 'PARTICLE_SYSTEM') {
        const ps = systemOf(ob, m);
        const s = ps ? doc.particles[ps.settings] : undefined;
        if (ps && s && s.type !== 'HAIR') {
          ps.point_cache ??= defaultPointCache();
          out.push({ key: particleCacheKey(ob, m), label: `${ob.name} ▸ ${ps.name}`, pc: ps.point_cache });
        } else if (ps && s && ps.use_hair_dynamics) {
          ps.point_cache ??= defaultPointCache();
          out.push({ key: hairDynKey(ob, m), label: `${ob.name} ▸ ${ps.name}`, pc: ps.point_cache });
        }
      }
    }
  }
  return out;
}

/** Simulate every frame of the given caches synchronously (evaluating the scene per frame). */
function bakeCaches(doc: DocumentData, owners: CacheOwner[]): number {
  if (!owners.length) return 0;
  const start = Math.min(...owners.map((o) => o.pc.frame_start)),
    end = Math.max(...owners.map((o) => o.pc.frame_end));
  const cur = doc.scene.frame_current,
    sub = doc.scene.frame_subframe;
  physicsState.baking = true;
  try {
    for (const o of owners) o.pc.is_baked = false;
    startBudget(Infinity);
    for (let f = start; f <= end; f++) {
      doc.scene.frame_current = f;
      doc.scene.frame_subframe = 0;
      app.graph.evaluate(doc);
    }
  } finally {
    physicsState.baking = false;
    doc.scene.frame_current = cur;
    doc.scene.frame_subframe = sub;
  }
  for (const o of owners) o.pc.is_baked = true;
  app.graph.evaluate(doc);
  return end - start + 1;
}

/** Simulate the given caches from their start up to a frame without baking them ("calculate to frame"). */
function calculateCaches(doc: DocumentData, owners: CacheOwner[], toFrame: number): number {
  if (!owners.length) return 0;
  const start = Math.min(...owners.map((o) => o.pc.frame_start));
  const end = Math.min(toFrame, Math.max(...owners.map((o) => o.pc.frame_end)));
  const cur = doc.scene.frame_current,
    sub = doc.scene.frame_subframe;
  try {
    startBudget(Infinity);
    for (let f = start; f <= end; f++) {
      doc.scene.frame_current = f;
      doc.scene.frame_subframe = 0;
      app.graph.evaluate(doc);
    }
  } finally {
    doc.scene.frame_current = cur;
    doc.scene.frame_subframe = sub;
  }
  app.graph.evaluate(doc);
  return Math.max(0, end - start + 1);
}

function freeOwner(o: CacheOwner) {
  o.pc.is_baked = false;
  freeCache(o.key);
  if (o.key === RB_CACHE) freeRigidBodyLive();
}

function ownerByKey(doc: DocumentData, key: string) {
  return cacheOwners(doc).find((o) => o.key === key);
}

const needsRapier = (owners: CacheOwner[]) => owners.some((o) => o.key === RB_CACHE) && !rapierLoaded();

function withRapier(owners: CacheOwner[], run: () => void, bake = true): 'FINISHED' | 'CANCELLED' {
  if (!needsRapier(owners)) {
    run();
    return 'FINISHED';
  }
  app.report('INFO', 'Loading physics engine…');
  void loadRapier().then(() => app.run('ptcache.bake_all', { only: owners.map((o) => o.key).join(','), bake }));
  return 'CANCELLED';
}

// ---------------------------------------------------------------------------
// Rigid body helpers

function rbObjects() {
  return app.selectedObjects().filter(isMesh);
}

function bakeToKeyframes(doc: DocumentData, obs: ObjectData[], start: number, end: number, step: number) {
  const w = doc.scene.rigidbody_world as RigidBodyWorldX;
  startBudget(Infinity);
  physicsState.baking = true;
  try {
    simulateRigidBodies(doc, Math.min(end, w.frame_end), null);
  } finally {
    physicsState.baking = false;
  }
  for (const ob of obs) {
    const scratch = { ...ob, location: [...ob.location], rotation_euler: [...ob.rotation_euler], rotation_quaternion: [...ob.rotation_quaternion], rotation_axis_angle: [...ob.rotation_axis_angle], scale: [...ob.scale] } as ObjectData;
    const { act, slot } = keyingTarget(doc, ob);
    const rpath = rotationPath(ob);
    for (let f = start; f <= end; f += step) {
      const world = rigidBodyMatrix(doc, ob.id, f) ?? objectWorldAt(doc, ob, f);
      let local = world.clone();
      const parent = ob.parent ? doc.objects[ob.parent] : undefined;
      if (parent) local = new Matrix4().multiplyMatrices(objectWorldAt(doc, parent, f), toMatrix4(ob.matrix_parent_inverse)).invert().multiply(world);
      applyMatrixToObject(scratch, local);
      const loc = scratch.location;
      const rot = rpath === 'rotation_quaternion' ? scratch.rotation_quaternion : rpath === 'rotation_axis_angle' ? scratch.rotation_axis_angle : scratch.rotation_euler;
      for (let i = 0; i < 3; i++) insertKeyframe(ensureFCurve(act, 'location', i, slot), f, loc[i]);
      for (let i = 0; i < rot.length; i++) insertKeyframe(ensureFCurve(act, rpath, i, slot), f, rot[i]);
    }
    ob.rigid_body = null;
  }
}

function bakeKeysExec(ctx: OpContext, p: Record<string, unknown>): 'FINISHED' | 'CANCELLED' {
  if (!rapierLoaded()) {
    app.report('INFO', 'Loading physics engine…');
    void loadRapier().then(() => app.run('rigidbody.bake_to_keyframes', { ...p }));
    return 'CANCELLED';
  }
  const obs = app.selectedObjects().filter((o) => o.rigid_body?.type === 'ACTIVE');
  bakeToKeyframes(ctx.doc, obs, Math.round(p.frame_start as number), Math.round(p.frame_end as number), Math.max(1, Math.round(p.step as number)));
  app.report('INFO', `Baked ${obs.length} rigid bod${obs.length === 1 ? 'y' : 'ies'} to keyframes`);
  return 'FINISHED';
}

function addConstraintObject(doc: DocumentData, a: ObjectData, b: ObjectData, type: RigidBodyConstraintData['type'], pivot: 'CENTER' | 'ACTIVE' | 'SELECTED') {
  const pa = objectWorldAt(doc, a, doc.scene.frame_current).elements,
    pb = objectWorldAt(doc, b, doc.scene.frame_current).elements;
  const loc: [number, number, number] =
    pivot === 'ACTIVE' ? [pa[12], pa[13], pa[14]] : pivot === 'SELECTED' ? [pb[12], pb[13], pb[14]] : [(pa[12] + pb[12]) / 2, (pa[13] + pb[13]) / 2, (pa[14] + pb[14]) / 2];
  const e = newObject('Constraint', 'EMPTY', null) as ObjectPhysics;
  e.empty_display_type = 'PLAIN_AXES';
  e.empty_display_size = 0.5;
  e.name = uniqueName(doc, 'Constraint');
  e.location = loc;
  e.rigid_body_constraint = { ...rbcDefaults(), type, enabled: true, disable_collisions: true, object1: a.id, object2: b.id };
  doc.objects[e.id] = e;
  doc.object_order.push(e.id);
  doc.collections[doc.scene.collection].objects.push(e.id);
  return e;
}

const SHAPES: [string, string][] = [
  ['BOX', 'Box'],
  ['SPHERE', 'Sphere'],
  ['CAPSULE', 'Capsule'],
  ['CYLINDER', 'Cylinder'],
  ['CONE', 'Cone'],
  ['CONVEX_HULL', 'Convex Hull'],
  ['MESH', 'Mesh'],
];
const CON_TYPES = RBC_TYPES;

function particleOwnerModifier(ob: ObjectData, ps: ParticleSystemX): ModifierBase | undefined {
  return ob.modifiers.find((m) => m.type === 'PARTICLE_SYSTEM' && m.particle_system === (ps as { id?: string }).id);
}

registerOperators([
  // --- rigid body world
  {
    idname: 'rigidbody.world_add',
    label: 'Add Rigid Body World',
    description: 'Add a rigid body simulation world to the scene',
    poll: (ctx) => !ctx.doc.scene.rigidbody_world,
    exec: (ctx) => {
      ensureWorld(ctx.doc);
      void loadRapier();
    },
  },
  {
    idname: 'rigidbody.world_remove',
    label: 'Remove Rigid Body World',
    description: 'Remove the rigid body simulation world from the scene',
    poll: (ctx) => !!ctx.doc.scene.rigidbody_world,
    exec: (ctx) => {
      ctx.doc.scene.rigidbody_world = null;
      freeCache(RB_CACHE);
      freeRigidBodyLive();
    },
  },
  // --- rigid body objects
  {
    idname: 'rigidbody.objects_add',
    label: 'Add Rigid Bodies',
    description: 'Add selected mesh objects to the rigid body world',
    props: [{ id: 'type', label: 'Rigid Body Type', type: 'enum', default: 'ACTIVE', items: [['ACTIVE', 'Active'], ['PASSIVE', 'Passive']] }],
    poll: (ctx) => objectMode(ctx) && app.selectedObjects().some(isMesh),
    exec: (ctx, p) => {
      const obs = rbObjects();
      if (!obs.length) return 'CANCELLED';
      ensureWorld(ctx.doc);
      for (const ob of obs) ob.rigid_body = defaultRigidBody(p.type as 'ACTIVE' | 'PASSIVE');
      void loadRapier();
    },
  },
  {
    idname: 'rigidbody.objects_remove',
    label: 'Remove Rigid Bodies',
    description: 'Remove selected objects from the rigid body world',
    poll: (ctx) => objectMode(ctx) && app.selectedObjects().some((o) => !!o.rigid_body),
    exec: () => {
      for (const ob of app.selectedObjects()) ob.rigid_body = null;
    },
  },
  {
    idname: 'rigidbody.object_add',
    label: 'Add Rigid Body',
    description: 'Add the active object as a rigid body',
    props: [{ id: 'type', label: 'Rigid Body Type', type: 'enum', default: 'ACTIVE', items: [['ACTIVE', 'Active'], ['PASSIVE', 'Passive']] }],
    poll: () => isMesh(active()) && !active()!.rigid_body,
    exec: (ctx, p) => {
      ensureWorld(ctx.doc);
      active()!.rigid_body = defaultRigidBody(p.type as 'ACTIVE' | 'PASSIVE');
      void loadRapier();
    },
  },
  {
    idname: 'rigidbody.object_remove',
    label: 'Remove Rigid Body',
    description: 'Remove the active object from the rigid body world',
    poll: () => !!active()?.rigid_body,
    exec: () => {
      active()!.rigid_body = null;
    },
  },
  {
    idname: 'rigidbody.shape_change',
    label: 'Change Collision Shape',
    description: 'Change the collision shape of selected rigid bodies',
    props: [{ id: 'type', label: 'Rigid Body Shape', type: 'enum', default: 'MESH', items: SHAPES }],
    poll: () => app.selectedObjects().some((o) => !!o.rigid_body),
    exec: (_ctx, p) => {
      for (const ob of app.selectedObjects()) if (ob.rigid_body) ob.rigid_body.collision_shape = p.type as never;
    },
  },
  {
    idname: 'rigidbody.object_settings_copy',
    label: 'Copy Rigid Body Settings',
    description: 'Copy the rigid body settings of the active object to selected objects',
    poll: () => !!active()?.rigid_body && app.selectedObjects().length > 1,
    exec: () => {
      const src = active()!.rigid_body!;
      for (const ob of app.selectedObjects()) if (ob !== active() && isMesh(ob)) ob.rigid_body = structuredClone(src);
    },
  },
  {
    idname: 'rigidbody.bake_to_keyframes',
    label: 'Bake to Keyframes',
    description: 'Bake rigid body transformations of selected objects to keyframes',
    props: [
      { id: 'frame_start', label: 'Start Frame', type: 'int', default: 1, min: 0 },
      { id: 'frame_end', label: 'End Frame', type: 'int', default: 250, min: 0 },
      { id: 'step', label: 'Frame Step', type: 'int', default: 1, min: 1, max: 120 },
    ],
    redo: false,
    poll: (ctx) => objectMode(ctx) && !!ctx.doc.scene.rigidbody_world && app.selectedObjects().some((o) => o.rigid_body?.type === 'ACTIVE'),
    invoke: (ctx, p) => {
      const w = ctx.doc.scene.rigidbody_world!;
      p.frame_start = w.frame_start;
      p.frame_end = w.frame_end;
      return bakeKeysExec(ctx, p);
    },
    exec: (ctx, p) => bakeKeysExec(ctx, p),
  },
  // --- rigid body constraints
  {
    idname: 'rigidbody.constraint_add',
    label: 'Add Rigid Body Constraint',
    description: 'Add a rigid body constraint to the active object',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'FIXED', items: CON_TYPES }],
    poll: () => !!active() && !(active() as ObjectPhysics).rigid_body_constraint,
    exec: (ctx, p) => {
      ensureWorld(ctx.doc);
      (active() as ObjectPhysics).rigid_body_constraint = { ...rbcDefaults(), type: p.type as RigidBodyConstraintData['type'], enabled: true, disable_collisions: true, object1: null, object2: null };
    },
  },
  {
    idname: 'rigidbody.constraint_remove',
    label: 'Remove Rigid Body Constraint',
    description: 'Remove the rigid body constraint from the active object',
    poll: () => !!(active() as ObjectPhysics | null)?.rigid_body_constraint,
    exec: () => {
      (active() as ObjectPhysics).rigid_body_constraint = null;
    },
  },
  {
    idname: 'rigidbody.connect',
    label: 'Connect Rigid Bodies',
    description: 'Create rigid body constraints between selected rigid bodies',
    props: [
      { id: 'con_type', label: 'Type', type: 'enum', default: 'FIXED', items: CON_TYPES },
      { id: 'pivot_type', label: 'Location', type: 'enum', default: 'CENTER', items: [['CENTER', 'Center'], ['ACTIVE', 'Active'], ['SELECTED', 'Selected']] },
      { id: 'connection_pattern', label: 'Connection Pattern', type: 'enum', default: 'SELECTED_TO_ACTIVE', items: [['SELECTED_TO_ACTIVE', 'Selected to Active'], ['CHAIN_DISTANCE', 'Chain by Distance']] },
    ],
    poll: (ctx) => objectMode(ctx) && app.selectedObjects().filter((o) => !!o.rigid_body).length > 1,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const obs = app.selectedObjects().filter((o) => !!o.rigid_body);
      const act = active() && obs.includes(active()!) ? active()! : obs[0];
      const pairs: [ObjectData, ObjectData][] = [];
      if (p.connection_pattern === 'CHAIN_DISTANCE') {
        const rest = obs.filter((o) => o !== act);
        let cur = act;
        const pos = (o: ObjectData) => objectWorldAt(doc, o, doc.scene.frame_current).elements;
        while (rest.length) {
          const c = pos(cur);
          rest.sort((a, b) => {
            const pa = pos(a),
              pb = pos(b);
            return Math.hypot(pa[12] - c[12], pa[13] - c[13], pa[14] - c[14]) - Math.hypot(pb[12] - c[12], pb[13] - c[13], pb[14] - c[14]);
          });
          const next = rest.shift()!;
          pairs.push([cur, next]);
          cur = next;
        }
      } else for (const o of obs) if (o !== act) pairs.push([act, o]);
      for (const [a, b] of pairs) addConstraintObject(doc, a, b, p.con_type as RigidBodyConstraintData['type'], p.pivot_type as 'CENTER');
      app.report('INFO', `Created ${pairs.length} constraint${pairs.length === 1 ? '' : 's'}`);
    },
  },
  // --- force fields & collision
  {
    idname: 'object.forcefield_toggle',
    label: 'Toggle Force Field',
    description: 'Toggle the force field of the active object',
    poll: () => !!active(),
    exec: () => {
      const ob = active()!;
      ob.field = ob.field && ob.field.type !== 'NONE' ? null : defaultField('FORCE');
    },
  },
  {
    idname: 'object.collision_toggle',
    label: 'Toggle Collision',
    description: 'Make the active object a collision object for cloth, soft bodies and particles',
    poll: () => !!active() && ['MESH', 'CURVE', 'FONT'].includes(active()!.type),
    exec: () => {
      const ob = active()!;
      ob.collision = ob.collision?.use ? null : defaultCollision();
    },
  },
  // --- particle systems
  {
    idname: 'object.particle_system_add',
    label: 'Add Particle System',
    description: 'Add a particle system to the active mesh object',
    poll: () => isMesh(active()),
    exec: (ctx) => {
      const ob = active()! as ObjectPhysics;
      const doc = ctx.doc;
      const settingsName = uniqueParticleName(doc, 'ParticleSettings');
      const s = defaultParticleSettings(uid('pa'), settingsName);
      s.frame_start = doc.scene.frame_start;
      s.frame_end = doc.scene.frame_start + 199;
      doc.particles[s.id] = s;
      let name = 'ParticleSystem';
      for (let i = 1; ob.particle_systems.some((p) => p.name === name); i++) name = `ParticleSystem.${String(i).padStart(3, '0')}`;
      const ps: ParticleSystemX & { id: string } = { name, settings: s.id, seed: ob.particle_systems.length, id: uid('psys'), point_cache: defaultPointCache(doc.scene.frame_start, doc.scene.frame_end) };
      ob.particle_systems.push(ps);
      const m = newModifier('PARTICLE_SYSTEM', uid('md'), ob.modifiers);
      m.name = name;
      m.particle_system = ps.id;
      ob.modifiers.push(m);
      ob.active_particle_system_index = ob.particle_systems.length - 1;
    },
  },
  {
    idname: 'object.particle_system_remove',
    label: 'Remove Particle System',
    description: 'Remove the active particle system',
    poll: () => !!active()?.particle_systems.length,
    exec: (ctx) => {
      const ob = active()! as ObjectPhysics;
      const i = Math.min(ob.active_particle_system_index ?? 0, ob.particle_systems.length - 1);
      const ps = ob.particle_systems[i] as ParticleSystemX;
      const m = particleOwnerModifier(ob, ps);
      if (m) {
        ob.modifiers = ob.modifiers.filter((x) => x !== m);
        freeCache(particleCacheKey(ob, m));
      }
      ob.particle_systems.splice(i, 1);
      const s = ctx.doc.particles[ps.settings];
      if (s && !Object.values(ctx.doc.objects).some((o) => o.particle_systems.some((p) => p.settings === s.id))) delete ctx.doc.particles[s.id];
      ob.active_particle_system_index = Math.max(0, i - 1);
    },
  },
  {
    idname: 'particle.new',
    label: 'New Particle Settings',
    description: 'Add new particle settings (a copy of the current ones) to the active particle system',
    poll: () => !!active()?.particle_systems.length,
    exec: (ctx) => {
      const ob = active()! as ObjectPhysics;
      const ps = ob.particle_systems[ob.active_particle_system_index ?? 0];
      if (!ps) return 'CANCELLED';
      const cur = ctx.doc.particles[ps.settings];
      const s = cur ? { ...structuredClone(cur), id: uid('pa'), name: uniqueParticleName(ctx.doc, cur.name) } : defaultParticleSettings(uid('pa'), uniqueParticleName(ctx.doc, 'ParticleSettings'));
      ctx.doc.particles[s.id] = s;
      ps.settings = s.id;
    },
  },
  {
    idname: 'object.particle_system_modifier_restore',
    label: 'Restore Particle Modifier',
    description: 'Re-create the modifier that evaluates the active particle system',
    internal: true,
    poll: () => {
      const ob = active() as ObjectPhysics | null;
      const ps = ob?.particle_systems[ob.active_particle_system_index ?? 0] as ParticleSystemX | undefined;
      return !!ob && !!ps && !particleOwnerModifier(ob, ps);
    },
    exec: () => {
      const ob = active()! as ObjectPhysics;
      const ps = ob.particle_systems[ob.active_particle_system_index ?? 0] as ParticleSystemX & { id?: string };
      ps.id ??= uid('psys');
      const m = newModifier('PARTICLE_SYSTEM', uid('md'), ob.modifiers);
      m.name = ps.name;
      m.particle_system = ps.id;
      ob.modifiers.push(m);
    },
  },
  // --- point caches
  {
    idname: 'ptcache.bake',
    label: 'Bake Physics',
    description: 'Bake the simulation of this cache for its whole frame range (or only calculate it up to the current frame)',
    props: [
      { id: 'cache', label: 'Cache', type: 'string', default: '', hidden: true },
      { id: 'bake', label: 'Bake', type: 'bool', default: true, hidden: true },
    ],
    redo: false,
    poll: (ctx) => cacheOwners(ctx.doc).length > 0,
    exec: (ctx, p) => {
      const o = ownerByKey(ctx.doc, p.cache as string);
      if (!o) return 'CANCELLED';
      if (p.bake === false) {
        if (o.pc.is_baked) return 'CANCELLED';
        return withRapier([o], () => {
          const n = calculateCaches(ctx.doc, [o], ctx.doc.scene.frame_current);
          app.report('INFO', `Calculated ${o.label} for ${n} frames`);
        }, false);
      }
      return withRapier([o], () => {
        const t = performance.now();
        const n = bakeCaches(ctx.doc, [o]);
        app.report('INFO', `Baked ${o.label}: ${n} frames in ${((performance.now() - t) / 1000).toFixed(2)} s`);
      });
    },
  },
  {
    idname: 'ptcache.bake_from_cache',
    label: 'Current Cache to Bake',
    description: 'Keep the frames simulated so far as the bake of this cache',
    props: [{ id: 'cache', label: 'Cache', type: 'string', default: '', hidden: true }],
    redo: false,
    poll: (ctx) => cacheOwners(ctx.doc).some((o) => !o.pc.is_baked),
    exec: (ctx, p) => {
      const o = ownerByKey(ctx.doc, p.cache as string);
      if (!o || o.pc.is_baked) return 'CANCELLED';
      const c = caches.get(o.key);
      if (!c?.frames.size) {
        app.report('WARNING', 'Nothing is cached yet: play the animation or calculate to a frame first');
        return 'CANCELLED';
      }
      o.pc.is_baked = true;
    },
  },
  {
    idname: 'ptcache.free_bake',
    label: 'Delete Bake',
    description: 'Free the baked cache of this simulation',
    props: [{ id: 'cache', label: 'Cache', type: 'string', default: '', hidden: true }],
    redo: false,
    poll: (ctx) => cacheOwners(ctx.doc).length > 0,
    exec: (ctx, p) => {
      const o = ownerByKey(ctx.doc, p.cache as string);
      if (!o) return 'CANCELLED';
      freeOwner(o);
    },
  },
  {
    idname: 'ptcache.bake_all',
    label: 'Bake All Dynamics',
    description: 'Bake all physics simulations in the scene (or only update them up to the current frame)',
    props: [
      { id: 'only', label: 'Only', type: 'string', default: '', hidden: true },
      { id: 'bake', label: 'Bake', type: 'bool', default: true, hidden: true },
    ],
    redo: false,
    poll: (ctx) => cacheOwners(ctx.doc).length > 0,
    exec: (ctx, p) => {
      const only = String(p.only || '');
      const owners = cacheOwners(ctx.doc).filter((o) => !only || only.split(',').includes(o.key));
      if (p.bake === false) {
        const todo = owners.filter((o) => !o.pc.is_baked);
        return withRapier(todo, () => {
          const n = calculateCaches(ctx.doc, todo, ctx.doc.scene.frame_current);
          app.report('INFO', `Updated ${todo.length} simulation${todo.length === 1 ? '' : 's'} to frame ${ctx.doc.scene.frame_current} (${n} frames)`);
        }, false);
      }
      return withRapier(owners, () => {
        const t = performance.now();
        const n = bakeCaches(ctx.doc, owners);
        app.report('INFO', `Baked ${owners.length} simulation${owners.length === 1 ? '' : 's'} (${n} frames) in ${((performance.now() - t) / 1000).toFixed(2)} s`);
      });
    },
  },
  {
    idname: 'ptcache.free_bake_all',
    label: 'Delete All Bakes',
    description: 'Free all baked physics caches in the scene',
    redo: false,
    poll: (ctx) => cacheOwners(ctx.doc).some((o) => o.pc.is_baked),
    exec: (ctx) => {
      for (const o of cacheOwners(ctx.doc)) if (o.pc.is_baked) freeOwner(o);
    },
  },
  {
    idname: 'ptcache.free',
    label: 'Free Cache',
    description: 'Free the (non-baked) cache of this simulation so it is recomputed',
    props: [{ id: 'cache', label: 'Cache', type: 'string', default: '', hidden: true }],
    undo: false,
    poll: (ctx) => cacheOwners(ctx.doc).some((o) => !o.pc.is_baked),
    exec: (ctx, p) => {
      const o = ownerByKey(ctx.doc, p.cache as string);
      if (!o || o.pc.is_baked) return 'CANCELLED';
      freeOwner(o);
      app.changed('frame');
    },
  },
  {
    idname: 'ptcache.free_all',
    label: 'Free All Caches',
    description: 'Free all (non-baked) simulation caches so they are recomputed',
    undo: false,
    exec: (ctx) => {
      for (const o of cacheOwners(ctx.doc)) if (!o.pc.is_baked) freeOwner(o);
      app.changed('frame');
    },
  },
]);

function uniqueParticleName(doc: DocumentData, base: string) {
  const names = new Set(Object.values(doc.particles).map((p) => p.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

