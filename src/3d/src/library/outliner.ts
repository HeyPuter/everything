// Libraries in the Outliner: linked libraries listed after "Current File" in the Data Blocks
// display mode (with their linked data-blocks), the Library Overrides display mode (overridden
// properties, or override hierarchies), and the library / override operations of their menus.
import { app, registerOperators, type OpContext } from '../app/app';
import type { DocumentData, ID } from '../data/types';
import type { MenuItem } from '../ui/menu';
import { currentOutliner } from '../editors/outliner/current';
import { kindMenuHooks, commonItems } from '../editors/outliner/menus';
import { fileModeRoots, idGroups, modeBuilders, userCounts, OB_ICON, type Row, type TreeNode, type TreeState } from '../editors/outliner/tree';
import {
  clearOverrides,
  deleteLibrary,
  hierarchyOf,
  isLinked,
  isOverride,
  libraries,
  lockLinked,
  makeOverride,
  overrideGroups,
  overriddenKeys,
  recordOf,
  resetOverrideProperty,
  resetOverrides,
  resyncOverrides,
  tableOfId,
  tablesOf,
} from './core';
import type { LibraryData } from './types';

const libIcon = (l: LibraryData) => (l.is_missing ? 'library_data_broken' : l.parent ? 'library_data_indirect' : 'library_data_direct');

function libraryNode(doc: DocumentData, st: TreeState, lib: LibraryData, users: Map<string, number>): TreeNode {
  const groups = idGroups(doc, st, (_t, x) => (x as { library?: string }).library === lib.id, users, `lg:${lib.id}`);
  const subs = Object.values(libraries(doc)).filter((l) => l.parent === lib.id);
  return {
    ekey: `lib:${lib.id}`,
    kind: 'library',
    label: lib.name,
    icon: libIcon(lib),
    id: lib.id,
    table: 'libraries',
    path: lib.filepath,
    defaultOpen: false,
    searchable: true,
    children: () => [...subs.map((s) => libraryNode(doc, st, s, users)), ...groups],
  };
}

fileModeRoots.push((doc, st) => {
  const libs = Object.values(libraries(doc)).filter((l) => !l.parent || !libraries(doc)[l.parent]);
  if (!libs.length) return [];
  const users = userCounts(doc);
  return libs.sort((a, b) => a.name.localeCompare(b.name)).map((l) => libraryNode(doc, st, l, users));
});

// ---------------------------------------------------------------------------
// Library Overrides display mode

const KEY_LABEL = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const iconOf = (table: string, rec: { type?: string }) => (table === 'objects' ? (OB_ICON[rec.type ?? ''] ?? 'object') : table === 'collections' ? 'collection' : 'file');

modeBuilders.LIBRARY_OVERRIDES = (doc, st) => {
  const groups = overrideGroups(doc);
  const byLib = new Map<ID, typeof groups>();
  for (const g of groups) {
    const ref = recordOf(doc, g.members.find((m) => m.id === g.root)?.reference ?? '');
    const lib = ref?.library ?? '';
    byLib.set(lib, [...(byLib.get(lib) ?? []), g]);
  }
  const t = tablesOf(doc);
  const out: TreeNode[] = [];
  for (const [libId, gs] of byLib) {
    const lib = libraries(doc)[libId];
    let children: () => TreeNode[];
    if (st.filter.lib_override_view_mode === 'PROPERTIES') {
      children = () =>
        gs
          .flatMap((g) => g.members.map((m) => ({ g, m })))
          .filter(({ m }) => st.filter.use_filter_lib_override_system || !t[m.table][m.id]?.override_library?.is_system_override)
          .map(({ g, m }) => {
            const rec = t[m.table][m.id];
            const keys = overriddenKeys(doc, m.table, m.id, g.map);
            return {
              ekey: `ovp:${m.id}`,
              kind: (m.table === 'objects' ? 'object' : 'id') as Row['kind'],
              label: rec.name,
              icon: iconOf(m.table, rec as { type?: string }),
              id: m.id,
              table: m.table,
              ob: m.table === 'objects' ? (rec as never) : undefined,
              collection: m.table === 'collections' ? (rec as never) : undefined,
              defaultOpen: true,
              searchable: true,
              children: () => keys.map((k) => ({ ekey: `ovk:${m.id}:${k}`, kind: 'override' as const, label: KEY_LABEL(k), icon: 'library_override', id: m.id, table: m.table, path: k, defaultOpen: false, searchable: true, children: () => [] })),
            };
          });
    } else {
      children = () =>
        gs.map((g) => {
          const member = (id: ID, depth: number): TreeNode => {
            const table = tableOfId(doc, id) ?? 'objects';
            const rec = t[table][id];
            const col = table === 'collections' ? (rec as unknown as { children: ID[]; objects: ID[] }) : null;
            const kids = col && depth < 32 ? [...col.children, ...col.objects].filter((x) => recordOf(doc, x)) : [];
            return {
              ekey: `ovh:${g.root}:${id}`,
              kind: (table === 'objects' ? 'object' : 'id') as Row['kind'],
              label: rec.name,
              icon: iconOf(table, rec as { type?: string }),
              id,
              table,
              ob: table === 'objects' ? (rec as never) : undefined,
              collection: table === 'collections' ? (rec as never) : undefined,
              defaultOpen: depth < 1,
              searchable: true,
              children: () => kids.map((k) => member(k, depth + 1)),
            };
          };
          return member(g.root, 0);
        });
    }
    out.push({ ekey: `ovl:${libId}`, kind: 'library', label: lib?.name ?? 'Unknown Library', icon: lib ? libIcon(lib) : 'library_data_broken', id: libId, table: 'libraries', defaultOpen: true, children });
  }
  return out;
};

// ---------------------------------------------------------------------------
// operators

/** Libraries of the selected (or active) library rows. */
function selectedLibraries(ctx: OpContext): LibraryData[] {
  const ol = currentOutliner(ctx);
  if (!ol) return [];
  const rows = ol.selectedRows('library');
  const act = ol.rows.find((r) => r.ekey === ol.activeKey && r.kind === 'library');
  const ids = [...new Set([...(act ? [act.id] : []), ...rows.map((r) => r.id)])];
  return ids.map((id) => libraries(ctx.doc)[id ?? '']).filter(Boolean);
}

/** Data-block ids of the selected rows (active first), optionally with what collections hold. */
function selectedIds(ctx: OpContext, set: string): ID[] {
  const ol = currentOutliner(ctx);
  if (!ol) return [];
  const rows = ol.selectedRows();
  const act = ol.rows.find((r) => r.ekey === ol.activeKey);
  const sel: ID[] = [];
  for (const r of act && !rows.includes(act) ? [act, ...rows] : rows) {
    const id = r.kind === 'object' ? r.ob?.id : r.id;
    if (id && r.kind !== 'library' && r.kind !== 'override' && recordOf(ctx.doc, id) && !sel.includes(id)) sel.push(id);
  }
  const content: ID[] = [];
  if (set !== 'SELECTED')
    for (const id of sel) {
      const c = ctx.doc.collections[id];
      if (!c) continue;
      const walk = (cid: ID, depth: number) => {
        const cc = ctx.doc.collections[cid];
        if (!cc || depth > 64) return;
        for (const o of cc.objects) if (!content.includes(o)) content.push(o);
        for (const ch of cc.children) {
          if (!content.includes(ch)) content.push(ch);
          walk(ch, depth + 1);
        }
      };
      walk(c.id, 0);
    }
  return set === 'CONTENT' ? content : [...sel, ...content.filter((x) => !sel.includes(x))];
}

/** The local Empty that instances a linked collection (to replace it by the override). */
const instancerOf = (doc: DocumentData, cid: ID) => Object.values(doc.objects).find((o) => !isLinked(o) && o.instance_type === 'COLLECTION' && o.instance_collection === cid)?.id;

function libOperation(ctx: OpContext, type: string, libs: LibraryData[]) {
  if (!libs.length) return (app.report('WARNING', 'Select a library in the Outliner'), 'CANCELLED' as const);
  if (type === 'RELOAD') {
    void app.run('wm.lib_reload', { library: libs[0].id }, { invoke: false });
    for (const l of libs.slice(1)) void app.run('wm.lib_reload', { library: l.id }, { invoke: false });
    return 'CANCELLED' as const;
  }
  if (type === 'RELOCATE') {
    app.run('wm.lib_relocate', { library: libs[0].id });
    return 'CANCELLED' as const;
  }
  let n = 0;
  for (const l of libs) n += deleteLibrary(ctx.doc, l.id);
  lockLinked(ctx.doc);
  app.report('INFO', `Deleted ${libs.length} librar${libs.length === 1 ? 'y' : 'ies'} (${n} linked data-block${n === 1 ? '' : 's'})`);
  app.changed('doc', 'select');
  return 'FINISHED' as const;
}

const selectionSet = { id: 'selection_set', label: 'Selection Set', type: 'enum' as const, default: 'SELECTED', items: [['SELECTED', 'Selected', 'Only the selected elements'], ['CONTENT', 'Content', 'What the selected collections hold'], ['SELECTED_AND_CONTENT', 'Selected & Content', 'The selected elements and what they hold']] as [string, string, string][] };

registerOperators([
  {
    idname: 'outliner.lib_operation',
    label: 'Outliner Library Operation',
    description: 'Delete, relocate or reload the selected libraries',
    props: [{ id: 'type', label: 'Library Operation', type: 'enum', default: 'DELETE', items: [['DELETE', 'Delete', 'Remove the library and everything linked from it'], ['RELOCATE', 'Relocate', 'Use another file for the library'], ['RELOAD', 'Reload', 'Read the library file again']] }],
    poll: (ctx) => Object.keys(libraries(ctx.doc)).length > 0,
    exec: (ctx, p) => libOperation(ctx, String(p.type), selectedLibraries(ctx)),
  },
  {
    idname: 'outliner.lib_relocate',
    label: 'Relocate Library',
    description: 'Use another file for the library under the pointer',
    undo: false,
    poll: (ctx) => selectedLibraries(ctx).length > 0,
    exec: (ctx) => libOperation(ctx, 'RELOCATE', selectedLibraries(ctx)),
  },
  {
    idname: 'outliner.id_linked_relocate',
    label: 'Relocate Linked Data-Block',
    description: 'Replace the active linked data-block (and what it uses) by another one, from the same or another library',
    undo: false,
    poll: (ctx) => selectedIds(ctx, 'SELECTED').some((id) => isLinked(recordOf(ctx.doc, id))),
    exec: (ctx) => {
      const id = selectedIds(ctx, 'SELECTED').find((x) => isLinked(recordOf(ctx.doc, x)));
      if (!id) return 'CANCELLED';
      app.run('wm.id_linked_relocate', { id });
      return 'CANCELLED';
    },
  },
  {
    idname: 'outliner.liboverride_operation',
    label: 'Outliner Library Override Operation',
    description: 'Make, reset or clear library overrides of the selected elements',
    props: [
      {
        id: 'type',
        label: 'Library Override Operation',
        type: 'enum',
        default: 'OVERRIDE_LIBRARY_CREATE_HIERARCHY',
        items: [
          ['OVERRIDE_LIBRARY_CREATE_HIERARCHY', 'Make', 'Make editable overrides of the selected linked data (with their hierarchy)'],
          ['OVERRIDE_LIBRARY_RESET', 'Reset', 'Drop the changes made to the selected overrides'],
          ['OVERRIDE_LIBRARY_CLEAR_SINGLE', 'Clear', 'Remove the selected overrides; their users go back to the linked data'],
        ],
      },
      selectionSet,
      { id: 'targets', label: 'Targets', type: 'string', default: '', hidden: true },
    ],
    poll: (ctx) => !!currentOutliner(ctx),
    invoke: (ctx, p) => {
      p.targets = p.targets || selectedIds(ctx, String(p.selection_set)).join('|');
      return liboverrideExec(ctx, p);
    },
    exec: (ctx, p) => liboverrideExec(ctx, p),
  },
  {
    idname: 'outliner.liboverride_troubleshoot_operation',
    label: 'Outliner Library Override Troubleshoot Operation',
    description: 'Repair override hierarchies: rebuild them from their linked data, or delete them',
    props: [
      {
        id: 'type',
        label: 'Library Override Troubleshoot Operation',
        type: 'enum',
        default: 'OVERRIDE_LIBRARY_RESYNC_HIERARCHY',
        items: [
          ['OVERRIDE_LIBRARY_RESYNC_HIERARCHY', 'Resync', 'Rebuild the hierarchy from the linked data, keeping the changes'],
          ['OVERRIDE_LIBRARY_RESYNC_HIERARCHY_ENFORCE', 'Resync Enforce', 'Rebuild the hierarchy, including which objects and collections it holds'],
          ['OVERRIDE_LIBRARY_DELETE_HIERARCHY', 'Delete', 'Delete the whole override hierarchy; its users go back to the linked data'],
        ],
      },
      selectionSet,
    ],
    poll: (ctx) => overrideGroups(ctx.doc).length > 0,
    exec: (ctx, p) => {
      const ids = selectedIds(ctx, String(p.selection_set)).filter((id) => isOverride(recordOf(ctx.doc, id)));
      if (!ids.length) return (app.report('WARNING', 'Select library overrides in the Outliner'), 'CANCELLED');
      let n: number;
      if (p.type === 'OVERRIDE_LIBRARY_DELETE_HIERARCHY') {
        const roots = [...new Set(ids.map((id) => recordOf(ctx.doc, id)?.override_library?.hierarchy_root ?? id))];
        n = clearOverrides(ctx.doc, roots);
        lockLinked(ctx.doc);
      } else n = resyncOverrides(ctx.doc, ids, p.type === 'OVERRIDE_LIBRARY_RESYNC_HIERARCHY_ENFORCE');
      if (!n) return 'CANCELLED';
      app.changed('doc', 'select');
    },
  },
  {
    idname: 'outliner.liboverride_property_remove',
    label: 'Remove Library Override Property',
    description: 'Drop the selected overridden properties: they take the linked value again',
    props: [{ id: 'targets', label: 'Targets', type: 'string', default: '', hidden: true }],
    poll: (ctx) => !!currentOutliner(ctx)?.selectedRows('override').length || !!currentOutliner(ctx)?.rows.find((r) => r.kind === 'override' && r.ekey === currentOutliner(ctx)?.activeKey),
    invoke: (ctx, p) => {
      const ol = currentOutliner(ctx)!;
      const rows = ol.selectedRows('override');
      const act = ol.rows.find((r) => r.kind === 'override' && r.ekey === ol.activeKey);
      p.targets = [...new Set([...(act ? [act] : []), ...rows].map((r) => `${r.id}\u0001${r.path}`))].join('|');
      return propRemove(ctx, p);
    },
    exec: (ctx, p) => propRemove(ctx, p),
  },
]);

function propRemove(ctx: OpContext, p: Record<string, unknown>) {
  let n = 0;
  for (const t of String(p.targets ?? '').split('|').filter(Boolean)) {
    const [id, key] = t.split('\u0001');
    if (resetOverrideProperty(ctx.doc, id, key)) n++;
  }
  if (!n) return 'CANCELLED' as const;
  app.changed('doc');
  return 'FINISHED' as const;
}

function liboverrideExec(ctx: OpContext, p: Record<string, unknown>) {
  const doc = ctx.doc;
  const ids = String(p.targets ?? '')
    .split('|')
    .filter((id) => id && recordOf(doc, id));
  let n = 0;
  if (p.type === 'OVERRIDE_LIBRARY_CREATE_HIERARCHY') {
    const done = new Set<ID>();
    for (const id of ids) {
      const table = tableOfId(doc, id)!;
      if (!isLinked(recordOf(doc, id)) || done.has(id) || (table !== 'collections' && table !== 'objects')) continue;
      const root = makeOverride(doc, table, id, { instancer: table === 'collections' ? instancerOf(doc, id) : undefined });
      if (root) {
        n++;
        for (const m of hierarchyOf(doc, root)) done.add(recordOf(doc, m)?.override_library?.reference ?? m);
      }
    }
    lockLinked(doc);
    if (!n) return (app.report('WARNING', 'Select linked collections or objects to override'), 'CANCELLED' as const);
  } else if (p.type === 'OVERRIDE_LIBRARY_RESET') n = resetOverrides(doc, ids.filter((id) => isOverride(recordOf(doc, id))));
  else {
    n = clearOverrides(doc, ids.filter((id) => isOverride(recordOf(doc, id))));
    lockLinked(doc);
  }
  if (!n) return (app.report('WARNING', 'Select library overrides in the Outliner'), 'CANCELLED' as const);
  app.changed('doc', 'select');
  return 'FINISHED' as const;
}

// ---------------------------------------------------------------------------
// row menus

kindMenuHooks.library = (ol, r): MenuItem[] => {
  const lib = libraries(app.doc)[r.id ?? ''];
  return [
    { label: 'Reload', icon: 'file_refresh', op: 'outliner.lib_operation', props: { type: 'RELOAD' } },
    { label: 'Relocate…', op: 'outliner.lib_operation', props: { type: 'RELOCATE' } },
    { separator: true },
    { label: lib?.packed_file?.length ? 'Unpack Linked Libraries' : 'Pack Linked Libraries', op: lib?.packed_file?.length ? 'file.unpack_libraries' : 'file.pack_libraries', disabled: !lib },
    { separator: true },
    { label: 'Delete', icon: 'trash', op: 'outliner.lib_operation', props: { type: 'DELETE' } },
    ...commonItems(ol),
  ];
};

kindMenuHooks.override = (ol): MenuItem[] => [{ label: 'Reset to Linked Value', op: 'outliner.liboverride_property_remove' }, ...commonItems(ol)];

