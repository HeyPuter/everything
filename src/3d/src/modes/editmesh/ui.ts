// Edit Mode menus, header select-mode buttons, keymap and tool behaviour.
import { h } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { modeMenus } from '../../editors/view3d/modemenus';
import { editModeHooks } from '../../editors/view3d/hooks';
import { activeTools } from '../../app/prefs';
import type { MenuItem } from '../../ui/menu';
import { meshAddMenu, snapMenu } from '../../editors/view3d/menus';
import { editTransformExtras } from '../../editors/view3d/transformui';
import { selectMode, inMeshEdit } from './context';

const isMeshEdit = () => inMeshEdit();

export function deleteMenu(): MenuItem[] {
  return [
    { label: 'Vertices', op: 'mesh.delete', props: { type: 'VERT' } },
    { label: 'Edges', op: 'mesh.delete', props: { type: 'EDGE' } },
    { label: 'Faces', op: 'mesh.delete', props: { type: 'FACE' } },
    { label: 'Only Edges & Faces', op: 'mesh.delete', props: { type: 'EDGE_FACE' } },
    { label: 'Only Faces', op: 'mesh.delete', props: { type: 'ONLY_FACE' } },
    { separator: true },
    { label: 'Dissolve Vertices', op: 'mesh.dissolve_verts' },
    { label: 'Dissolve Edges', op: 'mesh.dissolve_edges' },
    { label: 'Dissolve Faces', op: 'mesh.dissolve_faces' },
    { separator: true },
    { label: 'Delete Loose', op: 'mesh.delete_loose' },
  ];
}

export function mergeMenu(): MenuItem[] {
  return [
    { label: 'At Center', op: 'mesh.merge', props: { type: 'CENTER' } },
    { label: 'At Cursor', op: 'mesh.merge', props: { type: 'CURSOR' } },
    { label: 'Collapse', op: 'mesh.merge', props: { type: 'COLLAPSE' } },
    { label: 'At First', op: 'mesh.merge', props: { type: 'FIRST' } },
    { label: 'At Last', op: 'mesh.merge', props: { type: 'LAST' } },
    { separator: true },
    { label: 'By Distance', op: 'mesh.remove_doubles' },
  ];
}

export function vertexMenu(): MenuItem[] {
  return [
    { label: 'Extrude Vertices', op: 'mesh.extrude_vertices_move' },
    { label: 'Bevel Vertices', op: 'mesh.bevel', props: { affect: 'VERTICES' }, shortcut: 'Shift Ctrl B' },
    { separator: true },
    { label: 'New Edge/Face from Vertices', op: 'mesh.edge_face_add', shortcut: 'F' },
    { label: 'Connect Vertex Path', op: 'mesh.vert_connect_path', shortcut: 'J' },
    { separator: true },
    { label: 'Slide Vertices', op: 'transform.vert_slide', shortcut: 'Shift V' },
    { label: 'Smooth Vertices', op: 'mesh.vertices_smooth' },
    { separator: true },
    { label: 'Merge Vertices', submenu: mergeMenu },
    { label: 'Split', op: 'mesh.split', shortcut: 'Y' },
    { label: 'Rip Vertices', op: 'mesh.rip_move', shortcut: 'V' },
    { label: 'Separate', submenu: separateMenu, shortcut: 'P' },
    { separator: true },
    { label: 'Add Hook to New Object', op: 'object.hook_add_newob' },
  ];
}

function separateMenu(): MenuItem[] {
  return [
    { label: 'Selection', op: 'mesh.separate', props: { type: 'SELECTED' } },
    { label: 'By Material', op: 'mesh.separate', props: { type: 'MATERIAL' } },
    { label: 'By Loose Parts', op: 'mesh.separate', props: { type: 'LOOSE' } },
  ];
}

export function edgeMenu(): MenuItem[] {
  return [
    { label: 'Extrude Edges', op: 'mesh.extrude_edges_move' },
    { label: 'Bevel Edges', op: 'mesh.bevel', props: { affect: 'EDGES' }, shortcut: 'Ctrl B' },
    { label: 'Bridge Edge Loops', op: 'mesh.bridge_edge_loops' },
    { separator: true },
    { label: 'Subdivide', op: 'mesh.subdivide' },
    { label: 'Loop Cut and Slide', op: 'mesh.loopcut_slide', shortcut: 'Ctrl R' },
    { separator: true },
    { label: 'Rotate Edge CW', op: 'mesh.edge_rotate', props: { use_ccw: false } },
    { label: 'Rotate Edge CCW', op: 'mesh.edge_rotate', props: { use_ccw: true } },
    { separator: true },
    { label: 'Edge Slide', op: 'transform.edge_slide' },
    { separator: true },
    { label: 'Edge Crease', op: 'transform.edge_crease', shortcut: 'Shift E' },
    { separator: true },
    { label: 'Mark Seam', op: 'mesh.mark_seam', props: { clear: false } },
    { label: 'Clear Seam', op: 'mesh.mark_seam', props: { clear: true } },
    { separator: true },
    { label: 'Mark Sharp', op: 'mesh.mark_sharp', props: { clear: false } },
    { label: 'Clear Sharp', op: 'mesh.mark_sharp', props: { clear: true } },
  ];
}

export function faceMenu(): MenuItem[] {
  return [
    { label: 'Extrude Faces', op: 'mesh.extrude_region_move', shortcut: 'E' },
    { label: 'Extrude Individual Faces', op: 'mesh.extrude_faces_move' },
    { separator: true },
    { label: 'Inset Faces', op: 'mesh.inset', shortcut: 'I' },
    { label: 'Poke Faces', op: 'mesh.poke' },
    { separator: true },
    { label: 'Triangulate Faces', op: 'mesh.quads_convert_to_tris', shortcut: 'Ctrl T' },
    { label: 'Tris to Quads', op: 'mesh.tris_convert_to_quads', shortcut: 'Alt J' },
    { separator: true },
    { label: 'Fill', op: 'mesh.fill', shortcut: 'Alt F' },
    { separator: true },
    { label: 'Shade Smooth', op: 'mesh.faces_shade_smooth' },
    { label: 'Shade Flat', op: 'mesh.faces_shade_flat' },
  ];
}

export function uvMenu(): MenuItem[] {
  return [
    { label: 'Unwrap', op: 'uv.unwrap' },
    { label: 'Smart UV Project', op: 'uv.smart_project' },
    { label: 'Lightmap Pack', op: 'uv.lightmap_pack' },
    { label: 'Follow Active Quads', op: 'uv.follow_active_quads' },
    { separator: true },
    { label: 'Cube Projection', op: 'uv.cube_project' },
    { label: 'Cylinder Projection', op: 'uv.cylinder_project' },
    { label: 'Sphere Projection', op: 'uv.sphere_project' },
    { separator: true },
    { label: 'Project from View', op: 'uv.project_from_view' },
    { label: 'Project from View (Bounds)', op: 'uv.project_from_view', props: { scale_to_bounds: true } },
    { separator: true },
    { label: 'Mark Seam', op: 'mesh.mark_seam', props: { clear: false } },
    { label: 'Clear Seam', op: 'mesh.mark_seam', props: { clear: true } },
    { separator: true },
    { label: 'Reset', op: 'uv.reset' },
  ];
}

function normalsMenu(): MenuItem[] {
  return [
    { label: 'Flip', op: 'mesh.flip_normals' },
    { label: 'Recalculate Outside', op: 'mesh.normals_make_consistent', props: { inside: false }, shortcut: 'Shift N' },
    { label: 'Recalculate Inside', op: 'mesh.normals_make_consistent', props: { inside: true } },
  ];
}

function meshMenu(): MenuItem[] {
  return [
    { label: 'Transform', submenu: () => [
      { label: 'Move', op: 'transform.translate', shortcut: 'G' },
      { label: 'Rotate', op: 'transform.rotate', shortcut: 'R' },
      { label: 'Scale', op: 'transform.resize', shortcut: 'S' },
      { separator: true },
      { label: 'To Sphere', op: 'transform.tosphere', shortcut: 'Shift Alt S' },
      { label: 'Shrink/Fatten', op: 'transform.shrink_fatten', shortcut: 'Alt S' },
      { label: 'Push/Pull', op: 'transform.push_pull' },
      ...editTransformExtras(),
    ] },
    { label: 'Mirror', submenu: () => [{ label: 'Symmetrize', op: 'mesh.symmetrize' }] },
    { label: 'Snap', submenu: snapMenu },
    { separator: true },
    { label: 'Duplicate', op: 'mesh.duplicate_move', shortcut: 'Shift D' },
    { label: 'Extrude', submenu: () => [
      { label: 'Extrude Faces', op: 'mesh.extrude_region_move' },
      { label: 'Extrude Individual Faces', op: 'mesh.extrude_faces_move' },
      { label: 'Extrude Edges', op: 'mesh.extrude_edges_move' },
      { label: 'Extrude Vertices', op: 'mesh.extrude_vertices_move' },
      { label: 'Spin', op: 'mesh.spin' },
    ] },
    { separator: true },
    { label: 'Merge', submenu: mergeMenu, shortcut: 'M' },
    { label: 'Split', op: 'mesh.split', shortcut: 'Y' },
    { label: 'Rip Vertices', op: 'mesh.rip_move', shortcut: 'V' },
    { label: 'Separate', submenu: separateMenu, shortcut: 'P' },
    { separator: true },
    { label: 'Bisect', op: 'mesh.bisect' },
    { separator: true },
    { label: 'Normals', submenu: normalsMenu, shortcut: 'Alt N' },
    { label: 'Shading', submenu: () => [{ label: 'Smooth Faces', op: 'mesh.faces_shade_smooth' }, { label: 'Flat Faces', op: 'mesh.faces_shade_flat' }] },
    { label: 'Show/Hide', submenu: () => [
      { label: 'Reveal Hidden', op: 'mesh.reveal', shortcut: 'Alt H' },
      { label: 'Hide Selected', op: 'mesh.hide', shortcut: 'H' },
      { label: 'Hide Unselected', op: 'mesh.hide', props: { unselected: true }, shortcut: 'Shift H' },
    ] },
    { label: 'Clean Up', submenu: () => [
      { label: 'Delete Loose', op: 'mesh.delete_loose' },
      { label: 'Merge by Distance', op: 'mesh.remove_doubles' },
    ] },
    { separator: true },
    { label: 'Delete', submenu: deleteMenu, shortcut: 'X' },
  ];
}

function selectMenuEdit(): MenuItem[] {
  return [
    { label: 'All', op: 'mesh.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'mesh.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'mesh.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'view3d.select_box_tool', shortcut: 'B' },
    { label: 'Circle Select', op: 'view3d.select_circle_tool', shortcut: 'C' },
    { separator: true },
    { label: 'Select Random', op: 'mesh.select_random' },
    { label: 'Checker Deselect', op: 'mesh.select_nth' },
    { separator: true },
    { label: 'Select More/Less', submenu: () => [{ label: 'More', op: 'mesh.select_more', shortcut: 'Ctrl Numpad +' }, { label: 'Less', op: 'mesh.select_less', shortcut: 'Ctrl Numpad -' }] },
    { separator: true },
    { label: 'Select All by Trait', submenu: () => [
      { label: 'Non Manifold', op: 'mesh.select_non_manifold' },
      { label: 'Loose Geometry', op: 'mesh.select_loose' },
      { label: 'Faces by Sides', op: 'mesh.select_face_by_sides' },
    ] },
    { label: 'Select Similar', submenu: () => (['NORMAL', 'AREA', 'SIDES', 'MATERIAL', 'SMOOTH', 'COPLANAR'] as const).map((t) => ({ label: { NORMAL: 'Normal', AREA: 'Area', SIDES: 'Polygon Sides', MATERIAL: 'Material', SMOOTH: 'Flat/Smooth', COPLANAR: 'Coplanar' }[t], op: 'mesh.select_similar', props: { type: t } })), shortcut: 'Shift G' },
    { separator: true },
    { label: 'Select Loops', submenu: () => [{ label: 'Edge Loops', op: 'mesh.loop_multi_select', props: { ring: false } }, { label: 'Edge Rings', op: 'mesh.loop_multi_select', props: { ring: true } }] },
    { separator: true },
    { label: 'Select Linked', submenu: () => [{ label: 'Linked', op: 'mesh.select_linked', shortcut: 'Ctrl L' }] },
    { label: 'Select Mirror', op: 'mesh.select_mirror', shortcut: 'Shift Ctrl M' },
  ];
}

function addMenuEdit(): MenuItem[] {
  return meshAddMenu();
}

function contextMenu(): MenuItem[] {
  const m = selectMode();
  if (m === 'VERT')
    return [
      { heading: 'Vertex Context Menu' },
      { label: 'Subdivide', op: 'mesh.subdivide' },
      { label: 'Extrude Vertices', op: 'mesh.extrude_vertices_move' },
      { label: 'Bevel Vertices', op: 'mesh.bevel', props: { affect: 'VERTICES' } },
      { separator: true },
      { label: 'New Edge/Face from Vertices', op: 'mesh.edge_face_add' },
      { separator: true },
      { label: 'Smooth Vertices', op: 'mesh.vertices_smooth' },
      { label: 'Mirror', op: 'mesh.symmetrize' },
      { separator: true },
      { label: 'Merge Vertices', submenu: mergeMenu },
      { label: 'Split', op: 'mesh.split' },
      { label: 'Separate', submenu: separateMenu },
      { separator: true },
      { label: 'Dissolve Vertices', op: 'mesh.dissolve_verts' },
      { label: 'Delete Vertices', op: 'mesh.delete', props: { type: 'VERT' } },
    ];
  if (m === 'EDGE')
    return [
      { heading: 'Edge Context Menu' },
      { label: 'Subdivide', op: 'mesh.subdivide' },
      { label: 'Extrude Edges', op: 'mesh.extrude_edges_move' },
      { label: 'Bevel Edges', op: 'mesh.bevel', props: { affect: 'EDGES' } },
      { label: 'Bridge Edge Loops', op: 'mesh.bridge_edge_loops' },
      { separator: true },
      { label: 'New Face from Edges', op: 'mesh.edge_face_add' },
      { separator: true },
      { label: 'Loop Cut and Slide', op: 'mesh.loopcut_slide' },
      { label: 'Edge Slide', op: 'transform.edge_slide' },
      { separator: true },
      { label: 'Mark Seam', op: 'mesh.mark_seam', props: { clear: false } },
      { label: 'Clear Seam', op: 'mesh.mark_seam', props: { clear: true } },
      { label: 'Mark Sharp', op: 'mesh.mark_sharp', props: { clear: false } },
      { label: 'Clear Sharp', op: 'mesh.mark_sharp', props: { clear: true } },
      { separator: true },
      { label: 'Dissolve Edges', op: 'mesh.dissolve_edges' },
      { label: 'Delete Edges', op: 'mesh.delete', props: { type: 'EDGE' } },
    ];
  return [
    { heading: 'Face Context Menu' },
    { label: 'Subdivide', op: 'mesh.subdivide' },
    { separator: true },
    { label: 'Extrude Faces', op: 'mesh.extrude_region_move' },
    { label: 'Extrude Individual Faces', op: 'mesh.extrude_faces_move' },
    { separator: true },
    { label: 'Inset Faces', op: 'mesh.inset' },
    { label: 'Poke Faces', op: 'mesh.poke' },
    { separator: true },
    { label: 'Triangulate Faces', op: 'mesh.quads_convert_to_tris' },
    { label: 'Tris to Quads', op: 'mesh.tris_convert_to_quads' },
    { separator: true },
    { label: 'Shade Smooth', op: 'mesh.faces_shade_smooth' },
    { label: 'Shade Flat', op: 'mesh.faces_shade_flat' },
    { separator: true },
    { label: 'UV Unwrap Faces', submenu: uvMenu },
    { separator: true },
    { label: 'Dissolve Faces', op: 'mesh.dissolve_faces' },
    { label: 'Delete Faces', op: 'mesh.delete', props: { type: 'FACE' } },
  ];
}

function selectModeButtons() {
  if (!inMeshEdit()) return null;
  const sm = app.doc.scene.tool_settings.mesh_select_mode;
  const btn = (i: number, ic: string, tip: string, type: string) =>
    h(
      'button',
      {
        key: type,
        class: { 'hdr-toggle': true, on: sm[i] },
        'data-tip': `${tip}\nShift-click to extend, ${i + 1} to switch`,
        onclick: (e: MouseEvent) => app.run('mesh.select_mode', { type, use_extend: e.shiftKey }),
      },
      icon(ic),
    );
  return h('div', { class: 'hdr-group select-modes' }, btn(0, 'snap_vertex', 'Vertex', 'VERT'), btn(1, 'snap_edge', 'Edge', 'EDGE'), btn(2, 'snap_face', 'Face', 'FACE'));
}

modeMenus.EDIT = {
  header: () =>
    isMeshEdit()
      ? [
          ['Mesh', meshMenu],
          ['Vertex', vertexMenu],
          ['Edge', edgeMenu],
          ['Face', faceMenu],
          ['UV', uvMenu],
        ]
      : [],
  select: () => (isMeshEdit() ? selectMenuEdit() : []),
  add: addMenuEdit,
  context: contextMenu,
  headerExtra: selectModeButtons,
};

// ---------------------------------------------------------------------------
// keymap (Mesh)

const m = isMeshEdit;
addKeys('Mesh', [
  { key: 'ONE', op: 'mesh.select_mode', props: { type: 'VERT' }, when: m },
  { key: 'TWO', op: 'mesh.select_mode', props: { type: 'EDGE' }, when: m },
  { key: 'THREE', op: 'mesh.select_mode', props: { type: 'FACE' }, when: m },
  { key: 'ONE', shift: true, op: 'mesh.select_mode', props: { type: 'VERT', use_extend: true }, when: m },
  { key: 'TWO', shift: true, op: 'mesh.select_mode', props: { type: 'EDGE', use_extend: true }, when: m },
  { key: 'THREE', shift: true, op: 'mesh.select_mode', props: { type: 'FACE', use_extend: true }, when: m },
  { key: 'A', op: 'mesh.select_all', props: { action: 'SELECT' }, when: m },
  { key: 'A', alt: true, op: 'mesh.select_all', props: { action: 'DESELECT' }, when: m },
  { key: 'I', ctrl: true, op: 'mesh.select_all', props: { action: 'INVERT' }, when: m },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'mesh.select_more', when: m },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'mesh.select_less', when: m },
  { key: 'L', ctrl: true, op: 'mesh.select_linked', when: m },
  { key: 'L', op: 'mesh.select_linked_pick', when: m },
  { key: 'L', shift: true, op: 'mesh.select_linked_pick', props: { deselect: true }, when: m },
  { key: 'G', shift: true, menu: () => (['NORMAL', 'AREA', 'SIDES', 'MATERIAL', 'SMOOTH', 'COPLANAR'] as const).map((t) => ({ label: { NORMAL: 'Normal', AREA: 'Area', SIDES: 'Polygon Sides', MATERIAL: 'Material', SMOOTH: 'Flat/Smooth', COPLANAR: 'Coplanar' }[t], op: 'mesh.select_similar', props: { type: t } })), menuTitle: 'Select Similar', when: m },
  { key: 'M', shift: true, ctrl: true, op: 'mesh.select_mirror', when: m },
  { key: 'H', op: 'mesh.hide', when: m },
  { key: 'H', shift: true, op: 'mesh.hide', props: { unselected: true }, when: m },
  { key: 'H', alt: true, op: 'mesh.reveal', when: m },
  { key: 'X', menu: deleteMenu, menuTitle: 'Delete', when: m },
  { key: 'DEL', menu: deleteMenu, menuTitle: 'Delete', when: m },
  { key: 'X', ctrl: true, op: 'mesh.dissolve_mode', when: m },
  { key: 'E', op: 'mesh.extrude_region_move', when: m },
  { key: 'E', alt: true, menu: () => [{ label: 'Extrude Faces', op: 'mesh.extrude_region_move' }, { label: 'Extrude Individual Faces', op: 'mesh.extrude_faces_move' }, { label: 'Extrude Edges', op: 'mesh.extrude_edges_move' }, { label: 'Extrude Vertices', op: 'mesh.extrude_vertices_move' }], menuTitle: 'Extrude', when: m },
  { key: 'I', op: 'mesh.inset', when: m },
  { key: 'B', ctrl: true, op: 'mesh.bevel', props: { affect: 'EDGES' }, when: m },
  { key: 'B', ctrl: true, shift: true, op: 'mesh.bevel', props: { affect: 'VERTICES' }, when: m },
  { key: 'R', ctrl: true, op: 'mesh.loopcut_slide', when: m },
  { key: 'F', op: 'mesh.edge_face_add', when: m },
  { key: 'F', alt: true, op: 'mesh.fill', when: m },
  { key: 'M', menu: mergeMenu, menuTitle: 'Merge', when: m },
  { key: 'Y', op: 'mesh.split', when: m },
  { key: 'P', menu: separateMenu, menuTitle: 'Separate', when: m },
  { key: 'D', shift: true, op: 'mesh.duplicate_move', when: m },
  { key: 'N', shift: true, op: 'mesh.normals_make_consistent', when: m },
  { key: 'N', alt: true, menu: normalsMenu, menuTitle: 'Normals', when: m },
  { key: 'V', ctrl: true, menu: vertexMenu, menuTitle: 'Vertex', when: m },
  { key: 'E', ctrl: true, menu: edgeMenu, menuTitle: 'Edge', when: m },
  { key: 'F', ctrl: true, menu: faceMenu, menuTitle: 'Face', when: m },
  { key: 'U', menu: uvMenu, menuTitle: 'UV', when: m },
  { key: 'T', ctrl: true, op: 'mesh.quads_convert_to_tris', when: m },
  { key: 'J', alt: true, op: 'mesh.tris_convert_to_quads', when: m },
  { key: 'S', alt: true, op: 'transform.shrink_fatten', when: m },
  { key: 'S', alt: true, shift: true, op: 'transform.tosphere', when: m },
  { key: 'V', shift: true, op: 'transform.vert_slide', when: m },
  { key: 'E', shift: true, op: 'transform.edge_crease', when: m },
  { key: 'R', alt: true, op: 'mesh.spin', when: m },
  { key: 'A', shift: true, menu: meshAddMenu, menuTitle: 'Add', when: m },
]);

// Tool behaviour: LMB drag with modelling tools runs the tool
editModeHooks.pointer.push((v, e) => {
  if (!isMeshEdit()) return false;
  const tool = activeTools.EDIT;
  const map: Record<string, string> = {
    'builtin.extrude_region': 'mesh.extrude_region_move',
    'builtin.inset_faces': 'mesh.inset',
    'builtin.bevel': 'mesh.bevel',
    'builtin.loop_cut': 'mesh.loopcut_slide',
    'builtin.spin': 'mesh.spin',
    'builtin.smooth': 'mesh.vertices_smooth',
    'builtin.edge_slide': 'transform.edge_slide',
    'builtin.shrink_fatten': 'transform.shrink_fatten',
  };
  const op = map[tool];
  if (!op) return false;
  if (tool === 'builtin.loop_cut') {
    app.run(op, {}, { event: { x: e.clientX, y: e.clientY } });
    return true;
  }
  // click without drag selects; drag runs the tool
  const sx = e.clientX,
    sy = e.clientY;
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    cleanup();
    app.run(op, {}, { event: { x: ev.clientX, y: ev.clientY } });
  };
  const up = () => {
    cleanup();
    const r = v.el.getBoundingClientRect();
    for (const hk of editModeHooks.pick) if (hk(v, sx - r.left, sy - r.top, { extend: e.shiftKey, toggle: e.shiftKey, deselectAll: !e.shiftKey })) break;
  };
  const cleanup = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  return true;
});
