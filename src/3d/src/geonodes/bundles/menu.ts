// Placing node types that register after the geometry Add menu was built (bundles, closures,
// lists, tool nodes) at their position in the full menu layout.
import { getNodeType } from '../../nodes/registry';
import type { MenuCategory, MenuEntry } from '../../nodes/types';
import { GEOMETRY_MENU_LAYOUT } from '../menu';
import { placeEntries } from '../menuplace';

type Item = MenuCategory['items'][number];
const labelOf = (it: Item): string => (it === 'SEPARATOR' ? '---' : 'idname' in it ? (it.label ?? getNodeType(it.idname)?.label ?? it.idname) : it.label);

/** Labels of every layout category by path ('' for the top level), for ordering new categories. */
function orders(): Record<string, string[]> {
  const out: Record<string, string[]> = { '': GEOMETRY_MENU_LAYOUT.map((c) => c.label) };
  const walk = (c: MenuCategory, path: string[]) => {
    const p = [...path, c.label];
    out[p.join('/')] = c.items.map(labelOf);
    for (const it of c.items) if (it !== 'SEPARATOR' && !('idname' in it)) walk(it, p);
  };
  for (const c of GEOMETRY_MENU_LAYOUT) walk(c, []);
  return out;
}

/** Where a node type sits in the layout: category path, sibling order and its entry. */
function find(idname: string): { path: string[]; ref: string[]; entry: MenuEntry } | null {
  let hit: { path: string[]; ref: string[]; entry: MenuEntry } | null = null;
  const walk = (c: MenuCategory, path: string[]) => {
    for (const it of c.items) {
      if (hit || it === 'SEPARATOR') continue;
      if ('idname' in it) {
        if (it.idname === idname) hit = { path: [...path, c.label], ref: c.items.map(labelOf), entry: it };
      } else walk(it, [...path, c.label]);
    }
  };
  for (const c of GEOMETRY_MENU_LAYOUT) walk(c, []);
  return hit;
}

/** Add registered node types to the geometry Add menu at their layout positions. */
export function placeFromLayout(idnames: string[]) {
  const ord = orders();
  for (const id of idnames) {
    if (!getNodeType(id)) continue;
    const f = find(id);
    if (f) placeEntries(f.path, f.ref, [f.entry], ord);
  }
}
