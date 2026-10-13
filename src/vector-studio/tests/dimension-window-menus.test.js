import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub, bootAppWithFeatures } from './helpers.js';
import { MENUS } from '../src/ui/menus.js';

beforeAll(() => installCanvasStub());

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ width: 200, height: 100 });
  ed.view.set({ width: 800, height: 600 });
  return { app, ed };
}

const menu = (label) => MENUS.find((m) => m.label === label).submenu;

describe('View > Rotate View', () => {
  it('offers every preset angle from 180 to -180 in order', async () => {
    const { app, ed } = await setup();
    const sub = menu('View').find((i) => i.label === 'Rotate View').submenu.filter((i) => i !== '-');
    const angles = sub.map((id) => Number(id.slice('view.rotate.'.length)));
    expect(angles).toEqual([180, 150, 135, 120, 90, 60, 45, 30, 15, 0, -15, -30, -45, -60, -90, -120, -135, -150, -180]);
    for (const id of sub) expect(app.commands.get(id), id).toBeTruthy();
    app.commands.run('view.rotate.-60');
    expect(ed.view.rotation).toBeCloseTo(300);
    expect(app.commands.isChecked('view.rotate.-60')).toBe(true);
    app.commands.run('view.rotate.120');
    expect(ed.view.rotation).toBeCloseTo(120);
    app.commands.run('view.rotate.-180');
    expect(ed.view.rotation).toBeCloseTo(180);
  });
});

describe('Window > Arrange', () => {
  it('lists cascade, tile, float, float all and consolidate', () => {
    const sub = menu('Window').find((i) => i.label === 'Arrange').submenu;
    expect(sub).toEqual(['window.arrange.cascade', 'window.arrange.tile', '-', 'window.arrange.float', 'window.arrange.floatAll', 'window.arrange.consolidate']);
  });

  it('cascades every document into offset floating windows with the active one in front', async () => {
    const { app, ed } = await setup();
    const ed2 = app.newDocument();
    const ed3 = app.newDocument();
    app.activate(ed);
    await app.commands.run('window.arrange.cascade');
    const hosts = [ed, ed2, ed3].map((e) => app.views.get(e).host);
    expect(hosts.every((h) => h.classList.contains('floating') && !h.hidden)).toBe(true);
    const lefts = new Set(hosts.map((h) => h.style.left));
    expect(lefts.size).toBe(3);
    expect(app.views.get(ed).host.style.zIndex).toBe('4');
    // The active document is cascaded last, so it sits at the front of the stack.
    expect(parseFloat(app.views.get(ed).host.style.left)).toBeGreaterThan(parseFloat(app.views.get(ed2).host.style.left));
    app.activate(ed2);
    expect(app.views.get(ed2).host.style.zIndex).toBe('4');
    expect(app.views.get(ed).host.style.zIndex).toBe('');
  });

  it('floats all windows, keeps a moved one in place, then consolidates into tabs', async () => {
    const { app, ed } = await setup();
    const ed2 = app.newDocument();
    await app.commands.run('window.arrange.float');
    const h2 = app.views.get(ed2).host;
    expect(h2.classList.contains('floating')).toBe(true);
    h2.style.left = '300px';
    expect(app.commands.isEnabled('window.arrange.floatAll')).toBe(true);
    await app.commands.run('window.arrange.floatAll');
    expect(app.views.get(ed).host.classList.contains('floating')).toBe(true);
    expect(h2.style.left).toBe('300px');
    expect(app.commands.isEnabled('window.arrange.floatAll')).toBe(false);
    expect(app.commands.isEnabled('window.arrange.consolidate')).toBe(true);
    await app.commands.run('window.arrange.consolidate');
    for (const e of [ed, ed2]) {
      const host = app.views.get(e).host;
      expect(host.classList.contains('floating')).toBe(false);
      expect(host.style.left).toBe('');
      expect(host.querySelector('.float-head')).toBe(null);
    }
    expect([...app.views.values()].filter((v) => !v.host.hidden).length).toBe(1);
    expect(app.commands.isEnabled('window.arrange.consolidate')).toBe(false);
  });

  it('tiles floating windows back into the grid', async () => {
    const { app } = await setup();
    app.newDocument();
    await app.commands.run('window.arrange.floatAll');
    await app.commands.run('window.arrange.tile');
    expect(app.canvasHost.classList.contains('arrange-tile')).toBe(true);
    expect([...app.views.values()].every((v) => !v.host.classList.contains('floating') && !v.host.hidden)).toBe(true);
    expect(app.commands.isChecked('window.arrange.tile')).toBe(true);
  });
});

describe('Window > Workspace', () => {
  it('offers the automation, getting started and printing workspaces in order', async () => {
    const { app } = await setup();
    const sub = menu('Window').find((i) => i.label === 'Workspace').submenu;
    expect(sub.slice(0, 8)).toEqual(['window.workspace.automation', 'window.workspace.essentials', 'window.workspace.classic', 'window.workspace.gettingStarted', 'window.workspace.layout', 'window.workspace.painting', 'window.workspace.printing', 'window.workspace.tracing']);
    await app.commands.run('window.workspace.printing');
    expect(app.commands.isChecked('window.workspace.printing')).toBe(true);
    expect(app.dock.getLayout().dock).toContain('layers');
    await app.commands.run('window.workspace.automation');
    expect(app.dock.getLayout().dock).toContain('actions');
    await app.commands.run('window.workspace.gettingStarted');
    expect(app.commands.isChecked('window.toolbar.basic')).toBe(true);
  });
});
