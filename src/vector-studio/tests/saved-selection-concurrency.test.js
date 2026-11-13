import { describe, expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { savedSelectionsOf } from '../src/features/panels/select-commands.js';

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  ed.doc.transact('Selections', () => ed.doc.updateRoot({ savedSelections: [
    { id: 'one', name: 'One', ids: ['old-one'] },
    { id: 'two', name: 'Two', ids: ['old-two'] },
  ] }));
  let dialog, answer;
  app.dialogs.open = (opts) => {
    dialog = opts;
    return new Promise((resolve) => { answer = resolve; });
  };
  const pending = app.commands.run('select.edit');
  return { ed, pending, dialog, answer };
}

function rename(dialog, index, value) {
  const input = dialog.body.querySelectorAll('input')[index];
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function concurrentEdit(doc) {
  doc.transact('Other window', () => doc.updateRoot({ savedSelections: [
    { id: 'one', name: 'One', ids: ['updated-one'] },
    { id: 'two', name: 'Renamed elsewhere', ids: ['updated-two'] },
    { id: 'new', name: 'New selection', ids: ['new-object'] },
  ] }));
}

describe('editing saved selections with concurrent document changes', () => {
  it('preserves updated membership, remote renames, and newly added selections', async () => {
    const { ed, pending, dialog, answer } = await setup();
    rename(dialog, 0, 'Local name');
    concurrentEdit(ed.doc);
    const latest = structuredClone(savedSelectionsOf(ed.doc));
    answer(true);
    await pending;
    expect(savedSelectionsOf(ed.doc)).toEqual([
      { ...latest[0], name: 'Local name' }, latest[1], latest[2],
    ]);
    ed.doc.undo();
    expect(savedSelectionsOf(ed.doc)).toEqual(latest);
  });

  it('keeps an explicit deletion without restoring a selection removed elsewhere', async () => {
    const { ed, pending, dialog, answer } = await setup();
    dialog.body.querySelector('button[aria-label="Delete One"]').click();
    ed.doc.transact('Other window', () => ed.doc.updateRoot({ savedSelections: [
      { id: 'one', name: 'One', ids: ['updated-one'] },
      { id: 'new', name: 'New', ids: [] },
    ] }));
    answer(true);
    await pending;
    expect(savedSelectionsOf(ed.doc)).toEqual([{ id: 'new', name: 'New', ids: [] }]);
  });

  it('does not add an undo step when no local changes remain to apply', async () => {
    const { ed, pending, answer } = await setup();
    concurrentEdit(ed.doc);
    const latest = savedSelectionsOf(ed.doc);
    const count = ed.doc.undoStack.length;
    answer(true);
    await pending;
    expect(savedSelectionsOf(ed.doc)).toBe(latest);
    expect(ed.doc.undoStack).toHaveLength(count);
  });

  it('preserves concurrent changes when the dialog is cancelled', async () => {
    const { ed, pending, dialog, answer } = await setup();
    rename(dialog, 0, 'Cancelled name');
    concurrentEdit(ed.doc);
    const latest = structuredClone(savedSelectionsOf(ed.doc));
    answer(null);
    await pending;
    expect(savedSelectionsOf(ed.doc)).toEqual(latest);
  });
});
