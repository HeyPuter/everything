import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

// Android sends touch and stylus events (and the clicks they make) without modifier
// keys even while a hardware keyboard's Shift is held; keyboard events still carry them.
function pointer(type, pointerType, init = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, detail: type.includes('click') ? 1 : 0, ...init });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  return e;
}
const tap = (el, pointerType = 'touch', init = {}) => {
  el.dispatchEvent(pointer('pointerdown', pointerType, init));
  el.dispatchEvent(pointer('pointerup', pointerType, init));
  const click = pointer('click', pointerType, init);
  el.dispatchEvent(click);
  return click;
};
const key = (type, k, init) => window.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, ...init }));

function setup() {
  const app = bootApp();
  const ed = app.newDocument({ name: 'Taps' });
  const doc = ed.doc;
  const layer = doc.layers()[0];
  const ids = [];
  doc.transact('Build', () => {
    for (let i = 0; i < 4; i++) {
      const p = { ...createPath(rectangle(i * 30, 0, 20, 20), true), name: `Item ${i}` };
      doc.insert(p, layer.id);
      ids.push(p.id);
    }
  });
  const panel = app.dock.panels.get('layers');
  panel.ensureBuilt();
  panel.expanded.add(layer.id);
  panel.update();
  const row = (id) => [...panel.el.querySelectorAll('[role="treeitem"]')].find((r) => r.getAttribute('aria-label') === doc.get(id).name);
  return { app, ed, ids, row };
}

describe('modifier keys on taps', () => {
  it('a tap while a hardware Shift is held selects a Layers panel range', () => {
    const { ed, ids, row } = setup();
    tap(row(ids[0]));
    expect([...ed.selection]).toEqual([ids[0]]);
    key('keydown', 'Shift', { shiftKey: true });
    const click = tap(row(ids[3]));
    expect(click.shiftKey).toBe(true);
    expect(new Set(ed.selection)).toEqual(new Set(ids));
    key('keyup', 'Shift', { shiftKey: false });
    tap(row(ids[1]));
    expect([...ed.selection]).toEqual([ids[1]]);
  });

  it('stylus taps get the held keys too, and losing the window releases them', () => {
    setup();
    key('keydown', 'Alt', { altKey: true });
    expect(tap(document.body, 'pen').altKey).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(tap(document.body, 'pen').altKey).toBe(false);
  });

  it('leaves mouse clicks and keyboard-activated clicks as they are', () => {
    setup();
    key('keydown', 'Shift', { shiftKey: true });
    expect(tap(document.body, 'mouse').shiftKey).toBe(false);
    // A click a key press makes after a tap (detail 0, no pointer type) is not a tap.
    tap(document.body, 'touch');
    const keyClick = new MouseEvent('click', { bubbles: true, detail: 0 });
    document.body.dispatchEvent(keyClick);
    expect(keyClick.shiftKey).toBe(false);
    key('keyup', 'Shift', { shiftKey: false });
    expect(tap(document.body, 'touch').shiftKey).toBe(false);
  });
});
