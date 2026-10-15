// Layer groups: named folders of layers. Members stay next to each other in the layer stack; the
// group's visibility / lock toggles act on all its members. Add / remove / ungroup / merge, color
// tags, add to / remove from a group, and moving layers around groups.
import { app, registerOperators, operators } from '../app/app';
import { activeGP } from './ops';
import { mergeLayers } from './layerops';
import { compactDrawings, setKeyframe, newLayer, uniqueLayerName } from './data';
import type { GPLayer, GreasePencilData } from './types';

export type { GPLayerGroup } from './types';
import type { GPLayerGroup } from './types';

export const groupsOf = (gp: GreasePencilData): GPLayerGroup[] => (gp.layer_groups ??= []);
export const members = (gp: GreasePencilData, name: string) => gp.layers.filter((l) => l.parent_group === name);

/** Keep every group's layers next to each other (at the position of its topmost member). */
export function normalizeGroups(gp: GreasePencilData) {
  const active = gp.layers[gp.active_layer_index];
  const top = [...gp.layers].reverse(); // top → bottom
  const out: GPLayer[] = [];
  const placed = new Set<string>();
  for (const l of top) {
    const g = l.parent_group;
    if (!g) {
      out.push(l);
      continue;
    }
    if (placed.has(g)) continue;
    placed.add(g);
    out.push(...top.filter((x) => x.parent_group === g));
  }
  gp.layers = out.reverse();
  if (active) gp.active_layer_index = gp.layers.indexOf(active);
  // groups without layers go away
  const used = new Set(gp.layers.map((l) => l.parent_group).filter(Boolean));
  const list = groupsOf(gp);
  for (let i = list.length - 1; i >= 0; i--) if (!used.has(list[i].name)) list.splice(i, 1);
}

function uniqueGroupName(gp: GreasePencilData, base: string) {
  const names = new Set(groupsOf(gp).map((g) => g.name));
  let n = base;
  for (let i = 1; names.has(n); i++) n = `${base}.${String(i).padStart(3, '0')}`;
  return n;
}

/** Group of the active layer. */
export function activeGroup(gp: GreasePencilData): GPLayerGroup | null {
  const g = gp.layers[gp.active_layer_index]?.parent_group;
  return g ? (groupsOf(gp).find((x) => x.name === g) ?? null) : null;
}

const COLOR_TAGS: [string, string][] = [
  ['NONE', 'Reset Color Tag'],
  ['COLOR1', 'Color Tag 1'],
  ['COLOR2', 'Color Tag 2'],
  ['COLOR3', 'Color Tag 3'],
  ['COLOR4', 'Color Tag 4'],
  ['COLOR5', 'Color Tag 5'],
  ['COLOR6', 'Color Tag 6'],
  ['COLOR7', 'Color Tag 7'],
  ['COLOR8', 'Color Tag 8'],
];
/** Display colors of the color tags (sRGB). */
export const TAG_COLORS: Record<string, string> = {
  COLOR1: '#e05e58',
  COLOR2: '#eca435',
  COLOR3: '#e5db48',
  COLOR4: '#62bf67',
  COLOR5: '#5c9ae7',
  COLOR6: '#9e68dd',
  COLOR7: '#de6caf',
  COLOR8: '#8c7a59',
};

registerOperators([
  {
    idname: 'grease_pencil.layer_group_add',
    label: 'Add New Layer Group',
    description: 'Put the active layer in a new group',
    props: [{ id: 'new_layer_group_name', label: 'Name', type: 'string', default: 'Group' }],
    poll: () => !!activeGP(),
    exec: (_c, p) => {
      const { gp } = activeGP()!;
      const name = uniqueGroupName(gp, (p.new_layer_group_name as string) || 'Group');
      groupsOf(gp).push({ name, expanded: true });
      const act = gp.layers[gp.active_layer_index];
      if (act) act.parent_group = name;
      normalizeGroups(gp);
    },
  },
  {
    idname: 'grease_pencil.layer_group_remove',
    label: 'Remove Layer Group',
    description: 'Remove the group of the active layer (keeping its layers, or with them)',
    props: [{ id: 'keep_children', label: 'Keep Children', type: 'bool', default: false }],
    poll: () => !!activeGP() && !!activeGroup(activeGP()!.gp),
    exec: (_c, p) => {
      const { gp } = activeGP()!;
      const g = activeGroup(gp)!;
      const list = groupsOf(gp);
      list.splice(list.indexOf(g), 1);
      if (p.keep_children) {
        for (const l of gp.layers) if (l.parent_group === g.name) delete l.parent_group;
      } else {
        gp.layers = gp.layers.filter((l) => l.parent_group !== g.name);
        gp.active_layer_index = Math.max(0, Math.min(gp.layers.length - 1, gp.active_layer_index));
        compactDrawings(gp);
      }
    },
  },
  {
    idname: 'grease_pencil.layer_group_color_tag',
    label: 'Grease Pencil Group Color Tag',
    description: 'Mark the group of the active layer with a color',
    props: [{ id: 'color_tag', label: 'Color Tag', type: 'enum', default: 'COLOR1', items: COLOR_TAGS }],
    poll: () => !!activeGP() && !!activeGroup(activeGP()!.gp),
    exec: (_c, p) => {
      activeGroup(activeGP()!.gp)!.color_tag = p.color_tag === 'NONE' ? undefined : (p.color_tag as string);
    },
  },
  {
    idname: 'grease_pencil.layer_group_assign',
    label: 'Move Layer to Group',
    description: 'Put the active layer in a group (an empty name takes it out of its group)',
    props: [{ id: 'group', label: 'Group', type: 'string', default: '' }],
    poll: () => !!activeGP() && !!activeGP()!.gp.layers.length,
    exec: (_c, p) => {
      const { gp } = activeGP()!;
      const act = gp.layers[gp.active_layer_index];
      const name = p.group as string;
      if (name && !groupsOf(gp).some((g) => g.name === name)) return 'CANCELLED';
      if ((act.parent_group ?? '') === name) return 'CANCELLED';
      if (name) {
        // join next to the group's layers (on top of them)
        act.parent_group = name;
        const others = members(gp, name).filter((l) => l !== act);
        if (others.length) {
          gp.layers.splice(gp.layers.indexOf(act), 1);
          const at = gp.layers.indexOf(others[others.length - 1]) + 1;
          gp.layers.splice(at, 0, act);
          gp.active_layer_index = at;
        }
      } else {
        // leave the group, staying just above it
        const g = act.parent_group!;
        delete act.parent_group;
        const rest = members(gp, g);
        if (rest.length) {
          gp.layers.splice(gp.layers.indexOf(act), 1);
          const at = gp.layers.indexOf(rest[rest.length - 1]) + 1;
          gp.layers.splice(at, 0, act);
          gp.active_layer_index = at;
        }
      }
      normalizeGroups(gp);
    },
  },
]);

// Merge ▸ Group: the active layer's group becomes one layer
const merge = operators.get('grease_pencil.layer_merge');
if (merge?.exec) {
  const base = merge.exec;
  const mode = merge.props?.find((d) => d.id === 'mode');
  if (mode?.items && !mode.items.some((i) => i[0] === 'GROUP')) mode.items.splice(1, 0, ['GROUP', 'Group', 'Combine the layers of the active layer’s group into one']);
  const basePoll = merge.poll;
  merge.poll = (ctx) => (basePoll ? basePoll(ctx) : true) || (!!activeGP() && !!activeGroup(activeGP()!.gp));
  merge.exec = (ctx, p) => {
    if (p.mode !== 'GROUP') return base(ctx, p);
    const { gp } = activeGP()!;
    const g = activeGroup(gp);
    if (!g) return 'CANCELLED';
    const list = members(gp, g.name);
    const target = newLayer(uniqueLayerName(gp, g.name));
    for (const m of mergeLayers(gp, list)) setKeyframe(gp, target, m.n, m.d, m.t);
    const at = gp.layers.indexOf(list[0]);
    gp.layers = gp.layers.filter((l) => l.parent_group !== g.name);
    gp.layers.splice(Math.min(at, gp.layers.length), 0, target);
    groupsOf(gp).splice(groupsOf(gp).indexOf(g), 1);
    gp.active_layer_index = gp.layers.indexOf(target);
    compactDrawings(gp);
  };
}

// Moving layers steps over whole groups; a grouped layer moves only inside its group
const move = operators.get('grease_pencil.layer_move');
if (move?.exec) {
  const base = move.exec;
  move.exec = (ctx, p) => {
    const { gp } = activeGP()!;
    const i = gp.active_layer_index;
    const l = gp.layers[i];
    const j = p.direction === 'UP' ? i + 1 : i - 1;
    const n = gp.layers[j];
    if (!l || !n || (n.parent_group ?? '') === (l.parent_group ?? '')) return base(ctx, p);
    if (l.parent_group) return 'CANCELLED';
    // jump past the neighbouring group
    const block = members(gp, n.parent_group!);
    gp.layers.splice(i, 1);
    const at = p.direction === 'UP' ? gp.layers.indexOf(block[block.length - 1]) + 1 : gp.layers.indexOf(block[0]);
    gp.layers.splice(at, 0, l);
    gp.active_layer_index = at;
  };
}

/** Group menu (under the Layer specials). */
export function groupMenu(): import('../ui/menu').MenuItem[] {
  const c = activeGP();
  const groups = c ? groupsOf(c.gp) : [];
  const g = c ? activeGroup(c.gp) : null;
  return [
    { label: 'New Group from Active Layer', op: 'grease_pencil.layer_group_add' },
    {
      label: 'Move Layer to Group',
      submenu: () => [
        ...groups.map((x) => ({ label: x.name, icon: 'file_folder', op: 'grease_pencil.layer_group_assign', props: { group: x.name } })),
        ...(groups.length ? [] : [{ label: 'No groups', disabled: true }]),
      ],
    },
    { label: 'Remove Layer from Group', op: 'grease_pencil.layer_group_assign', props: { group: '' }, disabled: !g },
    { separator: true },
    { label: 'Delete Group', op: 'grease_pencil.layer_group_remove', props: { keep_children: false } },
    { label: 'Ungroup', op: 'grease_pencil.layer_group_remove', props: { keep_children: true } },
    { label: 'Merge Group', op: 'grease_pencil.layer_merge', props: { mode: 'GROUP' } },
    { separator: true },
    { label: 'Color Tag', submenu: () => COLOR_TAGS.map(([id, label]) => ({ label, op: 'grease_pencil.layer_group_color_tag', props: { color_tag: id } })) },
  ];
}
