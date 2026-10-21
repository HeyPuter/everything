// Specials (dropdown) menus of the Object Data lists: vertex groups, shape keys, material slots.
import type { MenuItem } from '../ui/menu';

export function vertexGroupSpecials(): MenuItem[] {
  return [
    { label: 'Sort by Name', op: 'object.vertex_group_sort', props: { sort_type: 'NAME' } },
    { label: 'Sort by Bone Hierarchy', icon: 'bone_data', op: 'object.vertex_group_sort', props: { sort_type: 'BONE_HIERARCHY' } },
    { separator: true },
    { label: 'Copy Vertex Group', icon: 'duplicate', op: 'object.vertex_group_copy' },
    { label: 'Copy Vertex Groups to Selected', op: 'object.vertex_group_copy_to_selected' },
    { separator: true },
    { label: 'Mirror Vertex Group', icon: 'mod_mirror', op: 'object.vertex_group_mirror', props: { use_topology: false } },
    { label: 'Mirror Vertex Group (Topology)', op: 'object.vertex_group_mirror', props: { use_topology: true } },
    { separator: true },
    { label: 'Remove from All Groups', icon: 'x', op: 'object.vertex_group_remove_from', props: { use_all_groups: true, use_all_verts: false } },
    { label: 'Clear Active Group', op: 'object.vertex_group_remove_from', props: { use_all_groups: false, use_all_verts: true } },
    { label: 'Delete All Unlocked Groups', op: 'object.vertex_group_remove', props: { all: false, all_unlocked: true } },
    { label: 'Delete All Groups', op: 'object.vertex_group_remove', props: { all: true, all_unlocked: false } },
    { separator: true },
    { label: 'Lock All', icon: 'locked', op: 'object.vertex_group_lock', props: { action: 'LOCK', mask: 'ALL' } },
    { label: 'Unlock All', icon: 'unlocked', op: 'object.vertex_group_lock', props: { action: 'UNLOCK', mask: 'ALL' } },
    { label: 'Lock Invert All', op: 'object.vertex_group_lock', props: { action: 'INVERT', mask: 'ALL' } },
    { separator: true },
    { label: 'Normalize All', op: 'object.vertex_group_normalize_all' },
    { label: 'Levels', op: 'object.vertex_group_levels' },
    { label: 'Quantize', op: 'object.vertex_group_quantize' },
  ];
}

export function shapeKeySpecials(): MenuItem[] {
  return [
    { label: 'New Shape from Mix', icon: 'add', op: 'object.shape_key_add', props: { from_mix: true } },
    { label: 'Duplicate Shape Key', icon: 'duplicate', op: 'object.shape_key_copy' },
    { label: 'Copy Shape Key from Selected', op: 'object.shape_key_transfer' },
    { label: 'Clear Shape Key Values', op: 'object.shape_key_clear' },
    { label: 'Re-Time Shape Keys', op: 'object.shape_key_retime' },
    { separator: true },
    { label: 'New from Objects', op: 'object.join_shapes', props: { use_mirror: false } },
    { label: 'New from Objects Flipped', op: 'object.join_shapes', props: { use_mirror: true } },
    { label: 'Update from Objects', op: 'object.update_shapes', props: { use_mirror: false } },
    { label: 'Update from Objects Flipped', op: 'object.update_shapes', props: { use_mirror: true } },
    { separator: true },
    { label: 'Mirror Shape Key', icon: 'mod_mirror', op: 'object.shape_key_mirror', props: { use_topology: false } },
    { label: 'Mirror Shape Key (Topology)', op: 'object.shape_key_mirror', props: { use_topology: true } },
    { separator: true },
    { label: 'Move After Basis', op: 'object.shape_key_move', props: { type: 'TOP' } },
    { label: 'Move to Last', op: 'object.shape_key_move', props: { type: 'BOTTOM' } },
    { separator: true },
    { label: 'Lock All', icon: 'locked', op: 'object.shape_key_lock', props: { action: 'LOCK' } },
    { label: 'Unlock All', icon: 'unlocked', op: 'object.shape_key_lock', props: { action: 'UNLOCK' } },
    { separator: true },
    { label: 'Make Basis', op: 'object.shape_key_make_basis' },
    { label: 'Apply to Basis', op: 'object.shape_key_apply_to_basis' },
    { separator: true },
    { label: 'Apply All Shape Keys', op: 'object.shape_key_remove', props: { all: true, apply_mix: true } },
    { label: 'Delete All Shape Keys', icon: 'x', op: 'object.shape_key_remove', props: { all: true, apply_mix: false } },
  ];
}

export function materialSpecials(): MenuItem[] {
  return [
    { label: 'Copy Material', op: 'material.copy' },
    { label: 'Copy Material to Selected', op: 'object.material_slot_copy' },
    { label: 'Paste Material', op: 'material.paste' },
    { separator: true },
    { label: 'Remove Unused Slots', op: 'object.material_slot_remove_unused' },
    { label: 'Remove All Materials', icon: 'x', op: 'object.material_slot_remove_all' },
  ];
}
