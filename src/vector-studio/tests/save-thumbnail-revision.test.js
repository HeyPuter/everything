import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { parseDocument } from '../src/features/files/format.js';

const thumbnail = vi.hoisted(() => vi.fn());
vi.mock('../src/features/files/thumbnail.js', () => ({ renderThumbnail: thumbnail }));

it.each([
  ['edit', false], ['edit', true], ['undo', false], ['undo', true],
])('marks the serialized artwork saved after %s during thumbnail generation (Save again: %s)', async (action, again) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ name: 'Original' });
  ed.file = { kind: 'puter', path: '/u/Drawing.vstudio', name: 'Drawing.vstudio' };
  ed.doc.transact('First edit', () => ed.doc.updateRoot({ name: 'First edit' }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  thumbnail.mockReset().mockReturnValue(gate);
  let disk;
  app.puter = { fs: { write: vi.fn(async (path, blob) => {
    disk = new Uint8Array(await blob.arrayBuffer());
    return { path, name: 'Drawing.vstudio' };
  }) } };
  try {
    const saving = app.files.service.save(ed);
    await vi.waitFor(() => expect(thumbnail).toHaveBeenCalledOnce());
    if (action === 'undo') ed.doc.undo();
    else ed.doc.transact('Latest edit', () => ed.doc.updateRoot({ name: 'Latest edit' }));
    const expectedName = ed.doc.root.name;
    const queued = again ? app.files.service.save(ed) : null;
    release(null);
    expect(await saving).toBe(true);
    if (queued) expect(await queued).toBe(true);
    expect((await parseDocument(disk)).doc.root.name).toBe(expectedName);
    expect.soft(ed.doc.dirty).toBe(false);
    expect.soft(ed.doc.savedRevision).toBe(ed.doc.revision);
    expect(app.puter.fs.write).toHaveBeenCalledOnce();
  } finally {
    release(null);
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});
