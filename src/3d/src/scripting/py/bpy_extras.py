"""``bpy_extras`` subset: ``object_utils.world_to_camera_view`` and the ``anim_utils`` channelbag helpers."""

import types

import mathutils


def world_to_camera_view(scene, obj, coord):
    """Where a world-space point falls in the camera's frame: x and y from 0 to 1
    (bottom left to top right), z the distance in front of the camera."""
    co_local = obj.matrix_world.normalized().inverted() @ mathutils.Vector(coord)
    z = -co_local.z
    camera = obj.data
    frame = [v for v in camera.view_frame(scene=scene)[:3]]
    if camera.type != 'ORTHO':
        if z == 0.0:
            return mathutils.Vector((0.5, 0.5, 0.0))
        frame = [-(v / (v.z / z)) for v in frame]
    min_x, max_x = frame[2].x, frame[1].x
    min_y, max_y = frame[1].y, frame[0].y
    x = (co_local.x - min_x) / (max_x - min_x)
    y = (co_local.y - min_y) / (max_y - min_y)
    return mathutils.Vector((x, y, z))


object_utils = types.ModuleType("bpy_extras.object_utils")
object_utils.world_to_camera_view = world_to_camera_view


def action_get_channelbag_for_slot(action, slot):
    """The channelbag (F-curves) of an action's slot, or None."""
    if action is None:
        return None
    for layer in action.layers:
        for strip in layer.strips:
            return strip.channelbag(slot)
    return None


def action_ensure_channelbag_for_slot(action, slot):
    """Like action_get_channelbag_for_slot: every action here has its channelbag already."""
    return action_get_channelbag_for_slot(action, slot)


anim_utils = types.ModuleType("bpy_extras.anim_utils")
anim_utils.action_get_channelbag_for_slot = action_get_channelbag_for_slot
anim_utils.action_ensure_channelbag_for_slot = action_ensure_channelbag_for_slot
