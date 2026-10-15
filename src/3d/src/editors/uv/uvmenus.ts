// UV editor menus (View, Select, Image, UV, context menu, pies) and the "UV Editor" keymap.
import { app } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { openMenu, openPie, type MenuItem, type PieItem } from '../../ui/menu';
import { activeUVEditor, uvSelectMode, uvEditPoll } from './uvcontext';
import { operatorDialog } from './dialog';
import { radialControl } from './uvsculpt';

const ts = () => app.doc.scene.tool_settings;

export function unwrapMenu(): MenuItem[] {
  return [
    { label: 'Unwrap Angle Based', op: 'uv.unwrap', props: { method: 'ANGLE_BASED' } },
    { label: 'Unwrap Conformal', op: 'uv.unwrap', props: { method: 'CONFORMAL' } },
    { label: 'Unwrap Minimum Stretch', op: 'uv.unwrap', props: { method: 'MINIMUM_STRETCH' } },
    { separator: true },
    { label: 'Smart UV Project…', op: 'uv.smart_project' },
    { label: 'Lightmap Pack…', op: 'uv.lightmap_pack' },
    { label: 'Follow Active Quads…', op: 'uv.follow_active_quads' },
    { separator: true },
    { label: 'Cube Projection', op: 'uv.cube_project' },
    { label: 'Cylinder Projection', op: 'uv.cylinder_project' },
    { label: 'Sphere Projection', op: 'uv.sphere_project' },
  ];
}

export function transformMenu(): MenuItem[] {
  return [
    { label: 'Move', op: 'uv.translate', shortcut: 'G' },
    { label: 'Rotate', op: 'uv.rotate', shortcut: 'R' },
    { label: 'Scale', op: 'uv.resize', shortcut: 'S' },
    { separator: true },
    { label: 'Shear', op: 'uv.shear', shortcut: 'Shift Ctrl Alt S' },
    { separator: true },
    { label: 'Randomize', op: 'uv.randomize_uv_transform' },
  ];
}

export function mirrorMenu(): MenuItem[] {
  return [
    { label: 'Copy Mirrored UV Coords', op: 'uv.copy_mirrored_faces' },
    { separator: true },
    { label: 'X Axis', op: 'uv.mirror', props: { axis: 0 } },
    { label: 'Y Axis', op: 'uv.mirror', props: { axis: 1 } },
  ];
}

export function snapMenu(): MenuItem[] {
  return [
    { label: 'Selected to Pixels', op: 'uv.snap_selected', props: { target: 'PIXELS' } },
    { label: 'Selected to Cursor', op: 'uv.snap_selected', props: { target: 'CURSOR' } },
    { label: 'Selected to Cursor (Offset)', op: 'uv.snap_selected', props: { target: 'CURSOR_OFFSET' } },
    { label: 'Selected to Adjacent Unselected', op: 'uv.snap_selected', props: { target: 'ADJACENT_UNSELECTED' } },
    { separator: true },
    { label: 'Cursor to Pixels', op: 'uv.snap_cursor', props: { target: 'PIXELS' } },
    { label: 'Cursor to Selected', op: 'uv.snap_cursor', props: { target: 'SELECTED' } },
    { label: 'Cursor to Origin', op: 'uv.snap_cursor', props: { target: 'ORIGIN' } },
  ];
}

export function mergeMenu(): MenuItem[] {
  return [
    { label: 'At Center', op: 'uv.weld' },
    { label: 'At Cursor', op: 'uv.snap_selected', props: { target: 'CURSOR' } },
    { separator: true },
    { label: 'By Distance', op: 'uv.remove_doubles' },
  ];
}

export function splitMenu(): MenuItem[] {
  return [{ label: 'Selection', op: 'uv.select_split', shortcut: 'Y' }];
}

export function alignMenu(): MenuItem[] {
  return [
    { label: 'Straighten', op: 'uv.align', props: { axis: 'ALIGN_S' } },
    { label: 'Straighten X', op: 'uv.align', props: { axis: 'ALIGN_T' } },
    { label: 'Straighten Y', op: 'uv.align', props: { axis: 'ALIGN_U' } },
    { label: 'Align Auto', op: 'uv.align', props: { axis: 'ALIGN_AUTO' } },
    { label: 'Align Vertically', op: 'uv.align', props: { axis: 'ALIGN_X' } },
    { label: 'Align Horizontally', op: 'uv.align', props: { axis: 'ALIGN_Y' } },
  ];
}

export function selectModeMenu(): MenuItem[] {
  const sync = ts().use_uv_select_sync;
  const mode = uvSelectMode();
  return [
    { label: 'Vertex', icon: 'snap_vertex', active: mode === 'VERTEX', op: 'uv.select_mode', props: { type: 'VERTEX' } },
    { label: 'Edge', icon: 'snap_edge', active: mode === 'EDGE', op: 'uv.select_mode', props: { type: 'EDGE' } },
    { label: 'Face', icon: 'snap_face', active: mode === 'FACE', op: 'uv.select_mode', props: { type: 'FACE' } },
    ...(sync ? [] : [{ separator: true }, { label: 'Island', icon: 'uv', active: mode === 'ISLAND', op: 'uv.select_mode', props: { type: 'ISLAND' } }]),
  ];
}

export function showHideMenu(): MenuItem[] {
  return [
    { label: 'Reveal Hidden', op: 'uv.reveal', shortcut: 'Alt H' },
    { label: 'Hide Selected', op: 'uv.hide', props: { unselected: false }, shortcut: 'H' },
    { label: 'Hide Unselected', op: 'uv.hide', props: { unselected: true }, shortcut: 'Shift H' },
  ];
}

export function uvMenu(): MenuItem[] {
  return [
    { label: 'Transform', submenu: transformMenu },
    { label: 'Mirror', submenu: mirrorMenu },
    { label: 'Snap', submenu: snapMenu },
    { separator: true },
    { label: 'Unwrap', submenu: unwrapMenu },
    { separator: true },
    { label: 'Pin', op: 'uv.pin', props: { clear: false }, shortcut: 'P' },
    { label: 'Unpin', op: 'uv.pin', props: { clear: true }, shortcut: 'Alt P' },
    { label: 'Merge', submenu: mergeMenu },
    { label: 'Split', submenu: splitMenu },
    { separator: true },
    { label: 'Pack Islands', op: 'uv.pack_islands' },
    { label: 'Average Islands Scale', op: 'uv.average_islands_scale' },
    { label: 'Arrange/Align Islands', op: 'uv.arrange_islands' },
    { label: 'Minimize Stretch', op: 'uv.minimize_stretch' },
    { label: 'Stitch', op: 'uv.stitch', shortcut: 'Alt V' },
    { separator: true },
    { label: 'Mark Seam', op: 'uv.mark_seam', props: { clear: false }, shortcut: 'Ctrl E' },
    { label: 'Clear Seam', op: 'uv.mark_seam', props: { clear: true } },
    { label: 'Seams from Islands', op: 'uv.seams_from_islands' },
    { separator: true },
    { label: 'Align', submenu: alignMenu },
    { label: 'Align Rotation', op: 'uv.align_rotation' },
    { label: 'UV Select Mode', submenu: selectModeMenu },
    { separator: true },
    { label: 'Show/Hide Faces', submenu: showHideMenu },
    { label: 'Reset', op: 'uv.reset' },
    { separator: true },
    { label: 'Export UV Layout…', op: 'uv.export_layout' },
  ];
}

function lassoMenu(): MenuItem[] {
  return [
    { label: 'Set', op: 'uv.select_lasso', props: { mode: 'SET' } },
    { label: 'Extend', op: 'uv.select_lasso', props: { mode: 'ADD' } },
    { label: 'Subtract', op: 'uv.select_lasso', props: { mode: 'SUB' } },
  ];
}

export function similarMenu(): MenuItem[] {
  const mode = uvSelectMode();
  const types: [string, string][] =
    mode === 'VERTEX'
      ? [['PIN', 'Pinned']]
      : mode === 'EDGE'
        ? [
            ['LENGTH', 'Length'],
            ['LENGTH_3D', 'Length 3D'],
            ['PIN', 'Pinned'],
          ]
        : mode === 'ISLAND'
          ? [
              ['AREA', 'Area'],
              ['AREA_3D', 'Area 3D'],
              ['FACE', 'Amount of Faces in Island'],
            ]
          : [
              ['AREA', 'Area'],
              ['AREA_3D', 'Area 3D'],
              ['MATERIAL', 'Material'],
              ['OBJECT', 'Object'],
              ['SIDES', 'Polygon Sides'],
              ['WINDING', 'Winding'],
            ];
  return types.map(([type, label]) => ({ label, op: 'uv.select_similar', props: { type } }));
}

export function selectMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'uv.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'uv.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'uv.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'uv.select_box', props: { pinned: false }, shortcut: 'B' },
    { label: 'Box Select Pinned', op: 'uv.select_box', props: { pinned: true }, shortcut: 'Alt B' },
    { label: 'Circle Select', op: 'uv.select_circle', shortcut: 'C' },
    { label: 'Lasso Select', submenu: lassoMenu },
    { separator: true },
    { label: 'More', op: 'uv.select_more', shortcut: 'Ctrl Numpad +' },
    { label: 'Less', op: 'uv.select_less', shortcut: 'Ctrl Numpad -' },
    { separator: true },
    { label: 'Select Similar', submenu: similarMenu },
    {
      label: 'Select Linked',
      submenu: () => [
        { label: 'Linked', op: 'uv.select_linked', shortcut: 'Ctrl L' },
        { label: 'Shortest Path', op: 'uv.shortest_path_select' },
      ],
    },
    { separator: true },
    { label: 'Select Split', op: 'uv.select_split', shortcut: 'Y' },
    {
      label: 'Select All by Trait',
      submenu: () => [
        { label: 'Pinned', op: 'uv.select_pinned', shortcut: 'Shift P' },
        { label: 'Overlap', op: 'uv.select_overlap' },
        { label: 'Winding', op: 'uv.select_by_winding' },
      ],
    },
  ];
}

export function uvContextMenu(): MenuItem[] {
  return [
    { label: 'Copy UVs', op: 'uv.copy', shortcut: 'Ctrl C' },
    { label: 'Paste UVs', op: 'uv.paste', shortcut: 'Ctrl V' },
    { separator: true },
    { label: 'Unwrap', op: 'uv.unwrap' },
    { label: 'Follow Active Quads', op: 'uv.follow_active_quads' },
    { separator: true },
    { label: 'Pin', op: 'uv.pin', props: { clear: false }, shortcut: 'P' },
    { label: 'Unpin', op: 'uv.pin', props: { clear: true }, shortcut: 'Alt P' },
    { separator: true },
    { label: 'Snap', submenu: snapMenu },
    { label: 'Mirror X', op: 'uv.mirror', props: { axis: 0 } },
    { label: 'Mirror Y', op: 'uv.mirror', props: { axis: 1 } },
    { separator: true },
    ...alignMenu(),
    { separator: true },
    { label: 'Rotate +90°', op: 'uv.rotate90', props: { clockwise: false } },
    { label: 'Rotate -90°', op: 'uv.rotate90', props: { clockwise: true } },
    { separator: true },
    { label: 'Merge', submenu: mergeMenu },
    { label: 'Stitch', op: 'uv.stitch' },
    { label: 'Split', submenu: splitMenu },
    { separator: true },
    { label: 'Mark Seam', op: 'uv.mark_seam', props: { clear: false } },
    { label: 'Clear Seam', op: 'uv.mark_seam', props: { clear: true } },
  ];
}

export function snapPie() {
  const items: PieItem[] = [
    { label: 'Cursor to Pixels', op: 'uv.snap_cursor', props: { target: 'PIXELS' } },
    { label: 'Selected to Pixels', op: 'uv.snap_selected', props: { target: 'PIXELS' } },
    { label: 'Cursor to Selected', op: 'uv.snap_cursor', props: { target: 'SELECTED' } },
    { label: 'Selected to Cursor', op: 'uv.snap_selected', props: { target: 'CURSOR' } },
    { label: 'Selected to Cursor (Offset)', op: 'uv.snap_selected', props: { target: 'CURSOR_OFFSET' } },
    { label: 'Selected to Adjacent Unselected', op: 'uv.snap_selected', props: { target: 'ADJACENT_UNSELECTED' } },
    { label: 'Cursor to Origin', op: 'uv.snap_cursor', props: { target: 'ORIGIN' } },
  ];
  openPie('Snap', [...items, null], app.pointer.x, app.pointer.y, 'S');
}

export function pivotPie() {
  const v = activeUVEditor();
  if (!v) return;
  const set = (p: typeof v.pivot) => () => {
    v.pivot = p;
    app.changed('ui');
  };
  openPie(
    'Pivot Point',
    [
      { label: 'Bounding Box Center', icon: 'pivot_boundbox', active: v.pivot === 'BOUNDING_BOX_CENTER', action: set('BOUNDING_BOX_CENTER') },
      { label: '2D Cursor', icon: 'pivot_cursor', active: v.pivot === 'CURSOR', action: set('CURSOR') },
      { label: 'Individual Origins', icon: 'pivot_individual', active: v.pivot === 'INDIVIDUAL_ORIGINS', action: set('INDIVIDUAL_ORIGINS') },
      { label: 'Median Point', icon: 'pivot_median', active: v.pivot === 'MEDIAN_POINT', action: set('MEDIAN_POINT') },
    ],
    app.pointer.x,
    app.pointer.y,
    'PERIOD',
  );
}

function falloffPie() {
  const t = ts();
  const items = (['SMOOTH', 'SPHERE', 'ROOT', 'INVERSE_SQUARE', 'SHARP', 'LINEAR', 'CONSTANT', 'RANDOM'] as const).map((f) => ({
    label: f === 'INVERSE_SQUARE' ? 'Inverse Square' : f[0] + f.slice(1).toLowerCase(),
    active: t.proportional_edit_falloff === f,
    action: () => {
      t.proportional_edit_falloff = f;
      app.pushUndo('Proportional Falloff');
      app.changed('ui', 'doc');
    },
  }));
  openPie('Proportional Editing Falloff', items, app.pointer.x, app.pointer.y, 'O');
}

function snapElementMenu(): MenuItem[] {
  const t = ts();
  const set = (v: 'INCREMENT' | 'VERTEX') => () => {
    t.snap_uv_element = v;
    app.pushUndo('Snap To');
    app.changed('ui', 'doc');
  };
  return [
    { label: 'Increment', icon: 'snap_increment', active: (t.snap_uv_element ?? 'INCREMENT') === 'INCREMENT', action: set('INCREMENT') },
    { label: 'Vertex', icon: 'snap_vertex', active: t.snap_uv_element === 'VERTEX', action: set('VERTEX') },
  ];
}

function toggleSetting(key: 'use_proportional_edit' | 'use_uv_select_sync' | 'use_snap_uv', label: string) {
  const t = ts();
  t[key] = !t[key];
  app.pushUndo(label);
  app.changed('ui', 'doc');
}

const inUV = () => !!activeUVEditor();
const sculptTool = () => ['grab', 'relax', 'pinch'].includes((activeUVEditor() as unknown as { tool?: string })?.tool ?? '');
const editing = () => inUV() && uvEditPoll();

addKeys('UV Editor', [
  { key: 'TAB', ctrl: true, menu: selectModeMenu, menuTitle: 'UV Select Mode', when: editing },
  { key: 'ONE', op: 'uv.select_mode', props: { type: 'VERTEX' }, when: editing },
  { key: 'TWO', op: 'uv.select_mode', props: { type: 'EDGE' }, when: editing },
  { key: 'THREE', op: 'uv.select_mode', props: { type: 'FACE' }, when: editing },
  { key: 'FOUR', op: 'uv.select_mode', props: { type: 'ISLAND' }, when: () => editing() && !ts().use_uv_select_sync },
  { key: 'E', ctrl: true, op: 'uv.mark_seam', when: editing },
  { key: 'Y', op: 'uv.select_split', when: editing },
  { key: 'B', op: 'uv.select_box', props: { pinned: false }, when: editing },
  { key: 'B', alt: true, op: 'uv.select_box', props: { pinned: true }, when: editing },
  { key: 'C', op: 'uv.select_circle', when: editing },
  { key: 'L', ctrl: true, op: 'uv.select_linked', when: editing },
  { key: 'L', op: 'uv.select_linked_pick', props: { extend: true, deselect: false }, when: editing },
  { key: 'L', shift: true, op: 'uv.select_linked_pick', props: { deselect: true }, when: editing },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'uv.select_more', when: editing },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'uv.select_less', when: editing },
  { key: 'G', shift: true, menu: similarMenu, menuTitle: 'Select Similar', when: editing },
  { key: 'A', op: 'uv.select_all', props: { action: 'SELECT' }, when: editing },
  { key: 'A', alt: true, op: 'uv.select_all', props: { action: 'DESELECT' }, when: editing },
  { key: 'I', ctrl: true, op: 'uv.select_all', props: { action: 'INVERT' }, when: editing },
  { key: 'H', alt: true, op: 'uv.reveal', when: editing },
  { key: 'H', op: 'uv.hide', props: { unselected: false }, when: editing },
  { key: 'H', shift: true, op: 'uv.hide', props: { unselected: true }, when: editing },
  { key: 'P', shift: true, op: 'uv.select_pinned', when: editing },
  { key: 'M', menu: mergeMenu, menuTitle: 'Merge', when: editing },
  { key: 'M', alt: true, menu: splitMenu, menuTitle: 'Split', when: editing },
  { key: 'W', shift: true, menu: alignMenu, menuTitle: 'Align', when: editing },
  ...(
    [
      ['NUMPAD_8', 'Y', 1],
      ['NUMPAD_2', 'Y', -1],
      ['NUMPAD_6', 'X', 1],
      ['NUMPAD_4', 'X', -1],
    ] as [string, string, number][]
  ).flatMap(([key, axis, distance]) => [
    { key, ctrl: true, op: 'uv.move_on_axis', props: { type: 'DYNAMIC', axis, distance }, when: editing },
    { key, shift: true, op: 'uv.move_on_axis', props: { type: 'PIXEL', axis, distance }, when: editing },
    { key, op: 'uv.move_on_axis', props: { type: 'UDIM', axis, distance }, when: editing },
  ]),
  { key: 'V', alt: true, op: 'uv.stitch', when: editing },
  { key: 'V', op: 'uv.rip_move', when: editing },
  { key: 'P', op: 'uv.pin', props: { clear: false }, when: editing },
  { key: 'P', alt: true, op: 'uv.pin', props: { clear: true }, when: editing },
  { key: 'C', ctrl: true, op: 'uv.copy', when: editing },
  { key: 'V', ctrl: true, op: 'uv.paste', when: editing },
  { key: 'U', menu: unwrapMenu, menuTitle: 'Unwrap', when: editing },
  { key: 'S', shift: true, action: snapPie, when: editing },
  { key: 'O', shift: true, action: falloffPie, when: editing },
  { key: 'O', action: () => toggleSetting('use_proportional_edit', 'Proportional Editing'), when: editing },
  { key: 'G', op: 'uv.translate', when: editing },
  { key: 'R', op: 'uv.rotate', when: editing },
  { key: 'S', op: 'uv.resize', when: editing },
  { key: 'M', ctrl: true, menu: () => mirrorMenu().slice(2), menuTitle: 'Mirror', when: editing },
  { key: 'S', shift: true, ctrl: true, alt: true, op: 'uv.shear', when: editing },
  { key: 'PERIOD', action: pivotPie, when: inUV },
  { key: 'F', action: () => radialControl('size', activeUVEditor()!), when: () => editing() && sculptTool() },
  { key: 'F', shift: true, action: () => radialControl('strength', activeUVEditor()!), when: () => editing() && sculptTool() },
  { key: 'TAB', shift: true, action: () => toggleSetting('use_snap_uv', 'Snap'), when: editing },
  { key: 'TAB', shift: true, ctrl: true, menu: snapElementMenu, menuTitle: 'Snap To', when: editing },
  { key: 'TAB', op: 'object.mode_set', props: { mode: 'EDIT', toggle: true }, when: inUV },
]);

/** Open the Export UV Layout dialog (menu entry helper). */
export function exportLayoutDialog() {
  operatorDialog('uv.export_layout');
}

export function openUVContextMenu(x: number, y: number) {
  openMenu(uvContextMenu(), { x, y }, { title: 'UV' });
}
