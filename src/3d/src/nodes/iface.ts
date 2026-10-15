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
  const it = items.find((i) => i.identifier === socketId);
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
  const it = items.find((i) => i.identifier === id);
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
