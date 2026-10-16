// Dynamic item lists of nodes: the sidebar list editor (the list logic and operators are in
// itemcore.ts and re-exported here).
import { h, type Child } from '../../ui/h';
import { enumMenu } from '../../ui/widgets';
import { splitRow } from '../../ui/props';
import { app } from '../../app/app';
import { uiList } from '../../editors/properties/uilist';
import type { NodeDrawContext } from '../../nodes/types';
import { writeItems, type NodeItem } from './itemdata';
import { activeIndex, addItem, listItems, moveActiveItem, removeItem, uniqueName, type ItemListDef } from './itemcore';

export * from './itemcore';

/** Sidebar list editor for the items of a node. */
export function itemListUI(ctx: NodeDrawContext, def: ItemListDef, items: NodeItem[] = listItems(ctx.node, def)): Child {
  const n = ctx.node;
  const ak = activeKeyOf(def);
  const tk = typeKeyOf(def);
  const active = activeIndex(n, def, items);
  const cur = items[active];
  const set = (list: NodeItem[], label: string) => {
    writeItems(n, def.prop, list);
    ctx.changed(label, true);
  };
  const update = (patch: Partial<NodeItem>) =>
    set(
      items.map((x) => (x === cur ? { ...x, ...patch } : x)),
      'Change Item',
    );
  return h(
    'div',
    { class: 'gn-items gn-zone-items' },
    h('div', { class: 'sub-label' }, def.title),
    uiList(
      `${ctx.key}:${def.prop}`,
      items.map((it, i) => ({ key: String(it.id), label: def.named === false ? String(i) : it.name })),
      active,
      (i) => {
        n.props[ak] = i;
        ctx.changed('Select Item', false);
        app.changed('ui');
      },
      {
        add: () => {
          addItem(n, def, items);
          n.props[ak] = items.length;
          ctx.changed('Add Item', true);
        },
        remove:
          cur && items.length > (def.min ?? 0)
            ? () => {
                removeItem(ctx.tree, n, def, cur.id);
                n.props[ak] = Math.max(0, active - 1);
                ctx.changed('Remove Item', true);
              }
            : undefined,
        rename:
          def.named === false
            ? undefined
            : (i, name) => {
                if (!name) return;
                set(
                  items.map((x, k) =>
                    k === i
                      ? {
                          ...x,
                          name: uniqueName(
                            items.filter((y) => y !== x),
                            name,
                          ),
                        }
                      : x,
                  ),
                  'Rename Item',
                );
              },
        up: () => moveActiveItem(n, def, -1) && ctx.changed('Move Item', true),
        down: () => moveActiveItem(n, def, 1) && ctx.changed('Move Item', true),
        rows: 3,
      },
    ),
    cur && def.types
      ? splitRow(
          'Type',
          enumMenu(
            `${ctx.key}:${def.prop}:type:${cur.id}`,
            def.types.map(([value, label]) => ({ value, label })),
            String((cur as Record<string, unknown>)[tk] ?? def.types[0][0]),
            (v) => update({ [tk]: v } as Partial<NodeItem>),
          ),
        )
      : null,
    cur && def.extra ? def.extra(ctx, cur, update) : null,
  );
}

const typeKeyOf = (def: ItemListDef) => def.typeKey ?? 'type';
const activeKeyOf = (def: ItemListDef) => def.activeKey ?? 'active_index';
