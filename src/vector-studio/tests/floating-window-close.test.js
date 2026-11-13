import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { layoutViews, setArrangement } from '../src/features/workspace/window.js';

it.each(['Cancel', 'Save'])('preserves a floating window when closing returns false after %s', async (choice) => {
  const app = await bootAppWithFeatures();
  const background = app.newDocument();
  const ed = app.newDocument();
  ed.doc.transact('Rename', () => ed.doc.updateRoot({ name: 'Changed' }));
  setArrangement(app, null, { float: true });
  const host = app.views.get(ed).host;
  Object.assign(host.style, { left: '130px', top: '90px', width: '420px', height: '310px' });
  const save = vi.spyOn(app.files.service, 'save').mockResolvedValue(false);
  try {
    const closing = app.closeDocument(ed);
    const dialog = document.querySelector('dialog[open]');
    [...dialog.querySelectorAll('button')].find((button) => button.textContent === choice).click();
    expect(await closing).toBe(false);
    expect(app.floating.has(ed)).toBe(true);
    app.activate(background);
    layoutViews(app);
    expect(host.hidden).toBe(false);
    expect(host.classList.contains('floating')).toBe(true);
    expect(host.querySelector('.float-head')).toBeTruthy();
    expect([host.style.left, host.style.top, host.style.width, host.style.height]).toEqual(['130px', '90px', '420px', '310px']);
  } finally {
    save.mockRestore();
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});

it('releases floating layout state when the document actually closes', async () => {
  const app = await bootAppWithFeatures();
  const background = app.newDocument();
  const ed = app.newDocument();
  setArrangement(app, null, { float: true });
  try {
    expect(await app.closeDocument(ed, { force: true })).toBe(true);
    expect(app.floating.has(ed)).toBe(false);
    expect(app.views.has(ed)).toBe(false);
    expect(app.root.classList.contains('arrange-tiled')).toBe(false);
    expect(app.views.get(background).host.hidden).toBe(false);
  } finally {
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});
