// Particle system operators: copying / duplicating / removing systems, the boid brain (rules and
// states), particle targets (keyed paths and boid relations), the instance weights of collection
// instancing and connecting / disconnecting hair from the emitter surface.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators, type OpContext } from '../app/app';
import type { DocumentData, ObjectData } from '../data/types';
import { uid } from '../data/defaults';
import { newModifier } from '../eval/modifiers';
import { freeCache } from './common';
import { particleCacheKey, systemOf } from './particles';
import { BOID_RULES, defaultBoidSettings, ensureBoidStates, newBoidRule, newBoidState, type BoidRuleType, type BoidSettings } from './boids';
import type { KeyedTarget } from './keyed';
import { bindHairRoots, type HairBinding } from './hairbind';
import type { EditedHair, ObjectPhysics, ParticleSettingsX, ParticleSystemX } from './types';

const active = () => app.activeObject as ObjectPhysics | null;

/** The active particle system of the active object, with its settings. */
export function activeSystem(): { ob: ObjectPhysics; ps: ParticleSystemX; s: ParticleSettingsX | undefined; index: number } | null {
  const ob = active();
  if (!ob || !ob.particle_systems.length) return null;
  const index = Math.min(Math.max(0, ob.active_particle_system_index ?? 0), ob.particle_systems.length - 1);
  const ps = ob.particle_systems[index] as ParticleSystemX;
  return { ob, ps, s: app.doc.particles[ps.settings] as ParticleSettingsX | undefined, index };
}

const modOf = (ob: ObjectData, ps: ParticleSystemX) => ob.modifiers.find((m) => m.type === 'PARTICLE_SYSTEM' && systemOf(ob, m) === ps);

function uniqueSystemName(ob: ObjectData, base: string) {
  const names = new Set(ob.particle_systems.map((p) => p.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

function uniqueSettingsName(doc: DocumentData, base: string) {
  const names = new Set(Object.values(doc.particles).map((p) => p.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

const cloneEdited = (ed: EditedHair): EditedHair => ({ key_offsets: ed.key_offsets.slice(), co: ed.co.slice(), weight: ed.weight.slice(), select: ed.select.slice(), hide: ed.hide.slice() });

/** Add a copy of `src` (from object `from`) to object `to` (its modifier goes to the end of the stack). */
function addSystemCopy(doc: DocumentData, from: ObjectData, src: ParticleSystemX, to: ObjectPhysics, settingsId: string, space: 'OBJECT' | 'WORLD'): ParticleSystemX {
  const ps: ParticleSystemX & { id: string } = {
    ...structuredClone({ ...src, edited_hair: null, hair_binding: null }),
    id: uid('psys'),
    name: uniqueSystemName(to, src.name),
    settings: settingsId,
  };
  if (src.edited_hair) {
    const ed = cloneEdited(src.edited_hair);
    if (space === 'WORLD' && from !== to) {
      // keep the hair where it is in the world
      const M = new Matrix4().copy(app.graph.get(to.id)?.world ?? new Matrix4()).invert().multiply(app.graph.get(from.id)?.world ?? new Matrix4());
      const v = new Vector3();
      for (let k = 0; k < ed.co.length; k += 3) v.fromArray(ed.co, k).applyMatrix4(M).toArray(ed.co, k);
    }
    ps.edited_hair = ed;
  }
  to.particle_systems.push(ps);
  const m = newModifier('PARTICLE_SYSTEM', uid('md'), to.modifiers);
  m.name = ps.name;
  m.particle_system = ps.id;
  to.modifiers.push(m);
  void doc;
  return ps;
}

function removeSystem(doc: DocumentData, ob: ObjectPhysics, ps: ParticleSystemX) {
  const m = modOf(ob, ps);
  if (m) {
    ob.modifiers = ob.modifiers.filter((x) => x !== m);
    freeCache(particleCacheKey(ob, m));
  }
  ob.particle_systems = ob.particle_systems.filter((p) => p !== ps);
  const s = doc.particles[ps.settings];
  if (s && !Object.values(doc.objects).some((o) => o.particle_systems.some((p) => p.settings === s.id))) delete doc.particles[s.id];
}

// ---------------------------------------------------------------------------
// boid brain helpers

function boidsOf(): BoidSettings | null {
  const a = activeSystem();
  if (!a?.s || a.s.physics_type !== 'BOIDS') return null;
  const b = (a.s.boids ??= defaultBoidSettings());
  ensureBoidStates(b);
  return b;
}

const boidPoll = () => !!boidsOf();

function activeState(b: BoidSettings) {
  const states = ensureBoidStates(b);
  const i = Math.min(Math.max(0, b.active_boid_state_index ?? 0), states.length - 1);
  return { states, i, st: states[i] };
}

function move<T>(arr: T[], i: number, d: number): T[] | null {
  const j = i + d;
  if (i < 0 || j < 0 || i >= arr.length || j >= arr.length) return null;
  const out = arr.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// ---------------------------------------------------------------------------
// targets

function targetsOf(): { ps: ParticleSystemX; ts: KeyedTarget[] } | null {
  const a = activeSystem();
  if (!a) return null;
  // older files kept keyed targets on the settings: move them to the system
  if (!a.ps.targets) a.ps.targets = (a.s?.keyed_targets ?? []).map((t) => ({ ...t }));
  return { ps: a.ps, ts: a.ps.targets };
}

const RULE_ITEMS = BOID_RULES.map(([v, l]) => [v, l] as [string, string]);

registerOperators([
  // --- systems
  {
    idname: 'particle.copy_particle_systems',
    label: 'Copy Particle Systems',
    description: 'Copy particle systems from the active object to the selected objects',
    props: [
      { id: 'space', label: 'Space', type: 'enum', default: 'OBJECT', items: [['OBJECT', 'Object'], ['WORLD', 'World']] },
      { id: 'remove_target_particles', label: 'Remove Target Particles', type: 'bool', default: true },
      { id: 'use_active', label: 'Use Active', type: 'bool', default: false },
    ],
    poll: () => !!active()?.particle_systems.length && app.selectedObjects().some((o) => o !== active() && o.type === 'MESH'),
    exec: (ctx, p) => {
      const src = active()!;
      const a = activeSystem()!;
      const list = (p.use_active ? [a.ps] : (src.particle_systems as ParticleSystemX[])).slice();
      let n = 0;
      for (const ob of app.selectedObjects() as ObjectPhysics[]) {
        if (ob === src || ob.type !== 'MESH') continue;
        if (p.remove_target_particles) for (const ps of (ob.particle_systems as ParticleSystemX[]).slice()) removeSystem(ctx.doc, ob, ps);
        for (const ps of list) addSystemCopy(ctx.doc, src, ps, ob, ps.settings, p.space as 'OBJECT' | 'WORLD');
        ob.active_particle_system_index = ob.particle_systems.length - 1;
        n++;
      }
      app.report('INFO', `Copied ${list.length} particle system${list.length === 1 ? '' : 's'} to ${n} object${n === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'particle.duplicate_particle_system',
    label: 'Duplicate Particle System',
    description: 'Duplicate the active particle system on its object',
    props: [{ id: 'use_duplicate_settings', label: 'Duplicate Settings', type: 'bool', default: false }],
    poll: () => !!activeSystem(),
    exec: (ctx, p) => {
      const a = activeSystem()!;
      let sid = a.ps.settings;
      if (p.use_duplicate_settings && a.s) {
        const copy = { ...structuredClone(a.s), id: uid('pa'), name: uniqueSettingsName(ctx.doc, a.s.name) };
        ctx.doc.particles[copy.id] = copy;
        sid = copy.id;
      }
      addSystemCopy(ctx.doc, a.ob, a.ps, a.ob, sid, 'OBJECT');
      a.ob.active_particle_system_index = a.ob.particle_systems.length - 1;
    },
  },
  {
    idname: 'particle.particle_system_remove_all',
    label: 'Remove All Particle Systems',
    description: 'Remove all particle systems of the active object',
    poll: () => !!active()?.particle_systems.length,
    exec: (ctx) => {
      const ob = active()!;
      for (const ps of (ob.particle_systems as ParticleSystemX[]).slice()) removeSystem(ctx.doc, ob, ps);
      ob.active_particle_system_index = 0;
    },
  },
  // --- boid rules
  {
    idname: 'boid.rule_add',
    label: 'Add Boid Rule',
    description: 'Add a rule to the active boid state',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'GOAL', items: RULE_ITEMS }],
    poll: boidPoll,
    exec: (_c, p) => {
      const { st } = activeState(boidsOf()!);
      st.rules = [...st.rules, newBoidRule(p.type as BoidRuleType)];
      st.active_boid_rule_index = st.rules.length - 1;
    },
  },
  {
    idname: 'boid.rule_del',
    label: 'Remove Boid Rule',
    description: 'Remove the active rule of the active boid state',
    poll: () => !!boidsOf() && activeState(boidsOf()!).st.rules.length > 0,
    exec: () => {
      const { st } = activeState(boidsOf()!);
      const i = Math.min(st.active_boid_rule_index, st.rules.length - 1);
      st.rules = st.rules.filter((_, k) => k !== i);
      st.active_boid_rule_index = Math.max(0, i - 1);
    },
  },
  ...(['up', 'down'] as const).map((dir) => ({
    idname: `boid.rule_move_${dir}`,
    label: `Move Boid Rule ${dir === 'up' ? 'Up' : 'Down'}`,
    description: `Move the active boid rule ${dir} in the list`,
    poll: boidPoll,
    exec: () => {
      const { st } = activeState(boidsOf()!);
      const r = move(st.rules, st.active_boid_rule_index, dir === 'up' ? -1 : 1);
      if (!r) return 'CANCELLED' as const;
      st.rules = r;
      st.active_boid_rule_index += dir === 'up' ? -1 : 1;
    },
  })),
  // --- boid states
  {
    idname: 'boid.state_add',
    label: 'Add Boid State',
    description: 'Add a boid state (a set of rules)',
    poll: boidPoll,
    exec: () => {
      const b = boidsOf()!;
      const states = ensureBoidStates(b);
      const names = new Set(states.map((s) => s.name));
      let name = 'State';
      for (let i = 1; names.has(name); i++) name = `State.${String(i).padStart(3, '0')}`;
      b.states = [...states, newBoidState(name)];
      b.active_boid_state_index = b.states.length - 1;
    },
  },
  {
    idname: 'boid.state_del',
    label: 'Delete Boid State',
    description: 'Delete the active boid state',
    poll: () => !!boidsOf() && ensureBoidStates(boidsOf()!).length > 1,
    exec: () => {
      const b = boidsOf()!;
      const { states, i } = activeState(b);
      b.states = states.filter((_, k) => k !== i);
      b.active_boid_state_index = Math.max(0, i - 1);
    },
  },
  ...(['up', 'down'] as const).map((dir) => ({
    idname: `boid.state_move_${dir}`,
    label: `Move Boid State ${dir === 'up' ? 'Up' : 'Down'}`,
    description: `Move the active boid state ${dir} in the list`,
    poll: boidPoll,
    exec: () => {
      const b = boidsOf()!;
      const { states, i } = activeState(b);
      const r = move(states, i, dir === 'up' ? -1 : 1);
      if (!r) return 'CANCELLED' as const;
      b.states = r;
      b.active_boid_state_index = i + (dir === 'up' ? -1 : 1);
    },
  })),
  // --- targets
  {
    idname: 'particle.new_target',
    label: 'New Particle Target',
    description: 'Add a target particle system (keyed path or boid relation)',
    poll: () => !!activeSystem(),
    exec: () => {
      const t = targetsOf()!;
      t.ps.targets = [...t.ts, { object: null, system: 1, time: 0, duration: 0, alliance: 'NEUTRAL' }];
      t.ps.active_particle_target_index = t.ps.targets.length - 1;
    },
  },
  {
    idname: 'particle.target_remove',
    label: 'Remove Target Particles',
    description: 'Remove the active target',
    poll: () => !!activeSystem() && (targetsOf()?.ts.length ?? 0) > 0,
    exec: () => {
      const t = targetsOf()!;
      const i = Math.min(t.ps.active_particle_target_index ?? 0, t.ts.length - 1);
      t.ps.targets = t.ts.filter((_, k) => k !== i);
      t.ps.active_particle_target_index = Math.max(0, i - 1);
    },
  },
  ...(['up', 'down'] as const).map((dir) => ({
    idname: `particle.target_move_${dir}`,
    label: `Move Particle Target ${dir === 'up' ? 'Up' : 'Down'}`,
    description: `Move the active target ${dir} in the list`,
    poll: () => !!activeSystem(),
    exec: () => {
      const t = targetsOf()!;
      const i = t.ps.active_particle_target_index ?? 0;
      const r = move(t.ts, i, dir === 'up' ? -1 : 1);
      if (!r) return 'CANCELLED' as const;
      t.ps.targets = r;
      t.ps.active_particle_target_index = i + (dir === 'up' ? -1 : 1);
    },
  })),
  // --- instance weights (render as collection, use count)
  {
    idname: 'particle.dupliob_refresh',
    label: 'Refresh Instance Objects',
    description: 'Refresh the list of objects and their counts from the instance collection',
    poll: () => !!activeSystem()?.s?.instance_collection,
    exec: (ctx) => refreshWeights(ctx, true),
  },
  {
    idname: 'particle.dupliob_copy',
    label: 'Copy Particle Instance Object',
    description: 'Duplicate the current instance object entry',
    poll: () => !!activeSystem()?.s?.instance_weights?.length,
    exec: () => {
      const s = activeSystem()!.s!;
      const w = s.instance_weights!;
      const i = Math.min(s.active_instanceweight_index ?? 0, w.length - 1);
      s.instance_weights = [...w.slice(0, i + 1), { ...w[i] }, ...w.slice(i + 1)];
      s.active_instanceweight_index = i + 1;
    },
  },
  {
    idname: 'particle.dupliob_remove',
    label: 'Remove Particle Instance Object',
    description: 'Remove the selected instance object entry',
    poll: () => !!activeSystem()?.s?.instance_weights?.length,
    exec: () => {
      const s = activeSystem()!.s!;
      const w = s.instance_weights!;
      const i = Math.min(s.active_instanceweight_index ?? 0, w.length - 1);
      s.instance_weights = w.filter((_, k) => k !== i);
      s.active_instanceweight_index = Math.max(0, i - 1);
    },
  },
  ...(['up', 'down'] as const).map((dir) => ({
    idname: `particle.dupliob_move_${dir}`,
    label: `Move Instance Object ${dir === 'up' ? 'Up' : 'Down'}`,
    description: `Move the instance object entry ${dir} in the list`,
    poll: () => !!activeSystem()?.s?.instance_weights?.length,
    exec: () => {
      const s = activeSystem()!.s!;
      const i = s.active_instanceweight_index ?? 0;
      const r = move(s.instance_weights!, i, dir === 'up' ? -1 : 1);
      if (!r) return 'CANCELLED' as const;
      s.instance_weights = r;
      s.active_instanceweight_index = i + (dir === 'up' ? -1 : 1);
    },
  })),
  // --- hair connection
  {
    idname: 'particle.disconnect_hair',
    label: 'Disconnect Hair',
    description: 'Disconnect the hair from the emitter mesh: it stays in place when the mesh changes',
    props: [{ id: 'all', label: 'All Hair', type: 'bool', default: false }],
    poll: () => hairSystems(false).length > 0,
    exec: (_c, p) => {
      let n = 0;
      for (const { ob, ps, s } of hairSystems(!!p.all)) {
        if (!ps.edited_hair) {
          const ed = editedFromGenerated(ob, ps, s);
          if (!ed) continue;
          ps.edited_hair = ed;
        }
        ps.hair_binding = null;
        ps.hair_disconnected = true;
        n++;
      }
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'particle.connect_hair',
    label: 'Connect Hair',
    description: 'Connect the hair to the emitter mesh: roots move onto the surface and follow it',
    props: [{ id: 'all', label: 'All Hair', type: 'bool', default: false }],
    poll: () => hairSystems(false).length > 0,
    exec: (_c, p) => {
      let n = 0;
      for (const { ob, ps, s } of hairSystems(!!p.all)) {
        const mesh = app.graph.get(ob.id)?.mesh;
        if (!mesh || !mesh.indices.length) continue;
        if (!ps.edited_hair) {
          const ed = editedFromGenerated(ob, ps, s);
          if (!ed) continue;
          ps.edited_hair = ed;
        }
        const r = bindHairRoots(ps.edited_hair, mesh);
        ps.edited_hair = r.ed;
        ps.hair_binding = r.binding as HairBinding;
        ps.hair_disconnected = false;
        n++;
      }
      if (!n) {
        app.report('ERROR', 'The emitter has no faces to connect the hair to');
        return 'CANCELLED';
      }
    },
  },
]);

/** Hair systems the hair operators act on (the active one, or all of the active object). */
function hairSystems(all: boolean): { ob: ObjectPhysics; ps: ParticleSystemX; s: ParticleSettingsX }[] {
  const ob = active();
  if (!ob || ob.type !== 'MESH') return [];
  const a = activeSystem();
  const list = all ? (ob.particle_systems as ParticleSystemX[]) : a ? [a.ps] : [];
  return list.map((ps) => ({ ob, ps, s: app.doc.particles[ps.settings] as ParticleSettingsX })).filter((x) => x.s?.type === 'HAIR');
}

/** Edited keys from the generated hair (set by the Particle Edit module to avoid an import cycle). */
export const hairEditing: { fromGenerated: ((ob: ObjectData, ps: ParticleSystemX, s: ParticleSettingsX) => EditedHair | null) | null } = { fromGenerated: null };
const editedFromGenerated = (ob: ObjectData, ps: ParticleSystemX, s: ParticleSettingsX) => hairEditing.fromGenerated?.(ob, ps, s) ?? null;

function refreshWeights(ctx: OpContext, keepCounts: boolean) {
  const s = activeSystem()?.s;
  if (!s?.instance_collection) return 'CANCELLED' as const;
  const objs: ObjectData[] = [];
  const visit = (cid: string, d: number) => {
    const c = ctx.doc.collections[cid];
    if (!c || d > 16) return;
    for (const id of c.objects) if (ctx.doc.objects[id]) objs.push(ctx.doc.objects[id]);
    for (const ch of c.children) visit(ch, d + 1);
  };
  visit(s.instance_collection, 0);
  const old = new Map((s.instance_weights ?? []).map((w) => [w.object, w.count]));
  s.instance_weights = objs.sort((a, b) => a.name.localeCompare(b.name)).map((o) => ({ object: o.id, name: o.name, count: keepCounts ? (old.get(o.id) ?? 1) : 1 }));
  s.active_instanceweight_index = Math.min(s.active_instanceweight_index ?? 0, Math.max(0, s.instance_weights.length - 1));
  return 'FINISHED' as const;
}
