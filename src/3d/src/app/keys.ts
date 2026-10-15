// Default key bindings (left-click select). Key names are the event type
// identifiers used throughout the keymaps.
import { addKeys } from './keymap';
import { app } from './app';
import { addMenu, applyMenu, objectContextMenu } from '../editors/view3d/menus';
import { availableModes } from '../editors/view3d/header';
import { openPie } from '../ui/menu';
import { parentClearMenu, parentSetMenu } from '../object/menus';

const objectMode = () => app.doc.mode === 'OBJECT';

addKeys('Window', [
  { key: 'N', ctrl: true, op: 'wm.call_menu', props: { name: 'TOPBAR_MT_file_new' } },
  { key: 'O', ctrl: true, op: 'wm.open_mainfile' },
  { key: 'S', ctrl: true, op: 'wm.save_mainfile' },
  { key: 'S', ctrl: true, shift: true, op: 'wm.save_as_mainfile' },
  { key: 'Z', ctrl: true, op: 'ed.undo' },
  { key: 'Z', ctrl: true, shift: true, op: 'ed.redo' },
  { key: 'Y', ctrl: true, op: 'ed.redo' },
  { key: 'Z', ctrl: true, alt: true, op: 'ed.undo_history' },
  { key: 'F3', op: 'wm.search_menu' },
  { key: 'F9', op: 'screen.redo_last' },
  { key: 'R', shift: true, op: 'screen.repeat_last' },
  { key: 'F12', op: 'render.render' },
  { key: 'F12', ctrl: true, op: 'render.render', props: { animation: true } },
  { key: 'F11', op: 'render.view_show' },
  { key: 'PAGE_UP', ctrl: true, op: 'screen.workspace_cycle', props: { direction: 'PREV' } },
  { key: 'PAGE_DOWN', ctrl: true, op: 'screen.workspace_cycle', props: { direction: 'NEXT' } },
  { key: 'COMMA', ctrl: true, op: 'screen.userpref_show' },
]);

addKeys('Screen', [
  { key: 'SPACE', ctrl: true, op: 'screen.screen_full_area' },
  { key: 'SPACE', ctrl: true, alt: true, op: 'screen.screen_full_area', props: { use_hide_panels: true } },
]);

addKeys('Frames', [
  { key: 'LEFT_ARROW', op: 'screen.frame_offset', props: { delta: -1 } },
  { key: 'RIGHT_ARROW', op: 'screen.frame_offset', props: { delta: 1 } },
  { key: 'LEFT_ARROW', shift: true, op: 'screen.frame_jump', props: { end: false } },
  { key: 'RIGHT_ARROW', shift: true, op: 'screen.frame_jump', props: { end: true } },
  { key: 'UP_ARROW', op: 'screen.keyframe_jump', props: { next: true } },
  { key: 'DOWN_ARROW', op: 'screen.keyframe_jump', props: { next: false } },
  { key: 'SPACE', op: 'screen.animation_play' },
  { key: 'SPACE', shift: true, ctrl: true, op: 'screen.animation_play', props: { reverse: true } },
  { key: 'ESC', op: 'screen.animation_cancel' },
]);

addKeys('3D View', [
  { key: 'NUMPAD_1', op: 'view3d.view_axis', props: { type: 'FRONT' } },
  { key: 'NUMPAD_1', ctrl: true, op: 'view3d.view_axis', props: { type: 'BACK' } },
  { key: 'NUMPAD_3', op: 'view3d.view_axis', props: { type: 'RIGHT' } },
  { key: 'NUMPAD_3', ctrl: true, op: 'view3d.view_axis', props: { type: 'LEFT' } },
  { key: 'NUMPAD_7', op: 'view3d.view_axis', props: { type: 'TOP' } },
  { key: 'NUMPAD_7', ctrl: true, op: 'view3d.view_axis', props: { type: 'BOTTOM' } },
  { key: 'NUMPAD_1', shift: true, op: 'view3d.view_axis', props: { type: 'FRONT', align_active: true } },
  { key: 'NUMPAD_3', shift: true, op: 'view3d.view_axis', props: { type: 'RIGHT', align_active: true } },
  { key: 'NUMPAD_7', shift: true, op: 'view3d.view_axis', props: { type: 'TOP', align_active: true } },
  { key: 'NUMPAD_5', op: 'view3d.view_persportho' },
  { key: 'NUMPAD_4', op: 'view3d.view_orbit', props: { type: 'ORBITLEFT' } },
  { key: 'NUMPAD_6', op: 'view3d.view_orbit', props: { type: 'ORBITRIGHT' } },
  { key: 'NUMPAD_8', op: 'view3d.view_orbit', props: { type: 'ORBITUP' } },
  { key: 'NUMPAD_2', op: 'view3d.view_orbit', props: { type: 'ORBITDOWN' } },
  { key: 'NUMPAD_9', op: 'view3d.view_orbit', props: { type: 'ORBITOPPOSITE' } },
  { key: 'NUMPAD_4', shift: true, op: 'view3d.view_roll', props: { angle: (-15 * Math.PI) / 180 } },
  { key: 'NUMPAD_6', shift: true, op: 'view3d.view_roll', props: { angle: (15 * Math.PI) / 180 } },
  { key: 'NUMPAD_4', ctrl: true, op: 'view3d.view_pan', props: { type: 'PANLEFT' } },
  { key: 'NUMPAD_6', ctrl: true, op: 'view3d.view_pan', props: { type: 'PANRIGHT' } },
  { key: 'NUMPAD_8', ctrl: true, op: 'view3d.view_pan', props: { type: 'PANUP' } },
  { key: 'NUMPAD_2', ctrl: true, op: 'view3d.view_pan', props: { type: 'PANDOWN' } },
  { key: 'NUMPAD_PLUS', op: 'view3d.zoom', props: { delta: 1 } },
  { key: 'NUMPAD_MINUS', op: 'view3d.zoom', props: { delta: -1 } },
  { key: 'EQUAL', ctrl: true, op: 'view3d.zoom', props: { delta: 1 } },
  { key: 'MINUS', ctrl: true, op: 'view3d.zoom', props: { delta: -1 } },
  { key: 'NUMPAD_0', op: 'view3d.view_camera' },
  { key: 'NUMPAD_0', ctrl: true, op: 'view3d.object_as_camera' },
  { key: 'NUMPAD_0', ctrl: true, alt: true, op: 'view3d.camera_to_view' },
  { key: 'NUMPAD_PERIOD', op: 'view3d.view_selected' },
  { key: 'NUMPAD_SLASH', op: 'view3d.localview' },
  { key: 'HOME', op: 'view3d.view_all' },
  { key: 'C', shift: true, op: 'view3d.view_all', props: { center: true } },
  { key: 'ACCENT_GRAVE', op: 'view3d.pie_view' },
  { key: 'Z', op: 'view3d.pie_shading' },
  { key: 'Z', alt: true, op: 'view3d.toggle_xray' },
  { key: 'Z', shift: true, alt: true, op: 'view3d.toggle_overlays' },
  { key: 'T', op: 'view3d.toggle_toolbar' },
  { key: 'N', op: 'view3d.toggle_sidebar' },
  { key: 'S', shift: true, op: 'view3d.pie_snap' },
  { key: 'PERIOD', op: 'view3d.pie_pivot' },
  { key: 'TAB', shift: true, op: 'wm.context_toggle_snap' },
  { key: 'O', op: 'wm.context_toggle_proportional' },
  { key: 'G', op: 'transform.translate' },
  { key: 'R', op: 'transform.rotate' },
  { key: 'S', op: 'transform.resize' },
  { key: 'B', op: 'view3d.select_box' },
  { key: 'W', op: 'wm.tool_cycle_select' },
  { key: 'TAB', op: 'object.editmode_toggle' },
  { key: 'TAB', ctrl: true, op: 'object.posemode_toggle', when: () => app.activeObject?.type === 'ARMATURE' },
  { key: 'TAB', ctrl: true, op: 'view3d.pie_mode' },
  { key: 'I', op: 'anim.keyframe_insert', when: () => app.doc.mode === 'OBJECT' || app.doc.mode === 'POSE' },
  { key: 'I', alt: true, op: 'anim.keyframe_delete_v3d', when: () => app.doc.mode === 'OBJECT' || app.doc.mode === 'POSE' },
  { key: 'I', alt: true, shift: true, op: 'anim.keyframe_clear_v3d', when: () => app.doc.mode === 'OBJECT' },
  { key: 'K', op: 'anim.keyframe_insert_menu', when: objectMode },
]);

addKeys('Object Mode', [
  { key: 'A', op: 'object.select_all', props: { action: 'SELECT' }, when: objectMode },
  { key: 'A', alt: true, op: 'object.select_all', props: { action: 'DESELECT' }, when: objectMode },
  { key: 'I', ctrl: true, op: 'object.select_all', props: { action: 'INVERT' }, when: objectMode },
  { key: 'G', alt: true, op: 'object.location_clear', when: objectMode },
  { key: 'R', alt: true, op: 'object.rotation_clear', when: objectMode },
  { key: 'S', alt: true, op: 'object.scale_clear', when: objectMode },
  { key: 'O', alt: true, op: 'object.origin_clear', when: objectMode },
  { key: 'D', shift: true, op: 'object.duplicate_move', when: objectMode },
  { key: 'D', alt: true, op: 'object.duplicate_move_linked', when: objectMode },
  { key: 'X', op: 'object.delete', when: objectMode },
  { key: 'DEL', op: 'object.delete', props: { confirm: false }, when: objectMode },
  { key: 'A', shift: true, menu: addMenu, menuTitle: 'Add', when: objectMode },
  { key: 'H', op: 'object.hide_view_set', when: objectMode },
  { key: 'H', shift: true, op: 'object.hide_view_set', props: { unselected: true }, when: objectMode },
  { key: 'H', alt: true, op: 'object.hide_view_clear', when: objectMode },
  { key: 'M', op: 'object.move_to_collection', when: objectMode },
  { key: 'M', shift: true, op: 'object.link_to_collection', when: objectMode },
  { key: 'J', ctrl: true, op: 'object.join', when: objectMode },
  { key: 'P', ctrl: true, menu: parentSetMenu, menuTitle: 'Set Parent To', when: objectMode },
  { key: 'P', alt: true, menu: parentClearMenu, menuTitle: 'Clear Parent', when: objectMode },
  { key: 'A', ctrl: true, menu: applyMenu, menuTitle: 'Apply', when: objectMode },
  { key: 'F2', op: 'object.rename' },
  { key: 'C', ctrl: true, op: 'view3d.copybuffer', when: objectMode },
  { key: 'V', ctrl: true, op: 'view3d.pastebuffer', when: objectMode },
  { key: 'LEFT_BRACKET', op: 'object.select_hierarchy', props: { direction: 'PARENT' }, when: objectMode },
  { key: 'RIGHT_BRACKET', op: 'object.select_hierarchy', props: { direction: 'CHILD' }, when: objectMode },
  { key: 'LEFT_BRACKET', shift: true, op: 'object.select_hierarchy', props: { direction: 'PARENT', extend: true }, when: objectMode },
  { key: 'RIGHT_BRACKET', shift: true, op: 'object.select_hierarchy', props: { direction: 'CHILD', extend: true }, when: objectMode },
  { key: 'G', ctrl: true, op: 'collection.create', when: objectMode },
  { key: 'M', shift: true, ctrl: true, op: 'object.select_mirror', when: objectMode },
  { key: 'F10', shift: true, menu: objectContextMenu },
]);

export function modePie() {
  const modes = availableModes();
  const dirs = ['OBJECT', 'EDIT', 'SCULPT', 'POSE', 'VERTEX_PAINT', 'WEIGHT_PAINT', 'TEXTURE_PAINT'];
  const items = dirs.map((d) => {
    // grease pencil objects show their own Sculpt / Draw modes in the Sculpt / Texture Paint slots
    const alt: Record<string, string> = { SCULPT: 'SCULPT_GREASE_PENCIL', TEXTURE_PAINT: 'PAINT_GREASE_PENCIL' };
    const m = modes.find((x) => x.mode === d) ?? modes.find((x) => x.mode === alt[d]);
    return m ? { label: m.label, icon: m.icon, active: app.doc.mode === m.mode, op: 'object.mode_set', props: { mode: m.mode } } : null;
  });
  // W E S N NW NE SW SE
  openPie('Mode', [items[0], items[1], items[4], items[2], items[3], items[5], items[6], null], app.pointer.x, app.pointer.y, 'Tab');
}
