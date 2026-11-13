import { expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';

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
