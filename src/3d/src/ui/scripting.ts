// Scripting access to the window manager: `bpy.context.workspace` (name, object_mode,
// use_pin_scene, use_filter_by_owner), live on the active workspace tab.
import { app, onAppReady } from '../app/app';
import { Context } from '../scripting/api';
import { mixin, pyError } from '../scripting/rna';
import { shellRef } from './shellref';
import { WORKSPACE_MODES, setWorkspaceMode } from './workspacemodes';
import type { Workspace } from './screen';

/** A workspace as scripts see it (live: reads and writes go to the workspace tab). */
export class WorkspaceWrapper {
  readonly __kind = 'struct';
  readonly __type = 'WorkSpace';
  constructor(private ws: Workspace) {}
  get name() {
    return this.ws.name;
  }
  set name(v: string) {
    const sh = shellRef.current as (typeof shellRef.current & { renameWorkspace?(a: string, b: string): void }) | null;
    if (!sh?.renameWorkspace || !v) return;
    sh.renameWorkspace(this.ws.name, String(v));
  }
  get object_mode() {
    return this.ws.mode ?? 'OBJECT';
  }
  set object_mode(v: string) {
    if (!WORKSPACE_MODES.some(([m]) => m === v)) throw pyError('TypeError', `bpy_struct: item.attr = val: enum "${v}" not found in (${WORKSPACE_MODES.map(([m]) => `'${m}'`).join(', ')})`);
    setWorkspaceMode(v as Workspace['mode'], this.ws.name);
  }
  get use_pin_scene() {
    return !!this.ws.pinScene;
  }
  set use_pin_scene(v: boolean) {
    if (!!v !== !!this.ws.pinScene) app.run('workspace.scene_pin_toggle', { name: this.ws.name });
  }
  get use_filter_by_owner() {
    return !!this.ws.use_filter_by_owner;
  }
  set use_filter_by_owner(v: boolean) {
    this.ws.use_filter_by_owner = !!v;
    app.changed('ui');
  }
}

class WorkspaceContext {
  get workspace() {
    const sh = shellRef.current;
    const ws = sh?.workspaces.find((w) => w.name === sh.active);
    return ws ? new WorkspaceWrapper(ws) : null;
  }
}

// after the other context members are in place
onAppReady(() => mixin(Context, WorkspaceContext, true));
