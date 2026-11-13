import { describe, expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { anchor } from '../src/model/bezier.js';

function drawing(ed, x = 0) {
  const p = createPath([anchor(x, 0), anchor(x + 20, 30), anchor(x + 40, 0)], false);
  ed.doc.transact('Artwork', () => ed.doc.insert(p, ed.targetLayer().id));
  ed.select([p.id]);
  return p;
}
const accept = (dialog) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const node = drawing(ed);
  const pending = app.commands.run('path.average');
  const dialog = document.querySelector('dialog[open]');
  return { app, ed, node, pending, dialog };
}

describe('Average dialog ownership', () => {
  it('does not average a different document after a tab switch', async () => {
    const { app, ed, node, pending, dialog } = await setup();
    const other = app.newDocument();
    const otherNode = drawing(other, 100);
    accept(dialog);
    await pending;
    expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
    expect(other.doc.get(otherNode.id).anchors).toEqual(otherNode.anchors);
  });

  it('does not average a newly selected path', async () => {
    const { ed, node, pending, dialog } = await setup();
    const otherNode = drawing(ed, 100);
    accept(dialog);
    await pending;
    expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
    expect(ed.doc.get(otherNode.id).anchors).toEqual(otherNode.anchors);
  });

  it('does not average a different anchor selection on the same path', async () => {
    const { ed, node, pending, dialog } = await setup();
    ed.selectAnchors(node.id, [0, 1]);
    accept(dialog);
    await pending;
    expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
  });

  it('still averages the original anchors in one undo step', async () => {
    const { ed, node, pending, dialog } = await setup();
    const before = ed.doc.undoStack.length;
    accept(dialog);
    await pending;
    expect(ed.doc.get(node.id).anchors.every((p) => p.x === 20 && p.y === 10)).toBe(true);
    expect(ed.doc.undoStack).toHaveLength(before + 1);
    ed.doc.undo();
    expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
  });
});
