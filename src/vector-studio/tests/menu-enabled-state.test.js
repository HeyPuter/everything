// Menu commands are enabled only when they can act on the selection or document.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { installCanvasStub, bootAppWithFeatures } from './helpers.js';
import { createPath, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { anchor } from '../src/model/bezier.js';
import { DEFAULT_GRAPHIC_STYLES } from '../src/features/paint/graphic-styles.js';

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

describe('Select menu', () => {
  it('Brush Strokes and Bristle Brush Strokes need such strokes in the document', () => {
    rect(10);
    expect(on('select.object.brushStrokes')).toBe(false);
    expect(on('select.object.bristleStrokes')).toBe(false);
    const basic = line(100, { brush: { id: 'def.basic' } });
    expect(on('select.object.brushStrokes')).toBe(true);
    expect(on('select.object.bristleStrokes')).toBe(false);
    const bristle = line(150, { brush: { id: 'lib.bristle.soft-round' } });
    expect(on('select.object.bristleStrokes')).toBe(true);
    // Hidden or locked strokes are not selectable, so they don't count.
    doc.transact('Hide', () => doc.update(bristle, { hidden: true }));
    expect(on('select.object.bristleStrokes')).toBe(false);
    doc.undo();
    expect(on('select.object.bristleStrokes')).toBe(true);
    doc.transact('Lock', () => {
      doc.update(basic, { locked: true });
      doc.update(bristle, { locked: true });
    });
    expect(on('select.object.brushStrokes')).toBe(false);
  });

  it('Same > Appearance Attribute and Graphic Style need something to match', () => {
    const plain = rect(10);
    app.editor.select([plain]);
    expect(on('select.same.appearanceAttribute')).toBe(false);
    expect(on('select.same.graphicStyle')).toBe(false);
    const neon = DEFAULT_GRAPHIC_STYLES.find((s) => s.id === 'gs-neon').style;
    const styled = add(createPath(rectangle(100, 10, 40, 20), true, structuredClone(neon)));
    app.editor.select([styled]);
    expect(on('select.same.graphicStyle')).toBe(true);
    expect(on('select.same.appearanceAttribute')).toBe(true);
    // Restyling the selected object updates the answer.
    doc.transact('Fill', () => doc.update(styled, { fill: solid('#123456'), effects: [] }));
    expect(on('select.same.graphicStyle')).toBe(false);
    expect(on('select.same.appearanceAttribute')).toBe(false);
  });

  it('Same > Fill Color and the like need a selected object other than a group', async () => {
    const a = rect(10);
    const b = rect(100, { fill: solid('#00ff00') });
    app.editor.select([a, b]);
    await app.commands.run('object.group');
    for (const id of [
      'select.same.fill',
      'select.same.stroke',
      'select.same.opacity',
      'select.same.appearance',
      'select.same.shapesText',
    ])
      expect(on(id), id).toBe(false);
    app.editor.select([a]);
    for (const id of [
      'select.same.fill',
      'select.same.stroke',
      'select.same.opacity',
      'select.same.appearance',
      'select.same.shapesText',
    ])
      expect(on(id), id).toBe(true);
  });

  it('Direction Handles needs a curve; Start Global Edit needs a path', () => {
    const r = rect(10);
    app.editor.select([r]);
    expect(on('select.object.handles')).toBe(false);
    expect(on('select.globalEdit')).toBe(true);
    const curve = add(
      createPath(
        [anchor(0, 0), { x: 50, y: 0, ix: 40, iy: -10, ox: 60, oy: 10 }, anchor(100, 0)],
        false,
      ),
    );
    app.editor.select([curve]);
    expect(on('select.object.handles')).toBe(true);
    // Only among the selected anchors when some are.
    app.editor.selectAnchors(curve, [0]);
    expect(on('select.object.handles')).toBe(false);
    const t = add(createText('Hi', 10, 100));
    app.editor.select([t]);
    expect(on('select.globalEdit')).toBe(false);
    expect(on('select.same.shapesText')).toBe(true);
  });
});
