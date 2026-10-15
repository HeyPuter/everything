// Object Mode selection operators: grow/shrink along parent links, select by collection.
import { app, registerOperators, type OpContext } from '../app/app';
import type { DocumentData, ObjectData } from '../data/types';
import { openMenu } from '../ui/menu';
import { setActiveTool } from '../editors/view3d/toolbar';
import { activeView3D } from '../editors/view3d/view3d';

const objectMode = (ctx: OpContext) => ctx.doc.mode === 'OBJECT';

function childrenOf(doc: DocumentData): Map<string, ObjectData[]> {
  const out = new Map<string, ObjectData[]>();
  for (const o of Object.values(doc.objects)) {
    if (!o.parent) continue;
    const list = out.get(o.parent);
    if (list) list.push(o);
    else out.set(o.parent, [o]);
  }
  return out;
}

/** Objects one parent-link away from the selection (parents and children). */
export function growSelection(doc: DocumentData, selectable: (id: string) => boolean): string[] {
  const kids = childrenOf(doc);
  const add = new Set<string>();
  for (const o of Object.values(doc.objects)) {
    if (!o.select) continue;
    if (o.parent && doc.objects[o.parent] && !doc.objects[o.parent].select) add.add(o.parent);
    for (const c of kids.get(o.id) ?? []) if (!c.select) add.add(c.id);
  }
  return [...add].filter(selectable);
}

/** Selected objects on the edge of the selected hierarchy: their parent or a child is unselected. */
export function shrinkSelection(doc: DocumentData): string[] {
  const kids = childrenOf(doc);
  const drop: string[] = [];
  for (const o of Object.values(doc.objects)) {
    if (!o.select) continue;
    const parentOut = !!o.parent && !!doc.objects[o.parent] && !doc.objects[o.parent].select;
    const childOut = (kids.get(o.id) ?? []).some((c) => !c.select);
    if (parentOut || childOut) drop.push(o.id);
  }
  return drop;
}

function selectCollection(ctx: OpContext, p: Record<string, unknown>) {
  const c = Object.values(ctx.doc.collections).find((x) => x.name === p.collection || x.id === p.collection);
  if (!c) {
    app.report('ERROR', `Collection "${String(p.collection)}" not found`);
    return 'CANCELLED' as const;
  }
  for (const id of c.objects) if (ctx.doc.objects[id] && app.isSelectable(id)) ctx.doc.objects[id].select = true;
}

registerOperators([
  {
    idname: 'view3d.select_lasso_tool',
    label: 'Lasso Select',
    description: 'Switch to the lasso selection tool',
    poll: () => !!activeView3D(),
    exec: () => {
      setActiveTool('builtin.select_lasso');
    },
    undo: false,
  },
  {
    idname: 'object.select_more',
    label: 'Select More',
    description: 'Also select the parents and children of the selected objects',
    poll: objectMode,
    exec: (ctx) => {
      const ids = growSelection(ctx.doc, (id) => app.isSelectable(id));
      if (!ids.length) return 'CANCELLED';
      for (const id of ids) ctx.doc.objects[id].select = true;
    },
  },
  {
    idname: 'object.select_less',
    label: 'Select Less',
    description: 'Deselect objects whose parent or children are not selected',
    poll: objectMode,
    exec: (ctx) => {
      const ids = shrinkSelection(ctx.doc);
      if (!ids.length) return 'CANCELLED';
      for (const id of ids) ctx.doc.objects[id].select = false;
    },
  },
  {
    idname: 'object.select_same_collection',
    label: 'Select Same Collection',
    description: 'Select every object in a collection',
    props: [{ id: 'collection', label: 'Collection', type: 'string', default: '' }],
    poll: objectMode,
    invoke: (ctx, p) => {
      if (p.collection) return selectCollection(ctx, p);
      const cols = Object.values(ctx.doc.collections).filter((c) => c.objects.length);
      openMenu(
        cols.map((c) => ({ label: c.name, icon: c.id === ctx.doc.scene.collection ? 'scene' : 'collection', action: () => app.run('object.select_same_collection', { collection: c.name }, { invoke: false }) })),
        { x: app.pointer.x, y: app.pointer.y },
        { title: 'Select Same Collection' },
      );
      return 'CANCELLED';
    },
    exec: selectCollection,
  },
]);
