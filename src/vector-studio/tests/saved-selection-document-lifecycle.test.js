import { describe, expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { savedSelectionsOf } from '../src/features/panels/select-commands.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const node = createPath(rectangle(0, 0, 20, 20), true);
  ed.doc.transact('Artwork', () => {
    ed.doc.insert(node, ed.targetLayer().id);
    ed.doc.updateRoot({ savedSelections: [{ id: 'saved', name: 'Existing', ids: [node.id] }] });
  });
  ed.select([node.id]);
  return { app, ed };
}

async function close(app, ed) {
  const other = app.newDocument();
  await app.closeDocument(ed, { force: true });
  return { other, original: structuredClone(savedSelectionsOf(ed.doc)), history: ed.doc.undoStack.length };
}

function unchanged(ed, { other, original, history }) {
  expect(savedSelectionsOf(ed.doc)).toEqual(original);
  expect(ed.doc.undoStack).toHaveLength(history);
  expect(savedSelectionsOf(other.doc)).toEqual([]);
}

describe('saved-selection dialog document lifecycle', () => {
  it('ignores a Save Selection answer after its document closes', async () => {
    const { app, ed } = await setup();
    const answer = deferred();
    app.dialogs.form = () => answer.promise;
    const pending = app.commands.run('select.save');
    const before = await close(app, ed);
    answer.resolve({ name: 'Too late' });
    await pending;
    unchanged(ed, before);
  });

  it('ignores an outstanding replacement confirmation after its document closes', async () => {
    const { app, ed } = await setup();
    const answer = deferred(), opened = deferred();
    app.dialogs.form = async () => ({ name: 'Existing' });
    app.dialogs.confirm = () => { opened.resolve(); return answer.promise; };
    const pending = app.commands.run('select.save');
    await opened.promise;
    const before = await close(app, ed);
    answer.resolve(true);
    await pending;
    unchanged(ed, before);
  });

  it('ignores an Edit Selection answer after its document closes', async () => {
    const { app, ed } = await setup();
    const answer = deferred();
    app.dialogs.open = (opts) => {
      const input = opts.body.querySelector('input');
      input.value = 'Too late';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return answer.promise;
    };
    const pending = app.commands.run('select.edit');
    const before = await close(app, ed);
    answer.resolve(true);
    await pending;
    unchanged(ed, before);
  });
  it('saves to its original document when that document is still open in the background', async () => {
    const { app, ed } = await setup();
    const answer = deferred();
    app.dialogs.form = () => answer.promise;
    const pending = app.commands.run('select.save');
    const other = app.newDocument();
    answer.resolve({ name: 'New selection' });
    await pending;
    expect(savedSelectionsOf(ed.doc).map((s) => s.name)).toEqual(['Existing', 'New selection']);
    expect(savedSelectionsOf(other.doc)).toEqual([]);
    ed.doc.undo();
    expect(savedSelectionsOf(ed.doc).map((s) => s.name)).toEqual(['Existing']);
  });

});
