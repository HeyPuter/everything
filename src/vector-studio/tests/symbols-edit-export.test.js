import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { editorSVG } from '../src/features/io/svg-export.js';
import { exportView } from '../src/features/io/export-view.js';
import { exportSkipIds } from '../src/features/io/hooks.js';
import { getDef } from '../src/features/symbols/model.js';

// While a symbol is edited its master sits on the page (the instance being edited is
// hidden on screen); exports must still show the document as it is: each instance once.
let app;
beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument({ name: 'Edit export' });
});

async function makeSymbol() {
  const doc = app.editor.doc;
  const n = createPath(rectangle(100, 100, 40, 20), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: null });
  doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
  app.editor.select([n.id]);
  await app.commands.run('symbol.new', { direct: true, name: 'Card' });
  return app.editor.selectedNodes()[0];
}
const rects = (svg) => (svg.match(/<(path|rect)\b/g) || []).length;

describe('exports while a symbol is being edited', () => {
  it('show each instance once, not the master as well', async () => {
    const inst = await makeSymbol();
    const before = editorSVG(app.editor);
    app.editor.select([inst.id]);
    await app.commands.run('symbol.edit');
    expect(app.editor.symbolEdit).toBeTruthy();
    expect(rects(editorSVG(app.editor))).toBe(rects(before));
    expect(exportSkipIds(app.editor.doc).size).toBe(1);
  });

  it('leave out a master opened from the Symbols panel', async () => {
    const inst = await makeSymbol();
    const doc = app.editor.doc;
    const defId = [...doc.nodes.values()].find((n) => n.symbolDef)?.id;
    expect(getDef(doc, defId)).toBeTruthy();
    doc.transact('Remove instance', () => doc.remove(inst.id));
    const empty = editorSVG(app.editor);
    await app.commands.run('symbol.edit', { id: defId });
    expect(app.editor.symbolEdit).toBe(defId);
    expect(rects(editorSVG(app.editor))).toBe(rects(empty));
    // The baked export view hides the master too.
    const view = exportView(doc);
    expect(view.get(defId).hidden).toBe(true);
  });
});
