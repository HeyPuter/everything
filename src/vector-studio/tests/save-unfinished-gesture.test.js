import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { parseDocument } from '../src/features/files/format.js';

it.each(['before write finishes', 'after write finishes'])('keeps cancelled preview changes unsaved when cancelled %s', async (when) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  ed.file = { kind: 'puter', path: '/u/Drawing.vstudio', name: 'Drawing.vstudio' };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let disk, writing = false;
  app.puter = { fs: { write: vi.fn(async (path, blob) => {
    writing = true;
    disk = new Uint8Array(await blob.arrayBuffer());
    await gate;
    return { path, name: 'Drawing.vstudio' };
  }) } };
  const ptr = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, timeStamp: 1000 });
  try {
    app.setTool('rectangle');
    app.input.down(ptr(100, 100));
    app.input.move(ptr(200, 200));
    expect(Boolean(ed.doc.tx)).toBe(true);
    const saving = app.commands.run('file.save');
    await vi.waitFor(() => expect(writing).toBe(true));
    if (when === 'before write finishes') app.input.cancel(ptr(200, 200));
    release();
    expect(await saving).toBe(true);
    if (when === 'after write finishes') app.input.cancel(ptr(200, 200));
    const saved = (await parseDocument(disk)).doc;
    expect(saved.leaves()).toHaveLength(1);
    expect(ed.doc.leaves()).toHaveLength(0);
    expect(ed.doc.dirty).toBe(true);
    // A second Save writes the cancelled state and can mark the document clean.
    expect(await app.commands.run('file.save')).toBe(true);
    expect((await parseDocument(disk)).doc.leaves()).toHaveLength(0);
    expect(ed.doc.dirty).toBe(false);
  } finally {
    release();
    await app.closeDocument(ed, { force: true });
  }
});

it.each(['unchanged preview', 'changed preview', 'cancelled preview', 'preview started during write'])('handles a queued Save for an %s', async (action) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  ed.file = { kind: 'puter', path: '/u/Drawing.vstudio', name: 'Drawing.vstudio' };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let disk, writes = 0;
  app.puter = { fs: { write: vi.fn(async (path, blob) => {
    writes++;
    await gate;
    disk = new Uint8Array(await blob.arrayBuffer());
    return { path, name: 'Drawing.vstudio' };
  }) } };
  const ptr = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, timeStamp: 1000 });
  const draw = () => {
    app.input.down(ptr(100, 100));
    app.input.move(ptr(200, 200));
  };
  try {
    app.setTool('rectangle');
    if (action !== 'preview started during write') draw();
    const first = app.commands.run('file.save');
    await vi.waitFor(() => expect(writes).toBe(1));
    if (action === 'changed preview') app.input.move(ptr(300, 300));
    if (action === 'cancelled preview') app.input.cancel(ptr(200, 200));
    if (action === 'preview started during write') draw();
    const queued = app.commands.run('file.save');
    release();
    expect(await first).toBe(true);
    expect(await queued).toBe(true);
    const saved = (await parseDocument(disk)).doc;
    expect.soft(saved.leaves().map((n) => n.anchors)).toEqual(ed.doc.leaves().map((n) => n.anchors));
    expect(writes).toBe(action === 'unchanged preview' ? 1 : 2);
    if (action === 'cancelled preview') expect(ed.doc.dirty).toBe(false);
    // Saving must leave the ongoing interaction usable.
    if (ed.doc.tx) {
      app.input.move(ptr(400, 400));
      app.input.up(ptr(400, 400));
      expect(ed.doc.leaves()).toHaveLength(1);
      expect(ed.doc.dirty).toBe(true);
    }
  } finally {
    release();
    await app.closeDocument(ed, { force: true });
  }
});

it('does not mark a save dirty merely because an empty transaction is open', async () => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  ed.file = { kind: 'puter', path: '/u/Drawing.vstudio', name: 'Drawing.vstudio' };
  app.puter = { fs: { write: async (path) => ({ path, name: 'Drawing.vstudio' }) } };
  const tx = ed.doc.begin('No preview changes');
  try {
    expect(await app.commands.run('file.save')).toBe(true);
    expect(ed.doc.dirty).toBe(false);
    tx.cancel();
    expect(ed.doc.dirty).toBe(false);
  } finally {
    tx.cancel();
    await app.closeDocument(ed, { force: true });
  }
});
