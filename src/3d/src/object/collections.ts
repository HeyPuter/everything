// Object properties ▸ Collections: the collections an object belongs to, with add/link/remove,
// plus collection-level helpers (unlink from the scene, select its objects).
import { app, registerOperators, type OpContext } from '../app/app';
import { newCollection } from '../data/defaults';
import type { DocumentData, ObjectData } from '../data/types';
import { uniqueName } from '../ops/object';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { openMenu, type MenuItem } from '../ui/menu';
import { textField } from '../ui/widgets';
import { vecProp } from '../ui/props';

const objectMode = (ctx: OpContext) => ctx.doc.mode === 'OBJECT';

function findCollection(doc: DocumentData, key: unknown) {
  return doc.collections[key as string] ?? Object.values(doc.collections).find((c) => c.name === key);
}

/** Collections reachable from the scene. */
function inScene(doc: DocumentData): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    if (out.has(id) || !doc.collections[id]) return;
    out.add(id);
    for (const ch of doc.collections[id].children) walk(ch);
  };
  walk(doc.scene.collection);
  return out;
}

registerOperators([
  {
    idname: 'object.collection_add',
    label: 'Add to New Collection',
    description: 'Put the active object into a new collection (not shown in the scene, handy for instancing)',
    poll: (ctx) => objectMode(ctx) && !!app.activeObject,
    exec: (ctx) => {
      const c = newCollection(uniqueName(ctx.doc, 'Collection', 'collections'));
      ctx.doc.collections[c.id] = c;
      c.objects.push(app.activeObject!.id);
    },
  },
  {
    idname: 'object.collection_link',
    label: 'Link to Collection',
    description: 'Also put the active object into an existing collection',
    props: [{ id: 'collection', label: 'Collection', type: 'string', default: '' }],
    poll: (ctx) => objectMode(ctx) && !!app.activeObject,
    exec: (ctx, p) => {
      const c = findCollection(ctx.doc, p.collection);
      const ob = app.activeObject!;
      if (!c || c.objects.includes(ob.id)) return 'CANCELLED';
      c.objects.push(ob.id);
    },
  },
  {
    idname: 'object.collection_remove',
    label: 'Remove from Collection',
    description: 'Take the active object out of this collection',
    props: [{ id: 'collection', label: 'Collection', type: 'string', default: '' }],
    poll: (ctx) => objectMode(ctx) && !!app.activeObject,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const c = findCollection(doc, p.collection);
      const ob = app.activeObject!;
      if (!c) return 'CANCELLED';
      const scene = inScene(doc);
      const stillShown = Object.values(doc.collections).some((x) => x !== c && scene.has(x.id) && x.objects.includes(ob.id));
      if (scene.has(c.id) && !stillShown) {
        app.report('WARNING', 'The object would no longer be in the scene; link it to another collection first');
        return 'CANCELLED';
      }
      c.objects = c.objects.filter((x) => x !== ob.id);
    },
  },
  {
    idname: 'object.collection_unlink',
    label: 'Unlink Collection',
    description: 'Take the collection out of the scene hierarchy (it is kept as data, e.g. for instancing)',
    props: [{ id: 'collection', label: 'Collection', type: 'string', default: '' }],
    poll: (ctx) => objectMode(ctx),
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const c = findCollection(doc, p.collection);
      if (!c || c.id === doc.scene.collection) return 'CANCELLED';
      for (const x of Object.values(doc.collections)) x.children = x.children.filter((ch) => ch !== c.id);
    },
  },
  {
    idname: 'object.collection_objects_select',
    label: 'Select Objects in Collection',
    description: 'Select every object of the collection',
    props: [{ id: 'collection', label: 'Collection', type: 'string', default: '' }],
    poll: (ctx) => objectMode(ctx),
    exec: (ctx, p) => {
      const c = findCollection(ctx.doc, p.collection);
      if (!c) return 'CANCELLED';
      for (const id of c.objects) if (ctx.doc.objects[id] && app.isSelectable(id)) ctx.doc.objects[id].select = true;
    },
  },
]);

function addMenu(o: ObjectData): MenuItem[] {
  const doc = app.doc;
  const others = Object.values(doc.collections).filter((c) => !c.objects.includes(o.id) && c.id !== doc.scene.collection);
  return [{ label: 'New Collection', icon: 'add', op: 'object.collection_add' }, ...(others.length ? [{ separator: true }] : []), ...others.map((c) => ({ label: c.name, icon: 'collection', op: 'object.collection_link', props: { collection: c.id } }))];
}

/** Body of the Object properties ▸ Collections panel. */
export function objectCollectionsPanel(o: ObjectData): Child {
  const doc = app.doc;
  const mine = Object.values(doc.collections).filter((c) => c.objects.includes(o.id));
  const menuButton = (items: () => MenuItem[], ...content: Child[]) =>
    h(
      'button',
      {
        class: 'icon-btn',
        'data-tip': 'More options',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          openMenu(items(), e.currentTarget as HTMLElement);
        },
      },
      ...content,
    );
  return [
    h(
      'div',
      { class: 'stack-toolbar' },
      h(
        'button',
        {
          class: 'btn add-mod',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(addMenu(o), e.currentTarget as HTMLElement);
          },
        },
        icon('add'),
        'Add to Collection',
        icon('down_arrow_hlt', 'tiny'),
      ),
    ),
    mine.map((c) => {
      const master = c.id === doc.scene.collection;
      return h(
        'div',
        { key: c.id, class: 'col-box' },
        h(
          'div',
          { class: 'col-box-head' },
          icon(master ? 'scene' : 'collection'),
          master ? h('span', { class: 'col-box-name' }, 'Scene Collection') : textField(`obcol-${c.id}`, c.name, (v) => ((c.name = uniqueName(doc, v, 'collections')), app.pushUndo('Rename Collection'), app.changed('doc'))),
          menuButton(
            () => [
              { label: 'Unlink Collection', op: 'object.collection_unlink', props: { collection: c.id }, disabled: master },
              { label: 'Select Objects in Collection', op: 'object.collection_objects_select', props: { collection: c.id } },
            ],
            icon('down_arrow_hlt'),
          ),
          h('button', { class: 'icon-btn', 'data-tip': 'Remove from collection', onclick: () => app.run('object.collection_remove', { collection: c.id }) }, icon('x')),
        ),
        master ? null : vecProp(c, 'instance_offset', 'Offset', { unit: 'distance' }),
      );
    }),
  ];
}
