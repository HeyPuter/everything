import { expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { createImage } from '../src/model/nodes.js';

function delayedImages() {
  const pending = [];
  vi.stubGlobal('Image', class {
    constructor() { pending.push(this); }
    finish() { this.onload?.(); }
  });
  return pending;
}

function place(editor, asset, id = 'photo') {
  editor.doc.assets.set(id, asset);
  editor.doc.transact('Place', () => editor.doc.insert(createImage(id, 20, 20), editor.targetLayer().id));
}

async function closeAll(app) {
  for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  vi.unstubAllGlobals();
}

it('redraws the document whose image loaded rather than the most recently opened document', async () => {
  const pending = delayedImages();
  const app = bootApp();
  try {
    const first = app.newDocument();
    place(first, { mime: 'image/png', data: 'data:image/png;base64,AAAA' });
    const a = app.views.get(first);
    a.renderNow();
    const second = app.newDocument();
    const b = app.views.get(second);
    b.renderNow();
    expect(pending).toHaveLength(1);
    pending[0].finish();
    expect(a.artDirty).toBe(true);
    expect(b.artDirty).toBe(false);
    const drawImage = a.actx.drawImage;
    a.actx.drawImage = vi.fn(drawImage);
    a.renderNow();
    expect(a.actx.drawImage.mock.calls.some(([source]) => source === pending[0])).toBe(true);
    a.actx.drawImage = drawImage;
  } finally {
    await closeAll(app);
  }
});

it.each(['another window', 'an asset alias'])('notifies both image consumers through %s', async (mode) => {
  const pending = delayedImages();
  const app = bootApp();
  try {
    const asset = { mime: 'image/png', data: 'data:image/png;base64,AAAA' };
    const first = app.newDocument();
    place(first, asset);
    const a = app.views.get(first);
    a.renderNow();
    const second = mode === 'another window' ? app.addDocument(first.doc) : app.newDocument();
    if (mode === 'an asset alias') place(second, asset, 'alias');
    const b = app.views.get(second);
    b.renderNow();
    a.renderNow();
    expect(pending).toHaveLength(1);
    pending[0].finish();
    expect(a.artDirty).toBe(true);
    expect(b.artDirty).toBe(true);
  } finally {
    await closeAll(app);
  }
});

it('does not notify a closed view when a delayed image finishes loading', async () => {
  const pending = delayedImages();
  const app = bootApp();
  try {
    const first = app.newDocument();
    place(first, { mime: 'image/png', data: 'data:image/png;base64,AAAA' });
    const a = app.views.get(first);
    a.renderNow();
    const second = app.addDocument(first.doc);
    const b = app.views.get(second);
    b.renderNow();
    await app.closeDocument(second, { force: true });
    a.renderNow();
    b.artDirty = false;
    pending[0].finish();
    expect(b.artDirty).toBe(false);
    expect(a.artDirty).toBe(true);
  } finally {
    await closeAll(app);
  }
});
