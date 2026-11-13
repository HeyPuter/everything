// Stylus review: palm rejection, the pen's eraser end, menus tapped with a pen, and brush cursors.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

// Presses a second apart, so no two count as a double-click.
let clock = 0;
const ptr = (x, y, extra = {}) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y, pressure: 0.5, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, timeStamp: (clock += 1000), ...extra });
const pen = (x, y, extra = {}) => ptr(x, y, { pointerId: 7, pointerType: 'pen', ...extra });
const touch = (x, y, id = 20, extra = {}) => ptr(x, y, { pointerId: id, pointerType: 'touch', ...extra });

let app;
beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
  app = await bootAppWithFeatures();
  app.newDocument();
});

beforeEach(() => {
  const input = app.input;
  input.pointers.clear();
  input.palms?.clear();
  input.active = null;
  input.gesture = null;
  input.pendingTouch = null;
  app.editor.clearSelection();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
});

const paths = () => {
  const out = [];
  app.editor.doc.walk((n) => {
    if (n.type === 'path') out.push(n);
  });
  return out;
};

describe('palm rejection', () => {
  it('a palm landing while the pen draws neither cancels the stroke nor pinches the view', () => {
    app.setTool('pencil');
    const before = paths().length;
    const zoom = app.editor.view.zoom;
    const input = app.input;
    input.down(pen(100, 100));
    input.move(pen(120, 110));
    input.down(touch(400, 400));
    input.move(touch(460, 470));
    expect(input.gesture).toBe(null);
    input.move(pen(140, 130));
    input.move(pen(160, 160));
    input.up(touch(460, 470));
    input.up(pen(160, 160));
    expect(app.editor.view.zoom).toBe(zoom);
    expect(paths().length).toBe(before + 1);
  });

  it('a palm resting before the pen lands gives the pen the stroke', async () => {
    app.setTool('pencil');
    const before = paths().length;
    const input = app.input;
    input.down(touch(400, 400));
    // The palm's deferred press would start the tool after a moment; the pen comes first.
    input.down(pen(100, 100));
    await new Promise((r) => setTimeout(r, 150));
    input.move(touch(410, 405));
    input.move(pen(130, 120));
    input.move(pen(160, 160));
    input.up(pen(160, 160));
    input.up(touch(410, 405));
    const added = paths().slice(before);
    expect(added.length).toBe(1);
    // The path runs where the pen went, not from the palm.
    expect(Math.abs(added[0].anchors[0].x - 100)).toBeLessThan(2);
  });

  it('a palm already dragging a tool is cancelled when the pen lands', () => {
    app.setTool('pencil');
    const before = paths().length;
    const input = app.input;
    input.down(touch(400, 400));
    input.move(touch(420, 420)); // moved: the palm's press started
    expect(input.active?.id).toBe(20);
    input.down(pen(100, 100));
    expect(input.active?.id).toBe(7);
    input.move(pen(150, 150));
    input.up(pen(150, 150));
    input.up(touch(430, 430));
    expect(paths().length).toBe(before + 1);
  });

  it('two fingers still pinch when no pen is down', () => {
    app.setTool('pencil');
    const input = app.input;
    input.down(touch(100, 100, 21));
    input.down(touch(200, 100, 22));
    expect(input.gesture).not.toBe(null);
    input.move(touch(50, 100, 21));
    input.move(touch(250, 100, 22));
    expect(app.editor.view.zoom).toBeCloseTo(2);
    input.up(touch(50, 100, 21));
    input.up(touch(250, 100, 22));
  });
});

describe('menus tapped with a pen', () => {
  const enter = (el, pointerType, buttons) => {
    const e = new Event('pointerenter');
    e.pointerType = pointerType;
    e.buttons = buttons;
    el.dispatchEvent(e);
  };
  const menus = () => [...document.querySelectorAll('.menu')].map((m) => m.getAttribute('aria-label'));
  const closeAll = () => document.querySelectorAll('.menu').forEach((m) => m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

  it('tapping another menu title with a pen that cannot hover opens that menu', () => {
    const titles = [...document.querySelectorAll('.menubar-item')];
    titles[0].click();
    expect(menus()).toEqual(['File']);
    // The pen enters the title as its tip lands, then the tap clicks it.
    enter(titles[1], 'pen', 1);
    titles[1].click();
    expect(menus()).toEqual(['Edit']);
    closeAll();
  });

  it('a hovering pen still switches menus as it moves across the bar', () => {
    const titles = [...document.querySelectorAll('.menubar-item')];
    titles[0].click();
    enter(titles[1], 'pen', 0);
    expect(menus()).toEqual(['Edit']);
    closeAll();
  });

  it('a submenu opens with the pen tap, not as the pen lands', async () => {
    const { openMenu } = await import('../src/ui/menubar.js');
    const items = [{ type: 'sub', label: 'More', items: [{ type: 'cmd', label: 'Inner', enabled: true, run: () => {} }] }];
    const m = openMenu({}, items, { x: 10, y: 10 });
    const row = m.el.querySelector('.menu-item');
    enter(row, 'pen', 1);
    expect(document.querySelectorAll('.menu').length).toBe(1);
    row.click();
    expect(document.querySelectorAll('.menu').length).toBe(2);
    m.close();
  });
});

describe("the pen's eraser end", () => {
  // Chrome and Firefox report the eraser end pressed as button 5 (buttons 32).
  const eraserPen = (x, y, extra = {}) => pen(x, y, { button: 5, buttons: 32, ...extra });

  function rect() {
    const doc = app.editor.doc;
    const p = createPath(rectangle(100, 100, 200, 200), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: null });
    doc.transact('Rect', () => app.editor.insertDrawn(p));
    app.editor.clearSelection();
    return p.id;
  }

  it('erases with the Eraser while another tool is in use, and draws nothing', async () => {
    const id = rect();
    app.setTool('pencil');
    const before = paths().length;
    const input = app.input;
    input.down(eraserPen(80, 200));
    expect(app.editor.pressTool?.id).toBe('eraser');
    for (let x = 90; x <= 320; x += 10) input.move(eraserPen(x, 200, { buttons: 32, button: -1 }));
    input.up(eraserPen(320, 200, { buttons: 0 }));
    expect(app.editor.pressTool).toBe(null);
    expect(app.tool.id).toBe('pencil');
    // The rectangle is cut in two, and the Pencil drew no path.
    await vi.waitFor(() => expect(app.editor.doc.has(id)).toBe(false));
    expect(paths().length).toBe(before + 1);
  });

  it('the tip still draws with the tool in use afterwards', () => {
    app.setTool('pencil');
    const before = paths().length;
    const input = app.input;
    input.down(pen(500, 500));
    input.move(pen(550, 540));
    input.move(pen(600, 560));
    input.up(pen(600, 560, { buttons: 0 }));
    expect(paths().length).toBe(before + 1);
  });

  it('a cancelled eraser press puts the tool back', () => {
    app.setTool('pencil');
    const input = app.input;
    input.down(eraserPen(80, 200));
    input.move(eraserPen(120, 200, { button: -1 }));
    input.cancel(eraserPen(120, 200));
    expect(app.editor.pressTool).toBe(null);
    expect(app.getTool('eraser').pts).toBe(null);
  });
});

describe('the context menu and a pen', () => {
  // Android sends contextmenu for a pen tip held still, as a right-button press.
  const menuEvent = (x, y, extra = {}) => ({ ...ptr(x, y, { button: 2, buttons: 2, ...extra }), preventDefault: vi.fn() });
  const sidePen = (x, y, extra = {}) => pen(x, y, { button: 2, buttons: 2, ...extra });

  function rect() {
    const doc = app.editor.doc;
    const p = createPath(rectangle(100, 100, 200, 200), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: null });
    doc.transact('Rect', () => app.editor.insertDrawn(p));
    app.editor.clearSelection();
    return p.id;
  }

  let menu;
  beforeEach(() => {
    Object.assign(app.input, { lastPressMenu: 0, lastContextMenu: 0, penLifted: 0, sidePressed: false });
    menu = vi.spyOn(app, 'showContextMenu');
    return () => menu.mockRestore();
  });

  it('a pen tip held still while drawing opens no menu, and the stroke goes on', () => {
    app.setTool('pencil');
    const before = paths().length;
    const input = app.input;
    input.down(pen(100, 100));
    input.move(pen(140, 120));
    const e = menuEvent(140, 120, { pointerType: 'pen', pointerId: 7 });
    input.contextMenu(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(menu).not.toHaveBeenCalled();
    input.move(pen(180, 160));
    input.up(pen(180, 160, { buttons: 0 }));
    expect(paths().length).toBe(before + 1);
  });

  it('ignores the hold however the browser labels the event while the pen is down', () => {
    app.setTool('selection');
    const input = app.input;
    input.down(pen(500, 500));
    input.contextMenu(menuEvent(500, 500, { pointerType: 'mouse' }));
    input.contextMenu(menuEvent(500, 500, { pointerType: 'touch' }));
    input.up(pen(500, 500, { buttons: 0 }));
    expect(menu).not.toHaveBeenCalled();
  });

  it('a tap with the side button pressed opens the menu on the object, and draws nothing', () => {
    const id = rect();
    app.setTool('selection');
    const before = paths().length;
    const input = app.input;
    input.down(sidePen(150, 150));
    expect(menu).toHaveBeenCalledTimes(1);
    expect(app.editor.selection.has(id)).toBe(true);
    // The browser's own contextmenu for the same tap opens no second menu.
    input.contextMenu(menuEvent(150, 150, { pointerType: 'pen', pointerId: 7 }));
    input.up(sidePen(150, 150, { buttons: 0 }));
    expect(menu).toHaveBeenCalledTimes(1);
    expect(paths().length).toBe(before);
    expect(input.active).toBe(null);
  });

  it('the side button counts when it is already held as the pen lands (buttons only)', () => {
    app.setTool('pencil');
    const before = paths().length;
    app.input.down(pen(600, 600, { button: 0, buttons: 3 }));
    app.input.up(pen(600, 600, { buttons: 0 }));
    expect(menu).toHaveBeenCalledTimes(1);
    expect(paths().length).toBe(before);
  });

  it('the menu opened by the side button stays open when the pen lifts', () => {
    app.setTool('selection');
    const host = app.canvasHost;
    const fire = (type, extra = {}) => host.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: 300, clientY: 300, ...extra }));
    fire('pointerdown', { button: 2, buttons: 2 });
    expect(document.querySelector('.menu')).not.toBeNull();
    fire('pointerup', { button: 2, buttons: 0 });
    expect(document.querySelector('.menu')).not.toBeNull();
    document.querySelectorAll('.menu').forEach((m) => m.remove());
  });

  // Android, on a Samsung tablet with an S Pen: the button clicked in the air
  // arrives as hovering moves with the contact bit and no pressure.
  const hover = (x, y, extra = {}) => pen(x, y, { button: -1, buttons: 0, pressure: 0, ...extra });

  it('the side button clicked with the pen in the air opens the menu once per click', () => {
    app.setTool('pencil');
    const before = paths().length;
    const input = app.input;
    input.move(hover(300, 300));
    input.move(hover(302, 301, { button: 0, buttons: 1 }));
    expect(menu).toHaveBeenCalledTimes(1);
    expect(menu).toHaveBeenLastCalledWith(302, 301);
    input.move(hover(304, 302, { buttons: 1 }));
    input.move(hover(306, 303, { buttons: 1 }));
    expect(menu).toHaveBeenCalledTimes(1);
    input.move(hover(306, 303));
    input.move(hover(400, 400, { button: 0, buttons: 1 }));
    expect(menu).toHaveBeenCalledTimes(2);
    expect(paths().length).toBe(before);
    expect(input.active).toBe(null);
  });

  it('an air click that arrives as a press with no pressure draws nothing and holds back no touch', () => {
    app.setTool('pencil');
    const before = paths().length;
    const input = app.input;
    input.down(pen(300, 300, { buttons: 1, pressure: 0 }));
    input.up(pen(300, 300, { buttons: 0, pressure: 0 }));
    expect(menu).toHaveBeenCalledTimes(1);
    expect(paths().length).toBe(before);
    // The pen is not on the screen, so a finger is no palm.
    input.down(touch(500, 500));
    expect(input.palms.has(20)).toBe(false);
    input.cancel(touch(500, 500));
  });

  it('a tap with the side button held opens the menu from the browser contextmenu alone', () => {
    app.setTool('pencil');
    const input = app.input;
    // No pen press arrives: only contextmenu, labelled pen, mouse or nothing depending on the browser.
    for (const pointerType of ['pen', 'mouse', '']) {
      input.lastContextMenu = 0;
      input.sidePressed = false;
      menu.mockClear();
      input.contextMenu(menuEvent(250, 250, { pointerType }));
      expect(menu).toHaveBeenCalledTimes(1);
      // Then hovering moves with the button held, as the pen leaves the screen: still one menu.
      input.move(hover(252, 250, { button: 0, buttons: 1 }));
      input.move(hover(254, 250));
      expect(menu).toHaveBeenCalledTimes(1);
    }
  });

  it('a hold sent just as the pen tip lifts opens no menu', () => {
    app.setTool('pencil');
    const input = app.input;
    input.down(pen(100, 100));
    input.up(pen(100, 100, { buttons: 0 }));
    input.contextMenu(menuEvent(100, 100, { pointerType: 'pen' }));
    expect(menu).not.toHaveBeenCalled();
  });

  it('a mouse right-click still opens the menu', () => {
    app.setTool('selection');
    app.input.contextMenu(menuEvent(300, 300));
    expect(menu).toHaveBeenCalledTimes(1);
  });
});

describe('brush outlines when the pen leaves', () => {
  for (const id of ['eraser', 'blob-brush', 'warp', 'symbol-sprayer']) {
    it(`the ${id} outline goes when the pen lifts out of range, and stays while it drags`, () => {
      expect(app.toolClasses.has(id)).toBe(true);
      app.setTool(id);
      const tool = app.tool;
      const input = app.input;
      const at = () => tool.cursorPt ?? tool.pos ?? null;
      input.move(pen(300, 300, { buttons: 0 }));
      expect(at()).not.toBe(null);
      input.leave();
      expect(at()).toBe(null);
      // A drag that leaves the canvas (the pointer is captured) keeps its outline.
      input.move(pen(300, 300, { buttons: 0 }));
      input.down(pen(300, 300));
      input.move(pen(320, 300));
      input.leave();
      expect(at()).not.toBe(null);
      input.cancel(pen(320, 300));
    });
  }
});

describe('dragging a dialog by its title bar', () => {
  it('a pen drag the browser cancels ends the drag, so the hovering pen no longer moves the dialog', async () => {
    const { openDialog } = await import('../src/ui/dialogs/dialog.js');
    const matchMedia = window.matchMedia;
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    try {
      openDialog({ title: 'Drag me', content: document.createElement('div') });
      const header = [...document.querySelectorAll('.dialog-header')].at(-1);
      const dialog = header.closest('dialog');
      const fire = (type, x, y, buttons = 1) => header.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 3, pointerType: 'pen', clientX: x, clientY: y, buttons }));
      header.setPointerCapture = () => {};
      fire('pointerdown', 100, 100);
      fire('pointermove', 120, 110);
      const left = dialog.style.left;
      fire('pointercancel', 120, 110, 0);
      fire('pointermove', 300, 300, 0);
      expect(dialog.style.left).toBe(left);
      dialog.close?.();
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});

describe('draggable in the element builder', () => {
  it("draggable: 'false' and draggable: false make an element that the browser does not drag", async () => {
    const { h } = await import('../src/lib/dom.js');
    expect(h('li', { draggable: 'false' }).draggable).toBe(false);
    expect(h('img', { draggable: false }).draggable).toBe(false);
    expect(h('li', { draggable: 'true' }).draggable).toBe(true);
    expect(h('li', { draggable: true }).draggable).toBe(true);
    expect(h('li', {}).hasAttribute('draggable')).toBe(false);
  });
});

describe('Artboards panel rows and a pen', () => {
  async function setup() {
    const { ArtboardsPanel } = await import('../src/features/artboards/artboards-panel.js');
    const ed = app.newDocument({ name: 'Boards', width: 100, height: 100 });
    ed.doc.transact('Boards', () =>
      ed.doc.updateRoot({ artboards: ['A', 'B', 'C', 'D'].map((name, i) => ({ id: `ab${i}`, name, x: i * 120, y: 0, w: 100, h: 100 })) }),
    );
    const panel = new ArtboardsPanel(app);
    document.body.append(panel.el);
    panel.ensureBuilt();
    panel.update();
    const rows = () => [...panel.el.querySelectorAll('.ab-row')];
    for (const [k, r] of rows().entries()) r.getBoundingClientRect = () => ({ top: k * 30, bottom: k * 30 + 30, height: 30, left: 0, right: 200, width: 200 });
    const names = () => ed.doc.artboards.map((a) => a.name);
    return { panel, rows, names, ed };
  }
  const fire = (target, type, y, extra = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: 1, pointerId: 9, pointerType: 'pen', clientX: 10, clientY: y, ...extra }));

  it('a drag the browser cancels to scroll the list moves nothing, then or at the next release', async () => {
    const { rows, names } = await setup();
    fire(rows()[0], 'pointerdown', 15);
    fire(window, 'pointermove', 60);
    fire(window, 'pointercancel', 60);
    expect(names()).toEqual(['A', 'B', 'C', 'D']);
    // A later tap elsewhere ends no drag.
    fire(window, 'pointerdown', 400, { pointerId: 10 });
    fire(window, 'pointerup', 95, { pointerId: 9 });
    expect(names()).toEqual(['A', 'B', 'C', 'D']);
    expect(document.querySelector('.ab-row.dragging')).toBe(null);
  });

  it('another pointer lifting does not drop the row being dragged', async () => {
    const { rows, names } = await setup();
    fire(rows()[0], 'pointerdown', 15);
    fire(window, 'pointermove', 60);
    fire(window, 'pointerup', 60, { pointerId: 11 });
    fire(window, 'pointermove', 95);
    fire(window, 'pointerup', 95);
    expect(names()).toEqual(['B', 'C', 'A', 'D']);
  });

  it('a hovering pen makes rows drag instead of scrolling the list; a finger scrolls it', async () => {
    const { panel } = await setup();
    const list = panel.el.querySelector('.ab-list');
    fire(list, 'pointermove', 20, { buttons: 0 });
    expect(list.classList.contains('pen-direct')).toBe(true);
    fire(list, 'pointerleave', 20, { buttons: 0 });
    expect(list.classList.contains('pen-direct')).toBe(false);
    fire(list, 'pointermove', 20, { buttons: 0 });
    fire(list, 'pointermove', 20, { pointerType: 'touch', pointerId: 30 });
    expect(list.classList.contains('pen-direct')).toBe(false);
    const css = fs.readFileSync(path.resolve(__dirname, '../src/features/artboards/styles.css'), 'utf8');
    expect(css).toMatch(/\.ab-list\.pen-direct \.ab-row \{\s*touch-action: none;/);
  });
});

describe('Swatches panel drags', () => {
  function setup() {
    app.newDocument();
    app.openPanel('swatches');
    const panel = app.dock.panels.get('swatches');
    panel.ensureBuilt?.();
    panel.update?.();
    const items = () => [...panel.el.querySelectorAll('.sw-list .sw-item')].filter((e) => e.dataset.id !== '__none');
    const order = () => (app.editor.doc.root.swatches || []).map((s) => s.id).join(',');
    return { panel, items, order };
  }
  const fire = (el, type, x, extra = {}) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: 1, pointerId: 4, pointerType: 'touch', clientX: x, clientY: 10, ...extra }));

  it('a swipe the browser takes over to scroll the list moves no swatch', () => {
    const { items, order } = setup();
    const before = order();
    const [a, , c] = items();
    const elementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => c;
    try {
      fire(a, 'pointerdown', 0);
      fire(a, 'pointermove', 40);
      fire(a, 'pointercancel', 0);
    } finally {
      document.elementFromPoint = elementFromPoint;
    }
    expect(order()).toBe(before);
  });

  it('a mouse drag still moves the swatch', () => {
    const { items, order, panel } = setup();
    const before = order();
    const [a, , c] = items();
    const elementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => c;
    try {
      fire(a, 'pointerdown', 0, { pointerType: 'mouse' });
      fire(a, 'pointermove', 40, { pointerType: 'mouse' });
      fire(a, 'pointerup', 40, { pointerType: 'mouse', buttons: 0 });
    } finally {
      document.elementFromPoint = elementFromPoint;
    }
    expect(order()).not.toBe(before);
  });
});

describe('Swatches panel and a hovering pen', () => {
  it('a hovering pen makes swatches drag instead of scrolling the list; a finger scrolls it', () => {
    app.newDocument();
    app.openPanel('swatches');
    const list = app.dock.panels.get('swatches').el.querySelector('.sw-list');
    const fire = (type, extra = {}) => list.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 5, pointerType: 'pen', buttons: 0, ...extra }));
    fire('pointermove');
    expect(list.classList.contains('pen-direct')).toBe(true);
    fire('pointerleave');
    expect(list.classList.contains('pen-direct')).toBe(false);
    fire('pointermove');
    fire('pointermove', { pointerType: 'touch', pointerId: 6, buttons: 1 });
    expect(list.classList.contains('pen-direct')).toBe(false);
    const css = fs.readFileSync(path.resolve(__dirname, '../src/features/paint/styles.css'), 'utf8');
    expect(css).toMatch(/\.sw-list\.pen-direct \.sw-item \{\s*touch-action: none;/);
  });
});

describe('drags the browser cancels', () => {
  it('a cancelled 9-slice guide drag puts the guide back and leaves the document editable', async () => {
    const { createSymbolFrom, getDef } = await import('../src/features/symbols/model.js');
    const ed = app.newDocument();
    ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    const doc = ed.doc;
    const r = createPath(rectangle(100, 100, 90, 30), true, { fill: { type: 'solid', color: '#336699' }, stroke: null });
    let out;
    doc.transact('Rect', () => {
      ed.insertDrawn(r);
      out = createSymbolFrom(doc, [r.id], { slice9: true });
    });
    const id = out.def.id;
    const before = { ...getDef(doc, id).symbolDef.slice9 };
    ed.symbolEdit = id;
    app.setTool('selection');
    const g = before;
    const a = ed.view.toScreen(g.x, g.y + g.h / 2);
    const fire = (type, x, y) => app.canvasHost.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointercancel' ? 0 : 1, pointerId: 8, pointerType: 'pen', clientX: x, clientY: y }));
    fire('pointerdown', a.x, a.y);
    expect(doc.tx?.label).toBe('Move 9-Slice Guide');
    fire('pointermove', a.x - 10, a.y);
    fire('pointercancel', 0, 0);
    expect(doc.tx).toBe(null);
    expect(getDef(doc, id).symbolDef.slice9).toEqual(before);
    // The document still takes edits.
    doc.transact('Rename', () => doc.update(r.id, { name: 'still editable' }));
    ed.symbolEdit = null;
  });

  it('a hovering pen no longer changes the color after a cancelled pick in the color field', async () => {
    const { createColorPicker } = await import('../src/ui/color-picker.js');
    const seen = [];
    const picker = createColorPicker({ value: '#ff0000', onInput: (v) => seen.push(v) });
    document.body.append(picker.el);
    const field = picker.el.querySelector('.cp-sv-wrap');
    field.setPointerCapture = () => {};
    field.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 });
    field.querySelector('canvas, .cp-sv') && (field.querySelector('canvas, .cp-sv').getBoundingClientRect = field.getBoundingClientRect);
    const fire = (type, x, y, buttons = 1) => field.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 2, pointerType: 'pen', clientX: x, clientY: y, buttons }));
    fire('pointerdown', 50, 50);
    fire('pointermove', 60, 40);
    fire('pointercancel', 0, 0, 0);
    const n = seen.length;
    fire('pointermove', 5, 95, 0);
    expect(seen.length).toBe(n);
    picker.el.remove();
  });
});

describe('the pressure stroke preview while drawing', () => {
  // A 2D context that counts the discs traced into it.
  const fakeCtx = (w = 400, h = 300) => {
    const ctx = {
      canvas: { width: w, height: h },
      arcs: 0,
      globalAlpha: 1,
      getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }),
      setTransform() {},
      save() {},
      restore() {},
      clearRect() {},
      drawImage() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill() {},
      arc() {
        ctx.arcs++;
      },
    };
    return ctx;
  };

  it('traces only what was added since the last frame, not the whole stroke', async () => {
    const { GrowingStrokePreview } = await import('../src/features/brushes/pressure.js');
    const layers = [];
    const Offscreen = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = class {
      constructor(w, h) {
        this.width = w;
        this.height = h;
        this.ctx = fakeCtx(w, h);
        layers.push(this);
      }
      getContext() {
        return this.ctx;
      }
    };
    try {
      const ctx = fakeCtx();
      const preview = new GrowingStrokePreview();
      const pts = [];
      let traced = 0;
      for (let n = 1; n <= 3000; n++) {
        pts.push({ x: n * 0.1, y: 50 });
        const before = ctx.arcs + layers.reduce((s, l) => s + l.ctx.arcs, 0);
        preview.draw(ctx, pts, pts.map(() => 3), { color: '#000', settled: n - 2 });
        traced = ctx.arcs + layers.reduce((s, l) => s + l.ctx.arcs, 0) - before;
        // Never more than a batch and the last points, however long the stroke.
        expect(traced).toBeLessThan(140);
      }
      // A change of view starts over.
      const moved = pts.map((p) => ({ x: p.x + 5, y: p.y }));
      const before = ctx.arcs + layers.reduce((s, l) => s + l.ctx.arcs, 0);
      preview.draw(ctx, moved, moved.map(() => 3), { color: '#000', settled: moved.length - 2 });
      expect(ctx.arcs + layers.reduce((s, l) => s + l.ctx.arcs, 0) - before).toBeGreaterThan(2900);
      preview.reset();
      expect(preview.layers).toBe(null);
    } finally {
      globalThis.OffscreenCanvas = Offscreen;
    }
  });
});
