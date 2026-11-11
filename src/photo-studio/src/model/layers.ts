import {
  allLayers,
  containerOf,
  findLayer,
  layer,
  type Layer,
  type PhotoDocument,
} from './document';
import { layerLocked } from './transform';
import { layerLock, ownLock, type LockOperation } from './locks';

/** Selected ancestors own their descendants, so every layer is edited at most once. */
export function selectedRoots(layers: Layer[], ids: ReadonlySet<string>): Layer[] {
  return layers.flatMap((l) => (ids.has(l.id) ? [l] : selectedRoots(l.children, ids)));
}
export function visibleRows(layers: Layer[], collapsed: ReadonlySet<string>): Layer[] {
  return [...layers]
    .reverse()
    .flatMap((l) => [l, ...(collapsed.has(l.id) ? [] : visibleRows(l.children, collapsed))]);
}
export function assertEditable(doc: PhotoDocument, roots: Layer[], operation: LockOperation = 'all') {
  if (
    roots.some((l) => layerLock(doc.layers, l.id, operation) || allLayers(l.children).some((c) => ownLock(c, operation)))
  )
    throw new Error('Unlock the selected layers and their groups first.');
}
function assertTree(layers: Layer[], depth = 0, inFrame = false) {
  if (depth > 12) throw new Error('Groups can be nested up to 12 levels.');
  if (allLayers(layers).length > 200) throw new Error('A document can contain up to 200 layers.');
  for (const l of layers) {
    if (l.artboard && depth > 0) throw new Error('Artboards stay at the top level of the layer stack.');
    if (l.frame && inFrame) throw new Error('Frames cannot contain other frames.');
    assertTree(l.children, depth + 1, inFrame || !!l.frame);
  }
}
// The Background layer stays at the bottom of the stack until it is
// converted (Layer → New → Layer from Background).
const BACKGROUND_STAYS = 'The Background layer stays at the bottom. Convert it with Layer from Background first.';
export type DropPosition = 'above' | 'below' | 'inside';
export function moveLayers(
  doc: PhotoDocument,
  ids: ReadonlySet<string>,
  targetId: string | null,
  position: DropPosition,
) {
  const roots = selectedRoots(doc.layers, ids);
  if (!roots.length) return;
  assertEditable(doc, roots);
  const target = targetId ? findLayer(doc.layers, targetId) : undefined;
  if (targetId && !target) throw new Error('The destination layer no longer exists.');
  if (target && allLayers(roots).some((l) => l.id === target.id))
    throw new Error('Drop outside the selected layers to move them.');
  if (target && layerLocked(doc.layers, target.id))
    throw new Error('Unlock the destination group or layer first.');
  if (position === 'inside' && target?.kind !== 'group')
    throw new Error('Only groups can contain layers.');
  if (roots.some((l) => l.background) || (target?.background && position === 'below')) throw new Error(BACKGROUND_STAYS);
  for (const l of roots) {
    const list = containerOf(doc.layers, l.id)!;
    list.splice(list.indexOf(l), 1);
  }
  const list = !target
    ? doc.layers
    : position === 'inside'
      ? target.children
      : containerOf(doc.layers, target.id)!;
  const index = !target
    ? list.length
    : position === 'inside'
      ? list.length
      : list.indexOf(target) + (position === 'above' ? 1 : 0);
  list.splice(index, 0, ...roots);
  assertTree(doc.layers);
}
export function groupLayers(doc: PhotoDocument, ids: ReadonlySet<string>): string | undefined {
  const roots = selectedRoots(doc.layers, ids);
  if (!roots.length) return;
  assertEditable(doc, roots);
  if (roots.some((l) => l.background)) throw new Error(BACKGROUND_STAYS);
  const list = containerOf(doc.layers, roots[0].id)!;
  if (roots.some((l) => containerOf(doc.layers, l.id) !== list))
    throw new Error('Move the selected layers into the same group before grouping them.');
  const topIndex = list.indexOf(roots.at(-1)!);
  const insertion = list.slice(0, topIndex).filter((l) => !roots.includes(l)).length;
  const group = layer('group', 'Group', doc.width, doc.height);
  group.children = roots;
  for (const l of roots) list.splice(list.indexOf(l), 1);
  list.splice(insertion, 0, group);
  assertTree(doc.layers);
  return group.id;
}
export function reorderLayers(doc: PhotoDocument, ids: ReadonlySet<string>, up: boolean) {
  const roots = selectedRoots(doc.layers, ids);
  assertEditable(doc, roots);
  const selected = new Set(roots.map((l) => l.id));
  const lists = new Set(roots.map((l) => containerOf(doc.layers, l.id)!));
  for (const list of lists) {
    const indices = Array.from({ length: list.length }, (_, i) => i);
    if (up) indices.reverse();
    for (const i of indices) {
      const j = i + (up ? 1 : -1);
      if (selected.has(list[i].id) && list[j] && !selected.has(list[j].id) && !list[j].locked && !list[i].background && !list[j].background)
        [list[i], list[j]] = [list[j], list[i]];
    }
  }
}
/** The layer stack after Merge Visible: `merged` replaces the visible layers.
 * Hidden layers survive, also those inside visible groups (which are merged
 * away), and stay below or above the merged layer as they were stacked
 * relative to the topmost visible layer. */
export function mergeVisibleStack(layers: Layer[], merged: Layer): Layer[] {
  const hidden: Layer[] = [];
  let below = -1;
  const walk = (list: Layer[]) => {
    for (const l of list) {
      if (!l.visible) hidden.push(l);
      else if (l.kind === 'group') walk(l.children);
      else below = hidden.length;
    }
  };
  walk(layers);
  if (below < 0) below = hidden.length;
  return [...hidden.slice(0, below), merged, ...hidden.slice(below)];
}
