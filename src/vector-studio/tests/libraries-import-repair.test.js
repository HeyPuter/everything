import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { LibraryStore } from '../src/features/libraries/store.js';
import { useItem, itemsFromSelection } from '../src/features/libraries/panel.js';
import { normalizeLibrary } from '../src/features/libraries/store.js';
import { createPath, createGroup, createText, createImage } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { memoryBackend } from '../src/features/files/backends.js';

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

const rectNode = (id, extra = {}) => ({
  id,
  type: 'path',
  closed: true,
  anchors: [0, 1, 2, 3].map((i) => ({
    x: i % 3 ? 20 : 0,
    y: i > 1 ? 20 : 0,
    ix: 0,
    iy: 0,
    ox: 0,
    oy: 0,
  })),
  fill: { type: 'solid', color: '#ff0000' },
  ...extra,
});

async function importAndPlace(items) {
  const store = new LibraryStore(app, memoryBackend());
  await store.load();
  const lib = await store.importLibrary({ name: 'Damaged', items });
  const ed = app.newDocument({ width: 400, height: 400 });
  const notes = [];
  app.notify = (m) => notes.push(m);
  const placed = lib.items.map((it) => useItem(app, it));
  return { lib, ed, notes, placed };
}

describe('importing a library with damaged graphics', () => {
  it('leaves sound graphics alone', async () => {
    const ed = app.newDocument({ width: 400, height: 400 });
    const doc = ed.doc;
    const L = ed.targetLayer().id;
    const a = createPath(rectangle(0, 0, 50, 50), true, { fill: { type: 'solid', color: '#f00' } });
    const b = createPath(ellipse(60, 0, 30, 30), true, {
      stroke: { type: 'solid', color: '#00f' },
      strokeWidth: 2,
      dash: [4, 2],
    });
    const t = createText('Hello', 10, 100);
    const g = createGroup([]);
    doc.assets.set('img1', { data: 'data:image/png;base64,AAAA', width: 1, height: 1 });
    const im = createImage('img1', 10, 10);
    doc.transact('x', () => {
      doc.insert(g, L);
      doc.insert(a, g.id);
      doc.insert(b, g.id);
      doc.insert(t, L);
      doc.insert(im, L);
    });
    ed.select([a.id, b.id]);
    await app.commands.run('object.compoundMake');
    ed.select([t.id]);
    const sym = await app.commands.run('symbol.new', { direct: true, name: 'Word' });
    ed.select([g.id, sym.instance.id, im.id]);
    const items = itemsFromSelection(app, ['graphic']);
    expect(items).toHaveLength(1);
    expect(items[0].data.symbols).toHaveLength(1);
    const types = items[0].data.items.flatMap((it) => it.nodes.map((n) => n.type));
    expect(types).toEqual(
      expect.arrayContaining(['group', 'compound', 'path', 'instance', 'image']),
    );
    expect(items[0].data.symbols[0].nodes.map((n) => n.type)).toContain('text');
    const stats = {};
    const lib = normalizeLibrary(JSON.parse(JSON.stringify({ name: 'Sound', items })), stats);
    expect(stats).toEqual({});
    expect(lib.items[0].data).toEqual(JSON.parse(JSON.stringify(items[0].data)));
  });

  it('repairs graphics like opening a file does and places only sound objects', async () => {
    const { lib, ed, placed } = await importAndPlace([
      // Anchors with missing handles and a non-point, a fill of the wrong kind.
      {
        kind: 'graphic',
        name: 'Bent',
        data: {
          items: [
            {
              root: 'p1',
              nodes: [
                rectNode('p1', {
                  fill: 'red',
                  anchors: [{ x: 0, y: 0 }, { x: 10, y: 0 }, 'bad', { x: 10, y: 10 }],
                }),
              ],
            },
          ],
        },
      },
      // A group whose child list names a node that is not there and a node without a type.
      {
        kind: 'graphic',
        name: 'Group',
        data: {
          items: [
            {
              root: 'g1',
              nodes: [
                { id: 'g1', type: 'group', children: ['p2', 'gone', 'x'] },
                rectNode('p2', { parent: 'g1' }),
                { id: 'x', parent: 'g1' },
              ],
            },
          ],
        },
      },
    ]);
    expect(lib.items.map((it) => it.name)).toEqual(['Bent', 'Group']);
    expect(placed).toEqual([true, true]);
    const doc = ed.doc;
    const paths = doc.leaves().filter((n) => n.type === 'path');
    expect(paths).toHaveLength(2);
    for (const p of paths) {
      expect(
        p.anchors.every((a) => [a.x, a.y, a.ix, a.iy, a.ox, a.oy].every(Number.isFinite)),
      ).toBe(true);
    }
    expect(paths[0].fill).toBeUndefined();
    const g = doc.get(paths[1].parent);
    expect(g.type).toBe('group');
    expect(g.children).toEqual([paths[1].id]);
  });

  it('skips graphics that cannot be repaired and says so', async () => {
    const store = new LibraryStore(app, memoryBackend());
    await store.load();
    const stats = {};
    const lib = await store.importLibrary(
      {
        name: 'Broken',
        items: [
          { kind: 'graphic', name: 'No items', data: { items: 'nope' } },
          { kind: 'graphic', name: 'Null item', data: { items: [null] } },
          { kind: 'graphic', name: 'No nodes', data: { items: [{ root: 'a', nodes: {} }] } },
          {
            kind: 'graphic',
            name: 'Untyped root',
            data: { items: [{ root: 'a', nodes: [{ id: 'a' }] }] },
          },
          {
            kind: 'graphic',
            name: 'Bad symbol',
            data: {
              items: [{ root: 'i', nodes: [{ id: 'i', type: 'instance', symbol: 's' }] }],
              symbols: [{ root: 's', nodes: [{ id: 's', type: 'group', children: [] }] }],
            },
          },
          {
            kind: 'graphic',
            name: 'Fine',
            data: { items: [{ root: 'p', nodes: [rectNode('p')] }] },
          },
          { kind: 'color', name: 'Red', data: { paint: { type: 'solid', color: '#ff0000' } } },
        ],
      },
      stats,
    );
    expect(lib.items.map((it) => it.name)).toEqual(['Fine', 'Red']);
    expect(stats.skipped).toBe(5);
  });
});

describe('Import Library in the Libraries panel', () => {
  async function importFile(text) {
    app.newDocument({ width: 400, height: 400 });
    app.libraries = new LibraryStore(app, memoryBackend());
    await app.libraries.load();
    const panel = app.dock.panels.get('libraries');
    panel.store = app.libraries;
    app.openPanel('libraries');
    const notes = [];
    app.notify = (m) => notes.push(m);
    const click = HTMLInputElement.prototype.click;
    let input = null;
    HTMLInputElement.prototype.click = function () {
      input = this;
    };
    try {
      panel.importLibrary();
    } finally {
      HTMLInputElement.prototype.click = click;
    }
    const file = { name: 'lib.json', text: async () => text };
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    for (let i = 0; i < 20 && !notes.length; i++) await new Promise((r) => setTimeout(r, 0));
    return notes;
  }

  it('a file that is not JSON gets a plain message, not the parser error', async () => {
    const notes = await importFile('{"name": "Brand", items: [}');
    expect(notes).toEqual(['This file is not a Vector Studio library.']);
  });

  it('says how many damaged graphics were repaired and left out', async () => {
    const lib = {
      name: 'Brand',
      items: [
        {
          kind: 'graphic',
          name: 'Bent',
          data: { items: [{ root: 'p', nodes: [rectNode('p', { fill: 'red' })] }] },
        },
        { kind: 'graphic', name: 'Gone', data: { items: [null] } },
        { kind: 'graphic', name: 'Gone too', data: { items: [] } },
        { kind: 'graphic', name: 'Fine', data: { items: [{ root: 'q', nodes: [rectNode('q')] }] } },
      ],
    };
    const notes = await importFile(JSON.stringify(lib));
    expect(notes).toEqual([
      'Imported Brand. 1 damaged graphic was repaired. 2 damaged graphics were left out.',
    ]);
    expect(app.libraries.libraries[0].items.map((it) => it.name)).toEqual(['Bent', 'Fine']);
  });
});
