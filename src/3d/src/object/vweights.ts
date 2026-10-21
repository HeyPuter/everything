// Sidebar ▸ Item: Vertex Weights panel (Edit Mode) and Global Transform copy/paste (Object Mode).
import { Matrix4 } from 'three';
import { app, registerOperators } from '../app/app';
import type { MeshData, ObjectData } from '../data/types';
import { applyMatrixToObject, toMatrix4 } from '../eval/transform';
import { itemPanels } from '../editors/view3d/sidebar';
import { h, type Child } from '../ui/h';
import { icon, registerIcons } from '../ui/icons';
import { numberField, opButton, panel } from '../ui/widgets';

function editMesh(): { ob: ObjectData; me: MeshData } | null {
  const ob = app.activeObject;
  if (app.doc.mode !== 'EDIT' || ob?.type !== 'MESH' || !ob.data) return null;
  const me = app.doc.meshes[ob.data];
  return me ? { ob, me } : null;
}

/** The vertex whose weights the panel shows: the first selected (visible) vertex. */
export function referenceVertex(me: MeshData): number {
  const s = me.select_vert;
  if (!s) return -1;
  for (let i = 0; i < s.length; i++) if (s[i] && !me.hide_vert?.[i]) return i;
  return -1;
}

function selected(me: MeshData): number[] {
  const out: number[] = [];
  const s = me.select_vert;
  if (s) for (let i = 0; i < s.length; i++) if (s[i] && !me.hide_vert?.[i]) out.push(i);
  return out;
}

const hasRef = () => {
  const t = editMesh();
  return !!t && t.me.vertex_groups.length > 0 && referenceVertex(t.me) >= 0;
};

const groupProp = { id: 'weight_group', label: 'Weight Index', type: 'int' as const, default: -1, min: -1 };

/** Replace one group's weight array with a modified copy. */
function editWeights(me: MeshData, g: number, fn: (w: Float32Array) => void) {
  const w = new Float32Array(me.weights[g]);
  fn(w);
  me.weights = me.weights.map((x, i) => (i === g ? w : x));
}


registerIcons({
  // clipboard with a downward arrow: spread a value to the selection
  paste_weight: '<rect class="s" x="3.5" y="3" width="9" height="11" rx="1" fill="none" stroke-width="1.3"/><path class="s" d="M6 3V2h4v1" fill="none" stroke-width="1.3"/><path class="s" d="M8 6v5M5.8 9L8 11.2 10.2 9" fill="none" stroke-width="1.3"/>',
});

registerOperators([
  {
    idname: 'object.vertex_weight_set_active',
    label: 'Set Active Group',
    description: 'Make this vertex group the active one',
    props: [groupProp],
    poll: hasRef,
    exec: (_ctx, p) => {
      const { ob, me } = editMesh()!;
      const g = p.weight_group as number;
      if (g < 0 || g >= me.vertex_groups.length) return 'CANCELLED';
      ob.vertex_group_active_index = g;
    },
  },
  {
    idname: 'object.vertex_weight_delete',
    label: 'Delete Weight',
    description: 'Remove the vertex from this group',
    props: [groupProp],
    poll: hasRef,
    exec: (_ctx, p) => {
      const { ob, me } = editMesh()!;
      const v = referenceVertex(me);
      const g = (p.weight_group as number) < 0 ? ob.vertex_group_active_index ?? 0 : (p.weight_group as number);
      if (!me.weights[g] || me.vertex_groups[g].lock_weight) return 'CANCELLED';
      editWeights(me, g, (w) => (w[v] = 0));
    },
  },
  {
    idname: 'object.vertex_weight_paste',
    label: 'Paste Weight to Selected',
    description: 'Give the other selected vertices this vertex’s weight in one group',
    props: [groupProp],
    poll: hasRef,
    exec: (_ctx, p) => {
      const { ob, me } = editMesh()!;
      const v = referenceVertex(me);
      const g = (p.weight_group as number) < 0 ? ob.vertex_group_active_index ?? 0 : (p.weight_group as number);
      if (!me.weights[g] || me.vertex_groups[g].lock_weight) return 'CANCELLED';
      const val = me.weights[g][v];
      editWeights(me, g, (w) => {
        for (const i of selected(me)) w[i] = val;
      });
    },
  },
  {
    idname: 'object.vertex_weight_copy',
    label: 'Copy Active',
    description: 'Copy every group weight of this vertex to the other selected vertices',
    poll: hasRef,
    exec: () => {
      const { me } = editMesh()!;
      const v = referenceVertex(me);
      const sel = selected(me);
      me.weights = me.weights.map((w, g) => {
        if (me.vertex_groups[g].lock_weight) return w;
        const out = new Float32Array(w);
        for (const i of sel) out[i] = w[v];
        return out;
      });
    },
  },
  {
    idname: 'object.vertex_weight_normalize_active_vertex',
    label: 'Normalize Active',
    description: 'Scale this vertex’s unlocked weights so they add up to 1',
    poll: hasRef,
    exec: () => {
      const { me } = editMesh()!;
      const v = referenceVertex(me);
      let locked = 0,
        free = 0;
      me.weights.forEach((w, g) => (me.vertex_groups[g].lock_weight ? (locked += w[v]) : (free += w[v])));
      if (free <= 0) return 'CANCELLED';
      const scale = Math.max(0, 1 - locked) / free;
      me.weights = me.weights.map((w, g) => {
        if (me.vertex_groups[g].lock_weight || !w[v]) return w;
        const out = new Float32Array(w);
        out[v] = w[v] * scale;
        return out;
      });
    },
  },
]);

function vertexWeightsPanel(): Child {
  const t = editMesh();
  if (!t || !t.me.vertex_groups.length) return null;
  const { ob, me } = t;
  const v = referenceVertex(me);
  if (v < 0) return null;
  const rows = me.vertex_groups
    .map((g, i) => ({ g, i, w: me.weights[i]?.[v] ?? 0 }))
    .filter((r) => r.w > 0)
    .map(({ g, i, w }) =>
      h(
        'div',
        { key: `vw-${i}`, class: { 'vw-row': true, on: i === (ob.vertex_group_active_index ?? 0) } },
        h('button', { class: 'vw-name', 'data-tip': 'Set active group', onclick: () => app.run('object.vertex_weight_set_active', { weight_group: i }) }, g.name),
        numberField({
          id: `vw.${me.id}.${i}`,
          value: w,
          min: 0,
          max: 1,
          slider: true,
          set: (x, final) => {
            if (g.lock_weight) return;
            editWeights(me, i, (arr) => (arr[v] = x));
            app.changed('doc');
            if (final) app.pushUndo('Vertex Weight');
          },
        }),
        h('button', { class: 'icon-btn', 'data-tip': 'Paste weight to selected', onclick: () => app.run('object.vertex_weight_paste', { weight_group: i }) }, icon('paste_weight')),
        h('button', { class: 'icon-btn', 'data-tip': 'Delete weight', onclick: () => app.run('object.vertex_weight_delete', { weight_group: i }) }, icon('x')),
      ),
    );
  return panel('sb-vweights', 'Vertex Weights', () => [
    rows.length ? rows : h('div', { class: 'sb-label' }, 'Not in any group'),
    h('div', { class: 'btn-row' }, opButton('object.vertex_weight_normalize_active_vertex', 'Normalize'), opButton('object.vertex_weight_copy', 'Copy')),
  ]);
}

itemPanels.push(() => vertexWeightsPanel());
