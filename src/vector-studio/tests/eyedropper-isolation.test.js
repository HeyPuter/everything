import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

const red = { type: 'solid', color: '#ff0000' };
const blue = { type: 'solid', color: '#0000ff' };
const ev = (x, y, alt = false) => ({ x, y, sx: x, sy: y, alt, shift: false, mod: false, button: 0, pointerType: 'mouse', native: {} });

function setup() {
  const app = bootApp();
  const ed = app.newDocument();
  ed.view.set({ zoom: 1, panX: 0, panY: 0, width: 500, height: 500 });
  const doc = ed.doc;
  const group = createGroup([]);
  const inside = createPath(rectangle(0, 0, 20, 20), true, { fill: red });
  const outside = createPath(rectangle(100, 0, 20, 20), true, { fill: blue });
  doc.transact('Artwork', () => {
    doc.insert(group, ed.targetLayer().id);
    doc.insert(inside, group.id);
    doc.insert(outside, ed.targetLayer().id);
  });
  app.commands.run('object.isolate', { id: group.id });
  app.setTool('eyedropper');
  return { app, ed, doc, inside, outside };
}

describe('Eyedropper isolation', () => {
  it('does not apply paint outside isolation with Alt-click', () => {
    const { app, ed, doc, outside } = setup();
    ed.setStyle({ fill: red });
    const before = doc.undoStack.length;
    app.tool.onPointerDown(ev(110, 10, true));
    expect(doc.get(outside.id).fill).toEqual(blue);
    expect(doc.undoStack).toHaveLength(before);
  });

  it('still applies paint inside isolation and can sample outside it', () => {
    const { app, ed, doc, inside } = setup();
    ed.select([inside.id]);
    app.tool.onPointerDown(ev(110, 10));
    expect(doc.get(inside.id).fill).toEqual(blue);
    doc.undo();
    expect(doc.get(inside.id).fill).toEqual(red);
    ed.setStyle({ fill: blue });
    app.tool.onPointerDown(ev(10, 10, true));
    expect(doc.get(inside.id).fill).toEqual(blue);
    doc.undo();
    expect(doc.get(inside.id).fill).toEqual(red);
  });
});
