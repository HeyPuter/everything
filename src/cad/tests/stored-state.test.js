// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { DEFAULT_SETTINGS } from '../src/editor/editor.js';
import { buildRegistry } from '../src/editor/commands/index.js';

vi.mock('../src/io/storage.js', () => ({ recovery: {} }));
const { App } = await import('../src/app.js');

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});
afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  delete globalThis.puter;
});

/** Stored interface state from another version, or damaged, must not keep the app from starting. */
describe('stored interface state the app cannot use', () => {
  it('settings of the wrong kind fall back to their defaults', () => {
    localStorage.setItem('cad.settings', JSON.stringify({ osnapModes: 5, gridSpacing: 'x', pickbox: null, polarInc: 45, snap: true }));
    const { settings } = new App(document.body);
    expect(settings.osnapModes).toEqual(DEFAULT_SETTINGS.osnapModes);
    expect(settings.gridSpacing).toBe(DEFAULT_SETTINGS.gridSpacing);
    expect(settings.pickbox).toBe(DEFAULT_SETTINGS.pickbox);
    expect(settings.polarInc).toBe(45);
    expect(settings.snap).toBe(true);
  });

  it('settings synced from the account are checked the same way', async () => {
    const app = new App(document.body);
    app.applySettings = () => {};
    app.setTheme = vi.fn();
    globalThis.puter = { kv: { get: async () => ({ osnapModes: 'all', polarInc: 30, theme: 7 }) } };
    await app.syncSettingsFromCloud();
    expect(app.settings.osnapModes).toEqual(DEFAULT_SETTINGS.osnapModes);
    expect(app.settings.polarInc).toBe(30);
    expect(app.setTheme).not.toHaveBeenCalled();
  });

  it('palettes this version does not have are not reopened', () => {
    const dock = () => {
      const app = Object.create(App.prototype);
      const div = () => document.createElement('div');
      app.shell = { dock: div(), dockResize: div(), workspace: div() };
      app.editor = { drawOverlay() {} };
      app.bindDock();
      return app;
    };
    localStorage.setItem('cad.dock', JSON.stringify({ open: ['sheets', 'layers'], active: 'sheets' }));
    let app = dock();
    expect([...app.dockOpen]).toEqual(['layers']);
    expect(app.dockActive).toBe(null);
    localStorage.setItem('cad.dock', JSON.stringify({ open: 5, active: 'layers' }));
    app = dock();
    expect([...app.dockOpen]).toEqual([]);
    expect(app.dockActive).toBe('layers');
  });

  it('ribbon button choices that are not a variant number are ignored', async () => {
    localStorage.setItem('cad.ribbonChoices', JSON.stringify({ CIRCLE: 'x', ARC: -1, RECTANG: 1.5, LINE: 99 }));
    vi.resetModules();
    const { Ribbon } = await import('../src/ui/ribbon.js');
    const app = { commands: buildRegistry(), settings: { ...DEFAULT_SETTINGS }, themePref: 'system', doc: null, run() {} };
    const rb = new Ribbon(app);
    expect(rb.el.querySelectorAll('.rb-lg').length).toBeGreaterThan(3);
    localStorage.setItem('cad.ribbonChoices', 'null');
    expect(() => new Ribbon(app)).not.toThrow();
  });

  it('a damaged record of collapsed Properties sections is ignored', async () => {
    localStorage.setItem('cad.propsCollapsed', 'null');
    const { PropertiesPalette } = await import('../src/ui/properties.js');
    const p = new PropertiesPalette({ doc: { drawing: new Drawing(), selection: new Set() }, camera: { cx: 0, cy: 0, width: 1, height: 1, scale: 1 }, run() {} });
    document.body.append(p.el);
    expect(() => p.render()).not.toThrow();
    expect(p.el.querySelectorAll('.props-sec').length).toBe(2);
  });
});
