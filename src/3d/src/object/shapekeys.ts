// Shape key management operators (Object Data ▸ Shape Keys list and its specials menu).
import { app, registerOperators, type OpContext } from '../app/app';
import type { MeshData, ObjectData, ShapeKey } from '../data/types';
import { activeMesh } from './vgroups';
import { mirrorShapeKey, mirrorVertexMap, mixShapeKeys, uniqueIn } from './core';

const keyCount = () => activeMesh()?.me.shape_keys.length ?? 0;
const objectMode = (ctx: OpContext) => ctx.doc.mode === 'OBJECT';

function newKey(me: MeshData, name: string, data: Float32Array): ShapeKey {
  return { name: uniqueIn(me.shape_keys.map((k) => k.name), name), data, value: 0, slider_min: 0, slider_max: 1, mute: false, relative_key: me.shape_keys[0]?.name ?? 'Basis' };
}

/** Make sure the mesh has a Basis key holding its current positions. */
export function ensureBasis(me: MeshData) {
  if (!me.shape_keys.length) me.shape_keys = [{ name: 'Basis', data: new Float32Array(me.positions), value: 0, slider_min: 0, slider_max: 1, mute: false, relative_key: 'Basis' }];
}

function relData(me: MeshData, k: ShapeKey): Float32Array {
  return me.shape_keys.find((x) => x.name === k.relative_key)?.data ?? me.shape_keys[0].data;
}

/** Other selected meshes with the same vertex count as `me`. */
function compatibleOthers(ob: ObjectData, me: MeshData): { ob: ObjectData; me: MeshData }[] {
  const out: { ob: ObjectData; me: MeshData }[] = [];
  for (const o of app.selectedObjects()) {
    if (o === ob || o.type !== 'MESH' || !o.data) continue;
    const m = app.doc.meshes[o.data];
    if (m && m.positions.length === me.positions.length) out.push({ ob: o, me: m });
  }
  return out;
}

/** Positions of another object as seen in the viewport (deformations included when topology matches). */
function evaluatedPositions(o: ObjectData, m: MeshData): Float32Array {
  const ev = app.graph.get(o.id)?.mesh;
  if (ev && ev.positions.length === m.positions.length) return new Float32Array(ev.positions);
  return mixShapeKeys(m);
}

registerOperators([
  {
    idname: 'object.shape_key_clear',
    label: 'Clear Shape Keys',
    description: 'Set every shape key value back to zero',
    poll: () => keyCount() > 1,
    exec: () => {
      const { me } = activeMesh()!;
      me.shape_keys = me.shape_keys.map((k) => ({ ...k, value: 0 }));
    },
  },
  {
    idname: 'object.shape_key_move',
    label: 'Move Shape Key',
    description: 'Move the active shape key up or down the list (the basis stays first)',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'UP', items: [['TOP', 'Top'], ['UP', 'Up'], ['DOWN', 'Down'], ['BOTTOM', 'Bottom']] }],
    poll: () => keyCount() > 2 && (activeMesh()?.me.active_shape_key_index ?? 0) > 0,
    exec: (_ctx, p) => {
      const { me } = activeMesh()!;
      const n = me.shape_keys.length;
      const i = me.active_shape_key_index;
      const j = { TOP: 1, UP: i - 1, DOWN: i + 1, BOTTOM: n - 1 }[p.type as string] ?? i;
      if (j < 1 || j >= n || j === i) return 'CANCELLED';
      const keys = me.shape_keys.slice();
      const [k] = keys.splice(i, 1);
      keys.splice(j, 0, k);
      me.shape_keys = keys;
      me.active_shape_key_index = j;
    },
  },
  {
    idname: 'object.shape_key_copy',
    label: 'Duplicate Shape Key',
    description: 'Duplicate the active shape key',
    poll: () => keyCount() > 0,
    exec: () => {
      const { me } = activeMesh()!;
      const i = me.active_shape_key_index;
      const src = me.shape_keys[i];
      const copy: ShapeKey = { ...src, data: new Float32Array(src.data), name: uniqueIn(me.shape_keys.map((k) => k.name), src.name) };
      if (i === 0) copy.relative_key = src.name;
      const keys = me.shape_keys.slice();
      keys.splice(i + 1, 0, copy);
      me.shape_keys = keys;
      me.active_shape_key_index = i + 1;
    },
  },
  {
    idname: 'object.shape_key_mirror',
    label: 'Mirror Shape Key',
    description: 'Mirror the active shape key across the local X axis',
    props: [{ id: 'use_topology', label: 'Topology Mirror', type: 'bool', default: false }],
    poll: () => keyCount() > 1 && (activeMesh()?.me.active_shape_key_index ?? 0) > 0,
    exec: (_ctx, p) => {
      const { me } = activeMesh()!;
      const k = me.shape_keys[me.active_shape_key_index];
      const rel = relData(me, k);
      const map = mirrorVertexMap(rel, p.use_topology ? 1e-3 : 1e-4);
      me.shape_keys = me.shape_keys.map((x) => (x === k ? { ...x, data: mirrorShapeKey(k.data, rel, map) } : x));
    },
  },
  {
    idname: 'object.shape_key_lock',
    label: 'Change the Lock On Shape Keys',
    description: 'Lock or unlock all shape keys against edits',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'LOCK', items: [['LOCK', 'Lock'], ['UNLOCK', 'Unlock']] }],
    poll: () => keyCount() > 0,
    exec: (_ctx, p) => {
      const { me } = activeMesh()!;
      me.shape_keys = me.shape_keys.map((k) => ({ ...k, lock_shape: p.action === 'LOCK' }));
    },
  },
  {
    idname: 'object.shape_key_make_basis',
    label: 'Make Shape Key the Basis Key',
    description: 'Make the active shape key the new rest shape',
    poll: (ctx) => objectMode(ctx) && keyCount() > 1 && (activeMesh()?.me.active_shape_key_index ?? 0) > 0,
    exec: () => {
      const { me } = activeMesh()!;
      const i = me.active_shape_key_index;
      const keys = me.shape_keys.slice();
      const oldBasis = keys[0];
      const [k] = keys.splice(i, 1);
      const nk: ShapeKey = { ...k, relative_key: k.name };
      keys.unshift(nk);
      keys[1] = { ...oldBasis, relative_key: nk.name };
      me.shape_keys = keys;
      me.positions = new Float32Array(nk.data);
      me.active_shape_key_index = 0;
    },
  },
  {
    idname: 'object.shape_key_apply_to_basis',
    label: 'Apply Shape Key to Basis',
    description: 'Add the active key’s current effect to the basis and every other key, then remove it',
    poll: (ctx) => objectMode(ctx) && keyCount() > 1 && (activeMesh()?.me.active_shape_key_index ?? 0) > 0,
    exec: () => {
      const { me } = activeMesh()!;
      const i = me.active_shape_key_index;
      const k = me.shape_keys[i];
      const rel = relData(me, k);
      const f = k.mute ? 0 : k.value;
      const gi = k.vertex_group ? me.vertex_groups.findIndex((g) => g.name === k.vertex_group) : -1;
      const w = gi >= 0 ? me.weights[gi] : null;
      const delta = new Float32Array(k.data.length);
      for (let c = 0; c < delta.length; c++) delta[c] = (k.data[c] - rel[c]) * f * (w ? w[(c / 3) | 0] : 1);
      const basisName = me.shape_keys[0].name;
      me.shape_keys = me.shape_keys
        .filter((_, j) => j !== i)
        .map((x) => {
          const d = new Float32Array(x.data);
          for (let c = 0; c < d.length; c++) d[c] += delta[c];
          return { ...x, data: d, relative_key: x.relative_key === k.name ? basisName : x.relative_key };
        });
      me.positions = new Float32Array(me.shape_keys[0].data);
      me.active_shape_key_index = 0;
    },
  },
  {
    idname: 'object.join_shapes',
    label: 'Join as Shapes',
    description: 'Add a shape key from each other selected mesh with the same vertex count',
    props: [{ id: 'use_mirror', label: 'Mirror', type: 'bool', default: false }],
    poll: (ctx) => objectMode(ctx) && !!activeMesh() && app.selectedObjects().length > 1,
    exec: (_ctx, p) => {
      const { ob, me } = activeMesh()!;
      const others = compatibleOthers(ob, me);
      if (!others.length) {
        app.report('ERROR', 'No other selected mesh has the same number of vertices');
        return 'CANCELLED';
      }
      ensureBasis(me);
      const keys = me.shape_keys.slice();
      for (const o of others) {
        let data = evaluatedPositions(o.ob, o.me);
        if (p.use_mirror) data = mirrorShapeKey(data, me.shape_keys[0].data, mirrorVertexMap(me.shape_keys[0].data));
        me.shape_keys = keys;
        keys.push(newKey(me, o.ob.name, data));
      }
      me.shape_keys = keys;
      me.active_shape_key_index = keys.length - 1;
    },
  },
  {
    idname: 'object.update_shapes',
    label: 'Update from Objects',
    description: 'Refresh the shape keys named after other selected meshes from those meshes',
    props: [{ id: 'use_mirror', label: 'Mirror', type: 'bool', default: false }],
    poll: (ctx) => objectMode(ctx) && keyCount() > 0 && app.selectedObjects().length > 1,
    exec: (_ctx, p) => {
      const { ob, me } = activeMesh()!;
      let n = 0;
      const keys = me.shape_keys.slice();
      for (const o of compatibleOthers(ob, me)) {
        const i = keys.findIndex((k, j) => j > 0 && k.name === o.ob.name);
        if (i < 0) continue;
        let data = evaluatedPositions(o.ob, o.me);
        if (p.use_mirror) data = mirrorShapeKey(data, keys[0].data, mirrorVertexMap(keys[0].data));
        keys[i] = { ...keys[i], data };
        n++;
      }
      if (!n) {
        app.report('WARNING', 'No shape key is named after another selected mesh');
        return 'CANCELLED';
      }
      me.shape_keys = keys;
    },
  },
  {
    idname: 'object.shape_key_transfer',
    label: 'Transfer Shape Key',
    description: 'Copy the active shape key of another selected mesh to this one',
    poll: (ctx) => objectMode(ctx) && !!activeMesh() && app.selectedObjects().length > 1,
    exec: () => {
      const { ob, me } = activeMesh()!;
      const src = compatibleOthers(ob, me).find((o) => o.me.shape_keys.length > 1);
      if (!src) {
        app.report('ERROR', 'No other selected mesh with matching vertices has shape keys');
        return 'CANCELLED';
      }
      const si = Math.max(1, Math.min(src.me.shape_keys.length - 1, src.me.active_shape_key_index));
      const sk = src.me.shape_keys[si];
      const srel = relData(src.me, sk);
      ensureBasis(me);
      const base = me.shape_keys[0].data;
      const data = new Float32Array(base);
      for (let c = 0; c < data.length; c++) {
        data[c] += sk.data[c] - srel[c];
      }
      const k = newKey(me, sk.name, data);
      me.shape_keys = [...me.shape_keys, k];
      me.active_shape_key_index = me.shape_keys.length - 1;
    },
  },
]);
