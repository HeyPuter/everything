// Curve Edit Mode header menus (Select / Add / Curve / Control Points / Segments), the context
// menu and the "Curve" keymap.
import { modeMenus } from '../../editors/view3d/modemenus';
import { addKeys } from '../../app/keymap';
import type { MenuItem } from '../../ui/menu';
import { inCurveEdit } from './curve';
import { hookMenu } from './hooks';
import { transformSubmenu, mirrorSubmenu, snapSubmenu, showHideSubmenu } from '../common-menus';

const SPLINE_TYPES: [string, string][] = [['POLY', 'Poly'], ['BEZIER', 'Bézier'], ['NURBS', 'NURBS']];

export function handleMenu(): MenuItem[] {
  return [
    { label: 'Automatic', op: 'curve.handle_type_set', props: { type: 'AUTOMATIC' } },
    { label: 'Vector', op: 'curve.handle_type_set', props: { type: 'VECTOR' } },
    { label: 'Aligned', op: 'curve.handle_type_set', props: { type: 'ALIGNED' } },
    { label: 'Free', op: 'curve.handle_type_set', props: { type: 'FREE_ALIGN' } },
    { separator: true },
    { label: 'Toggle Free/Align', op: 'curve.handle_type_set', props: { type: 'TOGGLE_FREE_ALIGN' } },
  ];
}

export function deleteMenu(): MenuItem[] {
  return [
    { label: 'Vertices', op: 'curve.delete', props: { type: 'VERT' } },
    { label: 'Segments', op: 'curve.delete', props: { type: 'SEGMENT' } },
    { separator: true },
    { label: 'Dissolve Vertices', op: 'curve.dissolve_verts', shortcut: 'Ctrl X' },
  ];
}

function splineTypeMenu(): MenuItem {
  return { label: 'Set Spline Type', submenu: () => SPLINE_TYPES.map(([t, l]) => ({ label: l, op: 'curve.spline_type_set', props: { type: t } })) };
}

function similarMenu(): MenuItem[] {
  return (
    [
      ['TYPE', 'Type'],
      ['RADIUS', 'Radius'],
      ['WEIGHT', 'Weight'],
      ['DIRECTION', 'Direction'],
    ] as const
  ).map(([t, l]) => ({ label: l, op: 'curve.select_similar', props: { type: t } }));
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
    { label: 'Checker Deselect', op: 'curve.select_nth' },
    { separator: true },
    { label: 'More', op: 'curve.select_more', shortcut: 'Ctrl Numpad +' },
    { label: 'Less', op: 'curve.select_less', shortcut: 'Ctrl Numpad -' },
    { separator: true },
    { label: 'Select Linked', op: 'curve.select_linked', shortcut: 'Ctrl L' },
    { label: 'Select Similar', submenu: similarMenu, shortcut: 'Shift G' },
    { separator: true },
    { label: '(De)select First', op: 'curve.de_select_first' },
    { label: '(De)select Last', op: 'curve.de_select_last' },
    { label: 'Select Next', op: 'curve.select_next' },
    { label: 'Select Previous', op: 'curve.select_previous' },
  ];
}

function addMenu(): MenuItem[] {
  return [
    { label: 'Bézier', icon: 'curve_bezcurve', op: 'curve.primitive_bezier_curve_add' },
    { label: 'Circle', icon: 'curve_bezcircle', op: 'curve.primitive_bezier_circle_add' },
    { separator: true },
    { label: 'Nurbs Curve', icon: 'curve_ncurve', op: 'curve.primitive_nurbs_curve_add' },
    { label: 'Nurbs Circle', icon: 'curve_ncircle', op: 'curve.primitive_nurbs_circle_add' },
    { label: 'Path', icon: 'curve_path', op: 'curve.primitive_nurbs_path_add' },
  ];
}

const radiusItem: MenuItem = { label: 'Radius', op: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN' }, shortcut: 'Alt S' };

function curveMenu(): MenuItem[] {
  return [
    transformSubmenu([radiusItem]),
    mirrorSubmenu(),
    snapSubmenu(),
    { separator: true },
    { label: 'Duplicate', op: 'curve.duplicate_move', shortcut: 'Shift D' },
    { separator: true },
    { label: 'Split', op: 'curve.split', shortcut: 'Y' },
    { label: 'Separate', op: 'curve.separate', shortcut: 'P' },
    { separator: true },
    { label: 'Toggle Cyclic', op: 'curve.cyclic_toggle', shortcut: 'Alt C' },
    splineTypeMenu(),
    { separator: true },
    showHideSubmenu('curve', 'reveal', 'hide'),
    { label: 'Clean Up', submenu: () => [{ label: 'Decimate Curve', op: 'curve.decimate' }] },
    { label: 'Delete', submenu: deleteMenu, shortcut: 'X' },
  ];
}

function controlPointsMenu(): MenuItem[] {
  return [
    { label: 'Extrude Curve and Move', op: 'curve.extrude_move', shortcut: 'E' },
    { separator: true },
    { label: 'Make Segment', op: 'curve.make_segment', shortcut: 'F' },
    { separator: true },
    { label: 'Tilt', op: 'transform.tilt', shortcut: 'Ctrl T' },
    { label: 'Clear Tilt', op: 'curve.tilt_clear', shortcut: 'Alt T' },
    { separator: true },
    { label: 'Set Handle Type', submenu: handleMenu, shortcut: 'V' },
    { label: 'Recalculate Handles', op: 'curve.normals_make_consistent', shortcut: 'Shift N' },
    { separator: true },
    { label: 'Smooth', op: 'curve.smooth' },
    { label: 'Smooth Curve Tilt', op: 'curve.smooth_tilt' },
    { label: 'Smooth Curve Radius', op: 'curve.smooth_radius' },
    { label: 'Smooth Curve Weight', op: 'curve.smooth_weight' },
    { separator: true },
    { label: 'Hooks', submenu: hookMenu, shortcut: 'Ctrl H' },
  ];
}

function segmentsMenu(): MenuItem[] {
  return [
    { label: 'Subdivide', op: 'curve.subdivide' },
    { label: 'Switch Direction', op: 'curve.switch_direction' },
  ];
}

export function curveContextMenu(): MenuItem[] {
  return [
    { heading: 'Curve' },
    { label: 'Subdivide', op: 'curve.subdivide' },
    { label: 'Extrude Curve and Move', op: 'curve.extrude_move', shortcut: 'E' },
    { label: 'Make Segment', op: 'curve.make_segment', shortcut: 'F' },
    { label: 'Duplicate', op: 'curve.duplicate_move', shortcut: 'Shift D' },
    { separator: true },
    radiusItem,
    { label: 'Tilt', op: 'transform.tilt', shortcut: 'Ctrl T' },
    { label: 'Clear Tilt', op: 'curve.tilt_clear', shortcut: 'Alt T' },
    { label: 'Smooth', op: 'curve.smooth' },
    { label: 'Smooth Curve Tilt', op: 'curve.smooth_tilt' },
    { label: 'Smooth Curve Radius', op: 'curve.smooth_radius' },
    { separator: true },
    mirrorSubmenu(),
    snapSubmenu(),
    { separator: true },
    splineTypeMenu(),
    { label: 'Set Handle Type', submenu: handleMenu, shortcut: 'V' },
    { label: 'Toggle Cyclic', op: 'curve.cyclic_toggle', shortcut: 'Alt C' },
    { label: 'Switch Direction', op: 'curve.switch_direction' },
    { separator: true },
    { label: 'Recalculate Handles', op: 'curve.normals_make_consistent', shortcut: 'Shift N' },
    { label: 'Set Goal Weight', op: 'curve.spline_weight_set' },
    { label: 'Set Curve Radius', op: 'curve.radius_set' },
    { separator: true },
    { label: 'Split', op: 'curve.split', shortcut: 'Y' },
    { label: 'Decimate Curve', op: 'curve.decimate' },
    { label: 'Separate', op: 'curve.separate', shortcut: 'P' },
    { label: 'Dissolve Vertices', op: 'curve.dissolve_verts', shortcut: 'Ctrl X' },
    { label: 'Delete Segment', op: 'curve.delete', props: { type: 'SEGMENT' } },
    { label: 'Delete Point', op: 'curve.delete', props: { type: 'VERT' } },
  ];
}

const prevEdit = modeMenus.EDIT;
modeMenus.EDIT = {
  ...prevEdit,
  header: () =>
    inCurveEdit()
      ? [
          ['Curve', curveMenu],
          ['Control Points', controlPointsMenu],
          ['Segments', segmentsMenu],
        ]
      : prevEdit?.header?.() ?? [],
  select: () => (inCurveEdit() ? selectMenu() : prevEdit?.select?.() ?? []),
  add: () => (inCurveEdit() ? addMenu() : prevEdit?.add?.() ?? []),
  context: () => (inCurveEdit() ? curveContextMenu() : prevEdit?.context?.() ?? []),
  headerExtra: () => (inCurveEdit() ? null : prevEdit?.headerExtra?.() ?? null),
};

const w = inCurveEdit;
addKeys('Curve', [
  { key: 'A', shift: true, menu: addMenu, menuTitle: 'Add', when: w },
  { key: 'V', menu: handleMenu, menuTitle: 'Set Handle Type', when: w },
  { key: 'A', op: 'curve.select_all', props: { action: 'SELECT' }, when: w },
  { key: 'A', alt: true, op: 'curve.select_all', props: { action: 'DESELECT' }, when: w },
  { key: 'I', ctrl: true, op: 'curve.select_all', props: { action: 'INVERT' }, when: w },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'curve.select_more', when: w },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'curve.select_less', when: w },
  { key: 'L', ctrl: true, op: 'curve.select_linked', when: w },
  { key: 'G', shift: true, menu: similarMenu, menuTitle: 'Select Similar', when: w },
  { key: 'L', op: 'curve.select_linked_pick', props: { deselect: false }, when: w },
  { key: 'L', shift: true, op: 'curve.select_linked_pick', props: { deselect: true }, when: w },
  { key: 'P', op: 'curve.separate', when: w },
  { key: 'Y', op: 'curve.split', when: w },
  { key: 'E', op: 'curve.extrude_move', when: w },
  { key: 'D', shift: true, op: 'curve.duplicate_move', when: w },
  { key: 'F', op: 'curve.make_segment', when: w },
  { key: 'C', alt: true, op: 'curve.cyclic_toggle', when: w },
  { key: 'X', menu: deleteMenu, menuTitle: 'Delete', when: w },
  { key: 'DEL', menu: deleteMenu, menuTitle: 'Delete', when: w },
  { key: 'X', ctrl: true, op: 'curve.dissolve_verts', when: w },
  { key: 'DEL', ctrl: true, op: 'curve.dissolve_verts', when: w },
  { key: 'T', alt: true, op: 'curve.tilt_clear', when: w },
  { key: 'T', ctrl: true, op: 'transform.tilt', when: w },
  { key: 'S', alt: true, op: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN' }, when: w },
  { key: 'H', alt: true, op: 'curve.reveal', when: w },
  { key: 'H', op: 'curve.hide', props: { unselected: false }, when: w },
  { key: 'H', shift: true, op: 'curve.hide', props: { unselected: true }, when: w },
  { key: 'N', shift: true, op: 'curve.normals_make_consistent', when: w },
]);
