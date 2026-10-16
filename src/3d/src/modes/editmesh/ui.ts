// Edit Mode menus, header select-mode buttons, keymap and tool behaviour.
import { h } from '../../ui/h';
import { unwrapMenu } from '../../editors/uv/uvmenus';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { modeMenus } from '../../editors/view3d/modemenus';
import { editModeHooks } from '../../editors/view3d/hooks';
import { hooksMenu } from '../../object/hooks';
import { activeTools } from '../../app/prefs';
import type { MenuItem } from '../../ui/menu';
import { meshAddMenu, snapMenu } from '../../editors/view3d/menus';
import { editTransformExtras, mirrorMenu } from '../../editors/view3d/transformui';
import { selectMode, inMeshEdit } from './context';
import { similarMenu } from './select-extra';
import { toolHeaderRightHooks } from '../../editors/view3d/tooloptions';

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
    { label: 'Limited Dissolve', op: 'mesh.dissolve_limited' },
    { separator: true },
    { label: 'Collapse Edges & Faces', op: 'mesh.edge_collapse' },
    { label: 'Edge Loops', op: 'mesh.delete_edgeloop' },
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

export function splitMenu(): MenuItem[] {
  return [
    { label: 'Selection', op: 'mesh.split', shortcut: 'Y' },
    { separator: true },
    { label: 'Faces by Edges', op: 'mesh.edge_split', props: { type: 'EDGE' } },
    { label: 'Faces & Edges by Vertices', op: 'mesh.edge_split', props: { type: 'VERT' } },
  ];
}

export function separateMenu(): MenuItem[] {
  return [
    { label: 'Selection', op: 'mesh.separate', props: { type: 'SELECTED' } },
    { label: 'By Material', op: 'mesh.separate', props: { type: 'MATERIAL' } },
    { label: 'By Loose Parts', op: 'mesh.separate', props: { type: 'LOOSE' } },
  ];
}

/** Extrude menu: the entries depend on the select mode. */
export function extrudeMenu(): MenuItem[] {
  const [v, e] = app.doc.scene.tool_settings.mesh_select_mode;
  return [
    { label: 'Extrude Faces', op: 'view3d.edit_mesh_extrude_move_normal', shortcut: 'E' },
    { label: 'Extrude Faces Along Normals', op: 'view3d.edit_mesh_extrude_move_shrink_fatten' },
    { label: 'Extrude Individual Faces', op: 'mesh.extrude_faces_move' },
    { label: 'Extrude Manifold', op: 'mesh.extrude_manifold' },
    ...(v || e ? [{ label: 'Extrude Edges', op: 'mesh.extrude_edges_move' }] : []),
    ...(v ? [{ label: 'Extrude Vertices', op: 'mesh.extrude_vertices_move' }] : []),
    { separator: true },
    { label: 'Extrude Repeat', op: 'mesh.extrude_repeat' },
    { label: 'Spin', op: 'mesh.spin', shortcut: 'Alt R' },
  ];
}

function vertexGroupMenu(): MenuItem[] {
  return [
    { label: 'Assign to New Group', action: () => app.run('object.vertex_group_add') === 'FINISHED' && app.run('object.vertex_group_assign') },
    { separator: true },
    { label: 'Assign to Active Group', op: 'object.vertex_group_assign' },
    { label: 'Remove from Active Group', op: 'object.vertex_group_remove_from', shortcut: 'Ctrl Alt G' },
    { separator: true },
    { label: 'Select Active Group', op: 'object.vertex_group_select' },
    { label: 'Deselect Active Group', op: 'object.vertex_group_deselect' },
  ];
}

function weightsMenu(): MenuItem[] {
  return [
    { label: 'Normalize All', op: 'object.vertex_group_normalize_all' },
    { label: 'Normalize', op: 'object.vertex_group_normalize' },
    { separator: true },
    { label: 'Invert', op: 'object.vertex_group_invert' },
    { label: 'Clean', op: 'object.vertex_group_clean' },
    { separator: true },
    { label: 'Smooth', op: 'object.vertex_group_smooth' },
    { label: 'Limit Total', op: 'object.vertex_group_limit_total' },
  ];
}

export function vertexMenu(): MenuItem[] {
  return [
    { label: 'Extrude Vertices', op: 'mesh.extrude_vertices_move' },
    { label: 'Extrude to Cursor or Add', op: 'mesh.dupli_extrude_cursor', shortcut: 'Ctrl Click' },
    { label: 'Bevel Vertices', op: 'mesh.bevel', props: { affect: 'VERTICES' }, shortcut: 'Shift Ctrl B' },
    { separator: true },
    { label: 'New Edge/Face from Vertices', op: 'mesh.edge_face_add', shortcut: 'F' },
    { label: 'Connect Vertex Path', op: 'mesh.vert_connect_path', shortcut: 'J' },
    { label: 'Connect Vertex Pairs', op: 'mesh.vert_connect' },
    { separator: true },
    { label: 'Rip Vertices', op: 'mesh.rip_move', shortcut: 'V' },
    { label: 'Rip Vertices and Fill', op: 'mesh.rip_move', props: { use_fill: true }, shortcut: 'Alt V' },
    { label: 'Rip Vertices and Extend', op: 'mesh.rip_edge_move', shortcut: 'Alt D' },
    { separator: true },
    { label: 'Slide Vertices', op: 'transform.vert_slide', shortcut: 'Shift V' },
    { label: 'Smooth Vertices', op: 'mesh.vertices_smooth' },
    { label: 'Smooth Laplacian', op: 'mesh.vertices_smooth_laplacian' },
    { separator: true },
    { label: 'Blend from Shape', op: 'mesh.blend_from_shape' },
    { label: 'Propagate to Shapes', op: 'mesh.shape_propagate_to_all' },
    { separator: true },
    { label: 'Vertex Groups', submenu: vertexGroupMenu, shortcut: 'Ctrl G' },
    { label: 'Hooks', submenu: hooksMenu, shortcut: 'Ctrl H' },
  ];
}

export function edgeMenu(): MenuItem[] {
  return [
    { label: 'Extrude Edges', op: 'mesh.extrude_edges_move' },
    { label: 'Bevel Edges', op: 'mesh.bevel', props: { affect: 'EDGES' }, shortcut: 'Ctrl B' },
    { label: 'Bridge Edge Loops', op: 'mesh.bridge_edge_loops' },
    { label: 'Screw', op: 'mesh.screw' },
    { separator: true },
    { label: 'Subdivide', op: 'mesh.subdivide' },
    { label: 'Subdivide Edge-Ring', op: 'mesh.subdivide_edgering' },
    { label: 'Un-Subdivide', op: 'mesh.unsubdivide' },
    { separator: true },
    { label: 'Rotate Edge CW', op: 'mesh.edge_rotate', props: { use_ccw: false } },
    { label: 'Rotate Edge CCW', op: 'mesh.edge_rotate', props: { use_ccw: true } },
    { separator: true },
    { label: 'Edge Slide', op: 'transform.edge_slide' },
    { label: 'Offset Edge Slide', op: 'mesh.offset_edge_loops_slide', shortcut: 'Shift Ctrl R' },
    { label: 'Loop Cut and Slide', op: 'mesh.loopcut_slide', shortcut: 'Ctrl R' },
    { separator: true },
    { label: 'Edge Crease', op: 'transform.edge_crease', shortcut: 'Shift E' },
    { separator: true },
    { label: 'Mark Seam', op: 'mesh.mark_seam', props: { clear: false } },
    { label: 'Clear Seam', op: 'mesh.mark_seam', props: { clear: true } },
    { separator: true },
    { label: 'Mark Sharp', op: 'mesh.mark_sharp', props: { clear: false } },
    { label: 'Clear Sharp', op: 'mesh.mark_sharp', props: { clear: true } },
    { separator: true },
    { label: 'Mark Sharp from Vertices', op: 'mesh.mark_sharp', props: { use_verts: true } },
    { label: 'Set Sharpness by Angle', op: 'mesh.set_sharpness_by_angle' },
    { separator: true },
    { label: 'Mark Freestyle Edge', op: 'mesh.mark_freestyle_edge', props: { clear: false } },
    { label: 'Clear Freestyle Edge', op: 'mesh.mark_freestyle_edge', props: { clear: true } },
  ];
}

function faceDataMenu(): MenuItem[] {
  return [
    { label: 'Rotate Colors', op: 'mesh.colors_rotate' },
    { label: 'Reverse Colors', op: 'mesh.colors_reverse' },
    { separator: true },
    { label: 'Rotate UVs', op: 'mesh.uvs_rotate' },
    { label: 'Reverse UVs', op: 'mesh.uvs_reverse' },
    { separator: true },
    { label: 'Flip Quad Tessellation', op: 'mesh.flip_quad_tessellation' },
    { separator: true },
    { label: 'Mark Freestyle Face', op: 'mesh.mark_freestyle_face', props: { clear: false } },
    { label: 'Clear Freestyle Face', op: 'mesh.mark_freestyle_face', props: { clear: true } },
  ];
}

export function faceMenu(): MenuItem[] {
  return [
    { label: 'Extrude Faces', op: 'view3d.edit_mesh_extrude_move_normal', shortcut: 'E' },
    { label: 'Extrude Faces Along Normals', op: 'view3d.edit_mesh_extrude_move_shrink_fatten' },
    { label: 'Extrude Individual Faces', op: 'mesh.extrude_faces_move' },
    { separator: true },
    { label: 'Inset Faces', op: 'mesh.inset', shortcut: 'I' },
    { label: 'Poke Faces', op: 'mesh.poke' },
    { label: 'Triangulate Faces', op: 'mesh.quads_convert_to_tris', shortcut: 'Ctrl T' },
    { label: 'Tris to Quads', op: 'mesh.tris_convert_to_quads', shortcut: 'Alt J' },
    { label: 'Solidify Faces', op: 'mesh.solidify' },
    { label: 'Wireframe', op: 'mesh.wireframe' },
    { separator: true },
    { label: 'Fill', op: 'mesh.fill', shortcut: 'Alt F' },
    { label: 'Grid Fill', op: 'mesh.fill_grid' },
    { label: 'Beautify Faces', op: 'mesh.beautify_fill' },
    { separator: true },
    { label: 'Intersect (Knife)', op: 'mesh.intersect' },
    { label: 'Intersect (Boolean)', op: 'mesh.intersect_boolean' },
    { separator: true },
    { label: 'Weld Edges into Faces', op: 'mesh.face_split_by_edges' },
    { separator: true },
    { label: 'Shade Smooth', op: 'mesh.faces_shade_smooth' },
    { label: 'Shade Flat', op: 'mesh.faces_shade_flat' },
    { separator: true },
    { label: 'Face Data', submenu: faceDataMenu },
  ];
}

export function uvMenu(): MenuItem[] {
  return [
    ...unwrapMenu(),
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

export function normalsMenu(): MenuItem[] {
  return [
    { label: 'Flip', op: 'mesh.flip_normals' },
    { label: 'Recalculate Outside', op: 'mesh.normals_make_consistent', props: { inside: false }, shortcut: 'Shift N' },
    { label: 'Recalculate Inside', op: 'mesh.normals_make_consistent', props: { inside: true }, shortcut: 'Shift Ctrl N' },
    { separator: true },
    { label: 'Set from Faces', op: 'mesh.set_normals_from_faces' },
    { label: 'Rotate…', op: 'transform.rotate_normal' },
    { label: 'Point to Target…', op: 'mesh.point_normals', shortcut: 'Alt L' },
    { label: 'Merge', op: 'mesh.merge_normals' },
    { label: 'Split', op: 'mesh.split_normals' },
    {
      label: 'Average',
      submenu: () => [
        { label: 'Custom Normal', op: 'mesh.average_normals', props: { average_type: 'CUSTOM_NORMAL' } },
        { label: 'Face Area', op: 'mesh.average_normals', props: { average_type: 'FACE_AREA' } },
        { label: 'Corner Angle', op: 'mesh.average_normals', props: { average_type: 'CORNER_ANGLE' } },
      ],
    },
    { separator: true },
    { label: 'Copy Vector', op: 'mesh.normals_tools', props: { mode: 'COPY' } },
    { label: 'Paste Vector', op: 'mesh.normals_tools', props: { mode: 'PASTE' } },
    { label: 'Smooth Vectors', op: 'mesh.smooth_normals' },
    { label: 'Reset Vectors', op: 'mesh.normals_tools', props: { mode: 'RESET' } },
    { separator: true },
    { label: 'Select by Face Strength', submenu: () => strengthItems(false) },
    { label: 'Set Face Strength', submenu: () => strengthItems(true) },
  ];
}

function strengthItems(set: boolean): MenuItem[] {
  return (['WEAK', 'MEDIUM', 'STRONG'] as const).map((k) => ({ label: k[0] + k.slice(1).toLowerCase(), op: 'mesh.mod_weighted_strength', props: { set, face_strength: k } }));
}

function shadingMenu(): MenuItem[] {
  return [
    { label: 'Smooth Faces', op: 'mesh.faces_shade_smooth' },
    { label: 'Flat Faces', op: 'mesh.faces_shade_flat' },
    { separator: true },
    { label: 'Smooth Edges', op: 'mesh.mark_sharp', props: { clear: true } },
    { label: 'Sharp Edges', op: 'mesh.mark_sharp', props: { clear: false } },
    { separator: true },
    { label: 'Smooth Vertices', op: 'mesh.mark_sharp', props: { clear: true, use_verts: true } },
    { label: 'Sharp Vertices', op: 'mesh.mark_sharp', props: { clear: false, use_verts: true } },
  ];
}

function cleanUpMenu(): MenuItem[] {
  return [
    { label: 'Delete Loose', op: 'mesh.delete_loose' },
    { separator: true },
    { label: 'Decimate Geometry', op: 'mesh.decimate' },
    { label: 'Degenerate Dissolve', op: 'mesh.dissolve_degenerate' },
    { label: 'Limited Dissolve', op: 'mesh.dissolve_limited' },
    { label: 'Make Planar Faces', op: 'mesh.face_make_planar' },
    { separator: true },
    { label: 'Split Non-Planar Faces', op: 'mesh.vert_connect_nonplanar' },
    { label: 'Split Concave Faces', op: 'mesh.vert_connect_concave' },
    { label: 'Merge by Distance', op: 'mesh.remove_doubles' },
    { label: 'Fill Holes', op: 'mesh.fill_holes' },
  ];
}

function sortMenu(): MenuItem[] {
  return [
    ['VIEW_ZAXIS', 'View Z Axis'],
    ['VIEW_XAXIS', 'View X Axis'],
    ['CURSOR_DISTANCE', 'Cursor Distance'],
    ['MATERIAL', 'Material'],
    ['SELECTED', 'Selected'],
    ['RANDOMIZE', 'Randomize'],
    ['REVERSE', 'Reverse'],
  ].map(([type, label]) => ({ label, op: 'mesh.sort_elements', props: { type, elements: type === 'MATERIAL' ? 'FACE' : 'VERT' } }));
}

function showHideMenu(): MenuItem[] {
  return [
    { label: 'Reveal Hidden', op: 'mesh.reveal', shortcut: 'Alt H' },
    { label: 'Hide Selected', op: 'mesh.hide', shortcut: 'H' },
    { label: 'Hide Unselected', op: 'mesh.hide', props: { unselected: true }, shortcut: 'Shift H' },
  ];
}

function meshMenu(): MenuItem[] {
  return [
    {
      label: 'Transform',
      submenu: () => [
        { label: 'Move', op: 'transform.translate', shortcut: 'G' },
        { label: 'Rotate', op: 'transform.rotate', shortcut: 'R' },
        { label: 'Scale', op: 'transform.resize', shortcut: 'S' },
        { separator: true },
        { label: 'To Sphere', op: 'transform.tosphere', shortcut: 'Shift Alt S' },
        { label: 'Push/Pull', op: 'transform.push_pull' },
        { label: 'Randomize', op: 'transform.vertex_random' },
        { label: 'Shear', op: 'transform.shear', shortcut: 'Shift Ctrl Alt S' },
        { label: 'Bend', op: 'transform.bend', shortcut: 'Shift W' },
        { label: 'Warp', op: 'transform.vertex_warp' },
        { separator: true },
        { label: 'Shrink/Fatten', op: 'transform.shrink_fatten', shortcut: 'Alt S' },
      ],
    },
    { label: 'Mirror', submenu: mirrorMenu },
    { label: 'Snap', submenu: snapMenu },
    { separator: true },
    { label: 'Duplicate', op: 'mesh.duplicate_move', shortcut: 'Shift D' },
    { label: 'Extrude', submenu: extrudeMenu, shortcut: 'Alt E' },
    { separator: true },
    { label: 'Merge', submenu: mergeMenu, shortcut: 'M' },
    { label: 'Split', submenu: splitMenu, shortcut: 'Alt M' },
    { label: 'Separate', submenu: separateMenu, shortcut: 'P' },
    { separator: true },
    { label: 'Bisect', op: 'mesh.bisect' },
    { label: 'Knife Project', op: 'mesh.knife_project' },
    { label: 'Knife Topology Tool', op: 'mesh.knife_tool', shortcut: 'K' },
    { label: 'Convex Hull', op: 'mesh.convex_hull' },
    { separator: true },
    { label: 'Symmetrize', op: 'mesh.symmetrize' },
    { label: 'Snap to Symmetry', op: 'mesh.symmetry_snap' },
    { separator: true },
    { label: 'Normals', submenu: normalsMenu, shortcut: 'Alt N' },
    { label: 'Shading', submenu: shadingMenu },
    { label: 'Weights', submenu: weightsMenu },
    { label: 'Set Attribute', op: 'mesh.attribute_set' },
    { label: 'Sort Elements', submenu: sortMenu },
    { separator: true },
    { label: 'Show/Hide', submenu: showHideMenu },
    { label: 'Clean Up', submenu: cleanUpMenu },
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
    { label: 'Select Mirror', op: 'mesh.select_mirror', shortcut: 'Shift Ctrl M' },
    { label: 'Select Random', op: 'mesh.select_random' },
    { label: 'Checker Deselect', op: 'mesh.select_nth' },
    { separator: true },
    {
      label: 'Select More/Less',
      submenu: () => [
        { label: 'More', op: 'mesh.select_more', shortcut: 'Ctrl Numpad +' },
        { label: 'Less', op: 'mesh.select_less', shortcut: 'Ctrl Numpad -' },
        { separator: true },
        { label: 'Next Active', op: 'mesh.select_next_item', shortcut: 'Shift Ctrl Numpad +' },
        { label: 'Previous Active', op: 'mesh.select_prev_item', shortcut: 'Shift Ctrl Numpad -' },
      ],
    },
    { separator: true },
    { label: 'Select Similar', submenu: similarMenu, shortcut: 'Shift G' },
    {
      label: 'Select All by Trait',
      submenu: () => [
        { label: 'Non Manifold', op: 'mesh.select_non_manifold' },
        { label: 'Loose Geometry', op: 'mesh.select_loose' },
        { label: 'Interior Faces', op: 'mesh.select_interior_faces' },
        { label: 'Faces by Sides', op: 'mesh.select_face_by_sides' },
        { label: 'Poles by Count', op: 'mesh.select_by_pole_count' },
        { separator: true },
        { label: 'Ungrouped Vertices', op: 'mesh.select_ungrouped' },
      ],
    },
    {
      label: 'Select Linked',
      submenu: () => [
        { label: 'Linked', op: 'mesh.select_linked', shortcut: 'Ctrl L' },
        { label: 'Shortest Path', op: 'mesh.shortest_path_select' },
        { label: 'Linked Flat Faces', op: 'mesh.faces_select_linked_flat' },
      ],
    },
    {
      label: 'Select Loops',
      submenu: () => [
        { label: 'Edge Loops', op: 'mesh.select_edge_loop_multi' },
        { label: 'Edge Rings', op: 'mesh.select_edge_ring_multi' },
        { label: 'Boundary Loops', op: 'mesh.select_boundary_loop_multi' },
        { separator: true },
        { label: 'Loop Inner-Region', op: 'mesh.loop_to_region' },
        { label: 'Boundary of Selected', op: 'mesh.region_to_loop' },
      ],
    },
    { separator: true },
    { label: 'Sharp Edges', op: 'mesh.edges_select_sharp' },
    { label: 'Side of Active', op: 'mesh.select_axis' },
  ];
}

function addMenuEdit(): MenuItem[] {
  return meshAddMenu();
}

function contextMenu(): MenuItem[] {
  const m = selectMode();
  const tail = (what: string, dissolve: string, type: string): MenuItem[] => [
    { separator: true },
    { label: 'Split', op: 'mesh.split', shortcut: 'Y' },
    { label: 'Separate', submenu: separateMenu, shortcut: 'P' },
    { label: `Dissolve ${what}`, op: dissolve },
    { label: `Delete ${what}`, op: 'mesh.delete', props: { type } },
  ];
  if (m === 'VERT')
    return [
      { heading: 'Vertex' },
      { label: 'Subdivide', op: 'mesh.subdivide' },
      { separator: true },
      { label: 'Extrude Vertices', op: 'mesh.extrude_vertices_move' },
      { label: 'Bevel Vertices', op: 'mesh.bevel', props: { affect: 'VERTICES' }, shortcut: 'Shift Ctrl B' },
      { separator: true },
      { label: 'New Edge/Face from Vertices', op: 'mesh.edge_face_add', shortcut: 'F' },
      { label: 'Connect Vertex Path', op: 'mesh.vert_connect_path', shortcut: 'J' },
      { separator: true },
      { label: 'Push/Pull', op: 'transform.push_pull' },
      { label: 'Shrink/Fatten', op: 'transform.shrink_fatten', shortcut: 'Alt S' },
      { label: 'Slide Vertices', op: 'transform.vert_slide', shortcut: 'Shift V' },
      { label: 'Randomize Vertices', op: 'transform.vertex_random' },
      { label: 'Smooth Vertices', op: 'mesh.vertices_smooth' },
      { label: 'Smooth Laplacian', op: 'mesh.vertices_smooth_laplacian' },
      { separator: true },
      { label: 'Mirror Vertices', submenu: mirrorMenu },
      { label: 'Snap Vertices', submenu: snapMenu },
      { separator: true },
      { label: 'Merge Vertices', submenu: mergeMenu, shortcut: 'M' },
      ...tail('Vertices', 'mesh.dissolve_verts', 'VERT'),
    ];
  if (m === 'EDGE')
    return [
      { heading: 'Edge' },
      { label: 'Subdivide', op: 'mesh.subdivide' },
      { label: 'Subdivide Edge-Ring', op: 'mesh.subdivide_edgering' },
      { label: 'Un-Subdivide', op: 'mesh.unsubdivide' },
      { separator: true },
      { label: 'Rotate Edge CW', op: 'mesh.edge_rotate', props: { use_ccw: false } },
      { label: 'Rotate Edge CCW', op: 'mesh.edge_rotate', props: { use_ccw: true } },
      { separator: true },
      { label: 'Extrude Edges', op: 'mesh.extrude_edges_move' },
      { label: 'Bevel Edges', op: 'mesh.bevel', props: { affect: 'EDGES' }, shortcut: 'Ctrl B' },
      { label: 'Bridge Edge Loops', op: 'mesh.bridge_edge_loops' },
      { separator: true },
      { label: 'New Face from Edges', op: 'mesh.edge_face_add', shortcut: 'F' },
      { separator: true },
      { label: 'Loop Cut and Slide', op: 'mesh.loopcut_slide', shortcut: 'Ctrl R' },
      { label: 'Edge Slide', op: 'transform.edge_slide' },
      { label: 'Offset Edge Slide', op: 'mesh.offset_edge_loops_slide', shortcut: 'Shift Ctrl R' },
      { separator: true },
      { label: 'Edge Crease', op: 'transform.edge_crease', shortcut: 'Shift E' },
      { separator: true },
      { label: 'Mark Seam', op: 'mesh.mark_seam', props: { clear: false } },
      { label: 'Clear Seam', op: 'mesh.mark_seam', props: { clear: true } },
      { separator: true },
      { label: 'Mark Sharp', op: 'mesh.mark_sharp', props: { clear: false } },
      { label: 'Clear Sharp', op: 'mesh.mark_sharp', props: { clear: true } },
      ...tail('Edges', 'mesh.dissolve_edges', 'EDGE'),
    ];
  return [
    { heading: 'Face' },
    { label: 'Subdivide', op: 'mesh.subdivide' },
    { separator: true },
    { label: 'Extrude Faces', op: 'view3d.edit_mesh_extrude_move_normal', shortcut: 'E' },
    { label: 'Extrude Faces Along Normals', op: 'view3d.edit_mesh_extrude_move_shrink_fatten' },
    { label: 'Extrude Individual Faces', op: 'mesh.extrude_faces_move' },
    { separator: true },
    { label: 'Inset Faces', op: 'mesh.inset', shortcut: 'I' },
    { label: 'Poke Faces', op: 'mesh.poke' },
    { separator: true },
    { label: 'Triangulate Faces', op: 'mesh.quads_convert_to_tris', shortcut: 'Ctrl T' },
    { label: 'Tris to Quads', op: 'mesh.tris_convert_to_quads', shortcut: 'Alt J' },
    { separator: true },
    { label: 'Shade Smooth', op: 'mesh.faces_shade_smooth' },
    { label: 'Shade Flat', op: 'mesh.faces_shade_flat' },
    { separator: true },
    { label: 'UV Unwrap Faces', submenu: uvMenu },
    ...tail('Faces', 'mesh.dissolve_faces', 'FACE'),
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
  return h('div', { key: 'selmodes', class: 'hdr-group select-modes' }, btn(0, 'snap_vertex', 'Vertex', 'VERT'), btn(1, 'snap_edge', 'Edge', 'EDGE'), btn(2, 'snap_face', 'Face', 'FACE'));
}

// mesh symmetry sits at the right of the tool settings row
toolHeaderRightHooks.push(() => (inMeshEdit() ? symmetryButtons() : null));

/** Mesh symmetry toggles: edits on one side are mirrored to the other. */
function symmetryButtons() {
  const ts = app.doc.scene.tool_settings;
  const keys = ['use_mesh_mirror_x', 'use_mesh_mirror_y', 'use_mesh_mirror_z'] as const;
  return h(
    'div',
    { key: 'symmetry', class: 'hdr-group mesh-symmetry', 'data-tip': 'Mesh Symmetry: mirror edits across the local axes' },
    icon('mod_mirror'),
    keys.map((k, i) =>
      h(
        'button',
        {
          key: k,
          class: { 'hdr-toggle': true, on: !!ts[k] },
          'data-tip': `Mirror editing across the local ${'XYZ'[i]} axis`,
          onclick: () => {
            ts[k] = !ts[k];
            app.changed('ui');
          },
        },
        'XYZ'[i],
      ),
    ),
  );
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
  headerLead: selectModeButtons,
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
  { key: 'ONE', ctrl: true, op: 'mesh.select_mode', props: { type: 'VERT', use_expand: true }, when: m },
  { key: 'TWO', ctrl: true, op: 'mesh.select_mode', props: { type: 'EDGE', use_expand: true }, when: m },
  { key: 'THREE', ctrl: true, op: 'mesh.select_mode', props: { type: 'FACE', use_expand: true }, when: m },
  { key: 'ONE', shift: true, ctrl: true, op: 'mesh.select_mode', props: { type: 'VERT', use_extend: true, use_expand: true }, when: m },
  { key: 'TWO', shift: true, ctrl: true, op: 'mesh.select_mode', props: { type: 'EDGE', use_extend: true, use_expand: true }, when: m },
  { key: 'THREE', shift: true, ctrl: true, op: 'mesh.select_mode', props: { type: 'FACE', use_extend: true, use_expand: true }, when: m },
  { key: 'A', op: 'mesh.select_all', props: { action: 'SELECT' }, when: m },
  { key: 'A', alt: true, op: 'mesh.select_all', props: { action: 'DESELECT' }, when: m },
  { key: 'I', ctrl: true, op: 'mesh.select_all', props: { action: 'INVERT' }, when: m },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'mesh.select_more', when: m },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'mesh.select_less', when: m },
  { key: 'NUMPAD_PLUS', shift: true, ctrl: true, op: 'mesh.select_next_item', when: m },
  { key: 'NUMPAD_MINUS', shift: true, ctrl: true, op: 'mesh.select_prev_item', when: m },
  { key: 'L', ctrl: true, op: 'mesh.select_linked', when: m },
  { key: 'L', op: 'mesh.select_linked_pick', when: m },
  { key: 'L', shift: true, op: 'mesh.select_linked_pick', props: { deselect: true }, when: m },
  { key: 'G', shift: true, menu: similarMenu, menuTitle: 'Select Similar', when: m },
  { key: 'M', shift: true, ctrl: true, op: 'mesh.select_mirror', when: m },
  { key: 'M', ctrl: true, menu: mirrorMenu, menuTitle: 'Mirror', when: m },
  { key: 'H', op: 'mesh.hide', when: m },
  { key: 'H', shift: true, op: 'mesh.hide', props: { unselected: true }, when: m },
  { key: 'H', alt: true, op: 'mesh.reveal', when: m },
  { key: 'X', menu: deleteMenu, menuTitle: 'Delete', when: m },
  { key: 'DEL', menu: deleteMenu, menuTitle: 'Delete', when: m },
  { key: 'X', ctrl: true, op: 'mesh.dissolve_mode', when: m },
  { key: 'DEL', ctrl: true, op: 'mesh.dissolve_mode', when: m },
  { key: 'E', op: 'view3d.edit_mesh_extrude_move_normal', when: m },
  { key: 'E', alt: true, menu: extrudeMenu, menuTitle: 'Extrude', when: m },
  { key: 'I', op: 'mesh.inset', when: m },
  { key: 'B', ctrl: true, op: 'mesh.bevel', props: { affect: 'EDGES' }, when: m },
  { key: 'B', ctrl: true, shift: true, op: 'mesh.bevel', props: { affect: 'VERTICES' }, when: m },
  { key: 'R', ctrl: true, op: 'mesh.loopcut_slide', when: m },
  { key: 'R', ctrl: true, shift: true, op: 'mesh.offset_edge_loops_slide', when: m },
  { key: 'F', op: 'mesh.edge_face_add', when: m },
  { key: 'F', alt: true, op: 'mesh.fill', when: m },
  { key: 'M', menu: mergeMenu, menuTitle: 'Merge', when: m },
  { key: 'M', alt: true, menu: splitMenu, menuTitle: 'Split', when: m },
  { key: 'Y', op: 'mesh.split', when: m },
  { key: 'P', menu: separateMenu, menuTitle: 'Separate', when: m },
  { key: 'J', op: 'mesh.vert_connect_path', when: m },
  { key: 'D', shift: true, op: 'mesh.duplicate_move', when: m },
  { key: 'N', shift: true, op: 'mesh.normals_make_consistent', props: { inside: false }, when: m },
  { key: 'N', shift: true, ctrl: true, op: 'mesh.normals_make_consistent', props: { inside: true }, when: m },
  { key: 'N', alt: true, menu: normalsMenu, menuTitle: 'Normals', when: m },
  { key: 'L', alt: true, op: 'mesh.point_normals', when: m },
  { key: 'V', ctrl: true, menu: vertexMenu, menuTitle: 'Vertex', when: m },
  { key: 'E', ctrl: true, menu: edgeMenu, menuTitle: 'Edge', when: m },
  { key: 'F', ctrl: true, menu: faceMenu, menuTitle: 'Face', when: m },
  { key: 'G', ctrl: true, menu: vertexGroupMenu, menuTitle: 'Vertex Groups', when: m },
  { key: 'G', ctrl: true, alt: true, op: 'object.vertex_group_remove_from', when: m },
  { key: 'H', ctrl: true, menu: hooksMenu, menuTitle: 'Hooks', when: m },
  { key: 'U', menu: uvMenu, menuTitle: 'UV', when: m },
  { key: 'T', ctrl: true, op: 'mesh.quads_convert_to_tris', props: { quad_method: 'BEAUTY', ngon_method: 'BEAUTY' }, when: m },
  { key: 'T', shift: true, ctrl: true, op: 'mesh.quads_convert_to_tris', props: { quad_method: 'FIXED', ngon_method: 'CLIP' }, when: m },
  { key: 'J', alt: true, op: 'mesh.tris_convert_to_quads', when: m },
  { key: 'S', alt: true, op: 'transform.shrink_fatten', when: m },
  { key: 'S', alt: true, shift: true, op: 'transform.tosphere', when: m },
  { key: 'V', shift: true, op: 'transform.vert_slide', when: m },
  { key: 'E', shift: true, op: 'transform.edge_crease', when: m },
  { key: 'R', alt: true, op: 'mesh.spin', when: m },
  { key: 'A', shift: true, menu: meshAddMenu, menuTitle: 'Add', when: m },
]);
