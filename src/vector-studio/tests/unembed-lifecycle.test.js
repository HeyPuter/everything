import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createImage } from '../src/model/nodes.js';
import { unembedImages } from '../src/features/panels/links.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  ed.doc.assets.set('original', { mime: 'image/png', data: 'data:image/png;base64,original' });
  const node = createImage('original', 10, 10, [1, 0, 0, 1, 0, 0], { name: 'Original' });
  ed.doc.transact('Image', () => ed.doc.insert(node, ed.targetLayer().id));
  app.addDocument(ed.doc, { activate: false });
  app.user = { username: 'test' };
  const picker = deferred();
  app.puter = { ui: { showSaveFilePicker: vi.fn(() => picker.promise) } };
  const blob = new Blob(['original'], { type: 'image/png' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => blob })));
  return { app, ed, node, picker, blob };
}
async function cleanup(app, picker) {
  picker.resolve(null);
  vi.unstubAllGlobals();
  for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
}

it.each(['closed window', 'deleted image', 'replaced image', 'new link'])('does not attach an old exported file to a %s', async (change) => {
  const { app, ed, node, picker } = await setup();
  try {
    const saving = unembedImages(app, ed, [node.id]);
    await vi.waitFor(() => expect(app.puter.ui.showSaveFilePicker).toHaveBeenCalledOnce());
    if (change === 'closed window') await app.closeDocument(ed, { force: true });
    else ed.doc.transact('Newer edit', () => {
      if (change === 'deleted image') ed.doc.remove(node.id);
      if (change === 'replaced image') {
        ed.doc.assets.set('new', { mime: 'image/png', data: 'data:image/png;base64,new' });
        ed.doc.update(node.id, { asset: 'new' });
      }
      if (change === 'new link') ed.doc.update(node.id, { link: { source: 'puter', path: '/u/New.png' } });
    });
    const before = ed.doc.get(node.id);
    const history = ed.doc.undoStack.length;
    picker.resolve({ path: '/u/Original.png', name: 'Original.png' });
    expect(await saving).toBe(0);
    expect(ed.doc.get(node.id)).toEqual(before);
    expect(ed.doc.undoStack.length).toBe(history);
  } finally { await cleanup(app, picker); }
});

it('does not open a save picker or load later images after its window closes during blob preparation', async () => {
  const { app, ed, node, picker, blob } = await setup();
  const read = deferred();
  const second = createImage('original', 10, 10);
  ed.doc.transact('Second image', () => ed.doc.insert(second, ed.targetLayer().id));
  fetch.mockImplementation(async () => ({ blob: () => read.promise }));
  try {
    const saving = unembedImages(app, ed, [node.id, second.id]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await app.closeDocument(ed, { force: true });
    picker.resolve(null);
    read.resolve(blob);
    expect(await saving).toBe(0);
    expect(app.puter.ui.showSaveFilePicker).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  } finally { read.resolve(blob); await cleanup(app, picker); }
});

it('links the exported image after unrelated transforms and background activation, with independent Undo', async () => {
  const { app, ed, node, picker, blob } = await setup();
  try {
    const saving = unembedImages(app, ed, [node.id]);
    await vi.waitFor(() => expect(app.puter.ui.showSaveFilePicker).toHaveBeenCalledWith(blob, 'Original.png'));
    const transform = [2, 0, 0, 2, 40, 50];
    ed.doc.transact('Move', () => ed.doc.update(node.id, { transform }));
    const other = app.newDocument();
    picker.resolve({ path: '/u/Original.png', name: 'Original.png' });
    expect(await saving).toBe(1);
    expect(ed.doc.get(node.id).link.path).toBe('/u/Original.png');
    expect(ed.doc.get(node.id).transform).toEqual(transform);
    expect(app.editor === other).toBe(true);
    ed.doc.undo();
    expect(ed.doc.get(node.id).link).toBeUndefined();
    expect(ed.doc.get(node.id).transform).toEqual(transform);
  } finally { await cleanup(app, picker); }
});

it('leaves a cancelled export embedded without adding history', async () => {
  const { app, ed, node, picker } = await setup();
  try {
    const history = ed.doc.undoStack.length;
    const saving = unembedImages(app, ed, [node.id]);
    picker.resolve(null);
    expect(await saving).toBe(0);
    expect(ed.doc.get(node.id).link).toBeUndefined();
    expect(ed.doc.undoStack.length).toBe(history);
  } finally { await cleanup(app, picker); }
});
