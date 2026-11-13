import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createImage } from '../src/model/nodes.js';
import { embedImages } from '../src/features/panels/links.js';

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
async function setup(linked = true) {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  ed.doc.assets.set('original', { mime: 'image/png', data: 'data:image/png;base64,original' });
  const node = createImage('original', 10, 10, [1, 0, 0, 1, 0, 0], { link: linked ? { source: 'puter', path: '/u/Original.png', name: 'Original.png' } : { source: 'url', url: 'https://example.invalid/image.png' } });
  ed.doc.transact('Image', () => ed.doc.insert(node, ed.targetLayer().id));
  ed.select([node.id]);
  const panel = app.dock.panels.get('links');
  panel.ensureBuilt();
  panel.update();
  app.notify = vi.fn();
  return { app, ed, node, panel };
}

it('reports a skipped linked-image update without claiming the image was ineligible', async () => {
  const { app, ed, node, panel } = await setup();
  let release;
  const read = new Promise((resolve) => { release = resolve; });
  app.puter = { fs: { read: vi.fn(() => read) } };
  try {
    panel.updateBtn.click();
    await vi.waitFor(() => expect(app.puter.fs.read).toHaveBeenCalledOnce());
    embedImages(ed, [node.id]);
    release(new Blob([png], { type: 'image/png' }));
    await vi.waitFor(() => expect(app.notify).toHaveBeenCalled());
    expect(app.notify).toHaveBeenCalledWith('No links were updated.', { polite: true });
    expect(ed.doc.get(node.id).link).toBeUndefined();
  } finally {
    release(new Blob([png], { type: 'image/png' }));
    await app.closeDocument(ed, { force: true });
  }
});

it.each([false, true])('keeps update feedback accurate for a current image (Puter source: %s)', async (linked) => {
  const { app, ed, panel } = await setup(linked);
  app.puter = { fs: { read: vi.fn(async () => new Blob([png], { type: 'image/png' })) } };
  try {
    panel.updateBtn.click();
    await vi.waitFor(() => expect(app.notify).toHaveBeenCalled());
    expect(app.notify).toHaveBeenCalledWith(linked ? 'Updated 1 link.' : 'Only images placed from Puter can be updated.', { polite: linked });
  } finally {
    await app.closeDocument(ed, { force: true });
  }
});
