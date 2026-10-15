// Header and context menus of the node editor (entries refer to node.* operators).
import type { MenuItem } from '../../ui/menu';
import { shortcutLabel } from '../../app/keymap';

interface EdLike {
  showSidebar: boolean;
  showToolbar: boolean;
  path: unknown[];
  area: { areaMenu(): MenuItem[] };
  provider: { linkViewer?: unknown };
  providerId: string;
  addMenuItems(at?: { x: number; y: number }): MenuItem[];
  swapMenuItems(): MenuItem[];
}

export const GROUPED_TYPES: ['TYPE' | 'COLOR' | 'PREFIX' | 'SUFFIX', string][] = [
  ['TYPE', 'Type'],
  ['COLOR', 'Color'],
  ['PREFIX', 'Prefix'],
  ['SUFFIX', 'Suffix'],
];

/** Shortcut text of an operator from the keymaps. */
const sc = (op: string, props?: Record<string, unknown>) => shortcutLabel(op, props) || undefined;
const opItem = (label: string, op: string, props?: Record<string, unknown>): MenuItem => ({ label, op, props, shortcut: sc(op, props) });

export function viewMenu(ed: EdLike): MenuItem[] {
  return [
    {
      label: 'Toolbar',
      checked: ed.showToolbar,
      shortcut: sc('node.toggle_toolbar'),
      op: 'node.toggle_toolbar',
    },
    {
      label: 'Sidebar',
      checked: ed.showSidebar,
      shortcut: sc('node.toggle_sidebar'),
      op: 'node.toggle_sidebar',
    },
    { separator: true },
    opItem('Zoom In', 'node.zoom', { factor: 1.25 }),
    opItem('Zoom Out', 'node.zoom', { factor: 0.8 }),
    { separator: true },
    opItem('Frame Selected', 'node.view_selected'),
    opItem('Frame All', 'node.view_all'),
    { separator: true },
    { label: 'Area', submenu: () => ed.area.areaMenu() },
  ];
}

export function selectGroupedItems(extend = false): MenuItem[] {
  return GROUPED_TYPES.map(([type, label]) => ({ label, op: 'node.select_grouped', props: { type, extend } }));
}

export function selectMenu(): MenuItem[] {
  return [
    opItem('All', 'node.select_all', { action: 'SELECT' }),
    opItem('None', 'node.select_all', { action: 'DESELECT' }),
    opItem('Invert', 'node.select_all', { action: 'INVERT' }),
    { separator: true },
    opItem('Box Select', 'node.select_box'),
    opItem('Circle Select', 'node.select_circle'),
    {
      label: 'Lasso Select',
      submenu: () => [
        { label: 'Set', op: 'node.select_lasso', props: { mode: 'SET' } },
        { label: 'Extend', op: 'node.select_lasso', props: { mode: 'ADD' } },
        { label: 'Subtract', op: 'node.select_lasso', props: { mode: 'SUB' } },
      ],
    },
    { separator: true },
    opItem('Linked From', 'node.select_linked_from'),
    opItem('Linked To', 'node.select_linked_to'),
    { separator: true },
    { label: 'Select Grouped', submenu: () => selectGroupedItems() },
    opItem('Activate Same Type Previous', 'node.select_same_type_step', { prev: true }),
    opItem('Activate Same Type Next', 'node.select_same_type_step', { prev: false }),
    { separator: true },
    opItem('Find Node...', 'node.find_node'),
  ];
}

export function showHideMenu(ed?: EdLike): MenuItem[] {
  return [
    opItem('Mute', 'node.mute_toggle'),
    opItem('Node Options', 'node.options_toggle'),
    ...(ed?.providerId === 'SHADER' ? [opItem('Node Preview', 'node.preview_toggle')] : []),
    { separator: true },
    opItem('Unconnected Sockets', 'node.hide_socket_toggle'),
    opItem('Collapse', 'node.hide_toggle'),
    opItem('Collapse and Hide Unused Sockets', 'node.collapse_hide_unused_toggle'),
  ];
}

export function nodeMenuItems(ed: EdLike): MenuItem[] {
  return [
    opItem('Move', 'node.translate_attach'),
    opItem('Rotate', 'node.rotate'),
    opItem('Scale', 'node.scale'),
    { separator: true },
    opItem('Cut', 'node.delete_copy_reconnect'),
    opItem('Copy', 'node.clipboard_copy'),
    opItem('Paste', 'node.clipboard_paste'),
    opItem('Duplicate', 'node.duplicate_move'),
    opItem('Duplicate Linked', 'node.duplicate_move_linked'),
    { separator: true },
    opItem('Delete', 'node.delete'),
    opItem('Delete with Reconnect', 'node.delete_reconnect'),
    { separator: true },
    opItem('Join in New Frame', 'node.join'),
    opItem('Remove from Frame', 'node.detach'),
    opItem('Join Group Inputs', 'node.join_nodes'),
    opItem('Join in Named Frame', 'node.join_named'),
    { separator: true },
    opItem('Rename...', 'node.rename'),
    { separator: true },
    opItem('Make Links', 'node.link_make', { replace: false }),
    opItem('Make and Replace Links', 'node.link_make', { replace: true }),
    opItem('Cut Links', 'node.links_cut'),
    opItem('Detach Links', 'node.links_detach'),
    opItem('Mute Links', 'node.links_mute'),
    { separator: true },
    opItem('Make Group', 'node.group_make'),
    opItem('Insert Into Group', 'node.group_insert'),
    opItem('Edit Group', 'node.group_edit', { exit: false }),
    opItem('Ungroup', 'node.group_ungroup'),
    ...(ed.path.length ? [{ label: 'Separate', submenu: () => separateItems() }] : []),
    { separator: true },
    { label: 'Swap', submenu: () => ed.swapMenuItems() },
    { label: 'Show/Hide', submenu: () => showHideMenu(ed) },
  ];
}

export function separateItems(): MenuItem[] {
  return [
    { label: 'Copy', op: 'node.group_separate', props: { type: 'COPY' } },
    { label: 'Move', op: 'node.group_separate', props: { type: 'MOVE' } },
  ];
}

function contextSelectMenu(): MenuItem[] {
  return [
    { label: 'Select Grouped...', submenu: () => selectGroupedItems() },
    { separator: true },
    opItem('Linked From', 'node.select_linked_from'),
    opItem('Linked To', 'node.select_linked_to'),
    { separator: true },
    opItem('Activate Same Type Previous', 'node.select_same_type_step', { prev: true }),
    opItem('Activate Same Type Next', 'node.select_same_type_step', { prev: false }),
  ];
}

/** Right-click / W menu: node commands when nodes are selected, tree commands otherwise. */
export function contextMenuItems(ed: EdLike, anySelected: boolean): MenuItem[] {
  if (!anySelected) {
    const items: MenuItem[] = [
      { label: 'Add', submenu: () => ed.addMenuItems() },
      opItem('Paste', 'node.clipboard_paste'),
      { separator: true },
      opItem('Find...', 'node.find_node'),
      { separator: true },
      opItem('Cut Links', 'node.links_cut'),
      opItem('Mute Links', 'node.links_mute'),
    ];
    if (ed.path.length) items.push({ separator: true }, opItem('Exit Group', 'node.group_edit', { exit: true }));
    return items;
  }
  return [
    ...(ed.provider.linkViewer ? [opItem('Link to Viewer', 'node.link_viewer'), { separator: true }] : []),
    opItem('Cut', 'node.delete_copy_reconnect'),
    opItem('Copy', 'node.clipboard_copy'),
    opItem('Paste', 'node.clipboard_paste'),
    opItem('Duplicate', 'node.duplicate_move'),
    { separator: true },
    opItem('Delete', 'node.delete'),
    opItem('Dissolve', 'node.delete_reconnect'),
    { separator: true },
    opItem('Make Group', 'node.group_make'),
    opItem('Insert Into Group', 'node.group_insert'),
    { separator: true },
    opItem('Join in New Frame', 'node.join'),
    opItem('Remove from Frame', 'node.detach'),
    { separator: true },
    opItem('Rename...', 'node.rename'),
    { separator: true },
    { label: 'Select', submenu: () => contextSelectMenu() },
    { label: 'Show/Hide', submenu: () => showHideMenu(ed) },
  ];
}
