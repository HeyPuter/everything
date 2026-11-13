import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { newWindow, setArrangement, floatAll } from '../src/features/workspace/window.js';
import { serializeDocument } from '../src/features/files/format.js';

async function setup() {
  const app = await bootAppWithFeatures();
  const first = app.newDocument({ name: 'Saved' });
  const bytes = await serializeDocument(first.doc);
  let finish;
  const read = new Promise((resolve) => { finish = resolve; });
  const getFile = vi.fn(() => read);
  first.file = { kind: 'local', name: 'Artwork.vstudio', handle: { getFile } };
  const second = newWindow(app, first);
  first.doc.transact('Rename', () => first.doc.updateRoot({ name: 'Unsaved' }));
  app.activate(first);
  app.dialogs.confirm = async () => true;
  return { app, first, second, getFile, finish: () => finish(new Blob([bytes])) };
}

it.each(['tabs', 'tile', 'floating', 'floating active'])('keeps the active document and its drawing intact when background Revert finishes in %s layout', async (layout) => {
  const { app, first, second, getFile, finish } = await setup();
  if (layout === 'floating') floatAll(app);
  else setArrangement(app, layout === 'floating active' ? 'tabs' : layout);
  const frames = [first, second].map((ed) => {
    const host = app.views.get(ed).host;
    return [host.style.left, host.style.top, host.style.width, host.style.height];
  });
  const ptr = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, timeStamp: 1000 });
  try {
    const reverting = app.files.service.revert(first);
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
    const other = app.newDocument({ name: 'Working here' });
    if (layout === 'floating active') {
      setArrangement(app, null, { float: true });
      app.activate(first);
      app.activate(other);
    }
    other.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    app.setTool('rectangle');
    app.input.down(ptr(100, 100));
    app.input.move(ptr(200, 200));
    const gesture = other.doc.tx;
    expect(Boolean(gesture)).toBe(true);
    finish();
    const reverted = await reverting;
    expect(reverted.doc.root.name).toBe('Saved');
    expect.soft(app.editor === other).toBe(true);
    expect(other.doc.tx === gesture).toBe(true);
    expect(Boolean(app.input.active)).toBe(true);
    app.input.move(ptr(300, 300));
    app.input.up(ptr(300, 300));
    expect(other.doc.leaves()).toHaveLength(1);
    other.doc.undo();
    expect(other.doc.leaves()).toHaveLength(0);
    const replaced = app.editors.filter((ed) => ed !== other);
    expect(replaced).toHaveLength(2);
    expect(replaced.every((ed) => ed.doc === reverted.doc && !ed.doc.dirty)).toBe(true);
    for (const [i, ed] of replaced.entries()) {
      const host = app.views.get(ed).host;
      expect(host.hidden).toBe(layout === 'tabs' || (layout === 'floating active' && ed !== reverted));
      if (layout === 'floating') {
        expect(app.floating.has(ed)).toBe(true);
        expect([host.style.left, host.style.top, host.style.width, host.style.height]).toEqual(frames[i]);
      }
    }
    if (layout === 'floating active') expect(app.lastDocked === reverted).toBe(true);
    const view = app.views.get(reverted);
    app.activate(reverted);
    expect(app.views.get(reverted) === view).toBe(true);
    expect(view.host.hidden).toBe(false);
  } finally {
    finish();
    for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
  }
});

it('keeps the shared window selected while Revert was loading active after replacement', async () => {
  const { app, first, second, getFile, finish } = await setup();
  try {
    const reverting = app.files.service.revert(first);
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
    app.activate(second);
    second.view.set({ zoom: 3, panX: 30, panY: 40 });
    finish();
    const reverted = await reverting;
    expect(reverted.doc.root.name).toBe('Saved');
    expect(app.editor.windowNumber).toBe(2);
    expect(app.editor.view.zoom).toBe(3);
    expect(app.editor.doc === reverted.doc).toBe(true);
  } finally {
    finish();
    for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
  }
});
