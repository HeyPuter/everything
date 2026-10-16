// More Outliner operators: data-block deletion and remapping, linking collections to the scene,
// deleting collection hierarchies, animation data operations, keying sets and drivers for Data
// API rows, the drag and drop operations (parenting, moving to collections) and the click
// operations (activate, open/close) as named operators.
import { Matrix4 } from 'three';
import { app, registerOperators, operators, onAppReady, type OpContext } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { openMenu, type MenuItem } from '../../ui/menu';
import type { DocumentData, ID, ObjectData } from '../../data/types';
import { applyMatrixToObject, fromMatrix4 } from '../../eval/transform';
import { deleteObjects } from '../../ops/object';
import { removeDataBlock } from '../../scripting/api';
import { activeUserSet, addKeyingPath, removeKeyingPath } from '../../anim/keyingsets';
import { addDriver, removeDriver } from '../../animation/driverseditor';
import { ensureAnimData } from '../../animation/actionops';
import { currentOutliner } from './current';
import { descendantCollections, objectsInside, ID_GROUPS, type Row } from './tree';
import { moveObjectsToCollection } from './collections';
import { decodeApiPath } from './dataapi';
import { contextMenuFor, kindMenuHooks, commonItems, idDataMenu } from './menus';
import { isLinked, lockLinked, recordOf, remapLocalUsers, scrubLocal, tableOfId, tablesOf } from '../../library/core';

const hasOutliner = (ctx: OpContext) => !!currentOutliner(ctx);

/** Data-block ids of the selected rows (active row first). */
function selectedIdRows(ctx: OpContext): { table: string; id: ID; row: Row }[] {
  const ol = currentOutliner(ctx);
  if (!ol) return [];
  const rows = ol.selectedRows();
  const act = ol.rows.find((r) => r.ekey === ol.activeKey);
  const out: { table: string; id: ID; row: Row }[] = [];
  for (const r of act && !rows.includes(act) ? [act, ...rows] : rows) {
    const id = r.kind === 'object' ? r.ob?.id : r.kind === 'collection' || r.kind === 'id' || r.kind === 'data' || r.kind === 'material' || r.kind === 'action' ? r.id : undefined;
    const table = r.kind === 'object' ? 'objects' : r.kind === 'collection' ? 'collections' : r.table;
    if (id && table && tablesOf(ctx.doc)[table]?.[id] && id !== ctx.doc.scene.collection && !out.some((x) => x.id === id)) out.push({ table, id, row: r });
  }
  return out;
}

/** Selected objects of the outliner (or of the scene). */
function targetObjects(ctx: OpContext): ObjectData[] {
  const ol = currentOutliner(ctx);
  const ids = new Set<string>();
  for (const r of ol?.selectedRows() ?? []) if (r.ob && (r.kind === 'object' || r.kind === 'action')) ids.add(r.ob.id);
  if (!ids.size) for (const o of app.selectedObjects()) ids.add(o.id);
  return [...ids].map((id) => ctx.doc.objects[id]).filter(Boolean);
}

/** Delete data-blocks of any type; linked ones are removed with every local reference to them. */
export function deleteIds(doc: DocumentData, items: { table: string; id: ID }[]): number {
  let n = 0;
  const linkedGone = new Set<string>();
  for (const { table, id } of items) {
    const rec = tablesOf(doc)[table]?.[id];
    if (!rec) continue;
    if (isLinked(rec)) {
      delete tablesOf(doc)[table][id];
      linkedGone.add(id);
    } else if (table === 'objects') deleteObjects(doc, new Set([id]));
    else removeDataBlock(table, id);
    n++;
  }
  if (linkedGone.size) {
    scrubLocal(doc, linkedGone);
    lockLinked(doc);
  }
  return n;
}

// ---------------------------------------------------------------------------
// keying sets and drivers of Data API rows

interface Prop {
  ob: ObjectData;
  path: string;
  index: number;
}

/** Animatable object properties of the selected Data API rows. */
function selectedProps(ctx: OpContext): Prop[] {
  const ol = currentOutliner(ctx);
  if (!ol || ol.displayMode !== 'DATA_API') return [];
  const out: Prop[] = [];
  for (const r of ol.selectedRows('rna')) {
    const p = decodeApiPath(r.path);
    if (!p || p.table !== 'objects' || !p.path) continue;
    const ob = ctx.doc.objects[p.id];
    if (!ob) continue;
    // "location[1]" style rows of a vector are the component of the vector property
    const m = /^(.*)\[(\d+)\]$/.exec(p.path);
    const path = p.index >= 0 ? p.path : m ? m[1] : p.path;
    const index = p.index >= 0 ? p.index : m ? Number(m[2]) : -1;
    // numbers, booleans and number vectors can be animated
    const v = r.value?.get();
    if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.startsWith('('))) out.push({ ob, path, index });
  }
  return out;
}

// ---------------------------------------------------------------------------
// drag and drop

function worldOf(id: ID): Matrix4 {
  return app.graph.get(id)?.world.clone() ?? new Matrix4();
}

/** Clear the parent of objects, keeping where they are in the world. */
function clearParent(doc: DocumentData, ids: ID[], keep = true): number {
  let n = 0;
  for (const id of ids) {
    const ob = doc.objects[id];
    if (!ob?.parent) continue;
    const w = worldOf(id);
    ob.parent = null;
    ob.matrix_parent_inverse = fromMatrix4(new Matrix4());
    if (keep) applyMatrixToObject(ob, w);
    n++;
  }
  return n;
}

const ids = (s: unknown) => String(s ?? '').split('|').filter(Boolean);

registerOperators([
  {
    idname: 'outliner.id_delete',
    label: 'Delete Data-Block',
    description: 'Delete the selected data-blocks (any type) and remove every use of them',
    poll: (ctx) => selectedIdRows(ctx).length > 0,
    exec: (ctx) => {
      const n = deleteIds(ctx.doc, selectedIdRows(ctx));
      if (!n) return 'CANCELLED';
      currentOutliner(ctx)?.sel.clear();
      app.report('INFO', `Deleted ${n} data-block${n === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'outliner.id_remap',
    label: 'Remap Users',
    description: 'Make everything that uses a data-block use another one of the same type instead',
    props: [
      { id: 'id_type', label: 'ID Type', type: 'string', default: '', hidden: true },
      { id: 'old_id', label: 'Old Data-Block', type: 'string', default: '', hidden: true },
      { id: 'new_id', label: 'New Data-Block', type: 'string', default: '' },
    ],
    poll: (ctx) => selectedIdRows(ctx).length > 0 || hasOutliner(ctx),
    invoke: (ctx, p) => {
      const first = p.old_id ? { table: tableOfId(ctx.doc, String(p.old_id)) ?? '', id: String(p.old_id) } : selectedIdRows(ctx)[0];
      if (!first?.table) return (app.report('WARNING', 'Select a data-block to remap'), 'CANCELLED');
      const others = Object.values(tablesOf(ctx.doc)[first.table] ?? {}).filter((x) => x.id !== first.id && x.id !== ctx.doc.scene.collection);
      if (!others.length) return (app.report('WARNING', 'There is no other data-block of this type to use instead'), 'CANCELLED');
      const ic = ID_GROUPS.find((g) => g[1] === first.table)?.[2] ?? 'file';
      openMenu(
        [{ heading: `Use instead of "${recordOf(ctx.doc, first.id)?.name}"` }, ...others.sort((a, b) => a.name.localeCompare(b.name)).map((x) => ({ label: x.name, icon: ic, action: () => void app.run('outliner.id_remap', { id_type: first.table, old_id: first.id, new_id: x.id }, { invoke: false }) }))],
        { x: app.pointer.x, y: app.pointer.y },
        { search: others.length > 12 },
      );
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const oldId = String(p.old_id),
        newId = String(p.new_id);
      const table = tableOfId(ctx.doc, oldId);
      if (!table || table !== tableOfId(ctx.doc, newId) || oldId === newId) return 'CANCELLED';
      remapLocalUsers(ctx.doc, new Map([[oldId, newId]]));
      // collections and objects are listed once per holder
      for (const c of Object.values(ctx.doc.collections)) {
        if (isLinked(c)) continue;
        c.objects = c.objects.filter((x, i, a) => a.indexOf(x) === i);
        c.children = c.children.filter((x, i, a) => a.indexOf(x) === i && x !== c.id);
      }
      app.report('INFO', `"${recordOf(ctx.doc, oldId)?.name}" users now use "${recordOf(ctx.doc, newId)?.name}"`);
    },
  },
  {
    idname: 'outliner.collection_link',
    label: 'Link Collection',
    description: 'Add the selected collections to the scene (also collections nothing uses yet)',
    poll: (ctx) => selectedIdRows(ctx).some((x) => x.table === 'collections'),
    exec: (ctx) => {
      const master = ctx.doc.collections[ctx.doc.scene.collection];
      let n = 0;
      for (const { id, table } of selectedIdRows(ctx)) {
        if (table !== 'collections' || master.children.includes(id) || id === master.id || descendantCollections(ctx.doc, id).includes(master.id)) continue;
        master.children.push(id);
        n++;
      }
      if (!n) return (app.report('INFO', 'The selected collections are already in the scene'), 'CANCELLED');
    },
  },
  {
    idname: 'outliner.collection_hierarchy_delete',
    label: 'Delete Hierarchy',
    description: 'Delete the selected collections with every collection and object inside them',
    poll: (ctx) => (currentOutliner(ctx)?.selectedCollections().length ?? 0) > 0,
    exec: (ctx) => {
      const doc = ctx.doc;
      const cols = currentOutliner(ctx)!.selectedCollections().filter((id) => !isLinked(doc.collections[id]));
      if (!cols.length) return 'CANCELLED';
      const doomed = new Set(cols.flatMap((id) => [id, ...descendantCollections(doc, id)]));
      const obs = new Set(cols.flatMap((id) => objectsInside(doc, id)));
      for (const cid of doomed) delete doc.collections[cid];
      for (const c of Object.values(doc.collections)) if (!isLinked(c)) c.children = c.children.filter((x) => !doomed.has(x));
      // objects still used by another collection stay
      for (const o of [...obs]) if (Object.values(doc.collections).some((c) => c.objects.includes(o))) obs.delete(o);
      deleteObjects(doc, obs);
      currentOutliner(ctx)?.sel.clear();
      app.report('INFO', `Deleted ${doomed.size} collection${doomed.size === 1 ? '' : 's'} and ${obs.size} object${obs.size === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'outliner.animdata_operation',
    label: 'Outliner Animation Data Operation',
    description: 'Animation data operations on the selected objects',
    props: [
      {
        id: 'type',
        label: 'Animation Operation',
        type: 'enum',
        default: 'CLEAR_ANIMDATA',
        items: [
          ['CLEAR_ANIMDATA', 'Clear Animation Data', 'Remove the action, NLA tracks and drivers'],
          ['SET_ACT', 'Set Action', 'Pick the action to use'],
          ['CLEAR_ACT', 'Unlink Action', 'Stop using the action (it stays in the file)'],
          ['REFRESH_DRIVERS', 'Refresh Drivers', 'Re-evaluate the drivers and clear their errors'],
          ['CLEAR_DRIVERS', 'Clear Drivers', 'Remove all drivers'],
        ],
      },
    ],
    poll: (ctx) => hasOutliner(ctx) && targetObjects(ctx).length > 0,
    invoke: (ctx, p) => {
      if (p.type === 'SET_ACT') return (app.run('outliner.action_set', {}), 'CANCELLED');
      return animdataExec(ctx, p);
    },
    exec: (ctx, p) => animdataExec(ctx, p),
  },
  {
    idname: 'outliner.action_set',
    label: 'Outliner Set Action',
    description: 'Use another action on the selected objects',
    props: [{ id: 'action', label: 'Action', type: 'string', default: '' }],
    poll: (ctx) => targetObjects(ctx).length > 0 && Object.keys(ctx.doc.actions).length > 0,
    invoke: (ctx, p) => {
      if (p.action) return app.run('outliner.action_set', { action: p.action }, { invoke: false }) as 'FINISHED';
      const acts = Object.values(ctx.doc.actions).sort((a, b) => a.name.localeCompare(b.name));
      openMenu(
        [{ heading: 'Set Action' }, ...acts.map((a) => ({ label: a.name, icon: 'action', action: () => void app.run('outliner.action_set', { action: a.id }, { invoke: false }) }))],
        { x: app.pointer.x, y: app.pointer.y },
        { search: acts.length > 12 },
      );
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const act = ctx.doc.actions[String(p.action)] ?? Object.values(ctx.doc.actions).find((a) => a.name === p.action);
      if (!act) return 'CANCELLED';
      for (const ob of targetObjects(ctx)) ensureAnimData(ob).action = act.id;
      app.report('INFO', `Action "${act.name}" set`);
    },
  },
  {
    idname: 'outliner.keyingset_add_selected',
    label: 'Keying Set Add Selected',
    description: 'Add the selected properties (Data API rows) to the active keying set',
    poll: (ctx) => selectedProps(ctx).length > 0,
    exec: (ctx) => {
      let set = activeUserSet(ctx.doc);
      if (!set) {
        const sets = (ctx.doc.scene.keying_sets ??= []);
        let name = 'Keying Set';
        for (let i = 1; sets.some((s) => s.name === name); i++) name = `Keying Set.${String(i).padStart(3, '0')}`;
        set = { name, paths: [] };
        sets.push(set);
        ctx.doc.scene.keying_set = `KS:${set.name}`;
      }
      let n = 0;
      for (const p of selectedProps(ctx)) if (addKeyingPath(set, p.ob.id, p.path, p.index)) n++;
      if (!n) return 'CANCELLED';
      app.report('INFO', `Added ${n} propert${n === 1 ? 'y' : 'ies'} to keying set "${set.name}"`);
    },
  },
  {
    idname: 'outliner.keyingset_remove_selected',
    label: 'Keying Set Remove Selected',
    description: 'Remove the selected properties (Data API rows) from the active keying set',
    poll: (ctx) => !!activeUserSet(ctx.doc) && selectedProps(ctx).length > 0,
    exec: (ctx) => {
      const set = activeUserSet(ctx.doc)!;
      let n = 0;
      for (const p of selectedProps(ctx)) if (removeKeyingPath(set, p.ob.id, p.path, p.index)) n++;
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'outliner.drivers_add_selected',
    label: 'Add Drivers for Selected',
    description: 'Add drivers to the selected properties (Data API rows)',
    poll: (ctx) => selectedProps(ctx).length > 0,
    exec: (ctx) => {
      let n = 0;
      for (const p of selectedProps(ctx)) n += addDriver(ctx.doc, p.ob, p.path, p.index).length;
      if (!n) return 'CANCELLED';
      app.report('INFO', `Added ${n} driver${n === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'outliner.drivers_delete_selected',
    label: 'Delete Drivers for Selected',
    description: 'Remove the drivers of the selected properties (Data API rows)',
    poll: (ctx) => selectedProps(ctx).length > 0,
    exec: (ctx) => {
      let n = 0;
      for (const p of selectedProps(ctx)) n += removeDriver(p.ob, p.path, p.index);
      if (!n) return (app.report('WARNING', 'The selected properties have no drivers'), 'CANCELLED');
    },
  },
  {
    idname: 'outliner.parent_drop',
    label: 'Drop to Set Parent',
    description: 'Parent the dragged objects to the object they are dropped on (they keep their place in the world)',
    props: [
      { id: 'children', label: 'Children', type: 'string', default: '', hidden: true },
      { id: 'parent', label: 'Parent', type: 'string', default: '', hidden: true },
      { id: 'collection', label: 'Collection', type: 'string', default: '', hidden: true },
    ],
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const parent = doc.objects[String(p.parent)];
      if (!parent) return 'CANCELLED';
      const pw = worldOf(parent.id);
      const parentCols = Object.values(doc.collections)
        .filter((c) => c.objects.includes(parent.id) && !isLinked(c))
        .map((c) => c.id);
      let n = 0;
      for (const id of ids(p.children)) {
        const ob = doc.objects[id];
        if (!ob || id === parent.id) continue;
        let q: string | null = parent.id,
          cycle = false;
        while (q) {
          if (q === id) cycle = true;
          q = doc.objects[q]?.parent ?? null;
        }
        if (cycle) continue;
        const w = worldOf(id);
        ob.parent = parent.id;
        ob.parent_type = 'OBJECT';
        ob.matrix_parent_inverse = fromMatrix4(new Matrix4());
        applyMatrixToObject(ob, pw.clone().invert().multiply(w));
        // children follow the parent into its collection when they were not sharing one
        const shared = parentCols.some((c) => doc.collections[c].objects.includes(id));
        if (!shared && parentCols.length) moveObjectsToCollection(doc, [id], p.collection && parentCols.includes(String(p.collection)) ? String(p.collection) : parentCols[0], false);
        n++;
      }
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'outliner.parent_clear',
    label: 'Drop to Clear Parent',
    description: 'Clear the parent of the dragged objects (they keep their place in the world)',
    props: [{ id: 'objects', label: 'Objects', type: 'string', default: '', hidden: true }],
    exec: (ctx, p) => (clearParent(ctx.doc, ids(p.objects)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'outliner.collection_drop',
    label: 'Move to Collection',
    description: 'Move (or with Ctrl link) the dragged objects into the collection they are dropped on',
    props: [
      { id: 'objects', label: 'Objects', type: 'string', default: '', hidden: true },
      { id: 'collection', label: 'Collection', type: 'string', default: '', hidden: true },
      { id: 'link', label: 'Link', type: 'bool', default: false },
      { id: 'keep_parent', label: 'Keep Parent', type: 'bool', default: false },
    ],
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const col = doc.collections[String(p.collection)];
      const list = ids(p.objects).filter((id) => doc.objects[id]);
      if (!col || !list.length) return 'CANCELLED';
      if (isLinked(col)) return (app.report('WARNING', 'Linked collections cannot get new objects'), 'CANCELLED');
      if (!p.link && !p.keep_parent) clearParent(doc, list.filter((id) => !list.includes(doc.objects[id]?.parent ?? '')));
      moveObjectsToCollection(doc, list, col.id, !!p.link);
    },
  },
  {
    idname: 'outliner.item_drag_drop',
    label: 'Drag and Drop',
    description: 'Drag outliner elements: objects onto objects (parent) or collections (move), collections into collections, materials onto objects',
    internal: true,
    undo: false,
    exec: () => {
      app.report('INFO', 'Drag elements in the Outliner with the mouse');
      return 'CANCELLED';
    },
  },
  {
    idname: 'outliner.item_openclose',
    label: 'Open/Close',
    description: 'Open or close the element under the pointer (All: also everything inside it)',
    props: [{ id: 'all', label: 'All', type: 'bool', default: false }],
    undo: false,
    poll: hasOutliner,
    exec: (ctx, p) => {
      const ol = currentOutliner(ctx)!;
      const r = rowAtPointer(ol) ?? ol.rows[ol.cursorIndex()];
      if (!r?.expandable) return 'CANCELLED';
      ol.toggleOpen(r, !!p.all);
    },
  },
  {
    idname: 'outliner.item_activate',
    label: 'Select',
    description: 'Select and activate the element under the pointer',
    props: [
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'extend_range', label: 'Extend Range', type: 'bool', default: false },
      { id: 'deselect_all', label: 'Deselect On Nothing', type: 'bool', default: false },
      { id: 'recurse', label: 'Recurse', type: 'bool', default: false },
    ],
    undo: false,
    poll: hasOutliner,
    exec: (ctx, p) => {
      const ol = currentOutliner(ctx)!;
      const r = rowAtPointer(ol);
      if (!r) {
        if (p.deselect_all) ol.selectAll('DESELECT');
        return 'CANCELLED';
      }
      ol.clickRow(r, { ctrl: !!p.extend, shift: !!p.extend_range, recurse: !!p.recurse });
    },
  },
  {
    idname: 'outliner.operation',
    label: 'Context Menu',
    description: 'Open the menu of the element under the pointer',
    undo: false,
    poll: hasOutliner,
    exec: (ctx) => {
      const ol = currentOutliner(ctx)!;
      const r = rowAtPointer(ol) ?? ol.rows[ol.cursorIndex()];
      if (!r) return 'CANCELLED';
      openMenu(contextMenuFor(ol, r), { x: app.pointer.x, y: app.pointer.y });
      return 'CANCELLED';
    },
  },
]);

function animdataExec(ctx: OpContext, p: Record<string, unknown>) {
  const obs = targetObjects(ctx).filter((o) => o.animation_data);
  if (!obs.length) return (app.report('WARNING', 'The selected objects have no animation data'), 'CANCELLED' as const);
  for (const ob of obs) {
    const ad = ob.animation_data!;
    if (p.type === 'CLEAR_ANIMDATA') ob.animation_data = null;
    else if (p.type === 'CLEAR_ACT') ad.action = null;
    else if (p.type === 'CLEAR_DRIVERS') ad.drivers = [];
    else if (p.type === 'REFRESH_DRIVERS') for (const d of ad.drivers) (d as unknown as { is_valid?: boolean }).is_valid = true;
  }
  if (p.type === 'REFRESH_DRIVERS') app.graph.invalidate();
  return 'FINISHED' as const;
}

/** The row under the pointer (or null). */
function rowAtPointer(ol: NonNullable<ReturnType<typeof currentOutliner>>): Row | null {
  const el = document.elementFromPoint(app.pointer.x, app.pointer.y)?.closest<HTMLElement>('.ol-row');
  if (!el || !ol.el.contains(el)) return null;
  return ol.rows.find((r) => r.key === el.dataset.key) ?? null;
}

// ---------------------------------------------------------------------------
// row menus of the newer element kinds

kindMenuHooks.strip = (ol): MenuItem[] => [
  { label: 'Select', op: 'outliner.data_operation', props: { type: 'SELECT' } },
  { label: 'Deselect', op: 'outliner.data_operation', props: { type: 'DESELECT' } },
  { label: 'Select Strips Using the Same Data', op: 'outliner.data_operation', props: { type: 'SELECT_LINKED' } },
  { separator: true },
  { label: 'Rename', shortcut: 'F2', action: () => ol.startRename() },
  { label: 'Delete', icon: 'trash', op: 'outliner.data_operation', props: { type: 'DELETE' } },
  ...commonItems(ol),
];

kindMenuHooks.rna = (ol): MenuItem[] => [
  { label: 'Add to Keying Set', shortcut: 'K', op: 'outliner.keyingset_add_selected' },
  { label: 'Remove from Keying Set', shortcut: 'Alt K', op: 'outliner.keyingset_remove_selected' },
  { separator: true },
  { label: 'Add Drivers for Selected', shortcut: 'Ctrl D', op: 'outliner.drivers_add_selected' },
  { label: 'Delete Drivers for Selected', shortcut: 'Ctrl Alt D', op: 'outliner.drivers_delete_selected' },
  ...commonItems(ol),
];

kindMenuHooks.action = (ol, r): MenuItem[] => [
  { label: 'Set Action', op: 'outliner.action_set' },
  { label: 'Unlink Action', op: 'outliner.animdata_operation', props: { type: 'CLEAR_ACT' } },
  { separator: true },
  { label: 'Refresh Drivers', op: 'outliner.animdata_operation', props: { type: 'REFRESH_DRIVERS' } },
  { label: 'Clear Drivers', op: 'outliner.animdata_operation', props: { type: 'CLEAR_DRIVERS' } },
  { separator: true },
  { label: 'Clear Animation Data', op: 'outliner.animdata_operation', props: { type: 'CLEAR_ANIMDATA' } },
  { separator: true },
  { label: 'ID Data', submenu: () => idDataMenu(r) },
  ...commonItems(ol),
];

// ---------------------------------------------------------------------------
// keys (Outliner keymap)

addKeys('Outliner', [
  { key: 'K', op: 'outliner.keyingset_add_selected' },
  { key: 'K', alt: true, op: 'outliner.keyingset_remove_selected' },
  { key: 'D', ctrl: true, op: 'outliner.drivers_add_selected' },
  { key: 'D', ctrl: true, alt: true, op: 'outliner.drivers_delete_selected' },
]);

// Delete in the Data Blocks / Unused Data modes also deletes other data-block types
onAppReady(() => {
  const del = operators.get('outliner.delete');
  if (!del?.exec) return;
  const exec = del.exec;
  const poll = del.poll;
  del.poll = (ctx) => {
    const ol = currentOutliner(ctx);
    if (ol && (ol.displayMode === 'BLENDER_FILE' || ol.displayMode === 'ORPHAN_DATA')) return selectedIdRows(ctx).length > 0;
    return poll ? poll(ctx) : true;
  };
  del.exec = (ctx, p) => {
    const ol = currentOutliner(ctx);
    if (ol && (ol.displayMode === 'BLENDER_FILE' || ol.displayMode === 'ORPHAN_DATA') && selectedIdRows(ctx).some((x) => x.table !== 'objects' && x.table !== 'collections')) return operators.get('outliner.id_delete')!.exec!(ctx, p);
    return exec(ctx, p);
  };
});
