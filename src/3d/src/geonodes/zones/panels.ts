// Bake controls of simulation zones and Bake nodes: the modifier panel's Bake section, the
// Physics tab's Simulation Nodes panel, the node editor sidebar and cached frames on the timeline.
import { h, type Child } from '../../ui/h';
import { app, onAppReady } from '../../app/app';
import type { ModifierBase, ObjectData } from '../../data/types';
import { modifierExtraUI } from '../../editors/properties/stack';
import { propertiesTabs } from '../../editors/properties/properties';
import { timelineCacheProviders } from '../../editors/timeline';
import { getNodeType } from '../../nodes/registry';
import type { NodeDrawContext } from '../../nodes/types';
import { opButton, panel } from '../../ui/widgets';
import { bakeTargets, isBaked, targetFrames, type BakeTarget } from './bakeops';
import { BAKE, SIM_INPUT, SIM_OUTPUT } from './kinds';
import { bakeMode } from './bake';
import { pairedOutput } from './items';
import { activeNodesModifier } from '../editor';

function ranges(frames: number[]): string {
  if (!frames.length) return '';
  const out: string[] = [];
  let a = frames[0];
  for (let i = 1; i <= frames.length; i++) {
    if (frames[i] === frames[i - 1] + 1) continue;
    out.push(a === frames[i - 1] ? `${a}` : `${a}–${frames[i - 1]}`);
    a = frames[i];
  }
  return out.join(', ');
}

function status(ob: ObjectData, m: ModifierBase, t: BakeTarget): string {
  const frames = targetFrames(ob, m, t);
  if (isBaked(ob, m, t)) return t.kind === 'BAKE' && bakeMode(t.node) === 'STILL' ? `Baked frame ${frames[0] ?? ''}` : `Baked frames ${ranges(frames)}`;
  if (t.kind === 'SIMULATION') return frames.length ? `Cached frames ${ranges(frames)}` : 'Not cached yet: play from the start frame';
  return 'Not baked';
}

function targetRow(ob: ObjectData, m: ModifierBase, t: BakeTarget): Child {
  const baked = isBaked(ob, m, t);
  const props = { modifier_name: m.name, bake_id: t.node.id };
  return h(
    'div',
    { key: t.node.id, class: 'gn-bake-row' },
    h('div', { class: 'gn-bake-name' }, t.label, h('span', { class: 'gn-bake-status' }, ` — ${status(ob, m, t)}`)),
    h(
      'div',
      { class: 'row-aligned' },
      opButton('object.geometry_node_bake_single', baked ? 'Bake Again' : 'Bake', props, { tip: 'Bake this over the scene frame range (a still Bake node bakes the current frame)' }),
      opButton('object.geometry_node_bake_delete_single', baked ? 'Delete Bake' : 'Free Cache', props),
    ),
  );
}

/** Bake section of a Geometry Nodes modifier (only when its tree has something to bake). */
export function bakeSection(ob: ObjectData, m: ModifierBase): Child {
  const targets = bakeTargets(app.doc, m);
  if (!targets.length) return null;
  return panel(`gnmod-${m.id}-bake`, 'Bake', () => targets.map((t) => targetRow(ob, m, t)), { sub: true });
}

/** Physics tab: bake every simulation of the active object at once. */
function simulationNodesPanel(): Child {
  const ob = app.activeObject;
  if (!ob) return null;
  const mods = ob.modifiers.filter((m) => m.type === 'NODES' && bakeTargets(app.doc, m).some((t) => t.kind === 'SIMULATION'));
  if (!mods.length) return null;
  return panel('ph-simnodes', 'Simulation Nodes', () => [
    h(
      'div',
      { class: 'row-aligned' },
      opButton('object.simulation_nodes_cache_bake', 'Bake', { selected: true }, { tip: 'Bake the simulations of the selected objects over the scene frame range' }),
      opButton('object.simulation_nodes_cache_delete', 'Delete Bake', { selected: true }),
    ),
    opButton('object.simulation_nodes_cache_calculate_to_frame', 'Calculate to Frame', { selected: true }),
    ...mods.flatMap((m) =>
      bakeTargets(app.doc, m)
        .filter((t) => t.kind === 'SIMULATION')
        .map((t) => h('div', { key: `${m.id}:${t.node.id}`, class: 'prop-note' }, `${m.name} ▸ ${t.label}: ${status(ob, m, t)}`)),
    ),
  ]);
}

/** Node editor sidebar: bake controls of the selected simulation zone or Bake node. */
function nodeBakePanel(ctx: NodeDrawContext): Child {
  const ob = app.activeObject;
  const m = activeNodesModifier(ob);
  if (!ob || !m) return null;
  const node = ctx.node.type === SIM_INPUT ? pairedOutput(ctx.tree, ctx.node) : ctx.node;
  const t = node && bakeTargets(app.doc, m).find((x) => x.node.id === node.id);
  if (!t) return null;
  return h('div', { class: 'gn-node-bake' }, h('div', { class: 'sub-label' }, 'Bake'), targetRow(ob, m, t));
}

for (const id of [SIM_INPUT, SIM_OUTPUT, BAKE]) {
  const d = getNodeType(id);
  if (!d) continue;
  const prev = d.drawOptions;
  d.drawOptions = (ctx) => h('div', {}, prev?.(ctx) ?? null, nodeBakePanel(ctx));
}

onAppReady(() => {
  const prev = modifierExtraUI.NODES;
  modifierExtraUI.NODES = (ob, m) => [prev?.(ob, m) ?? null, bakeSection(ob, m)];
  const tab = propertiesTabs.find((t) => t.id === 'PHYSICS');
  if (tab) {
    const draw = tab.draw;
    tab.draw = (p) => [draw(p), simulationNodesPanel()];
  }
  timelineCacheProviders.push(() => {
    const ob = app.activeObject;
    if (!ob) return [];
    return ob.modifiers
      .filter((m) => m.type === 'NODES')
      .flatMap((m) => bakeTargets(app.doc, m).map((t) => ({ frames: targetFrames(ob, m, t), baked: isBaked(ob, m, t), color: t.kind === 'SIMULATION' ? '#d9a24a' : '#5aa9d6' })));
  });
});
