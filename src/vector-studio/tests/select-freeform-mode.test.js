import { describe, expect, it } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { matchesStyle, similarObjects, GlobalEdit } from '../src/features/panels/select-commands.js';
import { sampleFreeform, setFreeformMode } from '../src/features/paint/freeform.js';

function setup() {
  const app = bootApp();
  const ed = app.newDocument();
  const linePaint = { type: 'freeform', mode: 'lines', points: [
    { x: 0, y: 0, color: '#ff0000' }, { x: 1, y: 0, color: '#0000ff' },
  ], lines: [[0, 1]] };
  const pointPaint = setFreeformMode(linePaint, 'points');
  const nodes = [linePaint, structuredClone(linePaint), pointPaint].map((fill, i) => createPath(rectangle(i * 30, 0, 20, 20), true, { fill }));
  ed.doc.transact('Gradients', () => nodes.forEach((n) => ed.doc.insert(n, ed.targetLayer().id)));
  return { app, ed, nodes, linePaint, pointPaint };
}

describe('freeform mode in graphic styles and global edits', () => {
  it('distinguishes a lines gradient from the same paint switched to points', () => {
    const { ed, nodes, linePaint, pointPaint } = setup();
    expect(sampleFreeform(linePaint, 0.25, 0)).not.toEqual(sampleFreeform(pointPaint, 0.25, 0));
    expect(matchesStyle(ed.doc, nodes[0], { fill: linePaint })).toBe(true);
    expect(matchesStyle(ed.doc, nodes[1], { fill: linePaint })).toBe(true);
    expect(matchesStyle(ed.doc, nodes[2], { fill: linePaint })).toBe(false);
    expect(similarObjects(ed.doc, nodes[0])).toEqual(nodes.slice(0, 2).map((n) => n.id));
  });

  it('treats omitted freeform mode as points and keeps solid color metadata irrelevant', () => {
    const { ed, nodes, pointPaint } = setup();
    const implicitPoints = { ...pointPaint };
    delete implicitPoints.mode;
    expect(matchesStyle(ed.doc, nodes[2], { fill: implicitPoints })).toBe(true);
    const solid = { type: 'solid', color: '#ff0000' };
    const node = { ...nodes[0], fill: { ...solid, mode: 'rgb' } };
    expect(matchesStyle(ed.doc, node, { fill: { ...solid, mode: 'cmyk', cmyk: [0, 1, 1, 0] } })).toBe(true);
  });

  it('propagates a mode change during global edit and undoes both changes together', () => {
    const { app, ed, nodes, pointPaint } = setup();
    const session = new GlobalEdit(app, ed, nodes.slice(0, 2).map((n) => n.id));
    try {
      ed.doc.transact('Points', () => ed.doc.update(nodes[0].id, { fill: pointPaint }));
      expect(ed.doc.get(nodes[1].id).fill.mode).toBe('points');
      ed.doc.undo();
      expect(ed.doc.get(nodes[0].id).fill.mode).toBe('lines');
      expect(ed.doc.get(nodes[1].id).fill.mode).toBe('lines');
    } finally {
      session.stop();
    }
  });
});
