import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { placeImage } from '../src/features/io/place.js';
import { createLayer } from '../src/model/nodes.js';

function delayedImage() {
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  let finish;
  const pending = new Promise((resolve) => { finish = () => resolve(bytes.buffer); });
  return { blob: { name: 'Image.png', type: 'image/png', arrayBuffer: vi.fn(() => pending) }, finish };
}

it.each([false, true])('ignores a decoded image after its target window closes (remaining shared window: %s)', async (shared) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  if (shared) app.addDocument(ed.doc, { activate: false });
  const { blob, finish } = delayedImage();
  try {
    const placing = placeImage(app, ed, blob);
    expect(blob.arrayBuffer).toHaveBeenCalledOnce();
    await app.closeDocument(ed, { force: true });
    const version = ed.doc.nodes.version;
    finish();
    expect(await placing).toBeNull();
    expect(ed.doc.nodes.version).toBe(version);
    expect(ed.doc.assets.size).toBe(0);
    expect(ed.doc.leaves()).toHaveLength(0);
  } finally {
    finish();
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});

it.each(['locked', 'hidden', 'removed', 'all locked'])('rechecks the target when it becomes %s during image decoding', async (change) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const original = ed.targetLayer();
  const fallback = createLayer('Fallback');
  ed.doc.transact('Add layer', () => ed.doc.insert(fallback, 'root'));
  ed.activeLayerId = original.id;
  const { blob, finish } = delayedImage();
  try {
    const placing = placeImage(app, ed, blob);
    expect(blob.arrayBuffer).toHaveBeenCalledOnce();
    ed.doc.transact('Change target', () => {
      if (change === 'removed') ed.doc.remove(original.id);
      else ed.doc.update(original.id, { [change === 'hidden' ? 'hidden' : 'locked']: true });
      if (change === 'all locked') ed.doc.update(fallback.id, { locked: true });
    });
    finish();
    const id = await placing;
    if (change === 'all locked') {
      expect(id).toBeNull();
      expect(ed.doc.assets.size).toBe(0);
      expect(ed.doc.leaves()).toHaveLength(0);
    } else {
      expect(ed.doc.get(id)?.parent).toBe(fallback.id);
      expect(ed.doc.get(id)?.type).toBe('image');
      expect(ed.doc.assets.size).toBe(1);
      ed.doc.undo();
      expect(ed.doc.leaves()).toHaveLength(0);
    }
  } finally {
    finish();
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});

it('still places into its open target when another document becomes active during decoding', async () => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const { blob, finish } = delayedImage();
  try {
    const placing = placeImage(app, ed, blob);
    const other = app.newDocument();
    finish();
    const id = await placing;
    expect(ed.doc.get(id)?.type).toBe('image');
    expect(other.doc.leaves()).toHaveLength(0);
    expect(app.editor === other).toBe(true);
  } finally {
    finish();
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});
