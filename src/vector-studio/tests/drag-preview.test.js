import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';
import { TransformSession, PREVIEW_THRESHOLD } from '../src/tools/transform-session.js';

function many(app, count) {
  const doc = app.editor.doc;
  const ids = [];
  doc.transact('Many', () => {
    for (let i = 0; i < count; i++) {
      const n = createPath(rectangle(i, 0, 1, 1), true);
      doc.insert(n, app.editor.targetLayer().id);
      ids.push(n.id);
    }
  });
  app.editor.select(ids);
  return ids;
}

describe('large-selection drag preview', () => {
  it('leaves the document untouched while dragging and writes once on release', () => {
    const app = bootApp();
    app.newDocument();
    const ids = many(app, PREVIEW_THRESHOLD + 50);
    const s = new TransformSession(app.editor, 'Move');
    expect(s.preview).toBe(true);
    s.apply([1, 0, 0, 1, 10, 20]);
    expect(app.editor.dragPreview.matrix).toEqual([1, 0, 0, 1, 10, 20]);
    expect(nodeBounds(app.editor.doc, app.editor.doc.get(ids[0])).x).toBe(0);
    s.commit();
    expect(app.editor.dragPreview).toBeNull();
    expect(nodeBounds(app.editor.doc, app.editor.doc.get(ids[0]))).toMatchObject({ x: 10, y: 20 });
    app.editor.doc.undo();
    expect(nodeBounds(app.editor.doc, app.editor.doc.get(ids[0]))).toMatchObject({ x: 0, y: 0 });
  });

  it('clears the preview on cancel', () => {
    const app = bootApp();
    app.newDocument();
    const ids = many(app, PREVIEW_THRESHOLD + 1);
    const s = new TransformSession(app.editor, 'Move');
    s.apply([1, 0, 0, 1, 5, 5]);
    s.cancel();
    expect(app.editor.dragPreview).toBeNull();
    expect(nodeBounds(app.editor.doc, app.editor.doc.get(ids[0])).x).toBe(0);
    expect(app.editor.doc.tx).toBeNull();
  });

  it('keeps small selections live', () => {
    const app = bootApp();
    app.newDocument();
    const ids = many(app, 3);
    const s = new TransformSession(app.editor, 'Move');
    expect(s.preview).toBe(false);
    s.apply([1, 0, 0, 1, 7, 0]);
    expect(nodeBounds(app.editor.doc, app.editor.doc.get(ids[0])).x).toBe(7);
    s.commit();
  });
});

describe('large-selection drag preview with Alt', () => {
  it('shows the originals in place once Alt switches the drag to copies', () => {
    const app = bootApp();
    app.newDocument();
    const ids = many(app, PREVIEW_THRESHOLD + 10);
    const view = app.views.get(app.editor);
    const s = new TransformSession(app.editor, 'Move');
    s.apply([1, 0, 0, 1, 10, 0]);
    view.renderNow();
    expect(view.previewCache.isMoving(ids[0])).toBe(true);
    s.setDuplicate(true);
    view.renderNow();
    // The copies move; the originals stay in the static artwork.
    expect(view.previewCache.isMoving(ids[0])).toBe(false);
    expect(view.previewCache.isMoving(s.ids[0])).toBe(true);
    s.setDuplicate(false);
    view.renderNow();
    expect(view.previewCache.isMoving(ids[0])).toBe(true);
    s.cancel();
    view.renderNow();
  });
});

describe('large pattern-only drags', () => {
  it('previews pattern movement without translating the object silhouettes', () => {
    const app = bootApp();
    const ed = app.newDocument();
    const ids = many(app, PREVIEW_THRESHOLD + 1);
    ed.doc.transact('Pattern', () => {
      for (const id of ids) ed.doc.update(id, { fill: { type: 'pattern', id: 'tile' } });
    });
    ed.patternsOnly = true;
    const before = ed.doc.get(ids[0]);
    const s = new TransformSession(ed, 'Move Patterns');
    s.apply([1, 0, 0, 1, 10, 20]);
    expect(ed.dragPreview).toBeFalsy();
    expect(ed.doc.get(ids[0]).fill.transform).toEqual([1, 0, 0, 1, 10, 20]);
    expect(ed.doc.get(ids[0]).anchors).toEqual(before.anchors);
    s.apply([1, 0, 0, 1, 20, 30]);
    s.commit();
    expect(ed.doc.get(ids[0]).fill.transform).toEqual([1, 0, 0, 1, 20, 30]);
    expect(ed.doc.get(ids[0]).anchors).toEqual(before.anchors);
    ed.doc.undo();
    expect(ed.doc.get(ids[0])).toEqual(before);
  });
});
