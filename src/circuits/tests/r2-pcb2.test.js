// Board editor review, round 2, second pass: drags, drawing tools, layers,
// the kernel worker and the ratsnest, driven through a real PcbEditor in
// jsdom (no WebGL, so nothing is drawn).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import { closeMenus } from '../src/ui/menu.js';
import { mm } from '../src/core/units.js';

async function bootBoard() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  setPuterForTests(null);
  delete window.puter;
  const app = new App(document.getElementById('app'), { puterTimeout: 10 });
  await app.init();
  app.settings.set('autoRepour', false);
  app.settings.set('onlineDrc', false);
  // jsdom cannot load the kernel; tests that need it stub these again.
  app.kernel.pours = async () => new Map();
  app.kernel.drc = async () => [];
  await app.openExample();
  app.openDoc(app.project.boards[0].id);
  const ed = app.activeEditor;
  return { app, ed };
}

const ev = (x, y) => ({ x, y, rawX: x, rawY: y });
const compOf = (ed, ref) => [...ed.doc.items()].find((o) => o.t === 'comp' && o.designator === ref);
const press = (ed, key, code, mods = {}) =>
  ed.canvas.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...mods }),
  );

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

describe('edits made while a board drag is in progress', () => {
  const startDrag = (ed, o) => {
    ed.setSelection([o.id]);
    ed.select.dragStart(ev(o.x, o.y));
    ed.select.drag(ev(o.x + mm(3), o.y));
  };

  it('keeps an undo undone instead of re-applying it when the drag ends', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const store = ed.doc.store;
    const r1 = compOf(ed, 'R1');
    store.transact('Value', (s) => s.update(r1.id, { value: '99k' }));
    startDrag(ed, store.get(r1.id));
    expect(ed.select.move).toBeTruthy();
    app.commands.run('edit.undo');
    ed.select.dragEnd();
    expect(store.get(r1.id)).toBe(r1);
    expect(store.canRedo).toBe(true);
    expect(ed.hidden.size).toBe(0);
    store.redo();
    expect(store.get(r1.id).value).toBe('99k');
  });

  it('does not stretch the tracks of a via deleted mid-drag', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const store = ed.doc.store;
    const via = {
      id: 'v1',
      t: 'via',
      x: mm(5),
      y: mm(5),
      d: mm(0.8),
      drill: mm(0.4),
      from: 'top',
      to: 'bottom',
    };
    const track = {
      id: 't1',
      t: 'track',
      layer: 'top',
      x1: mm(5),
      y1: mm(5),
      x2: mm(9),
      y2: mm(5),
      w: mm(0.25),
    };
    store.transact('Set up', (s) => {
      s.add(via);
      s.add(track);
    });
    startDrag(ed, via);
    app.commands.run('edit.delete');
    ed.select.dragEnd();
    expect(store.get('v1')).toBeFalsy();
    expect(store.get('t1')).toEqual(track);
    expect(store.undoLabel).toBe('Delete');
    store.undo();
    expect(store.get('v1')).toEqual(via);
  });

  it('still commits an ordinary drag as one step', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const store = ed.doc.store;
    const r1 = compOf(ed, 'R1');
    startDrag(ed, r1);
    ed.select.dragEnd();
    expect(store.get(r1.id).x - r1.x).toBe(mm(3));
    expect(store.undoLabel).toBe('Move');
    expect(ed.select.move).toBeNull();
    expect(ed.hidden.size).toBe(0);
    store.undo();
    expect(store.get(r1.id)).toBe(r1);
  });
});

describe('rotate and flip keys in board drawing tools', () => {
  it.each([
    'line',
    'fill',
    'dim',
    'measure',
    'pour',
    'region',
    'keepout',
    'board',
    'cutout',
    'route',
  ])('do not turn the selection left from before the %s tool started', async (tool) => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const r1 = compOf(ed, 'R1');
    ed.setSelection([r1.id]);
    ed.startTool(tool);
    ed.tool.click(ev(mm(40), mm(40)));
    press(ed, ' ', 'Space');
    press(ed, ' ', 'Space', { shiftKey: true });
    press(ed, 'l', 'KeyL');
    expect(ed.doc.store.get(r1.id)).toBe(r1);
    expect(ed.tool.name).not.toBe('select');
  });

  it.each(['via', 'text'])('do not flip the selection while placing a %s', async (tool) => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const r1 = compOf(ed, 'R1');
    ed.setSelection([r1.id]);
    ed.startTool(tool);
    press(ed, 'l', 'KeyL');
    expect(ed.doc.store.get(r1.id)).toBe(r1);
  });

  it('do not turn the selection while pasting', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const r1 = compOf(ed, 'R1');
    ed.setSelection([r1.id]);
    ed.pasteClip(ed.copySelection());
    press(ed, ' ', 'Space', { shiftKey: true });
    press(ed, 'l', 'KeyL');
    expect(ed.doc.store.get(r1.id)).toBe(r1);
    expect(ed.tool.name).toBe('paste');
  });

  it('still rotate and flip the selection in the select tool', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const r1 = compOf(ed, 'R1');
    ed.setSelection([r1.id]);
    press(ed, ' ', 'Space');
    expect(ed.doc.store.get(r1.id).rot).toBe(((r1.rot || 0) + 90) % 360);
    press(ed, 'l', 'KeyL');
    expect(ed.doc.store.get(r1.id).side).not.toBe(r1.side);
  });
});

describe('copper on hidden layers', () => {
  const setUp = async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const y = mm(70);
    ed.doc.store.transact('Set up', (s) => {
      s.add({
        id: 'tb',
        t: 'track',
        layer: 'bottom',
        x1: 0,
        y1: y,
        x2: mm(4),
        y2: y,
        w: mm(0.3),
        net: 'HID',
      });
      s.add({
        id: 'vb',
        t: 'via',
        x: mm(8),
        y,
        d: mm(0.8),
        drill: mm(0.4),
        from: 'top',
        to: 'bottom',
        net: 'VIA',
      });
    });
    return { ed, y };
  };

  it('is not named by the readout or highlighted with Ctrl+click', async () => {
    const { ed, y } = await setUp();
    expect(ed.netUnder(mm(2), y)).toBe('HID');
    ed.setLayerVisible('bottom', false);
    expect(ed.netUnder(mm(2), y)).toBeNull();
    ed.select.click({ ...ev(mm(2), y), ctrl: true });
    expect(ed.highlight).toBeNull();
    // A via shows through the board on the layers still visible.
    expect(ed.netUnder(mm(8), y)).toBe('VIA');
    ed.setLayerVisible('bottom', true);
    ed.select.click({ ...ev(mm(2), y), ctrl: true });
    expect(ed.highlight.net).toBe('HID');
  });

  it('is not named in single layer mode when other layers are hidden', async () => {
    const { ed, y } = await setUp();
    ed.singleLayer = 'hide';
    expect(ed.activeLayer).toBe('top');
    expect(ed.netUnder(mm(2), y)).toBeNull();
    expect(ed.netUnder(mm(8), y)).toBe('VIA');
  });

  it('still gives its net to a via placed on it', async () => {
    const { ed, y } = await setUp();
    ed.setLayerVisible('bottom', false);
    ed.startTool('via');
    ed.tool.click(ev(mm(2), y));
    const via = [...ed.doc.items()].find((o) => o.t === 'via' && o.x === mm(2));
    expect(via.net).toBe('HID');
  });
});

describe('the layers panel', () => {
  const open = async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    app.showPanel('layers');
    const panel = app.panels.layers;
    panel.refresh();
    return { app, ed, panel };
  };

  it('refreshes pad net labels when single layer mode is chosen, as Shift+S does', async () => {
    const { ed, panel } = await open();
    const mode = panel.body.querySelector('select[aria-label="Single layer mode"]');
    clearTimeout(ed._labelTimer);
    let rebuilt = 0;
    ed._rebuildLabels = () => rebuilt++;
    mode.value = 'hide';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(ed.singleLayer).toBe('hide');
    await new Promise((r) => setTimeout(r, 120));
    expect(rebuilt).toBe(1);
  });

  it('marks the current layer without list-box attributes on plain list items', async () => {
    const { ed, panel } = await open();
    expect(panel.body.querySelectorAll('li[aria-selected]')).toHaveLength(0);
    const current = panel.body.querySelectorAll('li[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('Top');
    ed.setActiveLayer('bottom');
    expect(panel.body.querySelector('li[aria-current="true"]').textContent).toContain('Bottom');
  });
});
