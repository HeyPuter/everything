// Menu commands are enabled only when they can act on the selection or document.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { installCanvasStub, bootAppWithFeatures } from './helpers.js';
import { createPath, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { anchor } from '../src/model/bezier.js';

beforeAll(() => installCanvasStub());

const solid = (color) => ({ type: 'solid', color });

let app;
let doc;
let notes;
const on = (id) => app.commands.isEnabled(id);

function add(node) {
  doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
  return node.id;
}
const rect = (x, style = { fill: solid('#ff0000') }) =>
  add(createPath(rectangle(x, 10, 40, 20), true, style));
const line = (y, style = {}) => add(createPath([anchor(0, y), anchor(100, y)], false, style));

beforeEach(async () => {
  app = await bootAppWithFeatures();
  notes = [];
  app.notify = (m, o) => notes.push([m, Boolean(o?.error)]);
  doc = app.newDocument({ width: 600, height: 400 }).doc;
});

describe('Join and Average', () => {
  it('Join needs an open path; Average needs two anchor points', async () => {
    const r = rect(10);
    app.editor.select([r]);
    expect(on('path.join')).toBe(false);
    expect(on('path.averageJoin')).toBe(false);
    // A closed path's anchors can still be averaged.
    expect(on('path.average')).toBe(true);
    const t = add(createText('Hi', 10, 100));
    app.editor.select([t]);
    expect(on('path.join')).toBe(false);
    expect(on('path.average')).toBe(false);
    // One selected anchor point: nothing to average.
    const l = line(200);
    app.editor.selectAnchors(l, [0]);
    expect(on('path.average')).toBe(false);
    expect(on('path.averageJoin')).toBe(false);
    expect(on('path.join')).toBe(true);
    app.editor.selectAnchors(l, [0, 1]);
    expect(on('path.average')).toBe(true);
    expect(on('path.averageJoin')).toBe(true);
    // Mod+J on a closed path does nothing instead of showing an error.
    app.editor.select([r]);
    await app.commands.run('path.join');
    expect(notes).toEqual([]);
    // Two open paths join.
    const l2 = add(createPath([anchor(100, 200), anchor(200, 250)], false));
    app.editor.select([l, l2]);
    expect(on('path.join')).toBe(true);
    await app.commands.run('path.join');
    expect(doc.has(l2)).toBe(false);
    expect(doc.get(l).anchors).toHaveLength(3);
  });
});
