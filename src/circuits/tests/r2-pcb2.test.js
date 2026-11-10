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
const compOf = (ed, ref) =>
  [...ed.doc.items()].find((o) => o.t === 'comp' && o.designator === ref);
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
    const via = { id: 'v1', t: 'via', x: mm(5), y: mm(5), d: mm(0.8), drill: mm(0.4), from: 'top', to: 'bottom' };
    const track = { id: 't1', t: 'track', layer: 'top', x1: mm(5), y1: mm(5), x2: mm(9), y2: mm(5), w: mm(0.25) };
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
