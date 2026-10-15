// Baking simulation zones and Bake nodes of Geometry Nodes modifiers: frame-by-frame evaluation of
// the scene range, then the results are kept (and shown) regardless of later changes until freed.
import { app, registerOperators } from '../../app/app';
import type { DocumentData, ModifierBase, NodeData, ObjectData } from '../../data/types';
import { groupTrees, nodeGroupOf } from '../modifier';
import { BAKE, SIM_OUTPUT } from './kinds';
import { bakeMode, bakeState, bakes, freeBakes, recording } from './bake';
import { simCaches, type SimCache } from './simulation';

export interface BakeTarget {
  kind: 'SIMULATION' | 'BAKE';
  node: NodeData;
  label: string;
}

/** Simulation zones and Bake nodes used by a modifier's node group (nested groups included). */
export function bakeTargets(doc: DocumentData, m: ModifierBase): BakeTarget[] {
  const g = nodeGroupOf(doc, m);
  if (!g) return [];
  const out: BakeTarget[] = [];
  for (const t of groupTrees(doc, g.tree))
    for (const n of t.nodes) {
      if (n.mute) continue;
      if (n.type === SIM_OUTPUT)
        out.push({
          kind: 'SIMULATION',
          node: n,
          label: n.label || 'Simulation',
        });
      else if (n.type === BAKE) out.push({ kind: 'BAKE', node: n, label: n.label || n.name || 'Bake' });
    }
  return out;
}

const nodeOfPath = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export function simCachesOf(ob: ObjectData, m: ModifierBase, nodeId?: string): SimCache[] {
  return [...simCaches.entries()].filter(([p, c]) => c.objectId === ob.id && c.modifierId === m.id && (!nodeId || nodeOfPath(p) === nodeId)).map(([, c]) => c);
}

export function isBaked(ob: ObjectData, m: ModifierBase, t: BakeTarget): boolean {
  if (t.kind === 'SIMULATION') return simCachesOf(ob, m, t.node.id).some((c) => c.baked);
  for (const b of bakes.values()) if (b.objectId === ob.id && b.modifierId === m.id && b.nodeId === t.node.id) return true;
  return false;
}

/** Cached / baked frame numbers of a target (for the panel and the timeline). */
export function targetFrames(ob: ObjectData, m: ModifierBase, t: BakeTarget): number[] {
  const out = new Set<number>();
  if (t.kind === 'SIMULATION') for (const c of simCachesOf(ob, m, t.node.id)) for (const [f, s] of c.frames) if (!s.outdated || c.baked) out.add(f);
  for (const b of bakes.values()) if (b.objectId === ob.id && b.modifierId === m.id && b.nodeId === t.node.id) for (const f of b.frames.keys()) out.add(f);
  return [...out].sort((a, b) => a - b);
}

function freeTarget(ob: ObjectData, m: ModifierBase, t: BakeTarget) {
  if (t.kind === 'SIMULATION') {
    for (const [p, c] of [...simCaches]) if (c.objectId === ob.id && c.modifierId === m.id && nodeOfPath(p) === t.node.id) simCaches.delete(p);
  } else freeBakes(ob.id, m.id, t.node.id);
  bakeState.version++;
  app.graph?.invalidate(ob.id);
}

/** Bake targets of a modifier over the scene frame range (a still Bake node bakes the current frame). */
export function bakeModifier(doc: DocumentData, ob: ObjectData, m: ModifierBase, targets: BakeTarget[]): number {
  if (!targets.length) return 0;
  const scene = doc.scene;
  const cur = scene.frame_current,
    sub = scene.frame_subframe;
  for (const t of targets) freeTarget(ob, m, t);
  const anim = targets.some((t) => t.kind === 'SIMULATION' || bakeMode(t.node) === 'ANIMATION');
  const start = anim ? scene.frame_start : cur,
    end = anim ? scene.frame_end : cur;
  for (const t of targets) if (t.kind === 'BAKE') recording.add(`${ob.id}/${m.id}/${t.node.id}`);
  bakeState.recording = true;
  bakeState.version++;
  try {
    for (let f = start; f <= end; f++) {
      scene.frame_current = f;
      scene.frame_subframe = 0;
      app.graph.invalidate(ob.id);
      app.graph.evaluate(doc);
    }
  } finally {
    recording.clear();
    bakeState.recording = false;
    scene.frame_current = cur;
    scene.frame_subframe = sub;
  }
  // still bakes keep only the current frame
  for (const t of targets)
    if (t.kind === 'BAKE' && bakeMode(t.node) === 'STILL')
      for (const b of bakes.values())
        if (b.objectId === ob.id && b.modifierId === m.id && b.nodeId === t.node.id) {
          const keep = b.frames.get(cur) ?? b.frames.values().next().value;
          b.frames = new Map(keep ? [[cur, keep]] : []);
          b.mode = 'STILL';
        }
  for (const t of targets) if (t.kind === 'SIMULATION') for (const c of simCachesOf(ob, m, t.node.id)) c.baked = true;
  bakeState.version++;
  app.graph.invalidate(ob.id);
  app.graph.evaluate(doc);
  return end - start + 1;
}

/** Step simulations from the start frame up to the current frame. */
function calculateToFrame(doc: DocumentData, ob: ObjectData, m: ModifierBase) {
  const scene = doc.scene;
  const cur = scene.frame_current;
  try {
    for (let f = scene.frame_start; f <= cur; f++) {
      scene.frame_current = f;
      app.graph.evaluate(doc);
    }
  } finally {
    scene.frame_current = cur;
  }
}

const objectsFor = (selected: boolean): ObjectData[] => (selected ? app.selectedObjects() : app.activeObject ? [app.activeObject] : []);
const nodesMods = (ob: ObjectData) => ob.modifiers.filter((m) => m.type === 'NODES');

function findModifier(name: string): { ob: ObjectData; m: ModifierBase } | null {
  const ob = app.activeObject;
  const m = ob?.modifiers.find((x) => x.type === 'NODES' && x.name === name);
  return ob && m ? { ob, m } : null;
}

const target = (doc: DocumentData, m: ModifierBase, nodeId: string) => bakeTargets(doc, m).find((t) => t.node.id === nodeId);

registerOperators([
  {
    idname: 'object.simulation_nodes_cache_bake',
    label: 'Bake Simulation',
    description: 'Bake the simulations and Bake nodes of Geometry Nodes modifiers over the scene frame range',
    props: [{ id: 'selected', label: 'Selected', type: 'bool', default: false }],
    redo: false,
    poll: () => !!app.activeObject,
    exec: (ctx, p) => {
      let frames = 0;
      for (const ob of objectsFor(!!p.selected)) for (const m of nodesMods(ob)) frames = Math.max(frames, bakeModifier(ctx.doc, ob, m, bakeTargets(ctx.doc, m)));
      if (!frames) {
        app.report('WARNING', 'Nothing to bake: no simulation zones or Bake nodes');
        return 'CANCELLED';
      }
      app.report('INFO', `Baked ${frames} frames`);
      app.changed('frame');
    },
  },
  {
    idname: 'object.simulation_nodes_cache_delete',
    label: 'Delete Cached Simulation',
    description: 'Delete the cached and baked simulation data of Geometry Nodes modifiers',
    props: [{ id: 'selected', label: 'Selected', type: 'bool', default: false }],
    redo: false,
    poll: () => !!app.activeObject,
    exec: (ctx, p) => {
      for (const ob of objectsFor(!!p.selected)) for (const m of nodesMods(ob)) for (const t of bakeTargets(ctx.doc, m)) freeTarget(ob, m, t);
      app.changed('frame');
    },
  },
  {
    idname: 'object.simulation_nodes_cache_calculate_to_frame',
    label: 'Calculate to Frame',
    description: 'Compute the simulations from the start frame up to the current frame',
    props: [{ id: 'selected', label: 'Selected', type: 'bool', default: false }],
    redo: false,
    poll: () => !!app.activeObject,
    exec: (ctx, p) => {
      for (const ob of objectsFor(!!p.selected)) for (const m of nodesMods(ob)) calculateToFrame(ctx.doc, ob, m);
      app.changed('frame');
    },
  },
  {
    idname: 'object.geometry_node_bake_single',
    label: 'Bake Geometry Node',
    description: 'Bake one simulation zone or Bake node of the active object’s modifier',
    props: [
      { id: 'modifier_name', type: 'string', default: '', hidden: true },
      { id: 'bake_id', type: 'string', default: '', hidden: true },
    ],
    redo: false,
    poll: () => !!app.activeObject,
    exec: (ctx, p) => {
      const r = findModifier(String(p.modifier_name));
      const t = r && target(ctx.doc, r.m, String(p.bake_id));
      if (!r || !t) return 'CANCELLED';
      const n = bakeModifier(ctx.doc, r.ob, r.m, [t]);
      app.report('INFO', `Baked ${t.label}: ${n} frame${n === 1 ? '' : 's'}`);
      app.changed('frame');
    },
  },
  {
    idname: 'object.geometry_node_bake_delete_single',
    label: 'Delete Single Bake',
    description: 'Delete the baked data of one simulation zone or Bake node',
    props: [
      { id: 'modifier_name', type: 'string', default: '', hidden: true },
      { id: 'bake_id', type: 'string', default: '', hidden: true },
    ],
    redo: false,
    poll: () => !!app.activeObject,
    exec: (ctx, p) => {
      const r = findModifier(String(p.modifier_name));
      const t = r && target(ctx.doc, r.m, String(p.bake_id));
      if (!r || !t) return 'CANCELLED';
      freeTarget(r.ob, r.m, t);
      app.changed('frame');
    },
  },
]);

export { freeTarget };
