import { describe, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { createImage, createText } from '../src/model/nodes.js';
import { VariablesPanel } from '../src/features/variables/panel.js';
import { addVariable, bind } from '../src/features/variables/model.js';

function png() {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 20);
  view.setUint32(20, 10);
  bytes.set([8, 6, 0, 0, 0], 24);
  return new Blob([bytes], { type: 'image/png' });
}

function setup() {
  const doc = VDocument.create();
  const image = createImage('original', 100, 100, [1, 0, 0, 1, 0, 0], { link: { path: 'original.png' } });
  const text = createText('Original', 0, 0);
  doc.assets.set('original', { mime: 'image/png', data: 'data:image/png;base64,AAAA' });
  doc.transact('Setup', () => {
    doc.insert(image, doc.layers()[0].id);
    doc.insert(text, doc.layers()[0].id);
    const photo = addVariable(doc, 'image', 'Photo');
    const title = addVariable(doc, 'text', 'Title');
    bind(doc, image.id, 'image', photo.id);
    bind(doc, text.id, 'text', title.id);
    doc.updateRoot({ dataSets: [
      { id: 'slow', name: 'Slow', values: { [photo.id]: 'slow.png', [title.id]: 'Slow' } },
      { id: 'latest', name: 'Latest', values: { [photo.id]: 'original.png', [title.id]: 'Latest' } },
    ] });
  });
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const app = { editor: { doc }, puter: { fs: { read: vi.fn(() => pending) } }, prefs: { get: () => 'fit' }, notify: vi.fn() };
  return { doc, image, text, app, panel: new VariablesPanel(app), resolve };
}

describe('asynchronous data set selection', () => {
  it('keeps the latest choice when an earlier linked image finishes later', async () => {
    const { doc, image, text, app, panel, resolve } = setup();
    const earlier = panel.apply('slow');
    await vi.waitFor(() => expect(app.puter.fs.read).toHaveBeenCalledWith('slow.png'));
    expect(await panel.apply('latest')).toBe(true);
    const undoDepth = doc.undoStack.length;
    resolve(png());
    expect(await earlier).toBe(false);
    expect(doc.root.dataSet).toBe('latest');
    expect(doc.get(text.id).text).toBe('Latest');
    expect(doc.get(image.id).asset).toBe('original');
    expect(doc.assets.size).toBe(1);
    expect(doc.undoStack).toHaveLength(undoDepth);
    doc.undo();
    expect(doc.get(text.id).text).toBe('Original');
  });

  it('still applies a linked image when the choice has not changed', async () => {
    const { doc, image, text, panel, resolve } = setup();
    const pending = panel.apply('slow');
    resolve(png());
    expect(await pending).toBe(true);
    expect(doc.get(image.id)).toMatchObject({ width: 20, height: 10, link: { path: 'slow.png' } });
    expect(doc.get(text.id).text).toBe('Slow');
    doc.undo();
    expect(doc.get(image.id).asset).toBe('original');
    expect(doc.get(text.id).text).toBe('Original');
  });
});
