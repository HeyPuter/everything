import { describe, expect, it } from 'vitest';
import { paintSetup } from './panels-paint-helpers.js';
import { VDocument } from '../src/model/document.js';
import { addGroup, addSwatch, groupsOf } from '../src/features/paint/swatch-model.js';

const accept = (dialog) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
async function setup() {
  const { app, ed, doc, panel } = await paintSetup();
  let gid, sid;
  doc.transact('Resources', () => {
    gid = addGroup(doc, 'Original');
    sid = addSwatch(doc, { name: 'Red', paint: { type: 'solid', color: '#ff0000' } });
  });
  const p = panel('swatches');
  p.selected = new Set([sid]);
  return { app, ed, doc, p, gid, sid };
}
function dialogName(value) {
  const dialog = document.querySelector('dialog[open]');
  dialog.querySelector('input[type=text]').value = value;
  return dialog;
}

describe('Color group dialog ownership', () => {
  it('renames the original open document after switching to a copy with the same group IDs', async () => {
    const { app, doc, p, gid } = await setup();
    const copy = VDocument.fromJSON(doc.toJSON());
    const pending = p.renameGroup(groupsOf(doc).find((g) => g.id === gid));
    const dialog = dialogName('Renamed');
    app.addDocument(copy);
    accept(dialog);
    await pending;
    expect(groupsOf(doc).find((g) => g.id === gid).name).toBe('Renamed');
    expect(groupsOf(copy).find((g) => g.id === gid).name).toBe('Original');
  });
  for (const method of ['rename', 'new']) {
    it(`ignores a ${method} answer after the originating window closes`, async () => {
      const { app, ed, doc, p, gid } = await setup();
      const copy = VDocument.fromJSON(doc.toJSON());
      app.addDocument(copy, { activate: false });
      const pending = method === 'rename' ? p.renameGroup(groupsOf(doc).find((g) => g.id === gid)) : p.newGroup();
      const dialog = dialogName('New name');
      const original = groupsOf(doc), other = groupsOf(copy);
      const history = doc.undoStack.length, otherHistory = copy.undoStack.length;
      await app.closeDocument(ed, { force: true });
      accept(dialog);
      await pending;
      expect(groupsOf(doc)).toEqual(original);
      expect(groupsOf(copy)).toEqual(other);
      expect(doc.undoStack).toHaveLength(history);
      expect(copy.undoStack).toHaveLength(otherHistory);
    });
    it(`does not add a ${method} answer to a newer transaction`, async () => {
      const { doc, p, gid } = await setup();
      const pending = method === 'rename' ? p.renameGroup(groupsOf(doc).find((g) => g.id === gid)) : p.newGroup();
      const dialog = dialogName('New name');
      const before = groupsOf(doc);
      const tx = doc.begin('Newer edit');
      try {
        doc.updateRoot({ name: 'Newer edit' });
        accept(dialog);
        await pending;
        expect(groupsOf(doc)).toEqual(before);
        expect(doc.tx).toBe(tx);
      } finally { tx.cancel(); }
    });
  }
  it('keeps the other document panel selection when creating a group in the original document', async () => {
    const { app, doc, p, sid } = await setup();
    const pending = p.newGroup();
    const dialog = dialogName('Created');
    const other = app.newDocument();
    const otherId = other.doc.root.swatches[0].id;
    p.selected = new Set([otherId]);
    p.focusId = otherId;
    accept(dialog);
    await pending;
    const created = groupsOf(doc).find((g) => g.name === 'Created');
    expect(created).toBeTruthy();
    expect(doc.root.swatches.find((s) => s.id === sid).group).toBe(created.id);
    expect(p.selected).toEqual(new Set([otherId]));
    expect(p.focusId).toBe(otherId);
  });
});
