// Edit Workspaces: deleting one custom workspace and giving its name to another.
import { describe, it, expect } from 'vitest';

async function makeApp() {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const app = new App();
  installCore(app);
  app.syncGraph = () => {};
  return app;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const topDialog = () => [...document.querySelectorAll('.dialog')].pop();
const clickPrimary = () => topDialog().querySelector('.dialog-foot .btn.primary').click();

describe('Edit Workspaces', () => {
  it('keeps the layout of a workspace renamed to a name deleted in the same session', async () => {
    const app = await makeApp();
    app.layoutMode = 'desktop';
    app.dock = { layout: () => ({}), setLayout() {} };
    const mineA = { t: 'group', tabs: ['files'], a: 'files' };
    const mineB = { t: 'group', tabs: ['history'], a: 'history' };
    app.prefs.set('customWorkspaces', { A: mineA, B: mineB });
    app.prefs.set('layouts', {
      A: { t: 'group', tabs: ['files', 'markers'], a: 'markers' },
      B: mineB,
    });
    app.prefs.set('workspace', 'A');
    const done = app.commands.run('workspace.edit');
    const dialog = document.querySelector('.ws-dialog');
    const row = (n) => dialog.querySelector(`.ws-row[data-name="${n}"]`);
    const button = (text) =>
      [...dialog.querySelectorAll('.dialog-foot button')].find((b) =>
        b.textContent.startsWith(text),
      );
    // Delete B ...
    row('B').click();
    button('Delete').click();
    await tick();
    topDialog().querySelector('.dialog-foot .btn.danger').click();
    await tick();
    // ... then rename A (the current workspace) to B.
    row('A').click();
    button('Rename').click();
    await tick();
    const input = topDialog().querySelector('input');
    input.value = 'B';
    clickPrimary();
    await tick();
    await tick();
    expect(row('B')).not.toBe(null);
    dialog.closest('.dialog').querySelector('.dialog-foot .btn.primary').click();
    await done;
    expect(app.prefs.get('workspace')).toBe('B');
    expect(app.prefs.get('customWorkspaces')).toEqual({ B: mineA });
    // A's arranged layout carried over to its new name.
    expect(app.prefs.get('layouts').B).toEqual({
      t: 'group',
      tabs: ['files', 'markers'],
      a: 'markers',
    });
  });
});
