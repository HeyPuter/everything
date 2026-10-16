// Asset operators: marking and clearing assets, previews, tags, catalogs, libraries, and using
// assets (adding objects and collections, assigning materials, worlds and actions, adding node
// groups to node trees and as Geometry Nodes modifiers).
import { app, registerOperators, type OpContext } from '../app/app';
import { linkAsset } from '../library/assets';
import { isLinked } from '../library/core';
import type { DocumentData, ID, NodeTreeData, ObjectData } from '../data/types';
import type { TreeType } from '../nodes/types';
import { compatibleGroups, makeNode } from '../nodes/tree';
import { groupIdnameFor } from '../nodes/common';
import { uid } from '../data/defaults';
import { activeCollection } from '../ops/object';
import { newModifier } from '../eval/modifiers';
import { currentOutliner } from '../editors/outliner/current';
import { openMenu, promptText, type MenuItem } from '../ui/menu';
import { download, pickFile, decodeDocument } from '../io/native';
import { openFile, fileEvents } from '../io/files';
import { renderPreview, previewFromFile, previewFromCanvas } from './preview';
import { renderContext } from '../render/context';
import { catalogById, deleteCatalog, newCatalog, renameCatalog, moveCatalog, ensureCatalogPath } from './catalogs';
import { activeBrush } from '../paint/brushes';
import { cloneShared } from '../data/cow';
import {
  LOCAL,
  libraryDoc,
  libraryInfo,
  libraryChanged,
  userLibraries,
  createLibrary,
  deleteLibrary,
  renameLibrary,
  refreshLibrary,
  copyToLibrary,
  removeFromLibrary,
  importLibraryDoc,
  exportLibraryBytes,
  writeLibraryBytes,
  catalogUndoPush,
  catalogUndo,
  canCatalogUndo,
  canCatalogRedo,
  saveLibrary,
  parseAssetRef,
  assetRef,
  findAsset,
  libraryCatalogs,
  type ImportMethod,
} from './library';
import { importAsset, duplicateObjectData, placeObjects, placeCollection, addCollectionInstance } from './importer';
import { browserOf, type AssetBrowserLike } from './state';
import { assetsOf, blockOf, decodeTargets, encodeTarget, isAssetTable, newMetaData, tableOf, type AssetCatalog, type AssetMetaData, type AssetTable } from './types';
import { applyPoseAsset, isPoseAction } from './poselib';

// ---------------------------------------------------------------------------
// targets

/** Data-blocks of the current file an operator acts on: outliner selection, else selected objects. */
export function contextTargets(ctx: OpContext): { table: AssetTable; id: ID }[] {
  const out: { table: AssetTable; id: ID }[] = [];
  const add = (table: string | undefined, id: string | undefined) => {
    if (!table || !id || !isAssetTable(table) || !blockOf(ctx.doc, table, id)) return;
    if (table === 'collections' && id === ctx.doc.scene.collection) return;
    if (!out.some((t) => t.table === table && t.id === id)) out.push({ table, id });
  };
  const b = browserOf(ctx);
  if (b) {
    for (const e of b.selection()) if (e.library === LOCAL) add(e.table, e.id);
    return out;
  }
  if (ctx.area?.type === 'OUTLINER') {
    const ol = currentOutliner(ctx);
    if (ol) {
      const rows = ol.selectedRows();
      const act = ol.rows.find((r) => r.ekey === ol.activeKey);
      for (const r of act && !rows.includes(act) ? [act, ...rows] : rows) {
        if (r.kind === 'object' && r.ob) add('objects', r.ob.id);
        else if (r.kind === 'collection') add('collections', r.id);
        else add(r.table, r.id);
      }
      return out;
    }
  }
  for (const id of ctx.doc.object_order) if (ctx.doc.objects[id]?.select) add('objects', id);
  const act = ctx.doc.scene.active_object;
  if (act && ctx.doc.objects[act] && !out.some((t) => t.id === act) && ctx.doc.mode === 'OBJECT') add('objects', act);
  return out;
}

const targetsProp = { id: 'targets', label: 'Targets', type: 'string' as const, default: '', hidden: true };
const resolveTargets = (ctx: OpContext, p: Record<string, unknown>) => (p.targets ? decodeTargets(String(p.targets)) : contextTargets(ctx)).filter((t) => blockOf(ctx.doc, t.table, t.id));

export const metaOf = (doc: DocumentData, t: { table: string; id: ID }) => blockOf(doc, t.table, t.id)?.asset_data;

/** Mark a data-block of `doc` as an asset (with a rendered preview); false when it already is one. */
export function markAsset(doc: DocumentData, table: AssetTable, id: ID): boolean {
  const b = blockOf(doc, table, id);
  if (!b || b.asset_data) return false;
  b.asset_data = newMetaData();
  // assets are kept in the file even when nothing uses them
  if (table !== 'objects' && table !== 'collections') b.use_fake_user = true;
  const url = renderPreview(doc, table, id);
  if (url) b.asset_data.preview = url;
  return true;
}

export function clearAsset(doc: DocumentData, table: AssetTable, id: ID, setFakeUser: boolean): boolean {
  const b = blockOf(doc, table, id);
  if (!b?.asset_data) return false;
  delete b.asset_data;
  if (table !== 'objects' && table !== 'collections') b.use_fake_user = setFakeUser;
  return true;
}

// ---------------------------------------------------------------------------
// the asset an editing operator acts on (Asset Browser active asset, or explicit)

interface Editable {
  library: string;
  table: AssetTable;
  id: ID;
  meta: AssetMetaData;
  doc: DocumentData;
}

function editableAsset(ctx: OpContext, p: Record<string, unknown> = {}): Editable | null {
  const ref = p.asset ? String(p.asset) : browserOf(ctx)?.active ?? '';
  const e = ref ? findAsset(ref) : null;
  if (!e) return null;
  const info = libraryInfo(e.library);
  const doc = libraryDoc(e.library);
  if (!info?.editable || !doc) return null;
  return { library: e.library, table: e.table, id: e.id, meta: e.block.asset_data!, doc };
}

/** After editing an asset of a library: undo step for the current file, save for user libraries. */
function edited(lib: string) {
  if (lib !== LOCAL) libraryChanged(lib);
}

const assetProp = { id: 'asset', label: 'Asset', type: 'string' as const, default: '', hidden: true };

// ---------------------------------------------------------------------------
// importing

const IMPORT_METHODS: [string, string, string][] = [
  ['FOLLOW_PREFS', 'Follow Library', 'Use the import method set for the asset’s library'],
  ['APPEND', 'Append', 'Copy the asset and everything it uses into this file'],
  ['APPEND_REUSE', 'Append (Reuse Data)', 'Copy the asset, reusing data this file already got from the same library'],
  ['LINK', 'Link', 'Use the asset from its library without copying it: it stays read-only and follows changes to the library'],
];

function methodFor(library: string, setting: unknown): ImportMethod {
  if (setting === 'APPEND' || setting === 'APPEND_REUSE' || setting === 'LINK') return setting;
  return libraryInfo(library)?.import_method ?? 'APPEND';
}

/** The data-block of an asset in the current file (imported first when it lives in another library). */
export function useAsset(doc: DocumentData, ref: string, method: unknown): { table: AssetTable; id: ID; objects: ID[] } | null {
  const r = parseAssetRef(ref);
  if (!r) return null;
  if (r.library === LOCAL) return blockOf(doc, r.table, r.id) ? { table: r.table, id: r.id, objects: [] } : null;
  const src = libraryDoc(r.library);
  if (!src) {
    app.report('WARNING', 'The asset library is still loading');
    return null;
  }
  const m = methodFor(r.library, method);
  if (m === 'LINK') {
    // only user libraries are files that can be linked; built-in assets are appended
    if (libraryInfo(r.library)?.kind === 'USER') {
      const lid = linkAsset(doc, src, r.library, libraryInfo(r.library)!.name, r.table, r.id);
      return lid ? { table: r.table, id: lid, objects: [] } : null;
    }
  }
  const res = importAsset(doc, src, r.library, r.table, r.id, m === 'LINK' ? 'APPEND_REUSE' : m);
  return res ? { table: res.table, id: res.id, objects: res.objects } : null;
}

const importProps = [assetProp, { id: 'import_method', label: 'Import Method', type: 'enum' as const, default: 'FOLLOW_PREFS', items: IMPORT_METHODS }];
const locationProp = { id: 'location', label: 'Location', type: 'vec3' as const, default: null, subtype: 'distance' as const };

const DATA_TABLE: Record<string, string> = { MESH: 'meshes', CURVE: 'curves', FONT: 'curves', META: 'metaballs', GREASEPENCIL: 'grease_pencils' };

/** Put a material into the object's active slot (adding a slot when it has none). */
export function assignMaterial(doc: DocumentData, ob: ObjectData, mat: ID): boolean {
  if (!ob.data) return false;
  const d = tableOf(doc, DATA_TABLE[ob.type] ?? '')?.[ob.data] as unknown as { materials?: (string | null)[] } | undefined;
  if (!d) return false;
  d.materials ??= [];
  if (!d.materials.length) d.materials.push(mat);
  else {
    const i = Math.max(0, Math.min(d.materials.length - 1, ob.active_material_index));
    if (ob.material_slots_link?.[i] === 'OBJECT' && ob.object_materials) ob.object_materials[i] = mat;
    else d.materials[i] = mat;
    ob.active_material_index = i;
  }
  return true;
}

const cursorOr = (doc: DocumentData, p: Record<string, unknown>) => (Array.isArray(p.location) ? (p.location as number[]) : [...doc.scene.cursor.location]);

// ---------------------------------------------------------------------------

registerOperators([
  {
    idname: 'asset.mark',
    label: 'Mark as Asset',
    description: 'Make the selected data-blocks reusable assets, shown in the Asset Browser, with a generated preview',
    props: [targetsProp],
    // explicit targets (data-block selectors) may differ from the context: menus check the context themselves
    poll: (ctx) => !browserOf(ctx),
    invoke: (ctx, p) => {
      p.targets = (p.targets as string) || contextTargets(ctx).map((t) => encodeTarget(t.table, t.id)).join('|');
      return markExec(ctx, p);
    },
    exec: (ctx, p) => markExec(ctx, p),
  },
  {
    idname: 'asset.clear',
    label: 'Clear Asset',
    description: 'Turn the selected assets back into ordinary data-blocks (their metadata and preview are removed)',
    props: [{ id: 'set_fake_user', label: 'Set Fake User', type: 'bool', default: false }, targetsProp],
    poll: (ctx) => !browserOf(ctx) || contextTargets(ctx).length > 0,
    invoke: (ctx, p) => {
      p.targets = (p.targets as string) || contextTargets(ctx).map((t) => encodeTarget(t.table, t.id)).join('|');
      return clearExec(ctx, p);
    },
    exec: (ctx, p) => clearExec(ctx, p),
  },
  {
    idname: 'ed.lib_id_generate_preview',
    label: 'Generate Preview',
    description: 'Render a new preview image for the asset',
    props: [assetProp],
    poll: (ctx) => !!editableAsset(ctx),
    exec: (ctx, p) => {
      const e = editableAsset(ctx, p);
      if (!e) return 'CANCELLED';
      const url = renderPreview(e.doc, e.table, e.id);
      if (!url) {
        app.report('WARNING', 'Nothing to render a preview of');
        return 'CANCELLED';
      }
      e.meta.preview = url;
      e.meta.preview_custom = false;
      edited(e.library);
    },
  },
  {
    idname: 'ed.lib_id_generate_preview_from_object',
    label: 'Render Active Object',
    description: 'Use a render of the active object (and its children) as the asset’s preview',
    props: [assetProp],
    poll: (ctx) => !!editableAsset(ctx) && !!app.activeObject,
    exec: (ctx, p) => {
      const e = editableAsset(ctx, p);
      const ob = app.activeObject;
      if (!e || !ob) return 'CANCELLED';
      const url = renderPreview(app.doc, 'objects', ob.id, ob.id);
      if (!url) {
        app.report('WARNING', 'The active object has no surface to render');
        return 'CANCELLED';
      }
      e.meta.preview = url;
      e.meta.preview_custom = true;
      edited(e.library);
    },
  },
  {
    idname: 'ed.lib_id_remove_preview',
    label: 'Remove Preview',
    description: 'Remove the asset’s preview image (its type icon is shown instead)',
    props: [assetProp],
    poll: (ctx) => !!editableAsset(ctx)?.meta.preview,
    exec: (ctx, p) => {
      const e = editableAsset(ctx, p);
      if (!e?.meta.preview) return 'CANCELLED';
      // empty (not missing): the type icon is shown and no new preview is rendered
      e.meta.preview = '';
      e.meta.preview_custom = false;
      edited(e.library);
    },
  },
  {
    idname: 'ed.lib_id_load_custom_preview',
    label: 'Load Custom Preview',
    description: 'Use an image file as the asset’s preview',
    props: [assetProp],
    undo: false,
    poll: (ctx) => !!editableAsset(ctx),
    exec: (ctx, p) => {
      const e = editableAsset(ctx, p);
      if (!e) return 'CANCELLED';
      void (async () => {
        const f = await pickFile('image/*');
        if (!f) return;
        try {
          const url = await previewFromFile(f);
          const cur = editableAsset(ctx, { asset: `${e.library}|${e.table}:${e.id}` });
          if (!cur) return;
          cur.meta.preview = url;
          cur.meta.preview_custom = true;
          if (cur.library === LOCAL) app.pushUndo('Load Custom Preview');
          edited(cur.library);
          app.changed('doc');
        } catch {
          app.report('ERROR', `Cannot read "${f.name}" as an image`);
        }
      })();
    },
  },
  {
    idname: 'asset.screenshot_preview',
    label: 'Capture Screenshot Preview',
    description: 'Drag a square over a 3D view (or node editor) to use that part of the screen as the asset’s preview',
    props: [assetProp, { id: 'force_square', label: 'Force Square', type: 'bool', default: true }],
    undo: false,
    poll: (ctx) => !!editableAsset(ctx) && !!renderContext,
    exec: (ctx, p) => {
      const e = editableAsset(ctx, p);
      if (!e) return 'CANCELLED';
      const ref = `${e.library}|${e.table}:${e.id}`;
      captureRegion(!!p.force_square, (canvas) => {
        const cur = editableAsset(ctx, { asset: ref });
        if (!cur) return;
        cur.meta.preview = previewFromCanvas(canvas);
        cur.meta.preview_custom = true;
        if (cur.library === LOCAL) app.pushUndo('Capture Screenshot Preview');
        edited(cur.library);
        app.changed('doc');
      });
    },
  },
  {
    idname: 'asset.tag_add',
    label: 'Add Asset Tag',
    description: 'Add a new keyword tag to the active asset',
    props: [assetProp, { id: 'name', label: 'Name', type: 'string', default: 'Tag' }],
    poll: (ctx) => !!editableAsset(ctx),
    exec: (ctx, p) => {
      const e = editableAsset(ctx, p);
      if (!e) return 'CANCELLED';
      const base = String(p.name || 'Tag').trim() || 'Tag';
      let n = base;
      for (let i = 1; e.meta.tags.includes(n); i++) n = `${base}.${String(i).padStart(3, '0')}`;
      e.meta.tags = [...e.meta.tags, n];
      edited(e.library);
    },
  },
  {
    idname: 'asset.tag_remove',
    label: 'Remove Asset Tag',
    description: 'Remove a tag from the active asset',
    props: [assetProp, { id: 'index', label: 'Index', type: 'int', default: -1 }],
    poll: (ctx) => !!editableAsset(ctx)?.meta.tags.length,
    exec: (ctx, p) => {
      const e = editableAsset(ctx, p);
      if (!e?.meta.tags.length) return 'CANCELLED';
      const i = (p.index as number) < 0 ? e.meta.tags.length - 1 : (p.index as number);
      if (i >= e.meta.tags.length) return 'CANCELLED';
      e.meta.tags = e.meta.tags.filter((_, k) => k !== i);
      edited(e.library);
    },
  },
  // ---- catalogs
  {
    idname: 'asset.catalog_new',
    label: 'New Catalog',
    description: 'Add a catalog to the library shown in the Asset Browser',
    props: [{ id: 'parent_path', label: 'Parent Path', type: 'string', default: '' }, { id: 'name', label: 'Name', type: 'string', default: 'Catalog' }],
    poll: (ctx) => catalogEditable(ctx),
    exec: (ctx, p) => catalogEdit(ctx, (cats) => void newCatalog(cats, String(p.parent_path || ''), String(p.name || 'Catalog'))),
  },
  {
    idname: 'asset.catalog_delete',
    label: 'Delete Catalog',
    description: 'Remove a catalog and its sub-catalogs; their assets become unassigned',
    props: [{ id: 'catalog_id', label: 'Catalog ID', type: 'string', default: '' }],
    poll: (ctx) => catalogEditable(ctx),
    exec: (ctx, p) =>
      catalogEdit(ctx, (cats, doc) => {
        const gone = deleteCatalog(cats, String(p.catalog_id));
        if (!gone.size) return false;
        for (const { block } of assetsOf(doc)) if (gone.has(block.asset_data!.catalog_id)) block.asset_data!.catalog_id = '';
        const b = browserOf(ctx);
        if (b?.catalogPath && !cats.some((c) => c.path === b.catalogPath)) b.catalogPath = null;
      }),
  },
  {
    idname: 'asset.catalog_rename',
    label: 'Rename Catalog',
    description: 'Rename a catalog (its sub-catalogs follow)',
    props: [{ id: 'catalog_id', label: 'Catalog ID', type: 'string', default: '' }, { id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: (ctx) => catalogEditable(ctx),
    exec: (ctx, p) =>
      catalogEdit(ctx, (cats) => {
        const b = browserOf(ctx);
        const before = catalogById(cats, String(p.catalog_id))?.path;
        const to = renameCatalog(cats, String(p.catalog_id), String(p.name));
        if (!to) return false;
        if (b && before && b.catalogPath && (b.catalogPath === before || b.catalogPath.startsWith(`${before}/`))) b.catalogPath = to + b.catalogPath.slice(before.length);
      }),
  },
  {
    idname: 'asset.catalog_move',
    label: 'Move Catalog',
    description: 'Move a catalog (and its sub-catalogs) into another catalog',
    props: [{ id: 'catalog_id', label: 'Catalog ID', type: 'string', default: '' }, { id: 'parent_id', label: 'Parent ID', type: 'string', default: '' }],
    poll: (ctx) => catalogEditable(ctx),
    exec: (ctx, p) => catalogEdit(ctx, (cats) => moveCatalog(cats, String(p.catalog_id), String(p.parent_id || ''))),
  },
  {
    idname: 'asset.catalog_assign',
    label: 'Assign to Catalog',
    description: 'Put the selected assets into a catalog (an empty catalog id removes them from their catalog)',
    props: [{ id: 'catalog_id', label: 'Catalog ID', type: 'string', default: '' }, { id: 'assets', label: 'Assets', type: 'string', default: '', hidden: true }],
    poll: (ctx) => catalogEditable(ctx),
    exec: (ctx, p) => {
      const b = browserOf(ctx);
      const refs = p.assets ? String(p.assets).split(',') : [...(b?.selected ?? [])];
      return catalogEdit(ctx, (cats, doc, lib) => {
        const cid = String(p.catalog_id || '');
        if (cid && !catalogById(cats, cid)) return false;
        let n = 0;
        for (const ref of refs) {
          const r = parseAssetRef(ref);
          if (!r || r.library !== lib) continue;
          const m = blockOf(doc, r.table, r.id)?.asset_data;
          if (m) ((m.catalog_id = cid), n++);
        }
        return n > 0;
      });
    },
  },
  {
    idname: 'asset.catalog_undo',
    label: 'Undo Catalog Edits',
    description: 'Undo the last catalog edit of the asset library',
    undo: false,
    poll: (ctx) => {
      const b = browserOf(ctx);
      return !!b && libraryInfo(b.library)?.kind === 'USER' && canCatalogUndo(b.library);
    },
    exec: (ctx) => void catalogUndo(browserOf(ctx)!.library),
  },
  {
    idname: 'asset.catalog_redo',
    label: 'Redo Catalog Edits',
    description: 'Redo the last undone catalog edit of the asset library',
    undo: false,
    poll: (ctx) => {
      const b = browserOf(ctx);
      return !!b && libraryInfo(b.library)?.kind === 'USER' && canCatalogRedo(b.library);
    },
    exec: (ctx) => void catalogUndo(browserOf(ctx)!.library, true),
  },
  {
    idname: 'asset.catalogs_save',
    label: 'Save Asset Catalogs',
    description: 'Write the catalogs of the asset library to storage now (the current file’s catalogs are saved with the file)',
    undo: false,
    poll: (ctx) => {
      const b = browserOf(ctx);
      return !!b && libraryInfo(b.library)?.kind === 'USER';
    },
    exec: (ctx) => {
      const id = browserOf(ctx)!.library;
      void saveLibrary(id, true).then(() => app.report('INFO', `Saved the catalogs of "${libraryInfo(id)?.name}"`));
    },
  },
  // ---- libraries
  {
    idname: 'asset.library_refresh',
    label: 'Refresh Asset Library',
    description: 'Read the asset library again and update its previews',
    undo: false,
    poll: (ctx) => !!browserOf(ctx),
    exec: (ctx) => {
      const b = browserOf(ctx)!;
      const libs = b.library === 'ALL' ? userLibraries().map((l) => l.id) : [b.library];
      void Promise.all(libs.map((l) => refreshLibrary(l))).then(() => b.draw());
    },
  },
  {
    idname: 'asset.library_new',
    label: 'New Asset Library',
    description: 'Create an asset library kept in this browser’s storage',
    undo: false,
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    invoke: (ctx, p) => {
      if (p.name) return newLibraryExec(ctx, String(p.name));
      promptText('New Asset Library', 'User Library', (n) => n && void newLibraryExec(ctx, n));
      return 'CANCELLED';
    },
    exec: (ctx, p) => newLibraryExec(ctx, String(p.name || 'User Library')),
  },
  {
    idname: 'asset.library_rename',
    label: 'Rename Asset Library',
    description: 'Rename the user asset library shown in the Asset Browser',
    undo: false,
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: (ctx) => libraryInfo(browserOf(ctx)?.library ?? '')?.kind === 'USER',
    invoke: (ctx, p) => {
      const id = browserOf(ctx)!.library;
      if (p.name) return void renameLibrary(id, String(p.name));
      promptText('Rename Asset Library', libraryInfo(id)?.name ?? '', (n) => n && void renameLibrary(id, n));
      return 'CANCELLED';
    },
    exec: (ctx, p) => void renameLibrary(browserOf(ctx)!.library, String(p.name)),
  },
  {
    idname: 'asset.library_remove',
    label: 'Delete Asset Library',
    description: 'Delete the user asset library shown in the Asset Browser and all its assets from this browser',
    undo: false,
    props: [{ id: 'confirm', label: 'Confirm', type: 'bool', default: true, hidden: true }],
    poll: (ctx) => libraryInfo(browserOf(ctx)?.library ?? '')?.kind === 'USER',
    exec: (ctx, p) => {
      const b = browserOf(ctx)!;
      const info = libraryInfo(b.library)!;
      if (p.confirm) {
        openMenu([{ heading: `Delete "${info.name}" and its assets?` }, { label: 'Delete Library', icon: 'trash', action: () => app.run('asset.library_remove', { confirm: false }, { area: ctx.area }) }], { x: app.pointer.x, y: app.pointer.y });
        return 'CANCELLED';
      }
      void deleteLibrary(info.id).then(() => {
        b.setLibrary(LOCAL);
        app.report('INFO', `Deleted the asset library "${info.name}"`);
      });
    },
  },
  {
    idname: 'asset.library_import',
    label: 'Import Asset Library',
    description: 'Add the assets of a project file (.p3d) or a .blend file as a new asset library; pick a catalog definition file (.txt) along with a .blend to keep its catalog names',
    undo: false,
    exec: (ctx) => {
      void (async () => {
        const files = await pickFiles('.p3d,.blend,.txt');
        const main = files.find((f) => /\.(p3d|blend)$/i.test(f.name));
        if (!main) {
          if (files.length) app.report('WARNING', 'Pick a .p3d or .blend file');
          return;
        }
        try {
          let doc: DocumentData;
          const bytes = new Uint8Array(await main.arrayBuffer());
          if (/\.blend$/i.test(main.name)) {
            const { readBlend } = await import('../io/blend/convert');
            const { applyCatalogFile } = await import('../io/blend/assets');
            doc = (await readBlend(bytes)).doc;
            const cats = files.find((f) => /\.txt$/i.test(f.name));
            if (cats) applyCatalogFile(doc, await cats.text());
          } else doc = decodeDocument(bytes).doc;
          const { id, count } = await importLibraryDoc(main.name.replace(/\.[^.]+$/, ''), doc);
          browserOf(ctx)?.setLibrary(id);
          app.report(count ? 'INFO' : 'WARNING', count ? `Imported ${count} asset${count === 1 ? '' : 's'} from "${main.name}"` : `"${main.name}" has no assets`);
        } catch (e) {
          app.report('ERROR', `Cannot import "${main.name}": ${e instanceof Error ? e.message : e}`);
        }
      })();
    },
  },
  {
    idname: 'asset.library_export',
    label: 'Export Asset Library',
    description: 'Download the asset library as a project file (it can be opened, or imported as a library elsewhere)',
    undo: false,
    poll: (ctx) => {
      const k = libraryInfo(browserOf(ctx)?.library ?? '')?.kind;
      return k === 'USER' || k === 'ESSENTIALS';
    },
    exec: (ctx) => {
      const id = browserOf(ctx)!.library;
      const bytes = exportLibraryBytes(id);
      if (!bytes) return 'CANCELLED';
      download(bytes, `${libraryInfo(id)?.name ?? 'Library'}.p3d`);
    },
  },
  {
    idname: 'asset.open_containing_blend_file',
    label: 'Open Library File',
    description: 'Open the library holding the active asset as the current file; for user libraries, saving the file (Ctrl S) updates the library',
    undo: false,
    poll: (ctx) => {
      const e = browserOf(ctx)?.activeAsset();
      return !!e && e.library !== LOCAL && !!libraryDoc(e.library);
    },
    exec: (ctx) => {
      const e = browserOf(ctx)!.activeAsset()!;
      const info = libraryInfo(e.library)!;
      const bytes = exportLibraryBytes(e.library);
      if (!bytes) return 'CANCELLED';
      const name = `${info.name}.p3d`;
      void openFile(new File([bytes as Uint8Array<ArrayBuffer>], name), 'open').then(() => {
        if (info.kind !== 'USER') return;
        fileEvents.saveTarget = {
          name,
          write: async (b) => {
            await writeLibraryBytes(info.id, b);
          },
        };
        app.report('INFO', `Opened the library "${info.name}"; save to update it`);
      });
    },
  },
  {
    idname: 'asset.bundle_install',
    label: 'Copy to Asset Library',
    description: 'Copy assets into a user asset library: the assets selected in the Asset Browser, or all assets of the current file',
    undo: false,
    props: [{ id: 'asset_library_reference', label: 'Library', type: 'string', default: '' }, targetsProp, { id: 'assets', label: 'Assets', type: 'string', default: '', hidden: true }],
    poll: (ctx) => assetsOf(ctx.doc).length > 0 || !!browserOf(ctx)?.selection().length,
    invoke: (ctx, p) => {
      if (!p.targets && !p.assets) {
        const sel = browserOf(ctx)?.selection() ?? [];
        if (sel.length) p.assets = sel.map((e) => assetRef(e)).join(',');
        else p.targets = assetsOf(ctx.doc).map(({ table, block }) => encodeTarget(table, block.id)).join('|');
      }
      if (p.asset_library_reference) return bundleExec(ctx, p);
      const items: MenuItem[] = [
        { heading: 'Copy to Library' },
        ...userLibraries().map((l) => ({ label: l.name, icon: 'asset_library', action: () => app.run('asset.bundle_install', { ...p, asset_library_reference: l.id }, { area: ctx.area }) })),
        { separator: true },
        {
          label: 'New Library…',
          icon: 'add',
          action: () =>
            promptText('New Asset Library', 'User Library', (n) => {
              if (!n) return;
              void createLibrary(n).then((id) => app.run('asset.bundle_install', { ...p, asset_library_reference: id }, { area: ctx.area }));
            }),
        },
      ];
      openMenu(items, { x: app.pointer.x, y: app.pointer.y });
      return 'CANCELLED';
    },
    exec: (ctx, p) => bundleExec(ctx, p),
  },
  {
    idname: 'asset.library_remove_assets',
    label: 'Remove from Library',
    description: 'Delete the selected assets from their user library',
    undo: false,
    poll: (ctx) => {
      const b = browserOf(ctx);
      return !!b?.selection().some((e) => libraryInfo(e.library)?.kind === 'USER');
    },
    exec: (ctx) => {
      const b = browserOf(ctx)!;
      let n = 0;
      for (const lib of new Set(b.selection().map((e) => e.library))) {
        if (libraryInfo(lib)?.kind !== 'USER') continue;
        catalogUndoPush(lib);
        n += removeFromLibrary(lib, b.selection().filter((e) => e.library === lib));
      }
      b.selected.clear();
      b.active = null;
      b.draw();
      app.report('INFO', `Removed ${n} asset${n === 1 ? '' : 's'}`);
    },
  },
  // ---- using assets
  {
    idname: 'object.add_named',
    label: 'Add Object',
    description: 'Add an object asset to the scene (a copy of it, at the drop point)',
    props: [...importProps, locationProp],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const r = parseAssetRef(String(p.asset));
      if (!r || r.table !== 'objects') return 'CANCELLED';
      const doc = ctx.doc;
      const loc = cursorOr(doc, p);
      p.location = loc;
      if (r.library === LOCAL) {
        const nid = duplicateObjectData(doc, r.id);
        if (!nid) return 'CANCELLED';
        placeObjects(doc, [nid], activeCollection(doc), loc);
        return 'FINISHED';
      }
      const res = useAsset(doc, String(p.asset), p.import_method);
      if (!res) return 'CANCELLED';
      // linked objects stay where their library has them
      placeObjects(doc, [res.id, ...res.objects], activeCollection(doc), isLinked(doc.objects[res.id]) ? undefined : loc);
    },
  },
  {
    idname: 'object.collection_external_asset_drop',
    label: 'Add Collection',
    description: 'Add a collection asset to the scene, as an instance or as a copy of its objects',
    props: [...importProps, locationProp, { id: 'use_instance', label: 'Instance', type: 'bool', default: true }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const r = parseAssetRef(String(p.asset));
      if (!r || r.table !== 'collections') return 'CANCELLED';
      const doc = ctx.doc;
      const loc = cursorOr(doc, p);
      p.location = loc;
      const res = useAsset(doc, String(p.asset), p.import_method);
      if (!res) return 'CANCELLED';
      if (r.library === LOCAL || p.use_instance) addCollectionInstance(doc, res.id, activeCollection(doc), loc);
      else if (isLinked(doc.collections[res.id])) {
        // a linked collection cannot be moved: it is added as it is
        const into = doc.collections[activeCollection(doc)] ?? doc.collections[doc.scene.collection];
        if (!into.children.includes(res.id)) into.children.push(res.id);
      } else placeCollection(doc, res.id, activeCollection(doc), loc);
    },
  },
  {
    idname: 'object.drop_named_material',
    label: 'Drop Named Material on Object',
    description: 'Put a material asset into the active material slot of an object',
    props: [...importProps, { id: 'object', label: 'Object', type: 'string', default: '', hidden: true }, { id: 'slot', label: 'Slot', type: 'int', default: -1, hidden: true }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' || ctx.doc.mode === 'EDIT',
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const obs = p.object ? [doc.objects[String(p.object)]].filter(Boolean) : app.selectedObjects();
      if ((p.slot as number) >= 0 && obs[0]) obs[0].active_material_index = p.slot as number;
      if (!obs.length) {
        app.report('WARNING', 'No object to put the material on');
        return 'CANCELLED';
      }
      const res = useAsset(doc, String(p.asset), p.import_method);
      if (!res || res.table !== 'materials') return 'CANCELLED';
      let n = 0;
      for (const ob of obs) if (assignMaterial(doc, ob, res.id)) n++;
      if (!n) {
        app.report('WARNING', 'The object cannot have materials');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'object.drop_geometry_nodes',
    label: 'Drop Geometry Node Group on Object',
    description: 'Add a Geometry Nodes modifier using a node group asset to an object',
    props: [...importProps, { id: 'object', label: 'Object', type: 'string', default: '', hidden: true }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const ob = p.object ? doc.objects[String(p.object)] : app.activeObject;
      if (!ob || (ob.type !== 'MESH' && ob.type !== 'CURVE' && ob.type !== 'POINTCLOUD')) {
        app.report('WARNING', 'Drop the node group on a mesh or curve object');
        return 'CANCELLED';
      }
      const res = useAsset(doc, String(p.asset), p.import_method);
      const g = res ? doc.node_groups[res.id] : undefined;
      if (!g || g.tree.type !== 'GEOMETRY') return 'CANCELLED';
      const m = newModifier('NODES', uid('md'), ob.modifiers);
      (m as unknown as { node_group: string }).node_group = g.id;
      m.name = g.name;
      ob.modifiers.push(m);
      doc.scene.active_object = ob.id;
    },
  },
  {
    idname: 'node.add_group_asset',
    label: 'Add Node Group Asset',
    description: 'Add a node group asset to the node tree as a group node',
    props: [...importProps, { id: 'location', label: 'Location', type: 'vec2', default: [0, 0] }],
    poll: (ctx) => !!nodeEditorOf(ctx)?.tree(),
    exec: (ctx, p) => {
      const ed = nodeEditorOf(ctx)!;
      const r = parseAssetRef(String(p.asset));
      if (!r || r.table !== 'node_groups') return 'CANCELLED';
      const src = libraryDoc(r.library);
      const g0 = src?.node_groups[r.id];
      const kind: string = ed.treeType() === 'WORLD' ? 'SHADER' : ed.treeType();
      if (!g0 || g0.tree.type !== kind) {
        app.report('WARNING', `"${g0?.name ?? 'The node group'}" does not fit in this node tree`);
        return 'CANCELLED';
      }
      const res = useAsset(ctx.doc, String(p.asset), p.import_method);
      if (!res) return 'CANCELLED';
      const loc = (p.location as number[]) ?? [0, 0];
      return addGroupNode(ed, res.id, [loc[0], loc[1]]) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'world.drop_named',
    label: 'Use World Asset',
    description: 'Make a world asset the scene’s world',
    props: importProps,
    exec: (ctx, p) => {
      const res = useAsset(ctx.doc, String(p.asset), p.import_method);
      if (!res || res.table !== 'worlds') return 'CANCELLED';
      ctx.doc.scene.world = res.id;
    },
  },
  {
    idname: 'anim.action_asset_assign',
    label: 'Assign Action Asset',
    description: 'Apply a pose asset to the selected bones, or make an action asset the animation of the selected objects',
    props: [...importProps, { id: 'object', label: 'Object', type: 'string', default: '', hidden: true }, { id: 'blend_factor', label: 'Blend Factor', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' }],
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const r = parseAssetRef(String(p.asset));
      const src = r ? libraryDoc(r.library) : null;
      const act0 = r && src ? src.actions[r.id] : undefined;
      if (!act0) return 'CANCELLED';
      const target = p.object ? doc.objects[String(p.object)] : app.activeObject;
      if (isPoseAction(act0) && target?.type === 'ARMATURE') {
        // poses apply directly; the action is not copied into the file
        return applyPoseAsset(doc, target, act0, (p.blend_factor as number) ?? 1) ? 'FINISHED' : 'CANCELLED';
      }
      const obs = p.object ? [target].filter(Boolean) as ObjectData[] : app.selectedObjects();
      if (!obs.length) {
        app.report('WARNING', 'Select an object to animate');
        return 'CANCELLED';
      }
      const res = useAsset(doc, String(p.asset), p.import_method);
      if (!res) return 'CANCELLED';
      for (const ob of obs) {
        ob.animation_data ??= { action: null, nla_tracks: [], drivers: [] };
        ob.animation_data.action = res.id;
      }
    },
  },
  {
    idname: 'brush.asset_activate',
    label: 'Activate Brush Asset',
    description: 'Make a brush asset the active brush of its paint mode (the brush is added to the file first)',
    props: importProps,
    poll: (ctx) => ['SCULPT', 'VERTEX_PAINT', 'WEIGHT_PAINT', 'TEXTURE_PAINT'].includes(ctx.doc.mode),
    exec: (ctx, p) => {
      const r = parseAssetRef(String(p.asset));
      const src = r ? libraryDoc(r.library) : null;
      const b0 = r && src ? src.brushes[r.id] : undefined;
      if (!b0) return 'CANCELLED';
      if (b0.mode !== ctx.doc.mode) {
        app.report('WARNING', `"${b0.name}" is a ${b0.mode.toLowerCase().replace('_', ' ')} brush`);
        return 'CANCELLED';
      }
      const res = useAsset(ctx.doc, String(p.asset), p.import_method);
      if (!res) return 'CANCELLED';
      app.run('paint.brush_select', { brush: res.id });
    },
  },
  {
    idname: 'brush.asset_save_as',
    label: 'Save as Brush Asset',
    description: 'Store a copy of the active brush, with its settings, as a brush asset of the current file or of a user library',
    props: [
      { id: 'name', label: 'Name', type: 'string', default: '' },
      { id: 'asset_library_reference', label: 'Library', type: 'string', default: 'LOCAL' },
      { id: 'catalog_path', label: 'Catalog', type: 'string', default: '' },
    ],
    poll: (ctx) => !!activeBrush(ctx.doc.mode as never),
    invoke: (ctx, p) => {
      if (p.name) return saveBrushExec(ctx, p);
      const b = activeBrush(ctx.doc.mode as never)!;
      promptText('Save as Brush Asset', `${b.name} Copy`.replace(/^Paint /, ''), (n) => n && app.run('brush.asset_save_as', { ...p, name: n }, { invoke: false, area: ctx.area }));
      return 'CANCELLED';
    },
    exec: (ctx, p) => saveBrushExec(ctx, p),
  },
  {
    idname: 'asset.activate',
    label: 'Use Asset',
    description: 'Use the active asset: add objects and collections at the 3D cursor, put materials on the selected objects, set worlds, apply poses and actions, add node groups to the active object',
    undo: false,
    poll: (ctx) => !!browserOf(ctx)?.activeAsset(),
    exec: (ctx) => {
      const b = browserOf(ctx)!;
      const e = b.activeAsset()!;
      activateAsset(b, e.library, e.table, e.id);
    },
  },
]);

/** Double-click / Enter on an asset. */
export function activateAsset(b: AssetBrowserLike, library: string, table: AssetTable, id: ID) {
  const ref = `${library}|${table}:${id}`;
  const props = { asset: ref, import_method: b.importMethod };
  const run = (op: string, extra: Record<string, unknown> = {}) => app.run(op, { ...props, ...extra }, { invoke: false });
  switch (table) {
    case 'objects':
      return run('object.add_named');
    case 'collections':
      return run('object.collection_external_asset_drop', { use_instance: b.instanceCollections });
    case 'materials':
      return run('object.drop_named_material');
    case 'worlds':
      return run('world.drop_named');
    case 'actions':
      return run('anim.action_asset_assign');
    case 'node_groups': {
      const g = libraryDoc(library)?.node_groups[id];
      if (g?.tree.type === 'GEOMETRY') return run('object.drop_geometry_nodes');
      app.report('INFO', 'Drag the node group into a node editor, or add it from the editor’s Add menu');
      return;
    }
    case 'brushes':
      return run('brush.asset_activate');
  }
}

export interface NodeEditorLike {
  tree(): NodeTreeData | null;
  treeType(): TreeType;
  currentGroupId(): string | undefined;
  toNode(clientX: number, clientY: number): [number, number];
  render(): void;
}
export function nodeEditorOf(ctx: { area: { editor: unknown } | null }): NodeEditorLike | null {
  const ed = ctx.area?.editor as Partial<NodeEditorLike> | undefined;
  return ed && typeof ed.tree === 'function' && typeof ed.treeType === 'function' && typeof ed.toNode === 'function' ? (ed as NodeEditorLike) : null;
}

/** Add a group node for a node group of the current file to a node editor's tree. */
function addGroupNode(ed: NodeEditorLike, groupId: ID, location: [number, number]): boolean {
  const tree = ed.tree();
  const g = app.doc.node_groups[groupId];
  if (!tree || !g) return false;
  if (!compatibleGroups(app.doc, ed.treeType(), ed.currentGroupId()).includes(g)) {
    app.report('WARNING', `"${g.name}" cannot be used in this node tree`);
    return false;
  }
  const n = makeNode(tree, groupIdnameFor(ed.treeType()), location, { node_tree: g.id });
  if (g.tree.default_group_node_width) n.width = g.tree.default_group_node_width;
  for (const o of tree.nodes) o.select = false;
  n.select = true;
  tree.nodes.push(n);
  tree.active_node = n.id;
  return true;
}

function markExec(ctx: OpContext, p: Record<string, unknown>) {
  const ts = resolveTargets(ctx, p);
  let n = 0;
  for (const t of ts) if (markAsset(ctx.doc, t.table, t.id)) n++;
  if (!n) {
    app.report('WARNING', ts.length ? 'The selected data-blocks are assets already' : 'Nothing selected that can be an asset');
    return 'CANCELLED' as const;
  }
  app.report('INFO', n === 1 ? `Marked "${blockOf(ctx.doc, ts[0].table, ts[0].id)!.name}" as an asset` : `Marked ${n} data-blocks as assets`);
  return 'FINISHED' as const;
}

function clearExec(ctx: OpContext, p: Record<string, unknown>) {
  const ts = resolveTargets(ctx, p);
  let n = 0;
  for (const t of ts) if (clearAsset(ctx.doc, t.table, t.id, !!p.set_fake_user)) n++;
  if (!n) return 'CANCELLED' as const;
  const b = browserOf(ctx);
  if (b) {
    b.selected.clear();
    b.active = null;
  }
  app.report('INFO', n === 1 ? 'Cleared 1 asset' : `Cleared ${n} assets`);
  return 'FINISHED' as const;
}

function catalogEditable(ctx: OpContext) {
  const b = browserOf(ctx);
  return !!b && !!libraryInfo(b.library)?.editable && !!libraryDoc(b.library);
}

/** Run a catalog edit on the browser's library (undo step for the current file, catalog history for user libraries). */
function catalogEdit(ctx: OpContext, fn: (cats: ReturnType<typeof libraryCatalogs>, doc: DocumentData, lib: string) => boolean | void) {
  const b = browserOf(ctx);
  const lib = b?.library ?? '';
  const doc = libraryDoc(lib);
  if (!doc || !libraryInfo(lib)?.editable) return 'CANCELLED' as const;
  if (lib !== LOCAL) catalogUndoPush(lib);
  const r = fn((doc.asset_catalogs ??= []), doc, lib);
  if (r === false) return 'CANCELLED' as const;
  if (lib !== LOCAL) {
    libraryChanged(lib);
    b?.draw();
    // user library edits have their own history; the file is unchanged
    return 'CANCELLED' as const;
  }
  b?.draw();
  return 'FINISHED' as const;
}

function newLibraryExec(ctx: OpContext, name: string) {
  void createLibrary(name).then((id) => {
    browserOf(ctx)?.setLibrary(id);
    app.report('INFO', `Created the asset library "${libraryInfo(id)?.name}"`);
  });
  return 'FINISHED' as const;
}

function bundleExec(ctx: OpContext, p: Record<string, unknown>) {
  const lib = String(p.asset_library_reference);
  const info = libraryInfo(lib);
  if (info?.kind !== 'USER') {
    app.report('ERROR', 'Pick a user asset library to copy to');
    return 'CANCELLED' as const;
  }
  const done = (n: number) => app.report(n ? 'INFO' : 'WARNING', n ? `Copied ${n} asset${n === 1 ? '' : 's'} to "${info.name}"` : 'No assets to copy');
  if (p.assets) {
    // assets of any library, copied library by library
    const bySource = new Map<string, { table: AssetTable; id: ID }[]>();
    for (const ref of String(p.assets).split(',')) {
      const r = parseAssetRef(ref);
      if (r && r.library !== lib) bySource.set(r.library, [...(bySource.get(r.library) ?? []), { table: r.table, id: r.id }]);
    }
    void (async () => {
      let n = 0;
      for (const [src, ts] of bySource) {
        const doc = libraryDoc(src);
        if (doc) n += await copyToLibrary(lib, ts, doc);
      }
      done(n);
    })();
    return 'FINISHED' as const;
  }
  const ts = p.targets ? decodeTargets(String(p.targets)) : assetsOf(ctx.doc).map(({ table, block }) => ({ table, id: block.id }));
  void copyToLibrary(lib, ts).then(done);
  return 'FINISHED' as const;
}

/** Let the user drag a rectangle over the screen; the shared 3D canvas under it is passed on. */
function captureRegion(square: boolean, done: (c: HTMLCanvasElement) => void) {
  const engine = renderContext?.engine;
  if (!engine) return;
  const layer = document.createElement('div');
  layer.className = 'ab-capture';
  const box = document.createElement('div');
  box.className = 'ab-capture-box';
  const hint = document.createElement('div');
  hint.className = 'ab-capture-hint';
  hint.textContent = 'Drag over a 3D view to capture the preview · Esc cancels';
  layer.append(box, hint);
  document.body.append(layer);
  let start: { x: number; y: number } | null = null;
  const rect = (e: PointerEvent) => {
    let w = e.clientX - start!.x,
      h = e.clientY - start!.y;
    if (square) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    return { x: Math.min(start!.x, start!.x + w), y: Math.min(start!.y, start!.y + h), w: Math.abs(w), h: Math.abs(h) };
  };
  const close = () => {
    layer.remove();
    removeEventListener('keydown', key, true);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  layer.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY };
    layer.setPointerCapture(e.pointerId);
  });
  layer.addEventListener('pointermove', (e) => {
    if (!start) return;
    const r = rect(e);
    Object.assign(box.style, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  });
  layer.addEventListener('pointerup', (e) => {
    if (!start) return;
    const r = rect(e);
    close();
    if (r.w < 4 || r.h < 4) return;
    engine.drawAll();
    const base = engine.canvas.getBoundingClientRect();
    const dpr = engine.dpr;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(r.w * dpr));
    out.height = Math.max(1, Math.round(r.h * dpr));
    out.getContext('2d')!.drawImage(engine.canvas, (r.x - base.left) * dpr, (r.y - base.top) * dpr, out.width, out.height, 0, 0, out.width, out.height);
    done(out);
  });
  addEventListener('keydown', key, true);
}

/** Let the user pick one or more files. */
function pickFiles(accept: string): Promise<File[]> {
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = accept;
    input.onchange = () => res(Array.from(input.files ?? []));
    input.addEventListener('cancel', () => res([]));
    input.click();
  });
}

function saveBrushExec(ctx: OpContext, p: Record<string, unknown>) {
  const src = activeBrush(ctx.doc.mode as never);
  if (!src) return 'CANCELLED' as const;
  const lib = String(p.asset_library_reference || LOCAL);
  const b = cloneShared(src) as typeof src & { asset_data?: AssetMetaData };
  b.id = uid('br');
  const base = String(p.name || src.name).trim() || src.name;
  const taken = new Set(Object.values(ctx.doc.brushes).map((x) => x.name));
  b.name = base;
  for (let i = 1; taken.has(b.name); i++) b.name = `${base}.${String(i).padStart(3, '0')}`;
  b.asset_data = newMetaData();
  const url = renderPreview({ brushes: { [b.id]: b } } as unknown as DocumentData, 'brushes', b.id);
  if (url) b.asset_data.preview = url;
  if (lib === LOCAL) {
    if (p.catalog_path) b.asset_data.catalog_id = ensureCatalogPath((ctx.doc.asset_catalogs ??= []), String(p.catalog_path));
    ctx.doc.brushes[b.id] = b;
    app.report('INFO', `Saved the brush asset "${b.name}"`);
    return 'FINISHED' as const;
  }
  if (libraryInfo(lib)?.kind !== 'USER') return 'CANCELLED' as const;
  // straight into the user library: a scratch document holds the brush while it is copied
  const tmp = { brushes: { [b.id]: b }, asset_catalogs: [] as AssetCatalog[], scene: { collection: '', world: null } } as unknown as DocumentData;
  if (p.catalog_path) b.asset_data.catalog_id = ensureCatalogPath(tmp.asset_catalogs!, String(p.catalog_path));
  void copyToLibrary(lib, [{ table: 'brushes', id: b.id }], tmp).then((n) => n && app.report('INFO', `Saved the brush asset "${b.name}" to "${libraryInfo(lib)?.name}"`));
  return 'CANCELLED' as const;
}
