// Outliner context menus: collections, objects, data-blocks, modifiers, constraints, empty space.
import type { MenuItem } from '../../ui/menu';
import { registerIcons } from '../../ui/icons';
import { app } from '../../app/app';
import { keymaps, keyLabel } from '../../app/keymap';
import type { Outliner } from '../outliner';
import type { Row } from './tree';

/** Collection color tags (also used by the outliner stylesheet). */
export const COLOR_TAGS: [string, string][] = [
  ['COLOR_01', '#de5a49'],
  ['COLOR_02', '#eb9e35'],
  ['COLOR_03', '#e2d346'],
  ['COLOR_04', '#61be61'],
  ['COLOR_05', '#538ddf'],
  ['COLOR_06', '#a368d5'],
  ['COLOR_07', '#d56ba2'],
  ['COLOR_08', '#977a57'],
];

registerIcons(Object.fromEntries(COLOR_TAGS.map(([t, c]) => [`collection_${t.toLowerCase()}`, `<path stroke="${c}" d="M2 5h12v8H2zM4 3h8" fill="none" stroke-width="1.4"/>`])));

/** Shortcut of an operator call in the Outliner keymap (exact property match). */
function outlinerShortcut(op: string, props: Record<string, unknown> = {}): string {
  for (const k of keymaps.Outliner ?? []) {
    if (k.op !== op) continue;
    const kp = k.props ?? {};
    const keys = new Set([...Object.keys(kp), ...Object.keys(props)]);
    if ([...keys].every((key) => (kp[key] ?? false) === (props[key] ?? false))) return keyLabel(k);
  }
  return '';
}

/** Fill in shortcuts from the Outliner keymap (also inside submenus). */
function withShortcuts(items: MenuItem[]): MenuItem[] {
  return items.map((it) => {
    if (it.submenu) {
      const sub = it.submenu;
      return { ...it, submenu: () => withShortcuts(sub()) };
    }
    if (it.op && it.shortcut === undefined) return { ...it, shortcut: outlinerShortcut(it.op, it.props) };
    return it;
  });
}

export function viewMenu(ol: Outliner): MenuItem[] {
  void ol;
  return [
    { label: 'Show Active', op: 'outliner.show_active' },
    { separator: true },
    { label: 'Expand/Collapse All', op: 'outliner.expanded_toggle' },
    { label: 'Show Object Hierarchy', op: 'outliner.show_hierarchy' },
    {
      label: 'Show One Level',
      op: 'outliner.show_one_level',
      props: { open: true },
    },
    {
      label: 'Hide One Level',
      op: 'outliner.show_one_level',
      props: { open: false },
    },
  ];
}

function common(ol: Outliner): MenuItem[] {
  return [{ separator: true }, { label: 'View', submenu: () => viewMenu(ol) }, { separator: true }, { label: 'Area', submenu: () => ol.area.areaMenu() }];
}

const idItem = (type: string, label: string, extra: Partial<MenuItem> = {}): MenuItem => ({
  label,
  op: 'outliner.id_operation',
  props: { type },
  ...extra,
});

/** Small badges drawn after a row's name (e.g. the asset mark). */
export const rowBadgeHooks: ((r: Row) => import('../../ui/h').Child)[] = [];

/** Extra entries of data-block rows (e.g. the Assets submenu), shown before ID Data. */
export const rowMenuHooks: ((r: Row) => MenuItem[])[] = [];
const hookItems = (r: Row) => rowMenuHooks.flatMap((f) => f(r));

/** The ID Data operations available for a row. */
export function idDataMenu(r: Row): MenuItem[] {
  const fake = r.table !== 'objects' && r.table !== 'collections';
  const single = r.kind === 'data' || r.kind === 'material' || r.kind === 'action';
  return [
    idItem('UNLINK', 'Unlink', {
      disabled: r.kind === 'data' || (r.kind === 'id' && r.table !== 'collections'),
    }),
    ...(single ? [idItem('SINGLE', 'Make Single User')] : []),
    idItem('DELETE', 'Delete'),
    { separator: true },
    idItem('COPY', 'Copy', { disabled: !app.poll('outliner.id_copy') }),
    idItem('PASTE', 'Paste', { disabled: !app.poll('outliner.id_paste') }),
    ...(fake ? [{ separator: true }, idItem('ADD_FAKE', 'Add Fake User'), idItem('CLEAR_FAKE', 'Clear Fake User')] : []),
    { separator: true },
    idItem('RENAME', 'Rename', { shortcut: 'F2' }),
    idItem('SELECT_LINKED', 'Select Linked'),
  ];
}

function collectionMenu(ol: Outliner, r: Row): MenuItem[] {
  const isMaster = r.id === app.doc.scene.collection;
  if (isMaster)
    return [
      {
        label: 'New Collection',
        op: 'outliner.collection_new',
        props: { nested: true },
      },
      { label: 'Paste Data-Blocks', op: 'outliner.id_paste' },
      { separator: true },
      {
        label: 'Select Objects',
        op: 'outliner.collection_objects_select',
        props: { collection: r.id },
      },
      {
        label: 'Deselect Objects',
        op: 'outliner.collection_objects_deselect',
        props: { collection: r.id },
      },
      ...common(ol),
    ];
  return [
    { label: 'New', op: 'outliner.collection_new', props: { nested: true } },
    { label: 'Duplicate Collection', op: 'outliner.collection_duplicate' },
    { label: 'Duplicate Linked', op: 'outliner.collection_duplicate_linked' },
    { label: 'Copy', op: 'outliner.id_copy' },
    { label: 'Paste', op: 'outliner.id_paste' },
    { separator: true },
    { label: 'Delete', op: 'outliner.delete' },
    {
      label: 'Delete Hierarchy',
      op: 'outliner.delete',
      props: { hierarchy: true },
    },
    { separator: true },
    { label: 'Select Objects', op: 'outliner.collection_objects_select' },
    { label: 'Deselect Objects', op: 'outliner.collection_objects_deselect' },
    { separator: true },
    { label: 'Instance to Scene', op: 'outliner.collection_instance' },
    { separator: true },
    {
      label: 'Visibility',
      submenu: () => [
        { label: 'Isolate', op: 'outliner.collection_isolate' },
        { separator: true },
        { label: 'Show', op: 'outliner.collection_show' },
        { label: 'Show All Inside', op: 'outliner.collection_show_inside' },
        { label: 'Hide', op: 'outliner.collection_hide' },
        { label: 'Hide All Inside', op: 'outliner.collection_hide_inside' },
        { separator: true },
        { label: 'Enable in Viewports', op: 'outliner.collection_enable' },
        { label: 'Disable in Viewports', op: 'outliner.collection_disable' },
        { separator: true },
        { label: 'Enable in Render', op: 'outliner.collection_enable_render' },
        {
          label: 'Disable in Render',
          op: 'outliner.collection_disable_render',
        },
      ],
    },
    { separator: true },
    {
      label: 'View Layer',
      submenu: () => [
        {
          label: 'Disable from View Layer',
          op: 'outliner.collection_exclude_set',
        },
        {
          label: 'Enable in View Layer',
          op: 'outliner.collection_exclude_clear',
        },
        { separator: true },
        { label: 'Set Holdout', op: 'outliner.collection_holdout_set' },
        { label: 'Clear Holdout', op: 'outliner.collection_holdout_clear' },
        { separator: true },
        {
          label: 'Set Indirect Only',
          op: 'outliner.collection_indirect_only_set',
        },
        {
          label: 'Clear Indirect Only',
          op: 'outliner.collection_indirect_only_clear',
        },
      ],
    },
    { separator: true },
    {
      label: 'Set Color Tag',
      submenu: () => [
        {
          label: 'None',
          icon: 'collection',
          active: r.collection?.color_tag === 'NONE',
          op: 'outliner.collection_color_tag_set',
          props: { color: 'NONE' },
        },
        ...COLOR_TAGS.map(([t]) => ({
          label: `Color 0${t.slice(-1)}`,
          icon: `collection_${t.toLowerCase()}`,
          op: 'outliner.collection_color_tag_set',
          props: { color: t },
        })),
      ],
    },
    { separator: true },
    ...hookItems(r),
    { label: 'ID Data', submenu: () => idDataMenu(r) },
    ...common(ol),
  ];
}

function objectMenu(ol: Outliner, r: Row): MenuItem[] {
  const fileMode = ol.displayMode === 'BLENDER_FILE' || ol.displayMode === 'ORPHAN_DATA';
  return [
    { label: 'Copy', op: 'outliner.id_copy' },
    { label: 'Paste', op: 'outliner.id_paste' },
    { separator: true },
    { label: 'Delete', op: 'outliner.delete' },
    {
      label: 'Delete Hierarchy',
      op: 'outliner.delete',
      props: { hierarchy: true },
    },
    { separator: true },
    {
      label: 'Select',
      op: 'outliner.object_operation',
      props: { type: 'SELECT' },
    },
    {
      label: 'Select Hierarchy',
      op: 'outliner.object_operation',
      props: { type: 'SELECT_HIERARCHY' },
    },
    {
      label: 'Deselect',
      op: 'outliner.object_operation',
      props: { type: 'DESELECT' },
    },
    { separator: true },
    ...(fileMode || !r.parentCollection
      ? []
      : [
          {
            label: 'Unlink from Collection',
            op: 'outliner.id_operation',
            props: { type: 'UNLINK' },
          },
          { separator: true },
        ]),
    ...hookItems(r),
    { label: 'ID Data', submenu: () => idDataMenu(r) },
    ...common(ol),
  ];
}

export function contextMenuFor(ol: Outliner, r: Row): MenuItem[] {
  return withShortcuts(rowMenu(ol, r));
}

function rowMenu(ol: Outliner, r: Row): MenuItem[] {
  switch (r.kind) {
    case 'collection':
      return collectionMenu(ol, r);
    case 'object':
      return objectMenu(ol, r);
    case 'data':
    case 'material':
    case 'action':
    case 'id':
      return [...idDataMenu(r), ...(hookItems(r).length ? [{ separator: true }, ...hookItems(r)] : []), ...common(ol)];
    case 'modifier':
    case 'modifiers':
      return [
        {
          label: 'Toggle Viewport Use',
          op: 'outliner.modifier_operation',
          props: { type: 'TOGVIS' },
        },
        {
          label: 'Toggle Render Use',
          op: 'outliner.modifier_operation',
          props: { type: 'TOGREN' },
        },
        { separator: true },
        {
          label: 'Delete',
          op: 'outliner.modifier_operation',
          props: { type: 'DELETE' },
        },
        ...common(ol),
      ];
    case 'constraint':
    case 'constraints':
      return [
        {
          label: 'Enable',
          op: 'outliner.constraint_operation',
          props: { type: 'ENABLE' },
        },
        {
          label: 'Disable',
          op: 'outliner.constraint_operation',
          props: { type: 'DISABLE' },
        },
        { separator: true },
        {
          label: 'Delete',
          op: 'outliner.constraint_operation',
          props: { type: 'DELETE' },
        },
        ...common(ol),
      ];
    default:
      return [
        {
          label: 'Rename',
          shortcut: 'F2',
          disabled: !ol.canRename(r),
          action: () => ol.startRename(r.key),
        },
        ...common(ol),
      ];
  }
}

export function emptyMenu(ol: Outliner): MenuItem[] {
  return withShortcuts(emptyItems(ol));
}

function emptyItems(ol: Outliner): MenuItem[] {
  if (ol.displayMode === 'ORPHAN_DATA') return [{ label: 'Purge Unused Data', op: 'outliner.orphans_purge' }, ...common(ol)];
  if (ol.displayMode === 'BLENDER_FILE') return common(ol).slice(1);
  return [
    {
      label: 'New Collection',
      op: 'outliner.collection_new',
      props: { nested: true },
    },
    { label: 'Paste Data-Blocks', op: 'outliner.id_paste' },
    ...common(ol),
  ];
}
