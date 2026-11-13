import { expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { createImage, createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { TransformSession, PREVIEW_THRESHOLD } from '../src/tools/transform-session.js';

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

function recordImages(view) {
  const draws = [];
  const originals = new Map();
  const instrument = (ctx) => {
    if (!originals.has(ctx)) {
      const drawImage = ctx.drawImage;
      originals.set(ctx, drawImage);
      ctx.drawImage = function (...args) { draws.push(args[0]); return drawImage.apply(this, args); };
    }
    return ctx;
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (...args) {
    return instrument(getContext.apply(this, args));
  });
  instrument(view.actx);
  return {
    draws,
    restore: () => {
      for (const [ctx, drawImage] of originals) ctx.drawImage = drawImage;
      spy.mockRestore();
    },
  };
}

it.each([
  { count: 1, movingImage: false },
  { count: PREVIEW_THRESHOLD + 1, movingImage: false },
  { count: PREVIEW_THRESHOLD + 1, movingImage: true },
])('refreshes a decoded image in a cached drag ($count objects; image moving: $movingImage)', async ({ count, movingImage }) => {
  const pending = delayedImages();
  const app = bootApp();
  let session, recording;
  try {
    const ed = app.newDocument();
    place(ed, { mime: 'image/png', data: 'data:image/png;base64,AAAA' });
    const ids = movingImage ? [ed.targetLayer().children[0]] : [];
    ed.doc.transact('Shapes', () => {
      while (ids.length < count) {
        const n = createPath(rectangle(0, 0, 10, 10), true);
        ed.doc.insert(n, ed.targetLayer().id);
        ids.push(n.id);
      }
    });
    ed.select(ids);
    const view = app.views.get(ed);
    recording = recordImages(view);
    session = new TransformSession(ed, 'Move');
    session.apply([1, 0, 0, 1, 1, 0]);
    view.slowScene = true;
    view.renderNow();
    expect(view.previewCache || view.interaction).toBeTruthy();
    expect(pending).toHaveLength(1);
    recording.draws.length = 0;
    pending[0].finish();
    view.renderNow();
    expect(recording.draws).toContain(pending[0]);
  } finally {
    session?.cancel();
    recording?.restore();
    await closeAll(app);
  }
});

it('replaces a pan snapshot when its pending image decodes', async () => {
  const pending = delayedImages();
  const app = bootApp();
  let recording;
  try {
    const ed = app.newDocument();
    place(ed, { mime: 'image/png', data: 'data:image/png;base64,AAAA' });
    const view = app.views.get(ed);
    recording = recordImages(view);
    view.renderNow();
    const canvas = document.createElement('canvas');
    canvas.width = view.art.width;
    canvas.height = view.art.height;
    canvas.getContext('2d').drawImage(view.art, 0, 0);
    view.snapshot = { canvas, matrix: ed.view.matrix.slice() };
    view.lastRenderMs = 20;
    ed.view.set({ panX: 1 });
    ed.viewChanged();
    expect(view.fastMode).toBe(true);
    recording.draws.length = 0;
    pending[0].finish();
    view.renderNow();
    expect(recording.draws).toContain(pending[0]);
  } finally {
    recording?.restore();
    await closeAll(app);
  }
});
