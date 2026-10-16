// Strip modifier stack operators: duplicate, move to an index, and redefining the bands of an
// Equalizer; plus the pure helpers they use.
import { app, registerOperators } from '../app/app';
import type { EqBand, StripModifier } from './types';
import type { DocumentData, NodeGroupData, NodeTreeData } from '../data/types';
import { uid } from '../data/defaults';
import { addInterfaceSocket, addNode, uniqueGroupName } from '../nodes/tree';
import { newModifier } from './strips';
import { stripGroupHooks } from '../compositor/editor';
import { activeStrip } from './context';
import { restartPlayback } from './audio';

/** Unique modifier name within a stack ("Curves", "Curves.001", …). */
export function uniqueModifierName(list: StripModifier[], base: string): string {
  let name = base;
  for (let i = 1; list.some((m) => m.name === name); i++) name = `${base}.${String(i).padStart(3, '0')}`;
  return name;
}

/** Copy of a modifier placed right after it. */
export function duplicateModifier(list: StripModifier[], name: string): StripModifier | null {
  const i = list.findIndex((m) => m.name === name);
  if (i < 0) return null;
  const copy = structuredClone(list[i]);
  copy.name = uniqueModifierName(list, list[i].name.replace(/\.\d{3}$/, ''));
  list.splice(i + 1, 0, copy);
  return copy;
}

/** Move a modifier to an index (clamped). Returns whether it moved. */
export function moveModifierTo(list: StripModifier[], name: string, index: number): boolean {
  const i = list.findIndex((m) => m.name === name);
  if (i < 0) return false;
  const j = Math.max(0, Math.min(list.length - 1, Math.round(index)));
  if (i === j) return false;
  const [m] = list.splice(i, 1);
  list.splice(j, 0, m);
  return true;
}

/** Equalizer bands spread over the audible range: shelves at the ends, peaks between (log spaced). */
export function equalizerBands(count: number): EqBand[] {
  const n = Math.max(2, Math.round(count));
  const lo = Math.log(60),
    hi = Math.log(12000);
  return Array.from({ length: n }, (_, i): EqBand => {
    const f = Math.round(Math.exp(lo + ((hi - lo) * i) / (n - 1)));
    return { type: i === 0 ? 'LOWSHELF' : i === n - 1 ? 'HIGHSHELF' : 'PEAKING', frequency: f, gain: 0, q: i === 0 || i === n - 1 ? 0.7 : Math.max(0.7, (n - 1) / 2.5) };
  });
}

export const EQUALIZER_LAYOUTS: [string, string, number][] = [
  ['SIMPLE', 'Simple (3 bands)', 3],
  ['DOUBLE', 'Double (5 bands)', 5],
  ['TRIPLE', 'Triple (8 bands)', 8],
];

const modifierOf = (name: unknown): StripModifier | undefined => activeStrip()?.modifiers.find((m) => m.name === name);

registerOperators([
  {
    idname: 'sequencer.strip_modifier_duplicate',
    label: 'Duplicate Strip Modifier',
    description: 'Add a copy of a modifier right after it in the stack',
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: () => !!activeStrip()?.modifiers.length,
    exec: (_c, p) => {
      const s = activeStrip()!;
      const copy = duplicateModifier(s.modifiers, String(p.name || s.active_modifier || ''));
      if (!copy) return 'CANCELLED';
      s.active_modifier = copy.name;
      restartPlayback();
      app.changed('doc');
    },
  },
  {
    idname: 'sequencer.strip_modifier_move_to_index',
    label: 'Move Strip Modifier to Index',
    description: 'Move a modifier to a position in the stack (0 is the first, applied first)',
    props: [
      { id: 'modifier', label: 'Modifier', type: 'string', default: '' },
      { id: 'index', label: 'Index', type: 'int', default: 0, min: 0 },
    ],
    poll: () => (activeStrip()?.modifiers.length ?? 0) > 1,
    exec: (_c, p) => {
      const s = activeStrip()!;
      if (!moveModifierTo(s.modifiers, String(p.modifier || s.active_modifier || ''), Number(p.index))) return 'CANCELLED';
      restartPlayback();
      app.changed('doc');
    },
  },
  {
    idname: 'sequencer.strip_modifier_equalizer_redefine',
    label: 'Redefine Equalizer',
    description: 'Replace the bands of an Equalizer modifier with a new set spread over the audible range',
    props: [
      { id: 'graphs', label: 'Bands', type: 'enum', default: 'SIMPLE', items: EQUALIZER_LAYOUTS.map(([v, l]) => [v, l] as [string, string]) },
      { id: 'name', label: 'Name', type: 'string', default: '', hidden: true },
    ],
    poll: () => !!activeStrip()?.modifiers.some((m) => m.type === 'SOUND_EQUALIZER'),
    exec: (_c, p) => {
      const s = activeStrip()!;
      const m = modifierOf(p.name) ?? s.modifiers.find((x) => x.type === 'SOUND_EQUALIZER' && x.name === s.active_modifier) ?? s.modifiers.find((x) => x.type === 'SOUND_EQUALIZER');
      if (!m || m.type !== 'SOUND_EQUALIZER') return 'CANCELLED';
      m.bands = equalizerBands(EQUALIZER_LAYOUTS.find(([v]) => v === p.graphs)?.[2] ?? 3);
      restartPlayback();
      app.changed('doc');
    },
  },
]);

// ---------------------------------------------------------------------------
// Compositor modifier: node groups run on the strip image

/** A compositing node group for strips: the image goes in through Group Input and out again. */
export function newStripNodeGroup(doc: DocumentData, name = 'Strip Compositor'): NodeGroupData {
  const tree: NodeTreeData = { type: 'COMPOSITOR', nodes: [], links: [], interface: [] };
  const img = addInterfaceSocket(tree, 'INPUT', 'Image', 'RGBA', [0, 0, 0, 1]);
  addInterfaceSocket(tree, 'INPUT', 'Mask', 'FLOAT', 1);
  const out = addInterfaceSocket(tree, 'OUTPUT', 'Image', 'RGBA', [0, 0, 0, 1]);
  const gin = addNode(tree, 'NodeGroupInput', [-300, 0]);
  const gout = addNode(tree, 'NodeGroupOutput', [200, 0]);
  tree.links.push({ id: uid('link'), from_node: gin.id, from_socket: img.identifier, to_node: gout.id, to_socket: out.identifier });
  const g: NodeGroupData = { id: uid('ng'), name: uniqueGroupName(doc, name), tree };
  doc.node_groups[g.id] = g;
  return g;
}

const compositorModifier = () => {
  const s = activeStrip();
  if (!s) return null;
  return s.modifiers.find((m) => m.type === 'COMPOSITOR' && m.name === s.active_modifier) ?? s.modifiers.find((m) => m.type === 'COMPOSITOR') ?? null;
};

registerOperators([
  {
    idname: 'sequencer.strip_modifier_add_node_group',
    label: 'Add Compositor Modifier',
    description: 'Add a Compositor modifier running a compositing node group on the active strip',
    props: [
      { id: 'name', label: 'Node Group', type: 'string', default: '' },
      { id: 'session_uid', label: 'Session UID', type: 'string', default: '', hidden: true },
    ],
    poll: () => !!activeStrip() && activeStrip()!.type !== 'SOUND',
    exec: (_c, p) => {
      const s = activeStrip()!;
      const groups = Object.values(app.doc.node_groups).filter((g) => g.tree.type === 'COMPOSITOR');
      const g = groups.find((x) => x.id === p.session_uid) ?? groups.find((x) => x.name === p.name) ?? (p.name || p.session_uid ? undefined : newStripNodeGroup(app.doc));
      if (!g) {
        app.report('ERROR', `No compositing node group named "${String(p.name)}"`);
        return 'CANCELLED';
      }
      const m = newModifier('COMPOSITOR', uniqueModifierName(s.modifiers, 'Compositor'));
      m.node_group = g.id;
      s.modifiers.push(m);
      s.active_modifier = m.name;
      app.changed('doc');
    },
  },
  {
    idname: 'node.new_compositor_sequencer_node_group',
    label: 'New Strip Node Group',
    description: 'Create a compositing node group for the active strip’s Compositor modifier',
    poll: () => !!compositorModifier(),
    exec: () => {
      const m = compositorModifier()!;
      m.node_group = newStripNodeGroup(app.doc).id;
      app.changed('doc');
    },
  },
  {
    idname: 'node.duplicate_compositing_modifier_node_group',
    label: 'Duplicate Node Group',
    description: 'Give the active strip’s Compositor modifier its own copy of its node group',
    poll: () => !!compositorModifier()?.node_group && !!app.doc.node_groups[compositorModifier()!.node_group!],
    exec: () => {
      const m = compositorModifier()!;
      const g = app.doc.node_groups[m.node_group!];
      const copy = structuredClone(g);
      copy.id = uid('ng');
      copy.name = uniqueGroupName(app.doc, g.name);
      app.doc.node_groups[copy.id] = copy;
      m.node_group = copy.id;
      app.changed('doc');
    },
  },
]);

// the Compositor editor's Sequencer context edits the active strip's modifier group
stripGroupHooks.group = () => {
  const m = compositorModifier();
  return m?.node_group ? (app.doc.node_groups[m.node_group] ?? null) : null;
};
stripGroupHooks.label = () => {
  const m = compositorModifier();
  return m ? `${activeStrip()!.name} ▸ ${m.name}` : '';
};
stripGroupHooks.set = (id) => {
  const m = compositorModifier();
  if (m) m.node_group = id;
};
stripGroupHooks.create = () => {
  const m = compositorModifier();
  if (m) m.node_group = newStripNodeGroup(app.doc).id;
};
