import { beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(import.meta.dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
});

it.each(['Cancel', 'Save'])('keeps Shape Builder responsive when closing returns false after %s', async (choice) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const a = createPath(rectangle(0, 0, 20, 20), true, { fill: { type: 'solid', color: '#f00' } });
  const b = createPath(rectangle(40, 0, 20, 20), true, { fill: { type: 'solid', color: '#f00' } });
  ed.doc.transact('Artwork', () => {
    ed.doc.insert(a, ed.targetLayer().id);
    ed.doc.insert(b, ed.targetLayer().id);
  });
  ed.select([a.id]);
  app.setTool('shape-builder');
  const tool = app.tool;
  await vi.waitFor(() => expect(tool.faces).toHaveLength(1));
  const save = vi.spyOn(app.files.service, 'save').mockResolvedValue(false);
  try {
    const closing = app.closeDocument(ed);
    const dialog = document.querySelector('dialog[open]');
    [...dialog.querySelectorAll('button')].find((button) => button.textContent === choice).click();
    expect(await closing).toBe(false);
    expect(app.editor).toBe(ed);
    ed.select([b.id]);
    expect(tool.leaves.map((n) => n.id)).toEqual([b.id]);
    await vi.waitFor(() => expect(tool.faces?.[0]?.bounds.x).toBe(40));
    if (choice === 'Save') expect(save).toHaveBeenCalled();
  } finally {
    save.mockRestore();
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});
