import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { LibraryStore, normalizeLibrary } from '../src/features/libraries/store.js';
import { itemsFromSelection, useItem, placeGraphic } from '../src/features/libraries/panel.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';

describe('library store', () => {
  it('creates, saves, reloads, renames, duplicates and deletes libraries', async () => {
    const backend = memoryBackend();
    const store = new LibraryStore({}, backend);
    await store.load();
    const lib = await store.create('Brand');
    store.addItems(lib.id, [{ kind: 'color', name: 'Red', data: { paint: { type: 'solid', color: '#ff0000' } } }]);
    await store.save(store.get(lib.id), { immediate: true });
    const again = new LibraryStore({}, backend);
    await again.load();
    expect(again.libraries.map((l) => l.name)).toEqual(['Brand']);
    expect(again.libraries[0].items[0].data.paint.color).toBe('#ff0000');
    await again.rename(lib.id, 'Brand Kit');
    const copy = await again.duplicate(lib.id);
    expect(copy.items[0].id).not.toBe(again.get(lib.id).items[0].id);
    await again.remove(lib.id);
    expect(again.libraries.map((l) => l.name)).toEqual(['Brand Kit copy']);
  });

  it('writes an edit made just before the page is hidden or closed', async () => {
    const app = await bootAppWithFeatures();
    const backend = memoryBackend();
    app.libraries = new LibraryStore(app, backend);
    await app.libraries.load();
    const lib = await app.libraries.create('Brand');
    app.libraries.addItems(lib.id, [{ kind: 'color', name: 'Red', data: { paint: { type: 'solid', color: '#ff0000' } } }]);
    window.dispatchEvent(new Event('pagehide'));
    await app.libraries.flush();
    expect((await backend.readJSON(`${lib.id}.json`)).items).toHaveLength(1);
    app.libraries.renameItem(lib.id, app.libraries.get(lib.id).items[0].id, 'Brand Red');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      delete document.visibilityState;
    }
    await app.libraries.flush();
    expect((await backend.readJSON(`${lib.id}.json`)).items[0].name).toBe('Brand Red');
    expect(app.libraries.pending.size).toBe(0);
  });

  it('keeps an edit whose write the closing page could not finish, and writes it on the next load', async () => {
    const backend = memoryBackend();
    const writeJSON = backend.writeJSON;
    const store = new LibraryStore({}, backend, { journal: 'test-libraries-journal' });
    await store.load();
    const lib = await store.create('Brand');
    // The page is closing: storage writes started now never finish.
    backend.writeJSON = () => new Promise(() => {});
    store.addItems(lib.id, [{ kind: 'text', name: 'Hi', data: { text: 'Hi' } }]);
    store.flush(null, { hiding: true });
    expect(localStorage.getItem('test-libraries-journal')).toContain('"Hi"');
    backend.writeJSON = writeJSON;
    expect((await backend.readJSON(`${lib.id}.json`)).items).toHaveLength(0);
    // Next time.
    const again = new LibraryStore({}, backend, { journal: 'test-libraries-journal' });
    await again.load();
    expect(again.get(lib.id).items.map((it) => it.name)).toEqual(['Hi']);
    await again.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect((await backend.readJSON(`${lib.id}.json`)).items).toHaveLength(1);
    expect(localStorage.getItem('test-libraries-journal')).toBe(null);
    // An older journal never replaces what was written later.
    localStorage.setItem('test-libraries-journal', JSON.stringify({ location: 'memory', libraries: [{ ...again.get(lib.id), items: [], modified: 1 }] }));
    const third = new LibraryStore({}, backend, { journal: 'test-libraries-journal' });
    await third.load();
    expect(third.get(lib.id).items).toHaveLength(1);
    await third.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem('test-libraries-journal')).toBe(null);
  });

  it('writes one library in order: a slow earlier write never replaces a newer one or a deletion', async () => {
    const backend = memoryBackend();
    const writeJSON = backend.writeJSON;
    let slow = true;
    backend.writeJSON = async (path, value) => {
      const text = JSON.stringify(value);
      if (slow) {
        slow = false;
        await new Promise((r) => setTimeout(r, 30));
      }
      return writeJSON(path, JSON.parse(text));
    };
    const store = new LibraryStore({}, backend);
    await store.load();
    const lib = await store.create('Brand');
    slow = true;
    const first = store.save(lib, { immediate: true });
    store.addItems(lib.id, [{ kind: 'text', name: 'Hi', data: { text: 'Hi' } }]);
    await store.flush();
    await first;
    expect((await backend.readJSON(`${lib.id}.json`)).items).toHaveLength(1);
    slow = true;
    store.save(lib, { immediate: true });
    await store.remove(lib.id);
    await store.flush();
    expect(await backend.readJSON(`${lib.id}.json`)).toBe(null);
  });

  it('rejects files that are not libraries and drops unknown items', () => {
    expect(normalizeLibrary({ nope: 1 })).toBe(null);
    const lib = normalizeLibrary({ name: 'x', items: [{ kind: 'color', data: { paint: {} } }, { kind: 'virus', data: {} }, { kind: 'text' }] });
    expect(lib.items).toHaveLength(1);
  });
});

describe('library assets', () => {
  it('round-trips graphics and colors through a document', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    const doc = app.editor.doc;
    const n = createPath(rectangle(10, 10, 50, 30), true, { fill: { type: 'solid', color: '#123456' } });
    doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
    app.editor.select([n.id]);
    const [graphic, color] = itemsFromSelection(app, ['graphic', 'fill']);
    expect(graphic.kind).toBe('graphic');
    expect(color).toMatchObject({ kind: 'color', data: { paint: { color: '#123456' } } });
    const ids = placeGraphic(app, graphic.data, { x: 500, y: 400 });
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(n.id);
    const b = nodeBounds(doc, doc.get(ids[0]));
    expect(b.x + b.w / 2).toBeCloseTo(500);
    expect(b.w).toBeCloseTo(50);
    app.editor.select([n.id]);
    app.editor.focusPaint = 'fill';
    useItem(app, { kind: 'color', data: { paint: { type: 'solid', color: '#abcdef' } } });
    expect(doc.get(n.id).fill.color).toBe('#abcdef');
  });

  it('registers the Libraries panel in the Window menu', async () => {
    const app = await bootAppWithFeatures();
    expect(app.commands.get('panel.libraries')).toBeTruthy();
  });
});
