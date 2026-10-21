// Edit Mode header menus (Grease Pencil, Stroke, Point), Select menu, context menu (W), the
// Delete / Snap / Move to Layer menus, the select mode buttons and the Edit Mode keymap.
import { app } from '../app/app';
import { addKeys } from '../app/keymap';
import { modeMenus } from '../editors/view3d/modemenus';
import { mirrorMenu, editTransformExtras } from '../editors/view3d/transformui';
import { h } from '../ui/h';
import { icon } from '../ui/icons';
import { openPie, promptText, type MenuItem } from '../ui/menu';
import { gpOf, gpTS } from './data';
import { inGPEdit } from './edit';
import { activeLayerMenu, animationMenu, showHideMenu, cleanupMenu } from './menus';
import { placementControls } from './ui';
import { vertexGroupMenu } from './weightpaint';
import { convertTypeMenu, setCurveTypeMenu, strokeTypeMenu, handleTypeMenu, cornerTypeMenu, selectByStrokeTypeMenu } from './curveedit';


const gpNow = () => gpOf(app.doc, app.activeObject);

function transformMenu(): MenuItem[] {
  return [
    { label: 'Move', op: 'transform.translate', shortcut: 'G' },
    { label: 'Rotate', op: 'transform.rotate', shortcut: 'R' },
    { label: 'Scale', op: 'transform.resize', shortcut: 'S' },
    { separator: true },
    { label: 'To Sphere', op: 'transform.tosphere', shortcut: 'Shift Alt S' },
    ...editTransformExtras(),
    { label: 'Push/Pull', op: 'transform.push_pull' },
    { label: 'Radius', op: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN' }, shortcut: 'Alt S' },
    { label: 'Opacity', op: 'transform.transform', props: { mode: 'GPENCIL_OPACITY' }, shortcut: 'Shift F' },
  ];
}

export function snapMenu(): MenuItem[] {
  return [
    { label: 'Selection to Grid', op: 'grease_pencil.snap_to_grid' },
    { label: 'Selection to Cursor', op: 'grease_pencil.snap_to_cursor', props: { use_offset: false } },
    { label: 'Selection to Cursor (Keep Offset)', op: 'grease_pencil.snap_to_cursor', props: { use_offset: true } },
    { separator: true },
    { label: 'Cursor to Selected', op: 'grease_pencil.snap_cursor_to_selected' },
    { label: 'Cursor to World Origin', op: 'view3d.snap_cursor_to_center' },
    { label: 'Cursor to Grid', op: 'view3d.snap_cursor_to_grid' },
  ];
}

function openSnapPie() {
  openPie(
    'Snap',
    [
      { label: 'Cursor to Grid', op: 'view3d.snap_cursor_to_grid' },
      { label: 'Selection to Grid', op: 'grease_pencil.snap_to_grid' },
      { label: 'Cursor to Selected', op: 'grease_pencil.snap_cursor_to_selected' },
      { label: 'Selection to Cursor', op: 'grease_pencil.snap_to_cursor', props: { use_offset: false } },
      { label: 'Selection to Cursor (Keep Offset)', op: 'grease_pencil.snap_to_cursor', props: { use_offset: true } },
      null,
      { label: 'Cursor to World Origin', op: 'view3d.snap_cursor_to_center' },
      null,
    ],
    app.pointer.x,
    app.pointer.y,
    'S',
  );
}

export function deleteMenu(): MenuItem[] {
  return [
    { label: 'Points', op: 'grease_pencil.delete' },
    { separator: true },
    { label: 'Dissolve', op: 'grease_pencil.dissolve', props: { type: 'POINTS' }, shortcut: 'Ctrl X' },
    { label: 'Dissolve Between', op: 'grease_pencil.dissolve', props: { type: 'BETWEEN' } },
    { label: 'Dissolve Unselected', op: 'grease_pencil.dissolve', props: { type: 'UNSELECT' } },
    { separator: true },
    { label: 'Delete Active Keyframe (Active Layer)', op: 'grease_pencil.delete_frame', props: { type: 'ACTIVE_FRAME' } },
    { label: 'Delete Active Keyframes (All Layers)', op: 'grease_pencil.delete_frame', props: { type: 'ALL_FRAMES' }, shortcut: 'Shift Delete' },
  ];
}

/** M: move the selection to a layer (or a new one). */
export function moveToLayerMenu(): MenuItem[] {
  const layers = (gpNow()?.layers ?? []).map((l) => ({ label: l.name, icon: 'outliner_data_gp_layer', op: 'grease_pencil.move_to_layer', props: { target_layer_name: l.name, add_new_layer: false } })).reverse();
  return [
    ...layers,
    { separator: true },
    {
      label: 'New Layer',
      icon: 'add',
      action: () => promptText('New Layer', 'Layer', (name) => name && app.run('grease_pencil.move_to_layer', { target_layer_name: name, add_new_layer: true })),
    },
  ];
}

function assignMaterialMenu(): MenuItem[] {
  return (gpNow()?.materials ?? []).map((id, i) => ({
    label: (id && app.doc.materials[id]?.name) || '(empty slot)',
    icon: 'material',
    op: 'grease_pencil.stroke_material_set',
    props: { slot: i },
  }));
}

function arrangeMenu(): MenuItem[] {
  return [
    { label: 'Bring to Front', op: 'grease_pencil.reorder', props: { direction: 'TOP' }, shortcut: 'Shift Ctrl ↑' },
    { label: 'Bring Forward', op: 'grease_pencil.reorder', props: { direction: 'UP' }, shortcut: 'Ctrl ↑' },
    { separator: true },
    { label: 'Send Backward', op: 'grease_pencil.reorder', props: { direction: 'DOWN' }, shortcut: 'Ctrl ↓' },
    { label: 'Send to Back', op: 'grease_pencil.reorder', props: { direction: 'BOTTOM' }, shortcut: 'Shift Ctrl ↓' },
  ];
}

function capsMenu(): MenuItem[] {
  return [
    { label: 'Rounded', op: 'grease_pencil.caps_set', props: { type: 'ROUND' } },
    { label: 'Flat', op: 'grease_pencil.caps_set', props: { type: 'FLAT' } },
    { separator: true },
    { label: 'Toggle Start', op: 'grease_pencil.caps_set', props: { type: 'START' } },
    { label: 'Toggle End', op: 'grease_pencil.caps_set', props: { type: 'END' } },
  ];
}

function separateMenu(): MenuItem[] {
  return [
    { label: 'Selection', op: 'grease_pencil.separate', props: { mode: 'SELECTED' } },
    { label: 'By Material', op: 'grease_pencil.separate', props: { mode: 'MATERIAL' } },
    { label: 'By Layer', op: 'grease_pencil.separate', props: { mode: 'LAYER' } },
  ];
}

function joinMenu(): MenuItem[] {
  return [
    { label: 'Join Strokes', op: 'grease_pencil.join_selection', props: { type: 'JOINSTROKES' }, shortcut: 'Ctrl J' },
    { label: 'Join and Copy', op: 'grease_pencil.join_selection', props: { type: 'SPLITCOPY' }, shortcut: 'Shift Ctrl J' },
    { label: 'Join', op: 'grease_pencil.join_selection', props: { type: 'SPLIT' } },
  ];
}

function simplifyMenu(): MenuItem[] {
  return [
    { label: 'Fixed', op: 'grease_pencil.stroke_simplify', props: { mode: 'FIXED' } },
    { label: 'Adaptive', op: 'grease_pencil.stroke_simplify', props: { mode: 'ADAPTIVE' } },
    { label: 'Sample', op: 'grease_pencil.stroke_simplify', props: { mode: 'SAMPLE' } },
    { label: 'Merge', op: 'grease_pencil.stroke_simplify', props: { mode: 'MERGE' } },
  ];
}

/** Grease Pencil menu. */
function gpMenu(): MenuItem[] {
  return [
    { label: 'Transform', submenu: transformMenu },
    { label: 'Mirror', submenu: mirrorMenu },
    { label: 'Snap', submenu: snapMenu },
    { separator: true },
    { label: 'Active Layer', submenu: activeLayerMenu, shortcut: 'Y' },
    { separator: true },
    { label: 'Animation', submenu: animationMenu, shortcut: 'I' },
    { label: 'Interpolate Sequence', op: 'grease_pencil.interpolate_sequence', props: { use_selection: true }, shortcut: 'Shift Ctrl E' },
    { separator: true },
    { label: 'Duplicate', op: 'grease_pencil.duplicate_move', shortcut: 'Shift D' },
    { separator: true },
    { label: 'Split', op: 'grease_pencil.stroke_split', shortcut: 'Shift V' },
    { label: 'Copy', op: 'grease_pencil.copy', shortcut: 'Ctrl C' },
    { label: 'Paste', op: 'grease_pencil.paste', props: { type: 'ACTIVE' }, shortcut: 'Ctrl V' },
    { label: 'Paste by Layer', op: 'grease_pencil.paste', props: { type: 'LAYER' } },
    { separator: true },
    { label: 'Show/Hide', submenu: showHideMenu },
    { label: 'Separate', submenu: separateMenu, shortcut: 'P' },
    { label: 'Clean Up', submenu: cleanupMenu },
    { label: 'Outline', op: 'grease_pencil.outline' },
    { separator: true },
    { label: 'Delete', submenu: deleteMenu, shortcut: 'X' },
  ];
}

function strokeMenu(): MenuItem[] {
  const ts = gpTS(app.doc) as unknown as { use_scale_thickness?: boolean };
  return [
    { label: 'Subdivide', op: 'grease_pencil.stroke_subdivide' },
    { label: 'Subdivide and Smooth', op: 'grease_pencil.stroke_subdivide_smooth' },
    { label: 'Simplify Stroke', submenu: simplifyMenu },
    { label: 'Outline', op: 'grease_pencil.outline' },
    { separator: true },
    { label: 'Join', submenu: joinMenu },
    { separator: true },
    { label: 'Move to Layer', submenu: moveToLayerMenu, shortcut: 'M' },
    { label: 'Assign Material', submenu: assignMaterialMenu },
    { label: 'Set as Active Material', op: 'grease_pencil.set_active_material', props: { slot: -1 } },
    { label: 'Arrange', submenu: arrangeMenu },
    { separator: true },
    { label: 'Close', op: 'grease_pencil.cyclical_set', props: { type: 'CLOSE', subdivide_cyclic_segment: true }, shortcut: 'F' },
    { label: 'Toggle Cyclic', op: 'grease_pencil.cyclical_set', props: { type: 'TOGGLE', subdivide_cyclic_segment: false }, shortcut: 'Alt C' },
    { label: 'Set Caps', submenu: capsMenu },
    { label: 'Switch Direction', op: 'grease_pencil.stroke_switch_direction' },
    { label: 'Set Start Point', op: 'grease_pencil.set_start_point' },
    { separator: true },
    { label: 'Set Uniform Thickness', op: 'grease_pencil.set_uniform_thickness' },
    { label: 'Set Uniform Opacity', op: 'grease_pencil.set_uniform_opacity' },
    {
      label: 'Scale Thickness',
      checked: ts.use_scale_thickness !== false,
      keepOpen: true,
      description: 'Scaling the selection also scales the stroke thickness',
      action: () => {
        ts.use_scale_thickness = ts.use_scale_thickness === false;
        app.changed('ui');
      },
    },
    { separator: true },
    { label: 'Convert Type', submenu: convertTypeMenu },
    { label: 'Set Curve Type', submenu: setCurveTypeMenu },
    { label: 'Set Resolution', op: 'grease_pencil.set_curve_resolution' },
    { separator: true },
    { label: 'Set Stroke Type', submenu: strokeTypeMenu },
    { separator: true },
    { label: 'Reset UVs', op: 'grease_pencil.reset_uvs' },
    { label: 'Join Fills', op: 'grease_pencil.join_fills', shortcut: 'Shift J' },
    { label: 'Separate Fills', op: 'grease_pencil.separate_fills', shortcut: 'Alt P' },
  ];
}

function pointMenu(): MenuItem[] {
  return [
    { label: 'Extrude', op: 'grease_pencil.extrude_move', shortcut: 'E' },
    { separator: true },
    { label: 'Smooth', op: 'grease_pencil.stroke_smooth' },
    { separator: true },
    { label: 'Vertex Groups', submenu: vertexGroupMenu, shortcut: 'Ctrl G' },
    { separator: true },
    { label: 'Set Handle Type', submenu: handleTypeMenu, shortcut: 'V' },
    { label: 'Set Corner Type', submenu: cornerTypeMenu },
  ];
}

function selectItems(): MenuItem[] {
  return [
    { label: 'All', op: 'grease_pencil.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'grease_pencil.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'grease_pencil.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'view3d.select_box', shortcut: 'B' },
    { label: 'Circle Select', op: 'view3d.select_circle', shortcut: 'C' },
    { label: 'Lasso Select', op: 'view3d.select_lasso_tool' },
    { separator: true },
    { label: 'Random', op: 'grease_pencil.select_random' },
    { label: 'Alternated', op: 'grease_pencil.select_alternate' },
    { separator: true },
    { label: 'More', op: 'grease_pencil.select_more', shortcut: 'Ctrl Numpad +' },
    { label: 'Less', op: 'grease_pencil.select_less', shortcut: 'Ctrl Numpad -' },
    { separator: true },
    {
      label: 'Select Similar',
      shortcut: 'Shift G',
      submenu: () =>
        [
          ['LAYER', 'Layer'],
          ['MATERIAL', 'Material'],
          ['VERTEX_COLOR', 'Vertex Color'],
          ['RADIUS', 'Radius'],
          ['OPACITY', 'Opacity'],
        ].map(([mode, label]) => ({ label, op: 'grease_pencil.select_similar', props: { mode } })),
    },
    { label: 'By Stroke Type', submenu: selectByStrokeTypeMenu },
    { label: 'Fill', op: 'grease_pencil.select_fill', shortcut: 'Ctrl L' },
    { label: 'Linked', op: 'grease_pencil.select_linked', shortcut: 'L' },
    { separator: true },
    { label: 'First', op: 'grease_pencil.select_ends', props: { amount_start: 1, amount_end: 0 } },
    { label: 'Last', op: 'grease_pencil.select_ends', props: { amount_start: 0, amount_end: 1 } },
  ];
}

/** W / right click: the Edit Mode context menu. */
function contextMenu(): MenuItem[] {
  return [
    { heading: 'Point' },
    { label: 'Subdivide', op: 'grease_pencil.stroke_subdivide' },
    { label: 'Subdivide and Smooth', op: 'grease_pencil.stroke_subdivide_smooth' },
    { label: 'Simplify', op: 'grease_pencil.stroke_simplify' },
    { label: 'Outline', op: 'grease_pencil.outline' },
    { label: 'Set Stroke Type', submenu: strokeTypeMenu },
    { separator: true },
    { label: 'To Sphere', op: 'transform.tosphere', shortcut: 'Shift Alt S' },
    { label: 'Shear', op: 'transform.shear', shortcut: 'Shift Ctrl Alt S' },
    { label: 'Bend', op: 'transform.bend', shortcut: 'Shift W' },
    { label: 'Push/Pull', op: 'transform.push_pull' },
    { label: 'Shrink/Fatten', op: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN' }, shortcut: 'Alt S' },
    { label: 'Smooth Points', op: 'grease_pencil.stroke_smooth' },
    { label: 'Set Start Point', op: 'grease_pencil.set_start_point' },
    { label: 'Set Corner Type', submenu: cornerTypeMenu },
    { separator: true },
    { label: 'Mirror', submenu: mirrorMenu },
    { separator: true },
    { label: 'Copy', op: 'grease_pencil.copy', shortcut: 'Ctrl C' },
    { label: 'Paste', op: 'grease_pencil.paste', shortcut: 'Ctrl V' },
    { label: 'Duplicate', op: 'grease_pencil.duplicate_move', shortcut: 'Shift D' },
    { separator: true },
    { label: 'Extrude', op: 'grease_pencil.extrude_move', shortcut: 'E' },
    { separator: true },
    { label: 'Split', op: 'grease_pencil.stroke_split', shortcut: 'Shift V' },
    { label: 'Separate', op: 'grease_pencil.separate', shortcut: 'P' },
    { separator: true },
    { label: 'Dissolve', op: 'grease_pencil.dissolve', props: { type: 'POINTS' } },
    { label: 'Dissolve Between', op: 'grease_pencil.dissolve', props: { type: 'BETWEEN' } },
    { label: 'Dissolve Unselected', op: 'grease_pencil.dissolve', props: { type: 'UNSELECT' } },
    { separator: true },
    { label: 'Convert Type', submenu: convertTypeMenu },
  ];
}

function selectModeButtons() {
  const m = gpTS(app.doc).gpencil_selectmode_edit;
  const btn = (mode: 'POINT' | 'STROKE' | 'SEGMENT', ic: string, tip: string) =>
    h(
      'button',
      {
        key: `gpsm-${mode}`,
        class: { 'hdr-toggle': true, on: m === mode },
        'data-tip': tip,
        onclick: () => app.run('grease_pencil.set_selection_mode', { mode }),
      },
      icon(ic),
    );
  return h(
    'div',
    { key: 'gp-selmode', class: 'hdr-group', style: { display: 'flex', gap: '1px' } },
    btn('POINT', 'gp_select_points', 'Point\nSelect individual points (1)'),
    btn('STROKE', 'gp_select_strokes', 'Stroke\nSelect whole strokes (2)'),
    btn('SEGMENT', 'gp_select_between_strokes', 'Segment\nSelect the part of a stroke between its crossings with other strokes (3)'),
  );
}

const prevEdit = modeMenus.EDIT;
modeMenus.EDIT = {
  ...prevEdit,
  header: () =>
    inGPEdit()
      ? [
          ['Grease Pencil', gpMenu],
          ['Point', pointMenu],
          ['Stroke', strokeMenu],
        ]
      : (prevEdit?.header?.() ?? []),
  select: () => (inGPEdit() ? selectItems() : (prevEdit?.select?.() ?? [])),
  add: () => (inGPEdit() ? [] : (prevEdit?.add?.() ?? [])),
  context: () => (inGPEdit() ? contextMenu() : (prevEdit?.context?.() ?? [])),
  headerExtra: () => (inGPEdit() ? [selectModeButtons(), placementControls()] : (prevEdit?.headerExtra?.() ?? null)),
};

const e = inGPEdit;

addKeys('Grease Pencil', [
  // selection
  { key: 'A', op: 'grease_pencil.select_all', props: { action: 'SELECT' }, when: e },
  { key: 'A', alt: true, op: 'grease_pencil.select_all', props: { action: 'DESELECT' }, when: e },
  { key: 'I', ctrl: true, op: 'grease_pencil.select_all', props: { action: 'INVERT' }, when: e },
  { key: 'L', ctrl: true, op: 'grease_pencil.select_fill', when: e },
  { key: 'L', op: 'grease_pencil.select_linked', props: { deselect: false }, when: e },
  { key: 'L', shift: true, op: 'grease_pencil.select_linked', props: { deselect: true }, when: e },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'grease_pencil.select_more', when: e },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'grease_pencil.select_less', when: e },
  {
    key: 'G',
    shift: true,
    menu: () => selectItems().find((i) => i.label === 'Select Similar')!.submenu!(),
    menuTitle: 'Select Similar',
    when: e,
  },
  // edit
  { key: 'X', menu: deleteMenu, menuTitle: 'Delete', when: e },
  { key: 'DEL', menu: deleteMenu, menuTitle: 'Delete', when: e },
  { key: 'X', ctrl: true, op: 'grease_pencil.dissolve', props: { type: 'POINTS' }, when: e },
  { key: 'DEL', ctrl: true, op: 'grease_pencil.dissolve', props: { type: 'POINTS' }, when: e },
  { key: 'C', ctrl: true, op: 'grease_pencil.copy', when: e },
  { key: 'V', ctrl: true, op: 'grease_pencil.paste', props: { paste_back: false }, when: e },
  { key: 'V', shift: true, ctrl: true, op: 'grease_pencil.paste', props: { paste_back: true }, when: e },
  { key: 'S', shift: true, action: openSnapPie, when: e },
  { key: 'P', op: 'grease_pencil.separate', props: { mode: 'SELECTED' }, when: e },
  { key: 'F', op: 'grease_pencil.cyclical_set', props: { type: 'CLOSE', subdivide_cyclic_segment: true }, when: e },
  { key: 'C', alt: true, op: 'grease_pencil.cyclical_set', props: { type: 'TOGGLE', subdivide_cyclic_segment: false }, when: e },
  { key: 'J', ctrl: true, op: 'grease_pencil.join_selection', props: { type: 'JOINSTROKES' }, when: e },
  { key: 'J', shift: true, ctrl: true, op: 'grease_pencil.join_selection', props: { type: 'SPLITCOPY' }, when: e },
  { key: 'D', shift: true, op: 'grease_pencil.duplicate_move', when: e },
  { key: 'V', shift: true, op: 'grease_pencil.stroke_split', when: e },
  { key: 'E', op: 'grease_pencil.extrude_move', when: e },
  { key: 'M', menu: moveToLayerMenu, menuTitle: 'Move to Layer', when: e },
  { key: 'W', menu: contextMenu, menuTitle: 'Grease Pencil', when: e },
  { key: 'UP_ARROW', shift: true, ctrl: true, op: 'grease_pencil.reorder', props: { direction: 'TOP' }, when: e },
  { key: 'UP_ARROW', ctrl: true, op: 'grease_pencil.reorder', props: { direction: 'UP' }, when: e },
  { key: 'DOWN_ARROW', ctrl: true, op: 'grease_pencil.reorder', props: { direction: 'DOWN' }, when: e },
  { key: 'DOWN_ARROW', shift: true, ctrl: true, op: 'grease_pencil.reorder', props: { direction: 'BOTTOM' }, when: e },
  { key: 'J', shift: true, op: 'grease_pencil.join_fills', when: e },
  { key: 'P', alt: true, op: 'grease_pencil.separate_fills', when: e },
  // transforms
  { key: 'M', ctrl: true, op: 'transform.mirror', when: e },
  { key: 'S', shift: true, alt: true, op: 'transform.tosphere', when: e },
  { key: 'S', shift: true, ctrl: true, alt: true, op: 'transform.shear', when: e },
  { key: 'W', shift: true, op: 'transform.bend', when: e },
  { key: 'S', alt: true, op: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN' }, when: e },
  { key: 'F', shift: true, op: 'transform.transform', props: { mode: 'GPENCIL_OPACITY' }, when: e },
  // proportional editing: connected (along the strokes)
  {
    key: 'O',
    alt: true,
    when: e,
    action: () => {
      const ts = app.doc.scene.tool_settings;
      ts.use_proportional_connected = !ts.use_proportional_connected;
      app.report('INFO', `Proportional Editing Connected: ${ts.use_proportional_connected ? 'on' : 'off'}`);
      app.changed('ui');
    },
  },
  // select modes
  { key: 'ONE', op: 'grease_pencil.set_selection_mode', props: { mode: 'POINT' }, when: e },
  { key: 'TWO', op: 'grease_pencil.set_selection_mode', props: { mode: 'STROKE' }, when: e },
  { key: 'THREE', op: 'grease_pencil.set_selection_mode', props: { mode: 'SEGMENT' }, when: e },
]);

