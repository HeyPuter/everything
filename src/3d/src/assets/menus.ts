// Asset entries in other editors' menus: Object ▸ Asset, the Outliner's Assets submenu, the
// right-click menu of data-block selectors, and node group assets in node editors' Add menus
// (listed under their catalogs).
import { app } from '../app/app';
import type { MenuItem, SearchEntry } from '../ui/menu';
import { rowMenuHooks } from '../editors/outliner/menus';
import { idSelectorMenuHooks } from '../editors/properties/tabs';
import { addMenuExtras } from '../nodes/editor/context';
import { contextTargets, metaOf, nodeEditorOf, type NodeEditorLike } from './ops';
import { libraries, libraryCatalogs, listAssets, libraryDoc, assetRef, type AssetEntry } from './library';
import { assetTableOfId, blockOf, encodeTarget, isAssetTable } from './types';
import { catalogTree, type CatalogNode } from './catalogs';

/** Mark / Clear entries for the current context (3D view selection or Outliner selection). */
function markClearItems(targets: { table: string; id: string }[], extra: Record<string, unknown> = {}): MenuItem[] {
  const anyUnmarked = targets.some((t) => !metaOf(app.doc, t));
  const anyMarked = targets.some((t) => metaOf(app.doc, t));
  return [
    { label: 'Mark as Asset', icon: 'asset_mark', op: 'asset.mark', props: extra, disabled: !anyUnmarked },
    { label: 'Clear Asset', op: 'asset.clear', props: { ...extra, set_fake_user: false }, disabled: !anyMarked },
    { label: 'Clear Asset (Set Fake User)', op: 'asset.clear', props: { ...extra, set_fake_user: true }, disabled: !anyMarked },
  ];
}

/** Object ▸ Asset (3D view, Object Mode). */
export function objectAssetMenu(): MenuItem[] {
  return markClearItems(contextTargets(app.context()));
}

// Outliner: an Assets submenu for objects, collections and asset-type data-blocks
rowMenuHooks.push((r) => {
  const table = r.kind === 'object' ? 'objects' : r.kind === 'collection' ? 'collections' : r.table;
  if (!table || !isAssetTable(table)) return [];
  if (r.kind === 'collection' && r.id === app.doc.scene.collection) return [];
  return [{ label: 'Assets', submenu: () => markClearItems(contextTargets(app.context())) }];
});

// Data-block selectors (material, world, node group, …)
idSelectorMenuHooks.push((id) => {
  const table = assetTableOfId(app.doc, id);
  if (!table) return [];
  const targets = encodeTarget(table, id);
  const marked = !!blockOf(app.doc, table, id)?.asset_data;
  return [
    { label: 'Mark as Asset', icon: 'asset_mark', op: 'asset.mark', props: { targets }, disabled: marked },
    { label: 'Clear Asset', op: 'asset.clear', props: { targets, set_fake_user: false }, disabled: !marked },
    { label: 'Clear Asset (Set Fake User)', op: 'asset.clear', props: { targets, set_fake_user: true }, disabled: !marked },
  ];
});

// ---------------------------------------------------------------------------
// node editors: node group assets by catalog

function groupAssetsFor(ed: NodeEditorLike): { e: AssetEntry; path: string }[] {
  const kind: string = ed.treeType() === 'WORLD' ? 'SHADER' : ed.treeType();
  const out: { e: AssetEntry; path: string }[] = [];
  for (const lib of libraries()) {
    const doc = libraryDoc(lib.id);
    if (!doc) continue;
    const cats = libraryCatalogs(lib.id);
    for (const e of listAssets(lib.id)) {
      if (e.table !== 'node_groups') continue;
      const g = doc.node_groups[e.id];
      if (!g || g.tree.type !== kind) continue;
      // a group cannot be added inside itself
      if (lib.id === 'LOCAL' && (e.id === ed.currentGroupId())) continue;
      out.push({ e, path: cats.find((c) => c.id === e.block.asset_data!.catalog_id)?.path ?? '' });
    }
  }
  return out;
}

function addAsset(ed: NodeEditorLike, ref: string, at?: { x: number; y: number }) {
  const p = at ?? app.pointer;
  const [nx, ny] = ed.toNode(p.x, p.y);
  const area = app.hoverArea?.editor === ed ? app.hoverArea : app.activeArea?.editor === ed ? app.activeArea : null;
  const r = app.run('node.add_group_asset', { asset: ref, location: [nx - 70, -ny + 11] }, { invoke: false, area });
  // the new node follows the pointer like other added nodes
  if (r === 'FINISHED') app.run('node.translate_attach', {}, { area });
}

addMenuExtras.push({
  items: (edAny, at) => {
    const ed = nodeEditorOf({ area: { editor: edAny } });
    if (!ed) return [];
    const list = groupAssetsFor(ed);
    if (!list.length) return [];
    const byPath = new Map<string, AssetEntry[]>();
    for (const { e, path } of list) byPath.set(path, [...(byPath.get(path) ?? []), e]);
    // catalogs of all libraries, merged by path, limited to those that hold node groups
    const paths = new Set<string>();
    for (const p of byPath.keys()) for (let q = p; q; q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : '') paths.add(q);
    const tree = catalogTree([...paths].map((p) => ({ id: p, path: p })));
    const entries = (es: AssetEntry[]): MenuItem[] =>
      es
        .sort((a, b) => a.block.name.localeCompare(b.block.name))
        .map((e) => ({ label: e.block.name, icon: 'node_tree', description: e.block.asset_data?.description || undefined, action: () => addAsset(ed, assetRef(e), at) }));
    const sub = (n: CatalogNode): MenuItem => ({
      label: n.name,
      icon: 'asset_catalog',
      submenu: () => [...n.children.map(sub), ...(n.children.length && byPath.get(n.path)?.length ? [{ separator: true }] : []), ...entries(byPath.get(n.path) ?? [])],
    });
    const items = tree.map(sub);
    if (byPath.get('')?.length) items.push({ label: 'Unassigned', icon: 'asset_catalog', submenu: () => entries(byPath.get('') ?? []) });
    return items;
  },
  search: (edAny, at): SearchEntry[] => {
    const ed = nodeEditorOf({ area: { editor: edAny } });
    if (!ed) return [];
    return groupAssetsFor(ed).map(({ e, path }) => ({ label: e.block.name, path: path ? `Assets ▸ ${path.split('/').join(' ▸ ')}` : 'Assets', icon: 'node_tree', run: () => addAsset(ed, assetRef(e), at) }));
  },
});
