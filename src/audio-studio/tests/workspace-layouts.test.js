// Saved workspace layouts that are missing or damaged (old versions, imported
// settings files) must still give a usable workspace with the editor.
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

async function shellWith(stored) {
  localStorage.clear();
  localStorage.setItem('audio-studio:prefs', JSON.stringify(stored));
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const { createShell } = await import('../src/ui/shell.js');
  const { LAYOUT_VERSION } = await import('../src/ui/workspaces.js');
  const app = new App();
  installCore(app);
  app.syncGraph = () => {};
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
  createShell(app, root);
  return { app, LAYOUT_VERSION };
}

describe('damaged saved layouts', () => {
  it('starts with the built-in layout when the saved layouts are null', async () => {
    const { app } = await shellWith({ layoutVersion: 2, layouts: null, workspace: 'Default' });
    expect(app.dock.isVisible('editor')).toBe(true);
    expect(app.dock.groups().length).toBeGreaterThan(3);
    // Moving panels saves the layout again.
    app.dock.openPanel('zoom', { focus: false });
    expect(app.prefs.get('layouts').Default).toBeTruthy();
  });

  it('keeps the editor when a saved layout has lost it', async () => {
    const { app } = await shellWith({
      layoutVersion: 2,
      workspace: 'Mine',
      customWorkspaces: { Mine: { t: 'group', tabs: ['files'], a: 'files' } },
      layouts: { Mine: { t: 'row' } },
    });
    expect(app.dock.isOpen('editor')).toBe(true);
  });
});
