// Node color presets: named custom colors kept in the browser (per user, not per file), offered
// next to the node color in the sidebar together with Copy to Selected.
import { app, registerOperators, type OpContext } from '../../app/app';
import { promptText, type MenuItem } from '../../ui/menu';
import type { NodeData } from '../../data/types';
import { NodeEditor } from './editor';

export interface ColorPreset {
  name: string;
  color: [number, number, number];
}

const KEY = 'p3d.nodeColorPresets.v1';
let cache: ColorPreset[] | null = null;

export function colorPresets(): ColorPreset[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as ColorPreset[]) : [];
    cache = Array.isArray(list) ? list.filter((p) => typeof p?.name === 'string' && Array.isArray(p.color)) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function save(list: ColorPreset[]) {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: presets last for this session only
  }
}

const activeNode = (ctx: OpContext): NodeData | undefined => {
  const ed = ctx.area?.editor;
  const tree = ed instanceof NodeEditor ? ed.tree() : null;
  return tree?.active_node ? tree.nodes.find((n) => n.id === tree.active_node) : undefined;
};

registerOperators([
  {
    idname: 'node.node_color_preset_add',
    label: 'Add Node Color Preset',
    description: 'Save the active node’s color as a named preset, or remove a preset',
    undo: false,
    props: [
      { id: 'name', type: 'string', default: '' },
      { id: 'remove_name', label: 'Remove', type: 'bool', default: false },
    ],
    poll: (ctx) => !!activeNode(ctx),
    exec: (ctx, p) => {
      const name = String(p.name ?? '').trim();
      if (!name) return 'CANCELLED';
      const list = colorPresets().filter((x) => x.name !== name);
      if (!p.remove_name) {
        const n = activeNode(ctx)!;
        const c = n.color ?? [0.608, 0.608, 0.608];
        list.push({ name, color: [c[0], c[1], c[2]] });
        list.sort((a, b) => a.name.localeCompare(b.name));
      }
      save(list);
      app.changed('ui');
    },
  },
]);

/** Specials menu of the node color: copy to selected, presets, add / remove presets. */
export function colorSpecials(n: NodeData): MenuItem[] {
  const list = colorPresets();
  const apply = (p: ColorPreset) => {
    const tree = (app.hoverArea?.editor as NodeEditor | undefined)?.tree?.();
    const targets = tree ? tree.nodes.filter((x) => x.select || x === n) : [n];
    for (const t of targets) {
      t.color = [...p.color];
      t.use_custom_color = true;
    }
    app.pushUndo('Node Color Preset');
    app.changed('doc');
  };
  return [
    { label: 'Copy to Selected', op: 'node.node_copy_color' },
    { separator: true },
    { heading: 'Presets' },
    ...(list.length ? list.map((p) => ({ label: p.name, icon: undefined, description: 'Apply to the selected nodes', action: () => apply(p) })) : [{ label: 'No presets yet', disabled: true }]),
    { separator: true },
    {
      label: 'Add Preset...',
      action: () => promptText('Preset Name', '', (v) => v && app.run('node.node_color_preset_add', { name: v })),
    },
    ...(list.length
      ? [
          {
            label: 'Remove Preset',
            submenu: () => list.map((p) => ({ label: p.name, action: () => app.run('node.node_color_preset_add', { name: p.name, remove_name: true }) })),
          },
        ]
      : []),
  ];
}
