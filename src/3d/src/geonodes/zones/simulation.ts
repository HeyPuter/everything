// Simulation zone: a state that carries over from frame to frame. The zone body computes the next
// state from the previous one; results are cached per frame (and can be baked for a frame range).
//
// Frame rules: a cached frame is shown as is; otherwise the state steps from the previous frame
// (or, when frames were skipped, from the last evaluated earlier frame) with a delta time of one
// frame; with no earlier state the simulation starts over from the zone input's values with a
// delta time of zero.
import type { NodeData } from '../../data/types';
import { geoNode, sock } from '../nodes/gndef';
import type { EvalEnv, Val } from '../exec';
import { TreeEval, coerce, type EvalLog } from '../evaluator';
import { extendSocket, itemSocket, pairedInput, pairedOutput, readItems } from './items';
import { SIM_INPUT, SIM_OUTPUT } from './kinds';
import { ZoneEval, inputOf, single, zoneBody } from './eval';
import { addPairedOutput, initItems } from './repeat';
import { persistState } from './state';
import { bakeState } from './bake';

const KEY = 'state_items';
const itemId = (it: { id: number }) => `Item_${it.id}`;

export interface SimFrame {
  state: Val[];
  /** computed before the last change of the node tree or its inputs */
  outdated: boolean;
}

export interface SimCache {
  sig: string;
  frames: Map<number, SimFrame>;
  /** last evaluated frame */
  last: number | null;
  baked: boolean;
  /** owner object / modifier (for panels and the timeline) */
  objectId: string;
  modifierId: string;
  touched: number;
}

/** Simulation caches by evaluation path (`object/modifier/…/node`). */
export const simCaches = new Map<string, SimCache>();
let clock = 0;

export function simCache(path: string): SimCache {
  let c = simCaches.get(path);
  if (!c) {
    const [objectId = '', modifierId = ''] = path.split('/');
    simCaches.set(
      path,
      (c = {
        sig: '',
        frames: new Map(),
        last: null,
        baked: false,
        objectId,
        modifierId,
        touched: 0,
      }),
    );
  }
  c.touched = ++clock;
  return c;
}

/** Caches belonging to one Geometry Nodes modifier. */
export function modifierSimCaches(objectId: string, modifierId: string): SimCache[] {
  return [...simCaches.values()].filter((c) => c.objectId === objectId && c.modifierId === modifierId);
}

export function freeSimCaches(objectId: string, modifierId?: string) {
  for (const [k, c] of simCaches) if (c.objectId === objectId && (!modifierId || c.modifierId === modifierId)) simCaches.delete(k);
}

/** Signature of the zone and everything feeding it, independent of the current frame. */
function staticSig(ev: TreeEval, node: NodeData): string {
  const env: EvalEnv = { ...ev.env, frame: 0 };
  const log: EvalLog = { warnings: new Map(), executed: 0, generation: 0 };
  return new TreeEval(env, ev.tree, ev.path, ev.groupInput, ev.groupInputSig, new Map(), log, ev.depth).signature(node);
}

geoNode(
  {
    idname: SIM_INPUT,
    label: 'Simulation Input',
    category: 'converter',
    description: 'Start of a simulation zone: the state of the previous frame and the time step since it',
    outputs: [sock('Delta Time', 'FLOAT')],
    dynamicSockets: (node, ctx) => {
      const items = readItems(pairedOutput(ctx.tree, node), KEY);
      return {
        inputs: [...items.map((it) => itemSocket(it, itemId(it))), extendSocket()],
        outputs: [sock('Delta Time', 'FLOAT'), ...items.map((it) => itemSocket(it, itemId(it))), extendSocket()],
      };
    },
    onAdd: (tree, n) =>
      addPairedOutput(tree, n, SIM_OUTPUT, (out) => {
        const g = readItems(out, KEY).find((i) => i.socket_type === 'GEOMETRY');
        return g ? [itemId(g), itemId(g)] : null;
      }),
  },
  {
    exec: (ctx) => {
      const out: Record<string, Val> = { 'Delta Time': 0 };
      for (const it of readItems(pairedOutput(ctx.tree, ctx.node), KEY)) out[itemId(it)] = ctx.input(itemId(it));
      return out;
    },
  },
);

geoNode(
  {
    idname: SIM_OUTPUT,
    label: 'Simulation Output',
    category: 'converter',
    hidden: true,
    description: 'End of a simulation zone: the new state, kept for the next frame',
    inputs: [sock('Skip', 'BOOLEAN', { d: false, hide_value: true })],
    init: (n) => initItems(n, KEY),
    dynamicSockets: (node) => {
      const items = readItems(node, KEY);
      return {
        inputs: [sock('Skip', 'BOOLEAN', { d: false, hide_value: true }), ...items.map((it) => itemSocket(it, itemId(it))), extendSocket()],
        outputs: [...items.map((it) => itemSocket(it, itemId(it))), extendSocket()],
      };
    },
  },
  {
    timeDependent: true,
    sig: (_node, env) => `f${Math.round(env.frame)}:${bakeState.version}`,
    exec: (ctx) => {
      const ev = ctx.evaluator;
      const node = ctx.node;
      const items = readItems(node, KEY);
      const inp = pairedInput(ctx.tree, node, SIM_INPUT);
      const outputs = (state: Val[]) => {
        const r: Record<string, Val> = {};
        items.forEach((it, k) => (r[itemId(it)] = state[k] ?? coerce(undefined, it.socket_type)));
        return r;
      };
      if (!inp) {
        ctx.warn('The simulation output has no paired simulation input');
        return outputs(items.map((it) => ctx.input(itemId(it))));
      }
      const frame = Math.round(ctx.env.frame);
      const cache = simCache(ctx.path);
      if (cache.baked) {
        let best: SimFrame | undefined = cache.frames.get(frame);
        if (!best) {
          // outside the baked range: hold the nearest baked frame
          let bf = Infinity;
          for (const f of cache.frames.keys()) if (Math.abs(f - frame) < Math.abs(bf - frame)) bf = f;
          best = cache.frames.get(bf);
        }
        return outputs(best?.state ?? []);
      }
      const sig = staticSig(ev, node);
      if (cache.sig !== sig) {
        for (const f of cache.frames.values()) f.outdated = true;
        cache.sig = sig;
      }
      const hit = cache.frames.get(frame);
      if (hit && !hit.outdated) {
        cache.last = frame;
        return outputs(hit.state);
      }
      let prev = cache.frames.get(frame - 1)?.state;
      if (!prev && cache.last !== null && cache.last < frame) prev = cache.frames.get(cache.last)?.state;
      let dt = 1 / (ctx.env.fps || 24);
      if (!prev) {
        cache.frames.clear();
        prev = persistState(
          items,
          items.map((it) => inputOf(ev, inp, itemId(it)) ?? coerce(undefined, it.socket_type)),
          `sim:${ctx.path}`,
        );
        dt = 0;
      }
      const ins: Record<string, Val> = { 'Delta Time': dt };
      items.forEach((it, k) => (ins[itemId(it)] = prev![k]));
      const z = new ZoneEval(ev, zoneBody(ctx.tree, inp.id, node.id), inp.id, ins);
      let next: Val[];
      if (single(z.outputInput(node, 'Skip')) === true) next = prev;
      else
        next = persistState(
          items,
          items.map((it) => z.outputInput(node, itemId(it))),
          `sim:${ctx.path}`,
        );
      cache.frames.set(frame, { state: next, outdated: false });
      cache.last = frame;
      return outputs(next);
    },
  },
);
