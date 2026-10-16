// Outliner operators and the Outliner keymap.
import { app, registerOperators, operators, onAppReady, type OpContext, type Operator } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { openPie } from '../../ui/menu';
import { uniqueName, deleteObjects, activeCollection, setActiveCollection } from '../../ops/object';
import { uid } from '../../data/defaults';
import type { DocumentData, ObjectData } from '../../data/types';
import { currentOutliner } from './current';
import { DATA_TABLE, objectHierarchy, objectsInside, parentCollection, type Row } from './tree';
import * as C from './collections';
import { removeDataBlock } from '../../scripting/api';
import { makeLocal, lockLinked } from '../../library/core';
import { deleteIds } from './ops_more';

const hasOutliner = (ctx: OpContext) => !!currentOutliner(ctx);
const notIdMode = (ctx: OpContext) => {
  const o = currentOutliner(ctx);
  return !!o && (o.displayMode === 'VIEW_LAYER' || o.displayMode === 'SCENES');
};

/** Collections an operator acts on: an explicit id, else the outliner selection, else the active collection. */
function targetCollections(ctx: OpContext, p: Record<string, unknown>): string[] {
  if (p.collection) return [p.collection as string].filter((id) => ctx.doc.collections[id]);
  const ol = currentOutliner(ctx);
  const sel = ol?.selectedCollections() ?? [];
  if (sel.length) return sel;
  const act = activeCollection(ctx.doc);
  return act && act !== ctx.doc.scene.collection ? [act] : [];
}

const collectionProp = {
  id: 'collection',
  label: 'Collection',
  type: 'string' as const,
  default: '',
  hidden: true,
};

function collectionFlagOps(): Operator[] {
  const defs: [string, string, string, C.CollectionFlag, boolean][] = [
    ['collection_exclude_set', 'Disable from View Layer', 'Exclude the selected collections from the view layer', 'exclude', true],
    ['collection_exclude_clear', 'Enable in View Layer', 'Include the selected collections in the view layer again', 'exclude', false],
    ['collection_holdout_set', 'Set Holdout', 'Mask out the objects of the selected collections in renders', 'holdout', true],
    ['collection_holdout_clear', 'Clear Holdout', 'Stop masking out the objects of the selected collections', 'holdout', false],
    ['collection_indirect_only_set', 'Set Indirect Only', 'Objects of the selected collections only contribute indirectly (shadows, reflections)', 'indirect_only', true],
    ['collection_indirect_only_clear', 'Clear Indirect Only', 'Objects of the selected collections render normally again', 'indirect_only', false],
    ['collection_hide', 'Hide Collection', 'Hide the selected collections in the viewport', 'hide', true],
    ['collection_enable', 'Enable Collection', 'Enable the selected collections in all viewports', 'hide_viewport', false],
    ['collection_disable', 'Disable Collection', 'Disable the selected collections in all viewports', 'hide_viewport', true],
    ['collection_enable_render', 'Enable Collection in Render', 'Render the selected collections', 'hide_render', false],
    ['collection_disable_render', 'Disable Collection in Render', 'Leave the selected collections out of renders', 'hide_render', true],
  ];
  return defs.map(([name, label, description, flag, value]) => ({
    idname: `outliner.${name}`,
    label,
    description,
    props: [collectionProp],
    poll: (ctx: OpContext) => targetCollections(ctx, {}).length > 0 || hasOutliner(ctx),
    exec: (ctx: OpContext, p: Record<string, unknown>) => {
      const ids = targetCollections(ctx, p);
      if (!ids.length) return 'CANCELLED';
      C.setCollectionFlag(ctx.doc, ids, flag, value);
      if (value && (flag === 'hide' || flag === 'exclude' || flag === 'hide_viewport'))
        for (const id of ids) for (const o of objectsInside(ctx.doc, id)) if (!app.isVisible(o)) ctx.doc.objects[o].select = false;
    },
  }));
}

/** Rows the ID Data operations act on, encoded as "table:id:context". */
function idTargetsFromSelection(ctx: OpContext): string[] {
  const ol = currentOutliner(ctx);
  if (!ol) return [];
  const out: string[] = [];
  const enc = (r: Row) => {
    if (r.kind === 'object' && r.ob) return `objects:${r.ob.id}:${r.parentCollection ?? ''}`;
    if (r.kind === 'collection' && r.id) return `collections:${r.id}:${parentCollection(ctx.doc, r.id)?.id ?? ''}`;
    if ((r.kind === 'data' || r.kind === 'material' || r.kind === 'action' || r.kind === 'id') && r.table && r.id) return `${r.table}:${r.id}:${r.ob?.id ?? ''}`;
    return null;
  };
  const rows = ol.selectedRows();
  const act = ol.rows.find((r) => r.ekey === ol.activeKey);
  for (const r of act && !rows.includes(act) ? [act, ...rows] : rows) {
    const e = enc(r);
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

function tableOf(doc: DocumentData, t: string) {
  return (doc as unknown as Record<string, Record<string, { id: string; name: string; use_fake_user?: boolean }>>)[t];
}

function copyDataBlock(doc: DocumentData, table: string, id: string): string | null {
  const src = tableOf(doc, table)?.[id];
  if (!src) return null;
  const c = structuredClone(src);
  c.id = uid(table.slice(0, 2));
  c.name = uniqueName(doc, src.name, table as 'meshes');
  c.use_fake_user = false;
  tableOf(doc, table)[c.id] = c;
  return c.id;
}

/** Does any object use this data-block in a way the given operation can act on? */
function objectsUsing(doc: DocumentData, table: string, id: string): ObjectData[] {
  return Object.values(doc.objects).filter((o) => {
    if (table === 'materials') {
      const d = o.data
        ? ((DATA_TABLE[o.type] && tableOf(doc, DATA_TABLE[o.type])?.[o.data]) as unknown as {
            materials?: (string | null)[];
          })
        : undefined;
      return !!d?.materials?.includes(id) || !!o.object_materials?.includes(id);
    }
    if (table === 'actions') return o.animation_data?.action === id;
    if (table === 'collections') return objectsInside(doc, id).includes(o.id) || o.instance_collection === id;
    if (table === 'objects') return o.id === id;
    return o.data === id;
  });
}

function idOperation(doc: DocumentData, type: string, targets: string[]): number {
  let n = 0;
  for (const t of targets) {
    const [table, id, context] = t.split(':');
    const rec = tableOf(doc, table)?.[id];
    if (!rec) continue;
    switch (type) {
      case 'UNLINK': {
        if (table === 'objects') {
          const col = context && doc.collections[context] ? context : parentCollectionOfObject(doc, id);
          if (col) doc.collections[col].objects = doc.collections[col].objects.filter((x) => x !== id);
        } else if (table === 'collections') {
          const parent = context && doc.collections[context] ? doc.collections[context] : parentCollection(doc, id);
          if (parent) parent.children = parent.children.filter((x) => x !== id);
        } else if (table === 'materials' && context && doc.objects[context]) {
          const ob = doc.objects[context];
          const d = ob.data
            ? (tableOf(doc, DATA_TABLE[ob.type])?.[ob.data] as unknown as {
                materials?: (string | null)[];
              })
            : undefined;
          if (d?.materials) d.materials = d.materials.map((m) => (m === id ? null : m));
          if (ob.object_materials) ob.object_materials = ob.object_materials.map((m) => (m === id ? null : m));
        } else if (table === 'actions' && context && doc.objects[context]?.animation_data?.action === id) doc.objects[context].animation_data!.action = null;
        else if (table === 'worlds' && doc.scene.world === id) doc.scene.world = null;
        else continue;
        n++;
        break;
      }
      case 'SINGLE': {
        const users = objectsUsing(doc, table, id);
        const ob = context ? doc.objects[context] : undefined;
        if (!ob || users.length < 2 || table === 'objects' || table === 'collections') continue;
        const nid = copyDataBlock(doc, table, id);
        if (!nid) continue;
        if (table === 'materials') {
          const d = ob.data
            ? (tableOf(doc, DATA_TABLE[ob.type])?.[ob.data] as unknown as {
                materials?: (string | null)[];
              })
            : undefined;
          if (d?.materials) d.materials = d.materials.map((m) => (m === id ? nid : m));
        } else if (table === 'actions' && ob.animation_data) ob.animation_data.action = nid;
        else if (ob.data === id) ob.data = nid;
        n++;
        break;
      }
      case 'LOCAL': {
        // linked data-blocks (and overrides) become regular local data
        const r = rec as { library?: string; override_library?: object };
        if (!r.library && !r.override_library) continue;
        makeLocal(doc, [id]);
        lockLinked(doc);
        n++;
        break;
      }
      case 'DELETE':
        if ((rec as { library?: string }).library) {
          n += deleteIds(doc, [{ table, id }]);
          continue;
        }
        if (table === 'objects') deleteObjects(doc, new Set([id]));
        else if (table === 'collections') C.deleteCollections(doc, [id], false);
        else removeDataBlock(table, id);
        n++;
        break;
      case 'ADD_FAKE':
      case 'CLEAR_FAKE':
        if (table === 'objects' || table === 'collections') continue;
        rec.use_fake_user = type === 'ADD_FAKE';
        n++;
        break;
      case 'SELECT_LINKED': {
        const obs = objectsUsing(doc, table, id);
        for (const o of obs) if (!o.hide) o.select = true;
        if (obs[0]) doc.scene.active_object = obs[0].id;
        n += obs.length;
        break;
      }
    }
  }
  return n;
}

function idExec(ctx: OpContext, p: Record<string, unknown>) {
  const targets = ((p.targets as string) || idTargetsFromSelection(ctx).join('|')).split('|').filter(Boolean);
  if (idOperation(ctx.doc, p.type as string, targets)) return 'FINISHED' as const;
  app.report('WARNING', 'Nothing to do for the selected elements');
  return 'CANCELLED' as const;
}

function parentCollectionOfObject(doc: DocumentData, id: string) {
  return Object.values(doc.collections).find((c) => c.objects.includes(id))?.id;
}

function selectedObjectIds(ctx: OpContext): string[] {
  return ctx.doc.object_order.filter((id) => ctx.doc.objects[id]?.select);
}

registerOperators([
  // ---------------------------------------------------------------- view / selection
  {
    idname: 'outliner.item_rename',
    label: 'Rename',
    description: 'Rename the active element (or the one under the mouse)',
    props: [
      {
        id: 'use_active',
        label: 'Use Active',
        type: 'bool',
        default: false,
        hidden: true,
      },
    ],
    poll: hasOutliner,
    exec: (ctx) => (currentOutliner(ctx)!.startRename() ? 'FINISHED' : 'CANCELLED'),
    undo: false,
  },
  {
    idname: 'outliner.select_all',
    label: 'Toggle Selected',
    description: 'Select, deselect or invert the selection of all outliner elements',
    props: [
      {
        id: 'action',
        label: 'Action',
        type: 'enum',
        default: 'TOGGLE',
        items: [
          ['TOGGLE', 'Toggle'],
          ['SELECT', 'Select'],
          ['DESELECT', 'Deselect'],
          ['INVERT', 'Invert'],
        ],
      },
    ],
    poll: hasOutliner,
    // the selection change pushes its own undo step
    exec: (ctx, p) => currentOutliner(ctx)!.selectAll(p.action as 'SELECT'),
    undo: false,
  },
  {
    idname: 'outliner.select_box',
    label: 'Box Select',
    description: 'Select the elements inside a box drawn over the outliner',
    poll: hasOutliner,
    invoke: (ctx) => {
      currentOutliner(ctx)!.startBoxSelect();
      return 'RUNNING_MODAL';
    },
    exec: () => 'CANCELLED',
    undo: false,
  },
  {
    idname: 'outliner.select_walk',
    label: 'Walk Select',
    description: 'Move the active element with the arrow keys; Left/Right close and open elements',
    props: [
      {
        id: 'direction',
        label: 'Direction',
        type: 'enum',
        default: 'UP',
        items: [
          ['UP', 'Up'],
          ['DOWN', 'Down'],
          ['LEFT', 'Left'],
          ['RIGHT', 'Right'],
        ],
      },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'toggle_all', label: 'Toggle All', type: 'bool', default: false },
    ],
    poll: hasOutliner,
    exec: (ctx, p) => currentOutliner(ctx)!.walk(p.direction as 'UP', !!p.extend, !!p.toggle_all),
    undo: false,
  },
  {
    idname: 'outliner.show_active',
    label: 'Show Active',
    description: 'Open the parents of the active element and scroll it into view',
    poll: hasOutliner,
    exec: (ctx) => currentOutliner(ctx)!.showActive(),
    undo: false,
  },
  {
    idname: 'outliner.show_hierarchy',
    label: 'Show Hierarchy',
    description: 'Open the object hierarchy and close everything else',
    poll: hasOutliner,
    exec: (ctx) => currentOutliner(ctx)!.showHierarchy(),
    undo: false,
  },
  {
    idname: 'outliner.show_one_level',
    label: 'Show/Hide One Level',
    description: 'Expand or collapse one more level of the tree',
    props: [{ id: 'open', label: 'Open', type: 'bool', default: true }],
    poll: hasOutliner,
    exec: (ctx, p) => currentOutliner(ctx)!.showOneLevel(!!p.open),
    undo: false,
  },
  {
    idname: 'outliner.expanded_toggle',
    label: 'Expand/Collapse All',
    description: 'Expand every element, or collapse all of them when everything is open',
    poll: hasOutliner,
    exec: (ctx) => currentOutliner(ctx)!.expandedToggle(),
    undo: false,
  },
  {
    idname: 'outliner.scroll_page',
    label: 'Scroll Page',
    props: [{ id: 'up', label: 'Up', type: 'bool', default: false }],
    poll: hasOutliner,
    exec: (ctx, p) => currentOutliner(ctx)!.scrollPage(!!p.up),
    undo: false,
  },
  {
    idname: 'outliner.start_filter',
    label: 'Filter',
    description: 'Start typing in the outliner search field',
    poll: hasOutliner,
    exec: (ctx) => currentOutliner(ctx)!.focusSearch(),
    undo: false,
  },
  {
    idname: 'outliner.clear_filter',
    label: 'Clear Filter',
    description: 'Clear the outliner search',
    poll: hasOutliner,
    exec: (ctx) => {
      const o = currentOutliner(ctx)!;
      o.search = '';
      o.redraw();
    },
    undo: false,
  },
  // ---------------------------------------------------------------- collections
  {
    idname: 'outliner.collection_new',
    label: 'New Collection',
    description: 'Add a new collection inside the selected collection',
    props: [{ id: 'nested', label: 'Nested', type: 'bool', default: true }],
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const sel = p.nested ? (currentOutliner(ctx)?.selectedCollections() ?? []) : [];
      const parent = sel[0] ?? (p.nested ? activeCollection(doc) : doc.scene.collection);
      const id = C.addCollection(doc, doc.collections[parent] ? parent : doc.scene.collection);
      setActiveCollection(id);
      const ol = currentOutliner(ctx);
      if (ol) {
        ol.sel.clear();
        ol.sel.add(`c:${id}`);
        ol.activeKey = `c:${id}`;
        ol.setOpen(`c:${parent}`, true);
      }
    },
  },
  {
    idname: 'outliner.collection_duplicate',
    label: 'Duplicate Collection',
    description: 'Copy the collection with its objects and child collections; object data is copied as well',
    props: [collectionProp],
    poll: (ctx) => targetCollections(ctx, {}).length > 0,
    exec: (ctx, p) => {
      const ids = targetCollections(ctx, p);
      const made = ids.map((id) => C.duplicateCollection(ctx.doc, id, false)).filter(Boolean) as string[];
      if (!made.length) return 'CANCELLED';
      setActiveCollection(made[0]);
    },
  },
  {
    idname: 'outliner.collection_duplicate_linked',
    label: 'Duplicate Linked',
    description: 'Copy the collection with its objects and child collections, sharing object data with the originals',
    props: [collectionProp],
    poll: (ctx) => targetCollections(ctx, {}).length > 0,
    exec: (ctx, p) => {
      const ids = targetCollections(ctx, p);
      const made = ids.map((id) => C.duplicateCollection(ctx.doc, id, true)).filter(Boolean) as string[];
      if (!made.length) return 'CANCELLED';
      setActiveCollection(made[0]);
    },
  },
  {
    idname: 'outliner.collection_delete',
    label: 'Delete Collection',
    props: [collectionProp, { id: 'hierarchy', label: 'Hierarchy', type: 'bool', default: false }],
    poll: (ctx) => targetCollections(ctx, {}).length > 0,
    exec: (ctx, p) => (C.deleteCollections(ctx.doc, targetCollections(ctx, p), !!p.hierarchy) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'outliner.delete',
    label: 'Delete',
    description: 'Delete the selected objects and collections',
    props: [{ id: 'hierarchy', label: 'Hierarchy', type: 'bool', default: false }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && hasOutliner(ctx),
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const ol = currentOutliner(ctx);
      const cols = ol?.selectedCollections() ?? [];
      const obs = new Set(selectedObjectIds(ctx));
      if (ol && !ol.filter.use_sync_select) for (const r of ol.selectedRows('object')) obs.add(r.ob!.id);
      if (p.hierarchy) for (const id of [...obs]) objectHierarchy(doc, id).forEach((x) => obs.add(x));
      if (!cols.length && !obs.size) return 'CANCELLED';
      const nCols = C.deleteCollections(doc, cols, !!p.hierarchy);
      const nObs = [...obs].filter((id) => doc.objects[id]).length;
      deleteObjects(doc, new Set([...obs].filter((id) => doc.objects[id])));
      ol?.sel.clear();
      app.report('INFO', `Deleted ${nObs ? `${nObs} object(s)` : ''}${nObs && nCols ? ' and ' : ''}${nCols ? `${nCols} collection(s)` : ''}`);
    },
  },
  {
    idname: 'outliner.collection_objects_select',
    label: 'Select Objects',
    description: 'Select the objects in the collection (including child collections)',
    props: [
      collectionProp,
      {
        id: 'deselect',
        label: 'Deselect',
        type: 'bool',
        default: false,
        hidden: true,
      },
    ],
    poll: (ctx) => targetCollections(ctx, {}).length > 0,
    exec: (ctx, p) => {
      const ids = targetCollections(ctx, p);
      if (!ids.length) return 'CANCELLED';
      for (const c of ids) for (const id of objectsInside(ctx.doc, c)) if (app.isVisible(id) || p.deselect) ctx.doc.objects[id].select = !p.deselect;
    },
  },
  {
    idname: 'outliner.collection_objects_deselect',
    label: 'Deselect Objects',
    description: 'Deselect the objects in the collection (including child collections)',
    props: [collectionProp],
    poll: (ctx) => targetCollections(ctx, {}).length > 0,
    exec: (ctx, p) => {
      const ids = targetCollections(ctx, p);
      if (!ids.length) return 'CANCELLED';
      for (const c of ids) for (const id of objectsInside(ctx.doc, c)) ctx.doc.objects[id].select = false;
    },
  },
  {
    idname: 'outliner.collection_instance',
    label: 'Instance to Scene',
    description: 'Add an instance of the selected collections to the scene at the 3D cursor',
    props: [collectionProp],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && targetCollections(ctx, {}).length > 0,
    exec: (ctx, p) => {
      const ids = targetCollections(ctx, p);
      let n = 0;
      for (const id of ids) {
        const op = operators.get('object.collection_instance_add');
        if (
          op?.exec?.(ctx, {
            collection: id,
            location: null,
            rotation: null,
            align: 'WORLD',
          }) !== 'CANCELLED'
        )
          n++;
      }
      return n ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'outliner.collection_isolate',
    label: 'Isolate Collection',
    description: 'Hide all collections except this one, its parents and its children',
    props: [collectionProp, { id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: (ctx) => targetCollections(ctx, {}).length > 0,
    exec: (ctx, p) => {
      const ids = targetCollections(ctx, p);
      if (!ids.length) return 'CANCELLED';
      if (p.extend) for (const id of ids) C.showCollection(ctx.doc, id);
      else {
        C.isolateCollection(ctx.doc, ids[0]);
        for (const id of ids.slice(1)) C.showCollection(ctx.doc, id);
      }
      for (const o of Object.values(ctx.doc.objects)) if (o.select && !app.isVisible(o.id)) o.select = false;
    },
  },
  {
    idname: 'outliner.collection_show',
    label: 'Show Collection',
    description: 'Show the selected collections (and their parents) in the viewport',
    props: [collectionProp],
    poll: (ctx) => targetCollections(ctx, {}).length > 0,
    exec: (ctx, p) => {
      const ids = targetCollections(ctx, p);
      if (!ids.length) return 'CANCELLED';
      for (const id of ids) C.showCollection(ctx.doc, id);
    },
  },
  {
    idname: 'outliner.collection_show_inside',
    label: 'Show Inside Collection',
    description: 'Show every child collection and object inside the selected collections',
    props: [collectionProp],
    poll: (ctx) => targetCollections(ctx, {}).length > 0,
    exec: (ctx, p) => {
      const ids = targetCollections(ctx, p);
      if (!ids.length) return 'CANCELLED';
      for (const id of ids) C.setInsideHidden(ctx.doc, id, false);
    },
  },
  {
    idname: 'outliner.collection_hide_inside',
    label: 'Hide Inside Collection',
    description: 'Hide every child collection and object inside the selected collections',
    props: [collectionProp],
    poll: (ctx) => targetCollections(ctx, {}).length > 0,
    exec: (ctx, p) => {
      const ids = targetCollections(ctx, p);
      if (!ids.length) return 'CANCELLED';
      for (const id of ids) C.setInsideHidden(ctx.doc, id, true);
    },
  },
  ...collectionFlagOps(),
  {
    idname: 'outliner.collection_color_tag_set',
    label: 'Set Color Tag',
    description: 'Set a color tag for the selected collections',
    props: [
      collectionProp,
      {
        id: 'color',
        label: 'Color Tag',
        type: 'enum',
        default: 'NONE',
        items: [['NONE', 'None'], ...([1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`COLOR_0${i}`, `Color 0${i}`]) as [string, string][])],
      },
    ],
    poll: (ctx) => targetCollections(ctx, {}).length > 0,
    exec: (ctx, p) => {
      const ids = targetCollections(ctx, p);
      if (!ids.length) return 'CANCELLED';
      for (const id of ids) ctx.doc.collections[id].color_tag = p.color as 'NONE';
    },
  },
  // ---------------------------------------------------------------- objects / visibility
  {
    idname: 'outliner.hide',
    label: 'Hide Selected',
    description: 'Hide the selected objects and collections',
    poll: notIdMode,
    exec: (ctx) => {
      const doc = ctx.doc;
      const cols = currentOutliner(ctx)?.selectedCollections() ?? [];
      const obs = selectedObjectIds(ctx);
      if (!cols.length && !obs.length) return 'CANCELLED';
      C.setCollectionFlag(doc, cols, 'hide', true);
      for (const id of obs) {
        doc.objects[id].hide = true;
        doc.objects[id].select = false;
      }
    },
  },
  {
    idname: 'outliner.unhide_all',
    label: 'Unhide All',
    description: 'Show all objects and collections in the view layer',
    poll: notIdMode,
    exec: (ctx) => {
      const doc = ctx.doc;
      for (const c of Object.values(doc.collections)) c.hide = false;
      for (const o of Object.values(doc.objects)) o.hide = false;
    },
  },
  {
    idname: 'outliner.object_operation',
    label: 'Outliner Object Operation',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'SELECT',
        items: [
          ['SELECT', 'Select'],
          ['DESELECT', 'Deselect'],
          ['SELECT_HIERARCHY', 'Select Hierarchy'],
          ['REMAP', 'Remap Users'],
          ['RENAME', 'Rename'],
        ],
      },
    ],
    poll: (ctx) => hasOutliner(ctx) && Object.keys(ctx.doc.objects).length > 0,
    invoke: (ctx, p) => {
      if (p.type === 'REMAP') return (void app.run('outliner.id_remap'), 'CANCELLED');
      if (p.type === 'RENAME') return (void currentOutliner(ctx)?.startRename(), 'CANCELLED');
      return operators.get('outliner.object_operation')!.exec!(ctx, p);
    },
    exec: (ctx, p) => {
      if (p.type === 'REMAP' || p.type === 'RENAME') return 'CANCELLED';
      const doc = ctx.doc;
      const ol = currentOutliner(ctx);
      const ids = ol ? ol.selectedRows('object').map((r) => r.ob!.id) : selectedObjectIds(ctx);
      const act = doc.scene.active_object;
      if (!ids.length && act) ids.push(act);
      if (!ids.length) return 'CANCELLED';
      if (p.type === 'DESELECT') for (const id of ids) doc.objects[id].select = false;
      else if (p.type === 'SELECT') for (const id of ids) doc.objects[id].select = !doc.objects[id].hide;
      else for (const id of ids) for (const x of objectHierarchy(doc, id)) if (!doc.objects[x].hide) doc.objects[x].select = true;
    },
  },
  {
    idname: 'outliner.object_select_hierarchy',
    label: 'Select Hierarchy',
    props: [
      {
        id: 'object',
        label: 'Object',
        type: 'string',
        default: '',
        hidden: true,
      },
    ],
    exec: (ctx, p) => {
      const id = (p.object as string) || ctx.doc.scene.active_object;
      if (!id || !ctx.doc.objects[id]) return 'CANCELLED';
      for (const x of objectHierarchy(ctx.doc, id)) ctx.doc.objects[x].select = true;
    },
  },
  {
    idname: 'outliner.object_delete_hierarchy',
    label: 'Delete Hierarchy',
    props: [
      {
        id: 'object',
        label: 'Object',
        type: 'string',
        default: '',
        hidden: true,
      },
    ],
    exec: (ctx, p) => {
      const id = (p.object as string) || ctx.doc.scene.active_object;
      if (!id || !ctx.doc.objects[id]) return 'CANCELLED';
      deleteObjects(ctx.doc, new Set(objectHierarchy(ctx.doc, id)));
    },
  },
  {
    idname: 'outliner.id_copy',
    label: 'Copy',
    description: 'Copy the selected objects to the internal clipboard',
    poll: (ctx) => app.poll('view3d.copybuffer', ctx.area),
    exec: () => void app.run('view3d.copybuffer', {}, { invoke: false }),
    undo: false,
  },
  {
    idname: 'outliner.id_paste',
    label: 'Paste',
    description: 'Paste objects from the internal clipboard into the active collection',
    poll: (ctx) => app.poll('view3d.pastebuffer', ctx.area),
    exec: () => void app.run('view3d.pastebuffer', {}, { invoke: false }),
    undo: false,
  },
  {
    idname: 'outliner.id_operation',
    label: 'Outliner ID Data Operation',
    description: 'Data-block operations on the selected outliner elements',
    props: [
      {
        id: 'type',
        label: 'ID Data Operation',
        type: 'enum',
        default: 'UNLINK',
        items: [
          ['UNLINK', 'Unlink'],
          ['LOCAL', 'Make Local'],
          ['SINGLE', 'Make Single User'],
          ['DELETE', 'Delete'],
          ['REMAP', 'Remap Users'],
          ['COPY', 'Copy'],
          ['PASTE', 'Paste'],
          ['ADD_FAKE', 'Add Fake User'],
          ['CLEAR_FAKE', 'Clear Fake User'],
          ['RENAME', 'Rename'],
          ['SELECT_LINKED', 'Select Linked'],
        ],
      },
      {
        id: 'targets',
        label: 'Targets',
        type: 'string',
        default: '',
        hidden: true,
      },
    ],
    poll: hasOutliner,
    invoke: (ctx, p) => {
      // interactive variants: rename in place, copy / paste through the clipboard operators
      if (p.type === 'RENAME') return (void currentOutliner(ctx)?.startRename(), 'CANCELLED');
      if (p.type === 'COPY') return (void app.run('outliner.id_copy', {}, { invoke: false }), 'CANCELLED');
      if (p.type === 'PASTE') return (void app.run('outliner.id_paste', {}, { invoke: false }), 'CANCELLED');
      if (p.type === 'REMAP') return (void app.run('outliner.id_remap'), 'CANCELLED');
      // fix the targets so Adjust Last Operation re-runs on the same elements
      p.targets = (p.targets as string) || idTargetsFromSelection(ctx).join('|');
      return idExec(ctx, p);
    },
    exec: (ctx, p) => idExec(ctx, p),
  },
  {
    idname: 'outliner.material_drop',
    label: 'Drag Material to Object',
    description: 'Assign a material to an object by dragging it from the outliner',
    props: [
      {
        id: 'object',
        label: 'Object',
        type: 'string',
        default: '',
        hidden: true,
      },
      {
        id: 'material',
        label: 'Material',
        type: 'string',
        default: '',
        hidden: true,
      },
    ],
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const ob = doc.objects[p.object as string];
      const mat = doc.materials[p.material as string];
      if (!ob || !mat || !ob.data) return 'CANCELLED';
      const d = tableOf(doc, DATA_TABLE[ob.type])?.[ob.data] as unknown as { materials?: (string | null)[] } | undefined;
      if (!d) return 'CANCELLED';
      d.materials ??= [];
      // the dropped material replaces the active slot's material (a slot is added when there is none)
      if (!d.materials.length) d.materials.push(mat.id);
      else {
        const i = Math.max(0, Math.min(d.materials.length - 1, ob.active_material_index));
        if (ob.material_slots_link?.[i] === 'OBJECT' && ob.object_materials) ob.object_materials[i] = mat.id;
        else d.materials[i] = mat.id;
        ob.active_material_index = i;
      }
    },
  },
  {
    idname: 'outliner.modifier_operation',
    label: 'Outliner Modifier Operation',
    props: [
      {
        id: 'type',
        label: 'Modifier Operation',
        type: 'enum',
        default: 'TOGVIS',
        items: [
          ['TOGVIS', 'Toggle Viewport Use'],
          ['TOGREN', 'Toggle Render Use'],
          ['DELETE', 'Delete'],
        ],
      },
      {
        id: 'targets',
        label: 'Targets',
        type: 'string',
        default: '',
        hidden: true,
      },
    ],
    poll: hasOutliner,
    exec: (ctx, p) => {
      const ol = currentOutliner(ctx);
      const targets =
        (p.targets as string) ||
        (ol
          ?.selectedRows('modifier')
          .map((r) => `${r.ob!.id}:${r.id}`)
          .join('|') ??
          '');
      let n = 0;
      for (const t of targets.split('|').filter(Boolean)) {
        const [obId, mid] = t.split(':');
        const ob = ctx.doc.objects[obId];
        const i = ob?.modifiers.findIndex((m) => m.id === mid) ?? -1;
        if (!ob || i < 0) continue;
        const m = ob.modifiers[i];
        if (p.type === 'TOGVIS') m.show_viewport = !m.show_viewport;
        else if (p.type === 'TOGREN') m.show_render = !m.show_render;
        else ob.modifiers.splice(i, 1);
        n++;
      }
      if (!n) return 'CANCELLED';
      app.graph.invalidate();
    },
  },
  {
    idname: 'outliner.constraint_operation',
    label: 'Outliner Constraint Operation',
    props: [
      {
        id: 'type',
        label: 'Constraint Operation',
        type: 'enum',
        default: 'ENABLE',
        items: [
          ['ENABLE', 'Enable'],
          ['DISABLE', 'Disable'],
          ['DELETE', 'Delete'],
        ],
      },
      {
        id: 'targets',
        label: 'Targets',
        type: 'string',
        default: '',
        hidden: true,
      },
    ],
    poll: hasOutliner,
    exec: (ctx, p) => {
      const ol = currentOutliner(ctx);
      const targets =
        (p.targets as string) ||
        (ol
          ?.selectedRows('constraint')
          .map((r) => `${r.ob!.id}:${r.id}`)
          .join('|') ??
          '');
      let n = 0;
      for (const t of targets.split('|').filter(Boolean)) {
        const [obId, cid] = t.split(':');
        const ob = ctx.doc.objects[obId];
        const i = ob?.constraints.findIndex((c) => c.id === cid) ?? -1;
        if (!ob || i < 0) continue;
        if (p.type === 'DELETE') ob.constraints.splice(i, 1);
        else ob.constraints[i].mute = p.type !== 'ENABLE';
        n++;
      }
      if (!n) return 'CANCELLED';
      app.graph.invalidate();
    },
  },
]);

// Numbered collection visibility (also used in the 3D view's object mode). Registered once the
// app is ready so another module may provide its own implementation first.
onAppReady(() => {
  if (operators.has('object.hide_collection')) return;
  registerOperators([
    {
      idname: 'object.hide_collection',
      label: 'Hide Other Collections',
      description: 'Show only the objects of the numbered collection (Shift: toggle it)',
      props: [
        {
          id: 'collection_index',
          label: 'Collection Index',
          type: 'int',
          default: 0,
          min: 0,
        },
        { id: 'extend', label: 'Extend', type: 'bool', default: false },
      ],
      exec: (ctx, p) => {
        if (!C.hideCollectionByIndex(ctx.doc, p.collection_index as number, !!p.extend)) return 'CANCELLED';
        for (const o of Object.values(ctx.doc.objects)) if (o.select && !app.isVisible(o.id)) o.select = false;
      },
    },
  ]);
});

// ---------------------------------------------------------------------------
// keymap

const DIGITS = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'ZERO'];

addKeys('Outliner', [
  { key: 'F2', op: 'outliner.item_rename', props: { use_active: true } },
  { key: 'B', op: 'outliner.select_box' },
  { key: 'UP_ARROW', op: 'outliner.select_walk', props: { direction: 'UP' } },
  {
    key: 'UP_ARROW',
    shift: true,
    op: 'outliner.select_walk',
    props: { direction: 'UP', extend: true },
  },
  {
    key: 'DOWN_ARROW',
    op: 'outliner.select_walk',
    props: { direction: 'DOWN' },
  },
  {
    key: 'DOWN_ARROW',
    shift: true,
    op: 'outliner.select_walk',
    props: { direction: 'DOWN', extend: true },
  },
  {
    key: 'LEFT_ARROW',
    op: 'outliner.select_walk',
    props: { direction: 'LEFT' },
  },
  {
    key: 'LEFT_ARROW',
    shift: true,
    op: 'outliner.select_walk',
    props: { direction: 'LEFT', toggle_all: true },
  },
  {
    key: 'RIGHT_ARROW',
    op: 'outliner.select_walk',
    props: { direction: 'RIGHT' },
  },
  {
    key: 'RIGHT_ARROW',
    shift: true,
    op: 'outliner.select_walk',
    props: { direction: 'RIGHT', toggle_all: true },
  },
  {
    key: 'ACCENT_GRAVE',
    action: () =>
      openPie(
        'View',
        [
          {
            label: 'Show Hierarchy',
            icon: 'outliner_hierarchy',
            op: 'outliner.show_hierarchy',
          },
          {
            label: 'Show Active',
            icon: 'outliner_show_active',
            op: 'outliner.show_active',
          },
          {
            label: 'Hide One Level',
            op: 'outliner.show_one_level',
            props: { open: false },
          },
          {
            label: 'Show One Level',
            op: 'outliner.show_one_level',
            props: { open: true },
          },
        ],
        app.pointer.x,
        app.pointer.y,
        'ACCENT_GRAVE',
      ),
  },
  { key: 'HOME', op: 'outliner.show_hierarchy' },
  { key: 'PERIOD', op: 'outliner.show_active' },
  { key: 'NUMPAD_PERIOD', op: 'outliner.show_active' },
  { key: 'PAGE_DOWN', op: 'outliner.scroll_page', props: { up: false } },
  { key: 'PAGE_UP', op: 'outliner.scroll_page', props: { up: true } },
  { key: 'NUMPAD_PLUS', op: 'outliner.show_one_level', props: { open: true } },
  {
    key: 'NUMPAD_MINUS',
    op: 'outliner.show_one_level',
    props: { open: false },
  },
  { key: 'A', op: 'outliner.select_all', props: { action: 'SELECT' } },
  {
    key: 'A',
    alt: true,
    op: 'outliner.select_all',
    props: { action: 'DESELECT' },
  },
  {
    key: 'I',
    ctrl: true,
    op: 'outliner.select_all',
    props: { action: 'INVERT' },
  },
  { key: 'A', shift: true, op: 'outliner.expanded_toggle' },
  { key: 'I', op: 'anim.keyframe_insert' },
  { key: 'I', alt: true, op: 'anim.keyframe_delete_v3d' },
  { key: 'C', op: 'outliner.collection_new', props: { nested: true } },
  { key: 'X', op: 'outliner.delete' },
  { key: 'DEL', op: 'outliner.delete' },
  { key: 'M', op: 'object.move_to_collection' },
  { key: 'M', shift: true, op: 'object.link_to_collection' },
  { key: 'E', op: 'outliner.collection_exclude_set' },
  { key: 'E', alt: true, op: 'outliner.collection_exclude_clear' },
  { key: 'H', op: 'outliner.hide' },
  { key: 'H', alt: true, op: 'outliner.unhide_all' },
  { key: 'F', ctrl: true, op: 'outliner.start_filter' },
  { key: 'F', alt: true, op: 'outliner.clear_filter' },
  { key: 'C', ctrl: true, op: 'outliner.id_copy' },
  { key: 'V', ctrl: true, op: 'outliner.id_paste' },
  ...DIGITS.map((key, i) => ({
    key,
    op: 'object.hide_collection',
    props: { collection_index: i + 1, extend: false },
  })),
  ...DIGITS.map((key, i) => ({
    key,
    alt: true,
    op: 'object.hide_collection',
    props: { collection_index: i + 11, extend: false },
  })),
  ...DIGITS.map((key, i) => ({
    key,
    shift: true,
    op: 'object.hide_collection',
    props: { collection_index: i + 1, extend: true },
  })),
  ...DIGITS.map((key, i) => ({
    key,
    shift: true,
    alt: true,
    op: 'object.hide_collection',
    props: { collection_index: i + 11, extend: true },
  })),
]);

export { idOperation, targetCollections };
