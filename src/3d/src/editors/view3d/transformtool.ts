// Settings of the Move / Rotate / Scale / Transform tools: the orientation of each gizmo (an
// own orientation or the scene's "Default") and what dragging in empty space does (Tweak or one
// of the selection shapes). Both are stored on the scene.
import { app } from '../../app/app';
import type { SceneData } from '../../data/types';

export type GizmoKind = 'move' | 'rotate' | 'scale';
export type DragAction = 'TWEAK' | 'SELECT_BOX' | 'SELECT_CIRCLE' | 'SELECT_LASSO';

type SceneExt = SceneData & {
  /** orientation of the move / rotate / scale gizmos ('DEFAULT' follows the header orientation) */
  transform_orientation_slots?: Partial<Record<GizmoKind, string>>;
  /** drag action of the transform tools, by tool id */
  transform_tool_drag?: Record<string, DragAction>;
};

const scene = () => app.doc.scene as SceneExt;

export const TOOL_KIND: Record<string, GizmoKind> = { 'builtin.move': 'move', 'builtin.rotate': 'rotate', 'builtin.scale': 'scale', 'builtin.scale_cage': 'scale', 'builtin.transform': 'move' };

/** Orientation slot value of a gizmo ('DEFAULT' or an orientation id / custom name). */
export function gizmoOrientationSlot(kind: GizmoKind): string {
  return scene().transform_orientation_slots?.[kind] ?? 'DEFAULT';
}

export function setGizmoOrientationSlot(kind: GizmoKind, value: string) {
  const s = scene();
  s.transform_orientation_slots = { ...(s.transform_orientation_slots ?? {}), [kind]: value };
  app.pushUndo('Transform Orientation');
  app.changed('ui', 'doc');
}

/** What dragging in empty space does with a transform tool. */
export function toolDragAction(toolId: string): DragAction {
  return scene().transform_tool_drag?.[toolId] ?? 'SELECT_BOX';
}

export function setToolDragAction(toolId: string, a: DragAction) {
  const s = scene();
  s.transform_tool_drag = { ...(s.transform_tool_drag ?? {}), [toolId]: a };
  app.changed('ui');
}

export const DRAG_ACTIONS: [DragAction, string, string][] = [
  ['TWEAK', 'Tweak', 'select_tweak'],
  ['SELECT_BOX', 'Select Box', 'select_box'],
  ['SELECT_CIRCLE', 'Select Circle', 'select_circle'],
  ['SELECT_LASSO', 'Select Lasso', 'select_lasso'],
];
