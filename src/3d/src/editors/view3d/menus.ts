// 3D viewport menus (View, Select, Add, Object, context menus).
import type { MenuItem } from '../../ui/menu';
import { app } from '../../app/app';
import { modeMenus } from './modemenus';
import { objectModeContextMenu, selectByTypeMenu, selectGroupedMenu, selectLinkedMenu, selectMoreLessMenu } from '../../object/menus';

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
    { label: 'Select Active Camera', op: 'object.select_camera' },
    { label: 'Select Mirror', op: 'object.select_mirror', shortcut: 'Shift Ctrl M' },
    { label: 'Select Random', op: 'object.select_random' },
    { separator: true },
    { label: 'Select More/Less', submenu: selectMoreLessMenu },
    { separator: true },
    { label: 'Select All by Type', submenu: selectByTypeMenu },
    { label: 'Select Grouped', submenu: selectGroupedMenu, shortcut: 'Shift G' },
    { label: 'Select Linked', submenu: selectLinkedMenu, shortcut: 'Shift L' },
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
    { label: 'Lattice', icon: 'outliner_ob_lattice', submenu: () => [{ label: 'Lattice', icon: 'outliner_ob_lattice', op: 'object.add', props: { type: 'LATTICE' } }, { label: 'Lattice Deform Selected', icon: 'mod_lattice', op: 'object.lattice_add_to_selected' }] },
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

export { objectMenu, applyMenu } from '../../object/menus';

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
  return objectModeContextMenu();
}
