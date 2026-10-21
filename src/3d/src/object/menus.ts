// Object Mode menus: Object menu and its submenus, Apply (Ctrl A), Link/Transfer Data (Ctrl L),
// Set Parent To (Ctrl P), the object context menu and the Select menu entries.
import { app } from '../app/app';
import type { DocumentData } from '../data/types';
import type { MenuItem } from '../ui/menu';
import { snapMenu } from '../editors/view3d/menus';
import { addModifierMenu } from '../editors/properties/stack';
import { objectTransformMenu as transformMenu, mirrorMenu } from '../editors/view3d/transformui';
import { objectAssetMenu } from '../assets/menus';
import { libOverrideMenu, makeLocalMenu } from '../library/menus';

export { mirrorMenu };

export function originMenu(): MenuItem[] {
  return [
    { label: 'Geometry to Origin', op: 'object.origin_set', props: { type: 'GEOMETRY_ORIGIN' } },
    { label: 'Origin to Geometry', op: 'object.origin_set', props: { type: 'ORIGIN_GEOMETRY' } },
    { label: 'Origin to 3D Cursor', op: 'object.origin_set', props: { type: 'ORIGIN_CURSOR' } },
    { label: 'Origin to Center of Mass (Surface)', op: 'object.origin_set', props: { type: 'ORIGIN_CENTER_OF_MASS' } },
    { label: 'Origin to Center of Mass (Volume)', op: 'object.origin_set', props: { type: 'ORIGIN_CENTER_OF_VOLUME' } },
  ];
}

function clearMenu(): MenuItem[] {
  return [
    { label: 'Location', op: 'object.location_clear', shortcut: 'Alt G' },
    { label: 'Rotation', op: 'object.rotation_clear', shortcut: 'Alt R' },
    { label: 'Scale', op: 'object.scale_clear', shortcut: 'Alt S' },
    { separator: true },
    { label: 'Origin', op: 'object.origin_clear', shortcut: 'Alt O' },
  ];
}

export function applyMenu(): MenuItem[] {
  const t = (location: boolean, rotation: boolean, scale: boolean) => ({ location, rotation, scale });
  return [
    { label: 'Location', op: 'object.transform_apply', props: t(true, false, false) },
    { label: 'Rotation', op: 'object.transform_apply', props: t(false, true, false) },
    { label: 'Scale', op: 'object.transform_apply', props: t(false, false, true) },
    { label: 'All Transforms', op: 'object.transform_apply', props: t(true, true, true) },
    { label: 'Rotation & Scale', op: 'object.transform_apply', props: t(false, true, true) },
    { separator: true },
    { label: 'Location to Deltas', op: 'object.transforms_to_deltas', props: { mode: 'LOC' } },
    { label: 'Rotation to Deltas', op: 'object.transforms_to_deltas', props: { mode: 'ROT' } },
    { label: 'Scale to Deltas', op: 'object.transforms_to_deltas', props: { mode: 'SCALE' } },
    { label: 'All Transforms to Deltas', op: 'object.transforms_to_deltas', props: { mode: 'ALL' } },
    { label: 'Animated Transforms to Deltas', op: 'object.anim_transforms_to_deltas' },
    { separator: true },
    { label: 'Visual Transform', op: 'object.visual_transform_apply' },
    { label: 'Visual Geometry to Mesh', op: 'object.convert', props: { target: 'MESH' } },
    { label: 'Visual Geometry to Objects', op: 'object.visual_geometry_to_objects' },
    { label: 'Make Instances Real', op: 'object.duplicates_make_real' },
    { label: 'Parent Inverse', op: 'object.parent_inverse_apply' },
  ];
}

/** Collection tree as menu items, each running `op` with the collection id. */
function collectionTree(doc: DocumentData, op: string, cid = doc.scene.collection, withNew = true): MenuItem[] {
  const c = doc.collections[cid];
  if (!c) return [];
  const self: MenuItem = { label: c.name, icon: cid === doc.scene.collection ? 'scene' : 'collection', op, props: { collection: cid } };
  const kids = c.children
    .filter((ch) => doc.collections[ch])
    .map((ch): MenuItem => {
      const cc = doc.collections[ch];
      return cc.children.length ? { label: cc.name, icon: 'collection', submenu: () => collectionTree(doc, op, ch, withNew) } : { label: cc.name, icon: 'collection', op, props: { collection: ch } };
    });
  return [self, ...kids, ...(withNew && op === 'object.move_to_collection' ? [{ separator: true }, { label: 'New Collection', icon: 'add', op, props: { collection: cid, is_new: true } }] : [])];
}

export function moveToCollectionMenu(): MenuItem[] {
  return collectionTree(app.doc, 'object.move_to_collection');
}

function collectionMenu(): MenuItem[] {
  return [
    { label: 'Move to Collection', submenu: moveToCollectionMenu, shortcut: 'M' },
    { label: 'Link to Collection', submenu: () => collectionTree(app.doc, 'object.link_to_collection'), shortcut: 'Shift M' },
    { separator: true },
    { label: 'Create New Collection', op: 'collection.create', shortcut: 'Ctrl G' },
    { label: 'Remove from Collection…', op: 'collection.objects_remove', shortcut: 'Ctrl Alt G' },
    { label: 'Remove from All Collections', op: 'collection.objects_remove_all', shortcut: 'Shift Ctrl Alt G' },
    { separator: true },
    { label: 'Add Selected to Active Collection', op: 'collection.objects_add_active', shortcut: 'Shift Ctrl G' },
    { label: 'Remove Selected from Active Collection', op: 'collection.objects_remove_active', shortcut: 'Shift Alt G' },
  ];
}

function singleUserMenu(): MenuItem[] {
  return [
    { label: 'Object & Data', op: 'object.make_single_user', props: { obdata: true, material: false, animation: false } },
    { label: 'Object & Data & Materials', op: 'object.make_single_user', props: { obdata: true, material: true, animation: false } },
    { label: 'Materials', op: 'object.make_single_user', props: { obdata: false, material: true, animation: false } },
    { label: 'Object Animation', op: 'object.make_single_user', props: { obdata: false, material: false, animation: true } },
  ];
}

function relationsMenu(): MenuItem[] {
  return [{ label: 'Make Instance Face', op: 'object.make_dupli_face' }, { separator: true }, { label: 'Make Local', submenu: makeLocalMenu }, { label: 'Make Single User', submenu: singleUserMenu }];
}

/** Parent types that make sense for the active (parent) object. */
export function parentSetMenu(): MenuItem[] {
  const parent = app.activeObject;
  const items: MenuItem[] = [
    { label: 'Object', op: 'object.parent_set', props: { type: 'OBJECT' } },
    { label: 'Object (Keep Transform)', op: 'object.parent_set', props: { type: 'OBJECT', keep_transform: true } },
  ];
  if (parent?.type === 'ARMATURE')
    items.push(
      { label: 'Armature Deform', op: 'object.parent_set', props: { type: 'ARMATURE' } },
      { label: '   With Empty Groups', op: 'object.parent_set', props: { type: 'ARMATURE_NAME' } },
      { label: '   With Automatic Weights', op: 'object.parent_set', props: { type: 'ARMATURE_AUTO' } },
      { label: 'Bone', op: 'object.parent_set', props: { type: 'BONE' } },
    );
  if (parent?.type === 'CURVE') items.push({ label: 'Curve Deform', op: 'object.parent_set', props: { type: 'CURVE' } });
  if (parent?.type === 'LATTICE') items.push({ label: 'Lattice Deform', op: 'object.parent_set', props: { type: 'LATTICE' } });
  return items;
}

export function parentClearMenu(): MenuItem[] {
  return [
    { label: 'Clear Parent', op: 'object.parent_clear', props: { type: 'CLEAR' } },
    { label: 'Clear and Keep Transformation', op: 'object.parent_clear', props: { type: 'CLEAR_KEEP_TRANSFORM' } },
    { label: 'Clear Parent Inverse', op: 'object.parent_clear', props: { type: 'CLEAR_INVERSE' } },
  ];
}

function parentMenu(): MenuItem[] {
  return [
    ...parentSetMenu(),
    { separator: true },
    { label: 'Make Parent without Inverse', op: 'object.parent_no_inverse_set' },
    { label: 'Make Parent without Inverse (Keep Transform)', op: 'object.parent_no_inverse_set', props: { keep_transform: true } },
    { separator: true },
    ...parentClearMenu(),
  ];
}

function modifiersMenu(): MenuItem[] {
  return [
    { label: 'Add Modifier', submenu: addModifierMenu, disabled: !app.poll('object.modifier_add') },
    { label: 'Copy Modifiers to Selected Objects', op: 'object.modifiers_copy_to_selected' },
    { separator: true },
    { label: 'Clear Object Modifiers', op: 'object.modifiers_clear' },
  ];
}

function constraintsMenu(): MenuItem[] {
  return [
    { label: 'Add Constraint (with Targets)', op: 'object.constraint_add_with_targets' },
    { label: 'Copy Constraints to Selected Objects', op: 'object.constraints_copy' },
    { separator: true },
    { label: 'Clear Object Constraints', op: 'object.constraints_clear' },
  ];
}

function trackMenu(): MenuItem[] {
  return [
    { label: 'Damped Track Constraint', op: 'object.track_set', props: { type: 'DAMPTRACK' } },
    { label: 'Track To Constraint', op: 'object.track_set', props: { type: 'TRACKTO' } },
    { label: 'Lock Track Constraint', op: 'object.track_set', props: { type: 'LOCKTRACK' } },
    { separator: true },
    { label: 'Clear Track', op: 'object.track_clear', props: { type: 'CLEAR' } },
    { label: 'Clear Track (Keep Transformation)', op: 'object.track_clear', props: { type: 'CLEAR_KEEP_TRANSFORM' } },
  ];
}

/** Extra entries of Link/Transfer Data (Link Objects to Scene at the top, light linking at the bottom). */
export const linkDataMenuHooks: { top: (() => MenuItem[])[]; bottom: (() => MenuItem[])[] } = { top: [], bottom: [] };

export function linkDataMenu(): MenuItem[] {
  const l = (label: string, type: string): MenuItem => ({ label, op: 'object.make_links_data', props: { type } });
  return [
    ...linkDataMenuHooks.top.flatMap((f) => f()),
    l('Link Object Data', 'OBDATA'),
    l('Link Materials', 'MATERIAL'),
    l('Link Animation Data', 'ANIMATION'),
    l('Link Collections', 'GROUPS'),
    l('Link Instance Collection', 'DUPLICOLLECTION'),
    l('Link Fonts to Text', 'FONTS'),
    l('Copy Modifiers', 'MODIFIERS'),
    { label: 'Copy UV Maps', op: 'object.join_uvs' },
    { separator: true },
    { label: 'Transfer Mesh Data', op: 'object.data_transfer' },
    { label: 'Transfer Mesh Data Layout', op: 'object.datalayout_transfer' },
    ...linkDataMenuHooks.bottom.flatMap((f) => f()),
  ];
}

function animationMenu(): MenuItem[] {
  return [
    { label: 'Insert Keyframe', op: 'anim.keyframe_insert', shortcut: 'I' },
    { label: 'Insert Keyframe with Keying Set…', op: 'anim.keyframe_insert_menu', shortcut: 'K' },
    { label: 'Delete Keyframes…', op: 'anim.keyframe_delete_v3d', shortcut: 'Alt I' },
    { label: 'Clear Keyframes…', op: 'anim.keyframe_clear_v3d', shortcut: 'Shift Alt I' },
    { label: 'Change Keying Set…', op: 'anim.keying_set_active_set', shortcut: 'Shift K' },
    { separator: true },
    { label: 'Bake Action…', op: 'nla.bake' },
    { label: 'Bake Object Transform to Grease Pencil…', op: 'grease_pencil.bake_grease_pencil_animation' },
    { label: 'Replace Action', op: 'anim.replace_action' },
    { label: 'Replace with New Action', op: 'anim.replace_action_new' },
  ];
}

function rigidBodyMenu(): MenuItem[] {
  const shapes: [string, string][] = [
    ['BOX', 'Box'],
    ['SPHERE', 'Sphere'],
    ['CAPSULE', 'Capsule'],
    ['CYLINDER', 'Cylinder'],
    ['CONE', 'Cone'],
    ['CONVEX_HULL', 'Convex Hull'],
    ['MESH', 'Mesh'],
  ];
  return [
    { label: 'Add Active', op: 'rigidbody.objects_add', props: { type: 'ACTIVE' } },
    { label: 'Add Passive', op: 'rigidbody.objects_add', props: { type: 'PASSIVE' } },
    { separator: true },
    { label: 'Remove', op: 'rigidbody.objects_remove' },
    { separator: true },
    { label: 'Change Shape', submenu: () => shapes.map(([v, l]) => ({ label: l, op: 'rigidbody.shape_change', props: { type: v } })), disabled: !app.poll('rigidbody.shape_change') },
    { label: 'Calculate Mass', op: 'rigidbody.mass_calculate' },
    { label: 'Copy from Active', op: 'rigidbody.object_settings_copy' },
    { label: 'Apply Transformation', op: 'object.visual_transform_apply' },
    { label: 'Bake to Keyframes', op: 'rigidbody.bake_to_keyframes' },
    { separator: true },
    { label: 'Connect', op: 'rigidbody.connect' },
  ];
}

export function convertMenu(): MenuItem[] {
  return [
    { label: 'Mesh', icon: 'outliner_ob_mesh', op: 'object.convert', props: { target: 'MESH' } },
    { label: 'Curve', icon: 'outliner_ob_curve', op: 'object.convert', props: { target: 'CURVE' }, disabled: !app.selectedObjects().some((o) => o.type === 'MESH' || o.type === 'FONT' || o.type === 'CURVES') },
    { label: 'Curves', icon: 'outliner_ob_curves', op: 'object.convert', props: { target: 'CURVES' }, disabled: !app.selectedObjects().some((o) => o.type === 'CURVE') },
    { label: 'Point Cloud', icon: 'outliner_ob_pointcloud', op: 'object.convert', props: { target: 'POINTCLOUD' }, disabled: !app.selectedObjects().some((o) => o.type === 'MESH' || o.type === 'CURVE' || o.type === 'FONT') },
    { label: 'Grease Pencil', icon: 'outliner_ob_greasepencil', op: 'object.convert', props: { target: 'GREASEPENCIL' } },
    { separator: true },
    { label: 'Trace Image to Grease Pencil', op: 'grease_pencil.trace_image' },
  ];
}

function showHideMenu(): MenuItem[] {
  return [
    { label: 'Show Hidden Objects', op: 'object.hide_view_clear', shortcut: 'Alt H' },
    { separator: true },
    { label: 'Hide Selected', op: 'object.hide_view_set', props: { unselected: false }, shortcut: 'H' },
    { label: 'Hide Unselected', op: 'object.hide_view_set', props: { unselected: true }, shortcut: 'Shift H' },
  ];
}

function cleanUpMenu(): MenuItem[] {
  return [
    { label: 'Clean Vertex Group Weights', op: 'object.vertex_group_clean', props: { group_select_mode: 'ALL' } },
    { label: 'Limit Total Vertex Groups', op: 'object.vertex_group_limit_total' },
    { separator: true },
    { label: 'Remove Unused Material Slots', op: 'object.material_slot_remove_unused' },
    { label: 'Remove All Materials', op: 'object.material_slot_remove_all' },
  ];
}

export function objectMenu(): MenuItem[] {
  return [
    { label: 'Transform', submenu: transformMenu },
    { label: 'Set Origin', submenu: originMenu },
    { label: 'Mirror', submenu: mirrorMenu },
    { label: 'Clear', submenu: clearMenu },
    { label: 'Apply', shortcut: 'Ctrl A', submenu: applyMenu },
    { label: 'Snap', submenu: snapMenu, shortcut: 'Shift S' },
    { separator: true },
    { label: 'Duplicate Objects', op: 'object.duplicate_move', shortcut: 'Shift D' },
    { label: 'Duplicate Linked', op: 'object.duplicate_move_linked', shortcut: 'Alt D' },
    { label: 'Join', op: 'object.join', shortcut: 'Ctrl J' },
    { separator: true },
    { label: 'Copy Objects', op: 'view3d.copybuffer', shortcut: 'Ctrl C' },
    { label: 'Paste Objects', op: 'view3d.pastebuffer', shortcut: 'Ctrl V' },
    { separator: true },
    { label: 'Asset', submenu: () => objectAssetMenu() },
    { label: 'Collection', submenu: collectionMenu },
    { separator: true },
    { label: 'Library Override', submenu: libOverrideMenu },
    { label: 'Relations', submenu: relationsMenu },
    { label: 'Parent', submenu: parentMenu },
    { label: 'Modifiers', icon: 'modifier', submenu: modifiersMenu },
    { label: 'Constraints', icon: 'constraint', submenu: constraintsMenu },
    { label: 'Track', submenu: trackMenu },
    { label: 'Link/Transfer Data', submenu: linkDataMenu, shortcut: 'Ctrl L' },
    { separator: true },
    { label: 'Shade Smooth', op: 'object.shade_smooth' },
    { label: 'Shade Auto Smooth', op: 'object.shade_auto_smooth' },
    { label: 'Shade Flat', op: 'object.shade_flat' },
    { separator: true },
    { label: 'Animation', submenu: animationMenu },
    { label: 'Rigid Body', submenu: rigidBodyMenu },
    { separator: true },
    { label: 'Quick Effects', submenu: () => [{ label: 'Quick Fur', op: 'object.quick_fur' }, { label: 'Quick Explode', op: 'object.quick_explode' }, { label: 'Quick Smoke', op: 'object.quick_smoke' }, { label: 'Quick Liquid', op: 'object.quick_liquid' }] },
    { separator: true },
    { label: 'Convert', submenu: convertMenu },
    { separator: true },
    { label: 'Show/Hide', submenu: showHideMenu },
    { label: 'Clean Up', submenu: cleanUpMenu },
    { separator: true },
    { label: 'Delete', op: 'object.delete', props: { use_global: false }, shortcut: 'X' },
    { label: 'Delete Global', op: 'object.delete', props: { use_global: true }, shortcut: 'Shift X' },
  ];
}

/** Right click / W in Object Mode. */
/** Drag-to-adjust entries for a value of the selected objects' data. */
const adjust = (label: string, path: string, scale: number, header: string): MenuItem => ({ label, op: 'wm.context_modal_mouse', props: { data_path_iter: 'selected_editable_objects', data_path_item: path, input_scale: scale, header_text: header } });

/** The first entries of the object context menu, by the active object's type. */
function contextMenuHead(): MenuItem[] {
  const ob = app.activeObject;
  const t = ob?.type;
  if (t === 'LIGHT' && ob?.data) {
    const la = app.doc.lights[ob.data];
    return [
      adjust('Adjust Light Power', 'data.energy', 1, 'Light Power: %.3f W'),
      ...(la?.type === 'AREA' ? [] : [adjust('Adjust Light Radius', 'data.shadow_soft_size', 0.01, 'Light Radius: %.3f m')]),
      ...(la?.type === 'SPOT' ? [adjust('Adjust Spot Light Beam Angle', 'data.spot_size', 0.01, 'Spot Size: %.3f'), adjust('Adjust Spot Light Blend', 'data.spot_blend', 0.01, 'Spot Blend: %.3f')] : []),
      ...(la?.type === 'AREA' ? [adjust('Adjust Area Light Size', 'data.size', 0.01, 'Area Size: %.3f m')] : []),
      { label: 'Interactive Light Track', op: 'object.transform_axis_target', shortcut: 'Shift T' },
      { separator: true },
    ];
  }
  if (t === 'CAMERA' && ob?.data) {
    const ca = app.doc.cameras[ob.data];
    return [
      { label: 'Set Active Camera', op: 'view3d.object_as_camera' },
      ca?.type === 'ORTHO' ? adjust('Adjust Orthographic Scale', 'data.ortho_scale', 0.01, 'Orthographic Scale: %.3f') : adjust('Adjust Focal Length', 'data.lens', 0.1, 'Focal Length: %.1f mm'),
      ...(ca?.dof?.use_dof && !ca.dof.focus_object ? [adjust('Adjust Focus Distance', 'data.dof.focus_distance', 0.02, 'Focus Distance: %.3f m')] : []),
      { label: 'Interactive Camera Track', op: 'object.transform_axis_target', shortcut: 'Shift T' },
      { separator: true },
    ];
  }
  if (t === 'EMPTY') return [adjust('Adjust Empty Display Size', 'empty_display_size', 0.01, 'Empty Display Size: %.3f'), { separator: true }];
  return [
    { label: 'Shade Smooth', op: 'object.shade_smooth' },
    { label: 'Shade Auto Smooth', op: 'object.shade_auto_smooth' },
    { label: 'Shade Flat', op: 'object.shade_flat' },
    { separator: true },
    { label: 'Convert To', submenu: convertMenu },
    { label: 'Set Origin', submenu: originMenu },
    { separator: true },
  ];
}

export function objectModeContextMenu(): MenuItem[] {
  return [
    ...contextMenuHead(),
    { label: 'Copy Objects', op: 'view3d.copybuffer', shortcut: 'Ctrl C' },
    { label: 'Paste Objects', op: 'view3d.pastebuffer', shortcut: 'Ctrl V' },
    { separator: true },
    { label: 'Duplicate Objects', icon: 'duplicate', op: 'object.duplicate_move', shortcut: 'Shift D' },
    { label: 'Duplicate Linked', op: 'object.duplicate_move_linked', shortcut: 'Alt D' },
    { separator: true },
    { label: 'Rename Active Object…', op: 'object.rename', shortcut: 'F2' },
    { separator: true },
    { label: 'Mirror', submenu: mirrorMenu },
    { label: 'Snap', submenu: snapMenu },
    { label: 'Parent', submenu: parentMenu },
    { label: 'Move to Collection', submenu: moveToCollectionMenu },
    { separator: true },
    { label: 'Insert Keyframe', op: 'anim.keyframe_insert', shortcut: 'I' },
    { label: 'Insert Keyframe with Keying Set…', op: 'anim.keyframe_insert_menu', shortcut: 'K' },
    { separator: true },
    { label: 'Delete', op: 'object.delete', props: { use_global: false }, shortcut: 'X' },
  ];
}

export function selectMoreLessMenu(): MenuItem[] {
  return [
    { label: 'More', op: 'object.select_more', shortcut: 'Ctrl Numpad +' },
    { label: 'Less', op: 'object.select_less', shortcut: 'Ctrl Numpad -' },
    { separator: true },
    { label: 'Parent', op: 'object.select_hierarchy', props: { direction: 'PARENT', extend: false }, shortcut: '[' },
    { label: 'Child', op: 'object.select_hierarchy', props: { direction: 'CHILD', extend: false }, shortcut: ']' },
    { separator: true },
    { label: 'Extend Parent', op: 'object.select_hierarchy', props: { direction: 'PARENT', extend: true }, shortcut: 'Shift [' },
    { label: 'Extend Child', op: 'object.select_hierarchy', props: { direction: 'CHILD', extend: true }, shortcut: 'Shift ]' },
  ];
}

export function selectGroupedMenu(): MenuItem[] {
  const g = (label: string, type: string): MenuItem => ({ label, op: 'object.select_grouped', props: { type } });
  return [
    g('Children', 'CHILDREN_RECURSIVE'),
    g('Immediate Children', 'CHILDREN'),
    g('Parent', 'PARENT'),
    g('Siblings', 'SIBLINGS'),
    g('Type', 'TYPE'),
    g('Collection', 'COLLECTION'),
    g('Hook', 'HOOK'),
    g('Pass', 'PASS'),
    g('Color', 'COLOR'),
    g('Light Type', 'LIGHT_TYPE'),
  ];
}

export function selectLinkedMenu(): MenuItem[] {
  const l = (label: string, type: string): MenuItem => ({ label, op: 'object.select_linked', props: { type } });
  return [l('Object Data', 'OBDATA'), l('Material', 'MATERIAL'), l('Instanced Collection', 'DUPGROUP'), l('Particle System', 'PARTICLE')];
}

export function selectByTypeMenu(): MenuItem[] {
  return [
    ['MESH', 'Mesh', 'outliner_ob_mesh'],
    ['CURVE', 'Curve', 'outliner_ob_curve'],
    ['META', 'Metaball', 'outliner_ob_meta'],
    ['FONT', 'Text', 'outliner_ob_font'],
    ['CURVES', 'Curves', 'outliner_ob_curves'],
    ['ARMATURE', 'Armature', 'outliner_ob_armature'],
    ['LATTICE', 'Lattice', 'outliner_ob_lattice'],
    ['EMPTY', 'Empty', 'outliner_ob_empty'],
    ['CAMERA', 'Camera', 'outliner_ob_camera'],
    ['LIGHT', 'Light', 'outliner_ob_light'],
    ['LIGHT_PROBE', 'Light Probe', 'outliner_ob_lightprobe'],
    ['SPEAKER', 'Speaker', 'outliner_ob_speaker'],
  ].map(([t, l, i]) => ({ label: l, icon: i, op: 'object.select_by_type', props: { type: t } }));
}
