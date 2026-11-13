import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createImage } from '../src/model/nodes.js';
import { replaceImage, updateLinks, relink, embedImages } from '../src/features/panels/links.js';

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function delayedImage(name) {
  const gate = deferred();
  return { blob: { name, type: 'image/png', arrayBuffer: vi.fn(() => gate.promise) }, finish: () => gate.resolve(png.buffer), fail: gate.reject };
}
async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  ed.doc.assets.set('original', { mime: 'image/png', data: 'data:image/png;base64,original' });
  const node = createImage('original', 10, 10, [1, 0, 0, 1, 0, 0], { link: { source: 'puter', path: '/u/Original.png', name: 'Original.png' } });
  ed.doc.transact('Image', () => ed.doc.insert(node, ed.targetLayer().id));
  return { app, ed, node };
}
async function closeAll(app) {
  for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
}
const link = (name) => ({ source: 'puter', path: `/u/${name}.png`, name: `${name}.png` });

it.each([[false, false], [true, false], [false, true], [true, true]])('keeps the latest replacement (older completes first: %s, shared window: %s)', async (olderFirst, shared) => {
  const { app, ed, node } = await setup();
  const receiving = shared ? app.addDocument(ed.doc, { activate: false }) : ed;
  const older = delayedImage('Older.png');
  const newer = delayedImage('Newer.png');
  try {
    const first = replaceImage(app, ed, [node.id], older.blob, { link: link('Older') });
    await vi.waitFor(() => expect(older.blob.arrayBuffer).toHaveBeenCalledOnce());
    const latest = replaceImage(app, receiving, [node.id], newer.blob, { link: link('Newer') });
    await vi.waitFor(() => expect(newer.blob.arrayBuffer).toHaveBeenCalledOnce());
    if (olderFirst) {
      older.finish();
      expect.soft((await first) === null).toBe(true);
      expect.soft(ed.doc.get(node.id).asset).toBe('original');
    }
    newer.finish();
    const applied = await latest;
    if (!olderFirst) {
      older.finish();
      expect.soft((await first) === null).toBe(true);
    }
    expect(ed.doc.get(node.id).asset).toBe(applied.assetId);
    expect(ed.doc.get(node.id).link.path).toBe('/u/Newer.png');
    expect(ed.doc.assets.size).toBe(2);
    ed.doc.undo();
    expect(ed.doc.get(node.id).asset).toBe('original');
  } finally {
    older.finish(); newer.finish();
    await closeAll(app);
  }
});

it('does not let an older Update Link read replace a later Relink', async () => {
  const { app, ed, node } = await setup();
  const read = deferred();
  app.puter = { fs: { read: vi.fn(() => read.promise) } };
  try {
    const update = updateLinks(app, ed, [node.id]);
    await vi.waitFor(() => expect(app.puter.fs.read).toHaveBeenCalledOnce());
    const latest = await replaceImage(app, ed, [node.id], new File([png], 'Latest.png'), { link: link('Latest') });
    read.resolve(new Blob([png], { type: 'image/png' }));
    expect(await update).toBe(0);
    expect(ed.doc.get(node.id).asset).toBe(latest.assetId);
    expect(ed.doc.get(node.id).link.path).toBe('/u/Latest.png');
    expect(ed.doc.assets.size).toBe(2);
  } finally {
    read.resolve(new Blob([png], { type: 'image/png' }));
    await closeAll(app);
  }
});

it('does not let a pending Update Links batch reclaim a target relinked by a later request', async () => {
  const { app, ed, node } = await setup();
  const second = createImage('original', 10, 10, [1, 0, 0, 1, 20, 20], { link: link('Second') });
  ed.doc.transact('Second', () => ed.doc.insert(second, ed.targetLayer().id));
  const read = deferred();
  app.puter = { fs: { read: vi.fn(() => read.promise) } };
  try {
    const update = updateLinks(app, ed, [node.id, second.id]);
    await vi.waitFor(() => expect(app.puter.fs.read).toHaveBeenCalledOnce());
    const latest = await replaceImage(app, ed, [second.id], new File([png], 'Latest.png'), { link: link('Latest') });
    read.resolve(new Blob([png], { type: 'image/png' }));
    expect(await update).toBe(1);
    expect(app.puter.fs.read).toHaveBeenCalledOnce();
    expect(ed.doc.get(second.id).asset).toBe(latest.assetId);
    expect(ed.doc.get(node.id).asset).not.toBe('original');
  } finally {
    read.resolve(new Blob([png], { type: 'image/png' }));
    await closeAll(app);
  }
});

it('orders Relink requests from the selected file, before its cloud read finishes', async () => {
  const { app, ed, node } = await setup();
  const read = deferred();
  const olderRead = vi.fn(() => read.promise);
  app.user = { username: 'test' };
  app.dialogs.open = async () => 'puter';
  app.puter = { ui: { showOpenFilePicker: vi.fn()
    .mockResolvedValueOnce({ name: 'Older.png', path: '/u/Older.png', read: olderRead })
    .mockResolvedValueOnce({ name: 'Newer.png', path: '/u/Newer.png', read: async () => new Blob([png], { type: 'image/png' }) }) } };
  try {
    const first = relink(app, ed, [node.id]);
    await vi.waitFor(() => expect(olderRead).toHaveBeenCalledOnce());
    expect(await relink(app, ed, [node.id])).toBe(true);
    read.resolve(new Blob([png], { type: 'image/png' }));
    expect(await first).toBe(false);
    expect(ed.doc.get(node.id).link.path).toBe('/u/Newer.png');
    expect(ed.doc.assets.size).toBe(2);
  } finally {
    read.resolve(new Blob([png], { type: 'image/png' }));
    await closeAll(app);
  }
});

it('does not undo Embed when a previously requested replacement finishes', async () => {
  const { app, ed, node } = await setup();
  const image = delayedImage('Replacement.png');
  try {
    const replacing = replaceImage(app, ed, [node.id], image.blob, { link: link('Replacement') });
    await vi.waitFor(() => expect(image.blob.arrayBuffer).toHaveBeenCalledOnce());
    embedImages(ed, [node.id]);
    image.finish();
    expect((await replacing) === null).toBe(true);
    expect(ed.doc.get(node.id).link).toBeUndefined();
    expect(ed.doc.get(node.id).asset).toBe('original');
    expect(ed.doc.assets.size).toBe(1);
  } finally {
    image.finish();
    await closeAll(app);
  }
});

it('applies only the unaffected targets of an older overlapping replacement', async () => {
  const { app, ed, node } = await setup();
  const second = createImage('original', 10, 10, [1, 0, 0, 1, 20, 20], { link: link('Second') });
  ed.doc.transact('Second', () => ed.doc.insert(second, ed.targetLayer().id));
  const older = delayedImage('Older.png');
  try {
    const pending = replaceImage(app, ed, [node.id, second.id], older.blob, { link: link('Older') });
    await vi.waitFor(() => expect(older.blob.arrayBuffer).toHaveBeenCalledOnce());
    const latest = await replaceImage(app, ed, [second.id], new File([png], 'Latest.png'), { link: link('Latest') });
    older.finish();
    const applied = await pending;
    expect(ed.doc.get(node.id).asset).toBe(applied.assetId);
    expect(ed.doc.get(second.id).asset).toBe(latest.assetId);
    ed.doc.undo();
    expect(ed.doc.get(node.id).asset).toBe('original');
    expect(ed.doc.get(second.id).asset).toBe(latest.assetId);
  } finally {
    older.finish();
    await closeAll(app);
  }
});

it('preserves transforms changed while replacement decoding is pending', async () => {
  const { app, ed, node } = await setup();
  const image = delayedImage('Replacement.png');
  try {
    const replacing = replaceImage(app, ed, [node.id], image.blob);
    await vi.waitFor(() => expect(image.blob.arrayBuffer).toHaveBeenCalledOnce());
    ed.doc.transact('Transform', () => ed.doc.update(node.id, { transform: [2, 0, 0, 2, 80, 90] }));
    image.finish();
    expect((await replacing) !== null).toBe(true);
    expect(ed.doc.get(node.id).transform).toEqual([20, 0, 0, 20, 80, 90]);
    ed.doc.undo();
    expect(ed.doc.get(node.id).transform).toEqual([2, 0, 0, 2, 80, 90]);
  } finally {
    image.finish();
    await closeAll(app);
  }
});

it('does not cancel an existing request when a later file picker is cancelled', async () => {
  const { app, ed, node } = await setup();
  const image = delayedImage('Replacement.png');
  app.user = { username: 'test' };
  app.dialogs.open = async () => 'puter';
  app.puter = { ui: { showOpenFilePicker: async () => null } };
  try {
    const pending = replaceImage(app, ed, [node.id], image.blob);
    await vi.waitFor(() => expect(image.blob.arrayBuffer).toHaveBeenCalledOnce());
    expect(await relink(app, ed, [node.id])).toBe(false);
    image.finish();
    const applied = await pending;
    expect(ed.doc.get(node.id).asset).toBe(applied.assetId);
  } finally {
    image.finish();
    await closeAll(app);
  }
});

it('reports a current decode failure, drops its superseded request, and allows a fresh retry', async () => {
  const { app, ed, node } = await setup();
  const older = delayedImage('Older.png');
  const newer = delayedImage('Newer.png');
  try {
    const first = replaceImage(app, ed, [node.id], older.blob);
    await vi.waitFor(() => expect(older.blob.arrayBuffer).toHaveBeenCalledOnce());
    const latest = replaceImage(app, ed, [node.id], newer.blob);
    await vi.waitFor(() => expect(newer.blob.arrayBuffer).toHaveBeenCalledOnce());
    const failed = expect(latest).rejects.toThrow('Decode failed');
    newer.fail(new Error('Decode failed'));
    await failed;
    older.finish();
    expect((await first) === null).toBe(true);
    expect(ed.doc.get(node.id).asset).toBe('original');
    const retry = await replaceImage(app, ed, [node.id], new File([png], 'Retry.png'));
    expect(ed.doc.get(node.id).asset).toBe(retry.assetId);
    expect(ed.doc.assets.size).toBe(2);
  } finally {
    older.finish(); newer.finish();
    await closeAll(app);
  }
});

it('silently drops an older read failure after a later replacement succeeds', async () => {
  const { app, ed, node } = await setup();
  const image = delayedImage('Older.png');
  try {
    const pending = replaceImage(app, ed, [node.id], image.blob);
    await vi.waitFor(() => expect(image.blob.arrayBuffer).toHaveBeenCalledOnce());
    const latest = await replaceImage(app, ed, [node.id], new File([png], 'Latest.png'));
    const result = expect(pending).resolves.toBeNull();
    image.fail(new Error('Old request failed'));
    await result;
    expect(ed.doc.get(node.id).asset).toBe(latest.assetId);
  } finally {
    image.finish();
    await closeAll(app);
  }
});

it('uses the configured placement mode when the caller leaves its option undefined', async () => {
  const { app, ed, node } = await setup();
  try {
    ed.doc.transact('Resize image', () => ed.doc.update(node.id, { height: 20 }));
    app.prefs.set('linkPlacement', 'fill');
    await replaceImage(app, ed, [node.id], new File([png], 'Replacement.png'), { placement: undefined });
    expect(ed.doc.get(node.id).transform).toEqual([20, 0, 0, 20, -5, 0]);
  } finally {
    await closeAll(app);
  }
});
