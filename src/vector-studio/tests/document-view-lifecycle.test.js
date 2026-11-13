import { expect, it, vi } from 'vitest';
import { bootApp, bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

async function closeAll(app) {
  for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
}

it('refreshes tabs once per document event regardless of the number of windows', async () => {
  const app = bootApp();
  try {
    const first = app.newDocument();
    const second = app.addDocument(first.doc);
    const third = app.addDocument(first.doc);
    const renderTabs = vi.spyOn(app, 'renderTabs');
    first.doc.transact('Rename', () => first.doc.updateRoot({ name: 'Shared' }));
    expect(renderTabs).toHaveBeenCalledTimes(1);
    expect(app.tabsEl.textContent).toContain('Shared');
    renderTabs.mockClear();
    first.doc.markSaved();
    expect(renderTabs).toHaveBeenCalledTimes(1);
    await app.closeDocument(third, { force: true });
    await app.closeDocument(second, { force: true });
    renderTabs.mockClear();
    first.doc.markSaved();
    expect(renderTabs).toHaveBeenCalledTimes(1);
    renderTabs.mockRestore();
  } finally {
    await closeAll(app);
  }
});

it('removes document tab listeners after the final window closes and can reopen cleanly', async () => {
  const app = bootApp();
  try {
    const first = app.newDocument();
    const doc = first.doc;
    app.addDocument(doc);
    await closeAll(app);
    const renderTabs = vi.spyOn(app, 'renderTabs');
    doc.markSaved();
    doc.transact('Rename after close', () => doc.updateRoot({ name: 'Reopened' }));
    expect(renderTabs).not.toHaveBeenCalled();
    app.addDocument(doc);
    renderTabs.mockClear();
    doc.markSaved();
    expect(renderTabs).toHaveBeenCalledTimes(1);
    renderTabs.mockRestore();
  } finally {
    await closeAll(app);
  }
});

it('stops delivering document changes to a closed window', async () => {
  const app = bootApp();
  try {
    const first = app.newDocument();
    const second = app.addDocument(first.doc);
    const closedChange = vi.fn();
    const liveChange = vi.fn();
    first.on('doc-change', closedChange);
    second.on('doc-change', liveChange);
    await app.closeDocument(first, { force: true });
    first.doc.transact('Rename remaining window', () => first.doc.updateRoot({ name: 'Still open' }));
    expect(closedChange).not.toHaveBeenCalled();
    expect(liveChange).toHaveBeenCalled();
  } finally {
    await closeAll(app);
  }
});

it('restores undo selection into the remaining window instead of the closed one', async () => {
  const app = bootApp();
  try {
    const first = app.newDocument();
    const shape = createPath(rectangle(0, 0, 10, 10), true);
    first.doc.transact('Shape', () => first.doc.insert(shape, first.targetLayer().id));
    const second = app.addDocument(first.doc);
    second.select([shape.id]);
    first.doc.transact('Opacity', () => first.doc.update(shape.id, { opacity: 0.5 }));
    second.clearSelection();
    await app.closeDocument(second, { force: true });
    first.doc.undo();
    expect([...first.selection]).toEqual([shape.id]);
    expect([...second.selection]).toEqual([]);
    expect(first.doc.get(shape.id).opacity).toBe(1);
    first.doc.redo();
    expect(first.doc.get(shape.id).opacity).toBe(0.5);
  } finally {
    await closeAll(app);
  }
});

it.each([false, true])('releases the undo selection binding after the final window closes (features: %s)', async (features) => {
  const app = features ? await bootAppWithFeatures() : bootApp();
  try {
    const editor = app.newDocument();
    const binding = editor.doc.selection;
    const getSelection = vi.spyOn(binding, 'get');
    await app.closeDocument(editor, { force: true });
    editor.doc.transact('After close', () => editor.doc.updateRoot({ name: 'Detached' }));
    expect(getSelection).not.toHaveBeenCalled();
    getSelection.mockRestore();
  } finally {
    await closeAll(app);
  }
});

it('does not steal the active undo binding when opening an inactive window', async () => {
  const app = bootApp();
  try {
    const active = app.newDocument();
    const shape = createPath(rectangle(0, 0, 10, 10), true);
    active.doc.transact('Shape', () => active.doc.insert(shape, active.targetLayer().id));
    active.select([shape.id]);
    const inactive = app.addDocument(active.doc, { activate: false });
    expect(app.editor).toBe(active);
    expect(active.doc.selection.get().ids).toEqual([shape.id]);
    await app.closeDocument(inactive, { force: true });
    expect(active.doc.selection.get().ids).toEqual([shape.id]);
  } finally {
    await closeAll(app);
  }
});

it('rebinds a shared document when its last active window closes behind another document', async () => {
  const app = bootApp();
  try {
    const first = app.newDocument();
    const second = app.addDocument(first.doc);
    const getClosedSelection = vi.spyOn(first.doc.selection, 'get');
    const other = app.newDocument();
    await app.closeDocument(second, { force: true });
    expect(app.editor).toBe(other);
    first.doc.transact('Background document', () => first.doc.updateRoot({ name: 'Remaining' }));
    expect(getClosedSelection).not.toHaveBeenCalled();
    expect(first.doc.selection).toBeTruthy();
    getClosedSelection.mockRestore();
  } finally {
    await closeAll(app);
  }
});
