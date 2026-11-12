import { describe, it, expect } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { serializeDocument, parseDocument } from '../src/features/files/format.js';

describe('native format keeps what the document needs', () => {
  it('keeps an embedded color profile the document is assigned to', async () => {
    const doc = VDocument.create({ name: 'Profiled' });
    doc.assets.set('icc-00000000deadbeef', {
      mime: 'application/vnd.iccprofile',
      data: 'data:application/vnd.iccprofile;base64,AAAA',
      name: 'Test RGB',
    });
    doc.transact('Assign Profile', () => doc.updateRoot({ colorProfile: 'icc:00000000deadbeef' }));
    // An image asset nothing uses is still dropped.
    doc.assets.set('img-unused', { mime: 'image/png', data: 'data:image/png;base64,AAAA' });
    const { doc: back } = await parseDocument(await serializeDocument(doc));
    expect(back.root.colorProfile).toBe('icc:00000000deadbeef');
    expect(back.assets.get('icc-00000000deadbeef')?.data).toBe(
      'data:application/vnd.iccprofile;base64,AAAA',
    );
    expect(back.assets.has('img-unused')).toBe(false);
  });
});

describe('damaged documents', () => {
  const damaged = (mutate) => {
    const data = JSON.parse(JSON.stringify(VDocument.create({ name: 'Damaged' }).toJSON()));
    mutate(data.nodes);
    return new TextEncoder().encode(JSON.stringify(data));
  };

  it('replaces artboards that are all unusable, even when as many are left', async () => {
    const { doc, repaired } = await parseDocument(
      damaged((nodes) => {
        nodes.root.artboards = [null];
        nodes.root.type = '';
      }),
    );
    expect(doc.artboards).toHaveLength(1);
    expect(doc.artboards[0]).toMatchObject({ x: 0, y: 0, w: 612, h: 792 });
    expect(doc.root.type).toBe('root');
    expect(repaired).toBe(0);
  });

  it('repairs a root whose type is not text instead of failing with a program error', async () => {
    const { doc } = await parseDocument(
      damaged((nodes) => {
        nodes.root.type = [];
      }),
    );
    expect(doc.root.type).toBe('root');
    expect(doc.layers()).toHaveLength(1);
  });
});

describe('damaged object settings', () => {
  it('leaves out settings of the wrong kind so damaged objects draw and select', async () => {
    const { bootAppWithFeatures } = await import('./helpers.js');
    const { createPath, createText } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const src = VDocument.create({ name: 'Damaged' });
    const L = src.layers()[0].id;
    const ids = {};
    src.transact('Add', () => {
      for (const k of ['effects', 'effects2', 'stops', 'dash', 'dash2'])
        ids[k] = src.insert(createPath(rectangle(0, 0, 10, 10), true), L).id;
      ids.text = src.insert(
        createText('Hello there', 0, 40, { runs: [{ len: 5, fontWeight: 700 }, { len: 6 }] }),
        L,
      ).id;
    });
    const data = JSON.parse(JSON.stringify(src.toJSON()));
    const n = data.nodes;
    n[ids.effects].effects = true;
    n[ids.effects2].effects = [
      'x',
      null,
      { type: 'dropShadow', x: 2, y: 2, blur: 2, color: '#000000', opacity: 0.5 },
    ];
    n[ids.stops].fill = { type: 'linear', stops: {} };
    n[ids.dash].dash = 'x';
    n[ids.dash2].dash = [4, null, 2];
    n[ids.text].para.align = {};
    n[ids.text].para.indentFirst = [true];
    n[ids.text].char.fontSize = 'big';
    n[ids.text].runs = [null, { len: 5, fontWeight: 'x' }];
    n.root.guides = [null, { axis: 'x', pos: 10 }];
    const { doc } = await parseDocument(new TextEncoder().encode(JSON.stringify(data)));
    expect(doc.get(ids.effects).effects).toBeUndefined();
    expect(doc.get(ids.effects2).effects.map((e) => e.type)).toEqual(['dropShadow']);
    expect(doc.get(ids.stops).fill).toBeUndefined();
    expect(doc.get(ids.dash).dash).toBeUndefined();
    expect(doc.get(ids.dash2).dash).toEqual([4, 2]);
    const t = doc.get(ids.text);
    expect(t.para.align).toBeUndefined();
    expect(t.para.indentFirst).toBeUndefined();
    expect(t.char.fontSize).toBeUndefined();
    expect(t.runs).toEqual([{ len: 5 }]);
    expect(doc.root.guides).toEqual([{ axis: 'x', pos: 10 }]);
    // The repaired document draws, selects and shows its settings.
    const app = await bootAppWithFeatures();
    const ed = app.addDocument(doc);
    const view = app.views.get(ed);
    expect(() => {
      view.renderNow();
      ed.select(doc.get(L).children);
      view.renderNow();
      app.refreshChrome();
    }).not.toThrow();
  });

  it('keeps every setting of an intact document as it is', async () => {
    const { createPath, createText } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const src = VDocument.create({ name: 'Intact' });
    const L = src.layers()[0].id;
    src.transact('Add', () => {
      src.insert(
        createPath(rectangle(0, 0, 10, 10), true, {
          dash: [3, 1],
          effects: [{ type: 'dropShadow', x: 1 }],
          fill: {
            type: 'radial',
            stops: [
              { offset: 0, color: '#ff0000' },
              { offset: 1, color: '#0000ff' },
            ],
          },
        }),
        L,
      );
      src.insert(createText('Hi', 0, 40, { runs: [{ len: 1, fontWeight: 700 }, { len: 1 }] }), L);
    });
    const data = JSON.parse(JSON.stringify(src.toJSON()));
    const { validateData } = await import('../src/features/files/format.js');
    const out = validateData(data);
    expect(out.repaired).toBe(0);
    for (const id of Object.keys(data.nodes)) expect(out.data.nodes[id]).toBe(data.nodes[id]);
  });
});

describe('recovery copies', () => {
  it('never forgets other copies when the list of copies cannot be read for a moment', async () => {
    const { RecoveryStore } = await import('../src/features/files/recovery.js');
    const { memoryBackend } = await import('../src/features/files/backends.js');
    const cloud = memoryBackend();
    const local = memoryBackend();
    const store = new RecoveryStore([cloud, local]);
    await store.put('r1', { name: 'First', data: new Uint8Array([1]), session: 's', saved: 1 });
    // The connection drops while the list is read (the copy itself was written).
    const readJSON = cloud.readJSON;
    cloud.readJSON = async () => {
      cloud.readJSON = readJSON;
      throw new Error('Network error');
    };
    await store.put('r2', { name: 'Second', data: new Uint8Array([2]), session: 's', saved: 2 });
    expect((await store.list()).map((e) => e.name).sort()).toEqual(['First', 'Second']);
    // A damaged list is started over, so copies can still be kept.
    cloud.files.set('recovery/index.json', '{not json');
    await store.put('r3', { name: 'Third', data: new Uint8Array([3]), session: 's', saved: 3 });
    expect((await store.list()).map((e) => e.name)).toContain('Third');
  });
});

describe('shared documents carry what an edit needs', () => {
  it('sends an embedded color profile with the edit that assigns it', async () => {
    const { network, shareNew, joinClient, settle, alice, bob } =
      await import('./collab-helpers.js');
    const net = network();
    const { room, client: a } = await shareNew(net);
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    const b = await joinClient(net, bob, room, { invite: token });
    a.doc.assets.set('icc-00000000deadbeef', {
      mime: 'application/vnd.iccprofile',
      data: 'data:application/vnd.iccprofile;base64,AAAA',
      name: 'Test RGB',
    });
    a.doc.transact('Assign Profile', () =>
      a.doc.updateRoot({ colorProfile: 'icc:00000000deadbeef' }),
    );
    await settle(a, b);
    expect(b.doc.root.colorProfile).toBe('icc:00000000deadbeef');
    expect(b.doc.assets.get('icc-00000000deadbeef')?.data).toBe(
      'data:application/vnd.iccprofile;base64,AAAA',
    );
  });
});

describe('closing with unsaved changes', () => {
  const waitDialog = async () => {
    for (let i = 0; i < 50 && !document.querySelector('dialog[open]'); i++)
      await new Promise((r) => setTimeout(r, 10));
    return document.querySelector('dialog[open]');
  };
  const click = (dlg, label) =>
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === label).click();

  it('keeps an edit made while Close > Save is writing', async () => {
    const { bootAppWithFeatures } = await import('./helpers.js');
    const { createPath } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const app = await bootAppWithFeatures({ env: 'app', user: { username: 'u' } });
    const files = new Map();
    let release = null;
    app.puter = {
      fs: {
        write: async (path, blob) => {
          if (!release) await new Promise((r) => (release = r));
          files.set(path, new Uint8Array(await blob.arrayBuffer()));
          return { path, name: path.split('/').pop() };
        },
      },
    };
    const doc = VDocument.create({ name: 'Logo' });
    const ed = app.addDocument(doc, {
      file: { kind: 'puter', path: '/u/Logo.vstudio', name: 'Logo.vstudio' },
    });
    const layer = doc.layers()[0].id;
    doc.transact('Add', () => doc.insert(createPath(rectangle(0, 0, 10, 10), true), layer));
    const closing = app.closeDocument(ed);
    click(await waitDialog(), 'Save');
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    // The prompt is gone while the file is written: the user keeps drawing.
    doc.transact('Add', () => doc.insert(createPath(rectangle(20, 0, 10, 10), true), layer));
    release();
    // Asked again rather than closing without the new change.
    const again = await waitDialog();
    expect(again.textContent).toMatch(/Save changes to "Logo.vstudio"/);
    click(again, 'Save');
    expect(await closing).toBe(true);
    expect(app.editors.includes(ed)).toBe(false);
    const { doc: back } = await parseDocument(files.get('/u/Logo.vstudio'));
    expect(back.get(layer).children.length).toBe(2);
    await app.files.autosaver.busy;
  });
});
