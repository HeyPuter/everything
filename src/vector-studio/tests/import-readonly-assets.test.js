import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createImage } from '../src/model/nodes.js';
import { placeImage, placeImported } from '../src/features/io/place.js';
import { svgToNodes } from '../src/features/io/svg-import.js';
import { replaceImage } from '../src/features/panels/links.js';

const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = Uint8Array.from(atob(data.split(',')[1]), (c) => c.charCodeAt(0));

it.each(['place', 'replace'])('does not retain decoded assets when %s loses write access during loading', async (kind) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  ed.doc.assets.set('original', { mime: 'image/png', data });
  const node = createImage('original', 10, 10);
  ed.doc.transact('Image', () => ed.doc.insert(node, ed.targetLayer().id));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const blob = { name: 'New.png', type: 'image/png', arrayBuffer: vi.fn(() => gate) };
  try {
    const loading = kind === 'place' ? placeImage(app, ed, blob) : replaceImage(app, ed, [node.id], blob);
    await vi.waitFor(() => expect(blob.arrayBuffer).toHaveBeenCalledOnce());
    const assets = [...ed.doc.assets];
    const version = ed.doc.nodes.version;
    const history = ed.doc.undoStack.length;
    ed.doc.readOnly = true;
    const rejected = expect(loading).rejects.toThrow('view only');
    release(png.buffer);
    await rejected;
    expect([...ed.doc.assets]).toEqual(assets);
    expect(ed.doc.nodes.version).toBe(version);
    expect(ed.doc.undoStack.length).toBe(history);
    expect(ed.doc.get(node.id).asset).toBe('original');
    // Restoring access allows retry, and Undo preserves the original artwork.
    ed.doc.readOnly = false;
    const result = kind === 'place' ? await placeImage(app, ed, blob) : await replaceImage(app, ed, [node.id], blob);
    expect(result).toBeTruthy();
    expect(ed.doc.assets.size).toBe(2);
    ed.doc.undo();
    expect(ed.doc.leaves().map((n) => n.id)).toEqual([node.id]);
    expect(ed.doc.get(node.id).asset).toBe('original');
  } finally {
    release(png.buffer);
    ed.doc.readOnly = false;
    await app.closeDocument(ed, { force: true });
  }
});

it('does not copy imported subtree assets into a view-only document', async () => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const imported = svgToNodes(`<svg xmlns="http://www.w3.org/2000/svg"><image width="10" height="10" href="${data}"/></svg>`);
  expect(Object.keys(imported.assets)).toHaveLength(1);
  try {
    const history = ed.doc.undoStack.length;
    ed.doc.readOnly = true;
    expect(() => placeImported(app, ed, imported)).toThrow('view only');
    expect(ed.doc.assets.size).toBe(0);
    expect(ed.doc.leaves()).toHaveLength(0);
    expect(ed.doc.undoStack.length).toBe(history);
    ed.doc.readOnly = false;
    expect(placeImported(app, ed, imported)).toBeTruthy();
    expect(ed.doc.assets.size).toBe(1);
    ed.doc.undo();
    expect(ed.doc.leaves()).toHaveLength(0);
  } finally {
    ed.doc.readOnly = false;
    await app.closeDocument(ed, { force: true });
  }
});
