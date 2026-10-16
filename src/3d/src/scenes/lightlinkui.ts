// Object ▸ Shading: Light Linking, Shadow Linking and Light Group panels, the object.light_linking_*
// operators and the Link/Transfer Data entries (Link Receivers / Link Blockers).
import { h, type Child } from '../ui/h';
import { icon, registerIcons } from '../ui/icons';
import { app, registerOperators, type OpContext } from '../app/app';
import { panel, enumMenu, textField } from '../ui/widgets';
import { splitRow } from '../ui/props';
import { openMenu, type MenuItem } from '../ui/menu';
import { newCollection } from '../data/defaults';
import { uniqueName } from '../ops/object';
import type { DocumentData, ID, ObjectData } from '../data/types';
import { objectExtraPanels, worldExtraPanels } from '../editors/properties/tabs';
import { linkDataMenuHooks } from '../object/menus';
import { uiList } from '../editors/properties/uilist';
import { sub } from '../render/final/props/common';
import { linkCollection, linkCollectionName, type LinkKind } from './lightlinking';
import { activeViewLayer } from './viewlayers';
import type { LightLinkState } from './types';

registerIcons({
  // a filled dot inside a ring: the member is lit / blocks
  link_include: '<circle class="s" cx="8" cy="8" r="5.5" fill="none" stroke-width="1.3"/><circle class="f" cx="8" cy="8" r="2.6"/>',
  // a ring crossed out: the member is left out
  link_exclude: '<circle class="s" cx="8" cy="8" r="5.5" fill="none" stroke-width="1.3"/><path class="s" d="M4.2 11.8l7.6-7.6" stroke-width="1.3"/>',
});

const KIND_LABEL: Record<LinkKind, { noun: string; plural: string; collection: string }> = {
  receiver: { noun: 'Receiver', plural: 'Receivers', collection: 'Light Linking' },
  blocker: { noun: 'Blocker', plural: 'Blockers', collection: 'Shadow Linking' },
};

function setLinkCollection(ob: ObjectData, kind: LinkKind, cid: ID | null) {
  ob.light_linking ??= { receiver_collection: null, blocker_collection: null };
  if (kind === 'receiver') ob.light_linking.receiver_collection = cid;
  else ob.light_linking.blocker_collection = cid;
  if (!ob.light_linking.receiver_collection && !ob.light_linking.blocker_collection) delete ob.light_linking;
}

/** Create a linking collection for the emitter (not linked into the scene) and assign it. */
function newLinkCollection(doc: DocumentData, ob: ObjectData, kind: LinkKind): ID {
  const c = newCollection(uniqueName(doc, linkCollectionName(ob, kind), 'collections'));
  doc.collections[c.id] = c;
  setLinkCollection(ob, kind, c.id);
  return c.id;
}

const emitter = (ctx: OpContext) => (ctx.doc.mode === 'OBJECT' ? app.activeObject : null);

function linkOps(kind: LinkKind) {
  const L = KIND_LABEL[kind];
  const plural = L.plural.toLowerCase();
  return registerOperators([
    {
      idname: `object.light_linking_${kind}_collection_new`,
      label: `New ${L.collection} Collection`,
      description: `Create a collection of ${plural} for the active object and use it for ${L.collection.toLowerCase()}`,
      icon: 'collection_new',
      poll: (ctx) => !!emitter(ctx),
      exec: (ctx) => {
        const ob = emitter(ctx)!;
        newLinkCollection(ctx.doc, ob, kind);
      },
    },
    {
      idname: `object.light_linking_${plural}_link`,
      label: `Link ${L.plural}`,
      description: `Add the selected objects to the active object's ${L.collection.toLowerCase()} collection`,
      props: [
        {
          id: 'link_state',
          label: 'Link State',
          type: 'enum',
          default: 'INCLUDE',
          items: [
            ['INCLUDE', 'Include', `The objects are ${kind === 'receiver' ? 'lit by' : 'shadowing'} the emitter`],
            ['EXCLUDE', 'Exclude', `The objects are left out of the emitter's ${kind === 'receiver' ? 'light' : 'shadows'}`],
          ],
        },
      ],
      poll: (ctx) => !!emitter(ctx) && app.selectedObjects().some((o) => o.id !== app.activeObject?.id),
      exec: (ctx, p) => {
        const ob = emitter(ctx)!;
        let cid = linkCollection(ob, kind);
        if (!cid || !ctx.doc.collections[cid]) cid = newLinkCollection(ctx.doc, ob, kind);
        const c = ctx.doc.collections[cid];
        const state = p.link_state === 'EXCLUDE' ? 'EXCLUDE' : 'INCLUDE';
        for (const o of app.selectedObjects()) {
          if (o.id === ob.id) continue;
          if (!c.objects.includes(o.id)) c.objects.push(o.id);
          (c.light_linking ??= {})[o.id] = state;
        }
      },
    },
    {
      idname: `object.light_linking_${plural}_select`,
      label: `Select ${L.plural}`,
      description: `Select the objects of the active object's ${L.collection.toLowerCase()} collection`,
      poll: (ctx) => !!linkCollection(emitter(ctx) ?? undefined, kind),
      exec: (ctx) => {
        const cid = linkCollection(emitter(ctx)!, kind)!;
        const c = ctx.doc.collections[cid];
        if (!c) return 'CANCELLED';
        const members = new Set(c.objects);
        for (const ch of c.children) for (const o of ctx.doc.collections[ch]?.objects ?? []) members.add(o);
        for (const o of Object.values(ctx.doc.objects)) o.select = members.has(o.id) && app.isSelectable(o.id);
        app.changed('select');
      },
    },
  ]);
}
linkOps('receiver');
linkOps('blocker');

registerOperators([
  {
    idname: 'object.light_linking_unlink_from_collection',
    label: 'Remove From Linking Collection',
    description: 'Remove an object or collection from the light or shadow linking collection',
    props: [
      { id: 'collection', label: 'Collection', type: 'string', default: '', hidden: true },
      { id: 'item', label: 'Item', type: 'string', default: '', hidden: true },
    ],
    exec: (ctx, p) => {
      const c = ctx.doc.collections[String(p.collection)];
      const id = String(p.item);
      if (!c || (!c.objects.includes(id) && !c.children.includes(id))) return 'CANCELLED';
      c.objects = c.objects.filter((x) => x !== id);
      c.children = c.children.filter((x) => x !== id);
      if (c.light_linking) delete c.light_linking[id];
    },
  },
]);

/** Link/Transfer Data entries (Ctrl L). */
function linkTransferItems(): MenuItem[] {
  const states = (op: string) => () => [
    { label: 'Include', op, props: { link_state: 'INCLUDE' } },
    { label: 'Exclude', op, props: { link_state: 'EXCLUDE' } },
  ];
  return [
    { label: 'Link Receivers', submenu: states('object.light_linking_receivers_link') },
    { label: 'Link Blockers', submenu: states('object.light_linking_blockers_link') },
  ];
}
linkDataMenuHooks.bottom.push(() => [{ separator: true }, ...linkTransferItems()]);

// ---------------------------------------------------------------------------
// panels

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

/** active row of each linking list (UI state, not saved) */
const listIndex = new Map<string, number>();

function linkPanel(o: ObjectData, kind: LinkKind): Child {
  const doc = app.doc;
  const L = KIND_LABEL[kind];
  const cid = linkCollection(o, kind);
  const c = cid ? doc.collections[cid] : undefined;
  const cols = Object.values(doc.collections)
    .filter((x) => x.id !== doc.scene.collection)
    .sort((a, b) => a.name.localeCompare(b.name));
  const rows: Child[] = [
    splitRow(
      'Collection',
      h(
        'div',
        { class: 'id-selector' },
        enumMenu(`ll-${kind}-col-${o.id}`, [{ value: '', label: '—' }, ...cols.map((x) => ({ value: x.id, label: x.name, icon: 'collection' }))], cid ?? '', (v) => {
          setLinkCollection(o, kind, v || null);
          changed(`Set ${L.collection} Collection`);
        }),
        c
          ? h('button', { class: 'ids-btn', 'data-tip': `Clear\nStop using a collection for ${L.collection.toLowerCase()}`, onclick: () => (setLinkCollection(o, kind, null), changed(`Clear ${L.collection} Collection`)) }, icon('x'))
          : h('button', { class: 'ids-btn', 'data-tip': `New\nCreate a ${L.collection.toLowerCase()} collection for this object`, onclick: () => app.run(`object.light_linking_${kind}_collection_new`) }, icon('add')),
      ),
    ),
  ];
  if (c) {
    const items = [...c.children.filter((id) => doc.collections[id]).map((id) => ({ id, name: doc.collections[id].name, coll: true })), ...c.objects.filter((id) => doc.objects[id]).map((id) => ({ id, name: doc.objects[id].name, coll: false }))];
    const stateOf = (id: ID): LightLinkState => c.light_linking?.[id] ?? 'INCLUDE';
    rows.push(
      uiList(
        `ll-${kind}-${c.id}`,
        items.map((it) => ({
          key: it.id,
          label: it.name,
          icon: it.coll ? 'collection' : 'object',
          rightSize: 'compact' as const,
          right: [
            h(
              'button',
              {
                class: { 'll-state': true, exclude: stateOf(it.id) === 'EXCLUDE' },
                'data-tip': stateOf(it.id) === 'EXCLUDE' ? `Excluded\nLeft out of the ${kind === 'receiver' ? 'light' : 'shadows'} (click to include)` : `Included\n${kind === 'receiver' ? 'Lit by' : 'Casts shadows from'} the emitter (click to exclude)`,
                onpointerdown: (e: PointerEvent) => e.stopPropagation(),
                onclick: (e: MouseEvent) => {
                  e.stopPropagation();
                  (c.light_linking ??= {})[it.id] = stateOf(it.id) === 'EXCLUDE' ? 'INCLUDE' : 'EXCLUDE';
                  changed('Change Link State');
                },
              },
              icon(stateOf(it.id) === 'EXCLUDE' ? 'link_exclude' : 'link_include'),
            ),
            h(
              'button',
              {
                class: 'll-state',
                'data-tip': `Remove\nRemove from the ${L.collection.toLowerCase()} collection`,
                onpointerdown: (e: PointerEvent) => e.stopPropagation(),
                onclick: (e: MouseEvent) => (e.stopPropagation(), app.run('object.light_linking_unlink_from_collection', { collection: c.id, item: it.id }, { invoke: false })),
              },
              icon('x'),
            ),
          ],
        })),
        Math.min(items.length - 1, Math.max(0, listIndex.get(`${kind}:${o.id}`) ?? 0)),
        (i) => {
          listIndex.set(`${kind}:${o.id}`, i);
          app.changed('ui');
        },
        { specials: () => [{ label: `Select ${L.plural}`, op: `object.light_linking_${L.plural.toLowerCase()}_select` }] },
      ),
      items.length ? null : h('div', { class: 'prop-note' }, `Select objects, then the emitter, and use Link/Transfer Data ▸ Link ${L.plural} (Ctrl L)`),
    );
  }
  return rows;
}

function lightGroupRow(o: { lightgroup?: string }, id: string): Child {
  const vl = activeViewLayer(app.doc.scene);
  const groups = (vl.lightgroups ?? []).map((g) => g.name);
  const cur = o.lightgroup ?? '';
  const missing = !!cur && !groups.includes(cur);
  return splitRow(
    'Light Group',
    h(
      'div',
      { class: 'id-selector' },
      textField(`lg-${id}`, cur, (v) => {
        const n = v.trim();
        if (n) o.lightgroup = n;
        else delete o.lightgroup;
        changed('Set Light Group');
      }, { placeholder: 'None' }),
      h(
        'button',
        {
          class: 'ids-btn',
          'data-tip': 'Light Groups\nPick one of the view layer’s light groups',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              groups.length
                ? [{ label: 'None', active: !cur, action: () => (delete o.lightgroup, changed('Set Light Group')) }, ...groups.map((g) => ({ label: g, active: g === cur, action: () => ((o.lightgroup = g), changed('Set Light Group')) }))]
                : [{ label: 'The view layer has no light groups', disabled: true }],
              e.currentTarget as HTMLElement,
            );
          },
        },
        icon('down_arrow_hlt', 'tiny'),
      ),
      missing
        ? h('button', { class: 'ids-btn', 'data-tip': `Add Lightgroup\nAdd “${cur}” to the view layer’s light groups`, onclick: () => app.run('scene.view_layer_add_lightgroup', { name: cur }, { invoke: false }) }, icon('add'))
        : null,
    ),
  );
}

objectExtraPanels.push((o) =>
  panel(
    'ob-shading',
    'Shading',
    () => [
      sub('ob-light-linking', 'Light Linking', () => linkPanel(o, 'receiver'), { closed: !o.light_linking?.receiver_collection }),
      sub('ob-shadow-linking', 'Shadow Linking', () => linkPanel(o, 'blocker'), { closed: !o.light_linking?.blocker_collection }),
      sub('ob-lightgroup', 'Light Group', () => [lightGroupRow(o, o.id)], { closed: !o.lightgroup }),
    ],
    { closed: true },
  ),
);

// World ▸ Light Group: the light group of the world's light
worldExtraPanels.push((w) => panel('wo-lightgroup', 'Light Group', () => [lightGroupRow(w, `wo-${w.id}`)], { closed: !w.lightgroup }));
