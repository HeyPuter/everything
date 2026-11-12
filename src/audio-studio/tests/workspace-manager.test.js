// Edit Workspaces: toolbar, overflow menu and Window-menu-only groups.
import { describe, it, expect } from 'vitest';
import { moveWorkspace, placeWorkspace, workspaceGroups } from '../src/ui/workspace-manager.js';

async function makeApp() {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { FEATURES } = await import('../src/features.js');
  const app = new App();
  for (const install of FEATURES) install(app);
  app.syncGraph = () => {};
  return app;
}

describe('workspace groups', () => {
  const groups = { bar: ['A', 'B'], overflow: ['C'], hidden: [] };

  it('moves within a group and across group edges', () => {
    expect(moveWorkspace(groups, 'B', -1)).toEqual({ bar: ['B', 'A'], overflow: ['C'], hidden: [] });
    expect(moveWorkspace(groups, 'B', 1)).toEqual({ bar: ['A'], overflow: ['B', 'C'], hidden: [] });
    expect(moveWorkspace(groups, 'C', 1)).toEqual({ bar: ['A', 'B'], overflow: [], hidden: ['C'] });
    expect(moveWorkspace(groups, 'A', -1)).toBe(groups);
  });

  it('places a dragged workspace before another or at the end of a group', () => {
    expect(placeWorkspace(groups, 'C', 'bar', 'A')).toEqual({ bar: ['C', 'A', 'B'], overflow: [], hidden: [] });
    expect(placeWorkspace(groups, 'A', 'hidden')).toEqual({ bar: ['B'], overflow: ['C'], hidden: ['A'] });
  });

  it('reads groups from preferences and leaves hidden ones out of the overflow menu', async () => {
    const app = await makeApp();
    // The current workspace always stays reachable, so test with others.
    const all = app.workspaceNames().filter((n) => n !== app.prefs.get('workspace'));
    app.prefs.set('workspaceTabs', [all[0]]);
    app.prefs.set('workspaceHidden', [all[2]]);
    const g = workspaceGroups(app);
    expect(g.bar).toEqual([all[0]]);
    expect(g.hidden).toEqual([all[2]]);
    expect(g.overflow).toContain(all[1]);
    const labels = (items) => items.filter((i) => i.type === 'cmd').map((i) => i.label);
    expect(labels(app.workspaceMenuItems({ overflow: true }))).not.toContain(all[2]);
    expect(labels(app.workspaceMenuItems())).toContain(all[2]);
  });

  it('saves the groups from the dialog', async () => {
    const app = await makeApp();
    // A desktop layout without a real dock.
    app.layoutMode = 'desktop';
    app.dock = { layout: () => ({}) };
    app.setWorkspace = () => {};
    const done = app.commands.run('workspace.edit');
    const dialog = document.querySelector('.ws-dialog');
    const rows = () => [...dialog.querySelectorAll('.ws-row')];
    expect(dialog.querySelectorAll('.ws-group').length).toBe(3);
    // The last toolbar workspace moves down into the overflow menu.
    const last = workspaceGroups(app).bar.length - 1;
    const name = rows()[last].dataset.name;
    rows()[last].click();
    const down = dialog.querySelector('[aria-label="Move down"]');
    down.click();
    dialog.querySelector('.dialog-foot .btn.primary').click();
    await done;
    expect(app.prefs.get('workspaceTabs')).not.toContain(name);
    expect(workspaceGroups(app).overflow[0]).toBe(name);
  });

  it('tells screen readers which workspace is selected in the list', async () => {
    const app = await makeApp();
    app.layoutMode = 'desktop';
    app.dock = { layout: () => ({}) };
    app.setWorkspace = () => {};
    const done = app.commands.run('workspace.edit');
    const list = document.querySelector('.ws-dialog [role=listbox]');
    const active = () => document.getElementById(list.getAttribute('aria-activedescendant'));
    expect(active().dataset.name).toBe(app.prefs.get('workspace'));
    list.focus();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(active().getAttribute('aria-selected')).toBe('true');
    expect(active().dataset.name).not.toBe(app.prefs.get('workspace'));
    const buttons = [...document.querySelectorAll('.ws-dialog .dialog-foot .btn')];
    buttons.find((b) => b.textContent === 'Cancel').click();
    await done;
  });
});
