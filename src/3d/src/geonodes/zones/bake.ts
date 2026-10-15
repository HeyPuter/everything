// Bake node: passes its items through until baked; then outputs the stored values (one frame
// for a still bake, every frame of the range for an animation bake), ignoring its inputs.
import type { NodeData } from '../../data/types';
import { geoNode, enumProp } from '../nodes/gndef';
import type { Val } from '../exec';
import { coerce } from '../evaluator';
import { extendSocket, itemSocket, nextItemId, readItems, writeItems } from './items';
import { BAKE } from './kinds';
import { persistState } from './state';

const KEY = 'bake_items';
const itemId = (it: { id: number }) => `Item_${it.id}`;

export interface BakeData {
  mode: 'ANIMATION' | 'STILL';
  frames: Map<number, Val[]>;
  objectId: string;
  modifierId: string;
  nodeId: string;
}

/** Baked node data by evaluation path. */
export const bakes = new Map<string, BakeData>();
/** Bakes being recorded ("object/modifier/node", or "object/modifier/*" for all of a modifier). */
export const recording = new Set<string>();

function isRecording(path: string, nodeId: string): boolean {
  if (!recording.size) return false;
  const [o = '', m = ''] = path.split('/');
  return recording.has(`${o}/${m}/${nodeId}`) || recording.has(`${o}/${m}/*`);
}
/** Bumped whenever bake data changes so cached node results are recomputed. */
export const bakeState = { version: 0, recording: false };

export function freeBakes(objectId: string, modifierId?: string, nodeId?: string) {
  for (const [k, b] of bakes) if (b.objectId === objectId && (!modifierId || b.modifierId === modifierId) && (!nodeId || b.nodeId === nodeId)) bakes.delete(k);
  bakeState.version++;
}

export function bakeOf(objectId: string, modifierId: string, nodeId: string): BakeData | undefined {
  for (const b of bakes.values()) if (b.objectId === objectId && b.modifierId === modifierId && b.nodeId === nodeId) return b;
  return undefined;
}

export const bakeMode = (n: NodeData) => (n.props.bake_mode === 'STILL' ? 'STILL' : 'ANIMATION');

geoNode(
  {
    idname: BAKE,
    label: 'Bake',
    category: 'geometry',
    description: 'Store the data passing through so it no longer has to be computed (for a single frame or every frame of a range)',
    props: [
      enumProp(
        'bake_mode',
        'Bake Mode',
        [
          ['ANIMATION', 'Animation'],
          ['STILL', 'Still'],
        ],
        'ANIMATION',
        { expand: true },
      ),
    ],
    init: (n) => {
      if (n.props[KEY] === undefined)
        writeItems(n, KEY, [
          {
            id: nextItemId(n, [KEY]),
            name: 'Geometry',
            socket_type: 'GEOMETRY',
            attribute_domain: 'POINT',
          },
        ]);
    },
    dynamicSockets: (node) => {
      const items = readItems(node, KEY);
      return {
        inputs: [...items.map((it) => itemSocket(it, itemId(it))), extendSocket()],
        outputs: [...items.map((it) => itemSocket(it, itemId(it))), extendSocket()],
      };
    },
  },
  {
    timeDependent: true,
    sig: (node, env) => `b${bakeState.version}:${bakeState.recording || bakes.size ? Math.round(env.frame) : ''}:${node.id}`,
    exec: (ctx) => {
      const items = readItems(ctx.node, KEY);
      const out = (vals: Val[]) => {
        const r: Record<string, Val> = {};
        items.forEach((it, k) => (r[itemId(it)] = vals[k] ?? coerce(undefined, it.socket_type)));
        return r;
      };
      const frame = Math.round(ctx.env.frame);
      const rec = isRecording(ctx.path, ctx.node.id);
      const b = bakes.get(ctx.path);
      if (b && !rec) {
        if (b.mode === 'STILL') return out(b.frames.values().next().value ?? []);
        let best = frame;
        if (!b.frames.has(frame)) {
          let bf = Infinity;
          for (const f of b.frames.keys()) if (Math.abs(f - frame) < Math.abs(bf - frame)) bf = f;
          best = bf;
        }
        return out(b.frames.get(best) ?? []);
      }
      const vals = items.map((it) => ctx.input(itemId(it)));
      if (rec) {
        const [objectId = '', modifierId = ''] = ctx.path.split('/');
        let data = bakes.get(ctx.path);
        if (!data)
          bakes.set(
            ctx.path,
            (data = {
              mode: bakeMode(ctx.node),
              frames: new Map(),
              objectId,
              modifierId,
              nodeId: ctx.node.id,
            }),
          );
        const stored = persistState(items, vals, `bake:${ctx.path}`);
        data.frames.set(frame, stored);
        return out(stored);
      }
      return out(vals);
    },
  },
);
