import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { parseDocument } from '../src/features/files/format.js';

it('honors Save requested while a follow-up save is already writing', async () => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ name: 'First' });
  ed.file = { kind: 'puter', path: '/u/Artwork.vstudio', name: 'Artwork.vstudio' };
  const releases = [];
  const gates = [0, 1].map(() => new Promise((resolve) => releases.push(resolve)));
  let disk, writes = 0;
  app.puter = { fs: { write: vi.fn(async (path, blob) => {
    const index = writes++;
    if (index < gates.length) await gates[index];
    disk = new Uint8Array(await blob.arrayBuffer());
    return { path, name: 'Artwork.vstudio' };
  }) } };
  try {
    const first = app.files.service.save(ed);
    await vi.waitFor(() => expect(writes).toBe(1));
    ed.doc.transact('Second', () => ed.doc.updateRoot({ name: 'Second' }));
    const second = app.files.service.save(ed);
    releases[0]();
    await vi.waitFor(() => expect(writes).toBe(2));
    ed.doc.transact('Latest', () => ed.doc.updateRoot({ name: 'Latest' }));
    const latest = app.files.service.save(ed);
    releases[1]();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(await latest).toBe(true);
    expect.soft(ed.doc.dirty).toBe(false);
    expect.soft((await parseDocument(disk)).doc.root.name).toBe('Latest');
    expect(writes).toBe(3);
  } finally {
    releases.forEach((release) => release());
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});

it('coalesces repeated Save requests when no newer edit needs writing', async () => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  ed.file = { kind: 'puter', path: '/u/Artwork.vstudio', name: 'Artwork.vstudio' };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  app.puter = { fs: { write: vi.fn(async (path) => {
    await gate;
    return { path, name: 'Artwork.vstudio' };
  }) } };
  try {
    const first = app.files.service.save(ed);
    await vi.waitFor(() => expect(app.puter.fs.write).toHaveBeenCalledOnce());
    const queued = Array.from({ length: 5 }, () => app.files.service.save(ed));
    release();
    expect(await Promise.all([first, ...queued])).toEqual(Array(6).fill(true));
    expect(app.puter.fs.write).toHaveBeenCalledOnce();
    expect(ed.doc.dirty).toBe(false);
  } finally {
    release();
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});
