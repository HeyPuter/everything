// Menus shared by the Grease Pencil modes (Active Layer, Animation, Show/Hide, Clean Up, Active
// Material, Delete Frame) and the Draw / Sculpt mode header menus and keymaps.
import { app } from '../app/app';
import { addKeys } from '../app/keymap';
import type { MenuItem } from '../ui/menu';
import { gpOf } from './data';

const gpNow = () => gpOf(app.doc, app.activeObject);

/** Layers top → bottom (the active one marked) and New Layer. */
export function activeLayerMenu(): MenuItem[] {
  const gp = gpNow();
  const layers = (gp?.layers ?? [])
    .map((l, i) => ({
      label: l.name,
      icon: 'outliner_data_gp_layer',
      active: gp?.active_layer_index === i,
      op: 'grease_pencil.layer_active',
      props: { layer: i },
    }))
    .reverse();
  return [...layers, ...(layers.length ? [{ separator: true }] : []), { label: 'New Layer', icon: 'add', op: 'grease_pencil.layer_add' }];
}

export function animationMenu(): MenuItem[] {
  return [
    { label: 'Insert Blank Keyframe (Active Layer)', op: 'grease_pencil.insert_blank_frame', props: { all_layers: false }, shortcut: 'Shift I' },
    { label: 'Insert Blank Keyframe (All Layers)', op: 'grease_pencil.insert_blank_frame', props: { all_layers: true } },
    { separator: true },
    { label: 'Duplicate Active Keyframe (Active Layer)', op: 'grease_pencil.frame_duplicate', props: { all: false } },
    { label: 'Duplicate Active Keyframe (All Layers)', op: 'grease_pencil.frame_duplicate', props: { all: true } },
    { separator: true },
    { label: 'Delete Active Keyframe (Active Layer)', op: 'grease_pencil.active_frame_delete', props: { all: false } },
    { label: 'Delete Active Keyframe (All Layers)', op: 'grease_pencil.active_frame_delete', props: { all: true } },
  ];
}

/** Alt I: delete the keyframe on the current frame. */
export function drawDeleteMenu(): MenuItem[] {
  return [
    { label: 'Delete Active Keyframe (Active Layer)', op: 'grease_pencil.delete_frame', props: { type: 'ACTIVE_FRAME' } },
    { label: 'Delete Active Keyframes (All Layers)', op: 'grease_pencil.delete_frame', props: { type: 'ALL_FRAMES' }, shortcut: 'Shift Delete' },
  ];
}

export function showHideMenu(): MenuItem[] {
  return [
    { label: 'Show All Layers', op: 'grease_pencil.layer_reveal', shortcut: 'Alt H' },
    { separator: true },
    { label: 'Hide Active Layer', op: 'grease_pencil.layer_hide', props: { unselected: false }, shortcut: 'H' },
    { label: 'Hide Inactive Layers', op: 'grease_pencil.layer_hide', props: { unselected: true }, shortcut: 'Shift H' },
  ];
}

export function cleanupMenu(): MenuItem[] {
  return [
    { label: 'Clean Loose Points...', op: 'grease_pencil.clean_loose' },
    { label: 'Delete Duplicate Frames', op: 'grease_pencil.frame_clean_duplicate' },
    { label: 'Merge by Distance', op: 'grease_pencil.stroke_merge_by_distance' },
    { label: 'Reproject Strokes...', op: 'grease_pencil.reproject' },
  ];
}

/** U: pick the material new strokes use. */
export function activeMaterialMenu(): MenuItem[] {
  const ob = app.activeObject;
  const gp = gpNow();
  if (!ob || !gp) return [];
  return gp.materials.map((id, i) => ({
    label: (id && app.doc.materials[id]?.name) || '(empty slot)',
    icon: 'material',
    active: ob.active_material_index === i,
    op: 'grease_pencil.set_material',
    props: { slot: i },
  }));
}

/** Layer management (Properties ▸ Layers specials and the header Layer menu). */
export function layerMenu(): MenuItem[] {
  return [
    { label: 'Add New Layer', op: 'grease_pencil.layer_add' },
    { label: 'Duplicate Layer', op: 'grease_pencil.layer_duplicate', props: { empty_keyframes: false } },
    { label: 'Duplicate Empty Keyframes', op: 'grease_pencil.layer_duplicate', props: { empty_keyframes: true } },
    { label: 'Copy Layer to Selected', op: 'grease_pencil.layer_duplicate_object', props: { only_active: true } },
    { label: 'Copy All Layers to Selected', op: 'grease_pencil.layer_duplicate_object', props: { only_active: false } },
    { separator: true },
    { label: 'Show All', op: 'grease_pencil.layer_reveal' },
    { label: 'Hide Others', op: 'grease_pencil.layer_hide', props: { unselected: true } },
    { separator: true },
    { label: 'Lock All', op: 'grease_pencil.layer_lock_all', props: { lock: true } },
    { label: 'Unlock All', op: 'grease_pencil.layer_lock_all', props: { lock: false } },
    { label: 'Isolate', op: 'grease_pencil.layer_isolate', shortcut: 'Numpad *' },
    { separator: true },
    { label: 'Merge Down', op: 'grease_pencil.layer_merge', props: { mode: 'ACTIVE' }, shortcut: 'Shift Ctrl M' },
    { label: 'Merge All', op: 'grease_pencil.layer_merge', props: { mode: 'ALL' } },
    { separator: true },
    { label: 'Move Up', op: 'grease_pencil.layer_move', props: { direction: 'UP' } },
    { label: 'Move Down', op: 'grease_pencil.layer_move', props: { direction: 'DOWN' } },
    { label: 'Remove Layer', op: 'grease_pencil.layer_remove' },
  ];
}

/** Draw Mode header menu. */
export function drawMenu(): MenuItem[] {
  return [
    { label: 'Active Layer', submenu: activeLayerMenu, shortcut: 'Y' },
    { separator: true },
    { label: 'Animation', submenu: animationMenu, shortcut: 'I' },
    { label: 'Interpolate Sequence', op: 'grease_pencil.interpolate_sequence', props: { use_selection: false }, shortcut: 'Shift Ctrl E' },
    { separator: true },
    { label: 'Show/Hide', submenu: showHideMenu },
    { label: 'Clean Up', submenu: cleanupMenu },
    { separator: true },
    { label: 'Sample Color', op: 'paint.sample_color', shortcut: 'Shift X' },
  ];
}

/** Sculpt Mode header menu. */
export function sculptMenu(): MenuItem[] {
  return [
    { label: 'Active Layer', submenu: activeLayerMenu, shortcut: 'Y' },
    { separator: true },
    { label: 'Animation', submenu: animationMenu, shortcut: 'I' },
    { label: 'Interpolate Sequence', op: 'grease_pencil.interpolate_sequence', props: { use_selection: false }, shortcut: 'Shift Ctrl E' },
    { separator: true },
    { label: 'Show/Hide', submenu: showHideMenu },
    { label: 'Clean Up', submenu: cleanupMenu },
  ];
}

// ---------------------------------------------------------------------------
// keymaps shared by the Draw / Sculpt / Edit modes (on the "Grease Pencil" keymap, which the
// 3D view consults first)

const mode = () => app.doc.mode;
const isGPOb = () => !!gpNow();
/** Draw, Sculpt or Edit Mode of a grease pencil object */
export const anyGPMode = () => isGPOb() && (mode() === 'PAINT_GREASE_PENCIL' || mode() === 'SCULPT_GREASE_PENCIL' || mode() === 'EDIT' || mode() === 'VERTEX_GREASE_PENCIL' || mode() === 'WEIGHT_GREASE_PENCIL');
const drawOrSculpt = () => isGPOb() && (mode() === 'PAINT_GREASE_PENCIL' || mode() === 'SCULPT_GREASE_PENCIL');
const brushModes = () => drawOrSculpt() || (isGPOb() && (mode() === 'VERTEX_GREASE_PENCIL' || mode() === 'WEIGHT_GREASE_PENCIL'));
const draw = () => isGPOb() && mode() === 'PAINT_GREASE_PENCIL';
const editGP = () => isGPOb() && mode() === 'EDIT';

addKeys('Grease Pencil', [
  // shared by all three modes
  { key: 'I', menu: animationMenu, menuTitle: 'Animation', when: anyGPMode },
  { key: 'I', shift: true, op: 'grease_pencil.insert_blank_frame', when: anyGPMode },
  { key: 'I', alt: true, menu: drawDeleteMenu, menuTitle: 'Delete', when: anyGPMode },
  { key: 'DEL', shift: true, op: 'grease_pencil.delete_frame', props: { type: 'ALL_FRAMES' }, when: anyGPMode },
  { key: 'M', shift: true, ctrl: true, op: 'grease_pencil.layer_merge', props: { mode: 'ACTIVE' }, when: anyGPMode },
  { key: 'Y', menu: activeLayerMenu, menuTitle: 'Change Active Layer', when: anyGPMode },
  { key: 'H', alt: true, op: 'grease_pencil.layer_reveal', when: () => draw() || editGP() },
  { key: 'H', op: 'grease_pencil.layer_hide', props: { unselected: false }, when: () => draw() || editGP() },
  { key: 'H', shift: true, op: 'grease_pencil.layer_hide', props: { unselected: true }, when: () => draw() || editGP() },
  { key: 'NUMPAD_ASTERIX', op: 'grease_pencil.layer_isolate', when: () => draw() || editGP() },
  { key: 'U', menu: activeMaterialMenu, menuTitle: 'Active Material', when: drawOrSculpt },
  // interpolation (Edit Mode interpolates the selected strokes only)
  { key: 'E', ctrl: true, op: 'grease_pencil.interpolate', props: { use_selection: false }, when: draw },
  { key: 'E', shift: true, ctrl: true, op: 'grease_pencil.interpolate_sequence', props: { use_selection: false }, when: draw },
  { key: 'E', ctrl: true, op: 'grease_pencil.interpolate', props: { use_selection: true }, when: editGP },
  { key: 'E', shift: true, ctrl: true, op: 'grease_pencil.interpolate_sequence', props: { use_selection: true }, when: editGP },
  // brushes
  { key: 'LEFT_BRACKET', op: 'brush.scale_size', props: { scalar: 0.9 }, when: brushModes },
  { key: 'RIGHT_BRACKET', op: 'brush.scale_size', props: { scalar: 1 / 0.9 }, when: brushModes },
  { key: 'X', op: 'paint.brush_colors_flip', when: draw },
  { key: 'X', shift: true, op: 'paint.sample_color', when: draw },
]);
