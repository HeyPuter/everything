// Built-in keymap presets. "Default" is the factory keymap; "Industry Standard" is our own
// layout following conventions shared by many 3D and compositing tools: Q/W/E/R pick the
// select / move / rotate / scale tools, F frames the selection, A frames everything,
// Ctrl A selects all, Ctrl D duplicates, Backspace deletes and Tab searches for commands.
import type { PresetAdd, PresetDef, PresetRule } from './keyconfig_core';

const MODES_3D: [string, string][] = [
  ['Object Mode', 'object.select_all'],
  ['Mesh', 'mesh.select_all'],
  ['Curve', 'curve.select_all'],
  ['Armature', 'armature.select_all'],
  ['Pose', 'pose.select_all'],
  ['Lattice', 'lattice.select_all'],
  ['Metaball', 'mball.select_all'],
];

const EDITORS_2D: [string, string][] = [
  ['Graph Editor', 'graph.select_all'],
  ['Dopesheet', 'action.select_all'],
  ['NLA Editor', 'nla.select_all'],
  ['Node Editor', 'node.select_all'],
  ['UV Editor', 'uv.select_all'],
  ['Sequencer', 'sequencer.select_all'],
  ['Clip Editor', 'clip.select_all'],
];

function industry(): PresetDef {
  const rules: PresetRule[] = [];
  const add: PresetAdd[] = [];

  // --- select all moves to Ctrl A, deselect to Ctrl Shift A; A frames everything, F the selection
  for (const [km, op] of [...MODES_3D, ...EDITORS_2D]) {
    rules.push({ km, match: { op, props: { action: 'SELECT' }, key: 'A', ctrl: false, shift: false, alt: false }, set: { ctrl: true } });
    rules.push({ km, match: { op, props: { action: 'DESELECT' }, key: 'A', alt: true }, set: { ctrl: true, shift: true, alt: false } });
  }
  for (const [km, op] of MODES_3D) {
    add.push({ km, like: { op, props: { action: 'SELECT' } }, set: { key: 'A', ctrl: false, shift: false, alt: false, op: 'view3d.view_all', props: {} } });
    add.push({ km, like: { op, props: { action: 'SELECT' } }, set: { key: 'F', ctrl: false, shift: false, alt: false, op: 'view3d.view_selected', props: {} } });
  }
  // 2D editors: A copies Home (view all), F copies Numpad . (view selected) where F is free
  for (const km of ['Graph Editor', 'Dopesheet', 'NLA Editor', 'Sequencer', 'Image', 'Node Editor', 'Clip Editor']) {
    add.push({ km, like: { key: 'HOME', ctrl: false, shift: false, alt: false }, set: { key: 'A', ctrl: false, shift: false, alt: false } });
    if (km !== 'Node Editor' && km !== 'Clip Editor') add.push({ km, like: { key: 'NUMPAD_PERIOD', ctrl: false, shift: false, alt: false }, set: { key: 'F', ctrl: false, shift: false, alt: false } });
  }
  rules.push({ km: 'Node Editor', match: { op: 'node.select_all', props: { action: 'DESELECT' }, key: 'A', alt: false }, set: { ctrl: true, shift: true } });
  rules.push({ km: 'NLA Editor', match: { op: 'nla.apply_scale', key: 'A', ctrl: true }, set: { alt: true } });
  // the Apply menus give up Ctrl A
  rules.push({ km: 'Object Mode', match: { menu: 'Apply', key: 'A', ctrl: true }, set: { alt: true } });
  rules.push({ km: 'Pose', match: { menu: 'Apply', key: 'A', ctrl: true }, set: { alt: true } });
  // F was "fill / make segment": now Shift F
  rules.push({ km: 'Mesh', match: { op: 'mesh.edge_face_add', key: 'F', shift: false }, set: { shift: true } });
  rules.push({ km: 'Curve', match: { op: 'curve.make_segment', key: 'F', shift: false }, set: { shift: true } });
  rules.push({ km: 'Armature', match: { op: 'armature.fill', key: 'F', shift: false }, set: { shift: true } });

  // --- tools on Q W E R (the modal rotate on R gives way; G and S stay modal)
  rules.push({ km: '3D View', match: { op: 'wm.tool_cycle_select', key: 'W' }, set: { active: false } });
  rules.push({ km: '3D View', match: { op: 'transform.rotate', key: 'R', ctrl: false, shift: false, alt: false }, set: { active: false } });
  for (const [key, name] of [
    ['Q', 'builtin.select_box'],
    ['W', 'builtin.move'],
    ['E', 'builtin.rotate'],
    ['R', 'builtin.scale'],
  ])
    add.push({ km: '3D View', set: { key, op: 'wm.tool_set_by_id', props: { name } } });
  // extrude leaves E for the rotate tool
  rules.push({ km: 'Mesh', match: { op: 'view3d.edit_mesh_extrude_move_normal', key: 'E', ctrl: false }, set: { ctrl: true } });
  rules.push({ km: 'Mesh', match: { menu: 'Edge', key: 'E', ctrl: true }, set: { shift: true } });
  rules.push({ km: 'Curve', match: { op: 'curve.extrude_move', key: 'E', ctrl: false }, set: { ctrl: true } });
  rules.push({ km: 'Armature', match: { op: 'armature.extrude_move', key: 'E', ctrl: false }, set: { ctrl: true } });

  // --- duplicate on Ctrl D
  for (const [km, op] of [
    ['Object Mode', 'object.duplicate_move'],
    ['Mesh', 'mesh.duplicate_move'],
    ['Curve', 'curve.duplicate_move'],
    ['Armature', 'armature.duplicate_move'],
    ['Graph Editor', 'graph.duplicate_move'],
    ['Dopesheet', 'action.duplicate_move'],
    ['Node Editor', 'node.duplicate_move'],
    ['Sequencer', 'sequencer.duplicate_move'],
  ])
    rules.push({ km, match: { op, key: 'D', shift: true, ctrl: false }, set: { shift: false, ctrl: true } });

  // --- Backspace deletes like Delete
  add.push({ km: 'Object Mode', like: { op: 'object.delete', key: 'DEL', shift: false }, set: { key: 'BACK_SPACE' } });
  for (const km of ['Mesh', 'Curve', 'Armature']) add.push({ km, like: { menu: 'Delete', key: 'DEL' }, set: { key: 'BACK_SPACE' } });

  // --- Tab searches commands; Ctrl Tab toggles Edit Mode
  rules.push({ km: '3D View', match: { op: 'object.editmode_toggle', key: 'TAB', ctrl: false }, set: { ctrl: true } });
  rules.push({ km: '3D View', match: { op: 'object.posemode_toggle', key: 'TAB', ctrl: true }, set: { active: false } });
  rules.push({ km: 'Pose', match: { op: 'object.posemode_toggle', key: 'TAB', ctrl: true }, set: { active: false } });
  rules.push({ km: '3D View', match: { op: 'view3d.pie_mode', key: 'TAB', ctrl: true }, set: { active: false } });
  add.push({ km: 'Window', set: { key: 'TAB', op: 'wm.search_menu' } });

  return {
    id: 'INDUSTRY',
    label: 'Industry Standard',
    description: 'Q W E R tools, F / A framing, Ctrl A select all, Ctrl D duplicate, Tab command search. Alt + mouse navigation: turn on Input ▸ Emulate 3 Button Mouse',
    rules,
    add,
  };
}

export const KEY_PRESETS: PresetDef[] = [
  { id: 'DEFAULT', label: 'Default', description: 'The factory keymap', rules: [], add: [] },
  industry(),
];
