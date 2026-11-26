// Floating, docking and collapsing panels; moving the Tools panel and the
// panel dock; the arrangement saved in workspaces and kept across sessions.
import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { App } from '../src/app.js';
import { Prefs } from '../src/prefs.js';
import { captureWorkspace, applyWorkspace } from '../src/features/workspace/window.js';

beforeAll(() => installCanvasStub());

async function boot(store = new Map()) {
  const { installFeatures } = await import('../src/features.js');
  document.body.innerHTML = '<div id="app" class="app"></div><div id="live-region" aria-live="polite"></div>';
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const app = new App(document.getElementById('app'), { prefs: new Prefs(storage), env: 'web', onSignOut: () => {} });
  installFeatures(app);
  app.start();
  return app;
}

/** Give an element a layout box (jsdom has none). */
function box(el, left, top, width, height) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
}

function pointer(target, type, x, y, pointerType = 'mouse') {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  target.dispatchEvent(e);
  return e;
}

/** A drag from `target` through `points`, released at the last one. */
function drag(target, [x0, y0], ...points) {
  pointer(target, 'pointerdown', x0, y0);
  for (const [x, y] of points) pointer(target.isConnected ? target : document.body, 'pointermove', x, y);
  const [x, y] = points.at(-1);
  pointer(document.body, 'pointerup', x, y);
}

/** Lay out the dock head, tabs and strip as on a 1280 x 800 screen. */
function layoutChrome(app) {
  const head = app.dock.el.querySelector('.dock-head');
  box(head, 976, 40, 304, 34);
  [...app.dock.el.querySelectorAll('.dock-tab')].forEach((t, i) => box(t, 984 + i * 80, 40, 76, 34));
  box(app.dock.el.querySelector('.panel-strip'), 936, 40, 40, 700);
  box(app.dock.floatLayer, 52, 40, 884, 740);
}

const menuItems = () => [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')];
const runMenuItem = (label) => menuItems().find((i) => i.textContent.trim() === label).click();

describe('floating panels', () => {
  it('floats a dock tab from its panel menu, then docks it again', async () => {
    const app = await boot();
    expect(app.dock.getLayout().dock).toEqual(['properties', 'layers']);
    app.dock.showTab('layers');
    document.querySelector('.dock-head .panel-menu-btn').click();
    expect(menuItems().map((i) => i.textContent.trim())).toEqual(expect.arrayContaining(['Float Panel', 'Collapse to Icon']));
    runMenuItem('Float Panel');
    const layout = app.dock.getLayout();
    expect(layout.dock).toEqual(['properties']);
    expect(layout.floating.map((f) => f.id)).toEqual(['layers']);
    expect(layout.active).toBe('properties');
    const win = app.dock.floatLayer.querySelector('.float-panel[data-panel="layers"]');
    expect(win.getAttribute('role')).toBe('dialog');
    expect(win.contains(app.dock.panels.get('layers').el)).toBe(true);
    expect(app.dock.panels.get('layers').visible).toBe(true);
    expect(app.dock.isOpen('layers')).toBe(true);
    // The last dock tab cannot float or collapse (the dock keeps one tab).
    document.querySelector('.dock-head .panel-menu-btn').click();
    expect(menuItems().find((i) => i.textContent.trim() === 'Float Panel').getAttribute('aria-disabled')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.dock.floatPanel('properties')).toBeNull();
    // Dock as Tab from the floating window's menu.
    win.querySelector('.panel-menu-btn').click();
    runMenuItem('Dock as Tab');
    expect(app.dock.getLayout()).toMatchObject({ dock: ['properties', 'layers'], active: 'layers', floating: [] });
    expect(win.isConnected).toBe(false);
  });

  it('tears a panel off the strip by dragging, moves it, and docks it on the tabs', async () => {
    const app = await boot();
    layoutChrome(app);
    const btn = app.dock.el.querySelector('.strip-btn[data-panel="color"]');
    box(btn, 940, 100, 32, 30);
    // A short wobble is still a click.
    pointer(btn, 'pointerdown', 950, 110);
    pointer(btn, 'pointermove', 952, 111);
    pointer(btn, 'pointerup', 952, 111);
    expect(app.dock.placeOf('color')).toBe('strip');
    // Dragging out over the canvas floats it under the pointer.
    drag(btn, [950, 110], [900, 120], [600, 300]);
    expect(app.dock.placeOf('color')).toBe('float');
    const f = app.dock.getLayout().floating[0];
    expect(f.id).toBe('color');
    expect(f.x).toBe(600 - 52 - 60);
    expect(f.y).toBe(300 - 40 - 14);
    expect(app.dock.el.querySelector('.strip-btn[data-panel="color"]')).toBeNull();
    // The click that ends the drag does not toggle anything.
    expect(app.dock.flyoutId).toBe(null);
    // Move it by its header.
    const win = app.dock.floatLayer.querySelector('.float-panel');
    const head = win.querySelector('.float-panel-head');
    box(win, 52 + f.x, 40 + f.y, f.w, 200);
    drag(head, [52 + f.x + 100, 40 + f.y + 10], [52 + f.x + 150, 40 + f.y + 40]);
    expect(app.dock.getLayout().floating[0]).toMatchObject({ x: f.x + 50, y: f.y + 30 });
    // Dropping the header on the tabs (between Properties and Layers) docks it there.
    box(win, 52 + f.x + 50, 40 + f.y + 30, f.w, 200);
    drag(head, [52 + f.x + 150, 40 + f.y + 40], [1040, 60], [1066, 56]);
    expect(app.dock.getLayout()).toMatchObject({ dock: ['properties', 'color', 'layers'], active: 'color', floating: [] });
    expect(app.dock.el.querySelector('.dock-head').classList.contains('drop-target')).toBe(false);
  });

  it('highlights the drop target while dragging and collapses to the strip on drop', async () => {
    const app = await boot();
    layoutChrome(app);
    app.dock.floatPanel('swatches', { x: 100, y: 100 });
    const win = app.dock.floatLayer.querySelector('.float-panel');
    const head = win.querySelector('.float-panel-head');
    box(win, 152, 140, 280, 200);
    pointer(head, 'pointerdown', 200, 150);
    pointer(head, 'pointermove', 950, 300);
    expect(app.dock.el.querySelector('.panel-strip').classList.contains('drop-target')).toBe(true);
    expect(win.classList.contains('dropping')).toBe(true);
    pointer(document.body, 'pointerup', 950, 300);
    expect(app.dock.placeOf('swatches')).toBe('strip');
    expect(app.dock.el.querySelector('.panel-strip').classList.contains('drop-target')).toBe(false);
    expect(app.dock.el.querySelector('.strip-btn[data-panel="swatches"]')).toBeTruthy();
  });

  it('reorders dock tabs by dragging along them, with a touch drag', async () => {
    const app = await boot();
    app.dock.dockPanel('color');
    layoutChrome(app);
    expect(app.dock.getLayout().dock).toEqual(['properties', 'layers', 'color']);
    const tab = app.dock.el.querySelector('#tab-color');
    pointer(tab, 'pointerdown', 1190, 56, 'touch');
    pointer(tab, 'pointermove', 1185, 56, 'touch'); // under the touch threshold
    expect(app.dock.getLayout().dock).toEqual(['properties', 'layers', 'color']);
    pointer(tab, 'pointermove', 1000, 56, 'touch');
    pointer(document.body, 'pointerup', 1000, 56, 'touch');
    expect(app.dock.getLayout().dock).toEqual(['color', 'properties', 'layers']);
    expect([...app.dock.el.querySelectorAll('.dock-tab')].map((t) => t.textContent)).toEqual(['Color', 'Properties', 'Layers']);
  });

  it('resizes a floating panel from its corner and closes it; the Window menu opens it where it was', async () => {
    const app = await boot();
    layoutChrome(app);
    app.dock.floatPanel('stroke', { x: 40, y: 50, w: 260 });
    const win = app.dock.floatLayer.querySelector('.float-panel');
    Object.defineProperty(win, 'offsetHeight', { value: 180, configurable: true });
    drag(win.querySelector('.float-panel-resize'), [400, 300], [460, 380]);
    expect(app.dock.getLayout().floating[0]).toMatchObject({ x: 40, y: 50, w: 320, h: 260 });
    await new Promise((r) => setTimeout(r, 0)); // past the click that ends a drag
    win.querySelector('[aria-label="Close Stroke"]').click();
    expect(app.dock.placeOf('stroke')).toBe(null);
    expect(app.dock.isOpen('stroke')).toBe(false);
    await app.commands.run('panel.stroke');
    expect(app.dock.getLayout().floating[0]).toMatchObject({ id: 'stroke', x: 40, y: 50, w: 320, h: 260 });
  });

  it('keeps a floating panel header on screen', async () => {
    const app = await boot();
    layoutChrome(app);
    app.dock.floatPanel('align', { x: 5000, y: -300, w: 99999 });
    const f = app.dock.getLayout().floating[0];
    expect(f.w).toBe(884);
    expect(f.x).toBeLessThanOrEqual(884 - 48);
    expect(f.y).toBe(0);
  });
});

describe('Tools panel and panel dock positions', () => {
  it('docks the Tools panel right, floats it and docks the panels left from the Window menu', async () => {
    const app = await boot();
    expect(app.root.classList.contains('tools-right')).toBe(false);
    await app.commands.run('window.tools.right');
    expect(app.root.classList.contains('tools-right')).toBe(true);
    expect(app.commands.isChecked('window.tools.right')).toBe(true);
    await app.commands.run('window.tools.float');
    expect(app.root.classList.contains('tools-float')).toBe(true);
    expect(app.root.classList.contains('tools-right')).toBe(false);
    await app.commands.run('window.panels.left');
    expect(app.root.classList.contains('panels-left')).toBe(true);
    expect(app.commands.isChecked('window.panels.left')).toBe(true);
    await app.commands.run('window.panels.right');
    expect(app.root.classList.contains('panels-left')).toBe(false);
  });

  it('drags the Tools panel by its grip to float it, then to the right edge to dock it there', async () => {
    const app = await boot();
    box(app.workspace, 0, 40, 1280, 760);
    box(app.docArea, 52, 40, 884, 760);
    box(app.toolbar.el, 0, 40, 52, 600);
    const grip = app.toolbar.el.querySelector('.toolbar-grip');
    expect(grip).toBeTruthy();
    drag(grip, [20, 46], [200, 200], [400, 300]);
    expect(app.root.classList.contains('tools-float')).toBe(true);
    expect(app.prefs.get('toolsPosition')).toBe('float');
    expect(app.toolbar.el.style.left).toBe('380px');
    // Near the canvas's right edge: a dock mark shows, and releasing docks it.
    box(app.toolbar.el, 380, 294, 52, 600);
    pointer(grip, 'pointerdown', 400, 300);
    pointer(grip, 'pointermove', 920, 300);
    expect(app.workspace.querySelector('.tools-dock-zone')).toBeTruthy();
    pointer(document.body, 'pointerup', 920, 300);
    expect(app.workspace.querySelector('.tools-dock-zone')).toBeNull();
    expect(app.prefs.get('toolsPosition')).toBe('right');
    expect(app.root.classList.contains('tools-right')).toBe(true);
    expect(app.root.classList.contains('tools-float')).toBe(false);
    expect(app.toolbar.el.style.left).toBe('');
  });
});

describe('saving the arrangement', () => {
  it('saves floating panels and positions in a workspace and applies them back', async () => {
    const app = await boot();
    layoutChrome(app);
    app.dock.floatPanel('color', { x: 30, y: 60, w: 250 });
    await app.commands.run('window.tools.right');
    await app.commands.run('window.panels.left');
    const ws = captureWorkspace(app, 'Tablet');
    expect(ws).toMatchObject({ toolsPosition: 'right', panelsSide: 'left', floating: [{ id: 'color', x: 30, y: 60, w: 250, h: null }] });
    await app.commands.run('window.workspace.essentials');
    expect(app.dock.getLayout().floating).toEqual([]);
    expect(app.root.classList.contains('tools-right')).toBe(false);
    expect(app.root.classList.contains('panels-left')).toBe(false);
    applyWorkspace(app, ws, 'saved:Tablet');
    expect(app.dock.getLayout().floating).toEqual([{ id: 'color', x: 30, y: 60, w: 250, h: null }]);
    expect(app.root.classList.contains('tools-right')).toBe(true);
    expect(app.root.classList.contains('panels-left')).toBe(true);
  });

  it('keeps the arrangement for the next session until the workspace is reset', async () => {
    const store = new Map();
    let app = await boot(store);
    layoutChrome(app);
    app.dock.floatPanel('layers', { x: 20, y: 30, user: true });
    app.dock.collapsePanel('align', { user: true });
    await app.commands.run('window.tools.float');
    app = await boot(store);
    expect(app.dock.getLayout().dock).toEqual(['properties']);
    expect(app.dock.getLayout().floating.map((f) => f.id)).toEqual(['layers']);
    expect(app.root.classList.contains('tools-float')).toBe(true);
    await app.commands.run('window.resetWorkspace');
    expect(app.dock.getLayout().dock).toEqual(['properties', 'layers']);
    expect(app.dock.getLayout().floating).toEqual([]);
    expect(app.root.classList.contains('tools-float')).toBe(false);
    app = await boot(store);
    expect(app.dock.getLayout().dock).toEqual(['properties', 'layers']);
    expect(app.dock.getLayout().floating).toEqual([]);
  });
});
