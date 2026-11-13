import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { parseDocument } from '../src/features/files/format.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

it.each([['comment', false], ['edit then Undo', false], ['comment', true], ['edit then Undo', true]])('asks again before closing after %s (save the remaining changes: %s)', async (change, saveAgain) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  ed.file = { kind: 'puter', path: '/u/Drawing.vstudio', name: 'Drawing.vstudio' };
  ed.doc.transact('First edit', () => ed.doc.updateRoot({ name: 'First edit' }));
  const originalRevision = ed.doc.revision;
  let releaseEncode, releaseWrite;
  const encodeGate = new Promise((resolve) => { releaseEncode = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  let disk, writing = false, prompts = 0;
  app.puter = { fs: { write: async (path, blob) => {
    disk = new Uint8Array(await blob.arrayBuffer());
    writing = true;
    await writeGate;
    return { path, name: 'Drawing.vstudio' };
  } } };
  const encode = app.files.service.encode.bind(app.files.service);
  const spy = vi.spyOn(app.files.service, 'encode').mockImplementation(async (...args) => {
    await encodeGate;
    return encode(...args);
  });
  dialogHooks.open = async () => (++prompts === 1 || (prompts === 2 && saveAgain)) ? 'save' : null;
  try {
    const closing = app.closeDocument(ed);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    if (change === 'edit then Undo') ed.doc.transact('Second edit', () => ed.doc.updateRoot({ name: 'Second edit' }));
    releaseEncode();
    await vi.waitFor(() => expect(writing).toBe(true));
    if (change === 'comment') app.comments.addThread('Added while closing', { x: 10, y: 10 });
    else ed.doc.undo();
    expect(ed.doc.revision).toBe(originalRevision);
    releaseWrite();
    expect.soft(await closing).toBe(saveAgain);
    expect.soft(prompts).toBe(2);
    expect(app.editors.includes(ed)).toBe(!saveAgain);
    expect(ed.doc.dirty).toBe(!saveAgain);
    const saved = (await parseDocument(disk)).doc;
    if (change === 'comment') {
      if (saveAgain) expect(JSON.stringify(saved.comments)).toContain('Added while closing');
      else expect(JSON.stringify(saved.comments)).not.toContain('Added while closing');
      expect(JSON.stringify(ed.doc.comments)).toContain('Added while closing');
    } else {
      expect(saved.root.name).toBe(saveAgain ? 'First edit' : 'Second edit');
      expect(ed.doc.root.name).toBe('First edit');
    }
  } finally {
    releaseEncode();
    releaseWrite();
    spy.mockRestore();
    dialogHooks.open = null;
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});
