// Armature Edit Mode menus (Select / Add / Armature), context menu, header X-Axis Mirror toggle
// and the "Armature" keymap.
import { h } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { modeMenus } from '../../editors/view3d/modemenus';
import { addKeys } from '../../app/keymap';
import type { MenuItem } from '../../ui/menu';
import { activeArmature, ROLL_TYPES } from './armature';
import { boneOptionsMenu } from './editops';
import { collectionMenuItems } from './collections';
import { transformSubmenu, mirrorSubmenu, snapSubmenu, showHideSubmenu } from '../common-menus';

const inArmEdit = () => app.doc.mode === 'EDIT' && !!activeArmature();


function rollMenu(): MenuItem[] {
  return [
    ...ROLL_TYPES.map(([t, l]) => ({ label: l, op: 'armature.calculate_roll', props: { type: t } })),
    { separator: true },
    { label: 'Set Roll', op: 'transform.transform', props: { mode: 'BONE_ROLL' }, shortcut: 'Ctrl R' },
    { label: 'Clear Roll', op: 'armature.roll_clear', shortcut: 'Alt R' },
  ];
}

function namesMenu(): MenuItem[] {
  return [
    { label: 'Auto-Name Left/Right', op: 'armature.autoside_names', props: { type: 'XAXIS' } },
    { label: 'Auto-Name Front/Back', op: 'armature.autoside_names', props: { type: 'YAXIS' } },
    { label: 'Auto-Name Top/Bottom', op: 'armature.autoside_names', props: { type: 'ZAXIS' } },
    { separator: true },
    { label: 'Flip Names', op: 'armature.flip_names' },
    { label: 'Rename Active Bone…', op: 'armature.rename', shortcut: 'F2' },
  ];
}

export function parentMakeMenu(): MenuItem[] {
  return [
    { label: 'Connected', op: 'armature.parent_set', props: { type: 'CONNECTED' } },
    { label: 'Keep Offset', op: 'armature.parent_set', props: { type: 'OFFSET' } },
  ];
}
export function parentClearMenu(): MenuItem[] {
  return [
    { label: 'Clear Parent', op: 'armature.parent_clear', props: { type: 'CLEAR' } },
    { label: 'Disconnect Bone', op: 'armature.parent_clear', props: { type: 'DISCONNECT' } },
  ];
}

function deleteMenu(): MenuItem[] {
  return [
    { label: 'Bones', op: 'armature.delete' },
    { separator: true },
    { label: 'Dissolve Bones', op: 'armature.dissolve', shortcut: 'Ctrl X' },
  ];
}

function similarMenu(): MenuItem[] {
  return (
    [
      ['LENGTH', 'Length'],
      ['DIRECTION', 'Direction (Y Axis)'],
      ['PREFIX', 'Prefix'],
      ['SUFFIX', 'Suffix'],
      ['BONE_COLLECTION', 'Bone Collection'],
      ['CHILDREN', 'Children'],
      ['CHILDREN_IMMEDIATE', 'Immediate Children'],
      ['SIBLINGS', 'Siblings'],
    ] as const
  ).map(([t, l]) => ({ label: l, op: 'armature.select_similar', props: { type: t } }));
}

function bonesCollectionsMenu(): MenuItem[] {
  return [
    { label: 'Move to Collection', submenu: () => collectionMenuItems(true), shortcut: 'M' },
    { label: 'Add to Collection', submenu: () => collectionMenuItems(false), shortcut: 'Shift M' },
    { separator: true },
    { label: 'Show All', op: 'armature.collection_show_all' },
    { label: 'Assign to New Collection', op: 'armature.collection_create_and_assign' },
  ];
}

function armatureMenu(): MenuItem[] {
  const mirror = !!activeArmature()?.arm.use_mirror_x;
  return [
    transformSubmenu([
      { label: 'Scale Envelope Distance', op: 'transform.transform', props: { mode: 'BONE_ENVELOPE_DIST' }, shortcut: 'Alt S' },
      { label: 'Scale B-Bone', op: 'transform.bbone_resize', shortcut: 'Shift Ctrl Alt S' },
      { label: 'Align Bones', op: 'armature.align', shortcut: 'Ctrl Alt A' },
    ]),
    mirrorSubmenu(),
    snapSubmenu(),
    { label: 'Bone Roll', submenu: rollMenu },
    { separator: true },
    mirror ? { label: 'Extrude Forked', op: 'armature.extrude_forked', shortcut: 'Shift E' } : { label: 'Extrude', op: 'armature.extrude_move', shortcut: 'E' },
    { label: 'Extrude to Cursor', op: 'armature.click_extrude', shortcut: 'Ctrl RMB' },
    { label: 'Duplicate', op: 'armature.duplicate_move', shortcut: 'Shift D' },
    { label: 'Duplicate and Rename', op: 'armature.duplicate_rename' },
    { label: 'Fill Between Joints', op: 'armature.fill', shortcut: 'F' },
    { separator: true },
    { label: 'Split', op: 'armature.split', shortcut: 'Y' },
    { label: 'Separate Bones', op: 'armature.separate', shortcut: 'P' },
    { separator: true },
    { label: 'Subdivide', op: 'armature.subdivide' },
    { label: 'Switch Direction', op: 'armature.switch_direction', shortcut: 'Alt F' },
    { label: 'Symmetrize', op: 'armature.symmetrize' },
    { separator: true },
    { label: 'Names', submenu: namesMenu },
    { separator: true },
    { label: 'Parent', submenu: () => [{ label: 'Make', submenu: parentMakeMenu, shortcut: 'Ctrl P' }, { label: 'Clear', submenu: parentClearMenu, shortcut: 'Alt P' }] },
    { separator: true },
    {
      label: 'Bone Settings',
      submenu: () => [
        { label: 'Toggle Bone Options', submenu: () => boneOptionsMenu('TOGGLE'), shortcut: 'Shift W' },
        { label: 'Enable Bone Options', submenu: () => boneOptionsMenu('ENABLE'), shortcut: 'Shift Ctrl W' },
        { label: 'Disable Bone Options', submenu: () => boneOptionsMenu('DISABLE'), shortcut: 'Alt W' },
      ],
    },
    { label: 'Bone Collections', submenu: bonesCollectionsMenu },
    { separator: true },
    showHideSubmenu('armature', 'reveal', 'hide'),
    { separator: true },
    { label: 'Delete', submenu: deleteMenu, shortcut: 'X' },
  ];
}

function selectMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'armature.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'armature.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'armature.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'view3d.select_box_tool', shortcut: 'B' },
    { label: 'Circle Select', op: 'view3d.select_circle_tool', shortcut: 'C' },
    { separator: true },
    { label: 'Mirror', op: 'armature.select_mirror', shortcut: 'Shift Ctrl M' },
    { separator: true },
    { label: 'More', op: 'armature.select_more', shortcut: 'Ctrl Numpad +' },
    { label: 'Less', op: 'armature.select_less', shortcut: 'Ctrl Numpad -' },
    { separator: true },
    { label: 'Select Linked', op: 'armature.select_linked', shortcut: 'Ctrl L' },
    { label: 'Select Similar', submenu: similarMenu, shortcut: 'Shift G' },
    { label: 'Select Pattern…', op: 'object.select_pattern' },
    { separator: true },
    { label: 'Parent', op: 'armature.select_hierarchy', props: { direction: 'PARENT', extend: false }, shortcut: '[' },
    { label: 'Child', op: 'armature.select_hierarchy', props: { direction: 'CHILD', extend: false }, shortcut: ']' },
    { label: 'Extend Parent', op: 'armature.select_hierarchy', props: { direction: 'PARENT', extend: true }, shortcut: 'Shift [' },
    { label: 'Extend Child', op: 'armature.select_hierarchy', props: { direction: 'CHILD', extend: true }, shortcut: 'Shift ]' },
  ];
}

function contextMenu(): MenuItem[] {
  return [
    { heading: 'Armature' },
    { label: 'Subdivide', op: 'armature.subdivide' },
    { label: 'Duplicate', op: 'armature.duplicate_move', shortcut: 'Shift D' },
    { label: 'Extrude', op: 'armature.extrude_move', shortcut: 'E' },
    { label: 'Extrude Forked', op: 'armature.extrude_forked', shortcut: 'Shift E' },
    { separator: true },
    { label: 'Fill Between Joints', op: 'armature.fill', shortcut: 'F' },
    { separator: true },
    { label: 'Split', op: 'armature.split', shortcut: 'Y' },
    { label: 'Separate Bones', op: 'armature.separate', shortcut: 'P' },
    { separator: true },
    { label: 'Switch Direction', op: 'armature.switch_direction', shortcut: 'Alt F' },
    { separator: true },
    { label: 'Symmetrize', op: 'armature.symmetrize' },
    { label: 'Auto-Name Left/Right', op: 'armature.autoside_names', props: { type: 'XAXIS' } },
    { label: 'Flip Names', op: 'armature.flip_names' },
    { separator: true },
    { label: 'Make Parent', submenu: parentMakeMenu, shortcut: 'Ctrl P' },
    { label: 'Clear Parent', submenu: parentClearMenu, shortcut: 'Alt P' },
    { separator: true },
    { label: 'Delete Bones', op: 'armature.delete', shortcut: 'X' },
    { label: 'Dissolve Bones', op: 'armature.dissolve', shortcut: 'Ctrl X' },
  ];
}

function mirrorToggle() {
  const a = activeArmature();
  if (!a) return null;
  const on = !!a.arm.use_mirror_x;
  return h(
    'div',
    { class: 'hdr-group' },
    h(
      'button',
      {
        key: 'arm-xmirror',
        class: { 'hdr-toggle': true, on },
        'data-tip': 'X-Axis Mirror\nEdit .L / .R bone pairs symmetrically',
        onclick: () => {
          a.arm.use_mirror_x = !on;
          app.pushUndo('X-Axis Mirror');
          app.changed('ui', 'doc');
        },
      },
      icon('mod_mirror'),
      h('span', { class: 'hdr-toggle-label' }, 'X'),
    ),
  );
}

const prevEdit = modeMenus.EDIT;
modeMenus.EDIT = {
  ...prevEdit,
  header: () => (inArmEdit() ? [['Armature', armatureMenu]] : prevEdit?.header?.() ?? []),
  select: () => (inArmEdit() ? selectMenu() : prevEdit?.select?.() ?? []),
  add: () => (inArmEdit() ? [{ label: 'Single Bone', icon: 'bone_data', op: 'armature.bone_primitive_add', shortcut: 'Shift A' }] : prevEdit?.add?.() ?? []),
  context: () => (inArmEdit() ? contextMenu() : prevEdit?.context?.() ?? []),
  headerExtra: () => (inArmEdit() ? mirrorToggle() : prevEdit?.headerExtra?.() ?? null),
};

const w = inArmEdit;
const pose = () => app.doc.mode === 'POSE' && !!activeArmature();
addKeys('Armature', [
  { key: 'E', op: 'armature.extrude_move', when: w },
  { key: 'E', shift: true, op: 'armature.extrude_forked', when: w },
  { key: 'A', op: 'armature.select_all', props: { action: 'SELECT' }, when: w },
  { key: 'A', alt: true, op: 'armature.select_all', props: { action: 'DESELECT' }, when: w },
  { key: 'I', ctrl: true, op: 'armature.select_all', props: { action: 'INVERT' }, when: w },
  { key: 'M', shift: true, ctrl: true, op: 'armature.select_mirror', props: { extend: false }, when: w },
  { key: 'LEFT_BRACKET', op: 'armature.select_hierarchy', props: { direction: 'PARENT', extend: false }, when: w },
  { key: 'LEFT_BRACKET', shift: true, op: 'armature.select_hierarchy', props: { direction: 'PARENT', extend: true }, when: w },
  { key: 'RIGHT_BRACKET', op: 'armature.select_hierarchy', props: { direction: 'CHILD', extend: false }, when: w },
  { key: 'RIGHT_BRACKET', shift: true, op: 'armature.select_hierarchy', props: { direction: 'CHILD', extend: true }, when: w },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'armature.select_more', when: w },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'armature.select_less', when: w },
  { key: 'G', shift: true, menu: similarMenu, menuTitle: 'Select Similar', when: w },
  { key: 'L', op: 'armature.select_linked_pick', props: { deselect: false }, when: w },
  { key: 'L', shift: true, op: 'armature.select_linked_pick', props: { deselect: true }, when: w },
  { key: 'L', ctrl: true, op: 'armature.select_linked', when: w },
  { key: 'X', menu: deleteMenu, menuTitle: 'Delete', when: w },
  { key: 'DEL', menu: deleteMenu, menuTitle: 'Delete', when: w },
  { key: 'X', ctrl: true, op: 'armature.dissolve', when: w },
  { key: 'DEL', ctrl: true, op: 'armature.dissolve', when: w },
  { key: 'D', shift: true, op: 'armature.duplicate_move', when: w },
  { key: 'F', op: 'armature.fill', when: w },
  { key: 'Y', op: 'armature.split', when: w },
  { key: 'P', op: 'armature.separate', when: w },
  { key: 'P', ctrl: true, menu: parentMakeMenu, menuTitle: 'Make Parent', when: w },
  { key: 'P', alt: true, menu: parentClearMenu, menuTitle: 'Clear Parent', when: w },
  { key: 'N', shift: true, menu: () => ROLL_TYPES.map(([t, l]) => ({ label: l, op: 'armature.calculate_roll', props: { type: t } })), menuTitle: 'Recalculate Roll', when: w },
  { key: 'R', alt: true, op: 'armature.roll_clear', when: w },
  { key: 'R', ctrl: true, op: 'transform.transform', props: { mode: 'BONE_ROLL' }, when: w },
  { key: 'S', alt: true, op: 'transform.transform', props: { mode: 'BONE_ENVELOPE_DIST' }, when: w },
  { key: 'S', ctrl: true, alt: true, shift: true, op: 'transform.bbone_resize', when: w },
  { key: 'F', alt: true, op: 'armature.switch_direction', when: w },
  { key: 'A', shift: true, op: 'armature.bone_primitive_add', when: w },
  { key: 'F2', op: 'armature.rename', when: () => w() || pose() },
  { key: 'H', op: 'armature.hide', props: { unselected: false }, when: w },
  { key: 'H', shift: true, op: 'armature.hide', props: { unselected: true }, when: w },
  { key: 'H', alt: true, op: 'armature.reveal', when: w },
  { key: 'W', shift: true, menu: () => boneOptionsMenu('TOGGLE'), menuTitle: 'Toggle Bone Options', when: w },
  { key: 'W', shift: true, ctrl: true, menu: () => boneOptionsMenu('ENABLE'), menuTitle: 'Enable Bone Options', when: w },
  { key: 'W', alt: true, menu: () => boneOptionsMenu('DISABLE'), menuTitle: 'Disable Bone Options', when: w },
  { key: 'M', menu: () => collectionMenuItems(true), menuTitle: 'Move to Collection', when: w },
  { key: 'M', shift: true, menu: () => collectionMenuItems(false), menuTitle: 'Add to Collection', when: w },
]);

// pose mode: hide / reveal keep working, bone collections menus
addKeys('Pose', [
  { key: 'H', op: 'pose.hide', when: pose },
  { key: 'H', alt: true, op: 'pose.reveal', when: pose },
  { key: 'M', menu: () => collectionMenuItems(true), menuTitle: 'Move to Collection', when: pose },
  { key: 'M', shift: true, menu: () => collectionMenuItems(false), menuTitle: 'Add to Collection', when: pose },
  { key: 'P', ctrl: true, menu: poseParentMenu, menuTitle: 'Set Parent To', when: pose },
]);

/** Pose Mode ▸ Ctrl P: parent the other selected objects to the armature or its active bone. */
function poseParentMenu(): MenuItem[] {
  return [
    { label: 'Object', op: 'object.parent_set', props: { type: 'OBJECT' } },
    { label: 'Object (Keep Transform)', op: 'object.parent_set', props: { type: 'OBJECT', keep_transform: true } },
    { label: 'Bone', op: 'object.parent_set', props: { type: 'BONE' } },
    { label: 'Bone Relative', op: 'object.parent_set', props: { type: 'BONE_RELATIVE' } },
  ];
}
