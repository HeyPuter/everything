// Placing entries in the Geometry Node Editor's Add menu. Menus are described by their item
// order (labels, '---' for separators); entries are inserted at their place in that order
// relative to whatever the menu already holds, so modules can add nodes independently.
import { getNodeType, nodeMenu } from '../nodes/registry';
import type { MenuCategory, MenuEntry } from '../nodes/types';
import { GEOMETRY_MENU } from './menu';

type Item = MenuCategory['items'][number];

const labelOf = (it: Item): string | null => (it === 'SEPARATOR' ? null : 'idname' in it ? (it.label ?? getNodeType(it.idname)?.label ?? it.idname) : it.label);

/** Top-level categories of the geometry Add menu (the registered array, editable in place). */
function roots(): MenuCategory[] {
  return nodeMenu('GEOMETRY');
}

/** Find (or create) a category by label path; new categories are placed by `order` of the parent. */
export function category(path: string[], order: Record<string, string[]> = {}): MenuCategory | null {
  let list: Item[] | null = null;
  let cat: MenuCategory | null = null;
  for (let d = 0; d < path.length; d++) {
    const label = path[d];
    const pool: Item[] = list ?? (roots() as Item[]);
    let found = pool.find((it) => it !== 'SEPARATOR' && !('idname' in it) && it.label === label) as MenuCategory | undefined;
    if (!found) {
      found = { label, items: [] };
      const ref = order[path.slice(0, d).join('/')];
      if (list) insertByRank(list, found, ref);
      else {
        // a new top-level category goes into the last registered menu block
        const top = roots();
        const parentRef = ref ?? [];
        const rank = parentRef.indexOf(label);
        let at = top.length;
        if (rank >= 0) {
          const next = top.findIndex((c) => parentRef.indexOf(c.label) > rank);
          if (next >= 0) at = next;
        }
        insertTop(found, at);
      }
    }
    cat = found;
    list = found.items;
  }
  return cat;
}

/** Insert a category at a position of the flattened top-level list (into the owning block). */
function insertTop(c: MenuCategory, at: number) {
  const top = roots();
  if (!top.length || at >= top.length) {
    // append to the block holding the last category
    const last = top[top.length - 1];
    const block = blockOf(last);
    if (block) block.push(c);
    return;
  }
  const before = top[at];
  const block = blockOf(before);
  if (block) block.splice(block.indexOf(before), 0, c);
}

const blocks: MenuCategory[][] = [GEOMETRY_MENU];
/** Register the arrays passed to registerNodeMenu so new top-level categories can be inserted. */
export function trackMenuBlock(cats: MenuCategory[]) {
  if (!blocks.includes(cats)) blocks.push(cats);
}
function blockOf(c: MenuCategory | undefined): MenuCategory[] | undefined {
  if (!c) return undefined;
  return blocks.find((b) => b.includes(c));
}

/** Insert an item into a list at its rank in `ref` (labels in menu order, '---' separators). */
export function insertByRank(list: Item[], item: Item, ref: string[] = []) {
  const label = labelOf(item);
  if (label && list.some((it) => labelOf(it) === label)) return;
  const rank = label ? ref.indexOf(label) : -1;
  if (rank < 0) {
    list.push(item);
    return;
  }
  const group = (r: number) => ref.slice(0, r).filter((x) => x === '---').length;
  let succ = -1,
    pred = -1;
  list.forEach((it, i) => {
    const l = labelOf(it);
    const r = l ? ref.indexOf(l) : -1;
    if (r < 0) return;
    if (r > rank && succ < 0) succ = i;
    if (r < rank) pred = i;
  });
  const succRank = succ >= 0 ? ref.indexOf(labelOf(list[succ])!) : -1;
  const predRank = pred >= 0 ? ref.indexOf(labelOf(list[pred])!) : -1;
  if (succ >= 0 && group(succRank) === group(rank)) list.splice(succ, 0, item);
  else if (pred >= 0) {
    const sameGroup = group(predRank) === group(rank);
    if (sameGroup) list.splice(pred + 1, 0, item);
    else {
      // first of its group: after the predecessor's group separator
      let at = pred + 1;
      while (at < list.length && list[at] !== 'SEPARATOR' && (labelOf(list[at]) === null || ref.indexOf(labelOf(list[at])!) < 0 || group(ref.indexOf(labelOf(list[at])!)) === group(predRank))) at++;
      if (list[at] === 'SEPARATOR') list.splice(at + 1, 0, item);
      else list.splice(at, 0, 'SEPARATOR', item);
    }
  } else if (succ >= 0) {
    list.splice(succ, 0, item);
    if (group(succRank) !== group(rank)) list.splice(succ + 1, 0, 'SEPARATOR');
  } else list.push(item);
}

/** Add node entries to a menu path in reference order. */
export function placeEntries(path: string[], ref: string[], entries: MenuEntry[], parentOrder: Record<string, string[]> = {}) {
  const cat = category(path, parentOrder);
  if (!cat) return;
  for (const e of entries) insertByRank(cat.items, e, ref);
}

/** Move existing items (entries or categories, by label) from one menu to another. */
export function moveItems(from: string[], to: string[], labels: string[], ref: string[], parentOrder: Record<string, string[]> = {}) {
  const src = from.length ? findCategory(from) : null;
  const list: Item[] = src ? src.items : (roots() as Item[]);
  const moving = list.filter((it) => {
    const l = labelOf(it);
    return l !== null && labels.includes(l);
  });
  if (!moving.length) return;
  const dst = category(to, parentOrder);
  if (!dst || dst === src) return;
  for (const it of moving) {
    if (src) src.items = src.items.filter((x) => x !== it);
    else {
      const b = blockOf(it as MenuCategory);
      if (b) b.splice(b.indexOf(it as MenuCategory), 1);
    }
    insertByRank(dst.items, it, ref);
  }
  if (src) tidy(src.items);
}

/** Drop leading, trailing and doubled separators. */
export function tidy(list: Item[]) {
  for (let i = list.length - 1; i >= 0; i--) if (list[i] === 'SEPARATOR' && (i === 0 || i === list.length - 1 || list[i - 1] === 'SEPARATOR')) list.splice(i, 1);
}

export function findCategory(path: string[]): MenuCategory | null {
  let pool: Item[] = roots() as Item[];
  let cat: MenuCategory | null = null;
  for (const label of path) {
    cat = (pool.find((it) => it !== 'SEPARATOR' && !('idname' in it) && it.label === label) as MenuCategory | undefined) ?? null;
    if (!cat) return null;
    pool = cat.items;
  }
  return cat;
}
