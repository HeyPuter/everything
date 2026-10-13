import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { copy, paste } from '../src/ops/clipboard.js';
import { placeSVG, placeText } from '../src/features/io/place.js';

let app;
beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
});

function addRect(x, y, w, h) {
  const doc = app.editor.doc;
  const node = createPath(rectangle(x, y, w, h), true, { fill: { type: 'solid', color: '#3366cc' }, stroke: { type: 'solid', color: '#000000' }, strokeWidth: 2 });
  doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
  return node.id;
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect x="0" y="0" width="20" height="20" fill="#ff0000"/></svg>';

describe('paste and place follow the drawing mode', () => {
  it('Paste in Draw Behind goes behind the selection', () => {
    const ed = app.editor;
    const a = addRect(0, 0, 50, 50);
    const b = addRect(100, 0, 50, 50);
    ed.select([a]);
    copy(ed);
    ed.select([b]);
    app.commands.run('view.drawMode.behind');
    paste(ed, 'center');
    const layer = ed.doc.get(ed.targetLayer().id);
    const pasted = [...ed.selection][0];
    expect(layer.children).toEqual([a, pasted, b]);
  });

  it('Paste in Place in Draw Inside goes inside the clipping path', () => {
    const ed = app.editor;
    const frame = addRect(0, 0, 100, 100);
    const other = addRect(20, 20, 30, 30);
    ed.select([other]);
    copy(ed);
    ed.select([frame]);
    app.commands.run('view.drawMode.inside');
    paste(ed, 'place');
    const pasted = [...ed.selection][0];
    const g = ed.doc.get(ed.doc.get(pasted).parent);
    expect(g.type).toBe('group');
    expect(g.clip).toBe(true);
    expect(g.children.at(-1)).toBe(frame);
  });

  it('Paste in Front ignores the drawing mode', () => {
    const ed = app.editor;
    const a = addRect(0, 0, 50, 50);
    const b = addRect(100, 0, 50, 50);
    ed.select([a]);
    copy(ed);
    app.commands.run('view.drawMode.behind');
    paste(ed, 'front');
    const layer = ed.doc.get(ed.targetLayer().id);
    expect(layer.children.indexOf(a)).toBe(0);
    expect(layer.children.at(-1)).toBe(b);
  });

  it('Place puts SVG artwork behind the selection in Draw Behind', async () => {
    const ed = app.editor;
    const a = addRect(0, 0, 50, 50);
    const b = addRect(100, 0, 50, 50);
    ed.select([b]);
    app.commands.run('view.drawMode.behind');
    const id = await placeSVG(app, ed, SVG);
    expect(id).toBeTruthy();
    expect(ed.doc.get(ed.targetLayer().id).children).toEqual([a, id, b]);
  });

  it('Place puts SVG artwork and text inside the Draw Inside path', async () => {
    const ed = app.editor;
    const frame = addRect(0, 0, 100, 100);
    ed.select([frame]);
    app.commands.run('view.drawMode.inside');
    const id = await placeSVG(app, ed, SVG);
    const g = ed.doc.get(ed.doc.get(id).parent);
    expect(g.clip).toBe(true);
    ed.select([frame]);
    const t = placeText(app, ed, 'Hello');
    expect(ed.doc.get(t).parent).toBe(g.id);
  });
});
