// 3D viewport menus (View, Select, Add, Object, context menus).
import type { MenuItem } from '../../ui/menu';
import { app } from '../../app/app';
import { modeMenus } from './modemenus';

export function viewMenu(): MenuItem[] {
  return [
    { label: 'Toolbar', op: 'view3d.toggle_toolbar', shortcut: 'T' },
    { label: 'Sidebar', op: 'view3d.toggle_sidebar', shortcut: 'N' },
    { label: 'Tool Settings', op: 'view3d.toggle_tool_header' },
    { label: 'Adjust Last Operation', op: 'screen.redo_last', shortcut: 'F9' },
    { separator: true },
    { label: 'Frame Selected', op: 'view3d.view_selected', shortcut: 'Numpad .' },
    { label: 'Frame All', op: 'view3d.view_all', shortcut: 'Home' },
    { separator: true },
    { label: 'Perspective/Orthographic', op: 'view3d.view_persportho', shortcut: 'Numpad 5' },
    { label: 'Local View', op: 'view3d.localview', shortcut: 'Numpad /' },
    { separator: true },
    { label: 'Cameras', submenu: camerasMenu },
    { label: 'Viewpoint', submenu: viewpointMenu },
    { label: 'Navigation', submenu: navigationMenu },
    { label: 'Align View', submenu: alignViewMenu },
    { separator: true },
    { label: 'Render Viewport Image', op: 'render.opengl' },
    { label: 'Viewport Render Animation', op: 'render.opengl_animation' },
    { separator: true },
    { label: 'Area', submenu: () => areaMenu() },
  ];
}

function areaMenu(): MenuItem[] {
  const area = app.hoverArea ?? app.activeArea;
  return area ? (area as unknown as { areaMenu(): MenuItem[] }).areaMenu() : [];
}

function camerasMenu(): MenuItem[] {
  return [
    { label: 'Set Active Object as Camera', op: 'view3d.object_as_camera', shortcut: 'Ctrl Numpad 0' },
    { label: 'Active Camera', op: 'view3d.view_camera', shortcut: 'Numpad 0' },
    { separator: true },
    { label: 'Align Active Camera to View', op: 'view3d.camera_to_view', shortcut: 'Ctrl Alt Numpad 0' },
    { label: 'Align Active Camera to Selected', op: 'view3d.camera_to_view_selected' },
    { label: 'Lock Camera to View', op: 'view3d.toggle_lock_camera' },
  ];
}

function viewpointMenu(): MenuItem[] {
  return [
    { label: 'Camera', op: 'view3d.view_camera', shortcut: 'Numpad 0' },
    { separator: true },
    { label: 'Top', op: 'view3d.view_axis', props: { type: 'TOP' }, shortcut: 'Numpad 7' },
    { label: 'Bottom', op: 'view3d.view_axis', props: { type: 'BOTTOM' }, shortcut: 'Ctrl Numpad 7' },
    { separator: true },
    { label: 'Front', op: 'view3d.view_axis', props: { type: 'FRONT' }, shortcut: 'Numpad 1' },
    { label: 'Back', op: 'view3d.view_axis', props: { type: 'BACK' }, shortcut: 'Ctrl Numpad 1' },
    { separator: true },
    { label: 'Right', op: 'view3d.view_axis', props: { type: 'RIGHT' }, shortcut: 'Numpad 3' },
    { label: 'Left', op: 'view3d.view_axis', props: { type: 'LEFT' }, shortcut: 'Ctrl Numpad 3' },
  ];
}

function navigationMenu(): MenuItem[] {
  return [
    { label: 'Orbit Left', op: 'view3d.view_orbit', props: { type: 'ORBITLEFT' }, shortcut: 'Numpad 4' },
    { label: 'Orbit Right', op: 'view3d.view_orbit', props: { type: 'ORBITRIGHT' }, shortcut: 'Numpad 6' },
    { label: 'Orbit Up', op: 'view3d.view_orbit', props: { type: 'ORBITUP' }, shortcut: 'Numpad 8' },
    { label: 'Orbit Down', op: 'view3d.view_orbit', props: { type: 'ORBITDOWN' }, shortcut: 'Numpad 2' },
    { label: 'Orbit Opposite', op: 'view3d.view_orbit', props: { type: 'ORBITOPPOSITE' }, shortcut: 'Numpad 9' },
    { separator: true },
    { label: 'Pan Left', op: 'view3d.view_pan', props: { type: 'PANLEFT' }, shortcut: 'Ctrl Numpad 4' },
    { label: 'Pan Right', op: 'view3d.view_pan', props: { type: 'PANRIGHT' }, shortcut: 'Ctrl Numpad 6' },
    { label: 'Pan Up', op: 'view3d.view_pan', props: { type: 'PANUP' }, shortcut: 'Ctrl Numpad 8' },
    { label: 'Pan Down', op: 'view3d.view_pan', props: { type: 'PANDOWN' }, shortcut: 'Ctrl Numpad 2' },
    { separator: true },
    { label: 'Zoom In', op: 'view3d.zoom', props: { delta: 1 }, shortcut: 'Numpad +' },
    { label: 'Zoom Out', op: 'view3d.zoom', props: { delta: -1 }, shortcut: 'Numpad -' },
    { label: 'Zoom Region…', op: 'view3d.zoom_border', shortcut: 'Shift B' },
    { label: 'Zoom Camera 1:1', op: 'view3d.zoom_camera_1_to_1' },
    { separator: true },
    { label: 'Fly Navigation', op: 'view3d.fly' },
    { label: 'Walk Navigation', op: 'view3d.walk', shortcut: 'Shift `' },
  ];
}

function alignViewMenu(): MenuItem[] {
  return [
    { label: 'Align View to Active', submenu: () => ['TOP', 'BOTTOM', 'FRONT', 'BACK', 'RIGHT', 'LEFT'].map((t) => ({ label: t[0] + t.slice(1).toLowerCase(), op: 'view3d.view_axis', props: { type: t, align_active: true } })) },
    { separator: true },
    { label: 'Center Cursor and Frame All', op: 'view3d.view_all', props: { center: true }, shortcut: 'Shift C' },
    { label: 'Center View to Cursor', op: 'view3d.view_center_cursor' },
    { label: 'View Lock to Active', op: 'view3d.view_lock_to_active' },
    { label: 'View Lock Clear', op: 'view3d.view_lock_clear' },
  ];
}

export function selectMenu(): MenuItem[] {
  const m = modeMenus[app.doc.mode]?.select;
  if (m) return m();
  return [
    { label: 'All', op: 'object.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'object.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'object.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'view3d.select_box_tool', shortcut: 'B' },
    { label: 'Circle Select', op: 'view3d.select_circle_tool', shortcut: 'C' },
    { separator: true },
    { label: 'Select All by Type', submenu: () => ['MESH', 'CURVE', 'FONT', 'ARMATURE', 'LATTICE', 'EMPTY', 'CAMERA', 'LIGHT'].map((t) => ({ label: t[0] + t.slice(1).toLowerCase(), op: 'object.select_by_type', props: { type: t } })) },
    { label: 'Select Active Camera', op: 'object.select_camera' },
    { label: 'Select Mirror', op: 'object.select_mirror', shortcut: 'Shift Ctrl M' },
    { label: 'Select Random', op: 'object.select_random' },
    { separator: true },
    { label: 'Select More/Less', submenu: () => [
      { label: 'Parent', op: 'object.select_hierarchy', props: { direction: 'PARENT' }, shortcut: '[' },
      { label: 'Child', op: 'object.select_hierarchy', props: { direction: 'CHILD' }, shortcut: ']' },
      { label: 'Extend Parent', op: 'object.select_hierarchy', props: { direction: 'PARENT', extend: true }, shortcut: 'Shift [' },
      { label: 'Extend Child', op: 'object.select_hierarchy', props: { direction: 'CHILD', extend: true }, shortcut: 'Shift ]' },
    ] },
    { label: 'Select Grouped', submenu: () => [
      { label: 'Children', op: 'object.select_grouped', props: { type: 'CHILDREN_RECURSIVE' } },
      { label: 'Immediate Children', op: 'object.select_grouped', props: { type: 'CHILDREN' } },
      { label: 'Parent', op: 'object.select_grouped', props: { type: 'PARENT' } },
      { label: 'Siblings', op: 'object.select_grouped', props: { type: 'SIBLINGS' } },
      { label: 'Type', op: 'object.select_grouped', props: { type: 'TYPE' } },
      { label: 'Collection', op: 'object.select_grouped', props: { type: 'COLLECTION' } },
      { label: 'Light Type', op: 'object.select_grouped', props: { type: 'LIGHT_TYPE' } },
    ] },
    { label: 'Select Linked', submenu: () => [
      { label: 'Object Data', op: 'object.select_linked', props: { type: 'OBDATA' } },
      { label: 'Material', op: 'object.select_linked', props: { type: 'MATERIAL' } },
    ] },
    { label: 'Select Pattern…', op: 'object.select_pattern' },
  ];
}

/** Extra Add menu entries (e.g. Grease Pencil), inserted after Point Cloud. */
export const addMenuHooks: (() => MenuItem[])[] = [];

export function addMenu(): MenuItem[] {
  return [
    { label: 'Mesh', icon: 'outliner_ob_mesh', submenu: meshAddMenu },
    { label: 'Curve', icon: 'outliner_ob_curve', submenu: curveAddMenu },
    { label: 'Surface', icon: 'outliner_ob_curve', submenu: () => [{ label: 'NURBS Curve', icon: 'curve_data', op: 'curve.primitive_nurbs_curve_add' }, { label: 'NURBS Circle', icon: 'circle', op: 'curve.primitive_nurbs_circle_add' }] },
    { label: 'Text', icon: 'outliner_ob_font', op: 'object.text_add' },
    { label: 'Point Cloud', icon: 'outliner_ob_pointcloud', op: 'object.pointcloud_add' },
    ...addMenuHooks.flatMap((f) => f()),
    { separator: true },
    { label: 'Armature', icon: 'outliner_ob_armature', op: 'object.armature_add' },
    { label: 'Lattice', icon: 'outliner_ob_lattice', op: 'object.add', props: { type: 'LATTICE' } },
    { separator: true },
    { label: 'Empty', icon: 'outliner_ob_empty', submenu: () =>
      [
        ['PLAIN_AXES', 'Plain Axes'],
        ['ARROWS', 'Arrows'],
        ['SINGLE_ARROW', 'Single Arrow'],
        ['CIRCLE', 'Circle'],
        ['CUBE', 'Cube'],
        ['SPHERE', 'Sphere'],
        ['CONE', 'Cone'],
      ].map(([t, l]) => ({ label: l, icon: 'outliner_ob_empty', op: 'object.empty_add', props: { type: t } })) },
    { label: 'Image', icon: 'image', submenu: () => [{ label: 'Reference', op: 'object.empty_image_add', props: { background: false } }, { label: 'Background', op: 'object.empty_image_add', props: { background: true } }, { label: 'Mesh Plane', op: 'image.import_as_mesh_planes' }] },
    { separator: true },
    { label: 'Light', icon: 'outliner_ob_light', submenu: () =>
      [
        ['POINT', 'Point', 'light_point'],
        ['SUN', 'Sun', 'light_sun'],
        ['SPOT', 'Spot', 'light_spot'],
        ['AREA', 'Area', 'light_area'],
      ].map(([t, l, i]) => ({ label: l, icon: i, op: 'object.light_add', props: { type: t } })) },
    { separator: true },
    { label: 'Camera', icon: 'outliner_ob_camera', op: 'object.camera_add' },
    { separator: true },
    { label: 'Force Field', icon: 'force_force', submenu: () =>
      [
        ['FORCE', 'Force'],
        ['WIND', 'Wind'],
        ['VORTEX', 'Vortex'],
        ['TURBULENCE', 'Turbulence'],
        ['DRAG', 'Drag'],
      ].map(([t, l]) => ({ label: l, icon: `force_${t.toLowerCase()}`, op: 'object.effector_add', props: { type: t } })) },
    { separator: true },
    { label: 'Collection Instance', icon: 'collection', submenu: () => {
      const cols = Object.values(app.doc.collections).filter((c) => c.id !== app.doc.scene.collection);
      return cols.length ? cols.map((c) => ({ label: c.name, icon: 'collection', op: 'object.collection_instance_add', props: { collection: c.id } })) : [{ label: 'No collections', disabled: true }];
    } },
  ];
}

export function meshAddMenu(): MenuItem[] {
  const mk = (label: string, op: string, icon: string): MenuItem => ({ label, op, icon });
  return [
    mk('Plane', 'mesh.primitive_plane_add', 'plane'),
    mk('Cube', 'mesh.primitive_cube_add', 'cube'),
    mk('Circle', 'mesh.primitive_circle_add', 'circle'),
    mk('UV Sphere', 'mesh.primitive_uv_sphere_add', 'sphere'),
    mk('Ico Sphere', 'mesh.primitive_ico_sphere_add', 'icosphere'),
    mk('Cylinder', 'mesh.primitive_cylinder_add', 'cylinder'),
    mk('Cone', 'mesh.primitive_cone_add', 'cone'),
    mk('Torus', 'mesh.primitive_torus_add', 'torus'),
    { separator: true },
    mk('Grid', 'mesh.primitive_grid_add', 'grid'),
    mk('Robot Head', 'mesh.primitive_mascot_add', 'mascot'),
  ];
}

function curveAddMenu(): MenuItem[] {
  return [
    { label: 'Bézier', icon: 'curve_data', op: 'curve.primitive_bezier_curve_add' },
    { label: 'Circle', icon: 'circle', op: 'curve.primitive_bezier_circle_add' },
    { separator: true },
    { label: 'NURBS Curve', icon: 'curve_data', op: 'curve.primitive_nurbs_curve_add' },
    { label: 'NURBS Circle', icon: 'circle', op: 'curve.primitive_nurbs_circle_add' },
    { label: 'Path', icon: 'curve_data', op: 'curve.primitive_nurbs_path_add' },
  ];
}

export function objectMenu(): MenuItem[] {
  return [
    { label: 'Transform', submenu: () => [
      { label: 'Move', op: 'transform.translate', shortcut: 'G' },
      { label: 'Rotate', op: 'transform.rotate', shortcut: 'R' },
      { label: 'Scale', op: 'transform.resize', shortcut: 'S' },
      { separator: true },
      { label: 'Push/Pull', op: 'transform.push_pull' },
      { label: 'Randomize Transform', op: 'object.randomize_transform' },
      { label: 'Align Objects', op: 'object.align' },
    ] },
    { label: 'Set Origin', submenu: () => [
      { label: 'Geometry to Origin', op: 'object.origin_set', props: { type: 'GEOMETRY_ORIGIN' } },
      { label: 'Origin to Geometry', op: 'object.origin_set', props: { type: 'ORIGIN_GEOMETRY' } },
      { label: 'Origin to 3D Cursor', op: 'object.origin_set', props: { type: 'ORIGIN_CURSOR' } },
      { label: 'Origin to Center of Mass (Surface)', op: 'object.origin_set', props: { type: 'ORIGIN_CENTER_OF_MASS' } },
    ] },
    { label: 'Apply', shortcut: 'Ctrl A', submenu: applyMenu },
    { label: 'Mirror', submenu: () => ['X', 'Y', 'Z'].map((a, i) => ({ label: `${a} Global`, op: 'transform.mirror', props: { axis: i } })) },
    { label: 'Clear', submenu: () => [
      { label: 'Location', op: 'object.location_clear', shortcut: 'Alt G' },
      { label: 'Rotation', op: 'object.rotation_clear', shortcut: 'Alt R' },
      { label: 'Scale', op: 'object.scale_clear', shortcut: 'Alt S' },
      { label: 'Origin', op: 'object.origin_clear', shortcut: 'Alt O' },
    ] },
    { label: 'Snap', submenu: snapMenu, shortcut: 'Shift S' },
    { separator: true },
    { label: 'Duplicate Objects', op: 'object.duplicate_move', shortcut: 'Shift D' },
    { label: 'Duplicate Linked', op: 'object.duplicate_move_linked', shortcut: 'Alt D' },
    { label: 'Join', op: 'object.join', shortcut: 'Ctrl J' },
    { separator: true },
    { label: 'Copy Objects', op: 'view3d.copybuffer', shortcut: 'Ctrl C' },
    { label: 'Paste Objects', op: 'view3d.pastebuffer', shortcut: 'Ctrl V' },
    { separator: true },
    { label: 'Parent', submenu: () => [
      { label: 'Object', op: 'object.parent_set', props: { type: 'OBJECT' }, shortcut: 'Ctrl P' },
      { label: 'Object (Keep Transform)', op: 'object.parent_set', props: { type: 'OBJECT', keep_transform: true } },
      { label: 'Object (Without Inverse)', op: 'object.parent_no_inverse_set' },
      { label: 'Armature Deform With Automatic Weights', op: 'object.parent_set', props: { type: 'ARMATURE_AUTO' } },
      { label: 'Armature Deform With Empty Groups', op: 'object.parent_set', props: { type: 'ARMATURE_NAME' } },
      { label: 'Bone', op: 'object.parent_set', props: { type: 'BONE' } },
      { separator: true },
      { label: 'Clear Parent', op: 'object.parent_clear', props: { type: 'CLEAR' }, shortcut: 'Alt P' },
      { label: 'Clear and Keep Transformation', op: 'object.parent_clear', props: { type: 'CLEAR_KEEP_TRANSFORM' } },
      { label: 'Clear Parent Inverse', op: 'object.parent_clear', props: { type: 'CLEAR_INVERSE' } },
    ] },
    { label: 'Collection', submenu: () => [
      { label: 'Move to Collection…', op: 'object.move_to_collection', shortcut: 'M' },
      { label: 'Link to Collection…', op: 'object.link_to_collection', shortcut: 'Shift M' },
      { separator: true },
      { label: 'Create New Collection', op: 'collection.create', shortcut: 'Ctrl G' },
      { label: 'Remove from All Collections', op: 'collection.objects_remove_all' },
    ] },
    { label: 'Relations', submenu: () => [
      { label: 'Make Single User', op: 'object.make_single_user' },
      { label: 'Link/Transfer Data', submenu: () => [
        { label: 'Link Object Data', op: 'object.make_links_data', props: { type: 'OBDATA' } },
        { label: 'Link Materials', op: 'object.make_links_data', props: { type: 'MATERIAL' } },
        { label: 'Copy Modifiers', op: 'object.make_links_data', props: { type: 'MODIFIERS' } },
      ], shortcut: 'Ctrl L' },
    ] },
    { label: 'Constraint', submenu: () => [
      { label: 'Add Constraint (with Targets)', op: 'object.constraint_add_with_targets' },
      { label: 'Copy Constraints to Selected Objects', op: 'object.constraints_copy' },
      { label: 'Clear Object Constraints', op: 'object.constraints_clear' },
    ] },
    { label: 'Track', submenu: () => [
      { label: 'Damped Track Constraint', op: 'object.track_set', props: { type: 'DAMPTRACK' } },
      { label: 'Track To Constraint', op: 'object.track_set', props: { type: 'TRACKTO' } },
      { label: 'Lock Track Constraint', op: 'object.track_set', props: { type: 'LOCKTRACK' } },
      { label: 'Clear Track', op: 'object.track_clear' },
    ] },
    { separator: true },
    { label: 'Animation', submenu: () => [
      { label: 'Insert Keyframe', op: 'anim.keyframe_insert', shortcut: 'I' },
      { label: 'Insert Keyframe with Keying Set', op: 'anim.keyframe_insert_menu', shortcut: 'K' },
      { label: 'Delete Keyframes…', op: 'anim.keyframe_delete_v3d', shortcut: 'Alt I' },
      { label: 'Clear Keyframes…', op: 'anim.keyframe_clear_v3d', shortcut: 'Shift Alt I' },
      { separator: true },
      { label: 'Bake Action…', op: 'nla.bake' },
    ] },
    { separator: true },
    { label: 'Shade Smooth', op: 'object.shade_smooth' },
    { label: 'Shade Auto Smooth', op: 'object.shade_auto_smooth' },
    { label: 'Shade Flat', op: 'object.shade_flat' },
    { separator: true },
    { label: 'Rigid Body', submenu: () => [
      { label: 'Add Active', op: 'rigidbody.objects_add', props: { type: 'ACTIVE' } },
      { label: 'Add Passive', op: 'rigidbody.objects_add', props: { type: 'PASSIVE' } },
      { label: 'Remove', op: 'rigidbody.objects_remove' },
      { separator: true },
      { label: 'Bake to Keyframes', op: 'rigidbody.bake_to_keyframes' },
    ] },
    { label: 'Convert', submenu: () => [
      { label: 'Mesh', op: 'object.convert', props: { target: 'MESH' } },
      { label: 'Curve', op: 'object.convert', props: { target: 'CURVE' } },
      { separator: true },
      { label: 'Image Empty to Mesh Plane', op: 'image.convert_to_mesh_plane' },
    ] },
    { separator: true },
    { label: 'Show/Hide', submenu: () => [
      { label: 'Show Hidden Objects', op: 'object.hide_view_clear', shortcut: 'Alt H' },
      { label: 'Hide Selected', op: 'object.hide_view_set', shortcut: 'H' },
      { label: 'Hide Unselected', op: 'object.hide_view_set', props: { unselected: true }, shortcut: 'Shift H' },
    ] },
    { label: 'Clean Up', submenu: () => [{ label: 'Clear Keyframes', op: 'anim.keyframe_clear_v3d' }] },
    { separator: true },
    { label: 'Delete', op: 'object.delete', shortcut: 'X' },
    { label: 'Delete Globally', op: 'object.delete', props: { use_global: true } },
  ];
}

export function applyMenu(): MenuItem[] {
  return [
    { label: 'Location', op: 'object.transform_apply', props: { location: true, rotation: false, scale: false } },
    { label: 'Rotation', op: 'object.transform_apply', props: { location: false, rotation: true, scale: false } },
    { label: 'Scale', op: 'object.transform_apply', props: { location: false, rotation: false, scale: true } },
    { label: 'All Transforms', op: 'object.transform_apply', props: { location: true, rotation: true, scale: true } },
    { label: 'Rotation & Scale', op: 'object.transform_apply', props: { location: false, rotation: true, scale: true } },
    { separator: true },
    { label: 'Location to Deltas', op: 'object.transforms_to_deltas', props: { mode: 'LOC' } },
    { label: 'All Transforms to Deltas', op: 'object.transforms_to_deltas', props: { mode: 'ALL' } },
    { separator: true },
    { label: 'Visual Transform', op: 'object.visual_transform_apply' },
    { label: 'Visual Geometry to Mesh', op: 'object.convert', props: { target: 'MESH' } },
    { label: 'Make Instances Real', op: 'object.duplicates_make_real' },
    { label: 'Parent Inverse', op: 'object.parent_inverse_apply' },
  ];
}

export function snapMenu(): MenuItem[] {
  return [
    { label: 'Selection to Grid', op: 'view3d.snap_selected_to_grid' },
    { label: 'Selection to Cursor', op: 'view3d.snap_selected_to_cursor', props: { use_offset: false } },
    { label: 'Selection to Cursor (Keep Offset)', op: 'view3d.snap_selected_to_cursor', props: { use_offset: true } },
    { label: 'Selection to Active', op: 'view3d.snap_selected_to_active' },
    { separator: true },
    { label: 'Cursor to Selected', op: 'view3d.snap_cursor_to_selected' },
    { label: 'Cursor to World Origin', op: 'view3d.snap_cursor_to_center' },
    { label: 'Cursor to Grid', op: 'view3d.snap_cursor_to_grid' },
    { label: 'Cursor to Active', op: 'view3d.snap_cursor_to_active' },
  ];
}

export function objectContextMenu(): MenuItem[] {
  const m = modeMenus[app.doc.mode]?.context;
  if (m) return m();
  return [
    { label: 'Shade Smooth', op: 'object.shade_smooth' },
    { label: 'Shade Auto Smooth', op: 'object.shade_auto_smooth' },
    { label: 'Shade Flat', op: 'object.shade_flat' },
    { separator: true },
    { label: 'Convert To', submenu: () => [{ label: 'Mesh', op: 'object.convert', props: { target: 'MESH' } }, { label: 'Curve', op: 'object.convert', props: { target: 'CURVE' } }] },
    { separator: true },
    { label: 'Copy Objects', op: 'view3d.copybuffer', shortcut: 'Ctrl C' },
    { label: 'Paste Objects', op: 'view3d.pastebuffer', shortcut: 'Ctrl V' },
    { separator: true },
    { label: 'Duplicate Objects', op: 'object.duplicate_move', shortcut: 'Shift D' },
    { label: 'Duplicate Linked', op: 'object.duplicate_move_linked', shortcut: 'Alt D' },
    { separator: true },
    { label: 'Rename Active Object…', op: 'object.rename', shortcut: 'F2' },
    { separator: true },
    { label: 'Mirror', submenu: () => ['X', 'Y', 'Z'].map((a, i) => ({ label: `${a} Global`, op: 'transform.mirror', props: { axis: i } })) },
    { label: 'Snap', submenu: snapMenu },
    { label: 'Parent', submenu: () => [{ label: 'Object', op: 'object.parent_set', props: { type: 'OBJECT' } }, { label: 'Clear Parent', op: 'object.parent_clear', props: { type: 'CLEAR' } }] },
    { label: 'Move to Collection', op: 'object.move_to_collection', shortcut: 'M' },
    { separator: true },
    { label: 'Insert Keyframe', op: 'anim.keyframe_insert', shortcut: 'I' },
    { separator: true },
    { label: 'Delete', op: 'object.delete', shortcut: 'X' },
  ];
}
