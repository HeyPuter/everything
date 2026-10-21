// Object modes of workspaces (DOM-free: shared by the Workspace panel and the scripting API).
import { app } from '../app/app';
import { shellRef } from './shellref';
import type { Workspace } from './screen';

/** Object modes a workspace can switch to when activated. */
export const WORKSPACE_MODES: [NonNullable<Workspace['mode']>, string][] = [
  ['OBJECT', 'Object Mode'],
  ['EDIT', 'Edit Mode'],
  ['SCULPT', 'Sculpt Mode'],
  ['VERTEX_PAINT', 'Vertex Paint'],
  ['WEIGHT_PAINT', 'Weight Paint'],
  ['TEXTURE_PAINT', 'Texture Paint'],
  ['POSE', 'Pose Mode'],
  ['PAINT_GREASE_PENCIL', 'Draw Mode'],
];

/** Set the mode the active (or named) workspace switches to. */
export function setWorkspaceMode(mode: Workspace['mode'], name = shellRef.current?.active) {
  const ws = shellRef.current?.workspaces.find((w) => w.name === name);
  if (!ws) return false;
  ws.mode = mode === 'OBJECT' ? undefined : mode;
  app.changed('ui');
  return true;
}
