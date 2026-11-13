import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createImage } from '../src/model/nodes.js';
import { replaceImage, relink, updateLinks } from '../src/features/panels/links.js';

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  ed.doc.assets.set('original', { mime: 'image/png', data: 'data:image/png;base64,original' });
  const node = createImage('original', 10, 10, [1, 0, 0, 1, 0, 0], { link: { source: 'puter', path: '/u/Original.png', name: 'Original.png' } });
  ed.doc.transact('Image', () => ed.doc.insert(node, ed.targetLayer().id));
  app.addDocument(ed.doc, { activate: false });
  return { app, ed, node };
}
async function closeAll(app) {
  for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
}

it.each(['closed window', 'deleted image'])('drops a decoded replacement for a %s without adding assets or history', async (change) => {
  const { app, ed, node } = await setup();
  const read = deferred();
  const blob = { name: 'Replacement.png', type: 'image/png', arrayBuffer: vi.fn(() => read.promise) };
  try {
    const replacing = replaceImage(app, ed, [node.id], blob);
    await vi.waitFor(() => expect(blob.arrayBuffer).toHaveBeenCalledOnce());
    if (change === 'closed window') await app.closeDocument(ed, { force: true });
    else ed.doc.transact('Remove', () => ed.doc.remove(node.id));
    const version = ed.doc.nodes.version;
    const history = ed.doc.undoStack.length;
    read.resolve(png.buffer);
    expect(await replacing).toBeNull();
    expect(ed.doc.assets.size).toBe(1);
    expect(ed.doc.nodes.version).toBe(version);
    expect(ed.doc.undoStack.length).toBe(history);
  } finally {
    read.resolve(png.buffer);
    await closeAll(app);
  }
});

it('does not report a successful Relink after its window closes while the picker is pending', async () => {
  const { app, ed, node } = await setup();
  const picker = deferred();
  const pick = vi.fn(() => picker.promise);
  app.user = { username: 'test' };
  app.puter = { ui: { showOpenFilePicker: pick } };
  app.dialogs.open = async () => 'puter';
  app.notify = vi.fn();
  try {
    const replacing = relink(app, ed, [node.id]);
    await vi.waitFor(() => expect(pick).toHaveBeenCalledOnce());
    await app.closeDocument(ed, { force: true });
    picker.resolve({ name: 'Replacement.png', path: '/u/Replacement.png', read: async () => new Blob([png], { type: 'image/png' }) });
    expect(await replacing).toBe(false);
    expect(ed.doc.get(node.id).asset).toBe('original');
    expect(ed.doc.assets.size).toBe(1);
    expect(app.notify.mock.calls.some(([message]) => message.startsWith('Relinked'))).toBe(false);
  } finally {
    picker.resolve(null);
    await closeAll(app);
  }
});

it('stops Update Links when its window closes while a source is loading', async () => {
  const { app, ed, node } = await setup();
  const second = createImage('original', 10, 10, [1, 0, 0, 1, 30, 30], { link: { ...node.link, path: '/u/Second.png' } });
  ed.doc.transact('Second image', () => ed.doc.insert(second, ed.targetLayer().id));
  const read = deferred();
  app.puter = { fs: { read: vi.fn(() => read.promise) } };
  try {
    const updating = updateLinks(app, ed, [node.id, second.id]);
    await vi.waitFor(() => expect(app.puter.fs.read).toHaveBeenCalledOnce());
    await app.closeDocument(ed, { force: true });
    read.resolve(new Blob([png], { type: 'image/png' }));
    expect(await updating).toBe(0);
    expect(app.puter.fs.read).toHaveBeenCalledOnce();
    expect(ed.doc.get(node.id).asset).toBe('original');
    expect(ed.doc.assets.size).toBe(1);
  } finally {
    read.resolve(new Blob([png], { type: 'image/png' }));
    await closeAll(app);
  }
});

it('relinks surviving targets while another document is active and keeps undo working', async () => {
  const { app, ed, node } = await setup();
  const second = createImage('original', 20, 20, [2, 0, 0, 2, 40, 50]);
  ed.doc.transact('Second image', () => ed.doc.insert(second, ed.targetLayer().id));
  const read = deferred();
  const blob = { name: 'Replacement.png', type: 'image/png', arrayBuffer: vi.fn(() => read.promise) };
  try {
    const replacing = replaceImage(app, ed, [node.id, second.id], blob);
    await vi.waitFor(() => expect(blob.arrayBuffer).toHaveBeenCalledOnce());
    ed.doc.transact('Remove one', () => ed.doc.remove(node.id));
    const other = app.newDocument();
    read.resolve(png.buffer);
    const data = await replacing;
    expect(ed.doc.get(second.id).asset).toBe(data.assetId);
    expect(ed.doc.has(node.id)).toBe(false);
    expect(app.editor === other).toBe(true);
    ed.doc.undo();
    expect(ed.doc.get(second.id).asset).toBe('original');
    expect(ed.doc.get(second.id).transform).toEqual(second.transform);
  } finally {
    read.resolve(png.buffer);
    await closeAll(app);
  }
});

it('counts an Update Link that applies to a live image', async () => {
  const { app, ed, node } = await setup();
  app.puter = { fs: { read: async () => new Blob([png], { type: 'image/png' }) } };
  try {
    expect(await updateLinks(app, ed, [node.id])).toBe(1);
    expect(ed.doc.get(node.id).asset).not.toBe('original');
    expect(ed.doc.get(node.id).link.path).toBe('/u/Original.png');
    ed.doc.undo();
    expect(ed.doc.get(node.id).asset).toBe('original');
  } finally {
    await closeAll(app);
  }
});
