import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { parseDocument } from '../src/features/files/format.js';

it.each([[false, false], [true, false], [true, true]])('tracks comments added during a save (existing comments: %s, Save again: %s)', async (existingComments, saveAgain) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ name: 'Artwork' });
  ed.file = { kind: 'puter', path: '/u/Artwork.vstudio', name: 'Artwork.vstudio' };
  if (existingComments) app.comments.addThread('Before saving', { x: 10, y: 10 });
  const savedComments = ed.doc.commentsRevision;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let disk, writes = 0;
  app.puter = { fs: { write: vi.fn(async (path, blob) => {
    const index = writes++;
    if (index === 0) await gate;
    disk = new Uint8Array(await blob.arrayBuffer());
    return { path, name: 'Artwork.vstudio' };
  }) } };
  try {
    const first = app.files.service.save(ed);
    await vi.waitFor(() => expect(writes).toBe(1));
    app.comments.addThread('Added during saving', { x: 20, y: 20 });
    const next = saveAgain ? app.files.service.save(ed) : null;
    release();
    expect(await first).toBe(true);
    if (next) expect(await next).toBe(true);
    const saved = (await parseDocument(disk)).doc;
    if (existingComments) expect(JSON.stringify(saved.comments)).toContain('Before saving');
    if (saveAgain) {
      expect.soft(JSON.stringify(saved.comments)).toContain('Added during saving');
      expect(writes).toBe(2);
      expect(ed.doc.dirty).toBe(false);
    } else {
      expect(JSON.stringify(saved.comments)).not.toContain('Added during saving');
      expect.soft(ed.doc.dirty).toBe(true);
      expect(ed.doc.savedCommentsRevision).toBe(savedComments);
    }
  } finally {
    release();
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});
