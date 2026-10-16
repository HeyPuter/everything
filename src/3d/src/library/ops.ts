// Operators for linked data: File ▸ Link… / Append…, reloading and relocating libraries and
// linked data-blocks, Make Local, library overrides, packing library files into the project and
// dropping project files onto the window.
import { app, registerOperators, type OpContext, type Operator } from '../app/app';
import type { DocumentData, ID } from '../data/types';
import { activeCollection } from '../ops/object';
import { openMenu, type MenuItem } from '../ui/menu';
import { openFile } from '../io/files';
import { openLibraryBrowser, typeLabel, type BrowseResult, type FileRef } from './browser';
import {
  appendFromDoc,
  clearOverrides,
  deleteLibrary,
  dropUnusedLibraries,
  hierarchyOf,
  isLinked,
  isOverride,
  libraries,
  linkFromDoc,
  linkedRecords,
  lockLinked,
  makeLocal,
  makeLocalTargets,
  makeOverride,
  recordOf,
  remapLocalUsers,
  resetOverrides,
  tableOfId,
  tablesOf,
  type LinkResult,
  type Pick,
} from './core';
import { cachedInfo, cachedSource, isLibraryFile, libraryBytes, libraryFor, reloadLibraries, reportReload } from './runtime';
import { fingerprint, putStored, getStored } from './store';
import type { LibraryData, LinkableID } from './types';

// ---------------------------------------------------------------------------
// link / append

const LINK_OPTIONS: [string, string, string][] = [
  ['autoselect', 'Select', 'Select the new objects'],
  ['active_collection', 'Active Collection', 'Put new objects into the active collection (else the scene collection)'],
  ['instance_collections', 'Instance Collections', 'Add collections through an Empty that instances them, instead of adding them to the scene'],
  ['instance_object_data', 'Instance Object Data', 'Add an object for picked object data (meshes, curves, lights…)'],
];
const APPEND_OPTIONS: [string, string, string][] = [
  ...LINK_OPTIONS,
  ['set_fake', 'Fake User', 'Keep the appended data-blocks in the file even when nothing uses them'],
  ['use_recursive', 'Localize All', 'Also make local the data the other file itself links from further files'],
  ['do_reuse_local_id', 'Reuse Local Data', 'Use data-blocks appended from the same file before instead of making new copies'],
  ['clear_asset_data', 'Clear Asset Data', 'Appended data-blocks are no longer marked as assets'],
];

const boolProp = (id: string, label: string, def: boolean) => ({ id, label, type: 'bool' as const, default: def });
const fileProps = [
  { id: 'filepath', label: 'File', type: 'string' as const, default: '', hidden: true },
  { id: 'files', label: 'Data-Blocks', type: 'string' as const, default: '', hidden: true },
];

/** "objects/Cube|materials/Red" → table/name pairs. */
export function parseFiles(s: string): { table: string; name: string }[] {
  return s
    .split('|')
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf('/');
      return { table: x.slice(0, i), name: x.slice(i + 1) };
    });
}
export const formatFiles = (items: { table: string; name: string }[]) => items.map((x) => `${x.table}/${x.name}`).join('|');

/** Source ids of picked data-blocks (by table and name). */
function resolvePicks(src: DocumentData, items: { table: string; name: string }[]): Pick[] {
  const t = tablesOf(src);
  const out: Pick[] = [];
  for (const it of items) {
    const rec = Object.values(t[it.table] ?? {}).find((x) => x.name === it.name && !x.library && x.id !== src.scene.collection);
    if (rec) out.push({ table: it.table, id: rec.id });
  }
  return out;
}

function selectPlaced(doc: DocumentData, ids: ID[]) {
  const obs = ids.filter((id) => doc.objects[id]);
  if (!obs.length) return;
  for (const o of Object.values(doc.objects)) o.select = false;
  for (const id of obs) doc.objects[id].select = true;
  doc.scene.active_object = obs[0];
}

function linkExec(ctx: OpContext, p: Record<string, unknown>, link: boolean) {
  const key = String(p.filepath ?? '');
  const src = cachedSource(key);
  const info = cachedInfo(key);
  if (!src || !info?.entry) {
    app.report('ERROR', 'The library file is not loaded; open it from the Link or Append dialog');
    return 'CANCELLED' as const;
  }
  const items = parseFiles(String(p.files ?? ''));
  const picks = resolvePicks(src, items);
  if (!picks.length) {
    app.report('WARNING', 'None of the data-blocks were found in the file');
    return 'CANCELLED' as const;
  }
  const doc = ctx.doc;
  const into = p.active_collection ? activeCollection(doc) : doc.scene.collection;
  const opts = { into, instance_collections: !!p.instance_collections, instance_object_data: !!p.instance_object_data, location: [...doc.scene.cursor.location] as [number, number, number] };
  let res: LinkResult;
  let lib: LibraryData | null = null;
  if (link) {
    lib = libraryFor(doc, info.entry);
    res = linkFromDoc(doc, src, lib, picks, opts);
    libraries(doc)[lib.id].revision = info.fp;
  } else res = appendFromDoc(doc, src, picks, { ...opts, key, use_recursive: !!p.use_recursive, do_reuse_local_id: !!p.do_reuse_local_id, set_fake: !!p.set_fake, clear_asset_data: !!p.clear_asset_data });
  lockLinked(doc);
  if (p.autoselect) selectPlaced(doc, res.placed);
  const n = Object.values(res.added).reduce((a, l) => a + l.length, 0);
  const what = picks.length === 1 ? `"${items.find((x) => x.table === picks[0].table)?.name ?? ''}"` : `${picks.length} data-blocks`;
  app.report('INFO', `${link ? 'Linked' : 'Appended'} ${what} from "${info.entry.name}"${n > picks.length ? ` (${n} with what they use)` : ''}`);
  app.changed('doc', 'select');
  return 'FINISHED' as const;
}

function browseFor(link: boolean, p: Record<string, unknown>, at?: FileRef) {
  const opts = link ? LINK_OPTIONS : APPEND_OPTIONS;
  const values = Object.fromEntries(opts.map(([k]) => [k, !!p[k]]));
  openLibraryBrowser(
    {
      mode: link ? 'LINK' : 'APPEND',
      options: opts,
      values,
      done: (r: BrowseResult) => void app.run(link ? 'wm.link' : 'wm.append', { ...r.options, filepath: r.entry.key, files: formatFiles(r.items) }, { invoke: false }),
    },
    at,
  );
}

/** Link or append from a file the user dropped or opened elsewhere (opens the browser in it). */
export function browseFile(link: boolean, ref: FileRef) {
  const op = link ? 'wm.link' : 'wm.append';
  const defaults = Object.fromEntries((link ? LINK_OPTIONS : APPEND_OPTIONS).map(([k]) => [k, k === 'instance_collections' ? link : k !== 'set_fake' && k !== 'do_reuse_local_id' && k !== 'clear_asset_data']));
  if (!app.poll(op)) return void app.report('WARNING', 'Linking and appending work in Object Mode');
  browseFor(link, defaults, ref);
}

const objectMode = (ctx: OpContext) => ctx.doc.mode === 'OBJECT';

// ---------------------------------------------------------------------------
// library helpers

/** A library by id or name (default: the only one, if there is exactly one). */
function libraryArg(doc: DocumentData, v: unknown): LibraryData | null {
  const libs = Object.values(libraries(doc));
  if (!v) return libs.length === 1 ? libs[0] : null;
  return libs.find((l) => l.id === v || l.name === v) ?? null;
}

async function reloadAndCommit(ids: ID[] | undefined, label: string) {
  const sum = await reloadLibraries(ids, { force: true, prompt: true });
  if (sum.reloaded.length) {
    app.pushUndo(label);
    app.changed('doc', 'select');
  }
  reportReload(sum);
}

function relocate(lib: LibraryData, r: BrowseResult) {
  const doc = app.doc;
  const cur = libraries(doc)[lib.id];
  if (!cur) return;
  const other = Object.values(libraries(doc)).find((l) => l.id !== lib.id && l.source.key === r.entry.key);
  if (other) {
    app.report('WARNING', `"${r.entry.name}" is already linked as library "${other.name}"`);
    return;
  }
  Object.assign(cur, { name: r.entry.name, filepath: r.entry.path, source: { kind: r.entry.recentName ? 'recent' : r.entry.handle ? 'handle' : 'copy', key: r.entry.key }, packed_file: null, revision: undefined, is_missing: false });
  void reloadAndCommit([lib.id], 'Relocate Library');
}

/** Relocate one linked data-block: link another one (any file) and switch local users to it. */
function relocateId(doc: DocumentData, oldId: ID, src: DocumentData, entry: NonNullable<ReturnType<typeof cachedInfo>>['entry'], item: { table: string; name: string }): boolean {
  const table = tableOfId(doc, oldId);
  const picks = resolvePicks(src, [item]);
  if (!table || !picks.length || !entry) return false;
  const lib = libraryFor(doc, entry);
  const res = linkFromDoc(doc, src, lib, picks, {});
  const nid = res.picked[0].id;
  // the new one only replaces the old in local users; the linking above must not place it
  const master = doc.collections[doc.scene.collection];
  if (table === 'objects') master.objects = master.objects.filter((x) => x !== nid || Object.values(doc.collections).some((c) => c !== master && c.objects.includes(oldId)));
  remapLocalUsers(doc, new Map([[oldId, nid]]));
  // the old one goes when nothing linked uses it
  if (!linkedRecords(doc).some(({ rec }) => rec.id !== oldId && JSON.stringify(rec).includes(`"${oldId}"`))) {
    delete tablesOf(doc)[table][oldId];
    doc.object_order = doc.object_order.filter((x) => x !== oldId);
  }
  dropUnusedLibraries(doc);
  lockLinked(doc);
  return true;
}

// ---------------------------------------------------------------------------
// overrides

/** Linked collection (with the instancer) or object a "Make Library Override" acts on. */
function overrideTarget(doc: DocumentData, ob: ReturnType<typeof app.selectedObjects>[number] | null): { table: string; id: ID; instancer?: ID } | null {
  if (!ob) return null;
  if (!isLinked(ob) && ob.instance_type === 'COLLECTION' && ob.instance_collection && isLinked(doc.collections[ob.instance_collection])) return { table: 'collections', id: ob.instance_collection, instancer: ob.id };
  if (!isLinked(ob)) return null;
  // a linked object inside a linked collection of the scene: override the whole collection
  const master = doc.collections[doc.scene.collection];
  const top = master.children.find((c) => isLinked(doc.collections[c]) && collectionHolds(doc, c, ob.id));
  return top ? { table: 'collections', id: top } : { table: 'objects', id: ob.id };
}

function collectionHolds(doc: DocumentData, cid: ID, obId: ID, depth = 0): boolean {
  const c = doc.collections[cid];
  if (!c || depth > 64) return false;
  return c.objects.includes(obId) || c.children.some((ch) => collectionHolds(doc, ch, obId, depth + 1));
}

const selectedOverrides = (ctx: OpContext) => app.selectedObjects().filter((o) => isOverride(o));

// ---------------------------------------------------------------------------

const ops: Operator[] = [
  {
    idname: 'wm.link',
    label: 'Link',
    description: 'Use objects, collections, materials and other data of another project file without copying them: they stay read-only and follow changes to that file',
    icon: 'link',
    props: [...fileProps, boolProp('autoselect', 'Select', true), boolProp('active_collection', 'Active Collection', true), boolProp('instance_collections', 'Instance Collections', true), boolProp('instance_object_data', 'Instance Object Data', true)],
    poll: objectMode,
    invoke: (_ctx, p) => {
      if (p.filepath && p.files) return linkExec(_ctx, p, true);
      browseFor(true, p);
      return 'CANCELLED';
    },
    exec: (ctx, p) => linkExec(ctx, p, true),
  },
  {
    idname: 'wm.append',
    label: 'Append',
    description: 'Copy objects, collections, materials and other data from another project file into this one',
    icon: 'append_blend',
    props: [
      ...fileProps,
      boolProp('autoselect', 'Select', true),
      boolProp('active_collection', 'Active Collection', true),
      boolProp('instance_collections', 'Instance Collections', false),
      boolProp('instance_object_data', 'Instance Object Data', true),
      boolProp('set_fake', 'Fake User', false),
      boolProp('use_recursive', 'Localize All', true),
      boolProp('do_reuse_local_id', 'Reuse Local Data', false),
      boolProp('clear_asset_data', 'Clear Asset Data', false),
    ],
    poll: objectMode,
    invoke: (_ctx, p) => {
      if (p.filepath && p.files) return linkExec(_ctx, p, false);
      browseFor(false, p);
      return 'CANCELLED';
    },
    exec: (ctx, p) => linkExec(ctx, p, false),
  },
  {
    idname: 'wm.lib_reload',
    label: 'Reload Library',
    description: 'Read a linked library file again and update the data linked from it',
    props: [{ id: 'library', label: 'Library', type: 'string', default: '', hidden: true }],
    undo: false,
    poll: (ctx) => Object.keys(libraries(ctx.doc)).length > 0,
    exec: (ctx, p) => {
      const lib = libraryArg(ctx.doc, p.library);
      if (p.library && !lib) return 'CANCELLED';
      void reloadAndCommit(lib ? [lib.id] : undefined, 'Reload Library');
      return 'CANCELLED';
    },
  },
  {
    idname: 'wm.lib_relocate',
    label: 'Relocate Library',
    description: 'Link the data of a library from another file instead (a moved, renamed or replacement file)',
    props: [
      { id: 'library', label: 'Library', type: 'string', default: '', hidden: true },
      { id: 'filepath', label: 'File', type: 'string', default: '', hidden: true },
    ],
    undo: false,
    poll: (ctx) => Object.keys(libraries(ctx.doc)).length > 0,
    invoke: (ctx, p) => {
      const lib = libraryArg(ctx.doc, p.library);
      if (!lib) return (app.report('WARNING', 'Pick a library to relocate (in the Outliner, Data Blocks display mode)'), 'CANCELLED');
      openLibraryBrowser({ mode: 'RELOCATE', title: `Relocate "${lib.name}"`, done: (r) => relocate(lib, r) });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const lib = libraryArg(ctx.doc, p.library);
      const info = cachedInfo(String(p.filepath ?? ''));
      const doc = cachedSource(String(p.filepath ?? ''));
      if (!lib || !info?.entry || !doc) return 'CANCELLED';
      relocate(lib, { entry: { ...info.entry, bytes: new Uint8Array(), time: Date.now() }, doc, items: [], options: {} });
      return 'CANCELLED';
    },
  },
  {
    idname: 'wm.id_linked_relocate',
    label: 'Relocate Linked Data-Block',
    description: 'Replace a linked data-block by another one, from the same or another file; everything local that used it switches over',
    props: [
      { id: 'id', label: 'Data-Block', type: 'string', default: '', hidden: true },
      ...fileProps,
    ],
    poll: (ctx) => linkedRecords(ctx.doc).length > 0,
    invoke: (ctx, p) => {
      const id = String(p.id || ctx.doc.scene.active_object || '');
      const rec = recordOf(ctx.doc, id);
      const table = tableOfId(ctx.doc, id);
      if (!rec || !isLinked(rec) || !table) return (app.report('WARNING', 'Pick a linked data-block to relocate'), 'CANCELLED');
      openLibraryBrowser({
        mode: 'ID_RELOCATE',
        table,
        title: `Relocate "${rec.name}"`,
        confirm: 'Replace',
        done: (r) => void app.run('wm.id_linked_relocate', { id, filepath: r.entry.key, files: formatFiles(r.items.slice(0, 1)) }, { invoke: false }),
      });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const key = String(p.filepath ?? '');
      const src = cachedSource(key);
      const item = parseFiles(String(p.files ?? ''))[0];
      if (!src || !item || !relocateId(ctx.doc, String(p.id), src, cachedInfo(key)?.entry, item)) return 'CANCELLED';
      app.report('INFO', `Now using ${typeLabel(item.table).replace(/s$/, '').toLowerCase()} "${item.name}"`);
    },
  },
  {
    idname: 'object.make_local',
    label: 'Make Local',
    description: 'Turn linked data into regular, editable data of this file',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'SELECT_OBJECT',
        items: [
          ['SELECT_OBJECT', 'Selected Objects', 'Make the selected linked objects local'],
          ['SELECT_OBDATA', 'Selected Objects and Data', 'Also make their object data local'],
          ['SELECT_OBDATA_MATERIAL', 'Selected Objects, Data and Materials', 'Also make their object data and materials local'],
          ['ALL', 'All', 'Make every linked data-block of this file local'],
        ],
      },
    ],
    poll: (ctx) => objectMode(ctx) && linkedRecords(ctx.doc).length + Object.values(ctx.doc.objects).filter(isOverride).length > 0,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const sel = app.selectedObjects().map((o) => o.id);
      const ids =
        p.type === 'ALL'
          ? linkedRecords(doc).map((x) => x.rec.id)
          : [...makeLocalTargets(doc, sel, p.type !== 'SELECT_OBJECT', p.type === 'SELECT_OBDATA_MATERIAL'), ...sel.filter((id) => isOverride(doc.objects[id]))];
      if (!ids.length) return (app.report('WARNING', 'Nothing linked is selected'), 'CANCELLED');
      const map = makeLocal(doc, ids);
      const act = doc.scene.active_object;
      if (act && map.has(act)) doc.scene.active_object = map.get(act)!;
      for (const nid of map.values()) if (doc.objects[nid]) doc.objects[nid].select = true;
      app.report('INFO', `Made ${ids.length} data-block${ids.length === 1 ? '' : 's'} local`);
      app.changed('doc', 'select');
    },
  },
  {
    idname: 'object.make_override_library',
    label: 'Make Library Override',
    description: 'Make an editable local override of the selected linked collection instance or object, so it can be moved and posed (its meshes and materials stay linked)',
    poll: (ctx) => objectMode(ctx) && !!overrideTarget(ctx.doc, app.activeObject),
    exec: (ctx) => {
      const t = overrideTarget(ctx.doc, app.activeObject);
      if (!t) return 'CANCELLED';
      const root = makeOverride(ctx.doc, t.table, t.id, { instancer: t.instancer });
      if (!root) return 'CANCELLED';
      lockLinked(ctx.doc);
      const members = hierarchyOf(ctx.doc, root).filter((id) => ctx.doc.objects[id]);
      for (const o of Object.values(ctx.doc.objects)) o.select = false;
      for (const id of members) ctx.doc.objects[id].select = true;
      // the armature (if any) becomes active, ready for posing
      ctx.doc.scene.active_object = members.find((id) => ctx.doc.objects[id].type === 'ARMATURE') ?? members[0] ?? null;
      app.report('INFO', `Made a library override of "${recordOf(ctx.doc, t.id)?.name ?? ''}"`);
      app.changed('doc', 'select');
    },
  },
  {
    idname: 'object.reset_override_library',
    label: 'Reset Library Override',
    description: 'Drop the changes made to the selected overrides, back to the linked data',
    poll: (ctx) => objectMode(ctx) && selectedOverrides(ctx).length > 0,
    exec: (ctx) => {
      const n = resetOverrides(
        ctx.doc,
        selectedOverrides(ctx).map((o) => o.id),
      );
      if (!n) return 'CANCELLED';
      app.report('INFO', `Reset ${n} override${n === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'object.clear_override_library',
    label: 'Clear Library Override',
    description: 'Remove the selected overrides: everything that used them uses the linked data again',
    poll: (ctx) => objectMode(ctx) && selectedOverrides(ctx).length > 0,
    exec: (ctx) => {
      const n = clearOverrides(
        ctx.doc,
        selectedOverrides(ctx).map((o) => o.id),
      );
      if (!n) return 'CANCELLED';
      lockLinked(ctx.doc);
      app.report('INFO', `Cleared ${n} override${n === 1 ? '' : 's'}`);
      app.changed('doc', 'select');
    },
  },
  {
    idname: 'file.pack_libraries',
    label: 'Pack Linked Libraries',
    description: 'Store the linked library files inside this project, so it opens with them anywhere',
    undo: false,
    poll: (ctx) => Object.values(libraries(ctx.doc)).some((l) => !l.packed_file?.length),
    exec: (ctx) => {
      void (async () => {
        let n = 0;
        for (const l of Object.values(libraries(ctx.doc))) {
          if (l.packed_file?.length) continue;
          const bytes = await libraryBytes(l);
          const cur = libraries(app.doc)[l.id];
          if (!bytes || !cur) {
            app.report('WARNING', `Library "${l.name}" could not be read`);
            continue;
          }
          cur.packed_file = bytes;
          n++;
        }
        if (n) {
          app.pushUndo('Pack Linked Libraries');
          app.changed('doc');
        }
        app.report('INFO', `Packed ${n} librar${n === 1 ? 'y' : 'ies'}`);
      })();
      return 'CANCELLED';
    },
  },
  {
    idname: 'file.unpack_libraries',
    label: 'Unpack Linked Libraries',
    description: 'Stop storing library files inside this project (they are kept in this browser instead)',
    undo: false,
    poll: (ctx) => Object.values(libraries(ctx.doc)).some((l) => !!l.packed_file?.length),
    exec: (ctx) => {
      void (async () => {
        let n = 0;
        for (const l of Object.values(libraries(ctx.doc))) {
          if (!l.packed_file?.length) continue;
          const stored = await getStored(l.source.key);
          if (!stored) await putStored({ key: l.source.key, name: l.name, path: l.filepath, bytes: l.packed_file, time: Date.now() });
          const cur = libraries(app.doc)[l.id];
          if (cur) cur.packed_file = null;
          n++;
        }
        if (n) {
          app.pushUndo('Unpack Linked Libraries');
          app.changed('doc');
        }
        app.report('INFO', `Unpacked ${n} librar${n === 1 ? 'y' : 'ies'}`);
      })();
      return 'CANCELLED';
    },
  },
  {
    idname: 'wm.drop_blend_file',
    label: 'Drop Project File',
    description: 'Choose what to do with a project file dropped onto the window: open it, or link or append from it',
    undo: false,
    internal: true,
    props: [{ id: 'filepath', label: 'File', type: 'string', default: '', hidden: true }],
    exec: () => {
      const f = pendingDrop;
      if (!f) return 'CANCELLED';
      openMenu(dropMenu(f), { x: app.pointer.x, y: app.pointer.y }, { title: f.name });
      return 'CANCELLED';
    },
  },
];
registerOperators(ops);

// ---------------------------------------------------------------------------
// dropping project files onto the window

let pendingDrop: File | null = null;

function dropMenu(f: File): MenuItem[] {
  const ref: FileRef = { name: f.name, path: f.name, file: f };
  return [
    { label: 'Open', icon: 'file_folder', action: () => void openFile(f) },
    { separator: true },
    { label: 'Link…', icon: 'link', disabled: !app.poll('wm.link'), action: () => browseFile(true, ref) },
    { label: 'Append…', icon: 'append_blend', disabled: !app.poll('wm.append'), action: () => browseFile(false, ref) },
  ];
}

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

if (typeof window !== 'undefined') {
  addEventListener('dragover', (e) => {
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  addEventListener('drop', (e) => {
    if (!hasFiles(e) || e.defaultPrevented) return;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    app.pointer = { x: e.clientX, y: e.clientY };
    const project = files.find((f) => isLibraryFile(f.name));
    if (project) {
      pendingDrop = project;
      app.run('wm.drop_blend_file', { filepath: project.name }, { invoke: false });
      return;
    }
    // other files: import the ones a format reads
    for (const f of files) void openFile(f, 'import');
  });
}

// ---------------------------------------------------------------------------

/** Menus of the Outliner and the 3D view call these. */
export const libraryOps = { reloadAndCommit, deleteLibraryNow, fingerprint };

function deleteLibraryNow(libId: ID): number {
  const n = deleteLibrary(app.doc, libId);
  lockLinked(app.doc);
  return n;
}

export type { LinkableID };
