import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { saveSelection, applySavedSelection } from '../src/features/panels/select-commands.js';

describe.each(['reselect', 'saved selection'])('restoring %s', (mode) => {
  it.each(['hidden', 'locked', 'isolation'])('excludes objects made unavailable by %s', async (state) => {
    const app = bootApp();
    const ed = app.newDocument();
    const doc = ed.doc;
    const group = createGroup([]);
    const available = createPath(rectangle(0, 0, 20, 20), true);
    const unavailable = createPath(rectangle(30, 0, 20, 20), true);
    const deleted = createPath(rectangle(60, 0, 20, 20), true);
    doc.transact('Artwork', () => {
      doc.insert(group, ed.targetLayer().id);
      doc.insert(available, ed.targetLayer().id);
      doc.insert(unavailable, group.id);
      doc.insert(deleted, ed.targetLayer().id);
    });
    ed.select([available.id, unavailable.id, deleted.id]);
    doc.transact('Remember', () => saveSelection(doc, 'Remember', [...ed.selection]));
    await app.commands.run('select.none');
    doc.transact('Change', () => {
      doc.remove(deleted.id);
      if (state !== 'isolation') doc.update(group.id, { [state]: true });
    });
    if (state === 'isolation') await app.commands.run('object.isolate', { id: available.id });
    if (mode === 'reselect') await app.commands.run('select.reselect');
    else expect(applySavedSelection(ed, doc.root.savedSelections[0].id)).toBe(1);
    expect([...ed.selection]).toEqual([available.id]);
  });
});
