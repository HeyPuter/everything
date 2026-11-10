// End-to-end review, round 2: bugs found by driving complete workflows in the
// real app, pinned here through the App and its editors in jsdom.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import { closeMenus } from '../src/ui/menu.js';
import { placedOf } from '../src/render/pcb-scene.js';

async function boot() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  setPuterForTests(null);
  delete window.puter;
  const app = new App(document.getElementById('app'), { puterTimeout: 10 });
  await app.init();
  app.settings.set('autoRepour', false);
  app.settings.set('onlineDrc', false);
  // jsdom cannot load the kernel; tests that need fills set them directly.
  app.kernel.pours = async () => new Map();
  app.kernel.drc = async () => [];
  return app;
}

async function bootBoard() {
  const app = await boot();
  await app.openExample();
  app.openDoc(app.project.boards[0].id);
  return { app, ed: app.activeEditor };
}

function padOf(ed, ref, num) {
  const comp = [...ed.doc.items()].find((o) => o.t === 'comp' && o.designator === ref);
  return placedOf(comp, ed.lib, ed.copperCount).pads.find((p) => p.num === num);
}

const count = (ed, t) => [...ed.doc.items()].filter((o) => o.t === t).length;
const ev = (x, y) => ({ x, y, rawX: x, rawY: y });
const key = (ed, combo) => ed.tool.key({ key: combo, preventDefault() {} }, combo);

let ctx;
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  ctx?.app.kernel.dispose();
  ctx = null;
  closeMenus();
  document.body.innerHTML = '';
});

describe('interactive routing over copper pours', () => {
  it('continues a trace after a via onto a layer poured with another net', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    expect(app.settings.get('routingMode')).toBe('stop');
    // The example's ground plane fills the whole bottom layer.
    const pour = [...ed.doc.items()].find((o) => o.t === 'pour' && o.layer === 'bottom');
    expect(pour.net).toBe('GND');
    ed.pourFills = new Map([[pour.id, [[pour.pts]]]]);
    const p = padOf(ed, 'U1', '2');
    expect(p.net).toBe('THR');
    ed.startTool('route');
    ed.tool.click(ev(p.x, p.y));
    ed.tool.click(ev(p.x - 3_000_000, p.y));
    key(ed, '*');
    expect(ed.tool.trace.layer).toBe('bottom');
    const before = count(ed, 'track');
    ed.tool.click(ev(p.x - 3_000_000, p.y + 5_000_000));
    // The pour is refilled around new copper, so it must not stop the trace.
    expect(count(ed, 'track')).toBeGreaterThan(before);
    const last = [...ed.doc.items()].filter((o) => o.t === 'track').pop();
    expect(last.layer).toBe('bottom');
    expect([last.x2, last.y2]).toEqual([p.x - 3_000_000, p.y + 5_000_000]);
  });

  it('still stops a trace at a pad of another net', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const a = padOf(ed, 'U1', '2');
    const b = padOf(ed, 'U1', '3');
    ed.startTool('route');
    // Started on the pad, so the trace has its net (a trace without one joins what it touches).
    ed.tool.click(ev(a.x, a.y));
    expect(ed.tool.trace.net).toBe(a.net);
    ed.tool.corner = 'any';
    // Straight at the neighbouring pad (net OUT): clipped short of it.
    const path = ed.tool._path(b.x, b.y);
    const end = path.slice(-2);
    expect(Math.hypot(end[0] - b.x, end[1] - b.y)).toBeGreaterThan(100_000);
  });
});

describe('layer changes while routing', () => {
  it('does not stack a second via when the layer is changed twice at one point', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const p = padOf(ed, 'U1', '2');
    ed.startTool('route');
    ed.tool.click(ev(p.x, p.y));
    ed.tool.click(ev(p.x - 3_000_000, p.y));
    key(ed, '*');
    expect(count(ed, 'via')).toBe(1);
    expect(ed.tool.trace.layer).toBe('bottom');
    // Back to the layer the trace came from: the via is not needed after all.
    key(ed, '*');
    expect(ed.tool.trace.layer).toBe('top');
    expect(ed.activeLayer).toBe('top');
    expect(count(ed, 'via')).toBe(0);
    // And the trace still works from there.
    key(ed, '*');
    expect(count(ed, 'via')).toBe(1);
    ed.tool.click(ev(p.x - 3_000_000, p.y + 5_000_000));
    expect([...ed.doc.items()].filter((o) => o.t === 'track').pop().layer).toBe('bottom');
  });

  it('keeps one via while stepping through the inner layers of a four layer board', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    ed.doc.store.transact('Layers', (s) => s.update('board', { copper: 4 }));
    const p = padOf(ed, 'U1', '2');
    ed.startTool('route');
    ed.tool.click(ev(p.x, p.y));
    ed.tool.click(ev(p.x - 3_000_000, p.y));
    const seen = [];
    for (let i = 0; i < 3; i++) {
      key(ed, '*');
      seen.push(ed.tool.trace.layer);
      expect(count(ed, 'via')).toBe(1);
    }
    expect(new Set(seen).size).toBe(3);
    key(ed, '*');
    expect(ed.tool.trace.layer).toBe('top');
    expect(count(ed, 'via')).toBe(0);
  });
});

describe('messages across projects', () => {
  it('drops check results when the project is closed or replaced', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const sheet = app.activeEditor;
    const part = [...sheet.doc.items()].find((o) => o.t === 'part' && o.designator === 'R1');
    sheet.doc.store.transact('Delete', (s) => s.remove(part.id));
    app.compile();
    expect(app.panels.messages.items.length).toBeGreaterThan(0);
    expect(app.status.querySelector('.msg-count')).not.toBeNull();

    await app.closeProject(true);
    expect(app.panels.messages.items).toHaveLength(0);
    // Nothing is open: no message counts, grid or cursor readout either.
    expect(app.status.querySelector('.msg-count')).toBeNull();
    expect(app.status.textContent).not.toMatch(/Grid/);

    await app.openExample();
    app.panels.messages.set(
      [{ severity: 'error', message: 'x', docId: 'gone', x: 5e7, y: 5e7 }],
      'T',
    );
    await app.openExample();
    expect(app.panels.messages.items).toHaveLength(0);
    expect(app.panels.messages.el.querySelectorAll('.list-row')).toHaveLength(0);
  });
});

describe('editors whose WebGL context was dropped', () => {
  // Browsers keep about 16 WebGL contexts and drop the oldest for good, so
  // with many documents open the first ones come back as blank canvases.
  const lostRenderer = () => ({
    gl: { isContextLost: () => true },
    view: { cx: 1, cy: 2, scale: 3 },
    resize() {},
    release() {},
    dispose() {},
  });

  it('rebuilds a sheet editor when its tab is shown again', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const sheet = app.project.sheets[0];
    const board = app.project.boards[0];
    const first = app.activeEditor;
    app.openDoc(board.id);
    first.renderer = lostRenderer();
    app.openDoc(sheet.id);
    const again = app.activeEditor;
    expect(again).not.toBe(first);
    expect(first.disposed).toBe(true);
    expect(first.el.isConnected).toBe(false);
    expect(again.doc).toBe(sheet);
    expect(again.el.isConnected).toBe(true);
    expect(again.el.hidden).toBe(false);
    expect([...app.editors.values()].filter((e) => e.doc === sheet)).toHaveLength(1);
    // The document and its undo history are untouched.
    again.doc.store.transact('Add', (s) => s.add({ t: 'junction', x: 0, y: 0 }));
    expect(app.commands.get('edit.undo').enabled()).toBe(true);
  });

  it('leaves editors with a working canvas alone', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const first = app.activeEditor;
    app.openDoc(app.project.boards[0].id);
    app.openDoc(app.project.sheets[0].id);
    expect(app.activeEditor).toBe(first);
    expect(first.disposed).toBe(false);
  });
});

describe('long press on a touch screen', () => {
  const touchEvent = (type, x, y) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(e, 'pointerId', { value: 7 });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    return e;
  };

  afterEach(() => vi.useRealTimers());

  it('does not choose the menu item that opens under the finger when it lifts', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const ed = app.activeEditor;
    ed.canvas.setPointerCapture = () => {};
    const before = JSON.stringify([...ed.doc.items()]);
    ed.selectAll();
    const toasts = document.querySelectorAll('.toast').length;
    vi.useFakeTimers();
    ed.canvas.dispatchEvent(touchEvent('pointerdown', 200, 200));
    vi.advanceTimersByTime(700);
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const item = [...menu.querySelectorAll('.menu-item')].find((b) => !b.disabled);
    // The finger lifts where it pressed, now over the menu; browsers that do
    // not treat the long press as their own gesture follow up with a click.
    ed.canvas.dispatchEvent(touchEvent('pointerup', 200, 200));
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.querySelectorAll('.toast')).toHaveLength(toasts);
    expect(JSON.stringify([...ed.doc.items()])).toBe(before);
    // A tap on an item after that is a real choice.
    vi.advanceTimersByTime(400);
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('sizes typed into the board dialogs', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const dialog = () => [...document.querySelectorAll('.dialog')].pop();
  const fieldOf = (label) => {
    const l = [...dialog().querySelectorAll('label')].find((x) => x.textContent === label);
    return dialog().querySelector(`#${l.getAttribute('for')}`);
  };
  const apply = async () => {
    dialog().querySelector('button.primary').click();
    await tick();
  };

  it('refuses design rules that are negative, zero sizes or a via hole wider than the via', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const before = JSON.stringify(ed.doc.rules);
    const cases = [
      ['Track width (preferred)', '-0.25'],
      ['Track width (preferred)', '0'],
      ['Track width (minimum)', '0'],
      ['Copper clearance', '-0.2'],
      ['Via diameter', '0'],
      ['Via hole', '0'],
      ['Via hole', '5'],
      ['Copper to board edge', '-1'],
      ['Thermal relief spoke width', '0'],
    ];
    for (const [label, value] of cases) {
      const done = app.editRules();
      fieldOf(label).value = value;
      await apply();
      expect(dialog(), `${label} = ${value}`).toBeTruthy();
      expect(dialog().querySelector('[role="alert"]').textContent, `${label} = ${value}`).not.toBe(
        '',
      );
      expect(JSON.stringify(ed.doc.rules)).toBe(before);
      dialog().querySelector('[aria-label="Close dialog"]').click();
      await done;
    }
    // Zero clearances and negative mask or paste expansion are legitimate.
    const done = app.editRules();
    fieldOf('Copper to board edge').value = '0';
    fieldOf('Paste expansion').value = '-0.05';
    fieldOf('Track width (minimum)').value = '0.1';
    await apply();
    await done;
    expect(dialog()).toBeUndefined();
    expect(ed.doc.rules.edgeClearance).toBe(0);
    expect(ed.doc.rules.pasteExpansion).toBe(-50_000);
    expect(ed.doc.rules.minTrackWidth).toBe(100_000);
  });

  it('refuses a board thickness of zero or less', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const before = ed.doc.board.thickness;
    for (const value of ['0', '-1.6']) {
      const done = app.editLayerStack();
      fieldOf('Board thickness').value = value;
      await apply();
      expect(dialog(), value).toBeTruthy();
      expect(fieldOf('Board thickness').getAttribute('aria-invalid')).toBe('true');
      expect(ed.doc.board.thickness).toBe(before);
      dialog().querySelector('[aria-label="Close dialog"]').click();
      await done;
    }
    const done = app.editLayerStack();
    fieldOf('Board thickness').value = '0.8';
    await apply();
    await done;
    expect(ed.doc.board.thickness).toBe(800_000);
  });
});
