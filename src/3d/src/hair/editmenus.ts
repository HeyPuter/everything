// Curves Edit Mode header (selection domain toggles, Select / Add / Curves / Control Points /
// Segments menus), context menu and the "Curves" keymap.
import { app } from '../app/app';
import { addKeys } from '../app/keymap';
import { modeMenus } from '../editors/view3d/modemenus';
import { viewportExtensions } from '../editors/view3d/hooks';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import type { MenuItem } from '../ui/menu';
import { transformSubmenu, mirrorSubmenu, snapSubmenu, mirrorMenuItems } from '../modes/common-menus';
import { activeHair, inCurvesEdit, inSculptCurves } from './common';
import { getAttr } from './data';

const CURVE_TYPES: [string, string][] = [
  ['CATMULL_ROM', 'Catmull Rom'],
  ['POLY', 'Poly'],
  ['BEZIER', 'Bézier'],
  ['NURBS', 'NURBS'],
];

const curveTypeMenu = (): MenuItem => ({ label: 'Set Curve Type', submenu: () => CURVE_TYPES.map(([t, l]) => ({ label: l, op: 'curves.curve_type_set', props: { type: t } })) });
const handleTypeMenu = (): MenuItem => ({
  label: 'Set Handle Type',
  shortcut: 'V',
  submenu: () => [
    ['AUTO', 'Auto'],
    ['VECTOR', 'Vector'],
    ['ALIGN', 'Align'],
    ['FREE_ALIGN', 'Free'],
  ].map(([t, l]) => ({ label: l, op: 'curves.handle_type_set', props: { type: t } })),
});
const hasHandles = () => !!(activeHair() && getAttr(activeHair()!.hc, 'handle_type_left'));

export function domainButtons(): Child {
  const a = activeHair();
  if (!a || (!inCurvesEdit() && !inSculptCurves())) return null;
  const d = a.hc.selection_domain;
  const btn = (dom: 'POINT' | 'CURVE', ic: string, tip: string) =>
    h(
      'button',
      {
        key: dom,
        class: { 'hdr-toggle': true, on: d === dom },
        'data-tip': tip,
        'data-domain': dom,
        onclick: () => app.run('curves.set_selection_domain', { domain: dom }),
      },
      icon(ic),
    );
  return h('div', { key: 'curves-domain', class: 'hdr-group select-modes', style: { flex: 'none' } }, btn('POINT', 'curve_points', 'Control Points (1)\nSelect individual control points'), btn('CURVE', 'curve_curves', 'Curves (2)\nSelect whole curves'));
}

function selectMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'curves.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'curves.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'curves.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'view3d.select_box_tool', shortcut: 'B' },
    { label: 'Circle Select', op: 'view3d.select_circle_tool', shortcut: 'C' },
    { separator: true },
    { label: 'Random', op: 'curves.select_random' },
    { separator: true },
    {
      label: 'More/Less',
      submenu: () => [
        { label: 'More', op: 'curves.select_more', shortcut: 'Ctrl Numpad +' },
        { label: 'Less', op: 'curves.select_less', shortcut: 'Ctrl Numpad -' },
      ],
    },
    { separator: true },
    { label: 'Linked', op: 'curves.select_linked', shortcut: 'Ctrl L' },
    { separator: true },
    { label: 'Endpoints', op: 'curves.select_ends' },
  ];
}

function addMenu(): MenuItem[] {
  return [
    { label: 'Bézier', icon: 'curve_data', op: 'curves.add_bezier' },
    { label: 'Circle', icon: 'circle', op: 'curves.add_circle' },
  ];
}

function curvesMenu(): MenuItem[] {
  return [
    transformSubmenu([
      { label: 'Radius', op: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN' }, shortcut: 'Alt S' },
      { label: 'Tilt', op: 'transform.tilt', shortcut: 'Ctrl T' },
    ]),
    mirrorSubmenu(),
    snapSubmenu(),
    { separator: true },
    { label: 'Duplicate', op: 'curves.duplicate_move', shortcut: 'Shift D' },
    { label: 'Extrude', op: 'curves.extrude_move', shortcut: 'E' },
    { separator: true },
    { label: 'Set Attribute', op: 'curves.attribute_set' },
    curveTypeMenu(),
    { label: 'Toggle Cyclic', op: 'curves.cyclic_toggle', shortcut: 'Alt C' },
    { separator: true },
    { label: 'Separate', op: 'curves.separate', shortcut: 'P' },
    { label: 'Delete', op: 'curves.delete', shortcut: 'X' },
  ];
}

function controlPointsMenu(): MenuItem[] {
  return [{ label: 'Extrude', op: 'curves.extrude_move', shortcut: 'E' }, ...(hasHandles() ? [handleTypeMenu()] : []), { separator: true }, { label: 'Clear Tilt', op: 'curves.tilt_clear', shortcut: 'Alt T' }];
}

function segmentsMenu(): MenuItem[] {
  return [
    { label: 'Subdivide', op: 'curves.subdivide' },
    { label: 'Switch Direction', op: 'curves.switch_direction' },
  ];
}

function contextMenu(): MenuItem[] {
  return [
    { heading: 'Curves' },
    { label: 'Subdivide', op: 'curves.subdivide' },
    { separator: true },
    { label: 'Extrude', op: 'curves.extrude_move', shortcut: 'E' },
    { separator: true },
    mirrorSubmenu(),
    snapSubmenu(),
    { separator: true },
    curveTypeMenu(),
    ...(hasHandles() ? [handleTypeMenu()] : []),
    { label: 'Toggle Cyclic', op: 'curves.cyclic_toggle', shortcut: 'Alt C' },
    { label: 'Switch Direction', op: 'curves.switch_direction' },
    { separator: true },
    { label: 'Separate', op: 'curves.separate', shortcut: 'P' },
    { label: 'Delete', op: 'curves.delete', shortcut: 'X' },
    { separator: true },
    { label: 'Split', op: 'curves.split', shortcut: 'Y' },
  ];
}

const prevEdit = modeMenus.EDIT;
modeMenus.EDIT = {
  ...prevEdit,
  header: () =>
    inCurvesEdit()
      ? [
          ['Curves', curvesMenu],
          ['Control Points', controlPointsMenu],
          ['Segments', segmentsMenu],
        ]
      : (prevEdit?.header?.() ?? []),
  select: () => (inCurvesEdit() ? selectMenu() : (prevEdit?.select?.() ?? [])),
  add: () => (inCurvesEdit() ? addMenu() : (prevEdit?.add?.() ?? [])),
  context: () => (inCurvesEdit() ? contextMenu() : (prevEdit?.context?.() ?? [])),
  headerLead: () => (inCurvesEdit() ? domainButtons() : (prevEdit?.headerLead?.() ?? null)),
  headerExtra: () => (inCurvesEdit() ? null : (prevEdit?.headerExtra?.() ?? null)),
};

const e = inCurvesEdit;
addKeys('Curves', [
  { key: 'ONE', op: 'curves.set_selection_domain', props: { domain: 'POINT' }, when: e },
  { key: 'TWO', op: 'curves.set_selection_domain', props: { domain: 'CURVE' }, when: e },
  { key: 'D', shift: true, op: 'curves.duplicate_move', when: e },
  { key: 'A', op: 'curves.select_all', props: { action: 'SELECT' }, when: e },
  { key: 'A', alt: true, op: 'curves.select_all', props: { action: 'DESELECT' }, when: e },
  { key: 'I', ctrl: true, op: 'curves.select_all', props: { action: 'INVERT' }, when: e },
  { key: 'E', op: 'curves.extrude_move', when: e },
  { key: 'L', ctrl: true, op: 'curves.select_linked', when: e },
  { key: 'L', op: 'curves.select_linked_pick', props: { deselect: false }, when: e },
  { key: 'L', shift: true, op: 'curves.select_linked_pick', props: { deselect: true }, when: e },
  { key: 'X', op: 'curves.delete', when: e },
  { key: 'DEL', op: 'curves.delete', when: e },
  { key: 'P', op: 'curves.separate', when: e },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'curves.select_more', when: e },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'curves.select_less', when: e },
  { key: 'Y', op: 'curves.split', when: e },
  { key: 'M', ctrl: true, menu: mirrorMenuItems, menuTitle: 'Mirror', when: e },
  { key: 'T', alt: true, op: 'curves.tilt_clear', when: e },
  { key: 'T', ctrl: true, op: 'transform.tilt', when: e },
  { key: 'S', alt: true, op: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN' }, when: e },
  { key: 'C', alt: true, op: 'curves.cyclic_toggle', when: e },
  { key: 'V', menu: () => handleTypeMenu().submenu!(), menuTitle: 'Set Handle Type', when: () => e() && hasHandles() },
  { key: 'A', shift: true, menu: addMenu, menuTitle: 'Add', when: e },
  { key: 'W', menu: contextMenu, when: e },
]);

viewportExtensions.push((v) => {
  for (const km of ['Particle', 'Sculpt Curves', 'Curves']) if (!v.keymaps.includes(km)) v.keymaps.unshift(km);
});
