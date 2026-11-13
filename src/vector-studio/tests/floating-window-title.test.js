import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { floatAll } from '../src/features/workspace/window.js';

function titles(app) {
  return app.editors.map((ed) => {
    const head = app.views.get(ed).host.querySelector('.float-head');
    return [head.querySelector('.float-title').textContent, head.querySelector('button').getAttribute('aria-label')];
  });
}

it('updates every floating title and dock-button label immediately after Save As without resizing views', async () => {
  const app = await bootAppWithFeatures();
  const first = app.newDocument({ name: 'Original' });
  await app.commands.run('window.newWindow');
  floatAll(app);
  const views = app.editors.map((ed) => app.views.get(ed));
  const resize = views.map((view) => vi.spyOn(view, 'resize'));
  const originalFrames = views.map(({ host }) => [host.style.left, host.style.top, host.style.width, host.style.height]);
  const savePicker = window.showSaveFilePicker;
  const openPicker = window.showOpenFilePicker;
  window.showOpenFilePicker = async () => [];
  window.showSaveFilePicker = async () => ({
    name: 'Renamed.vstudio',
    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
  });
  try {
    expect(await app.files.service.saveAs(first)).toBe(true);
    expect(titles(app)).toEqual(app.editors.map((ed) => [ed.name, `Dock ${ed.name}`]));
    expect(app.editors.every((ed) => ed.name.startsWith('Renamed.vstudio'))).toBe(true);
    expect(views.map(({ host }) => [host.style.left, host.style.top, host.style.width, host.style.height])).toEqual(originalFrames);
    for (const spy of resize) expect(spy).not.toHaveBeenCalled();
  } finally {
    resize.forEach((spy) => spy.mockRestore());
    window.showSaveFilePicker = savePicker;
    window.showOpenFilePicker = openPicker;
    for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
  }
});

it('refreshes floating titles on document renames, Undo and Redo, including background windows', async () => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ name: 'Original' });
  await app.commands.run('window.newWindow');
  floatAll(app);
  try {
    ed.doc.transact('Rename', () => ed.doc.updateRoot({ name: 'Changed' }));
    expect.soft(titles(app)).toEqual(app.editors.map((e) => [e.name, `Dock ${e.name}`]));
    ed.doc.undo();
    expect.soft(titles(app)).toEqual(app.editors.map((e) => [e.name, `Dock ${e.name}`]));
    ed.doc.redo();
    expect(titles(app)).toEqual(app.editors.map((e) => [e.name, `Dock ${e.name}`]));
  } finally {
    for (const e of [...app.editors]) await app.closeDocument(e, { force: true });
  }
});
