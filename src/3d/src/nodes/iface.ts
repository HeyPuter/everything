// Node group interface editing: sockets and the panels that organize a group node's inputs.
// Pure data operations used by the node editor sidebar.
import type { NodeTreeData } from '../data/types';

type Item = NonNullable<NodeTreeData['interface']>[number];
type Panel = NonNullable<NodeTreeData['interface_panels']>[number];

export type IfaceEntry = { kind: 'socket'; item: Item; depth: number } | { kind: 'panel'; panel: Panel; depth: number };

/** Sockets outside panels first (in interface order), then each panel with its inputs. */
export function interfaceEntries(tree: NodeTreeData): IfaceEntry[] {
  const items = tree.interface ?? [];
  const panels = tree.interface_panels ?? [];
  const ids = new Set(panels.map((p) => p.identifier));
  const out: IfaceEntry[] = items.filter((i) => !(i.in_out === 'INPUT' && i.panel && ids.has(i.panel))).map((item) => ({ kind: 'socket' as const, item, depth: 0 }));
  for (const panel of panels) {
    out.push({ kind: 'panel', panel, depth: 0 });
    for (const item of items) if (item.in_out === 'INPUT' && item.panel === panel.identifier) out.push({ kind: 'socket', item, depth: 1 });
  }
  return out;
}

export function addInterfacePanel(tree: NodeTreeData, name = 'Panel'): Panel {
  const panels = (tree.interface_panels ??= []);
  const used = new Set(panels.map((p) => p.identifier));
  let k = panels.length;
  while (used.has(`Panel_${k}`)) k++;
  const names = new Set(panels.map((p) => p.name));
  let nm = name;
  for (let i = 1; names.has(nm); i++) nm = `${name}.${String(i).padStart(3, '0')}`;
  const p: Panel = { identifier: `Panel_${k}`, name: nm };
  panels.push(p);
  return p;
}

/** Remove a panel; its sockets stay, outside any panel. */
export function removeInterfacePanel(tree: NodeTreeData, id: string) {
  tree.interface_panels = (tree.interface_panels ?? []).filter((p) => p.identifier !== id);
  for (const i of tree.interface ?? []) if (i.panel === id) delete i.panel;
  if (!tree.interface_panels.length) delete tree.interface_panels;
}

/** Put an input socket in a panel (or take it out with `panel` undefined); it goes last in the panel. */
export function setSocketPanel(tree: NodeTreeData, socketId: string, panel: string | undefined) {
  const items = tree.interface ?? [];
  const it = findSocketItem(tree, socketId);
  if (!it || it.in_out !== 'INPUT') return;
  if (panel) it.panel = panel;
  else delete it.panel;
  items.splice(items.indexOf(it), 1);
  items.push(it);
}

/** Move a socket (within its panel) or a panel up (-1) or down (+1). Returns whether it moved. */
export function moveInterfaceEntry(tree: NodeTreeData, id: string, dir: -1 | 1): boolean {
  const panels = tree.interface_panels ?? [];
  const pi = panels.findIndex((p) => p.identifier === id);
  if (pi >= 0) {
    const j = pi + dir;
    if (j < 0 || j >= panels.length) return false;
    [panels[pi], panels[j]] = [panels[j], panels[pi]];
    return true;
  }
  const items = tree.interface ?? [];
  const it = findSocketItem(tree, id);
  if (!it) return false;
  const group = (i: Item) => (i.in_out === 'INPUT' && i.panel && panels.some((p) => p.identifier === i.panel) ? i.panel : '');
  const same = items.filter((i) => group(i) === group(it));
  const k = same.indexOf(it) + dir;
  if (k < 0 || k >= same.length) return false;
  const other = same[k];
  const a = items.indexOf(it),
    b = items.indexOf(other);
  [items[a], items[b]] = [items[b], items[a]];
  return true;
}

// ---------------------------------------------------------------------------
// Items (sockets and panels) by identifier: remove, duplicate, panel toggles

/**
 * Key of a socket in the interface list. An input and an output may share an identifier (older
 * groups use "Geometry" for both), so the key carries the direction.
 */
export const socketKey = (it: Pick<Item, 'in_out' | 'identifier'>) => `${it.in_out}:${it.identifier}`;

/** A socket by key ("INPUT:Socket_0") or plain identifier (first match). */
export function findSocketItem(tree: NodeTreeData, key: string): Item | undefined {
  const items = tree.interface ?? [];
  const m = /^(INPUT|OUTPUT):(.*)$/.exec(key);
  if (m) return items.find((i) => i.in_out === m[1] && i.identifier === m[2]);
  return items.find((i) => i.identifier === key);
}
export const findPanel = (tree: NodeTreeData, id: string): Panel | undefined => (tree.interface_panels ?? []).find((p) => p.identifier === id);

/** Remove a socket (and the links of the group input / output nodes to it) or a panel. */
export function removeInterfaceItem(tree: NodeTreeData, id: string): boolean {
  if (findPanel(tree, id)) {
    removeInterfacePanel(tree, id);
    return true;
  }
  const it = findSocketItem(tree, id);
  if (!it) return false;
  tree.interface = (tree.interface ?? []).filter((x) => x !== it);
  if (it.in_out === 'INPUT') for (const p of tree.interface_panels ?? []) if (p.toggle === it.identifier) delete p.toggle;
  tree.links = tree.links.filter(
    (l) =>
      !(
        (it.in_out === 'INPUT' && l.from_socket === it.identifier && tree.nodes.find((n) => n.id === l.from_node)?.type === 'NodeGroupInput') ||
        (it.in_out === 'OUTPUT' && l.to_socket === it.identifier && tree.nodes.find((n) => n.id === l.to_node)?.type === 'NodeGroupOutput')
      ),
  );
  return true;
}

/** Copy of a socket placed right after it. Returns the copy. */
export function duplicateInterfaceItem(tree: NodeTreeData, id: string, add: (inOut: 'INPUT' | 'OUTPUT', name: string) => Item): Item | null {
  const it = findSocketItem(tree, id);
  if (!it) return null;
  const copy = add(it.in_out, it.name);
  const { identifier } = copy;
  Object.assign(copy, structuredClone(it), { identifier, name: copy.name });
  const list = tree.interface!;
  list.splice(list.indexOf(copy), 1);
  list.splice(list.indexOf(it) + 1, 0, copy);
  return copy;
}

/** The panel holding an input socket that can be its toggle (a boolean input of the panel). */
export function toggleCandidatePanel(tree: NodeTreeData, socketId: string): Panel | undefined {
  const it = findSocketItem(tree, socketId);
  if (!it || it.in_out !== 'INPUT' || it.socket_type !== 'NodeSocketBool' || !it.panel) return undefined;
  const p = findPanel(tree, it.panel);
  return p && p.toggle !== it.identifier ? p : undefined;
}

/** Make a boolean input of a panel the panel's toggle (drawn as a checkbox in the panel header). */
export function makePanelToggle(tree: NodeTreeData, socketId: string): boolean {
  const p = toggleCandidatePanel(tree, socketId);
  if (!p) return false;
  p.toggle = findSocketItem(tree, socketId)!.identifier;
  return true;
}

/** Add a new boolean input to a panel and make it the panel's toggle. */
export function addPanelToggle(tree: NodeTreeData, panelId: string, add: (inOut: 'INPUT' | 'OUTPUT', name: string) => Item): Item | null {
  const p = findPanel(tree, panelId);
  if (!p || p.toggle) return null;
  const it = add('INPUT', p.name);
  it.socket_type = 'NodeSocketBool';
  it.default_value = true;
  it.panel = p.identifier;
  p.toggle = it.identifier;
  return it;
}

/** Turn a panel's toggle back into an ordinary input of the panel. */
export function unlinkPanelToggle(tree: NodeTreeData, panelId: string): boolean {
  const p = findPanel(tree, panelId);
  if (!p?.toggle) return false;
  delete p.toggle;
  return true;
}

/** Panel whose toggle is the given socket. */
export const panelOfToggle = (tree: NodeTreeData, socketId: string): Panel | undefined => {
  const it = findSocketItem(tree, socketId);
  if (it && it.in_out !== 'INPUT') return undefined;
  const id = it?.identifier ?? socketId;
  return (tree.interface_panels ?? []).find((p) => p.toggle === id);
};
