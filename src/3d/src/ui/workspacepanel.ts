// The Workspace panel (tool settings sidebars): pin scene and the object mode the workspace
// switches to when it is activated.
import { h, type VNode } from './h';
import { checkbox, enumMenu, panel } from './widgets';
import { splitRow } from './props';
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

/** Workspace settings rows for the active workspace. */
export function workspaceRows(idPrefix = 'ws'): VNode[] {
  const sh = shellRef.current;
  const ws = sh?.workspaces.find((w) => w.name === sh.active);
  if (!ws) return [];
  return [
    splitRow('', checkbox(`${idPrefix}-pin`, 'Pin Scene', !!ws.pinScene, () => app.run('workspace.scene_pin_toggle', { name: ws.name }), { tip: 'Pin Scene\nRemember the scene used in this workspace and switch back to it whenever the workspace is activated' })),
    splitRow(
      'Mode',
      enumMenu(
        `${idPrefix}-mode`,
        WORKSPACE_MODES.map(([value, label]) => ({ value, label })),
        ws.mode ?? 'OBJECT',
        (v) => setWorkspaceMode(v as Workspace['mode'], ws.name),
        { tip: 'Mode\nThe object mode this workspace switches to when it is activated' },
      ),
    ),
  ];
}

/** The Workspace panel. */
export function workspacePanel(id = 'sb-workspace', opts: { closed?: boolean } = {}): VNode {
  return panel(id, 'Workspace', () => h('div', { class: 'ws-panel' }, workspaceRows(id)), opts);
}
