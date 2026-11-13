import { describe, expect, it } from 'vitest';
import { bootApp } from './helpers.js';
import { createCompound, createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { GlobalEdit } from '../src/features/panels/select-commands.js';

function setup(compound) {
  const app = bootApp();
  const ed = app.newDocument();
  const paths = [0, 50].map((x) => createPath(rectangle(x, 0, 20, 20), false));
  const members = compound ? paths.map(() => createCompound([])) : paths;
  ed.doc.transact('Paths', () => {
    members.forEach((n, i) => {
      ed.doc.insert(n, ed.targetLayer().id);
      if (compound) ed.doc.insert(paths[i], n.id);
    });
  });
  const session = new GlobalEdit(app, ed, members.map((n) => n.id));
  return { app, ed, paths, session };
}

describe('Global Edit path closure', () => {
  it.each([false, true])('propagates opening and closing paths, including compound=%s', (compound) => {
    const { ed, paths, session } = setup(compound);
    try {
      const before = ed.doc.undoStack.length;
      ed.doc.transact('Close path', () => ed.doc.update(paths[0].id, { closed: true }));
      expect(paths.map((p) => ed.doc.get(p.id).closed)).toEqual([true, true]);
      expect(ed.doc.get(paths[1].id).anchors).toEqual(paths[1].anchors);
      expect(ed.doc.undoStack).toHaveLength(before + 1);
      ed.doc.undo();
      expect(paths.map((p) => ed.doc.get(p.id).closed)).toEqual([false, false]);
      ed.doc.redo();
      expect(paths.map((p) => ed.doc.get(p.id).closed)).toEqual([true, true]);
      ed.doc.transact('Open path', () => ed.doc.update(paths[1].id, { closed: false }));
      expect(paths.map((p) => ed.doc.get(p.id).closed)).toEqual([false, false]);
    } finally {
      session.stop();
    }
  });

  it('keeps matching paths closed when Join closes the edited path', async () => {
    const { app, ed, paths, session } = setup(false);
    try {
      ed.select([paths[0].id]);
      await app.commands.run('path.join');
      expect(paths.map((p) => ed.doc.get(p.id).closed)).toEqual([true, true]);
    } finally {
      session.stop();
    }
  });
});
