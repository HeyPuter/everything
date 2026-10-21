// The Workspace panel (tool settings sidebars): pin scene and the object mode the workspace
// switches to when it is activated.
import { h, type VNode } from './h';
import { checkbox, enumMenu, panel } from './widgets';
import { splitRow } from './props';
import { app } from '../app/app';
import { shellRef } from './shellref';
import { WORKSPACE_MODES, setWorkspaceMode } from './workspacemodes';

export { WORKSPACE_MODES, setWorkspaceMode };
import type { Workspace } from './screen';

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

/** More rows of the Workspace panel (e.g. the add-on filter, from the Preferences module). */
export const workspacePanelExtras: ((idPrefix: string) => VNode | null)[] = [];

/** The Workspace panel. */
export function workspacePanel(id = 'sb-workspace', opts: { closed?: boolean } = {}): VNode {
  return panel(id, 'Workspace', () => h('div', { class: 'ws-panel' }, workspaceRows(id), workspacePanelExtras.map((f) => f(id))), opts);
}
