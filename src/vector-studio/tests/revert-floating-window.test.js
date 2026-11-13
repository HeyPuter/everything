import { expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { newWindow, setArrangement } from '../src/features/workspace/window.js';
import { serializeDocument } from '../src/features/files/format.js';

it.each(['floating', 'docked'])('preserves floating frames when reverting from a %s window', async (from) => {
  const app = await bootAppWithFeatures();
  try {
    const first = app.newDocument({ name: 'Artwork' });
    const bytes = await serializeDocument(first.doc);
    first.file = { kind: 'local', name: 'Artwork.vstudio', handle: { getFile: async () => new Blob([bytes]) } };
    const floating = newWindow(app, first);
    setArrangement(app, null, { float: true });
    const frame = { left: '137px', top: '83px', width: '480px', height: '320px' };
    Object.assign(app.views.get(floating).host.style, frame);
    floating.view.set({ zoom: 2, panX: 34, panY: 56, rotation: 25 });
    first.doc.transact('Rename', () => first.doc.updateRoot({ name: 'Unsaved' }));
    app.dialogs.confirm = async () => true;
    const source = from === 'floating' ? floating : first;
    app.activate(source);
    const active = await app.files.service.revert(source);
    const reverted = app.editors.find((ed) => ed.windowNumber === 2);
    expect(app.floating.has(reverted)).toBe(true);
    expect(app.floating.has(floating)).toBe(false);
    const host = app.views.get(reverted).host;
    expect(host.classList.contains('floating')).toBe(true);
    expect(host.querySelector('.float-title').textContent).toBe('Artwork.vstudio:2');
    for (const [key, value] of Object.entries(frame)) expect(host.style[key]).toBe(value);
    expect(reverted.view.snapshot()).toEqual({ zoom: 2, panX: 34, panY: 56, rotation: 25 });
    const docked = app.editors.find((ed) => ed !== reverted);
    expect(app.views.get(docked).host.hidden).toBe(false);
    expect(app.floating.has(docked)).toBe(false);
    expect(app.editors.map((ed) => ed.name)).toEqual(['Artwork.vstudio', 'Artwork.vstudio:2']);
    expect(app.editor === active).toBe(true);
    expect(active.windowNumber).toBe(from === 'floating' ? 2 : null);
  } finally {
    for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
  }
});
