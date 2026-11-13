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
