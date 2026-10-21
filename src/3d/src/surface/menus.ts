// Surface Edit Mode header menus (Select / Add / Surface / Control Points / Segments), the context menu,
// the Add ▸ Surface menu and the surface items of the "Curve" keymap.
import { modeMenus } from '../editors/view3d/modemenus';
import { addKeys } from '../app/keymap';
import type { MenuItem } from '../ui/menu';
import { surfaceAddHook } from '../editors/view3d/menus';
import { transformSubmenu, mirrorSubmenu, snapSubmenu, showHideSubmenu } from '../modes/common-menus';
import { inSurfaceEdit } from './edit';

export function surfaceAddMenu(): MenuItem[] {
  return [
    { label: 'NURBS Curve', icon: 'surface_ncurve', op: 'surface.primitive_nurbs_surface_curve_add' },
    { label: 'NURBS Circle', icon: 'surface_ncircle', op: 'surface.primitive_nurbs_surface_circle_add' },
    { label: 'NURBS Surface', icon: 'surface_nsurface', op: 'surface.primitive_nurbs_surface_surface_add' },
    { label: 'NURBS Cylinder', icon: 'surface_ncylinder', op: 'surface.primitive_nurbs_surface_cylinder_add' },
    { label: 'NURBS Sphere', icon: 'surface_nsphere', op: 'surface.primitive_nurbs_surface_sphere_add' },
    { label: 'NURBS Torus', icon: 'surface_ntorus', op: 'surface.primitive_nurbs_surface_torus_add' },
  ];
}
surfaceAddHook.items = surfaceAddMenu;

const cyclicMenu = (): MenuItem[] => [
  { label: 'Cyclic U', op: 'curve.cyclic_toggle', props: { direction: 'CYCLIC_U' } },
  { label: 'Cyclic V', op: 'curve.cyclic_toggle', props: { direction: 'CYCLIC_V' } },
];

function surfaceMenu(): MenuItem[] {
  return [
    transformSubmenu(),
    mirrorSubmenu(),
    snapSubmenu(),
    { separator: true },
    { label: 'Spin', op: 'curve.spin' },
    { label: 'Duplicate', op: 'curve.duplicate_move', shortcut: 'Shift D' },
    { separator: true },
    { label: 'Separate', op: 'curve.separate', shortcut: 'P' },
    { separator: true },
    { label: 'Toggle Cyclic', submenu: cyclicMenu, shortcut: 'Alt C' },
    { separator: true },
    showHideSubmenu('curve', 'reveal', 'hide'),
    { label: 'Delete', submenu: deleteMenu, shortcut: 'X' },
  ];
}

const deleteMenu = (): MenuItem[] => [{ label: 'Vertices', op: 'curve.delete', props: { type: 'VERT' } }];

function controlPointsMenu(): MenuItem[] {
  return [
    { label: 'Extrude', op: 'curve.extrude_move', shortcut: 'E' },
    { separator: true },
    { label: 'Set Goal Weight', op: 'curve.spline_weight_set' },
  ];
}

function segmentsMenu(): MenuItem[] {
  return [
    { label: 'Subdivide', op: 'curve.subdivide' },
    { label: 'Switch Direction', op: 'curve.switch_direction' },
  ];
}

function selectMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'curve.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'curve.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'curve.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'view3d.select_box_tool', shortcut: 'B' },
    { label: 'Circle Select', op: 'view3d.select_circle_tool', shortcut: 'C' },
    { separator: true },
    { label: 'Select Random', op: 'curve.select_random' },
    { separator: true },
    { label: 'More', op: 'curve.select_more', shortcut: 'Ctrl Numpad +' },
    { label: 'Less', op: 'curve.select_less', shortcut: 'Ctrl Numpad -' },
    { separator: true },
    { label: 'Select Linked', op: 'curve.select_linked', shortcut: 'Ctrl L' },
    { separator: true },
    { label: 'Control Point Row', op: 'curve.select_row', shortcut: 'Shift Ctrl R' },
  ];
}

function contextMenu(): MenuItem[] {
  return [
    { heading: 'Surface' },
    { label: 'Subdivide', op: 'curve.subdivide' },
    { label: 'Extrude', op: 'curve.extrude_move', shortcut: 'E' },
    { label: 'Duplicate', op: 'curve.duplicate_move', shortcut: 'Shift D' },
    { separator: true },
    mirrorSubmenu(),
    snapSubmenu(),
    { separator: true },
    { label: 'Toggle Cyclic', submenu: cyclicMenu, shortcut: 'Alt C' },
    { label: 'Switch Direction', op: 'curve.switch_direction' },
    { label: 'Set Goal Weight', op: 'curve.spline_weight_set' },
    { separator: true },
    { label: 'Separate', op: 'curve.separate', shortcut: 'P' },
    { label: 'Delete Point', op: 'curve.delete', props: { type: 'VERT' } },
  ];
}

const prevEdit = modeMenus.EDIT;
modeMenus.EDIT = {
  ...prevEdit,
  header: () =>
    inSurfaceEdit()
      ? [
          ['Surface', surfaceMenu],
          ['Control Points', controlPointsMenu],
          ['Segments', segmentsMenu],
        ]
      : (prevEdit?.header?.() ?? []),
  select: () => (inSurfaceEdit() ? selectMenu() : (prevEdit?.select?.() ?? [])),
  add: () => (inSurfaceEdit() ? surfaceAddMenu() : (prevEdit?.add?.() ?? [])),
  context: () => (inSurfaceEdit() ? contextMenu() : (prevEdit?.context?.() ?? [])),
  headerExtra: () => (inSurfaceEdit() ? null : (prevEdit?.headerExtra?.() ?? null)),
};

const w = inSurfaceEdit;
addKeys('Curve', [
  { key: 'A', shift: true, menu: surfaceAddMenu, menuTitle: 'Add', when: w },
  { key: 'A', op: 'curve.select_all', props: { action: 'SELECT' }, when: w },
  { key: 'A', alt: true, op: 'curve.select_all', props: { action: 'DESELECT' }, when: w },
  { key: 'I', ctrl: true, op: 'curve.select_all', props: { action: 'INVERT' }, when: w },
  { key: 'R', shift: true, ctrl: true, op: 'curve.select_row', when: w },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'curve.select_more', when: w },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'curve.select_less', when: w },
  { key: 'L', ctrl: true, op: 'curve.select_linked', when: w },
  { key: 'L', op: 'curve.select_linked_pick', props: { deselect: false }, when: w },
  { key: 'L', shift: true, op: 'curve.select_linked_pick', props: { deselect: true }, when: w },
  { key: 'P', op: 'curve.separate', when: w },
  { key: 'E', op: 'curve.extrude_move', when: w },
  { key: 'D', shift: true, op: 'curve.duplicate_move', when: w },
  { key: 'C', alt: true, menu: cyclicMenu, menuTitle: 'Toggle Cyclic', when: w },
  { key: 'X', menu: deleteMenu, menuTitle: 'Delete', when: w },
  { key: 'DEL', menu: deleteMenu, menuTitle: 'Delete', when: w },
  { key: 'H', op: 'curve.hide', props: { unselected: false }, when: w },
  { key: 'H', shift: true, op: 'curve.hide', props: { unselected: true }, when: w },
  { key: 'H', alt: true, op: 'curve.reveal', when: w },
  { key: 'W', menu: contextMenu, menuTitle: 'Surface', when: w },
]);
